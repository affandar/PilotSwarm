/**
 * CMS Migration definitions — ordered SQL migrations for the session catalog.
 *
 * Each migration is a function of schema name → SQL string so that the schema
 * placeholder is resolved at runtime (supporting isolated test schemas).
 *
 * @module
 */

import type { MigrationEntry } from "./cms-migrator.js";

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
