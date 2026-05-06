/**
 * CMS Migration definitions — ordered SQL migrations for the session catalog.
 *
 * Each migration is a function of schema name → SQL string so that the schema
 * placeholder is resolved at runtime (supporting isolated test schemas).
 *
 * @module
 */

import type { MigrationEntry } from "./pg-migrator.js";

/**
 * Return the ordered list of CMS migrations for a given schema.
 * Migrations are idempotent (CREATE IF NOT EXISTS / ADD COLUMN IF NOT EXISTS).
 */
export function CMS_MIGRATIONS(schema: string): MigrationEntry[] {
    const queryPerformanceIndexStatements =
        migration_0008_session_indexes_for_tree_and_event_filters(schema);

    return [
        {
            version: "0001",
            name: "baseline",
            sql: migration_0001_baseline(schema),
        },
        {
            version: "0002",
            name: "session_metric_summaries",
            sql: migration_0002_session_metric_summaries(schema),
        },
        {
            version: "0003",
            name: "session_metric_summaries_backfill_from_events",
            sql: migration_0003_session_metric_summaries_backfill_from_events(schema),
        },
        {
            version: "0004",
            name: "stored_procedures",
            sql: migration_0004_stored_procedures(schema),
        },
        {
            version: "0005",
            name: "skill_usage_procs",
            sql: migration_0005_skill_usage_procs(schema),
        },
        {
            version: "0006",
            name: "fleet_cache_columns",
            sql: migration_0006_fleet_cache_columns(schema),
        },
        {
            version: "0007",
            name: "session_tree_stats_by_model",
            sql: migration_0007_session_tree_stats_by_model(schema),
        },
        {
            version: "0008",
            name: "session_indexes_for_tree_and_event_filters",
            sql: queryPerformanceIndexStatements.join("\n"),
            statements: queryPerformanceIndexStatements,
            transactional: false,
        },
        {
            version: "0009",
            name: "monitoring_columns",
            sql: migration_0009_monitoring_columns(schema),
        },
        {
            version: "0010",
            name: "turn_metrics_and_db_buckets",
            sql: migration_0010_turn_metrics_and_db_buckets(schema),
        },
        {
            version: "0011",
            name: "list_sessions_page",
            sql: migration_0011_list_sessions_page(schema),
        },
        {
            version: "0012",
            name: "sql_read_bounds",
            sql: migration_0012_sql_read_bounds(schema),
        },
        {
            version: "0013",
            name: "top_event_emitters",
            sql: migration_0013_top_event_emitters(schema),
        },
        {
            version: "0014",
            name: "session_owner_users",
            sql: migration_0014_session_owner_users(schema),
        },
        {
            version: "0015",
            name: "user_stats_by_model",
            sql: migration_0015_user_stats_by_model(schema),
        },
        {
            version: "0016",
            name: "user_profile_and_copilot_key",
            sql: migration_0016_user_profile_and_copilot_key(schema),
        },
        {
            version: "0017",
            name: "session_reasoning_effort",
            sql: migration_0017_session_reasoning_effort(schema),
        },
        {
            version: "0018",
            name: "session_reasoning_effort_read_views",
            sql: migration_0018_session_reasoning_effort_read_views(schema),
        },
    ];
}

// ─── Migration 0001: Baseline ────────────────────────────────────

function migration_0001_baseline(schema: string): string {
    const s = `"${schema}"`;
    return `
-- 0001_baseline: captures the CMS schema as of v1.0.41.
-- All statements are idempotent.

CREATE TABLE IF NOT EXISTS ${s}.sessions (
    session_id        TEXT PRIMARY KEY,
    orchestration_id  TEXT,
    title             TEXT,
    title_locked      BOOLEAN NOT NULL DEFAULT FALSE,
    state             TEXT NOT NULL DEFAULT 'pending',
    model             TEXT,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_active_at    TIMESTAMPTZ,
    deleted_at        TIMESTAMPTZ,
    current_iteration INTEGER NOT NULL DEFAULT 0,
    last_error        TEXT,
    parent_session_id TEXT,
    wait_reason       TEXT
);

CREATE TABLE IF NOT EXISTS ${s}.session_events (
    seq            BIGSERIAL PRIMARY KEY,
    session_id     TEXT NOT NULL,
    event_type     TEXT NOT NULL,
    data           JSONB,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_${schema}_sessions_state
    ON ${s}.sessions(state) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_${schema}_sessions_updated
    ON ${s}.sessions(updated_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_${schema}_events_session_seq
    ON ${s}.session_events(session_id, seq);

-- Column migrations (idempotent for existing DBs)
ALTER TABLE ${s}.sessions ADD COLUMN IF NOT EXISTS parent_session_id TEXT;
ALTER TABLE ${s}.sessions ADD COLUMN IF NOT EXISTS is_system BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE ${s}.sessions ADD COLUMN IF NOT EXISTS wait_reason TEXT;
ALTER TABLE ${s}.sessions ADD COLUMN IF NOT EXISTS agent_id TEXT;
ALTER TABLE ${s}.sessions ADD COLUMN IF NOT EXISTS splash TEXT;
ALTER TABLE ${s}.sessions ADD COLUMN IF NOT EXISTS title_locked BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE ${s}.session_events ADD COLUMN IF NOT EXISTS worker_node_id TEXT;
`;
}

// ─── Migration 0002: Session Metric Summaries ────────────────────

function migration_0002_session_metric_summaries(schema: string): string {
    const s = `"${schema}"`;
    return `
-- 0002_session_metric_summaries: per-session metric summary table.

CREATE TABLE IF NOT EXISTS ${s}.session_metric_summaries (
    session_id              TEXT PRIMARY KEY,
    agent_id                TEXT,
    model                   TEXT,
    parent_session_id       TEXT,
    snapshot_size_bytes     BIGINT NOT NULL DEFAULT 0,
    dehydration_count       INTEGER NOT NULL DEFAULT 0,
    hydration_count         INTEGER NOT NULL DEFAULT 0,
    lossy_handoff_count     INTEGER NOT NULL DEFAULT 0,
    last_dehydrated_at      TIMESTAMPTZ,
    last_hydrated_at        TIMESTAMPTZ,
    last_checkpoint_at      TIMESTAMPTZ,
    tokens_input            BIGINT NOT NULL DEFAULT 0,
    tokens_output           BIGINT NOT NULL DEFAULT 0,
    tokens_cache_read       BIGINT NOT NULL DEFAULT 0,
    tokens_cache_write      BIGINT NOT NULL DEFAULT 0,
    deleted_at              TIMESTAMPTZ,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_${schema}_sms_agent_model
    ON ${s}.session_metric_summaries(agent_id, model);
CREATE INDEX IF NOT EXISTS idx_${schema}_sms_parent
    ON ${s}.session_metric_summaries(parent_session_id);
CREATE INDEX IF NOT EXISTS idx_${schema}_sms_updated
    ON ${s}.session_metric_summaries(updated_at DESC);

-- Backfill: create a zeroed summary row for every existing session.
INSERT INTO ${s}.session_metric_summaries (session_id, agent_id, model, parent_session_id, deleted_at)
SELECT session_id, agent_id, model, parent_session_id, deleted_at
FROM ${s}.sessions
ON CONFLICT (session_id) DO NOTHING;
`;
}

function migration_0003_session_metric_summaries_backfill_from_events(schema: string): string {
    const s = `"${schema}"`;
    return `
-- 0003_session_metric_summaries_backfill_from_events: populate summary counters from historical session_events.

WITH event_metrics AS (
    SELECT
        session_id,
        COALESCE(SUM(CASE
            WHEN event_type = 'assistant.usage'
                THEN COALESCE((data->>'inputTokens')::bigint, (data->>'prompt_tokens')::bigint, 0)
            ELSE 0
        END), 0)::bigint AS tokens_input,
        COALESCE(SUM(CASE
            WHEN event_type = 'assistant.usage'
                THEN COALESCE((data->>'outputTokens')::bigint, (data->>'completion_tokens')::bigint, 0)
            ELSE 0
        END), 0)::bigint AS tokens_output,
        COALESCE(SUM(CASE
            WHEN event_type = 'assistant.usage'
                THEN COALESCE((data->>'cacheReadTokens')::bigint, (data->>'cached_prompt_tokens')::bigint, 0)
            ELSE 0
        END), 0)::bigint AS tokens_cache_read,
        COALESCE(SUM(CASE
            WHEN event_type = 'assistant.usage'
                THEN COALESCE((data->>'cacheWriteTokens')::bigint, 0)
            ELSE 0
        END), 0)::bigint AS tokens_cache_write,
        COUNT(*) FILTER (WHERE event_type = 'session.dehydrated')::int AS dehydration_count,
        COUNT(*) FILTER (WHERE event_type = 'session.hydrated')::int AS hydration_count,
        COUNT(*) FILTER (WHERE event_type = 'session.lossy_handoff')::int AS lossy_handoff_count,
        MAX(CASE WHEN event_type = 'session.dehydrated' THEN created_at END) AS last_dehydrated_at,
        MAX(CASE WHEN event_type = 'session.hydrated' THEN created_at END) AS last_hydrated_at
    FROM ${s}.session_events
    GROUP BY session_id
)
UPDATE ${s}.session_metric_summaries sms
SET
    tokens_input = em.tokens_input,
    tokens_output = em.tokens_output,
    tokens_cache_read = em.tokens_cache_read,
    tokens_cache_write = em.tokens_cache_write,
    dehydration_count = em.dehydration_count,
    hydration_count = em.hydration_count,
    lossy_handoff_count = em.lossy_handoff_count,
    last_dehydrated_at = em.last_dehydrated_at,
    last_hydrated_at = em.last_hydrated_at,
    updated_at = now()
FROM event_metrics em
WHERE sms.session_id = em.session_id;
`;
}

// ─── Migration 0004: Stored Procedures ──────────────────────────

function migration_0004_stored_procedures(schema: string): string {
    const s = `"${schema}"`;
    return `
-- 0004_stored_procedures: all CMS data-access moves behind functions.

-- ── cms_create_session ───────────────────────────────────────────
CREATE OR REPLACE FUNCTION ${s}.cms_create_session(
    p_session_id        TEXT,
    p_model             TEXT,
    p_parent_session_id TEXT,
    p_is_system         BOOLEAN,
    p_agent_id          TEXT,
    p_splash            TEXT
) RETURNS VOID AS $$
BEGIN
    INSERT INTO ${s}.sessions
        (session_id, model, parent_session_id, is_system, agent_id, splash)
    VALUES
        (p_session_id, p_model, p_parent_session_id, p_is_system, p_agent_id, p_splash)
    ON CONFLICT (session_id) DO UPDATE
    SET model             = EXCLUDED.model,
        parent_session_id = EXCLUDED.parent_session_id,
        is_system         = EXCLUDED.is_system,
        agent_id          = EXCLUDED.agent_id,
        splash            = EXCLUDED.splash,
        deleted_at        = NULL,
        updated_at        = now(),
        state             = 'pending',
        orchestration_id  = NULL,
        last_error        = NULL,
        last_active_at    = NULL,
        current_iteration = 0,
        wait_reason       = NULL,
        title_locked      = FALSE
    WHERE ${s}.sessions.deleted_at IS NOT NULL;

    -- Seed zeroed metric summary row
    INSERT INTO ${s}.session_metric_summaries
        (session_id, agent_id, model, parent_session_id)
    VALUES
        (p_session_id, p_agent_id, p_model, p_parent_session_id)
    ON CONFLICT (session_id) DO NOTHING;
END;
$$ LANGUAGE plpgsql;

-- ── cms_update_session ───────────────────────────────────────────
CREATE OR REPLACE FUNCTION ${s}.cms_update_session(
    p_session_id TEXT,
    p_updates    JSONB
) RETURNS VOID AS $$
BEGIN
    UPDATE ${s}.sessions SET
        orchestration_id  = CASE WHEN p_updates ? 'orchestrationId'  THEN (p_updates->>'orchestrationId')                         ELSE orchestration_id  END,
        title             = CASE WHEN p_updates ? 'title'            THEN (p_updates->>'title')                                    ELSE title             END,
        title_locked      = CASE WHEN p_updates ? 'titleLocked'     THEN (p_updates->>'titleLocked')::BOOLEAN                     ELSE title_locked      END,
        state             = CASE WHEN p_updates ? 'state'           THEN (p_updates->>'state')                                     ELSE state             END,
        model             = CASE WHEN p_updates ? 'model'           THEN (p_updates->>'model')                                     ELSE model             END,
        last_active_at    = CASE WHEN p_updates ? 'lastActiveAt'    THEN (p_updates->>'lastActiveAt')::TIMESTAMPTZ                 ELSE last_active_at    END,
        current_iteration = CASE WHEN p_updates ? 'currentIteration' THEN (p_updates->>'currentIteration')::INT                   ELSE current_iteration END,
        last_error        = CASE WHEN p_updates ? 'lastError'       THEN (p_updates->>'lastError')                                 ELSE last_error        END,
        wait_reason       = CASE WHEN p_updates ? 'waitReason'      THEN (p_updates->>'waitReason')                                ELSE wait_reason       END,
        is_system         = CASE WHEN p_updates ? 'isSystem'        THEN (p_updates->>'isSystem')::BOOLEAN                         ELSE is_system         END,
        agent_id          = CASE WHEN p_updates ? 'agentId'         THEN (p_updates->>'agentId')                                   ELSE agent_id          END,
        splash            = CASE WHEN p_updates ? 'splash'          THEN (p_updates->>'splash')                                    ELSE splash            END,
        updated_at        = now()
    WHERE session_id = p_session_id;
END;
$$ LANGUAGE plpgsql;

-- ── cms_soft_delete_session ──────────────────────────────────────
CREATE OR REPLACE FUNCTION ${s}.cms_soft_delete_session(
    p_session_id TEXT
) RETURNS VOID AS $$
DECLARE
    v_is_system BOOLEAN;
BEGIN
    SELECT is_system INTO v_is_system
    FROM ${s}.sessions
    WHERE session_id = p_session_id;

    IF v_is_system THEN
        RAISE EXCEPTION 'Cannot delete system session';
    END IF;

    UPDATE ${s}.sessions
    SET deleted_at = now(), updated_at = now()
    WHERE session_id = p_session_id;

    UPDATE ${s}.session_metric_summaries
    SET deleted_at = now(), updated_at = now()
    WHERE session_id = p_session_id;
END;
$$ LANGUAGE plpgsql;

-- ── cms_list_sessions ────────────────────────────────────────────
CREATE OR REPLACE FUNCTION ${s}.cms_list_sessions()
RETURNS SETOF ${s}.sessions AS $$
BEGIN
    RETURN QUERY
    SELECT * FROM ${s}.sessions
    WHERE deleted_at IS NULL
    ORDER BY updated_at DESC;
END;
$$ LANGUAGE plpgsql;

-- ── cms_get_session ──────────────────────────────────────────────
CREATE OR REPLACE FUNCTION ${s}.cms_get_session(
    p_session_id TEXT
) RETURNS SETOF ${s}.sessions AS $$
BEGIN
    RETURN QUERY
    SELECT * FROM ${s}.sessions
    WHERE session_id = p_session_id AND deleted_at IS NULL;
END;
$$ LANGUAGE plpgsql;

-- ── cms_get_descendant_session_ids ───────────────────────────────
CREATE OR REPLACE FUNCTION ${s}.cms_get_descendant_session_ids(
    p_session_id TEXT
) RETURNS TABLE (session_id TEXT) AS $$
BEGIN
    RETURN QUERY
    WITH RECURSIVE descendants AS (
        SELECT s.session_id FROM ${s}.sessions s
        WHERE s.parent_session_id = p_session_id AND s.deleted_at IS NULL
        UNION ALL
        SELECT s.session_id FROM ${s}.sessions s
        INNER JOIN descendants d ON s.parent_session_id = d.session_id
        WHERE s.deleted_at IS NULL
    )
    SELECT d.session_id FROM descendants d;
END;
$$ LANGUAGE plpgsql;

-- ── cms_get_last_session_id ──────────────────────────────────────
CREATE OR REPLACE FUNCTION ${s}.cms_get_last_session_id()
RETURNS TEXT AS $$
DECLARE
    v_session_id TEXT;
BEGIN
    SELECT s.session_id INTO v_session_id
    FROM ${s}.sessions s
    WHERE s.deleted_at IS NULL AND s.is_system = FALSE
    ORDER BY s.last_active_at DESC NULLS LAST
    LIMIT 1;
    RETURN v_session_id;
END;
$$ LANGUAGE plpgsql;

-- ── cms_record_events ────────────────────────────────────────────
CREATE OR REPLACE FUNCTION ${s}.cms_record_events(
    p_session_id     TEXT,
    p_events         JSONB,
    p_worker_node_id TEXT
) RETURNS VOID AS $$
BEGIN
    INSERT INTO ${s}.session_events (session_id, event_type, data, worker_node_id)
    SELECT
        p_session_id,
        (elem->>'eventType'),
        (elem->'data'),
        p_worker_node_id
    FROM jsonb_array_elements(p_events) AS elem;
END;
$$ LANGUAGE plpgsql;

-- ── cms_get_session_events ───────────────────────────────────────
CREATE OR REPLACE FUNCTION ${s}.cms_get_session_events(
    p_session_id TEXT,
    p_after_seq  BIGINT,
    p_limit      INT
) RETURNS SETOF ${s}.session_events AS $$
BEGIN
    IF p_after_seq IS NOT NULL AND p_after_seq > 0 THEN
        RETURN QUERY
        SELECT * FROM ${s}.session_events
        WHERE session_id = p_session_id AND seq > p_after_seq
        ORDER BY seq ASC LIMIT p_limit;
    ELSE
        RETURN QUERY
        SELECT * FROM (
            SELECT * FROM ${s}.session_events
            WHERE session_id = p_session_id
            ORDER BY seq DESC LIMIT p_limit
        ) t ORDER BY seq ASC;
    END IF;
END;
$$ LANGUAGE plpgsql;

-- ── cms_get_session_events_before ────────────────────────────────
CREATE OR REPLACE FUNCTION ${s}.cms_get_session_events_before(
    p_session_id  TEXT,
    p_before_seq  BIGINT,
    p_limit       INT
) RETURNS SETOF ${s}.session_events AS $$
BEGIN
    RETURN QUERY
    SELECT * FROM (
        SELECT * FROM ${s}.session_events
        WHERE session_id = p_session_id AND seq < p_before_seq
        ORDER BY seq DESC LIMIT p_limit
    ) t ORDER BY seq ASC;
END;
$$ LANGUAGE plpgsql;

-- ── cms_get_session_metric_summary ───────────────────────────────
CREATE OR REPLACE FUNCTION ${s}.cms_get_session_metric_summary(
    p_session_id TEXT
) RETURNS SETOF ${s}.session_metric_summaries AS $$
BEGIN
    RETURN QUERY
    SELECT * FROM ${s}.session_metric_summaries
    WHERE session_id = p_session_id;
END;
$$ LANGUAGE plpgsql;

-- ── cms_get_session_tree_stats ───────────────────────────────────
CREATE OR REPLACE FUNCTION ${s}.cms_get_session_tree_stats(
    p_session_id TEXT
) RETURNS TABLE (
    session_count              INT,
    total_tokens_input         BIGINT,
    total_tokens_output        BIGINT,
    total_tokens_cache_read    BIGINT,
    total_tokens_cache_write   BIGINT,
    total_dehydration_count    INT,
    total_hydration_count      INT,
    total_lossy_handoff_count  INT,
    total_snapshot_size_bytes   BIGINT
) AS $$
BEGIN
    RETURN QUERY
    WITH RECURSIVE tree AS (
        SELECT m.session_id FROM ${s}.session_metric_summaries m
        WHERE m.session_id = p_session_id
        UNION ALL
        SELECT m.session_id FROM ${s}.session_metric_summaries m
        INNER JOIN tree t ON m.parent_session_id = t.session_id
    )
    SELECT
        COUNT(*)::int                                    AS session_count,
        COALESCE(SUM(m.tokens_input), 0)::bigint        AS total_tokens_input,
        COALESCE(SUM(m.tokens_output), 0)::bigint       AS total_tokens_output,
        COALESCE(SUM(m.tokens_cache_read), 0)::bigint   AS total_tokens_cache_read,
        COALESCE(SUM(m.tokens_cache_write), 0)::bigint  AS total_tokens_cache_write,
        COALESCE(SUM(m.dehydration_count), 0)::int      AS total_dehydration_count,
        COALESCE(SUM(m.hydration_count), 0)::int        AS total_hydration_count,
        COALESCE(SUM(m.lossy_handoff_count), 0)::int    AS total_lossy_handoff_count,
        COALESCE(SUM(m.snapshot_size_bytes), 0)::bigint AS total_snapshot_size_bytes
    FROM ${s}.session_metric_summaries m
    WHERE m.session_id IN (SELECT tree.session_id FROM tree);
END;
$$ LANGUAGE plpgsql;

-- ── cms_get_fleet_stats_by_agent ─────────────────────────────────
CREATE OR REPLACE FUNCTION ${s}.cms_get_fleet_stats_by_agent(
    p_include_deleted BOOLEAN,
    p_since           TIMESTAMPTZ
) RETURNS TABLE (
    agent_id                    TEXT,
    model                       TEXT,
    session_count               INT,
    total_snapshot_size_bytes    BIGINT,
    total_dehydration_count     INT,
    total_hydration_count       INT,
    total_lossy_handoff_count   INT,
    total_tokens_input          BIGINT,
    total_tokens_output         BIGINT
) AS $$
BEGIN
    RETURN QUERY
    SELECT
        m.agent_id,
        m.model,
        COUNT(*)::int                                          AS session_count,
        COALESCE(SUM(m.snapshot_size_bytes), 0)::bigint        AS total_snapshot_size_bytes,
        COALESCE(SUM(m.dehydration_count), 0)::int             AS total_dehydration_count,
        COALESCE(SUM(m.hydration_count), 0)::int               AS total_hydration_count,
        COALESCE(SUM(m.lossy_handoff_count), 0)::int           AS total_lossy_handoff_count,
        COALESCE(SUM(m.tokens_input), 0)::bigint               AS total_tokens_input,
        COALESCE(SUM(m.tokens_output), 0)::bigint              AS total_tokens_output
    FROM ${s}.session_metric_summaries m
    WHERE (p_include_deleted OR m.deleted_at IS NULL)
      AND (p_since IS NULL OR m.created_at >= p_since)
    GROUP BY m.agent_id, m.model;
END;
$$ LANGUAGE plpgsql;

-- ── cms_get_fleet_stats_totals ───────────────────────────────────
CREATE OR REPLACE FUNCTION ${s}.cms_get_fleet_stats_totals(
    p_include_deleted BOOLEAN,
    p_since           TIMESTAMPTZ
) RETURNS TABLE (
    session_count                INT,
    total_snapshot_size_bytes     BIGINT,
    total_tokens_input           BIGINT,
    total_tokens_output          BIGINT,
    earliest_session_created_at  TIMESTAMPTZ
) AS $$
BEGIN
    RETURN QUERY
    SELECT
        COUNT(*)::int                                          AS session_count,
        COALESCE(SUM(m.snapshot_size_bytes), 0)::bigint        AS total_snapshot_size_bytes,
        COALESCE(SUM(m.tokens_input), 0)::bigint               AS total_tokens_input,
        COALESCE(SUM(m.tokens_output), 0)::bigint              AS total_tokens_output,
        MIN(m.created_at)                                      AS earliest_session_created_at
    FROM ${s}.session_metric_summaries m
    WHERE (p_include_deleted OR m.deleted_at IS NULL)
      AND (p_since IS NULL OR m.created_at >= p_since);
END;
$$ LANGUAGE plpgsql;

-- ── cms_upsert_session_metric_summary ────────────────────────────
CREATE OR REPLACE FUNCTION ${s}.cms_upsert_session_metric_summary(
    p_session_id TEXT,
    p_updates    JSONB
) RETURNS VOID AS $$
DECLARE
    v_snapshot       BIGINT  := COALESCE((p_updates->>'snapshotSizeBytes')::BIGINT, 0);
    v_dehydration    INT     := COALESCE((p_updates->>'dehydrationCountIncrement')::INT, 0);
    v_hydration      INT     := COALESCE((p_updates->>'hydrationCountIncrement')::INT, 0);
    v_lossy          INT     := COALESCE((p_updates->>'lossyHandoffCountIncrement')::INT, 0);
    v_tokens_in      BIGINT  := COALESCE((p_updates->>'tokensInputIncrement')::BIGINT, 0);
    v_tokens_out     BIGINT  := COALESCE((p_updates->>'tokensOutputIncrement')::BIGINT, 0);
    v_tokens_cread   BIGINT  := COALESCE((p_updates->>'tokensCacheReadIncrement')::BIGINT, 0);
    v_tokens_cwrite  BIGINT  := COALESCE((p_updates->>'tokensCacheWriteIncrement')::BIGINT, 0);
    v_set_dehydrated BOOLEAN := COALESCE((p_updates->>'lastDehydratedAt')::BOOLEAN, FALSE);
    v_set_hydrated   BOOLEAN := COALESCE((p_updates->>'lastHydratedAt')::BOOLEAN, FALSE);
    v_set_checkpoint BOOLEAN := COALESCE((p_updates->>'lastCheckpointAt')::BOOLEAN, FALSE);
BEGIN
    INSERT INTO ${s}.session_metric_summaries (
        session_id, snapshot_size_bytes,
        dehydration_count, hydration_count, lossy_handoff_count,
        tokens_input, tokens_output, tokens_cache_read, tokens_cache_write
    ) VALUES (
        p_session_id, v_snapshot,
        v_dehydration, v_hydration, v_lossy,
        v_tokens_in, v_tokens_out, v_tokens_cread, v_tokens_cwrite
    )
    ON CONFLICT (session_id) DO UPDATE SET
        snapshot_size_bytes = CASE
            WHEN p_updates ? 'snapshotSizeBytes'
            THEN v_snapshot
            ELSE ${s}.session_metric_summaries.snapshot_size_bytes
        END,
        dehydration_count   = ${s}.session_metric_summaries.dehydration_count   + v_dehydration,
        hydration_count     = ${s}.session_metric_summaries.hydration_count     + v_hydration,
        lossy_handoff_count = ${s}.session_metric_summaries.lossy_handoff_count + v_lossy,
        tokens_input        = ${s}.session_metric_summaries.tokens_input        + v_tokens_in,
        tokens_output       = ${s}.session_metric_summaries.tokens_output       + v_tokens_out,
        tokens_cache_read   = ${s}.session_metric_summaries.tokens_cache_read   + v_tokens_cread,
        tokens_cache_write  = ${s}.session_metric_summaries.tokens_cache_write  + v_tokens_cwrite,
        last_dehydrated_at  = CASE WHEN v_set_dehydrated THEN now() ELSE ${s}.session_metric_summaries.last_dehydrated_at END,
        last_hydrated_at    = CASE WHEN v_set_hydrated   THEN now() ELSE ${s}.session_metric_summaries.last_hydrated_at   END,
        last_checkpoint_at  = CASE WHEN v_set_checkpoint  THEN now() ELSE ${s}.session_metric_summaries.last_checkpoint_at  END,
        updated_at          = now();
END;
$$ LANGUAGE plpgsql;

-- ── cms_prune_deleted_summaries ──────────────────────────────────
CREATE OR REPLACE FUNCTION ${s}.cms_prune_deleted_summaries(
    p_older_than TIMESTAMPTZ
) RETURNS BIGINT AS $$
DECLARE
    deleted_count BIGINT;
BEGIN
    DELETE FROM ${s}.session_metric_summaries
    WHERE deleted_at IS NOT NULL AND deleted_at < p_older_than;
    GET DIAGNOSTICS deleted_count = ROW_COUNT;
    RETURN deleted_count;
END;
$$ LANGUAGE plpgsql;
`;
}

// ─── Migration 0005: Skill Usage Procs ───────────────────────────

function migration_0005_skill_usage_procs(schema: string): string {
    const s = `"${schema}"`;
    return `
-- 0005_skill_usage_procs: per-session, tree, and fleet skill-usage queries.
-- Two source event types, both rare relative to assistant.delta /
-- tool.execution_*:
--   * 'skill.invoked'      — Copilot SDK fires this when the model expands
--                             a static skill from a plugin's skills/ dir.
--                             Payload: { name, pluginName?, pluginVersion?, ... }
--   * 'learned_skill.read' — emitted by the read_facts tool wrapper when
--                             the call touches the 'skills/' fact namespace.
--                             Payload: { name (key|keyPattern), scope, matchCount, ... }
--
-- Each row carries a 'kind' discriminator so callers can distinguish the
-- two flavors without inspecting event_type. 'name' is the static skill
-- name OR the requested learned-skill key/keyPattern. Plugin metadata is
-- only meaningful for static skills.

-- ── Unified partial index for skill-signal rows ──────────────────
CREATE INDEX IF NOT EXISTS idx_${schema}_events_skill_signals
    ON ${s}.session_events (session_id, created_at DESC)
    WHERE event_type IN ('skill.invoked', 'learned_skill.read');

-- ── cms_get_session_skill_usage ──────────────────────────────────
CREATE OR REPLACE FUNCTION ${s}.cms_get_session_skill_usage(
    p_session_id TEXT,
    p_since      TIMESTAMPTZ
) RETURNS TABLE (
    kind           TEXT,
    name           TEXT,
    plugin_name    TEXT,
    plugin_version TEXT,
    invocations    BIGINT,
    first_used_at  TIMESTAMPTZ,
    last_used_at   TIMESTAMPTZ
) AS $$
BEGIN
    RETURN QUERY
    SELECT
        CASE WHEN e.event_type = 'skill.invoked'
             THEN 'static' ELSE 'learned' END::TEXT    AS kind,
        COALESCE(e.data->>'name', '')::TEXT            AS name,
        NULLIF(e.data->>'pluginName', '')::TEXT        AS plugin_name,
        NULLIF(e.data->>'pluginVersion', '')::TEXT     AS plugin_version,
        COUNT(*)::BIGINT                               AS invocations,
        MIN(e.created_at)                              AS first_used_at,
        MAX(e.created_at)                              AS last_used_at
    FROM ${s}.session_events e
    WHERE e.session_id = p_session_id
      AND e.event_type IN ('skill.invoked', 'learned_skill.read')
      AND (p_since IS NULL OR e.created_at >= p_since)
    GROUP BY 1, 2, 3, 4
    ORDER BY invocations DESC, last_used_at DESC;
END;
$$ LANGUAGE plpgsql;

-- ── cms_get_session_tree_skill_usage ─────────────────────────────
CREATE OR REPLACE FUNCTION ${s}.cms_get_session_tree_skill_usage(
    p_session_id TEXT,
    p_since      TIMESTAMPTZ
) RETURNS TABLE (
    session_id     TEXT,
    agent_id       TEXT,
    kind           TEXT,
    name           TEXT,
    plugin_name    TEXT,
    plugin_version TEXT,
    invocations    BIGINT,
    first_used_at  TIMESTAMPTZ,
    last_used_at   TIMESTAMPTZ
) AS $$
BEGIN
    RETURN QUERY
    WITH RECURSIVE tree AS (
        SELECT s0.session_id, s0.agent_id FROM ${s}.sessions s0 WHERE s0.session_id = p_session_id
        UNION ALL
        SELECT s1.session_id, s1.agent_id FROM ${s}.sessions s1
        INNER JOIN tree t ON s1.parent_session_id = t.session_id
    )
    SELECT
        e.session_id                                   AS session_id,
        t.agent_id                                     AS agent_id,
        CASE WHEN e.event_type = 'skill.invoked'
             THEN 'static' ELSE 'learned' END::TEXT    AS kind,
        COALESCE(e.data->>'name', '')::TEXT            AS name,
        NULLIF(e.data->>'pluginName', '')::TEXT        AS plugin_name,
        NULLIF(e.data->>'pluginVersion', '')::TEXT     AS plugin_version,
        COUNT(*)::BIGINT                               AS invocations,
        MIN(e.created_at)                              AS first_used_at,
        MAX(e.created_at)                              AS last_used_at
    FROM ${s}.session_events e
    INNER JOIN tree t ON e.session_id = t.session_id
    WHERE e.event_type IN ('skill.invoked', 'learned_skill.read')
      AND (p_since IS NULL OR e.created_at >= p_since)
    GROUP BY e.session_id, t.agent_id, kind, name, plugin_name, plugin_version
    ORDER BY e.session_id, invocations DESC;
END;
$$ LANGUAGE plpgsql;

-- ── cms_get_fleet_skill_usage ────────────────────────────────────
-- Joined to the sessions row for agent_id. p_include_deleted controls
-- whether soft-deleted sessions contribute. p_since bounds the scan.
CREATE OR REPLACE FUNCTION ${s}.cms_get_fleet_skill_usage(
    p_since           TIMESTAMPTZ,
    p_include_deleted BOOLEAN
) RETURNS TABLE (
    agent_id       TEXT,
    kind           TEXT,
    name           TEXT,
    plugin_name    TEXT,
    plugin_version TEXT,
    session_count  BIGINT,
    invocations    BIGINT,
    last_used_at   TIMESTAMPTZ
) AS $$
BEGIN
    RETURN QUERY
    SELECT
        s.agent_id                                     AS agent_id,
        CASE WHEN e.event_type = 'skill.invoked'
             THEN 'static' ELSE 'learned' END::TEXT    AS kind,
        COALESCE(e.data->>'name', '')::TEXT            AS name,
        NULLIF(e.data->>'pluginName', '')::TEXT        AS plugin_name,
        NULLIF(e.data->>'pluginVersion', '')::TEXT     AS plugin_version,
        COUNT(DISTINCT e.session_id)::BIGINT           AS session_count,
        COUNT(*)::BIGINT                               AS invocations,
        MAX(e.created_at)                              AS last_used_at
    FROM ${s}.session_events e
    INNER JOIN ${s}.sessions s ON s.session_id = e.session_id
    WHERE e.event_type IN ('skill.invoked', 'learned_skill.read')
      AND (p_include_deleted OR s.deleted_at IS NULL)
      AND (p_since IS NULL OR e.created_at >= p_since)
    GROUP BY s.agent_id, kind, name, plugin_name, plugin_version
    ORDER BY invocations DESC, last_used_at DESC;
END;
$$ LANGUAGE plpgsql;
`;
}

// ─── Migration 0006: Fleet Cache Columns ─────────────────────────

function migration_0006_fleet_cache_columns(schema: string): string {
    const s = `"${schema}"`;
    return `
-- 0006_fleet_cache_columns: surface prompt-cache token counts at the fleet
-- aggregation level. Data is already collected per session in
-- session_metric_summaries.tokens_cache_read / tokens_cache_write; the prior
-- fleet procs simply ignored those columns. This migration adds them to the
-- two fleet read paths.
--
-- PostgreSQL refuses CREATE OR REPLACE FUNCTION when the RETURNS TABLE shape
-- changes. We DROP-then-CREATE for both procs. Idempotent via IF EXISTS.

-- ── cms_get_fleet_stats_by_agent (drop + recreate) ───────────────
DROP FUNCTION IF EXISTS ${s}.cms_get_fleet_stats_by_agent(BOOLEAN, TIMESTAMPTZ);
CREATE FUNCTION ${s}.cms_get_fleet_stats_by_agent(
    p_include_deleted BOOLEAN,
    p_since           TIMESTAMPTZ
) RETURNS TABLE (
    agent_id                    TEXT,
    model                       TEXT,
    session_count               INT,
    total_snapshot_size_bytes    BIGINT,
    total_dehydration_count     INT,
    total_hydration_count       INT,
    total_lossy_handoff_count   INT,
    total_tokens_input          BIGINT,
    total_tokens_output         BIGINT,
    total_tokens_cache_read     BIGINT,
    total_tokens_cache_write    BIGINT
) AS $$
BEGIN
    RETURN QUERY
    SELECT
        m.agent_id,
        m.model,
        COUNT(*)::int                                          AS session_count,
        COALESCE(SUM(m.snapshot_size_bytes), 0)::bigint        AS total_snapshot_size_bytes,
        COALESCE(SUM(m.dehydration_count), 0)::int             AS total_dehydration_count,
        COALESCE(SUM(m.hydration_count), 0)::int               AS total_hydration_count,
        COALESCE(SUM(m.lossy_handoff_count), 0)::int           AS total_lossy_handoff_count,
        COALESCE(SUM(m.tokens_input), 0)::bigint               AS total_tokens_input,
        COALESCE(SUM(m.tokens_output), 0)::bigint              AS total_tokens_output,
        COALESCE(SUM(m.tokens_cache_read), 0)::bigint          AS total_tokens_cache_read,
        COALESCE(SUM(m.tokens_cache_write), 0)::bigint         AS total_tokens_cache_write
    FROM ${s}.session_metric_summaries m
    WHERE (p_include_deleted OR m.deleted_at IS NULL)
      AND (p_since IS NULL OR m.created_at >= p_since)
    GROUP BY m.agent_id, m.model;
END;
$$ LANGUAGE plpgsql;

-- ── cms_get_fleet_stats_totals (drop + recreate) ─────────────────
DROP FUNCTION IF EXISTS ${s}.cms_get_fleet_stats_totals(BOOLEAN, TIMESTAMPTZ);
CREATE FUNCTION ${s}.cms_get_fleet_stats_totals(
    p_include_deleted BOOLEAN,
    p_since           TIMESTAMPTZ
) RETURNS TABLE (
    session_count                INT,
    total_snapshot_size_bytes     BIGINT,
    total_tokens_input           BIGINT,
    total_tokens_output          BIGINT,
    total_tokens_cache_read      BIGINT,
    total_tokens_cache_write     BIGINT,
    earliest_session_created_at  TIMESTAMPTZ
) AS $$
BEGIN
    RETURN QUERY
    SELECT
        COUNT(*)::int                                          AS session_count,
        COALESCE(SUM(m.snapshot_size_bytes), 0)::bigint        AS total_snapshot_size_bytes,
        COALESCE(SUM(m.tokens_input), 0)::bigint               AS total_tokens_input,
        COALESCE(SUM(m.tokens_output), 0)::bigint              AS total_tokens_output,
        COALESCE(SUM(m.tokens_cache_read), 0)::bigint          AS total_tokens_cache_read,
        COALESCE(SUM(m.tokens_cache_write), 0)::bigint         AS total_tokens_cache_write,
        MIN(m.created_at)                                      AS earliest_session_created_at
    FROM ${s}.session_metric_summaries m
    WHERE (p_include_deleted OR m.deleted_at IS NULL)
      AND (p_since IS NULL OR m.created_at >= p_since);
END;
$$ LANGUAGE plpgsql;
`;
}

// ─── Migration 0007: Session-Tree Stats By Model ─────────────────

function migration_0007_session_tree_stats_by_model(schema: string): string {
    const s = `"${schema}"`;
    return `
-- 0007_session_tree_stats_by_model: per-model breakdown across the
-- spawn tree rooted at a session. Mirrors the shape of
-- cms_get_fleet_stats_by_agent so the TUI/portal "By Model" card can
-- render uniformly for both the fleet view and the per-session tree
-- view. Uses the same recursive-descendant CTE pattern as
-- cms_get_session_tree_stats so they stay in sync.

CREATE OR REPLACE FUNCTION ${s}.cms_get_session_tree_stats_by_model(
    p_session_id TEXT
) RETURNS TABLE (
    model                       TEXT,
    session_count               INT,
    total_tokens_input          BIGINT,
    total_tokens_output         BIGINT,
    total_tokens_cache_read     BIGINT,
    total_tokens_cache_write    BIGINT,
    total_snapshot_size_bytes   BIGINT
) AS $$
BEGIN
    RETURN QUERY
    WITH RECURSIVE tree AS (
        SELECT m.session_id FROM ${s}.session_metric_summaries m
        WHERE m.session_id = p_session_id
        UNION ALL
        SELECT m.session_id FROM ${s}.session_metric_summaries m
        INNER JOIN tree t ON m.parent_session_id = t.session_id
    )
    SELECT
        COALESCE(m.model, '(unknown)')                  AS model,
        COUNT(*)::int                                    AS session_count,
        COALESCE(SUM(m.tokens_input), 0)::bigint        AS total_tokens_input,
        COALESCE(SUM(m.tokens_output), 0)::bigint       AS total_tokens_output,
        COALESCE(SUM(m.tokens_cache_read), 0)::bigint   AS total_tokens_cache_read,
        COALESCE(SUM(m.tokens_cache_write), 0)::bigint  AS total_tokens_cache_write,
        COALESCE(SUM(m.snapshot_size_bytes), 0)::bigint AS total_snapshot_size_bytes
    FROM ${s}.session_metric_summaries m
    WHERE m.session_id IN (SELECT tree.session_id FROM tree)
    GROUP BY m.model
    ORDER BY total_tokens_input DESC, model;
END;
$$ LANGUAGE plpgsql;
`;
}

// ─── Migration 0008: Query Performance Indexes ──────────────────

function migration_0008_session_indexes_for_tree_and_event_filters(schema: string): string[] {
    const s = `"${schema}"`;
    return [
        `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_${schema}_sessions_parent
    ON ${s}.sessions(parent_session_id) WHERE deleted_at IS NULL;`,
        `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_${schema}_events_session_type
    ON ${s}.session_events(session_id, event_type);`,
        `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_${schema}_events_worker
    ON ${s}.session_events(worker_node_id) WHERE worker_node_id IS NOT NULL;`,
        `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_${schema}_sessions_active
    ON ${s}.sessions(deleted_at) WHERE deleted_at IS NULL;`,
    ];
}

// ─── Migration 0009: Monitoring Columns ─────────────────────────

function migration_0009_monitoring_columns(schema: string): string {
    const s = `"${schema}"`;
    return `
-- 0009_monitoring_columns: add per-session turn/error/tool counters and
-- surface them in fleet aggregate procs.

-- 1. New columns (idempotent with IF NOT EXISTS)
ALTER TABLE ${s}.session_metric_summaries
    ADD COLUMN IF NOT EXISTS turn_count              INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS error_count             INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS tool_call_count         INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS tool_error_count        INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS total_turn_duration_ms  BIGINT  NOT NULL DEFAULT 0;

-- 2. Extend upsert proc (VOID return — CREATE OR REPLACE is safe)
CREATE OR REPLACE FUNCTION ${s}.cms_upsert_session_metric_summary(
    p_session_id TEXT,
    p_updates    JSONB
) RETURNS VOID AS $$
DECLARE
    v_snapshot       BIGINT  := COALESCE((p_updates->>'snapshotSizeBytes')::BIGINT, 0);
    v_dehydration    INT     := COALESCE((p_updates->>'dehydrationCountIncrement')::INT, 0);
    v_hydration      INT     := COALESCE((p_updates->>'hydrationCountIncrement')::INT, 0);
    v_lossy          INT     := COALESCE((p_updates->>'lossyHandoffCountIncrement')::INT, 0);
    v_tokens_in      BIGINT  := COALESCE((p_updates->>'tokensInputIncrement')::BIGINT, 0);
    v_tokens_out     BIGINT  := COALESCE((p_updates->>'tokensOutputIncrement')::BIGINT, 0);
    v_tokens_cread   BIGINT  := COALESCE((p_updates->>'tokensCacheReadIncrement')::BIGINT, 0);
    v_tokens_cwrite  BIGINT  := COALESCE((p_updates->>'tokensCacheWriteIncrement')::BIGINT, 0);
    v_set_dehydrated BOOLEAN := COALESCE((p_updates->>'lastDehydratedAt')::BOOLEAN, FALSE);
    v_set_hydrated   BOOLEAN := COALESCE((p_updates->>'lastHydratedAt')::BOOLEAN, FALSE);
    v_set_checkpoint BOOLEAN := COALESCE((p_updates->>'lastCheckpointAt')::BOOLEAN, FALSE);
    v_turn_count     INT     := COALESCE((p_updates->>'turnCountIncrement')::INT, 0);
    v_error_count    INT     := COALESCE((p_updates->>'errorCountIncrement')::INT, 0);
    v_tool_calls     INT     := COALESCE((p_updates->>'toolCallCountIncrement')::INT, 0);
    v_tool_errors    INT     := COALESCE((p_updates->>'toolErrorCountIncrement')::INT, 0);
    v_turn_ms        BIGINT  := COALESCE((p_updates->>'totalTurnDurationMsIncrement')::BIGINT, 0);
BEGIN
    INSERT INTO ${s}.session_metric_summaries (
        session_id, snapshot_size_bytes,
        dehydration_count, hydration_count, lossy_handoff_count,
        tokens_input, tokens_output, tokens_cache_read, tokens_cache_write,
        turn_count, error_count, tool_call_count, tool_error_count, total_turn_duration_ms
    ) VALUES (
        p_session_id, v_snapshot,
        v_dehydration, v_hydration, v_lossy,
        v_tokens_in, v_tokens_out, v_tokens_cread, v_tokens_cwrite,
        v_turn_count, v_error_count, v_tool_calls, v_tool_errors, v_turn_ms
    )
    ON CONFLICT (session_id) DO UPDATE SET
        snapshot_size_bytes    = CASE
                                     WHEN p_updates ? 'snapshotSizeBytes'
                                     THEN v_snapshot
                                     ELSE ${s}.session_metric_summaries.snapshot_size_bytes
                                 END,
        dehydration_count      = ${s}.session_metric_summaries.dehydration_count      + v_dehydration,
        hydration_count        = ${s}.session_metric_summaries.hydration_count        + v_hydration,
        lossy_handoff_count    = ${s}.session_metric_summaries.lossy_handoff_count    + v_lossy,
        tokens_input           = ${s}.session_metric_summaries.tokens_input           + v_tokens_in,
        tokens_output          = ${s}.session_metric_summaries.tokens_output          + v_tokens_out,
        tokens_cache_read      = ${s}.session_metric_summaries.tokens_cache_read      + v_tokens_cread,
        tokens_cache_write     = ${s}.session_metric_summaries.tokens_cache_write     + v_tokens_cwrite,
        last_dehydrated_at     = CASE WHEN v_set_dehydrated THEN now() ELSE ${s}.session_metric_summaries.last_dehydrated_at  END,
        last_hydrated_at       = CASE WHEN v_set_hydrated   THEN now() ELSE ${s}.session_metric_summaries.last_hydrated_at    END,
        last_checkpoint_at     = CASE WHEN v_set_checkpoint THEN now() ELSE ${s}.session_metric_summaries.last_checkpoint_at  END,
        turn_count             = ${s}.session_metric_summaries.turn_count             + v_turn_count,
        error_count            = ${s}.session_metric_summaries.error_count            + v_error_count,
        tool_call_count        = ${s}.session_metric_summaries.tool_call_count        + v_tool_calls,
        tool_error_count       = ${s}.session_metric_summaries.tool_error_count       + v_tool_errors,
        total_turn_duration_ms = ${s}.session_metric_summaries.total_turn_duration_ms + v_turn_ms,
        updated_at             = now();
END;
$$ LANGUAGE plpgsql;

-- 3. Fleet stats by agent (DROP + CREATE: RETURNS TABLE shape changes)
DROP FUNCTION IF EXISTS ${s}.cms_get_fleet_stats_by_agent(BOOLEAN, TIMESTAMPTZ);
CREATE FUNCTION ${s}.cms_get_fleet_stats_by_agent(
    p_include_deleted BOOLEAN,
    p_since           TIMESTAMPTZ
) RETURNS TABLE (
    agent_id                   TEXT,
    model                      TEXT,
    session_count              INT,
    total_snapshot_size_bytes  BIGINT,
    total_dehydration_count    INT,
    total_hydration_count      INT,
    total_lossy_handoff_count  INT,
    total_tokens_input         BIGINT,
    total_tokens_output        BIGINT,
    total_tokens_cache_read    BIGINT,
    total_tokens_cache_write   BIGINT,
    total_turn_count           BIGINT,
    total_error_count          BIGINT,
    total_tool_call_count      BIGINT,
    total_tool_error_count     BIGINT,
    total_turn_duration_ms     BIGINT
) AS $$
BEGIN
    RETURN QUERY
    SELECT
        m.agent_id,
        m.model,
        COUNT(*)::int                                           AS session_count,
        COALESCE(SUM(m.snapshot_size_bytes), 0)::bigint         AS total_snapshot_size_bytes,
        COALESCE(SUM(m.dehydration_count), 0)::int              AS total_dehydration_count,
        COALESCE(SUM(m.hydration_count), 0)::int                AS total_hydration_count,
        COALESCE(SUM(m.lossy_handoff_count), 0)::int            AS total_lossy_handoff_count,
        COALESCE(SUM(m.tokens_input), 0)::bigint                AS total_tokens_input,
        COALESCE(SUM(m.tokens_output), 0)::bigint               AS total_tokens_output,
        COALESCE(SUM(m.tokens_cache_read), 0)::bigint           AS total_tokens_cache_read,
        COALESCE(SUM(m.tokens_cache_write), 0)::bigint          AS total_tokens_cache_write,
        COALESCE(SUM(m.turn_count), 0)::bigint                  AS total_turn_count,
        COALESCE(SUM(m.error_count), 0)::bigint                 AS total_error_count,
        COALESCE(SUM(m.tool_call_count), 0)::bigint             AS total_tool_call_count,
        COALESCE(SUM(m.tool_error_count), 0)::bigint            AS total_tool_error_count,
        COALESCE(SUM(m.total_turn_duration_ms), 0)::bigint      AS total_turn_duration_ms
    FROM ${s}.session_metric_summaries m
    WHERE (p_include_deleted OR m.deleted_at IS NULL)
      AND (p_since IS NULL OR m.created_at >= p_since)
    GROUP BY m.agent_id, m.model;
END;
$$ LANGUAGE plpgsql;

-- 4. Fleet stats totals (DROP + CREATE: RETURNS TABLE shape changes)
DROP FUNCTION IF EXISTS ${s}.cms_get_fleet_stats_totals(BOOLEAN, TIMESTAMPTZ);
CREATE FUNCTION ${s}.cms_get_fleet_stats_totals(
    p_include_deleted BOOLEAN,
    p_since           TIMESTAMPTZ
) RETURNS TABLE (
    session_count                INT,
    total_snapshot_size_bytes    BIGINT,
    total_tokens_input           BIGINT,
    total_tokens_output          BIGINT,
    total_tokens_cache_read      BIGINT,
    total_tokens_cache_write     BIGINT,
    earliest_session_created_at  TIMESTAMPTZ,
    total_turn_count             BIGINT,
    total_error_count            BIGINT,
    total_tool_call_count        BIGINT,
    total_tool_error_count       BIGINT,
    total_turn_duration_ms       BIGINT
) AS $$
BEGIN
    RETURN QUERY
    SELECT
        COUNT(*)::int                                           AS session_count,
        COALESCE(SUM(m.snapshot_size_bytes), 0)::bigint         AS total_snapshot_size_bytes,
        COALESCE(SUM(m.tokens_input), 0)::bigint                AS total_tokens_input,
        COALESCE(SUM(m.tokens_output), 0)::bigint               AS total_tokens_output,
        COALESCE(SUM(m.tokens_cache_read), 0)::bigint           AS total_tokens_cache_read,
        COALESCE(SUM(m.tokens_cache_write), 0)::bigint          AS total_tokens_cache_write,
        MIN(m.created_at)                                       AS earliest_session_created_at,
        COALESCE(SUM(m.turn_count), 0)::bigint                  AS total_turn_count,
        COALESCE(SUM(m.error_count), 0)::bigint                 AS total_error_count,
        COALESCE(SUM(m.tool_call_count), 0)::bigint             AS total_tool_call_count,
        COALESCE(SUM(m.tool_error_count), 0)::bigint            AS total_tool_error_count,
        COALESCE(SUM(m.total_turn_duration_ms), 0)::bigint      AS total_turn_duration_ms
    FROM ${s}.session_metric_summaries m
    WHERE (p_include_deleted OR m.deleted_at IS NULL)
      AND (p_since IS NULL OR m.created_at >= p_since);
END;
$$ LANGUAGE plpgsql;
`;
}

// ─── Migration 0010: Turn Metrics + DB Call Buckets ─────────────

function migration_0010_turn_metrics_and_db_buckets(schema: string): string {
    const s = `"${schema}"`;
    return `
-- 0010_turn_metrics_and_db_buckets: per-turn analytics table, hourly token
-- buckets, and per-minute per-process DB call metric buckets.

-- ── 1. session_turn_metrics ──────────────────────────────────────

CREATE TABLE IF NOT EXISTS ${s}.session_turn_metrics (
    id                  BIGSERIAL PRIMARY KEY,
    session_id          TEXT          NOT NULL,
    agent_id            TEXT,
    model               TEXT,
    turn_index          INTEGER       NOT NULL,
    started_at          TIMESTAMPTZ   NOT NULL,
    ended_at            TIMESTAMPTZ   NOT NULL,
    duration_ms         INTEGER       NOT NULL CHECK (duration_ms >= 0),
    tokens_input        BIGINT        NOT NULL DEFAULT 0,
    tokens_output       BIGINT        NOT NULL DEFAULT 0,
    tokens_cache_read   BIGINT        NOT NULL DEFAULT 0,
    tokens_cache_write  BIGINT        NOT NULL DEFAULT 0,
    tool_calls          INTEGER       NOT NULL DEFAULT 0,
    tool_errors         INTEGER       NOT NULL DEFAULT 0,
    result_type         TEXT,
    error_message       TEXT,
    worker_node_id      TEXT,
    created_at          TIMESTAMPTZ   NOT NULL DEFAULT now(),
    CHECK (ended_at >= started_at)
);

CREATE INDEX IF NOT EXISTS idx_${schema}_turn_metrics_session_idx
    ON ${s}.session_turn_metrics(session_id, turn_index DESC);
CREATE INDEX IF NOT EXISTS idx_${schema}_turn_metrics_started
    ON ${s}.session_turn_metrics(started_at DESC);
CREATE INDEX IF NOT EXISTS idx_${schema}_turn_metrics_agent_started
    ON ${s}.session_turn_metrics(agent_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_${schema}_turn_metrics_model_started
    ON ${s}.session_turn_metrics(model, started_at DESC);

-- ── 2. db_call_metric_buckets ────────────────────────────────────

CREATE TABLE IF NOT EXISTS ${s}.db_call_metric_buckets (
    bucket_minute   TIMESTAMPTZ   NOT NULL,
    process_id      TEXT          NOT NULL,
    process_role    TEXT          NOT NULL DEFAULT 'unknown',
    method          TEXT          NOT NULL,
    calls           BIGINT        NOT NULL DEFAULT 0,
    errors          BIGINT        NOT NULL DEFAULT 0,
    total_ms        BIGINT        NOT NULL DEFAULT 0,
    created_at      TIMESTAMPTZ   NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ   NOT NULL DEFAULT now(),
    PRIMARY KEY (bucket_minute, process_id, method)
);

CREATE INDEX IF NOT EXISTS idx_${schema}_db_buckets_minute
    ON ${s}.db_call_metric_buckets(bucket_minute DESC);
CREATE INDEX IF NOT EXISTS idx_${schema}_db_buckets_method_minute
    ON ${s}.db_call_metric_buckets(method, bucket_minute DESC);

-- ── 3. cms_insert_turn_metric ────────────────────────────────────

CREATE OR REPLACE FUNCTION ${s}.cms_insert_turn_metric(
    p_session_id         TEXT,
    p_agent_id           TEXT,
    p_model              TEXT,
    p_turn_index         INTEGER,
    p_started_at         TIMESTAMPTZ,
    p_ended_at           TIMESTAMPTZ,
    p_duration_ms        INTEGER,
    p_tokens_input       BIGINT,
    p_tokens_output      BIGINT,
    p_tokens_cache_read  BIGINT,
    p_tokens_cache_write BIGINT,
    p_tool_calls         INTEGER,
    p_tool_errors        INTEGER,
    p_result_type        TEXT,
    p_error_message      TEXT,
    p_worker_node_id     TEXT
) RETURNS VOID AS $$
BEGIN
    INSERT INTO ${s}.session_turn_metrics (
        session_id, agent_id, model, turn_index,
        started_at, ended_at, duration_ms,
        tokens_input, tokens_output, tokens_cache_read, tokens_cache_write,
        tool_calls, tool_errors, result_type, error_message, worker_node_id
    ) VALUES (
        p_session_id, p_agent_id, p_model, p_turn_index,
        p_started_at, p_ended_at, p_duration_ms,
        p_tokens_input, p_tokens_output, p_tokens_cache_read, p_tokens_cache_write,
        p_tool_calls, p_tool_errors, p_result_type, p_error_message, p_worker_node_id
    );
END;
$$ LANGUAGE plpgsql;

-- ── 4. cms_get_session_turn_metrics ─────────────────────────────

CREATE OR REPLACE FUNCTION ${s}.cms_get_session_turn_metrics(
    p_session_id TEXT,
    p_since      TIMESTAMPTZ DEFAULT NULL,
    p_limit      INT         DEFAULT 200
) RETURNS TABLE (
    id                  BIGINT,
    session_id          TEXT,
    agent_id            TEXT,
    model               TEXT,
    turn_index          INT,
    started_at          TIMESTAMPTZ,
    ended_at            TIMESTAMPTZ,
    duration_ms         INT,
    tokens_input        BIGINT,
    tokens_output       BIGINT,
    tokens_cache_read   BIGINT,
    tokens_cache_write  BIGINT,
    tool_calls          INT,
    tool_errors         INT,
    result_type         TEXT,
    error_message       TEXT,
    worker_node_id      TEXT,
    created_at          TIMESTAMPTZ
) AS $$
BEGIN
    RETURN QUERY
    SELECT
        t.id, t.session_id, t.agent_id, t.model, t.turn_index,
        t.started_at, t.ended_at, t.duration_ms,
        t.tokens_input, t.tokens_output, t.tokens_cache_read, t.tokens_cache_write,
        t.tool_calls, t.tool_errors, t.result_type, t.error_message,
        t.worker_node_id, t.created_at
    FROM ${s}.session_turn_metrics t
    WHERE t.session_id = p_session_id
      AND (p_since IS NULL OR t.started_at >= p_since)
    ORDER BY t.turn_index DESC, t.id DESC
    LIMIT p_limit;
END;
$$ LANGUAGE plpgsql;

-- ── 5. cms_get_fleet_turn_analytics ─────────────────────────────

CREATE OR REPLACE FUNCTION ${s}.cms_get_fleet_turn_analytics(
    p_since    TIMESTAMPTZ DEFAULT NULL,
    p_agent_id TEXT        DEFAULT NULL,
    p_model    TEXT        DEFAULT NULL
) RETURNS TABLE (
    agent_id                 TEXT,
    model                    TEXT,
    turn_count               BIGINT,
    error_count              BIGINT,
    tool_call_count          BIGINT,
    tool_error_count         BIGINT,
    avg_duration_ms          NUMERIC,
    p95_duration_ms          NUMERIC,
    p99_duration_ms          NUMERIC,
    total_tokens_input       BIGINT,
    total_tokens_output      BIGINT,
    total_tokens_cache_read  BIGINT,
    total_tokens_cache_write BIGINT
) AS $$
BEGIN
    RETURN QUERY
    SELECT
        t.agent_id,
        t.model,
        COUNT(*)::bigint                                                     AS turn_count,
        SUM(CASE WHEN t.result_type = 'error' THEN 1 ELSE 0 END)::bigint    AS error_count,
        COALESCE(SUM(t.tool_calls),  0)::bigint                              AS tool_call_count,
        COALESCE(SUM(t.tool_errors), 0)::bigint                              AS tool_error_count,
        ROUND(AVG(t.duration_ms), 2)                                         AS avg_duration_ms,
        PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY t.duration_ms)::numeric AS p95_duration_ms,
        PERCENTILE_CONT(0.99) WITHIN GROUP (ORDER BY t.duration_ms)::numeric AS p99_duration_ms,
        COALESCE(SUM(t.tokens_input),       0)::bigint                       AS total_tokens_input,
        COALESCE(SUM(t.tokens_output),      0)::bigint                       AS total_tokens_output,
        COALESCE(SUM(t.tokens_cache_read),  0)::bigint                       AS total_tokens_cache_read,
        COALESCE(SUM(t.tokens_cache_write), 0)::bigint                       AS total_tokens_cache_write
    FROM ${s}.session_turn_metrics t
    WHERE (p_since    IS NULL OR t.started_at >= p_since)
      AND (p_agent_id IS NULL OR t.agent_id   =  p_agent_id)
      AND (p_model    IS NULL OR t.model      =  p_model)
    GROUP BY t.agent_id, t.model;
END;
$$ LANGUAGE plpgsql;

-- ── 6. cms_get_hourly_token_buckets ─────────────────────────────

CREATE OR REPLACE FUNCTION ${s}.cms_get_hourly_token_buckets(
    p_since    TIMESTAMPTZ,
    p_agent_id TEXT DEFAULT NULL,
    p_model    TEXT DEFAULT NULL
) RETURNS TABLE (
    hour_bucket              TIMESTAMPTZ,
    turn_count               BIGINT,
    total_tokens_input       BIGINT,
    total_tokens_output      BIGINT,
    total_tokens_cache_read  BIGINT,
    total_tokens_cache_write BIGINT
) AS $$
BEGIN
    RETURN QUERY
    SELECT
        date_trunc('hour', t.started_at)                   AS hour_bucket,
        COUNT(*)::bigint                                   AS turn_count,
        COALESCE(SUM(t.tokens_input),       0)::bigint    AS total_tokens_input,
        COALESCE(SUM(t.tokens_output),      0)::bigint    AS total_tokens_output,
        COALESCE(SUM(t.tokens_cache_read),  0)::bigint    AS total_tokens_cache_read,
        COALESCE(SUM(t.tokens_cache_write), 0)::bigint    AS total_tokens_cache_write
    FROM ${s}.session_turn_metrics t
    WHERE t.started_at >= p_since
      AND (p_agent_id IS NULL OR t.agent_id = p_agent_id)
      AND (p_model    IS NULL OR t.model    = p_model)
    GROUP BY date_trunc('hour', t.started_at)
    ORDER BY hour_bucket DESC;
END;
$$ LANGUAGE plpgsql;

-- ── 7. cms_prune_turn_metrics ────────────────────────────────────

CREATE OR REPLACE FUNCTION ${s}.cms_prune_turn_metrics(
    p_older_than TIMESTAMPTZ
) RETURNS INT AS $$
DECLARE
    v_deleted INT;
BEGIN
    DELETE FROM ${s}.session_turn_metrics
    WHERE started_at < p_older_than;
    GET DIAGNOSTICS v_deleted = ROW_COUNT;
    RETURN v_deleted;
END;
$$ LANGUAGE plpgsql;

-- ── 8. cms_upsert_db_call_metric_bucket_batch ────────────────────
-- Expects a JSON array of {bucket, process, processRole, method,
-- calls, errors, totalMs}. Returns the number of rows processed.
-- Invalid rows are skipped; valid rows are still applied.

CREATE OR REPLACE FUNCTION ${s}.cms_upsert_db_call_metric_bucket_batch(
    p_rows JSONB
) RETURNS INT AS $$
DECLARE
    v_row         JSONB;
    v_bucket      TIMESTAMPTZ;
    v_process     TEXT;
    v_process_role TEXT;
    v_method      TEXT;
    v_calls       BIGINT;
    v_errors      BIGINT;
    v_total_ms    BIGINT;
    v_count       INT := 0;
BEGIN
    IF p_rows IS NULL OR jsonb_typeof(p_rows) <> 'array' THEN
        RETURN 0;
    END IF;

    FOR v_row IN SELECT value FROM jsonb_array_elements(p_rows)
    LOOP
        IF jsonb_typeof(v_row) <> 'object' THEN
            CONTINUE;
        END IF;

        IF NULLIF(v_row->>'bucket', '') IS NULL THEN
            CONTINUE;
        END IF;

        v_process := NULLIF(v_row->>'process', '');
        v_method := NULLIF(v_row->>'method', '');
        IF v_process IS NULL OR v_method IS NULL THEN
            CONTINUE;
        END IF;

        v_process_role := COALESCE(NULLIF(v_row->>'processRole', ''), 'unknown');

        BEGIN
            v_bucket := (v_row->>'bucket')::timestamptz;
        EXCEPTION WHEN invalid_text_representation OR datetime_field_overflow THEN
            CONTINUE;
        END;

        v_calls := CASE
            WHEN COALESCE(v_row->>'calls', '') ~ '^[+-]?[0-9]+$' THEN (v_row->>'calls')::bigint
            ELSE 0
        END;
        v_errors := CASE
            WHEN COALESCE(v_row->>'errors', '') ~ '^[+-]?[0-9]+$' THEN (v_row->>'errors')::bigint
            ELSE 0
        END;
        v_total_ms := CASE
            WHEN COALESCE(v_row->>'totalMs', '') ~ '^[+-]?[0-9]+$' THEN (v_row->>'totalMs')::bigint
            ELSE 0
        END;

        INSERT INTO ${s}.db_call_metric_buckets (
            bucket_minute, process_id, process_role, method,
            calls, errors, total_ms
        ) VALUES (
            v_bucket, v_process, v_process_role, v_method,
            v_calls, v_errors, v_total_ms
        )
        ON CONFLICT (bucket_minute, process_id, method) DO UPDATE SET
            calls      = ${s}.db_call_metric_buckets.calls    + EXCLUDED.calls,
            errors     = ${s}.db_call_metric_buckets.errors   + EXCLUDED.errors,
            total_ms   = ${s}.db_call_metric_buckets.total_ms + EXCLUDED.total_ms,
            updated_at = now();
        v_count := v_count + 1;
    END LOOP;
    RETURN v_count;
END;
$$ LANGUAGE plpgsql;

-- ── 9. cms_get_fleet_db_call_metrics ────────────────────────────

CREATE OR REPLACE FUNCTION ${s}.cms_get_fleet_db_call_metrics(
    p_since TIMESTAMPTZ DEFAULT NULL
) RETURNS TABLE (
    method     TEXT,
    calls      BIGINT,
    errors     BIGINT,
    total_ms   BIGINT,
    avg_ms     NUMERIC,
    error_rate NUMERIC
) AS $$
BEGIN
    RETURN QUERY
    SELECT
        b.method,
        SUM(b.calls)::bigint    AS calls,
        SUM(b.errors)::bigint   AS errors,
        SUM(b.total_ms)::bigint AS total_ms,
        CASE WHEN SUM(b.calls) > 0
             THEN ROUND(SUM(b.total_ms)::numeric / SUM(b.calls)::numeric, 2)
             ELSE 0
        END                     AS avg_ms,
        CASE WHEN SUM(b.calls) > 0
             THEN ROUND(SUM(b.errors)::numeric / SUM(b.calls)::numeric, 4)
             ELSE 0
        END                     AS error_rate
    FROM ${s}.db_call_metric_buckets b
    WHERE (p_since IS NULL OR b.bucket_minute >= p_since)
    GROUP BY b.method
    ORDER BY SUM(b.calls) DESC;
END;
$$ LANGUAGE plpgsql;
`;
}

// ─── Migration 0011: List Sessions Page ──────────────────────────

function migration_0011_list_sessions_page(schema: string): string {
    const s = `"${schema}"`;
    return `
-- ── cms_list_sessions_page ────────────────────────────────────────
-- Keyset-paginated session listing ordered by updated_at DESC, session_id DESC.
-- Caller passes limit+1 so TypeScript can detect hasMore without a count query.
-- SQL cap: GREATEST(1, LEAST(COALESCE(p_limit, 51), 201)) — NULL-safe defence-in-depth.
CREATE OR REPLACE FUNCTION ${s}.cms_list_sessions_page(
    p_limit             INT         DEFAULT 51,
    p_cursor_updated_at TIMESTAMPTZ DEFAULT NULL,
    p_cursor_session_id TEXT        DEFAULT NULL,
    p_include_deleted   BOOL        DEFAULT FALSE
) RETURNS SETOF ${s}.sessions AS $$
DECLARE
    v_limit INT := GREATEST(1, LEAST(COALESCE(p_limit, 51), 201));
BEGIN
    RETURN QUERY
    SELECT * FROM ${s}.sessions s
    WHERE
        (p_include_deleted OR s.deleted_at IS NULL)
        AND (
            p_cursor_updated_at IS NULL
            OR s.updated_at < p_cursor_updated_at
            OR (s.updated_at = p_cursor_updated_at AND s.session_id < p_cursor_session_id)
        )
    ORDER BY s.updated_at DESC, s.session_id DESC
    LIMIT v_limit;
END;
$$ LANGUAGE plpgsql;
`;
}

// ─── Migration 0012: SQL Read Bounds ─────────────────────────────

function migration_0012_sql_read_bounds(schema: string): string {
    const s = `"${schema}"`;
    return `
-- Defence-in-depth: enforce server-side read limits on the three high-volume
-- read functions so a bypassed app-layer cap cannot cause runaway transfers.
-- All three use: v_limit := GREATEST(1, LEAST(COALESCE(p_limit, 200), 500))

-- ── 1. cms_get_session_events (bounded) ──────────────────────────
CREATE OR REPLACE FUNCTION ${s}.cms_get_session_events(
    p_session_id TEXT,
    p_after_seq  BIGINT,
    p_limit      INT
) RETURNS SETOF ${s}.session_events AS $$
DECLARE
    v_limit INT := GREATEST(1, LEAST(COALESCE(p_limit, 200), 500));
BEGIN
    IF p_after_seq IS NOT NULL AND p_after_seq > 0 THEN
        RETURN QUERY
        SELECT * FROM ${s}.session_events
        WHERE session_id = p_session_id AND seq > p_after_seq
        ORDER BY seq ASC LIMIT v_limit;
    ELSE
        RETURN QUERY
        SELECT * FROM (
            SELECT * FROM ${s}.session_events
            WHERE session_id = p_session_id
            ORDER BY seq DESC LIMIT v_limit
        ) t ORDER BY seq ASC;
    END IF;
END;
$$ LANGUAGE plpgsql;

-- ── 2. cms_get_session_events_before (bounded) ───────────────────
CREATE OR REPLACE FUNCTION ${s}.cms_get_session_events_before(
    p_session_id  TEXT,
    p_before_seq  BIGINT,
    p_limit       INT
) RETURNS SETOF ${s}.session_events AS $$
DECLARE
    v_limit INT := GREATEST(1, LEAST(COALESCE(p_limit, 200), 500));
BEGIN
    RETURN QUERY
    SELECT * FROM (
        SELECT * FROM ${s}.session_events
        WHERE session_id = p_session_id AND seq < p_before_seq
        ORDER BY seq DESC LIMIT v_limit
    ) t ORDER BY seq ASC;
END;
$$ LANGUAGE plpgsql;

-- ── 3. cms_get_session_turn_metrics (bounded) ────────────────────
CREATE OR REPLACE FUNCTION ${s}.cms_get_session_turn_metrics(
    p_session_id TEXT,
    p_since      TIMESTAMPTZ DEFAULT NULL,
    p_limit      INT         DEFAULT 200
) RETURNS TABLE (
    id                  BIGINT,
    session_id          TEXT,
    agent_id            TEXT,
    model               TEXT,
    turn_index          INT,
    started_at          TIMESTAMPTZ,
    ended_at            TIMESTAMPTZ,
    duration_ms         INT,
    tokens_input        BIGINT,
    tokens_output       BIGINT,
    tokens_cache_read   BIGINT,
    tokens_cache_write  BIGINT,
    tool_calls          INT,
    tool_errors         INT,
    result_type         TEXT,
    error_message       TEXT,
    worker_node_id      TEXT,
    created_at          TIMESTAMPTZ
) AS $$
DECLARE
    v_limit INT := GREATEST(1, LEAST(COALESCE(p_limit, 200), 500));
BEGIN
    RETURN QUERY
    SELECT
        t.id, t.session_id, t.agent_id, t.model, t.turn_index,
        t.started_at, t.ended_at, t.duration_ms,
        t.tokens_input, t.tokens_output, t.tokens_cache_read, t.tokens_cache_write,
        t.tool_calls, t.tool_errors, t.result_type, t.error_message,
        t.worker_node_id, t.created_at
    FROM ${s}.session_turn_metrics t
    WHERE t.session_id = p_session_id
      AND (p_since IS NULL OR t.started_at >= p_since)
    ORDER BY t.turn_index DESC, t.id DESC
    LIMIT v_limit;
END;
$$ LANGUAGE plpgsql;
`;
}

// ─── Migration 0013: Top Event Emitters ──────────────────────────

function migration_0013_top_event_emitters(schema: string): string {
    const s = `"${schema}"`;
    return `
-- 0013_top_event_emitters: diagnostics function to identify noisy event
-- emitters by (worker_node_id, event_type) within a given time window.

CREATE OR REPLACE FUNCTION ${s}.cms_get_top_event_emitters(
    p_since TIMESTAMPTZ,
    p_limit INT
) RETURNS TABLE (
    worker_node_id TEXT,
    event_type     TEXT,
    event_count    BIGINT,
    session_count  BIGINT,
    first_seen_at  TIMESTAMPTZ,
    last_seen_at   TIMESTAMPTZ
) AS $$
DECLARE
    v_limit INT := GREATEST(1, LEAST(COALESCE(p_limit, 20), 100));
BEGIN
    RETURN QUERY
    SELECT
        se.worker_node_id,
        se.event_type,
        COUNT(*)::BIGINT                      AS event_count,
        COUNT(DISTINCT se.session_id)::BIGINT AS session_count,
        MIN(se.created_at)                    AS first_seen_at,
        MAX(se.created_at)                    AS last_seen_at
    FROM ${s}.session_events se
    WHERE se.worker_node_id IS NOT NULL
      AND se.created_at >= COALESCE(p_since, now() - INTERVAL '24 hours')
    GROUP BY se.worker_node_id, se.event_type
    ORDER BY event_count DESC, last_seen_at DESC
    LIMIT v_limit;
END;
$$ LANGUAGE plpgsql;
`;
}

// ─── Migration 0014: Session Owner Users (upstream 0008) ─────────

function migration_0014_session_owner_users(schema: string): string {
    const s = `"${schema}"`;
    return `
CREATE TABLE IF NOT EXISTS ${s}.users (
    user_id      BIGSERIAL PRIMARY KEY,
    provider     TEXT NOT NULL,
    subject      TEXT NOT NULL,
    email        TEXT,
    display_name TEXT,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_${schema}_users_provider_subject
    ON ${s}.users(provider, subject);
CREATE TABLE IF NOT EXISTS ${s}.session_owners (
    session_id  TEXT PRIMARY KEY REFERENCES ${s}.sessions(session_id) ON DELETE CASCADE,
    user_id     BIGINT NOT NULL REFERENCES ${s}.users(user_id),
    assigned_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_${schema}_session_owners_user
    ON ${s}.session_owners(user_id);
CREATE OR REPLACE FUNCTION ${s}.cms_register_user(
    p_provider TEXT, p_subject TEXT, p_email TEXT, p_display_name TEXT
) RETURNS BIGINT AS $$
DECLARE
    v_provider TEXT := NULLIF(BTRIM(p_provider), '');
    v_subject  TEXT := NULLIF(BTRIM(p_subject), '');
    v_user_id  BIGINT;
BEGIN
    IF v_provider IS NULL OR v_subject IS NULL THEN
        RAISE EXCEPTION 'User provider and subject are required';
    END IF;
    INSERT INTO ${s}.users (provider, subject, email, display_name)
    VALUES (v_provider, v_subject, NULLIF(BTRIM(p_email), ''), NULLIF(BTRIM(p_display_name), ''))
    ON CONFLICT (provider, subject) DO NOTHING;
    SELECT user_id INTO v_user_id FROM ${s}.users WHERE provider = v_provider AND subject = v_subject;
    RETURN v_user_id;
END;
$$ LANGUAGE plpgsql;
CREATE OR REPLACE FUNCTION ${s}.cms_set_session_owner(
    p_session_id TEXT, p_provider TEXT, p_subject TEXT, p_email TEXT, p_display_name TEXT
) RETURNS VOID AS $$
DECLARE
    v_user_id   BIGINT;
    v_is_system BOOLEAN;
BEGIN
    SELECT is_system INTO v_is_system FROM ${s}.sessions WHERE session_id = p_session_id AND deleted_at IS NULL;
    IF NOT FOUND OR v_is_system THEN RETURN; END IF;
    v_user_id := ${s}.cms_register_user(p_provider, p_subject, p_email, p_display_name);
    INSERT INTO ${s}.session_owners (session_id, user_id) VALUES (p_session_id, v_user_id) ON CONFLICT (session_id) DO NOTHING;
END;
$$ LANGUAGE plpgsql;
CREATE OR REPLACE FUNCTION ${s}.cms_inherit_session_owner(
    p_session_id TEXT, p_parent_session_id TEXT
) RETURNS VOID AS $$
DECLARE
    v_is_system BOOLEAN;
BEGIN
    SELECT is_system INTO v_is_system FROM ${s}.sessions WHERE session_id = p_session_id AND deleted_at IS NULL;
    IF NOT FOUND OR v_is_system THEN RETURN; END IF;
    INSERT INTO ${s}.session_owners (session_id, user_id)
    SELECT p_session_id, so.user_id FROM ${s}.session_owners so WHERE so.session_id = p_parent_session_id
    ON CONFLICT (session_id) DO NOTHING;
END;
$$ LANGUAGE plpgsql;
`;
}

// ─── Migration 0015: User Stats By Model (upstream 0009) ─────────

function migration_0015_user_stats_by_model(schema: string): string {
    const s = `"${schema}"`;
    return `
CREATE OR REPLACE FUNCTION ${s}.cms_get_user_stats_by_model(
    p_include_deleted BOOLEAN,
    p_since           TIMESTAMPTZ
) RETURNS TABLE (
    owner_kind                  TEXT,
    owner_provider              TEXT,
    owner_subject               TEXT,
    owner_email                 TEXT,
    owner_display_name          TEXT,
    model                       TEXT,
    session_ids                 TEXT[],
    session_count               INT,
    total_snapshot_size_bytes    BIGINT,
    total_dehydration_count     INT,
    total_hydration_count       INT,
    total_lossy_handoff_count   INT,
    total_tokens_input          BIGINT,
    total_tokens_output         BIGINT,
    total_tokens_cache_read     BIGINT,
    total_tokens_cache_write    BIGINT,
    earliest_session_created_at TIMESTAMPTZ
) AS $$
BEGIN
    RETURN QUERY
    WITH base AS (
        SELECT
            CASE WHEN sess.is_system THEN 'system' WHEN u.user_id IS NULL THEN 'unowned' ELSE 'user' END::text AS owner_kind,
            u.provider, u.subject, u.email, u.display_name,
            m.model, m.session_id, m.created_at, m.snapshot_size_bytes,
            m.dehydration_count, m.hydration_count, m.lossy_handoff_count,
            m.tokens_input, m.tokens_output, m.tokens_cache_read, m.tokens_cache_write
        FROM ${s}.session_metric_summaries m
        INNER JOIN ${s}.sessions sess ON sess.session_id = m.session_id
        LEFT JOIN ${s}.session_owners so ON so.session_id = m.session_id
        LEFT JOIN ${s}.users u ON u.user_id = so.user_id
        WHERE (p_include_deleted OR m.deleted_at IS NULL) AND (p_since IS NULL OR m.created_at >= p_since)
    )
    SELECT b.owner_kind, b.provider, b.subject, b.email, b.display_name, b.model,
        ARRAY_AGG(b.session_id ORDER BY b.created_at DESC), COUNT(*)::int,
        COALESCE(SUM(b.snapshot_size_bytes),0)::bigint, COALESCE(SUM(b.dehydration_count),0)::int,
        COALESCE(SUM(b.hydration_count),0)::int, COALESCE(SUM(b.lossy_handoff_count),0)::int,
        COALESCE(SUM(b.tokens_input),0)::bigint, COALESCE(SUM(b.tokens_output),0)::bigint,
        COALESCE(SUM(b.tokens_cache_read),0)::bigint, COALESCE(SUM(b.tokens_cache_write),0)::bigint,
        MIN(b.created_at)
    FROM base b
    GROUP BY b.owner_kind, b.provider, b.subject, b.email, b.display_name, b.model
    ORDER BY COALESCE(SUM(b.tokens_input),0)::bigint DESC, b.owner_kind, b.display_name, b.email, b.model;
END;
$$ LANGUAGE plpgsql;
`;
}

// ─── Migration 0016: User Profile + GitHub Copilot Key (upstream 0010) ──

function migration_0016_user_profile_and_copilot_key(schema: string): string {
    const s = `"${schema}"`;
    return `
ALTER TABLE ${s}.users ADD COLUMN IF NOT EXISTS profile_settings JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE ${s}.users ADD COLUMN IF NOT EXISTS github_copilot_key TEXT;
CREATE OR REPLACE FUNCTION ${s}.cms_get_user_profile(p_provider TEXT, p_subject TEXT)
RETURNS TABLE (user_id BIGINT, provider TEXT, subject TEXT, email TEXT, display_name TEXT,
    profile_settings JSONB, github_copilot_key_set BOOLEAN, created_at TIMESTAMPTZ, updated_at TIMESTAMPTZ) AS $$
DECLARE
    v_provider TEXT := NULLIF(BTRIM(p_provider), '');
    v_subject  TEXT := NULLIF(BTRIM(p_subject),  '');
BEGIN
    IF v_provider IS NULL OR v_subject IS NULL THEN RETURN; END IF;
    RETURN QUERY SELECT u.user_id, u.provider, u.subject, u.email, u.display_name,
        COALESCE(u.profile_settings, '{}'::jsonb), (u.github_copilot_key IS NOT NULL)::boolean,
        u.created_at, u.updated_at
    FROM ${s}.users u WHERE u.provider = v_provider AND u.subject = v_subject;
END;
$$ LANGUAGE plpgsql;
CREATE OR REPLACE FUNCTION ${s}.cms_get_user_github_copilot_key(p_provider TEXT, p_subject TEXT) RETURNS TEXT AS $$
DECLARE
    v_provider TEXT := NULLIF(BTRIM(p_provider), ''); v_subject TEXT := NULLIF(BTRIM(p_subject), ''); v_key TEXT;
BEGIN
    IF v_provider IS NULL OR v_subject IS NULL THEN RETURN NULL; END IF;
    SELECT u.github_copilot_key INTO v_key FROM ${s}.users u WHERE u.provider = v_provider AND u.subject = v_subject;
    RETURN v_key;
END;
$$ LANGUAGE plpgsql;
CREATE OR REPLACE FUNCTION ${s}.cms_set_user_profile_settings(
    p_provider TEXT, p_subject TEXT, p_email TEXT, p_display_name TEXT, p_settings JSONB
) RETURNS BIGINT AS $$
DECLARE v_user_id BIGINT; v_settings JSONB := COALESCE(p_settings, '{}'::jsonb);
BEGIN
    v_user_id := ${s}.cms_register_user(p_provider, p_subject, p_email, p_display_name);
    UPDATE ${s}.users SET profile_settings = v_settings, updated_at = now() WHERE user_id = v_user_id;
    RETURN v_user_id;
END;
$$ LANGUAGE plpgsql;
CREATE OR REPLACE FUNCTION ${s}.cms_set_user_github_copilot_key(
    p_provider TEXT, p_subject TEXT, p_email TEXT, p_display_name TEXT, p_key TEXT
) RETURNS BIGINT AS $$
DECLARE v_user_id BIGINT; v_key TEXT := NULLIF(BTRIM(p_key), '');
BEGIN
    v_user_id := ${s}.cms_register_user(p_provider, p_subject, p_email, p_display_name);
    UPDATE ${s}.users SET github_copilot_key = v_key, updated_at = now() WHERE user_id = v_user_id;
    RETURN v_user_id;
END;
$$ LANGUAGE plpgsql;
`;
}

// ─── Migration 0017: Session Reasoning Effort (upstream 0011) ────

function migration_0017_session_reasoning_effort(schema: string): string {
    const s = `"${schema}"`;
    return `
ALTER TABLE ${s}.sessions ADD COLUMN IF NOT EXISTS reasoning_effort TEXT;
ALTER TABLE ${s}.session_metric_summaries ADD COLUMN IF NOT EXISTS reasoning_effort TEXT;
UPDATE ${s}.session_metric_summaries m SET reasoning_effort = sess.reasoning_effort, updated_at = now()
FROM ${s}.sessions sess WHERE sess.session_id = m.session_id AND m.reasoning_effort IS NULL AND sess.reasoning_effort IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_${schema}_sms_agent_model_reasoning ON ${s}.session_metric_summaries(agent_id, model, reasoning_effort);
`;
}

// ─── Migration 0018: Reasoning Effort Read Views (upstream 0012) ─

function migration_0018_session_reasoning_effort_read_views(schema: string): string {
    const s = `"${schema}"`;
    return `
DROP FUNCTION IF EXISTS ${s}.cms_list_sessions();
CREATE FUNCTION ${s}.cms_list_sessions()
RETURNS TABLE (
    session_id TEXT, orchestration_id TEXT, title TEXT, title_locked BOOLEAN,
    state TEXT, model TEXT, reasoning_effort TEXT,
    created_at TIMESTAMPTZ, updated_at TIMESTAMPTZ, last_active_at TIMESTAMPTZ, deleted_at TIMESTAMPTZ,
    current_iteration INTEGER, last_error TEXT, parent_session_id TEXT, wait_reason TEXT,
    is_system BOOLEAN, agent_id TEXT, splash TEXT,
    owner_provider TEXT, owner_subject TEXT, owner_email TEXT, owner_display_name TEXT
) AS $$
BEGIN
    RETURN QUERY
    SELECT sess.session_id, sess.orchestration_id, sess.title, sess.title_locked, sess.state, sess.model,
        sess.reasoning_effort, sess.created_at, sess.updated_at, sess.last_active_at, sess.deleted_at,
        sess.current_iteration, sess.last_error, sess.parent_session_id, sess.wait_reason,
        sess.is_system, sess.agent_id, sess.splash,
        u.provider, u.subject, u.email, u.display_name
    FROM ${s}.sessions sess
    LEFT JOIN ${s}.session_owners so ON so.session_id = sess.session_id
    LEFT JOIN ${s}.users u ON u.user_id = so.user_id
    WHERE sess.deleted_at IS NULL ORDER BY sess.updated_at DESC;
END;
$$ LANGUAGE plpgsql;

DROP FUNCTION IF EXISTS ${s}.cms_list_sessions_page(INT, TIMESTAMPTZ, TEXT, BOOL);
CREATE FUNCTION ${s}.cms_list_sessions_page(
    p_limit             INT         DEFAULT 51,
    p_cursor_updated_at TIMESTAMPTZ DEFAULT NULL,
    p_cursor_session_id TEXT        DEFAULT NULL,
    p_include_deleted   BOOL        DEFAULT FALSE
) RETURNS TABLE (
    session_id TEXT, orchestration_id TEXT, title TEXT, title_locked BOOLEAN,
    state TEXT, model TEXT, reasoning_effort TEXT,
    created_at TIMESTAMPTZ, updated_at TIMESTAMPTZ, last_active_at TIMESTAMPTZ, deleted_at TIMESTAMPTZ,
    current_iteration INTEGER, last_error TEXT, parent_session_id TEXT, wait_reason TEXT,
    is_system BOOLEAN, agent_id TEXT, splash TEXT,
    owner_provider TEXT, owner_subject TEXT, owner_email TEXT, owner_display_name TEXT
) AS $$
DECLARE
    v_limit INT := GREATEST(1, LEAST(COALESCE(p_limit, 51), 201));
BEGIN
    RETURN QUERY
    SELECT sess.session_id, sess.orchestration_id, sess.title, sess.title_locked, sess.state, sess.model,
        sess.reasoning_effort, sess.created_at, sess.updated_at, sess.last_active_at, sess.deleted_at,
        sess.current_iteration, sess.last_error, sess.parent_session_id, sess.wait_reason,
        sess.is_system, sess.agent_id, sess.splash,
        u.provider, u.subject, u.email, u.display_name
    FROM ${s}.sessions sess
    LEFT JOIN ${s}.session_owners so ON so.session_id = sess.session_id
    LEFT JOIN ${s}.users u ON u.user_id = so.user_id
    WHERE
        (p_include_deleted OR sess.deleted_at IS NULL)
        AND (
            p_cursor_updated_at IS NULL
            OR sess.updated_at < p_cursor_updated_at
            OR (sess.updated_at = p_cursor_updated_at AND sess.session_id < p_cursor_session_id)
        )
    ORDER BY sess.updated_at DESC, sess.session_id DESC
    LIMIT v_limit;
END;
$$ LANGUAGE plpgsql;

DROP FUNCTION IF EXISTS ${s}.cms_get_session(TEXT);
CREATE FUNCTION ${s}.cms_get_session(p_session_id TEXT)
RETURNS TABLE (
    session_id TEXT, orchestration_id TEXT, title TEXT, title_locked BOOLEAN,
    state TEXT, model TEXT, reasoning_effort TEXT,
    created_at TIMESTAMPTZ, updated_at TIMESTAMPTZ, last_active_at TIMESTAMPTZ, deleted_at TIMESTAMPTZ,
    current_iteration INTEGER, last_error TEXT, parent_session_id TEXT, wait_reason TEXT,
    is_system BOOLEAN, agent_id TEXT, splash TEXT,
    owner_provider TEXT, owner_subject TEXT, owner_email TEXT, owner_display_name TEXT
) AS $$
BEGIN
    RETURN QUERY
    SELECT sess.session_id, sess.orchestration_id, sess.title, sess.title_locked, sess.state, sess.model,
        sess.reasoning_effort, sess.created_at, sess.updated_at, sess.last_active_at, sess.deleted_at,
        sess.current_iteration, sess.last_error, sess.parent_session_id, sess.wait_reason,
        sess.is_system, sess.agent_id, sess.splash,
        u.provider, u.subject, u.email, u.display_name
    FROM ${s}.sessions sess
    LEFT JOIN ${s}.session_owners so ON so.session_id = sess.session_id
    LEFT JOIN ${s}.users u ON u.user_id = so.user_id
    WHERE sess.session_id = p_session_id AND sess.deleted_at IS NULL;
END;
$$ LANGUAGE plpgsql;
`;
}
