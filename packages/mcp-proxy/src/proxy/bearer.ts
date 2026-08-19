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
