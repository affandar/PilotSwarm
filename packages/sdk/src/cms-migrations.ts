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
