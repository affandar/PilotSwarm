import { SessionManager } from "./session-manager.js";
import { SessionBlobStore } from "./blob-store.js";
import { registerActivities } from "./session-proxy.js";
import { durableSessionOrchestration_1_0_1 } from "./orchestration_1_0_1.js";
import { durableSessionOrchestration_1_0_0 } from "./orchestration_1_0_0.js";
import { durableSessionOrchestration_1_0_2 } from "./orchestration_1_0_2.js";
import { durableSessionOrchestration_1_0_3 } from "./orchestration_1_0_3.js";
import { durableSessionOrchestration_1_0_4 } from "./orchestration_1_0_4.js";
import { durableSessionOrchestration_1_0_5 } from "./orchestration_1_0_5.js";
import { durableSessionOrchestration_1_0_6 } from "./orchestration.js";
import { PgSessionCatalogProvider } from "./cms.js";
import type { SessionCatalogProvider } from "./cms.js";
import { loadAgentFiles, systemAgentUUID } from "./agent-loader.js";
import { loadMcpConfig } from "./mcp-loader.js";
import { loadModelProviders, type ModelProviderRegistry } from "./model-providers.js";
import { createArtifactTools } from "./artifact-tools.js";
import { createSweeperTools } from "./sweeper-tools.js";
import type { Tool } from "@github/copilot-sdk";
import type { PilotSwarmWorkerOptions, ManagedSessionConfig, OrchestrationInput } from "./types.js";
import type { AgentConfig } from "./agent-loader.js";
import fs from "node:fs";
import path from "node:path";

// duroxide is CommonJS — use createRequire for ESM compatibility
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { SqliteProvider, PostgresProvider, Runtime, Client } = require("duroxide");

const ORCHESTRATION_NAME = "durable-session-v2";
const ORCHESTRATION_VERSION = "1.0.6";
const DEFAULT_DUROXIDE_SCHEMA = "duroxide";

/**
 * PilotSwarmWorker — runs activities and orchestrations.
 *
 * Owns:
 *   - SessionManager (creates/resumes CopilotSessions, holds tools/hooks)
 *   - duroxide Runtime (dispatches activities + orchestrations)
 *   - BlobStore (optional, for session dehydration/hydration)
 *
 * In single-process mode, pass this worker to PilotSwarmClient's
 * constructor so they share the database provider and the client can
 * forward tool/hook registrations.
 */
export class PilotSwarmWorker {
    private config: PilotSwarmWorkerOptions & { waitThreshold: number };
    private sessionManager: SessionManager;
    private blobStore: SessionBlobStore | null = null;
    private runtime: any = null;
    private _provider: any = null;
    private _catalog: SessionCatalogProvider | null = null;
    private _started = false;
    /** Worker-level tool registry — name → Tool. */
    private toolRegistry = new Map<string, Tool<any>>();
    /** Loaded skill directories from plugins + direct config. */
    private _loadedSkillDirs: string[] = [];
    /** Loaded agent configs from plugins + direct config. */
    private _loadedAgents: Array<{ name: string; description?: string; prompt: string; tools?: string[] | null }> = [];
    /** Loaded MCP server configs from plugins + direct config. */
    private _loadedMcpServers: Record<string, any> = {};
    /** Model provider registry — multi-provider LLM config. */
    private _modelProviders: ModelProviderRegistry | null = null;
    /** Prompt from default.agent.md — used as base system message. */
    private _defaultAgentPrompt: string | null = null;
    /** System agents loaded from plugins — started automatically on worker start. */
    private _loadedSystemAgents: AgentConfig[] = [];

    constructor(options: PilotSwarmWorkerOptions) {
        this.config = {
            ...options,
            waitThreshold: options.waitThreshold ?? 30,
        };

        if (options.blobConnectionString) {
            this.blobStore = new SessionBlobStore(
                options.blobConnectionString,
                options.blobContainer ?? "copilot-sessions",
            );
        }

        // Load plugins and merge with direct config — must happen before SessionManager init
        this._loadPlugins();

        // Load model providers: explicit file path > auto-discover > env vars fallback
        this._modelProviders = loadModelProviders(options.modelProvidersPath);

        this.sessionManager = new SessionManager(
            options.githubToken,
            this.blobStore,
            {
                systemMessage: options.systemMessage ?? this._defaultAgentPrompt ?? undefined,
                skillDirectories: this._loadedSkillDirs,
                customAgents: this._loadedAgents,
                mcpServers: this._loadedMcpServers,
                provider: options.provider,
                modelProviders: this._modelProviders ?? undefined,
            },
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

    /** Whether blob storage is configured. */
    get blobEnabled(): boolean {
        return this.blobStore !== null;
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
    get loadedAgents(): Array<{ name: string; description?: string; prompt: string; tools?: string[] | null }> {
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
            this.blobStore,
            this.config.githubToken,
            this._catalog,
            this._provider,
            store,
            this.config.cmsSchema,
            {
                blobEnabled: this.blobEnabled,
                duroxideSchema: this.config.duroxideSchema,
            },
        );

        this.runtime.registerOrchestrationVersioned(ORCHESTRATION_NAME, "1.0.0", durableSessionOrchestration_1_0_0);
        this.runtime.registerOrchestrationVersioned(ORCHESTRATION_NAME, "1.0.1", durableSessionOrchestration_1_0_1);
        this.runtime.registerOrchestrationVersioned(ORCHESTRATION_NAME, "1.0.2", durableSessionOrchestration_1_0_2);
        this.runtime.registerOrchestrationVersioned(ORCHESTRATION_NAME, "1.0.3", durableSessionOrchestration_1_0_3);
        this.runtime.registerOrchestrationVersioned(ORCHESTRATION_NAME, "1.0.4", durableSessionOrchestration_1_0_4);
        this.runtime.registerOrchestrationVersioned(ORCHESTRATION_NAME, "1.0.5", durableSessionOrchestration_1_0_5);
        this.runtime.registerOrchestrationVersioned(ORCHESTRATION_NAME, "1.0.6", durableSessionOrchestration_1_0_6);

        // Auto-register sweeper tools if CMS is available
        if (this._catalog) {
            const sweeperClient = new Client(this._provider);
            const sweeperTools = createSweeperTools({
                catalog: this._catalog,
                duroxideClient: sweeperClient,
                duroxideSchema: this.config.duroxideSchema,
            });
            this.registerTools(sweeperTools);
        }

        // Auto-register artifact tools if blob storage is available
        if (this.blobStore) {
            const artifactTools = createArtifactTools({ blobStore: this.blobStore });
            this.registerTools(artifactTools);
        }

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
        if (this.blobStore) {
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
     * Load plugin contents from plugin directories + direct config.
     * Reads skills, agents, and MCP from each plugin dir and merges
     * with any direct config from PilotSwarmWorkerOptions.
     */
    private _loadPlugins(): void {
        // 1. Load from plugin directories
        const pluginDirs = this.config.pluginDirs ?? [];
        for (const pluginDir of pluginDirs) {
            const absDir = path.resolve(pluginDir);

            if (!fs.existsSync(absDir)) {
                console.warn(`[PilotSwarmWorker] Plugin dir not found: ${absDir}`);
                continue;
            }

            // Skills: each subdirectory of skills/ containing SKILL.md
            const skillsDir = path.join(absDir, "skills");
            if (fs.existsSync(skillsDir)) {
                this._loadedSkillDirs.push(skillsDir);
            }

            // Agents: parse .agent.md files
            const agentsDir = path.join(absDir, "agents");
            if (fs.existsSync(agentsDir)) {
                const agents = loadAgentFiles(agentsDir);
                for (const agent of agents) {
                    if (agent.name === "default") {
                        // default.agent.md → becomes the base system message,
                        // not a custom @-mentionable agent.
                        this._defaultAgentPrompt = agent.prompt;
                    } else if (agent.system) {
                        // System agents are started automatically by the worker
                        this._loadedSystemAgents.push(agent);
                    } else {
                        this._loadedAgents.push(agent);
                    }
                }
            }

            // MCP: parse .mcp.json
            const mcpConfig = loadMcpConfig(absDir);
            Object.assign(this._loadedMcpServers, mcpConfig);
        }

        // 2. Merge direct config (takes precedence over plugins)
        if (this.config.skillDirectories?.length) {
            this._loadedSkillDirs.push(...this.config.skillDirectories);
        }
        if (this.config.customAgents?.length) {
            this._loadedAgents.push(...this.config.customAgents);
        }
        if (this.config.mcpServers) {
            Object.assign(this._loadedMcpServers, this.config.mcpServers);
        }

        // 3. Prepend default agent prompt to all other agents so they inherit base rules
        if (this._defaultAgentPrompt) {
            for (const agent of this._loadedAgents) {
                agent.prompt = `${this._defaultAgentPrompt}\n\n---\n\n${agent.prompt}`;
            }
        }

        // 4. Log summary
        const parts: string[] = [];
        if (this._defaultAgentPrompt) parts.push(`default agent (system message)`);
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

        for (const agent of this._loadedSystemAgents) {
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

                // Build system message — use the agent prompt directly (mode: replace)
                // The system agent prompt replaces the default agent prompt entirely.
                const systemMessage = {
                    mode: "replace" as const,
                    content: agent.prompt,
                };

                const serializableConfig = {
                    systemMessage,
                    toolNames: agent.tools ?? undefined,
                };

                // Create CMS entry
                await this._catalog.createSession(sessionId, {
                    isSystem: true,
                });
                // Set title immediately
                const title = agent.name.charAt(0).toUpperCase() + agent.name.slice(1) + " Agent";
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
                    ORCHESTRATION_NAME,
                    input,
                    ORCHESTRATION_VERSION,
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
                        JSON.stringify({ prompt: agent.initialPrompt }),
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
