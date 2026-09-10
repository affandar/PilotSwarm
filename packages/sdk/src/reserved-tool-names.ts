const COPILOT_NATIVE_TOOL_NAMES = [
    "apply_patch", "bash", "create", "edit", "extensions_manage",
    "extensions_reload", "git_apply_patch", "list_agents", "multi_tool_use.parallel",
    "read_agent", "reindex", "search_code_subagent", "session_store_sql",
    "str_replace_editor", "task", "write_agent",
] as const;

/** Find the first package tool that would shadow platform or deployment behavior. */
export function findReservedPackageToolName(
    packageToolNames: Iterable<string>,
    platformToolNames: Iterable<string>,
    deploymentToolNames: Iterable<string>,
): string | null {
    const reserved = new Set<string>([
        ...COPILOT_NATIVE_TOOL_NAMES,
        ...platformToolNames,
        ...deploymentToolNames,
    ]);
    return [...packageToolNames].sort().find((name) => reserved.has(name)) ?? null;
}
