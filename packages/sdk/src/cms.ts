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
import { globalDbMetrics } from "./db-metrics.js";
import type { SessionOwnerInfo } from "./types.js";

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

/** A row in the sessions table. */
export interface SessionRow {
    sessionId: string;
    orchestrationId: string | null;
    title: string | null;
    titleLocked: boolean;
    state: string;
    model: string | null;
    createdAt: Date;
    updatedAt: Date;
    lastActiveAt: Date | null;
    deletedAt: Date | null;
    currentIteration: number;
    lastError: string | null;
    /** Live wait reason (e.g. "waiting for build"). Synced from runTurn activity. */
    waitReason: string | null;
    /** If this session is a sub-agent, the parent session's ID. */
    parentSessionId: string | null;
    /** Whether this is a system session (e.g. Sweeper Agent). */
    isSystem: boolean;
    /** Agent definition ID (e.g. "sweeper"). Links session to its agent config. */
    agentId: string | null;
    /** Splash banner (terminal markup) from the agent definition. */
    splash: string | null;
    /** Reasoning effort level set for this session. */
    reasoningEffort: string | null;
    /** Authenticated user associated with this session, if any. */
    owner: SessionOwnerInfo | null;
}

/** Opaque cursor for keyset-paginated session listing. */
export interface SessionPageCursor {
    /** ISO timestamp of the last item on the current page. */
    updatedAt: string;
    /** Session ID of the last item on the current page (tie-breaker). */
    sessionId: string;
}

/** Result of a paginated session list call. */
export interface SessionPage {
    items: SessionRow[];
    nextCursor?: SessionPageCursor;
    hasMore: boolean;
}

/** Fields that can be updated on a session row. */
export interface SessionRowUpdates {
    orchestrationId?: string | null;
    title?: string | null;
    titleLocked?: boolean;
    state?: string;
    model?: string | null;
    lastActiveAt?: Date;
    currentIteration?: number;
    lastError?: string | null;
    waitReason?: string | null;
    isSystem?: boolean;
    agentId?: string | null;
    splash?: string | null;
    reasoningEffort?: string | null;
    owner?: SessionOwnerInfo | null;
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
    turnCount: number;
    errorCount: number;
    toolCallCount: number;
    toolErrorCount: number;
    totalTurnDurationMs: number;
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
    turnCountIncrement?: number;
    errorCountIncrement?: number;
    toolCallCountIncrement?: number;
    toolErrorCountIncrement?: number;
    totalTurnDurationMsIncrement?: number;
}

/** Fleet-wide aggregate stats. */
export interface FleetStats {
    windowStart: number | null;
    earliestSessionCreatedAt: number | null;
    byAgent: Array<{
        agentId: string | null;
        model: string | null;
        sessionCount: number;
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
        totalTurnCount: number;
        totalErrorCount: number;
        totalToolCallCount: number;
        totalToolErrorCount: number;
        totalTurnDurationMs: number;
    }>;
    totals: {
        sessionCount: number;
        totalSnapshotSizeBytes: number;
        totalTokensInput: number;
        totalTokensOutput: number;
        totalTokensCacheRead: number;
        totalTokensCacheWrite: number;
        cacheHitRatio: number | null;
        totalTurnCount: number;
        totalErrorCount: number;
        totalToolCallCount: number;
        totalToolErrorCount: number;
        totalTurnDurationMs: number;
    };
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

// ─── User Stats & Profile Types ──────────────────────────────────

export type UserStatsOwnerKind = "user" | "system" | "unowned";

export interface UserStatsModelBucket {
    model: string | null;
    sessionIds: string[];
    sessionCount: number;
    totalSnapshotSizeBytes: number;
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
        totalTokensInput: number;
        totalTokensOutput: number;
        totalTokensCacheRead: number;
        totalTokensCacheWrite: number;
        cacheHitRatio: number | null;
    };
}

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

// ─── Turn Metrics + DB Bucket Types (Phase 2) ────────────────────

/** Input for inserting a single turn metric row. */
export interface InsertTurnMetricInput {
    sessionId:        string;
    agentId:          string | null;
    model:            string | null;
    turnIndex:        number;
    startedAt:        Date;
    endedAt:          Date;
    durationMs:       number;
    tokensInput:      number;
    tokensOutput:     number;
    tokensCacheRead:  number;
    tokensCacheWrite: number;
    toolCalls:        number;
    toolErrors:       number;
    resultType:       string | null;
    errorMessage:     string | null;
    workerNodeId:     string | null;
}

/** One row from session_turn_metrics. */
export interface TurnMetricRow {
    id:               number;
    sessionId:        string;
    agentId:          string | null;
    model:            string | null;
    turnIndex:        number;
    startedAt:        Date;
    endedAt:          Date;
    durationMs:       number;
    tokensInput:      number;
    tokensOutput:     number;
    tokensCacheRead:  number;
    tokensCacheWrite: number;
    toolCalls:        number;
    toolErrors:       number;
    resultType:       string | null;
    errorMessage:     string | null;
    workerNodeId:     string | null;
    createdAt:        Date;
}

/** One row from cms_get_fleet_turn_analytics. */
export interface FleetTurnAnalyticsRow {
    agentId:               string | null;
    model:                 string | null;
    turnCount:             number;
    errorCount:            number;
    toolCallCount:         number;
    toolErrorCount:        number;
    avgDurationMs:         number;
    p95DurationMs:         number;
    p99DurationMs:         number;
    totalTokensInput:      number;
    totalTokensOutput:     number;
    totalTokensCacheRead:  number;
    totalTokensCacheWrite: number;
}

/** One row from cms_get_hourly_token_buckets. */
export interface HourlyTokenBucketRow {
    hourBucket:            Date;
    turnCount:             number;
    totalTokensInput:      number;
    totalTokensOutput:     number;
    totalTokensCacheRead:  number;
    totalTokensCacheWrite: number;
}

/** Input row for upsert batch — one entry per (bucket_minute, process_id, method). */
export interface DbCallMetricBucketInput {
    bucket:      Date;
    process:     string;
    processRole: string;
    method:      string;
    calls:       number;
    errors:      number;
    totalMs:     number;
}

/** One row from cms_get_fleet_db_call_metrics. */
export interface FleetDbCallMetricRow {
    method:    string;
    calls:     number;
    errors:    number;
    totalMs:   number;
    avgMs:     number;
    errorRate: number;
}

export interface TopEventEmitterRow {
    workerNodeId: string;
    eventType:    string;
    eventCount:   number;
    sessionCount: number;
    firstSeenAt:  Date;
    lastSeenAt:   Date;
}

// ─── Provider Interface ──────────────────────────────────────────

/**
 * SessionCatalogProvider — abstraction over the CMS backing store.
 *
 * Initial implementation: PostgreSQL.
 * Future: CosmosDB, etc.
 */
export interface SessionCatalogProvider {
    /** Create schema and tables if they don't exist. */
    initialize(): Promise<void>;

    // ── Writes (called from client, before duroxide calls) ───

    /** Insert a new session. No-op if session already exists. */
    createSession(sessionId: string, opts?: { model?: string; parentSessionId?: string; isSystem?: boolean; agentId?: string; splash?: string }): Promise<void>;

    /** Update one or more fields on an existing session. */
    updateSession(sessionId: string, updates: SessionRowUpdates): Promise<void>;

    /** Soft-delete a session (set deleted_at). */
    softDeleteSession(sessionId: string): Promise<void>;

    // ── Reads (called from client) ───────────────────────────

    /** List all non-deleted sessions, newest first. */
    listSessions(): Promise<SessionRow[]>;

    /** Keyset-paginated session listing. Stable order: updated_at DESC, session_id DESC. */
    listSessionsPage(params?: { limit?: number; cursor?: SessionPageCursor; includeDeleted?: boolean }): Promise<SessionPage>;

    /** Get a single session by ID (null if not found or deleted). */
    getSession(sessionId: string): Promise<SessionRow | null>;

    /** Get all descendant session IDs (children, grandchildren, etc.) of a given session. */
    getDescendantSessionIds(sessionId: string): Promise<string[]>;

    /** Get the most recently active session ID. */
    getLastSessionId(): Promise<string | null>;

    // ── Events (written from worker, read from client) ───────

    /** Record a batch of events for a session. */
    recordEvents(sessionId: string, events: { eventType: string; data: unknown }[], workerNodeId?: string): Promise<void>;

    /** Get events for a session, optionally after a sequence number. */
    getSessionEvents(sessionId: string, afterSeq?: number, limit?: number): Promise<SessionEvent[]>;

    /** Get events before a sequence number, ordered ascending by seq. */
    getSessionEventsBefore(sessionId: string, beforeSeq: number, limit?: number): Promise<SessionEvent[]>;

    // ── Session Metric Summaries ──────────────────────────────

    /** Get the metric summary for a single session. */
    getSessionMetricSummary(sessionId: string): Promise<SessionMetricSummary | null>;

    /** Get a session's own stats plus rolled-up totals of all descendants. */
    getSessionTreeStats(sessionId: string): Promise<SessionTreeStats | null>;

    /** Get fleet-wide aggregate stats, optionally filtered. */
    getFleetStats(opts?: { includeDeleted?: boolean; since?: Date }): Promise<FleetStats>;

    /** Get skill usage (skill.invoked event aggregation) for a single session. */
    getSessionSkillUsage(sessionId: string, opts?: { since?: Date }): Promise<SkillUsageRow[]>;

    /** Get skill usage rolled across the spawn tree rooted at the given session. */
    getSessionTreeSkillUsage(sessionId: string, opts?: { since?: Date }): Promise<SessionTreeSkillUsage>;

    /** Get fleet-wide skill usage broken down by agent. Tuner / management surface. */
    getFleetSkillUsage(opts?: { since?: Date; includeDeleted?: boolean }): Promise<FleetSkillUsage>;

    /** Upsert a session metric summary with atomic increments. */
    upsertSessionMetricSummary(sessionId: string, updates: SessionMetricSummaryUpsert): Promise<void>;

    /** Hard-delete summary rows for sessions deleted before the cutoff. Returns count removed. */
    pruneDeletedSummaries(olderThan: Date): Promise<number>;

    // ── Turn Metrics (Phase 2) ────────────────────────────────

    /** Insert a single turn metric row. Fire-and-forget safe. */
    insertTurnMetric(input: InsertTurnMetricInput): Promise<void>;

    /** Get turn metrics for a session, most-recent-first. */
    getSessionTurnMetrics(sessionId: string, opts?: { since?: Date; limit?: number }): Promise<TurnMetricRow[]>;

    /** Fleet-wide turn analytics with p95, grouped by (agentId, model). */
    getFleetTurnAnalytics(opts?: { since?: Date; agentId?: string; model?: string }): Promise<FleetTurnAnalyticsRow[]>;

    /** Hourly token bucket rollup from session_turn_metrics. */
    getHourlyTokenBuckets(since: Date, opts?: { agentId?: string; model?: string }): Promise<HourlyTokenBucketRow[]>;

    /** Hard-delete turn metrics older than the cutoff. Returns count removed. */
    pruneTurnMetrics(olderThan: Date): Promise<number>;

    /** Upsert a batch of per-minute DB call metric buckets. Returns rows processed. */
    upsertDbCallMetricBucketBatch(rows: DbCallMetricBucketInput[]): Promise<number>;

    /** Fleet-wide DB call metrics aggregated from db_call_metric_buckets. */
    getFleetDbCallMetrics(opts?: { since?: Date }): Promise<FleetDbCallMetricRow[]>;

    /** Top (worker_node_id, event_type) pairs by event count within the given window. */
    getTopEventEmitters(params: { since: Date; limit?: number }): Promise<TopEventEmitterRow[]>;

    // ── User Stats & Profiles ─────────────────────────────────

    /** Get fleet-wide token usage stats grouped by owner. */
    getUserStats(opts?: { includeDeleted?: boolean; since?: Date }): Promise<UserStats>;

    /** Get or create a user profile by principal. Returns null if not found. */
    getUserProfile(principal: UserPrincipal): Promise<UserProfile | null>;

    /** Get the GitHub Copilot API key for a user principal. Returns null if not set. */
    getUserGitHubCopilotKey(principal: UserPrincipal): Promise<string | null>;

    /** Update a user's profile settings. Returns the updated profile. */
    setUserProfileSettings(principal: UserPrincipal, settings: Record<string, unknown>): Promise<UserProfile>;

    /** Set or clear a user's GitHub Copilot API key. Returns the updated profile. */
    setUserGitHubCopilotKey(principal: UserPrincipal, key: string | null): Promise<UserProfile>;

    /** Cleanup / close connections. */
    close(): Promise<void>;
}

// ─── PostgreSQL Implementation ───────────────────────────────────

const DEFAULT_SCHEMA = "copilot_sessions";
export const SESSION_EVENTS_NOTIFY_CHANNEL = "session_events";
const DEFAULT_DB_POOL_MAX = 10;
const DEFAULT_EVENT_FETCH_LIMIT = 200;
const DEFAULT_PG_QUERY_TIMEOUT_MS = 15_000;
const DEFAULT_PG_CONNECTION_TIMEOUT_MS = 5_000;
const DEFAULT_PG_IDLE_TIMEOUT_MS = 30_000;

/**
 * Parse a positive integer from an env-style record, returning `defaultVal`
 * on missing/invalid/below-`minVal` input.
 */
function resolveEnvInt(
    varName: string,
    defaultVal: number,
    env: Record<string, string | undefined> = process.env,
    minVal = 0,
): number {
    const raw = env[varName];
    if (!raw) return defaultVal;
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed) || parsed < minVal) return defaultVal;
    return parsed;
}

/**
 * Build pg Pool guardrail options from env vars.
 * Accepts an optional `env` record so tests can inject values without
 * mutating `process.env`.
 *
 * Env vars:
 *   DB_POOL_MAX               – max pool connections (default 10, min 1)
 *   PG_CONNECTION_TIMEOUT_MS  – connection timeout in ms (default 5000; 0 = no limit)
 *   PG_IDLE_TIMEOUT_MS        – idle client timeout in ms (default 30000; 0 = no limit)
 *   PG_QUERY_TIMEOUT_MS       – library-side query cancel in ms (default 15000; 0 = no limit)
 *   PG_STATEMENT_TIMEOUT_MS   – DB-side statement_timeout in ms (default 0 = disabled)
 */
export function buildPgGuardrailConfig(env: Record<string, string | undefined> = process.env): {
    max: number;
    connectionTimeoutMillis: number;
    idleTimeoutMillis: number;
    query_timeout: number;
    statement_timeout?: number;
} {
    const stmtTimeout = resolveEnvInt("PG_STATEMENT_TIMEOUT_MS", 0, env);
    return {
        max: resolveEnvInt("DB_POOL_MAX", DEFAULT_DB_POOL_MAX, env, 1),
        connectionTimeoutMillis: resolveEnvInt("PG_CONNECTION_TIMEOUT_MS", DEFAULT_PG_CONNECTION_TIMEOUT_MS, env),
        idleTimeoutMillis: resolveEnvInt("PG_IDLE_TIMEOUT_MS", DEFAULT_PG_IDLE_TIMEOUT_MS, env),
        query_timeout: resolveEnvInt("PG_QUERY_TIMEOUT_MS", DEFAULT_PG_QUERY_TIMEOUT_MS, env),
        ...(stmtTimeout > 0 ? { statement_timeout: stmtTimeout } : {}),
    };
}

export function buildPgConnectionConfig(connectionString: string): {
    connectionString: string;
    ssl?: { rejectUnauthorized: boolean; checkServerIdentity?: () => undefined };
} {
    // pg v8 treats sslmode=require as verify-full, which rejects some managed/self-signed certs.
    // For require/prefer: strip sslmode and use rejectUnauthorized: false.
    // For verify-ca: validate cert chain but skip hostname check.
    // For verify-full: validate cert chain + hostname (Node TLS default).
    const parsed = new URL(connectionString);
    const sslmode = parsed.searchParams.get("sslmode") ?? "";
    const relaxedSsl = ["require", "prefer"].includes(sslmode);
    const verifyCa = sslmode === "verify-ca";
    const verifyFull = sslmode === "verify-full";
    parsed.searchParams.delete("sslmode");
    parsed.searchParams.delete("channel_binding");

    const sslConfig = relaxedSsl
        ? { ssl: { rejectUnauthorized: false } }
        : verifyCa
            ? { ssl: { rejectUnauthorized: true, checkServerIdentity: () => undefined as undefined } }
            : verifyFull
                ? { ssl: { rejectUnauthorized: true } }
                : {};

    return { connectionString: parsed.toString(), ...sslConfig };
}

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
            updateSession:              `${s}.cms_update_session`,
            softDeleteSession:          `${s}.cms_soft_delete_session`,
            listSessions:               `${s}.cms_list_sessions`,
            listSessionsPage:           `${s}.cms_list_sessions_page`,
            getSession:                 `${s}.cms_get_session`,
            getDescendantSessionIds:    `${s}.cms_get_descendant_session_ids`,
            getLastSessionId:           `${s}.cms_get_last_session_id`,
            recordEvents:               `${s}.cms_record_events`,
            getSessionEvents:           `${s}.cms_get_session_events`,
            getSessionEventsBefore:     `${s}.cms_get_session_events_before`,
            getSessionMetricSummary:    `${s}.cms_get_session_metric_summary`,
            getSessionTreeStats:        `${s}.cms_get_session_tree_stats`,
            getSessionTreeStatsByModel: `${s}.cms_get_session_tree_stats_by_model`,
            getFleetStatsByAgent:       `${s}.cms_get_fleet_stats_by_agent`,
            getFleetStatsTotals:        `${s}.cms_get_fleet_stats_totals`,
            upsertSessionMetricSummary: `${s}.cms_upsert_session_metric_summary`,
            pruneDeletedSummaries:      `${s}.cms_prune_deleted_summaries`,
            getSessionSkillUsage:             `${s}.cms_get_session_skill_usage`,
            getSessionTreeSkillUsage:         `${s}.cms_get_session_tree_skill_usage`,
            getFleetSkillUsage:               `${s}.cms_get_fleet_skill_usage`,
            insertTurnMetric:                 `${s}.cms_insert_turn_metric`,
            getSessionTurnMetrics:            `${s}.cms_get_session_turn_metrics`,
            getFleetTurnAnalytics:            `${s}.cms_get_fleet_turn_analytics`,
            getHourlyTokenBuckets:            `${s}.cms_get_hourly_token_buckets`,
            pruneTurnMetrics:                 `${s}.cms_prune_turn_metrics`,
            upsertDbCallMetricBucketBatch:    `${s}.cms_upsert_db_call_metric_bucket_batch`,
            getFleetDbCallMetrics:            `${s}.cms_get_fleet_db_call_metrics`,
            getTopEventEmitters:              `${s}.cms_get_top_event_emitters`,
            getUserStatsByModel:              `${s}.cms_get_user_stats_by_model`,
            getUserProfile:                   `${s}.cms_get_user_profile`,
            getUserGitHubCopilotKey:          `${s}.cms_get_user_github_copilot_key`,
            setUserProfileSettings:           `${s}.cms_set_user_profile_settings`,
            setUserGitHubCopilotKey:          `${s}.cms_set_user_github_copilot_key`,
        },
    };
}

async function measureDbCall<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const t0 = Date.now();
    try {
        const result = await fn();
        globalDbMetrics.record(key, Date.now() - t0);
        return result;
    } catch (err) {
        globalDbMetrics.record(key, Date.now() - t0, true);
        throw err;
    }
}

/**
 * PgSessionCatalogProvider — PostgreSQL implementation of SessionCatalogProvider.
 *
 * Uses the `pg` package (node-postgres) directly.
 * Must be created via the async `PgSessionCatalogProvider.create()` factory.
 */
export class PgSessionCatalogProvider implements SessionCatalogProvider {
    private pool: any;
    private initialized = false;
    private sql: ReturnType<typeof sqlForSchema>;

    private constructor(pool: any, schema: string) {
        this.pool = pool;
        this.sql = sqlForSchema(schema);
    }

    /** Factory: create and connect a PgSessionCatalogProvider. */
    static async create(
        connectionString: string,
        schema?: string,
        env: Record<string, string | undefined> = process.env,
    ): Promise<PgSessionCatalogProvider> {
        const { default: pg } = await import("pg");

        const pool = new pg.Pool({
            ...buildPgGuardrailConfig(env),
            ...buildPgConnectionConfig(connectionString),
        });

        // Handle idle client errors (e.g. EADDRNOTAVAIL when the network
        // drops). Without this, pg Pool emits an unhandled 'error' event
        // which crashes the Node.js process.
        pool.on('error', (err: Error) => {
            console.error('[cms] pool idle client error (non-fatal):', err.message);
        });

        return new PgSessionCatalogProvider(pool, schema ?? DEFAULT_SCHEMA);
    }

    async initialize(): Promise<void> {
        if (this.initialized) return;
        return measureDbCall("cms.initialize", async () => {
            await runCmsMigrations(this.pool, this.sql.schema);
            this.initialized = true;
        });
    }

    // ── Writes ───────────────────────────────────────────────

    async createSession(sessionId: string, opts?: { model?: string; parentSessionId?: string; isSystem?: boolean; agentId?: string; splash?: string }): Promise<void> {
        return measureDbCall("cms.createSession", async () => {
            await this.pool.query(
                `SELECT ${this.sql.fn.createSession}($1, $2, $3, $4, $5, $6)`,
                [sessionId, opts?.model ?? null, opts?.parentSessionId ?? null, opts?.isSystem ?? false, opts?.agentId ?? null, opts?.splash ?? null],
            );
        });
    }

    async updateSession(sessionId: string, updates: SessionRowUpdates): Promise<void> {
        const jsonUpdates: Record<string, unknown> = {};
        if (updates.orchestrationId !== undefined) jsonUpdates.orchestrationId = updates.orchestrationId;
        if (updates.title !== undefined) jsonUpdates.title = updates.title;
        if (updates.titleLocked !== undefined) jsonUpdates.titleLocked = updates.titleLocked;
        if (updates.state !== undefined) jsonUpdates.state = updates.state;
        if (updates.model !== undefined) jsonUpdates.model = updates.model;
        if (updates.lastActiveAt !== undefined) jsonUpdates.lastActiveAt = updates.lastActiveAt ? updates.lastActiveAt.toISOString() : null;
        if (updates.currentIteration !== undefined) jsonUpdates.currentIteration = updates.currentIteration;
        if (updates.lastError !== undefined) jsonUpdates.lastError = updates.lastError;
        if (updates.waitReason !== undefined) jsonUpdates.waitReason = updates.waitReason;
        if (updates.isSystem !== undefined) jsonUpdates.isSystem = updates.isSystem;
        if (updates.agentId !== undefined) jsonUpdates.agentId = updates.agentId;
        if (updates.splash !== undefined) jsonUpdates.splash = updates.splash;

        if (Object.keys(jsonUpdates).length === 0) return;

        return measureDbCall("cms.updateSession", async () => {
            await this.pool.query(
                `SELECT ${this.sql.fn.updateSession}($1, $2)`,
                [sessionId, JSON.stringify(jsonUpdates)],
            );
        });
    }

    async softDeleteSession(sessionId: string): Promise<void> {
        return measureDbCall("cms.softDeleteSession", async () => {
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
        });
    }

    // ── Reads ────────────────────────────────────────────────

    async listSessions(): Promise<SessionRow[]> {
        return measureDbCall("cms.listSessions", async () => {
            const { rows } = await this.pool.query(
                `SELECT * FROM ${this.sql.fn.listSessions}()`,
            );
            return rows.map(rowToSessionRow);
        });
    }

    async listSessionsPage(params?: { limit?: number; cursor?: SessionPageCursor; includeDeleted?: boolean }): Promise<SessionPage> {
        return measureDbCall("cms.listSessionsPage", async () => {
            const limit = Math.min(200, Math.max(1, params?.limit ?? 50));
            const { rows } = await this.pool.query(
                `SELECT * FROM ${this.sql.fn.listSessionsPage}($1, $2, $3, $4)`,
                [
                    limit + 1,
                    params?.cursor?.updatedAt ?? null,
                    params?.cursor?.sessionId ?? null,
                    params?.includeDeleted ?? false,
                ],
            );
            const hasMore = rows.length > limit;
            const items = rows.slice(0, limit).map(rowToSessionRow);
            const nextCursor: SessionPageCursor | undefined = hasMore
                ? {
                    updatedAt: items[items.length - 1].updatedAt.toISOString(),
                    sessionId: items[items.length - 1].sessionId,
                }
                : undefined;
            return { items, nextCursor, hasMore };
        });
    }

    async getSession(sessionId: string): Promise<SessionRow | null> {
        return measureDbCall("cms.getSession", async () => {
            const { rows } = await this.pool.query(
                `SELECT * FROM ${this.sql.fn.getSession}($1)`,
                [sessionId],
            );
            return rows.length > 0 ? rowToSessionRow(rows[0]) : null;
        });
    }

    async getDescendantSessionIds(sessionId: string): Promise<string[]> {
        return measureDbCall("cms.getDescendantSessionIds", async () => {
            const { rows } = await this.pool.query(
                `SELECT * FROM ${this.sql.fn.getDescendantSessionIds}($1)`,
                [sessionId],
            );
            return rows.map((r: any) => r.session_id);
        });
    }

    async getLastSessionId(): Promise<string | null> {
        return measureDbCall("cms.getLastSessionId", async () => {
            const { rows } = await this.pool.query(
                `SELECT ${this.sql.fn.getLastSessionId}() AS session_id`,
            );
            return rows.length > 0 ? rows[0].session_id : null;
        });
    }

    // ── Events ───────────────────────────────────────────────

    async recordEvents(sessionId: string, events: { eventType: string; data: unknown }[], workerNodeId?: string): Promise<void> {
        if (events.length === 0) return;
        return measureDbCall("cms.recordEvents", async () => {
            const client = await this.pool.connect();
            try {
                await client.query("BEGIN");

                await client.query(
                    `SELECT ${this.sql.fn.recordEvents}($1, $2, $3)`,
                    [sessionId, JSON.stringify(events), workerNodeId ?? null],
                );
                await client.query(
                    "SELECT pg_notify($1, $2)",
                    [SESSION_EVENTS_NOTIFY_CHANNEL, JSON.stringify({ sessionId })],
                );
                await client.query("COMMIT");
            } catch (err) {
                try {
                    await client.query("ROLLBACK");
                } catch {}
                throw err;
            } finally {
                client.release();
            }
        });
    }

    async getSessionEvents(sessionId: string, afterSeq?: number, limit?: number): Promise<SessionEvent[]> {
        return measureDbCall("cms.getSessionEvents", async () => {
            const effectiveLimit = limit ?? DEFAULT_EVENT_FETCH_LIMIT;
            const { rows } = await this.pool.query(
                `SELECT * FROM ${this.sql.fn.getSessionEvents}($1, $2, $3)`,
                [sessionId, afterSeq ?? null, effectiveLimit],
            );
            return rows.map(rowToSessionEvent);
        });
    }

    async getSessionEventsBefore(sessionId: string, beforeSeq: number, limit?: number): Promise<SessionEvent[]> {
        return measureDbCall("cms.getSessionEventsBefore", async () => {
            const effectiveLimit = limit ?? DEFAULT_EVENT_FETCH_LIMIT;
            const { rows } = await this.pool.query(
                `SELECT * FROM ${this.sql.fn.getSessionEventsBefore}($1, $2, $3)`,
                [sessionId, beforeSeq, effectiveLimit],
            );
            return rows.map(rowToSessionEvent);
        });
    }

    // ── Session Metric Summaries ─────────────────────────────

    async getSessionMetricSummary(sessionId: string): Promise<SessionMetricSummary | null> {
        return measureDbCall("cms.getSessionMetricSummary", async () => {
            const { rows } = await this.pool.query(
                `SELECT * FROM ${this.sql.fn.getSessionMetricSummary}($1)`,
                [sessionId],
            );
            return rows.length > 0 ? rowToSessionMetricSummary(rows[0]) : null;
        });
    }

    async getSessionTreeStats(sessionId: string): Promise<SessionTreeStats | null> {
        return measureDbCall("cms.getSessionTreeStats", async () => {
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
        });
    }

    async getFleetStats(opts?: { includeDeleted?: boolean; since?: Date }): Promise<FleetStats> {
        return measureDbCall("cms.getFleetStats", async () => {
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
                    totalSnapshotSizeBytes: Number(g.total_snapshot_size_bytes) || 0,
                    totalDehydrationCount: Number(g.total_dehydration_count) || 0,
                    totalHydrationCount: Number(g.total_hydration_count) || 0,
                    totalLossyHandoffCount: Number(g.total_lossy_handoff_count) || 0,
                    totalTokensInput: tokensInput,
                    totalTokensOutput: Number(g.total_tokens_output) || 0,
                    totalTokensCacheRead: tokensCacheRead,
                    totalTokensCacheWrite: Number(g.total_tokens_cache_write) || 0,
                    cacheHitRatio: computeCacheHitRatio(tokensInput, tokensCacheRead),
                    totalTurnCount: Number(g.total_turn_count) || 0,
                    totalErrorCount: Number(g.total_error_count) || 0,
                    totalToolCallCount: Number(g.total_tool_call_count) || 0,
                    totalToolErrorCount: Number(g.total_tool_error_count) || 0,
                    totalTurnDurationMs: Number(g.total_turn_duration_ms) || 0,
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
                totalTurnCount: Number(t.total_turn_count) || 0,
                totalErrorCount: Number(t.total_error_count) || 0,
                totalToolCallCount: Number(t.total_tool_call_count) || 0,
                totalToolErrorCount: Number(t.total_tool_error_count) || 0,
                totalTurnDurationMs: Number(t.total_turn_duration_ms) || 0,
            },
        };
        });
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
            sessionCount: 0, totalSnapshotSizeBytes: 0,
            totalTokensInput: 0, totalTokensOutput: 0, totalTokensCacheRead: 0, totalTokensCacheWrite: 0,
            cacheHitRatio: null as number | null,
        };
        for (const row of rows) {
            const ownerKind = normalizeOwnerKind(row.owner_kind);
            const owner = ownerKind === "user" && row.owner_provider && row.owner_subject
                ? { provider: row.owner_provider, subject: row.owner_subject, email: row.owner_email ?? null, displayName: row.owner_display_name ?? null }
                : null;
            const ownerKey = userStatsOwnerKey(ownerKind, owner);
            const sessionIds = Array.isArray(row.session_ids)
                ? row.session_ids.map((id: unknown) => String(id || "")).filter(Boolean) : [];
            const tokensInput = Number(row.total_tokens_input) || 0;
            const tokensCacheRead = Number(row.total_tokens_cache_read) || 0;
            const modelBucket: UserStatsModelBucket = {
                model: row.model ?? null, sessionIds, sessionCount: Number(row.session_count) || 0,
                totalSnapshotSizeBytes: Number(row.total_snapshot_size_bytes) || 0,
                totalDehydrationCount: Number(row.total_dehydration_count) || 0,
                totalHydrationCount: Number(row.total_hydration_count) || 0,
                totalLossyHandoffCount: Number(row.total_lossy_handoff_count) || 0,
                totalTokensInput: tokensInput, totalTokensOutput: Number(row.total_tokens_output) || 0,
                totalTokensCacheRead: tokensCacheRead, totalTokensCacheWrite: Number(row.total_tokens_cache_write) || 0,
                cacheHitRatio: computeCacheHitRatio(tokensInput, tokensCacheRead),
            };
            let bucket = byOwner.get(ownerKey);
            if (!bucket) {
                bucket = { ownerKind, owner, sessionIds: [], sessionCount: 0, totalSnapshotSizeBytes: 0,
                    totalTokensInput: 0, totalTokensOutput: 0,
                    totalTokensCacheRead: 0, totalTokensCacheWrite: 0, cacheHitRatio: null, byModel: [] };
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
                if (Number.isFinite(ts) && (earliestSessionCreatedAt == null || ts < earliestSessionCreatedAt))
                    earliestSessionCreatedAt = ts;
            }
        }
        const users = Array.from(byOwner.values()).map((bucket) => ({
            ...bucket, sessionIds: [...new Set(bucket.sessionIds)],
            cacheHitRatio: computeCacheHitRatio(bucket.totalTokensInput, bucket.totalTokensCacheRead),
            byModel: bucket.byModel.sort((a, b) => (b.totalTokensInput - a.totalTokensInput) || String(a.model || "").localeCompare(String(b.model || ""))),
        })).sort((a, b) => (b.totalTokensInput - a.totalTokensInput) || (b.totalSnapshotSizeBytes - a.totalSnapshotSizeBytes) || userStatsOwnerLabel(a).localeCompare(userStatsOwnerLabel(b)));
        return { windowStart: opts?.since ? opts.since.getTime() : null, earliestSessionCreatedAt, users,
            totals: { ...totals, cacheHitRatio: computeCacheHitRatio(totals.totalTokensInput, totals.totalTokensCacheRead) } };
    }

    async getUserProfile(principal: UserPrincipal): Promise<UserProfile | null> {
        const provider = principal?.provider?.trim();
        const subject = principal?.subject?.trim();
        if (!provider || !subject) return null;
        const { rows } = await this.pool.query(`SELECT * FROM ${this.sql.fn.getUserProfile}($1, $2)`, [provider, subject]);
        if (rows.length === 0) return null;
        return rowToUserProfile(rows[0]);
    }

    async getUserGitHubCopilotKey(principal: UserPrincipal): Promise<string | null> {
        const provider = principal?.provider?.trim();
        const subject = principal?.subject?.trim();
        if (!provider || !subject) return null;
        const { rows } = await this.pool.query(`SELECT ${this.sql.fn.getUserGitHubCopilotKey}($1, $2) AS key`, [provider, subject]);
        const raw = rows[0]?.key;
        if (raw == null) return null;
        const text = String(raw);
        return text.length === 0 ? null : text;
    }

    async setUserProfileSettings(principal: UserPrincipal, settings: Record<string, unknown>): Promise<UserProfile> {
        const provider = principal?.provider?.trim();
        const subject = principal?.subject?.trim();
        if (!provider || !subject) throw new Error("setUserProfileSettings: provider and subject are required");
        const safeSettings = settings && typeof settings === "object" && !Array.isArray(settings) ? settings : {};
        await this.pool.query(`SELECT ${this.sql.fn.setUserProfileSettings}($1, $2, $3, $4, $5::jsonb)`,
            [provider, subject, principal.email ?? null, principal.displayName ?? null, JSON.stringify(safeSettings)]);
        const profile = await this.getUserProfile(principal);
        if (!profile) throw new Error("setUserProfileSettings: failed to read back the user profile after write");
        return profile;
    }

    async setUserGitHubCopilotKey(principal: UserPrincipal, key: string | null): Promise<UserProfile> {
        const provider = principal?.provider?.trim();
        const subject = principal?.subject?.trim();
        if (!provider || !subject) throw new Error("setUserGitHubCopilotKey: provider and subject are required");
        const normalized = typeof key === "string" && key.trim().length > 0 ? key.trim() : null;
        await this.pool.query(`SELECT ${this.sql.fn.setUserGitHubCopilotKey}($1, $2, $3, $4, $5)`,
            [provider, subject, principal.email ?? null, principal.displayName ?? null, normalized]);
        const profile = await this.getUserProfile(principal);
        if (!profile) throw new Error("setUserGitHubCopilotKey: failed to read back the user profile after write");
        return profile;
    }

    async upsertSessionMetricSummary(sessionId: string, updates: SessionMetricSummaryUpsert): Promise<void> {
        return measureDbCall("cms.upsertSessionMetricSummary", async () => {
            await this.pool.query(
                `SELECT ${this.sql.fn.upsertSessionMetricSummary}($1, $2)`,
                [sessionId, JSON.stringify(updates)],
            );
        });
    }

    async pruneDeletedSummaries(olderThan: Date): Promise<number> {
        return measureDbCall("cms.pruneDeletedSummaries", async () => {
            const { rows } = await this.pool.query(
                `SELECT ${this.sql.fn.pruneDeletedSummaries}($1) AS deleted_count`,
                [olderThan],
            );
            return Number(rows[0]?.deleted_count) || 0;
        });
    }

    async getSessionSkillUsage(sessionId: string, opts?: { since?: Date }): Promise<SkillUsageRow[]> {
        return measureDbCall("cms.getSessionSkillUsage", async () => {
            const { rows } = await this.pool.query(
                `SELECT * FROM ${this.sql.fn.getSessionSkillUsage}($1, $2)`,
                [sessionId, opts?.since ?? null],
            );
            return rows.map(rowToSkillUsageRow);
        });
    }

    async getSessionTreeSkillUsage(sessionId: string, opts?: { since?: Date }): Promise<SessionTreeSkillUsage> {
        return measureDbCall("cms.getSessionTreeSkillUsage", async () => {
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
        });
    }

    async getFleetSkillUsage(opts?: { since?: Date; includeDeleted?: boolean }): Promise<FleetSkillUsage> {
        return measureDbCall("cms.getFleetSkillUsage", async () => {
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
        });
    }

    // ── Turn Metrics (Phase 2) ───────────────────────────────

    async insertTurnMetric(input: InsertTurnMetricInput): Promise<void> {
        return measureDbCall("cms.insertTurnMetric", async () => {
            await this.pool.query(
                `SELECT ${this.sql.fn.insertTurnMetric}($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
                [
                    input.sessionId,
                    input.agentId,
                    input.model,
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
        });
    }

    async getSessionTurnMetrics(sessionId: string, opts?: { since?: Date; limit?: number }): Promise<TurnMetricRow[]> {
        return measureDbCall("cms.getSessionTurnMetrics", async () => {
            const { rows } = await this.pool.query(
                `SELECT * FROM ${this.sql.fn.getSessionTurnMetrics}($1, $2, $3)`,
                [sessionId, opts?.since ?? null, opts?.limit ?? 200],
            );
            return rows.map(rowToTurnMetricRow);
        });
    }

    async getFleetTurnAnalytics(opts?: { since?: Date; agentId?: string; model?: string }): Promise<FleetTurnAnalyticsRow[]> {
        return measureDbCall("cms.getFleetTurnAnalytics", async () => {
            const { rows } = await this.pool.query(
                `SELECT * FROM ${this.sql.fn.getFleetTurnAnalytics}($1, $2, $3)`,
                [opts?.since ?? null, opts?.agentId ?? null, opts?.model ?? null],
            );
            return rows.map(rowToFleetTurnAnalyticsRow);
        });
    }

    async getHourlyTokenBuckets(since: Date, opts?: { agentId?: string; model?: string }): Promise<HourlyTokenBucketRow[]> {
        return measureDbCall("cms.getHourlyTokenBuckets", async () => {
            const { rows } = await this.pool.query(
                `SELECT * FROM ${this.sql.fn.getHourlyTokenBuckets}($1, $2, $3)`,
                [since, opts?.agentId ?? null, opts?.model ?? null],
            );
            return rows.map(rowToHourlyTokenBucketRow);
        });
    }

    async pruneTurnMetrics(olderThan: Date): Promise<number> {
        return measureDbCall("cms.pruneTurnMetrics", async () => {
            const { rows } = await this.pool.query(
                `SELECT ${this.sql.fn.pruneTurnMetrics}($1) AS pruned_count`,
                [olderThan],
            );
            return Number(rows[0]?.pruned_count) || 0;
        });
    }

    async upsertDbCallMetricBucketBatch(rows: DbCallMetricBucketInput[]): Promise<number> {
        if (rows.length === 0) return 0;
        return measureDbCall("cms.upsertDbCallMetricBucketBatch", async () => {
            const payload = rows.map(r => ({
                bucket:      r.bucket instanceof Date ? r.bucket.toISOString() : r.bucket,
                process:     r.process,
                processRole: r.processRole,
                method:      r.method,
                calls:       r.calls,
                errors:      r.errors,
                totalMs:     r.totalMs,
            }));
            const { rows: result } = await this.pool.query(
                `SELECT ${this.sql.fn.upsertDbCallMetricBucketBatch}($1) AS row_count`,
                [JSON.stringify(payload)],
            );
            return Number(result[0]?.row_count) || 0;
        });
    }

    async getFleetDbCallMetrics(opts?: { since?: Date }): Promise<FleetDbCallMetricRow[]> {
        return measureDbCall("cms.getFleetDbCallMetrics", async () => {
            const { rows } = await this.pool.query(
                `SELECT * FROM ${this.sql.fn.getFleetDbCallMetrics}($1)`,
                [opts?.since ?? null],
            );
            return rows.map(rowToFleetDbCallMetricRow);
        });
    }

    async getTopEventEmitters(params: { since: Date; limit?: number }): Promise<TopEventEmitterRow[]> {
        return measureDbCall("cms.getTopEventEmitters", async () => {
            const limit = Math.min(100, Math.max(1, params.limit ?? 20));
            const { rows } = await this.pool.query(
                `SELECT * FROM ${this.sql.fn.getTopEventEmitters}($1, $2)`,
                [params.since, limit],
            );
            return rows.map(rowToTopEventEmitterRow);
        });
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
    return {
        sessionId: row.session_id,
        orchestrationId: row.orchestration_id ?? null,
        title: row.title ?? null,
        titleLocked: row.title_locked ?? false,
        state: row.state,
        model: row.model ?? null,
        createdAt: new Date(row.created_at),
        updatedAt: new Date(row.updated_at),
        lastActiveAt: row.last_active_at ? new Date(row.last_active_at) : null,
        deletedAt: row.deleted_at ? new Date(row.deleted_at) : null,
        currentIteration: row.current_iteration ?? 0,
        lastError: row.last_error ?? null,
        waitReason: row.wait_reason ?? null,
        parentSessionId: row.parent_session_id ?? null,
        isSystem: row.is_system ?? false,
        agentId: row.agent_id ?? null,
        splash: row.splash ?? null,
        reasoningEffort: row.reasoning_effort ?? null,
        owner: row.owner_provider && row.owner_subject
            ? {
                provider: row.owner_provider,
                subject: row.owner_subject,
                email: row.owner_email ?? null,
                displayName: row.owner_display_name ?? null,
            }
            : null,
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
        turnCount: Number(row.turn_count) || 0,
        errorCount: Number(row.error_count) || 0,
        toolCallCount: Number(row.tool_call_count) || 0,
        toolErrorCount: Number(row.tool_error_count) || 0,
        totalTurnDurationMs: Number(row.total_turn_duration_ms) || 0,
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

function normalizeOwnerKind(value: unknown): UserStatsOwnerKind {
    return value === "system" || value === "unowned" ? value : "user";
}

function userStatsOwnerKey(ownerKind: UserStatsOwnerKind, owner: SessionOwnerInfo | null): string {
    if (ownerKind !== "user") return ownerKind;
    return `${owner?.provider || ""}${owner?.subject || ""}`;
}

function userStatsOwnerLabel(bucket: { ownerKind: UserStatsOwnerKind; owner: SessionOwnerInfo | null }): string {
    if (bucket.ownerKind === "system") return "system";
    if (bucket.ownerKind === "unowned") return "unowned";
    return String(bucket.owner?.displayName || bucket.owner?.email || bucket.owner?.subject || "user");
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

/** Map a PG row to TurnMetricRow. */
function rowToTurnMetricRow(row: any): TurnMetricRow {
    return {
        id:               Number(row.id),
        sessionId:        row.session_id,
        agentId:          row.agent_id ?? null,
        model:            row.model ?? null,
        turnIndex:        Number(row.turn_index),
        startedAt:        new Date(row.started_at),
        endedAt:          new Date(row.ended_at),
        durationMs:       Number(row.duration_ms) || 0,
        tokensInput:      Number(row.tokens_input) || 0,
        tokensOutput:     Number(row.tokens_output) || 0,
        tokensCacheRead:  Number(row.tokens_cache_read) || 0,
        tokensCacheWrite: Number(row.tokens_cache_write) || 0,
        toolCalls:        Number(row.tool_calls) || 0,
        toolErrors:       Number(row.tool_errors) || 0,
        resultType:       row.result_type ?? null,
        errorMessage:     row.error_message ?? null,
        workerNodeId:     row.worker_node_id ?? null,
        createdAt:        new Date(row.created_at),
    };
}

/** Map a PG row to FleetTurnAnalyticsRow. */
function rowToFleetTurnAnalyticsRow(row: any): FleetTurnAnalyticsRow {
    return {
        agentId:               row.agent_id ?? null,
        model:                 row.model ?? null,
        turnCount:             Number(row.turn_count) || 0,
        errorCount:            Number(row.error_count) || 0,
        toolCallCount:         Number(row.tool_call_count) || 0,
        toolErrorCount:        Number(row.tool_error_count) || 0,
        avgDurationMs:         Number(row.avg_duration_ms) || 0,
        p95DurationMs:         Number(row.p95_duration_ms) || 0,
        p99DurationMs:         Number(row.p99_duration_ms) || 0,
        totalTokensInput:      Number(row.total_tokens_input) || 0,
        totalTokensOutput:     Number(row.total_tokens_output) || 0,
        totalTokensCacheRead:  Number(row.total_tokens_cache_read) || 0,
        totalTokensCacheWrite: Number(row.total_tokens_cache_write) || 0,
    };
}

/** Map a PG row to HourlyTokenBucketRow. */
function rowToHourlyTokenBucketRow(row: any): HourlyTokenBucketRow {
    return {
        hourBucket:            new Date(row.hour_bucket),
        turnCount:             Number(row.turn_count) || 0,
        totalTokensInput:      Number(row.total_tokens_input) || 0,
        totalTokensOutput:     Number(row.total_tokens_output) || 0,
        totalTokensCacheRead:  Number(row.total_tokens_cache_read) || 0,
        totalTokensCacheWrite: Number(row.total_tokens_cache_write) || 0,
    };
}

/** Map a PG row to FleetDbCallMetricRow. */
function rowToFleetDbCallMetricRow(row: any): FleetDbCallMetricRow {
    return {
        method:    String(row.method),
        calls:     Number(row.calls) || 0,
        errors:    Number(row.errors) || 0,
        totalMs:   Number(row.total_ms) || 0,
        avgMs:     Number(row.avg_ms) || 0,
        errorRate: Number(row.error_rate) || 0,
    };
}

/** Map a PG row to TopEventEmitterRow. */
function rowToTopEventEmitterRow(row: any): TopEventEmitterRow {
    return {
        workerNodeId: String(row.worker_node_id),
        eventType:    String(row.event_type),
        eventCount:   Number(row.event_count),
        sessionCount: Number(row.session_count),
        firstSeenAt:  new Date(row.first_seen_at),
        lastSeenAt:   new Date(row.last_seen_at),
    };
}
