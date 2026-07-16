import {
    PilotSwarmClient,
    PilotSwarmManagementClient,
    createFactStoreForUrl,
    createWebFactStore,
    createGraphStoreForUrl,
    createWebGraphStore,
    isEnhancedFactStore,
    horizonConfigFromEnv,
    loadModelProviders,
    ModelProviderRegistry,
    loadSkills,
    loadAgentFiles,
    type FactStore,
    type EnhancedFactStore,
    type GraphStore,
} from "pilotswarm-sdk";
import { ApiClient } from "pilotswarm-sdk/api";
import { createApiTokenProvider } from "./auth.js";

type AgentConfig = ReturnType<typeof loadAgentFiles>[number];

export interface ServerContext {
    client: PilotSwarmClient;
    mgmt: PilotSwarmManagementClient;
    facts: FactStore;
    /**
     * The same store as `facts`, narrowed once at boot via
     * `isEnhancedFactStore` — null when the provider has no search/embedder
     * surface. Enhanced tools register iff non-null (per-boot gate, never
     * sniffed per call).
     */
    enhancedFacts: EnhancedFactStore | null;
    /**
     * Optional graph store — a SEPARATE injection (enhancedfactstore 07 D2),
     * never derived from the fact store. Web mode: capability-probed via
     * `createWebGraphStore`. Direct mode: constructed from HORIZON_* env.
     * Graph tools register iff non-null.
     */
    graph: GraphStore | null;
    /**
     * Web API client (web mode only; null in direct mode). Escape hatch for
     * operations the web management client does not wrap (artifacts, system
     * ops) — `api.call(<operation>, params)` dispatches any operation in the
     * protocol table.
     */
    api: ApiClient | null;
    /**
     * Whether this process's credential carries the deployment's admin role.
     * Web mode: `role === "admin" || role === "anonymous"` from /auth/me
     * (mirrors the server's isAdminAuth). Direct mode: always true — a
     * process holding DATABASE_URL is definitionally privileged.
     * [admin]-tagged tools register iff true.
     */
    admin: boolean;
    /**
     * The caller's normalized role (`admin` | `user` | `anonymous` | null),
     * and the deployment's ownership/visibility posture. Web mode reads these
     * from /auth/me and /bootstrap; direct mode is privileged (`admin`) with
     * enforcement off. Surfaced by get_capabilities so an agent can explain a
     * refusal instead of retrying blindly.
     */
    role: string | null;
    authz: { ownershipEnforced: boolean; defaultVisibility: string; systemVisibility: string };
    /** True when running over the Web API (`--api-url`); false in direct mode. */
    webMode: boolean;
    models: ModelProviderRegistry | null;
    skills: Array<{ name: string; description: string; prompt: string }>;
    /**
     * Agent definitions visible to this MCP server. Web mode: the
     * deployment's creatable-agent catalog (`GET /api/v1/agents`) — the
     * authoritative set `createSessionForAgent` will accept. Direct mode:
     * loaded from `<pluginDir>/agents/*.agent.md` for each configured plugin
     * dir (may diverge from any particular worker's catalog).
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
    let graph: GraphStore | null = null;
    let api: ApiClient | null = null;
    let admin = false;
    let ctxRole: string | null = null;
    let ctxAuthz = { ownershipEnforced: false, defaultVisibility: "private", systemVisibility: "read" };
    let webAgents: AgentConfig[] | null = null;

    if (opts.apiUrl) {
        // Web API mode (supported): no database credentials in this process.
        const getAccessToken = await createApiTokenProvider(opts.apiUrl) ?? undefined;
        client = new PilotSwarmClient({ apiUrl: opts.apiUrl, getAccessToken } as any);
        await client.start();
        mgmt = new PilotSwarmManagementClient({ apiUrl: opts.apiUrl, getAccessToken } as any);
        await mgmt.start();
        api = new ApiClient({ apiUrl: opts.apiUrl, getAccessToken });
        facts = await createWebFactStore(api);

        // Graph: capability-probed against the deployment (null ⇒ no graph
        // tools). A transient probe failure disables graph rather than
        // failing boot — same posture as the worker's graph init.
        try {
            graph = await createWebGraphStore(api);
        } catch {
            graph = null;
        }

        // Admin role: mirrors the server's isAdminAuth (router.js) — the
        // admin role, or "anonymous" on a no-auth deployment (binary
        // admission = full access).
        try {
            const me: any = await api.getAuthContext();
            const role = me?.authorization?.role;
            admin = role === "admin" || role === "anonymous";
            ctxRole = typeof role === "string" ? role : null;
        } catch {
            admin = false;
        }

        // Ownership/visibility posture from /bootstrap (security model).
        try {
            const boot: any = await api.getBootstrap();
            if (boot?.authz && typeof boot.authz === "object") {
                ctxAuthz = {
                    ownershipEnforced: Boolean(boot.authz.ownershipEnforced),
                    defaultVisibility: String(boot.authz.defaultVisibility || "private"),
                    systemVisibility: String(boot.authz.systemVisibility || "read"),
                };
            }
        } catch {
            // leave defaults
        }

        // Registered agents: the deployment's creatable-agent catalog is the
        // truth in web mode — local plugin dirs may diverge from what
        // createSessionForAgent will accept.
        try {
            const creatable: any[] = await api.call("listCreatableAgents");
            if (Array.isArray(creatable)) {
                webAgents = creatable.map((a: any) => ({
                    name: a.name ?? a.id,
                    title: a.title ?? null,
                    description: a.description ?? null,
                    system: Boolean(a.system),
                    parent: a.parent ?? null,
                })) as AgentConfig[];
            }
        } catch {
            webAgents = null; // fall back to plugin dirs below
        }
    } else if (opts.store) {
        // Direct mode (internal/testing): straight to the datastore. A
        // process holding DATABASE_URL is definitionally privileged.
        admin = true;
        ctxRole = "admin";
        client = new PilotSwarmClient({ store: opts.store });
        await client.start();
        mgmt = new PilotSwarmManagementClient({ store: opts.store });
        await mgmt.start();

        // Enhanced facts + graph provisioning from HORIZON_* env — the same
        // mapping the worker uses, so an MCP server co-located with workers
        // sees the same providers.
        const horizon = horizonConfigFromEnv();
        if (horizon.enhancedFactsDatabaseUrl) {
            facts = await createFactStoreForUrl(horizon.enhancedFactsDatabaseUrl, horizon.enhancedFactsSchema, {
                provider: "horizon",
                embedding: horizon.horizonEmbed,
            });
        } else {
            facts = await createFactStoreForUrl(opts.store);
        }
        await facts.initialize();

        if (horizon.graphDatabaseUrl) {
            try {
                const g = await createGraphStoreForUrl(horizon.graphDatabaseUrl, horizon.graphSchema, {
                    registrySchema: horizon.graphRegistrySchema,
                    namespaceCacheTtlMs: horizon.graphNamespaceCacheTtlMs,
                });
                if (g) {
                    await g.initialize();
                    graph = g;
                }
            } catch {
                graph = null; // graph disabled; facts unaffected
            }
        }
    } else {
        throw new Error("createContext requires either apiUrl (web mode) or store (direct mode).");
    }

    // Narrow ONCE at boot; enhanced tools register iff non-null.
    const enhancedFacts = isEnhancedFactStore(facts) ? facts : null;

    // Local model-provider registry is a DIRECT-mode concern — in web mode
    // the deployment serves the model list, and auto-discovering a local
    // .model_providers.json (cwd) can crash boot on a file that is valid for
    // the deployment but not for this machine's env. Load it in web mode only
    // when the caller explicitly passed --model-providers.
    const models = opts.apiUrl && !opts.modelProvidersPath
        ? null
        : (loadModelProviders(opts.modelProvidersPath ?? undefined) ?? null);

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

    let registeredAgents: AgentConfig[] = webAgents ?? [];
    if (!webAgents && opts.pluginDirs) {
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

    return {
        client,
        mgmt,
        facts,
        enhancedFacts,
        graph,
        api,
        admin,
        role: ctxRole,
        authz: ctxAuthz,
        webMode: Boolean(opts.apiUrl),
        models,
        skills,
        registeredAgents,
        systemAgentIds,
        refreshSystemAgentIds,
    };
}
