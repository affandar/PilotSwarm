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
    sanitizePromptAttachmentRefs,
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
    PromptAttachmentRef,
} from "./types.js";
import type {
    SessionCatalog, SessionRow, TopEventEmitterRow, AgentPackageSelector, AgentPrincipal,
    AgentPackageScope, AgentPackageSummary, AgentPackageDetail, AgentPackageEditorInfo, AgentWorkerStateRow, WorkerRow,
} from "./cms.js";
import { SYSTEM_USER_PRINCIPAL } from "./cms.js";
import { readCanvasKv, writeCanvasKv, CanvasKvError } from "./canvas-kv.js";
import type { CanvasKvStore, CanvasKvPrincipal, CanvasKvReadResult, CanvasKvWriteOp, CanvasKvWriteResult, CanvasKvMe } from "./canvas-kv.js";
import type {
    ProviderStore, ProviderRow, ProviderStatusRow, PausedSessionRow, DefaultTuple, UsageFilters,
    ProviderClass, UsageGridRow, ProviderDefaults, ProviderCredential, SystemAgentModelOverride,
} from "./provider-store.js";
import { ProviderError } from "./provider-store.js";
import type { BudgetPeriod } from "./provider-budgets.js";
import { wakeProviderPausedSessions } from "./provider-wake.js";
import { LOCAL_DEFAULT_USER_PRINCIPAL } from "./session-owner-utils.js";
import type { MessageSender } from "./message-sender.js";
import { normalizeMessageSender } from "./message-sender.js";
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
    UserRoleInfo,
    UserRoleValue,
    SessionGroupRow,
    PlacementViewer,
    SessionPlacementResult,
    ChildOutcomeRow,
    SessionVisibility,
    SessionShareInfo,
    SessionAccessSnapshot,
    AuthzAuditEntry,
    KnownUserInfo,
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
import { computeSessionFootprint, FootprintCache, type SessionFootprint } from "./footprint.js";
import { loadModelProviders, loadModelProviderTypes, providerTypeUsesWorkloadIdentity, type ModelProviderRegistry, type ModelDescriptor, type ReasoningEffort, type ContextTier } from "./model-providers.js";
import { bootstrapProviders, resolveProviderCredential, resolveRuntimeModelSelection } from "./provider-catalog.js";
import { deriveStatusFromCmsAndRuntime, shouldSyncCompletedStatus, shouldSyncFailedStatus, resolveStaleRunningRowRecovery } from "./session-status.js";
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
import type { ArtifactStore } from "./session-store.js";
import {
    AgentPackageValidationError,
    deleteAgentPackageEverywhere,
    fetchAgentPackageTarGz,
    publishAgentPackageDir,
    publishPackedAgentPackage,
    readAgentPackageVersionEntries,
    resolveAgentPackageVersion,
} from "./agent-package-service.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

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

/**
 * A default is one tuple, saved whole. With no provider there is nothing to
 * run, so the other three go with it — carrying a model for a provider that
 * was cleared would leave a half-default nobody can act on.
 */
function normalizeDefaultTuple(tuple: DefaultTuple | null | undefined): DefaultTuple {
    const provider = String(tuple?.provider ?? "").trim() || null;
    if (!provider) return { provider: null, model: null, reasoning: null, context: null };
    return {
        provider,
        model: String(tuple?.model ?? "").trim() || null,
        reasoning: String(tuple?.reasoning ?? "").trim() || null,
        context: String(tuple?.context ?? "").trim() || null,
    };
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
    return null;
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
    contextTier?: ContextTier | null;
    modelResolutionSource?: string;
    /** Stable id for an idempotent multi-agent rollout; omitted for a new manual restart. */
    operationId?: string;
}

export interface RestartSystemSessionResult {
    agentId: string;
    agentName: string;
    sessionId: string;
    disposition: "complete" | "terminate" | "hard_delete";
    previousSessionExisted: boolean;
    startResults: SystemAgentStartResult[];
    skippedReason?: "busy" | "complete";
}

function normalizeSystemRestartDisposition(disposition: SystemSessionRestartDisposition): "complete" | "terminate" | "hard_delete" {
    if (disposition === "complete") return "complete";
    if (disposition === "terminate") return "terminate";
    if (disposition === "hard_delete" || disposition === "hardDelete") return "hard_delete";
    throw Object.assign(
        new Error(`Unsupported system session restart disposition: ${String(disposition)}`),
        { code: "INVALID_REQUEST" },
    );
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
        viewerGroupId: row.groupId ?? undefined,
        isSystem: row.isSystem || undefined,
        serviceKind: row.serviceKind ?? undefined,
        serviceOf: row.serviceOf ?? undefined,
        model: row.model ?? undefined,
        reasoningEffort: row.reasoningEffort ?? undefined,
        contextTier: row.contextTier ?? undefined,
        shortSummary: row.shortSummary ?? undefined,
        summaryState: row.summaryState ?? undefined,
        summaryUpdatedAt: row.summaryUpdatedAt?.getTime(),
        error: row.lastError ?? undefined,
        waitReason: row.waitReason ?? undefined,
        statusVersion: undefined,
        visibility: row.visibility ?? "private",
        rootSessionId: row.rootSessionId ?? row.sessionId,
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
    /** The requesting viewer's private group placement for this session's root. */
    viewerGroupId?: string;
    isSystem?: boolean;
    /** Service session (tree-scoped machinery, e.g. "regen-distiller"): read-only to users. */
    serviceKind?: string;
    /** The session this service session serves. */
    serviceOf?: string;
    model?: string;
    reasoningEffort?: string;
    contextTier?: string;
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
    /** Sharing level of the session's tree root (private | shared_read | shared_write). */
    visibility?: SessionVisibility;
    /** Denormalized session-tree root id (self for top-level sessions). */
    rootSessionId?: string;
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
    /** When set, restrict rows to what this principal can read (viewer-scoped listing). */
    viewer?: { provider: string; subject: string; systemVisible?: boolean } | null;
    /** When set, root rows carry this principal's private group placement as viewerGroupId. */
    placement?: { provider: string; subject: string } | null;
}

/** One bounded page of management session views. */
export interface PilotSwarmSessionPage {
    sessions: PilotSwarmSessionView[];
    hasMore: boolean;
    nextCursor?: SessionPageCursor;
}

/** Model summary for UI display. */
export interface ModelSummary {
    catalogKind?: "provider_type" | "runtime_provider";
    qualifiedName: string;
    providerId: string;
    providerType: string;
    modelName: string;
    description?: string;
    cost?: string;
    supportedReasoningEfforts?: ReasoningEffort[];
    defaultReasoningEffort?: ReasoningEffort;
    supportedContextTiers?: import("./model-providers.js").ContextTier[];
    defaultContextTier?: import("./model-providers.js").ContextTier;
    contextWindowSizes?: Partial<Record<import("./model-providers.js").ContextTier, number>>;
    /**
     * Whether the provider has a process/env credential. For GitHub
     * providers this excludes per-user CMS keys (see
     * getModelCredentialStatus) — a `false` here means the model is only
     * usable by users who configured their own GitHub Copilot key.
     */
    credentialAvailable?: boolean;
}

/** Credential availability for a configured model provider. */
export interface ModelCredentialStatus {
    qualifiedName?: string;
    providerId?: string;
    providerType?: string;
    credentialAvailable: boolean;
}

/**
 * Who is asking for a provider-budget operation.
 *
 * `principal` is the caller's identity, resolved to a numeric user id on the
 * way in because the `cms_provider_*` procedures take numbers; `null` is a
 * caller the deployment has never seen, which the procedures read as nobody.
 * `isAdmin` is the role the caller authenticated with. Neither field decides
 * anything here — every rule about who may do what is in SQL.
 */
export interface ProviderViewer {
    principal: UserPrincipal | null;
    isAdmin: boolean;
    /** Resolved by the authenticated surface, never from request parameters. */
    adminScope?: "unrestricted" | "cluster";
}

/** What a caller sends to make a provider — the words the surface uses, not the column names. */
export interface ProviderCreateInput {
    name: string;
    type: string;
    credentials?: Record<string, unknown> | null;
    baseUrl?: string | null;
}

export interface ProviderCredentialUpdateInput {
    name: string;
    credentials?: Record<string, unknown> | null;
}

export interface ModelDefaultInput {
    scope: "user" | "cluster";
    provider: string | null;
    model: string | null;
    reasoningEffort?: ReasoningEffort | null;
    contextTier?: ContextTier | null;
}

export interface SystemModelDefaultInput {
    provider: string | null;
    model: string | null;
    reasoningEffort?: ReasoningEffort | null;
    contextTier?: ContextTier | null;
    restartExisting?: false | { disposition: SystemSessionRestartDisposition };
}

export interface ResolvedModelDefault {
    provider: string;
    model: string;
    reasoningEffort: ReasoningEffort | null;
    contextTier: ContextTier | null;
    source: "user_default" | "cluster_default" | "system_default" | "first_available";
}

/** Which limit on which provider: one per (period, scope). */
export interface ProviderLimitRef {
    provider: string;
    period: BudgetPeriod;
    /** One model, or every model on the provider when absent. */
    model?: string | null;
}

export interface ProviderLimitInput extends ProviderLimitRef {
    /** A whole number of tokens. Hard — the first turn past it waits. */
    tokens: number;
}

export interface ProviderHoldInput {
    provider: string;
    /** When the hold lifts by itself. */
    untilUtc?: string | null;
    /** Lift it now. */
    release?: boolean;
}

/** What a usage breakdown groups by. */
export type ProviderUsageDimension = "session" | "user" | "provider" | "model" | "agent";

export const PROVIDER_USAGE_DIMENSIONS: ProviderUsageDimension[] =
    ["session", "user", "provider", "model", "agent"];

export interface ProviderUsageQuery extends UsageFilters {
    dimension?: string | null;
    limit?: number | null;
    /**
     * "Only my own spend", resolved HERE from the authenticated caller.
     *
     * The alternative is for the caller to send their own `ownerUserId`, which
     * means the client has to know its own id and the wire has to carry one —
     * and a wire that can carry your id can carry somebody else's. This cannot:
     * the flag is a boolean and the id is the actor the server already
     * resolved. It wins over `ownerUserId` when both are sent.
     */
    mine?: boolean | null;
}

/** The whole usage view in one answer: totals, the daily chart, one breakdown. */
/** What the cluster summary is asked for. */
export interface ProviderUsageSummaryQuery {
    /** Days of history for the chart and the model table: 1–365, default 14. */
    days?: number;
    /** Only these providers; empty or absent means all of them. */
    providers?: string[];
}

/** One window's four-way token split. */
export interface ProviderUsageSummaryWindow {
    input: number; output: number; cacheRead: number; cacheWrite: number;
    total: number; turns: number; sessions: number;
}

/** The cluster summary, as `cms_provider_usage_summary` builds it. */
export interface ProviderUsageSummary {
    days: number;
    /** The UTC day the windows and series count as "today". */
    today: string;
    /** "cluster" for an admin, "mine" for everyone else. */
    scope: "cluster" | "mine";
    windows: { day: ProviderUsageSummaryWindow; week: ProviderUsageSummaryWindow; month: ProviderUsageSummaryWindow };
    daily: Array<{ day: string; input: number; output: number; cacheRead: number; cacheWrite: number; total: number; turns: number }>;
    /** Pivoted on the model NAME, across providers, efforts and context tiers. */
    models: Array<{
        model: string; providers: number; turns: number;
        input: number; output: number; cacheRead: number; cacheWrite: number; total: number;
        daily: Array<{ day: string; total: number }>;
    }>;
    classes: Array<{ chargeClass: string; total: number; turns: number }>;
}

export interface ProviderUsageReport {
    totals: { tokensTotal: number; turns: number; sessions: number };
    daily: Array<{
        dayUtc: string; tokensTotal: number; turns: number;
        /** The four parts of tokensTotal. */
        tokensInput: number; tokensOutput: number; tokensCacheRead: number; tokensCacheWrite: number;
    }>;
    breakdown: Array<{ key: string; label: string; tokensTotal: number; turns: number }>;
    /** The dimension actually grouped by, which is the default when the request named an unknown one. */
    dimension: ProviderUsageDimension;
    /** True when more rows exist than `limit` returned. */
    truncated: boolean;
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
    /** Artifact store used by direct-mode agent-package publish/read/delete operations. */
    artifactStore?: ArtifactStore | null;
}

// ─── Management Client ──────────────────────────────────────────

function normalizeShareSlot(slot: unknown): number {
    const n = Math.floor(Number(slot));
    if (!Number.isInteger(n) || n < 1 || n > 5) throw new Error("slot must be an integer 1-5");
    return n;
}

export class PilotSwarmManagementClient {
    private config!: PilotSwarmManagementClientOptions;
    private _catalog: SessionCatalog | null = null;
    private _factStore: FactStore | null = null;
    private _graphStore: GraphStore | null = null;
    private _duroxideClient: any = null;
    private _modelProviders: ModelProviderRegistry | null = null;
    private _systemAgents: AgentConfig[] = [];
    private _artifactStore: ArtifactStore | null = null;
    private _activeStatusWaitControllers = new Set<AbortController>();
    private _activeStatusWaitPromises = new Set<Promise<unknown>>();
    private _started = false;

    constructor(options: PilotSwarmManagementClientOptions | PilotSwarmWebOptions) {
        assertUnambiguousProvider(options, "PilotSwarmManagementClient");
        if (isWebOptions(options)) {
            // Web mode — the supported public mode: talk to a deployment's
            // Web API instead of the datastore.
            //
            // Prefer `createManagementClient(options)` in new code: it
            // returns the honestly-typed WebPilotSwarmManagementClient
            // (including its generated `ops` surface) instead of casting it
            // to this class. The cast below is compile-time verified — see
            // _WebSatisfiesManagementSurface in web-management-client.ts —
            // so every method this type declares either works over HTTP or
            // throws a typed WEB_MODE_UNSUPPORTED error; the documented
            // KnownDivergences are the sync model-catalog reads, which are
            // async over HTTP.
            return new WebPilotSwarmManagementClient(options) as unknown as PilotSwarmManagementClient;
        }
        this.config = options;
        this._artifactStore = options.artifactStore ?? null;
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
        this._modelProviders = loadModelProviderTypes(this.config.modelProvidersPath);
                const legacyProviders = loadModelProviders(this.config.modelProvidersPath);
                if (this._catalog.providers && legacyProviders) {
                    await bootstrapProviders(this._catalog.providers, {
                        providers: legacyProviders.allProviders,
                        defaultModel: legacyProviders.defaultModel,
                    });
                }
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
            throw Object.assign(
                new Error(
                    `System agent "${target}" is not known to this management client. ` +
                    `Configure pluginDirs/systemAgents so the client can recreate the system session.`,
                ),
                { code: "NOT_FOUND" },
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
    async listSessions(placement?: { provider: string; subject: string } | null): Promise<PilotSwarmSessionView[]> {
        this._ensureStarted();

        // Single CMS query — no duroxide fan-out
        const cmsSessions = await this._catalog!.listSessions(placement ?? null);

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
            viewer: opts.viewer ?? null,
            placement: opts.placement ?? null,
        });
        const visibleRows = rows.slice(0, limit);
        const hasMore = rows.length > limit;
        const last = visibleRows[visibleRows.length - 1];

        // Canvas summaries ride the list DTO so the portal can mark rows on
        // cold load without replaying events. Optional method, non-fatal:
        // a catalog without it (tests, older DBs) just ships no canvases.
        const canvasesById = await this._catalog!.listSessionCanvasesFor?.(visibleRows.map((r: any) => r.sessionId)).catch(() => null);
        return {
            sessions: visibleRows.map((row: any) => ({
                ...sessionViewFromCmsRow(row),
                ...(canvasesById?.get(row.sessionId)?.length ? { canvases: canvasesById.get(row.sessionId) } : {}),
            })),
            hasMore,
            ...(hasMore && last
                ? { nextCursor: { updatedAt: last.updatedAt.getTime(), sessionId: last.sessionId } }
                : {}),
        };
    }

    /** List sessions visible to a principal (non-paged viewer-scoped listing). */
    async listSessionsVisible(
        viewer: { provider: string; subject: string; systemVisible?: boolean },
        placement?: { provider: string; subject: string } | null,
    ): Promise<PilotSwarmSessionView[]> {
        this._ensureStarted();
        const rows = await this._catalog!.listSessionsVisible(viewer, placement ?? null);
        return rows.map(sessionViewFromCmsRow);
    }

    /** Member directory for share autocomplete (excludes synthetic principals). */
    async listKnownUsers(opts?: { limit?: number }): Promise<KnownUserInfo[]> {
        this._ensureStarted();
        return this._catalog!.listKnownUsers(opts);
    }

    // ─── Session sharing / access (security model) ────────────

    /** Access snapshot for the enforcement predicate (null = missing/deleted session). */
    async getSessionAccess(sessionId: string, viewer: { provider: string; subject: string }): Promise<SessionAccessSnapshot | null> {
        this._ensureStarted();
        return this._catalog!.getSessionAccess(sessionId, viewer);
    }

    /** Set the sharing level on the ROOT of the given session's tree. */
    async setSessionVisibility(sessionId: string, visibility: SessionVisibility): Promise<void> {
        this._ensureStarted();
        await this._catalog!.setSessionVisibility(sessionId, visibility);
    }

    /** Grant (or update) a targeted share on the session's tree root. */
    async grantSessionShare(
        sessionId: string,
        grantee: { provider: string; subject: string; email?: string | null; displayName?: string | null },
        access: "read" | "write",
        grantedBy?: { provider: string; subject: string } | null,
    ): Promise<void> {
        this._ensureStarted();
        await this._catalog!.grantSessionShare(
            sessionId,
            {
                provider: grantee.provider,
                subject: grantee.subject,
                email: grantee.email ?? null,
                displayName: grantee.displayName ?? null,
            },
            access,
            grantedBy ? { provider: grantedBy.provider, subject: grantedBy.subject, email: null, displayName: null } : null,
        );
    }

    /** Revoke a targeted share on the session's tree root. */
    async revokeSessionShare(sessionId: string, grantee: { provider: string; subject: string }): Promise<void> {
        this._ensureStarted();
        await this._catalog!.revokeSessionShare(sessionId, grantee);
    }

    /** List targeted shares on the session's tree root. */
    async listSessionShares(sessionId: string): Promise<SessionShareInfo[]> {
        this._ensureStarted();
        return this._catalog!.listSessionShares(sessionId);
    }

    /** Append one authz audit record (fire-and-forget friendly; errors surface to the caller). */
    async recordAuthzAudit(entry: {
        actor?: { provider?: string | null; subject?: string | null; display?: string | null } | null;
        action: string;
        sessionId?: string | null;
        target?: string | null;
        decision: string;
        reason?: string | null;
        details?: Record<string, unknown> | null;
    }): Promise<void> {
        this._ensureStarted();
        await this._catalog!.recordAuthzAudit(entry);
    }

    /** Read authz audit records, newest first (optionally scoped to one session). */
    async listAuthzAudit(opts?: { limit?: number; sessionId?: string | null }): Promise<AuthzAuditEntry[]> {
        this._ensureStarted();
        return this._catalog!.listAuthzAudit(opts);
    }

    /**
     * Record the authorization role observed for a principal at sign-in.
     *
     * DIRECT MODE ONLY, and deliberately not a Web API route: a caller able
     * to write its own role would hold a privilege-escalation primitive. The
     * only legitimate writer is the portal process itself, which has just
     * validated the token the role came from. Same posture as
     * `recordAuthzAudit`.
     *
     * Returns the normalized role that was stored (`null` when the input was
     * absent or outside the known vocabulary).
     */
    async recordUserRole(principal: UserPrincipal, role: string | null): Promise<UserRoleValue | null> {
        this._ensureStarted();
        return this._catalog!.setUserRole(principal, role);
    }

    /**
     * Read the last-observed authorization role for a principal. `null` role
     * means no privilege, whether the principal is unknown or simply has no
     * role recorded.
     */
    async getUserRole(principal: UserPrincipal): Promise<UserRoleInfo> {
        this._ensureStarted();
        return this._catalog!.getUserRole(principal);
    }

    /**
     * Get a single session view by ID.
     */
    async getSession(sessionId: string, placement?: { provider: string; subject: string } | null): Promise<PilotSwarmSessionView | null> {
        this._ensureStarted();
        const row = await this._catalog!.getSession(sessionId, placement ?? null);
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
        } else {
            const recoveredState = resolveStaleRunningRowRecovery({
                rowState: row.state,
                status: customStatus?.status,
                orchestrationStatus: orchStatus,
            });
            if (recoveredState) {
                await this._catalog!.updateSession(sessionId, {
                    state: recoveredState,
                    lastError: null,
                    ...(recoveredState === "waiting" || recoveredState === "input_required"
                        ? {}
                        : { waitReason: null }),
                }).catch(() => {});
            }
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
            viewerGroupId: row.groupId ?? undefined,
            isSystem: row.isSystem || undefined,
            model: row.model ?? undefined,
            reasoningEffort: row.reasoningEffort ?? undefined,
            contextTier: row.contextTier ?? undefined,
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
        // Direct-mode callers (MCP direct, tests) carry no auth principal, so
        // default the owner to the local principal — an ownerless group can
        // never receive placements (the composite FK rejects them), which
        // would make create-then-place fail. Web callers always pass owner.
        await this._catalog!.createSessionGroup({
            groupId,
            title: input.title,
            description: input.description ?? null,
            owner: input.owner ?? { ...LOCAL_DEFAULT_USER_PRINCIPAL },
            metadata: input.metadata ?? {},
        });
        const created = (await this._catalog!.listSessionGroups()).find((group) => group.groupId === groupId);
        if (!created) throw new Error(`Session group ${groupId} was not created.`);
        return created;
    }

    async listSessionGroups(viewer?: PlacementViewer | null): Promise<SessionGroupRow[]> {
        this._ensureStarted();
        return this._catalog!.listSessionGroups(viewer ?? null);
    }

    async listGroupSessions(groupId: string, placement?: { provider: string; subject: string } | null): Promise<PilotSwarmSessionView[]> {
        this._ensureStarted();
        const rows = await this._catalog!.listGroupSessions(groupId, placement ?? null);
        return rows.map(sessionViewFromCmsRow);
    }

    async updateSessionGroup(groupId: string, patch: { title?: string; description?: string | null; metadataPatch?: Record<string, unknown> }): Promise<SessionGroupRow> {
        this._ensureStarted();
        await this._catalog!.updateSessionGroup(groupId, patch);
        const updated = (await this._catalog!.listSessionGroups()).find((group) => group.groupId === groupId);
        if (!updated) throw new Error(`Session group ${groupId} was not found.`);
        return updated;
    }

    /**
     * Upsert (or delete, when groupId is null) the viewer's private placement
     * for each distinct session tree root. Requires read access per session;
     * the target group must be owned by the viewer. Never touches shared
     * session data.
     */
    async placeSessionsInGroup(
        viewer: PlacementViewer,
        sessionIds: string[],
        groupId: string | null,
    ): Promise<SessionPlacementResult[]> {
        this._ensureStarted();
        const uniqueIds = Array.from(new Set((Array.isArray(sessionIds) ? sessionIds : []).map((id) => String(id || "").trim()).filter(Boolean)));
        const normalizedGroupId = groupId == null ? null : String(groupId || "").trim() || null;
        return this._catalog!.placeSessionsInGroup(viewer, uniqueIds, normalizedGroupId);
    }

    /**
     * Deprecated alias of placeSessionsInGroup for direct-mode callers that
     * carry no viewer: places for the target group's owner, or (when
     * ungrouping) clears each session owner's own placement.
     */
    async moveSessionsToGroup(groupId: string | null, sessionIds: string[]): Promise<void> {
        this._ensureStarted();
        const normalizedGroupId = groupId == null ? null : String(groupId || "").trim();
        const uniqueIds = Array.from(new Set((Array.isArray(sessionIds) ? sessionIds : []).map((id) => String(id || "").trim()).filter(Boolean)));

        if (normalizedGroupId) {
            const targetGroup = (await this._catalog!.listSessionGroups()).find((candidate) => candidate.groupId === normalizedGroupId) ?? null;
            if (!targetGroup) throw new Error(`Session group ${normalizedGroupId} was not found.`);
            if (!targetGroup.owner?.provider || !targetGroup.owner?.subject) {
                throw new Error(`Session group ${normalizedGroupId} has no owner to place sessions for.`);
            }
            await this.placeSessionsInGroup(
                { provider: targetGroup.owner.provider, subject: targetGroup.owner.subject, isAdmin: true },
                uniqueIds,
                normalizedGroupId,
            );
            return;
        }

        for (const sessionId of uniqueIds) {
            const session = await this._catalog!.getSession(sessionId);
            if (!session || session.isSystem) continue;
            if (!session.owner?.provider || !session.owner?.subject) continue;
            await this.placeSessionsInGroup(
                { provider: session.owner.provider, subject: session.owner.subject, isAdmin: true },
                [sessionId],
                null,
            );
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
        void reason;
        const deleted = await this._catalog!.deleteSessionGroup(groupId);
        if (!deleted) {
            throw new Error(`Session group ${groupId} was not found.`);
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
            // Terminal fast path: there is no live orchestration to run the
            // descendant cascade (the delete command handler), so cascade
            // here. Enumerate BEFORE deleting the target — the descendant
            // walk skips soft-deleted rows, so deleting the target first
            // would orphan its subtree.
            let descendants: string[] = [];
            try {
                descendants = await this._catalog!.getDescendantSessionIds(sessionId);
            } catch (err) {
                console.error(`[PilotSwarmManagementClient] descendant enumeration failed for ${sessionId}:`, err);
            }
            for (const descendantId of descendants) {
                try {
                    await this._forceDeleteSession(descendantId, `Ancestor ${sessionId} deleted: ${deleteReason}`);
                } catch (err) {
                    // Non-fatal (e.g. a system/service descendant): keep
                    // going so one refusal doesn't strand its siblings.
                    console.error(`[PilotSwarmManagementClient] failed to delete descendant ${descendantId} of ${sessionId}:`, err);
                }
            }
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
        opts?: { reasoningEffort?: ReasoningEffort | null; contextTier?: ContextTier | null; source?: string },
    ): Promise<void> {
        this._ensureStarted();
        const trimmed = String(model || "").trim();
        if (!trimmed) throw new Error("setSessionModel requires a model id");
        const session = await this.getSession(sessionId).catch(() => null);
        if (!session) throw new Error(`Session ${sessionId.slice(0, 8)} was not found`);
        const store = this._requireProviders();
        if (!this._modelProviders) throw new Error("Provider type catalog is unavailable");
        const actor = session.owner
            ? await store.lookupUserId(session.owner)
            : null;
        const credentials = await store.allCredentials();
        let selection;
        try {
            selection = resolveRuntimeModelSelection(this._modelProviders, credentials, {
                requestedModel: trimmed,
                requestedReasoning: opts?.reasoningEffort,
                requestedContext: opts?.contextTier,
                eligible: session.isSystem
                    ? (provider) => provider.class === "shared" || provider.systemUseEnabled === true
                    : (provider) => provider.class === "shared" || (actor !== null && provider.ownerUserId === actor),
            });
        } catch (error: any) {
            if (error?.code === "MODEL_AMBIGUOUS") throw error;
            if (error?.code === "MODEL_UNRESOLVED") {
                throw Object.assign(
                    new Error(`Unknown model: ${trimmed}. ${error.message}`),
                    { code: "MODEL_UNRESOLVED" },
                );
            }
            throw new Error(`Unknown model: ${trimmed}. ${error?.message || String(error)}`);
        }
        const credential = credentials.find((provider) => provider.name === selection.provider)!;
        const modelName = selection.model.slice(selection.model.indexOf(":") + 1);
        const match = this._providerTypeModels(credential.typeId)
            .find((candidate) => candidate.modelName === modelName);
        if (!match) throw new Error(`Unknown model: ${selection.model}`);
        const resolvedModel = selection.model;
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
                throw new Error(`Model ${resolvedModel} does not support reasoning effort '${nextReasoningEffort}'`);
            }
        }
        // Context-window tier follows the same preserve-when-omitted contract.
        const hasExplicitContextTier = !!opts && "contextTier" in opts;
        const nextContextTier = hasExplicitContextTier ? (opts!.contextTier ?? null) : undefined;
        if (nextContextTier) {
            const supported = match.supportedContextTiers ?? [];
            if (!supported.includes(nextContextTier)) {
                throw new Error(`Model ${resolvedModel} does not support context tier '${nextContextTier}'`);
            }
        }
        await this.sendCommand(sessionId, {
            cmd: "set_model",
            id: buildLifecycleCommandId("set-model"),
            args: {
                model: resolvedModel,
                ...(hasExplicitEffort ? { reasoningEffort: nextReasoningEffort } : {}),
                ...(hasExplicitContextTier ? { contextTier: nextContextTier } : {}),
                source: opts?.source ?? "user",
            },
        });
    }

    /**
     * Regenerate a session's Copilot transcript in place (epoch rebirth,
     * proposal §4): archive → distill → flip, applied by the orchestration at
     * a turn boundary. Enqueue-then-observe — outcomes arrive as
     * session.regenerate_* events; the cmd handler is the gate authority
     * (too_young / already_pending / cooldown refusals emit
     * session.regenerate_refused).
     */
    async regenerateSession(
        sessionId: string,
        opts?: { handoff?: string; instructions?: string; distillMode?: "llm" | "deterministic"; distillerModel?: string; distillerReasoningEffort?: string; distillerContextTier?: string; model?: string; source?: string; force?: boolean },
    ): Promise<{ attemptId: string }> {
        this._ensureStarted();
        const session = await this.getSession(sessionId).catch(() => null);
        if (!session) throw new Error(`Session ${sessionId.slice(0, 8)} was not found`);
        if ((session as any).isSystem) {
            throw Object.assign(
                new Error("System sessions are excluded from regeneration (use restartSystemSession)"),
                { code: "REGENERATE_UNSUPPORTED" },
            );
        }
        if ((session as any).serviceKind) {
            throw Object.assign(
                new Error("Service sessions are runtime machinery and are excluded from regeneration"),
                { code: "REGENERATE_UNSUPPORTED" },
            );
        }
        const store = this._requireProviders();
        if (!this._modelProviders) throw new Error("Provider type catalog is unavailable");
        const actor = session.owner ? await store.lookupUserId(session.owner) : null;
        const credentials = await store.allCredentials();
        const eligible = (provider: ProviderCredential) =>
            provider.class === "shared" || (actor !== null && provider.ownerUserId === actor);
        const resolveRequested = (
            model: string,
            reasoning?: string | null,
            context?: string | null,
        ) => resolveRuntimeModelSelection(this._modelProviders!, credentials, {
            requestedModel: model,
            requestedReasoning: reasoning,
            requestedContext: context,
            eligible,
        });

        let targetModel = opts?.model;
        let distillerModel = opts?.distillerModel;
        let distillerReasoningEffort = opts?.distillerReasoningEffort;
        let distillerContextTier = opts?.distillerContextTier;
        if (targetModel) {
            try {
                targetModel = resolveRequested(targetModel).model;
            } catch (error: any) {
                if (error?.code === "MODEL_AMBIGUOUS") throw error;
                if (error?.code === "MODEL_UNRESOLVED") {
                    throw Object.assign(
                        new Error(`Unknown model: ${opts?.model}. ${error.message}`),
                        { code: "MODEL_UNRESOLVED" },
                    );
                }
                throw new Error(`Unknown model: ${opts?.model}. ${error?.message || String(error)}`);
            }
        }
        if (distillerModel) {
            try {
                const resolved = resolveRequested(
                    distillerModel,
                    distillerReasoningEffort,
                    distillerContextTier,
                );
                distillerModel = resolved.model;
                distillerReasoningEffort = resolved.reasoning ?? undefined;
                distillerContextTier = resolved.context ?? undefined;
            } catch (error: any) {
                if (error?.code === "MODEL_AMBIGUOUS") throw error;
                if (error?.code === "MODEL_UNRESOLVED") {
                    throw Object.assign(
                        new Error(`Unknown distiller model: ${opts?.distillerModel}. ${error.message}`),
                        { code: "MODEL_UNRESOLVED" },
                    );
                }
                throw new Error(`Unknown distiller model: ${opts?.distillerModel}. ${error?.message || String(error)}`);
            }
        }
        // Dead-model guard: the reborn session's grounding turn runs on the
        // session's model. If that model no longer resolves (a common regen
        // trigger is exactly a removed model), regenerating verbatim would
        // discard the transcript and then wedge on the dead model. Require a
        // live replacement rather than making a broken session strictly worse.
        const currentModel = (session as any).model as string | undefined;
        if (!targetModel && currentModel) {
            try {
                resolveRequested(currentModel);
            } catch (error: any) {
                if (error?.code === "MODEL_AMBIGUOUS") throw error;
                throw Object.assign(new Error(
                    `Session model '${currentModel}' is no longer available; pass a replacement model to regenerate this session. `
                    + `${error?.message || String(error)}`,
                ), { code: "MODEL_UNRESOLVED" });
            }
        }
        const attemptId = buildLifecycleCommandId("regenerate");
        await this.sendCommand(sessionId, {
            cmd: "regenerate",
            id: attemptId,
            args: {
                ...(opts?.handoff ? { handoff: String(opts.handoff).slice(0, 4_000) } : {}),
                ...(opts?.instructions ? { instructions: String(opts.instructions).slice(0, 4_000) } : {}),
                ...(opts?.distillMode === "deterministic" ? { distill_mode: "deterministic" } : {}),
                ...(distillerModel ? { distillerModel } : {}),
                ...(distillerReasoningEffort ? { distillerReasoningEffort } : {}),
                ...(distillerContextTier ? { distillerContextTier } : {}),
                ...(targetModel ? { model: targetModel } : {}),
                ...(opts?.force ? { force: true } : {}),
                source: opts?.source ?? "operator",
            },
        });
        return { attemptId };
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
            throw Object.assign(
                new Error(
                    "restartSystemSession requires a disposition: complete, terminate, or hard_delete "
                    + "(HTTP callers send it inside the options envelope: {\"options\":{\"disposition\":\"complete\"}})",
                ),
                { code: "INVALID_REQUEST" },
            );
        }

        const disposition = normalizeSystemRestartDisposition(options.disposition);
        const plan = this._resolveSystemAgentPlan(agentIdOrSessionId);
        const sessionId = plan.sessionId;
        const reason = options.reason ?? `Restarting system session ${plan.agent.id}`;
        const existingRow = await this._catalog!.getSession(sessionId);
        const previousSessionExisted = Boolean(existingRow);
        const providerStore = this._catalog!.providers;
        let persistedRoute: DefaultTuple | null = null;
        let persistedSource: string | null = null;
        if (providerStore) {
            const [defaults, overrides, credentials] = await Promise.all([
                providerStore.getDefaults(null),
                providerStore.listSystemAgentModels(),
                providerStore.allCredentials(),
            ]);
            const override = overrides.find((candidate) => candidate.agentId === plan.agent.id);
            if (override) {
                persistedRoute = override;
                persistedSource = "agent_override";
            } else if (defaults.system.provider && defaults.system.model) {
                persistedRoute = defaults.system;
                persistedSource = "system_default";
            } else {
                persistedRoute = this._firstAvailableTuple(
                    credentials,
                    (provider) => provider.class === "shared" || provider.systemUseEnabled === true,
                );
                persistedSource = persistedRoute ? "first_available" : null;
            }
        }
        let defaultModel = options.model
            ?? persistedRoute?.model
            ?? existingRow?.model
            ?? this._modelProviders?.defaultModel;
        if (!defaultModel) {
            throw new Error("Cannot restart system session without a configured default model");
        }
        let restartReasoning = Object.prototype.hasOwnProperty.call(options, "reasoningEffort")
            ? options.reasoningEffort ?? null
            : persistedRoute?.reasoning ?? existingRow?.reasoningEffort ?? null;
        let restartContext = Object.prototype.hasOwnProperty.call(options, "contextTier")
            ? options.contextTier ?? null
            : persistedRoute?.context ?? existingRow?.contextTier ?? null;
        let restartSource = options.modelResolutionSource ?? persistedSource ?? existingRow?.modelResolutionSource ?? "manual_restart";
        if (providerStore) {
            if (!this._modelProviders) {
                throw new Error("Cannot restart system session without a provider type catalog");
            }
            const credentials = await providerStore.allCredentials();
            const validated = resolveRuntimeModelSelection(this._modelProviders, credentials, {
                requestedModel: defaultModel,
                requestedReasoning: restartReasoning,
                requestedContext: restartContext,
                eligible: (provider) => provider.class === "shared" || provider.systemUseEnabled === true,
            });
            defaultModel = validated.model;
            restartReasoning = validated.reasoning as ReasoningEffort | null;
            restartContext = validated.context as ContextTier | null;
            if (!options.modelResolutionSource && !persistedSource) restartSource = validated.source;
        }
        const operationId = options.operationId ?? `manual:${buildLifecycleCommandId("system-restart")}`;
        const claimId = buildLifecycleCommandId("system-restart-claim");
        if (providerStore) {
            const claim = await providerStore.claimSystemRestart({
                agentId: plan.agent.id,
                operationId,
                claimId,
                model: defaultModel,
                reasoning: restartReasoning,
                context: restartContext,
                disposition,
            });
            if (claim !== "claimed") {
                return {
                    agentId: plan.agent.id,
                    agentName: plan.agent.name,
                    sessionId,
                    disposition,
                    previousSessionExisted,
                    startResults: [],
                    skippedReason: claim,
                };
            }
        }

        if (existingRow && !existingRow.isSystem) {
            throw new Error(`Session ${sessionId.slice(0, 8)} exists but is not a system session`);
        }

        try {
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

        const startResults = await startSystemAgents({
            catalog: this._catalog!,
            duroxideClient: this._duroxideClient,
            agents: this._systemAgents,
            defaultModel,
            defaultReasoningEffort: restartReasoning as ReasoningEffort | null,
            defaultContextTier: restartContext as ContextTier | null,
            modelResolutionSource: restartSource,
            blobEnabled: this.config.blobEnabled,
            dehydrateThreshold: this.config.waitThreshold ?? DEFAULT_SYSTEM_AGENT_DEHYDRATE_THRESHOLD,
            agentId: plan.agent.id,
            // The retained session id already has ledger rows from earlier
            // lifetimes; advance its ledger base so the new lifetime's
            // settles land on fresh keys instead of silently colliding.
            ...(providerStore ? {
                prepareRetainedSessionLedger: async (sid: string) => { await providerStore.bumpLedgerBase(sid); },
            } : {}),
        });
        const newSession = await this.getSession(sessionId).catch(() => null);
        if (!newSession) {
            throw new Error(`System session ${plan.agent.id} was not recreated`);
        }

        await providerStore?.finishSystemRestart(plan.agent.id, claimId, null);

        return {
            agentId: plan.agent.id,
            agentName: plan.agent.name,
            sessionId,
            disposition,
            previousSessionExisted,
            startResults,
        };
        } catch (error: any) {
            await providerStore?.finishSystemRestart(plan.agent.id, claimId, error?.message || String(error));
            throw error;
        }
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
     * The canvas data plane's last-value rows for one session (migration
     * 0047): current doc pointer + latest merged tick per slot. The browser's
     * snapshot source on subscribe and on seq gaps. Empty when the plane is
     * absent (older deployment) — callers fall back to canvas_data events.
     */
    /** Public view link status for one canvas — never the token itself. */
    async getCanvasShareLink(sessionId: string, slot: number): Promise<{ exists: boolean; createdAt?: string; createdBy?: string }> {
        this._ensureStarted();
        const catalog = this._catalog as any;
        if (typeof catalog?.getCanvasShareLinkInfo !== "function") return { exists: false };
        return catalog.getCanvasShareLinkInfo(sessionId, normalizeShareSlot(slot));
    }

    /**
     * Mint-or-rotate the ONE public view token for a canvas. The raw token
     * is generated here, returned exactly once, and only its sha256 hash is
     * stored — a rotate makes the previous link dead the moment the row
     * lands.
     */
    async resetCanvasShareLink(sessionId: string, slot: number, createdBy: string): Promise<{ token: string }> {
        this._ensureStarted();
        const catalog = this._catalog as any;
        if (typeof catalog?.setCanvasShareLink !== "function") {
            throw new Error("this deployment predates canvas share links");
        }
        const { randomBytes, createHash } = await import("node:crypto");
        const token = randomBytes(32).toString("base64url");
        const hash = createHash("sha256").update(token, "utf8").digest("hex");
        await catalog.setCanvasShareLink(sessionId, normalizeShareSlot(slot), hash, createdBy || "");
        return { token };
    }

    /**
     * SERVER-INTERNAL: hash lookup for the token doors (WS subscribe and the
     * share doc/live routes). Deliberately NOT a wire operation — the raw
     * resolve must never be callable by clients.
     */
    async resolveCanvasShareTokenHash(tokenHash: string): Promise<{ sessionId: string; slot: number } | null> {
        this._ensureStarted();
        const catalog = this._catalog as any;
        if (typeof catalog?.resolveCanvasShareToken !== "function") return null;
        return catalog.resolveCanvasShareToken(tokenHash);
    }

    async removeCanvasShareLink(sessionId: string, slot: number): Promise<{ removed: boolean }> {
        this._ensureStarted();
        const catalog = this._catalog as any;
        if (typeof catalog?.removeCanvasShareLink !== "function") return { removed: false };
        return { removed: await catalog.removeCanvasShareLink(sessionId, normalizeShareSlot(slot)) };
    }

    async getCanvasLive(sessionId: string): Promise<Array<{ slot: number; seq: number; docRev: number; docSha: string; payload: Record<string, unknown>; updatedBy: string; updatedAt: string }>> {
        this._ensureStarted();
        const catalog = this._catalog as any;
        if (typeof catalog?.getCanvasLive !== "function") return [];
        if (typeof catalog?.canvasLiveAvailable === "function" && !(await catalog.canvasLiveAvailable())) return [];
        return catalog.getCanvasLive(sessionId);
    }

    async getLive(sessionId: string, topics?: string[]): Promise<Array<{ topic: string; seq: number; payload: Record<string, unknown>; updatedBy: string; updatedAt: string }>> {
        this._ensureStarted();
        const catalog = this._catalog as any;
        if (typeof catalog?.getLive !== "function") return [];
        if (typeof catalog?.liveAvailable === "function" && !(await catalog.liveAvailable())) return [];
        return catalog.getLive(sessionId, topics);
    }

    // ── The canvas KV store (migration 0064) ─────────────────────────
    //
    // Doors 1 (signed-in) and 2 (link, read-only) land here with a RESOLVED
    // principal; every rule is the SDK chokepoint's (canvas-kv.ts). The
    // runtime has already gated session read for door 1.

    private _canvasKvStore(): CanvasKvStore {
        this._ensureStarted();
        const catalog = this._catalog as any;
        if (typeof catalog?.canvasKvWrite !== "function") {
            throw Object.assign(new Error("this deployment's catalog predates the canvas KV store (migration 0064)"), { code: "NOT_FOUND" });
        }
        return catalog as CanvasKvStore;
    }

    private _mapCanvasKvErrors<T>(run: () => Promise<T>): Promise<T> {
        return run().catch((error: any) => {
            if (error instanceof CanvasKvError) {
                error.code = error.code === "INVALID_KEY" ? "INVALID_REQUEST" : error.code;
            }
            throw error;
        });
    }

    async readCanvasKv(
        sessionId: string,
        slot: number,
        principal: CanvasKvPrincipal,
        query: { prefix?: string | null; limit?: number | null; after?: string | null; key?: string | null } = {},
    ): Promise<CanvasKvReadResult> {
        return this._mapCanvasKvErrors(() => readCanvasKv(this._canvasKvStore(), sessionId, slot, principal, query));
    }

    async writeCanvasKv(
        sessionId: string,
        slot: number,
        principal: CanvasKvPrincipal,
        ops: CanvasKvWriteOp[],
    ): Promise<{ results: CanvasKvWriteResult[]; me: CanvasKvMe }> {
        return this._mapCanvasKvErrors(() => writeCanvasKv(this._canvasKvStore(), sessionId, slot, principal, ops));
    }

    /** Door 2: a link bearer reads; the link door is read-only until phase 4. */
    async readCanvasKvForLink(
        sessionId: string,
        slot: number,
        query: { prefix?: string | null; limit?: number | null; after?: string | null; key?: string | null } = {},
    ): Promise<CanvasKvReadResult> {
        const principal: CanvasKvPrincipal = { kind: "link", writerId: "link", label: null, writeEnabled: false };
        return this._mapCanvasKvErrors(() => readCanvasKv(this._canvasKvStore(), sessionId, slot, principal, query));
    }

    async setCanvasKvAccess(sessionId: string, slot: number, access: "owner" | "readers" | "link"): Promise<void> {
        const store = this._canvasKvStore() as any;
        await store.setCanvasKvAccess(sessionId, slot, access);
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

    // ── Session footprint (sensor) ────────────────────────────

    private _footprintCache: FootprintCache | null = null;

    /**
     * Control-plane footprint for one session (never wakes it). TTL-cached
     * (§11 — TTL-only staleness by design); pass bypassCache for tests.
     */
    async getSessionFootprint(
        sessionId: string,
        opts?: { bypassCache?: boolean },
    ): Promise<SessionFootprint> {
        this._ensureStarted();
        if (!this._footprintCache) this._footprintCache = new FootprintCache();
        if (!opts?.bypassCache) {
            const cached = this._footprintCache.get(sessionId);
            if (cached) return cached;
        }
        const catalog = this._catalog!;
        const footprint = await computeSessionFootprint(
            {
                getSession: (id) => catalog.getSession(id),
                getSessionEventStats: (id, afterSeq) => catalog.getSessionEventStats(id, afterSeq),
                getSessionCompactionStats: (id, afterSeq) =>
                    catalog.getSessionCompactionStats(id, afterSeq),
                getSessionEventsBefore: (id, beforeSeq, limit, eventTypes) =>
                    catalog.getSessionEventsBefore(id, beforeSeq, limit, eventTypes),
                getSessionMetricSummary: (id) => catalog.getSessionMetricSummary(id),
                getDescendantSessionIds: (id) => catalog.getDescendantSessionIds(id),
                ...(this._factStore
                    ? { getSessionFactsStats: (id: string) => this.getSessionFactsStats(id) }
                    : {}),
                getOrchestrationStats: async (id) =>
                    (await this.getOrchestrationStats(id)) as Record<string, unknown> | null,
                getEpochBoundarySeq: async (id) => {
                    const rows = await catalog.getSessionEventsBefore(
                        id, Number.MAX_SAFE_INTEGER, 1, ["session.epoch_committed"],
                    );
                    return rows.length > 0 ? Number((rows[0] as any).seq) : null;
                },
            },
            sessionId,
        );
        this._footprintCache.set(footprint);
        return footprint;
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

    async readFacts(query: ReadFactsQuery, opts?: { admin?: boolean; sessionId?: string }): Promise<{ count: number; facts: FactRecord[] }> {
        const admin = opts?.admin === true;
        // sessionId is stamped by the authenticated surface after a READ gate.
        // It grants one session, never unrestricted access to caller-supplied keys.
        if (!admin && opts?.sessionId) {
            return this._requireFactStore().readFacts({ ...query, sessionId: opts.sessionId }, { readerSessionId: opts.sessionId, grantedSessionIds: [opts.sessionId] });
        }
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
     * @param options.sender Server-stamped sender identity (security model).
     *   Trusted metadata from the API edge — never client-supplied — recorded
     *   on the durable user.message event and used for multi-writer prompt
     *   attribution. Optional so the payload stays byte-identical for callers
     *   that don't pass it (frozen orchestration replay safety).
     */
    async sendMessage(
        sessionId: string,
        prompt: string,
        options?: { clientMessageIds?: string[]; sender?: MessageSender; attachments?: PromptAttachmentRef[] },
    ): Promise<void> {
        this._ensureStarted();
        const session = await this.getSession(sessionId);
        if (!session) {
            throw new Error(`Session ${sessionId.slice(0, 8)} was not found.`);
        }
        if ((session as any).serviceKind) {
            throw new Error(
                `Session ${sessionId.slice(0, 8)} is a service session (runtime machinery) — its transcript is a read-only trace and it does not accept messages.`,
            );
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
        const sender = normalizeMessageSender(options?.sender);
        if (sender) payload.sender = sender;
        const attachments = sanitizePromptAttachmentRefs(options?.attachments);
        if (attachments.length > 0) payload.attachments = attachments;
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
    async sendAnswer(sessionId: string, answer: string, options?: { sender?: MessageSender }): Promise<void> {
        this._ensureStarted();
        const orchId = `session-${sessionId}`;
        await this._assertOrchestrationLive(orchId, sessionId, "sendAnswer");
        const payload: Record<string, unknown> = { answer, wasFreeform: true };
        const sender = normalizeMessageSender(options?.sender);
        if (sender) payload.sender = sender;
        await this._duroxideClient.enqueueEvent(
            orchId,
            "messages",
            JSON.stringify(payload),
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

    // ─── Provider budgets ────────────────────────────────────
    //
    // The capabilities of docs/proposals/providers-and-budgets-surface.md.
    // Each one resolves the caller to a user id and hands that number, with
    // the role they signed in as, to a `cms_provider_*` procedure. Nothing
    // below asks whether the caller is allowed to do the thing: the procedure
    // raises PROVIDER_FORBIDDEN / PROVIDER_NOT_FOUND when they are not, and
    // that refusal is the same on every surface because it is made in one
    // place. See provider-store.ts.

    private _requireProviders(): ProviderStore {
        this._ensureStarted();
        const providers = this._catalog!.providers;
        if (!providers) throw new Error("Provider budgets are not available on this deployment.");
        return providers;
    }

    /**
     * The caller as the procedures want them: a numeric user id and a role.
     * The id lookup never creates a row, so an unknown caller stays `null`
     * rather than being minted by a read.
     */
    private async _providerActor(viewer: ProviderViewer): Promise<{
        store: ProviderStore;
        actor: number | null;
        isAdmin: boolean;
    }> {
        const store = this._requireProviders();
        return {
            store,
            actor: await store.lookupUserId(viewer?.principal ?? null),
            isAdmin: viewer?.isAdmin === true,
        };
    }

    private async _auditProviderMutation(
        viewer: ProviderViewer,
        action: string,
        target: string | null,
        details?: Record<string, unknown>,
    ): Promise<void> {
        await this._catalog!.recordAuthzAudit({
            actor: viewer.principal ? {
                provider: viewer.principal.provider,
                subject: viewer.principal.subject,
                display: viewer.principal.email ?? viewer.principal.displayName ?? null,
            } : null,
            action,
            target,
            decision: "provider_change",
            reason: null,
            details: details ?? null,
        }).catch(() => {});
    }

    private _providerTypeModels(typeId: string): ModelDescriptor[] {
        return this._modelProviders?.getModelsByProvider()
            .find((group) => group.providerId === typeId)?.models ?? [];
    }

    private _normalizeProviderTuple(
        row: ProviderRow,
        tuple: DefaultTuple,
    ): DefaultTuple {
        const provider = String(tuple.provider || "").trim();
        const requested = String(tuple.model || "").trim();
        if (!provider || !requested) {
            throw new ProviderError("PROVIDER_INVALID", "A default needs both a provider and model.");
        }
        const prefix = `${provider}:`;
        const modelName = requested.startsWith(prefix)
            ? requested.slice(prefix.length)
            : (requested.includes(":") ? "" : requested);
        if (!modelName) {
            throw new ProviderError(
                "PROVIDER_INVALID",
                `The model must belong to "${provider}": write it as "${provider}:<model>".`,
            );
        }
        const descriptor = this._providerTypeModels(row.typeId)
            .find((model) => model.modelName === modelName);
        if (this._modelProviders && !descriptor) {
            throw new ProviderError(
                "PROVIDER_INVALID",
                `Provider type "${row.typeId}" does not offer model "${modelName}".`,
            );
        }
        const reasoning = tuple.reasoning ?? descriptor?.defaultReasoningEffort ?? null;
        if (reasoning && descriptor?.supportedReasoningEfforts?.length
            && !descriptor.supportedReasoningEfforts.includes(reasoning as ReasoningEffort)) {
            throw new ProviderError("PROVIDER_INVALID", `Model ${provider}:${modelName} does not support reasoning effort '${reasoning}'.`);
        }
        const context = tuple.context ?? descriptor?.defaultContextTier ?? null;
        if (context && descriptor?.supportedContextTiers?.length
            && !descriptor.supportedContextTiers.includes(context as ContextTier)) {
            throw new ProviderError("PROVIDER_INVALID", `Model ${provider}:${modelName} does not support context tier '${context}'.`);
        }
        return { provider, model: `${provider}:${modelName}`, reasoning, context };
    }

    private async _validatedDefaultTuple(
        store: ProviderStore,
        actor: number | null,
        isAdmin: boolean,
        tuple: DefaultTuple,
        scope: "user" | "cluster" | "system",
    ): Promise<DefaultTuple> {
        if (!tuple.provider) return normalizeDefaultTuple(null);
        const rows = await store.listProviders(actor, isAdmin);
        const row = rows.find((candidate) => candidate.name === tuple.provider);
        if (!row) throw new ProviderError("PROVIDER_NOT_FOUND", `There is no provider named "${tuple.provider}".`);
        if (scope === "user" && !row.usableByMe) {
            throw new ProviderError("PROVIDER_NOT_FOUND", `There is no provider named "${tuple.provider}".`);
        }
        if (scope === "cluster" && row.class !== "shared") {
            throw new ProviderError("PROVIDER_INVALID", "The cluster default must be a shared provider.");
        }
        if (scope === "system" && !row.systemEligible) {
            throw new ProviderError("PROVIDER_INVALID", `Provider "${row.name}" is not enabled for system sessions.`);
        }
        const normalized = this._normalizeProviderTuple(row, tuple);
        const credential = scope === "system"
            ? await store.getSystemCredential(row.name)
            : await store.getCredential(row.name, actor);
        const modelName = normalized.model!.slice(normalized.model!.indexOf(":") + 1);
        if (!credential || !this._modelProviders
            || !resolveProviderCredential(this._modelProviders, credential, modelName)) {
            throw new ProviderError("PROVIDER_INVALID", `Provider "${row.name}" does not have a usable credential and endpoint.`);
        }
        return normalized;
    }

    private _firstAvailableTuple(
        credentials: ProviderCredential[],
        eligible: (credential: ProviderCredential) => boolean,
    ): DefaultTuple | null {
        if (!this._modelProviders) return null;
        for (const credential of credentials) {
            if (!eligible(credential)) continue;
            const first = this._providerTypeModels(credential.typeId)[0];
            if (!first) continue;
            if (!resolveProviderCredential(this._modelProviders, credential, first.modelName)) continue;
            return {
                provider: credential.name,
                model: `${credential.name}:${first.modelName}`,
                reasoning: first.defaultReasoningEffort ?? null,
                context: first.defaultContextTier ?? null,
            };
        }
        return null;
    }

    private _resolvedDefault(
        tuple: DefaultTuple | null,
        source: ResolvedModelDefault["source"],
    ): ResolvedModelDefault | null {
        if (!tuple?.provider || !tuple.model) return null;
        return {
            provider: tuple.provider,
            model: tuple.model,
            reasoningEffort: tuple.reasoning as ReasoningEffort | null,
            contextTier: tuple.context as ContextTier | null,
            source,
        };
    }

    /** Every shared provider plus the caller's own. Admins also see other people's, unusable. */
    async listProviders(viewer: ProviderViewer): Promise<{ providers: ProviderRow[] }> {
        const { store, actor, isAdmin } = await this._providerActor(viewer);
        return { providers: await store.listProviders(actor, isAdmin) };
    }

    /** Limits, what has been spent against them, reset times, and the caller's own ceiling. */
    async getProviderStatus(
        viewer: ProviderViewer,
        names?: string[] | null,
    ): Promise<{ providers: ProviderStatusRow[] }> {
        const { store, actor, isAdmin } = await this._providerActor(viewer);
        return { providers: await store.providerStatus(actor, isAdmin, names ?? null) };
    }

    /**
     * Everything the provider table draws, in one read.
     *
     * Rows come back in render order — shared providers first, then the
     * caller's own, each immediately followed by its model-scoped limits — so
     * a table draws the array as it arrives and never asks a second time per
     * provider.
     *
     * Every period reports a used figure whether or not a limit caps it. That
     * is the fact `getProviderStatus` cannot carry: it lists limits, and a
     * period with no limit has no limit to list.
     */
    async getProviderUsageGrid(viewer: ProviderViewer): Promise<{ rows: UsageGridRow[] }> {
        const { store, actor, isAdmin } = await this._providerActor(viewer);
        return { rows: await store.usageGrid(actor, isAdmin) };
    }

    /** Create a shared provider: anyone in the cluster may spend from it. */
    /**
     * Wake every session waiting on this provider.
     *
     * The durable timer a paused session sleeps on is only the BACKSTOP. What
     * should actually release it is the change itself — a limit raised or
     * removed, an allowance widened, a hold released, a missing name created
     * again — and without this that promise was never kept: a session paused
     * on a monthly limit would sleep out the backstop no matter what an
     * administrator did.
     *
     * The wake is a nudge, not a decision. Each woken session re-enters the
     * gate on its next turn and pauses again if the reason still holds, so a
     * raise that is still not enough wakes nobody in the end — and waking
     * after a change that releases no one costs one cheap re-check, because
     * the gate runs before the model.
     *
     * Best-effort throughout. A failed wake leaves the backstop, which is
     * exactly what it is for.
     */
    private async _wakeProvidersPaused(providerName: string): Promise<void> {
        await wakeProviderPausedSessions(this._catalog, this._duroxideClient, providerName);
    }

    /**
     * Refuse a provider type this deployment does not describe.
     *
     * The database cannot check it: the types live in the model-providers
     * FILE, which SQL has never read. Without this, a typo created a
     * provider that listed as an ordinary usable row and could never run a
     * turn — buildRuntimeRegistry drops an instance whose type it does not
     * know, silently, so the failure surfaced only as a session that waited
     * for ever on a name that was right there in the table.
     */
    private _assertKnownProviderType(typeId: string): void {
        const wanted = String(typeId ?? "").trim();
        const known = this.getModelsByProvider().map((g) => g.providerId);
        // No catalog at all is not evidence of a bad type — a deployment that
        // has not loaded one yet would refuse everything.
        if (known.length === 0) return;
        if (known.includes(wanted)) return;
        throw new ProviderError(
            "PROVIDER_INVALID",
            `No provider type named "${wanted}" on this deployment. `
            + `It has ${known.slice(0, 6).join(", ")}${known.length > 6 ? ", …" : ""}.`,
        );
    }

    /**
     * Does this type authenticate as the worker rather than with a key?
     *
     * The store knows a type only by its name, so the decision is made here,
     * where the type catalog is. An unknown type answers false and is refused
     * a moment later by `_assertKnownProviderType` — this is not the place
     * that reports it.
     */
    private _typeUsesWorkloadIdentity(typeId: string): boolean {
        const wanted = String(typeId ?? "").trim();
        const group = this.getModelsByProvider().find((candidate) => candidate.providerId === wanted);
        return providerTypeUsesWorkloadIdentity(group?.type);
    }

    /**
     * Refuse a key update on a provider that has no key.
     *
     * Accepting it would store a real secret in a row nothing ever reads a
     * secret from, and tell the person their rotation worked.
     */
    private async _assertCredentialIsUpdatable(store: ProviderStore, name: string, actor: number | null, isAdmin: boolean): Promise<void> {
        const rows = await store.listProviders(actor, isAdmin);
        const row = rows.find((candidate) => candidate.name === name);
        if (row && this._typeUsesWorkloadIdentity(row.typeId)) {
            throw new ProviderError(
                "PROVIDER_INVALID",
                `Provider "${name}" authenticates with the worker's workload identity and has no key to update. `
                + "Change the worker's identity configuration instead.",
            );
        }
    }

    async createProvider(
        viewer: ProviderViewer,
        input: ProviderCreateInput,
    ): Promise<{ name: string; typeId: string; class: ProviderClass }> {
        const { store, actor, isAdmin } = await this._providerActor(viewer);
        this._assertKnownProviderType(input.type);
        const created = await store.createProvider({
            name: input.name,
            typeId: input.type,
            class: "shared",
            secretRef: input.credentials ?? null,
            baseUrl: input.baseUrl ?? null,
            workloadIdentity: this._typeUsesWorkloadIdentity(input.type),
        }, actor, isAdmin);
        await this._auditProviderMutation(viewer, "createProvider", created.name, { class: "shared", type: created.typeId });
        // A name that did not resolve a moment ago now does.
        await this._wakeProvidersPaused(input.name);
        return created;
    }

    /** Create a provider of the caller's own, on their own credentials. Nobody else sees it. */
    async createMyProvider(
        viewer: ProviderViewer,
        input: ProviderCreateInput,
    ): Promise<{ name: string; typeId: string; class: ProviderClass }> {
        const { store, actor, isAdmin } = await this._providerActor(viewer);
        if (actor === null) {
            throw new ProviderError("PROVIDER_FORBIDDEN", "Sign in to add a personal provider.");
        }
        this._assertKnownProviderType(input.type);
        // A personal provider exists to run on ITS OWNER'S credentials. This
        // type has none: it runs on the worker's, which is the organization's.
        // A personal one would spend the cluster's own account under a name no
        // administrator can cap, hold or delete, because a personal provider
        // answers only to its owner — and anyone signed in may create one.
        if (this._typeUsesWorkloadIdentity(input.type)) {
            throw new ProviderError(
                "PROVIDER_FORBIDDEN",
                `Provider type "${input.type}" authenticates with the worker's own identity, `
                + "so it cannot be a personal provider. An administrator can add it as a shared one.",
            );
        }
        const created = await store.createProvider({
            name: input.name,
            typeId: input.type,
            class: "personal",
            ownerUserId: actor,
            secretRef: input.credentials ?? null,
            baseUrl: input.baseUrl ?? null,
        }, actor, isAdmin);
        await this._wakeProvidersPaused(input.name);
        await this._auditProviderMutation(viewer, "createMyProvider", created.name, { class: "personal", type: created.typeId });
        return created;
    }

    /** Replace the credential on one of the caller's own personal providers. */
    async updateMyProviderCredential(
        viewer: ProviderViewer,
        input: ProviderCredentialUpdateInput,
    ): Promise<{ name: string; typeId: string; class: ProviderClass }> {
        const { store, actor, isAdmin } = await this._providerActor(viewer);
        await this._assertCredentialIsUpdatable(store, input.name, actor, isAdmin);
        const updated = await store.updatePersonalCredential(input.name, input.credentials, actor);
        await this._auditProviderMutation(viewer, "updateMyProviderCredential", updated.name, {
            class: "personal",
            type: updated.typeId,
        });
        return updated;
    }

    /**
     * Replace the credential on a SHARED provider. Admin-only.
     *
     * Exists so an expired cluster key can be rotated in place. Deleting and
     * re-creating the name would drop the cluster-default flag, the allowance,
     * any hold, the system-use routing and the usage history — everything the
     * name carries.
     */
    async updateSharedProviderCredential(
        viewer: ProviderViewer,
        input: ProviderCredentialUpdateInput,
    ): Promise<{ name: string; typeId: string; class: ProviderClass }> {
        const { store, actor, isAdmin } = await this._providerActor(viewer);
        await this._assertCredentialIsUpdatable(store, input.name, actor, isAdmin);
        const updated = await store.updateSharedCredential(input.name, input.credentials, actor, isAdmin);
        await this._auditProviderMutation(viewer, "updateSharedProviderCredential", updated.name, {
            class: "shared",
            type: updated.typeId,
        });
        return updated;
    }

    /**
     * Remove a shared provider. Its sessions are not moved anywhere: they
     * wait on a name that no longer resolves, and the count says how many.
     */
    async deleteProvider(viewer: ProviderViewer, name: string): Promise<{ name: string; waitingSessions: number }> {
        const { store, actor, isAdmin } = await this._providerActor(viewer);
        const result = { name, waitingSessions: await store.deleteProvider(name, actor, isAdmin) };
        await this._auditProviderMutation(viewer, "deleteProvider", name, { waitingSessions: result.waitingSessions });
        return result;
    }

    /**
     * Remove one of the caller's own providers. The same call as
     * `deleteProvider`: `cms_provider_delete` refuses a name the caller may
     * not touch, so the two differ only in which door offers them.
     */
    async deleteMyProvider(viewer: ProviderViewer, name: string): Promise<{ name: string; waitingSessions: number }> {
        // The /me namespace holds ONLY the caller's own personal providers.
        // Delegating straight to deleteProvider let an admin delete a SHARED
        // provider through this route, and answered "forbidden" for shared
        // names — an existence oracle. Anything that is not the caller's own
        // personal provider is a name this namespace has never heard of.
        const { store, actor } = await this._providerActor(viewer);
        const rows = await store.listProviders(actor, false);
        const mine = rows.find((row) => row.name === name && row.class === "personal" && row.ownerUserId === actor);
        if (!mine) {
            throw new ProviderError("PROVIDER_NOT_FOUND", `there is no provider named "${name}"`);
        }
        const result = { name, waitingSessions: await store.deleteProvider(name, actor, false) };
        await this._auditProviderMutation(viewer, "deleteMyProvider", name, { waitingSessions: result.waitingSessions });
        return result;
    }

    async clearProviderRoutingDependencies(viewer: ProviderViewer, name: string) {
        const { store, actor, isAdmin } = await this._providerActor(viewer);
        const result = await store.clearRoutingDependencies(name, actor, isAdmin);
        await this._auditProviderMutation(viewer, "clearProviderRoutingDependencies", name, result);
        return { name, ...result };
    }

    /**
     * Save one limit. The same (period, scope) replaces what was there.
     * `seededTokens` is what this period had already spent when the limit
     * landed — a limit counts from the current window, it never resets it.
     */
    async setProviderLimit(
        viewer: ProviderViewer,
        input: ProviderLimitInput,
    ): Promise<{ ruleId: string; seededTokens: number }> {
        const { store, actor, isAdmin } = await this._providerActor(viewer);
        // Validate here, not in Postgres: an unparsable or fractional value
        // used to reach the proc and come back as a raw 22P02 dressed up as
        // an internal server error.
        const tokens = Number(input.tokens);
        if (!Number.isSafeInteger(tokens) || tokens < 0) {
            throw new ProviderError("PROVIDER_INVALID", "A limit is a whole number of tokens, zero or more.");
        }
        const saved = await store.setLimit({
            name: input.provider,
            period: input.period,
            modelQualified: input.model ?? null,
            limitTokens: tokens,
        }, actor, isAdmin);
        await this._wakeProvidersPaused(input.provider);
        return saved;
    }

    /** Drop one limit. `removed` is false when that (period, scope) had none. */
    async removeProviderLimit(viewer: ProviderViewer, input: ProviderLimitRef): Promise<{ removed: boolean }> {
        const { store, actor, isAdmin } = await this._providerActor(viewer);
        const removed = await store.removeLimit(input.provider, input.period, input.model ?? null, actor, isAdmin);
        await this._wakeProvidersPaused(input.provider);
        return { removed };
    }

    /** The share of each of a shared provider's limits that one person may use. 100 is full. */
    async setProviderAllowance(
        viewer: ProviderViewer,
        input: { provider: string; pct: number },
    ): Promise<{ name: string; allowancePct: number }> {
        const { store, actor, isAdmin } = await this._providerActor(viewer);
        const allowancePct = await store.setAllowance(input.provider, Number(input.pct), actor, isAdmin);
        await this._wakeProvidersPaused(input.provider);
        return { name: input.provider, allowancePct };
    }

    /**
     * Pause new turns against a provider, independently of any limit. With
     * neither an end time nor a release the hold has no end, and only
     * another call lifts it.
     */
    async setProviderHold(
        viewer: ProviderViewer,
        input: ProviderHoldInput,
    ): Promise<{ name: string; holdUntilUtc: string | null; holdIndefinite: boolean }> {
        const { store, actor, isAdmin } = await this._providerActor(viewer);
        const release = input.release === true;
        const untilUtc = release ? null : (input.untilUtc ?? null);
        if (untilUtc !== null) {
            const parsed = Date.parse(untilUtc);
            if (Number.isNaN(parsed)) {
                throw new ProviderError("PROVIDER_INVALID", `"${untilUtc}" is not a timestamp.`);
            }
            // A hold that has already ended holds nothing; accepting one and
            // echoing it back as set is the write-path lie the 2026-08-21
            // audit flagged. The Edit sheet validates too, but the API must
            // not trust the sheet.
            if (parsed <= Date.now()) {
                throw new ProviderError("PROVIDER_INVALID", "A hold must end in the future.");
            }
        }
        const indefinite = !release && !untilUtc;
        await store.setHold(input.provider, { untilUtc, indefinite }, actor, isAdmin);
        await this._wakeProvidersPaused(input.provider);
        return { name: input.provider, holdUntilUtc: untilUtc, holdIndefinite: indefinite };
    }

    /** Compatibility read: configured ordinary defaults plus system routing. */
    async getDefaults(viewer: ProviderViewer): Promise<ProviderDefaults> {
        const { store, actor, isAdmin } = await this._providerActor(viewer);
        return store.getDefaults(actor);
    }

    /** @deprecated Use setModelDefault({ scope: "cluster", ... }). */
    async setClusterDefault(viewer: ProviderViewer, tuple: DefaultTuple): Promise<DefaultTuple> {
        return this.setModelDefault(viewer, {
            scope: "cluster",
            provider: tuple.provider,
            model: tuple.model,
            reasoningEffort: tuple.reasoning as ReasoningEffort | null,
            contextTier: tuple.context as ContextTier | null,
        });
    }

    /** @deprecated Use setModelDefault({ scope: "user", ... }). */
    async setMyDefault(viewer: ProviderViewer, tuple: DefaultTuple | null): Promise<DefaultTuple> {
        return this.setModelDefault(viewer, {
            scope: "user",
            provider: tuple?.provider ?? null,
            model: tuple?.model ?? null,
            reasoningEffort: tuple?.reasoning as ReasoningEffort | null,
            contextTier: tuple?.context as ContextTier | null,
        });
    }

    async setModelDefault(viewer: ProviderViewer, input: ModelDefaultInput): Promise<DefaultTuple> {
        const { store, actor, isAdmin } = await this._providerActor(viewer);
        if (input.scope !== "user" && input.scope !== "cluster") {
            throw new ProviderError("PROVIDER_INVALID", "scope must be user or cluster.");
        }
        if (input.scope === "cluster" && !isAdmin) {
            throw new ProviderError("PROVIDER_FORBIDDEN", "Only an administrator can set the cluster default.");
        }
        const requested = normalizeDefaultTuple({
            provider: input.provider,
            model: input.model,
            reasoning: input.reasoningEffort ?? null,
            context: input.contextTier ?? null,
        });
        const next = await this._validatedDefaultTuple(store, actor, isAdmin, requested, input.scope);
        if (input.scope === "cluster") await store.setClusterDefault(next, isAdmin);
        else await store.setUserDefault(actor, next);
        await this._auditProviderMutation(viewer, "setModelDefault", next.provider, {
            scope: input.scope, model: next.model, cleared: next.provider === null,
        });
        return next;
    }

    async setProviderSystemUse(
        viewer: ProviderViewer,
        input: { provider: string; enabled: boolean },
    ): Promise<{ provider: string; systemUseEnabled: boolean }> {
        const { store, actor, isAdmin } = await this._providerActor(viewer);
        const provider = String(input.provider || "").trim();
        if (!provider) throw new ProviderError("PROVIDER_INVALID", "A provider name is required.");
        if (input.enabled === true) {
            const rows = await store.listProviders(actor, isAdmin);
            const row = rows.find((candidate) => candidate.name === provider);
            if (!row || row.class !== "personal" || !row.usableByMe) {
                throw new ProviderError("PROVIDER_NOT_FOUND", `There is no provider named "${provider}".`);
            }
            const first = row ? this._providerTypeModels(row.typeId)[0] : null;
            const credential = await store.getCredential(provider, actor);
            if (!row || !first || !credential || !this._modelProviders
                || !resolveProviderCredential(this._modelProviders, credential, first.modelName)) {
                throw new ProviderError("PROVIDER_INVALID", `Provider "${provider}" does not have a usable credential and endpoint.`);
            }
        }
        const systemUseEnabled = await store.setSystemUse(provider, input.enabled === true, actor, isAdmin);
        await this._auditProviderMutation(viewer, "setProviderSystemUse", provider, { enabled: systemUseEnabled });
        return { provider, systemUseEnabled };
    }

    async getLegacyProviderMigrationStatus(viewer: ProviderViewer) {
        const { store, isAdmin } = await this._providerActor(viewer);
        if (!isAdmin) throw new ProviderError("PROVIDER_FORBIDDEN", "Only an administrator can read legacy provider migration status.");
        return store.getLegacyKeyMigrationStatus();
    }

    async adoptLegacySystemGitHubCopilotKey(
        viewer: ProviderViewer,
        input: { name: string },
    ) {
        const { store, actor, isAdmin } = await this._providerActor(viewer);
        if (!isAdmin) throw new ProviderError("PROVIDER_FORBIDDEN", "Only an administrator can adopt the legacy System key.");
        const adopted = await store.adoptLegacySystemGitHubKey(
            String(input.name || "").trim(), actor, isAdmin);
        await this._auditProviderMutation(viewer, "adoptLegacySystemGitHubCopilotKey", adopted.name, {
            class: "personal", systemUseEnabled: true,
        });
        return { provider: adopted, status: await store.getLegacyKeyMigrationStatus() };
    }

    async getModelDefaults(viewer: ProviderViewer): Promise<{
        userSession: { configured: DefaultTuple; effective: ResolvedModelDefault | null; error: string | null };
        clusterSession: { configured: DefaultTuple; effective: ResolvedModelDefault | null; error: string | null };
        system: { configured: DefaultTuple; effective: ResolvedModelDefault | null; error: string | null; updatedBy: number | null; updatedAt: string | null };
        systemOverrides: SystemAgentModelOverride[];
    }> {
        const { store, actor, isAdmin } = await this._providerActor(viewer);
        const [configured, credentials, systemOverrides] = await Promise.all([
            store.getDefaults(actor),
            store.allCredentials(),
            store.listSystemAgentModels(),
        ]);
        const clusterFallback = this._firstAvailableTuple(credentials, (credential) => credential.class === "shared");
        const userFallback = this._firstAvailableTuple(
            credentials,
            (credential) => credential.class === "shared" || (actor !== null && credential.ownerUserId === actor),
        );
        const systemFallback = this._firstAvailableTuple(
            credentials,
            (credential) => credential.class === "shared" || credential.systemUseEnabled === true,
        );
        const resolveConfigured = (
            candidates: Array<{ tuple: DefaultTuple; source: "user_default" | "cluster_default" | "system_default" }>,
            eligible: (credential: ProviderCredential) => boolean,
            fallback: DefaultTuple | null,
        ): { tuple: DefaultTuple | null; source: ResolvedModelDefault["source"]; error: string | null } => {
            try {
                if (candidates.some((candidate) => candidate.tuple.provider || candidate.tuple.model)) {
                    const resolved = resolveRuntimeModelSelection(this._modelProviders!, credentials, {
                        defaults: candidates,
                        eligible,
                    });
                    return { tuple: resolved, source: resolved.source as ResolvedModelDefault["source"], error: null };
                }
                return { tuple: fallback, source: "first_available", error: null };
            } catch (error: any) {
                return { tuple: null, source: "first_available", error: error?.message || String(error) };
            }
        };
        const clusterResolution = this._modelProviders
            ? resolveConfigured(
                [{ tuple: configured.cluster, source: "cluster_default" }],
                (credential) => credential.class === "shared",
                clusterFallback)
            : { tuple: null, source: "first_available" as const, error: "Provider type catalog is unavailable." };
        const userCandidates = configured.mine.provider || configured.mine.model
            ? [{ tuple: configured.mine, source: "user_default" as const }]
            : configured.cluster.provider || configured.cluster.model
                ? [{ tuple: configured.cluster, source: "cluster_default" as const }]
                : [];
        const userResolution = this._modelProviders
            ? resolveConfigured(
                userCandidates,
                (credential) => credential.class === "shared" || (actor !== null && credential.ownerUserId === actor),
                userFallback)
            : { tuple: null, source: "first_available" as const, error: "Provider type catalog is unavailable." };
        const systemResolution = this._modelProviders
            ? resolveConfigured(
                [{ tuple: configured.system, source: "system_default" }],
                (credential) => credential.class === "shared" || credential.systemUseEnabled === true,
                systemFallback)
            : { tuple: null, source: "first_available" as const, error: "Provider type catalog is unavailable." };
        return {
            userSession: {
                configured: configured.mine,
                effective: this._resolvedDefault(userResolution.tuple, userResolution.source),
                error: userResolution.error,
            },
            clusterSession: {
                configured: configured.cluster,
                effective: this._resolvedDefault(clusterResolution.tuple, clusterResolution.source),
                error: clusterResolution.error,
            },
            system: {
                configured: isAdmin ? configured.system : normalizeDefaultTuple(null),
                effective: isAdmin
                    ? this._resolvedDefault(systemResolution.tuple, systemResolution.source)
                    : null,
                error: isAdmin ? systemResolution.error : null,
                updatedBy: isAdmin ? configured.systemUpdatedBy : null,
                updatedAt: isAdmin ? configured.systemUpdatedAt : null,
            },
            systemOverrides: isAdmin ? systemOverrides : [],
        };
    }

    async setSystemModelDefault(
        viewer: ProviderViewer,
        input: SystemModelDefaultInput,
    ): Promise<{
        configured: DefaultTuple;
        effective: ResolvedModelDefault | null;
        restart: null | {
            requested: true;
            disposition: "complete" | "terminate" | "hard_delete";
            affected: number;
            restarted: number;
            failures: Array<{ agentId: string; error: string }>;
        };
    }> {
        const { store, actor, isAdmin } = await this._providerActor(viewer);
        if (!isAdmin) throw new ProviderError("PROVIDER_FORBIDDEN", "Only an administrator can set the system default.");
        const requested = normalizeDefaultTuple({
            provider: input.provider,
            model: input.model,
            reasoning: input.reasoningEffort ?? null,
            context: input.contextTier ?? null,
        });
        const configured = await this._validatedDefaultTuple(store, actor, isAdmin, requested, "system");
        const disposition = input.restartExisting
            ? normalizeSystemRestartDisposition(input.restartExisting.disposition)
            : null;
        await store.setSystemDefault(actor, isAdmin, configured);
        await this._auditProviderMutation(viewer, "setSystemModelDefault", configured.provider, {
            model: configured.model,
            cleared: configured.provider === null,
            restartDisposition: disposition,
        });
        const defaults = await this.getModelDefaults(viewer);
        if (!input.restartExisting) {
            return { configured, effective: defaults.system.effective, restart: null };
        }
        if (!defaults.system.effective) {
            throw new ProviderError("PROVIDER_INVALID", "No system-eligible provider is available for restart.");
        }
        const operationId = [
            "system-default",
            disposition,
            defaults.system.effective.model,
            defaults.system.effective.reasoningEffort ?? "",
            defaults.system.effective.contextTier ?? "",
        ].join(":");
        const overridden = new Set(defaults.systemOverrides.map((override) => override.agentId));
        const candidatePlans = this._getSystemAgentPlans().filter((plan) => !overridden.has(plan.agent.id));
        const plans: SystemAgentSessionPlan[] = [];
        for (const plan of candidatePlans) {
            const row = await this._catalog!.getSession(plan.sessionId).catch(() => null);
            const rollout = await store.getSystemRestart(plan.agent.id);
            const retryingSameOperation = rollout?.operationId === operationId
                && rollout.status !== "complete";
            const live = Boolean(row && !row.deletedAt
                && !["completed", "failed", "error", "cancelled"].includes(row.state));
            if (!retryingSameOperation && !live) continue;
            if (!retryingSameOperation && row!.orchestrationId && row!.state !== "pending"
                && row!.model === defaults.system.effective.model
                && (row!.reasoningEffort ?? null) === (defaults.system.effective.reasoningEffort ?? null)
                && (row!.contextTier ?? null) === (defaults.system.effective.contextTier ?? null)) continue;
            plans.push(plan);
        }
        const failures: Array<{ agentId: string; error: string }> = [];
        let restarted = 0;
        for (const plan of plans) {
            try {
                const outcome = await this.restartSystemSession(plan.agent.id, {
                    disposition: disposition!,
                    model: defaults.system.effective.model,
                    reasoningEffort: defaults.system.effective.reasoningEffort,
                    contextTier: defaults.system.effective.contextTier,
                    modelResolutionSource: defaults.system.effective.source,
                    operationId,
                    reason: "Applying the configured system model default",
                });
                if (!outcome.skippedReason) restarted += 1;
            } catch (error: any) {
                failures.push({ agentId: plan.agent.id, error: error?.message || String(error) });
            }
        }
        return {
            configured,
            effective: defaults.system.effective,
            restart: { requested: true, disposition: disposition!, affected: plans.length, restarted, failures },
        };
    }

    async setSystemSessionModel(
        viewer: ProviderViewer,
        input: { agentId: string; provider: string; model: string; reasoningEffort?: ReasoningEffort | null; contextTier?: ContextTier | null },
    ): Promise<SystemAgentModelOverride> {
        const { store, actor, isAdmin } = await this._providerActor(viewer);
        if (!isAdmin) throw new ProviderError("PROVIDER_FORBIDDEN", "Only an administrator can set a system-agent model.");
        const plan = this._resolveSystemAgentPlan(input.agentId);
        const next = await this._validatedDefaultTuple(store, actor, isAdmin, normalizeDefaultTuple({
            provider: input.provider,
            model: input.model,
            reasoning: input.reasoningEffort ?? null,
            context: input.contextTier ?? null,
        }), "system");
        await store.setSystemAgentModel(plan.agent.id, actor, isAdmin, next);
        await this._auditProviderMutation(viewer, "setSystemSessionModel", plan.agent.id, {
            provider: next.provider, model: next.model,
        });
        const row = await this._catalog!.getSession(plan.sessionId).catch(() => null);
        if (row && !row.deletedAt && row.orchestrationId) {
            await this.sendCommand(plan.sessionId, {
                cmd: "set_model",
                id: buildLifecycleCommandId("set-system-model"),
                args: {
                    model: next.model,
                    reasoningEffort: next.reasoning,
                    contextTier: next.context,
                    source: "system_default",
                },
            });
        }
        return (await store.listSystemAgentModels()).find((override) => override.agentId === plan.agent.id)!;
    }

    async clearSystemSessionModel(viewer: ProviderViewer, agentId: string): Promise<{ agentId: string; cleared: boolean }> {
        const { store, actor, isAdmin } = await this._providerActor(viewer);
        if (!isAdmin) throw new ProviderError("PROVIDER_FORBIDDEN", "Only an administrator can clear a system-agent model.");
        const plan = this._resolveSystemAgentPlan(agentId);
        const cleared = await store.clearSystemAgentModel(plan.agent.id, actor, isAdmin);
        if (cleared) await this._auditProviderMutation(viewer, "clearSystemSessionModel", plan.agent.id, { cleared: true });
        if (cleared) {
            const defaults = await this.getModelDefaults(viewer);
            const row = await this._catalog!.getSession(plan.sessionId).catch(() => null);
            if (row && !row.deletedAt && row.orchestrationId && defaults.system.effective) {
                await this.sendCommand(plan.sessionId, {
                    cmd: "set_model",
                    id: buildLifecycleCommandId("clear-system-model"),
                    args: {
                        model: defaults.system.effective.model,
                        reasoningEffort: defaults.system.effective.reasoningEffort,
                        contextTier: defaults.system.effective.contextTier,
                        source: "system_default",
                    },
                });
            }
        }
        return { agentId: plan.agent.id, cleared };
    }

    /**
     * Where the tokens went: totals, the daily chart, and one breakdown, over
     * the same filters. Three reads because they group differently, one
     * answer because a report that shows a total and a chart from different
     * filters is a report nobody can act on.
     *
     * The breakdown asks for one row more than it returns, so `truncated`
     * reports the cut rather than guessing at it.
     */
    async getProviderUsage(viewer: ProviderViewer, query: ProviderUsageQuery = {}): Promise<ProviderUsageReport> {
        const { store, actor, isAdmin } = await this._providerActor(viewer);
        const dimension = PROVIDER_USAGE_DIMENSIONS.includes(query.dimension as ProviderUsageDimension)
            ? query.dimension as ProviderUsageDimension
            : "provider";
        const limit = clampInteger(query.limit ?? undefined, 40, 1, 200);
        const filters: UsageFilters = {
            days: clampInteger(query.days ?? undefined, 7, 1, 365),
            // `mine` beats a supplied id: it is the one form that cannot name
            // anybody but the caller.
            ownerUserId: query.mine === true ? actor : (query.ownerUserId ?? null),
            provider: query.provider ?? null,
            model: query.model ?? null,
            sessionId: query.sessionId ?? null,
            chargeClass: query.chargeClass ?? null,
        };
        const [totals, daily, breakdown] = await Promise.all([
            store.usageTotals(actor, isAdmin, filters),
            store.usageDaily(actor, isAdmin, filters),
            store.usageBreakdown(actor, isAdmin, dimension, filters, limit + 1, viewer.adminScope === "cluster" && isAdmin),
        ]);
        return {
            totals,
            daily,
            breakdown: breakdown.slice(0, limit),
            dimension,
            truncated: breakdown.length > limit,
        };
    }

    /**
     * The cluster summary: totals for today / the week / the month, a per-day
     * series and the per-model pivot, over every provider (or the ones named).
     * Read from the ledger, so system sessions are in it — unlike the meters
     * the Providers tab reads, which count people's turns only.
     */
    async getProviderUsageSummary(viewer: ProviderViewer, query: ProviderUsageSummaryQuery = {}): Promise<ProviderUsageSummary> {
        const { store, actor, isAdmin } = await this._providerActor(viewer);
        const days = clampInteger(query.days ?? undefined, 14, 1, 365);
        const providers = Array.isArray(query.providers) ? query.providers : null;
        return await store.usageSummary(actor, isAdmin, days, providers) as unknown as ProviderUsageSummary;
    }

    /**
     * The agent pivot from the same ledger: tokens, turns and models per
     * agent (with '(none)' for unbound sessions) plus a day×agent series.
     * Same viewer scoping as getProviderUsageSummary.
     */
    async getProviderUsageAgents(viewer: ProviderViewer, query: ProviderUsageSummaryQuery = {}): Promise<Record<string, unknown>> {
        const { store, actor, isAdmin } = await this._providerActor(viewer);
        const days = clampInteger(query.days ?? undefined, 14, 1, 365);
        const providers = Array.isArray(query.providers) ? query.providers : null;
        return await store.usageAgents(actor, isAdmin, days, providers, viewer.adminScope === "cluster" && isAdmin) as Record<string, unknown>;
    }

    /** Sessions waiting on a limit right now, with what is holding each one. */
    async listPausedSessions(viewer: ProviderViewer): Promise<{ sessions: PausedSessionRow[] }> {
        const { store, actor, isAdmin } = await this._providerActor(viewer);
        return { sessions: await store.listPaused(actor, isAdmin, 100, viewer.adminScope === "cluster" && isAdmin) };
    }

    // ─── Agent packages / worker registry ────────────────────

    private _agentPackagePrincipal(owner: AgentPrincipal | null | undefined, isAdmin: boolean): AgentPrincipal | null {
        if (owner?.provider && owner?.subject) {
            return { provider: owner.provider, subject: owner.subject };
        }
        if (isAdmin) return null;
        const error: any = new Error("agent-package operations require an authenticated principal");
        error.code = "FORBIDDEN";
        throw error;
    }

    private _agentPackageSelector(selector?: any, isAdmin = false): AgentPackageSelector | null {
        if (!selector || typeof selector !== "object") return null;
        const scope = selector.scope === "shared" || selector.scope === "user" ? selector.scope : null;
        const provider = String(selector.ownerProvider || selector.owner?.provider || "").trim();
        const subject = String(selector.ownerSubject || selector.owner?.subject || "").trim();
        const owner = isAdmin && provider && subject ? { provider, subject } : null;
        if (!scope && !owner) return null;
        return { ...(scope ? { scope } : {}), ...(owner ? { owner } : {}) };
    }

    private async _mapAgentPackageErrors<T>(run: () => Promise<T>): Promise<T> {
        try {
            return await run();
        } catch (error: any) {
            const message = String(error?.message || "");
            if (/AGENT_(?:PACKAGE|SOURCE)_[A-Z_]*FORBIDDEN/.test(message)) error.code = "FORBIDDEN";
            else if (/AGENT_(?:PACKAGE|SOURCE)_[A-Z_]*NOT_FOUND/.test(message)) error.code = "NOT_FOUND";
            else if (/AGENT_PACKAGE_(?:SEMVER_CONFLICT|SCOPE_MISMATCH|NAME_TAKEN|AMBIGUOUS)/.test(message)) error.code = "CONFLICT";
            else if (/AGENT_PACKAGE_(?:BAD_(?:SCOPE|NAME)|NO_OWNER|RESERVED_NAME|NOT_SHARED|EDITOR_IS_OWNER)/.test(message)) error.code = "INVALID_REQUEST";
            throw error;
        }
    }

    private _requireAgentPackageArtifacts(): ArtifactStore {
        if (!this._artifactStore) {
            throw new Error("agent-package artifact operations require an artifact store in direct mode");
        }
        return this._artifactStore;
    }

    async listAgentPackages(owner: AgentPrincipal | null, isAdmin: boolean): Promise<AgentPackageSummary[]> {
        this._ensureStarted();
        return this._catalog!.listAgentPackages(this._agentPackagePrincipal(owner, isAdmin), isAdmin);
    }

    async getAgentPackage(
        name: string,
        owner: AgentPrincipal | null,
        isAdmin: boolean,
        selector?: AgentPackageSelector | null,
    ): Promise<AgentPackageDetail | null> {
        this._ensureStarted();
        return this._catalog!.getAgentPackage(
            name,
            this._agentPackagePrincipal(owner, isAdmin),
            isAdmin,
            this._agentPackageSelector(selector, isAdmin),
        );
    }

    async listAgentWorkerState(): Promise<AgentWorkerStateRow[]> {
        this._ensureStarted();
        return this._catalog!.listAgentWorkerState();
    }

    async listWorkers(): Promise<WorkerRow[]> {
        this._ensureStarted();
        return this._catalog!.listWorkers();
    }

    async setAgentPackageScope(
        name: string,
        scope: AgentPackageScope,
        owner: AgentPrincipal | null,
        isAdmin: boolean,
        selector?: AgentPackageSelector | null,
    ): Promise<{ ok: true }> {
        this._ensureStarted();
        const targetScope = scope === "shared" ? "shared" : "user";
        const principal = this._agentPackagePrincipal(owner, isAdmin);
        const ownerOverride = this._agentPackageSelector(selector, isAdmin)?.owner ?? null;
        let sourceSelector: AgentPackageSelector | null = null;
        if (targetScope === "user") sourceSelector = { scope: "shared", ...(ownerOverride ? { owner: ownerOverride } : {}) };
        else if (ownerOverride) sourceSelector = { scope: "user", owner: ownerOverride };
        await this._mapAgentPackageErrors(() => this._catalog!.setAgentPackageScope(
            name, targetScope, principal, isAdmin, sourceSelector,
        ));
        return { ok: true };
    }

    async setAgentPackageEnabled(
        name: string,
        enabled: boolean,
        owner: AgentPrincipal | null,
        isAdmin: boolean,
        selector?: AgentPackageSelector | null,
    ): Promise<{ ok: true }> {
        this._ensureStarted();
        await this._mapAgentPackageErrors(() => this._catalog!.setAgentPackageEnabled(
            name, Boolean(enabled), this._agentPackagePrincipal(owner, isAdmin), isAdmin,
            this._agentPackageSelector(selector, isAdmin),
        ));
        return { ok: true };
    }

    // ── Editors: write grants on a SHARED package ─────────────────────
    //
    // No copy selector on any of these: editors exist only on the shared
    // copy, so the name alone is unambiguous. Grant/revoke are owner-or-admin
    // (enforced in SQL); the list is readable by anyone who can see the
    // package.

    async grantAgentPackageEditor(
        name: string,
        grantee: { provider: string; subject: string },
        owner: AgentPrincipal | null,
        isAdmin: boolean,
    ): Promise<{ ok: true }> {
        this._ensureStarted();
        const provider = String(grantee?.provider ?? "").trim();
        const subject = String(grantee?.subject ?? "").trim();
        if (!provider || !subject) {
            throw Object.assign(new Error("grantAgentPackageEditor requires user { provider, subject }"), { code: "INVALID_REQUEST" });
        }
        await this._mapAgentPackageErrors(() => this._catalog!.grantAgentPackageEditor(
            name, { provider, subject }, this._agentPackagePrincipal(owner, isAdmin), isAdmin,
        ));
        return { ok: true };
    }

    async revokeAgentPackageEditor(
        name: string,
        grantee: { provider: string; subject: string },
        owner: AgentPrincipal | null,
        isAdmin: boolean,
    ): Promise<{ ok: true }> {
        this._ensureStarted();
        const provider = String(grantee?.provider ?? "").trim();
        const subject = String(grantee?.subject ?? "").trim();
        if (!provider || !subject) {
            throw Object.assign(new Error("revokeAgentPackageEditor requires user { provider, subject }"), { code: "INVALID_REQUEST" });
        }
        await this._mapAgentPackageErrors(() => this._catalog!.revokeAgentPackageEditor(
            name, { provider, subject }, this._agentPackagePrincipal(owner, isAdmin), isAdmin,
        ));
        return { ok: true };
    }

    async listAgentPackageEditors(name: string): Promise<AgentPackageEditorInfo[]> {
        this._ensureStarted();
        return this._mapAgentPackageErrors(() => this._catalog!.listAgentPackageEditors(name));
    }

    async pinAgentPackageVersion(
        name: string,
        semver: string,
        owner: AgentPrincipal | null,
        isAdmin: boolean,
        selector?: AgentPackageSelector | null,
    ): Promise<{ ok: true }> {
        this._ensureStarted();
        await this._mapAgentPackageErrors(() => this._catalog!.pinAgentPackageVersion(
            name, semver, this._agentPackagePrincipal(owner, isAdmin), isAdmin,
            this._agentPackageSelector(selector, isAdmin),
        ));
        return { ok: true };
    }

    async deleteAgentPackage(
        name: string,
        owner: AgentPrincipal | null,
        isAdmin: boolean,
        selector?: AgentPackageSelector | null,
    ): Promise<{ ok: true }> {
        this._ensureStarted();
        await this._mapAgentPackageErrors(() => deleteAgentPackageEverywhere(
            { catalog: this._catalog!, artifactStore: this._requireAgentPackageArtifacts() },
            name,
            this._agentPackagePrincipal(owner, isAdmin),
            isAdmin,
            this._agentPackageSelector(selector, isAdmin),
        ));
        return { ok: true };
    }

    async publishAgentPackageDirectory(
        dir: string,
        scope: AgentPackageScope,
        owner: AgentPrincipal | null,
        isAdmin: boolean,
        opts: { createdBy?: string | null; reservedAgentNames?: string[]; reservedMcpServerNames?: string[] } = {},
    ) {
        this._ensureStarted();
        return this._mapAgentPackageErrors(() => publishAgentPackageDir(
            { catalog: this._catalog!, artifactStore: this._requireAgentPackageArtifacts() },
            {
                dir,
                scope,
                owner: this._agentPackagePrincipal(owner, isAdmin),
                createdBy: opts.createdBy ?? null,
                isAdmin,
                ...(opts.reservedAgentNames?.length || opts.reservedMcpServerNames?.length
                    ? { validate: { reservedAgentNames: opts.reservedAgentNames ?? [], reservedMcpServerNames: opts.reservedMcpServerNames ?? [] } }
                    : {}),
            },
        ));
    }

    async uploadAgentPackage(
        files: Array<{ path: string; contentBase64: string }>,
        scope: AgentPackageScope,
        owner: AgentPrincipal | null,
        isAdmin: boolean,
        opts: { createdBy?: string | null; reservedAgentNames?: string[]; reservedMcpServerNames?: string[] } = {},
    ) {
        const invalid = (message: string) => Object.assign(new Error(message), { code: "INVALID_REQUEST" });
        const tooLarge = (message: string) => Object.assign(new Error(message), { code: "PAYLOAD_TOO_LARGE" });
        // An absent scope means "user", as it does on the CLI and the MCP tool.
        // Anything else is refused HERE: the SQL check `p_scope NOT IN (...)`
        // is NULL for a NULL scope and lets it through to a NOT NULL violation,
        // which surfaced as a 500 with a raw SQLSTATE.
        const resolvedScope: AgentPackageScope = scope == null ? "user" : scope;
        if (resolvedScope !== "shared" && resolvedScope !== "user") {
            throw invalid(`AGENT_PACKAGE_BAD_SCOPE: scope must be shared or user, got "${String(scope)}"`);
        }
        if (!Array.isArray(files) || files.length === 0) throw invalid("upload requires files: [{ path, contentBase64 }]");
        if (files.length > 2_000) throw tooLarge("upload exceeds 2000 files");
        const normalizedPaths = files.map((file) => String(file?.path || ""));
        const pathSet = new Set<string>();
        for (const rel of normalizedPaths) {
            if (pathSet.has(rel)) throw invalid(`upload contains duplicate file path: ${rel}`);
            const parts = rel.split("/");
            for (let index = 1; index < parts.length; index++) {
                const parent = parts.slice(0, index).join("/");
                if (pathSet.has(parent)) throw invalid(`upload path conflicts with file path: ${parent} and ${rel}`);
            }
            for (const existing of pathSet) {
                if (existing.startsWith(`${rel}/`)) throw invalid(`upload path conflicts with file path: ${rel} and ${existing}`);
            }
            pathSet.add(rel);
        }
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ps-agent-upload-"));
        try {
            let total = 0;
            for (const file of files) {
                const rel = String(file?.path || "");
                if (!rel || rel.startsWith("/") || rel.includes("\\") || rel.split("/").some((part) => part === "..")) {
                    throw invalid(`upload file path is not a safe relative path: ${rel}`);
                }
                const encoded = String(file?.contentBase64 || "");
                const remaining = 2 * 1024 * 1024 - total;
                if (encoded.length > Math.ceil(remaining * 4 / 3) + 4) throw tooLarge("upload exceeds the 2 MB envelope");
                const bytes = Buffer.from(encoded, "base64");
                total += bytes.length;
                if (total > 2 * 1024 * 1024) throw tooLarge("upload exceeds the 2 MB envelope");
                const target = path.resolve(tmp, rel);
                if (target === tmp || !target.startsWith(tmp + path.sep)) throw invalid(`upload file path escapes the package root: ${rel}`);
                fs.mkdirSync(path.dirname(target), { recursive: true });
                fs.writeFileSync(target, bytes);
            }
            return await this.publishAgentPackageDirectory(tmp, resolvedScope, owner, isAdmin, opts);
        } catch (error) {
            if (error instanceof AgentPackageValidationError) {
                const wrapped: any = new Error(error.message);
                wrapped.code = "VALIDATION_FAILED";
                wrapped.validation = error.validation;
                throw wrapped;
            }
            throw error;
        } finally {
            fs.rmSync(tmp, { recursive: true, force: true });
        }
    }

    private async _agentPackageVersion(name: string, semver: string | null, owner: AgentPrincipal | null, isAdmin: boolean, selector?: AgentPackageSelector | null) {
        this._ensureStarted();
        return resolveAgentPackageVersion(
            this._catalog!, name, this._agentPackagePrincipal(owner, isAdmin), isAdmin,
            this._agentPackageSelector(selector, isAdmin), semver,
        );
    }

    async getAgentPackageTree(name: string, semver: string | null, owner: AgentPrincipal | null, isAdmin: boolean, selector?: AgentPackageSelector | null) {
        this._ensureStarted();
        const { version, entries } = await readAgentPackageVersionEntries(
            { catalog: this._catalog!, artifactStore: this._requireAgentPackageArtifacts() },
            name, this._agentPackagePrincipal(owner, isAdmin), isAdmin,
            this._agentPackageSelector(selector, isAdmin), semver,
        );
        const dirs = new Set<string>();
        const files = entries.map((entry) => {
            const parts = entry.name.split("/");
            for (let index = 1; index < parts.length; index++) dirs.add(parts.slice(0, index).join("/"));
            return { path: entry.name, size: entry.body.length };
        }).sort((left, right) => left.path.localeCompare(right.path));
        return { name, semver: version.semver, sha256: version.sha256, dirs: [...dirs].sort(), files };
    }

    async getAgentPackageFile(name: string, semver: string | null, filePath: string, owner: AgentPrincipal | null, isAdmin: boolean, selector?: AgentPackageSelector | null) {
        this._ensureStarted();
        const { version, entries } = await readAgentPackageVersionEntries(
            { catalog: this._catalog!, artifactStore: this._requireAgentPackageArtifacts() },
            name, this._agentPackagePrincipal(owner, isAdmin), isAdmin,
            this._agentPackageSelector(selector, isAdmin), semver,
        );
        const entry = entries.find((candidate) => candidate.name === filePath);
        if (!entry) throw Object.assign(new Error(`"${filePath}" is not in ${name}@${version.semver}`), { code: "NOT_FOUND" });
        const binary = entry.body.includes(0);
        let body = entry.body.subarray(0, 256 * 1024);
        let text = "";
        if (!binary) {
            const decoder = new TextDecoder("utf-8", { fatal: true });
            for (let trim = 0; trim <= 4; trim++) {
                try {
                    text = decoder.decode(trim ? body.subarray(0, body.length - trim) : body);
                    if (trim) body = body.subarray(0, body.length - trim);
                    break;
                } catch {
                    if (trim === 4) text = body.toString("utf8");
                }
            }
        }
        return {
            name, semver: version.semver, path: filePath, size: entry.body.length,
            truncated: entry.body.length > body.length,
            binary,
            encoding: binary ? "base64" : "utf8",
            content: binary ? body.toString("base64") : text,
        };
    }

    async downloadAgentPackage(
        name: string,
        semver: string | null,
        owner: AgentPrincipal | null,
        isAdmin: boolean,
        selector?: AgentPackageSelector | null,
    ): Promise<{
        name: string;
        semver: string;
        sha256: string;
        filename: string;
        contentType: string;
        body: Uint8Array;
    }> {
        this._ensureStarted();
        const { version } = await this._agentPackageVersion(name, semver, owner, isAdmin, selector);
        const body = await fetchAgentPackageTarGz(
            this._requireAgentPackageArtifacts(), version.artifactFilename, version.sha256,
        );
        return {
            name,
            semver: version.semver,
            sha256: version.sha256,
            filename: `${name}@${version.semver}.tgz`,
            contentType: "application/gzip",
            body,
        };
    }

    async republishAgentPackageVersion(
        name: string,
        semver: string | null,
        targetScope: AgentPackageScope,
        owner: AgentPrincipal | null,
        isAdmin: boolean,
        opts: { createdBy?: string | null; selector?: AgentPackageSelector | null } = {},
    ) {
        this._ensureStarted();
        const principal = this._agentPackagePrincipal(owner, isAdmin);
        const target = targetScope === "shared" ? "shared" : "user";
        const sourceScope: AgentPackageScope = target === "shared" ? "user" : "shared";
        return this._mapAgentPackageErrors(async () => {
            const selectedOwner = this._agentPackageSelector(opts.selector, isAdmin)?.owner ?? null;
            const { detail, version } = await this._agentPackageVersion(name, semver, principal, isAdmin, {
                scope: sourceScope,
                ...(selectedOwner ? { owner: selectedOwner } : {}),
            });
            const targz = await fetchAgentPackageTarGz(this._requireAgentPackageArtifacts(), version.artifactFilename, version.sha256);
            const outcome = await publishPackedAgentPackage(
                { catalog: this._catalog!, artifactStore: this._requireAgentPackageArtifacts() },
                {
                    manifest: version.manifest as any,
                    targz,
                    sha256: version.sha256,
                    scope: target,
                    owner: principal,
                    createdBy: `republish of ${sourceScope} ${name}@${version.semver}`
                        + (opts.createdBy ? ` by ${opts.createdBy}` : ""),
                    isAdmin,
                    sourceId: detail.sourceId ?? null,
                    commitSha: version.commitSha ?? null,
                },
            );
            const { manifest: _manifest, ...summary } = outcome;
            return summary;
        });
    }

    // ─── Models ──────────────────────────────────────────────

    /**
     * List all available models across all configured providers.
     */
    listModels(): ModelSummary[] {
        if (!this._modelProviders) return [];
        return this._modelProviders.allModels.map((m: ModelDescriptor) => ({
            catalogKind: "provider_type",
            qualifiedName: m.qualifiedName,
            providerId: m.providerId,
            providerType: m.providerType,
            modelName: m.modelName,
            description: m.description,
            cost: m.cost,
            ...(m.supportedReasoningEfforts?.length ? { supportedReasoningEfforts: m.supportedReasoningEfforts } : {}),
            ...(m.defaultReasoningEffort ? { defaultReasoningEffort: m.defaultReasoningEffort } : {}),
            ...(m.supportedContextTiers?.length ? { supportedContextTiers: m.supportedContextTiers } : {}),
            ...(m.defaultContextTier ? { defaultContextTier: m.defaultContextTier } : {}),
            ...(m.contextWindowSizes ? { contextWindowSizes: m.contextWindowSizes } : {}),
            credentialAvailable: this.getModelCredentialStatus(m.qualifiedName).credentialAvailable,
        }));
    }

    async listRuntimeModels(viewer: ProviderViewer): Promise<ModelSummary[]> {
        const typeModels = this.listModels();
        const { store, actor, isAdmin } = await this._providerActor(viewer);
        const [providers, credentials] = await Promise.all([
            store.listProviders(actor, isAdmin),
            store.allCredentials(),
        ]);
        const credentialByName = new Map(credentials.map((credential) => [credential.name, credential]));
        const out: ModelSummary[] = [];
        for (const provider of providers.filter((candidate) => candidate.usableByMe)) {
            const credential = credentialByName.get(provider.name);
            for (const model of typeModels.filter((candidate) => candidate.providerId === provider.typeId)) {
                const credentialAvailable = Boolean(
                    credential && this._modelProviders
                    && resolveProviderCredential(this._modelProviders, credential, model.modelName),
                );
                out.push({
                    ...model,
                    catalogKind: "runtime_provider",
                    providerId: provider.name,
                    qualifiedName: `${provider.name}:${model.modelName}`,
                    credentialAvailable,
                });
            }
        }
        return out;
    }

    /**
     * Get models grouped by provider for display.
     */
    getModelsByProvider(): Array<{ catalogKind: "provider_type"; providerId: string; type: string; models: ModelSummary[] }> {
        if (!this._modelProviders) return [];
        return this._modelProviders.getModelsByProvider().map(g => ({
            catalogKind: "provider_type" as const,
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
                ...(m.supportedContextTiers?.length ? { supportedContextTiers: m.supportedContextTiers } : {}),
                ...(m.defaultContextTier ? { defaultContextTier: m.defaultContextTier } : {}),
                ...(m.contextWindowSizes ? { contextWindowSizes: m.contextWindowSizes } : {}),
                credentialAvailable: this.getModelCredentialStatus(m.qualifiedName).credentialAvailable,
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
            // A workload-identity provider has a credential in every sense
            // that matters here — the worker can authenticate — it just is
            // not a stored one. Testing for a key would grey out the model in
            // every picker and refuse it as a default.
            credentialAvailable: resolved.usesWorkloadIdentity
                ? true
                : resolved.type === "github"
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

/**
 * Construct a management client with an honest return type.
 *
 * Web options yield the WebPilotSwarmManagementClient itself — including its
 * generated `ops` surface (one wire-shaped method per protocol-table
 * operation) — rather than a cast to the direct class. Direct options yield
 * the direct client.
 *
 * `new PilotSwarmManagementClient(options)` remains supported and behaves
 * identically at runtime; this factory exists so web-mode callers get the
 * type that tells the truth.
 */
export function createManagementClient(options: PilotSwarmWebOptions): WebPilotSwarmManagementClient;
export function createManagementClient(options: PilotSwarmManagementClientOptions): PilotSwarmManagementClient;
export function createManagementClient(
    options: PilotSwarmManagementClientOptions | PilotSwarmWebOptions,
): PilotSwarmManagementClient | WebPilotSwarmManagementClient {
    return isWebOptions(options)
        ? new WebPilotSwarmManagementClient(options)
        : new PilotSwarmManagementClient(options);
}
