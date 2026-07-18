/**
 * Deployment capability catalog — capability-profiles Phase 2.
 *
 * The catalog is the deployment-wide inventory of capabilities across the
 * three axes (MCP servers, skills, tools), plus per-agent defaults so
 * clients can pre-check an agent's profile. It carries NAMES AND METADATA
 * ONLY — never resolved MCP server configs, which can contain expanded
 * credentials.
 *
 * The worker builds the catalog from its loaded plugins at boot and
 * publishes it to CMS (`cms_set_capability_catalog`), because in the remote
 * topology the web runtime has no embedded worker to ask — its own
 * plugin-dir load reads only session-policy.json and agent files.
 *
 * @module
 */

// ─── Types ───────────────────────────────────────────────────────

export interface CapabilityCatalogMcpServer {
    name: string;
    /** Member of the deployment default MCP set (`"default": true` in .mcp.json). */
    isDefault: boolean;
    /** Capability tier: isDefault → "default" (attached, removable), else "extended" (opt-in). */
    tier?: CapabilityTier;
}

/**
 * Capability tier — one model across all three axes (tools, skills, MCP):
 *
 *  - "base"     always on, non-removable (durable-session floor).
 *  - "default"  on by default, removable.
 *  - "extended" OFF by default, shown in the picker; opt in to add. The
 *               worker withholds extended capabilities from a session unless
 *               opted in, so their definitions never load (context savings).
 *  - "system"   OFF by default AND hidden from normal (non-system) pickers;
 *               only system/admin agents receive them.
 */
export type CapabilityTier = "base" | "default" | "extended" | "system";

/** Tiers whose capabilities are withheld from a session unless opted in. */
export const DEFAULT_OFF_TIERS: readonly CapabilityTier[] = ["extended", "system"];
/** Tiers hidden from a normal (non-system-agent) session's picker. */
export const HIDDEN_TIERS: readonly CapabilityTier[] = ["system"];

/**
 * Tool GROUP → tier. Groups not listed are "default". Base is per-tool (the
 * locked protocol floor), independent of group. Deployments can override a
 * group's tier via `toolGroupTiers` in session-policy.json.
 */
export const GROUP_TIERS: Record<string, CapabilityTier> = {
    graph: "extended",
    observability: "system",
    maintenance: "system",
};

/** Resolve a tool's tier from its name (base floor) and group. */
export function toolTier(name: string, group: string | undefined, groupTiers: Record<string, CapabilityTier> = GROUP_TIERS): CapabilityTier {
    if (PROTOCOL_FLOOR_TOOLS.includes(name as any)) return "base";
    if (group && groupTiers[group]) return groupTiers[group];
    return "default";
}

export interface CapabilityCatalogSkill {
    name: string;
    description?: string;
    /** Skill group (from SKILL.md frontmatter `group:`). Absent = "Other". */
    group?: string;
    /** Capability tier (from frontmatter `tier:`). Absent = "default". */
    tier?: CapabilityTier;
    /**
     * Tools this skill requires to function (from the skill's tools.json).
     * When a session enables the skill, these tools are force-enabled and
     * non-removable — a skill cannot run without them.
     */
    requiredTools?: string[];
}

export interface CapabilityCatalogTool {
    name: string;
    /** Tool group (facts, graph, artifacts, …). Absent = ungrouped. */
    group?: string;
    /** Capability tier — base | default | extended | system. */
    tier: CapabilityTier;
    /**
     * Convenience alias for `tier === "base"`: a locked durable-floor tool,
     * always present and non-removable. Retained for pickers that key off it.
     */
    locked?: boolean;
}


export interface CapabilityCatalogAgentDefaults {
    /** Names of the agent's resolved MCP grants (never the server configs). */
    mcpServers: string[];
    /** `allowedSkills` restriction; null = unrestricted (all catalog skills). */
    skills: string[] | null;
    /** Additive tool names from the agent's `tools:` frontmatter. */
    tools: string[];
    /** Tool restriction policy, when declared. */
    toolPolicy?: { allow?: string[]; deny?: string[] };
}

export interface CapabilityCatalog {
    mcpServers: CapabilityCatalogMcpServer[];
    skills: CapabilityCatalogSkill[];
    tools: CapabilityCatalogTool[];
    agentDefaults: Record<string, CapabilityCatalogAgentDefaults>;
}

// ─── Default tool groups ────────────────────────────────────────
//
// The SDK's built-in grouping source (review addendum 6: nothing else in
// the system defines groups — the Copilot SDK tool type has no group field
// and the worker registry is a flat map). Deployments extend or override
// via `toolGroups` in session-policy.json: { "<group>": ["tool", ...] }.
// Tools in neither source render ungrouped.
//
// Names must match the defineTool("<name>", ...) declarations in the
// factory modules (managed-session.ts, facts-tools.ts, graph-tools.ts,
// inspect-tools.ts, artifact-tools.ts, sweeper-tools.ts,
// resourcemgr-tools.ts) — pinned by test/unit/capability-catalog.test.mjs.

const GROUPED_TOOL_NAMES: Record<string, string[]> = {
    session: [
        "wait", "wait_on_worker", "cron", "cron_at", "ask_user", "report_cycle",
        "list_available_models", "set_session_model", "update_session_summary", "bash",
    ],
    messaging: ["send_session_message", "reply_session_message"],
    "sub-agents": [
        "spawn_agent", "message_agent", "check_agents", "wait_for_agents",
        "list_sessions", "complete_agent", "cancel_agent", "delete_agent",
    ],
    facts: [
        "store_fact", "read_facts", "delete_fact", "facts_search", "facts_similar",
        "search_skills", "manage_embedder", "facts_tombstone_stats",
        "facts_purge_tombstones", "facts_force_purge",
    ],
    graph: [
        "graph_list_namespaces", "graph_get_namespace", "graph_search_nodes",
        "graph_search_edges", "graph_neighbourhood", "graph_stats",
        "graph_upsert_namespace", "graph_archive_namespace", "graph_delete_namespace",
        "graph_upsert_node", "graph_upsert_edge", "graph_merge_nodes",
        "graph_delete_node", "graph_delete_edge", "graph_remove_evidence",
        "facts_read_uncrawled", "facts_set_crawled",
    ],
    artifacts: ["write_artifact", "read_artifact", "list_artifacts"],
    observability: [
        "read_agent_events", "list_all_sessions", "list_orchestrations_by_status",
        "read_embedder_status", "read_execution_history", "read_facts_tombstone_stats",
        "read_fleet_graph_node_usage", "read_fleet_retrieval_usage",
        "read_fleet_skill_usage", "read_fleet_stats", "read_orchestration_stats",
        "read_session_facts_stats", "read_session_graph_edge_search_usage",
        "read_session_graph_node_usage", "read_session_graph_searches",
        "read_session_info", "read_session_metric_summary",
        "read_session_retrieval_usage", "read_session_skill_usage",
        "read_session_tokens_by_model", "read_session_tree_facts_stats",
        "read_session_tree_retrieval_usage", "read_session_tree_skill_usage",
        "read_session_tree_stats", "read_shared_facts_stats", "read_user_stats",
    ],
    maintenance: [
        "cleanup_session", "compact_database", "force_terminate_session",
        "get_database_stats", "get_infrastructure_stats", "get_storage_stats",
        "get_system_stats", "prune_orchestrations", "purge_old_events",
        "purge_orphaned_blobs", "scale_workers", "scan_completed_sessions",
    ],
};

/** Flattened name → group lookup for the SDK's built-in tool families. */
export const DEFAULT_TOOL_GROUPS: Record<string, string> = Object.fromEntries(
    Object.entries(GROUPED_TOOL_NAMES).flatMap(([group, names]) =>
        names.map((name) => [name, group])),
);

/**
 * The durable-session protocol floor: tools whose absence breaks session
 * mechanics rather than merely narrowing capability — the recurring-watcher
 * reporter, durable waits, the ask_user input flow, and summary upkeep. A
 * capability restriction (allow-list OR deny-list, from an agent policy OR a
 * session override) can narrow WHAT an agent does, but must never be able to
 * strip these — doing so would brick every session in the tree. Enforced in
 * BOTH directions at assembly: retained in allow-mode availableTools, and
 * removed from excludedTools regardless of what a deny/disable names.
 */
export const PROTOCOL_FLOOR_TOOLS = [
    "report_cycle", "wait", "wait_on_worker", "ask_user", "update_session_summary",
] as const;

/** @deprecated Use {@link PROTOCOL_FLOOR_TOOLS}. Retained for import stability. */
export const ALLOW_MODE_RETAINED_TOOLS = PROTOCOL_FLOOR_TOOLS;

/**
 * Merge the built-in grouping with a deployment's session-policy
 * `toolGroups` override ({ group: [toolName, ...] }; policy wins per tool).
 */
export function resolveToolGroups(policyToolGroups?: Record<string, string[]> | null): Record<string, string> {
    const merged: Record<string, string> = { ...DEFAULT_TOOL_GROUPS };
    for (const [group, names] of Object.entries(policyToolGroups ?? {})) {
        if (!Array.isArray(names)) continue;
        for (const name of names) {
            if (typeof name === "string" && name) merged[name] = group;
        }
    }
    return merged;
}
