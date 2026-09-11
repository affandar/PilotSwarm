import { defineTool } from "@github/copilot-sdk";
import { resolveAgentDefinitionForCaller } from "./session-proxy.js";

/** A selectable blueprint, with metadata from exactly the copy spawning binds. */
export interface AgentDiscoveryEntry {
    /** Pass this reference unchanged to spawn_agent. */
    agent_name: string;
    name: string;
    qualifiedName: string;
    namespace: string | null;
    description: string | null;
    tools: string[];
    skills: string[];
    /** Server names only. Connection details and credentials are never listed. */
    mcpServers: string[];
    initialRequiredTool: string | null;
    source: "static" | "published";
    scope: "cluster" | "user";
    system: boolean;
    creatable: boolean;
    id: string | null;
    parent: string | null;
}

export async function listAgentDefinitionsForCaller(opts: {
    userAgents: any[];
    systemAgents?: any[];
    getCallerOwnerKey: () => Promise<string | null>;
    systemOnly?: boolean;
}): Promise<AgentDiscoveryEntry[]> {
    // Snapshot the arrays: worker package refresh mutates them in place while
    // owner lookup awaits the catalog. A listing must use one coherent set.
    const userAgents = [...opts.userAgents];
    const systemAgents = [...(opts.systemAgents ?? [])];
    let ownerKey: Promise<string | null> | undefined;
    const getCallerOwnerKey = () => ownerKey ??= Promise.resolve()
        .then(opts.getCallerOwnerKey).catch(() => null);
    const candidates: any[] = [];
    for (const candidate of opts.systemOnly ? systemAgents : userAgents) {
        // Do not even generate aliases from invisible metadata. A foreign
        // name can fuzzy-match a public role; returning that reference would
        // disclose the foreign name despite selecting a public definition.
        const visible = await resolveAgentDefinitionForCaller({
            agentName: candidate.name,
            userAgents: opts.systemOnly ? [] : [candidate],
            systemAgents: opts.systemOnly ? [candidate] : [],
            getCallerOwnerKey,
        });
        if (visible) candidates.push(candidate);
    }
    const references = new Set<string>();
    for (const agent of candidates) {
        if (!agent.name) continue;
        references.add(agent.name);
        if (agent.namespace) references.add(`${agent.namespace}:${agent.name}`);
        if (agent.packageScope !== "user") references.add(`__shared:${agent.name}`);
    }
    // IDs are existing resolver aliases. They can reach a public copy hidden
    // behind both an own-copy shadow and another namespace's same-name role.
    for (const agent of candidates) {
        if (!agent.id) continue;
        references.add(agent.id);
        if (agent.packageScope !== "user") references.add(`__shared:${agent.id}`);
    }

    const seen = new Set<any>();
    const entries: AgentDiscoveryEntry[] = [];
    for (const agentName of references) {
        const resolved = await resolveAgentDefinitionForCaller({
            agentName, userAgents: opts.systemOnly ? [] : userAgents, systemAgents, getCallerOwnerKey,
        });
        if (!resolved || (opts.systemOnly ? resolved.creatable !== false : resolved.creatable === false)) continue;
        const selected = candidates.find(agent => agent.name === resolved.name
            && agent.packageId === resolved.packageId
            && agent.namespace === resolved.namespace
            && agent.prompt === resolved.prompt);
        if (!selected || seen.has(selected)) continue;
        seen.add(selected);
        entries.push({
            agent_name: agentName,
            name: resolved.name,
            qualifiedName: agentName,
            namespace: resolved.namespace ?? null,
            description: selected.description || null,
            tools: [...(resolved.tools ?? [])],
            skills: [...(selected.skills ?? [])],
            mcpServers: Array.isArray(selected.mcpServers)
                ? [...selected.mcpServers] : Object.keys(selected.mcpServers ?? {}),
            initialRequiredTool: resolved.initialRequiredTool ?? null,
            source: resolved.packageId ? "published" : "static",
            scope: resolved.packageScope === "user" ? "user" : "cluster",
            system: resolved.system === true,
            creatable: resolved.creatable !== false,
            id: resolved.id ?? null,
            parent: resolved.parent ?? null,
        });
    }
    return entries.sort((a, b) => a.name.localeCompare(b.name) || a.agent_name.localeCompare(b.agent_name));
}

/** Live getters keep discovery consistent with worker package polling. */
export function createAgentDiscoveryTool(opts: {
    getUserAgents: () => any[];
    getSystemAgents: () => any[];
    getCallerOwnerKey: (durableSessionId?: string) => Promise<string | null>;
}) {
    return defineTool("ps_list_agents", {
        description:
            "Discover the named agent blueprints available to this session: static deployment agents and enabled published agents visible to its owner. " +
            "Before choosing a generic child or native task, inspect this list if you do not already have an adequate current catalog. " +
            "Match the job to each role's description, declared tools, skills and source access; pass its exact agent_name to spawn_agent with task for the assignment. " +
            "A named agent loads its own instructions, tools and startup requirement. Tools listed here are declarations; session defaults may also apply. " +
            "If no listed specialist fits, choose the appropriate generic or native delegation. " +
            "These are blueprints, not running children; use check_agents for children already spawned. " +
            "systemOnly is for inspecting worker-managed definitions, which cannot be spawned.",
        parameters: {
            type: "object" as const,
            properties: {
                systemOnly: { type: "boolean", description: "Inspect worker-managed definitions only. These are not spawn targets. Default false." },
                creatableOnly: { type: "boolean", description: "Return spawnable definitions only; this is already the default." },
            },
        },
        handler: async (args: { systemOnly?: boolean; creatableOnly?: boolean }, invocation: any) => {
            const agents = await listAgentDefinitionsForCaller({
                userAgents: opts.getUserAgents(),
                systemAgents: opts.getSystemAgents(),
                getCallerOwnerKey: () => opts.getCallerOwnerKey(invocation?.durableSessionId),
                systemOnly: args.systemOnly === true,
            });
            return JSON.stringify({ agents, total: agents.length }, null, 2);
        },
    });
}
