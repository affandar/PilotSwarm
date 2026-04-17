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
    }>;
    totals: {
        sessionCount: number;
        totalSnapshotSizeBytes: number;
        totalTokensInput: number;
        totalTokensOutput: number;
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
        totalDehydrationCount: number;
        totalHydrationCount: number;
        totalLossyHandoffCount: number;
        totalSnapshotSizeBytes: number;
    };
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
            getFleetStatsByAgent:       `${s}.cms_get_fleet_stats_by_agent`,
            getFleetStatsTotals:        `${s}.cms_get_fleet_stats_totals`,
            upsertSessionMetricSummary: `${s}.cms_upsert_session_metric_summary`,
            pruneDeletedSummaries:      `${s}.cms_prune_deleted_summaries`,
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

    async createSession(sessionId: string, opts?: { model?: string; parentSessionId?: string; isSystem?: boolean; agentId?: string; splash?: string }): Promise<void> {
        await this.pool.query(
            `SELECT ${this.sql.fn.createSession}($1, $2, $3, $4, $5, $6)`,
            [sessionId, opts?.model ?? null, opts?.parentSessionId ?? null, opts?.isSystem ?? false, opts?.agentId ?? null, opts?.splash ?? null],
        );
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

        const { rows } = await this.pool.query(
            `SELECT * FROM ${this.sql.fn.getSessionTreeStats}($1)`,
            [sessionId],
        );

        const r = rows[0];
        return {
            rootSessionId: sessionId,
            self,
            tree: {
                sessionCount: Number(r.session_count) || 0,
                totalTokensInput: Number(r.total_tokens_input) || 0,
                totalTokensOutput: Number(r.total_tokens_output) || 0,
                totalTokensCacheRead: Number(r.total_tokens_cache_read) || 0,
                totalTokensCacheWrite: Number(r.total_tokens_cache_write) || 0,
                totalDehydrationCount: Number(r.total_dehydration_count) || 0,
                totalHydrationCount: Number(r.total_hydration_count) || 0,
                totalLossyHandoffCount: Number(r.total_lossy_handoff_count) || 0,
                totalSnapshotSizeBytes: Number(r.total_snapshot_size_bytes) || 0,
            },
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
        return {
            windowStart: opts?.since ? opts.since.getTime() : null,
            earliestSessionCreatedAt: t.earliest_session_created_at
                ? new Date(t.earliest_session_created_at).getTime()
                : null,
            byAgent: groups.map((g: any) => ({
                agentId: g.agent_id ?? null,
                model: g.model ?? null,
                sessionCount: Number(g.session_count) || 0,
                totalSnapshotSizeBytes: Number(g.total_snapshot_size_bytes) || 0,
                totalDehydrationCount: Number(g.total_dehydration_count) || 0,
                totalHydrationCount: Number(g.total_hydration_count) || 0,
                totalLossyHandoffCount: Number(g.total_lossy_handoff_count) || 0,
                totalTokensInput: Number(g.total_tokens_input) || 0,
                totalTokensOutput: Number(g.total_tokens_output) || 0,
            })),
            totals: {
                sessionCount: Number(t.session_count) || 0,
                totalSnapshotSizeBytes: Number(t.total_snapshot_size_bytes) || 0,
                totalTokensInput: Number(t.total_tokens_input) || 0,
                totalTokensOutput: Number(t.total_tokens_output) || 0,
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
        tokensInput: Number(row.tokens_input) || 0,
        tokensOutput: Number(row.tokens_output) || 0,
        tokensCacheRead: Number(row.tokens_cache_read) || 0,
        tokensCacheWrite: Number(row.tokens_cache_write) || 0,
        deletedAt: row.deleted_at ? new Date(row.deleted_at).getTime() : null,
        createdAt: new Date(row.created_at).getTime(),
        updatedAt: new Date(row.updated_at).getTime(),
    };
}
