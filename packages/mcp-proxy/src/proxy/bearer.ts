import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Carries the caller's bearer from the express auth middleware into the MCP
 * tool handler that runs (asynchronously) inside the same request. This mirrors
 * the Python proxy's ContextVar: the token is NEVER a server credential, only
 * the caller's, and it is forwarded verbatim to the upstream resource.
 *
 * The auth middleware wraps `next()` in `runWithBearer(token, ...)`, so any
 * async work the MCP transport schedules for that request (tool execution)
 * observes the token via `currentBearer()`.
 */
const store = new AsyncLocalStorage<string>();

export function runWithBearer<T>(bearer: string, fn: () => T): T {
    return store.run(bearer, fn);
}

export function currentBearer(): string | undefined {
    return store.getStore();
}

/**
 * Read the caller's delegated bearer bound by the auth middleware. Adapters
 * must fail rather than fall back to a server credential when it is absent.
 */
export function requireBearer(): string {
    const bearer = currentBearer();
    if (!bearer) {
        throw new Error("no caller bearer present on the request");
    }
    return bearer;
}
