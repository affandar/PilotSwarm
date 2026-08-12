/**
 * Generic MCP upstream-auth resolution (discovery-driven, no static mapping).
 *
 * A repo-pinned worker loads the MCP servers a repository declares in its
 * `.vscode/mcp.json` and must connect to each "as the calling user".
 * Different servers require tokens for DIFFERENT audiences (one server wants the
 * Azure DevOps first-party app; another wants its own `api://<app-id>`), and
 * this file ships in a PUBLIC GitHub repo — so we must NOT hardcode any
 * server→audience table. Instead we discover each server's required audience at
 * runtime, exactly as a spec-compliant MCP client would:
 *
 *   1. Send an UNAUTHENTICATED MCP `initialize` probe to the server URL.
 *   2. On HTTP 401, read the `WWW-Authenticate: Bearer` challenge (RFC 6750).
 *   3. Follow its `resource_metadata` URL (RFC 9728) to the protected-resource
 *      metadata document and read `scopes_supported` / `resource` — that yields
 *      the audience the server accepts.
 *   4. If (and only if) the CALLER's delegated token is minted for that
 *      audience, inject it as `Authorization: Bearer <token>` ("as the user").
 *
 * SECURITY — the caller's identity is the ONLY identity that ever reaches an
 * upstream MCP server. We deliberately DO NOT fall back to the worker's managed
 * identity for the upstream connection: doing so would let a customer's session
 * borrow the platform's privileges (a confused-deputy escalation). The worker
 * MI is used solely to read the caller token out of Key Vault (control plane),
 * never presented to a data-plane MCP server. When no caller credential matches
 * a server's audience we FAST-FAIL the session with a clear error.
 *
 * This mirrors the discovery flow of a spec-compliant MCP client / auth proxy
 * (RFC 6750 bearer-challenge resolution + RFC 9728 protected-resource-metadata
 * lookup), but resolves auth PRE-FLIGHT (before handing config to the Copilot
 * CLI), because our architecture has no in-path proxy to catch the 401 lazily.
 *
 * @module
 */

// ─── WWW-Authenticate (RFC 6750 §3) ─────────────────────────────

export interface WwwAuthenticate {
    /** RFC 9728 `resource_metadata` URL pointing at the PRM document. */
    resourceMetadata?: string;
    /** Inline `scope` parameter, when the server states it directly. */
    scope?: string;
    /** Non-standard `resource_id` some Microsoft resources emit (audience). */
    resourceId?: string;
    /** Non-standard `authorization_uri` (Entra authorize endpoint). */
    authorizationUri?: string;
    error?: string;
    errorDescription?: string;
}

/**
 * Parse a `WWW-Authenticate: Bearer ...` header value into its parameters.
 * Tolerant of the `Bearer `  prefix and quoted values, per RFC 6750 §3.
  */
export function parseWwwAuthenticate(headerValue: string): WwwAuthenticate {
    const out: WwwAuthenticate = {};
    const s = headerValue.replace(/^Bearer\s+/i, "");
    for (const rawPart of s.split(",")) {
        const part = rawPart.trim();
        const eq = part.indexOf("=");
        if (eq < 0) continue;
        const key = part.slice(0, eq).trim().toLowerCase();
        const val = part.slice(eq + 1).trim().replace(/^"|"$/g, "");
        switch (key) {
            case "resource_metadata": out.resourceMetadata = val; break;
            case "scope": out.scope = val; break;
            case "resource_id": out.resourceId = val; break;
            case "authorization_uri": out.authorizationUri = val; break;
            case "error": out.error = val; break;
            case "error_description": out.errorDescription = val; break;
        }
    }
    return out;
}

// ─── Protected Resource Metadata (RFC 9728) ─────────────────────

export interface ProtectedResourceMetadata {
    resource?: string;
    authorizationServers?: string[];
    scopesSupported?: string[];
}

// ─── Scope / audience helpers ───────────────────────────────────

/**
 * Reduce an OAuth scope to its app-id-URI (audience): strip a trailing
 * `/.default` (or any delegated
 * permission segment) and keep `<scheme>://<host>` when a scheme is present.
 *
 *   "<app-guid>/.default"                    → "<app-guid>"
 *   "api://<app-guid>/.default"              → "api://<app-guid>"
 *   "https://resource.example.net/.default"  → "https://resource.example.net"
 *   "api://app-id/access_as_user"            → "api://app-id"
 */
export function appIdUriFromScope(scope: string): string {
    const noDefault = scope.endsWith("/.default") ? scope.slice(0, -"/.default".length) : scope;
    const schemeIdx = noDefault.indexOf("://");
    if (schemeIdx < 0) {
        // No scheme (e.g. a bare GUID audience): drop any trailing path segment.
        const slash = noDefault.indexOf("/");
        return slash < 0 ? noDefault : noDefault.slice(0, slash);
    }
    const afterScheme = schemeIdx + 3;
    const slash = noDefault.indexOf("/", afterScheme);
    return slash < 0 ? noDefault : noDefault.slice(0, slash);
}

/** Normalize an audience for comparison: drop an `api://` prefix and any
 * trailing slash, l-case. `api://<guid>` and a bare `<guid>` compare equal. */
export function normalizeAudience(aud: string): string {
    return aud.replace(/^api:\/\//i, "").replace(/\/+$/, "").toLowerCase();
}

/** Decode the `aud` claim(s) of a JWT WITHOUT verifying the signature (we only
 * need the audience to decide which server a caller token is for; the upstream
 * server does the real validation). Returns [] on any parse failure. */
export function decodeJwtAudiences(token: string): string[] {
    const parts = token.split(".");
    if (parts.length < 2) return [];
    try {
        const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
        const json = Buffer.from(b64, "base64").toString("utf8");
        const payload = JSON.parse(json);
        const aud = payload?.aud;
        if (Array.isArray(aud)) return aud.map((a: unknown) => String(a));
        if (typeof aud === "string") return [aud];
        return [];
    } catch {
        return [];
    }
}

/** True when a caller token minted for `tokenAudiences` is accepted by a server
 * whose discovered required audience is `requiredAppIdUri`. */
export function audienceMatches(requiredAppIdUri: string, tokenAudiences: string[]): boolean {
    const need = normalizeAudience(requiredAppIdUri);
    return tokenAudiences.some((a) => normalizeAudience(a) === need);
}

// ─── HTTP primitives (injectable for tests) ─────────────────────

export interface ProbeResult {
    status: number;
    wwwAuthenticate?: string;
}

export interface HttpDeps {
    /** Unauthenticated MCP `initialize` probe. Returns status + challenge. */
    probe: (url: string, headers: Record<string, string>) => Promise<ProbeResult>;
    /** HTTPS GET returning body text (used for the PRM document). */
    getText: (url: string) => Promise<{ status: number; body: string }>;
}

/** Default HTTP deps backed by global fetch (Node 18+). */
export function defaultHttpDeps(): HttpDeps {
    const MCP_INIT_BODY = JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
            protocolVersion: "2024-11-05",
            capabilities: {},
            clientInfo: { name: "pilotswarm-mcp-auth-probe", version: "0" },
        },
    });
    return {
        async probe(url, headers) {
            const res = await fetch(url, {
                method: "POST",
                headers: {
                    "content-type": "application/json",
                    accept: "application/json, text/event-stream",
                    ...headers,
                },
                body: MCP_INIT_BODY,
            });
            return { status: res.status, wwwAuthenticate: res.headers.get("www-authenticate") ?? undefined };
        },
        async getText(url) {
            const res = await fetch(url, { method: "GET" });
            return { status: res.status, body: await res.text() };
        },
    };
}

// ─── Discovery ──────────────────────────────────────────────────

export interface DiscoveredAudience {
    /** The app-id-URI (audience) a caller token must be minted for. */
    appIdUri: string;
    /** The full scope string (`<appIdUri>/.default`) if useful downstream. */
    scope: string;
    /** Authorization servers from the PRM document (informational/logging). */
    authorizationServers: string[];
}

/**
 * Discover the audience a remote MCP server requires, by probing it and
 * following its RFC 6750 → RFC 9728 challenge chain. Returns:
 *   - a `DiscoveredAudience` when the server demands a bearer;
 *   - `null` when the server needs no auth (probe did not 401 with a usable
 *     challenge) — the caller should connect unauthenticated.
 */
export async function discoverServerAudience(
    serverUrl: string,
    serverHeaders: Record<string, string>,
    http: HttpDeps,
    trace: (m: string) => void,
): Promise<DiscoveredAudience | null> {
    const probe = await http.probe(serverUrl, serverHeaders);
    if (probe.status !== 401 || !probe.wwwAuthenticate) {
        trace(`[mcp-auth] probe ${serverUrl} -> HTTP ${probe.status} (no bearer challenge); treating as no-auth`);
        return null;
    }
    const wa = parseWwwAuthenticate(probe.wwwAuthenticate);
    trace(`[mcp-auth] probe ${serverUrl} -> 401; WWW-Authenticate parsed: ${JSON.stringify(wa)}`);

    // Path A — RFC 9728: follow the resource_metadata URL to the PRM document.
    if (wa.resourceMetadata) {
        if (!/^https:\/\//i.test(wa.resourceMetadata)) {
            // SSRF guard: never fetch a non-https metadata URL from an attacker-
            // controllable header.
            trace(`[mcp-auth] resource_metadata URL is not https, refusing to fetch: ${wa.resourceMetadata}`);
            return null;
        }
        const md = await http.getText(wa.resourceMetadata);
        if (md.status < 200 || md.status >= 300) {
            trace(`[mcp-auth] PRM fetch ${wa.resourceMetadata} -> HTTP ${md.status}; cannot discover audience`);
            return null;
        }
        let prm: ProtectedResourceMetadata;
        try {
            const raw = JSON.parse(md.body);
            prm = {
                resource: raw.resource,
                authorizationServers: raw.authorization_servers,
                scopesSupported: raw.scopes_supported,
            };
        } catch (e: any) {
            trace(`[mcp-auth] PRM parse failed for ${wa.resourceMetadata}: ${e?.message ?? e}`);
            return null;
        }
        const scope =
            wa.scope ||
            (prm.scopesSupported && prm.scopesSupported.length > 0 ? prm.scopesSupported[0] : undefined) ||
            (prm.resource ? `${prm.resource}/.default` : undefined);
        if (!scope) {
            trace(`[mcp-auth] PRM for ${serverUrl} had no scope/resource; cannot discover audience`);
            return null;
        }
        const appIdUri = appIdUriFromScope(scope);
        trace(
            `[mcp-auth] discovered audience for ${serverUrl}: appIdUri=${appIdUri} scope=${scope} ` +
                `authServers=${JSON.stringify(prm.authorizationServers ?? [])}`,
        );
        return { appIdUri, scope, authorizationServers: prm.authorizationServers ?? [] };
    }

    // Path B — non-standard Microsoft form: resource_id (+ optional
    // authorization_uri) directly in the header, no PRM document to fetch.
    if (wa.resourceId) {
        const scope = wa.scope || `${wa.resourceId}/.default`;
        const appIdUri = appIdUriFromScope(scope);
        trace(`[mcp-auth] discovered audience for ${serverUrl} via resource_id: appIdUri=${appIdUri}`);
        return { appIdUri, scope, authorizationServers: wa.authorizationUri ? [wa.authorizationUri] : [] };
    }

    // Path C — inline scope only.
    if (wa.scope) {
        const appIdUri = appIdUriFromScope(wa.scope);
        trace(`[mcp-auth] discovered audience for ${serverUrl} via inline scope: appIdUri=${appIdUri}`);
        return { appIdUri, scope: wa.scope, authorizationServers: [] };
    }

    trace(`[mcp-auth] 401 from ${serverUrl} but challenge had no resource_metadata/resource_id/scope; cannot discover`);
    return null;
}

// ─── Per-server resolution ──────────────────────────────────────

/** True when an MCP server config is a remote (http/sse) server. */
function isRemoteMcpServer(cfg: any): boolean {
    return !!cfg && (cfg.type === "http" || cfg.type === "sse" || (typeof cfg.url === "string" && !cfg.command));
}

function hasAuthorizationHeader(cfg: any): boolean {
    const headers = cfg?.headers;
    return !!headers && Object.keys(headers).some((h) => h.toLowerCase() === "authorization");
}

export class McpAuthFastFailError extends Error {
    constructor(
        public readonly serverName: string,
        public readonly requiredAudience: string,
        message: string,
    ) {
        super(message);
        this.name = "McpAuthFastFailError";
    }
}

/** The audience a server demands, as discovered at runtime. */
export interface RequiredAudience {
    /** The app-id-URI (audience) a caller token must be minted for. */
    appIdUri: string;
    /** The full scope string (`<appIdUri>/.default`) to request a token for. */
    scope: string;
}

/**
 * Resolve a delegated (caller) token for a specific discovered audience, or
 * `null` when the caller cannot obtain one for that audience.
 *
 * This is the SEAM that makes upstream auth generic: `resolveMcpServerAuth`
 * discovers each server's required audience and asks the provider for a token
 * FOR THAT AUDIENCE — it never inspects a fixed token itself. Build one with
 * {@link multiTokenProvider} (the client-mints model: a caller-supplied
 * `{ audience: token }` map keyed by audience).
 *
 * A provider MUST only ever return a token that represents the CALLER. It must
 * never substitute the platform's own identity; returning `null` triggers the
 * fast-fail (or phase-2 skip) in `resolveMcpServerAuth`.
 */
export type CallerTokenProvider = (required: RequiredAudience) => Promise<string | null>;

/**
 * The client-mints provider: a caller-supplied `{ audience: token }` map, each
 * value a bearer the CALLER already minted for that audience. Given a server's
 * discovered audience, returns the token whose key matches (normalized compare)
 * — else `null`, which triggers the fast-fail in {@link resolveMcpServerAuth}.
 *
 * This is the delegated-MCP model in force: the client mints one token per
 * required audience up front (it holds the consent) and the worker only ROUTES
 * by discovered `aud`. No server→audience table (public repo), no On-Behalf-Of
 * exchange, and the worker identity is never presented upstream. Keys are
 * matched by {@link normalizeAudience} so `api://<guid>` and a bare `<guid>`
 * compare equal; empty/blank token values are ignored.
 */
export function multiTokenProvider(
    audienceTokens: Record<string, string> | null | undefined,
): CallerTokenProvider {
    const byAud = new Map<string, string>();
    for (const [aud, tok] of Object.entries(audienceTokens ?? {})) {
        if (typeof tok === "string" && tok.length > 0) {
            byAud.set(normalizeAudience(aud), tok);
        }
    }
    return async ({ appIdUri }) => byAud.get(normalizeAudience(appIdUri)) ?? null;
}

export interface ResolveMcpAuthOptions {
    servers: Record<string, any>;
    /**
     * Per-audience token provider. Given a server's discovered audience, returns
     * a caller token for it or `null`. Build one with {@link multiTokenProvider}.
     */
    getCallerToken?: CallerTokenProvider | null;
    http?: HttpDeps;
    trace?: (m: string) => void;
}

export interface ResolveMcpAuthResult {
    servers: Record<string, any>;
    injected: string[];
}

/**
 * Resolve upstream auth for every remote MCP server in `servers`, injecting a
 * caller token (obtained per-audience from the provider) into each server whose
 * discovered audience the caller can satisfy.
 *
 * Behavior per remote server that lacks an explicit `Authorization` header:
 *   - Probe + discover its required audience.
 *   - No audience discovered (open server) → leave unauthenticated.
 *   - Provider returns a token for that audience → inject it.
 *   - Provider returns `null` (no caller credential for it) → **FAST-FAIL**.
 *
 * TODO(delegated-mcp, phase 2): instead of fast-failing when the provider has no
 * credential for a server's audience, SKIP that server (drop it from the map)
 * so the session still runs with whatever servers the caller CAN reach. Kept as
 * a hard fail for now so the gap is loud and obvious during bring-up.
 *
 * The worker managed identity is intentionally never used as a fallback for the
 * upstream connection (confused-deputy protection).
 */
export async function resolveMcpServerAuth(opts: ResolveMcpAuthOptions): Promise<ResolveMcpAuthResult> {
    const trace = opts.trace ?? (() => {});
    const http = opts.http ?? defaultHttpDeps();
    const provider: CallerTokenProvider | null = opts.getCallerToken ?? null;
    if (provider) {
        trace(`[mcp-auth] caller token provider present; per-audience tokens resolved at connect time`);
    } else {
        trace(`[mcp-auth] no caller token provider supplied for this session`);
    }

    const out: Record<string, any> = {};
    const injected: string[] = [];

    for (const [name, cfg] of Object.entries(opts.servers ?? {})) {
        if (!isRemoteMcpServer(cfg)) {
            out[name] = cfg;
            continue;
        }
        if (hasAuthorizationHeader(cfg)) {
            trace(`[mcp-auth] server "${name}": explicit Authorization present, leaving as-is`);
            out[name] = cfg;
            continue;
        }

        const url: string = cfg.url;
        const headers: Record<string, string> = { ...(cfg.headers ?? {}) };
        // TODO(delegated-mcp, perf): a server URL -> discovered audience binding is
        // effectively IMMUTABLE (a server's protected-resource-metadata / required
        // audience does not change turn-to-turn), yet we re-probe every remote
        // server on every turn (two network round-trips per server: RFC 6750
        // challenge + RFC 9728 PRM). Cache the resolved `{ url -> DiscoveredAudience }`
        // out-of-band and consult it before probing (probe only on cache miss or a
        // 401 that no longer matches). Store the cache IN-CLUSTER (e.g. the worker's
        // durable/redis layer or a mounted config), NOT in this repo — this ships
        // in a PUBLIC repo, so no server->audience table may live in the source.
        let discovered: DiscoveredAudience | null = null;
        try {
            discovered = await discoverServerAudience(url, headers, http, trace);
        } catch (e: any) {
            trace(`[mcp-auth] server "${name}": discovery error: ${e?.message ?? e}`);
            discovered = null;
        }

        if (!discovered) {
            // No auth required (or undiscoverable): connect unauthenticated.
            trace(`[mcp-auth] server "${name}": no discoverable auth requirement; connecting unauthenticated`);
            out[name] = cfg;
            continue;
        }

        // Ask the provider for a token minted for THIS server's discovered
        // audience. The provider owns HOW that token is obtained (static match
        // or On-Behalf-Of exchange); we only inject what it returns.
        let token: string | null = null;
        if (provider) {
            try {
                token = await provider({ appIdUri: discovered.appIdUri, scope: discovered.scope });
            } catch (e: any) {
                trace(`[mcp-auth] server "${name}": token provider error: ${e?.message ?? e}`);
                token = null;
            }
        }

        if (token) {
            headers.Authorization = `Bearer ${token}`;
            out[name] = { ...cfg, headers };
            injected.push(name);
            trace(
                `[mcp-auth] server "${name}": obtained caller token for ${normalizeAudience(discovered.appIdUri)}; ` +
                    `injected delegated Authorization (as the user)`,
            );
            continue;
        }

        // No caller credential for this audience. Never substitute platform
        // identity. Fast-fail (see phase-2 TODO above to skip instead).
        const msg =
            `[mcp-auth] FAST-FAIL: server "${name}" requires audience ` +
            `"${normalizeAudience(discovered.appIdUri)}" but the caller could not obtain a matching ` +
            `credential. Refusing to connect as the platform identity.`;
        trace(msg);
        throw new McpAuthFastFailError(name, normalizeAudience(discovered.appIdUri), msg);
    }

    return { servers: out, injected };
}
