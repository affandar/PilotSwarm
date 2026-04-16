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
