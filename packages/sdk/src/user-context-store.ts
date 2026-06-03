/**
 * In-memory user-context store (Phase 1 minimal version).
 *
 * Maps `sessionId → UserContext` for sessions that have observed an
 * envelope on a worker-bound RPC. Phase 2 extends this with parent-map
 * tracking and the public `lookup` chain walk; Phase 1 only needs:
 *
 *   - `setUserContext(sessionId, ctx)` — populate / replace
 *   - `clear(sessionId)` — terminal cleanup
 *   - `getRaw(sessionId)` — direct read (no chain walk yet)
 *
 * Lifecycle: per-process, in-memory only. NEVER persisted, NEVER
 * dehydrated. After a worker restart or session migration to another
 * pod, the next envelope-carrying message re-populates on the new pod
 * (the encrypted envelope rides the durable queue / activity history,
 * see FR-023).
 *
 * Plaintext token material is held in pod memory only; never logged.
 *
 * @internal
 */

import type { UserContext, UserEnvelope } from "./types.js";

export class UserContextStore {
    private entries = new Map<string, UserContext>();

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

    /** Remove the entry for `sessionId`. Idempotent. */
    clear(sessionId: string): void {
        const id = String(sessionId || "").trim();
        if (!id) return;
        this.entries.delete(id);
    }

    /**
     * Direct read — returns the entry for exactly this sessionId without
     * any chain walking. Phase 2's `lookup` will use this as the leaf
     * accessor while walking the parent chain.
     */
    getRaw(sessionId: string): UserContext | null {
        const id = String(sessionId || "").trim();
        if (!id) return null;
        return this.entries.get(id) ?? null;
    }

    /** Test/debug helper — current entry count. */
    size(): number {
        return this.entries.size;
    }
}
