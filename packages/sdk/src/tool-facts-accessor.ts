/**
 * The facts accessor a worker-registered tool receives on its invocation
 * context as `invocation.facts` (see docs/proposals/tool-context-facts-accessor.md).
 *
 * Three scopes, one session binding each:
 *   session (default)  this session's scope key      dies with the session
 *   root               the root session of this tree  dies with the root
 *   shared             the cluster-wide key           until deleted
 *
 * A tool can never name an arbitrary session. Reads are EXACT (by scope key),
 * never a LIKE pattern: `bindings/my_service` must not also match
 * `bindings/myXservice`.
 *
 * Runtime context only: not part of any tool schema, never sent to the model.
 * Keys under `tools/` (TOOL_PRIVATE_FACT_PREFIX) are reachable ONLY here — the
 * agent-facing fact tools refuse them for every agent identity.
 */
import { computeScopeKey, type FactStore } from "./facts-store.js";

export type ToolFactsScope = "session" | "root" | "shared";

export interface ToolFactsScopeOptions {
    scope?: ToolFactsScope;
}

export interface ToolFactsAccessor {
    /** The calling PilotSwarm session. */
    readonly durableSessionId: string;
    /** The root of the calling session's spawn tree (itself for a top-level session). */
    readonly rootSessionId: string;
    /** Exact read of `key` in the chosen scope. `null` when absent. */
    read(key: string, opts?: ToolFactsScopeOptions): Promise<unknown | null>;
    /** Upsert `key` in the chosen scope. */
    store(key: string, value: unknown, opts?: ToolFactsScopeOptions): Promise<void>;
    /** Remove the exact `key` in the chosen scope. True when a row was removed. */
    delete(key: string, opts?: ToolFactsScopeOptions): Promise<boolean>;
}

/** Keys under this prefix belong to tools; no agent can read, write, delete or search them. */
export { TOOL_PRIVATE_FACT_PREFIX } from "./facts-tools.js";

function normalizeKey(key: unknown): string {
    const text = typeof key === "string" ? key.trim() : "";
    if (!text) throw new Error("facts accessor: key must be a non-empty string");
    return text;
}

export function createToolFactsAccessor(opts: {
    factStore: FactStore;
    durableSessionId: string;
    rootSessionId?: string | null;
    /** Recorded as the writing agent on stored facts (provenance only). */
    agentId?: string | null;
}): ToolFactsAccessor {
    const { factStore } = opts;
    const durableSessionId = String(opts.durableSessionId || "").trim();
    if (!durableSessionId) throw new Error("facts accessor: durableSessionId is required");
    const rootSessionId = String(opts.rootSessionId || "").trim() || durableSessionId;
    const agentId = opts.agentId ?? null;

    // scope → { shared, sessionId the row is bound to }
    const resolve = (scopeOpts?: ToolFactsScopeOptions): { shared: boolean; sessionId: string } => {
        const scope = scopeOpts?.scope ?? "session";
        if (scope === "shared") return { shared: true, sessionId: durableSessionId };
        if (scope === "root") return { shared: false, sessionId: rootSessionId };
        if (scope === "session") return { shared: false, sessionId: durableSessionId };
        throw new Error(`facts accessor: unknown scope '${String(scope)}'`);
    };

    return {
        durableSessionId,
        rootSessionId,
        async read(key, scopeOpts) {
            const k = normalizeKey(key);
            const { shared, sessionId } = resolve(scopeOpts);
            const result = await factStore.readFacts(
                {
                    scopeKeys: [computeScopeKey(k, shared, sessionId)],
                    scope: shared ? "shared" : "accessible",
                    limit: 1,
                },
                { readerSessionId: sessionId },
            );
            const fact = result?.facts?.[0];
            return fact ? (fact.value ?? null) : null;
        },
        async store(key, value, scopeOpts) {
            const k = normalizeKey(key);
            const { shared, sessionId } = resolve(scopeOpts);
            await factStore.storeFact({ key: k, value, shared, sessionId, agentId });
        },
        async delete(key, scopeOpts) {
            const k = normalizeKey(key);
            const { shared, sessionId } = resolve(scopeOpts);
            const result = await factStore.deleteFact({ key: k, shared, sessionId, pattern: false });
            return Boolean((result as { deleted?: boolean })?.deleted);
        },
    };
}
