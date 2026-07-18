import { SessionManager } from "./session-manager.js";
import { SessionBlobStore, createSessionBlobStore } from "./blob-store.js";
import { FilesystemArtifactStore, FilesystemSessionStore, type ArtifactStore, type SessionStateStore } from "./session-store.js";
import { registerActivities } from "./session-proxy.js";
import {
    DURABLE_SESSION_ORCHESTRATION_NAME,
    DURABLE_SESSION_ORCHESTRATION_REGISTRY,
} from "./orchestration-registry.js";
import { PgSessionCatalog } from "./cms.js";
import type { SessionCatalog } from "./cms.js";
import { loadAgentFiles } from "./agent-loader.js";
import { resolveToolGroups, PROTOCOL_FLOOR_TOOLS, type CapabilityCatalog, type CapabilityCatalogAgentDefaults } from "./capability-catalog.js";
import { composeDeclaredSkillsPrompt, loadSkillsSync, type Skill } from "./skills.js";
import { startSystemAgents } from "./system-agents.js";
import { loadMcpConfig } from "./mcp-loader.js";
import { createModelProvidersReloader, type ModelProviderRegistry } from "./model-providers.js";
import { createArtifactTools } from "./artifact-tools.js";
import { isEnhancedFactStore, PgFactStore, type FactStore } from "./facts-store.js";
import type { GraphStore } from "./graph-store.js";
import { resolveStorageConfig, type StorageConfig } from "./storage-config.js";
import { getDuroxideStorageProvider, getRuntimeStorageProvider } from "./storage-providers.js";
import { createSweeperTools } from "./sweeper-tools.js";
import { createResourceManagerTools } from "./resourcemgr-tools.js";
import { composeSystemPrompt, mergePromptSections } from "./prompt-layering.js";
import { buildSchemaIdentifier } from "./prompt-layers.js";
import { defineTool } from "@github/copilot-sdk";
import type { Tool } from "@github/copilot-sdk";
import type { PilotSwarmWorkerOptions, ManagedSessionConfig } from "./types.js";
import type { AgentConfig } from "./agent-loader.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// duroxide is CommonJS — use createRequire for ESM compatibility
import { createRequire } from "node:module";

const __sdkDir = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { SqliteProvider, Runtime, Client } = require("duroxide");

const DEFAULT_SESSION_STATE_DIR = path.join(os.homedir(), ".copilot", "session-state");
const DEFAULT_ORCHESTRATION_CONCURRENCY = 2;
const DEFAULT_WORKER_CONCURRENCY = 2;
const DEFAULT_DUROXIDE_PG_POOL_MAX = 10;

function normalizeAgentIdentity(value: unknown): string {
    return String(value ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function parsePositiveInt(raw: unknown): number | undefined {
    const normalized = typeof raw === "string" ? Number.parseInt(raw, 10) : Number(raw);
    if (!Number.isFinite(normalized) || normalized <= 0) return undefined;
    return Math.floor(normalized);
}

export { buildSystemAgentBootstrapPayload } from "./system-agents.js";

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
/**
 * Resolve the spawn-tree session IDs for a given session.
 *
 * Walks up to the root ancestor via `parentSessionId`, then returns
 * `[root, ...descendants_of_root]` minus the caller itself. This is the
 * visibility set used by `setLineageSessionLookup` so peer agents
 * (siblings, cousins) under a common root can share session-scoped
 * facts without needing `shared=true`.
 *
 * Exported so tests can verify spawn-tree visibility behavior with a
 * mock `SessionCatalog`.
 *
 * @internal
 */
export async function resolveSpawnTreeSessionIds(
    sessionId: string,
    catalog: Pick<SessionCatalog, "getSession" | "getDescendantSessionIds">,
): Promise<string[]> {
    const seen = new Set([sessionId]);
    const lineage: string[] = [];

    let rootSessionId = sessionId;
    const walked = new Set([sessionId]);
    while (true) {
        const row = await catalog.getSession(rootSessionId);
        const parentSessionId = row?.parentSessionId ?? null;
        if (!parentSessionId || parentSessionId === rootSessionId) break;
        if (walked.has(parentSessionId)) break; // cycle guard
        walked.add(parentSessionId);
        rootSessionId = parentSessionId;
    }

    if (rootSessionId !== sessionId) {
        lineage.push(rootSessionId);
        seen.add(rootSessionId);
    }

    const treeMembers = await catalog.getDescendantSessionIds(rootSessionId);
    for (const memberSessionId of treeMembers) {
        if (seen.has(memberSessionId)) continue;
        lineage.push(memberSessionId);
        seen.add(memberSessionId);
    }

    return lineage;
}

export class PilotSwarmWorker {
    private config: PilotSwarmWorkerOptions & { waitThreshold: number };
    private sessionManager: SessionManager;
    private sessionStore: SessionStateStore | null = null;
    private blobStore: SessionBlobStore | null = null;
    private artifactStore: ArtifactStore | null = null;
    private factStore: FactStore | null = null;
    private graphStore: GraphStore | null = null;
    private runtime: any = null;
    private _evictionTimer: ReturnType<typeof setInterval> | null = null;
    private _provider: any = null;
    private _catalog: SessionCatalog | null = null;
    private _started = false;
    /** Worker-level tool registry — name → Tool. */
    private toolRegistry = new Map<string, Tool<any>>();
    /** Loaded skill directories from plugins + direct config. */
    private _loadedSkillDirs: string[] = [];
    /** Loaded skills by name for agent-declared eager prompt injection. */
    private _loadedSkills = new Map<string, Skill>();
    /** Raw loaded user-creatable agent configs from plugins + direct config. */
    private _rawLoadedAgents: Array<{ name: string; description?: string; prompt: string; tools?: string[] | null; skills?: string[]; mcpServers?: string[]; inheritDefaultMcpServers?: boolean; allowedSkills?: string[]; toolPolicy?: { allow?: string[]; deny?: string[] }; namespace?: string; crawler?: boolean; harvester?: boolean; promptLayerKind?: "app-agent" | "app-system-agent" | "pilotswarm-system-agent" }> = [];
    /** Optional PilotSwarm-bundled user agents, loaded only when session policy opts in. */
    private _availableBundledAgents = new Map<string, AgentConfig>();
    /** Loaded agent configs from plugins + direct config, composed for SDK customAgents. */
    private _loadedAgents: Array<{ name: string; description?: string; prompt: string; tools?: string[] | null; skills?: string[]; mcpServers?: Record<string, any>; namespace?: string }> = [];
    /** Loaded MCP server configs from plugins + direct config (the deployment catalog). */
    private _loadedMcpServers: Record<string, any> = {};
    /** Resolved per-agent MCP server maps, keyed by agent name (raw + system agents). */
    private _agentMcpServers: Record<string, Record<string, any>> = {};
    /** Names of catalog servers tagged `"default": true` — the deployment default MCP set. */
    private _defaultMcpServerNames: string[] = [];
    /** MCP declarations gathered from base (default) agents — resolved into the base map. */
    private _baseAgentMcpDecl: { refs: string[]; inherit: boolean } = { refs: [], inherit: false };
    /** Server names from direct worker-config `mcpServers` — legacy every-session semantics. */
    private _directConfigMcpNames: string[] = [];
    /** Resolved base MCP map applied to EVERY session (base-agent opt-ins + direct config). */
    private _baseMcpServers: Record<string, any> = {};
    /** Per-agent allowedSkills restriction (as declared), keyed by agent name. */
    private _agentAllowedSkills: Record<string, string[]> = {};
    /** Per-agent DISABLED skill names (catalog − allowedSkills), keyed by agent name. */
    private _agentDisabledSkills: Record<string, string[]> = {};
    /** Per-agent tool policy, keyed by agent name. */
    private _agentToolPolicy: Record<string, { allow?: string[]; deny?: string[] }> = {};
    /** Model provider registry — multi-provider LLM config. */
    private _modelProviders: ModelProviderRegistry | null = null;
    /** Mtime watcher that re-loads model_providers.json on file change. */
    private _modelProvidersReloader: ReturnType<typeof createModelProvidersReloader> | null = null;
    private _modelProvidersReloadTimer: ReturnType<typeof setInterval> | null = null;
    /** Embedded PilotSwarm framework prompt. */
    private _frameworkBasePrompt: string | null = null;
    /** Tool names declared by the embedded PilotSwarm framework default agent. */
    private _frameworkBaseToolNames: string[] = [];
    /** App-level default prompt overlay from app pluginDirs and inline worker config. */
    private _appDefaultPrompt: string | null = null;
    /** Tool names declared by the app-level default agent overlay. */
    private _appDefaultToolNames: string[] = [];
    /** System agents loaded from plugins — started automatically on worker start. */
    private _loadedSystemAgents: AgentConfig[] = [];
    /** Prompt lookup used for direct named/system sessions. */
    private _agentPromptLookup: Record<string, { prompt: string; kind: "app-agent" | "app-system-agent" | "pilotswarm-system-agent"; descriptor?: import("./prompt-layers.js").PromptLayerDescriptor }> = {};
    /** Descriptor for the PilotSwarm framework base layer (from system default.agent.md). */
    private _frameworkBaseDescriptor: import("./prompt-layers.js").PromptLayerDescriptor | null = null;
    /** Descriptor for the app default layer (from app default.agent.md or inline config). */
    private _appDefaultDescriptor: import("./prompt-layers.js").PromptLayerDescriptor | null = null;
    /** Session creation policy loaded from session-policy.json. */
    private _sessionPolicy: import("./types.js").SessionPolicy | null = null;

    constructor(options: PilotSwarmWorkerOptions) {
        this.config = {
            ...options,
            waitThreshold: options.waitThreshold ?? 30,
        };
        const effectiveSessionStateDir = options.sessionStateDir ?? DEFAULT_SESSION_STATE_DIR;

        // Pick blob backing: explicit options win, but we route through
        // createSessionBlobStore() so the MI flag + account URL path
        // works the same way as for env-driven callers (CLI transport).
        const blobStore = createSessionBlobStore(
            {
                PILOTSWARM_USE_MANAGED_IDENTITY: options.useManagedIdentity ? "1" : undefined,
                AZURE_STORAGE_ACCOUNT_URL: options.blobAccountUrl,
                AZURE_STORAGE_CONNECTION_STRING: options.blobConnectionString,
                AZURE_STORAGE_CONTAINER: options.blobContainer,
            },
            { sessionStateDir: effectiveSessionStateDir },
        );

        if (blobStore) {
            this.blobStore = blobStore;
            this.artifactStore = blobStore;
        } else {
            // Local mode: use filesystem-based artifact storage
            const artifactDir = path.join(path.dirname(effectiveSessionStateDir), "artifacts");
            this.artifactStore = new FilesystemArtifactStore(artifactDir);
        }

        let defaultSessionStore: SessionStateStore | null = this.blobStore;
        if (!defaultSessionStore) {
            const storeDir = path.join(path.dirname(effectiveSessionStateDir), "session-store");
            defaultSessionStore = new FilesystemSessionStore(storeDir, effectiveSessionStateDir);
        }
        this.sessionStore = options.sessionStore ?? defaultSessionStore;

        // Load plugins and merge with direct config — must happen before SessionManager init
        this._loadPlugins();

        // Load model providers: explicit file path > auto-discover > env vars
        // fallback. The reloader mtime-watches the resolved file so a
        // ConfigMap rollout (new/changed models) applies without a pod
        // restart — the registry used to be read exactly once at startup.
        this._modelProvidersReloader = createModelProvidersReloader(options.modelProvidersPath);
        this._modelProviders = this._modelProvidersReloader.current;

        this.sessionManager = new SessionManager(
            options.githubToken,
            this.sessionStore,
            {
                frameworkBasePrompt: this._frameworkBasePrompt ?? undefined,
                frameworkBaseToolNames: this._frameworkBaseToolNames,
                appDefaultPrompt: this._appDefaultPrompt ?? undefined,
                appDefaultToolNames: this._appDefaultToolNames,
                systemMessage: this._frameworkBasePrompt ?? undefined,
                agentPromptLookup: this._agentPromptLookup,
                frameworkBaseDescriptor: this._frameworkBaseDescriptor ?? undefined,
                appDefaultDescriptor: this._appDefaultDescriptor ?? undefined,
                skillDirectories: this._loadedSkillDirs,
                customAgents: this._loadedAgents,
                mcpServers: this._loadedMcpServers,
                agentMcpServers: this._agentMcpServers,
                baseMcpServers: this._baseMcpServers,
                agentDisabledSkills: this._agentDisabledSkills,
                agentAllowedSkills: this._agentAllowedSkills,
                agentToolPolicy: this._agentToolPolicy,
                toolGroupMembers: this._buildToolGroupMembers(),
                skillRequiredTools: this._buildSkillRequiredTools(),
                provider: options.provider,
                modelProviders: this._modelProviders ?? undefined,
                turnTimeoutMs: options.turnTimeoutMs,
                turnInactivityTimeoutMs: options.turnInactivityTimeoutMs,
            },
            effectiveSessionStateDir,
        );

        // Poll for model_providers.json changes (30s, unref'd so it never
        // holds the process open). On reload, swap the worker's registry AND
        // the SessionManager's — new sessions and per-turn model resolution
        // pick up the fresh catalog immediately.
        if (this._modelProvidersReloader?.path) {
            this._modelProvidersReloadTimer = setInterval(() => {
                if (this._modelProvidersReloader!.checkAndReload()) {
                    this._modelProviders = this._modelProvidersReloader!.current;
                    this.sessionManager.setModelProviders(this._modelProviders);
                    console.log(
                        `[PilotSwarmWorker] model providers reloaded from ${this._modelProvidersReloader!.path} ` +
                        `(${this._modelProviders?.allModels.length ?? 0} models)`,
                    );
                }
            }, 30_000);
            this._modelProvidersReloadTimer.unref?.();
        }
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
    get catalog(): SessionCatalog | null {
        return this._catalog;
    }

    /** Loaded skill directories. */
    get loadedSkillDirs(): string[] {
        return this._loadedSkillDirs;
    }

    /**
     * Loaded agent configs. Entries may carry `mcpServers` — the agent's
     * RESOLVED server map, which can contain expanded credentials
     * (env-substituted headers). Never serialize these entries wholesale to
     * client-facing surfaces.
     */
    get loadedAgents(): Array<{ name: string; description?: string; prompt: string; tools?: string[] | null; skills?: string[]; mcpServers?: Record<string, any>; namespace?: string }> {
        return this._loadedAgents;
    }

    /** Loaded MCP server configs (the deployment catalog). */
    get loadedMcpServers(): Record<string, any> {
        return this._loadedMcpServers;
    }

    /** Resolved per-agent MCP server maps, keyed by agent name. */
    get agentMcpServers(): Record<string, Record<string, any>> {
        return this._agentMcpServers;
    }

    /** Resolved base MCP map applied to every session (base-agent opt-ins + direct config). */
    get baseMcpServers(): Record<string, any> {
        return this._baseMcpServers;
    }

    /** Names of catalog servers in the deployment default MCP set (`"default": true`). */
    get defaultMcpServerNames(): string[] {
        return this._defaultMcpServerNames;
    }

    /** Per-agent DISABLED skill names (catalog − allowedSkills), keyed by agent name. */
    get agentDisabledSkills(): Record<string, string[]> {
        return this._agentDisabledSkills;
    }

    /** Per-agent allowedSkills restriction as declared, keyed by agent name. */
    get agentAllowedSkills(): Record<string, string[]> {
        return this._agentAllowedSkills;
    }

    /** Per-agent tool policies, keyed by agent name. */
    get agentToolPolicy(): Record<string, { allow?: string[]; deny?: string[] }> {
        return this._agentToolPolicy;
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

        const trace = this.config.traceWriter ?? (() => {});
        const store = this.config.store;
        const storage = resolveStorageConfig({ options: this.config });
        const runtimeStorageProvider = getRuntimeStorageProvider(storage.runtime.provider);
        const orchestrationConcurrency = parsePositiveInt(process.env.PILOTSWARM_ORCHESTRATION_CONCURRENCY)
            ?? DEFAULT_ORCHESTRATION_CONCURRENCY;
        const workerConcurrency = parsePositiveInt(process.env.PILOTSWARM_WORKER_CONCURRENCY)
            ?? DEFAULT_WORKER_CONCURRENCY;
        const cmsPoolMax = parsePositiveInt(process.env.PILOTSWARM_CMS_PG_POOL_MAX)
            ?? PgSessionCatalog.DEFAULT_POOL_MAX;
        const factsPoolMax = parsePositiveInt(process.env.PILOTSWARM_FACTS_PG_POOL_MAX)
            ?? PgFactStore.DEFAULT_POOL_MAX;

        if ((store.startsWith("postgres://") || store.startsWith("postgresql://")) && !parsePositiveInt(process.env.DUROXIDE_PG_POOL_MAX)) {
            process.env.DUROXIDE_PG_POOL_MAX = String(DEFAULT_DUROXIDE_PG_POOL_MAX);
        }

        this._provider = await this._createProvider(storage);

        // Initialize CMS catalog and facts store.
        // CMS + facts can use a separate URL when running with AAD/MI
        // (passwordless URL whose `user@` segment is the federated UAMI's
        // display name). Defaults to `store` for the legacy
        // connection-string path. The duroxide orchestration store
        // (created above in `_createProvider`) honours the same MI
        // switch via duroxide-node's native Entra path; CMS/facts go
        // through the pg-pool factory using `DefaultAzureCredential`.
        // Retry, then fail the boot. A worker that silently continues without
        // CMS never registers the catalog-gated tools (sweeper maintenance,
        // resource manager) for its entire lifetime — system agents hydrating
        // on such a pod run tool-less and report blocked cycles. Transient PG
        // unavailability during rollouts is exactly when workers boot, so
        // retry briefly; if CMS still isn't reachable, crash and let the
        // orchestrator restart the pod into a healthy state.
        {
            const attempts = 5;
            let lastErr: unknown;
            for (let attempt = 1; attempt <= attempts; attempt += 1) {
                try {
                    this._catalog = await runtimeStorageProvider.createSessionCatalog(storage.runtime);
                    await this._catalog.initialize();
                    lastErr = null;
                    break;
                } catch (err) {
                    lastErr = err;
                    this._catalog = null;
                    const delayMs = Math.min(15_000, 1_000 * 2 ** (attempt - 1));
                    console.error(`[PilotSwarmWorker] CMS initialization failed (attempt ${attempt}/${attempts}), retrying in ${delayMs}ms:`, err);
                    if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, delayMs));
                }
            }
            if (lastErr) {
                throw new Error(`CMS initialization failed after ${attempts} attempts — refusing to run a degraded worker without catalog-gated tools: ${String((lastErr as Error)?.message ?? lastErr)}`);
            }
        }
        // ── Facts store: base PgFactStore (default) or an EnhancedFactStore
        //    provider (enhancedfactstore 07 P3). Shared resolver keeps the
        //    worker/client/management in lockstep.
        this.factStore = await runtimeStorageProvider.createFactStore(storage.runtime);
        await this.factStore.initialize();
        const enhancedFactStore = runtimeStorageProvider.getEnhancedFactStore?.(this.factStore)
            ?? (isEnhancedFactStore(this.factStore) ? this.factStore : undefined);

        // ── Durable embedder lifecycle (enhancedfactstore 07 P5) ────────────
        //   When horizonEmbed is configured AND the store is an enhanced store
        //   that was provisioned for embedding, ensure the single eternal in-DB
        //   embed loop is running. The provider already configures + starts it
        //   idempotently inside initialize() (advisory-locked → one loop per
        //   schema across all workers); here the worker OBSERVES that state and
        //   ENSURES recovery if the loop is somehow not running, logging the
        //   outcome for operators. This is lifecycle control only — the loop
        //   itself runs inside HorizonDB (pg_durable), never inline in
        //   orchestration (determinism boundary).
        //
        //   It is INTENTIONAL that worker shutdown does NOT stop the loop (see
        //   stop()): the loop is a SHARED durable resource. Stopping it on one
        //   worker's shutdown would halt embedding for the whole fleet, and a
        //   rolling restart would leave it stopped. It is started idempotently
        //   and only ever stopped by an explicit operator action.
        if (storage.runtime.embedding && enhancedFactStore?.capabilities.embedder) {
            try {
            let st = await enhancedFactStore.embedderStatus();
                if (!st.running) {
                    // Recovery: the provider's boot start did not take (or a
                    // prior loop was stopped). startEmbedder is idempotent +
                    // advisory-locked, so this converges on exactly one loop.
                    st = await enhancedFactStore.startEmbedder();
                }
                trace(`[worker] durable embedder: running=${st.running}${st.instanceId ? `, instance=${st.instanceId}` : ""}`);
            } catch (err) {
                // Non-fatal: without the embedder, semantic/hybrid search simply
                // degrades to lexical (provider hybrid-degrade). Do not take the
                // worker down over an embedder hiccup.
                console.error("[PilotSwarmWorker] durable embedder start/verify failed (semantic search degraded to lexical):", err);
            }
        }

        // ── Graph store: SEPARATE, opt-in provider (07 D2). Present iff
        //    graphDatabaseUrl is configured. Never selected implicitly.
        if (storage.runtime.graph?.enabled) {
            let candidate: GraphStore | undefined;
            try {
                candidate = await runtimeStorageProvider.createGraphStore?.(storage.runtime);
                if (candidate) await candidate.initialize();
                this.graphStore = candidate ?? null;
            } catch (err) {
                // A failed graph init disables graph tools without taking down
                // facts — graph is optional and isolated. Close the half-open
                // pool the provider opened before initialize() threw.
                await candidate?.close().catch(() => {});
                this.graphStore = null;
                console.error("[PilotSwarmWorker] graph store initialization failed (graph tools disabled):", err);
            }
        }

        trace(
            `[worker] runtime storage provider=${storage.runtime.provider}, enhancedFacts=${enhancedFactStore ? "on" : "off"}, graph=${this.graphStore ? "on" : "off"}; ` +
            `postgres pools: duroxidePgPoolMax=${process.env.DUROXIDE_PG_POOL_MAX ?? "(unset)"}, ` +
            `cmsPoolMax=${cmsPoolMax}, factsPoolMax=${factsPoolMax}`,
        );
        this.sessionManager.setFactStore(this.factStore);
        this.sessionManager.setGraphStore(this.graphStore);
        if (this._catalog) {
            this.sessionManager.setSessionCatalog(this._catalog);
            this.sessionManager.setLineageSessionLookup(async (sessionId) => (
                resolveSpawnTreeSessionIds(sessionId, this._catalog!)
            ));
        }

        // Inspect tools (e.g. agent-tuner read tools) need a duroxide client
        // for orchestration stats and execution-history reads. Use a dedicated
        // client; tuner tools are read-only.
        const inspectClient = new Client(this._provider);
        this.sessionManager.setDuroxideClient(inspectClient);

        const runtimeOptions = {
            orchestrationConcurrency,
            workerConcurrency,
            dispatcherPollIntervalMs: 10,
            workerLockTimeoutMs: this.config.workerLockTimeoutMs
                ?? parsePositiveInt(process.env.PILOTSWARM_WORKER_LOCK_TIMEOUT_MS)
                ?? 10_000,
            logLevel: this.config.logLevel ?? "error",
            maxSessionsPerRuntime: this.config.maxSessionsPerRuntime ?? 50,
            sessionIdleTimeoutMs: this.config.sessionIdleTimeoutMs ?? 3_600_000,
            workerNodeId: this.config.workerNodeId,
        };

        this.runtime = new Runtime(this._provider, runtimeOptions);
        trace(
            `[worker] runtime options: orchestrationConcurrency=${runtimeOptions.orchestrationConcurrency}, ` +
            `workerConcurrency=${runtimeOptions.workerConcurrency}, ` +
            `dispatcherPollIntervalMs=${runtimeOptions.dispatcherPollIntervalMs}, ` +
            `workerLockTimeoutMs=${runtimeOptions.workerLockTimeoutMs}, ` +
            `maxSessionsPerRuntime=${runtimeOptions.maxSessionsPerRuntime}, ` +
            `sessionIdleTimeoutMs=${runtimeOptions.sessionIdleTimeoutMs}, ` +
            `workerNodeId=${runtimeOptions.workerNodeId ?? "(unset)"}`,
        );
        if (!runtimeOptions.workerNodeId) {
            // Without a stable process-level session identity, duroxide
            // serializes same-session activities, so the stop-turn fast path
            // (same-affinity abortTurn) cannot run concurrently with an
            // in-flight runTurn. Stop still works via dropped-future
            // cancellation, just slower (~lock-renewal interval + poll).
            console.warn(
                "[PilotSwarmWorker] workerNodeId is not set: stop-turn will rely on the slow " +
                "cancellation backstop (~2-7s) instead of the fast same-affinity interrupt. " +
                "Set workerNodeId (e.g. POD_NAME or hostname) for mid-flight stop responsiveness.",
            );
        }

        registerActivities(
            this.runtime,
            this.sessionManager,
            this.sessionStore,
            this.config.githubToken,
            this._catalog,
            this._provider,
            storage.duroxide.url,
            storage.runtime.cmsSchema,
            {
                storageConfig: storage,
                duroxideSchema: storage.duroxide.schema,
                factsSchema: storage.runtime.factsSchema,
                cmsFactsDatabaseUrl: storage.runtime.sessionCatalogUrl ?? storage.runtime.url,
                enhancedFactsDatabaseUrl: storage.runtime.factStoreUrl,
                factsProvider: storage.runtime.provider === "horizondb" ? "horizon" : "pg",
                enhancedFactsSchema: storage.runtime.provider === "horizondb" ? storage.runtime.factsSchema : undefined,
                useManagedIdentity: storage.runtime.useManagedIdentity,
                aadDbUser: storage.runtime.aadDbUser,
            },
            this._loadedSystemAgents,
            this._sessionPolicy,
            this.allowedAgentNames,
            this._rawLoadedAgents,
            this.factStore,
            this.config.workerNodeId,
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
                factStore: this.factStore,
                duroxideSchema: storage.duroxide.schema,
                storeUrl: storage.duroxide.url,
            });
            this.registerTools(sweeperTools);
        }

        // Auto-register artifact tools (blob storage or local filesystem)
        if (this.artifactStore) {
            const artifactTools = createArtifactTools({ blobStore: this.artifactStore });
            this.registerTools(artifactTools);
        }

        // Auto-register resource manager tools
        if (this._catalog) {
            const rmClient = new Client(this._provider);
            const rmTools = createResourceManagerTools({
                catalog: this._catalog,
                duroxideClient: rmClient,
                blobStore: this.blobStore,
                duroxideSchema: storage.duroxide.schema,
                cmsSchema: storage.runtime.cmsSchema,
            });
            this.registerTools(rmTools);
        }

        // ps_list_agents tool — exposes user-creatable agents by default.
        // NOTE: prefixed with `ps_` to avoid collision with the Copilot SDK's
        // built-in `list_agents` tool (introduced in @github/copilot 1.0.32),
        // which lists live background-agent task instances rather than blueprints.
        const listAgentsTool = defineTool("ps_list_agents", {
            description:
                "List all available agent BLUEPRINTS (definitions loaded from .agent.md files). " +
                "By default this returns only user-creatable named agents. " +
                "Worker-managed system agents are hidden from the default list because they are NOT valid spawn_agent targets. " +
                "Pass systemOnly=true only when you need to inspect system-agent definitions for diagnostics. " +
                "Use this to discover what agents CAN be spawned. To check status of sub-agents you ALREADY spawned, use check_agents instead. " +
                "IMPORTANT: Do NOT call this unless you actually need to spawn an agent and don't know its name. " +
                "Seeing an agent in this list does NOT mean you should spawn it.",
            parameters: {
                type: "object" as const,
                properties: {
                    systemOnly: {
                        type: "boolean",
                        description: "If true, only return system agents. Default: false",
                    },
                    creatableOnly: {
                        type: "boolean",
                        description: "If true, only return user-creatable (non-system) agents. This matches the default behavior.",
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
                        skills: a.skills || [],
                        system: false,
                        creatable: true,
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
                        creatable: false,
                        id: a.id || null,
                        parent: a.parent || null,
                    })),
                ];
                let filtered = allAgents.filter(a => !a.system);
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

        // Autonomous eviction clock (lifecycle protocol §3.4): local session
        // state is a cache. Sessions idle past the hold window + margin are
        // reclaimed locally (committed → delete; legacy → dehydrate) with no
        // orchestration coordination — the next runTurn self-validates.
        const rawEvictMs = Number.parseInt(process.env.PILOTSWARM_SESSION_EVICT_MS || "", 10);
        const evictAfterMs = Number.isFinite(rawEvictMs) ? rawEvictMs : 2_100_000; // 35 min
        if (evictAfterMs > 0 && this.sessionStore) {
            this._evictionTimer = setInterval(() => {
                void this.sessionManager.sweepIdleSessions(evictAfterMs)
                    .then((count) => {
                        if (count > 0) {
                            console.error(`[PilotSwarmWorker] eviction sweep reclaimed ${count} idle session(s)`);
                        }
                    })
                    .catch((err: any) => {
                        console.warn(`[PilotSwarmWorker] eviction sweep failed: ${err?.message ?? err}`);
                    });
            }, Math.min(evictAfterMs, 300_000));
            this._evictionTimer.unref?.();
        }

        await new Promise(r => setTimeout(r, 200));

        // Auto-start system agents defined in plugins (idempotent), but do not
        // block worker.start() on the bootstrap race. The TUI should become
        // interactive even if first-run system-agent startup is slow.
        void this._startSystemAgents().catch((err: any) => {
            console.warn(`[PilotSwarmWorker] background system agent startup failed: ${err?.message ?? err}`);
        });

        // Publish the deployment capability catalog to CMS (idempotent
        // single-row upsert; concurrent workers race benignly). Non-blocking
        // and best-effort: the web runtime treats a missing catalog as
        // "unknown", never as an error.
        if (this._catalog) {
            void this._catalog.setCapabilityCatalog(this.buildCapabilityCatalog(), this.config.workerNodeId ?? null)
                .then((published) => {
                    if (!published) {
                        console.warn("[PilotSwarmWorker] CMS predates migration 0035; capability catalog not published.");
                    }
                })
                .catch((err: any) => {
                    console.warn(`[PilotSwarmWorker] Failed to publish capability catalog: ${err?.message ?? err}`);
                });
        }
    }

    async stop(): Promise<void> {
        if (this._evictionTimer) {
            clearInterval(this._evictionTimer);
            this._evictionTimer = null;
        }
        if (this.runtime) {
            const rawShutdownTimeoutMs = Number.parseInt(
                process.env.PILOTSWARM_WORKER_SHUTDOWN_TIMEOUT_MS || "",
                10,
            );
            const shutdownTimeoutMs = Number.isFinite(rawShutdownTimeoutMs) && rawShutdownTimeoutMs >= 0
                ? rawShutdownTimeoutMs
                : 5000;
            await this.runtime.shutdown(shutdownTimeoutMs);
            this.runtime = null;
        }
        await this.sessionManager.shutdown();
        if (this._catalog) {
            try { await this._catalog.close(); } catch {}
            this._catalog = null;
        }
        if (this.factStore) {
            // NOTE: deliberately NOT calling stopEmbedder() here. The durable
            // embed loop is a SHARED, fleet-wide resource (one per schema inside
            // HorizonDB via pg_durable); stopping it on a single worker's
            // shutdown would halt embedding for every other worker and survive a
            // rolling restart as a stopped loop. It is started idempotently on
            // boot and only ever stopped by an explicit operator action.
            try { await this.factStore.close(); } catch {}
            this.factStore = null;
        }
        if (this.graphStore) {
            try { await this.graphStore.close(); } catch {}
            this.graphStore = null;
        }
        this._provider = null;
        this._started = false;
    }

    /**
     * Graceful drain (lifecycle protocol §3.8):
     *   1. Stop fetching — duroxide's shutdown flag makes dispatch slots
     *      finish their in-flight item and claim nothing new.
     *   2. Finish in-flight — running turns complete within the drain
     *      budget; their snapshot commits land inside the runTurn activity.
     *      (duroxide sleeps the FULL budget before returning; turns longer
     *      than the budget are aborted — crash semantics, lossless for
     *      every committed turn.)
     *   3. Evict all — purely local for sessions with a committed marker
     *      (the store already holds their state); legacy dehydrate for
     *      unmarked sessions whose local files may be the only copy.
     *   4. Exit — anything still leased lapses within the duroxide session
     *      lock timeout.
     */
    async gracefulShutdown(): Promise<void> {
        const rawDrainMs = Number.parseInt(process.env.PILOTSWARM_WORKER_SHUTDOWN_TIMEOUT_MS || "", 10);
        const drainBudgetMs = Number.isFinite(rawDrainMs) && rawDrainMs >= 0 ? rawDrainMs : 60_000;

        if (this.runtime) {
            console.error(`[PilotSwarmWorker] draining: waiting up to ${drainBudgetMs}ms for in-flight turns...`);
            await this.runtime.shutdown(drainBudgetMs);
            this.runtime = null;
        }

        // Release everything this worker served, via the same lock-aware
        // sweep the eviction clock uses: committed sessions are deleted
        // locally (the store holds their state), unmarked legacy sessions
        // dehydrate (with the versioned-snapshot fence), and sessions whose
        // aborted turns still hold their run-turn lock are SKIPPED — their
        // dirs must not be deleted or archived out from under a still-
        // running body; the post-deploy retry self-validates instead.
        if (this.sessionStore) {
            try {
                const released = await this.sessionManager.sweepIdleSessions(1);
                console.error(`[PilotSwarmWorker] drain released ${released} warm session(s)`);
            } catch (err: any) {
                console.warn(`[PilotSwarmWorker] drain release sweep failed: ${err?.message ?? err}`);
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
    * Tiered loading order:
     *   1. system/  — SDK core (always loaded: base system prompt, durable-timers, sub-agents)
     *   2. mgmt/    — SDK management agents (loaded unless disableManagementAgents is true)
    *   3. default-agents/ — optional SDK user agents, read into a separate registry
    *   4. app      — Consumer-provided plugin dirs (from pluginDirs option)
    *   5. direct   — Inline config (skillDirectories, customAgents, mcpServers options)
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

        // ── Tier 3: SDK bundled default agents (policy opt-in) ───────
        const defaultAgentsDir = path.join(sdkPluginsDir, "default-agents");
        this._loadBundledDefaultAgents(defaultAgentsDir);

        // ── Tier 4: App plugins (from pluginDirs option) ─────────────
        const pluginDirs = this.config.pluginDirs ?? [];
        for (const pluginDir of pluginDirs) {
            const absDir = path.resolve(pluginDir);
            if (!fs.existsSync(absDir)) {
                console.warn(`[PilotSwarmWorker] Plugin dir not found: ${absDir}`);
                continue;
            }
            this._loadPluginDir(absDir, "app");
        }

        this._mergeOptedBundledAgents();

        // ── Tier 5: Direct config (inline options override all) ──────
        if (this.config.skillDirectories?.length) {
            for (const skillsDir of this.config.skillDirectories) {
                this._loadedSkillDirs.push(skillsDir);
                for (const skill of loadSkillsSync(skillsDir)) this._loadedSkills.set(skill.name, skill);
            }
        }
        if (this.config.customAgents?.length) {
            for (const agent of this.config.customAgents) {
                this._rawLoadedAgents.push({ ...agent, promptLayerKind: "app-agent" });
                const descriptor = this._buildLayerDescriptor(agent as any, "app", "inline");
                this._agentPromptLookup[agent.name] = {
                    prompt: agent.prompt,
                    kind: "app-agent",
                    descriptor,
                };
            }
        }
        if (this.config.mcpServers) {
            Object.assign(this._loadedMcpServers, this.config.mcpServers);
            // Direct worker-config servers keep their documented every-session
            // semantics (legacy): they join the catalog AND the base map.
            this._directConfigMcpNames = Object.keys(this.config.mcpServers);
        }
        this._appDefaultPrompt = mergePromptSections([
            this._appDefaultPrompt,
            this.config.systemMessage,
        ]) ?? null;
        this._applyDeclaredAgentSkills();
        this._resolveAgentMcpServers();
        this._resolveAgentSkillAndToolRestrictions();
        this._loadedAgents = this._rawLoadedAgents.map((agent) => {
            // Replace the frontmatter's named MCP references with the
            // resolved server map (and drop the inherit flag) so the SDK's
            // CustomAgentConfig.mcpServers receives real server configs.
            // allowedSkills/toolPolicy are worker-side resolution inputs
            // applied at session assembly, not SDK CustomAgentConfig fields.
            const { mcpServers: _refs, inheritDefaultMcpServers: _inherit, allowedSkills: _allowed, toolPolicy: _policy, ...rest } = agent;
            return {
                ...rest,
                prompt: composeSystemPrompt({
                    frameworkBase: this._frameworkBasePrompt,
                    appDefault: this._appDefaultPrompt,
                    activeAgentPrompt: this._agentPromptLookup[agent.name]?.prompt ?? agent.prompt,
                }) ?? agent.prompt,
                ...(this._agentMcpServers[agent.name] ? { mcpServers: this._agentMcpServers[agent.name] } : {}),
            };
        });

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
    /**
     * Build a `PromptLayerDescriptor` from an authored agent config.
     *
     * Source of truth is the .agent.md frontmatter (`schemaVersion`, `version`,
     * `name`, `system`). Missing frontmatter falls back to safe defaults
     * (`schemaVersion=1`, `version="0.0.0"`).
     */
    private _buildLayerDescriptor(
        agent: { name: string; namespace?: string; system?: boolean; schemaVersion?: number; version?: string; sourcePath?: string },
        layer: "system" | "management" | "app",
        namespace: string,
    ): import("./prompt-layers.js").PromptLayerDescriptor {
        const isInline = namespace === "inline";
        const isSystemAuthored = !isInline && (layer === "system" || layer === "management" || Boolean(agent.system));
        const layerKind: import("./prompt-layers.js").PromptLayerKind =
            agent.name === "default"
                ? (layer === "system" ? "pilotswarm_base" : "app_base")
                : "agent";
        const schemaVersion = isInline && agent.schemaVersion === undefined
            ? "inline"
            : agent.schemaVersion === undefined
                ? "legacy"
                : buildSchemaIdentifier(agent.schemaVersion);
        const version = isInline && !agent.version
            ? "inline"
            : (agent.version && agent.version.trim()) || "unversioned";
        const ns = namespace || agent.namespace || "unknown";
        return {
            layerKind,
            layerId: `${ns}:${agent.name}`,
            name: agent.name,
            schemaVersion,
            version,
            type: isSystemAuthored ? "system" : "app",
            ...(agent.sourcePath ? { source: agent.sourcePath } : {}),
        };
    }

    /**
     * Resolve each loaded agent's MCP server references against the merged
     * deployment catalog (capability-profiles Phase 1).
     *
     * The catalog is the union of all plugin `.mcp.json` files (plus direct
     * config). Servers tagged `"default": true` form the deployment default
     * MCP set, granted only to agents with `inheritDefaultMcpServers: true`;
     * the tag is stripped from the config objects afterwards so the Copilot
     * CLI never sees it. Named references that miss the catalog are dropped
     * with a warning. Runs after every plugin dir (and direct config) has
     * merged, so the catalog is complete.
     */
    private _resolveAgentMcpServers(): void {
        const defaults: Record<string, any> = {};
        for (const [name, cfg] of Object.entries(this._loadedMcpServers)) {
            if (!cfg || typeof cfg !== "object") continue;
            if (cfg.default === true) defaults[name] = cfg;
            if ("default" in cfg) delete cfg.default;
        }
        this._defaultMcpServerNames = Object.keys(defaults);

        const resolveRefs = (owner: string, refs: string[] | undefined, into: Record<string, any>) => {
            for (const ref of refs ?? []) {
                if (typeof ref !== "string" || !ref) continue;
                const server = this._loadedMcpServers[ref];
                if (server) {
                    into[ref] = server;
                } else {
                    console.warn(`[PilotSwarmWorker] ${owner}: MCP server "${ref}" is not in the deployment catalog; reference dropped.`);
                }
            }
        };

        // Base map — applied to EVERY session: base (default) agents that
        // opted in, plus direct worker-config servers (their documented
        // every-session semantics predate per-agent resolution).
        const base: Record<string, any> = {};
        if (this._baseAgentMcpDecl.inherit) Object.assign(base, defaults);
        resolveRefs("Base (default) agent", this._baseAgentMcpDecl.refs, base);
        for (const name of this._directConfigMcpNames) {
            if (this._loadedMcpServers[name]) base[name] = this._loadedMcpServers[name];
        }
        this._baseMcpServers = base;
        if (this._directConfigMcpNames.length > 0) {
            console.warn(
                `[PilotSwarmWorker] Direct worker-config mcpServers (${this._directConfigMcpNames.join(", ")}) ` +
                `apply to every session (legacy). Prefer per-agent frontmatter declarations or tagging catalog servers "default": true.`,
            );
        }

        // Per-agent maps. Agents merge by name with later definitions
        // overriding earlier ones (same contract as prompt resolution), so
        // ALWAYS assign: a later definition with no MCP declarations must
        // clear a shadowed definition's grants, never inherit them.
        for (const agent of [...this._rawLoadedAgents, ...this._loadedSystemAgents]) {
            const resolved: Record<string, any> = {};
            if (agent.inheritDefaultMcpServers === true) {
                Object.assign(resolved, defaults);
            }
            resolveRefs(`Agent "${agent.name}"`, agent.mcpServers, resolved);
            if (Object.keys(resolved).length > 0) {
                this._agentMcpServers[agent.name] = resolved;
            } else {
                delete this._agentMcpServers[agent.name];
            }
        }
    }

    /**
     * Resolve each agent's `allowedSkills` / `toolPolicy` restrictions
     * (capability-profiles Phase 2).
     *
     * allowedSkills complements against the loaded skill catalog into the
     * per-agent DISABLED list the CLI consumes (`disabledSkills`); unknown
     * allowed names warn (typo detection) but stay harmless. Agents merge
     * by name with later definitions overriding earlier ones — always
     * assign or delete, mirroring MCP resolution, so a later definition
     * without restrictions clears a shadowed definition's.
     *
     * Base (default) agents cannot carry restrictions in Phase 2 — warn
     * loudly instead of silently dropping (declarations on default agents
     * never reach _rawLoadedAgents).
     */
    private _resolveAgentSkillAndToolRestrictions(): void {
        const catalogSkillNames = [...this._loadedSkills.keys()];

        for (const agent of [...this._rawLoadedAgents, ...this._loadedSystemAgents]) {
            if (agent.allowedSkills !== undefined) {
                const allowed = agent.allowedSkills.filter((name) => typeof name === "string" && name);
                for (const name of allowed) {
                    if (!this._loadedSkills.has(name)) {
                        console.warn(`[PilotSwarmWorker] Agent "${agent.name}": allowedSkills entry "${name}" is not a loaded skill.`);
                    }
                }
                this._agentAllowedSkills[agent.name] = allowed;
                this._agentDisabledSkills[agent.name] = catalogSkillNames.filter((name) => !allowed.includes(name));
            } else {
                delete this._agentAllowedSkills[agent.name];
                delete this._agentDisabledSkills[agent.name];
            }

            const policy = agent.toolPolicy;
            // A bare "*" would make the Copilot SDK's tool-filter validation
            // throw at session creation, bricking every session bound to the
            // agent — drop it with a warning. An explicitly EMPTY allow list
            // is a valid "floor tools only" restriction (kept), matching
            // allowedSkills semantics.
            const scrub = (names: string[] | undefined, side: string): string[] | undefined => {
                if (names === undefined) return undefined;
                const kept = names.filter((n) => n !== "*");
                if (kept.length !== names.length) {
                    console.warn(`[PilotSwarmWorker] Agent "${agent.name}": toolPolicy.${side} entry "*" is not valid (the SDK rejects bare wildcards); entry dropped.`);
                }
                return kept;
            };
            const allow = scrub(policy?.allow, "allow");
            const deny = scrub(policy?.deny, "deny");
            if (policy && (allow !== undefined || deny?.length)) {
                this._agentToolPolicy[agent.name] = {
                    ...(allow !== undefined ? { allow } : {}),
                    ...(deny?.length ? { deny } : {}),
                };
            } else {
                delete this._agentToolPolicy[agent.name];
            }
        }
    }

    /**
     * Build the deployment capability catalog (names and metadata only —
     * never resolved MCP configs, which can carry expanded credentials).
     * Published to CMS at boot so the remote-topology web runtime can serve
     * it on bootstrap; embedded transports may call it directly.
     */
    buildCapabilityCatalog(): CapabilityCatalog {
        const toolGroups = resolveToolGroups((this._sessionPolicy as any)?.toolGroups);
        const toolNames = new Set<string>([
            ...this._frameworkBaseToolNames,
            ...this._appDefaultToolNames,
            ...this.toolRegistry.keys(),
            ...Object.keys(toolGroups),
        ]);
        for (const agent of [...this._rawLoadedAgents, ...this._loadedSystemAgents]) {
            for (const tool of agent.tools ?? []) toolNames.add(tool);
        }

        const agentDefaults: Record<string, CapabilityCatalogAgentDefaults> = {};
        for (const agent of [...this._rawLoadedAgents, ...this._loadedSystemAgents]) {
            agentDefaults[agent.name] = {
                mcpServers: Object.keys(this._agentMcpServers[agent.name] ?? {}),
                skills: this._agentAllowedSkills[agent.name] ?? null,
                tools: [...(agent.tools ?? [])],
                ...(this._agentToolPolicy[agent.name] ? { toolPolicy: this._agentToolPolicy[agent.name] } : {}),
            };
        }

        return {
            mcpServers: Object.keys(this._loadedMcpServers).map((name) => ({
                name,
                isDefault: this._defaultMcpServerNames.includes(name),
            })),
            skills: [...this._loadedSkills.values()].map((skill) => ({
                name: skill.name,
                ...(skill.description ? { description: skill.description } : {}),
                ...(skill.toolNames?.length ? { requiredTools: [...skill.toolNames] } : {}),
            })),
            tools: [...toolNames].sort().map((name) => ({
                name,
                ...(toolGroups[name] ? { group: toolGroups[name] } : {}),
                // LOCKED base tools: the durable-session protocol floor.
                // Non-removable and enforced un-excludable at assembly.
                ...(PROTOCOL_FLOOR_TOOLS.includes(name as any) ? { locked: true } : {}),
            })),
            agentDefaults,
        };
    }

    /** Skill name → the tools it requires (from tools.json), for override resolution. */
    private _buildSkillRequiredTools(): Record<string, string[]> {
        const map: Record<string, string[]> = {};
        for (const skill of this._loadedSkills.values()) {
            if (skill.toolNames?.length) map[skill.name] = [...skill.toolNames];
        }
        return map;
    }

    /** Invert the tool-group lookup into group → member names (for override expansion). */
    private _buildToolGroupMembers(): Record<string, string[]> {
        const toolGroups = resolveToolGroups((this._sessionPolicy as any)?.toolGroups);
        const members: Record<string, string[]> = {};
        for (const [name, group] of Object.entries(toolGroups)) {
            (members[group] ??= []).push(name);
        }
        return members;
    }

    private _applyDeclaredAgentSkills(): void {
        const skills = [...this._loadedSkills.values()];
        for (const agent of [...this._rawLoadedAgents, ...this._loadedSystemAgents]) {
            if (!agent.skills?.length) continue;
            const composed = composeDeclaredSkillsPrompt(agent.prompt, agent.skills, skills);
            const existing = this._agentPromptLookup[agent.name];
            if (existing) existing.prompt = composed.prompt;
            for (const missing of composed.missing) {
                console.warn(`[PilotSwarmWorker] Agent ${agent.name} declares missing skill ${JSON.stringify(missing)}; available skill directories did not provide it.`);
            }
        }
    }

    private _loadBundledDefaultAgents(absDir: string): void {
        if (!fs.existsSync(absDir)) return;
        const agentsDir = path.join(absDir, "agents");
        if (!fs.existsSync(agentsDir)) return;

        for (const agent of loadAgentFiles(agentsDir)) {
            if (agent.name === "default" || agent.system) {
                console.warn(`[PilotSwarmWorker] Ignoring bundled default agent ${agent.name}: optional bundled agents must be user-creatable named agents.`);
                continue;
            }
            agent.namespace = "pilotswarm";
            agent.promptLayerKind = "app-agent";
            const key = normalizeAgentIdentity(agent.name);
            if (!key) continue;
            this._availableBundledAgents.set(key, agent);
        }
    }

    private _mergeOptedBundledAgents(): void {
        const requested = this._sessionPolicy?.creation?.bundledAgents ?? [];
        const appAgentKeys = new Set([
            ...this._rawLoadedAgents.map((agent) => normalizeAgentIdentity(agent.name)),
            ...(this.config.customAgents ?? []).map((agent) => normalizeAgentIdentity(agent.name)),
        ]);
        if (requested.length === 0) {
            const defaultAgent = this._sessionPolicy?.creation?.defaultAgent;
            const defaultKey = normalizeAgentIdentity(defaultAgent);
            if (defaultKey && this._availableBundledAgents.has(defaultKey) && !appAgentKeys.has(defaultKey)) {
                throw new Error(`[PilotSwarmWorker] session-policy.json creation.defaultAgent=${JSON.stringify(defaultAgent)} references a bundled default agent but creation.bundledAgents does not opt it in.`);
            }
            return;
        }

        const requestedKeys = new Set<string>();
        for (const name of requested) {
            const key = normalizeAgentIdentity(name);
            if (!key || !this._availableBundledAgents.has(key)) {
                throw new Error(`[PilotSwarmWorker] session-policy.json creation.bundledAgents contains unknown bundled agent ${JSON.stringify(name)}.`);
            }
            requestedKeys.add(key);
        }

        const defaultAgent = this._sessionPolicy?.creation?.defaultAgent;
        const defaultKey = normalizeAgentIdentity(defaultAgent);
        if (defaultKey && this._availableBundledAgents.has(defaultKey) && !requestedKeys.has(defaultKey) && !appAgentKeys.has(defaultKey)) {
            throw new Error(`[PilotSwarmWorker] session-policy.json creation.defaultAgent=${JSON.stringify(defaultAgent)} references a bundled default agent but creation.bundledAgents does not opt it in.`);
        }

        for (const key of requestedKeys) {
            if (appAgentKeys.has(key)) continue;
            const agent = this._availableBundledAgents.get(key)!;
            const descriptor = this._buildLayerDescriptor(agent, "app", agent.namespace || "pilotswarm");
            this._agentPromptLookup[agent.name] = {
                prompt: agent.prompt,
                kind: "app-agent",
                descriptor,
            };
            this._rawLoadedAgents.push(agent);
            appAgentKeys.add(key);
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
            for (const skill of loadSkillsSync(skillsDir)) this._loadedSkills.set(skill.name, skill);
        }

        // Agents — tag each with namespace
        const agentsDir = path.join(absDir, "agents");
        if (fs.existsSync(agentsDir)) {
            const agents = loadAgentFiles(agentsDir);
            for (const agent of agents) {
                agent.namespace = namespace;
                const descriptor = this._buildLayerDescriptor(agent, layer, namespace);
                if (agent.name === "default") {
                    if (layer === "system") {
                        this._frameworkBasePrompt = agent.prompt;
                        this._frameworkBaseToolNames = agent.tools ?? [];
                        this._frameworkBaseDescriptor = descriptor;
                    } else if (layer === "app") {
                        this._appDefaultPrompt = agent.prompt;
                        this._appDefaultToolNames = agent.tools ?? [];
                        this._appDefaultDescriptor = descriptor;
                    }
                    // Base (default) agents may opt sessions into MCP: their
                    // declarations resolve into the base map applied to
                    // every session (the pilotswarm base agent declares
                    // none, so this is inert unless an app opts in).
                    if (agent.mcpServers?.length) {
                        this._baseAgentMcpDecl.refs.push(...agent.mcpServers);
                    }
                    if (agent.inheritDefaultMcpServers === true) {
                        this._baseAgentMcpDecl.inherit = true;
                    }
                    // Skill/tool RESTRICTIONS on base agents are not
                    // supported in Phase 2 — warn instead of silently
                    // dropping the declaration.
                    if (agent.allowedSkills !== undefined || agent.toolPolicy !== undefined) {
                        console.warn(`[PilotSwarmWorker] ${layer} default agent: allowedSkills/toolPolicy on base agents is not supported; declaration ignored. Declare restrictions on named agents.`);
                    }
                } else if (agent.system) {
                    agent.promptLayerKind = layer === "management" ? "pilotswarm-system-agent" : "app-system-agent";
                    this._agentPromptLookup[agent.name] = {
                        prompt: agent.prompt,
                        kind: agent.promptLayerKind,
                        descriptor,
                    };
                    this._loadedSystemAgents.push(agent);
                } else {
                    agent.promptLayerKind = "app-agent";
                    this._agentPromptLookup[agent.name] = {
                        prompt: agent.prompt,
                        kind: "app-agent",
                        descriptor,
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
     *
     * All system agents, including permanent children such as sweeper/resource
     * manager/facts manager, are bootstrapped directly by the worker. They are
     * not LLM-spawned via spawn_agent(agent_name=...).
     */
    private async _startSystemAgents(): Promise<void> {
        if (!this._catalog) return; // No CMS = no system agents
        if (this._loadedSystemAgents.length === 0) return;

        const duroxideClient = new Client(this._provider);
        const defaultModel = this._modelProviders?.defaultModel;
        if (!defaultModel) {
            throw new Error(
                "System agents require a configured defaultModel in model_providers.json. " +
                "Implicit fallback model selection is disabled.",
            );
        }
        await startSystemAgents({
            catalog: this._catalog,
            duroxideClient,
            agents: this._loadedSystemAgents,
            defaultModel,
            blobEnabled: this.blobEnabled,
            dehydrateThreshold: this.config.waitThreshold,
            log: (message) => console.error(message),
            warn: (message) => console.warn(message),
        });
    }

    private async _createProvider(storage: StorageConfig): Promise<any> {
        const store = this.config.store;
        if (store === "sqlite::memory:") return SqliteProvider.inMemory();
        if (store.startsWith("sqlite://")) return SqliteProvider.open(store);
        if (storage.duroxide.url.startsWith("postgres://") || storage.duroxide.url.startsWith("postgresql://")) {
            return getDuroxideStorageProvider(storage.duroxide.provider).createDuroxideProvider(storage.duroxide);
        }
        throw new Error(`Unsupported duroxide store URL: ${storage.duroxide.url}`);
    }
}
