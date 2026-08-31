import { SessionManager, packageAgentKey, agentOwnerKey } from "./session-manager.js";
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
import { clipDescription, composeDeclaredSkillsPrompt, loadSkillsSync, type Skill } from "./skills.js";
import { resolveSystemAgentSessionPlans, startSystemAgents } from "./system-agents.js";
import { firstRuntimeModel } from "./provider-catalog.js";
import { loadMcpConfig, mcpAllowlistAdmits, type McpAllowlistAgent } from "./mcp-loader.js";

import { createModelProvidersReloader, type ModelProviderRegistry } from "./model-providers.js";
import { createArtifactTools } from "./artifact-tools.js";
import { createDistillerTools } from "./distiller-tools.js";
import { isEnhancedFactStore, PgFactStore, type FactStore } from "./facts-store.js";
import type { GraphStore } from "./graph-store.js";
import { resolveStorageConfig, type StorageConfig } from "./storage-config.js";
import { getDuroxideStorageProvider, getRuntimeStorageProvider } from "./storage-providers.js";
import { createSweeperTools } from "./sweeper-tools.js";
import { createResourceManagerTools } from "./resourcemgr-tools.js";
import { composeSystemPrompt, mergePromptSections } from "./prompt-layering.js";
import { buildSchemaIdentifier } from "./prompt-layers.js";
import { DEFAULT_TURN_TIMEOUT_MS } from "./managed-session.js";
import { defineTool } from "@github/copilot-sdk";
import type { Tool } from "@github/copilot-sdk";
import type { PilotSwarmWorkerOptions, ManagedSessionConfig } from "./types.js";
import type { AgentConfig } from "./agent-loader.js";
import { installAgentPackages, loadAgentPackageTools } from "./agent-package-installer.js";
import fs from "node:fs";
import os from "node:os";
import { monitorEventLoopDelay, type IntervalHistogram } from "node:perf_hooks";
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

function parseNonNegativeInt(raw: unknown): number | undefined {
    const normalized = typeof raw === "string" ? Number.parseInt(raw, 10) : Number(raw);
    if (!Number.isFinite(normalized) || normalized < 0) return undefined;
    return Math.floor(normalized);
}

/** @internal Resolve the worker-wide turn cap: explicit option > deployment env > SDK default. */
export function resolveWorkerTurnTimeoutMs(
    explicitValue: unknown,
    envValue: unknown = process.env.PILOTSWARM_TURN_TIMEOUT_MS,
): number {
    if (explicitValue !== undefined) {
        return parseNonNegativeInt(explicitValue) ?? DEFAULT_TURN_TIMEOUT_MS;
    }
    return parseNonNegativeInt(envValue) ?? DEFAULT_TURN_TIMEOUT_MS;
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
    /** Every loaded skill with provenance intact — the name-keyed map above collapses duplicates. */
    private _loadedSkillsAll: Skill[] = [];
    /** Skills `load_skill` may return: everything but user-scope package skills. Refilled in place. */
    private _loadableSkills: Skill[] = [];
    /**
     * A user-scope package's skills, keyed by its owner (`agentOwnerKey`).
     * They are private, so they are NOT in the fleet-wide `_loadableSkills`
     * catalog — but a session OWNED BY that person may load them, exactly as
     * it may already use the private agents from the same package. Held by
     * reference in workerDefaults; cleared and refilled in place on reload.
     */
    private _ownerScopedSkills = new Map<string, Skill[]>();
    /** Raw loaded user-creatable agent configs from plugins + direct config. */
    private _rawLoadedAgents: Array<{ name: string; description?: string; prompt: string; tools?: string[] | null; skills?: string[]; mcpServers?: string[]; inheritDefaultMcpServers?: boolean; namespace?: string; crawler?: boolean; harvester?: boolean; promptLayerKind?: "app-agent" | "app-system-agent" | "pilotswarm-system-agent" }> = [];
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
    /**
     * Catalog servers restricted with `allowedAgents`: server name → the agent
     * identities allowed to reference it. Filled by `_resolveAgentMcpServers`,
     * which also strips the field from the catalog configs.
     */
    private _mcpAllowedAgents = new Map<string, Set<string>>();
    /**
     * Server names defined by the DEPLOYMENT (plugin dirs + direct config),
     * as opposed to installed packages. A package may not redefine one: the
     * catalog is flat, so it would swap the server every agent talks to.
     * Cleared in place on reload; held by reference in workerDefaults.
     */
    private _deploymentMcpNames = new Set<string>();
    /** MCP declarations gathered from base (default) agents — resolved into the base map. */
    private _baseAgentMcpDecl: { refs: string[]; inherit: boolean } = { refs: [], inherit: false };
    /** Server names from direct worker-config `mcpServers` — legacy every-session semantics. */
    private _directConfigMcpNames: string[] = [];
    /** Resolved base MCP map applied to EVERY session (base-agent opt-ins + direct config). */
    private _baseMcpServers: Record<string, any> = {};
    /** Model provider registry — multi-provider LLM config. */
    private _modelProviders: ModelProviderRegistry | null = null;
    /** Provider-type templates, including types with no static credential. */
    private _modelProviderTypes: ModelProviderRegistry | null = null;
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
    /**
     * Live allowed-agent-names array. registerActivities captures this exact
     * array once at start(); refreshAgentPackages mutates it IN PLACE so the
     * activity layer never sees a stale copy. Never reassign it.
     */
    private _allowedAgentNamesLive: string[] = [];
    /** Constructor-time pluginDirs snapshot — package dirs are appended per refresh. */
    private _basePluginDirs: string[] = [];
    /**
     * Installed-package dir → owning scope/owner, for agents loaded from
     * agent packages. Empty for plugin dirs the deployment configured itself.
     */
    private _packageDirOwners = new Map<string, { packageId: string; scope: "shared" | "user"; owner: { provider: string; subject: string } | null }>();
    /** Agent-package dynamic install state (docs/proposals/agent-packages.md). */
    private _agentPackagesCacheDir: string | null = null;
    private _agentPackagesRefreshMs = 20_000;
    private _agentPackagesEpoch = -1;
    private _agentPackagesTimer: ReturnType<typeof setInterval> | null = null;
    private _agentPackagesRefreshing = false;
    /** Tools contributed by installed packages, merged under static tools. */
    private _agentPackageTools = new Map<string, Tool<any>>();
    /** Per-package tool maps — lets a session prefer ITS package's handler on a name collision. */
    private _agentPackageToolsByPackage = new Map<string, Map<string, Tool<any>>>();
    /** Last install report — carried in the registry heartbeat's state. */
    private _agentPackagesInstalled: Record<string, { semver: string; sha256: string; status: string; error?: string }> = {};
    /** Worker-registry lifecycle phase (docs/proposals/worker-registry.md). */
    private _workerPhase: "starting" | "ready" | "draining" = "starting";
    /** Write-once registration info; built on the first heartbeat. */
    private _registrarInfo: Record<string, unknown> | null = null;
    /** Event-loop delay histogram for health reporting (reset each beat). */
    private _eventLoopHist: IntervalHistogram | null = null;
    /** Last refresh failure — carried in heartbeat state until a clean pass. */
    private _agentPackagesRefreshError: string | null = null;

    constructor(options: PilotSwarmWorkerOptions) {
        this.config = {
            ...options,
            waitThreshold: options.waitThreshold ?? 30,
            turnTimeoutMs: resolveWorkerTurnTimeoutMs(options.turnTimeoutMs),
        };
        const effectiveSessionStateDir = options.sessionStateDir ?? DEFAULT_SESSION_STATE_DIR;

        // Agent packages: resolve the cache dir up front; installation itself
        // runs in start() (needs the CMS catalog) and on every epoch refresh.
        this._basePluginDirs = [...(options.pluginDirs ?? [])];
        if (options.agentPackages) {
            this._eventLoopHist = monitorEventLoopDelay({ resolution: 20 });
            this._eventLoopHist.enable();
            this._agentPackagesCacheDir = options.agentPackages.cacheDir
                ?? path.join(path.dirname(effectiveSessionStateDir), "agent-packages");
            const rawRefresh = options.agentPackages.refreshIntervalMs;
            this._agentPackagesRefreshMs = Number.isFinite(rawRefresh as number) ? Number(rawRefresh) : 20_000;
        }

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
        this._modelProviderTypes = this._modelProvidersReloader.types;

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
                // The `load_skill` catalog, BY REFERENCE (cleared and refilled
                // in place on reload): deployment + shared-package skills.
                skills: this._loadableSkills,
                // Private, per-owner skills, also by reference. A session
                // gets the ones its OWNER published, and nobody else's — see
                // SessionManager._skillCatalogForSession (what load_skill
                // will serve) and _ownerSkillsIndexSection (what its prompt
                // says exists).
                ownerScopedSkills: this._ownerScopedSkills,
                mcpServers: this._loadedMcpServers,
                agentMcpServers: this._agentMcpServers,
                baseMcpServers: this._baseMcpServers,
                mcpAllowedAgents: this._mcpAllowedAgents,
                deploymentMcpNames: this._deploymentMcpNames,
                provider: options.provider,
                modelProviders: this._modelProviders ?? undefined,
                turnTimeoutMs: this.config.turnTimeoutMs,
                turnInactivityTimeoutMs: options.turnInactivityTimeoutMs,
            },
            effectiveSessionStateDir,
        );
        this.sessionManager.setModelProvidersRefresher(() => this._refreshProviderRegistry());

        // Poll for model_providers.json changes (30s, unref'd so it never
        // holds the process open). On reload, swap the worker's registry AND
        // the SessionManager's — new sessions and per-turn model resolution
        // pick up the fresh catalog immediately.
        if (this._modelProvidersReloader?.path || this._modelProviders) {
            this._modelProvidersReloadTimer = setInterval(() => {
                if (this._modelProvidersReloader?.checkAndReload()) {
                    this._modelProviders = this._modelProvidersReloader.current;
                    this._modelProviderTypes = this._modelProvidersReloader.types;
                    console.log(
                        `[PilotSwarmWorker] model providers reloaded from ${this._modelProvidersReloader.path} ` +
                        `(${this._modelProviders?.allModels.length ?? 0} models)`,
                    );
                }
                // Providers are created and deleted at runtime, so the
                // catalog is re-read on the same tick as the file. Without
                // it a provider somebody just added would resolve no
                // credential until the worker restarted.
                void this._refreshProviderRegistry()
                    .then(() => this._startSystemAgents())
                    .catch((err) => console.warn(`[PilotSwarmWorker] provider/system reconciliation failed: ${String((err as Error)?.message ?? err)}`));
            }, 30_000);
            this._modelProvidersReloadTimer.unref?.();
        }
    }

    /**
     * Rebuild what the SessionManager resolves models against: the TYPES
     * from the file, joined to the PROVIDERS in the database. Falls back to
     * the file alone when there is no catalog, which is what the embedded
     * single-process test worker runs on.
     */
    private async _refreshProviderRegistry(): Promise<void> {
        const store = this._catalog?.providers;
        if (!store || !this._modelProviderTypes) {
            if (this._modelProviders) this.sessionManager.setModelProviders(this._modelProviders);
            return;
        }
        const { buildRuntimeRegistry } = await import("./provider-catalog.js");
        try {
            const [credentials, defaults] = await Promise.all([
                store.allCredentials(),
                store.getDefaults(null),
            ]);
            this._modelProviders = buildRuntimeRegistry(
                this._modelProviderTypes, credentials, defaults.cluster.model);
            this.sessionManager.setModelProviders(this._modelProviders);
        } catch (err) {
            // Provider identity and credentials are authoritative in CMS.
            // Clear the runtime registry so a turn fails closed instead of
            // executing through a stale/file-backed credential.
            this._modelProviders = buildRuntimeRegistry(this._modelProviderTypes, [], null);
            this.sessionManager.setModelProviders(this._modelProviders);
            console.warn(`[PilotSwarmWorker] provider registry refresh failed: ${String((err as Error)?.message ?? err)}`);
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
        this._pushMergedToolRegistry();
    }

    /**
     * SessionManager resolves tool names against one merged map: statically
     * registered tools win over package tools on a name collision (the
     * static registration is deployment code; a package must not shadow it).
     */
    private _pushMergedToolRegistry(): void {
        const merged = new Map<string, Tool<any>>(this._agentPackageTools);
        for (const [name, tool] of this.toolRegistry) merged.set(name, tool);
        this.sessionManager.setToolRegistry(merged, {
            byPackage: this._agentPackageToolsByPackage,
            staticNames: new Set(this.toolRegistry.keys()),
        });
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

    /** Server names the deployment defines (plugin dirs + direct config) — names no package may redefine. */
    get deploymentMcpServerNames(): string[] {
        return [...this._deploymentMcpNames];
    }

    /** Catalog servers restricted with `allowedAgents`: server name → allowed agent identities. */
    get restrictedMcpServers(): Record<string, string[]> {
        const out: Record<string, string[]> = {};
        for (const [name, allowed] of this._mcpAllowedAgents) out[name] = [...allowed];
        return out;
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

        // ── Provider budgets: the one-time deployment seed ──────────────
        //
        // A fresh cluster holds no providers, and the credentials in the
        // model-providers file are the obvious place to start: each entry
        // that carries a usable key becomes one shared provider named after
        // the entry, so `azure-openai:gpt-5.4` means the same thing before
        // and after this feature and no deployment file has to change.
        //
        // The claim is atomic in the database, so several pods booting
        // together seed exactly once, and it is read ONCE per cluster ever —
        // a provider an administrator later deleted stays deleted rather
        // than reappearing at the next restart.
        //
        // Never fatal. A worker that cannot seed can still run every session
        // whose provider already exists.
        if (this._catalog?.providers && this._modelProviders) {
            try {
                const { bootstrapProviders } = await import("./provider-catalog.js");
                const seeded = await bootstrapProviders(this._catalog.providers, {
                    providers: this._modelProviders.allProviders,
                    defaultModel: this._modelProviders.defaultModel,
                });
                if (seeded.claimed) {
                    console.log(`[PilotSwarmWorker] seeded ${seeded.created} provider(s) from the model-providers file`);
                }
            } catch (err) {
                console.warn(`[PilotSwarmWorker] provider seed skipped: ${String((err as Error)?.message ?? err)}`);
            }
            await this._refreshProviderRegistry();
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
            `cmsPoolMax=${cmsPoolMax}, factsPoolMax=${factsPoolMax}; ` +
            `turnTimeoutMs=${this.config.turnTimeoutMs}`,
        );
        this.sessionManager.setFactStore(this.factStore);
        this.sessionManager.setGraphStore(this.graphStore);

        // ── Agent packages: initial install AFTER the stores settle (the
        //    first heartbeat writes the worker's write-once capability info,
        //    which reads factStore/graphStore) but BEFORE the runtime exists
        //    so the first session on a fresh pod already sees registry
        //    agents. A registry problem degrades to zero packages, never a
        //    failed boot.
        if (this._agentPackagesCacheDir) {
            await this.refreshAgentPackages({ force: true });
        }
        // Registered + converged (or intentionally package-less): the next
        // heartbeat advertises ready. Draining is set in gracefulShutdown.
        this._workerPhase = "ready";
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
            this._allowedAgentNamesLive,
            this._rawLoadedAgents,
            this.factStore,
            this.config.workerNodeId,
            this.artifactStore,
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
            // The write bundle attaches patch artifacts through the same store.
            if (this.sessionManager) this.sessionManager.artifactStore = this.artifactStore ?? null;
            this.registerTools(artifactTools);
        }

        // Regen-distiller service-session tools (archived-transcript pager).
        // Registered fleet-wide — any pod can host the distiller's turn — but
        // the tool self-gates at call time on the caller's CMS service columns.
        if (this.artifactStore && this._catalog) {
            this.registerTools(createDistillerTools({ catalog: this._catalog, blobStore: this.artifactStore }));
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

        // Agent-package epoch poll (model-providers-reloader pattern): one
        // single-row SELECT per interval; a changed epoch triggers the full
        // install + in-place swap. 0 disables.
        if (this._agentPackagesCacheDir && this._agentPackagesRefreshMs > 0) {
            this._agentPackagesTimer = setInterval(() => {
                void this.refreshAgentPackages();
            }, this._agentPackagesRefreshMs);
            this._agentPackagesTimer.unref?.();
        }

        await new Promise(r => setTimeout(r, 200));

        // Auto-start system agents defined in plugins (idempotent), but do not
        // block worker.start() on the bootstrap race. The TUI should become
        // interactive even if first-run system-agent startup is slow.
        void this._startSystemAgents().catch((err: any) => {
            console.warn(`[PilotSwarmWorker] background system agent startup failed: ${err?.message ?? err}`);
        });
    }

    async stop(): Promise<void> {
        if (this._evictionTimer) {
            clearInterval(this._evictionTimer);
            this._evictionTimer = null;
        }
        if (this._agentPackagesTimer) {
            clearInterval(this._agentPackagesTimer);
            this._agentPackagesTimer = null;
        }
        if (this._eventLoopHist) {
            this._eventLoopHist.disable();
            this._eventLoopHist = null;
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

        // Advertise draining before the runtime drain so operators see the
        // phase for the duration of the drain window. Best-effort AND
        // bounded: a black-holed CMS socket must not eat the drain budget
        // (SIGKILL at grace-period expiry would crash in-flight turns).
        this._workerPhase = "draining";
        if (this._agentPackagesCacheDir) {
            await Promise.race([
                this._reportAgentWorkerState(),
                new Promise<void>((resolve) => { setTimeout(resolve, 5_000).unref?.(); }),
            ]);
        }

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
     *   1. system/  — SDK core (always loaded: base system prompt, html-visuals skill)
     *   2. mgmt/    — SDK management agents (loaded unless disableManagementAgents is true)
    *   3. default-agents/ — optional SDK user agents, read into a separate registry
    *   4. app      — Consumer-provided plugin dirs (from pluginDirs option)
    *   5. direct   — Inline config (skillDirectories, customAgents, mcpServers options)
     *
     * Agents merge by name (later tiers override earlier).
     * Skills: every dir is read, but the registry is keyed by skill NAME, so a
     *   later tier replaces an earlier skill of the same name. A registered
     *   skill only reaches a prompt if some agent declares it in `skills:`
     *   (see _applyDeclaredAgentSkills) — there is no discovery path.
     * MCP servers merge by name (later tiers override earlier).
     */
    // ─── Agent packages (docs/proposals/agent-packages.md) ────────

    /**
     * Reset every plugin-derived structure IN PLACE so the shared references
     * held by SessionManager (workerDefaults) and the activity layer
     * (registerActivities args) observe the reload. Reassigning any of these
     * would strand a consumer on a stale snapshot — see the field comments.
     */
    private _resetLoadedPluginState(): void {
        this._loadedSkillDirs.length = 0;
        this._loadedSkills.clear();
        this._loadedSkillsAll.length = 0;
        this._rawLoadedAgents.length = 0;
        this._loadedAgents.length = 0;
        this._loadedSystemAgents.length = 0;
        this._availableBundledAgents.clear();
        for (const key of Object.keys(this._loadedMcpServers)) delete this._loadedMcpServers[key];
        for (const key of Object.keys(this._agentMcpServers)) delete this._agentMcpServers[key];
        for (const key of Object.keys(this._agentPromptLookup)) delete this._agentPromptLookup[key];
        this._defaultMcpServerNames.length = 0;
        this._mcpAllowedAgents.clear();
        this._deploymentMcpNames.clear();
        this._baseAgentMcpDecl = { refs: [], inherit: false };
        this._directConfigMcpNames = [];
        this._frameworkBasePrompt = null;
        this._appDefaultPrompt = null;
        this._frameworkBaseToolNames.length = 0;
        this._appDefaultToolNames.length = 0;
        this._frameworkBaseDescriptor = null;
        this._appDefaultDescriptor = null;
        this._sessionPolicy = null;
    }

    /**
     * Install (or re-install) registry agent packages and swap them into the
     * live catalog. Startup calls this once before the runtime exists; the
     * epoch poll calls it forever after. Never throws: a registry outage or
     * a broken package degrades to "packages unchanged/quarantined", never
     * to a dead worker.
     *
     * Hot-swap semantics (existing runtime behavior, relied on, not added):
     * prompts re-read per turn, tool HANDLERS re-register per turn, tool
     * DECLARATIONS and MCP configs reach the CLI only on cold create/resume.
     */
    async refreshAgentPackages(opts: { force?: boolean } = {}): Promise<void> {
        if (!this._agentPackagesCacheDir || !this._catalog || !this.artifactStore) return;
        if (this._agentPackagesRefreshing) return;
        this._agentPackagesRefreshing = true;
        try {
            const currentEpoch = await this._catalog.agentRegistryEpoch();
            if (!opts.force && currentEpoch === this._agentPackagesEpoch) {
                return;
            }

            const result = await installAgentPackages({
                catalog: this._catalog,
                artifactStore: this.artifactStore,
                cacheDir: this._agentPackagesCacheDir,
            });

            // Import worker modules BEFORE the swap; an import failure
            // quarantines the whole package (prompts included) so a package
            // never half-loads.
            //
            // Two registries on purpose. The flat map keeps the historical
            // "any session can name any tool" behavior, but two enabled
            // packages may ship the SAME tool name (scope shadowing publishes
            // a private copy next to the shared one) — there the flat map has
            // one arbitrary winner. The per-package map lets tool resolution
            // hand each session the handler from the copy its agent bound to.
            const packageTools = new Map<string, Tool<any>>();
            const packageToolsByPackage = new Map<string, Map<string, Tool<any>>>();
            for (const pkg of result.packages) {
                if (pkg.status !== "ok" || !pkg.workerModulePath) continue;
                try {
                    const tools = await loadAgentPackageTools(pkg, { workerNodeId: this.config.workerNodeId });
                    const ownMap = new Map<string, Tool<any>>();
                    for (const tool of tools) {
                        packageTools.set((tool as any).name, tool);
                        ownMap.set((tool as any).name, tool);
                    }
                    if (ownMap.size > 0) packageToolsByPackage.set(pkg.packageId, ownMap);
                } catch (error: any) {
                    pkg.status = "error";
                    pkg.error = `worker-module import failed: ${String(error?.message ?? error)}`;
                }
            }
            const okDirs = result.packages.filter((p) => p.status === "ok").map((p) => p.dir);

            // Which installed dir came from which package OWNER.
            //
            // The install manifest is deliberately unfiltered — workers hold
            // every enabled package, including other users' private ones — so
            // the ONLY thing that can keep a user-scope agent private is
            // knowing who owns it at resolution time. Without this map the
            // provenance is lost the moment a package becomes "just another
            // plugin dir", and every loaded agent looks equally public.
            // Key by the RESOLVED absolute dir: _loadPluginDir looks provenance
            // up with path.resolve(pluginDir), so an unresolved key here would
            // miss whenever the cache dir is relative — silently demoting every
            // package agent to a deployment agent and disabling fail-closed
            // privacy, MCP qualification, and skill scoping all at once.
            this._packageDirOwners = new Map(
                result.packages
                    .filter((p) => p.status === "ok")
                    .map((p) => [path.resolve(p.dir), { packageId: p.packageId, scope: p.scope, owner: p.owner }]),
            );

            // Synchronous swap — no await between reset and reload, so no
            // turn can observe the intermediate empty state.
            this._resetLoadedPluginState();
            this.config.pluginDirs = [...this._basePluginDirs, ...okDirs];
            this._loadPlugins();
            this._agentPackageTools = packageTools;
            this._agentPackageToolsByPackage = packageToolsByPackage;
            this._pushMergedToolRegistry();

            this._agentPackagesEpoch = result.epoch;
            // Heartbeat state keys by name for the common case, but two
            // packages CAN share a name (scope shadowing). Collapsing those
            // to one row hid exactly the collision an operator needs to see —
            // duplicated names get a qualified key instead.
            const installedNameCounts = new Map<string, number>();
            for (const p of result.packages) {
                installedNameCounts.set(p.name, (installedNameCounts.get(p.name) ?? 0) + 1);
            }
            this._agentPackagesInstalled = Object.fromEntries(result.packages.map((p) => [
                (installedNameCounts.get(p.name) ?? 0) > 1
                    ? `${p.name}#${p.scope}${p.scope === "user" && p.owner ? `:${p.owner.subject.slice(0, 8)}` : ""}`
                    : p.name,
                { semver: p.semver, sha256: p.sha256, status: p.status, ...(p.error ? { error: p.error } : {}) },
            ]));
            const failed = result.packages.filter((p) => p.status === "error");
            console.log(
                `[PilotSwarmWorker] agent packages @ epoch ${result.epoch}: ` +
                `${okDirs.length} installed${failed.length ? `, ${failed.length} quarantined (${failed.map((p) => p.name).join(", ")})` : ""}`,
            );
            for (const pkg of failed) {
                console.warn(`[PilotSwarmWorker] agent package "${pkg.name}@${pkg.semver}" quarantined: ${pkg.error}`);
            }
            this._agentPackagesRefreshError = null;
        } catch (error: any) {
            // Recorded into the heartbeat's state so a stuck worker is
            // diagnosable from the registry (actual epoch lags + lastError),
            // not just from this pod's logs.
            this._agentPackagesRefreshError = String(error?.message ?? error);
            console.warn(`[PilotSwarmWorker] agent-package refresh failed (will retry on next poll): ${error?.message ?? error}`);
        } finally {
            // The heartbeat is the worker's PRESENCE, not a success report:
            // it must fire on the unchanged path, the converge path, and the
            // install-failure path alike, or a worker becomes invisible
            // exactly when it is unhealthy. Awaited so fleet truth is durable
            // once a refresh resolves; never throws.
            await this._reportAgentWorkerState();
            this._agentPackagesRefreshing = false;
        }
    }

    /** Stable registry identity: configured workerNodeId, else host#pid. */
    private get _registryWorkerId(): string {
        return this.config.workerNodeId || `${os.hostname()}#${process.pid}`;
    }

    private get _workerPool(): string {
        return this.config.workerPool
            || process.env.PILOTSWARM_WORKER_POOL
            || (process.env.KUBERNETES_SERVICE_HOST ? "aks-default" : "default");
    }

    /** Write-once identity/build/capability record for the workers row. */
    private _buildRegistrarInfo(): Record<string, unknown> {
        if (this._registrarInfo) return this._registrarInfo;
        let sdkVersion = "unknown";
        try {
            sdkVersion = require("../package.json").version ?? "unknown";
        } catch { /* packed layouts without a reachable package.json */ }
        this._registrarInfo = {
            sdkVersion,
            orchestrationVersions: DURABLE_SESSION_ORCHESTRATION_REGISTRY.map((r) => r.version),
            consumes: this._agentPackagesCacheDir ? ["agent-packages"] : [],
            capabilities: {
                blobStore: Boolean(this.blobStore),
                enhancedFacts: Boolean(this.factStore && isEnhancedFactStore(this.factStore)),
                graph: Boolean(this.graphStore),
            },
            runtime: {
                substrate: process.env.KUBERNETES_SERVICE_HOST ? "kubernetes" : "process",
                hostname: os.hostname(),
                pid: process.pid,
                startedAt: new Date(Date.now() - Math.round(process.uptime() * 1000)).toISOString(),
            },
        };
        return this._registrarInfo;
    }

    /** Glanceable health snapshot — last-known values, never a time series. */
    private _collectWorkerHealth(): Record<string, unknown> {
        const memory = process.memoryUsage();
        const eventLoopDelayP99Ms = this._eventLoopHist
            ? Math.round((this._eventLoopHist.percentile(99) / 1e6) * 100) / 100
            : null;
        this._eventLoopHist?.reset();
        const slotTotal = (raw: string | undefined, fallback: number) => {
            const n = Number.parseInt(raw || "", 10);
            return Number.isFinite(n) && n > 0 ? n : fallback;
        };
        return {
            uptimeS: Math.round(process.uptime()),
            rssBytes: memory.rss,
            heapUsedBytes: memory.heapUsed,
            eventLoopDelayP99Ms,
            activeSessions: this.sessionManager.activeSessionCount,
            orchestrationSlots: { total: slotTotal(process.env.PILOTSWARM_ORCHESTRATION_CONCURRENCY, 2) },
            workerSlots: { total: slotTotal(process.env.PILOTSWARM_WORKER_CONCURRENCY, 2) },
        };
    }

    /**
     * Worker-registry heartbeat (migration 0040): upsert this worker's row —
     * presence, health, per-domain actual state — and receive the effective
     * directive set. Agent-packages convergence stays driven by the refresh
     * flow (its epoch read rides the seeded directive via the shim), so the
     * returned directives are bookkeeping here; unknown or externally-
     * actuated domains are inert by protocol. Never throws.
     */
    private async _reportAgentWorkerState(): Promise<void> {
        if (!this._catalog) return;
        try {
            await this._catalog.workerHeartbeat({
                workerNodeId: this._registryWorkerId,
                pool: this._workerPool,
                phase: this._workerPhase,
                owner: this.config.workerOwner ?? null,
                info: this._buildRegistrarInfo(),
                health: this._collectWorkerHealth(),
                state: {
                    "agent-packages": {
                        epoch: this._agentPackagesEpoch,
                        installed: this._agentPackagesInstalled,
                        ...(this._agentPackagesRefreshError ? { lastError: this._agentPackagesRefreshError } : {}),
                    },
                },
            });
        } catch (error: any) {
            console.warn(`[PilotSwarmWorker] worker-registry heartbeat failed: ${error?.message ?? error}`);
        }
    }

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
                for (const skill of loadSkillsSync(skillsDir)) {
                    this._loadedSkills.set(skill.name, skill);
                    this._loadedSkillsAll.push(skill);
                }
            }
        }
        if (this.config.customAgents?.length) {
            for (const agent of this.config.customAgents) {
                const descriptor = this._buildLayerDescriptor(agent as any, "app", "inline");
                this._rawLoadedAgents.push({ ...agent, promptLayerKind: "app-agent", layerDescriptor: descriptor } as any);
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
            for (const name of this._directConfigMcpNames) this._deploymentMcpNames.add(name);
        }
        this._appDefaultPrompt = mergePromptSections([
            this._appDefaultPrompt,
            this.config.systemMessage,
        ]) ?? null;
        this._applyDeclaredAgentSkills();
        this._finalizeAgentPromptLookup();
        this._composeSkillsIndex();
        this._resolveAgentMcpServers();
        // IN PLACE: SessionManager holds this exact array as
        // workerDefaults.customAgents — reassigning would strand it on the
        // constructor-time snapshot after an agent-package refresh.
        this._loadedAgents.length = 0;
        this._loadedAgents.push(...this._rawLoadedAgents.map((agent) => {
            // Replace the frontmatter's named MCP references with the
            // resolved server map (and drop the inherit flag) so the SDK's
            // CustomAgentConfig.mcpServers receives real server configs.
            const { mcpServers: _refs, inheritDefaultMcpServers: _inherit, ...rest } = agent;
            const mcpKey = (agent as any).packageId
                ? packageAgentKey((agent as any).packageId, agent.name)
                : agent.name;
            return {
                ...rest,
                // The agent's OWN prompt (skills already composed in), never
                // the name-keyed lookup: with scope shadowing two copies share
                // the name and the lookup would hand every copy the default's.
                prompt: composeSystemPrompt({
                    frameworkBase: this._frameworkBasePrompt,
                    appDefault: this._appDefaultPrompt,
                    activeAgentPrompt: agent.prompt,
                }) ?? agent.prompt,
                // mcpKey is the qualified key for a package agent, the bare
                // name for a deployment/inline one — the only keys registered.
                ...(this._agentMcpServers[mcpKey]
                    ? { mcpServers: this._agentMcpServers[mcpKey] }
                    : {}),
            };
        }));
        this._allowedAgentNamesLive.length = 0;
        this._allowedAgentNamesLive.push(...this._loadedAgents.map((a) => a.name));

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
        this._mcpAllowedAgents.clear();
        for (const [name, cfg] of Object.entries(this._loadedMcpServers)) {
            if (!cfg || typeof cfg !== "object") continue;
            // `allowedAgents` — a restricted server. Remember who may use it,
            // then strip the field: it must never reach the Copilot CLI.
            if (Array.isArray(cfg.allowedAgents)) {
                const allowed = new Set<string>(
                    cfg.allowedAgents.map((v: unknown) => String(v ?? "").trim()).filter(Boolean),
                );
                this._mcpAllowedAgents.set(name, allowed);
            }
            if ("allowedAgents" in cfg) delete cfg.allowedAgents;
            // A restricted server never joins the default set: "default": true
            // would hand it to every agent that inherits defaults, which is
            // exactly what the allowlist exists to prevent.
            if (cfg.default === true) {
                if (this._mcpAllowedAgents.has(name)) {
                    console.warn(`[PilotSwarmWorker] MCP server "${name}" is tagged "default": true but restricted by allowedAgents; it is NOT part of the default set.`);
                } else {
                    defaults[name] = cfg;
                }
            }
            if ("default" in cfg) delete cfg.default;
        }
        this._defaultMcpServerNames = Object.keys(defaults);

        // `agent` is the agent whose references are being resolved; null for
        // the base map, which carries no agent identity and therefore never
        // receives a restricted server.
        const resolveRefs = (owner: string, refs: string[] | undefined, into: Record<string, any>, agent: McpAllowlistAgent | null = null) => {
            for (const ref of refs ?? []) {
                if (typeof ref !== "string" || !ref) continue;
                const server = this._loadedMcpServers[ref];
                if (!server) {
                    console.warn(`[PilotSwarmWorker] ${owner}: MCP server "${ref}" is not in the deployment catalog; reference dropped.`);
                    continue;
                }
                const allowed = this._mcpAllowedAgents.get(ref);
                if (allowed && !mcpAllowlistAdmits(allowed, agent)) {
                    console.warn(`[PilotSwarmWorker] ${owner}: MCP server "${ref}" is restricted to ${[...allowed].join(", ")}; reference dropped.`);
                    continue;
                }
                into[ref] = server;
            }
        };

        // Base map — applied to EVERY session: base (default) agents that
        // opted in, plus direct worker-config servers (their documented
        // every-session semantics predate per-agent resolution).
        // IN PLACE: SessionManager holds this exact object as
        // workerDefaults.baseMcpServers — never reassign it.
        for (const key of Object.keys(this._baseMcpServers)) delete this._baseMcpServers[key];
        if (this._baseAgentMcpDecl.inherit) Object.assign(this._baseMcpServers, defaults);
        resolveRefs("Base (default) agent", this._baseAgentMcpDecl.refs, this._baseMcpServers);
        for (const name of this._directConfigMcpNames) {
            if (!this._loadedMcpServers[name]) continue;
            if (this._mcpAllowedAgents.has(name)) {
                console.warn(`[PilotSwarmWorker] Direct worker-config MCP server "${name}" is restricted by allowedAgents and cannot apply to every session; dropped from the base map.`);
                continue;
            }
            this._baseMcpServers[name] = this._loadedMcpServers[name];
        }
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
        //
        // A PACKAGE agent registers ONLY under a package-qualified key, never
        // the bare name. With scope shadowing two copies share the bare name,
        // and a bare-name entry is last-write-wins — a session resolving one
        // copy could read the other's grants (or a user package could strip a
        // deployment agent's grants fleet-wide). The bare name is therefore
        // reserved for deployment/inline agents, which have no packageId; the
        // session-manager reads the qualified key for package copies and the
        // bare key only for non-package agents.
        for (const agent of [...this._rawLoadedAgents, ...this._loadedSystemAgents]) {
            const resolved: Record<string, any> = {};
            if (agent.inheritDefaultMcpServers === true) {
                Object.assign(resolved, defaults);
            }
            resolveRefs(`Agent "${agent.name}"`, agent.mcpServers, resolved, {
                name: agent.name,
                namespace: agent.namespace ?? null,
                packageId: (agent as any).packageId ?? null,
                packageScope: (agent as any).packageScope ?? null,
            });
            const key = (agent as any).packageId
                ? packageAgentKey((agent as any).packageId, agent.name)
                : agent.name;
            if (Object.keys(resolved).length > 0) {
                this._agentMcpServers[key] = resolved;
            } else {
                delete this._agentMcpServers[key];
            }
        }
    }

    /**
     * The package a loaded skill belongs to, or null for a deployment skill.
     * Matched by directory prefix against the installed package dirs.
     */
    private _skillPackageOwner(skill: Skill): { scope: "shared" | "user"; owner: { provider: string; subject: string } | null } | null {
        if (!skill.dir) return null;
        // Resolve the skill dir once; the map keys are already resolved.
        const skillDir = path.resolve(skill.dir);
        for (const [dir, prov] of this._packageDirOwners) {
            if (skillDir === dir || skillDir.startsWith(dir + path.sep)) {
                return { scope: prov.scope, owner: prov.owner };
            }
        }
        return null;
    }

    /**
     * Progressive discovery: append a one-line-per-skill index to the
     * framework base prompt so every session knows which skills EXIST and
     * can pull one with `load_skill`. The bodies stay out of context unless
     * an agent declares them in `skills:`. Runs once per plugin load — the
     * base prompt is re-read from disk on every reload, so it never stacks.
     */
    private _composeSkillsIndex(): void {
        // Two catalogs, both held by reference in workerDefaults and refilled
        // in place:
        //
        //   _loadableSkills      deployment + shared-package skills. Every
        //                        session may load these, and they are indexed
        //                        in the framework base prompt below.
        //   _ownerScopedSkills   a user-scope package's skills, keyed by its
        //                        owner. Private: only sessions owned by that
        //                        person may load them, and only their prompt
        //                        lists them. session-manager concatenates the
        //                        right bucket onto the shared list per
        //                        session (`_skillCatalogForSession`) and adds
        //                        the matching index lines
        //                        (`_ownerSkillsIndexSection`).
        this._loadableSkills.length = 0;
        this._ownerScopedSkills.clear();
        const seen = new Map<string, string>();
        const ownerSeen = new Map<string, Set<string>>();
        for (const skill of this._loadedSkillsAll) {
            if (!skill?.name) continue;
            const prov = this._skillPackageOwner(skill);
            if (prov && prov.scope === "user") {
                // Private to its owner: never in the fleet-wide catalog, but
                // loadable by that person's own sessions. session-manager
                // concatenates this list onto the shared one per session.
                const key = agentOwnerKey(prov.owner);
                if (!key) continue;
                const names = ownerSeen.get(key) ?? new Set<string>();
                if (names.has(skill.name)) continue;
                names.add(skill.name);
                ownerSeen.set(key, names);
                const list = this._ownerScopedSkills.get(key) ?? [];
                list.push(skill);
                this._ownerScopedSkills.set(key, list);
                continue;
            }
            if (seen.has(skill.name)) continue;
            this._loadableSkills.push(skill);
            const description = clipDescription(String(skill.description || "").replace(/\s+/g, " ").trim(), 240);
            seen.set(skill.name, description);
        }
        if (!this._frameworkBasePrompt || seen.size === 0) return;
        const lines = [...seen.entries()].sort(([a], [b]) => a.localeCompare(b))
            .map(([name, description]) => `- \`${name}\`${description ? ` — ${description}` : ""}`);
        this._frameworkBasePrompt += `\n\n## Skills available on demand\n\nCall \`load_skill(name)\` when a task matches one; the full instructions come back as the tool result. Load a skill once per session, before the work it covers.\n\n${lines.join("\n")}`;
    }

    private _applyDeclaredAgentSkills(): void {
        // (see _composeSkillsIndex for the discovery half)
        for (const agent of [...this._rawLoadedAgents, ...this._loadedSystemAgents]) {
            if (!agent.skills?.length) continue;
            // Resolved to match _packageDirOwners keys (see _skillPackageOwner).
            const ownDir = (agent as any).packageDir
                ? path.resolve((agent as any).packageDir as string)
                : undefined;
            const ownOwnerKey = agentOwnerKey((agent as any).packageOwner);
            // Build THIS agent's skill pool. Deployment and shared-package
            // skills are public by construction. A user-scope package's skills
            // are PRIVATE to its owner — the worker holds every tenant's
            // packages, so composing against the flat map let a package agent
            // pull another user's private skill BODY just by declaring its
            // name (accidentally on a name collision, or deliberately). Each
            // agent therefore sees deployment + shared skills + only its OWN
            // package's skills. A declared name that resolves to none becomes a
            // normal "missing skill" warning instead of a silent cross-tenant
            // read.
            const pool: Skill[] = [];
            const ownSkills: Skill[] = [];
            for (const skill of this._loadedSkillsAll) {
                const prov = this._skillPackageOwner(skill);
                const skillDir = skill.dir ? path.resolve(skill.dir) : null;
                const isOwn = Boolean(ownDir && skillDir && skillDir.startsWith(ownDir + path.sep));
                if (isOwn) { ownSkills.push(skill); continue; }
                if (!prov || prov.scope !== "user") { pool.push(skill); continue; }
                // Foreign user-scope skill: include only if same owner (another
                // copy the same person owns); otherwise exclude.
                if (ownOwnerKey && agentOwnerKey(prov.owner) === ownOwnerKey) pool.push(skill);
            }
            // Own-package skills go LAST so they win a name collision with a
            // shared/deployment skill (composeDeclaredSkillsPrompt is last-wins).
            const composed = composeDeclaredSkillsPrompt(agent.prompt, agent.skills, [...pool, ...ownSkills]);
            // Compose onto the agent itself: each copy of a shadowed name
            // keeps its own composed prompt instead of fighting over one
            // name-keyed lookup entry.
            agent.prompt = composed.prompt;
            for (const missing of composed.missing) {
                console.warn(`[PilotSwarmWorker] Agent ${agent.name} declares missing skill ${JSON.stringify(missing)}; available skill directories did not provide it.`);
            }
        }
    }

    /**
     * Rebuild the by-name agent lookup after everything is loaded and skills
     * are composed.
     *
     * With agent-package scope shadowing one NAME can be served by several
     * enabled packages at once. The incremental per-dir writes above are
     * last-wins — load order decided which copy every session got, and one
     * user's private copy could silently replace the shared prompt for the
     * whole fleet. This pass makes the bare entry deterministic (deployment
     * code beats shared package beats user package) and records every copy so
     * session resolution can pick per session owner
     * (`pickAgentCopyForOwner` in session-manager).
     */
    private _finalizeAgentPromptLookup(): void {
        const byName = new Map<string, any[]>();
        for (const agent of [...this._rawLoadedAgents, ...this._loadedSystemAgents]) {
            const list = byName.get(agent.name) ?? [];
            list.push(agent);
            byName.set(agent.name, list);
        }
        const rank = (agent: any) => agent.packageId == null ? 0 : (agent.packageScope !== "user" ? 1 : 2);
        for (const [name, agents] of byName) {
            const winner = [...agents].sort((a, b) => rank(a) - rank(b))[0];
            const copyOf = (agent: any) => ({
                prompt: agent.prompt,
                kind: agent.promptLayerKind ?? "app-agent",
                descriptor: agent.layerDescriptor,
                ...(agent.packageId ? {
                    packageId: agent.packageId,
                    packageScope: agent.packageScope ?? "shared",
                    packageOwner: agent.packageOwner ?? null,
                } : {}),
            });
            this._agentPromptLookup[name] = {
                ...copyOf(winner),
                ...(agents.length > 1 ? { copies: agents.map(copyOf) } : {}),
            };
            if (agents.length > 1) {
                console.warn(
                    `[PilotSwarmWorker] agent name "${name}" is served by ${agents.length} loaded copies `
                    + `(${agents.map((a: any) => a.packageId ? `${a.packageScope ?? "shared"} package` : "deployment").join(", ")}); `
                    + `sessions resolve their owner's copy, default is the ${winner.packageId ? `${winner.packageScope ?? "shared"} package` : "deployment"} copy`,
                );
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
            (agent as any).layerDescriptor = descriptor;
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
            for (const skill of loadSkillsSync(skillsDir)) {
                this._loadedSkills.set(skill.name, skill);
                // Keep every copy with provenance: same-named skills from two
                // package copies must not collapse before per-agent compose.
                this._loadedSkillsAll.push(skill);
            }
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
                        // IN PLACE: SessionManager captured this exact array at
                        // construction (workerDefaults.frameworkBaseToolNames);
                        // reassigning would strand it EMPTY after the reset in
                        // an agent-package refresh — every cold session would
                        // lose the entire framework base tool set.
                        this._frameworkBaseToolNames.length = 0;
                        this._frameworkBaseToolNames.push(...(agent.tools ?? []));
                        this._frameworkBaseDescriptor = descriptor;
                    } else if (layer === "app") {
                        this._appDefaultPrompt = agent.prompt;
                        // IN PLACE — same contract as the framework array above.
                        this._appDefaultToolNames.length = 0;
                        this._appDefaultToolNames.push(...(agent.tools ?? []));
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
                } else if (agent.system) {
                    agent.promptLayerKind = layer === "management" ? "pilotswarm-system-agent" : "app-system-agent";
                    (agent as any).layerDescriptor = descriptor;
                    this._agentPromptLookup[agent.name] = {
                        prompt: agent.prompt,
                        kind: agent.promptLayerKind,
                        descriptor,
                    };
                    this._loadedSystemAgents.push(agent);
                } else {
                    agent.promptLayerKind = "app-agent";
                    (agent as any).layerDescriptor = descriptor;
                    this._agentPromptLookup[agent.name] = {
                        prompt: agent.prompt,
                        kind: "app-agent",
                        descriptor,
                    };
                    // Stamp package provenance so agent resolution can tell a
                    // deployment-wide agent from one that belongs to a single
                    // user. Absent for plain plugin dirs, which are part of
                    // the deployment and public to it by construction.
                    const provenance = this._packageDirOwners.get(absDir);
                    if (provenance) {
                        (agent as any).packageId = provenance.packageId;
                        (agent as any).packageDir = absDir;
                    }
                    if (provenance && provenance.scope === "user" && provenance.owner) {
                        (agent as any).packageScope = "user";
                        (agent as any).packageOwner = provenance.owner;
                    } else if (provenance) {
                        (agent as any).packageScope = "shared";
                    }
                    this._rawLoadedAgents.push(agent);
                }
            }
        }

        // MCP — merge into the deployment catalog. The catalog is FLAT, so a
        // PACKAGE dir may not redefine any name the deployment defined (that
        // would swap the server every agent in the fleet talks to, restricted
        // or not), and may not restrict entries itself — `allowedAgents` is a
        // deployment-catalog field. Deployment dirs load before package dirs,
        // so every deployment name is known when a package tries to shadow it.
        const mcpConfig = loadMcpConfig(absDir);
        const mcpPackageProvenance = this._packageDirOwners.get(absDir);
        for (const [name, cfg] of Object.entries(mcpConfig)) {
            if (mcpPackageProvenance) {
                if (this._deploymentMcpNames.has(name)) {
                    console.warn(`[PilotSwarmWorker] Package MCP server "${name}" cannot override a deployment catalog entry; definition dropped.`);
                    continue;
                }
                if (cfg && typeof cfg === "object" && "allowedAgents" in cfg) {
                    console.warn(`[PilotSwarmWorker] Package MCP server "${name}": "allowedAgents" is a deployment-catalog field; ignored.`);
                    delete (cfg as any).allowedAgents;
                }
            } else {
                this._deploymentMcpNames.add(name);
            }
            this._loadedMcpServers[name] = cfg;
        }

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
        const providerStore = this._catalog.providers;
        if (!providerStore || !this._modelProviderTypes) {
            console.warn("[PilotSwarmWorker] system agents blocked: provider routing is unavailable");
            return;
        }
        const [defaults, overrides, credentials] = await Promise.all([
            providerStore.getDefaults(null),
            providerStore.listSystemAgentModels(),
            providerStore.allCredentials(),
        ]);
        const fallback = firstRuntimeModel(
            this._modelProviderTypes,
            credentials,
            (provider) => provider.class === "shared" || provider.systemUseEnabled === true,
        );
        const systemDefault = defaults.system.provider ? defaults.system : fallback;
        if (!systemDefault?.model) {
            console.warn("[PilotSwarmWorker] system agents blocked: no system-eligible model provider is configured");
            return;
        }

        const overrideByAgent = new Map(overrides.map((override) => [override.agentId, override]));
        for (const plan of resolveSystemAgentSessionPlans(this._loadedSystemAgents)) {
            const override = overrideByAgent.get(plan.agent.id);
            const route = override ?? systemDefault;
            if (!route.model || !this._modelProviders?.hasModel(route.model)) {
                console.warn(`[PilotSwarmWorker] system agent ${plan.agent.id} blocked: configured model ${route.model ?? "(none)"} is unavailable`);
                continue;
            }
            await startSystemAgents({
                catalog: this._catalog,
                duroxideClient,
                agents: this._loadedSystemAgents,
                agentId: plan.agent.id,
                defaultModel: route.model,
                ...(route.reasoning ? { defaultReasoningEffort: route.reasoning as any } : {}),
                ...(route.context ? { defaultContextTier: route.context as any } : {}),
                modelResolutionSource: override
                    ? "agent_override"
                    : defaults.system.provider ? "system_default" : "first_available",
                blobEnabled: this.blobEnabled,
                dehydrateThreshold: this.config.waitThreshold,
                // A system session row can outlive its orchestration (a
                // restart, a pending recovery); advance its ledger base so
                // the fresh lifetime's settles land on new keys instead of
                // silently colliding with the old lifetime's rows.
                prepareRetainedSessionLedger: async (sid: string) => { await providerStore.bumpLedgerBase(sid); },
                log: (message) => console.error(message),
                warn: (message) => console.warn(message),
            });
        }
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
