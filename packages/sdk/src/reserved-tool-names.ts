import { FEATURE_OPERATION_SPECS } from "./feature-tools.js";
import { PROVIDER_TOOL_NAMES } from "./provider-tools.js";

const COPILOT_NATIVE_TOOL_NAMES = [
    "apply_patch", "bash", "catalog_search", "create", "edit", "extensions_manage",
    "extensions_reload", "git_apply_patch", "glob", "list_agents", "list_bash", "multi_tool_use.parallel",
    "read_agent", "read_bash", "reindex", "rg", "search_code_subagent", "session_store_sql",
    "sql", "stop_bash", "str_replace_editor", "task", "view", "web_fetch", "web_search", "write_agent",
] as const;

// These tools attach per session, so a worker's default tool registry is not
// sufficient: reserving only currently attached tools makes package validity
// depend on the first session's role or backing-store capabilities. Keep the
// complete dynamic namespace reserved even when a deployment disables a store.
// The factory coverage test checks this list against all role/capability bundles.
const SESSION_ATTACHED_TOOL_NAMES = [
    "search_capabilities", "load_agent_guidelines", "list_session_capabilities", "use_package",
    "bulk_store_facts",
    "context_health",
    "create_agent_session",
    "delete_fact",
    "diff_agent_versions",
    "facts_force_purge",
    "facts_purge_tombstones",
    "facts_read_uncrawled",
    "facts_search",
    "facts_set_crawled",
    "facts_similar",
    "facts_tombstone_stats",
    "graph_archive_namespace",
    "graph_delete_edge",
    "graph_delete_namespace",
    "graph_delete_node",
    "graph_get_namespace",
    "graph_list_namespaces",
    "graph_merge_nodes",
    "graph_neighbourhood",
    "graph_remove_evidence",
    "graph_search_edges",
    "graph_search_nodes",
    "graph_stats",
    "graph_upsert_edge",
    "graph_upsert_namespace",
    "graph_upsert_node",
    "import_agent_package",
    "list_agent_packages",
    "list_all_sessions",
    "list_orchestrations_by_status",
    "manage_agent_session",
    "manage_embedder",
    "message_agent_session",
    "pin_agent_package_version",
    "propose_agent_patch",
    "publish_agent_package",
    "read_agent_events",
    "read_agent_package",
    "read_agent_package_file",
    "read_embedder_status",
    "read_execution_history",
    "read_facts",
    "read_facts_tombstone_stats",
    "read_fleet_graph_node_usage",
    "read_fleet_retrieval_usage",
    "read_fleet_skill_usage",
    "read_fleet_stats",
    "read_orchestration_stats",
    "read_session_facts_stats",
    "read_session_graph_edge_search_usage",
    "read_session_graph_node_usage",
    "read_session_graph_searches",
    "read_session_info",
    "read_session_metric_summary",
    "read_session_retrieval_usage",
    "read_session_signals",
    "read_session_skill_usage",
    "read_session_tokens_by_model",
    "read_session_tree_facts_stats",
    "read_session_tree_retrieval_usage",
    "read_session_tree_skill_usage",
    "read_session_tree_stats",
    "read_shared_facts_stats",
    "read_user_stats",
    "search_skills",
    "set_agent_package_enabled",
    "stage_agent_package_edit",
    "store_fact",
    "wait_for_signal",
    "wait_for_any",
    "create_signal_webhook",
    "read_webhook_receipts",
    "read_webhook_receipt",
    "read_webhook_metrics",
] as const;

/** Complete platform namespace, including tools gated by role or store. */
export function reservedPlatformToolNames(baseToolNames: Iterable<string> = []): Set<string> {
    return new Set([
        ...baseToolNames,
        ...SESSION_ATTACHED_TOOL_NAMES,
        ...PROVIDER_TOOL_NAMES,
        ...FEATURE_OPERATION_SPECS.map(spec => spec.name),
    ]);
}

/** Find the first package tool that would shadow platform or deployment behavior. */
export function findReservedPackageToolName(
    packageToolNames: Iterable<string>,
    platformToolNames: Iterable<string>,
    deploymentToolNames: Iterable<string>,
): string | null {
    const reserved = new Set<string>([
        ...COPILOT_NATIVE_TOOL_NAMES,
        ...reservedPlatformToolNames(platformToolNames),
        ...deploymentToolNames,
    ]);
    return [...packageToolNames].sort().find((name) => reserved.has(name)) ?? null;
}
