/**
 * In-memory user-context store (Phase 1 + Phase 2).
 *
 * Two maps with different purposes and lifetimes (per ImplementationPlan
 * Phase 2 — single-source-of-truth invariant, FR-021):
 *
 *   - `entries` (sessionId → UserContext) — populated only at successful
 *     envelope decryption on a worker-bound RPC. Cleared on terminal
 *     state OR session dehydration (token material never persists past
 *     a session leaving warm memory). Recovery: the next envelope-bearing
 *     RPC after rehydration repopulates.
 *
 *   - `parentMap` (sessionId → { parentSessionId, isSystem }) — structural
 *     metadata used only for the `lookup` chain walk. Carries NO token
 *     material. Populated on `bindParent` (called from `getOrCreate`
 *     hydrate/create paths, walking the CMS-recorded ancestor chain
 *     once per session per worker). Persists across dehydrate cycles so
 *     descendants can still resolve to the portal-bound ancestor even
 *     if intermediate sessions have been evicted from warm memory.
 *
 * API:
 *   - `setUserContext(sessionId, envelope)` — populate / replace entry
 *   - `bindParent(sessionId, meta)` — populate parent-map entry (idempotent)
 *   - `hasParentBinding(sessionId)` — guard used by getOrCreate to skip
 *     redundant CMS walks
 *   - `lookup(sessionId)` — synchronous chain walk; FR-009 (isSystem →
 *     null), FR-021 (single source of truth via chain), FR-022 (fail-safe
 *     null when chain breaks)
 *   - `clear(sessionId)` — terminal/dehydrate cleanup of the user-context
 *     entry ONLY; parent-map entry persists
 *   - `clearParent(sessionId)` — explicit parent-map cleanup (used on
 *     hard-delete cleanup; ordinary terminal state keeps it for descendants)
 *   - `getRaw(sessionId)` — direct entry read (no chain walk; debug/test)
 *
 * Plaintext token material is held in pod memory only; never logged,
 * never serialized, never dehydrated.
 *
 * @internal
 */

import type { UserContext, UserEnvelope } from "./types.js";

interface ParentBinding {
    parentSessionId: string | null;
    isSystem: boolean;
}

const CHAIN_WALK_MAX_DEPTH = 32;

function cloneContext(ctx: UserContext): UserContext {
    return {
        principal: {
            provider: ctx.principal.provider,
            subject: ctx.principal.subject,
            email: ctx.principal.email ?? null,
            displayName: ctx.principal.displayName ?? null,
        },
        accessToken: ctx.accessToken ?? null,
        accessTokenExpiresAt: ctx.accessTokenExpiresAt ?? null,
    };
}

export class UserContextStore {
    private entries = new Map<string, UserContext>();
    private parentMap = new Map<string, ParentBinding>();

    /**
     * Populate or replace the user-context entry for `sessionId`.
     * Token fields may be `null` when no OBO scope is configured for
     * the deployment (Spec P1 scenario 2 / FR-007).
     */
    setUserContext(sessionId: string, envelope: UserEnvelope): void {
        const id = String(sessionId || "").trim();
        if (!id) return;
        this.entries.set(id, {
            principal: {
                provider: envelope.provider,
                subject: envelope.subject,
                email: envelope.email ?? null,
                displayName: envelope.displayName ?? null,
            },
            accessToken: envelope.accessToken ?? null,
            accessTokenExpiresAt: envelope.accessTokenExpiresAt ?? null,
        });
    }

    /**
     * Record / refresh structural parent metadata for `sessionId`.
     * Called from `SessionManager.getOrCreate` walking the CMS-recorded
     * ancestor chain once per session per worker. Idempotent;
     * last-write-wins. Contains NO token material.
     */
    bindParent(sessionId: string, meta: { parentSessionId: string | null; isSystem: boolean }): void {
        const id = String(sessionId || "").trim();
        if (!id) return;
        this.parentMap.set(id, {
            parentSessionId: meta.parentSessionId ? String(meta.parentSessionId).trim() || null : null,
            isSystem: Boolean(meta.isSystem),
        });
    }

    /** True iff a parent-map entry exists for `sessionId`. Used to skip redundant CMS walks. */
    hasParentBinding(sessionId: string): boolean {
        const id = String(sessionId || "").trim();
        if (!id) return false;
        return this.parentMap.has(id);
    }

    /**
     * Synchronous chain-walking lookup (FR-008 / FR-021 / FR-022 / FR-009).
     *
     * At each node in the chain:
     *   - If the node is missing from the parent map: return `null`
     *     (fail-safe — chain broken; FR-022).
     *   - If the node is a system session: return `null` (FR-009 —
     *     system sessions have no human principal).
     *   - If the node has its own user-context entry: return a defensive
     *     copy.
     *   - Otherwise walk to `parentSessionId` (or return `null` if root
     *     reached without finding a binding).
     *
     * Bounded by `CHAIN_WALK_MAX_DEPTH` (32) to defend against accidental
     * cycles; over-depth emits a warning and returns `null`.
     */
    lookup(sessionId: string): UserContext | null {
        const start = String(sessionId || "").trim();
        if (!start) return null;
        let cur: string | null = start;
        for (let depth = 0; depth < CHAIN_WALK_MAX_DEPTH; depth++) {
            if (!cur) return null;
            const binding = this.parentMap.get(cur);
            if (!binding) return null;
            if (binding.isSystem) return null;
            const entry = this.entries.get(cur);
            if (entry) return cloneContext(entry);
            cur = binding.parentSessionId;
        }
        // eslint-disable-next-line no-console
        console.warn(
            `[UserContextStore] lookup chain exceeded max depth ${CHAIN_WALK_MAX_DEPTH} starting from session ${start} — returning null`,
        );
        return null;
    }

    /**
     * Remove the user-context entry for `sessionId` (called on terminal
     * state AND on dehydrate so token material never outlives the warm
     * session in pod memory). The parent-map binding is intentionally
     * preserved so descendants can still resolve to the portal-bound
     * ancestor; `clearParent` is the separate cleanup for the structural
     * entry. Idempotent.
     */
    clear(sessionId: string): void {
        const id = String(sessionId || "").trim();
        if (!id) return;
        this.entries.delete(id);
    }

    /** Drop the parent-map binding (used on hard-delete cleanup). Idempotent. */
    clearParent(sessionId: string): void {
        const id = String(sessionId || "").trim();
        if (!id) return;
        this.parentMap.delete(id);
    }

    /**
     * Direct read — returns a defensive copy of the entry for exactly
     * this sessionId, without any chain walking. Phase 2 callers should
     * use `lookup` for the public path; `getRaw` stays for tests and
     * debug.
     */
    getRaw(sessionId: string): UserContext | null {
        const id = String(sessionId || "").trim();
        if (!id) return null;
        const entry = this.entries.get(id);
        return entry ? cloneContext(entry) : null;
    }

    /** Test/debug — current entry counts. */
    size(): number {
        return this.entries.size;
    }

    /** Test/debug — current parent-map count. */
    parentSize(): number {
        return this.parentMap.size;
    }
}
