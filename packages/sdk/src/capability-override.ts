/**
 * Session capability overrides — capability-profiles Phases 3/4.
 *
 * A `SessionCapabilityOverride` is the user's per-TREE enable/disable delta
 * over the resolved agent profiles. It is stored once, on the tree ROOT's
 * `capability_override` column (the single authority — review addendum 1),
 * and every session in the tree applies the root's override on top of its
 * own agent profile at assembly. `disable` wins over `enable` at equal
 * specificity; for the tools axis an entry may name an individual tool or a
 * tool GROUP (groups expand to members; an individual entry overrides its
 * group).
 *
 * Overrides can only reference deployment-catalog entries. Unknown names
 * are dropped and reported (never fatal) so a catalog that shrinks between
 * deployments does not break a stored override.
 *
 * @module
 */

export interface SessionCapabilityAxisOverride {
    enable?: string[];
    disable?: string[];
}

export interface SessionCapabilityOverride {
    mcpServers?: SessionCapabilityAxisOverride;
    skills?: SessionCapabilityAxisOverride;
    tools?: SessionCapabilityAxisOverride;
}

const AXES = ["mcpServers", "skills", "tools"] as const;

function sanitizeNames(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    // A bare "*" is rejected by the Copilot SDK's tool-filter validation
    // (session creation would throw) — drop it here so a stored override can
    // never brick assembly.
    return [...new Set(
        value
            .filter((v): v is string => typeof v === "string" && v.trim().length > 0 && v.trim() !== "*")
            .map((v) => v.trim()),
    )];
}

/**
 * Normalize an untrusted override payload: keep only known axes and
 * enable/disable string lists, dedupe, and — when a validator is given —
 * drop names the deployment does not offer, reporting them per axis.
 * Returns null for an effectively-empty override.
 */
export function normalizeCapabilityOverride(
    raw: unknown,
    validators?: {
        mcpServers?: (name: string) => boolean;
        skills?: (name: string) => boolean;
        /** Tools validator receives tool AND group names. */
        tools?: (name: string) => boolean;
    },
): { override: SessionCapabilityOverride | null; dropped: Record<string, string[]> } {
    const dropped: Record<string, string[]> = {};
    if (!raw || typeof raw !== "object") return { override: null, dropped };

    const override: SessionCapabilityOverride = {};
    for (const axis of AXES) {
        const axisRaw = (raw as any)[axis];
        if (!axisRaw || typeof axisRaw !== "object") continue;
        const validator = validators?.[axis];
        const filter = (names: string[]) => {
            if (!validator) return names;
            const kept: string[] = [];
            for (const name of names) {
                if (validator(name)) kept.push(name);
                else (dropped[axis] ??= []).push(name);
            }
            return kept;
        };
        const enable = filter(sanitizeNames(axisRaw.enable));
        const disable = filter(sanitizeNames(axisRaw.disable));
        if (enable.length || disable.length) {
            override[axis] = {
                ...(enable.length ? { enable } : {}),
                ...(disable.length ? { disable } : {}),
            };
        }
    }

    return { override: Object.keys(override).length > 0 ? override : null, dropped };
}

/**
 * Expand a tools-axis name list: group names expand to their catalog member
 * tools, individual tool names pass through. `groupMembers` maps group →
 * member tool names.
 */
export function expandToolNames(names: string[] | undefined, groupMembers: Record<string, string[]>): Set<string> {
    const expanded = new Set<string>();
    for (const name of names ?? []) {
        const members = groupMembers[name];
        if (members) {
            for (const member of members) expanded.add(member);
        } else {
            expanded.add(name);
        }
    }
    return expanded;
}

/**
 * Individual-tool entries override their group at equal specificity, and
 * disable beats enable. Given the raw axis lists and group membership,
 * compute the final enabled/disabled tool-name sets.
 */
export function resolveToolAxis(
    axis: SessionCapabilityAxisOverride | undefined,
    groupMembers: Record<string, string[]>,
): { enabled: Set<string>; disabled: Set<string> } {
    const enabledExpanded = expandToolNames(axis?.enable, groupMembers);
    const disabledExpanded = expandToolNames(axis?.disable, groupMembers);
    // Individual > group: a tool named INDIVIDUALLY on one side is removed
    // from the other side's GROUP-derived set.
    const individualEnable = new Set((axis?.enable ?? []).filter((n) => !groupMembers[n]));
    const individualDisable = new Set((axis?.disable ?? []).filter((n) => !groupMembers[n]));
    for (const name of individualEnable) {
        if (!individualDisable.has(name)) disabledExpanded.delete(name);
    }
    for (const name of individualDisable) enabledExpanded.delete(name);
    // Disable wins at equal specificity.
    for (const name of disabledExpanded) enabledExpanded.delete(name);
    return { enabled: enabledExpanded, disabled: disabledExpanded };
}

/**
 * Compose the CLI tool-filter (`excludedTools` / `availableTools`) from the
 * bound agent's tool policy and the session-tree override, enforcing the
 * durable-session protocol floor in BOTH directions:
 *
 *  - `excludedTools` always starts with the native "task" tool (permanently
 *    removed) and adds the agent deny ∪ override-disable, MINUS anything the
 *    override re-enables, MINUS the protocol floor and any bare "*". A
 *    restriction narrows capability; it can never brick the session protocol.
 *  - `availableTools` is set only in allow-list mode (agent policy `allow`
 *    DEFINED — an empty list means "floor only"); it unions the allow list,
 *    override-enabled tools, the protocol floor, and `mcp:*` when the session
 *    has any granted MCP servers (availableTools filters across all sources,
 *    so omitting it would silently kill Phase-1 MCP grants).
 */
export function composeToolFilters(opts: {
    agentPolicy?: { allow?: string[]; deny?: string[] };
    override?: SessionCapabilityAxisOverride;
    groupMembers: Record<string, string[]>;
    protocolFloor: readonly string[];
    hasMcpServers: boolean;
}): { excludedTools: string[]; availableTools: string[] | undefined } {
    const { agentPolicy, override, groupMembers, protocolFloor, hasMcpServers } = opts;
    const toolAxis = resolveToolAxis(override, groupMembers);

    const deny = new Set([...(agentPolicy?.deny ?? []), ...toolAxis.disabled]);
    for (const name of toolAxis.enabled) deny.delete(name);
    deny.delete("*");
    for (const name of protocolFloor) deny.delete(name);
    const excludedTools = ["task", ...deny];

    const allowMode = agentPolicy?.allow !== undefined;
    const availableTools = allowMode
        ? Array.from(new Set([
            ...(agentPolicy?.allow ?? []),
            ...toolAxis.enabled,
            ...protocolFloor,
            ...(hasMcpServers ? ["mcp:*"] : []),
        ])).filter((name) => name !== "*")
        : undefined;

    return { excludedTools, availableTools };
}

/**
 * Stable fingerprint for rebind detection: a warm Copilot session built
 * under one override must be destroyed and rebuilt when the effective
 * override changes (MCP servers and skills are fixed at session build).
 */
export function fingerprintCapabilityOverride(override: SessionCapabilityOverride | null | undefined): string {
    if (!override) return "";
    const canonical: any = {};
    for (const axis of AXES) {
        const axisValue = override[axis];
        if (!axisValue) continue;
        canonical[axis] = {
            ...(axisValue.enable?.length ? { enable: [...axisValue.enable].sort() } : {}),
            ...(axisValue.disable?.length ? { disable: [...axisValue.disable].sort() } : {}),
        };
    }
    return JSON.stringify(canonical);
}
