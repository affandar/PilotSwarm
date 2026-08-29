/**
 * Workload Identity Federation for the Anthropic API — no API key anywhere.
 *
 * A provider declared `type: "anthropic-wif"` carries no credential at all.
 * The worker proves who it is with an identity token its platform already
 * issues, trades that for a short-lived Anthropic access token, and sends the
 * result as `Authorization: Bearer`. Nothing is stored, so nothing can leak
 * from the database and nothing has to be rotated.
 *
 * Two shapes of identity token are understood, chosen by what the environment
 * actually provides:
 *
 * ```
 * ANTHROPIC_IDENTITY_TOKEN_FILE (or _TOKEN)   one hop
 *   the file already holds a JWT the federation rule trusts
 *   → POST /v1/oauth/token
 *
 * AZURE_FEDERATED_TOKEN_FILE + AZURE_TENANT_ID   two hops
 *   the file holds a Kubernetes-projected token, which Microsoft Entra ID
 *   does not accept as an assertion for anyone but itself
 *   → POST login.microsoftonline.com/<tenant>/oauth2/v2.0/token   (Entra JWT)
 *   → POST /v1/oauth/token
 * ```
 *
 * Both token files are re-read on every exchange: a projected token rotates
 * on disk under the process, and a copy cached in memory goes stale.
 *
 * WHY A CALLBACK RATHER THAN A STORED KEY. The access token expires — an hour
 * by default, a day at most — while a PilotSwarm session outlives any of that
 * and may be resumed on a different worker days later. So the token is never
 * put in the session config; `@github/copilot-sdk` takes a `bearerTokenProvider`
 * callback instead and asks for a token before each outbound request. The
 * runtime caches nothing, which is why the caching below is not an
 * optimisation: without it every single request would mint two fresh tokens.
 *
 * @module
 */

import type { ResolvedProvider } from "./model-providers.js";

/** Where the identity token that proves who this worker is comes from. */
export type WifIdentitySource =
    /** The JWT itself, handed over in the environment. */
    | { kind: "literal"; token: string }
    /** A file holding the JWT. Re-read on every exchange. */
    | { kind: "file"; path: string }
    /**
     * A Kubernetes-projected token that must be redeemed at Microsoft Entra ID
     * first. `clientId` is the identity being claimed and `scope` the audience
     * asked for — the federation rule matches what comes back, not this file.
     */
    | { kind: "entra"; tokenFile: string; tenantId: string; clientId: string; scope: string };

/** Everything needed to mint an Anthropic access token, and nothing secret. */
export interface AnthropicWifSettings {
    federationRuleId: string;
    organizationId: string;
    serviceAccountId: string;
    /** Required only when the rule is enabled for more than one workspace. */
    workspaceId?: string;
    /** Host to exchange at. Overridable so a test never reaches the network. */
    baseUrl: string;
    identity: WifIdentitySource;
}

/** What `readAnthropicWifSettings` found, or precisely what was missing. */
export type WifSettingsResult =
    | { ok: true; settings: AnthropicWifSettings }
    | { ok: false; missing: string[] };

type EnvLike = Record<string, string | undefined>;

const DEFAULT_BASE_URL = "https://api.anthropic.com";

/**
 * The three ids that name the rule, the organization and the identity the
 * minted token acts as. All three are required whichever identity source is
 * used, and none of them is a secret.
 */
const REQUIRED_VARS = [
    "ANTHROPIC_FEDERATION_RULE_ID",
    "ANTHROPIC_ORGANIZATION_ID",
    "ANTHROPIC_SERVICE_ACCOUNT_ID",
] as const;

function trimmed(value: string | undefined): string {
    return typeof value === "string" ? value.trim() : "";
}

/**
 * Read the settings out of the worker's environment.
 *
 * Returns the missing variable names rather than throwing, so a worker whose
 * deployment declares the type but has not configured identity yet can say
 * which line is absent instead of failing an unrelated turn later.
 */
export function readAnthropicWifSettings(env: EnvLike = process.env): WifSettingsResult {
    const missing: string[] = REQUIRED_VARS.filter((name) => !trimmed(env[name]));

    const identity = readIdentitySource(env);
    if (!identity) {
        missing.push("ANTHROPIC_IDENTITY_TOKEN_FILE (or ANTHROPIC_IDENTITY_TOKEN, or AZURE_FEDERATED_TOKEN_FILE with AZURE_TENANT_ID)");
    }
    if (missing.length > 0 || !identity) return { ok: false, missing };

    const workspaceId = trimmed(env.ANTHROPIC_WORKSPACE_ID);
    return {
        ok: true,
        settings: {
            federationRuleId: trimmed(env.ANTHROPIC_FEDERATION_RULE_ID),
            organizationId: trimmed(env.ANTHROPIC_ORGANIZATION_ID),
            serviceAccountId: trimmed(env.ANTHROPIC_SERVICE_ACCOUNT_ID),
            ...(workspaceId ? { workspaceId } : {}),
            // The assertion posted to this host is a signed identity token, so
            // where it goes is worth naming deliberately. ANTHROPIC_BASE_URL is
            // honoured because it is the conventional override and a worker
            // that sets it means it — but a deployment that points that at a
            // gateway for unrelated reasons can pin the exchange back with
            // ANTHROPIC_WIF_TOKEN_URL.
            baseUrl: (trimmed(env.ANTHROPIC_WIF_TOKEN_URL)
                || trimmed(env.ANTHROPIC_BASE_URL)
                || DEFAULT_BASE_URL).replace(/\/+$/, ""),
            identity,
        },
    };
}

/**
 * A ready-made assertion wins over one that has to be fetched: a deployment
 * that sets `ANTHROPIC_IDENTITY_TOKEN_FILE` has said which token it means,
 * and Azure's own variables may be present on the same pod for unrelated
 * reasons (a sidecar, a storage credential) without being the intended path.
 */
function readIdentitySource(env: EnvLike): WifIdentitySource | null {
    const literal = trimmed(env.ANTHROPIC_IDENTITY_TOKEN);
    if (literal) return { kind: "literal", token: literal };

    const file = trimmed(env.ANTHROPIC_IDENTITY_TOKEN_FILE);
    if (file) return { kind: "file", path: file };

    const azureFile = trimmed(env.AZURE_FEDERATED_TOKEN_FILE);
    const tenantId = trimmed(env.AZURE_TENANT_ID);
    if (!azureFile || !tenantId) return null;

    // The identity to claim is not always the one the platform injected: a
    // pod may run under its cluster's own identity while the federation rule
    // names another that the same projected token is allowed to redeem. So an
    // explicit override wins, and the injected value is only the default.
    const clientId = trimmed(env.ANTHROPIC_WIF_AZURE_CLIENT_ID) || trimmed(env.AZURE_CLIENT_ID);
    if (!clientId) return null;

    // The audience asked for. Defaulting to the identity's own id covers a
    // rule that matches the identity as its own audience; a deployment with a
    // separate audience app registration sets the scope explicitly.
    const scope = trimmed(env.ANTHROPIC_WIF_AZURE_SCOPE) || `${clientId}/.default`;
    return { kind: "entra", tokenFile: azureFile, tenantId, clientId, scope };
}

/** Anything a provider type may declare that authenticates without a stored key. */
export class WifExchangeError extends Error {
    readonly code = "WIF_EXCHANGE_FAILED";

    constructor(message: string, readonly status?: number, readonly requestId?: string | null) {
        super(message);
        this.name = "WifExchangeError";
    }
}

export interface WifDependencies {
    fetch?: typeof globalThis.fetch;
    readFile?: (path: string) => Promise<string>;
    now?: () => number;
}

interface CachedToken {
    token: string;
    /** Epoch ms after which the token must not be used. */
    expiresAtMs: number;
}

/**
 * How early a token is replaced. A token used at the instant it expires is a
 * failed request: the clock on the far side is not this one, and the request
 * still has to travel. Half the lifetime is the ceiling so that a deliberately
 * short-lived token (the rule may set 60 seconds) is still cached for a while
 * rather than re-minted for every single request.
 */
const REFRESH_MARGIN_MS = 5 * 60_000;

function marginFor(lifetimeMs: number): number {
    return Math.min(REFRESH_MARGIN_MS, Math.max(0, Math.floor(lifetimeMs / 2)));
}

/**
 * What a lifetime is assumed to be when the response does not say.
 *
 * `expires_in` is optional in the type and could arrive absent, zero, or
 * unparseable. Treating that as "expires now" silently turns the cache OFF —
 * and because the callback runs before EVERY outbound request, that is one
 * token exchange per LLM request, for ever, until the endpoint throttles.
 * A minute is the shortest lifetime a federation rule may be configured for,
 * so assuming it can never outlive the real token.
 */
const ASSUMED_LIFETIME_MS = 60_000;

/**
 * The longest a token is trusted, however long it says it is valid.
 *
 * Nothing tells this process that a token was revoked: the rule is disabled or
 * the service account deleted, and the only symptom is that requests start
 * failing. A token cached for its full 24 hours would keep failing for 24
 * hours. Re-minting hourly costs one exchange per worker per hour and bounds
 * how long a revoked credential can keep a worker down.
 */
const MAX_CACHE_MS = 60 * 60_000;

/** When to replace a token, from whatever the endpoint claimed. */
function expiryFrom(now: number, expiresIn: unknown): number {
    const seconds = Number(expiresIn);
    const claimed = Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : ASSUMED_LIFETIME_MS;
    const lifetimeMs = Math.min(claimed, MAX_CACHE_MS);
    return now + Math.max(0, lifetimeMs - marginFor(lifetimeMs));
}

/**
 * Mints and caches the Anthropic access token for one set of settings.
 *
 * One instance serves every session on the worker. The callback is invoked
 * once per outbound request — several turns running at once is the normal
 * case, not the exception — so concurrent callers share a single exchange
 * rather than each starting their own. A failure is never cached: the next
 * request tries again, which is what recovers a worker that started before
 * its token file was mounted.
 */
export class AnthropicWifCredentials {
    private access: CachedToken | null = null;
    private assertion: CachedToken | null = null;
    private inflight: Promise<string> | null = null;
    /** Bumped by reset(), so a mint that started earlier does not store its result. */
    private generation = 0;

    private readonly fetchImpl: typeof globalThis.fetch;
    private readonly readFileImpl: (path: string) => Promise<string>;
    private readonly now: () => number;

    constructor(readonly settings: AnthropicWifSettings, deps: WifDependencies = {}) {
        this.fetchImpl = deps.fetch ?? globalThis.fetch;
        this.readFileImpl = deps.readFile ?? (async (p: string) => {
            const { readFile } = await import("node:fs/promises");
            return readFile(p, "utf8");
        });
        this.now = deps.now ?? Date.now;
    }

    /** A valid Anthropic access token, minted or from cache. */
    async getToken(): Promise<string> {
        const cached = this.access;
        if (cached && this.now() < cached.expiresAtMs) return cached.token;
        if (this.inflight) return this.inflight;

        const startedIn = this.generation;
        const run = this.mint()
            .then((minted) => {
                // Discarded by a reset() that landed while this was in flight:
                // the token is still returned to whoever asked for it, but it
                // is not written into a cache that was deliberately emptied.
                if (this.generation === startedIn) this.access = minted;
                return minted.token;
            })
            .finally(() => {
                if (this.generation === startedIn) this.inflight = null;
            });
        this.inflight = run;
        return run;
    }

    /**
     * Drop what is cached. For tests, and for a caller that saw a 401.
     *
     * The generation bump is the point. Clearing the fields alone does not
     * work while an exchange is in flight: that exchange resolves afterwards
     * and writes the very token this was called to discard straight back into
     * the cache. A mint only stores its result if the generation it started
     * in is still current.
     */
    reset(): void {
        this.access = null;
        this.assertion = null;
        this.generation += 1;
        this.inflight = null;
    }

    private async mint(): Promise<CachedToken> {
        const assertion = await this.identityToken();
        const body: Record<string, string> = {
            grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
            assertion,
            federation_rule_id: this.settings.federationRuleId,
            organization_id: this.settings.organizationId,
            service_account_id: this.settings.serviceAccountId,
        };
        // Sending an empty workspace is not the same as not naming one: the
        // exchange validates the shape of the value it is given.
        if (this.settings.workspaceId) body.workspace_id = this.settings.workspaceId;

        const response = await this.fetchImpl(`${this.settings.baseUrl}/v1/oauth/token`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
        });

        if (!response.ok) {
            // Throw the cached assertion away with it. That token is what was
            // just refused, and it may be cached for hours — without this a
            // retrying worker keeps presenting the same rejected assertion
            // until it expires on its own.
            this.assertion = null;
            // Every denial is the same opaque 401 with the same sentence —
            // which check failed is recorded against the request id in the
            // Anthropic console's authentication history, and is unknowable
            // from here. Carrying the id is the difference between a
            // diagnosable failure and a shrug.
            const requestId = response.headers?.get?.("request-id") ?? null;
            throw new WifExchangeError(
                `Anthropic token exchange failed with HTTP ${response.status}`
                + `${requestId ? ` (request id ${requestId})` : ""}.`
                + " Check the authentication history in the Anthropic console for the reason.",
                response.status,
                requestId,
            );
        }

        // Guarded like the Entra hop: a 200 carrying something that is not
        // JSON (an intercepting proxy, an HTML error page) must still surface
        // as a WifExchangeError with the guidance below, not a raw SyntaxError.
        const payload = await response.json().catch(() => ({})) as { access_token?: string; expires_in?: number };
        const token = typeof payload.access_token === "string" ? payload.access_token : "";
        if (!token) {
            throw new WifExchangeError("Anthropic token exchange returned no access_token.", response.status);
        }
        return { token, expiresAtMs: expiryFrom(this.now(), payload.expires_in) };
    }

    /** The JWT presented to Anthropic as the assertion. */
    private async identityToken(): Promise<string> {
        const source = this.settings.identity;
        if (source.kind === "literal") return source.token;
        if (source.kind === "file") return (await this.readFileImpl(source.path)).trim();

        const cached = this.assertion;
        if (cached && this.now() < cached.expiresAtMs) return cached.token;
        const minted = await this.entraToken(source);
        this.assertion = minted;
        return minted.token;
    }

    /**
     * Redeem the Kubernetes-projected token for an Entra-issued one.
     *
     * The projected token is read fresh every time: Kubernetes rewrites that
     * file as it rotates, and the copy this process read at startup stops
     * verifying the moment it does.
     */
    private async entraToken(source: Extract<WifIdentitySource, { kind: "entra" }>): Promise<CachedToken> {
        const projected = (await this.readFileImpl(source.tokenFile)).trim();
        const form = new URLSearchParams({
            grant_type: "client_credentials",
            client_id: source.clientId,
            scope: source.scope,
            client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
            client_assertion: projected,
        });

        const response = await this.fetchImpl(
            `https://login.microsoftonline.com/${encodeURIComponent(source.tenantId)}/oauth2/v2.0/token`,
            {
                method: "POST",
                headers: { "content-type": "application/x-www-form-urlencoded" },
                body: form.toString(),
            },
        );

        const payload = await response.json().catch(() => ({})) as {
            access_token?: string; expires_in?: number; error?: string; error_description?: string;
        };
        if (!response.ok || !payload.access_token) {
            // Entra says exactly what is wrong (a missing audience app, an
            // unfederated service account), and its first line is the useful
            // one — the rest is a stack of correlation ids.
            const detail = String(payload.error_description ?? payload.error ?? "").split("\n")[0];
            throw new WifExchangeError(
                `Microsoft Entra token request failed with HTTP ${response.status}${detail ? `: ${detail}` : "."}`,
                response.status,
            );
        }

        return { token: payload.access_token, expiresAtMs: expiryFrom(this.now(), payload.expires_in) };
    }
}

/**
 * The worker's own credentials, made once and shared.
 *
 * Keyed by the settings themselves so that a test which changes the
 * environment gets a fresh instance, while every session in a running worker
 * shares one cache and one in-flight exchange.
 */
const instances = new Map<string, AnthropicWifCredentials>();

export function anthropicWifCredentials(
    settings: AnthropicWifSettings,
    deps: WifDependencies = {},
): AnthropicWifCredentials {
    const key = JSON.stringify(settings);
    let found = instances.get(key);
    if (!found) {
        found = new AnthropicWifCredentials(settings, deps);
        instances.set(key, found);
    }
    return found;
}

/** Forget every shared instance. Tests only. */
export function resetAnthropicWifCredentials(): void {
    instances.clear();
}

/**
 * Give a workload-identity provider the callback that authenticates it.
 *
 * Every other provider reaches the Copilot SDK carrying its own key. This one
 * carries a function, because the token it would carry instead expires long
 * before the session does — a session resumed days later on another worker
 * would come back with a dead credential baked into its config. The SDK keeps
 * the callback client-side and asks for a token before each outbound request,
 * so a token lives only as long as the call it authenticates.
 *
 * Called on the path that builds the SDK options and nowhere earlier: that
 * object is rebuilt from the registry on every create and resume, and is
 * never persisted. (`providerFingerprint` hashes the same object through
 * JSON.stringify, which drops function-valued keys, so the fingerprint stays
 * stable and a resume does not read as a provider change.)
 *
 * A provider that is not workload-identity is returned untouched, by
 * identity, so this is safe to call on the whole path.
 */
export function attachWorkloadIdentity(
    resolved: {
        providerId: string;
        usesWorkloadIdentity?: boolean | undefined;
        sdkProvider?: ResolvedProvider["sdkProvider"];
    },
    deps: { env?: EnvLike; credentials?: (settings: AnthropicWifSettings) => { getToken(): Promise<string> } } = {},
): Record<string, unknown> {
    const provider = resolved.sdkProvider as Record<string, unknown>;
    if (!resolved.usesWorkloadIdentity) return provider;

    // Said once at session creation, naming the variables that are absent,
    // rather than as an opaque 401 on the first turn of every session that
    // ever names this provider.
    const found = readAnthropicWifSettings(deps.env ?? process.env);
    if (!found.ok) {
        throw new Error(
            `Provider "${resolved.providerId}" authenticates with workload identity, `
            + `but the worker is missing ${found.missing.join(", ")}.`);
    }
    const credentials = (deps.credentials ?? anthropicWifCredentials)(found.settings);
    return { ...provider, bearerTokenProvider: () => credentials.getToken() };
}
