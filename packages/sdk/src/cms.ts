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
    lastActiveAt?: Date;
    currentIteration?: number;
    lastError?: string | null;
    waitReason?: string | null;
    isSystem?: boolean;
    agentId?: string | null;
    splash?: string | null;
}

// ─── Session Metric Summary Types ────────────────────────────────

/** Per-session metric summary — one row per session, updated in place. */
export interface SessionMetricSummary {
    sessionId: string;
    agentId: string | null;
    model: string | null;
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
    createSession(sessionId: string, opts?: {
        model?: string;
        parentSessionId?: string;
        isSystem?: boolean;
        agentId?: string;
        splash?: string;
        owner?: SessionOwnerInfo | null;
    }): Promise<void>;

    /** Update one or more fields on an existing session. */
    updateSession(sessionId: string, updates: SessionRowUpdates): Promise<void>;

    /** Soft-delete a session (set deleted_at). */
    softDeleteSession(sessionId: string): Promise<void>;

    // ── Reads (called from client) ───────────────────────────

    /** List all non-deleted sessions, newest first. */
    listSessions(): Promise<SessionRow[]>;

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

    /** Get user/session-owner aggregate stats, optionally filtered. */
    getUserStats(opts?: { includeDeleted?: boolean; since?: Date }): Promise<UserStats>;

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
            listSessions:               `${s}.cms_list_sessions`,
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
            getUserStatsByModel:        `${s}.cms_get_user_stats_by_model`,
            upsertSessionMetricSummary: `${s}.cms_upsert_session_metric_summary`,
            pruneDeletedSummaries:      `${s}.cms_prune_deleted_summaries`,
            getSessionSkillUsage:       `${s}.cms_get_session_skill_usage`,
            getSessionTreeSkillUsage:   `${s}.cms_get_session_tree_skill_usage`,
            getFleetSkillUsage:         `${s}.cms_get_fleet_skill_usage`,
        },
    };
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
    static async create(connectionString: string, schema?: string): Promise<PgSessionCatalogProvider> {
        const { default: pg } = await import("pg");

        // pg v8 treats sslmode=require as verify-full, which rejects Azure/self-signed
        // certs. Strip sslmode from URL and control SSL entirely via config object.
        const parsed = new URL(connectionString);
        const needsSsl = ["require", "prefer", "verify-ca", "verify-full"]
            .includes(parsed.searchParams.get("sslmode") ?? "");
        parsed.searchParams.delete("sslmode");

        const pool = new pg.Pool({
            connectionString: parsed.toString(),
            max: 3,
            ...(needsSsl ? { ssl: { rejectUnauthorized: false } } : {}),
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
        await runCmsMigrations(this.pool, this.sql.schema);
        this.initialized = true;
    }

    // ── Writes ───────────────────────────────────────────────

    async createSession(sessionId: string, opts?: {
        model?: string;
        parentSessionId?: string;
        isSystem?: boolean;
        agentId?: string;
        splash?: string;
        owner?: SessionOwnerInfo | null;
    }): Promise<void> {
        await this.pool.query(
            `SELECT ${this.sql.fn.createSession}($1, $2, $3, $4, $5, $6)`,
            [sessionId, opts?.model ?? null, opts?.parentSessionId ?? null, opts?.isSystem ?? false, opts?.agentId ?? null, opts?.splash ?? null],
        );
        if (opts?.isSystem) return;

        if (opts?.owner?.provider && opts?.owner?.subject) {
            await this.pool.query(
                `SELECT ${this.sql.fn.setSessionOwner}($1, $2, $3, $4, $5)`,
                [
                    sessionId,
                    opts.owner.provider,
                    opts.owner.subject,
                    opts.owner.email ?? null,
                    opts.owner.displayName ?? null,
                ],
            );
            return;
        }

        if (opts?.parentSessionId) {
            await this.pool.query(
                `SELECT ${this.sql.fn.inheritSessionOwner}($1, $2)`,
                [sessionId, opts.parentSessionId],
            );
        }
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

        await this.pool.query(
            `SELECT ${this.sql.fn.updateSession}($1, $2)`,
            [sessionId, JSON.stringify(jsonUpdates)],
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

    // ── Reads ────────────────────────────────────────────────

    async listSessions(): Promise<SessionRow[]> {
        const { rows } = await this.pool.query(
            `SELECT * FROM ${this.sql.fn.listSessions}()`,
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
        owner,
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
