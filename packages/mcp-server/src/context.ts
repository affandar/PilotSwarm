import {
    PilotSwarmClient,
    PilotSwarmManagementClient,
    PgFactStore,
    createFactStoreForUrl,
    loadModelProviders,
    ModelProviderRegistry,
    loadSkills,
    loadAgentFiles,
} from "pilotswarm-sdk";

type AgentConfig = ReturnType<typeof loadAgentFiles>[number];

export interface ServerContext {
    client: PilotSwarmClient;
    mgmt: PilotSwarmManagementClient;
    facts: PgFactStore;
    models: ModelProviderRegistry | null;
    skills: Array<{ name: string; description: string; prompt: string }>;
    /**
     * Agent definitions visible to this MCP server, loaded from
     * `<pluginDir>/agents/*.agent.md` for each configured plugin dir.
     * Used by the read-only `list_registered_agents` tool. Workers in
     * different processes may have a different catalog — see the tool
     * description for the divergence note.
     */
    registeredAgents: AgentConfig[];
    /**
     * Set of agentIds for sessions where `isSystem === true`, derived from
     * `mgmt.listSessions()` at startup. Used by resource registrations and
     * subscription filters that need to enumerate system agents without
     * hardcoding their names.
     */
    systemAgentIds: Set<string>;
    /**
     * Re-query the management API to refresh `systemAgentIds`. Tool/resource
     * handlers may call this when they suspect the list has drifted (e.g. a
     * new system agent was registered after server startup). Cheap to call —
     * shares the same listSessions() call already used elsewhere.
     */
    refreshSystemAgentIds(): Promise<void>;
}

export interface CreateContextOptions {
    store: string;
    modelProvidersPath?: string;
    pluginDirs?: string[];
}

export async function createContext(opts: CreateContextOptions): Promise<ServerContext> {
    const client = new PilotSwarmClient({ store: opts.store });
    await client.start();

    const mgmt = new PilotSwarmManagementClient({ store: opts.store });
    await mgmt.start();

    const facts = (await createFactStoreForUrl(opts.store)) as PgFactStore;
    await facts.initialize();

    const models = loadModelProviders(opts.modelProvidersPath ?? undefined) ?? null;

    let skills: Array<{ name: string; description: string; prompt: string }> = [];
    if (opts.pluginDirs) {
        for (const dir of opts.pluginDirs) {
            try {
                const loaded = await loadSkills(dir + "/skills");
                skills.push(...loaded.map(s => ({ name: s.name, description: s.description, prompt: s.prompt })));
            } catch {
                // Directory may not have skills — skip
            }
        }
    }

    let registeredAgents: AgentConfig[] = [];
    if (opts.pluginDirs) {
        // Mirror the worker's loading semantics: name-keyed, last-write-wins
        // (see packages/sdk/src/worker.ts ~line 720). Keying on `id ?? name`
        // would let the MCP catalog diverge from any specific worker's
        // runtime when two plugin dirs share a name but differ on id.
        const byName = new Map<string, AgentConfig>();
        for (const dir of opts.pluginDirs) {
            try {
                const loaded = loadAgentFiles(dir + "/agents");
                for (const agent of loaded) {
                    if (!agent.name) continue;
                    byName.set(agent.name, agent);
                }
            } catch {
                // Directory may not have agents — skip
            }
        }
        registeredAgents = Array.from(byName.values());
    }

    const systemAgentIds = new Set<string>();
    async function refreshSystemAgentIds() {
        try {
            const sessions = await mgmt.listSessions();
            systemAgentIds.clear();
            for (const s of sessions as any[]) {
                if (s?.isSystem && typeof s.agentId === "string" && s.agentId.length > 0) {
                    systemAgentIds.add(s.agentId);
                }
            }
        } catch {
            // Best-effort — leave existing set untouched if mgmt is transiently unavailable.
        }
    }
    await refreshSystemAgentIds();

    return { client, mgmt, facts, models, skills, registeredAgents, systemAgentIds, refreshSystemAgentIds };
}
