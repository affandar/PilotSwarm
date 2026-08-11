/**
 * Model provider registry — loads and resolves multi-provider LLM configuration.
 *
 * Reads a `model_providers.json` file that defines multiple LLM providers
 * (GitHub Copilot, Azure OpenAI, OpenAI, Anthropic, local/Ollama) each with
 * their own endpoints, API keys, and available models.
 *
 * Models are identified by normalized strings: `provider:model`
 * (e.g. `github-copilot:claude-opus-4`, `anthropic:claude-sonnet-4-6`).
 *
 * Secrets use the `env:VAR_NAME` syntax to reference environment variables
 * so keys stay in `.env` files while provider config stays in JSON.
 *
 * @module
 */

import fs from "node:fs";
import path from "node:path";

// ─── Types ───────────────────────────────────────────────────────

/** Reasoning effort levels accepted by the Copilot CLI. */
export type ReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

/**
 * Context-window tier accepted by the Copilot SDK (CLI 1.0.6x+).
 * "default" is the smaller/cheaper window; "long_context" pins the session to
 * the model's long-context tier (larger window, higher token cost).
 */
export type ContextTier = "default" | "long_context";

/** A model entry within a provider. */
export interface ModelEntry {
    /** Model name (deployment name for Azure). */
    name: string;
    /** Short description of when to use this model. */
    description?: string;
    /** Relative cost tier. */
    cost?: "low" | "medium" | "high";
    /** Optional reasoning effort levels exposed in the UI for this model. */
    supportedReasoningEfforts?: ReasoningEffort[];
    /** Optional default reasoning effort when creating sessions. */
    defaultReasoningEffort?: ReasoningEffort;
    /** Optional context-window tiers exposed in the UI for this model. */
    supportedContextTiers?: ContextTier[];
    /** Optional default context tier when creating sessions (prefer "default", the smaller window). */
    defaultContextTier?: ContextTier;
    /** Optional token capacity for each supported context-window tier. */
    contextWindowSizes?: Partial<Record<ContextTier, number>>;
    /**
     * Vision support for a BYOK model.
     *
     * Only ever needed for a non-Copilot provider. The Copilot catalog
     * reports vision itself through `capabilities.supports.vision`, but an
     * OpenAI-compatible provider (Fireworks, a local vLLM) appears in no
     * catalog at all — so without a declaration here `getModelVisionInfo`
     * cannot find an entry, reports `vision: false`, and every attachment is
     * dropped as `no_vision_support` before its bytes are even fetched.
     *
     * Declaring it for a model that cannot actually see turns a clean refusal
     * into a provider error, so state it only where it is true.
     */
    vision?: ModelVisionCapability;
}

/** What a BYOK model accepts when it can see images. Limits are optional. */
export interface ModelVisionCapability {
    maxImages?: number;
    maxImageBytes?: number;
    supportedMediaTypes?: string[];
}

/**
 * Provider types a model catalog may declare.
 *
 * `openai-proxy` is an OPT-IN variant of `openai`. On the wire it is exactly
 * an OpenAI-shaped endpoint — the resolved SDK provider config says `openai`,
 * because the Copilot SDK's own union has no other value. The single
 * difference: PilotSwarm appends the session's reasoning effort to `baseUrl`
 * as a path segment (`<baseUrl>/x-reasoning-effort/high`), because the child
 * process that builds the HTTP request drops `reasoning_effort` for every
 * non-Copilot provider and the url is the only thing that survives untouched.
 *
 * Declaring `openai-proxy` is a PROMISE that whatever is at `baseUrl` strips
 * that segment back off before the real provider sees it. The reference
 * implementation is `deploy/openai-compat-proxy.mjs` in the grimfanda repo.
 * Point `openai-proxy` at a raw provider and every request with an effort set
 * 404s, because no provider serves a route under `/x-reasoning-effort/high`.
 *
 * Note where the segment lands. It is appended to the END of `baseUrl`, and
 * the runtime then appends its own route, so a `baseUrl` with a path of its
 * own puts the segment in the MIDDLE of the request path:
 *
 *   http://127.0.0.1:8787      ->  /x-reasoning-effort/high/chat/completions
 *   http://127.0.0.1:8787/v1   ->  /v1/x-reasoning-effort/high/chat/completions
 *
 * A stripper that anchors its match to the front of the path handles only the
 * first. Match the segment wherever it appears.
 *
 * `github`, `openai`, `azure` and `anthropic` behave exactly as they always
 * have. Nothing is encoded for them.
 */
export type ProviderType = "github" | "azure" | "openai" | "openai-proxy" | "anthropic";

/** A single provider entry in model_providers.json. */
export interface ModelProviderConfig {
    /** Unique identifier for this provider (e.g. "azure-openai", "github-copilot"). */
    id: string;
    /** Provider type. See ProviderType — `openai-proxy` is opt-in and has a contract. */
    type: ProviderType;
    /**
     * GitHub token (type=github only). Supports `env:VAR_NAME` syntax.
     * When type=github, the SDK uses the Copilot API — no baseUrl needed.
     */
    githubToken?: string;
    /**
     * API endpoint URL. Required for non-github providers.
     * For Azure: base URL without /deployments/ (e.g. https://resource.openai.azure.com/openai)
     * For OpenAI: https://api.openai.com/v1
     * For Anthropic: https://api.anthropic.com
     */
    baseUrl?: string;
    /** API key. Supports `env:VAR_NAME` syntax. */
    apiKey?: string;
    /** Azure API version (type=azure only). Defaults to "2024-10-21". */
    apiVersion?: string;
    /** Available models. Can be plain strings (legacy) or ModelEntry objects with descriptions. */
    models: (string | ModelEntry)[];
}

/** Top-level model_providers.json schema. */
export interface ModelProvidersFile {
    providers: ModelProviderConfig[];
    /** Default model in `provider:model` format. */
    defaultModel?: string;
}

/** A fully-resolved model descriptor for display and selection. */
export interface ModelDescriptor {
    /** Normalized ID: `provider:model` */
    qualifiedName: string;
    /** Raw model name (for SDK config). */
    modelName: string;
    /** Provider ID. */
    providerId: string;
    /** Provider type. See ProviderType. */
    providerType: ProviderType;
    /** Short description of when to use this model. */
    description?: string;
    /** Relative cost tier. */
    cost?: "low" | "medium" | "high";
    /** Optional reasoning effort levels exposed in the UI for this model. */
    supportedReasoningEfforts?: ReasoningEffort[];
    /** Optional default reasoning effort when creating sessions. */
    defaultReasoningEffort?: ReasoningEffort;
    /** Optional context-window tiers exposed in the UI for this model. */
    supportedContextTiers?: ContextTier[];
    /** Optional default context tier when creating sessions. */
    defaultContextTier?: ContextTier;
    /** Optional token capacity for each supported context-window tier. */
    contextWindowSizes?: Partial<Record<ContextTier, number>>;
    /** Declared vision support — see ModelEntry.vision. */
    vision?: ModelVisionCapability;
}

/** Resolved provider info for a specific model — ready to use. */
export interface ResolvedProvider {
    /** The provider ID from model_providers.json. */
    providerId: string;
    /** Provider type as DECLARED — `openai-proxy` stays distinguishable here. */
    type: ProviderType;
    /** Raw model name (for SDK config). */
    modelName: string;
    /** Resolved GitHub token (type=github only). */
    githubToken?: string;
    /**
     * Copilot SDK ProviderConfig — passed to SessionConfig.provider.
     * Undefined for type=github (uses githubToken instead).
     *
     * The type here is the SDK's own union, which knows nothing about
     * `openai-proxy`; that value is mapped to `openai` in `resolve()` and must
     * never leak into this object.
     */
    sdkProvider?: {
        type: "openai" | "azure" | "anthropic";
        baseUrl: string;
        apiKey?: string;
        azure?: { apiVersion?: string };
    };
}

// ─── Registry ────────────────────────────────────────────────────

/**
 * ModelProviderRegistry — loaded once at worker startup.
 * Maps normalized `provider:model` strings to their provider configs.
 */
export class ModelProviderRegistry {
    private providers: ModelProviderConfig[];
    /** Qualified name → ModelDescriptor */
    private descriptors = new Map<string, ModelDescriptor>();
    /** Qualified name → ModelProviderConfig */
    private qualifiedToProvider = new Map<string, ModelProviderConfig>();
    /** Bare model name → first matching qualified name (for backwards compat). */
    private bareToQualified = new Map<string, string>();
    private _defaultModel: string | undefined;
    private _allDescriptors: ModelDescriptor[] = [];

    constructor(config: ModelProvidersFile) {
        const configuredDefaultModel = config.defaultModel;
        this._defaultModel = configuredDefaultModel;

        // Filter to providers whose credentials are actually available.
        // GitHub providers are kept even without an env token because a
        // per-user key may be supplied later from CMS, and the UX should
        // still show configured GitHub models. GitHub credential enforcement
        // happens when creating/resuming a GitHub-backed session.
        this.providers = config.providers.filter(p => {
            if (p.type === "github") {
                return true;
            }
            return !!resolveEnvValue(p.apiKey);
        });

        // Build lookups
        for (const p of this.providers) {
            for (const m of p.models) {
                const entry: ModelEntry = typeof m === "string" ? { name: m } : m;
                const supportedReasoningEfforts = normalizeReasoningEfforts(entry.supportedReasoningEfforts);
                const defaultReasoningEffort = supportedReasoningEfforts.includes(entry.defaultReasoningEffort as ReasoningEffort)
                    ? entry.defaultReasoningEffort
                    : undefined;
                const supportedContextTiers = normalizeContextTiers(entry.supportedContextTiers);
                // Default to the smaller window: an explicit valid default wins,
                // otherwise "default" whenever tiers are offered at all.
                const defaultContextTier = supportedContextTiers.length > 0
                    ? (supportedContextTiers.includes(entry.defaultContextTier as ContextTier)
                        ? entry.defaultContextTier
                        : "default")
                    : undefined;
                const contextWindowSizes = normalizeContextWindowSizes(entry.contextWindowSizes, supportedContextTiers);
                const qualified = `${p.id}:${entry.name}`;
                const desc: ModelDescriptor = {
                    qualifiedName: qualified,
                    modelName: entry.name,
                    providerId: p.id,
                    providerType: p.type,
                    description: entry.description,
                    cost: entry.cost,
                    ...(supportedReasoningEfforts.length > 0 ? { supportedReasoningEfforts } : {}),
                    ...(defaultReasoningEffort ? { defaultReasoningEffort } : {}),
                    ...(supportedContextTiers.length > 0 ? { supportedContextTiers } : {}),
                    ...(defaultContextTier ? { defaultContextTier } : {}),
                    ...(Object.keys(contextWindowSizes).length > 0 ? { contextWindowSizes } : {}),
                    ...(entry.vision ? { vision: entry.vision } : {}),
                };
                this.descriptors.set(qualified, desc);
                this.qualifiedToProvider.set(qualified, p);
                this._allDescriptors.push(desc);

                // First provider to register a bare name wins
                if (!this.bareToQualified.has(entry.name)) {
                    this.bareToQualified.set(entry.name, qualified);
                }
            }
        }

        if (configuredDefaultModel && !this.descriptors.has(configuredDefaultModel)) {
            const availableModels = this._allDescriptors.map(d => d.qualifiedName);
            const availableSummary = availableModels.length > 0
                ? ` Available models: ${availableModels.join(", ")}`
                : " No credentialed models are available after provider filtering.";
            throw new Error(
                `Invalid defaultModel ${JSON.stringify(configuredDefaultModel)} in model provider config.` +
                availableSummary,
            );
        }

    }

    /** Default model in `provider:model` format. */
    get defaultModel(): string | undefined {
        return this._defaultModel;
    }

    /** All model descriptors across all providers. */
    get allModels(): ModelDescriptor[] {
        return [...this._allDescriptors];
    }

    /** All provider configs. */
    get allProviders(): ModelProviderConfig[] {
        return [...this.providers];
    }

    /**
     * Normalize a model reference to `provider:model` format.
     * Accepts: `provider:model`, bare `model`, or undefined (→ default).
     */
    normalize(ref?: string): string | undefined {
        if (!ref) return this._defaultModel;
        if (ref.includes(":") && this.descriptors.has(ref)) return ref;
        const qualified = this.bareToQualified.get(ref);
        if (qualified) return qualified;
        return undefined;
    }

    /** Get the ModelDescriptor for a model reference. */
    getDescriptor(ref?: string): ModelDescriptor | undefined {
        const q = this.normalize(ref);
        return q ? this.descriptors.get(q) : undefined;
    }

    /**
     * Resolve the provider for a model reference.
     * Accepts `provider:model` or bare `model` name.
     */
    resolve(ref?: string): ResolvedProvider | undefined {
        const q = this.normalize(ref);
        if (!q) return undefined;

        const provider = this.qualifiedToProvider.get(q);
        const desc = this.descriptors.get(q);
        if (!provider || !desc) return undefined;

        if (provider.type === "github") {
            return {
                providerId: provider.id,
                type: "github",
                modelName: desc.modelName,
                githubToken: resolveEnvValue(provider.githubToken),
            };
        }

        const baseUrl = provider.baseUrl;
        if (!baseUrl) return undefined;

        const resolvedUrl = provider.type === "azure" && !baseUrl.includes("/deployments/")
            ? `${baseUrl.replace(/\/+$/, "")}/deployments/${desc.modelName}`
            : baseUrl;

        // `openai-proxy` is a PilotSwarm-only distinction. The Copilot SDK's
        // provider union is openai | azure | anthropic, so it is mapped back to
        // `openai` right here and never reaches the SDK. The declared type
        // survives on `type` above, which is what the effort encoding reads.
        const sdkProviderType = provider.type === "openai-proxy" ? "openai" : provider.type;

        return {
            providerId: provider.id,
            type: provider.type,
            modelName: desc.modelName,
            sdkProvider: {
                type: sdkProviderType,
                baseUrl: resolvedUrl,
                apiKey: resolveEnvValue(provider.apiKey),
                ...(provider.type === "azure" && {
                    azure: { apiVersion: provider.apiVersion || "2024-10-21" },
                }),
            },
        };
    }

    /** Check if a model reference (qualified or bare) is known. */
    hasModel(ref: string): boolean {
        return this.normalize(ref) !== undefined;
    }

    /** Get models grouped by provider, for display. */
    getModelsByProvider(): Array<{ providerId: string; type: string; models: ModelDescriptor[] }> {
        return this.providers.map(p => ({
            providerId: p.id,
            type: p.type,
            models: this._allDescriptors.filter(d => d.providerId === p.id),
        }));
    }

    /** Get a summary of all models suitable for LLM tool consumption. */
    getModelSummaryForLLM(): string {
        const lines: string[] = ["Available models (use the qualified name to select):"];
        for (const group of this.getModelsByProvider()) {
            lines.push(`\n## ${group.providerId} (${group.type})`);
            for (const m of group.models) {
                const costLabel = m.cost ? ` [cost: ${m.cost}]` : "";
                const reasoningLabel = m.supportedReasoningEfforts?.length
                    ? ` [reasoning: ${m.supportedReasoningEfforts.join(", ")}${m.defaultReasoningEffort ? `; default: ${m.defaultReasoningEffort}` : ""}]`
                    : "";
                const contextTierLabel = m.supportedContextTiers?.length
                    ? ` [context: ${m.supportedContextTiers.join(", ")}${m.defaultContextTier ? `; default: ${m.defaultContextTier}` : ""}]`
                    : "";
                const desc = m.description ? ` — ${m.description}` : "";
                lines.push(`- ${m.qualifiedName}${costLabel}${reasoningLabel}${contextTierLabel}${desc}`);
            }
        }
        lines.push(`\nDefault: ${this._defaultModel || "none"}`);
        return lines.join("\n");
    }
}

// ─── Reasoning effort carried on the provider baseUrl ────────────

/**
 * The path segment that carries a reasoning effort to a stripping proxy.
 *
 * Why the URL, of all places. PilotSwarm takes a per-session reasoning effort
 * and hands it to `@github/copilot-sdk` as `config.reasoningEffort`. The SDK
 * spawns the `@github/copilot` binary, and THAT child process builds the HTTP
 * request. It only emits `reasoning_effort` for the Copilot API (provider
 * `type: github`); for every BYOK provider the field is dropped before the
 * request exists. Measured with an HTTP proxy in front of both Fireworks and
 * Azure AI Foundry: the outbound body carried `model`, `tools`, and nothing
 * else. So the effort has to ride on something the runtime forwards verbatim.
 *
 * It used to ride in the model NAME, as `kimi-k3::effort=high`. That broke
 * hard on @github/copilot 1.0.79, which parses `model:key=value` as its own
 * model-options syntax and rejects unknown keys:
 *
 *     Execution failed: Unknown model option key: effort
 *
 * Every turn with an effort set failed. The old comment argued a colon was
 * safe because no provider id uses one — which checked our naming and not the
 * runtime's, and the runtime is the thing doing the parsing. (Its own valid
 * keys are `defaultReasoningEffort` and `defaultReasoningSummary`; neither
 * puts `reasoning_effort` on a BYOK request, so neither helps here.)
 *
 * The baseUrl path is a better carrier. The runtime treats it as opaque and
 * appends its own route to it, verified end to end:
 *
 *     baseUrl   http://127.0.0.1:8787/x-reasoning-effort/high
 *     proxy saw POST /x-reasoning-effort/high/chat/completions
 *
 * Only providers declared `type: "openai-proxy"` get this — an explicit
 * promise that the server at that baseUrl strips the prefix back off. Every
 * other provider type is left byte-identical, which is what keeps deployments
 * without such a proxy working.
 *
 * The decoder lives in the grimfanda repo, `deploy/openai-compat-proxy.mjs`.
 * Changing this string breaks that proxy — change both together.
 */
export const REASONING_EFFORT_PATH_PREFIX = "/x-reasoning-effort";

/** Matches exactly what `encodeReasoningEffortInBaseUrl` writes, and nothing else. */
const BASE_URL_EFFORT_PATTERN = /^(.*)\/x-reasoning-effort\/([a-z]+)$/;

/**
 * Append a reasoning effort to a provider baseUrl.
 *
 * Returns the url unchanged for an absent or unknown effort, and for a url
 * that already carries one. Low-level: `applyReasoningEffortToProviderConfig`
 * decides WHETHER a provider should be encoded at all.
 */
export function encodeReasoningEffortInBaseUrl(baseUrl: string, effort?: ReasoningEffort | null): string {
    const url = String(baseUrl || "");
    if (!url) return url;
    if (!effort || !REASONING_EFFORTS.has(String(effort))) return url;
    if (decodeReasoningEffortFromBaseUrl(url).reasoningEffort) return url;
    // Trailing slashes are stripped first, or the proxy sees a doubled slash
    // and the prefix no longer matches at the front of the path.
    return `${url.replace(/\/+$/, "")}${REASONING_EFFORT_PATH_PREFIX}/${effort}`;
}

/**
 * Split an encoded effort back off a provider baseUrl.
 *
 * The mirror of `encodeReasoningEffortInBaseUrl`, kept here so the two are
 * verified against each other. Anything that is not an exact
 * `<url>/x-reasoning-effort/<known level>` comes back untouched with a null
 * effort — a real baseUrl must never be truncated by a near-miss.
 */
export function decodeReasoningEffortFromBaseUrl(
    encodedBaseUrl: string,
): { baseUrl: string; reasoningEffort: ReasoningEffort | null } {
    const url = String(encodedBaseUrl || "");
    const match = BASE_URL_EFFORT_PATTERN.exec(url);
    if (!match) return { baseUrl: url, reasoningEffort: null };
    if (!REASONING_EFFORTS.has(match[2])) return { baseUrl: url, reasoningEffort: null };
    return { baseUrl: match[1], reasoningEffort: match[2] as ReasoningEffort };
}

/**
 * The provider config to put on the SDK session config — the whole decision.
 *
 * Encodes ONLY when all of these hold:
 *   1. an effort is set for the session,
 *   2. the model has a catalog entry (nothing is claimed about a model the
 *      registry has never heard of),
 *   3. the provider is declared `type: "openai-proxy"` — an explicit promise
 *      that its `baseUrl` strips the prefix back off. `github`, `openai`,
 *      `azure` and `anthropic` are left byte-identical,
 *   4. the catalog entry DECLARES that effort in `supportedReasoningEfforts`
 *      — sending a level a model does not accept is exactly the 400 this
 *      exists to avoid. Mirrors how an unsupported context tier is dropped.
 *
 * Anything else returns the config unchanged, by identity, so a caller can
 * spread it without allocating.
 */
export function applyReasoningEffortToProviderConfig<T extends { baseUrl?: string } | undefined>(
    providerConfig: T,
    descriptor: ModelDescriptor | undefined,
    reasoningEffort?: ReasoningEffort | null,
): T {
    if (!providerConfig || !providerConfig.baseUrl) return providerConfig;
    if (!reasoningEffort || !descriptor) return providerConfig;
    if (descriptor.providerType !== "openai-proxy") return providerConfig;
    const supported = descriptor.supportedReasoningEfforts ?? [];
    if (!supported.includes(reasoningEffort)) return providerConfig;
    const baseUrl = encodeReasoningEffortInBaseUrl(providerConfig.baseUrl, reasoningEffort);
    if (baseUrl === providerConfig.baseUrl) return providerConfig;
    return { ...providerConfig, baseUrl };
}

// ─── Loader ──────────────────────────────────────────────────────

/**
 * Load a model_providers.json file.
 * Falls back to building a config from env vars for backwards compatibility.
 */
export function loadModelProviders(filePath?: string): ModelProviderRegistry | null {
    const resolvedPath = resolveModelProvidersPath(filePath);
    if (resolvedPath) {
        const raw = fs.readFileSync(resolvedPath, "utf-8");
        return new ModelProviderRegistry(JSON.parse(raw));
    }
    return buildFromEnv();
}

/**
 * Resolve the model_providers.json path `loadModelProviders` would read:
 * explicit file path > PS_MODEL_PROVIDERS_PATH/MODEL_PROVIDERS_PATH env >
 * auto-discovery. Returns null when no file exists (env-var fallback case).
 */
export function resolveModelProvidersPath(filePath?: string): string | null {
    const envOverridePath = process.env.PS_MODEL_PROVIDERS_PATH || process.env.MODEL_PROVIDERS_PATH;
    const overridePath = filePath || envOverridePath;
    if (overridePath && fs.existsSync(overridePath)) return overridePath;

    const searchPaths = [
        ".model_providers.json",
        path.join(process.cwd(), ".model_providers.json"),
        "/app/.model_providers.json",
        // Legacy fallback
        "model_providers.json",
        path.join(process.cwd(), "model_providers.json"),
        "/app/model_providers.json",
    ];

    // Also walk up from CWD to find repo-root config
    let dir = process.cwd();
    for (let i = 0; i < 5; i++) {
        const parent = path.dirname(dir);
        if (parent === dir) break; // hit filesystem root
        searchPaths.push(path.join(parent, ".model_providers.json"));
        dir = parent;
    }
    for (const p of searchPaths) {
        if (fs.existsSync(p)) return p;
    }
    return null;
}

/**
 * Mtime-watched wrapper around `loadModelProviders`: `checkAndReload()`
 * re-reads the config file when its mtime changed since the last load, so a
 * ConfigMap rollout applies without a process restart (the registry used to
 * be loaded exactly once at startup, leaving workers on a stale catalog
 * until the next deploy — the model-catalog staleness behind the silent
 * model-substitution incident). Malformed content never replaces a good
 * registry: parse failures keep the current one and return false.
 */
export function createModelProvidersReloader(filePath?: string): {
    current: ModelProviderRegistry | null;
    readonly path: string | null;
    checkAndReload(): boolean;
} {
    const resolved = resolveModelProvidersPath(filePath);
    const statMtime = (): number => {
        if (!resolved) return 0;
        try { return fs.statSync(resolved).mtimeMs; } catch { return 0; }
    };
    let lastMtimeMs = statMtime();
    const state = {
        current: loadModelProviders(filePath),
        path: resolved,
        checkAndReload(): boolean {
            if (!resolved) return false;
            const mtimeMs = statMtime();
            if (mtimeMs === 0 || mtimeMs === lastMtimeMs) return false;
            // Record the observed mtime up-front so a persistently broken
            // file doesn't re-parse on every poll tick.
            lastMtimeMs = mtimeMs;
            try {
                const raw = fs.readFileSync(resolved, "utf-8");
                state.current = new ModelProviderRegistry(JSON.parse(raw));
                return true;
            } catch {
                return false;
            }
        },
    };
    return state;
}

/** Build a ModelProviderRegistry from legacy env vars. */
function buildFromEnv(): ModelProviderRegistry | null {
    const providers: ModelProviderConfig[] = [];

    if (process.env.LLM_ENDPOINT) {
        const type = (process.env.LLM_PROVIDER_TYPE || "openai") as "openai" | "azure" | "anthropic";
        const modelNames = process.env.LLM_MODELS
            ? process.env.LLM_MODELS.split(",").map(m => m.trim()).filter(Boolean)
            : process.env.COPILOT_MODEL ? [process.env.COPILOT_MODEL] : [];

        if (modelNames.length > 0) {
            providers.push({
                id: `env-${type}`,
                type,
                baseUrl: process.env.LLM_ENDPOINT,
                apiKey: process.env.LLM_API_KEY ? `env:LLM_API_KEY` : undefined,
                ...(type === "azure" && { apiVersion: process.env.LLM_API_VERSION || "2024-10-21" }),
                models: modelNames,
            });
        }
    }

    if (process.env.GITHUB_TOKEN) {
        providers.push({
            id: "github-copilot",
            type: "github",
            githubToken: "env:GITHUB_TOKEN",
            models: ["claude-sonnet-5", "claude-opus-4.6", "claude-sonnet-4.6", "gpt-4o"],
        });
    }

    if (providers.length === 0) return null;
    return new ModelProviderRegistry({ providers });
}

// ─── Helpers ─────────────────────────────────────────────────────

const REASONING_EFFORTS = new Set(["none", "minimal", "low", "medium", "high", "xhigh", "max"]);

function normalizeReasoningEfforts(values?: ReasoningEffort[]): ReasoningEffort[] {
    if (!Array.isArray(values)) return [];
    const out: ReasoningEffort[] = [];
    for (const raw of values) {
        const value = String(raw || "").trim().toLowerCase();
        if (!REASONING_EFFORTS.has(value)) continue;
        if (out.includes(value as ReasoningEffort)) continue;
        out.push(value as ReasoningEffort);
    }
    return out;
}

const CONTEXT_TIERS = new Set(["default", "long_context"]);

function normalizeContextTiers(values?: ContextTier[]): ContextTier[] {
    if (!Array.isArray(values)) return [];
    const out: ContextTier[] = [];
    for (const raw of values) {
        const value = String(raw || "").trim().toLowerCase();
        if (!CONTEXT_TIERS.has(value)) continue;
        if (out.includes(value as ContextTier)) continue;
        out.push(value as ContextTier);
    }
    return out;
}

function normalizeContextWindowSizes(
    values: Partial<Record<ContextTier, number>> | undefined,
    supportedTiers: ContextTier[],
): Partial<Record<ContextTier, number>> {
    if (!values || typeof values !== "object") return {};
    const out: Partial<Record<ContextTier, number>> = {};
    for (const tier of supportedTiers) {
        const size = values[tier];
        if (typeof size === "number" && Number.isSafeInteger(size) && size > 0) {
            out[tier] = size;
        }
    }
    return out;
}

function resolveEnvValue(value?: string): string | undefined {
    if (!value) return undefined;
    if (value.startsWith("env:")) {
        return process.env[value.slice(4)] || undefined;
    }
    return value;
}
