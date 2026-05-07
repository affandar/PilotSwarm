import {
    PilotSwarmClient,
    PilotSwarmManagementClient,
    PgFactStore,
    createFactStoreForUrl,
    loadModelProviders,
    ModelProviderRegistry,
    loadSkills,
} from "pilotswarm-sdk";

export interface ServerContext {
    client: PilotSwarmClient;
    mgmt: PilotSwarmManagementClient;
    facts: PgFactStore;
    models: ModelProviderRegistry | null;
    skills: Array<{ name: string; description: string; prompt: string }>;
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

    return { client, mgmt, facts, models, skills, systemAgentIds, refreshSystemAgentIds };
}
