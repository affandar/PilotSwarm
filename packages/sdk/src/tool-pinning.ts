import type { Tool } from "@github/copilot-sdk";

/**
 * Pin tool declarations so the Copilot runtime never defers them behind
 * tool search.
 *
 * copilot-sdk 1.0.7 introduced tool search: when a session's total tool
 * count exceeds the deferral threshold (built-in default 30), MCP and
 * external tools are no longer pre-loaded into the prompt — the model gets
 * a `tool_search_tool` instead and must think to search for the rest.
 * PilotSwarm sessions declare 40+ tools, so deferral WOULD engage, and a
 * deferred tool is invisible until the model suspects it exists. For
 * workflow-critical tools (spawn_agent, store_fact, complete_session ...)
 * that is a silent no-op factory — the same failure mode as the
 * declaration-less regen tools, found the hard way.
 *
 * So: every tool PilotSwarm hands to the CLI is pinned `defer: "never"`
 * unless its definition says otherwise. An explicit `defer` on a tool
 * definition is respected, which is the phase-2 path — individual
 * long-tail tools (inspect/graph) can opt back in to deferral at their
 * definition site without touching the session-config chokepoint.
 *
 * Copies, never mutates: several tool arrays (e.g. systemToolDefs) are
 * shared module-level definitions, and mutating them here would leak the
 * pin into unrelated callers.
 */
export function pinToolsNeverDefer<T>(tools: Tool<T>[]): Tool<T>[] {
    return (tools || []).map((tool) => ({
        ...tool,
        defer: (tool as any).defer ?? "never",
    }));
}
