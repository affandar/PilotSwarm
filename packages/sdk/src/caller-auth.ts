/**
 * Delegated MCP access — caller credential store (AKV stopgap).
 *
 * When a caller creates a session with delegated credentials (one bearer token
 * per downstream MCP audience its repo-declared servers require — e.g. an
 * Azure DevOps-audience token for a code-intelligence server, and a separate
 * token for a service that exposes its own `api://` app), the platform must
 * present the RIGHT token to each
 * repo-declared MCP server "as the user" — WITHOUT baking any of them into the
 * durable orchestration payload (replayed in history) or into a plaintext
 * Postgres column.
 *
 * The client mints those tokens up front (it holds the consent) and sends an
 * `{ audience: token }` map. This module implements the stopgap store for it:
 *   - The map is JSON-serialized and written to Azure Key Vault under a name
 *     DERIVED from the session id (`ps-caller-<sessionId>`), so no session-row
 *     column / DB migration is needed — the worker recomputes the name and
 *     matches each server's discovered `aud` against the map keys.
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
 * Caller-supplied delegated credentials accepted at session creation. Only
 * `audienceTokens` is required; the rest tune persistence/authorization tagging.
 */
export interface CallerAuthInput {
    /** The caller's `{ audience: token }` map — one delegated bearer per
     * downstream audience its servers require (never logged). */
    audienceTokens: Record<string, string>;
    /** MCP server ids the caller intends these tokens for (informational tag). */
    allowedServers?: string[];
    /** Secret lifetime in seconds; defaults to 2h. */
    ttlSeconds?: number;
}

export interface StoreCallerAuthOptions {
    vaultName: string;
    sessionId: string;
    /** The caller's `{ audience: token }` map (never logged). */
    audienceTokens: Record<string, string>;
    /** Owner principal, stored as non-secret tags for a confused-deputy check. */
    owner?: { provider?: string | null; subject?: string | null } | null;
    /** Server ids the tokens are authorized for (informational tag today). */
    allowedServers?: string[];
    /** Secret lifetime; defaults to 2h (caps exposure; tokens themselves are short-lived). */
    ttlSeconds?: number;
    trace?: (message: string) => void;
}

/**
 * Persist a caller's delegated credentials for `sessionId` as a single Key Vault
 * secret whose value is the JSON-serialized `{ audience: token }` map. Returns
 * the secret name written (the ref the worker recomputes).
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
        value: JSON.stringify(opts.audienceTokens ?? {}),
        expiresUnix,
        tags,
        trace: opts.trace,
    });
    return secretName;
}

/**
 * Resolve the caller's `{ audience: token }` map for `sessionId`, or null when
 * none was stored (the common case — a session created without delegated
 * credentials). Absence (Key Vault 404) is not an error; neither is a malformed
 * secret value (treated as "no delegated auth", surfaced in trace).
 */
export async function resolveCallerAuth(opts: {
    vaultName: string;
    sessionId: string;
    trace?: (message: string) => void;
}): Promise<Record<string, string> | null> {
    const secretName = callerAuthSecretName(opts.sessionId);
    let raw: string | null;
    try {
        raw = await getKeyVaultSecretOptional({
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
    if (raw == null) return null;
    try {
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
            opts.trace?.(`[caller-auth] secret ${secretName} is not a JSON object; ignoring`);
            return null;
        }
        const map: Record<string, string> = {};
        for (const [aud, tok] of Object.entries(parsed as Record<string, unknown>)) {
            if (typeof tok === "string" && tok.length > 0) map[aud] = tok;
        }
        return Object.keys(map).length > 0 ? map : null;
    } catch (err: any) {
        opts.trace?.(`[caller-auth] secret ${secretName} JSON parse failed: ${err?.message ?? err}`);
        return null;
    }
}
