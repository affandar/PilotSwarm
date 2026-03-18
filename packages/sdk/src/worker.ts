import { SessionManager } from "./session-manager.js";
import { SessionBlobStore } from "./blob-store.js";
import { FilesystemSessionStore } from "./session-store.js";
import type { SessionStateStore } from "./session-store.js";
import { registerActivities } from "./session-proxy.js";
import {
    DURABLE_SESSION_LATEST_VERSION,
    DURABLE_SESSION_ORCHESTRATION_NAME,
    DURABLE_SESSION_ORCHESTRATION_REGISTRY,
} from "./orchestration-registry.js";
import { PgSessionCatalogProvider } from "./cms.js";
import type { SessionCatalogProvider } from "./cms.js";
import { loadAgentFiles, systemAgentUUID } from "./agent-loader.js";
import { loadMcpConfig } from "./mcp-loader.js";
import { loadModelProviders, type ModelProviderRegistry } from "./model-providers.js";
import { createArtifactTools } from "./artifact-tools.js";
import { createSweeperTools } from "./sweeper-tools.js";
import { createResourceManagerTools } from "./resourcemgr-tools.js";
import { composeSystemPrompt, mergePromptSections } from "./prompt-layering.js";
import { defineTool } from "@github/copilot-sdk";
import type { Tool } from "@github/copilot-sdk";
import type { PilotSwarmWorkerOptions, ManagedSessionConfig, OrchestrationInput } from "./types.js";
import type { AgentConfig } from "./agent-loader.js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// duroxide is CommonJS — use createRequire for ESM compatibility
import { createRequire } from "node:module";

const __sdkDir = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { SqliteProvider, PostgresProvider, Runtime, Client } = require("duroxide");

const DEFAULT_DUROXIDE_SCHEMA = "duroxide";

/**
 * PilotSwarmWorker — runs activities and orchestrations.
 *
 * Owns:
 *   - SessionManager (creates/resumes CopilotSessions, holds tools/hooks)
 *   - duroxide Runtime (dispatches activities + orchestrations)
 *   - Session state store (optional, for session dehydration/hydration)
 *
 * In single-process mode, pass this worker to PilotSwarmClient's
 * constructor so they share the database provider and the client can
 * forward tool/hook registrations.
 */
export class PilotSwarmWorker {
    private config: PilotSwarmWorkerOptions & { waitThreshold: number };
    private sessionManager: SessionManager;
    private sessionStore: SessionStateStore | null = null;
    private blobStore: SessionBlobStore | null = null;
    private runtime: any = null;
    private _provider: any = null;
    private _catalog: SessionCatalogProvider | null = null;
    private _started = false;
    /** Worker-level tool registry — name → Tool. */
    private toolRegistry = new Map<string, Tool<any>>();
    /** Loaded skill directories from plugins + direct config. */
    private _loadedSkillDirs: string[] = [];
    /** Raw loaded user-creatable agent configs from plugins + direct config. */
    private _rawLoadedAgents: Array<{ name: string; description?: string; prompt: string; tools?: string[] | null; namespace?: string; promptLayerKind?: "app-agent" | "app-system-agent" | "pilotswarm-system-agent" }> = [];
    /** Loaded agent configs from plugins + direct config, composed for SDK customAgents. */
    private _loadedAgents: Array<{ name: string; description?: string; prompt: string; tools?: string[] | null; namespace?: string }> = [];
    /** Loaded MCP server configs from plugins + direct config. */
    private _loadedMcpServers: Record<string, any> = {};
    /** Model provider registry — multi-provider LLM config. */
    private _modelProviders: ModelProviderRegistry | null = null;
    /** Embedded PilotSwarm framework prompt. */
    private _frameworkBasePrompt: string | null = null;
    /** App-level default prompt overlay from app pluginDirs and inline worker config. */
    private _appDefaultPrompt: string | null = null;
    /** System agents loaded from plugins — started automatically on worker start. */
    private _loadedSystemAgents: AgentConfig[] = [];
    /** Prompt lookup used for direct named/system sessions. */
    private _agentPromptLookup: Record<string, { prompt: string; kind: "app-agent" | "app-system-agent" | "pilotswarm-system-agent" }> = {};
    /** Session creation policy loaded from session-policy.json. */
    private _sessionPolicy: import("./types.js").SessionPolicy | null = null;

    constructor(options: PilotSwarmWorkerOptions) {
        this.config = {
            ...options,
            waitThreshold: options.waitThreshold ?? 30,
        };

        if (options.blobConnectionString) {
            this.blobStore = new SessionBlobStore(
                options.blobConnectionString,
                options.blobContainer ?? "copilot-sessions",
                options.sessionStateDir,
            );
        }

        let defaultSessionStore: SessionStateStore | null = this.blobStore;
        if (!defaultSessionStore && options.sessionStateDir) {
            const storeDir = path.join(path.dirname(options.sessionStateDir), "session-store");
            defaultSessionStore = new FilesystemSessionStore(storeDir, options.sessionStateDir);
        }
        this.sessionStore = options.sessionStore ?? defaultSessionStore;

        // Load plugins and merge with direct config — must happen before SessionManager init
        this._loadPlugins();

        // Load model providers: explicit file path > auto-discover > env vars fallback
        this._modelProviders = loadModelProviders(options.modelProvidersPath);

        this.sessionManager = new SessionManager(
            options.githubToken,
            this.sessionStore,
            {
                frameworkBasePrompt: this._frameworkBasePrompt ?? undefined,
                appDefaultPrompt: this._appDefaultPrompt ?? undefined,
                systemMessage: this._frameworkBasePrompt ?? undefined,
                agentPromptLookup: this._agentPromptLookup,
                skillDirectories: this._loadedSkillDirs,
                customAgents: this._loadedAgents,
                mcpServers: this._loadedMcpServers,
                provider: options.provider,
                modelProviders: this._modelProviders ?? undefined,
                turnTimeoutMs: options.turnTimeoutMs,
            },
            options.sessionStateDir,
        );
    }

    // ─── Public API ──────────────────────────────────────────

    /**
     * Register tools at the worker level.
     *
     * These tools are available to ALL sessions on this worker.
    * Clients can reference them by name in createSession() via
    * `toolNames: ["tool_name_1", "tool_name_2"]` — the names travel
     * through duroxide as serializable strings, and the worker
     * resolves them to the actual Tool objects at execution time.
     *
     * This is the primary mechanism for custom tools in remote/
     * separate-process mode where client and worker run on
     * different machines.
     */
    registerTools(tools: Tool<any>[]): void {
        for (const tool of tools) {
            this.toolRegistry.set((tool as any).name, tool);
        }
        this.sessionManager.setToolRegistry(this.toolRegistry);
    }

    /** Store full config (with tools/hooks) for a session. */
    setSessionConfig(sessionId: string, config: ManagedSessionConfig): void {
        this.sessionManager.setConfig(sessionId, config);
    }

    /** Whether a durable session store is configured. */
    get blobEnabled(): boolean {
        return this.sessionStore !== null;
    }

    /** Whether the worker runtime is running. */
    get isStarted(): boolean {
        return this._started;
    }

    /** @internal — shared with co-located PilotSwarmClient. */
    get provider(): any {
        return this._provider;
    }

    /** Session catalog (CMS) — available when store is PostgreSQL. */
    get catalog(): SessionCatalogProvider | null {
        return this._catalog;
    }

    /** Loaded skill directories. */
    get loadedSkillDirs(): string[] {
        return this._loadedSkillDirs;
    }

    /** Loaded agent configs. */
    get loadedAgents(): Array<{ name: string; description?: string; prompt: string; tools?: string[] | null; namespace?: string }> {
        return this._loadedAgents;
    }

    /** Loaded MCP server configs. */
    get loadedMcpServers(): Record<string, any> {
        return this._loadedMcpServers;
    }

    /** Model provider registry (null if no providers configured). */
    get modelProviders(): ModelProviderRegistry | null {
        return this._modelProviders;
    }

    /** System agents loaded from plugins. */
    get systemAgents(): AgentConfig[] {
        return this._loadedSystemAgents;
    }

    /** Session creation policy (null if no session-policy.json found). */
    get sessionPolicy(): import("./types.js").SessionPolicy | null {
        return this._sessionPolicy;
    }

    /** Names of loaded non-system agents that can be created as top-level sessions. */
    get allowedAgentNames(): string[] {
        return this._loadedAgents.map(a => a.name);
    }

    // ─── Lifecycle ───────────────────────────────────────────

    async start(): Promise<void> {
        if (this._started) return;

        this._provider = await this._createProvider();

        // Initialize CMS catalog for PostgreSQL stores
        const store = this.config.store;
        if (store.startsWith("postgres://") || store.startsWith("postgresql://")) {
            try {
                this._catalog = await PgSessionCatalogProvider.create(store, this.config.cmsSchema);
                await this._catalog.initialize();
            } catch (err) {
                console.error("[PilotSwarmWorker] CMS initialization failed:", err);
                this._catalog = null;
            }
        }

        this.runtime = new Runtime(this._provider, {
            dispatcherPollIntervalMs: 10,
            workerLockTimeoutMs: 10_000,
            logLevel: this.config.logLevel ?? "error",
            maxSessionsPerRuntime: this.config.maxSessionsPerRuntime ?? 50,
            sessionIdleTimeoutMs: this.config.sessionIdleTimeoutMs ?? 3_600_000,
            workerNodeId: this.config.workerNodeId,
        });

        registerActivities(
            this.runtime,
            this.sessionManager,
            this.sessionStore,
            this.config.githubToken,
            this._catalog,
            this._provider,
            store,
            this.config.cmsSchema,
            {
                blobEnabled: this.blobEnabled,
                duroxideSchema: this.config.duroxideSchema,
            },
            this._loadedSystemAgents,
            this._sessionPolicy,
            this.allowedAgentNames,
            this._rawLoadedAgents,
        );

        for (const registration of DURABLE_SESSION_ORCHESTRATION_REGISTRY) {
            this.runtime.registerOrchestrationVersioned(
                DURABLE_SESSION_ORCHESTRATION_NAME,
                registration.version,
                registration.handler,
            );
        }

        // Auto-register sweeper tools if CMS is available
        if (this._catalog) {
            const sweeperClient = new Client(this._provider);
            const sweeperTools = createSweeperTools({
                catalog: this._catalog,
                duroxideClient: sweeperClient,
                duroxideSchema: this.config.duroxideSchema,
                storeUrl: this.config.store,
            });
            this.registerTools(sweeperTools);
        }

        // Auto-register artifact tools if blob storage is available
        if (this.blobStore) {
            const artifactTools = createArtifactTools({ blobStore: this.blobStore });
            this.registerTools(artifactTools);
        }

        // Auto-register resource manager tools
        if (this._catalog) {
            const rmClient = new Client(this._provider);
            const rmTools = createResourceManagerTools({
                catalog: this._catalog,
                duroxideClient: rmClient,
                blobStore: this.blobStore,
                duroxideSchema: this.config.duroxideSchema,
                cmsSchema: this.config.cmsSchema,
            });
            this.registerTools(rmTools);
        }

        // list_agents tool — exposes loaded agents to the PilotSwarm Agent
        const listAgentsTool = defineTool("list_agents", {
            description:
                "List all loaded agents in the PilotSwarm cluster. Returns both user-invocable agents and system agents " +
                "with their name, namespace, qualifiedName, description, tools, system flag, and parent relationship. " +
                "Use creatableOnly=true to get only agents that users can create as top-level sessions.",
            parameters: {
                type: "object" as const,
                properties: {
                    systemOnly: {
                        type: "boolean",
                        description: "If true, only return system agents. Default: false",
                    },
                    creatableOnly: {
                        type: "boolean",
                        description: "If true, only return user-creatable (non-system) agents. Default: false",
                    },
                },
            },
            handler: async (args: { systemOnly?: boolean; creatableOnly?: boolean }) => {
                const allAgents = [
                    ...this._loadedAgents.map(a => ({
                        name: a.name,
                        namespace: (a as any).namespace || "custom",
                        qualifiedName: `${(a as any).namespace || "custom"}:${a.name}`,
                        description: a.description || null,
                        tools: a.tools || [],
                        system: false,
                        id: null,
                        parent: null,
                    })),
                    ...this._loadedSystemAgents.map(a => ({
                        name: a.name,
                        namespace: a.namespace || "pilotswarm",
                        qualifiedName: `${a.namespace || "pilotswarm"}:${a.name}`,
                        description: a.description || null,
                        tools: a.tools || [],
                        system: true,
                        id: a.id || null,
                        parent: a.parent || null,
                    })),
                ];
                let filtered = allAgents;
                if (args.systemOnly) {
                    filtered = allAgents.filter(a => a.system);
                } else if (args.creatableOnly) {
                    filtered = allAgents.filter(a => !a.system);
                }
                return JSON.stringify({ agents: filtered, total: filtered.length }, null, 2);
            },
        });
        this.registerTools([listAgentsTool]);

        this.runtime.start().catch((err: any) => {
            console.error("[PilotSwarmWorker] Runtime error:", err);
        });
        this._started = true;

        await new Promise(r => setTimeout(r, 200));

        // Auto-start system agents defined in plugins (idempotent)
        await this._startSystemAgents();
    }

    async stop(): Promise<void> {
        if (this.runtime) {
            await this.runtime.shutdown(5000);
            this.runtime = null;
        }
        await this.sessionManager.shutdown();
        if (this._catalog) {
            try { await this._catalog.close(); } catch {}
            this._catalog = null;
        }
        this._provider = null;
        this._started = false;
    }

    /** Dehydrate all active sessions, then stop. */
    async gracefulShutdown(): Promise<void> {
        if (this.sessionStore) {
            const ids = this.sessionManager.activeSessionIds();
            if (ids.length > 0) {
                console.error(`[PilotSwarmWorker] Dehydrating ${ids.length} sessions...`);
                await Promise.allSettled(
                    ids.map(id => this.sessionManager.dehydrate(id, "shutdown").catch(() => {})),
                );
            }
        }
        await this.stop();
    }

    /** Destroy a session on this worker. */
    async destroySession(sessionId: string): Promise<void> {
        await this.sessionManager.destroySession(sessionId);
    }

    // ─── Internal ────────────────────────────────────────────

    /**
     * Load plugin contents from SDK bundled plugins + app plugin directories.
     *
     * Three-tier loading order:
     *   1. system/  — SDK core (always loaded: base system prompt, durable-timers, sub-agents)
     *   2. mgmt/    — SDK management agents (loaded unless disableManagementAgents is true)
     *   3. app      — Consumer-provided plugin dirs (from pluginDirs option)
     *   4. direct   — Inline config (skillDirectories, customAgents, mcpServers options)
     *
     * Agents merge by name (later tiers override earlier).
     * Skills merge additively (all dirs combined).
     * MCP servers merge by name (later tiers override earlier).
     */
    private _loadPlugins(): void {
        // ── Tier 1: SDK system plugins (always loaded) ───────────────
        const sdkPluginsDir = path.resolve(__sdkDir, "..", "plugins");
        const systemDir = path.join(sdkPluginsDir, "system");
        this._loadPluginDir(systemDir, "system");

        // ── Tier 2: SDK management plugins (opt-out) ─────────────────
        if (!(this.config as any).disableManagementAgents) {
            const mgmtDir = path.join(sdkPluginsDir, "mgmt");
            this._loadPluginDir(mgmtDir, "management");
        }

        // ── Tier 3: App plugins (from pluginDirs option) ─────────────
        const pluginDirs = this.config.pluginDirs ?? [];
        for (const pluginDir of pluginDirs) {
            const absDir = path.resolve(pluginDir);
            if (!fs.existsSync(absDir)) {
                console.warn(`[PilotSwarmWorker] Plugin dir not found: ${absDir}`);
                continue;
            }
            this._loadPluginDir(absDir, "app");
        }

        // ── Tier 4: Direct config (inline options override all) ──────
        if (this.config.skillDirectories?.length) {
            this._loadedSkillDirs.push(...this.config.skillDirectories);
        }
        if (this.config.customAgents?.length) {
            for (const agent of this.config.customAgents) {
                this._rawLoadedAgents.push({ ...agent, promptLayerKind: "app-agent" });
                this._agentPromptLookup[agent.name] = {
                    prompt: agent.prompt,
                    kind: "app-agent",
                };
            }
        }
        if (this.config.mcpServers) {
            Object.assign(this._loadedMcpServers, this.config.mcpServers);
        }
        this._appDefaultPrompt = mergePromptSections([
            this._appDefaultPrompt,
            this.config.systemMessage,
        ]) ?? null;
        this._loadedAgents = this._rawLoadedAgents.map((agent) => ({
            ...agent,
            prompt: composeSystemPrompt({
                frameworkBase: this._frameworkBasePrompt,
                appDefault: this._appDefaultPrompt,
                activeAgentPrompt: agent.prompt,
            }) ?? agent.prompt,
        }));

        // ── Log summary ──────────────────────────────────────────────
        const parts: string[] = [];
        if (this._frameworkBasePrompt) parts.push(`framework base prompt`);
        if (this._appDefaultPrompt) parts.push(`app default prompt overlay`);
        if (this._loadedSkillDirs.length > 0) parts.push(`${this._loadedSkillDirs.length} skill dir(s)`);
        if (this._loadedAgents.length > 0) parts.push(`${this._loadedAgents.length} agent(s): ${this._loadedAgents.map(a => a.name).join(", ")}`);
        if (this._loadedSystemAgents.length > 0) parts.push(`${this._loadedSystemAgents.length} system agent(s): ${this._loadedSystemAgents.map(a => a.name).join(", ")}`);
        const mcpCount = Object.keys(this._loadedMcpServers).length;
        if (mcpCount > 0) parts.push(`${mcpCount} MCP server(s): ${Object.keys(this._loadedMcpServers).join(", ")}`);

        if (parts.length > 0) {
            console.log(`[PilotSwarmWorker] Loaded: ${parts.join("; ")}`);
        }
    }

    /**
     * Load agents, skills, MCP config, and session policy from a single plugin directory.
     */
    private _loadPluginDir(absDir: string, layer: "system" | "management" | "app"): void {
        if (!fs.existsSync(absDir)) return;

        // Determine namespace from plugin.json name or directory basename
        let namespace = path.basename(absDir);
        const pluginJsonPath = path.join(absDir, "plugin.json");
        if (fs.existsSync(pluginJsonPath)) {
            try {
                const pluginJson = JSON.parse(fs.readFileSync(pluginJsonPath, "utf-8"));
                if (pluginJson.name) namespace = pluginJson.name;
            } catch {}
        }

        // Skills
        const skillsDir = path.join(absDir, "skills");
        if (fs.existsSync(skillsDir)) {
            this._loadedSkillDirs.push(skillsDir);
        }

        // Agents — tag each with namespace
        const agentsDir = path.join(absDir, "agents");
        if (fs.existsSync(agentsDir)) {
            const agents = loadAgentFiles(agentsDir);
            for (const agent of agents) {
                agent.namespace = namespace;
                if (agent.name === "default") {
                    if (layer === "system") {
                        this._frameworkBasePrompt = agent.prompt;
                    } else if (layer === "app") {
                        this._appDefaultPrompt = agent.prompt;
                    }
                } else if (agent.system) {
                    agent.promptLayerKind = layer === "management" ? "pilotswarm-system-agent" : "app-system-agent";
                    this._agentPromptLookup[agent.name] = {
                        prompt: agent.prompt,
                        kind: agent.promptLayerKind,
                    };
                    this._loadedSystemAgents.push(agent);
                } else {
                    agent.promptLayerKind = "app-agent";
                    this._agentPromptLookup[agent.name] = {
                        prompt: agent.prompt,
                        kind: "app-agent",
                    };
                    this._rawLoadedAgents.push(agent);
                }
            }
        }

        // MCP
        const mcpConfig = loadMcpConfig(absDir);
        Object.assign(this._loadedMcpServers, mcpConfig);

        // Session policy — last one wins
        const policyPath = path.join(absDir, "session-policy.json");
        if (fs.existsSync(policyPath)) {
            try {
                this._sessionPolicy = JSON.parse(fs.readFileSync(policyPath, "utf-8"));
            } catch (err: any) {
                console.warn(`[PilotSwarmWorker] Failed to parse session-policy.json: ${err.message}`);
            }
        }
    }

    /**
     * Auto-start system agents defined in plugins.
     *
     * Each system agent has a deterministic session UUID derived from its `id` slug.
     * Multiple workers calling this concurrently is safe — CMS upsert and
     * duroxide startOrchestrationVersioned are both idempotent.
     */
    private async _startSystemAgents(): Promise<void> {
        if (!this._catalog) return; // No CMS = no system agents
        if (this._loadedSystemAgents.length === 0) return;

        const duroxideClient = new Client(this._provider);

        // Only start root agents (no parent field) — child system agents are
        // spawned by the parent agent at runtime via spawn_agent with agent_name.
        const rootAgents = this._loadedSystemAgents.filter(a => !a.parent);

        for (const agent of rootAgents) {
            if (!agent.id) continue;

            const sessionId = systemAgentUUID(agent.id);
            const orchestrationId = `session-${sessionId}`;

            try {
                // Check if this system agent's session already exists in CMS
                let existing = false;
                try {
                    const row = await this._catalog.getSession(sessionId);
                    if (row) existing = true;
                } catch { /* not found */ }

                if (existing) {
                    // Already created — nothing to do. The orchestration is either
                    // running or will be picked up by the runtime.
                    continue;
                }

                const serializableConfig = {
                    boundAgentName: agent.name,
                    promptLayering: {
                        kind: agent.promptLayerKind ?? (agent.namespace === "pilotswarm" ? "pilotswarm-system-agent" : "app-system-agent"),
                    },
                    toolNames: agent.tools ?? undefined,
                };

                // Create CMS entry (root agents have no parent)
                await this._catalog.createSession(sessionId, {
                    isSystem: true,
                    agentId: agent.id,
                    splash: agent.splash ?? undefined,
                });
                // Set title immediately — prefer explicit title, fallback to capitalized name + "Agent"
                const title = agent.title ?? (agent.name.charAt(0).toUpperCase() + agent.name.slice(1) + " Agent");
                await this._catalog.updateSession(sessionId, { title });

                // Start the duroxide orchestration
                const input: OrchestrationInput = {
                    sessionId,
                    config: serializableConfig,
                    iteration: 0,
                    blobEnabled: this.blobEnabled,
                    dehydrateThreshold: this.config.waitThreshold,
                    idleTimeout: -1, // system agents never idle-dehydrate
                    inputGracePeriod: -1,
                    isSystem: true,
                };

                await duroxideClient.startOrchestrationVersioned(
                    orchestrationId,
                    DURABLE_SESSION_ORCHESTRATION_NAME,
                    input,
                    DURABLE_SESSION_LATEST_VERSION,
                );

                // Update CMS with orchestration ID
                await this._catalog.updateSession(sessionId, {
                    orchestrationId,
                    state: "running",
                    lastActiveAt: new Date(),
                });

                // Send the initial prompt to kick off the agent
                if (agent.initialPrompt) {
                    await duroxideClient.enqueueEvent(
                        orchestrationId,
                        "messages",
                        JSON.stringify({ prompt: agent.initialPrompt, bootstrap: true }),
                    );
                }

                console.log(`[PilotSwarmWorker] System agent started: ${agent.name} (${sessionId.slice(0, 8)})`);
            } catch (err: any) {
                // Likely already exists (race with another worker) — not an error
                if (err.message?.includes("already exists") || err.message?.includes("duplicate")) {
                    continue;
                }
                console.warn(`[PilotSwarmWorker] System agent ${agent.name} start failed: ${err.message}`);
            }
        }
    }

    private async _createProvider(): Promise<any> {
        const store = this.config.store;
        if (store === "sqlite::memory:") return SqliteProvider.inMemory();
        if (store.startsWith("sqlite://")) return SqliteProvider.open(store);
        if (store.startsWith("postgres://") || store.startsWith("postgresql://")) {
            return PostgresProvider.connectWithSchema(store, this.config.duroxideSchema ?? DEFAULT_DUROXIDE_SCHEMA);
        }
        throw new Error(`Unsupported store URL: ${store}`);
    }
}
