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

/** A model entry within a provider. */
export interface ModelEntry {
    /** Model name (deployment name for Azure). */
    name: string;
    /** Short description of when to use this model. */
    description?: string;
    /** Relative cost tier. */
    cost?: "low" | "medium" | "high";
}

/** A single provider entry in model_providers.json. */
export interface ModelProviderConfig {
    /** Unique identifier for this provider (e.g. "azure-openai", "github-copilot"). */
    id: string;
    /** Provider type. */
    type: "github" | "azure" | "openai" | "anthropic";
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
    /** Provider type. */
    providerType: "github" | "azure" | "openai" | "anthropic";
    /** Short description of when to use this model. */
    description?: string;
    /** Relative cost tier. */
    cost?: "low" | "medium" | "high";
}

/** Resolved provider info for a specific model — ready to use. */
export interface ResolvedProvider {
    /** The provider ID from model_providers.json. */
    providerId: string;
    /** Provider type. */
    type: "github" | "azure" | "openai" | "anthropic";
    /** Raw model name (for SDK config). */
    modelName: string;
    /** Resolved GitHub token (type=github only). */
    githubToken?: string;
    /**
     * Copilot SDK ProviderConfig — passed to SessionConfig.provider.
     * Undefined for type=github (uses githubToken instead).
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
        // GitHub providers need a resolved githubToken; BYOK providers need a resolved apiKey.
        this.providers = config.providers.filter(p => {
            if (p.type === "github") {
                return !!resolveEnvValue(p.githubToken);
            }
            return !!resolveEnvValue(p.apiKey);
        });

        // Build lookups
        for (const p of this.providers) {
            for (const m of p.models) {
                const entry: ModelEntry = typeof m === "string" ? { name: m } : m;
                const qualified = `${p.id}:${entry.name}`;
                const desc: ModelDescriptor = {
                    qualifiedName: qualified,
                    modelName: entry.name,
                    providerId: p.id,
                    providerType: p.type,
                    description: entry.description,
                    cost: entry.cost,
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

        // If no defaultModel is configured, use first available.
        if (!this._defaultModel) {
            this._defaultModel = this._allDescriptors.length > 0
                ? this._allDescriptors[0].qualifiedName
                : undefined;
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

        return {
            providerId: provider.id,
            type: provider.type,
            modelName: desc.modelName,
            sdkProvider: {
                type: provider.type,
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
                const desc = m.description ? ` — ${m.description}` : "";
                lines.push(`- ${m.qualifiedName}${costLabel}${desc}`);
            }
        }
        lines.push(`\nDefault: ${this._defaultModel || "none"}`);
        return lines.join("\n");
    }
}

// ─── Loader ──────────────────────────────────────────────────────

/**
 * Load a model_providers.json file.
 * Falls back to building a config from env vars for backwards compatibility.
 */
export function loadModelProviders(filePath?: string): ModelProviderRegistry | null {
    const envOverridePath = process.env.PS_MODEL_PROVIDERS_PATH || process.env.MODEL_PROVIDERS_PATH;
    const resolvedPath = filePath || envOverridePath;

    if (resolvedPath && fs.existsSync(resolvedPath)) {
        const raw = fs.readFileSync(resolvedPath, "utf-8");
        return new ModelProviderRegistry(JSON.parse(raw));
    }

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
        if (fs.existsSync(p)) {
            const raw = fs.readFileSync(p, "utf-8");
            return new ModelProviderRegistry(JSON.parse(raw));
        }
    }

    return buildFromEnv();
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
            models: ["claude-opus-4.6", "claude-sonnet-4.6", "gpt-4o"],
        });
    }

    if (providers.length === 0) return null;
    return new ModelProviderRegistry({ providers });
}

// ─── Helpers ─────────────────────────────────────────────────────

function resolveEnvValue(value?: string): string | undefined {
    if (!value) return undefined;
    if (value.startsWith("env:")) {
        return process.env[value.slice(4)] || undefined;
    }
    return value;
}
