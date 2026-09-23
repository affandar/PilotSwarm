import type { Tool } from "@github/copilot-sdk";

export const NATIVE_TASK_NAMES = ["swarm-explore", "swarm-task"] as const;
export type NativeTaskName = typeof NATIVE_TASK_NAMES[number];
/** Exact external tool names; MCP entries use server/tool. No wildcards. */
export type NativeTaskTools = Partial<Record<NativeTaskName, string[]>>;
const forbidden = new Set([
    "task", "spawn_agent", "create_agent_session", "message_agent_session", "manage_agent_session",
    "send_session_message", "reply_session_message", "complete_agent", "wait", "ask_user",
    "create_session", "send_message", "send_and_wait", "stop_session", "delete_session", "restart_session", "fork_session",
    "write_agent", "manage_schedule", "run_factory", "factories_manage", "schedule", "cron",
    "wait_on_worker", "wait_for_signal", "wait_for_any", "create_signal_webhook", "cron_at", "report_cycle", "set_session_model", "regenerate_context", "regenerate_agent",
    "message_agent", "wait_for_agents", "cancel_agent", "delete_agent", "manage_embedder",
    "manage_system_session_model", "force_terminate_session", "cleanup_session", "prune_orchestrations",
    "start_pod_process",
    "bash", "powershell", "view", "rg", "grep", "glob", "read_bash", "list_bash", "stop_bash", "stop_powershell",
]);
// Reviewed synchronous framework operations. Keep future framework tools closed by default.
export const NATIVE_SYNCHRONOUS_TOOLS = new Set([
    "adopt_legacy_system_github_key",
    "bulk_store_facts",
    "canvas_kv",
    "check_agents",
    "context_health",
    "delete_fact",
    "diff_agent_versions",
    "draw_canvas",
    "facts_force_purge",
    "facts_purge_tombstones",
    "facts_read_uncrawled",
    "facts_search",
    "facts_set_crawled",
    "facts_similar",
    "facts_tombstone_stats",
    "find_canvas_app",
    "get_cluster_feature_flags",
    "get_legacy_provider_migration_status",
    "get_model_defaults",
    "get_my_feature_flags",
    "get_provider_defaults",
    "get_provider_status",
    "get_provider_usage",
    "get_provider_usage_agents",
    "get_provider_usage_grid",
    "get_provider_usage_summary",
    "get_user_feature_flags",
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
    "list_artifacts",
    "list_available_models",
    "list_feature_flag_changes",
    "list_feature_flag_users",
    "list_feature_flags",
    "list_orchestrations_by_status",
    "list_paused_sessions",
    "list_providers",
    "list_sessions",
    "load_skill",
    "manage_provider",
    "pin_agent_package_version",
    "propose_agent_patch",
    "provider_hold",
    "ps_list_agents",
    "publish_agent_package",
    "publish_canvas_app",
    "read_agent_events",
    "read_agent_package",
    "read_agent_package_file",
    "read_artifact",
    "read_canvas",
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
    "read_session_skill_usage",
    "read_session_tokens_by_model",
    "read_session_tree_facts_stats",
    "read_session_tree_retrieval_usage",
    "read_session_tree_skill_usage",
    "read_session_tree_stats",
    "read_shared_facts_stats",
    "read_user_stats",
    "reset_cluster_feature_flag",
    "search_skills",
    "set_agent_package_enabled",
    "set_cluster_feature_flag",
    "set_model_default",
    "set_my_feature_flag",
    "set_provider_allowance",
    "set_provider_default",
    "set_provider_limit",
    "set_provider_system_use",
    "set_system_model_default",
    "set_user_feature_flag",
    "show_artifact",
    "show_canvas",
    "stage_agent_package_edit",
    "store_fact",
    "unset_my_feature_flag",
    "unset_user_feature_flag",
    "update_canvas",
    "write_artifact",
]);

export function validateNativeTaskTools(value: unknown): asserts value is NativeTaskTools {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("nativeTaskTools must be a task-name mapping");
    for (const [task, tools] of Object.entries(value)) {
        if (!(NATIVE_TASK_NAMES as readonly string[]).includes(task)) throw new Error(`Unknown native task: ${task}`);
        if (!Array.isArray(tools) || tools.some(t => typeof t !== "string" || !/^[\w.-]+(?:\/[\w.-]+)?$/.test(t))) {
            throw new Error(`nativeTaskTools.${task} must contain exact tool names (no wildcards)`);
        }
        if (tools.some(t => forbidden.has(t) || forbidden.has(t.split("/").at(-1)!))) throw new Error(`nativeTaskTools.${task} contains a prohibited orchestration, session-control, or detached-work tool`);
    }
}

/** Per CLI handle. Child identities come from runtime events, never model arguments. */
export class NativeTaskAccess {
    readonly tools: Record<NativeTaskName, string[]> = { "swarm-explore": [], "swarm-task": [] };
    readonly mcpServers: Record<NativeTaskName, Record<string, any>> = { "swarm-explore": {}, "swarm-task": {} };
    private children = new Map<string, NativeTaskName>();
    private calls = new Map<string, { owner?: string; tool: string }>();
    private results = new Map<string, Promise<unknown>>();
    constructor(
        readonly declarations: NativeTaskTools,
        parentTools: Tool<any>[],
        reserved: Set<string>,
        parentMcp: Record<string, any>,
    ) {
        validateNativeTaskTools(declarations);
        const available = new Set(parentTools.map(t => t.name));
        for (const task of NATIVE_TASK_NAMES) for (const name of declarations[task] ?? []) {
            if (!name.includes("/")) {
                if (available.has(name) && (!reserved.has(name) || NATIVE_SYNCHRONOUS_TOOLS.has(name))) this.tools[task].push(name);
                continue;
            }
            const [server, tool] = name.split("/");
            const config = Object.hasOwn(parentMcp, server) ? parentMcp[server] : undefined;
            if (!config || !Array.isArray(config.tools) || !(config.tools.includes("*") || config.tools.includes(tool))) continue;
            const childConfig = this.mcpServers[task][server] ?? { ...config, tools: [] };
            childConfig.tools.push(tool);
            this.mcpServers[task][server] = childConfig;
            this.tools[task].push(name);
        }
    }
    observe(event: any): void {
        if (event.type === "tool.execution_start" && event.data?.toolCallId) {
            const id = event.data.toolCallId;
            const previous = this.calls.get(id);
            if (previous && (previous.owner !== event.agentId || previous.tool !== event.data.toolName)) {
                this.calls.set(id, { owner: "unknown", tool: "" });
            } else this.calls.set(id, { owner: event.agentId, tool: event.data.toolName });
        } else if (event.type === "subagent.started" && event.agentId && !event.data?.parentId
            && event.data?.executionMode === "sync" && NATIVE_TASK_NAMES.includes(event.data?.agentName)) {
            this.children.set(event.agentId, event.data.agentName);
        } else if (["subagent.completed", "subagent.failed"].includes(event.type) && event.agentId) {
            this.children.delete(event.agentId);
        } else if (["session.idle", "session.error", "abort"].includes(event.type) && !event.agentId) {
            this.children.clear();
            this.calls.clear();
            this.results.clear();
        }
    }
    allows(sessionId: string, tool: string): boolean {
        const task = this.children.get(sessionId);
        return Boolean(task && this.tools[task].includes(tool));
    }
    allowsHook(sessionId: string, tool: string): boolean {
        if (this.allows(sessionId, tool)) return true;
        const task = this.children.get(sessionId);
        // Copilot exposes MCP declarations as server/tool and hook names as server-tool.
        return Boolean(task && this.tools[task].some(t => t.includes("/") && t.replace("/", "-") === tool));
    }
    invoke(tool: Tool<any>, args: any, invocation: any, parentSessionId: string): unknown {
        // SDK 1.0.13 forwards child callbacks with the ROOT sessionId, and can
        // broadcast the same request twice. Attribute using the earlier runtime
        // tool.execution_start, not the callback's sessionId or model args.
        const call = this.calls.get(invocation.toolCallId);
        const owner = call?.owner ?? (invocation.sessionId !== parentSessionId ? invocation.sessionId : undefined);
        if (!call || call.tool !== tool.name || (owner && !this.allows(owner, tool.name))) {
            throw new Error("Native workers cannot invoke an unattributed or non-allowlisted external tool");
        }
        if (!owner) return tool.handler!(args, invocation);
        const key = `${owner}:${invocation.toolCallId}`;
        const previous = this.results.get(key);
        if (previous) return previous;
        const result = Promise.resolve().then(() => tool.handler!(args, {
            ...invocation, parentSessionId, nativeSessionId: owner, nativeTaskName: this.children.get(owner),
        }));
        this.results.set(key, result);
        return result;
    }
    /** Never persist runtime identity maps or MCP credentials with session config. */
    toJSON(): undefined { return undefined; }
}
