/**
 * Session Catalog (CMS) — provider-based session metadata store.
 *
 * The client writes to CMS before making duroxide calls (write-first).
 * CMS is the source of truth for session lifecycle.
 * Duroxide state is eventually consistent with CMS.
 *
 * @module
 */

import { runCmsMigrations } from "./cms-migrator.js";
import type { SessionOwnerInfo, SessionSummaryState } from "./types.js";

// ─── Types ───────────────────────────────────────────────────────

/** A persisted session event (non-ephemeral). */
export interface SessionEvent {
    seq: number;
    sessionId: string;
    eventType: string;
    data: unknown;
    createdAt: Date;
    workerNodeId?: string;
}

/** One row from cms_get_top_event_emitters. */
export interface TopEventEmitterRow {
    workerNodeId: string;
    eventType: string;
    eventCount: number;
    sessionCount: number;
    firstSeenAt: Date | null;
    lastSeenAt: Date | null;
}

export interface InsertTurnMetricInput {
    sessionId: string;
    agentId: string | null;
    model: string | null;
    reasoningEffort: string | null;
    turnIndex: number;
    startedAt: Date;
    endedAt: Date;
    durationMs: number;
    tokensInput: number;
    tokensOutput: number;
    tokensCacheRead: number;
    tokensCacheWrite: number;
    toolCalls: number;
    toolErrors: number;
    resultType: string | null;
    errorMessage: string | null;
    workerNodeId: string | null;
}

export interface CompleteTurnWritebackInput extends InsertTurnMetricInput {
    toolNames?: string[];
    state: string;
    lastActiveAt: Date;
    lastError: string | null;
    waitReason: string | null;
    currentIteration: number;
}

export interface TurnMetricRow {
    id: number;
    sessionId: string;
    agentId: string | null;
    model: string | null;
    reasoningEffort: string | null;
    turnIndex: number;
    startedAt: Date;
    endedAt: Date;
    durationMs: number;
    tokensInput: number;
    tokensOutput: number;
    tokensCacheRead: number;
    tokensCacheWrite: number;
    toolCalls: number;
    toolErrors: number;
    resultType: string | null;
    errorMessage: string | null;
    workerNodeId: string | null;
    createdAt: Date;
}

export interface TokensByModelRow {
    /** Combined model:effort label (or provider/model when no effort). */
    model: string;
    turnCount: number;
    totalTokensInput: number;
    totalTokensOutput: number;
    totalTokensCacheRead: number;
    totalTokensCacheWrite: number;
}

export interface HourlyTokenBucketRow {
    hourBucket: Date;
    turnCount: number;
    totalTokensInput: number;
    totalTokensOutput: number;
    totalTokensCacheRead: number;
    totalTokensCacheWrite: number;
}

/** A row in the sessions table. */
export interface SessionRow {
    sessionId: string;
    orchestrationId: string | null;
    title: string | null;
    titleLocked: boolean;
    state: string;
    model: string | null;
    reasoningEffort: string | null;
    createdAt: Date;
    updatedAt: Date;
    lastActiveAt: Date | null;
    deletedAt: Date | null;
    currentIteration: number;
    lastError: string | null;
    /** Live wait reason (e.g. "waiting for build"). Synced from runTurn activity. */
    waitReason: string | null;
    /**
     * In-flight turn index while a turn is running, else null. Written by the
     * runTurn activity's pre-turn writeback; cleared by the post-turn
     * writeback and by any state transition away from "running". Used by
     * stopSessionTurn() to address the turn-scoped stop queue.
     */
    activeTurnIndex: number | null;
    /** If this session is a sub-agent, the parent session's ID. */
    parentSessionId: string | null;
    /** Whether this is a system session (e.g. Sweeper Agent). */
    isSystem: boolean;
    /** Agent definition ID (e.g. "sweeper"). Links session to its agent config. */
    agentId: string | null;
    /** Splash banner (terminal markup) from the agent definition. */
    splash: string | null;
    /** Optional visual session group assignment. */
    groupId: string | null;
    /** Short live summary for discovery/session lists. */
    shortSummary: string | null;
    /** Structured live summary state, application domain payload included. */
    summaryState: SessionSummaryState | null;
    /** Last time summaryState/shortSummary was updated. */
    summaryUpdatedAt: Date | null;
    /** Authenticated user associated with this session, if any. */
    owner: SessionOwnerInfo | null;
}

/** Fields that can be updated on a session row. */
export interface SessionRowUpdates {
    orchestrationId?: string | null;
    title?: string | null;
    titleLocked?: boolean;
    state?: string;
    model?: string | null;
    reasoningEffort?: string | null;
    lastActiveAt?: Date;
    currentIteration?: number;
    lastError?: string | null;
    waitReason?: string | null;
    isSystem?: boolean;
    agentId?: string | null;
    splash?: string | null;
    groupId?: string | null;
}

export interface SessionGroupRow {
    groupId: string;
    title: string;
    description: string | null;
    owner: SessionOwnerInfo | null;
    metadata: Record<string, unknown>;
    memberCount: number;
    runningCount: number;
    waitingCount: number;
    completedCount: number;
    failedCount: number;
    cancelledCount: number;
    latestActivityAt: Date | null;
    latestSummaryUpdatedAt: Date | null;
    createdAt: Date;
    updatedAt: Date;
}

export interface ChildOutcomeRow {
    childSessionId: string;
    parentSessionId: string;
    contractJson: Record<string, unknown> | null;
    resultJson: Record<string, unknown> | null;
    verdict: string | null;
    summary: string | null;
    completedAt: Date | null;
    createdAt: Date;
    updatedAt: Date;
}

// ─── Session Metric Summary Types ────────────────────────────────

/** Per-session metric summary — one row per session, updated in place. */
export interface SessionMetricSummary {
    sessionId: string;
    agentId: string | null;
    model: string | null;
    reasoningEffort: string | null;
    parentSessionId: string | null;
    snapshotSizeBytes: number;
    dehydrationCount: number;
    hydrationCount: number;
    lossyHandoffCount: number;
    lastDehydratedAt: number | null;
    lastHydratedAt: number | null;
    lastCheckpointAt: number | null;
    tokensInput: number;
    tokensOutput: number;
    tokensCacheRead: number;
    tokensCacheWrite: number;
    /** Cached-prompt hit ratio (0..1), null when tokensInput is 0. Derived. */
    cacheHitRatio: number | null;
    deletedAt: number | null;
    createdAt: number;
    updatedAt: number;
}

/** Fields for atomic upsert — increments are additive, absolutes are set. */
export interface SessionMetricSummaryUpsert {
    snapshotSizeBytes?: number;
    dehydrationCountIncrement?: number;
    hydrationCountIncrement?: number;
    lossyHandoffCountIncrement?: number;
    lastDehydratedAt?: boolean;
    lastHydratedAt?: boolean;
    lastCheckpointAt?: boolean;
    tokensInputIncrement?: number;
    tokensOutputIncrement?: number;
    tokensCacheReadIncrement?: number;
    tokensCacheWriteIncrement?: number;
}

/** Fleet-wide aggregate stats. */
export interface FleetStats {
    windowStart: number | null;
    earliestSessionCreatedAt: number | null;
    byAgent: Array<{
        agentId: string | null;
        model: string | null;
        sessionCount: number;
        turnCount: number;
        totalSnapshotSizeBytes: number;
        totalDehydrationCount: number;
        totalHydrationCount: number;
        totalLossyHandoffCount: number;
        totalTokensInput: number;
        totalTokensOutput: number;
        totalTokensCacheRead: number;
        totalTokensCacheWrite: number;
        /** Derived: cache_read / input. Null when input is 0. */
        cacheHitRatio: number | null;
    }>;
    totals: {
        sessionCount: number;
        totalSnapshotSizeBytes: number;
        totalTokensInput: number;
        totalTokensOutput: number;
        totalTokensCacheRead: number;
        totalTokensCacheWrite: number;
        cacheHitRatio: number | null;
    };
}

export type UserStatsOwnerKind = "user" | "system" | "unowned";

export interface UserStatsModelBucket {
    model: string | null;
    sessionIds: string[];
    sessionCount: number;
    turnCount: number;
    totalSnapshotSizeBytes: number;
    totalOrchestrationHistorySizeBytes: number;
    totalDehydrationCount: number;
    totalHydrationCount: number;
    totalLossyHandoffCount: number;
    totalTokensInput: number;
    totalTokensOutput: number;
    totalTokensCacheRead: number;
    totalTokensCacheWrite: number;
    cacheHitRatio: number | null;
}

export interface UserStatsBucket {
    ownerKind: UserStatsOwnerKind;
    owner: SessionOwnerInfo | null;
    sessionIds: string[];
    sessionCount: number;
    totalSnapshotSizeBytes: number;
    totalOrchestrationHistorySizeBytes: number;
    totalTokensInput: number;
    totalTokensOutput: number;
    totalTokensCacheRead: number;
    totalTokensCacheWrite: number;
    cacheHitRatio: number | null;
    byModel: UserStatsModelBucket[];
}

export interface UserStats {
    windowStart: number | null;
    earliestSessionCreatedAt: number | null;
    users: UserStatsBucket[];
    totals: {
        sessionCount: number;
        totalSnapshotSizeBytes: number;
        totalOrchestrationHistorySizeBytes: number;
        totalTokensInput: number;
        totalTokensOutput: number;
        totalTokensCacheRead: number;
        totalTokensCacheWrite: number;
        cacheHitRatio: number | null;
    };
}

/**
 * Public user profile shape exposed through the management surface and
 * consumed by the Admin Console UI.
 *
 * `profileSettings` is an opaque application-owned JSON document (the
 * Admin Console + future client-state migrations decide its schema).
 *
 * `githubCopilotKeySet` is a presence flag; the raw key text is only
 * available through the worker-side resolver in `SessionCatalog`
 * to prevent accidental leakage through this management-facing type.
 */
export interface UserProfile {
    userId: number;
    provider: string;
    subject: string;
    email: string | null;
    displayName: string | null;
    profileSettings: Record<string, unknown>;
    githubCopilotKeySet: boolean;
    createdAt: Date | null;
    updatedAt: Date | null;
}

export interface UserPrincipal {
    provider: string;
    subject: string;
    email?: string | null;
    displayName?: string | null;
}

/** Aggregate of a session and all its descendants. */
export interface SessionTreeStats {
    rootSessionId: string;
    self: SessionMetricSummary;
    tree: {
        sessionCount: number;
        totalTokensInput: number;
        totalTokensOutput: number;
        totalTokensCacheRead: number;
        totalTokensCacheWrite: number;
        /** Derived: cache_read / input across the tree. Null when input is 0. */
        cacheHitRatio: number | null;
        totalDehydrationCount: number;
        totalHydrationCount: number;
        totalLossyHandoffCount: number;
        totalSnapshotSizeBytes: number;
    };
    /** Per-model breakdown across the tree, sorted by total input tokens. */
    byModel: Array<{
        model: string;
        sessionCount: number;
        turnCount: number;
        totalTokensInput: number;
        totalTokensOutput: number;
        totalTokensCacheRead: number;
        totalTokensCacheWrite: number;
        totalSnapshotSizeBytes: number;
        /** Derived per model. Null when input is 0. */
        cacheHitRatio: number | null;
    }>;
}

/**
 * Compute prompt-cache hit ratio with the inclusive token convention.
 * Returns a value in [0, 1] or null when tokensInput is 0 / negative / missing.
 * Defined once so per-session, tree, and fleet surfaces report identical values.
 */
export function computeCacheHitRatio(
    tokensInput: number | null | undefined,
    tokensCacheRead: number | null | undefined,
): number | null {
    const input = Number(tokensInput);
    const read = Number(tokensCacheRead);
    if (!Number.isFinite(input) || input <= 0) return null;
    if (!Number.isFinite(read) || read <= 0) return 0;
    const ratio = read / input;
    return Math.max(0, Math.min(1, ratio));
}

/** Discriminator: 'static' = SDK skill.invoked, 'learned' = read_facts on skills/. */
export type SkillKind = "static" | "learned";

/** One row of skill-usage aggregation for a single session. */
export interface SkillUsageRow {
    kind: SkillKind;
    /** Static: skill name. Learned: requested key or keyPattern (e.g. "skills/foo/%"). */
    name: string;
    pluginName: string | null;     // static skills only
    pluginVersion: string | null;  // static skills only
    invocations: number;
    firstUsedAt: Date;
    lastUsedAt: Date;
}

/** Skill usage rolled up across the spawn tree rooted at a session. */
export interface SessionTreeSkillUsage {
    rootSessionId: string;
    perSession: Array<{
        sessionId: string;
        agentId: string | null;
        skills: SkillUsageRow[];
    }>;
    rolledUp: SkillUsageRow[];
    totalInvocations: number;
}

/** One row of skill-usage aggregation across the fleet, by agent. */
export interface FleetSkillUsageRow extends SkillUsageRow {
    agentId: string | null;
    sessionCount: number;
}

/** Fleet-wide skill usage. */
export interface FleetSkillUsage {
    windowStart: number | null;
    rows: FleetSkillUsageRow[];
}

export type RetrievalSurface = "facts" | "skills" | "graph";
export type RetrievalOperation =
    | "facts_search"
    | "facts_similar"
    | "search_skills"
    | "graph_search_nodes"
    | "graph_search_edges"
    | "graph_neighbourhood";

export interface RetrievalUsageRow {
    surface: RetrievalSurface;
    operation: RetrievalOperation;
    namespace: string | null;
    calls: number;
    totalResults: number;
    avgResults: number;
    totalDurationMs: number | null;
    avgDurationMs: number | null;
    firstUsedAt: Date;
    lastUsedAt: Date;
}

export interface SessionTreeRetrievalUsage {
    rootSessionId: string;
    perSession: Array<{
        sessionId: string;
        agentId: string | null;
        rows: RetrievalUsageRow[];
    }>;
    rolledUp: RetrievalUsageRow[];
    totalCalls: number;
}

export interface FleetRetrievalUsageRow extends RetrievalUsageRow {
    agentId: string | null;
    sessionCount: number;
}

export interface FleetRetrievalUsage {
    windowStart: number | null;
    rows: FleetRetrievalUsageRow[];
}

export type GraphNodeUsageKind = "searched" | "loaded";

export interface GraphNodeUsageRow {
    nodeKey: string;
    namespace: string | null;
    operation: RetrievalOperation;
    kind: GraphNodeUsageKind;
    count: number;
    firstSeenAt: Date;
    lastSeenAt: Date;
}

export interface FleetGraphNodeUsageRow extends GraphNodeUsageRow {
    agentId: string | null;
    sessionCount: number;
}

export interface FleetGraphNodeUsage {
    windowStart: number | null;
    rows: FleetGraphNodeUsageRow[];
}

export interface GraphEdgeSearchUsageRow {
    predicateKey: string | null;
    fromKey: string | null;
    toKey: string | null;
    namespace: string | null;
    calls: number;
    totalResults: number;
    firstSearchedAt: Date;
    lastSearchedAt: Date;
}

// ─── Provider Interface ──────────────────────────────────────────

/**
 * SessionCatalog — abstraction over the CMS backing store.
 *
 * Initial implementation: PostgreSQL.
 * Future: CosmosDB, etc.
 */
export interface SessionCatalog {
    /** Create schema and tables if they don't exist. */
    initialize(): Promise<void>;

    // ── Writes (called from client, before duroxide calls) ───

    /** Insert a new session. No-op if session already exists. */
    createSession(sessionId: string, opts?: {
        model?: string;
        reasoningEffort?: string;
        parentSessionId?: string;
        isSystem?: boolean;
        agentId?: string;
        splash?: string;
        groupId?: string | null;
        owner?: SessionOwnerInfo | null;
    }): Promise<void>;

    /** Update one or more fields on an existing session. */
    updateSession(sessionId: string, updates: SessionRowUpdates): Promise<void>;
    /** Publish the in-flight turn index (stop-turn targeting). */
    setActiveTurnIndex(sessionId: string, turnIndex: number): Promise<void>;

    /** Soft-delete a session (set deleted_at). */
    softDeleteSession(sessionId: string): Promise<void>;

    /** Privileged archive/reset for deterministic system-session restart. */
    archiveSystemSessionForRestart(sessionId: string, state: "completed" | "cancelled" | "failed", lastError?: string | null): Promise<void>;

    // ── Reads (called from client) ───────────────────────────

    /** List all non-deleted sessions, newest first. */
    listSessions(): Promise<SessionRow[]>;

    /** List one bounded page of sessions, newest first. */
    listSessionsPage(opts?: {
        limit?: number;
        cursorUpdatedAt?: Date | null;
        cursorSessionId?: string | null;
        includeDeleted?: boolean;
    }): Promise<SessionRow[]>;

    /** Get a single session by ID (null if not found or deleted). */
    getSession(sessionId: string): Promise<SessionRow | null>;

    /** Get all descendant session IDs (children, grandchildren, etc.) of a given session. */
    getDescendantSessionIds(sessionId: string): Promise<string[]>;

    /** Get the most recently active session ID. */
    getLastSessionId(): Promise<string | null>;

    /** Persist a structured live session summary. */
    updateSessionSummary(sessionId: string, summaryState: SessionSummaryState, shortSummary?: string | null): Promise<void>;

    /** Create a visual session group. */
    createSessionGroup(input: { groupId: string; title: string; description?: string | null; owner?: SessionOwnerInfo | null; metadata?: Record<string, unknown> }): Promise<void>;

    /** Update title/description/owner/metadata for a session group. */
    updateSessionGroup(groupId: string, patch: { title?: string; description?: string | null; owner?: SessionOwnerInfo | null; metadataPatch?: Record<string, unknown> }): Promise<void>;

    /** List session groups with aggregate member status. */
    listSessionGroups(): Promise<SessionGroupRow[]>;

    /** List non-deleted sessions assigned to a group. */
    listGroupSessions(groupId: string): Promise<SessionRow[]>;

    /** Delete an empty session group. Returns false while non-deleted members remain. */
    deleteSessionGroup(groupId: string): Promise<boolean>;

    /** Upsert current child contract/result outcome state. */
    upsertChildOutcome(input: {
        childSessionId: string;
        parentSessionId: string;
        contractJson?: Record<string, unknown> | null;
        resultJson?: Record<string, unknown> | null;
        verdict?: string | null;
        summary?: string | null;
        completedAt?: Date | null;
    }): Promise<void>;

    /** Get a child outcome record by child session id. */
    getChildOutcome(childSessionId: string): Promise<ChildOutcomeRow | null>;

    /** List child outcome records for a parent session. */
    listChildOutcomes(parentSessionId: string): Promise<ChildOutcomeRow[]>;

    // ── Events (written from worker, read from client) ───────

    /** Record a batch of events for a session. */
    recordEvents(sessionId: string, events: { eventType: string; data: unknown }[], workerNodeId?: string): Promise<void>;

    /**
     * Get a provider-capped page of events for a session, ordered ascending by seq.
     * Without afterSeq this returns the latest page; with afterSeq it returns the next forward page.
     * Use getSessionEventsBefore() paging to drain complete history.
     */
    getSessionEvents(sessionId: string, afterSeq?: number, limit?: number): Promise<SessionEvent[]>;

    /**
     * Get a provider-capped older page before a sequence number, ordered ascending by seq.
     * Call repeatedly with the oldest returned seq to drain complete history.
     */
    getSessionEventsBefore(sessionId: string, beforeSeq: number, limit?: number): Promise<SessionEvent[]>;

    /** Get the highest-volume event emitters since a point in time. */
    getTopEventEmitters(since: Date, limit?: number): Promise<TopEventEmitterRow[]>;

    /** Insert one per-turn metrics row. */
    insertTurnMetric(input: InsertTurnMetricInput): Promise<void>;

    /** Complete one turn's CMS writeback atomically. */
    completeTurnWriteback(input: CompleteTurnWritebackInput): Promise<void>;

    /** Get bounded per-session turn metrics, newest-first. */
    getSessionTurnMetrics(sessionId: string, opts?: { since?: Date; limit?: number }): Promise<TurnMetricRow[]>;

    /** Get per-session token totals grouped by model:effort, with per-bucket turn count. */
    getSessionTokensByModel(sessionId: string): Promise<TokensByModelRow[]>;

    /** Aggregate hourly token buckets from session turn metrics. */
    getHourlyTokenBuckets(since: Date, opts?: { agentId?: string; model?: string }): Promise<HourlyTokenBucketRow[]>;

    /** Delete turn metrics older than a cutoff and return deleted row count. */
    pruneTurnMetrics(olderThan: Date): Promise<number>;

    // ── Session Metric Summaries ──────────────────────────────

    /** Get the metric summary for a single session. */
    getSessionMetricSummary(sessionId: string): Promise<SessionMetricSummary | null>;

    /** Get a session's own stats plus rolled-up totals of all descendants. */
    getSessionTreeStats(sessionId: string): Promise<SessionTreeStats | null>;

    /** Get fleet-wide aggregate stats, optionally filtered. */
    getFleetStats(opts?: { includeDeleted?: boolean; since?: Date }): Promise<FleetStats>;

    /** Get user/session-owner aggregate stats, optionally filtered. */
    getUserStats(opts?: { includeDeleted?: boolean; since?: Date }): Promise<UserStats>;

    // ── User Profiles (settings + per-user GitHub Copilot key) ──

    /**
     * Read the public user profile (settings + key-set flag). Returns
     * `null` when the principal has not been registered yet.
     *
     * Never returns the raw key text; callers wanting the key must use
     * `getUserGitHubCopilotKey` so leakage stays auditable.
     */
    getUserProfile(principal: UserPrincipal): Promise<UserProfile | null>;

    /**
     * Internal: fetch the raw GitHub Copilot key for a user. Used by the
     * worker's per-user token resolver. Returns `null` when no override
     * is set or the user is unknown.
     */
    getUserGitHubCopilotKey(principal: UserPrincipal): Promise<string | null>;

    /**
     * Replace the user's `profile_settings` JSON document. Creates the
     * user row lazily if needed so settings can be saved before the
     * principal owns any sessions.
     */
    setUserProfileSettings(principal: UserPrincipal, settings: Record<string, unknown>): Promise<UserProfile>;

    /**
     * Set or clear the per-user GitHub Copilot key. Pass `null` to
     * remove the override (which reverts the user to the worker's
     * env-supplied default).
     */
    setUserGitHubCopilotKey(principal: UserPrincipal, key: string | null): Promise<UserProfile>;

    /** Get skill usage (skill.invoked event aggregation) for a single session. */
    getSessionSkillUsage(sessionId: string, opts?: { since?: Date }): Promise<SkillUsageRow[]>;

    /** Get skill usage rolled across the spawn tree rooted at the given session. */
    getSessionTreeSkillUsage(sessionId: string, opts?: { since?: Date }): Promise<SessionTreeSkillUsage>;

    /** Get fleet-wide skill usage broken down by agent. Tuner / management surface. */
    getFleetSkillUsage(opts?: { since?: Date; includeDeleted?: boolean }): Promise<FleetSkillUsage>;

    /** Get per-session retrieval usage counts from durable retrieval events. */
    getSessionRetrievalUsage(sessionId: string, opts?: { since?: Date }): Promise<RetrievalUsageRow[]>;

    /** Get retrieval usage rolled up across the spawn tree rooted at the given session. */
    getSessionTreeRetrievalUsage(sessionId: string, opts?: { since?: Date }): Promise<SessionTreeRetrievalUsage>;

    /** Get fleet-wide retrieval usage broken down by agent. */
    getFleetRetrievalUsage(opts?: { since?: Date; includeDeleted?: boolean }): Promise<FleetRetrievalUsage>;

    /** Get exact graph node-key search/load usage for one session. */
    getSessionGraphNodeUsage(sessionId: string, opts?: { since?: Date; limit?: number; nodeKeyLike?: string; kind?: GraphNodeUsageKind }): Promise<GraphNodeUsageRow[]>;

    /** Get exact graph node-key search/load usage across the fleet. */
    getFleetGraphNodeUsage(opts?: { since?: Date; includeDeleted?: boolean; limit?: number; nodeKeyLike?: string; kind?: GraphNodeUsageKind }): Promise<FleetGraphNodeUsage>;

    /** Get requested graph edge-search shapes for one session. */
    getSessionGraphEdgeSearchUsage(sessionId: string, opts?: { since?: Date; limit?: number }): Promise<GraphEdgeSearchUsageRow[]>;

    /** Upsert a session metric summary with atomic increments. */
    upsertSessionMetricSummary(sessionId: string, updates: SessionMetricSummaryUpsert): Promise<void>;

    /** Hard-delete summary rows for sessions deleted before the cutoff. Returns count removed. */
    pruneDeletedSummaries(olderThan: Date): Promise<number>;

    /** Cleanup / close connections. */
    close(): Promise<void>;
}

// ─── PostgreSQL Implementation ───────────────────────────────────

const DEFAULT_SCHEMA = "copilot_sessions";

/**
 * Build qualified function/table names for a given schema.
 * Allows multiple deployments to coexist on the same database.
 */
function sqlForSchema(schema: string) {
    const s = `"${schema}"`;
    return {
        schema,
        fn: {
            createSession:              `${s}.cms_create_session`,
            setSessionOwner:            `${s}.cms_set_session_owner`,
            inheritSessionOwner:        `${s}.cms_inherit_session_owner`,
            updateSession:              `${s}.cms_update_session`,
            softDeleteSession:          `${s}.cms_soft_delete_session`,
            archiveSystemSessionForRestart: `${s}.cms_archive_system_session_for_restart`,
            listSessions:               `${s}.cms_list_sessions`,
            listSessionsPage:           `${s}.cms_list_sessions_page`,
            getSession:                 `${s}.cms_get_session`,
            getDescendantSessionIds:    `${s}.cms_get_descendant_session_ids`,
            getLastSessionId:           `${s}.cms_get_last_session_id`,
            updateSessionSummary:       `${s}.cms_update_session_summary`,
            assignSessionGroup:         `${s}.cms_assign_session_group`,
            createSessionGroup:         `${s}.cms_create_session_group`,
            updateSessionGroup:         `${s}.cms_update_session_group`,
            listSessionGroups:          `${s}.cms_list_session_groups`,
            listGroupSessions:          `${s}.cms_list_group_sessions`,
            deleteSessionGroup:         `${s}.cms_delete_session_group`,
            upsertChildOutcome:         `${s}.cms_upsert_child_outcome`,
            getChildOutcome:            `${s}.cms_get_child_outcome`,
            listChildOutcomes:          `${s}.cms_list_child_outcomes`,
            recordEvents:               `${s}.cms_record_events`,
            getSessionEvents:           `${s}.cms_get_session_events`,
            getSessionEventsBefore:     `${s}.cms_get_session_events_before`,
            getTopEventEmitters:        `${s}.cms_get_top_event_emitters`,
            insertTurnMetric:           `${s}.cms_insert_turn_metric`,
            completeTurnWriteback:      `${s}.cms_complete_turn_writeback`,
            setActiveTurnIndex:         `${s}.cms_set_active_turn_index`,
            getSessionTurnMetrics:      `${s}.cms_get_session_turn_metrics`,
            getSessionTokensByModel:    `${s}.cms_get_session_tokens_by_model`,
            getHourlyTokenBuckets:      `${s}.cms_get_hourly_token_buckets`,
            pruneTurnMetrics:           `${s}.cms_prune_turn_metrics`,
            getSessionMetricSummary:    `${s}.cms_get_session_metric_summary`,
            getSessionTreeStats:        `${s}.cms_get_session_tree_stats`,
            getSessionTreeStatsByModel: `${s}.cms_get_session_tree_stats_by_model`,
            getFleetStatsByAgent:       `${s}.cms_get_fleet_stats_by_agent`,
            getFleetStatsTotals:        `${s}.cms_get_fleet_stats_totals`,
            getUserStatsByModel:        `${s}.cms_get_user_stats_by_model`,
            getUserProfile:             `${s}.cms_get_user_profile`,
            getUserGitHubCopilotKey:    `${s}.cms_get_user_github_copilot_key`,
            setUserProfileSettings:     `${s}.cms_set_user_profile_settings`,
            setUserGitHubCopilotKey:    `${s}.cms_set_user_github_copilot_key`,
            upsertSessionMetricSummary: `${s}.cms_upsert_session_metric_summary`,
            pruneDeletedSummaries:      `${s}.cms_prune_deleted_summaries`,
            getSessionSkillUsage:       `${s}.cms_get_session_skill_usage`,
            getSessionTreeSkillUsage:   `${s}.cms_get_session_tree_skill_usage`,
            getFleetSkillUsage:         `${s}.cms_get_fleet_skill_usage`,
            getSessionRetrievalUsage:   `${s}.cms_get_session_retrieval_usage`,
            getSessionTreeRetrievalUsage: `${s}.cms_get_session_tree_retrieval_usage`,
            getFleetRetrievalUsage:     `${s}.cms_get_fleet_retrieval_usage`,
            getSessionGraphNodeUsage:   `${s}.cms_get_session_graph_node_usage`,
            getFleetGraphNodeUsage:     `${s}.cms_get_fleet_graph_node_usage`,
            getSessionGraphEdgeSearchUsage: `${s}.cms_get_session_graph_edge_search_usage`,
        },
    };
}

/**
 * PgSessionCatalog — PostgreSQL implementation of SessionCatalog.
 *
 * Uses the `pg` package (node-postgres) directly.
 * Must be created via the async `PgSessionCatalog.create()` factory.
 */
export class PgSessionCatalog implements SessionCatalog {
    private pool: any;
    private initialized = false;
    private sql: ReturnType<typeof sqlForSchema>;

    private constructor(pool: any, schema: string) {
        this.pool = pool;
        this.sql = sqlForSchema(schema);
    }

    static readonly DEFAULT_POOL_MAX = 3;

    /** Factory: create and connect a PgSessionCatalog. */
    static async create(
        connectionString: string,
        schema?: string,
        opts: { useManagedIdentity?: boolean; aadUser?: string } = {},
    ): Promise<PgSessionCatalog> {
        const { default: pg } = await import("pg");
        const { buildPgPoolConfig } = await import("./pg-pool-factory.js");

        const configuredPoolMax = Number.parseInt(process.env.PILOTSWARM_CMS_PG_POOL_MAX ?? "", 10);
        const poolMax = Number.isFinite(configuredPoolMax) && configuredPoolMax > 0
            ? configuredPoolMax
            : PgSessionCatalog.DEFAULT_POOL_MAX;

        const poolConfig = buildPgPoolConfig({
            connectionString,
            useManagedIdentity: opts.useManagedIdentity,
            aadUser: opts.aadUser,
            max: poolMax,
        });

        const pool = new pg.Pool(poolConfig);

        // Handle idle client errors (e.g. EADDRNOTAVAIL when the network
        // drops). Without this, pg Pool emits an unhandled 'error' event
        // which crashes the Node.js process.
        pool.on('error', (err: Error) => {
            console.error('[cms] pool idle client error (non-fatal):', err.message);
        });

        return new PgSessionCatalog(pool, schema ?? DEFAULT_SCHEMA);
    }


    async initialize(): Promise<void> {
        if (this.initialized) return;
        await runCmsMigrations(this.pool, this.sql.schema);
        this.initialized = true;
    }

    // ── Writes ───────────────────────────────────────────────

    async createSession(sessionId: string, opts?: {
        model?: string;
        reasoningEffort?: string;
        parentSessionId?: string;
        isSystem?: boolean;
        agentId?: string;
        splash?: string;
        groupId?: string | null;
        owner?: SessionOwnerInfo | null;
    }): Promise<void> {
        const explicitGroupId = typeof opts?.groupId === "string" && opts.groupId.trim()
            ? opts.groupId.trim()
            : null;
        const createGroupId = explicitGroupId ? null : opts?.groupId ?? null;
        const client = await this.pool.connect();
        try {
            await client.query("BEGIN");
            await client.query(
                `SELECT ${this.sql.fn.createSession}($1, $2, $3, $4, $5, $6, $7, $8)`,
                [sessionId, opts?.model ?? null, opts?.reasoningEffort ?? null, opts?.parentSessionId ?? null, opts?.isSystem ?? false, opts?.agentId ?? null, opts?.splash ?? null, createGroupId],
            );

            if (!opts?.isSystem) {
                if (opts?.owner?.provider && opts?.owner?.subject) {
                    await client.query(
                        `SELECT ${this.sql.fn.setSessionOwner}($1, $2, $3, $4, $5)`,
                        [
                            sessionId,
                            opts.owner.provider,
                            opts.owner.subject,
                            opts.owner.email ?? null,
                            opts.owner.displayName ?? null,
                        ],
                    );
                } else if (opts?.parentSessionId) {
                    await client.query(
                        `SELECT ${this.sql.fn.inheritSessionOwner}($1, $2)`,
                        [sessionId, opts.parentSessionId],
                    );
                }

                if (explicitGroupId) {
                    await client.query(
                        `SELECT ${this.sql.fn.assignSessionGroup}($1, $2)`,
                        [sessionId, explicitGroupId],
                    );
                }
            }

            await client.query("COMMIT");
        } catch (err) {
            await client.query("ROLLBACK").catch(() => {});
            throw err;
        } finally {
            client.release();
        }
    }

    async updateSession(sessionId: string, updates: SessionRowUpdates): Promise<void> {
        const jsonUpdates: Record<string, unknown> = {};
        if (updates.orchestrationId !== undefined) jsonUpdates.orchestrationId = updates.orchestrationId;
        if (updates.title !== undefined) jsonUpdates.title = updates.title;
        if (updates.titleLocked !== undefined) jsonUpdates.titleLocked = updates.titleLocked;
        if (updates.state !== undefined) jsonUpdates.state = updates.state;
        if (updates.model !== undefined) jsonUpdates.model = updates.model;
        if (updates.reasoningEffort !== undefined) jsonUpdates.reasoningEffort = updates.reasoningEffort;
        if (updates.lastActiveAt !== undefined) jsonUpdates.lastActiveAt = updates.lastActiveAt ? updates.lastActiveAt.toISOString() : null;
        if (updates.currentIteration !== undefined) jsonUpdates.currentIteration = updates.currentIteration;
        if (updates.lastError !== undefined) jsonUpdates.lastError = updates.lastError;
        if (updates.waitReason !== undefined) jsonUpdates.waitReason = updates.waitReason;
        if (updates.isSystem !== undefined) jsonUpdates.isSystem = updates.isSystem;
        if (updates.agentId !== undefined) jsonUpdates.agentId = updates.agentId;
        if (updates.splash !== undefined) jsonUpdates.splash = updates.splash;
        if (updates.groupId !== undefined) jsonUpdates.groupId = updates.groupId;

        if (Object.keys(jsonUpdates).length === 0) return;

        await this.pool.query(
            `SELECT ${this.sql.fn.updateSession}($1, $2)`,
            [sessionId, JSON.stringify(jsonUpdates)],
        );
    }

    async setActiveTurnIndex(sessionId: string, turnIndex: number): Promise<void> {
        await this.pool.query(
            `SELECT ${this.sql.fn.setActiveTurnIndex}($1, $2)`,
            [sessionId, turnIndex],
        );
    }

    async softDeleteSession(sessionId: string): Promise<void> {
        try {
            await this.pool.query(
                `SELECT ${this.sql.fn.softDeleteSession}($1)`,
                [sessionId],
            );
        } catch (err: any) {
            if (err?.message?.includes("Cannot delete system session")) {
                throw new Error("Cannot delete system session");
            }
            throw err;
        }
    }

    async archiveSystemSessionForRestart(
        sessionId: string,
        state: "completed" | "cancelled" | "failed",
        lastError?: string | null,
    ): Promise<void> {
        await this.pool.query(
            `SELECT ${this.sql.fn.archiveSystemSessionForRestart}($1, $2, $3)`,
            [sessionId, state, lastError ?? null],
        );
    }

    // ── Reads ────────────────────────────────────────────────

    async listSessions(): Promise<SessionRow[]> {
        const { rows } = await this.pool.query(
            `SELECT * FROM ${this.sql.fn.listSessions}()`,
        );
        return rows.map(rowToSessionRow);
    }

    async listSessionsPage(opts?: {
        limit?: number;
        cursorUpdatedAt?: Date | null;
        cursorSessionId?: string | null;
        includeDeleted?: boolean;
    }): Promise<SessionRow[]> {
        const { rows } = await this.pool.query(
            `SELECT * FROM ${this.sql.fn.listSessionsPage}($1, $2, $3, $4)`,
            [
                opts?.limit ?? null,
                opts?.cursorUpdatedAt ?? null,
                opts?.cursorSessionId ?? null,
                opts?.includeDeleted ?? false,
            ],
        );
        return rows.map(rowToSessionRow);
    }

    async getSession(sessionId: string): Promise<SessionRow | null> {
        const { rows } = await this.pool.query(
            `SELECT * FROM ${this.sql.fn.getSession}($1)`,
            [sessionId],
        );
        return rows.length > 0 ? rowToSessionRow(rows[0]) : null;
    }

    async getDescendantSessionIds(sessionId: string): Promise<string[]> {
        const { rows } = await this.pool.query(
            `SELECT * FROM ${this.sql.fn.getDescendantSessionIds}($1)`,
            [sessionId],
        );
        return rows.map((r: any) => r.session_id);
    }

    async getLastSessionId(): Promise<string | null> {
        const { rows } = await this.pool.query(
            `SELECT ${this.sql.fn.getLastSessionId}() AS session_id`,
        );
        return rows.length > 0 ? rows[0].session_id : null;
    }

    async updateSessionSummary(sessionId: string, summaryState: SessionSummaryState, shortSummary?: string | null): Promise<void> {
        await this.pool.query(
            `SELECT ${this.sql.fn.updateSessionSummary}($1, $2, $3)`,
            [sessionId, JSON.stringify(summaryState), shortSummary ?? null],
        );
    }

    async createSessionGroup(input: { groupId: string; title: string; description?: string | null; owner?: SessionOwnerInfo | null; metadata?: Record<string, unknown> }): Promise<void> {
        await this.pool.query(
            `SELECT ${this.sql.fn.createSessionGroup}($1, $2, $3, $4, $5)`,
            [
                input.groupId,
                input.title,
                input.description ?? null,
                input.owner ? JSON.stringify(input.owner) : null,
                JSON.stringify(input.metadata ?? {}),
            ],
        );
    }

    async updateSessionGroup(groupId: string, patch: { title?: string; description?: string | null; owner?: SessionOwnerInfo | null; metadataPatch?: Record<string, unknown> }): Promise<void> {
        await this.pool.query(
            `SELECT ${this.sql.fn.updateSessionGroup}($1, $2)`,
            [groupId, JSON.stringify(patch)],
        );
    }

    async listSessionGroups(): Promise<SessionGroupRow[]> {
        const { rows } = await this.pool.query(
            `SELECT * FROM ${this.sql.fn.listSessionGroups}()`,
        );
        return rows.map(rowToSessionGroupRow);
    }

    async listGroupSessions(groupId: string): Promise<SessionRow[]> {
        const { rows } = await this.pool.query(
            `SELECT * FROM ${this.sql.fn.listGroupSessions}($1)`,
            [groupId],
        );
        return rows.map(rowToSessionRow);
    }

    async deleteSessionGroup(groupId: string): Promise<boolean> {
        const { rows } = await this.pool.query(
            `SELECT ${this.sql.fn.deleteSessionGroup}($1) AS deleted`,
            [groupId],
        );
        return rows[0]?.deleted === true;
    }

    async upsertChildOutcome(input: {
        childSessionId: string;
        parentSessionId: string;
        contractJson?: Record<string, unknown> | null;
        resultJson?: Record<string, unknown> | null;
        verdict?: string | null;
        summary?: string | null;
        completedAt?: Date | null;
    }): Promise<void> {
        await this.pool.query(
            `SELECT ${this.sql.fn.upsertChildOutcome}($1, $2, $3, $4, $5, $6, $7)`,
            [
                input.childSessionId,
                input.parentSessionId,
                input.contractJson ? JSON.stringify(input.contractJson) : null,
                input.resultJson ? JSON.stringify(input.resultJson) : null,
                input.verdict ?? null,
                input.summary ?? null,
                input.completedAt ?? null,
            ],
        );
    }

    async getChildOutcome(childSessionId: string): Promise<ChildOutcomeRow | null> {
        const { rows } = await this.pool.query(
            `SELECT * FROM ${this.sql.fn.getChildOutcome}($1)`,
            [childSessionId],
        );
        return rows.length > 0 ? rowToChildOutcomeRow(rows[0]) : null;
    }

    async listChildOutcomes(parentSessionId: string): Promise<ChildOutcomeRow[]> {
        const { rows } = await this.pool.query(
            `SELECT * FROM ${this.sql.fn.listChildOutcomes}($1)`,
            [parentSessionId],
        );
        return rows.map(rowToChildOutcomeRow);
    }

    // ── Events ───────────────────────────────────────────────

    async recordEvents(sessionId: string, events: { eventType: string; data: unknown }[], workerNodeId?: string): Promise<void> {
        if (events.length === 0) return;

        await this.pool.query(
            `SELECT ${this.sql.fn.recordEvents}($1, $2, $3)`,
            [sessionId, JSON.stringify(events), workerNodeId ?? null],
        );
    }

    async getSessionEvents(sessionId: string, afterSeq?: number, limit?: number): Promise<SessionEvent[]> {
        const effectiveLimit = limit ?? 1000;
        const { rows } = await this.pool.query(
            `SELECT * FROM ${this.sql.fn.getSessionEvents}($1, $2, $3)`,
            [sessionId, afterSeq ?? null, effectiveLimit],
        );
        return rows.map(rowToSessionEvent);
    }

    async getSessionEventsBefore(sessionId: string, beforeSeq: number, limit?: number): Promise<SessionEvent[]> {
        const effectiveLimit = limit ?? 1000;
        const { rows } = await this.pool.query(
            `SELECT * FROM ${this.sql.fn.getSessionEventsBefore}($1, $2, $3)`,
            [sessionId, beforeSeq, effectiveLimit],
        );
        return rows.map(rowToSessionEvent);
    }

    async getTopEventEmitters(since: Date, limit?: number): Promise<TopEventEmitterRow[]> {
        const { rows } = await this.pool.query(
            `SELECT * FROM ${this.sql.fn.getTopEventEmitters}($1, $2)`,
            [since, limit ?? null],
        );
        return rows.map(rowToTopEventEmitterRow);
    }

    async insertTurnMetric(input: InsertTurnMetricInput): Promise<void> {
        await this.pool.query(
            `SELECT ${this.sql.fn.insertTurnMetric}($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)`,
            [
                input.sessionId,
                input.agentId,
                input.model,
                input.reasoningEffort,
                input.turnIndex,
                input.startedAt,
                input.endedAt,
                input.durationMs,
                input.tokensInput,
                input.tokensOutput,
                input.tokensCacheRead,
                input.tokensCacheWrite,
                input.toolCalls,
                input.toolErrors,
                input.resultType,
                input.errorMessage,
                input.workerNodeId,
            ],
        );
    }

    async completeTurnWriteback(input: CompleteTurnWritebackInput): Promise<void> {
        await this.pool.query(
            `SELECT ${this.sql.fn.completeTurnWriteback}($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23)`,
            [
                input.sessionId,
                input.agentId,
                input.model,
                input.reasoningEffort,
                input.turnIndex,
                input.startedAt,
                input.endedAt,
                input.durationMs,
                input.tokensInput,
                input.tokensOutput,
                input.tokensCacheRead,
                input.tokensCacheWrite,
                input.toolCalls,
                input.toolErrors,
                input.toolNames ?? [],
                input.resultType,
                input.errorMessage,
                input.workerNodeId,
                input.state,
                input.lastActiveAt,
                input.lastError,
                input.waitReason,
                input.currentIteration,
            ],
        );
    }

    async getSessionTurnMetrics(sessionId: string, opts?: { since?: Date; limit?: number }): Promise<TurnMetricRow[]> {
        const { rows } = await this.pool.query(
            `SELECT * FROM ${this.sql.fn.getSessionTurnMetrics}($1, $2, $3)`,
            [sessionId, opts?.since ?? null, opts?.limit ?? null],
        );
        return rows.map(rowToTurnMetricRow);
    }

    async getSessionTokensByModel(sessionId: string): Promise<TokensByModelRow[]> {
        const { rows } = await this.pool.query(
            `SELECT * FROM ${this.sql.fn.getSessionTokensByModel}($1)`,
            [sessionId],
        );
        return rows.map((r: any): TokensByModelRow => ({
            model: r.model ?? "(unknown)",
            turnCount: Number(r.turn_count) || 0,
            totalTokensInput: Number(r.total_tokens_input) || 0,
            totalTokensOutput: Number(r.total_tokens_output) || 0,
            totalTokensCacheRead: Number(r.total_tokens_cache_read) || 0,
            totalTokensCacheWrite: Number(r.total_tokens_cache_write) || 0,
        }));
    }

    async getHourlyTokenBuckets(since: Date, opts?: { agentId?: string; model?: string }): Promise<HourlyTokenBucketRow[]> {
        const { rows } = await this.pool.query(
            `SELECT * FROM ${this.sql.fn.getHourlyTokenBuckets}($1, $2, $3)`,
            [since, opts?.agentId ?? null, opts?.model ?? null],
        );
        return rows.map(rowToHourlyTokenBucketRow);
    }

    async pruneTurnMetrics(olderThan: Date): Promise<number> {
        const { rows } = await this.pool.query(
            `SELECT ${this.sql.fn.pruneTurnMetrics}($1) AS deleted_count`,
            [olderThan],
        );
        return Number(rows[0]?.deleted_count) || 0;
    }

    // ── Session Metric Summaries ─────────────────────────────

    async getSessionMetricSummary(sessionId: string): Promise<SessionMetricSummary | null> {
        const { rows } = await this.pool.query(
            `SELECT * FROM ${this.sql.fn.getSessionMetricSummary}($1)`,
            [sessionId],
        );
        return rows.length > 0 ? rowToSessionMetricSummary(rows[0]) : null;
    }

    async getSessionTreeStats(sessionId: string): Promise<SessionTreeStats | null> {
        const self = await this.getSessionMetricSummary(sessionId);
        if (!self) return null;

        const [{ rows }, { rows: modelRows }] = await Promise.all([
            this.pool.query(
                `SELECT * FROM ${this.sql.fn.getSessionTreeStats}($1)`,
                [sessionId],
            ),
            this.pool.query(
                `SELECT * FROM ${this.sql.fn.getSessionTreeStatsByModel}($1)`,
                [sessionId],
            ),
        ]);

        const r = rows[0];
        const treeTokensInput = Number(r.total_tokens_input) || 0;
        const treeTokensCacheRead = Number(r.total_tokens_cache_read) || 0;
        const byModel = modelRows.map((mr: any) => {
            const input = Number(mr.total_tokens_input) || 0;
            const cacheRead = Number(mr.total_tokens_cache_read) || 0;
            return {
                model: String(mr.model || "(unknown)"),
                sessionCount: Number(mr.session_count) || 0,
                turnCount: Number(mr.turn_count) || 0,
                totalTokensInput: input,
                totalTokensOutput: Number(mr.total_tokens_output) || 0,
                totalTokensCacheRead: cacheRead,
                totalTokensCacheWrite: Number(mr.total_tokens_cache_write) || 0,
                totalSnapshotSizeBytes: Number(mr.total_snapshot_size_bytes) || 0,
                cacheHitRatio: computeCacheHitRatio(input, cacheRead),
            };
        });
        return {
            rootSessionId: sessionId,
            self,
            tree: {
                sessionCount: Number(r.session_count) || 0,
                totalTokensInput: treeTokensInput,
                totalTokensOutput: Number(r.total_tokens_output) || 0,
                totalTokensCacheRead: treeTokensCacheRead,
                totalTokensCacheWrite: Number(r.total_tokens_cache_write) || 0,
                cacheHitRatio: computeCacheHitRatio(treeTokensInput, treeTokensCacheRead),
                totalDehydrationCount: Number(r.total_dehydration_count) || 0,
                totalHydrationCount: Number(r.total_hydration_count) || 0,
                totalLossyHandoffCount: Number(r.total_lossy_handoff_count) || 0,
                totalSnapshotSizeBytes: Number(r.total_snapshot_size_bytes) || 0,
            },
            byModel,
        };
    }

    async getFleetStats(opts?: { includeDeleted?: boolean; since?: Date }): Promise<FleetStats> {
        const includeDeleted = opts?.includeDeleted ?? false;
        const since = opts?.since ?? null;

        // Per-group breakdown
        const { rows: groups } = await this.pool.query(
            `SELECT * FROM ${this.sql.fn.getFleetStatsByAgent}($1, $2)`,
            [includeDeleted, since],
        );

        // Totals + earliest date
        const { rows: totalsRows } = await this.pool.query(
            `SELECT * FROM ${this.sql.fn.getFleetStatsTotals}($1, $2)`,
            [includeDeleted, since],
        );

        const t = totalsRows[0];
        const totalsTokensInput = Number(t.total_tokens_input) || 0;
        const totalsTokensCacheRead = Number(t.total_tokens_cache_read) || 0;
        return {
            windowStart: opts?.since ? opts.since.getTime() : null,
            earliestSessionCreatedAt: t.earliest_session_created_at
                ? new Date(t.earliest_session_created_at).getTime()
                : null,
            byAgent: groups.map((g: any) => {
                const tokensInput = Number(g.total_tokens_input) || 0;
                const tokensCacheRead = Number(g.total_tokens_cache_read) || 0;
                return {
                    agentId: g.agent_id ?? null,
                    model: g.model ?? null,
                    sessionCount: Number(g.session_count) || 0,
                    turnCount: Number(g.turn_count) || 0,
                    totalSnapshotSizeBytes: Number(g.total_snapshot_size_bytes) || 0,
                    totalDehydrationCount: Number(g.total_dehydration_count) || 0,
                    totalHydrationCount: Number(g.total_hydration_count) || 0,
                    totalLossyHandoffCount: Number(g.total_lossy_handoff_count) || 0,
                    totalTokensInput: tokensInput,
                    totalTokensOutput: Number(g.total_tokens_output) || 0,
                    totalTokensCacheRead: tokensCacheRead,
                    totalTokensCacheWrite: Number(g.total_tokens_cache_write) || 0,
                    cacheHitRatio: computeCacheHitRatio(tokensInput, tokensCacheRead),
                };
            }),
            totals: {
                sessionCount: Number(t.session_count) || 0,
                totalSnapshotSizeBytes: Number(t.total_snapshot_size_bytes) || 0,
                totalTokensInput: totalsTokensInput,
                totalTokensOutput: Number(t.total_tokens_output) || 0,
                totalTokensCacheRead: totalsTokensCacheRead,
                totalTokensCacheWrite: Number(t.total_tokens_cache_write) || 0,
                cacheHitRatio: computeCacheHitRatio(totalsTokensInput, totalsTokensCacheRead),
            },
        };
    }

    async getUserStats(opts?: { includeDeleted?: boolean; since?: Date }): Promise<UserStats> {
        const includeDeleted = opts?.includeDeleted ?? false;
        const since = opts?.since ?? null;
        const { rows } = await this.pool.query(
            `SELECT * FROM ${this.sql.fn.getUserStatsByModel}($1, $2)`,
            [includeDeleted, since],
        );

        const byOwner = new Map<string, UserStatsBucket>();
        let earliestSessionCreatedAt: number | null = null;
        const totals = {
            sessionCount: 0,
            totalSnapshotSizeBytes: 0,
            totalOrchestrationHistorySizeBytes: 0,
            totalTokensInput: 0,
            totalTokensOutput: 0,
            totalTokensCacheRead: 0,
            totalTokensCacheWrite: 0,
            cacheHitRatio: null as number | null,
        };

        for (const row of rows) {
            const ownerKind = normalizeOwnerKind(row.owner_kind);
            const owner = ownerKind === "user" && row.owner_provider && row.owner_subject
                ? {
                    provider: row.owner_provider,
                    subject: row.owner_subject,
                    email: row.owner_email ?? null,
                    displayName: row.owner_display_name ?? null,
                }
                : null;
            const ownerKey = userStatsOwnerKey(ownerKind, owner);
            const sessionIds = Array.isArray(row.session_ids)
                ? row.session_ids.map((id: unknown) => String(id || "")).filter(Boolean)
                : [];
            const tokensInput = Number(row.total_tokens_input) || 0;
            const tokensCacheRead = Number(row.total_tokens_cache_read) || 0;
            const modelBucket: UserStatsModelBucket = {
                model: row.model ?? null,
                sessionIds,
                sessionCount: Number(row.session_count) || 0,
                turnCount: Number(row.turn_count) || 0,
                totalSnapshotSizeBytes: Number(row.total_snapshot_size_bytes) || 0,
                totalOrchestrationHistorySizeBytes: 0,
                totalDehydrationCount: Number(row.total_dehydration_count) || 0,
                totalHydrationCount: Number(row.total_hydration_count) || 0,
                totalLossyHandoffCount: Number(row.total_lossy_handoff_count) || 0,
                totalTokensInput: tokensInput,
                totalTokensOutput: Number(row.total_tokens_output) || 0,
                totalTokensCacheRead: tokensCacheRead,
                totalTokensCacheWrite: Number(row.total_tokens_cache_write) || 0,
                cacheHitRatio: computeCacheHitRatio(tokensInput, tokensCacheRead),
            };

            let bucket = byOwner.get(ownerKey);
            if (!bucket) {
                bucket = {
                    ownerKind,
                    owner,
                    sessionIds: [],
                    sessionCount: 0,
                    totalSnapshotSizeBytes: 0,
                    totalOrchestrationHistorySizeBytes: 0,
                    totalTokensInput: 0,
                    totalTokensOutput: 0,
                    totalTokensCacheRead: 0,
                    totalTokensCacheWrite: 0,
                    cacheHitRatio: null,
                    byModel: [],
                };
                byOwner.set(ownerKey, bucket);
            }

            bucket.byModel.push(modelBucket);
            bucket.sessionIds.push(...sessionIds);
            bucket.sessionCount += modelBucket.sessionCount;
            bucket.totalSnapshotSizeBytes += modelBucket.totalSnapshotSizeBytes;
            bucket.totalTokensInput += modelBucket.totalTokensInput;
            bucket.totalTokensOutput += modelBucket.totalTokensOutput;
            bucket.totalTokensCacheRead += modelBucket.totalTokensCacheRead;
            bucket.totalTokensCacheWrite += modelBucket.totalTokensCacheWrite;

            totals.sessionCount += modelBucket.sessionCount;
            totals.totalSnapshotSizeBytes += modelBucket.totalSnapshotSizeBytes;
            totals.totalTokensInput += modelBucket.totalTokensInput;
            totals.totalTokensOutput += modelBucket.totalTokensOutput;
            totals.totalTokensCacheRead += modelBucket.totalTokensCacheRead;
            totals.totalTokensCacheWrite += modelBucket.totalTokensCacheWrite;

            if (row.earliest_session_created_at) {
                const ts = new Date(row.earliest_session_created_at).getTime();
                if (Number.isFinite(ts) && (earliestSessionCreatedAt == null || ts < earliestSessionCreatedAt)) {
                    earliestSessionCreatedAt = ts;
                }
            }
        }

        const users = Array.from(byOwner.values()).map((bucket) => ({
            ...bucket,
            sessionIds: [...new Set(bucket.sessionIds)],
            cacheHitRatio: computeCacheHitRatio(bucket.totalTokensInput, bucket.totalTokensCacheRead),
            byModel: bucket.byModel.sort((a, b) =>
                (b.totalTokensInput - a.totalTokensInput)
                || String(a.model || "").localeCompare(String(b.model || "")),
            ),
        })).sort((a, b) =>
            (b.totalTokensInput - a.totalTokensInput)
            || (b.totalSnapshotSizeBytes - a.totalSnapshotSizeBytes)
            || userStatsOwnerLabel(a).localeCompare(userStatsOwnerLabel(b)),
        );

        return {
            windowStart: opts?.since ? opts.since.getTime() : null,
            earliestSessionCreatedAt,
            users,
            totals: {
                ...totals,
                cacheHitRatio: computeCacheHitRatio(totals.totalTokensInput, totals.totalTokensCacheRead),
            },
        };
    }

    async upsertSessionMetricSummary(sessionId: string, updates: SessionMetricSummaryUpsert): Promise<void> {
        await this.pool.query(
            `SELECT ${this.sql.fn.upsertSessionMetricSummary}($1, $2)`,
            [sessionId, JSON.stringify(updates)],
        );
    }

    async getUserProfile(principal: UserPrincipal): Promise<UserProfile | null> {
        const provider = principal?.provider?.trim();
        const subject = principal?.subject?.trim();
        if (!provider || !subject) return null;
        const { rows } = await this.pool.query(
            `SELECT * FROM ${this.sql.fn.getUserProfile}($1, $2)`,
            [provider, subject],
        );
        if (rows.length === 0) return null;
        return rowToUserProfile(rows[0]);
    }

    async getUserGitHubCopilotKey(principal: UserPrincipal): Promise<string | null> {
        const provider = principal?.provider?.trim();
        const subject = principal?.subject?.trim();
        if (!provider || !subject) return null;
        const { rows } = await this.pool.query(
            `SELECT ${this.sql.fn.getUserGitHubCopilotKey}($1, $2) AS key`,
            [provider, subject],
        );
        const raw = rows[0]?.key;
        if (raw == null) return null;
        const text = String(raw);
        return text.length === 0 ? null : text;
    }

    async setUserProfileSettings(principal: UserPrincipal, settings: Record<string, unknown>): Promise<UserProfile> {
        const provider = principal?.provider?.trim();
        const subject = principal?.subject?.trim();
        if (!provider || !subject) {
            throw new Error("setUserProfileSettings: provider and subject are required");
        }
        const safeSettings = settings && typeof settings === "object" && !Array.isArray(settings) ? settings : {};
        await this.pool.query(
            `SELECT ${this.sql.fn.setUserProfileSettings}($1, $2, $3, $4, $5::jsonb)`,
            [
                provider,
                subject,
                principal.email ?? null,
                principal.displayName ?? null,
                JSON.stringify(safeSettings),
            ],
        );
        const profile = await this.getUserProfile(principal);
        if (!profile) {
            throw new Error("setUserProfileSettings: failed to read back the user profile after write");
        }
        return profile;
    }

    async setUserGitHubCopilotKey(principal: UserPrincipal, key: string | null): Promise<UserProfile> {
        const provider = principal?.provider?.trim();
        const subject = principal?.subject?.trim();
        if (!provider || !subject) {
            throw new Error("setUserGitHubCopilotKey: provider and subject are required");
        }
        const normalized = typeof key === "string" && key.trim().length > 0 ? key.trim() : null;
        await this.pool.query(
            `SELECT ${this.sql.fn.setUserGitHubCopilotKey}($1, $2, $3, $4, $5)`,
            [
                provider,
                subject,
                principal.email ?? null,
                principal.displayName ?? null,
                normalized,
            ],
        );
        const profile = await this.getUserProfile(principal);
        if (!profile) {
            throw new Error("setUserGitHubCopilotKey: failed to read back the user profile after write");
        }
        return profile;
    }

    async pruneDeletedSummaries(olderThan: Date): Promise<number> {
        const { rows } = await this.pool.query(
            `SELECT ${this.sql.fn.pruneDeletedSummaries}($1) AS deleted_count`,
            [olderThan],
        );
        return Number(rows[0]?.deleted_count) || 0;
    }

    async getSessionSkillUsage(sessionId: string, opts?: { since?: Date }): Promise<SkillUsageRow[]> {
        const { rows } = await this.pool.query(
            `SELECT * FROM ${this.sql.fn.getSessionSkillUsage}($1, $2)`,
            [sessionId, opts?.since ?? null],
        );
        return rows.map(rowToSkillUsageRow);
    }

    async getSessionTreeSkillUsage(sessionId: string, opts?: { since?: Date }): Promise<SessionTreeSkillUsage> {
        const { rows } = await this.pool.query(
            `SELECT * FROM ${this.sql.fn.getSessionTreeSkillUsage}($1, $2)`,
            [sessionId, opts?.since ?? null],
        );

        const perSessionMap = new Map<string, { agentId: string | null; skills: SkillUsageRow[] }>();
        const rolledUpMap = new Map<string, SkillUsageRow>();
        let totalInvocations = 0;

        for (const r of rows) {
            const sid = String(r.session_id);
            const item = rowToSkillUsageRow(r);
            const bucket = perSessionMap.get(sid)
                ?? ({ agentId: (r.agent_id ?? null) as string | null, skills: [] as SkillUsageRow[] });
            bucket.skills.push(item);
            perSessionMap.set(sid, bucket);

            const key = `${item.kind}\u0001${item.name}\u0001${item.pluginName ?? ""}\u0001${item.pluginVersion ?? ""}`;
            const existing = rolledUpMap.get(key);
            if (existing) {
                existing.invocations += item.invocations;
                if (item.firstUsedAt < existing.firstUsedAt) existing.firstUsedAt = item.firstUsedAt;
                if (item.lastUsedAt > existing.lastUsedAt) existing.lastUsedAt = item.lastUsedAt;
            } else {
                rolledUpMap.set(key, { ...item });
            }
            totalInvocations += item.invocations;
        }

        const rolledUp = Array.from(rolledUpMap.values()).sort((a, b) =>
            b.invocations - a.invocations || b.lastUsedAt.getTime() - a.lastUsedAt.getTime(),
        );

        const perSession = Array.from(perSessionMap.entries()).map(([sid, bucket]) => ({
            sessionId: sid,
            agentId: bucket.agentId,
            skills: bucket.skills,
        }));

        return {
            rootSessionId: sessionId,
            perSession,
            rolledUp,
            totalInvocations,
        };
    }

    async getFleetSkillUsage(opts?: { since?: Date; includeDeleted?: boolean }): Promise<FleetSkillUsage> {
        const since = opts?.since ?? null;
        const includeDeleted = opts?.includeDeleted ?? false;
        const { rows } = await this.pool.query(
            `SELECT * FROM ${this.sql.fn.getFleetSkillUsage}($1, $2)`,
            [since, includeDeleted],
        );
        return {
            windowStart: opts?.since ? opts.since.getTime() : null,
            rows: rows.map((r: any): FleetSkillUsageRow => ({
                ...rowToSkillUsageRow(r),
                agentId: r.agent_id ?? null,
                sessionCount: Number(r.session_count) || 0,
            })),
        };
    }

    async getSessionRetrievalUsage(sessionId: string, opts?: { since?: Date }): Promise<RetrievalUsageRow[]> {
        const { rows } = await this.pool.query(
            `SELECT * FROM ${this.sql.fn.getSessionRetrievalUsage}($1, $2)`,
            [sessionId, opts?.since ?? null],
        );
        return rows.map(rowToRetrievalUsageRow);
    }

    async getSessionTreeRetrievalUsage(sessionId: string, opts?: { since?: Date }): Promise<SessionTreeRetrievalUsage> {
        const { rows } = await this.pool.query(
            `SELECT * FROM ${this.sql.fn.getSessionTreeRetrievalUsage}($1, $2)`,
            [sessionId, opts?.since ?? null],
        );

        const perSessionMap = new Map<string, { agentId: string | null; rows: RetrievalUsageRow[] }>();
        const rolledUpMap = new Map<string, RetrievalUsageRow>();
        let totalCalls = 0;

        for (const r of rows) {
            const sid = String(r.session_id);
            const item = rowToRetrievalUsageRow(r);
            const bucket = perSessionMap.get(sid)
                ?? ({ agentId: (r.agent_id ?? null) as string | null, rows: [] as RetrievalUsageRow[] });
            bucket.rows.push(item);
            perSessionMap.set(sid, bucket);

            const key = `${item.surface}\u0001${item.operation}\u0001${item.namespace ?? ""}`;
            const existing = rolledUpMap.get(key);
            if (existing) {
                const nextCalls = existing.calls + item.calls;
                existing.totalResults += item.totalResults;
                existing.totalDurationMs = sumNullable(existing.totalDurationMs, item.totalDurationMs);
                existing.calls = nextCalls;
                existing.avgResults = nextCalls > 0 ? existing.totalResults / nextCalls : 0;
                existing.avgDurationMs = existing.totalDurationMs != null && nextCalls > 0 ? existing.totalDurationMs / nextCalls : null;
                if (item.firstUsedAt < existing.firstUsedAt) existing.firstUsedAt = item.firstUsedAt;
                if (item.lastUsedAt > existing.lastUsedAt) existing.lastUsedAt = item.lastUsedAt;
            } else {
                rolledUpMap.set(key, { ...item });
            }
            totalCalls += item.calls;
        }

        const rolledUp = Array.from(rolledUpMap.values()).sort((a, b) =>
            b.calls - a.calls || b.lastUsedAt.getTime() - a.lastUsedAt.getTime(),
        );
        const perSession = Array.from(perSessionMap.entries()).map(([sid, bucket]) => ({
            sessionId: sid,
            agentId: bucket.agentId,
            rows: bucket.rows,
        }));

        return { rootSessionId: sessionId, perSession, rolledUp, totalCalls };
    }

    async getFleetRetrievalUsage(opts?: { since?: Date; includeDeleted?: boolean }): Promise<FleetRetrievalUsage> {
        const { rows } = await this.pool.query(
            `SELECT * FROM ${this.sql.fn.getFleetRetrievalUsage}($1, $2)`,
            [opts?.since ?? null, opts?.includeDeleted ?? false],
        );
        return {
            windowStart: opts?.since ? opts.since.getTime() : null,
            rows: rows.map((r: any): FleetRetrievalUsageRow => ({
                ...rowToRetrievalUsageRow(r),
                agentId: r.agent_id ?? null,
                sessionCount: Number(r.session_count) || 0,
            })),
        };
    }

    async getSessionGraphNodeUsage(sessionId: string, opts?: { since?: Date; limit?: number; nodeKeyLike?: string; kind?: GraphNodeUsageKind }): Promise<GraphNodeUsageRow[]> {
        const { rows } = await this.pool.query(
            `SELECT * FROM ${this.sql.fn.getSessionGraphNodeUsage}($1, $2, $3, $4, $5)`,
            [sessionId, opts?.since ?? null, opts?.limit ?? null, opts?.nodeKeyLike ?? null, opts?.kind ?? null],
        );
        return rows.map(rowToGraphNodeUsageRow);
    }

    async getFleetGraphNodeUsage(opts?: { since?: Date; includeDeleted?: boolean; limit?: number; nodeKeyLike?: string; kind?: GraphNodeUsageKind }): Promise<FleetGraphNodeUsage> {
        const { rows } = await this.pool.query(
            `SELECT * FROM ${this.sql.fn.getFleetGraphNodeUsage}($1, $2, $3, $4, $5)`,
            [opts?.since ?? null, opts?.includeDeleted ?? false, opts?.limit ?? null, opts?.nodeKeyLike ?? null, opts?.kind ?? null],
        );
        return {
            windowStart: opts?.since ? opts.since.getTime() : null,
            rows: rows.map((r: any): FleetGraphNodeUsageRow => ({
                ...rowToGraphNodeUsageRow(r),
                agentId: r.agent_id ?? null,
                sessionCount: Number(r.session_count) || 0,
            })),
        };
    }

    async getSessionGraphEdgeSearchUsage(sessionId: string, opts?: { since?: Date; limit?: number }): Promise<GraphEdgeSearchUsageRow[]> {
        const { rows } = await this.pool.query(
            `SELECT * FROM ${this.sql.fn.getSessionGraphEdgeSearchUsage}($1, $2, $3)`,
            [sessionId, opts?.since ?? null, opts?.limit ?? null],
        );
        return rows.map(rowToGraphEdgeSearchUsageRow);
    }

    async close(): Promise<void> {
        if (this.pool) {
            await this.pool.end();
            this.pool = null;
        }
    }
}

// ─── Helpers ─────────────────────────────────────────────────────

/** Map a PG row (snake_case) to SessionRow (camelCase). */
function rowToSessionRow(row: any): SessionRow {
    const owner = row.owner_provider && row.owner_subject
        ? {
            provider: row.owner_provider,
            subject: row.owner_subject,
            email: row.owner_email ?? null,
            displayName: row.owner_display_name ?? null,
        }
        : null;
    return {
        sessionId: row.session_id,
        orchestrationId: row.orchestration_id ?? null,
        title: row.title ?? null,
        titleLocked: row.title_locked ?? false,
        state: row.state,
        model: row.model ?? null,
        reasoningEffort: row.reasoning_effort ?? null,
        createdAt: new Date(row.created_at),
        updatedAt: new Date(row.updated_at),
        lastActiveAt: row.last_active_at ? new Date(row.last_active_at) : null,
        deletedAt: row.deleted_at ? new Date(row.deleted_at) : null,
        currentIteration: row.current_iteration ?? 0,
        lastError: row.last_error ?? null,
        waitReason: row.wait_reason ?? null,
        activeTurnIndex: row.active_turn_index ?? null,
        parentSessionId: row.parent_session_id ?? null,
        isSystem: row.is_system ?? false,
        agentId: row.agent_id ?? null,
        splash: row.splash ?? null,
        groupId: row.group_id ?? null,
        shortSummary: row.short_summary ?? null,
        summaryState: row.summary_state ?? null,
        summaryUpdatedAt: row.summary_updated_at ? new Date(row.summary_updated_at) : null,
        owner,
    };
}

function rowToSessionGroupRow(row: any): SessionGroupRow {
    const owner = row.owner_provider && row.owner_subject
        ? {
            provider: row.owner_provider,
            subject: row.owner_subject,
            email: row.owner_email ?? null,
            displayName: row.owner_display_name ?? null,
        }
        : row.owner ?? null;
    return {
        groupId: row.group_id,
        title: row.title,
        description: row.description ?? null,
        owner,
        metadata: row.metadata ?? {},
        memberCount: Number(row.member_count) || 0,
        runningCount: Number(row.running_count) || 0,
        waitingCount: Number(row.waiting_count) || 0,
        completedCount: Number(row.completed_count) || 0,
        failedCount: Number(row.failed_count) || 0,
        cancelledCount: Number(row.cancelled_count) || 0,
        latestActivityAt: row.latest_activity_at ? new Date(row.latest_activity_at) : null,
        latestSummaryUpdatedAt: row.latest_summary_updated_at ? new Date(row.latest_summary_updated_at) : null,
        createdAt: new Date(row.created_at),
        updatedAt: new Date(row.updated_at),
    };
}

function rowToChildOutcomeRow(row: any): ChildOutcomeRow {
    return {
        childSessionId: row.child_session_id,
        parentSessionId: row.parent_session_id,
        contractJson: row.contract_json ?? null,
        resultJson: row.result_json ?? null,
        verdict: row.verdict ?? null,
        summary: row.summary ?? null,
        completedAt: row.completed_at ? new Date(row.completed_at) : null,
        createdAt: new Date(row.created_at),
        updatedAt: new Date(row.updated_at),
    };
}

/** Map a PG row to SessionEvent. */
function rowToSessionEvent(row: any): SessionEvent {
    return {
        seq: Number(row.seq),
        sessionId: row.session_id,
        eventType: row.event_type,
        data: row.data,
        createdAt: new Date(row.created_at),
        workerNodeId: row.worker_node_id ?? undefined,
    };
}

/** Map a PG row to TopEventEmitterRow. */
function rowToTopEventEmitterRow(row: any): TopEventEmitterRow {
    return {
        workerNodeId: String(row.worker_node_id),
        eventType: String(row.event_type),
        eventCount: Number(row.event_count) || 0,
        sessionCount: Number(row.session_count) || 0,
        firstSeenAt: row.first_seen_at ? new Date(row.first_seen_at) : null,
        lastSeenAt: row.last_seen_at ? new Date(row.last_seen_at) : null,
    };
}

function rowToTurnMetricRow(row: any): TurnMetricRow {
    return {
        id: Number(row.id),
        sessionId: row.session_id,
        agentId: row.agent_id ?? null,
        model: row.model ?? null,
        reasoningEffort: row.reasoning_effort ?? null,
        turnIndex: Number(row.turn_index) || 0,
        startedAt: new Date(row.started_at),
        endedAt: new Date(row.ended_at),
        durationMs: Number(row.duration_ms) || 0,
        tokensInput: Number(row.tokens_input) || 0,
        tokensOutput: Number(row.tokens_output) || 0,
        tokensCacheRead: Number(row.tokens_cache_read) || 0,
        tokensCacheWrite: Number(row.tokens_cache_write) || 0,
        toolCalls: Number(row.tool_calls) || 0,
        toolErrors: Number(row.tool_errors) || 0,
        resultType: row.result_type ?? null,
        errorMessage: row.error_message ?? null,
        workerNodeId: row.worker_node_id ?? null,
        createdAt: new Date(row.created_at),
    };
}

function rowToHourlyTokenBucketRow(row: any): HourlyTokenBucketRow {
    return {
        hourBucket: new Date(row.hour_bucket),
        turnCount: Number(row.turn_count) || 0,
        totalTokensInput: Number(row.total_tokens_input) || 0,
        totalTokensOutput: Number(row.total_tokens_output) || 0,
        totalTokensCacheRead: Number(row.total_tokens_cache_read) || 0,
        totalTokensCacheWrite: Number(row.total_tokens_cache_write) || 0,
    };
}

function normalizeOwnerKind(value: unknown): UserStatsOwnerKind {
    return value === "system" || value === "unowned" ? value : "user";
}

function userStatsOwnerKey(ownerKind: UserStatsOwnerKind, owner: SessionOwnerInfo | null): string {
    if (ownerKind !== "user") return ownerKind;
    return `${owner?.provider || ""}\u0001${owner?.subject || ""}`;
}

function userStatsOwnerLabel(bucket: { ownerKind: UserStatsOwnerKind; owner: SessionOwnerInfo | null }): string {
    if (bucket.ownerKind === "system") return "system";
    if (bucket.ownerKind === "unowned") return "unowned";
    return String(bucket.owner?.displayName || bucket.owner?.email || bucket.owner?.subject || "user");
}

/** Map a PG row to SessionMetricSummary. */
function rowToSessionMetricSummary(row: any): SessionMetricSummary {
    const tokensInput = Number(row.tokens_input) || 0;
    const tokensCacheRead = Number(row.tokens_cache_read) || 0;
    return {
        sessionId: row.session_id,
        agentId: row.agent_id ?? null,
        model: row.model ?? null,
        reasoningEffort: row.reasoning_effort ?? null,
        parentSessionId: row.parent_session_id ?? null,
        snapshotSizeBytes: Number(row.snapshot_size_bytes) || 0,
        dehydrationCount: Number(row.dehydration_count) || 0,
        hydrationCount: Number(row.hydration_count) || 0,
        lossyHandoffCount: Number(row.lossy_handoff_count) || 0,
        lastDehydratedAt: row.last_dehydrated_at ? new Date(row.last_dehydrated_at).getTime() : null,
        lastHydratedAt: row.last_hydrated_at ? new Date(row.last_hydrated_at).getTime() : null,
        lastCheckpointAt: row.last_checkpoint_at ? new Date(row.last_checkpoint_at).getTime() : null,
        tokensInput,
        tokensOutput: Number(row.tokens_output) || 0,
        tokensCacheRead,
        tokensCacheWrite: Number(row.tokens_cache_write) || 0,
        cacheHitRatio: computeCacheHitRatio(tokensInput, tokensCacheRead),
        deletedAt: row.deleted_at ? new Date(row.deleted_at).getTime() : null,
        createdAt: new Date(row.created_at).getTime(),
        updatedAt: new Date(row.updated_at).getTime(),
    };
}

/** Map a PG row to SkillUsageRow. Used for per-session, tree, and fleet rows. */
function rowToSkillUsageRow(row: any): SkillUsageRow {
    const kind: SkillKind = row.kind === "learned" ? "learned" : "static";
    return {
        kind,
        name: String(row.name ?? ""),
        pluginName: row.plugin_name ?? null,
        pluginVersion: row.plugin_version ?? null,
        invocations: Number(row.invocations) || 0,
        firstUsedAt: new Date(row.first_used_at ?? row.last_used_at),
        lastUsedAt: new Date(row.last_used_at),
    };
}

function normalizeRetrievalSurface(raw: any): RetrievalSurface {
    return raw === "skills" || raw === "graph" ? raw : "facts";
}

function normalizeRetrievalOperation(raw: any): RetrievalOperation {
    switch (raw) {
        case "facts_similar": return "facts_similar";
        case "search_skills": return "search_skills";
        case "graph_search_nodes": return "graph_search_nodes";
        case "graph_search_edges": return "graph_search_edges";
        case "graph_neighbourhood": return "graph_neighbourhood";
        default: return "facts_search";
    }
}

function rowToRetrievalUsageRow(row: any): RetrievalUsageRow {
    return {
        surface: normalizeRetrievalSurface(row.surface),
        operation: normalizeRetrievalOperation(row.operation),
        namespace: row.namespace ?? null,
        calls: Number(row.calls) || 0,
        totalResults: Number(row.total_results) || 0,
        avgResults: Number(row.avg_results) || 0,
        totalDurationMs: row.total_duration_ms == null ? null : Number(row.total_duration_ms),
        avgDurationMs: row.avg_duration_ms == null ? null : Number(row.avg_duration_ms),
        firstUsedAt: new Date(row.first_used_at ?? row.last_used_at),
        lastUsedAt: new Date(row.last_used_at ?? row.first_used_at),
    };
}

function rowToGraphNodeUsageRow(row: any): GraphNodeUsageRow {
    return {
        nodeKey: String(row.node_key ?? ""),
        namespace: row.namespace ?? null,
        operation: normalizeRetrievalOperation(row.operation),
        kind: row.kind === "loaded" ? "loaded" : "searched",
        count: Number(row.count) || 0,
        firstSeenAt: new Date(row.first_seen_at ?? row.last_seen_at),
        lastSeenAt: new Date(row.last_seen_at ?? row.first_seen_at),
    };
}

function rowToGraphEdgeSearchUsageRow(row: any): GraphEdgeSearchUsageRow {
    return {
        predicateKey: row.predicate_key ?? null,
        fromKey: row.from_key ?? null,
        toKey: row.to_key ?? null,
        namespace: row.namespace ?? null,
        calls: Number(row.calls) || 0,
        totalResults: Number(row.total_results) || 0,
        firstSearchedAt: new Date(row.first_searched_at ?? row.last_searched_at),
        lastSearchedAt: new Date(row.last_searched_at ?? row.first_searched_at),
    };
}

function sumNullable(a: number | null, b: number | null): number | null {
    if (a == null && b == null) return null;
    return (a ?? 0) + (b ?? 0);
}

function rowToUserProfile(row: any): UserProfile {
    let parsedSettings: Record<string, unknown> = {};
    const rawSettings = row?.profile_settings;
    if (rawSettings && typeof rawSettings === "object" && !Array.isArray(rawSettings)) {
        parsedSettings = rawSettings as Record<string, unknown>;
    } else if (typeof rawSettings === "string" && rawSettings.length > 0) {
        try {
            const parsed = JSON.parse(rawSettings);
            if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
                parsedSettings = parsed as Record<string, unknown>;
            }
        } catch {
            parsedSettings = {};
        }
    }
    return {
        userId: Number(row.user_id) || 0,
        provider: String(row.provider ?? ""),
        subject: String(row.subject ?? ""),
        email: row.email ?? null,
        displayName: row.display_name ?? null,
        profileSettings: parsedSettings,
        githubCopilotKeySet: Boolean(row.github_copilot_key_set),
        createdAt: row.created_at ? new Date(row.created_at) : null,
        updatedAt: row.updated_at ? new Date(row.updated_at) : null,
    };
}

/** @deprecated Use `SessionCatalog` instead. */
export type SessionCatalogProvider = SessionCatalog;

/** @deprecated Use `PgSessionCatalog` instead. */
export const PgSessionCatalogProvider = PgSessionCatalog;
