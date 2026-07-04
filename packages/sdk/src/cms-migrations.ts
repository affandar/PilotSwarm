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
            name: "session_owner_users",
            sql: migration_0008_session_owner_users(schema),
        },
        {
            version: "0009",
            name: "user_stats_by_model",
            sql: migration_0009_user_stats_by_model(schema),
        },
        {
            version: "0010",
            name: "user_profile_and_copilot_key",
            sql: migration_0010_user_profile_and_copilot_key(schema),
        },
        {
            version: "0011",
            name: "session_reasoning_effort",
            sql: migration_0011_session_reasoning_effort(schema),
        },
        {
            version: "0012",
            name: "session_reasoning_effort_read_views",
            sql: migration_0012_session_reasoning_effort_read_views(schema),
        },
        {
            version: "0013",
            name: "bounded_session_reads_and_emitters",
            sql: migration_0013_bounded_session_reads_and_emitters(schema),
        },
        {
            version: "0014",
            name: "turn_metrics_foundations",
            sql: migration_0014_turn_metrics_foundations(schema),
        },
        {
            version: "0015",
            name: "base_infra_state",
            sql: migration_0015_base_infra_state(schema),
        },
        {
            version: "0016",
            name: "base_infra_state_compat_fixes",
            sql: migration_0016_base_infra_state_compat_fixes(schema),
        },
        {
            version: "0017",
            name: "system_session_restart_archive",
            sql: migration_0017_system_session_restart_archive(schema),
        },
        {
            version: "0018",
            name: "session_group_assignment_update",
            sql: migration_0018_session_group_assignment_update(schema),
        },
        {
            version: "0019",
            name: "session_group_owner_enforcement",
            sql: migration_0019_session_group_owner_enforcement(schema),
        },
        {
            version: "0020",
            name: "session_group_owner_adoption",
            sql: migration_0020_session_group_owner_adoption(schema),
        },
        {
            version: "0021",
            name: "retrieval_usage_procs",
            sql: migration_0021_retrieval_usage_procs(schema),
        },
        {
            version: "0022",
            name: "turn_metrics_reasoning_effort",
            sql: migration_0022_turn_metrics_reasoning_effort(schema),
        },
        {
            version: "0023",
            name: "turn_metrics_stats_fallbacks_and_group_owner_patch",
            sql: migration_0023_turn_metrics_stats_fallbacks_and_group_owner_patch(schema),
        },
        {
            version: "0024",
            name: "stop_turn_active_turn_index",
            sql: migration_0024_stop_turn_active_turn_index(schema),
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

// ─── Migration 0008: Session Owner Users ─────────────────────────

function migration_0008_session_owner_users(schema: string): string {
    const s = `"${schema}"`;
    return `
-- 0008_session_owner_users: lazily catalog authenticated users and link
-- non-system sessions to their first-seen owner. CMS access remains behind
-- stored procedures; callers do not read or mutate these tables directly.

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

-- ── cms_register_user ────────────────────────────────────────────
CREATE OR REPLACE FUNCTION ${s}.cms_register_user(
    p_provider     TEXT,
    p_subject      TEXT,
    p_email        TEXT,
    p_display_name TEXT
) RETURNS BIGINT AS $$
DECLARE
    v_provider TEXT := NULLIF(BTRIM(p_provider), '');
    v_subject  TEXT := NULLIF(BTRIM(p_subject), '');
    v_user_id  BIGINT;
BEGIN
    IF v_provider IS NULL OR v_subject IS NULL THEN
        RAISE EXCEPTION 'User provider and subject are required';
    END IF;

    -- First-seen-write-wins: do not refresh profile fields on later sightings.
    INSERT INTO ${s}.users (provider, subject, email, display_name)
    VALUES (
        v_provider,
        v_subject,
        NULLIF(BTRIM(p_email), ''),
        NULLIF(BTRIM(p_display_name), '')
    )
    ON CONFLICT (provider, subject) DO NOTHING;

    SELECT user_id INTO v_user_id
    FROM ${s}.users
    WHERE provider = v_provider AND subject = v_subject;

    RETURN v_user_id;
END;
$$ LANGUAGE plpgsql;

-- ── cms_set_session_owner ────────────────────────────────────────
CREATE OR REPLACE FUNCTION ${s}.cms_set_session_owner(
    p_session_id    TEXT,
    p_provider      TEXT,
    p_subject       TEXT,
    p_email         TEXT,
    p_display_name  TEXT
) RETURNS VOID AS $$
DECLARE
    v_user_id   BIGINT;
    v_is_system BOOLEAN;
BEGIN
    SELECT is_system INTO v_is_system
    FROM ${s}.sessions
    WHERE session_id = p_session_id AND deleted_at IS NULL;

    IF NOT FOUND OR v_is_system THEN
        RETURN;
    END IF;

    v_user_id := ${s}.cms_register_user(p_provider, p_subject, p_email, p_display_name);

    -- First assignment wins for a session.
    INSERT INTO ${s}.session_owners (session_id, user_id)
    VALUES (p_session_id, v_user_id)
    ON CONFLICT (session_id) DO NOTHING;
END;
$$ LANGUAGE plpgsql;

-- ── cms_inherit_session_owner ────────────────────────────────────
CREATE OR REPLACE FUNCTION ${s}.cms_inherit_session_owner(
    p_session_id        TEXT,
    p_parent_session_id TEXT
) RETURNS VOID AS $$
DECLARE
    v_is_system BOOLEAN;
BEGIN
    SELECT is_system INTO v_is_system
    FROM ${s}.sessions
    WHERE session_id = p_session_id AND deleted_at IS NULL;

    IF NOT FOUND OR v_is_system THEN
        RETURN;
    END IF;

    INSERT INTO ${s}.session_owners (session_id, user_id)
    SELECT p_session_id, so.user_id
    FROM ${s}.session_owners so
    WHERE so.session_id = p_parent_session_id
    ON CONFLICT (session_id) DO NOTHING;
END;
$$ LANGUAGE plpgsql;

-- PostgreSQL refuses CREATE OR REPLACE FUNCTION when the return row shape
-- changes, so the read functions are drop-then-create.

-- ── cms_list_sessions (drop + recreate with owner join) ──────────
DROP FUNCTION IF EXISTS ${s}.cms_list_sessions();
CREATE FUNCTION ${s}.cms_list_sessions()
RETURNS TABLE (
    session_id         TEXT,
    orchestration_id   TEXT,
    title              TEXT,
    title_locked       BOOLEAN,
    state              TEXT,
    model              TEXT,
    created_at         TIMESTAMPTZ,
    updated_at         TIMESTAMPTZ,
    last_active_at     TIMESTAMPTZ,
    deleted_at         TIMESTAMPTZ,
    current_iteration  INTEGER,
    last_error         TEXT,
    parent_session_id  TEXT,
    wait_reason        TEXT,
    is_system          BOOLEAN,
    agent_id           TEXT,
    splash             TEXT,
    owner_provider     TEXT,
    owner_subject      TEXT,
    owner_email        TEXT,
    owner_display_name TEXT
) AS $$
BEGIN
    RETURN QUERY
    SELECT
        sess.session_id,
        sess.orchestration_id,
        sess.title,
        sess.title_locked,
        sess.state,
        sess.model,
        sess.created_at,
        sess.updated_at,
        sess.last_active_at,
        sess.deleted_at,
        sess.current_iteration,
        sess.last_error,
        sess.parent_session_id,
        sess.wait_reason,
        sess.is_system,
        sess.agent_id,
        sess.splash,
        u.provider AS owner_provider,
        u.subject AS owner_subject,
        u.email AS owner_email,
        u.display_name AS owner_display_name
    FROM ${s}.sessions sess
    LEFT JOIN ${s}.session_owners so ON so.session_id = sess.session_id
    LEFT JOIN ${s}.users u ON u.user_id = so.user_id
    WHERE sess.deleted_at IS NULL
    ORDER BY sess.updated_at DESC;
END;
$$ LANGUAGE plpgsql;

-- ── cms_get_session (drop + recreate with owner join) ────────────
DROP FUNCTION IF EXISTS ${s}.cms_get_session(TEXT);
CREATE FUNCTION ${s}.cms_get_session(
    p_session_id TEXT
) RETURNS TABLE (
    session_id         TEXT,
    orchestration_id   TEXT,
    title              TEXT,
    title_locked       BOOLEAN,
    state              TEXT,
    model              TEXT,
    created_at         TIMESTAMPTZ,
    updated_at         TIMESTAMPTZ,
    last_active_at     TIMESTAMPTZ,
    deleted_at         TIMESTAMPTZ,
    current_iteration  INTEGER,
    last_error         TEXT,
    parent_session_id  TEXT,
    wait_reason        TEXT,
    is_system          BOOLEAN,
    agent_id           TEXT,
    splash             TEXT,
    owner_provider     TEXT,
    owner_subject      TEXT,
    owner_email        TEXT,
    owner_display_name TEXT
) AS $$
BEGIN
    RETURN QUERY
    SELECT
        sess.session_id,
        sess.orchestration_id,
        sess.title,
        sess.title_locked,
        sess.state,
        sess.model,
        sess.created_at,
        sess.updated_at,
        sess.last_active_at,
        sess.deleted_at,
        sess.current_iteration,
        sess.last_error,
        sess.parent_session_id,
        sess.wait_reason,
        sess.is_system,
        sess.agent_id,
        sess.splash,
        u.provider AS owner_provider,
        u.subject AS owner_subject,
        u.email AS owner_email,
        u.display_name AS owner_display_name
    FROM ${s}.sessions sess
    LEFT JOIN ${s}.session_owners so ON so.session_id = sess.session_id
    LEFT JOIN ${s}.users u ON u.user_id = so.user_id
    WHERE sess.session_id = p_session_id AND sess.deleted_at IS NULL;
END;
$$ LANGUAGE plpgsql;
`;
}

// ─── Migration 0009: User Stats By Model ─────────────────────────

function migration_0009_user_stats_by_model(schema: string): string {
    const s = `"${schema}"`;
    return `
-- 0009_user_stats_by_model: user/session-owner aggregate for the stats pane.
-- Runtime orchestration history bytes are enriched by management code because
-- they live in the orchestration provider, not in CMS tables.

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
            CASE
                WHEN sess.is_system THEN 'system'
                WHEN u.user_id IS NULL THEN 'unowned'
                ELSE 'user'
            END::text      AS owner_kind,
            u.provider     AS owner_provider,
            u.subject      AS owner_subject,
            u.email        AS owner_email,
            u.display_name AS owner_display_name,
            m.model,
            m.session_id,
            m.created_at,
            m.snapshot_size_bytes,
            m.dehydration_count,
            m.hydration_count,
            m.lossy_handoff_count,
            m.tokens_input,
            m.tokens_output,
            m.tokens_cache_read,
            m.tokens_cache_write
        FROM ${s}.session_metric_summaries m
        INNER JOIN ${s}.sessions sess ON sess.session_id = m.session_id
        LEFT JOIN ${s}.session_owners so ON so.session_id = m.session_id
        LEFT JOIN ${s}.users u ON u.user_id = so.user_id
        WHERE (p_include_deleted OR m.deleted_at IS NULL)
          AND (p_since IS NULL OR m.created_at >= p_since)
    )
    SELECT
        b.owner_kind                                           AS owner_kind,
        b.owner_provider                                       AS owner_provider,
        b.owner_subject                                        AS owner_subject,
        b.owner_email                                          AS owner_email,
        b.owner_display_name                                   AS owner_display_name,
        b.model                                                AS model,
        ARRAY_AGG(b.session_id ORDER BY b.created_at DESC)     AS session_ids,
        COUNT(*)::int                                          AS session_count,
        COALESCE(SUM(b.snapshot_size_bytes), 0)::bigint        AS total_snapshot_size_bytes,
        COALESCE(SUM(b.dehydration_count), 0)::int             AS total_dehydration_count,
        COALESCE(SUM(b.hydration_count), 0)::int               AS total_hydration_count,
        COALESCE(SUM(b.lossy_handoff_count), 0)::int           AS total_lossy_handoff_count,
        COALESCE(SUM(b.tokens_input), 0)::bigint               AS total_tokens_input,
        COALESCE(SUM(b.tokens_output), 0)::bigint              AS total_tokens_output,
        COALESCE(SUM(b.tokens_cache_read), 0)::bigint          AS total_tokens_cache_read,
        COALESCE(SUM(b.tokens_cache_write), 0)::bigint         AS total_tokens_cache_write,
        MIN(b.created_at)                                      AS earliest_session_created_at
    FROM base b
    GROUP BY
        b.owner_kind,
        b.owner_provider,
        b.owner_subject,
        b.owner_email,
        b.owner_display_name,
        b.model
    ORDER BY
        COALESCE(SUM(b.tokens_input), 0)::bigint DESC,
        b.owner_kind,
        b.owner_display_name,
        b.owner_email,
        b.model;
END;
$$ LANGUAGE plpgsql;
`;
}

// ─── Migration 0010: User Profile + GitHub Copilot Key ───────────

function migration_0010_user_profile_and_copilot_key(schema: string): string {
    const s = `"${schema}"`;
    return `
-- 0010_user_profile_and_copilot_key:
--   - profile_settings JSONB on users: per-user UI preferences blob (theme,
--     pinned sessions, layout adjustments, etc.). Replaced wholesale by the
--     setter so the application owns the schema of the JSON document.
--   - github_copilot_key TEXT on users: optional per-user override for the
--     github-copilot model provider token. When set, the worker prefers it
--     over the env-supplied GITHUB_TOKEN for sessions owned by this user.

ALTER TABLE ${s}.users ADD COLUMN IF NOT EXISTS profile_settings JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE ${s}.users ADD COLUMN IF NOT EXISTS github_copilot_key TEXT;

-- ── cms_get_user_profile ─────────────────────────────────────────
-- Public read: returns the user row plus a boolean flag indicating whether
-- a GitHub Copilot key is set. The actual key is intentionally NOT returned
-- here; use cms_get_user_github_copilot_key() from the worker resolver only.
CREATE OR REPLACE FUNCTION ${s}.cms_get_user_profile(
    p_provider TEXT,
    p_subject  TEXT
) RETURNS TABLE (
    user_id                BIGINT,
    provider               TEXT,
    subject                TEXT,
    email                  TEXT,
    display_name           TEXT,
    profile_settings       JSONB,
    github_copilot_key_set BOOLEAN,
    created_at             TIMESTAMPTZ,
    updated_at             TIMESTAMPTZ
) AS $$
DECLARE
    v_provider TEXT := NULLIF(BTRIM(p_provider), '');
    v_subject  TEXT := NULLIF(BTRIM(p_subject),  '');
BEGIN
    IF v_provider IS NULL OR v_subject IS NULL THEN
        RETURN;
    END IF;

    RETURN QUERY
    SELECT
        u.user_id,
        u.provider,
        u.subject,
        u.email,
        u.display_name,
        COALESCE(u.profile_settings, '{}'::jsonb)        AS profile_settings,
        (u.github_copilot_key IS NOT NULL)::boolean      AS github_copilot_key_set,
        u.created_at,
        u.updated_at
    FROM ${s}.users u
    WHERE u.provider = v_provider AND u.subject = v_subject;
END;
$$ LANGUAGE plpgsql;

-- ── cms_get_user_github_copilot_key ──────────────────────────────
-- Internal-only read: returns the raw key text for the worker's per-user
-- token resolver. Never expose this through the public management API.
CREATE OR REPLACE FUNCTION ${s}.cms_get_user_github_copilot_key(
    p_provider TEXT,
    p_subject  TEXT
) RETURNS TEXT AS $$
DECLARE
    v_provider TEXT := NULLIF(BTRIM(p_provider), '');
    v_subject  TEXT := NULLIF(BTRIM(p_subject),  '');
    v_key      TEXT;
BEGIN
    IF v_provider IS NULL OR v_subject IS NULL THEN
        RETURN NULL;
    END IF;

    SELECT u.github_copilot_key INTO v_key
    FROM ${s}.users u
    WHERE u.provider = v_provider AND u.subject = v_subject;

    RETURN v_key;
END;
$$ LANGUAGE plpgsql;

-- ── cms_set_user_profile_settings ────────────────────────────────
-- Creates the user row if it does not yet exist (so settings can be saved
-- before the user has any sessions), then replaces profile_settings with
-- the supplied JSONB document. Pass '{}' to clear all settings.
CREATE OR REPLACE FUNCTION ${s}.cms_set_user_profile_settings(
    p_provider     TEXT,
    p_subject      TEXT,
    p_email        TEXT,
    p_display_name TEXT,
    p_settings     JSONB
) RETURNS BIGINT AS $$
DECLARE
    v_user_id  BIGINT;
    v_settings JSONB := COALESCE(p_settings, '{}'::jsonb);
BEGIN
    v_user_id := ${s}.cms_register_user(p_provider, p_subject, p_email, p_display_name);

    UPDATE ${s}.users
    SET profile_settings = v_settings,
        updated_at       = now()
    WHERE user_id = v_user_id;

    RETURN v_user_id;
END;
$$ LANGUAGE plpgsql;

-- ── cms_set_user_github_copilot_key ──────────────────────────────
-- Creates the user row if missing, then sets or clears the per-user key.
-- A NULL or all-whitespace key clears the override and reverts the user
-- to the worker's env-supplied default token.
CREATE OR REPLACE FUNCTION ${s}.cms_set_user_github_copilot_key(
    p_provider     TEXT,
    p_subject      TEXT,
    p_email        TEXT,
    p_display_name TEXT,
    p_key          TEXT
) RETURNS BIGINT AS $$
DECLARE
    v_user_id BIGINT;
    v_key     TEXT := NULLIF(BTRIM(p_key), '');
BEGIN
    v_user_id := ${s}.cms_register_user(p_provider, p_subject, p_email, p_display_name);

    UPDATE ${s}.users
    SET github_copilot_key = v_key,
        updated_at         = now()
    WHERE user_id = v_user_id;

    RETURN v_user_id;
END;
$$ LANGUAGE plpgsql;
`;
}

// ─── Migration 0011: Session Reasoning Effort ───────────────────

function migration_0011_session_reasoning_effort(schema: string): string {
    const s = `"${schema}"`;
    const modelLabelExpr = `(CASE
            WHEN NULLIF(BTRIM(m.reasoning_effort), '') IS NULL THEN m.model
            WHEN NULLIF(BTRIM(m.model), '') IS NULL THEN '(unknown):' || BTRIM(m.reasoning_effort)
            ELSE m.model || ':' || BTRIM(m.reasoning_effort)
        END)`;
    return `
-- 0011_session_reasoning_effort:
--   - Persist optional per-session reasoning effort alongside the canonical
--     provider:model id.
--   - Keep stats return shapes stable by deriving model classification labels
--     as provider:model:reasoning_effort inside the existing model column.

ALTER TABLE ${s}.sessions ADD COLUMN IF NOT EXISTS reasoning_effort TEXT;
ALTER TABLE ${s}.session_metric_summaries ADD COLUMN IF NOT EXISTS reasoning_effort TEXT;

UPDATE ${s}.session_metric_summaries m
SET reasoning_effort = sess.reasoning_effort,
    updated_at       = now()
FROM ${s}.sessions sess
WHERE sess.session_id = m.session_id
  AND m.reasoning_effort IS NULL
  AND sess.reasoning_effort IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_${schema}_sms_agent_model_reasoning
    ON ${s}.session_metric_summaries(agent_id, model, reasoning_effort);

-- ── cms_create_session ───────────────────────────────────────────
CREATE OR REPLACE FUNCTION ${s}.cms_create_session(
    p_session_id        TEXT,
    p_model             TEXT,
    p_reasoning_effort  TEXT,
    p_parent_session_id TEXT,
    p_is_system         BOOLEAN,
    p_agent_id          TEXT,
    p_splash            TEXT
) RETURNS VOID AS $$
DECLARE
    v_reasoning_effort TEXT := NULLIF(BTRIM(p_reasoning_effort), '');
BEGIN
    INSERT INTO ${s}.sessions
        (session_id, model, reasoning_effort, parent_session_id, is_system, agent_id, splash)
    VALUES
        (p_session_id, p_model, v_reasoning_effort, p_parent_session_id, p_is_system, p_agent_id, p_splash)
    ON CONFLICT (session_id) DO UPDATE
    SET model             = EXCLUDED.model,
        reasoning_effort  = EXCLUDED.reasoning_effort,
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

    INSERT INTO ${s}.session_metric_summaries
        (session_id, agent_id, model, reasoning_effort, parent_session_id)
    VALUES
        (p_session_id, p_agent_id, p_model, v_reasoning_effort, p_parent_session_id)
    ON CONFLICT (session_id) DO UPDATE
    SET agent_id          = COALESCE(${s}.session_metric_summaries.agent_id, EXCLUDED.agent_id),
        model             = COALESCE(${s}.session_metric_summaries.model, EXCLUDED.model),
        reasoning_effort  = COALESCE(${s}.session_metric_summaries.reasoning_effort, EXCLUDED.reasoning_effort),
        parent_session_id = COALESCE(${s}.session_metric_summaries.parent_session_id, EXCLUDED.parent_session_id),
        updated_at        = now();
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
        reasoning_effort  = CASE WHEN p_updates ? 'reasoningEffort' THEN NULLIF(BTRIM(p_updates->>'reasoningEffort'), '')          ELSE reasoning_effort  END,
        last_active_at    = CASE WHEN p_updates ? 'lastActiveAt'    THEN (p_updates->>'lastActiveAt')::TIMESTAMPTZ                 ELSE last_active_at    END,
        current_iteration = CASE WHEN p_updates ? 'currentIteration' THEN (p_updates->>'currentIteration')::INT                   ELSE current_iteration END,
        last_error        = CASE WHEN p_updates ? 'lastError'       THEN (p_updates->>'lastError')                                 ELSE last_error        END,
        wait_reason       = CASE WHEN p_updates ? 'waitReason'      THEN (p_updates->>'waitReason')                                ELSE wait_reason       END,
        is_system         = CASE WHEN p_updates ? 'isSystem'        THEN (p_updates->>'isSystem')::BOOLEAN                         ELSE is_system         END,
        agent_id          = CASE WHEN p_updates ? 'agentId'         THEN (p_updates->>'agentId')                                   ELSE agent_id          END,
        splash            = CASE WHEN p_updates ? 'splash'          THEN (p_updates->>'splash')                                    ELSE splash            END,
        updated_at        = now()
    WHERE session_id = p_session_id;

    UPDATE ${s}.session_metric_summaries
    SET model = CASE WHEN p_updates ? 'model' THEN (p_updates->>'model') ELSE model END,
        reasoning_effort = CASE WHEN p_updates ? 'reasoningEffort' THEN NULLIF(BTRIM(p_updates->>'reasoningEffort'), '') ELSE reasoning_effort END,
        updated_at = CASE WHEN p_updates ? 'model' OR p_updates ? 'reasoningEffort' THEN now() ELSE updated_at END
    WHERE session_id = p_session_id
      AND (p_updates ? 'model' OR p_updates ? 'reasoningEffort');
END;
$$ LANGUAGE plpgsql;

-- ── cms_get_session_tree_stats_by_model ─────────────────────────
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
        COALESCE(${modelLabelExpr}, '(unknown)')          AS model,
        COUNT(*)::int                                    AS session_count,
        COALESCE(SUM(m.tokens_input), 0)::bigint        AS total_tokens_input,
        COALESCE(SUM(m.tokens_output), 0)::bigint       AS total_tokens_output,
        COALESCE(SUM(m.tokens_cache_read), 0)::bigint   AS total_tokens_cache_read,
        COALESCE(SUM(m.tokens_cache_write), 0)::bigint  AS total_tokens_cache_write,
        COALESCE(SUM(m.snapshot_size_bytes), 0)::bigint AS total_snapshot_size_bytes
    FROM ${s}.session_metric_summaries m
    WHERE m.session_id IN (SELECT tree.session_id FROM tree)
    GROUP BY ${modelLabelExpr}
    ORDER BY total_tokens_input DESC, model;
END;
$$ LANGUAGE plpgsql;

-- ── cms_get_fleet_stats_by_agent ────────────────────────────────
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
    total_tokens_output         BIGINT,
    total_tokens_cache_read     BIGINT,
    total_tokens_cache_write    BIGINT
) AS $$
BEGIN
    RETURN QUERY
    SELECT
        m.agent_id,
        ${modelLabelExpr}                                  AS model,
        COUNT(*)::int                                      AS session_count,
        COALESCE(SUM(m.snapshot_size_bytes), 0)::bigint    AS total_snapshot_size_bytes,
        COALESCE(SUM(m.dehydration_count), 0)::int         AS total_dehydration_count,
        COALESCE(SUM(m.hydration_count), 0)::int           AS total_hydration_count,
        COALESCE(SUM(m.lossy_handoff_count), 0)::int       AS total_lossy_handoff_count,
        COALESCE(SUM(m.tokens_input), 0)::bigint           AS total_tokens_input,
        COALESCE(SUM(m.tokens_output), 0)::bigint          AS total_tokens_output,
        COALESCE(SUM(m.tokens_cache_read), 0)::bigint      AS total_tokens_cache_read,
        COALESCE(SUM(m.tokens_cache_write), 0)::bigint     AS total_tokens_cache_write
    FROM ${s}.session_metric_summaries m
    WHERE (p_include_deleted OR m.deleted_at IS NULL)
      AND (p_since IS NULL OR m.created_at >= p_since)
    GROUP BY m.agent_id, ${modelLabelExpr};
END;
$$ LANGUAGE plpgsql;

-- ── cms_get_user_stats_by_model ─────────────────────────────────
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
            CASE
                WHEN sess.is_system THEN 'system'
                WHEN u.user_id IS NULL THEN 'unowned'
                ELSE 'user'
            END::text      AS owner_kind,
            u.provider     AS owner_provider,
            u.subject      AS owner_subject,
            u.email        AS owner_email,
            u.display_name AS owner_display_name,
            ${modelLabelExpr} AS model,
            m.session_id,
            m.created_at,
            m.snapshot_size_bytes,
            m.dehydration_count,
            m.hydration_count,
            m.lossy_handoff_count,
            m.tokens_input,
            m.tokens_output,
            m.tokens_cache_read,
            m.tokens_cache_write
        FROM ${s}.session_metric_summaries m
        INNER JOIN ${s}.sessions sess ON sess.session_id = m.session_id
        LEFT JOIN ${s}.session_owners so ON so.session_id = m.session_id
        LEFT JOIN ${s}.users u ON u.user_id = so.user_id
        WHERE (p_include_deleted OR m.deleted_at IS NULL)
          AND (p_since IS NULL OR m.created_at >= p_since)
    )
    SELECT
        b.owner_kind                                           AS owner_kind,
        b.owner_provider                                       AS owner_provider,
        b.owner_subject                                        AS owner_subject,
        b.owner_email                                          AS owner_email,
        b.owner_display_name                                   AS owner_display_name,
        b.model                                                AS model,
        ARRAY_AGG(b.session_id ORDER BY b.created_at DESC)     AS session_ids,
        COUNT(*)::int                                          AS session_count,
        COALESCE(SUM(b.snapshot_size_bytes), 0)::bigint        AS total_snapshot_size_bytes,
        COALESCE(SUM(b.dehydration_count), 0)::int             AS total_dehydration_count,
        COALESCE(SUM(b.hydration_count), 0)::int               AS total_hydration_count,
        COALESCE(SUM(b.lossy_handoff_count), 0)::int           AS total_lossy_handoff_count,
        COALESCE(SUM(b.tokens_input), 0)::bigint               AS total_tokens_input,
        COALESCE(SUM(b.tokens_output), 0)::bigint              AS total_tokens_output,
        COALESCE(SUM(b.tokens_cache_read), 0)::bigint          AS total_tokens_cache_read,
        COALESCE(SUM(b.tokens_cache_write), 0)::bigint         AS total_tokens_cache_write,
        MIN(b.created_at)                                      AS earliest_session_created_at
    FROM base b
    GROUP BY
        b.owner_kind,
        b.owner_provider,
        b.owner_subject,
        b.owner_email,
        b.owner_display_name,
        b.model
    ORDER BY
        COALESCE(SUM(b.tokens_input), 0)::bigint DESC,
        b.owner_kind,
        b.owner_display_name,
        b.owner_email,
        b.model;
END;
$$ LANGUAGE plpgsql;
`;
}

// ─── Migration 0012: Reasoning Effort Read Views ────────────────

function migration_0012_session_reasoning_effort_read_views(schema: string): string {
    const s = `"${schema}"`;
    return `
-- 0012_session_reasoning_effort_read_views:
--   The reasoning_effort columns were added in 0011. The owner-aware session
--   read procedures from 0008 use explicit RETURNS TABLE shapes, so they must
--   be drop/recreated to expose reasoning_effort to management clients.

DROP FUNCTION IF EXISTS ${s}.cms_list_sessions();
CREATE FUNCTION ${s}.cms_list_sessions()
RETURNS TABLE (
    session_id         TEXT,
    orchestration_id   TEXT,
    title              TEXT,
    title_locked       BOOLEAN,
    state              TEXT,
    model              TEXT,
    reasoning_effort   TEXT,
    created_at         TIMESTAMPTZ,
    updated_at         TIMESTAMPTZ,
    last_active_at     TIMESTAMPTZ,
    deleted_at         TIMESTAMPTZ,
    current_iteration  INTEGER,
    last_error         TEXT,
    parent_session_id  TEXT,
    wait_reason        TEXT,
    is_system          BOOLEAN,
    agent_id           TEXT,
    splash             TEXT,
    owner_provider     TEXT,
    owner_subject      TEXT,
    owner_email        TEXT,
    owner_display_name TEXT
) AS $$
BEGIN
    RETURN QUERY
    SELECT
        sess.session_id,
        sess.orchestration_id,
        sess.title,
        sess.title_locked,
        sess.state,
        sess.model,
        sess.reasoning_effort,
        sess.created_at,
        sess.updated_at,
        sess.last_active_at,
        sess.deleted_at,
        sess.current_iteration,
        sess.last_error,
        sess.parent_session_id,
        sess.wait_reason,
        sess.is_system,
        sess.agent_id,
        sess.splash,
        u.provider AS owner_provider,
        u.subject AS owner_subject,
        u.email AS owner_email,
        u.display_name AS owner_display_name
    FROM ${s}.sessions sess
    LEFT JOIN ${s}.session_owners so ON so.session_id = sess.session_id
    LEFT JOIN ${s}.users u ON u.user_id = so.user_id
    WHERE sess.deleted_at IS NULL
    ORDER BY sess.updated_at DESC;
END;
$$ LANGUAGE plpgsql;

DROP FUNCTION IF EXISTS ${s}.cms_get_session(TEXT);
CREATE FUNCTION ${s}.cms_get_session(
    p_session_id TEXT
) RETURNS TABLE (
    session_id         TEXT,
    orchestration_id   TEXT,
    title              TEXT,
    title_locked       BOOLEAN,
    state              TEXT,
    model              TEXT,
    reasoning_effort   TEXT,
    created_at         TIMESTAMPTZ,
    updated_at         TIMESTAMPTZ,
    last_active_at     TIMESTAMPTZ,
    deleted_at         TIMESTAMPTZ,
    current_iteration  INTEGER,
    last_error         TEXT,
    parent_session_id  TEXT,
    wait_reason        TEXT,
    is_system          BOOLEAN,
    agent_id           TEXT,
    splash             TEXT,
    owner_provider     TEXT,
    owner_subject      TEXT,
    owner_email        TEXT,
    owner_display_name TEXT
) AS $$
BEGIN
    RETURN QUERY
    SELECT
        sess.session_id,
        sess.orchestration_id,
        sess.title,
        sess.title_locked,
        sess.state,
        sess.model,
        sess.reasoning_effort,
        sess.created_at,
        sess.updated_at,
        sess.last_active_at,
        sess.deleted_at,
        sess.current_iteration,
        sess.last_error,
        sess.parent_session_id,
        sess.wait_reason,
        sess.is_system,
        sess.agent_id,
        sess.splash,
        u.provider AS owner_provider,
        u.subject AS owner_subject,
        u.email AS owner_email,
        u.display_name AS owner_display_name
    FROM ${s}.sessions sess
    LEFT JOIN ${s}.session_owners so ON so.session_id = sess.session_id
    LEFT JOIN ${s}.users u ON u.user_id = so.user_id
    WHERE sess.session_id = p_session_id AND sess.deleted_at IS NULL;
END;
$$ LANGUAGE plpgsql;
`;
}

// ─── Migration 0013: Bounded Session Reads And Emitters ──────────

function migration_0013_bounded_session_reads_and_emitters(schema: string): string {
    const s = `"${schema}"`;
    return `
-- 0013_bounded_session_reads_and_emitters:
--   Adds keyset-paginated session listing, bounded event-emitter diagnostics,
--   and SQL-side caps for session event history reads.

-- ── cms_list_sessions_page ───────────────────────────────────────
-- Keyset-paginated session listing ordered by updated_at DESC, session_id DESC.
-- Callers can request limit+1 rows later to compute hasMore without a count query.
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

-- ── cms_get_session_events (bounded) ─────────────────────────────
CREATE OR REPLACE FUNCTION ${s}.cms_get_session_events(
    p_session_id TEXT,
    p_after_seq  BIGINT,
    p_limit      INT
) RETURNS SETOF ${s}.session_events AS $$
DECLARE
    v_limit INT := GREATEST(1, LEAST(COALESCE(p_limit, 1000), 1000));
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

-- ── cms_get_session_events_before (bounded) ──────────────────────
CREATE OR REPLACE FUNCTION ${s}.cms_get_session_events_before(
    p_session_id  TEXT,
    p_before_seq  BIGINT,
    p_limit       INT
) RETURNS SETOF ${s}.session_events AS $$
DECLARE
    v_limit INT := GREATEST(1, LEAST(COALESCE(p_limit, 1000), 1000));
BEGIN
    RETURN QUERY
    SELECT * FROM (
        SELECT * FROM ${s}.session_events
        WHERE session_id = p_session_id AND seq < p_before_seq
        ORDER BY seq DESC LIMIT v_limit
    ) t ORDER BY seq ASC;
END;
$$ LANGUAGE plpgsql;

-- ── cms_get_top_event_emitters ───────────────────────────────────
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

// ─── Migration 0014: Turn Metrics Foundations ───────────────────

function migration_0014_turn_metrics_foundations(schema: string): string {
    const s = `"${schema}"`;
    return `
-- 0014_turn_metrics_foundations:
--   Adds per-turn analytics storage and bounded turn-metrics read functions.

CREATE TABLE IF NOT EXISTS ${s}.session_turn_metrics (
    id                  BIGSERIAL PRIMARY KEY,
    session_id          TEXT        NOT NULL,
    agent_id            TEXT,
    model               TEXT,
    turn_index          INTEGER     NOT NULL,
    started_at          TIMESTAMPTZ NOT NULL,
    ended_at            TIMESTAMPTZ NOT NULL,
    duration_ms         INTEGER     NOT NULL CHECK (duration_ms >= 0),
    tokens_input        BIGINT      NOT NULL DEFAULT 0,
    tokens_output       BIGINT      NOT NULL DEFAULT 0,
    tokens_cache_read   BIGINT      NOT NULL DEFAULT 0,
    tokens_cache_write  BIGINT      NOT NULL DEFAULT 0,
    tool_calls          INTEGER     NOT NULL DEFAULT 0,
    tool_errors         INTEGER     NOT NULL DEFAULT 0,
    result_type         TEXT,
    error_message       TEXT,
    worker_node_id      TEXT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
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
        date_trunc('hour', t.started_at)                AS hour_bucket,
        COUNT(*)::bigint                                AS turn_count,
        COALESCE(SUM(t.tokens_input), 0)::bigint        AS total_tokens_input,
        COALESCE(SUM(t.tokens_output), 0)::bigint       AS total_tokens_output,
        COALESCE(SUM(t.tokens_cache_read), 0)::bigint   AS total_tokens_cache_read,
        COALESCE(SUM(t.tokens_cache_write), 0)::bigint  AS total_tokens_cache_write
    FROM ${s}.session_turn_metrics t
    WHERE t.started_at >= p_since
      AND (p_agent_id IS NULL OR t.agent_id = p_agent_id)
      AND (p_model IS NULL OR t.model = p_model)
    GROUP BY date_trunc('hour', t.started_at)
    ORDER BY hour_bucket DESC;
END;
$$ LANGUAGE plpgsql;

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
`;
}

// ─── Migration 0015: Base Infrastructure State ─────────────────

function migration_0015_base_infra_state(schema: string): string {
    const s = `"${schema}"`;
    return `
-- 0015_base_infra_state:
--   Adds additive state for session groups, live summaries, and child outcomes.

ALTER TABLE ${s}.sessions ADD COLUMN IF NOT EXISTS group_id TEXT;
ALTER TABLE ${s}.sessions ADD COLUMN IF NOT EXISTS short_summary TEXT;
ALTER TABLE ${s}.sessions ADD COLUMN IF NOT EXISTS summary_state JSONB;
ALTER TABLE ${s}.sessions ADD COLUMN IF NOT EXISTS summary_updated_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_${schema}_sessions_group_id
    ON ${s}.sessions(group_id)
    WHERE deleted_at IS NULL AND group_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS ${s}.session_groups (
    group_id    TEXT PRIMARY KEY,
    title       TEXT NOT NULL,
    description TEXT,
    owner       JSONB,
    metadata    JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ${s}.session_child_outcomes (
    child_session_id  TEXT PRIMARY KEY,
    parent_session_id TEXT NOT NULL,
    contract_json     JSONB,
    result_json       JSONB,
    verdict           TEXT,
    summary           TEXT,
    completed_at      TIMESTAMPTZ,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_${schema}_child_outcomes_parent
    ON ${s}.session_child_outcomes(parent_session_id);

-- ── cms_create_session (group-aware overload) ───────────────────
CREATE OR REPLACE FUNCTION ${s}.cms_create_session(
    p_session_id        TEXT,
    p_model             TEXT,
    p_reasoning_effort  TEXT,
    p_parent_session_id TEXT,
    p_is_system         BOOLEAN,
    p_agent_id          TEXT,
    p_splash            TEXT,
    p_group_id          TEXT
) RETURNS VOID AS $$
DECLARE
    v_reasoning_effort TEXT := NULLIF(BTRIM(p_reasoning_effort), '');
    v_group_id TEXT := NULLIF(BTRIM(p_group_id), '');
BEGIN
    IF v_group_id IS NULL AND p_parent_session_id IS NOT NULL THEN
        SELECT group_id INTO v_group_id
        FROM ${s}.sessions
        WHERE session_id = p_parent_session_id;
    END IF;

    INSERT INTO ${s}.sessions
        (session_id, model, reasoning_effort, parent_session_id, is_system, agent_id, splash, group_id)
    VALUES
        (p_session_id, p_model, v_reasoning_effort, p_parent_session_id, p_is_system, p_agent_id, p_splash, v_group_id)
    ON CONFLICT (session_id) DO UPDATE
    SET model             = EXCLUDED.model,
        reasoning_effort  = EXCLUDED.reasoning_effort,
        parent_session_id = EXCLUDED.parent_session_id,
        is_system         = EXCLUDED.is_system,
        agent_id          = EXCLUDED.agent_id,
        splash            = EXCLUDED.splash,
        group_id          = EXCLUDED.group_id,
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

    INSERT INTO ${s}.session_metric_summaries
        (session_id, agent_id, model, reasoning_effort, parent_session_id)
    VALUES
        (p_session_id, p_agent_id, p_model, v_reasoning_effort, p_parent_session_id)
    ON CONFLICT (session_id) DO UPDATE
    SET agent_id          = COALESCE(${s}.session_metric_summaries.agent_id, EXCLUDED.agent_id),
        model             = COALESCE(${s}.session_metric_summaries.model, EXCLUDED.model),
        reasoning_effort  = COALESCE(${s}.session_metric_summaries.reasoning_effort, EXCLUDED.reasoning_effort),
        parent_session_id = COALESCE(${s}.session_metric_summaries.parent_session_id, EXCLUDED.parent_session_id),
        updated_at        = now();
END;
$$ LANGUAGE plpgsql;

-- ── cms_update_session_summary ─────────────────────────────────
CREATE OR REPLACE FUNCTION ${s}.cms_update_session_summary(
    p_session_id     TEXT,
    p_summary_state  JSONB,
    p_short_summary  TEXT DEFAULT NULL
) RETURNS VOID AS $$
DECLARE
    v_short_summary TEXT := NULLIF(BTRIM(p_short_summary), '');
BEGIN
    IF p_summary_state IS NULL OR jsonb_typeof(p_summary_state) <> 'object' THEN
        RAISE EXCEPTION 'summary_state must be a JSON object';
    END IF;

    UPDATE ${s}.sessions
    SET summary_state = p_summary_state,
        short_summary = COALESCE(v_short_summary, NULLIF(BTRIM(p_summary_state->>'summary'), '')),
        summary_updated_at = now(),
        updated_at = now()
    WHERE session_id = p_session_id
      AND deleted_at IS NULL;
END;
$$ LANGUAGE plpgsql;

-- ── owner/reasoning/summary-aware read procedures ───────────────
DROP FUNCTION IF EXISTS ${s}.cms_list_sessions();
CREATE FUNCTION ${s}.cms_list_sessions()
RETURNS TABLE (
    session_id         TEXT,
    orchestration_id   TEXT,
    title              TEXT,
    title_locked       BOOLEAN,
    state              TEXT,
    model              TEXT,
    reasoning_effort   TEXT,
    group_id           TEXT,
    short_summary      TEXT,
    summary_state      JSONB,
    summary_updated_at TIMESTAMPTZ,
    created_at         TIMESTAMPTZ,
    updated_at         TIMESTAMPTZ,
    last_active_at     TIMESTAMPTZ,
    deleted_at         TIMESTAMPTZ,
    current_iteration  INTEGER,
    last_error         TEXT,
    parent_session_id  TEXT,
    wait_reason        TEXT,
    is_system          BOOLEAN,
    agent_id           TEXT,
    splash             TEXT,
    owner_provider     TEXT,
    owner_subject      TEXT,
    owner_email        TEXT,
    owner_display_name TEXT
) AS $$
BEGIN
    RETURN QUERY
    SELECT
        sess.session_id,
        sess.orchestration_id,
        sess.title,
        sess.title_locked,
        sess.state,
        sess.model,
        sess.reasoning_effort,
        sess.group_id,
        sess.short_summary,
        sess.summary_state,
        sess.summary_updated_at,
        sess.created_at,
        sess.updated_at,
        sess.last_active_at,
        sess.deleted_at,
        sess.current_iteration,
        sess.last_error,
        sess.parent_session_id,
        sess.wait_reason,
        sess.is_system,
        sess.agent_id,
        sess.splash,
        u.provider AS owner_provider,
        u.subject AS owner_subject,
        u.email AS owner_email,
        u.display_name AS owner_display_name
    FROM ${s}.sessions sess
    LEFT JOIN ${s}.session_owners so ON so.session_id = sess.session_id
    LEFT JOIN ${s}.users u ON u.user_id = so.user_id
    WHERE sess.deleted_at IS NULL
    ORDER BY COALESCE(sess.summary_updated_at, sess.updated_at) DESC, sess.session_id DESC;
END;
$$ LANGUAGE plpgsql;

DROP FUNCTION IF EXISTS ${s}.cms_get_session(TEXT);
CREATE FUNCTION ${s}.cms_get_session(
    p_session_id TEXT
) RETURNS TABLE (
    session_id         TEXT,
    orchestration_id   TEXT,
    title              TEXT,
    title_locked       BOOLEAN,
    state              TEXT,
    model              TEXT,
    reasoning_effort   TEXT,
    group_id           TEXT,
    short_summary      TEXT,
    summary_state      JSONB,
    summary_updated_at TIMESTAMPTZ,
    created_at         TIMESTAMPTZ,
    updated_at         TIMESTAMPTZ,
    last_active_at     TIMESTAMPTZ,
    deleted_at         TIMESTAMPTZ,
    current_iteration  INTEGER,
    last_error         TEXT,
    parent_session_id  TEXT,
    wait_reason        TEXT,
    is_system          BOOLEAN,
    agent_id           TEXT,
    splash             TEXT,
    owner_provider     TEXT,
    owner_subject      TEXT,
    owner_email        TEXT,
    owner_display_name TEXT
) AS $$
BEGIN
    RETURN QUERY
    SELECT
        sess.session_id,
        sess.orchestration_id,
        sess.title,
        sess.title_locked,
        sess.state,
        sess.model,
        sess.reasoning_effort,
        sess.group_id,
        sess.short_summary,
        sess.summary_state,
        sess.summary_updated_at,
        sess.created_at,
        sess.updated_at,
        sess.last_active_at,
        sess.deleted_at,
        sess.current_iteration,
        sess.last_error,
        sess.parent_session_id,
        sess.wait_reason,
        sess.is_system,
        sess.agent_id,
        sess.splash,
        u.provider AS owner_provider,
        u.subject AS owner_subject,
        u.email AS owner_email,
        u.display_name AS owner_display_name
    FROM ${s}.sessions sess
    LEFT JOIN ${s}.session_owners so ON so.session_id = sess.session_id
    LEFT JOIN ${s}.users u ON u.user_id = so.user_id
    WHERE sess.session_id = p_session_id AND sess.deleted_at IS NULL;
END;
$$ LANGUAGE plpgsql;

-- ── session group procedures ───────────────────────────────────
CREATE OR REPLACE FUNCTION ${s}.cms_create_session_group(
    p_group_id    TEXT,
    p_title       TEXT,
    p_description TEXT DEFAULT NULL,
    p_owner       JSONB DEFAULT NULL,
    p_metadata    JSONB DEFAULT '{}'::jsonb
) RETURNS VOID AS $$
BEGIN
    IF NULLIF(BTRIM(p_group_id), '') IS NULL THEN
        RAISE EXCEPTION 'group_id is required';
    END IF;
    IF NULLIF(BTRIM(p_title), '') IS NULL THEN
        RAISE EXCEPTION 'title is required';
    END IF;

    INSERT INTO ${s}.session_groups (group_id, title, description, owner, metadata)
    VALUES (p_group_id, BTRIM(p_title), p_description, p_owner, COALESCE(p_metadata, '{}'::jsonb))
    ON CONFLICT (group_id) DO NOTHING;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION ${s}.cms_update_session_group(
    p_group_id TEXT,
    p_patch    JSONB
) RETURNS VOID AS $$
BEGIN
    UPDATE ${s}.session_groups
    SET title = CASE WHEN p_patch ? 'title' THEN NULLIF(BTRIM(p_patch->>'title'), '') ELSE title END,
        description = CASE WHEN p_patch ? 'description' THEN p_patch->>'description' ELSE description END,
        metadata = CASE WHEN p_patch ? 'metadataPatch' THEN metadata || COALESCE(p_patch->'metadataPatch', '{}'::jsonb) ELSE metadata END,
        updated_at = now()
    WHERE group_id = p_group_id;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION ${s}.cms_list_session_groups()
RETURNS TABLE (
    group_id                  TEXT,
    title                     TEXT,
    description               TEXT,
    owner                     JSONB,
    metadata                  JSONB,
    member_count              INT,
    running_count             INT,
    waiting_count             INT,
    completed_count           INT,
    failed_count              INT,
    cancelled_count           INT,
    latest_activity_at        TIMESTAMPTZ,
    latest_summary_updated_at TIMESTAMPTZ,
    created_at                TIMESTAMPTZ,
    updated_at                TIMESTAMPTZ
) AS $$
BEGIN
    RETURN QUERY
    SELECT
        g.group_id,
        g.title,
        g.description,
        g.owner,
        g.metadata,
        COUNT(sess.session_id)::INT AS member_count,
        COUNT(sess.session_id) FILTER (WHERE sess.state IN ('running', 'idle', 'pending'))::INT AS running_count,
        COUNT(sess.session_id) FILTER (WHERE sess.state IN ('waiting', 'input_required'))::INT AS waiting_count,
        COUNT(sess.session_id) FILTER (WHERE sess.state = 'completed')::INT AS completed_count,
        COUNT(sess.session_id) FILTER (WHERE sess.state IN ('failed', 'error'))::INT AS failed_count,
        COUNT(sess.session_id) FILTER (WHERE sess.state = 'cancelled')::INT AS cancelled_count,
        MAX(COALESCE(sess.last_active_at, sess.updated_at)) AS latest_activity_at,
        MAX(sess.summary_updated_at) AS latest_summary_updated_at,
        g.created_at,
        g.updated_at
    FROM ${s}.session_groups g
    LEFT JOIN ${s}.sessions sess ON sess.group_id = g.group_id AND sess.deleted_at IS NULL
    GROUP BY g.group_id, g.title, g.description, g.owner, g.metadata, g.created_at, g.updated_at
    ORDER BY MAX(sess.summary_updated_at) DESC NULLS LAST, g.updated_at DESC, g.group_id DESC;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION ${s}.cms_list_group_sessions(
    p_group_id TEXT
) RETURNS TABLE (
    session_id         TEXT,
    orchestration_id   TEXT,
    title              TEXT,
    title_locked       BOOLEAN,
    state              TEXT,
    model              TEXT,
    reasoning_effort   TEXT,
    group_id           TEXT,
    short_summary      TEXT,
    summary_state      JSONB,
    summary_updated_at TIMESTAMPTZ,
    created_at         TIMESTAMPTZ,
    updated_at         TIMESTAMPTZ,
    last_active_at     TIMESTAMPTZ,
    deleted_at         TIMESTAMPTZ,
    current_iteration  INTEGER,
    last_error         TEXT,
    parent_session_id  TEXT,
    wait_reason        TEXT,
    is_system          BOOLEAN,
    agent_id           TEXT,
    splash             TEXT,
    owner_provider     TEXT,
    owner_subject      TEXT,
    owner_email        TEXT,
    owner_display_name TEXT
) AS $$
BEGIN
    RETURN QUERY
    SELECT * FROM ${s}.cms_list_sessions() s
    WHERE s.group_id = p_group_id
    ORDER BY COALESCE(s.summary_updated_at, s.updated_at) DESC, s.session_id DESC;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION ${s}.cms_delete_session_group(
    p_group_id TEXT
) RETURNS BOOLEAN AS $$
DECLARE
    v_member_count INT;
BEGIN
    SELECT COUNT(*)::INT INTO v_member_count
    FROM ${s}.sessions
    WHERE group_id = p_group_id AND deleted_at IS NULL;

    IF v_member_count > 0 THEN
        RETURN FALSE;
    END IF;

    DELETE FROM ${s}.session_groups WHERE group_id = p_group_id;
    RETURN TRUE;
END;
$$ LANGUAGE plpgsql;

-- ── child outcome procedures ───────────────────────────────────
CREATE OR REPLACE FUNCTION ${s}.cms_upsert_child_outcome(
    p_child_session_id  TEXT,
    p_parent_session_id TEXT,
    p_contract_json     JSONB DEFAULT NULL,
    p_result_json       JSONB DEFAULT NULL,
    p_verdict           TEXT DEFAULT NULL,
    p_summary           TEXT DEFAULT NULL,
    p_completed_at      TIMESTAMPTZ DEFAULT NULL
) RETURNS VOID AS $$
BEGIN
    INSERT INTO ${s}.session_child_outcomes (
        child_session_id, parent_session_id, contract_json, result_json,
        verdict, summary, completed_at
    ) VALUES (
        p_child_session_id, p_parent_session_id, p_contract_json, p_result_json,
        p_verdict, p_summary, p_completed_at
    )
    ON CONFLICT (child_session_id) DO UPDATE
    SET parent_session_id = EXCLUDED.parent_session_id,
        contract_json = COALESCE(EXCLUDED.contract_json, ${s}.session_child_outcomes.contract_json),
        result_json = COALESCE(EXCLUDED.result_json, ${s}.session_child_outcomes.result_json),
        verdict = COALESCE(EXCLUDED.verdict, ${s}.session_child_outcomes.verdict),
        summary = COALESCE(EXCLUDED.summary, ${s}.session_child_outcomes.summary),
        completed_at = COALESCE(EXCLUDED.completed_at, ${s}.session_child_outcomes.completed_at),
        updated_at = now();
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION ${s}.cms_get_child_outcome(
    p_child_session_id TEXT
) RETURNS SETOF ${s}.session_child_outcomes AS $$
BEGIN
    RETURN QUERY
    SELECT * FROM ${s}.session_child_outcomes
    WHERE child_session_id = p_child_session_id;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION ${s}.cms_list_child_outcomes(
    p_parent_session_id TEXT
) RETURNS SETOF ${s}.session_child_outcomes AS $$
BEGIN
    RETURN QUERY
    SELECT * FROM ${s}.session_child_outcomes
    WHERE parent_session_id = p_parent_session_id
    ORDER BY updated_at DESC, child_session_id DESC;
END;
$$ LANGUAGE plpgsql;
`;
}

// ─── Migration 0016: Base Infra State Compatibility Fixes ───────

function migration_0016_base_infra_state_compat_fixes(schema: string): string {
    const s = `"${schema}"`;
    return `
-- 0016_base_infra_state_compat_fixes: applies post-0015 procedure fixes
-- for schemas that already recorded migration 0015.

CREATE OR REPLACE FUNCTION ${s}.cms_create_session(
    p_session_id        TEXT,
    p_model             TEXT,
    p_reasoning_effort  TEXT,
    p_parent_session_id TEXT,
    p_is_system         BOOLEAN,
    p_agent_id          TEXT,
    p_splash            TEXT
) RETURNS VOID AS $$
BEGIN
    PERFORM ${s}.cms_create_session(
        p_session_id,
        p_model,
        p_reasoning_effort,
        p_parent_session_id,
        p_is_system,
        p_agent_id,
        p_splash,
        NULL::TEXT
    );
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION ${s}.cms_update_session_summary(
    p_session_id     TEXT,
    p_summary_state  JSONB,
    p_short_summary  TEXT DEFAULT NULL
) RETURNS VOID AS $$
DECLARE
    v_short_summary TEXT := NULLIF(BTRIM(regexp_replace(COALESCE(p_short_summary, ''), '\\s+', ' ', 'g')), '');
BEGIN
    IF p_summary_state IS NULL OR jsonb_typeof(p_summary_state) <> 'object' THEN
        RAISE EXCEPTION 'summary_state must be a JSON object';
    END IF;

    UPDATE ${s}.sessions
    SET summary_state = p_summary_state,
        short_summary = LEFT(COALESCE(v_short_summary, NULLIF(BTRIM(regexp_replace(COALESCE(p_summary_state->>'summary', ''), '\\s+', ' ', 'g')), '')), 240),
        summary_updated_at = now(),
        updated_at = now()
    WHERE session_id = p_session_id
      AND deleted_at IS NULL;
END;
$$ LANGUAGE plpgsql;

DROP FUNCTION IF EXISTS ${s}.cms_list_sessions();
CREATE FUNCTION ${s}.cms_list_sessions()
RETURNS TABLE (
    session_id         TEXT,
    orchestration_id   TEXT,
    title              TEXT,
    title_locked       BOOLEAN,
    state              TEXT,
    model              TEXT,
    reasoning_effort   TEXT,
    group_id           TEXT,
    short_summary      TEXT,
    summary_state      JSONB,
    summary_updated_at TIMESTAMPTZ,
    created_at         TIMESTAMPTZ,
    updated_at         TIMESTAMPTZ,
    last_active_at     TIMESTAMPTZ,
    deleted_at         TIMESTAMPTZ,
    current_iteration  INTEGER,
    last_error         TEXT,
    parent_session_id  TEXT,
    wait_reason        TEXT,
    is_system          BOOLEAN,
    agent_id           TEXT,
    splash             TEXT,
    owner_provider     TEXT,
    owner_subject      TEXT,
    owner_email        TEXT,
    owner_display_name TEXT
) AS $$
BEGIN
    RETURN QUERY
    SELECT
        sess.session_id,
        sess.orchestration_id,
        sess.title,
        sess.title_locked,
        sess.state,
        sess.model,
        sess.reasoning_effort,
        sess.group_id,
        sess.short_summary,
        sess.summary_state,
        sess.summary_updated_at,
        sess.created_at,
        sess.updated_at,
        sess.last_active_at,
        sess.deleted_at,
        sess.current_iteration,
        sess.last_error,
        sess.parent_session_id,
        sess.wait_reason,
        sess.is_system,
        sess.agent_id,
        sess.splash,
        u.provider AS owner_provider,
        u.subject AS owner_subject,
        u.email AS owner_email,
        u.display_name AS owner_display_name
    FROM ${s}.sessions sess
    LEFT JOIN ${s}.session_owners so ON so.session_id = sess.session_id
    LEFT JOIN ${s}.users u ON u.user_id = so.user_id
    WHERE sess.deleted_at IS NULL
    ORDER BY sess.updated_at DESC, sess.session_id DESC;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION ${s}.cms_create_session_group(
    p_group_id    TEXT,
    p_title       TEXT,
    p_description TEXT DEFAULT NULL,
    p_owner       JSONB DEFAULT NULL,
    p_metadata    JSONB DEFAULT '{}'::jsonb
) RETURNS VOID AS $$
BEGIN
    IF NULLIF(BTRIM(p_group_id), '') IS NULL THEN
        RAISE EXCEPTION 'group_id is required';
    END IF;
    IF NULLIF(BTRIM(p_title), '') IS NULL THEN
        RAISE EXCEPTION 'title is required';
    END IF;

    INSERT INTO ${s}.session_groups (group_id, title, description, owner, metadata)
    VALUES (p_group_id, BTRIM(p_title), p_description, p_owner, COALESCE(p_metadata, '{}'::jsonb));
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION ${s}.cms_list_group_sessions(
    p_group_id TEXT
) RETURNS TABLE (
    session_id         TEXT,
    orchestration_id   TEXT,
    title              TEXT,
    title_locked       BOOLEAN,
    state              TEXT,
    model              TEXT,
    reasoning_effort   TEXT,
    group_id           TEXT,
    short_summary      TEXT,
    summary_state      JSONB,
    summary_updated_at TIMESTAMPTZ,
    created_at         TIMESTAMPTZ,
    updated_at         TIMESTAMPTZ,
    last_active_at     TIMESTAMPTZ,
    deleted_at         TIMESTAMPTZ,
    current_iteration  INTEGER,
    last_error         TEXT,
    parent_session_id  TEXT,
    wait_reason        TEXT,
    is_system          BOOLEAN,
    agent_id           TEXT,
    splash             TEXT,
    owner_provider     TEXT,
    owner_subject      TEXT,
    owner_email        TEXT,
    owner_display_name TEXT
) AS $$
BEGIN
    RETURN QUERY
    SELECT * FROM ${s}.cms_list_sessions() s
    WHERE s.group_id = p_group_id
    ORDER BY s.updated_at DESC, s.session_id DESC;
END;
$$ LANGUAGE plpgsql;
`;
}

// ─── Migration 0017: System Session Restart Archive ──────────────

function migration_0017_system_session_restart_archive(schema: string): string {
    const s = `"${schema}"`;
    return `
-- 0017_system_session_restart_archive: privileged archive/reset for deterministic system-session restarts.

CREATE OR REPLACE FUNCTION ${s}.cms_archive_system_session_for_restart(
    p_session_id TEXT,
    p_state      TEXT,
    p_last_error TEXT DEFAULT NULL
) RETURNS VOID AS $$
DECLARE
    v_is_system BOOLEAN;
BEGIN
    SELECT is_system INTO v_is_system
    FROM ${s}.sessions
    WHERE session_id = p_session_id
      AND deleted_at IS NULL;

    IF NOT FOUND THEN
        RETURN;
    END IF;

    IF NOT v_is_system THEN
        RAISE EXCEPTION 'Cannot archive non-system session for system restart';
    END IF;

    IF p_state NOT IN ('completed', 'cancelled', 'failed') THEN
        RAISE EXCEPTION 'Invalid system restart archive state: %', p_state;
    END IF;

    DELETE FROM ${s}.session_events
    WHERE session_id = p_session_id;

    DELETE FROM ${s}.session_turn_metrics
    WHERE session_id = p_session_id;

    DELETE FROM ${s}.session_metric_summaries
    WHERE session_id = p_session_id;

    DELETE FROM ${s}.session_child_outcomes
    WHERE child_session_id = p_session_id
       OR parent_session_id = p_session_id;

    UPDATE ${s}.sessions
    SET state             = p_state,
        last_error        = p_last_error,
        wait_reason       = NULL,
        orchestration_id  = NULL,
        last_active_at    = NULL,
        current_iteration = 0,
        short_summary     = NULL,
        summary_state     = NULL,
        summary_updated_at = NULL,
        deleted_at        = now(),
        updated_at        = now()
    WHERE session_id = p_session_id;
END;
$$ LANGUAGE plpgsql;
`;
}

// ─── Migration 0018: Session Group Assignment Update ─────────────

function migration_0018_session_group_assignment_update(schema: string): string {
    const s = `"${schema}"`;
    return `
-- 0018_session_group_assignment_update: allow management/UI to assign sessions to groups.

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
        reasoning_effort  = CASE WHEN p_updates ? 'reasoningEffort' THEN NULLIF(BTRIM(p_updates->>'reasoningEffort'), '')          ELSE reasoning_effort  END,
        last_active_at    = CASE WHEN p_updates ? 'lastActiveAt'    THEN (p_updates->>'lastActiveAt')::TIMESTAMPTZ                 ELSE last_active_at    END,
        current_iteration = CASE WHEN p_updates ? 'currentIteration' THEN (p_updates->>'currentIteration')::INT                   ELSE current_iteration END,
        last_error        = CASE WHEN p_updates ? 'lastError'       THEN (p_updates->>'lastError')                                 ELSE last_error        END,
        wait_reason       = CASE WHEN p_updates ? 'waitReason'      THEN (p_updates->>'waitReason')                                ELSE wait_reason       END,
        is_system         = CASE WHEN p_updates ? 'isSystem'        THEN (p_updates->>'isSystem')::BOOLEAN                         ELSE is_system         END,
        agent_id          = CASE WHEN p_updates ? 'agentId'         THEN (p_updates->>'agentId')                                   ELSE agent_id          END,
        splash            = CASE WHEN p_updates ? 'splash'          THEN (p_updates->>'splash')                                    ELSE splash            END,
        group_id          = group_id,
        updated_at        = now()
    WHERE session_id = p_session_id;

    UPDATE ${s}.session_metric_summaries
    SET model = CASE WHEN p_updates ? 'model' THEN (p_updates->>'model') ELSE model END,
        reasoning_effort = CASE WHEN p_updates ? 'reasoningEffort' THEN NULLIF(BTRIM(p_updates->>'reasoningEffort'), '') ELSE reasoning_effort END,
        updated_at = CASE WHEN p_updates ? 'model' OR p_updates ? 'reasoningEffort' THEN now() ELSE updated_at END
    WHERE session_id = p_session_id
      AND (p_updates ? 'model' OR p_updates ? 'reasoningEffort');
END;
$$ LANGUAGE plpgsql;
`;
}

// ─── Migration 0019: Session Group Owner Enforcement ────────────

function migration_0019_session_group_owner_enforcement(schema: string): string {
    const s = `"${schema}"`;
    return `
-- 0019_session_group_owner_enforcement: give groups the same normalized owner schema as sessions.

CREATE TABLE IF NOT EXISTS ${s}.session_group_owners (
    group_id    TEXT PRIMARY KEY REFERENCES ${s}.session_groups(group_id) ON DELETE CASCADE,
    user_id     BIGINT NOT NULL REFERENCES ${s}.users(user_id),
    assigned_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_${schema}_session_group_owners_user
    ON ${s}.session_group_owners(user_id);

INSERT INTO ${s}.users (provider, subject, email, display_name)
SELECT DISTINCT
    NULLIF(BTRIM(g.owner->>'provider'), ''),
    NULLIF(BTRIM(g.owner->>'subject'), ''),
    NULLIF(BTRIM(g.owner->>'email'), ''),
    NULLIF(BTRIM(g.owner->>'displayName'), '')
FROM ${s}.session_groups g
WHERE g.owner IS NOT NULL
  AND NULLIF(BTRIM(g.owner->>'provider'), '') IS NOT NULL
  AND NULLIF(BTRIM(g.owner->>'subject'), '') IS NOT NULL
ON CONFLICT (provider, subject) DO NOTHING;

INSERT INTO ${s}.session_group_owners (group_id, user_id)
SELECT g.group_id, u.user_id
FROM ${s}.session_groups g
JOIN ${s}.users u
  ON u.provider = NULLIF(BTRIM(g.owner->>'provider'), '')
 AND u.subject = NULLIF(BTRIM(g.owner->>'subject'), '')
WHERE g.owner IS NOT NULL
  AND NULLIF(BTRIM(g.owner->>'provider'), '') IS NOT NULL
  AND NULLIF(BTRIM(g.owner->>'subject'), '') IS NOT NULL
ON CONFLICT (group_id) DO NOTHING;

CREATE OR REPLACE FUNCTION ${s}.cms_set_session_group_owner(
    p_group_id      TEXT,
    p_provider      TEXT,
    p_subject       TEXT,
    p_email         TEXT,
    p_display_name  TEXT
) RETURNS VOID AS $$
DECLARE
    v_user_id BIGINT;
BEGIN
    IF NOT EXISTS (SELECT 1 FROM ${s}.session_groups WHERE group_id = p_group_id) THEN
        RETURN;
    END IF;

    v_user_id := ${s}.cms_register_user(p_provider, p_subject, p_email, p_display_name);

    INSERT INTO ${s}.session_group_owners (group_id, user_id)
    VALUES (p_group_id, v_user_id)
    ON CONFLICT (group_id) DO NOTHING;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION ${s}.cms_create_session_group(
    p_group_id    TEXT,
    p_title       TEXT,
    p_description TEXT DEFAULT NULL,
    p_owner       JSONB DEFAULT NULL,
    p_metadata    JSONB DEFAULT '{}'::jsonb
) RETURNS VOID AS $$
BEGIN
    IF NULLIF(BTRIM(p_group_id), '') IS NULL THEN
        RAISE EXCEPTION 'group_id is required';
    END IF;
    IF NULLIF(BTRIM(p_title), '') IS NULL THEN
        RAISE EXCEPTION 'title is required';
    END IF;

    INSERT INTO ${s}.session_groups (group_id, title, description, metadata)
    VALUES (p_group_id, BTRIM(p_title), p_description, COALESCE(p_metadata, '{}'::jsonb));

    IF p_owner IS NOT NULL
       AND NULLIF(BTRIM(p_owner->>'provider'), '') IS NOT NULL
       AND NULLIF(BTRIM(p_owner->>'subject'), '') IS NOT NULL THEN
        PERFORM ${s}.cms_set_session_group_owner(
            p_group_id,
            p_owner->>'provider',
            p_owner->>'subject',
            p_owner->>'email',
            p_owner->>'displayName'
        );
    END IF;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION ${s}.cms_list_session_groups()
RETURNS TABLE (
    group_id                  TEXT,
    title                     TEXT,
    description               TEXT,
    owner                     JSONB,
    metadata                  JSONB,
    member_count              INT,
    running_count             INT,
    waiting_count             INT,
    completed_count           INT,
    failed_count              INT,
    cancelled_count           INT,
    latest_activity_at        TIMESTAMPTZ,
    latest_summary_updated_at TIMESTAMPTZ,
    created_at                TIMESTAMPTZ,
    updated_at                TIMESTAMPTZ
) AS $$
BEGIN
    RETURN QUERY
    SELECT
        g.group_id,
        g.title,
        g.description,
        CASE WHEN u.user_id IS NULL THEN NULL ELSE jsonb_build_object(
            'provider', u.provider,
            'subject', u.subject,
            'email', u.email,
            'displayName', u.display_name
        ) END AS owner,
        g.metadata,
        COUNT(sess.session_id)::INT AS member_count,
        COUNT(sess.session_id) FILTER (WHERE sess.state IN ('running', 'idle', 'pending'))::INT AS running_count,
        COUNT(sess.session_id) FILTER (WHERE sess.state IN ('waiting', 'input_required'))::INT AS waiting_count,
        COUNT(sess.session_id) FILTER (WHERE sess.state = 'completed')::INT AS completed_count,
        COUNT(sess.session_id) FILTER (WHERE sess.state IN ('failed', 'error'))::INT AS failed_count,
        COUNT(sess.session_id) FILTER (WHERE sess.state = 'cancelled')::INT AS cancelled_count,
        MAX(COALESCE(sess.last_active_at, sess.updated_at)) AS latest_activity_at,
        MAX(sess.summary_updated_at) AS latest_summary_updated_at,
        g.created_at,
        g.updated_at
    FROM ${s}.session_groups g
    LEFT JOIN ${s}.session_group_owners go ON go.group_id = g.group_id
    LEFT JOIN ${s}.users u ON u.user_id = go.user_id
    LEFT JOIN ${s}.sessions sess ON sess.group_id = g.group_id AND sess.deleted_at IS NULL
    GROUP BY g.group_id, g.title, g.description, u.user_id, u.provider, u.subject, u.email, u.display_name, g.metadata, g.created_at, g.updated_at
    ORDER BY MAX(sess.summary_updated_at) DESC NULLS LAST, g.updated_at DESC, g.group_id DESC;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION ${s}.cms_assign_session_group(
    p_session_id TEXT,
    p_group_id   TEXT DEFAULT NULL
) RETURNS VOID AS $$
DECLARE
    v_group_id TEXT := NULLIF(BTRIM(p_group_id), '');
    v_is_system BOOLEAN;
    v_session_owner_provider TEXT;
    v_session_owner_subject TEXT;
    v_group_owner_provider TEXT;
    v_group_owner_subject TEXT;
BEGIN
    SELECT sess.is_system, u.provider, u.subject
    INTO v_is_system, v_session_owner_provider, v_session_owner_subject
    FROM ${s}.sessions sess
    LEFT JOIN ${s}.session_owners so ON so.session_id = sess.session_id
    LEFT JOIN ${s}.users u ON u.user_id = so.user_id
    WHERE sess.session_id = p_session_id
      AND sess.deleted_at IS NULL;

    IF NOT FOUND OR v_is_system THEN
        RETURN;
    END IF;

    IF v_group_id IS NOT NULL THEN
        SELECT u.provider, u.subject
        INTO v_group_owner_provider, v_group_owner_subject
        FROM ${s}.session_groups g
        LEFT JOIN ${s}.session_group_owners go ON go.group_id = g.group_id
        LEFT JOIN ${s}.users u ON u.user_id = go.user_id
        WHERE g.group_id = v_group_id;

        IF NOT FOUND THEN
            RAISE EXCEPTION 'Session group % was not found', v_group_id;
        END IF;

        IF v_session_owner_provider IS DISTINCT FROM v_group_owner_provider
           OR v_session_owner_subject IS DISTINCT FROM v_group_owner_subject THEN
            RAISE EXCEPTION 'Session % owner does not match session group % owner', p_session_id, v_group_id;
        END IF;
    END IF;

    UPDATE ${s}.sessions
    SET group_id = v_group_id,
        updated_at = now()
    WHERE session_id = p_session_id
      AND deleted_at IS NULL;
END;
$$ LANGUAGE plpgsql;

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
        reasoning_effort  = CASE WHEN p_updates ? 'reasoningEffort' THEN NULLIF(BTRIM(p_updates->>'reasoningEffort'), '')          ELSE reasoning_effort  END,
        last_active_at    = CASE WHEN p_updates ? 'lastActiveAt'    THEN (p_updates->>'lastActiveAt')::TIMESTAMPTZ                 ELSE last_active_at    END,
        current_iteration = CASE WHEN p_updates ? 'currentIteration' THEN (p_updates->>'currentIteration')::INT                   ELSE current_iteration END,
        last_error        = CASE WHEN p_updates ? 'lastError'       THEN (p_updates->>'lastError')                                 ELSE last_error        END,
        wait_reason       = CASE WHEN p_updates ? 'waitReason'      THEN (p_updates->>'waitReason')                                ELSE wait_reason       END,
        is_system         = CASE WHEN p_updates ? 'isSystem'        THEN (p_updates->>'isSystem')::BOOLEAN                         ELSE is_system         END,
        agent_id          = CASE WHEN p_updates ? 'agentId'         THEN (p_updates->>'agentId')                                   ELSE agent_id          END,
        splash            = CASE WHEN p_updates ? 'splash'          THEN (p_updates->>'splash')                                    ELSE splash            END,
        updated_at        = now()
    WHERE session_id = p_session_id;

    IF p_updates ? 'groupId' THEN
        PERFORM ${s}.cms_assign_session_group(p_session_id, p_updates->>'groupId');
    END IF;

    UPDATE ${s}.session_metric_summaries
    SET model = CASE WHEN p_updates ? 'model' THEN (p_updates->>'model') ELSE model END,
        reasoning_effort = CASE WHEN p_updates ? 'reasoningEffort' THEN NULLIF(BTRIM(p_updates->>'reasoningEffort'), '') ELSE reasoning_effort END,
        updated_at = CASE WHEN p_updates ? 'model' OR p_updates ? 'reasoningEffort' THEN now() ELSE updated_at END
    WHERE session_id = p_session_id
      AND (p_updates ? 'model' OR p_updates ? 'reasoningEffort');
END;
$$ LANGUAGE plpgsql;
`;
}

// ─── Migration 0020: Session Group Owner Adoption ───────────────

function migration_0020_session_group_owner_adoption(schema: string): string {
    const s = `"${schema}"`;
    return `
-- 0020_session_group_owner_adoption: let empty unowned groups adopt the first moved session owner.

CREATE OR REPLACE FUNCTION ${s}.cms_assign_session_group(
    p_session_id TEXT,
    p_group_id   TEXT DEFAULT NULL
) RETURNS VOID AS $$
DECLARE
    v_group_id TEXT := NULLIF(BTRIM(p_group_id), '');
    v_is_system BOOLEAN;
    v_session_owner_user_id BIGINT;
    v_session_owner_provider TEXT;
    v_session_owner_subject TEXT;
    v_group_owner_provider TEXT;
    v_group_owner_subject TEXT;
    v_group_member_count INT;
BEGIN
    SELECT sess.is_system, u.user_id, u.provider, u.subject
    INTO v_is_system, v_session_owner_user_id, v_session_owner_provider, v_session_owner_subject
    FROM ${s}.sessions sess
    LEFT JOIN ${s}.session_owners so ON so.session_id = sess.session_id
    LEFT JOIN ${s}.users u ON u.user_id = so.user_id
    WHERE sess.session_id = p_session_id
      AND sess.deleted_at IS NULL;

    IF NOT FOUND OR v_is_system THEN
        RETURN;
    END IF;

    IF v_group_id IS NOT NULL THEN
        SELECT u.provider, u.subject
        INTO v_group_owner_provider, v_group_owner_subject
        FROM ${s}.session_groups g
        LEFT JOIN ${s}.session_group_owners go ON go.group_id = g.group_id
        LEFT JOIN ${s}.users u ON u.user_id = go.user_id
        WHERE g.group_id = v_group_id;

        IF NOT FOUND THEN
            RAISE EXCEPTION 'Session group % was not found', v_group_id;
        END IF;

        IF v_group_owner_provider IS NULL
           AND v_group_owner_subject IS NULL
           AND v_session_owner_user_id IS NOT NULL THEN
            SELECT COUNT(*)::INT INTO v_group_member_count
            FROM ${s}.sessions
            WHERE group_id = v_group_id
              AND deleted_at IS NULL;

            IF COALESCE(v_group_member_count, 0) = 0 THEN
                INSERT INTO ${s}.session_group_owners (group_id, user_id)
                VALUES (v_group_id, v_session_owner_user_id)
                ON CONFLICT (group_id) DO NOTHING;

                v_group_owner_provider := v_session_owner_provider;
                v_group_owner_subject := v_session_owner_subject;
            END IF;
        END IF;

        IF v_session_owner_provider IS DISTINCT FROM v_group_owner_provider
           OR v_session_owner_subject IS DISTINCT FROM v_group_owner_subject THEN
            RAISE EXCEPTION 'Session % owner does not match session group % owner', p_session_id, v_group_id;
        END IF;
    END IF;

    UPDATE ${s}.sessions
    SET group_id = v_group_id,
        updated_at = now()
    WHERE session_id = p_session_id
      AND deleted_at IS NULL;
END;
$$ LANGUAGE plpgsql;
`;
}

// ─── Migration 0021: Retrieval Usage Procs ──────────────────────

function migration_0021_retrieval_usage_procs(schema: string): string {
    const s = `"${schema}"`;
    return `
-- 0021_retrieval_usage_procs: count-only fact/search/graph retrieval usage from session_events.

CREATE INDEX IF NOT EXISTS idx_${schema}_events_retrieval_usage
    ON ${s}.session_events (session_id, created_at DESC)
    WHERE event_type IN ('facts.searched', 'facts.similar', 'skills.searched', 'graph.searched', 'graph.node_searched', 'graph.node_loaded');

CREATE INDEX IF NOT EXISTS idx_${schema}_events_graph_node_usage
    ON ${s}.session_events ((data->>'nodeKey'), created_at DESC)
    WHERE event_type IN ('graph.node_searched', 'graph.node_loaded');

CREATE OR REPLACE FUNCTION ${s}.cms_get_session_retrieval_usage(
    p_session_id TEXT,
    p_since      TIMESTAMPTZ
) RETURNS TABLE (
    surface           TEXT,
    operation         TEXT,
    namespace         TEXT,
    calls             BIGINT,
    total_results     BIGINT,
    avg_results       DOUBLE PRECISION,
    total_duration_ms BIGINT,
    avg_duration_ms   DOUBLE PRECISION,
    first_used_at     TIMESTAMPTZ,
    last_used_at      TIMESTAMPTZ
) AS $$
BEGIN
    RETURN QUERY
    SELECT
        CASE
            WHEN e.event_type IN ('facts.searched', 'facts.similar') THEN 'facts'
            WHEN e.event_type = 'skills.searched' THEN 'skills'
            ELSE 'graph'
        END::TEXT AS surface,
        COALESCE(NULLIF(e.data->>'operation', ''),
            CASE e.event_type
                WHEN 'facts.searched' THEN 'facts_search'
                WHEN 'facts.similar' THEN 'facts_similar'
                WHEN 'skills.searched' THEN 'search_skills'
                WHEN 'graph.searched' THEN
                    CASE COALESCE(e.data->>'kind', '')
                        WHEN 'search_nodes' THEN 'graph_search_nodes'
                        WHEN 'search_edges' THEN 'graph_search_edges'
                        WHEN 'neighbourhood' THEN 'graph_neighbourhood'
                        ELSE 'graph_search_nodes'
                    END
                ELSE NULL
            END
        )::TEXT AS operation,
        NULLIF(e.data->>'namespace', '')::TEXT AS namespace,
        COUNT(*)::BIGINT AS calls,
        COALESCE(SUM(NULLIF(e.data->>'resultCount', '')::BIGINT), 0)::BIGINT AS total_results,
        COALESCE(AVG(NULLIF(e.data->>'resultCount', '')::DOUBLE PRECISION), 0)::DOUBLE PRECISION AS avg_results,
        SUM(NULLIF(e.data->>'durationMs', '')::BIGINT)::BIGINT AS total_duration_ms,
        AVG(NULLIF(e.data->>'durationMs', '')::DOUBLE PRECISION)::DOUBLE PRECISION AS avg_duration_ms,
        MIN(e.created_at) AS first_used_at,
        MAX(e.created_at) AS last_used_at
    FROM ${s}.session_events e
    WHERE e.session_id = p_session_id
      AND e.event_type IN ('facts.searched', 'facts.similar', 'skills.searched', 'graph.searched')
      AND (p_since IS NULL OR e.created_at >= p_since)
    GROUP BY 1, 2, 3
    ORDER BY calls DESC, last_used_at DESC;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION ${s}.cms_get_session_tree_retrieval_usage(
    p_session_id TEXT,
    p_since      TIMESTAMPTZ
) RETURNS TABLE (
    session_id        TEXT,
    agent_id          TEXT,
    surface           TEXT,
    operation         TEXT,
    namespace         TEXT,
    calls             BIGINT,
    total_results     BIGINT,
    avg_results       DOUBLE PRECISION,
    total_duration_ms BIGINT,
    avg_duration_ms   DOUBLE PRECISION,
    first_used_at     TIMESTAMPTZ,
    last_used_at      TIMESTAMPTZ
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
        e.session_id AS session_id,
        t.agent_id AS agent_id,
        CASE
            WHEN e.event_type IN ('facts.searched', 'facts.similar') THEN 'facts'
            WHEN e.event_type = 'skills.searched' THEN 'skills'
            ELSE 'graph'
        END::TEXT AS surface,
        COALESCE(NULLIF(e.data->>'operation', ''),
            CASE e.event_type
                WHEN 'facts.searched' THEN 'facts_search'
                WHEN 'facts.similar' THEN 'facts_similar'
                WHEN 'skills.searched' THEN 'search_skills'
                WHEN 'graph.searched' THEN
                    CASE COALESCE(e.data->>'kind', '')
                        WHEN 'search_nodes' THEN 'graph_search_nodes'
                        WHEN 'search_edges' THEN 'graph_search_edges'
                        WHEN 'neighbourhood' THEN 'graph_neighbourhood'
                        ELSE 'graph_search_nodes'
                    END
                ELSE NULL
            END
        )::TEXT AS operation,
        NULLIF(e.data->>'namespace', '')::TEXT AS namespace,
        COUNT(*)::BIGINT AS calls,
        COALESCE(SUM(NULLIF(e.data->>'resultCount', '')::BIGINT), 0)::BIGINT AS total_results,
        COALESCE(AVG(NULLIF(e.data->>'resultCount', '')::DOUBLE PRECISION), 0)::DOUBLE PRECISION AS avg_results,
        SUM(NULLIF(e.data->>'durationMs', '')::BIGINT)::BIGINT AS total_duration_ms,
        AVG(NULLIF(e.data->>'durationMs', '')::DOUBLE PRECISION)::DOUBLE PRECISION AS avg_duration_ms,
        MIN(e.created_at) AS first_used_at,
        MAX(e.created_at) AS last_used_at
    FROM ${s}.session_events e
    INNER JOIN tree t ON e.session_id = t.session_id
    WHERE e.event_type IN ('facts.searched', 'facts.similar', 'skills.searched', 'graph.searched')
      AND (p_since IS NULL OR e.created_at >= p_since)
    GROUP BY e.session_id, t.agent_id, surface, operation, namespace
    ORDER BY e.session_id, calls DESC, last_used_at DESC;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION ${s}.cms_get_fleet_retrieval_usage(
    p_since           TIMESTAMPTZ,
    p_include_deleted BOOLEAN
) RETURNS TABLE (
    agent_id          TEXT,
    surface           TEXT,
    operation         TEXT,
    namespace         TEXT,
    session_count     BIGINT,
    calls             BIGINT,
    total_results     BIGINT,
    avg_results       DOUBLE PRECISION,
    total_duration_ms BIGINT,
    avg_duration_ms   DOUBLE PRECISION,
    first_used_at     TIMESTAMPTZ,
    last_used_at      TIMESTAMPTZ
) AS $$
BEGIN
    RETURN QUERY
    SELECT
        s.agent_id AS agent_id,
        CASE
            WHEN e.event_type IN ('facts.searched', 'facts.similar') THEN 'facts'
            WHEN e.event_type = 'skills.searched' THEN 'skills'
            ELSE 'graph'
        END::TEXT AS surface,
        COALESCE(NULLIF(e.data->>'operation', ''),
            CASE e.event_type
                WHEN 'facts.searched' THEN 'facts_search'
                WHEN 'facts.similar' THEN 'facts_similar'
                WHEN 'skills.searched' THEN 'search_skills'
                WHEN 'graph.searched' THEN
                    CASE COALESCE(e.data->>'kind', '')
                        WHEN 'search_nodes' THEN 'graph_search_nodes'
                        WHEN 'search_edges' THEN 'graph_search_edges'
                        WHEN 'neighbourhood' THEN 'graph_neighbourhood'
                        ELSE 'graph_search_nodes'
                    END
                ELSE NULL
            END
        )::TEXT AS operation,
        NULLIF(e.data->>'namespace', '')::TEXT AS namespace,
        COUNT(DISTINCT e.session_id)::BIGINT AS session_count,
        COUNT(*)::BIGINT AS calls,
        COALESCE(SUM(NULLIF(e.data->>'resultCount', '')::BIGINT), 0)::BIGINT AS total_results,
        COALESCE(AVG(NULLIF(e.data->>'resultCount', '')::DOUBLE PRECISION), 0)::DOUBLE PRECISION AS avg_results,
        SUM(NULLIF(e.data->>'durationMs', '')::BIGINT)::BIGINT AS total_duration_ms,
        AVG(NULLIF(e.data->>'durationMs', '')::DOUBLE PRECISION)::DOUBLE PRECISION AS avg_duration_ms,
        MIN(e.created_at) AS first_used_at,
        MAX(e.created_at) AS last_used_at
    FROM ${s}.session_events e
    INNER JOIN ${s}.sessions s ON s.session_id = e.session_id
    WHERE e.event_type IN ('facts.searched', 'facts.similar', 'skills.searched', 'graph.searched')
      AND (p_include_deleted OR s.deleted_at IS NULL)
      AND (p_since IS NULL OR e.created_at >= p_since)
    GROUP BY s.agent_id, surface, operation, namespace
    ORDER BY calls DESC, last_used_at DESC;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION ${s}.cms_get_session_graph_node_usage(
    p_session_id    TEXT,
    p_since         TIMESTAMPTZ,
    p_limit         INT,
    p_node_key_like TEXT,
    p_kind          TEXT
) RETURNS TABLE (
    node_key      TEXT,
    namespace     TEXT,
    operation     TEXT,
    kind          TEXT,
    count         BIGINT,
    first_seen_at TIMESTAMPTZ,
    last_seen_at  TIMESTAMPTZ
) AS $$
BEGIN
    RETURN QUERY
    SELECT
        e.data->>'nodeKey' AS node_key,
        NULLIF(e.data->>'namespace', '')::TEXT AS namespace,
        COALESCE(NULLIF(e.data->>'operation', ''),
            CASE WHEN e.event_type = 'graph.node_loaded' THEN 'graph_neighbourhood' ELSE 'graph_search_nodes' END
        )::TEXT AS operation,
        CASE WHEN e.event_type = 'graph.node_loaded' THEN 'loaded' ELSE 'searched' END::TEXT AS kind,
        COUNT(*)::BIGINT AS count,
        MIN(e.created_at) AS first_seen_at,
        MAX(e.created_at) AS last_seen_at
    FROM ${s}.session_events e
    WHERE e.session_id = p_session_id
      AND e.event_type IN ('graph.node_searched', 'graph.node_loaded')
      AND NULLIF(e.data->>'nodeKey', '') IS NOT NULL
      AND (p_since IS NULL OR e.created_at >= p_since)
      AND (p_kind IS NULL OR p_kind = '' OR (CASE WHEN e.event_type = 'graph.node_loaded' THEN 'loaded' ELSE 'searched' END) = p_kind)
      AND (p_node_key_like IS NULL OR p_node_key_like = '' OR e.data->>'nodeKey' ILIKE ('%' || p_node_key_like || '%'))
    GROUP BY 1, 2, 3, 4
    ORDER BY count DESC, last_seen_at DESC
    LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 100), 500));
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION ${s}.cms_get_fleet_graph_node_usage(
    p_since           TIMESTAMPTZ,
    p_include_deleted BOOLEAN,
    p_limit           INT,
    p_node_key_like   TEXT,
    p_kind            TEXT
) RETURNS TABLE (
    agent_id      TEXT,
    node_key      TEXT,
    namespace     TEXT,
    operation     TEXT,
    kind          TEXT,
    session_count BIGINT,
    count         BIGINT,
    first_seen_at TIMESTAMPTZ,
    last_seen_at  TIMESTAMPTZ
) AS $$
BEGIN
    RETURN QUERY
    SELECT
        s.agent_id AS agent_id,
        e.data->>'nodeKey' AS node_key,
        NULLIF(e.data->>'namespace', '')::TEXT AS namespace,
        COALESCE(NULLIF(e.data->>'operation', ''),
            CASE WHEN e.event_type = 'graph.node_loaded' THEN 'graph_neighbourhood' ELSE 'graph_search_nodes' END
        )::TEXT AS operation,
        CASE WHEN e.event_type = 'graph.node_loaded' THEN 'loaded' ELSE 'searched' END::TEXT AS kind,
        COUNT(DISTINCT e.session_id)::BIGINT AS session_count,
        COUNT(*)::BIGINT AS count,
        MIN(e.created_at) AS first_seen_at,
        MAX(e.created_at) AS last_seen_at
    FROM ${s}.session_events e
    INNER JOIN ${s}.sessions s ON s.session_id = e.session_id
    WHERE e.event_type IN ('graph.node_searched', 'graph.node_loaded')
      AND NULLIF(e.data->>'nodeKey', '') IS NOT NULL
      AND (p_include_deleted OR s.deleted_at IS NULL)
      AND (p_since IS NULL OR e.created_at >= p_since)
      AND (p_kind IS NULL OR p_kind = '' OR (CASE WHEN e.event_type = 'graph.node_loaded' THEN 'loaded' ELSE 'searched' END) = p_kind)
      AND (p_node_key_like IS NULL OR p_node_key_like = '' OR e.data->>'nodeKey' ILIKE ('%' || p_node_key_like || '%'))
    GROUP BY s.agent_id, node_key, namespace, operation, kind
    ORDER BY count DESC, last_seen_at DESC
    LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 100), 500));
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION ${s}.cms_get_session_graph_edge_search_usage(
    p_session_id TEXT,
    p_since      TIMESTAMPTZ,
    p_limit      INT
) RETURNS TABLE (
    predicate_key     TEXT,
    from_key          TEXT,
    to_key            TEXT,
    namespace         TEXT,
    calls             BIGINT,
    total_results     BIGINT,
    first_searched_at TIMESTAMPTZ,
    last_searched_at  TIMESTAMPTZ
) AS $$
BEGIN
    RETURN QUERY
    SELECT
        NULLIF(e.data->>'predicateKey', '')::TEXT AS predicate_key,
        NULLIF(e.data->>'fromKey', '')::TEXT AS from_key,
        NULLIF(e.data->>'toKey', '')::TEXT AS to_key,
        NULLIF(e.data->>'namespace', '')::TEXT AS namespace,
        COUNT(*)::BIGINT AS calls,
        COALESCE(SUM(NULLIF(e.data->>'resultCount', '')::BIGINT), 0)::BIGINT AS total_results,
        MIN(e.created_at) AS first_searched_at,
        MAX(e.created_at) AS last_searched_at
    FROM ${s}.session_events e
    WHERE e.session_id = p_session_id
      AND e.event_type = 'graph.searched'
      AND COALESCE(NULLIF(e.data->>'operation', ''), NULLIF(e.data->>'kind', '')) IN ('graph_search_edges', 'search_edges')
      AND (p_since IS NULL OR e.created_at >= p_since)
    GROUP BY 1, 2, 3, 4
    ORDER BY calls DESC, last_searched_at DESC
    LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 100), 500));
END;
$$ LANGUAGE plpgsql;
`;
}

// ─── Migration 0022: Turn Metrics Reasoning Effort ──────────────

function migration_0022_turn_metrics_reasoning_effort(schema: string): string {
    const s = `"${schema}"`;
    return `
-- 0022_turn_metrics_reasoning_effort:
--   - Add reasoning_effort to per-turn metrics so token attribution aligns with
--     the session row model:effort convention and survives mid-session switches.
--   - Add model+effort composite indexes for by-model aggregation.
--   - Extend insert/read procs; add per-session by-model rollup with turn count.

DO $$
BEGIN
    IF to_regclass('${schema}.session_metrics') IS NULL
       AND to_regclass('${schema}.session_metric_summaries') IS NOT NULL THEN
        ALTER TABLE ${s}.session_metric_summaries RENAME TO session_metrics;
    END IF;
END;
$$ LANGUAGE plpgsql;

DO $$
BEGIN
    IF to_regclass('${schema}.session_metric_summaries') IS NULL
       AND to_regclass('${schema}.session_metrics') IS NOT NULL THEN
        EXECUTE 'CREATE VIEW ${s}.session_metric_summaries AS SELECT * FROM ${s}.session_metrics';
    END IF;
END;
$$ LANGUAGE plpgsql;

CREATE INDEX IF NOT EXISTS idx_${schema}_session_metrics_agent_model
    ON ${s}.session_metrics(agent_id, model);
CREATE INDEX IF NOT EXISTS idx_${schema}_session_metrics_agent_model_effort
    ON ${s}.session_metrics(agent_id, model, reasoning_effort);
CREATE INDEX IF NOT EXISTS idx_${schema}_session_metrics_parent
    ON ${s}.session_metrics(parent_session_id);
CREATE INDEX IF NOT EXISTS idx_${schema}_session_metrics_updated
    ON ${s}.session_metrics(updated_at DESC);

DROP INDEX IF EXISTS ${s}.idx_${schema}_sms_agent_model;
DROP INDEX IF EXISTS ${s}.idx_${schema}_sms_agent_model_reasoning;
DROP INDEX IF EXISTS ${s}.idx_${schema}_sms_parent;
DROP INDEX IF EXISTS ${s}.idx_${schema}_sms_updated;

CREATE OR REPLACE FUNCTION ${s}.cms_update_session_group(
    p_group_id TEXT,
    p_patch    JSONB
) RETURNS VOID AS $$
BEGIN
    UPDATE ${s}.session_groups
    SET title = CASE WHEN p_patch ? 'title' THEN NULLIF(BTRIM(p_patch->>'title'), '') ELSE title END,
        description = CASE WHEN p_patch ? 'description' THEN p_patch->>'description' ELSE description END,
        owner = CASE WHEN p_patch ? 'owner' THEN p_patch->'owner' ELSE owner END,
        metadata = CASE WHEN p_patch ? 'metadataPatch' THEN metadata || COALESCE(p_patch->'metadataPatch', '{}'::jsonb) ELSE metadata END,
        updated_at = now()
    WHERE group_id = p_group_id;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION ${s}.cms_get_session_metric_summary(
    p_session_id TEXT
) RETURNS SETOF ${s}.session_metrics AS $$
BEGIN
    RETURN QUERY
    SELECT * FROM ${s}.session_metrics
    WHERE session_id = p_session_id;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION ${s}.cms_create_session(
    p_session_id        TEXT,
    p_model             TEXT,
    p_reasoning_effort  TEXT,
    p_parent_session_id TEXT,
    p_is_system         BOOLEAN,
    p_agent_id          TEXT,
    p_splash            TEXT,
    p_group_id          TEXT
) RETURNS VOID AS $$
DECLARE
    v_reasoning_effort TEXT := NULLIF(BTRIM(p_reasoning_effort), '');
    v_group_id TEXT := NULLIF(BTRIM(p_group_id), '');
BEGIN
    IF v_group_id IS NULL AND p_parent_session_id IS NOT NULL THEN
        SELECT group_id INTO v_group_id
        FROM ${s}.sessions
        WHERE session_id = p_parent_session_id;
    END IF;

    INSERT INTO ${s}.sessions
        (session_id, model, reasoning_effort, parent_session_id, is_system, agent_id, splash, group_id)
    VALUES
        (p_session_id, p_model, v_reasoning_effort, p_parent_session_id, p_is_system, p_agent_id, p_splash, v_group_id)
    ON CONFLICT (session_id) DO UPDATE
    SET model             = EXCLUDED.model,
        reasoning_effort  = EXCLUDED.reasoning_effort,
        parent_session_id = EXCLUDED.parent_session_id,
        is_system         = EXCLUDED.is_system,
        agent_id          = EXCLUDED.agent_id,
        splash            = EXCLUDED.splash,
        group_id          = EXCLUDED.group_id,
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

    INSERT INTO ${s}.session_metrics
        (session_id, agent_id, model, reasoning_effort, parent_session_id)
    VALUES
        (p_session_id, p_agent_id, p_model, v_reasoning_effort, p_parent_session_id)
    ON CONFLICT (session_id) DO UPDATE
    SET agent_id          = COALESCE(${s}.session_metrics.agent_id, EXCLUDED.agent_id),
        model             = COALESCE(${s}.session_metrics.model, EXCLUDED.model),
        reasoning_effort  = COALESCE(${s}.session_metrics.reasoning_effort, EXCLUDED.reasoning_effort),
        parent_session_id = COALESCE(${s}.session_metrics.parent_session_id, EXCLUDED.parent_session_id),
        updated_at        = now();
END;
$$ LANGUAGE plpgsql;

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
        reasoning_effort  = CASE WHEN p_updates ? 'reasoningEffort' THEN NULLIF(BTRIM(p_updates->>'reasoningEffort'), '')          ELSE reasoning_effort  END,
        last_active_at    = CASE WHEN p_updates ? 'lastActiveAt'    THEN (p_updates->>'lastActiveAt')::TIMESTAMPTZ                 ELSE last_active_at    END,
        current_iteration = CASE WHEN p_updates ? 'currentIteration' THEN (p_updates->>'currentIteration')::INT                   ELSE current_iteration END,
        last_error        = CASE WHEN p_updates ? 'lastError'       THEN (p_updates->>'lastError')                                 ELSE last_error        END,
        wait_reason       = CASE WHEN p_updates ? 'waitReason'      THEN (p_updates->>'waitReason')                                ELSE wait_reason       END,
        is_system         = CASE WHEN p_updates ? 'isSystem'        THEN (p_updates->>'isSystem')::BOOLEAN                         ELSE is_system         END,
        agent_id          = CASE WHEN p_updates ? 'agentId'         THEN (p_updates->>'agentId')                                   ELSE agent_id          END,
        splash            = CASE WHEN p_updates ? 'splash'          THEN (p_updates->>'splash')                                    ELSE splash            END,
        group_id          = group_id,
        updated_at        = now()
    WHERE session_id = p_session_id;

    IF p_updates ? 'groupId' THEN
        PERFORM ${s}.cms_assign_session_group(p_session_id, p_updates->>'groupId');
    END IF;

    UPDATE ${s}.session_metrics
    SET model = CASE WHEN p_updates ? 'model' THEN (p_updates->>'model') ELSE model END,
        reasoning_effort = CASE WHEN p_updates ? 'reasoningEffort' THEN NULLIF(BTRIM(p_updates->>'reasoningEffort'), '') ELSE reasoning_effort END,
        updated_at = CASE WHEN p_updates ? 'model' OR p_updates ? 'reasoningEffort' THEN now() ELSE updated_at END
    WHERE session_id = p_session_id
      AND (p_updates ? 'model' OR p_updates ? 'reasoningEffort');
END;
$$ LANGUAGE plpgsql;

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
    INSERT INTO ${s}.session_metrics (
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
            ELSE ${s}.session_metrics.snapshot_size_bytes
        END,
        dehydration_count   = ${s}.session_metrics.dehydration_count   + v_dehydration,
        hydration_count     = ${s}.session_metrics.hydration_count     + v_hydration,
        lossy_handoff_count = ${s}.session_metrics.lossy_handoff_count + v_lossy,
        tokens_input        = ${s}.session_metrics.tokens_input        + v_tokens_in,
        tokens_output       = ${s}.session_metrics.tokens_output       + v_tokens_out,
        tokens_cache_read   = ${s}.session_metrics.tokens_cache_read   + v_tokens_cread,
        tokens_cache_write  = ${s}.session_metrics.tokens_cache_write  + v_tokens_cwrite,
        last_dehydrated_at  = CASE WHEN v_set_dehydrated THEN now() ELSE ${s}.session_metrics.last_dehydrated_at END,
        last_hydrated_at    = CASE WHEN v_set_hydrated   THEN now() ELSE ${s}.session_metrics.last_hydrated_at   END,
        last_checkpoint_at  = CASE WHEN v_set_checkpoint  THEN now() ELSE ${s}.session_metrics.last_checkpoint_at  END,
        updated_at          = now();
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION ${s}.cms_prune_deleted_summaries(
    p_older_than TIMESTAMPTZ
) RETURNS BIGINT AS $$
DECLARE
    deleted_count BIGINT;
BEGIN
    DELETE FROM ${s}.session_metrics
    WHERE deleted_at IS NOT NULL AND deleted_at < p_older_than;
    GET DIAGNOSTICS deleted_count = ROW_COUNT;
    RETURN deleted_count;
END;
$$ LANGUAGE plpgsql;

ALTER TABLE ${s}.session_turn_metrics ADD COLUMN IF NOT EXISTS reasoning_effort TEXT;

INSERT INTO ${s}.session_turn_metrics (
        session_id, agent_id, model, reasoning_effort, turn_index,
        started_at, ended_at, duration_ms,
        tokens_input, tokens_output, tokens_cache_read, tokens_cache_write,
        tool_calls, tool_errors, result_type, error_message, worker_node_id
)
SELECT
        m.session_id,
        m.agent_id,
        m.model,
        m.reasoning_effort,
        0,
        COALESCE(m.created_at, now()),
        GREATEST(COALESCE(m.updated_at, m.created_at, now()), COALESCE(m.created_at, now())),
        LEAST(2147483647, GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (GREATEST(COALESCE(m.updated_at, m.created_at, now()), COALESCE(m.created_at, now())) - COALESCE(m.created_at, now()))) * 1000)))::INT,
        m.tokens_input,
        m.tokens_output,
        m.tokens_cache_read,
        m.tokens_cache_write,
        0,
        0,
        'legacy_summary',
        NULL,
        NULL
FROM ${s}.session_metrics m
WHERE (COALESCE(m.tokens_input, 0) <> 0
        OR COALESCE(m.tokens_output, 0) <> 0
        OR COALESCE(m.tokens_cache_read, 0) <> 0
        OR COALESCE(m.tokens_cache_write, 0) <> 0)
    AND NOT EXISTS (
            SELECT 1
            FROM ${s}.session_turn_metrics t
            WHERE t.session_id = m.session_id
    );

CREATE INDEX IF NOT EXISTS idx_${schema}_turn_metrics_session_model
    ON ${s}.session_turn_metrics(session_id, model, reasoning_effort);
CREATE INDEX IF NOT EXISTS idx_${schema}_turn_metrics_model_effort_started
    ON ${s}.session_turn_metrics(model, reasoning_effort, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_${schema}_turn_metrics_agent_model_started
    ON ${s}.session_turn_metrics(agent_id, model, reasoning_effort, started_at DESC);

-- Signature/return-type changes require drop-then-create.
DROP FUNCTION IF EXISTS ${s}.cms_insert_turn_metric(
    TEXT, TEXT, TEXT, INTEGER, TIMESTAMPTZ, TIMESTAMPTZ, INTEGER,
    BIGINT, BIGINT, BIGINT, BIGINT, INTEGER, INTEGER, TEXT, TEXT, TEXT);
DROP FUNCTION IF EXISTS ${s}.cms_get_session_turn_metrics(TEXT, TIMESTAMPTZ, INT);

CREATE OR REPLACE FUNCTION ${s}.cms_insert_turn_metric(
    p_session_id         TEXT,
    p_agent_id           TEXT,
    p_model              TEXT,
    p_reasoning_effort   TEXT,
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
        session_id, agent_id, model, reasoning_effort, turn_index,
        started_at, ended_at, duration_ms,
        tokens_input, tokens_output, tokens_cache_read, tokens_cache_write,
        tool_calls, tool_errors, result_type, error_message, worker_node_id
    ) VALUES (
        p_session_id, p_agent_id, p_model, NULLIF(BTRIM(p_reasoning_effort), ''), p_turn_index,
        p_started_at, p_ended_at, p_duration_ms,
        p_tokens_input, p_tokens_output, p_tokens_cache_read, p_tokens_cache_write,
        p_tool_calls, p_tool_errors, p_result_type, p_error_message, p_worker_node_id
    );
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION ${s}.cms_complete_turn_writeback(
    p_session_id         TEXT,
    p_agent_id           TEXT,
    p_model              TEXT,
    p_reasoning_effort   TEXT,
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
    p_tool_names         TEXT[],
    p_result_type        TEXT,
    p_error_message      TEXT,
    p_worker_node_id     TEXT,
    p_state              TEXT,
    p_last_active_at     TIMESTAMPTZ,
    p_last_error         TEXT,
    p_wait_reason        TEXT,
    p_current_iteration  INTEGER
) RETURNS VOID AS $$
DECLARE
    v_reasoning_effort TEXT := NULLIF(BTRIM(p_reasoning_effort), '');
    v_ended_at TIMESTAMPTZ := COALESCE(p_ended_at, now());
    v_started_at TIMESTAMPTZ := COALESCE(p_started_at, v_ended_at);
    v_duration_ms INTEGER := GREATEST(0, COALESCE(p_duration_ms, FLOOR(EXTRACT(EPOCH FROM (v_ended_at - v_started_at)) * 1000)::INT));
BEGIN
    UPDATE ${s}.sessions
    SET state = COALESCE(p_state, state),
        last_active_at = COALESCE(p_last_active_at, v_ended_at),
        current_iteration = COALESCE(p_current_iteration, current_iteration),
        last_error = p_last_error,
        wait_reason = p_wait_reason,
        updated_at = now()
    WHERE session_id = p_session_id;

    INSERT INTO ${s}.session_metrics (
        session_id, agent_id, model, reasoning_effort,
        tokens_input, tokens_output, tokens_cache_read, tokens_cache_write
    ) VALUES (
        p_session_id, p_agent_id, p_model, v_reasoning_effort,
        COALESCE(p_tokens_input, 0), COALESCE(p_tokens_output, 0),
        COALESCE(p_tokens_cache_read, 0), COALESCE(p_tokens_cache_write, 0)
    )
    ON CONFLICT (session_id) DO UPDATE SET
        agent_id = COALESCE(${s}.session_metrics.agent_id, EXCLUDED.agent_id),
        model = COALESCE(EXCLUDED.model, ${s}.session_metrics.model),
        reasoning_effort = COALESCE(EXCLUDED.reasoning_effort, ${s}.session_metrics.reasoning_effort),
        tokens_input = ${s}.session_metrics.tokens_input + EXCLUDED.tokens_input,
        tokens_output = ${s}.session_metrics.tokens_output + EXCLUDED.tokens_output,
        tokens_cache_read = ${s}.session_metrics.tokens_cache_read + EXCLUDED.tokens_cache_read,
        tokens_cache_write = ${s}.session_metrics.tokens_cache_write + EXCLUDED.tokens_cache_write,
        updated_at = now();

    INSERT INTO ${s}.session_turn_metrics (
        session_id, agent_id, model, reasoning_effort, turn_index,
        started_at, ended_at, duration_ms,
        tokens_input, tokens_output, tokens_cache_read, tokens_cache_write,
        tool_calls, tool_errors, result_type, error_message, worker_node_id
    ) VALUES (
        p_session_id, p_agent_id, p_model, v_reasoning_effort, COALESCE(p_turn_index, 0),
        v_started_at, v_ended_at, v_duration_ms,
        COALESCE(p_tokens_input, 0), COALESCE(p_tokens_output, 0),
        COALESCE(p_tokens_cache_read, 0), COALESCE(p_tokens_cache_write, 0),
        COALESCE(p_tool_calls, 0), COALESCE(p_tool_errors, 0),
        p_result_type, p_error_message, p_worker_node_id
    );

    INSERT INTO ${s}.session_events (session_id, event_type, data, worker_node_id)
    VALUES (
        p_session_id,
        'session.turn_completed',
        jsonb_build_object(
            'iteration', COALESCE(p_turn_index, 0),
            'turnIndex', COALESCE(p_turn_index, 0),
            'model', p_model,
            'reasoningEffort', v_reasoning_effort,
            'startedAt', v_started_at,
            'endedAt', v_ended_at,
            'durationMs', v_duration_ms,
            'tokensInput', COALESCE(p_tokens_input, 0),
            'tokensOutput', COALESCE(p_tokens_output, 0),
            'tokensCacheRead', COALESCE(p_tokens_cache_read, 0),
            'tokensCacheWrite', COALESCE(p_tokens_cache_write, 0),
            'toolCalls', COALESCE(p_tool_calls, 0),
            'toolErrors', COALESCE(p_tool_errors, 0),
            'toolNames', to_jsonb(COALESCE(p_tool_names, ARRAY[]::TEXT[])),
            'resultType', p_result_type,
            'errorMessage', p_error_message,
            'workerNodeId', p_worker_node_id
        ),
        p_worker_node_id
    );
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION ${s}.cms_get_session_turn_metrics(
    p_session_id TEXT,
    p_since      TIMESTAMPTZ DEFAULT NULL,
    p_limit      INT         DEFAULT 200
) RETURNS TABLE (
    id                  BIGINT,
    session_id          TEXT,
    agent_id            TEXT,
    model               TEXT,
    reasoning_effort    TEXT,
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
        t.id, t.session_id, t.agent_id, t.model, t.reasoning_effort, t.turn_index,
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

-- Per-session token totals grouped by model:effort label, with per-bucket turn count.
CREATE OR REPLACE FUNCTION ${s}.cms_get_session_tokens_by_model(
    p_session_id TEXT
) RETURNS TABLE (
    model                    TEXT,
    turn_count               BIGINT,
    total_tokens_input       BIGINT,
    total_tokens_output      BIGINT,
    total_tokens_cache_read  BIGINT,
    total_tokens_cache_write BIGINT
) AS $$
BEGIN
    RETURN QUERY
    SELECT
        norm.label                                          AS model,
        COUNT(*)::bigint                                     AS turn_count,
        COALESCE(SUM(norm.tokens_input), 0)::bigint         AS total_tokens_input,
        COALESCE(SUM(norm.tokens_output), 0)::bigint        AS total_tokens_output,
        COALESCE(SUM(norm.tokens_cache_read), 0)::bigint    AS total_tokens_cache_read,
        COALESCE(SUM(norm.tokens_cache_write), 0)::bigint   AS total_tokens_cache_write
    FROM (
        SELECT
            CASE
                WHEN NULLIF(BTRIM(t.reasoning_effort), '') IS NULL
                    THEN COALESCE(NULLIF(BTRIM(t.model), ''), '(unknown)')
                ELSE COALESCE(NULLIF(BTRIM(t.model), ''), '(unknown)') || ':' || BTRIM(t.reasoning_effort)
            END AS label,
            t.tokens_input, t.tokens_output, t.tokens_cache_read, t.tokens_cache_write
        FROM ${s}.session_turn_metrics t
        WHERE t.session_id = p_session_id
    ) norm
    GROUP BY norm.label
    ORDER BY COALESCE(SUM(norm.tokens_input), 0) DESC, norm.label;
END;
$$ LANGUAGE plpgsql;

DROP FUNCTION IF EXISTS ${s}.cms_get_session_tree_stats_by_model(TEXT);
CREATE FUNCTION ${s}.cms_get_session_tree_stats_by_model(
    p_session_id TEXT
) RETURNS TABLE (
    model                       TEXT,
    session_count               INT,
    turn_count                  BIGINT,
    total_tokens_input          BIGINT,
    total_tokens_output         BIGINT,
    total_tokens_cache_read     BIGINT,
    total_tokens_cache_write    BIGINT,
    total_snapshot_size_bytes   BIGINT
) AS $$
BEGIN
    RETURN QUERY
    WITH RECURSIVE tree AS (
        SELECT m.session_id FROM ${s}.session_metrics m
        WHERE m.session_id = p_session_id
        UNION ALL
        SELECT m.session_id FROM ${s}.session_metrics m
        INNER JOIN tree tr ON m.parent_session_id = tr.session_id
    ), token_rows AS (
        SELECT
            CASE
                WHEN NULLIF(BTRIM(t.reasoning_effort), '') IS NULL
                    THEN COALESCE(NULLIF(BTRIM(t.model), ''), '(unknown)')
                ELSE COALESCE(NULLIF(BTRIM(t.model), ''), '(unknown)') || ':' || BTRIM(t.reasoning_effort)
            END AS model_label,
            t.session_id,
            t.tokens_input,
            t.tokens_output,
            t.tokens_cache_read,
            t.tokens_cache_write
        FROM ${s}.session_turn_metrics t
        INNER JOIN tree tr ON tr.session_id = t.session_id
        UNION ALL
        SELECT
            CASE
                WHEN NULLIF(BTRIM(m.reasoning_effort), '') IS NULL
                    THEN COALESCE(NULLIF(BTRIM(m.model), ''), '(unknown)')
                ELSE COALESCE(NULLIF(BTRIM(m.model), ''), '(unknown)') || ':' || BTRIM(m.reasoning_effort)
            END AS model_label,
            m.session_id,
            m.tokens_input,
            m.tokens_output,
            m.tokens_cache_read,
            m.tokens_cache_write
        FROM ${s}.session_metrics m
        INNER JOIN tree tr ON tr.session_id = m.session_id
        WHERE NOT EXISTS (
            SELECT 1 FROM ${s}.session_turn_metrics existing
            WHERE existing.session_id = m.session_id
        )
    ), token_rollup AS (
        SELECT
            model_label,
            COUNT(DISTINCT session_id)::INT AS session_count,
            COUNT(*)::BIGINT AS turn_count,
            COALESCE(SUM(tokens_input), 0)::BIGINT AS total_tokens_input,
            COALESCE(SUM(tokens_output), 0)::BIGINT AS total_tokens_output,
            COALESCE(SUM(tokens_cache_read), 0)::BIGINT AS total_tokens_cache_read,
            COALESCE(SUM(tokens_cache_write), 0)::BIGINT AS total_tokens_cache_write
        FROM token_rows
        GROUP BY model_label
    ), metric_rollup AS (
        SELECT
            CASE
                WHEN NULLIF(BTRIM(m.reasoning_effort), '') IS NULL
                    THEN COALESCE(NULLIF(BTRIM(m.model), ''), '(unknown)')
                ELSE COALESCE(NULLIF(BTRIM(m.model), ''), '(unknown)') || ':' || BTRIM(m.reasoning_effort)
            END AS model_label,
            COUNT(*)::INT AS session_count,
            COALESCE(SUM(m.snapshot_size_bytes), 0)::BIGINT AS total_snapshot_size_bytes
        FROM ${s}.session_metrics m
        INNER JOIN tree tr ON tr.session_id = m.session_id
        GROUP BY model_label
    )
    SELECT
        COALESCE(t.model_label, m.model_label) AS model,
        COALESCE(t.session_count, m.session_count, 0)::INT AS session_count,
        COALESCE(t.turn_count, 0)::BIGINT AS turn_count,
        COALESCE(t.total_tokens_input, 0)::BIGINT AS total_tokens_input,
        COALESCE(t.total_tokens_output, 0)::BIGINT AS total_tokens_output,
        COALESCE(t.total_tokens_cache_read, 0)::BIGINT AS total_tokens_cache_read,
        COALESCE(t.total_tokens_cache_write, 0)::BIGINT AS total_tokens_cache_write,
        COALESCE(m.total_snapshot_size_bytes, 0)::BIGINT AS total_snapshot_size_bytes
    FROM token_rollup t
    FULL OUTER JOIN metric_rollup m ON m.model_label = t.model_label
    ORDER BY COALESCE(t.total_tokens_input, 0) DESC, COALESCE(t.model_label, m.model_label);
END;
$$ LANGUAGE plpgsql;

DROP FUNCTION IF EXISTS ${s}.cms_get_fleet_stats_by_agent(BOOLEAN, TIMESTAMPTZ);
CREATE FUNCTION ${s}.cms_get_fleet_stats_by_agent(
    p_include_deleted BOOLEAN,
    p_since           TIMESTAMPTZ
) RETURNS TABLE (
    agent_id                    TEXT,
    model                       TEXT,
    session_count               INT,
    turn_count                  BIGINT,
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
    WITH token_rows AS (
        SELECT
            COALESCE(t.agent_id, m.agent_id, sess.agent_id) AS agent_id_value,
            CASE
                WHEN NULLIF(BTRIM(t.reasoning_effort), '') IS NULL
                    THEN COALESCE(NULLIF(BTRIM(t.model), ''), '(unknown)')
                ELSE COALESCE(NULLIF(BTRIM(t.model), ''), '(unknown)') || ':' || BTRIM(t.reasoning_effort)
            END AS model_label,
            t.session_id,
            t.tokens_input,
            t.tokens_output,
            t.tokens_cache_read,
            t.tokens_cache_write
        FROM ${s}.session_turn_metrics t
        INNER JOIN ${s}.sessions sess ON sess.session_id = t.session_id
        LEFT JOIN ${s}.session_metrics m ON m.session_id = t.session_id
        WHERE (p_include_deleted OR sess.deleted_at IS NULL)
          AND (p_since IS NULL OR t.started_at >= p_since)
        UNION ALL
        SELECT
            COALESCE(m.agent_id, sess.agent_id) AS agent_id_value,
            CASE
                WHEN NULLIF(BTRIM(m.reasoning_effort), '') IS NULL
                    THEN COALESCE(NULLIF(BTRIM(m.model), ''), '(unknown)')
                ELSE COALESCE(NULLIF(BTRIM(m.model), ''), '(unknown)') || ':' || BTRIM(m.reasoning_effort)
            END AS model_label,
            m.session_id,
            m.tokens_input,
            m.tokens_output,
            m.tokens_cache_read,
            m.tokens_cache_write
        FROM ${s}.session_metrics m
        INNER JOIN ${s}.sessions sess ON sess.session_id = m.session_id
        WHERE (p_include_deleted OR m.deleted_at IS NULL)
          AND (p_since IS NULL OR m.created_at >= p_since)
          AND NOT EXISTS (
              SELECT 1 FROM ${s}.session_turn_metrics existing
              WHERE existing.session_id = m.session_id
          )
    ), token_rollup AS (
        SELECT
            agent_id_value,
            model_label,
            COUNT(DISTINCT session_id)::INT AS session_count,
            COUNT(*)::BIGINT AS turn_count,
            COALESCE(SUM(tokens_input), 0)::BIGINT AS total_tokens_input,
            COALESCE(SUM(tokens_output), 0)::BIGINT AS total_tokens_output,
            COALESCE(SUM(tokens_cache_read), 0)::BIGINT AS total_tokens_cache_read,
            COALESCE(SUM(tokens_cache_write), 0)::BIGINT AS total_tokens_cache_write
        FROM token_rows
        GROUP BY agent_id_value, model_label
    ), metric_rollup AS (
        SELECT
            m.agent_id AS agent_id_value,
            CASE
                WHEN NULLIF(BTRIM(m.reasoning_effort), '') IS NULL
                    THEN COALESCE(NULLIF(BTRIM(m.model), ''), '(unknown)')
                ELSE COALESCE(NULLIF(BTRIM(m.model), ''), '(unknown)') || ':' || BTRIM(m.reasoning_effort)
            END AS model_label,
            COUNT(*)::INT AS session_count,
            COALESCE(SUM(m.snapshot_size_bytes), 0)::BIGINT AS total_snapshot_size_bytes,
            COALESCE(SUM(m.dehydration_count), 0)::INT AS total_dehydration_count,
            COALESCE(SUM(m.hydration_count), 0)::INT AS total_hydration_count,
            COALESCE(SUM(m.lossy_handoff_count), 0)::INT AS total_lossy_handoff_count
        FROM ${s}.session_metrics m
        WHERE (p_include_deleted OR m.deleted_at IS NULL)
          AND (p_since IS NULL OR m.created_at >= p_since)
        GROUP BY m.agent_id, model_label
    )
    SELECT
        COALESCE(t.agent_id_value, m.agent_id_value) AS agent_id,
        COALESCE(t.model_label, m.model_label) AS model,
        COALESCE(t.session_count, m.session_count, 0)::INT AS session_count,
        COALESCE(t.turn_count, 0)::BIGINT AS turn_count,
        COALESCE(m.total_snapshot_size_bytes, 0)::BIGINT AS total_snapshot_size_bytes,
        COALESCE(m.total_dehydration_count, 0)::INT AS total_dehydration_count,
        COALESCE(m.total_hydration_count, 0)::INT AS total_hydration_count,
        COALESCE(m.total_lossy_handoff_count, 0)::INT AS total_lossy_handoff_count,
        COALESCE(t.total_tokens_input, 0)::BIGINT AS total_tokens_input,
        COALESCE(t.total_tokens_output, 0)::BIGINT AS total_tokens_output,
        COALESCE(t.total_tokens_cache_read, 0)::BIGINT AS total_tokens_cache_read,
        COALESCE(t.total_tokens_cache_write, 0)::BIGINT AS total_tokens_cache_write
    FROM token_rollup t
    FULL OUTER JOIN metric_rollup m
    ON m.agent_id_value IS NOT DISTINCT FROM t.agent_id_value
      AND m.model_label = t.model_label
     ORDER BY COALESCE(t.total_tokens_input, 0) DESC, COALESCE(t.model_label, m.model_label);
END;
$$ LANGUAGE plpgsql;

DROP FUNCTION IF EXISTS ${s}.cms_get_user_stats_by_model(BOOLEAN, TIMESTAMPTZ);
CREATE FUNCTION ${s}.cms_get_user_stats_by_model(
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
    turn_count                  BIGINT,
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
    WITH session_owner AS (
        SELECT
            sess.session_id,
            CASE
                WHEN sess.is_system THEN 'system'
                WHEN u.user_id IS NULL THEN 'unowned'
                ELSE 'user'
            END::TEXT AS owner_kind_value,
            u.provider AS owner_provider_value,
            u.subject AS owner_subject_value,
            u.email AS owner_email_value,
            u.display_name AS owner_display_name_value
        FROM ${s}.sessions sess
        LEFT JOIN ${s}.session_owners so ON so.session_id = sess.session_id
        LEFT JOIN ${s}.users u ON u.user_id = so.user_id
    ), token_rows AS (
        SELECT
            so.owner_kind_value, so.owner_provider_value, so.owner_subject_value, so.owner_email_value, so.owner_display_name_value,
            CASE
                WHEN NULLIF(BTRIM(t.reasoning_effort), '') IS NULL
                    THEN COALESCE(NULLIF(BTRIM(t.model), ''), '(unknown)')
                ELSE COALESCE(NULLIF(BTRIM(t.model), ''), '(unknown)') || ':' || BTRIM(t.reasoning_effort)
            END AS model_label,
            t.session_id,
            t.tokens_input, t.tokens_output, t.tokens_cache_read, t.tokens_cache_write
        FROM ${s}.session_turn_metrics t
        INNER JOIN ${s}.sessions sess ON sess.session_id = t.session_id
        INNER JOIN session_owner so ON so.session_id = t.session_id
        WHERE (p_include_deleted OR sess.deleted_at IS NULL)
          AND (p_since IS NULL OR t.started_at >= p_since)
        UNION ALL
        SELECT
            so.owner_kind_value, so.owner_provider_value, so.owner_subject_value, so.owner_email_value, so.owner_display_name_value,
            CASE
                WHEN NULLIF(BTRIM(m.reasoning_effort), '') IS NULL
                    THEN COALESCE(NULLIF(BTRIM(m.model), ''), '(unknown)')
                ELSE COALESCE(NULLIF(BTRIM(m.model), ''), '(unknown)') || ':' || BTRIM(m.reasoning_effort)
            END AS model_label,
            m.session_id,
            m.tokens_input, m.tokens_output, m.tokens_cache_read, m.tokens_cache_write
        FROM ${s}.session_metrics m
        INNER JOIN ${s}.sessions sess ON sess.session_id = m.session_id
        INNER JOIN session_owner so ON so.session_id = m.session_id
        WHERE (p_include_deleted OR m.deleted_at IS NULL)
          AND (p_since IS NULL OR m.created_at >= p_since)
          AND NOT EXISTS (
              SELECT 1 FROM ${s}.session_turn_metrics existing
              WHERE existing.session_id = m.session_id
          )
    ), token_rollup AS (
        SELECT
            owner_kind_value, owner_provider_value, owner_subject_value, owner_email_value, owner_display_name_value, model_label,
            ARRAY_AGG(DISTINCT session_id ORDER BY session_id) AS session_ids,
            COUNT(DISTINCT session_id)::INT AS session_count,
            COUNT(*)::BIGINT AS turn_count,
            COALESCE(SUM(tokens_input), 0)::BIGINT AS total_tokens_input,
            COALESCE(SUM(tokens_output), 0)::BIGINT AS total_tokens_output,
            COALESCE(SUM(tokens_cache_read), 0)::BIGINT AS total_tokens_cache_read,
            COALESCE(SUM(tokens_cache_write), 0)::BIGINT AS total_tokens_cache_write
        FROM token_rows
        GROUP BY owner_kind_value, owner_provider_value, owner_subject_value, owner_email_value, owner_display_name_value, model_label
    ), metric_rollup AS (
        SELECT
            so.owner_kind_value, so.owner_provider_value, so.owner_subject_value, so.owner_email_value, so.owner_display_name_value,
            CASE
                WHEN NULLIF(BTRIM(m.reasoning_effort), '') IS NULL
                    THEN COALESCE(NULLIF(BTRIM(m.model), ''), '(unknown)')
                ELSE COALESCE(NULLIF(BTRIM(m.model), ''), '(unknown)') || ':' || BTRIM(m.reasoning_effort)
            END AS model_label,
            ARRAY_AGG(DISTINCT m.session_id ORDER BY m.session_id) AS session_ids,
            COUNT(*)::INT AS session_count,
            COALESCE(SUM(m.snapshot_size_bytes), 0)::BIGINT AS total_snapshot_size_bytes,
            COALESCE(SUM(m.dehydration_count), 0)::INT AS total_dehydration_count,
            COALESCE(SUM(m.hydration_count), 0)::INT AS total_hydration_count,
            COALESCE(SUM(m.lossy_handoff_count), 0)::INT AS total_lossy_handoff_count,
            MIN(m.created_at) AS earliest_session_created_at
        FROM ${s}.session_metrics m
        INNER JOIN ${s}.sessions sess ON sess.session_id = m.session_id
        INNER JOIN session_owner so ON so.session_id = m.session_id
        WHERE (p_include_deleted OR m.deleted_at IS NULL)
          AND (p_since IS NULL OR m.created_at >= p_since)
        GROUP BY so.owner_kind_value, so.owner_provider_value, so.owner_subject_value, so.owner_email_value, so.owner_display_name_value, model_label
    )
    SELECT
        COALESCE(t.owner_kind_value, m.owner_kind_value) AS owner_kind,
        COALESCE(t.owner_provider_value, m.owner_provider_value) AS owner_provider,
        COALESCE(t.owner_subject_value, m.owner_subject_value) AS owner_subject,
        COALESCE(t.owner_email_value, m.owner_email_value) AS owner_email,
        COALESCE(t.owner_display_name_value, m.owner_display_name_value) AS owner_display_name,
        COALESCE(t.model_label, m.model_label) AS model,
        ARRAY(SELECT DISTINCT unnest(COALESCE(t.session_ids, ARRAY[]::TEXT[]) || COALESCE(m.session_ids, ARRAY[]::TEXT[])) ORDER BY 1) AS session_ids,
        COALESCE(t.session_count, m.session_count, 0)::INT AS session_count,
        COALESCE(t.turn_count, 0)::BIGINT AS turn_count,
        COALESCE(m.total_snapshot_size_bytes, 0)::BIGINT AS total_snapshot_size_bytes,
        COALESCE(m.total_dehydration_count, 0)::INT AS total_dehydration_count,
        COALESCE(m.total_hydration_count, 0)::INT AS total_hydration_count,
        COALESCE(m.total_lossy_handoff_count, 0)::INT AS total_lossy_handoff_count,
        COALESCE(t.total_tokens_input, 0)::BIGINT AS total_tokens_input,
        COALESCE(t.total_tokens_output, 0)::BIGINT AS total_tokens_output,
        COALESCE(t.total_tokens_cache_read, 0)::BIGINT AS total_tokens_cache_read,
        COALESCE(t.total_tokens_cache_write, 0)::BIGINT AS total_tokens_cache_write,
        m.earliest_session_created_at AS earliest_session_created_at
    FROM token_rollup t
    FULL OUTER JOIN metric_rollup m
    ON m.owner_kind_value = t.owner_kind_value
     AND m.owner_provider_value IS NOT DISTINCT FROM t.owner_provider_value
     AND m.owner_subject_value IS NOT DISTINCT FROM t.owner_subject_value
      AND m.model_label = t.model_label
     ORDER BY COALESCE(t.total_tokens_input, 0) DESC, COALESCE(t.model_label, m.model_label);
END;
$$ LANGUAGE plpgsql;
`;
}

// ─── Migration 0023: Turn Metrics Stats Fallbacks And Group Owner Patch ───
function migration_0023_turn_metrics_stats_fallbacks_and_group_owner_patch(schema: string): string {
    // Migration 0022 was deployed before these stored-procedure fixes landed.
    // Its SQL is idempotent, so reapplying the corrected procedure layer under
    // a new version updates already-migrated schemas without requiring a reset.
    return migration_0022_turn_metrics_reasoning_effort(schema);
}

// ─── Migration 0024: Stop Turn Active Turn Index ──────────────────
function migration_0024_stop_turn_active_turn_index(schema: string): string {
    const s = `"${schema}"`;
    return `
-- 0024_stop_turn_active_turn_index: track the in-flight turn index on the
-- sessions row so stopSessionTurn() can address the turn-scoped stop queue
-- (stopTurn.<turnIndex>). Written by the runTurn activity's pre-turn
-- writeback; cleared by the post-turn writeback and by any state transition
-- away from 'running' (stop-turn plan, docs/proposals-impl/stop-button-turn-abort-plan.md).

ALTER TABLE ${s}.sessions ADD COLUMN IF NOT EXISTS active_turn_index INTEGER;

-- ── cms_set_active_turn_index ─────────────────────────────────────
-- Pre-turn: publish the in-flight turn index.
CREATE OR REPLACE FUNCTION ${s}.cms_set_active_turn_index(
    p_session_id TEXT,
    p_turn_index INTEGER
) RETURNS VOID AS $$
BEGIN
    UPDATE ${s}.sessions
    SET active_turn_index = p_turn_index,
        updated_at = now()
    WHERE session_id = p_session_id;
END;
$$ LANGUAGE plpgsql;

-- ── cms_get_session ──────────────────────────────────────────────
-- Same as the owner-join version, plus active_turn_index in the returned
-- column set (RETURNS TABLE is a fixed list — new table columns are not
-- returned automatically). stopSessionTurn() reads it for the pre-check and
-- the turn-scoped stop queue name.
DROP FUNCTION IF EXISTS ${s}.cms_get_session(TEXT);
CREATE FUNCTION ${s}.cms_get_session(
    p_session_id TEXT
) RETURNS TABLE (
    session_id         TEXT,
    orchestration_id   TEXT,
    title              TEXT,
    title_locked       BOOLEAN,
    state              TEXT,
    model              TEXT,
    reasoning_effort   TEXT,
    group_id           TEXT,
    short_summary      TEXT,
    summary_state      JSONB,
    summary_updated_at TIMESTAMPTZ,
    created_at         TIMESTAMPTZ,
    updated_at         TIMESTAMPTZ,
    last_active_at     TIMESTAMPTZ,
    deleted_at         TIMESTAMPTZ,
    current_iteration  INTEGER,
    last_error         TEXT,
    parent_session_id  TEXT,
    wait_reason        TEXT,
    is_system          BOOLEAN,
    agent_id           TEXT,
    splash             TEXT,
    owner_provider     TEXT,
    owner_subject      TEXT,
    owner_email        TEXT,
    owner_display_name TEXT,
    active_turn_index  INTEGER
) AS $$
BEGIN
    RETURN QUERY
    SELECT
        sess.session_id,
        sess.orchestration_id,
        sess.title,
        sess.title_locked,
        sess.state,
        sess.model,
        sess.reasoning_effort,
        sess.group_id,
        sess.short_summary,
        sess.summary_state,
        sess.summary_updated_at,
        sess.created_at,
        sess.updated_at,
        sess.last_active_at,
        sess.deleted_at,
        sess.current_iteration,
        sess.last_error,
        sess.parent_session_id,
        sess.wait_reason,
        sess.is_system,
        sess.agent_id,
        sess.splash,
        u.provider AS owner_provider,
        u.subject AS owner_subject,
        u.email AS owner_email,
        u.display_name AS owner_display_name,
        sess.active_turn_index
    FROM ${s}.sessions sess
    LEFT JOIN ${s}.session_owners so ON so.session_id = sess.session_id
    LEFT JOIN ${s}.users u ON u.user_id = so.user_id
    WHERE sess.session_id = p_session_id AND sess.deleted_at IS NULL;
END;
$$ LANGUAGE plpgsql;

-- ── cms_update_session ───────────────────────────────────────────
-- Same as 0022/0023, plus: any state transition away from 'running' clears
-- active_turn_index, so the orchestration's authoritative stop bookkeeping
-- (updateCmsState idle) and error transitions retire the stop-queue target.
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
        reasoning_effort  = CASE WHEN p_updates ? 'reasoningEffort' THEN NULLIF(BTRIM(p_updates->>'reasoningEffort'), '')          ELSE reasoning_effort  END,
        last_active_at    = CASE WHEN p_updates ? 'lastActiveAt'    THEN (p_updates->>'lastActiveAt')::TIMESTAMPTZ                 ELSE last_active_at    END,
        current_iteration = CASE WHEN p_updates ? 'currentIteration' THEN (p_updates->>'currentIteration')::INT                   ELSE current_iteration END,
        last_error        = CASE WHEN p_updates ? 'lastError'       THEN (p_updates->>'lastError')                                 ELSE last_error        END,
        wait_reason       = CASE WHEN p_updates ? 'waitReason'      THEN (p_updates->>'waitReason')                                ELSE wait_reason       END,
        is_system         = CASE WHEN p_updates ? 'isSystem'        THEN (p_updates->>'isSystem')::BOOLEAN                         ELSE is_system         END,
        agent_id          = CASE WHEN p_updates ? 'agentId'         THEN (p_updates->>'agentId')                                   ELSE agent_id          END,
        splash            = CASE WHEN p_updates ? 'splash'          THEN (p_updates->>'splash')                                    ELSE splash            END,
        active_turn_index = CASE WHEN (p_updates ? 'state') AND (p_updates->>'state') <> 'running' THEN NULL                       ELSE active_turn_index END,
        group_id          = group_id,
        updated_at        = now()
    WHERE session_id = p_session_id;

    IF p_updates ? 'groupId' THEN
        PERFORM ${s}.cms_assign_session_group(p_session_id, p_updates->>'groupId');
    END IF;

    UPDATE ${s}.session_metrics
    SET model = CASE WHEN p_updates ? 'model' THEN (p_updates->>'model') ELSE model END,
        reasoning_effort = CASE WHEN p_updates ? 'reasoningEffort' THEN NULLIF(BTRIM(p_updates->>'reasoningEffort'), '') ELSE reasoning_effort END,
        updated_at = CASE WHEN p_updates ? 'model' OR p_updates ? 'reasoningEffort' THEN now() ELSE updated_at END
    WHERE session_id = p_session_id
      AND (p_updates ? 'model' OR p_updates ? 'reasoningEffort');
END;
$$ LANGUAGE plpgsql;

-- ── cms_complete_turn_writeback ───────────────────────────────────
-- Same as 0022/0023, plus: the turn ended, so always clear active_turn_index.
CREATE OR REPLACE FUNCTION ${s}.cms_complete_turn_writeback(
    p_session_id         TEXT,
    p_agent_id           TEXT,
    p_model              TEXT,
    p_reasoning_effort   TEXT,
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
    p_tool_names         TEXT[],
    p_result_type        TEXT,
    p_error_message      TEXT,
    p_worker_node_id     TEXT,
    p_state              TEXT,
    p_last_active_at     TIMESTAMPTZ,
    p_last_error         TEXT,
    p_wait_reason        TEXT,
    p_current_iteration  INTEGER
) RETURNS VOID AS $$
DECLARE
    v_reasoning_effort TEXT := NULLIF(BTRIM(p_reasoning_effort), '');
    v_ended_at TIMESTAMPTZ := COALESCE(p_ended_at, now());
    v_started_at TIMESTAMPTZ := COALESCE(p_started_at, v_ended_at);
    v_duration_ms INTEGER := GREATEST(0, COALESCE(p_duration_ms, FLOOR(EXTRACT(EPOCH FROM (v_ended_at - v_started_at)) * 1000)::INT));
BEGIN
    UPDATE ${s}.sessions
    SET state = COALESCE(p_state, state),
        last_active_at = COALESCE(p_last_active_at, v_ended_at),
        current_iteration = COALESCE(p_current_iteration, current_iteration),
        last_error = p_last_error,
        wait_reason = p_wait_reason,
        active_turn_index = NULL,
        updated_at = now()
    WHERE session_id = p_session_id;

    INSERT INTO ${s}.session_metrics (
        session_id, agent_id, model, reasoning_effort,
        tokens_input, tokens_output, tokens_cache_read, tokens_cache_write
    ) VALUES (
        p_session_id, p_agent_id, p_model, v_reasoning_effort,
        COALESCE(p_tokens_input, 0), COALESCE(p_tokens_output, 0),
        COALESCE(p_tokens_cache_read, 0), COALESCE(p_tokens_cache_write, 0)
    )
    ON CONFLICT (session_id) DO UPDATE SET
        agent_id = COALESCE(${s}.session_metrics.agent_id, EXCLUDED.agent_id),
        model = COALESCE(EXCLUDED.model, ${s}.session_metrics.model),
        reasoning_effort = COALESCE(EXCLUDED.reasoning_effort, ${s}.session_metrics.reasoning_effort),
        tokens_input = ${s}.session_metrics.tokens_input + EXCLUDED.tokens_input,
        tokens_output = ${s}.session_metrics.tokens_output + EXCLUDED.tokens_output,
        tokens_cache_read = ${s}.session_metrics.tokens_cache_read + EXCLUDED.tokens_cache_read,
        tokens_cache_write = ${s}.session_metrics.tokens_cache_write + EXCLUDED.tokens_cache_write,
        updated_at = now();

    INSERT INTO ${s}.session_turn_metrics (
        session_id, agent_id, model, reasoning_effort, turn_index,
        started_at, ended_at, duration_ms,
        tokens_input, tokens_output, tokens_cache_read, tokens_cache_write,
        tool_calls, tool_errors, result_type, error_message, worker_node_id
    ) VALUES (
        p_session_id, p_agent_id, p_model, v_reasoning_effort, COALESCE(p_turn_index, 0),
        v_started_at, v_ended_at, v_duration_ms,
        COALESCE(p_tokens_input, 0), COALESCE(p_tokens_output, 0),
        COALESCE(p_tokens_cache_read, 0), COALESCE(p_tokens_cache_write, 0),
        COALESCE(p_tool_calls, 0), COALESCE(p_tool_errors, 0),
        p_result_type, p_error_message, p_worker_node_id
    );

    INSERT INTO ${s}.session_events (session_id, event_type, data, worker_node_id)
    VALUES (
        p_session_id,
        'session.turn_completed',
        jsonb_build_object(
            'iteration', COALESCE(p_turn_index, 0),
            'turnIndex', COALESCE(p_turn_index, 0),
            'model', p_model,
            'reasoningEffort', v_reasoning_effort,
            'startedAt', v_started_at,
            'endedAt', v_ended_at,
            'durationMs', v_duration_ms,
            'tokensInput', COALESCE(p_tokens_input, 0),
            'tokensOutput', COALESCE(p_tokens_output, 0),
            'tokensCacheRead', COALESCE(p_tokens_cache_read, 0),
            'tokensCacheWrite', COALESCE(p_tokens_cache_write, 0),
            'toolCalls', COALESCE(p_tool_calls, 0),
            'toolErrors', COALESCE(p_tool_errors, 0),
            'toolNames', to_jsonb(COALESCE(p_tool_names, ARRAY[]::TEXT[])),
            'resultType', p_result_type,
            'errorMessage', p_error_message,
            'workerNodeId', p_worker_node_id
        ),
        p_worker_node_id
    );
END;
$$ LANGUAGE plpgsql;
`;
}
