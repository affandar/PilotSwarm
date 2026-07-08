/**
 * PilotSwarmManagementClient — runtime/session fleet management.
 *
 * Provides public APIs for listing sessions, renaming, cancelling,
 * deleting, model listing, session dumps, and status watching.
 *
 * This is the management surface for TUI and admin tools.
 * It replaces direct usage of private client internals, raw duroxide
 * client handles, and raw CMS catalog handles.
 *
 * @module
 */

import {
    RESPONSE_LATEST_KEY,
    commandResponseKey,
    stopTurnQueueName,
} from "./types.js";
import type {
    PilotSwarmSessionStatus,
    SessionResponsePayload,
    SessionCommandResponse,
    SessionStatusSignal,
    SessionContextUsage,
    SessionOwnerInfo,
    SessionSummaryState,
    StopTurnResult,
} from "./types.js";
import type { SessionCatalog, SessionRow, TopEventEmitterRow } from "./cms.js";
import { SYSTEM_USER_PRINCIPAL } from "./cms.js";
import type {
    SessionMetricSummary,
    TokensByModelRow,
    SessionTreeStats,
    FleetStats,
    UserStats,
    SkillUsageRow,
    SessionTreeSkillUsage,
    FleetSkillUsage,
    RetrievalUsageRow,
    SessionTreeRetrievalUsage,
    FleetRetrievalUsage,
    GraphNodeUsageKind,
    GraphNodeUsageRow,
    FleetGraphNodeUsage,
    GraphEdgeSearchUsageRow,
    UserProfile,
    UserPrincipal,
    SessionGroupRow,
    ChildOutcomeRow,
} from "./cms.js";
import type {
    FactStore, EnhancedFactStore, FactsStatsRow, FactsTombstoneStats, FactRecord, StoreFactInput,
    StoredFactResult, ReadFactsQuery, DeleteFactInput, DeletedFactResult, DeletedFactsResult,
    SearchOpts, SimilarOpts, SearchResult, FactsCapabilities, AccessContext, ForcePurgeFactsInput,
} from "./facts-store.js";
import { isEnhancedFactStore, EnhancedFactsUnsupportedError } from "./facts-store.js";
import type {
    GraphStore, GraphNodeInput, GraphEdgeInput, GraphNodeQuery, GraphEdgeQuery, GraphNodeHit,
    GraphEdgeHit, GraphNodeRef, GraphEdgeRef, SubGraph, GraphNamespaceInfo, GraphNamespaceListQuery,
    GraphNamespaceInput, GraphNamespaceQuery,
} from "./graph-store.js";
import { resolveStorageConfig, type StorageConfig } from "./storage-config.js";
import { getDuroxideStorageProvider, getRuntimeStorageProvider } from "./storage-providers.js";
import { SessionDumper } from "./session-dumper.js";
import { loadModelProviders, type ModelProviderRegistry, type ModelDescriptor, type ReasoningEffort } from "./model-providers.js";
import { deriveStatusFromCmsAndRuntime, shouldSyncCompletedStatus, shouldSyncFailedStatus } from "./session-status.js";
import { assertUnambiguousProvider, isWebOptions, type PilotSwarmWebOptions } from "./web/api-connection.js";
import { WebPilotSwarmManagementClient } from "./web/web-management-client.js";
import type { AgentConfig } from "./agent-loader.js";
import {
    loadSystemAgentConfigs,
    resolveSystemAgentSessionPlans,
    startSystemAgents,
    type SystemAgentStartResult,
    type SystemAgentSessionPlan,
} from "./system-agents.js";

// duroxide is CommonJS — use createRequire for ESM compatibility
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { SqliteProvider, Client } = require("duroxide");

const STATUS_WAIT_SLICE_MS = 10_000;
const MAX_SESSION_TITLE_LENGTH = 60;
const SESSION_COMMAND_SETTLE_TIMEOUT_MS = 65_000;
const SESSION_STATE_POLL_MS = 500;
const DEFAULT_SYSTEM_AGENT_DEHYDRATE_THRESHOLD = 30;
const DEFAULT_SESSION_PAGE_LIMIT = 50;
const MAX_SESSION_PAGE_LIMIT = 200;
const DEFAULT_TOP_EVENT_EMITTER_LIMIT = 20;
const MAX_TOP_EVENT_EMITTER_LIMIT = 100;

function clampInteger(value: number | undefined, defaultValue: number, min: number, max: number): number {
    if (value == null) return defaultValue;
    if (!Number.isFinite(value)) return defaultValue;
    return Math.max(min, Math.min(Math.trunc(value), max));
}

function assertValidDate(value: Date, label: string): void {
    if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
        throw new Error(`${label} must be a valid Date`);
    }
}

function isTerminalOrchestrationStatus(status?: string | null): boolean {
    return status === "Completed" || status === "Failed" || status === "Terminated";
}

function cloneContextUsage(contextUsage?: SessionContextUsage): SessionContextUsage | undefined {
    if (!contextUsage || typeof contextUsage !== "object") return undefined;
    return {
        ...contextUsage,
        ...(contextUsage.compaction && typeof contextUsage.compaction === "object"
            ? { compaction: { ...contextUsage.compaction } }
            : {}),
    };
}

function stripRunningCompaction(contextUsage?: SessionContextUsage): SessionContextUsage | undefined {
    const cloned = cloneContextUsage(contextUsage);
    if (!cloned?.compaction || cloned.compaction.state !== "running") return cloned;
    delete cloned.compaction;
    return cloned;
}

function isIgnorableCancelError(error: unknown): boolean {
    const message = String((error as any)?.message || error || "");
    return /instance is terminal|already (?:completed|terminated|cancelled)|not found|no such instance|missing/i.test(message);
}

function isIgnorableRestartCommandError(error: unknown): boolean {
    const message = String((error as any)?.message || error || "");
    return isIgnorableCancelError(error) || /not started|status=(?:missing|notfound|unknown)/i.test(message);
}

function createAbortError(message: string, reason?: unknown): Error {
    if (reason instanceof Error) return reason;
    const error = new Error(typeof reason === "string" && reason ? reason : message);
    error.name = "AbortError";
    return error;
}

function normalizeSessionTitleInput(title: string, maxLength = MAX_SESSION_TITLE_LENGTH): string {
    return String(title || "").trim().slice(0, maxLength);
}

function getNamedAgentTitlePrefix(session: { agentId?: string | null; title?: string | null } | null | undefined): string | null {
    if (!session?.agentId) return null;
    const currentTitle = String(session.title || "").trim();
    if (!currentTitle) return null;
    const separatorIndex = currentTitle.indexOf(": ");
    if (separatorIndex > 0) {
        return currentTitle.slice(0, separatorIndex).trim() || null;
    }
    return currentTitle || null;
}

function buildStoredSessionTitle(
    session: { agentId?: string | null; title?: string | null } | null | undefined,
    requestedTitle: string,
): string {
    const normalizedTitle = normalizeSessionTitleInput(requestedTitle);
    const prefix = getNamedAgentTitlePrefix(session);
    if (!prefix) return normalizedTitle;

    const prefixLabel = `${prefix}: `;
    const maxSuffixLength = Math.max(0, MAX_SESSION_TITLE_LENGTH - prefixLabel.length);
    if (maxSuffixLength <= 0) return prefix.slice(0, MAX_SESSION_TITLE_LENGTH);
    return `${prefixLabel}${normalizedTitle.slice(0, maxSuffixLength)}`;
}

function throwIfAborted(signal: AbortSignal | undefined, message: string): void {
    if (signal?.aborted) {
        throw createAbortError(message, signal.reason);
    }
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildLifecycleCommandId(prefix: string): string {
    return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function ownerKeyForOwner(owner: SessionOwnerInfo | null | undefined): string | null {
    const provider = String(owner?.provider || "").trim();
    const subject = String(owner?.subject || "").trim();
    return provider && subject ? `${provider}\u0001${subject}` : null;
}

function ownerLabel(owner: SessionOwnerInfo | null | undefined): string {
    return String(owner?.displayName || owner?.email || "").trim() || "unowned";
}

export type SystemSessionRestartDisposition = "complete" | "terminate" | "hard_delete" | "hardDelete";

/** Status view of the SYSTEM user's GitHub Copilot key (never the key itself). */
export interface SystemGitHubCopilotKeyStatus {
    configured: boolean;
    changedBy: string | null;
    changedAt: string | null;
}

export interface RestartSystemSessionOptions {
    disposition: SystemSessionRestartDisposition;
    reason?: string;
    timeoutMs?: number;
    model?: string;
    reasoningEffort?: ReasoningEffort | null;
}

export interface RestartSystemSessionResult {
    agentId: string;
    agentName: string;
    sessionId: string;
    disposition: "complete" | "terminate" | "hard_delete";
    previousSessionExisted: boolean;
    startResults: SystemAgentStartResult[];
}

function normalizeSystemRestartDisposition(disposition: SystemSessionRestartDisposition): "complete" | "terminate" | "hard_delete" {
    if (disposition === "complete") return "complete";
    if (disposition === "terminate") return "terminate";
    if (disposition === "hard_delete" || disposition === "hardDelete") return "hard_delete";
    throw new Error(`Unsupported system session restart disposition: ${String(disposition)}`);
}

function sessionViewFromCmsRow(row: SessionRow): PilotSwarmSessionView {
    const liveStatus: PilotSwarmSessionStatus = (row.state as PilotSwarmSessionStatus) || "pending";
    return {
        sessionId: row.sessionId,
        title: row.title ?? undefined,
        agentId: row.agentId ?? undefined,
        splash: row.splash ?? undefined,
        splashMobile: row.splashMobile ?? undefined,
        owner: row.owner ?? undefined,
        status: liveStatus,
        orchestrationStatus: undefined,
        orchestrationVersion: undefined,
        createdAt: row.createdAt.getTime(),
        updatedAt: row.updatedAt?.getTime(),
        iterations: row.currentIteration ?? 0,
        parentSessionId: row.parentSessionId ?? undefined,
        groupId: row.groupId ?? undefined,
        isSystem: row.isSystem || undefined,
        model: row.model ?? undefined,
        reasoningEffort: row.reasoningEffort ?? undefined,
        shortSummary: row.shortSummary ?? undefined,
        summaryState: row.summaryState ?? undefined,
        summaryUpdatedAt: row.summaryUpdatedAt?.getTime(),
        error: row.lastError ?? undefined,
        waitReason: row.waitReason ?? undefined,
        statusVersion: undefined,
    };
}

// ─── Types ───────────────────────────────────────────────────────

/** Merged view of a session for management UIs. */
export interface PilotSwarmSessionView {
    sessionId: string;
    title?: string;
    agentId?: string;
    splash?: string;
    /** Narrow-viewport splash variant, used when the main splash art is wider than the pane. */
    splashMobile?: string;
    owner?: SessionOwnerInfo;
    /** Live status from orchestration customStatus (idle, running, waiting, etc.) */
    status: PilotSwarmSessionStatus;
    /** Duroxide orchestration runtime status (Running, Completed, Failed, Terminated). */
    orchestrationStatus?: string;
    /** Registered duroxide orchestration version for the current instance execution. */
    orchestrationVersion?: string;
    createdAt: number;
    updatedAt?: number;
    iterations?: number;
    parentSessionId?: string;
    groupId?: string;
    isSystem?: boolean;
    model?: string;
    reasoningEffort?: string;
    shortSummary?: string;
    summaryState?: SessionSummaryState;
    summaryUpdatedAt?: number;
    error?: string;
    waitReason?: string;
    cronActive?: boolean;
    cronInterval?: number;
    cronReason?: string;
    cronKind?: "interval" | "wall-clock";
    cronNextFireAt?: number;
    cronTimezone?: string;
    cronMaxFires?: number;
    cronFiresCompleted?: number;
    pendingQuestion?: { question: string; choices?: string[]; allowFreeform?: boolean };
    result?: string;
    contextUsage?: SessionContextUsage;
    /** customStatusVersion for change tracking. */
    statusVersion?: number;
}

/** Cursor for keyset-paginated session listing. */
export interface SessionPageCursor {
    updatedAt: number;
    sessionId: string;
}

/** Options for bounded management session listing. */
export interface ListSessionsPageOptions {
    limit?: number;
    cursor?: SessionPageCursor | null;
    includeDeleted?: boolean;
}

/** One bounded page of management session views. */
export interface PilotSwarmSessionPage {
    sessions: PilotSwarmSessionView[];
    hasMore: boolean;
    nextCursor?: SessionPageCursor;
}

/** Model summary for UI display. */
export interface ModelSummary {
    qualifiedName: string;
    providerId: string;
    providerType: string;
    modelName: string;
    description?: string;
    cost?: string;
    supportedReasoningEfforts?: ReasoningEffort[];
    defaultReasoningEffort?: ReasoningEffort;
}

/** Credential availability for a configured model provider. */
export interface ModelCredentialStatus {
    qualifiedName?: string;
    providerId?: string;
    providerType?: string;
    credentialAvailable: boolean;
}

/** Status change result from watchSessionStatus. */
export interface SessionStatusChange {
    customStatus: SessionStatusSignal | any;
    customStatusVersion: number;
    orchestrationStatus?: string;
}

/** Per-orchestration runtime stats from duroxide. */
export interface SessionOrchestrationStats {
    orchestrationVersion?: string;
    historyEventCount?: number;
    historySizeBytes?: number;
    queuePendingCount?: number;
    kvUserKeyCount?: number;
    kvTotalValueBytes?: number;
}

/** A single duroxide execution history event. */
export interface ExecutionHistoryEvent {
    eventId: number;
    kind: string;
    sourceEventId?: number;
    timestampMs: number;
    data?: string;
}

/** Options for PilotSwarmManagementClient. */
export interface PilotSwarmManagementClientOptions {
    /** PostgreSQL connection string. PilotSwarm requires PostgreSQL for CMS and facts. */
    store: string;
    /** Resolved storage config. Must match the worker when supplied. */
    storageConfig?: StorageConfig;
    /** PostgreSQL schema for duroxide tables. Default: "ps_duroxide". */
    duroxideSchema?: string;
    /** PostgreSQL schema for CMS tables. Default: "copilot_sessions". */
    cmsSchema?: string;
    /** PostgreSQL schema for durable facts. Default: "pilotswarm_facts". */
    factsSchema?: string;
    /** EnhancedFactStore URL (07 P3) — must match the worker so facts reads/
     * stats target the same store. Unset ⇒ facts on cmsFactsDatabaseUrl ?? store. */
    enhancedFactsDatabaseUrl?: string;
    /** Facts provider selector — must match the worker. */
    factsProvider?: "pg" | "horizon";
    /** Enhanced facts schema — must match the worker's enhancedFactsSchema. */
    enhancedFactsSchema?: string;
    /** Path to model_providers.json. Auto-discovers if not set. */
    modelProvidersPath?: string;
    /** App plugin dirs used to discover app-defined system agents for restart operations. */
    pluginDirs?: string[];
    /** Disable bundled PilotSwarm management agents when discovering restartable system agents. */
    disableManagementAgents?: boolean;
    /** Direct system-agent definitions for restart operations. Mostly useful for tests/embedded hosts. */
    systemAgents?: AgentConfig[];
    /** Whether restarted system-agent orchestrations should enable blob-backed dehydration. */
    blobEnabled?: boolean;
    /** Dehydrate threshold passed to restarted system-agent orchestrations. Defaults to 30. */
    waitThreshold?: number;
    /**
     * Optional trace callback for startup diagnostics.
     * If not provided, trace messages are discarded.
     */
    traceWriter?: (msg: string) => void;
    /**
     * Use AAD/Managed Identity for CMS + facts Postgres pools. Mirrors
     * `PilotSwarmClientOptions.useManagedIdentity`. When `true`,
     * `cmsFactsDatabaseUrl` (or `store`) must be a passwordless URL.
     */
    useManagedIdentity?: boolean;
    /**
     * Optional separate URL for CMS + facts pools. When unset, `store` is
     * reused. Pair with `useManagedIdentity: true` for the passwordless
     * AAD path.
     */
    cmsFactsDatabaseUrl?: string;
    /**
     * Override the AAD principal name used as the Postgres `user` when
     * minting tokens. Only consulted when `useManagedIdentity` is `true`.
     */
    aadDbUser?: string;
}

// ─── Management Client ──────────────────────────────────────────

export class PilotSwarmManagementClient {
    private config!: PilotSwarmManagementClientOptions;
    private _catalog: SessionCatalog | null = null;
    private _factStore: FactStore | null = null;
    private _graphStore: GraphStore | null = null;
    private _duroxideClient: any = null;
    private _modelProviders: ModelProviderRegistry | null = null;
    private _systemAgents: AgentConfig[] = [];
    private _activeStatusWaitControllers = new Set<AbortController>();
    private _activeStatusWaitPromises = new Set<Promise<unknown>>();
    private _started = false;

    constructor(options: PilotSwarmManagementClientOptions | PilotSwarmWebOptions) {
        assertUnambiguousProvider(options, "PilotSwarmManagementClient");
        if (isWebOptions(options)) {
            // Web mode — the supported public mode: talk to a deployment's
            // Web API instead of the datastore. The returned object carries
            // the same management surface (see WebPilotSwarmManagementClient
            // for the few direct-mode-only methods).
            return new WebPilotSwarmManagementClient(options) as unknown as PilotSwarmManagementClient;
        }
        this.config = options;
    }

    // ─── Lifecycle ───────────────────────────────────────────

    async start(): Promise<void> {
        if (this._started) return;
        const store = this.config.store;
        const storage = resolveStorageConfig({ options: this.config });
        const runtimeStorageProvider = getRuntimeStorageProvider(storage.runtime.provider);
        const _trace = this.config.traceWriter ?? (() => {});

        // CMS + facts may use a separate URL when running with AAD/MI
        // (passwordless URL whose `user@` segment is the federated UAMI's
        // display name). Mirrors PilotSwarmClient.start(). The duroxide
        // orchestration store honours the same MI switch via
        // duroxide-node's native Entra path.
        // Create duroxide client
        let provider: any;
        if (store === "sqlite::memory:") provider = SqliteProvider.inMemory();
        else if (store.startsWith("sqlite://")) provider = SqliteProvider.open(store);
        else if (storage.duroxide.url.startsWith("postgres://") || storage.duroxide.url.startsWith("postgresql://")) {
            _trace("[mgmt] duroxide provider connect start...");
            provider = await getDuroxideStorageProvider(storage.duroxide.provider).createDuroxideProvider(storage.duroxide);
            _trace("[mgmt] duroxide provider connect done");
        } else {
            throw new Error(`Unsupported duroxide store URL: ${storage.duroxide.url}`);
        }
        this._duroxideClient = new Client(provider);

        // Create CMS catalog
        _trace("[mgmt] CMS create start...");
        this._catalog = await runtimeStorageProvider.createSessionCatalog(storage.runtime);
        _trace("[mgmt] CMS initialize start...");
        await this._catalog.initialize();
        _trace("[mgmt] CMS initialize done");

        _trace("[mgmt] facts create start...");
        this._factStore = await runtimeStorageProvider.createFactStore(storage.runtime);
        await this._factStore.initialize();
        _trace("[mgmt] facts initialize done");

        // Graph store: SEPARATE, opt-in provider — present iff graph is
        // configured (mirrors the worker; see worker.ts). A failed init leaves
        // graph disabled without taking down facts.
        if (storage.runtime.graph?.enabled && runtimeStorageProvider.createGraphStore) {
            let candidate: GraphStore | undefined;
            try {
                candidate = await runtimeStorageProvider.createGraphStore(storage.runtime);
                if (candidate) await candidate.initialize();
                this._graphStore = candidate ?? null;
            } catch (err) {
                await candidate?.close().catch(() => {});
                this._graphStore = null;
                _trace(`[mgmt] graph store init failed (graph API disabled): ${(err as any)?.message ?? err}`);
            }
        }

        // Load model providers
        this._modelProviders = loadModelProviders(this.config.modelProvidersPath);
        this._systemAgents = loadSystemAgentConfigs({
            pluginDirs: this.config.pluginDirs,
            disableManagementAgents: this.config.disableManagementAgents,
            systemAgents: this.config.systemAgents,
        });

        this._started = true;
    }

    async stop(): Promise<void> {
        for (const controller of [...this._activeStatusWaitControllers]) {
            controller.abort(createAbortError("PilotSwarmManagementClient stopped"));
        }
        await Promise.allSettled([...this._activeStatusWaitPromises]);

        if (this._graphStore) {
            try { await this._graphStore.close(); } catch {}
            this._graphStore = null;
        }
        if (this._factStore) {
            try { await this._factStore.close(); } catch {}
            this._factStore = null;
        }
        if (this._catalog) {
            try { await this._catalog.close(); } catch {}
            this._catalog = null;
        }
        this._duroxideClient = null;
        this._started = false;
    }

    private async _readJsonValue<T>(sessionId: string, key: string): Promise<T | null> {
        try {
            const raw = await this._duroxideClient.getValue(`session-${sessionId}`, key);
            if (!raw) return null;
            return typeof raw === "string" ? JSON.parse(raw) : raw;
        } catch {
            return null;
        }
    }

    private async _waitForSession(
        sessionId: string,
        predicate: (session: PilotSwarmSessionView | null) => boolean,
        timeoutMs: number,
    ): Promise<PilotSwarmSessionView | null> {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            const session = await this.getSession(sessionId).catch(() => null);
            if (predicate(session)) return session;

            const remainingMs = deadline - Date.now();
            if (remainingMs <= 0) break;
            await sleep(Math.min(SESSION_STATE_POLL_MS, remainingMs));
        }

        throw new Error(`Timed out waiting for session ${sessionId.slice(0, 8)} to settle`);
    }

    private async _forceDeleteSession(sessionId: string, reason?: string): Promise<void> {
        const session = await this._catalog!.getSession(sessionId);
        if (session?.isSystem) {
            throw new Error("Cannot delete system session");
        }

        // Set terminal state in CMS before soft-delete so any last read picks it up
        await this._catalog!.updateSession(sessionId, {
            state: "failed",
            lastError: reason ?? "Deleted by management client",
            waitReason: null,
        }).catch(() => {});

        await this._catalog!.softDeleteSession(sessionId);

        if (this._factStore) {
            try {
                await this._factStore.deleteSessionFactsForSession(sessionId);
            } catch (err) {
                console.error(`[PilotSwarmManagementClient] session fact cleanup failed for ${sessionId}:`, err);
            }
        }

        try {
            await this._duroxideClient.deleteInstance(`session-${sessionId}`, true);
        } catch {}
    }

    private _getSystemAgentPlans(): SystemAgentSessionPlan[] {
        return resolveSystemAgentSessionPlans(this._systemAgents);
    }

    private _resolveSystemAgentPlan(agentIdOrSessionId: string): SystemAgentSessionPlan {
        const target = String(agentIdOrSessionId || "").trim();
        if (!target) throw new Error("System agent id or session id is required");
        const plans = this._getSystemAgentPlans();
        const plan = plans.find((candidate) =>
            candidate.agent.id === target ||
            candidate.agent.name === target ||
            candidate.sessionId === target ||
            `session-${candidate.sessionId}` === target);
        if (!plan) {
            throw new Error(
                `System agent "${target}" is not known to this management client. ` +
                `Configure pluginDirs/systemAgents so the client can recreate the system session.`,
            );
        }
        return plan;
    }

    private async _archiveSystemSessionForRestart(
        sessionId: string,
        state: "completed" | "cancelled" | "failed",
        reason: string,
    ): Promise<void> {
        await this._catalog!.archiveSystemSessionForRestart(
            sessionId,
            state,
            state === "completed" ? null : reason,
        );

        if (this._factStore) {
            try {
                await this._factStore.deleteSessionFactsForSession(sessionId);
            } catch (err) {
                console.error(`[PilotSwarmManagementClient] system-session fact cleanup failed for ${sessionId}:`, err);
            }
        }
    }

    private async _deleteSystemOrchestrationInstance(sessionId: string): Promise<void> {
        try {
            await this._duroxideClient.deleteInstance(`session-${sessionId}`, true);
        } catch {}
    }

    private async _terminateSystemOrchestrationInstance(sessionId: string, reason: string): Promise<void> {
        try {
            await this._duroxideClient.cancelInstance(`session-${sessionId}`, reason);
        } catch (err) {
            if (!isIgnorableCancelError(err)) throw err;
        }
        await this._deleteSystemOrchestrationInstance(sessionId);
    }

    // ─── Session Listing ─────────────────────────────────────

    /**
     * List all sessions with merged CMS + orchestration state.
     * Returns a ready-to-render view model.
     *
     * **Optimized path**: reads entirely from CMS (single SQL query).
     * Live status is kept up-to-date by activity-level writeback in
     * the runTurn activity (session-proxy). For real-time status of a
     * single session, use getSession() which still hits duroxide.
     */
    async listSessions(): Promise<PilotSwarmSessionView[]> {
        this._ensureStarted();

        // Single CMS query — no duroxide fan-out
        const cmsSessions = await this._catalog!.listSessions();

        return cmsSessions.map(sessionViewFromCmsRow);
    }

    /**
     * List one bounded page of sessions with merged CMS state.
     *
     * Uses CMS keyset pagination. For real-time status of a single session,
     * use getSession() which still reads duroxide runtime state.
     */
    async listSessionsPage(opts: ListSessionsPageOptions = {}): Promise<PilotSwarmSessionPage> {
        this._ensureStarted();

        const limit = clampInteger(opts.limit, DEFAULT_SESSION_PAGE_LIMIT, 1, MAX_SESSION_PAGE_LIMIT);
        const cursor = opts.cursor ?? null;
        let cursorUpdatedAt: Date | null = null;
        let cursorSessionId: string | null = null;

        if (cursor) {
            cursorUpdatedAt = new Date(cursor.updatedAt);
            assertValidDate(cursorUpdatedAt, "cursor.updatedAt");
            cursorSessionId = String(cursor.sessionId || "").trim();
            if (!cursorSessionId) throw new Error("cursor.sessionId must be a non-empty string");
        }

        const rows = await this._catalog!.listSessionsPage({
            limit: limit + 1,
            cursorUpdatedAt,
            cursorSessionId,
            includeDeleted: opts.includeDeleted,
        });
        const visibleRows = rows.slice(0, limit);
        const hasMore = rows.length > limit;
        const last = visibleRows[visibleRows.length - 1];

        return {
            sessions: visibleRows.map(sessionViewFromCmsRow),
            hasMore,
            ...(hasMore && last
                ? { nextCursor: { updatedAt: last.updatedAt.getTime(), sessionId: last.sessionId } }
                : {}),
        };
    }

    /**
     * Get a single session view by ID.
     */
    async getSession(sessionId: string): Promise<PilotSwarmSessionView | null> {
        this._ensureStarted();
        const row = await this._catalog!.getSession(sessionId);
        if (!row) return null;

        const orchId = `session-${sessionId}`;
        let orchStatus = "Unknown";
        let orchestrationVersion: string | undefined;
        let createdAt = row.createdAt.getTime();
        let customStatus: any = {};
        let statusVersion = 0;
        let latestResponse: SessionResponsePayload | null = null;

        const [infoResult, statusResult] = await Promise.allSettled([
            this._duroxideClient.getInstanceInfo(orchId),
            this._duroxideClient.getStatus(orchId),
        ]);

        if (infoResult.status === "fulfilled") {
            const info = infoResult.value;
            orchStatus = info?.status || "Unknown";
            if (typeof info?.orchestrationVersion === "string" && info.orchestrationVersion.trim()) {
                orchestrationVersion = info.orchestrationVersion;
            }
        }

        if (statusResult.status === "fulfilled") {
            const status = statusResult.value;
            statusVersion = status?.customStatusVersion || 0;
            if (status?.customStatus) {
                try {
                    customStatus = typeof status.customStatus === "string"
                        ? JSON.parse(status.customStatus)
                        : status.customStatus;
                } catch {}
            }
            if (customStatus?.responseVersion) {
                latestResponse = await this._readJsonValue<SessionResponsePayload>(sessionId, RESPONSE_LATEST_KEY);
            }
        }

        const terminalOrchestration = isTerminalOrchestrationStatus(orchStatus);
        const rawCronActive = customStatus.cronActive === true;
        const rawCronInterval = typeof customStatus.cronInterval === "number" ? customStatus.cronInterval : undefined;
        const cronActive = terminalOrchestration ? false : rawCronActive;
        const cronInterval = terminalOrchestration ? undefined : rawCronInterval;
        const cronKind = cronActive && (customStatus.cronKind === "wall-clock" || customStatus.cronKind === "interval")
            ? customStatus.cronKind
            : undefined;
        const cronNextFireAt = cronActive && typeof customStatus.cronNextFireAt === "number"
            ? customStatus.cronNextFireAt
            : undefined;
        const cronTimezone = cronActive && typeof customStatus.cronTimezone === "string"
            ? customStatus.cronTimezone
            : undefined;
        const cronMaxFires = cronActive && typeof customStatus.cronMaxFires === "number"
            ? customStatus.cronMaxFires
            : undefined;
        const cronFiresCompleted = cronActive && typeof customStatus.cronFiresCompleted === "number"
            ? customStatus.cronFiresCompleted
            : undefined;
        const normalizedCustomStatus = {
            ...customStatus,
            cronActive,
            cronInterval,
            cronKind,
            cronNextFireAt,
            cronTimezone,
            cronMaxFires,
            cronFiresCompleted,
            contextUsage: customStatus?.contextUsage,
        };
        const normalizedContextUsage = terminalOrchestration
            ? stripRunningCompaction(normalizedCustomStatus.contextUsage as SessionContextUsage | undefined)
            : cloneContextUsage(normalizedCustomStatus.contextUsage as SessionContextUsage | undefined);
        normalizedCustomStatus.contextUsage = normalizedContextUsage;
        const liveStatus = deriveStatusFromCmsAndRuntime({
            row,
            customStatus: normalizedCustomStatus,
            latestResponse,
            orchestrationStatus: orchStatus,
        });

        const terminalStatusInput = {
            parentSessionId: row.parentSessionId,
            isSystem: row.isSystem,
            rowState: row.state,
            status: normalizedCustomStatus?.status,
            orchestrationStatus: orchStatus,
            cronActive,
            cronInterval,
            turnResultType: normalizedCustomStatus?.turnResult?.type,
            latestResponseType: latestResponse?.type,
        };

        if (shouldSyncCompletedStatus(terminalStatusInput)) {
            await this._catalog!.updateSession(sessionId, {
                state: "completed",
                lastError: null,
                waitReason: null,
            }).catch(() => {});
        } else if (shouldSyncFailedStatus(terminalStatusInput)) {
            const failureMessage =
                (typeof customStatus?.error === "string" && customStatus.error.trim())
                    ? customStatus.error.trim()
                    : (typeof row.lastError === "string" && row.lastError.trim())
                        ? row.lastError.trim()
                        : null;
            await this._catalog!.updateSession(sessionId, {
                state: "failed",
                waitReason: null,
                ...(failureMessage ? { lastError: failureMessage } : {}),
            }).catch(() => {});
        } else if (
            orchStatus === "Running"
            && (row.state === "error" || row.state === "failed")
        ) {
            const recoveredState =
                typeof customStatus?.status === "string"
                    && customStatus.status !== "error"
                    && customStatus.status !== "failed"
                    ? customStatus.status
                    : "running";
            await this._catalog!.updateSession(sessionId, {
                state: recoveredState,
                lastError: null,
                ...(recoveredState === "waiting" || recoveredState === "input_required"
                    ? {}
                    : { waitReason: null }),
            }).catch(() => {});
        }

        const effectiveError = (liveStatus === "error" || liveStatus === "failed")
            ? (customStatus.error ?? row.lastError ?? undefined)
            : undefined;

        return {
            sessionId: row.sessionId,
            title: row.title ?? undefined,
            agentId: row.agentId ?? undefined,
            splash: row.splash ?? undefined,
            splashMobile: row.splashMobile ?? undefined,
            owner: row.owner ?? undefined,
            status: liveStatus,
            orchestrationStatus: orchStatus,
            orchestrationVersion,
            createdAt,
            updatedAt: row.updatedAt?.getTime(),
            iterations: customStatus.iteration ?? row.currentIteration ?? 0,
            parentSessionId: row.parentSessionId ?? undefined,
            groupId: row.groupId ?? undefined,
            isSystem: row.isSystem || undefined,
            model: row.model ?? undefined,
            reasoningEffort: row.reasoningEffort ?? undefined,
            shortSummary: row.shortSummary ?? undefined,
            summaryState: row.summaryState ?? undefined,
            summaryUpdatedAt: row.summaryUpdatedAt?.getTime(),
            error: effectiveError,
            waitReason: normalizedCustomStatus.waitReason,
            cronActive,
            cronInterval,
            cronKind,
            cronNextFireAt,
            cronTimezone,
            cronMaxFires,
            cronFiresCompleted,
            cronReason: cronActive && typeof normalizedCustomStatus.cronReason === "string"
                ? normalizedCustomStatus.cronReason
                : undefined,
            pendingQuestion: normalizedCustomStatus.pendingQuestion
                ? {
                    question: normalizedCustomStatus.pendingQuestion,
                    choices: normalizedCustomStatus.choices,
                    allowFreeform: normalizedCustomStatus.allowFreeform,
                }
                    : latestResponse?.type === "input_required" && latestResponse.question
                    ? {
                        question: latestResponse.question,
                        choices: latestResponse.choices,
                        allowFreeform: latestResponse.allowFreeform,
                    }
                    : undefined,
            result: normalizedCustomStatus.turnResult?.type === "completed"
                ? normalizedCustomStatus.turnResult.content
                : latestResponse?.type === "completed"
                    ? latestResponse.content
                    : undefined,
            contextUsage: normalizedContextUsage,
            statusVersion,
        };
    }

    // ─── Child Contracts / Outcomes ────────────────────────

    async getChildOutcome(childSessionId: string): Promise<ChildOutcomeRow | null> {
        this._ensureStarted();
        return this._catalog!.getChildOutcome(childSessionId);
    }

    async listChildOutcomes(parentSessionId: string): Promise<ChildOutcomeRow[]> {
        this._ensureStarted();
        return this._catalog!.listChildOutcomes(parentSessionId);
    }

    // ─── Session Groups ─────────────────────────────────────

    async createSessionGroup(input: {
        groupId?: string;
        title: string;
        description?: string | null;
        owner?: SessionOwnerInfo | null;
        metadata?: Record<string, unknown>;
    }): Promise<SessionGroupRow> {
        this._ensureStarted();
        const groupId = input.groupId ?? crypto.randomUUID();
        await this._catalog!.createSessionGroup({
            groupId,
            title: input.title,
            description: input.description ?? null,
            owner: input.owner ?? null,
            metadata: input.metadata ?? {},
        });
        const created = (await this._catalog!.listSessionGroups()).find((group) => group.groupId === groupId);
        if (!created) throw new Error(`Session group ${groupId} was not created.`);
        return created;
    }

    async listSessionGroups(): Promise<SessionGroupRow[]> {
        this._ensureStarted();
        return this._catalog!.listSessionGroups();
    }

    async listGroupSessions(groupId: string): Promise<PilotSwarmSessionView[]> {
        this._ensureStarted();
        const rows = await this._catalog!.listGroupSessions(groupId);
        return rows.map(sessionViewFromCmsRow);
    }

    async updateSessionGroup(groupId: string, patch: { title?: string; description?: string | null; metadataPatch?: Record<string, unknown> }): Promise<SessionGroupRow> {
        this._ensureStarted();
        await this._catalog!.updateSessionGroup(groupId, patch);
        const updated = (await this._catalog!.listSessionGroups()).find((group) => group.groupId === groupId);
        if (!updated) throw new Error(`Session group ${groupId} was not found.`);
        return updated;
    }

    async moveSessionsToGroup(groupId: string | null, sessionIds: string[]): Promise<void> {
        this._ensureStarted();
        const normalizedGroupId = groupId == null ? null : String(groupId || "").trim();
        let targetGroup: SessionGroupRow | null = null;
        if (normalizedGroupId) {
            targetGroup = (await this._catalog!.listSessionGroups()).find((candidate) => candidate.groupId === normalizedGroupId) ?? null;
            if (!targetGroup) throw new Error(`Session group ${normalizedGroupId} was not found.`);
        }

        const uniqueIds = Array.from(new Set((Array.isArray(sessionIds) ? sessionIds : []).map((id) => String(id || "").trim()).filter(Boolean)));
        const movableSessions: SessionRow[] = [];
        for (const sessionId of uniqueIds) {
            const session = await this._catalog!.getSession(sessionId);
            if (!session || session.isSystem) continue;
            movableSessions.push(session);
        }

        if (targetGroup) {
            const groupOwnerKey = ownerKeyForOwner(targetGroup.owner);
            const sessionOwnerKeys = new Set(movableSessions.map((session) => ownerKeyForOwner(session.owner) || ""));
            const canAdoptOwner = !groupOwnerKey
                && (targetGroup.memberCount ?? 0) === 0
                && sessionOwnerKeys.size === 1
                && Boolean(sessionOwnerKeys.values().next().value);
            const mismatch = canAdoptOwner
                ? null
                : movableSessions.find((session) => ownerKeyForOwner(session.owner) !== groupOwnerKey);
            if (mismatch) {
                throw new Error(
                    `Cannot move session ${mismatch.sessionId.slice(0, 8)} owned by ${ownerLabel(mismatch.owner)} ` +
                    `into group ${targetGroup.title || targetGroup.groupId} owned by ${ownerLabel(targetGroup.owner)}.`,
                );
            }
            if (canAdoptOwner) {
                const ownerToAdopt = movableSessions.find((session) => session.owner)?.owner ?? null;
                if (ownerToAdopt) {
                    await this._catalog!.updateSessionGroup(targetGroup.groupId, { owner: ownerToAdopt });
                }
            }
        }

        for (const session of movableSessions) {
            await this._catalog!.updateSession(session.sessionId, { groupId: normalizedGroupId || null });
        }
    }

    async assignSessionsToGroup(groupId: string, sessionIds: string[]): Promise<void> {
        await this.moveSessionsToGroup(groupId, sessionIds);
    }

    async completeSessionGroup(groupId: string, options?: { reason?: string }): Promise<void> {
        this._ensureStarted();
        void groupId;
        void options;
        throw new Error("Session groups are containers only; complete sessions individually.");
    }

    async cancelSessionGroup(groupId: string, reason?: string): Promise<void> {
        this._ensureStarted();
        void groupId;
        void reason;
        throw new Error("Session groups are containers only; cancel sessions individually.");
    }

    async deleteSessionGroup(groupId: string, reason?: string): Promise<void> {
        this._ensureStarted();
        const members = await this._catalog!.listGroupSessions(groupId);
        void reason;
        if (members.length > 0) {
            throw new Error(`Cannot delete session group ${groupId}; move ${members.length} member session(s) out first.`);
        }
        const deleted = await this._catalog!.deleteSessionGroup(groupId);
        if (!deleted) {
            throw new Error(`Cannot delete session group ${groupId}; member sessions remain.`);
        }
    }

    // ─── Session Actions ─────────────────────────────────────

    async completeSession(sessionId: string, reason?: string): Promise<void> {
        this._ensureStarted();
        const session = await this.getSession(sessionId);
        if (!session) return;
        if (session.isSystem) {
            throw new Error("Cannot complete system session");
        }
        if (session.status === "completed") return;
        if (session.status === "cancelled" || session.status === "failed") return;

        const doneReason = reason ?? "Completed by management client";
        await this.sendCommand(sessionId, {
            cmd: "done",
            id: buildLifecycleCommandId("done"),
            args: { reason: doneReason },
        });

        await this._waitForSession(
            sessionId,
            (current) => current != null && (current.status === "completed" || current.status === "failed" || current.status === "cancelled"),
            SESSION_COMMAND_SETTLE_TIMEOUT_MS,
        );
    }

    /**
     * Rename a session. Updates the title in CMS.
     */
    async renameSession(sessionId: string, title: string): Promise<void> {
        this._ensureStarted();
        const session = await this._catalog!.getSession(sessionId);
        if (!session) {
            throw new Error(`Session ${sessionId.slice(0, 8)} was not found.`);
        }
        if (session.isSystem) {
            throw new Error("System session titles are fixed");
        }

        const storedTitle = buildStoredSessionTitle(session, title);
        if (!storedTitle) {
            throw new Error("Title cannot be empty");
        }

        await this._catalog!.updateSession(sessionId, {
            title: storedTitle,
            titleLocked: true,
        });
    }

    /**
     * Cancel a session's orchestration.
     * Refuses to cancel system sessions.
     */
    async cancelSession(sessionId: string, reason?: string): Promise<void> {
        this._ensureStarted();
        const session = await this.getSession(sessionId);
        if (!session) return;
        if (session.isSystem) {
            throw new Error("Cannot cancel system session");
        }
        if (session.status === "cancelled" || session.status === "failed" || session.status === "completed") {
            return;
        }

        const cancelReason = reason ?? "Cancelled by management client";
        await this.sendCommand(sessionId, {
            cmd: "cancel",
            id: buildLifecycleCommandId("cancel"),
            args: { reason: cancelReason },
        });

        await this._waitForSession(
            sessionId,
            (current) => current != null && (current.status === "cancelled" || current.status === "failed" || current.status === "completed"),
            SESSION_COMMAND_SETTLE_TIMEOUT_MS,
        );
    }

    /**
     * Delete a session: cancel orchestration + soft-delete from CMS.
     * Refuses to delete system sessions.
     */
    async deleteSession(sessionId: string, reason?: string): Promise<void> {
        this._ensureStarted();
        const session = await this.getSession(sessionId);
        if (!session) return;
        if (session.isSystem) {
            throw new Error("Cannot delete system session");
        }
        const deleteReason = reason ?? "Deleted by management client";

        if (
            session.status === "pending"
            || session.orchestrationStatus === "Unknown"
            || session.orchestrationStatus == null
            || session.status === "completed"
            || session.status === "failed"
            || session.status === "cancelled"
            || isTerminalOrchestrationStatus(session.orchestrationStatus)
        ) {
            await this._forceDeleteSession(sessionId, deleteReason);
            return;
        }

        await this.sendCommand(sessionId, {
            cmd: "delete",
            id: buildLifecycleCommandId("delete"),
            args: { reason: deleteReason },
        });

        await this._waitForSession(
            sessionId,
            (current) => current == null,
            SESSION_COMMAND_SETTLE_TIMEOUT_MS,
        );
    }

    /**
     * Switch a session's model (and optionally reasoning effort) at the next
     * turn boundary. Applies via the durable set_model command; never affects an
     * in-flight turn. Allowed for system sessions too.
     */
    async setSessionModel(
        sessionId: string,
        model: string,
        opts?: { reasoningEffort?: ReasoningEffort | null; source?: string },
    ): Promise<void> {
        this._ensureStarted();
        const trimmed = String(model || "").trim();
        if (!trimmed) throw new Error("setSessionModel requires a model id");
        const models = this.listModels();
        const match = models.find((m) => m.qualifiedName === trimmed);
        if (!match) throw new Error(`Unknown model: ${trimmed}`);
        // Reasoning effort is applied ONLY when the caller asked for one.
        // When omitted, the key is left out of the command args entirely so
        // the orchestration's set_model handler PRESERVES the session's
        // current effort (args.reasoningEffort === undefined → keep old).
        // Injecting the model descriptor's defaultReasoningEffort here used
        // to silently override the session's effort on every switch.
        const hasExplicitEffort = !!opts && "reasoningEffort" in opts;
        const nextReasoningEffort = hasExplicitEffort ? (opts!.reasoningEffort ?? null) : undefined;
        if (nextReasoningEffort) {
            const supported = match.supportedReasoningEfforts ?? [];
            if (!supported.includes(nextReasoningEffort)) {
                throw new Error(`Model ${trimmed} does not support reasoning effort '${nextReasoningEffort}'`);
            }
        }
        const session = await this.getSession(sessionId).catch(() => null);
        if (!session) throw new Error(`Session ${sessionId.slice(0, 8)} was not found`);
        await this.sendCommand(sessionId, {
            cmd: "set_model",
            id: buildLifecycleCommandId("set-model"),
            args: {
                model: trimmed,
                ...(hasExplicitEffort ? { reasoningEffort: nextReasoningEffort } : {}),
                source: opts?.source ?? "user",
            },
        });
    }

    /**
     * Stop the session's in-flight LLM turn without completing, cancelling,
     * or deleting the session (stop-turn plan,
     * docs/proposals-impl/stop-button-turn-abort-plan.md).
     *
     * Enqueues a stop event on the TURN-SCOPED stop queue
     * (stopTurn.<activeTurnIndex>) that the session orchestration races
     * against the in-flight runTurn activity, then polls the KV
     * command-response channel for the outcome. Valid for system sessions
     * too; only group/container rows are not sessions and cannot be stopped.
     *
     * Outcomes:
     *  - stopped / stop_forced: the turn was aborted mid-flight; session idle.
     *  - no_active_turn: nothing was running (idempotent no-op).
     *  - timeout: no response before timeoutMs — the stop may still land;
     *    refresh session state rather than assuming failure.
     */
    async stopSessionTurn(
        sessionId: string,
        opts?: { reason?: string; timeoutMs?: number },
    ): Promise<StopTurnResult> {
        this._ensureStarted();
        const row = await this._catalog!.getSession(sessionId).catch(() => null);
        if (!row || row.deletedAt) {
            return { outcome: "no_active_turn", detail: "session not found" };
        }
        const turnIndex = row.activeTurnIndex;
        if (row.state !== "running" || turnIndex == null) {
            return {
                outcome: "no_active_turn",
                detail: `session is not running a turn (state=${row.state})`,
            };
        }

        const orchId = `session-${sessionId}`;
        await this._assertOrchestrationLive(orchId, sessionId, "stopSessionTurn");
        const id = buildLifecycleCommandId("stop-turn");
        await this._duroxideClient.enqueueEvent(
            orchId,
            stopTurnQueueName(turnIndex),
            JSON.stringify({
                id,
                reason: opts?.reason ?? "Stopped by user",
                requestedAt: Date.now(),
            }),
        );

        const timeoutMs = opts?.timeoutMs ?? 30_000;
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            const resp = await this.getCommandResponse(sessionId, id).catch(() => null);
            if (resp) {
                if (resp.error) {
                    return { outcome: "no_active_turn", turnIndex, detail: resp.error };
                }
                const result = (resp.result ?? {}) as Partial<StopTurnResult>;
                return {
                    outcome: result.outcome ?? "stopped",
                    turnIndex: result.turnIndex ?? turnIndex,
                    ...(result.detail ? { detail: result.detail } : {}),
                };
            }
            await sleep(400);
        }
        // If the turn ended between the CMS read and the enqueue, the stop
        // event rots unread in a dead turn-scoped queue (harmless) and no
        // response will ever appear.
        return {
            outcome: "timeout",
            turnIndex,
            detail: "no stop response before timeout; refresh session state",
        };
    }

    async restartSystemSession(
        agentIdOrSessionId: string,
        options: RestartSystemSessionOptions,
    ): Promise<RestartSystemSessionResult> {
        this._ensureStarted();
        if (!options?.disposition) {
            throw new Error("restartSystemSession requires a disposition: complete, terminate, or hard_delete");
        }

        const disposition = normalizeSystemRestartDisposition(options.disposition);
        const plan = this._resolveSystemAgentPlan(agentIdOrSessionId);
        const sessionId = plan.sessionId;
        const reason = options.reason ?? `Restarting system session ${plan.agent.id}`;
        const existingRow = await this._catalog!.getSession(sessionId);
        const previousSessionExisted = Boolean(existingRow);

        if (existingRow && !existingRow.isSystem) {
            throw new Error(`Session ${sessionId.slice(0, 8)} exists but is not a system session`);
        }

        if (existingRow) {
            if (disposition === "complete") {
                const view = await this.getSession(sessionId).catch(() => null);
                if (view && view.status !== "completed" && view.status !== "failed" && view.status !== "cancelled") {
                    try {
                        await this.sendCommand(sessionId, {
                            cmd: "done",
                            id: buildLifecycleCommandId("done-system-restart"),
                            args: { reason },
                        });
                        await this._waitForSession(
                            sessionId,
                            (current) => current != null && (current.status === "completed" || current.status === "failed" || current.status === "cancelled"),
                            options.timeoutMs ?? SESSION_COMMAND_SETTLE_TIMEOUT_MS,
                        );
                    } catch (err) {
                        if (!isIgnorableRestartCommandError(err)) throw err;
                    }
                }
                await this._deleteSystemOrchestrationInstance(sessionId);
                await this._archiveSystemSessionForRestart(sessionId, "completed", reason);
            } else if (disposition === "terminate") {
                await this._terminateSystemOrchestrationInstance(sessionId, reason);
                await this._archiveSystemSessionForRestart(sessionId, "cancelled", `Terminated for restart: ${reason}`);
            } else {
                await this._deleteSystemOrchestrationInstance(sessionId);
                await this._archiveSystemSessionForRestart(sessionId, "failed", `Hard-deleted for restart: ${reason}`);
            }
        }

        const defaultModel = options.model ?? this._modelProviders?.defaultModel ?? existingRow?.model;
        if (!defaultModel) {
            throw new Error("Cannot restart system session without a configured default model");
        }

        const startResults = await startSystemAgents({
            catalog: this._catalog!,
            duroxideClient: this._duroxideClient,
            agents: this._systemAgents,
            defaultModel,
            ...(options.reasoningEffort ? { defaultReasoningEffort: options.reasoningEffort } : {}),
            blobEnabled: this.config.blobEnabled,
            dehydrateThreshold: this.config.waitThreshold ?? DEFAULT_SYSTEM_AGENT_DEHYDRATE_THRESHOLD,
            agentId: plan.agent.id,
        });
        const newSession = await this.getSession(sessionId).catch(() => null);
        if (!newSession) {
            throw new Error(`System session ${plan.agent.id} was not recreated`);
        }

        return {
            agentId: plan.agent.id,
            agentName: plan.agent.name,
            sessionId,
            disposition,
            previousSessionExisted,
            startResults,
        };
    }

    // ─── Session Events ──────────────────────────────────────

    /**
     * Get a provider-capped page of CMS events for a session, ordered by seq.
     * Without afterSeq this returns the latest page; with afterSeq it returns the next forward page.
     * Use getSessionEventsBefore() paging to drain complete history.
     * eventTypes narrows the page to those event types server-side (e.g. chat
     * message types for transcript paging); omit for the full stream.
     */
    async getSessionEvents(sessionId: string, afterSeq?: number, limit?: number, eventTypes?: string[]): Promise<import("./cms.js").SessionEvent[]> {
        this._ensureStarted();
        return this._catalog!.getSessionEvents(sessionId, afterSeq, limit, eventTypes);
    }

    /**
     * Graph-search forensics (enhancedfactstore 07 P4): the `graph.searched`
     * events a session emitted — what graph queries it ran and how many results
     * each returned. Powers the agent-tuner graph-debug skill. Reads the latest
     * page of session events and filters to `graph.searched`.
     */
    async getSessionGraphSearches(sessionId: string, limit?: number): Promise<Array<{ seq: number; at: string; kind: string; query: unknown; resultCount: number }>> {
        this._ensureStarted();
        // Pull a generous page and filter; graph searches are sparse vs. all events.
        const events = await this._catalog!.getSessionEvents(sessionId, undefined, limit ?? 500);
        return events
            .filter((e: any) => e.eventType === "graph.searched")
            .map((e: any) => {
                const d = e.data ?? {};
                return { seq: e.seq, at: d.at ?? "", kind: d.kind ?? "", query: d.query, resultCount: d.resultCount ?? 0 };
            });
    }

    /**
     * Get a provider-capped older page before a sequence number, ordered by seq.
     * Call repeatedly with the oldest returned seq to drain complete history.
     */
    async getSessionEventsBefore(sessionId: string, beforeSeq: number, limit?: number, eventTypes?: string[]): Promise<import("./cms.js").SessionEvent[]> {
        this._ensureStarted();
        return this._catalog!.getSessionEventsBefore(sessionId, beforeSeq, limit, eventTypes);
    }

    /**
     * Get bounded event-emitter diagnostics for noisy worker/event buckets.
     */
    async getTopEventEmitters(opts: { since: Date; limit?: number }): Promise<TopEventEmitterRow[]> {
        this._ensureStarted();
        assertValidDate(opts.since, "since");
        const limit = clampInteger(opts.limit, DEFAULT_TOP_EVENT_EMITTER_LIMIT, 1, MAX_TOP_EVENT_EMITTER_LIMIT);
        return this._catalog!.getTopEventEmitters(opts.since, limit);
    }

    // ─── Status Watching ─────────────────────────────────────

    /**
     * Get current orchestration status for a session.
     * Returns parsed customStatus + orchestration status.
     */
    async getSessionStatus(sessionId: string): Promise<SessionStatusChange> {
        this._ensureStarted();
        const orchId = `session-${sessionId}`;
        const status = await this._duroxideClient.getStatus(orchId);
        let customStatus: any = null;
        if (status.customStatus) {
            try {
                customStatus = typeof status.customStatus === "string"
                    ? JSON.parse(status.customStatus)
                    : status.customStatus;
            } catch {}
        }
        return {
            customStatus,
            customStatusVersion: status.customStatusVersion || 0,
            orchestrationStatus: status.status,
        };
    }

    /**
     * Get per-orchestration runtime stats for a session, when supported by the provider.
     */
    async getOrchestrationStats(sessionId: string): Promise<SessionOrchestrationStats | null> {
        this._ensureStarted();
        const orchId = `session-${sessionId}`;
        const [statsResult, infoResult] = await Promise.allSettled([
            this._duroxideClient.getOrchestrationStats(orchId),
            this._duroxideClient.getInstanceInfo(orchId),
        ]);

        const output: SessionOrchestrationStats = {};

        if (statsResult.status === "fulfilled") {
            const stats = statsResult.value;
            if (stats && typeof stats === "object") {
                const historyEventCount = Number(stats.historyEventCount);
                if (Number.isFinite(historyEventCount)) output.historyEventCount = historyEventCount;

                const historySizeBytes = Number(stats.historySizeBytes);
                if (Number.isFinite(historySizeBytes)) output.historySizeBytes = historySizeBytes;

                const queuePendingCount = Number(stats.queuePendingCount);
                if (Number.isFinite(queuePendingCount)) output.queuePendingCount = queuePendingCount;

                const kvUserKeyCount = Number(stats.kvUserKeyCount);
                if (Number.isFinite(kvUserKeyCount)) output.kvUserKeyCount = kvUserKeyCount;

                const kvTotalValueBytes = Number(stats.kvTotalValueBytes);
                if (Number.isFinite(kvTotalValueBytes)) output.kvTotalValueBytes = kvTotalValueBytes;
            }
        }

        if (infoResult.status === "fulfilled") {
            const info = infoResult.value;
            if (info && typeof info.orchestrationVersion === "string" && info.orchestrationVersion.trim()) {
                output.orchestrationVersion = info.orchestrationVersion;
            }
        }

        return Object.keys(output).length > 0 ? output : null;
    }

    /**
     * Read the duroxide execution history for a session's current (or specified) execution.
     * Returns the raw event list from the duroxide orchestration engine.
     */
    async getExecutionHistory(sessionId: string, executionId?: number): Promise<ExecutionHistoryEvent[] | null> {
        this._ensureStarted();
        const orchId = `session-${sessionId}`;
        try {
            let execId = executionId;
            if (execId == null) {
                const executions: number[] = await this._duroxideClient.listExecutions(orchId);
                if (!Array.isArray(executions) || executions.length === 0) return null;
                execId = executions[executions.length - 1];
            }
            const events = await this._duroxideClient.readExecutionHistory(orchId, execId);
            if (!Array.isArray(events)) return null;
            return events.map((e: any) => ({
                eventId: Number(e.eventId) || 0,
                kind: String(e.kind || ""),
                ...(e.sourceEventId != null ? { sourceEventId: Number(e.sourceEventId) } : {}),
                timestampMs: Number(e.timestampMs) || 0,
                ...(e.data != null ? { data: String(e.data) } : {}),
            }));
        } catch {
            return null;
        }
    }

    /**
     * Get the latest KV-backed response payload for a session.
     */
    async getLatestResponse(sessionId: string): Promise<SessionResponsePayload | null> {
        this._ensureStarted();
        return this._readJsonValue<SessionResponsePayload>(sessionId, RESPONSE_LATEST_KEY);
    }

    // ── Session Metric Summaries ──────────────────────────────

    async getSessionMetricSummary(sessionId: string): Promise<SessionMetricSummary | null> {
        this._ensureStarted();
        return this._catalog!.getSessionMetricSummary(sessionId);
    }

    /** Per-session token totals grouped by provider:model:reasoning, with turn count. */
    async getSessionTokensByModel(sessionId: string): Promise<TokensByModelRow[]> {
        this._ensureStarted();
        return this._catalog!.getSessionTokensByModel(sessionId);
    }

    async getSessionTreeStats(sessionId: string): Promise<SessionTreeStats | null> {
        this._ensureStarted();
        return this._catalog!.getSessionTreeStats(sessionId);
    }

    async getFleetStats(opts?: { includeDeleted?: boolean; since?: Date }): Promise<FleetStats> {
        this._ensureStarted();
        return this._catalog!.getFleetStats(opts);
    }

    async getUserStats(opts?: { includeDeleted?: boolean; since?: Date }): Promise<UserStats> {
        this._ensureStarted();
        const stats = await this._catalog!.getUserStats(opts);
        const sessionIds = [...new Set(stats.users.flatMap((user) =>
            user.byModel.flatMap((bucket) => bucket.sessionIds || []),
        ))];
        if (sessionIds.length === 0) return stats;

        const historySizeBySessionId = new Map<string, number>();
        await Promise.allSettled(sessionIds.map(async (sessionId) => {
            const orchestrationStats = await this.getOrchestrationStats(sessionId);
            const size = Number(orchestrationStats?.historySizeBytes);
            if (Number.isFinite(size) && size > 0) {
                historySizeBySessionId.set(sessionId, size);
            }
        }));

        let totalOrchestrationHistorySizeBytes = 0;
        for (const user of stats.users) {
            let userOrchestrationSize = 0;
            for (const bucket of user.byModel) {
                bucket.totalOrchestrationHistorySizeBytes = (bucket.sessionIds || [])
                    .reduce((sum, sessionId) => sum + (historySizeBySessionId.get(sessionId) || 0), 0);
                userOrchestrationSize += bucket.totalOrchestrationHistorySizeBytes;
            }
            user.totalOrchestrationHistorySizeBytes = userOrchestrationSize;
            totalOrchestrationHistorySizeBytes += userOrchestrationSize;
        }
        stats.totals.totalOrchestrationHistorySizeBytes = totalOrchestrationHistorySizeBytes;
        return stats;
    }

    // ─── User Profile (Admin Console) ───────────────────────

    /**
     * Read a single user's profile (settings + key-set flag). Returns
     * `null` when the principal has no row yet — callers should treat
     * that as the unconfigured state.
     *
     * The raw GitHub Copilot key is intentionally NOT returned here.
     * The Admin Console only needs to know whether one is set so it can
     * render "configured" / "not configured" affordances; the worker's
     * per-user token resolver reads the actual key directly from CMS.
     */
    async getUserProfile(principal: UserPrincipal): Promise<UserProfile | null> {
        this._ensureStarted();
        return this._catalog!.getUserProfile(principal);
    }

    /**
     * Replace the user's `profile_settings` JSON document. Creates the
     * user row lazily so settings can be saved before the principal has
     * created any sessions.
     */
    async setUserProfileSettings(
        principal: UserPrincipal,
        settings: Record<string, unknown>,
    ): Promise<UserProfile> {
        this._ensureStarted();
        return this._catalog!.setUserProfileSettings(principal, settings);
    }

    /**
     * Set or clear the per-user GitHub Copilot key. Pass `null` (or an
     * all-whitespace string) to remove the override and revert the user
     * to the worker's env-supplied default token.
     *
     * Warm sessions belonging to this user will rebind to the new
     * CopilotClient on their next `runTurn` (the SessionManager
     * detects the token change and recycles the warm handle).
     */
    async setUserGitHubCopilotKey(
        principal: UserPrincipal,
        key: string | null,
    ): Promise<UserProfile> {
        this._ensureStarted();
        return this._catalog!.setUserGitHubCopilotKey(principal, key);
    }

    /**
     * Set or clear the SYSTEM user's GitHub Copilot key (admin surface).
     * Ownerless system sessions resolve this key through the same per-user
     * path as owned sessions resolve their owner's key. The system user row
     * is created lazily on first set. `actor` — the admin performing the
     * change — is recorded in the system user's profile settings for audit
     * (pass `null` on anonymous/no-auth deployments).
     */
    async setSystemGitHubCopilotKey(
        actor: UserPrincipal | null,
        key: string | null,
    ): Promise<SystemGitHubCopilotKeyStatus> {
        this._ensureStarted();
        await this._catalog!.setUserGitHubCopilotKey(SYSTEM_USER_PRINCIPAL, key);
        const cleared = !(typeof key === "string" && key.trim().length > 0);
        await this._catalog!.setUserProfileSettings(SYSTEM_USER_PRINCIPAL, {
            githubCopilotKey: {
                changedBy: actor?.email || actor?.displayName || actor?.subject || "anonymous",
                changedAt: new Date().toISOString(),
                cleared,
            },
        });
        return this.getSystemGitHubCopilotKeyStatus();
    }

    /**
     * Whether a System GitHub Copilot key is configured, and who last
     * changed it. Never returns the key itself.
     */
    async getSystemGitHubCopilotKeyStatus(): Promise<SystemGitHubCopilotKeyStatus> {
        this._ensureStarted();
        const profile = await this._catalog!.getUserProfile(SYSTEM_USER_PRINCIPAL);
        const meta = (profile?.profileSettings as any)?.githubCopilotKey ?? {};
        return {
            configured: Boolean(profile?.githubCopilotKeySet),
            changedBy: typeof meta.changedBy === "string" ? meta.changedBy : null,
            changedAt: typeof meta.changedAt === "string" ? meta.changedAt : null,
        };
    }

    /**
     * Get per-session skill usage. Returns one row per (kind, name, plugin)
     * for either static skills (`skill.invoked`) or learned-knowledge reads
     * (`learned_skill.read`) the session has performed.
     */
    async getSessionSkillUsage(sessionId: string, opts?: { since?: Date }): Promise<SkillUsageRow[]> {
        this._ensureStarted();
        return this._catalog!.getSessionSkillUsage(sessionId, opts);
    }

    /**
     * Get skill usage rolled up across the spawn tree rooted at the given
     * session. Returns per-session breakdown, a flat rolled-up summary,
     * and total invocation count.
     */
    async getSessionTreeSkillUsage(sessionId: string, opts?: { since?: Date }): Promise<SessionTreeSkillUsage> {
        this._ensureStarted();
        return this._catalog!.getSessionTreeSkillUsage(sessionId, opts);
    }

    /**
     * Get fleet-wide skill usage broken down by `agentId` and skill kind.
     * Pass `since` for time-windowed reads (recommended for the default UI).
     */
    async getFleetSkillUsage(opts?: { since?: Date; includeDeleted?: boolean }): Promise<FleetSkillUsage> {
        this._ensureStarted();
        return this._catalog!.getFleetSkillUsage(opts);
    }

    /** Get per-session retrieval usage for enhanced facts, learned skills, and graph reads. */
    async getSessionRetrievalUsage(sessionId: string, opts?: { since?: Date }): Promise<RetrievalUsageRow[]> {
        this._ensureStarted();
        return this._catalog!.getSessionRetrievalUsage(sessionId, opts);
    }

    /** Get retrieval usage rolled up across the spawn tree rooted at the given session. */
    async getSessionTreeRetrievalUsage(sessionId: string, opts?: { since?: Date }): Promise<SessionTreeRetrievalUsage> {
        this._ensureStarted();
        return this._catalog!.getSessionTreeRetrievalUsage(sessionId, opts);
    }

    /** Get fleet-wide retrieval usage broken down by agent and operation. */
    async getFleetRetrievalUsage(opts?: { since?: Date; includeDeleted?: boolean }): Promise<FleetRetrievalUsage> {
        this._ensureStarted();
        return this._catalog!.getFleetRetrievalUsage(opts);
    }

    /** Get exact graph node-key search/load usage for one session. */
    async getSessionGraphNodeUsage(sessionId: string, opts?: { since?: Date; limit?: number; nodeKeyLike?: string; kind?: GraphNodeUsageKind }): Promise<GraphNodeUsageRow[]> {
        this._ensureStarted();
        return this._catalog!.getSessionGraphNodeUsage(sessionId, opts);
    }

    /** Get exact graph node-key search/load usage across the fleet. */
    async getFleetGraphNodeUsage(opts?: { since?: Date; includeDeleted?: boolean; limit?: number; nodeKeyLike?: string; kind?: GraphNodeUsageKind }): Promise<FleetGraphNodeUsage> {
        this._ensureStarted();
        return this._catalog!.getFleetGraphNodeUsage(opts);
    }

    /** Get requested graph edge-search shapes for one session. */
    async getSessionGraphEdgeSearchUsage(sessionId: string, opts?: { since?: Date; limit?: number }): Promise<GraphEdgeSearchUsageRow[]> {
        this._ensureStarted();
        return this._catalog!.getSessionGraphEdgeSearchUsage(sessionId, opts);
    }

    /**
     * Per-session non-shared facts, bucketed by knowledge namespace
     * (`skills` | `asks` | `intake` | `config` | `(other)`). Counts and
     * total `pg_column_size(value)` bytes only — never the values themselves.
     */
    async getSessionFactsStats(sessionId: string): Promise<{ sessionId: string; rows: FactsStatsRow[]; totalCount: number; totalBytes: number }> {
        this._ensureStarted();
        if (!this._factStore) return { sessionId, rows: [], totalCount: 0, totalBytes: 0 };
        const rows = await this._factStore.getSessionFactsStats(sessionId);
        return {
            sessionId,
            rows,
            totalCount: rows.reduce((acc, r) => acc + r.factCount, 0),
            totalBytes: rows.reduce((acc, r) => acc + r.totalValueBytes, 0),
        };
    }

    /**
     * Facts stats rolled up across the spawn tree rooted at `sessionId`.
     * Resolves descendant ids from the CMS first, then aggregates in the
     * facts schema. Returns per-session breakdown plus a flat roll-up.
     */
    async getSessionTreeFactsStats(sessionId: string): Promise<{
        rootSessionId: string;
        sessionIds: string[];
        rolledUp: FactsStatsRow[];
        totalCount: number;
        totalBytes: number;
    }> {
        this._ensureStarted();
        if (!this._factStore) {
            return { rootSessionId: sessionId, sessionIds: [sessionId], rolledUp: [], totalCount: 0, totalBytes: 0 };
        }
        const descendants = await this._catalog!.getDescendantSessionIds(sessionId);
        const ids = Array.from(new Set([sessionId, ...descendants]));
        const rolledUp = await this._factStore.getFactsStatsForSessions(ids);
        return {
            rootSessionId: sessionId,
            sessionIds: ids,
            rolledUp,
            totalCount: rolledUp.reduce((acc, r) => acc + r.factCount, 0),
            totalBytes: rolledUp.reduce((acc, r) => acc + r.totalValueBytes, 0),
        };
    }

    /**
     * Shared (cross-session) facts bucketed by namespace. Used for the
     * fleet "Facts" card to spot Facts Manager activity at a glance.
     */
    async getSharedFactsStats(): Promise<{ rows: FactsStatsRow[]; totalCount: number; totalBytes: number }> {
        this._ensureStarted();
        if (!this._factStore) return { rows: [], totalCount: 0, totalBytes: 0 };
        const rows = await this._factStore.getSharedFactsStats();
        return {
            rows,
            totalCount: rows.reduce((acc, r) => acc + r.factCount, 0),
            totalBytes: rows.reduce((acc, r) => acc + r.totalValueBytes, 0),
        };
    }

    // ─── Facts data-plane (Web API surface) ──────────────────────────
    //
    // These expose the FactStore/EnhancedFactStore data-plane so the Web API
    // can serve remote callers (e.g. the MCP server over --api-url) without a
    // direct database connection. The runtime derives the AccessContext from
    // the authenticated principal (see _apiAccessContext): under today's
    // binary-admission model an admitted caller is a privileged operator
    // (equivalent to the direct-DB placement the MCP server uses today), so
    // reads are unrestricted. Per-user fact scoping is future work; the derived
    // context — never client-supplied — is where it will land.

    private _requireFactStore(): FactStore {
        this._ensureStarted();
        if (!this._factStore) throw new Error("Facts store is not available on this deployment.");
        return this._factStore;
    }

    private _requireEnhancedFactStore(method: string) {
        const store = this._requireFactStore();
        if (!isEnhancedFactStore(store)) {
            const err = new EnhancedFactsUnsupportedError(method);
            (err as any).code = "FACTS_ENHANCED_UNSUPPORTED";
            throw err;
        }
        return store;
    }

    private _requireGraphStore(): GraphStore {
        this._ensureStarted();
        if (!this._graphStore) {
            const err = new Error("Graph store is not available on this deployment.");
            (err as any).code = "GRAPH_UNSUPPORTED";
            throw err;
        }
        return this._graphStore;
    }

    /**
     * Access context for API-brokered facts/graph reads — server-derived,
     * never from the client. Admin callers (and no-auth deployments) read
     * unrestricted, like an operator with direct DB access. A non-admin
     * admitted caller is limited to SHARED facts: private/session-scoped facts
     * of other sessions are off-limits (see _scopeReadForRole, which also drops
     * a client-supplied sessionId so it cannot target another session).
     */
    private _apiAccessContext(admin: boolean): AccessContext {
        return admin ? { unrestricted: true } : {};
    }

    /** Restrict a non-admin facts read to shared visibility; admins read as requested. */
    private _scopeReadForRole<T extends { scope?: string; sessionId?: string; namespace?: string }>(query: T, admin: boolean): T {
        if (admin) return query;
        return { ...query, scope: "shared", sessionId: undefined };
    }

    /** Capabilities of this deployment's fact/graph stores — the remote form of isEnhancedFactStore/isGraphStore. */
    factsCapabilities(): FactsCapabilities & { graph: boolean } {
        this._ensureStarted();
        const enhanced = Boolean(this._factStore && isEnhancedFactStore(this._factStore));
        const caps = enhanced ? (this._factStore as EnhancedFactStore).capabilities : { search: false, embedder: false };
        return { search: caps.search, embedder: caps.embedder, graph: Boolean(this._graphStore) };
    }

    async readFacts(query: ReadFactsQuery, opts?: { admin?: boolean }): Promise<{ count: number; facts: FactRecord[] }> {
        const admin = opts?.admin === true;
        return this._requireFactStore().readFacts(this._scopeReadForRole(query, admin), this._apiAccessContext(admin));
    }

    async storeFact(input: StoreFactInput | StoreFactInput[]): Promise<StoredFactResult | { stored: number; facts: StoredFactResult[] }> {
        return Array.isArray(input)
            ? this._requireFactStore().storeFact(input)
            : this._requireFactStore().storeFact(input);
    }

    async deleteFact(input: DeleteFactInput): Promise<DeletedFactResult | DeletedFactsResult> {
        // Never honor a client-supplied `unrestricted`, and refuse scope="all"
        // on this Tier-1 (non-admin) op: an all-scope delete spans every
        // session's private facts and would be a mass-delete escalation for a
        // plain admitted caller. Cross-cutting purges go through the
        // admin-gated forcePurgeFacts instead. Targeted / session / shared
        // deletes are the operator-level facts management the MCP server does.
        const { unrestricted: _drop, ...safe } = input as DeleteFactInput & { unrestricted?: boolean };
        if (safe.scope === "all") {
            const err = new Error("deleteFact scope='all' is not permitted over the Web API; use the admin forcePurgeFacts operation.");
            (err as any).code = "INVALID_REQUEST";
            throw err;
        }
        return this._requireFactStore().deleteFact(safe);
    }

    async searchFacts(query: string, opts?: SearchOpts, roleOpts?: { admin?: boolean }): Promise<SearchResult> {
        const admin = roleOpts?.admin === true;
        const scopedOpts = admin ? opts : { ...(opts ?? {}), scope: "shared" as const };
        return this._requireEnhancedFactStore("searchFacts").searchFacts(query, scopedOpts, this._apiAccessContext(admin));
    }

    async similarFacts(scopeKey: string, opts?: SimilarOpts, roleOpts?: { admin?: boolean }): Promise<SearchResult> {
        const admin = roleOpts?.admin === true;
        return this._requireEnhancedFactStore("similarFacts").similarFacts(scopeKey, opts, this._apiAccessContext(admin));
    }

    // ─── Graph data-plane (Web API surface) ──────────────────────────
    // Graph evidence arrays are ACL-filtered by the store; admitted callers
    // read graph structure with an unrestricted context (graph nodes/edges are
    // not per-session private data the way facts are).

    async searchGraphNodes(q: GraphNodeQuery): Promise<GraphNodeHit[]> {
        return this._requireGraphStore().searchGraphNodes(q, this._apiAccessContext(true));
    }

    async searchGraphEdges(q: GraphEdgeQuery): Promise<GraphEdgeHit[]> {
        return this._requireGraphStore().searchGraphEdges(q, this._apiAccessContext(true));
    }

    async graphNeighbourhood(nodeKey: string, depth: number, opts?: GraphNamespaceQuery): Promise<SubGraph> {
        return this._requireGraphStore().graphNeighbourhood(nodeKey, depth, this._apiAccessContext(true), opts);
    }

    async upsertGraphNode(n: GraphNodeInput): Promise<GraphNodeRef> {
        return this._requireGraphStore().upsertGraphNode(n);
    }

    async upsertGraphEdge(e: GraphEdgeInput): Promise<GraphEdgeRef> {
        return this._requireGraphStore().upsertGraphEdge(e);
    }

    async deleteGraphNode(nodeKey: string, opts?: GraphNamespaceQuery): Promise<boolean> {
        return this._requireGraphStore().deleteGraphNode(nodeKey, opts);
    }

    async deleteGraphEdge(fromKey: string, toKey: string, predicateKey: string, opts?: GraphNamespaceQuery): Promise<boolean> {
        return this._requireGraphStore().deleteGraphEdge(fromKey, toKey, predicateKey, opts);
    }

    async graphStats(opts?: GraphNamespaceQuery): Promise<{ nodeCount: number; edgeCount: number; uncrawledFacts?: number }> {
        const store = this._requireGraphStore();
        if (!store.graphStats) return { nodeCount: 0, edgeCount: 0 };
        return store.graphStats(opts);
    }

    async listGraphNamespaces(q?: GraphNamespaceListQuery): Promise<GraphNamespaceInfo[]> {
        const store = this._requireGraphStore();
        return store.listGraphNamespaces ? store.listGraphNamespaces(q) : [];
    }

    async getGraphNamespace(namespace: string): Promise<GraphNamespaceInfo | null> {
        const store = this._requireGraphStore();
        return store.getGraphNamespace ? store.getGraphNamespace(namespace) : null;
    }

    async upsertGraphNamespace(input: GraphNamespaceInput): Promise<GraphNamespaceInfo> {
        const store = this._requireGraphStore();
        if (!store.upsertGraphNamespace) {
            const err = new Error("Graph namespace registry is not supported by this deployment.");
            (err as any).code = "GRAPH_UNSUPPORTED";
            throw err;
        }
        return store.upsertGraphNamespace(input);
    }

    async deleteGraphNamespace(namespace: string): Promise<{ deleted: boolean; nodesDeleted: number; edgesDeleted: number }> {
        const store = this._requireGraphStore();
        if (!store.deleteGraphNamespace) {
            const err = new Error("Graph namespace registry is not supported by this deployment.");
            (err as any).code = "GRAPH_UNSUPPORTED";
            throw err;
        }
        return store.deleteGraphNamespace(namespace);
    }

    // ─── Enhanced-facts operational controls (admin surface) ──────────

    async startEmbedder(opts?: { intervalSeconds?: number; batch?: number }) {
        return this._requireEnhancedFactStore("startEmbedder").startEmbedder(opts);
    }

    async stopEmbedder(reason?: string) {
        return this._requireEnhancedFactStore("stopEmbedder").stopEmbedder(reason);
    }

    async forcePurgeFacts(input: ForcePurgeFactsInput): Promise<number> {
        return this._requireFactStore().forcePurgeFacts(input);
    }

    /**
     * Soft-deleted facts waiting for graph reconciliation or TTL purge.
     * Used by operator/tuner inspect tools to spot crawler lag before the TTL
     * backstop strands graph evidence.
     */
    async getFactsTombstoneStats(opts?: { ttlSeconds?: number }): Promise<FactsTombstoneStats> {
        this._ensureStarted();
        if (!this._factStore) {
            return { pendingTotal: 0, unreconciled: 0, ttlBlocked: 0, oldestUnreconciledAgeSeconds: null, reconciledUnswept: 0 };
        }
        return this._factStore.getFactsTombstoneStats(opts?.ttlSeconds);
    }

    /**
     * Durable embedder status (enhancedfactstore 07 P5): whether the in-DB
     * batch-embedding loop is running for the configured EnhancedFactStore.
     * Returns `{ supported: false }` for the base PgFactStore (no embedder) or a
     * store that was not provisioned for embedding. Powers the agent-tuner
     * `read_embedder_status` tool and operator dashboards — semantic/hybrid
     * search only returns semantic hits while this is running.
     */
    async getEmbedderStatus(): Promise<{ supported: boolean; running?: boolean; instanceId?: string; status?: string }> {
        this._ensureStarted();
        // Gate ONLY on whether this is an EnhancedFactStore (which guarantees an
        // embedderStatus() method). Do NOT gate on construction-time
        // `capabilities.embedder`: this control-plane store may be built without
        // an embedding endpoint while the durable loop is configured + running
        // for the schema by the workers. embedderStatus() reads the durable
        // df.instances state, so it reports the truth regardless of how THIS
        // store instance was constructed.
        if (!this._factStore || !isEnhancedFactStore(this._factStore)) {
            return { supported: false };
        }
        const st = await this._factStore.embedderStatus();
        return { supported: true, running: st.running, instanceId: st.instanceId, status: st.status };
    }

    async pruneDeletedSummaries(olderThan: Date): Promise<number> {
        this._ensureStarted();
        return this._catalog!.pruneDeletedSummaries(olderThan);
    }

    /**
     * Get the KV-backed response for a command ID.
     */
    async getCommandResponse(sessionId: string, cmdId: string): Promise<SessionCommandResponse | null> {
        this._ensureStarted();
        return this._readJsonValue<SessionCommandResponse>(sessionId, commandResponseKey(cmdId));
    }

    /**
     * Wait for a session's status to change.
     * Blocks until customStatusVersion advances past `afterVersion`,
     * or until `timeoutMs` elapses.
     */
    async waitForStatusChange(
        sessionId: string,
        afterVersion: number,
        pollIntervalMs?: number,
        timeoutMs?: number,
        opts?: { signal?: AbortSignal },
    ): Promise<SessionStatusChange> {
        this._ensureStarted();
        const orchId = `session-${sessionId}`;
        const controller = new AbortController();
        this._activeStatusWaitControllers.add(controller);
        const externalSignal = opts?.signal;
        const onAbort = () => controller.abort(createAbortError("Management status wait aborted", externalSignal?.reason));
        if (externalSignal) {
            if (externalSignal.aborted) onAbort();
            else externalSignal.addEventListener("abort", onAbort, { once: true });
        }

        const waitPromise = (async () => {
            const deadline = Date.now() + (timeoutMs ?? 30_000);
            while (Date.now() < deadline) {
                throwIfAborted(controller.signal, `Management status wait aborted (${orchId})`);
                const sliceMs = Math.min(deadline - Date.now(), STATUS_WAIT_SLICE_MS);
                if (sliceMs <= 0) break;

                const result = await this._duroxideClient.waitForStatusChange(
                    orchId,
                    afterVersion,
                    pollIntervalMs ?? 1_000,
                    sliceMs,
                );
                throwIfAborted(controller.signal, `Management status wait aborted (${orchId})`);

                if ((result.customStatusVersion || 0) <= afterVersion) {
                    continue;
                }

                let customStatus: any = null;
                if (result.customStatus) {
                    try {
                        customStatus = typeof result.customStatus === "string"
                            ? JSON.parse(result.customStatus)
                            : result.customStatus;
                    } catch {}
                }
                return {
                    customStatus,
                    customStatusVersion: result.customStatusVersion || 0,
                    orchestrationStatus: result.status,
                };
            }

            throwIfAborted(controller.signal, `Management status wait aborted (${orchId})`);
            throw new Error(`Timed out waiting for session ${sessionId} status change after version ${afterVersion}`);
        })();

        this._activeStatusWaitPromises.add(waitPromise);
        try {
            return await waitPromise;
        } finally {
            this._activeStatusWaitPromises.delete(waitPromise);
            this._activeStatusWaitControllers.delete(controller);
            if (externalSignal) externalSignal.removeEventListener("abort", onAbort);
        }
    }

    /**
     * Send a prompt message to a session's orchestration.
     *
     * @param options.clientMessageIds Optional list of UI-generated message ids
     *   that contributed to this (potentially merged) prompt. The orchestration
     *   preserves these and records them on the durable user.message event so
     *   the client can ack/cancel by exact id rather than text match.
     */
    async sendMessage(
        sessionId: string,
        prompt: string,
        options?: { clientMessageIds?: string[] },
    ): Promise<void> {
        this._ensureStarted();
        const session = await this.getSession(sessionId);
        if (!session) {
            throw new Error(`Session ${sessionId.slice(0, 8)} was not found.`);
        }
        if (session.status === "failed" || session.status === "cancelled") {
            throw new Error(
                `Session ${sessionId.slice(0, 8)} is a terminal orchestration and cannot accept new messages.`,
            );
        }
        if (
            session.status === "completed"
            && session.parentSessionId
            && !session.isSystem
            && !session.cronActive
            && !session.cronInterval
        ) {
            throw new Error(
                `Session ${sessionId.slice(0, 8)} is a completed terminal orchestration and cannot accept new messages.`,
            );
        }
        const orchId = `session-${sessionId}`;
        await this._assertOrchestrationLive(orchId, sessionId, "sendMessage");
        await this._catalog!.updateSession(sessionId, {
            state: "running",
            lastError: null,
            waitReason: null,
            lastActiveAt: new Date(),
        }).catch(() => {});

        // Optional: only include clientMessageIds in the payload when present so
        // the JSON shape stays byte-for-byte identical for callers that don't
        // pass them. This keeps every existing frozen orchestration version
        // happy on replay.
        const payload: Record<string, unknown> = { prompt };
        if (options?.clientMessageIds && options.clientMessageIds.length > 0) {
            payload.clientMessageIds = options.clientMessageIds;
        }
        await this._duroxideClient.enqueueEvent(
            orchId,
            "messages",
            JSON.stringify(payload),
        );
    }

    /**
     * Defense-in-depth guard for management enqueue paths.
     *
     * The management client only enqueues onto the durable messages queue —
     * it never starts an orchestration. If the orchestration was never
     * started (or has been removed), the enqueue lands on a queue with no
     * live instance and duroxide-pg eventually drops it as an orphan,
     * silently breaking the session. Refuse to enqueue in that case so the
     * caller sees an actionable error and can retry through the start-aware
     * path (`PilotSwarmSession.send` → `_ensureOrchestrationAndSend`).
     */
    private async _assertOrchestrationLive(
        orchId: string,
        sessionId: string,
        operation: string,
    ): Promise<void> {
        // Use getStatus, not getInstanceInfo: getStatus returns
        // `{ status: "NotFound" }` for non-existent instances, while
        // getInstanceInfo throws — and we cannot distinguish a real
        // "not found" from a transient connection error in a thrown
        // message reliably. With getStatus we can fail closed on
        // NotFound and fail open on transient errors.
        let status: string | undefined;
        try {
            const info = await this._duroxideClient.getStatus(orchId);
            status = info?.status;
        } catch {
            // Transient duroxide query failure — fail open so legitimate
            // enqueues are not blocked when the durable layer is briefly
            // unavailable. The dispatcher's orphan-drop is the last-resort
            // backstop.
            return;
        }
        if (!status || status === "NotFound" || status === "Unknown") {
            throw new Error(
                `Cannot ${operation} for session ${sessionId.slice(0, 8)}: orchestration ${orchId} is not started (status=${status ?? "missing"}). ` +
                `Use PilotSwarmSession.send (which starts the orchestration on the first turn) instead of the management enqueue path.`,
            );
        }
    }

    /**
     * Send an answer to a pending question from a session.
     */
    async sendAnswer(sessionId: string, answer: string): Promise<void> {
        this._ensureStarted();
        const orchId = `session-${sessionId}`;
        await this._assertOrchestrationLive(orchId, sessionId, "sendAnswer");
        await this._duroxideClient.enqueueEvent(
            orchId,
            "messages",
            JSON.stringify({ answer, wasFreeform: true }),
        );
    }

    /**
     * Cancel one or more queued (durable) pending messages by their
     * UI-generated client message ids.
     *
     * @internal Prefer `PilotSwarmSession.cancelPendingMessage` for in-process
     * callers and the public client transport surface for remote callers; this
     * method is the low-level durable enqueue both layers funnel through.
     */
    async cancelPendingMessage(sessionId: string, clientMessageIds: string[]): Promise<void> {
        this._ensureStarted();
        const ids = (clientMessageIds || []).filter((id): id is string => typeof id === "string" && Boolean(id));
        if (ids.length === 0) return;
        const orchId = `session-${sessionId}`;
        await this._assertOrchestrationLive(orchId, sessionId, "cancelPendingMessage");
        await this._duroxideClient.enqueueEvent(
            orchId,
            "messages",
            JSON.stringify({ cancelPending: ids }),
        );
    }

    /**
     * Send a command to a session's orchestration.
     */
    async sendCommand(sessionId: string, command: { cmd: string; id: string; args?: Record<string, unknown> }): Promise<void> {
        this._ensureStarted();
        const orchId = `session-${sessionId}`;
        await this._assertOrchestrationLive(orchId, sessionId, "sendCommand");
        await this._duroxideClient.enqueueEvent(
            orchId,
            "messages",
            JSON.stringify({ type: "cmd", ...command }),
        );
    }

    // ─── Models ──────────────────────────────────────────────

    /**
     * List all available models across all configured providers.
     */
    listModels(): ModelSummary[] {
        if (!this._modelProviders) return [];
        return this._modelProviders.allModels.map((m: ModelDescriptor) => ({
            qualifiedName: m.qualifiedName,
            providerId: m.providerId,
            providerType: m.providerType,
            modelName: m.modelName,
            description: m.description,
            cost: m.cost,
            ...(m.supportedReasoningEfforts?.length ? { supportedReasoningEfforts: m.supportedReasoningEfforts } : {}),
            ...(m.defaultReasoningEffort ? { defaultReasoningEffort: m.defaultReasoningEffort } : {}),
        }));
    }

    /**
     * Get models grouped by provider for display.
     */
    getModelsByProvider(): Array<{ providerId: string; type: string; models: ModelSummary[] }> {
        if (!this._modelProviders) return [];
        return this._modelProviders.getModelsByProvider().map(g => ({
            providerId: g.providerId,
            type: g.type,
            models: g.models.map((m: ModelDescriptor) => ({
                qualifiedName: m.qualifiedName,
                providerId: m.providerId,
                providerType: m.providerType,
                modelName: m.modelName,
                description: m.description,
                cost: m.cost,
                ...(m.supportedReasoningEfforts?.length ? { supportedReasoningEfforts: m.supportedReasoningEfforts } : {}),
                ...(m.defaultReasoningEffort ? { defaultReasoningEffort: m.defaultReasoningEffort } : {}),
            })),
        }));
    }

    /**
     * Get the default model name, if configured.
     */
    getDefaultModel(): string | undefined {
        return this._modelProviders?.defaultModel;
    }

    /**
     * Normalize a model reference to qualified `provider:model` format.
     */
    normalizeModel(ref?: string): string | undefined {
        return this._modelProviders?.normalize(ref);
    }

    /**
     * Return whether the model's provider has a process/env credential
     * available. For GitHub providers this intentionally does not include
     * per-user CMS keys; callers that create user-owned sessions should OR
     * this with the relevant profile's githubCopilotKeySet flag.
     */
    getModelCredentialStatus(ref?: string): ModelCredentialStatus {
        const normalized = this._modelProviders?.normalize(ref);
        if (!this._modelProviders || !normalized) {
            return { qualifiedName: normalized, credentialAvailable: false };
        }

        const descriptor = this._modelProviders.getDescriptor(normalized);
        const resolved = this._modelProviders.resolve(normalized);
        if (!descriptor || !resolved) {
            return { qualifiedName: normalized, credentialAvailable: false };
        }

        return {
            qualifiedName: descriptor.qualifiedName,
            providerId: descriptor.providerId,
            providerType: descriptor.providerType,
            credentialAvailable: resolved.type === "github"
                ? Boolean(resolved.githubToken)
                : Boolean(resolved.sdkProvider?.apiKey),
        };
    }

    // ─── Session Dump ────────────────────────────────────────

    /**
     * Dump a session and all its descendants to Markdown.
     */
    async dumpSession(sessionId: string): Promise<string> {
        this._ensureStarted();
        const dumper = new SessionDumper(this._catalog!);
        return dumper.dump(sessionId);
    }

    // ─── Internal ────────────────────────────────────────────

    private _ensureStarted(): void {
        if (!this._started) {
            throw new Error("ManagementClient not started. Call start() first.");
        }
    }
}
