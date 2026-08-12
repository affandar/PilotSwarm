/**
 * Delegated MCP access — caller credential store (AKV stopgap).
 *
 * When a caller creates a session with a delegated credential (their bearer
 * token for a downstream MCP audience, e.g. an Azure DevOps-audience token that
 * a repo-declared MCP server accepts), the platform must present that token
 * to the repo-declared MCP servers "as the user" — WITHOUT baking it into the
 * durable orchestration payload (replayed in history) or into a plaintext
 * Postgres column.
 *
 * This module implements the stopgap agreed for the first cut:
 *   - The token is written to Azure Key Vault under a name DERIVED from the
 *     session id (`ps-caller-<sessionId>`), so no session-row column / DB
 *     migration is needed — the worker recomputes the name from the session id.
 *   - The secret carries an `exp` attribute (TTL) and `tags` (owner principal,
 *     allowed server ids) for a confused-deputy check and a future sweeper.
 *   - The portal writes it at create time (its identity has Key Vault write);
 *     the worker reads it at session-create time via its managed identity
 *     (Key Vault Secrets User) and injects `Authorization: Bearer <token>` into
 *     the repo-loaded remote MCP servers that lack an explicit auth header.
 *
 * Key Vault does NOT auto-purge on `exp` — it only marks the secret unusable.
 * A periodic sweeper (deleting expired secrets, and secrets for terminal
 * sessions) is a follow-up; the `exp` bound caps the exposure window regardless.
 */

import { getKeyVaultSecretOptional, putKeyVaultSecret } from "./plugin-spec.js";

/** Key Vault secret-name charset is `^[0-9a-zA-Z-]+$`. Session ids are GUIDs
 * (already safe); sanitize defensively so a non-GUID id can never break the
 * name or collide across sessions. */
export function callerAuthSecretName(sessionId: string): string {
    const safe = String(sessionId).replace(/[^0-9a-zA-Z-]+/g, "-").slice(0, 100);
    return `ps-caller-${safe}`;
}

/**
 * Caller-supplied delegated credential payload accepted at session creation.
 * Only `token` is required; the rest tune persistence/authorization tagging.
 */
export interface CallerAuthInput {
    /** The caller's delegated bearer token (never logged). */
    token: string;
    /** MCP server ids the caller intends this token for (informational tag). */
    allowedServers?: string[];
    /** Secret lifetime in seconds; defaults to 2h. */
    ttlSeconds?: number;
}

export interface StoreCallerAuthOptions {
    vaultName: string;
    sessionId: string;
    /** The caller's delegated bearer token (never logged). */
    token: string;
    /** Owner principal, stored as non-secret tags for a confused-deputy check. */
    owner?: { provider?: string | null; subject?: string | null } | null;
    /** Server ids the token is authorized for (informational tag today). */
    allowedServers?: string[];
    /** Secret lifetime; defaults to 2h (caps exposure; token itself is short-lived). */
    ttlSeconds?: number;
    trace?: (message: string) => void;
}

/**
 * Persist a caller's delegated credential for `sessionId` as a Key Vault secret.
 * Returns the secret name written (the ref the worker recomputes).
 */
export async function storeCallerAuth(opts: StoreCallerAuthOptions): Promise<string> {
    const secretName = callerAuthSecretName(opts.sessionId);
    const ttl = opts.ttlSeconds && opts.ttlSeconds > 0 ? opts.ttlSeconds : 2 * 60 * 60;
    const expiresUnix = Math.floor(Date.now() / 1000) + ttl;
    const tags: Record<string, string> = { psCallerAuth: "1", sessionId: String(opts.sessionId).slice(0, 120) };
    if (opts.owner?.provider) tags.ownerProvider = String(opts.owner.provider).slice(0, 120);
    if (opts.owner?.subject) tags.ownerSubject = String(opts.owner.subject).slice(0, 120);
    if (opts.allowedServers && opts.allowedServers.length > 0) {
        tags.allowedServers = opts.allowedServers.join(",").slice(0, 240);
    }
    await putKeyVaultSecret({
        vaultName: opts.vaultName,
        secretName,
        value: opts.token,
        expiresUnix,
        tags,
        trace: opts.trace,
    });
    return secretName;
}

/**
 * Resolve the caller credential for `sessionId`, or null when none was stored
 * (the common case — a session created without a delegated credential). Absence
 * (Key Vault 404) is not an error.
 */
export async function resolveCallerAuth(opts: {
    vaultName: string;
    sessionId: string;
    trace?: (message: string) => void;
}): Promise<string | null> {
    const secretName = callerAuthSecretName(opts.sessionId);
    try {
        return await getKeyVaultSecretOptional({
            vaultName: opts.vaultName,
            secretName,
            trace: opts.trace,
        });
    } catch (err: any) {
        // A real Key Vault error (not 404) must not take the turn down — the
        // session simply runs without delegated MCP auth. Surface it in trace.
        opts.trace?.(`[caller-auth] resolve failed for ${secretName}: ${err?.message ?? err}`);
        return null;
    }
}

/** True when an MCP server config is a remote (http/sse) server. */
function isRemoteMcpServer(cfg: any): boolean {
    return !!cfg && (cfg.type === "http" || cfg.type === "sse" || (typeof cfg.url === "string" && !cfg.command));
}

/**
 * Inject `Authorization: Bearer <token>` into remote MCP servers that do not
 * already carry an explicit `Authorization` header. Mutates a SHALLOW copy of
 * each affected server (never the shared catalog object) and returns a new map.
 *
 * Only remote servers are touched — stdio servers run locally as the worker and
 * do not take a bearer. A server that already declares an Authorization header
 * (repo author supplied one) is left as-is.
 */
export function injectMcpAuthorization(
    servers: Record<string, any>,
    token: string,
    opts?: { only?: string[]; trace?: (message: string) => void },
): { servers: Record<string, any>; injected: string[] } {
    const only = opts?.only && opts.only.length > 0 ? new Set(opts.only) : null;
    const out: Record<string, any> = {};
    const injected: string[] = [];
    for (const [name, cfg] of Object.entries(servers ?? {})) {
        if (!isRemoteMcpServer(cfg) || (only && !only.has(name))) {
            out[name] = cfg;
            continue;
        }
        const headers: Record<string, string> = { ...(cfg.headers ?? {}) };
        const hasAuth = Object.keys(headers).some((h) => h.toLowerCase() === "authorization");
        if (hasAuth) {
            out[name] = cfg;
            continue;
        }
        headers.Authorization = `Bearer ${token}`;
        out[name] = { ...cfg, headers };
        injected.push(name);
    }
    if (injected.length > 0) {
        opts?.trace?.(`[caller-auth] injected delegated Authorization into MCP server(s): ${injected.join(", ")}`);
    }
    return { servers: out, injected };
}
