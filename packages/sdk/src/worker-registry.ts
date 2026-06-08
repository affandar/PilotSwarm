/**
 * Worker registry for the public `getUserContextForSession` lookup API
 * (Phase 2 of the user-OBO-propagation work).
 *
 * Two resolution paths, in priority order:
 *
 *   1. **AsyncLocalStorage** — when a `runTurn` activity (or any future
 *      activity that exposes tool handlers) is on the stack, the session
 *      manager hosting that activity is published into ALS. Any
 *      synchronous lookup from inside a tool handler resolves to that
 *      worker's UserContextStore. This is the worker-affined path and is
 *      the only path that's safe when multiple workers coexist in a
 *      single process (tests, embedded mode).
 *
 *   2. **Single-worker fallback** — when ALS is not set (e.g., a caller
 *      outside any activity), the registry returns the lone registered
 *      worker if and only if exactly one is registered. Ambiguous
 *      multi-worker cases return `null` rather than risk leaking token
 *      material across worker boundaries.
 *
 * The registry never stores worker instances directly; it stores the
 * `SessionManager` reference that owns the relevant `UserContextStore`,
 * which is the minimum needed for the lookup.
 *
 * @internal
 */

import { AsyncLocalStorage } from "node:async_hooks";
import type { SessionManager } from "./session-manager.js";
import type { UserContext } from "./types.js";

const activeManagers = new Set<SessionManager>();
const managerStorage = new AsyncLocalStorage<SessionManager>();

/** Add a session manager to the registry. Called on successful `PilotSwarmWorker.start()`. */
export function registerSessionManager(sm: SessionManager): void {
    activeManagers.add(sm);
}

/** Remove a session manager from the registry. Called from `PilotSwarmWorker.stop()` finally block. */
export function unregisterSessionManager(sm: SessionManager): void {
    activeManagers.delete(sm);
}

/**
 * Run `fn` with `sm` published as the ambient worker in ALS. Used by
 * the `runTurn` activity to bind worker context for tool handlers that
 * may synchronously call `getUserContextForSession`.
 */
export function runWithSessionManager<T>(sm: SessionManager, fn: () => Promise<T>): Promise<T> {
    return managerStorage.run(sm, fn);
}

/**
 * Resolve the active SessionManager for the calling context. Returns
 * the ALS-published manager when set; falls back to the lone registered
 * worker when exactly one is present; returns `null` otherwise.
 *
 * Returning `null` on the multi-worker-and-no-ALS case is intentional —
 * a wrong answer would leak token material across worker boundaries.
 */
export function resolveActiveSessionManager(): SessionManager | null {
    const fromAls = managerStorage.getStore();
    if (fromAls) return fromAls;
    if (activeManagers.size === 1) {
        const [only] = activeManagers;
        return only ?? null;
    }
    return null;
}

/**
 * Public worker-side lookup. Synchronous, importable, returns `null`
 * for any of: no active worker, session id not bound on this worker,
 * chain rooted at a system session (FR-009), broken chain (FR-022).
 *
 * The returned object is a defensive copy; mutating it does not affect
 * the underlying UserContextStore.
 */
export function getUserContextForSession(sessionId: string): UserContext | null {
    const sm = resolveActiveSessionManager();
    if (!sm) return null;
    try {
        return sm.getUserContextStore().lookup(sessionId);
    } catch {
        return null;
    }
}
