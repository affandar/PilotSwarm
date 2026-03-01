import { SessionManager } from "./session-manager.js";
import { SessionBlobStore } from "./blob-store.js";
import { registerActivities } from "./session-proxy.js";
import { durableSessionOrchestration_1_0_1 } from "./orchestration.js";
import { durableSessionOrchestration_1_0_0 } from "./orchestration_1_0_0.js";
import { PgSessionCatalogProvider } from "./cms.js";
import type { SessionCatalogProvider } from "./cms.js";
import { loadAgentFiles } from "./agent-loader.js";
import { loadMcpConfig } from "./mcp-loader.js";
import type { Tool } from "@github/copilot-sdk";
import type { DurableCopilotWorkerOptions, ManagedSessionConfig } from "./types.js";
import fs from "node:fs";
import path from "node:path";

// duroxide is CommonJS — use createRequire for ESM compatibility
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { SqliteProvider, PostgresProvider, Runtime } = require("duroxide");

const ORCHESTRATION_NAME = "durable-session-v2";
const DUROXIDE_SCHEMA = "duroxide";

/**
 * DurableCopilotWorker — runs activities and orchestrations.
 *
 * Owns:
 *   - SessionManager (creates/resumes CopilotSessions, holds tools/hooks)
 *   - duroxide Runtime (dispatches activities + orchestrations)
 *   - BlobStore (optional, for session dehydration/hydration)
 *
 * In single-process mode, pass this worker to DurableCopilotClient's
 * constructor so they share the database provider and the client can
 * forward tool/hook registrations.
 */
export class DurableCopilotWorker {
    private config: DurableCopilotWorkerOptions & { waitThreshold: number };
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

    constructor(options: DurableCopilotWorkerOptions) {
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

        this.sessionManager = new SessionManager(
            options.githubToken,
            this.blobStore,
            {
                systemMessage: options.systemMessage,
                skillDirectories: this._loadedSkillDirs,
                customAgents: this._loadedAgents,
                mcpServers: this._loadedMcpServers,
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

    /** @internal — shared with co-located DurableCopilotClient. */
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

    // ─── Lifecycle ───────────────────────────────────────────

    async start(): Promise<void> {
        if (this._started) return;

        this._provider = await this._createProvider();

        // Initialize CMS catalog for PostgreSQL stores
        const store = this.config.store;
        if (store.startsWith("postgres://") || store.startsWith("postgresql://")) {
            try {
                this._catalog = await PgSessionCatalogProvider.create(store);
                await this._catalog.initialize();
            } catch (err) {
                console.error("[DurableCopilotWorker] CMS initialization failed:", err);
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
        );

        this.runtime.registerOrchestrationVersioned(ORCHESTRATION_NAME, "1.0.0", durableSessionOrchestration_1_0_0);
        this.runtime.registerOrchestrationVersioned(ORCHESTRATION_NAME, "1.0.1", durableSessionOrchestration_1_0_1);

        this.runtime.start().catch((err: any) => {
            console.error("[DurableCopilotWorker] Runtime error:", err);
        });
        this._started = true;

        await new Promise(r => setTimeout(r, 200));
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
                console.error(`[DurableCopilotWorker] Dehydrating ${ids.length} sessions...`);
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
     * with any direct config from DurableCopilotWorkerOptions.
     */
    private _loadPlugins(): void {
        // 1. Load from plugin directories
        const pluginDirs = this.config.pluginDirs ?? [];
        for (const pluginDir of pluginDirs) {
            const absDir = path.resolve(pluginDir);

            if (!fs.existsSync(absDir)) {
                console.warn(`[DurableCopilotWorker] Plugin dir not found: ${absDir}`);
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
                this._loadedAgents.push(...agents);
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

        // 3. Log summary
        const parts: string[] = [];
        if (this._loadedSkillDirs.length > 0) parts.push(`${this._loadedSkillDirs.length} skill dir(s)`);
        if (this._loadedAgents.length > 0) parts.push(`${this._loadedAgents.length} agent(s): ${this._loadedAgents.map(a => a.name).join(", ")}`);
        const mcpCount = Object.keys(this._loadedMcpServers).length;
        if (mcpCount > 0) parts.push(`${mcpCount} MCP server(s): ${Object.keys(this._loadedMcpServers).join(", ")}`);

        if (parts.length > 0) {
            console.log(`[DurableCopilotWorker] Loaded: ${parts.join("; ")}`);
        }
    }

    private async _createProvider(): Promise<any> {
        const store = this.config.store;
        if (store === "sqlite::memory:") return SqliteProvider.inMemory();
        if (store.startsWith("sqlite://")) return SqliteProvider.open(store);
        if (store.startsWith("postgres://") || store.startsWith("postgresql://")) {
            return PostgresProvider.connectWithSchema(store, DUROXIDE_SCHEMA);
        }
        throw new Error(`Unsupported store URL: ${store}`);
    }
}
