import {
    PilotSwarmClient,
    PilotSwarmManagementClient,
    createFactStoreForUrl,
    createWebFactStore,
    loadModelProviders,
    ModelProviderRegistry,
    loadSkills,
    loadAgentFiles,
    type FactStore,
} from "pilotswarm-sdk";
import { ApiClient } from "pilotswarm-sdk/api";
import { createApiTokenProvider } from "./auth.js";

type AgentConfig = ReturnType<typeof loadAgentFiles>[number];

export interface ServerContext {
    client: PilotSwarmClient;
    mgmt: PilotSwarmManagementClient;
    facts: FactStore;
    /** True when running over the Web API (`--api-url`); false in direct mode. */
    webMode: boolean;
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
    /** Direct database URL (internal/trusted placement). Mutually exclusive with apiUrl. */
    store?: string;
    /** Web API base URL (supported remote mode). Mutually exclusive with store. */
    apiUrl?: string;
    modelProvidersPath?: string;
    pluginDirs?: string[];
}

export async function createContext(opts: CreateContextOptions): Promise<ServerContext> {
    let client: PilotSwarmClient;
    let mgmt: PilotSwarmManagementClient;
    let facts: FactStore;

    if (opts.apiUrl) {
        // Web API mode (supported): no database credentials in this process.
        const getAccessToken = await createApiTokenProvider(opts.apiUrl) ?? undefined;
        client = new PilotSwarmClient({ apiUrl: opts.apiUrl, getAccessToken } as any);
        await client.start();
        mgmt = new PilotSwarmManagementClient({ apiUrl: opts.apiUrl, getAccessToken } as any);
        await mgmt.start();
        const api = new ApiClient({ apiUrl: opts.apiUrl, getAccessToken });
        facts = await createWebFactStore(api);
    } else if (opts.store) {
        // Direct mode (internal/testing): straight to the datastore.
        client = new PilotSwarmClient({ store: opts.store });
        await client.start();
        mgmt = new PilotSwarmManagementClient({ store: opts.store });
        await mgmt.start();
        facts = await createFactStoreForUrl(opts.store);
        await facts.initialize();
    } else {
        throw new Error("createContext requires either apiUrl (web mode) or store (direct mode).");
    }

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

    return { client, mgmt, facts, webMode: Boolean(opts.apiUrl), models, skills, registeredAgents, systemAgentIds, refreshSystemAgentIds };
}
