/**
 * Facts Migration definitions — ordered SQL migrations for the facts store.
 *
 * Each migration is a function of schema name → SQL string so that the schema
 * placeholder is resolved at runtime (supporting isolated test schemas).
 *
 * @module
 */

import type { MigrationEntry } from "./pg-migrator.js";

/**
 * Return the ordered list of Facts migrations for a given schema.
 */
export function FACTS_MIGRATIONS(schema: string): MigrationEntry[] {
    return [
        {
            version: "0001",
            name: "baseline",
            sql: migration_0001_baseline(schema),
        },
        {
            version: "0002",
            name: "stored_procedures",
            sql: migration_0002_stored_procedures(schema),
        },
    ];
}

// ─── Migration 0001: Baseline ────────────────────────────────────

function migration_0001_baseline(schema: string): string {
    const table = `${schema}.facts`;
    return `
-- 0001_baseline: captures the facts schema as of v0.
-- All statements are idempotent.

CREATE TABLE IF NOT EXISTS ${table} (
    id          BIGSERIAL PRIMARY KEY,
    scope_key   TEXT NOT NULL UNIQUE,
    key         TEXT NOT NULL,
    value       JSONB NOT NULL,
    agent_id    TEXT,
    session_id  TEXT,
    shared      BOOLEAN NOT NULL DEFAULT FALSE,
    transient   BOOLEAN NOT NULL DEFAULT FALSE,
    tags        TEXT[] NOT NULL DEFAULT '{}',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (NOT (shared AND transient))
);

CREATE INDEX IF NOT EXISTS idx_${schema}_facts_key ON ${table}(key);
CREATE INDEX IF NOT EXISTS idx_${schema}_facts_tags ON ${table} USING GIN (tags);
CREATE INDEX IF NOT EXISTS idx_${schema}_facts_session ON ${table}(session_id);
CREATE INDEX IF NOT EXISTS idx_${schema}_facts_agent ON ${table}(agent_id);
CREATE INDEX IF NOT EXISTS idx_${schema}_facts_shared ON ${table}(shared);
CREATE INDEX IF NOT EXISTS idx_${schema}_facts_transient ON ${table}(transient);

-- Column migrations (idempotent for existing DBs that predate scope_key)
ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS scope_key TEXT;
ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS shared BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS transient BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS tags TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

-- Backfill scope_key for rows that predate it
UPDATE ${table}
SET scope_key = CASE
    WHEN shared THEN 'shared:' || key
    ELSE 'session:' || COALESCE(session_id, '') || ':' || key
END
WHERE scope_key IS NULL;
`;
}

// ─── Migration 0002: Stored Procedures ───────────────────────────

function migration_0002_stored_procedures(schema: string): string {
    const table = `${schema}.facts`;
    return `
-- 0002_stored_procedures: all data-access for the facts store moves behind functions.

-- ── facts_store_fact ─────────────────────────────────────────────
CREATE OR REPLACE FUNCTION ${schema}.facts_store_fact(
    p_scope_key  TEXT,
    p_key        TEXT,
    p_value      JSONB,
    p_agent_id   TEXT,
    p_session_id TEXT,
    p_shared     BOOLEAN,
    p_transient  BOOLEAN,
    p_tags       TEXT[]
) RETURNS VOID AS $$
BEGIN
    INSERT INTO ${table}
        (scope_key, key, value, agent_id, session_id, shared, transient, tags)
    VALUES
        (p_scope_key, p_key, p_value, p_agent_id, p_session_id, p_shared, p_transient, p_tags)
    ON CONFLICT (scope_key) DO UPDATE SET
        value      = EXCLUDED.value,
        agent_id   = EXCLUDED.agent_id,
        session_id = EXCLUDED.session_id,
        shared     = EXCLUDED.shared,
        transient  = EXCLUDED.transient,
        tags       = EXCLUDED.tags,
        updated_at = now();
END;
$$ LANGUAGE plpgsql;

-- ── facts_read_facts ─────────────────────────────────────────────
CREATE OR REPLACE FUNCTION ${schema}.facts_read_facts(
    p_scope              TEXT,
    p_reader_session_id  TEXT,
    p_granted_ids        TEXT[],
    p_key_pattern        TEXT,
    p_tags               TEXT[],
    p_session_id         TEXT,
    p_agent_id           TEXT,
    p_limit              INT
) RETURNS TABLE (
    key        TEXT,
    value      JSONB,
    agent_id   TEXT,
    session_id TEXT,
    shared     BOOLEAN,
    tags       TEXT[],
    created_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ
) AS $$
DECLARE
    base_sql TEXT;
    where_clauses TEXT[] := ARRAY[]::TEXT[];
    final_sql TEXT;
BEGIN
    base_sql := 'SELECT f.key, f.value, f.agent_id, f.session_id, f.shared, f.tags, f.created_at, f.updated_at FROM ${table} f WHERE ';

    -- Scope filter
    IF p_scope = 'shared' THEN
        where_clauses := array_append(where_clauses, 'f.shared = TRUE');
    ELSIF p_scope = 'session' THEN
        IF p_reader_session_id IS NULL THEN
            RETURN;
        END IF;
        where_clauses := array_append(where_clauses,
            'f.shared = FALSE AND f.session_id = ' || quote_literal(p_reader_session_id));
    ELSIF p_reader_session_id IS NOT NULL THEN
        -- "accessible" or "descendants"
        DECLARE
            vis_parts TEXT[] := ARRAY[
                'f.shared = TRUE',
                '(f.shared = FALSE AND f.session_id = ' || quote_literal(p_reader_session_id) || ')'
            ];
        BEGIN
            IF p_granted_ids IS NOT NULL AND array_length(p_granted_ids, 1) > 0 THEN
                vis_parts := array_append(vis_parts,
                    '(f.shared = FALSE AND f.session_id = ANY(' || quote_literal(p_granted_ids)::TEXT || '::TEXT[]))');
            END IF;
            where_clauses := array_append(where_clauses, '(' || array_to_string(vis_parts, ' OR ') || ')');
        END;
    ELSE
        where_clauses := array_append(where_clauses, 'f.shared = TRUE');
    END IF;

    -- Optional filters
    IF p_key_pattern IS NOT NULL THEN
        where_clauses := array_append(where_clauses,
            'f.key LIKE ' || quote_literal(p_key_pattern));
    END IF;
    IF p_tags IS NOT NULL AND array_length(p_tags, 1) > 0 THEN
        where_clauses := array_append(where_clauses,
            'f.tags @> ' || quote_literal(p_tags)::TEXT || '::TEXT[]');
    END IF;
    IF p_session_id IS NOT NULL THEN
        where_clauses := array_append(where_clauses,
            'f.session_id = ' || quote_literal(p_session_id));
    END IF;
    IF p_agent_id IS NOT NULL THEN
        where_clauses := array_append(where_clauses,
            'f.agent_id = ' || quote_literal(p_agent_id));
    END IF;

    final_sql := base_sql || array_to_string(where_clauses, ' AND ')
        || ' ORDER BY f.updated_at DESC LIMIT ' || p_limit;

    RETURN QUERY EXECUTE final_sql;
END;
$$ LANGUAGE plpgsql;

-- ── facts_delete_fact ────────────────────────────────────────────
CREATE OR REPLACE FUNCTION ${schema}.facts_delete_fact(
    p_scope_key TEXT
) RETURNS BIGINT AS $$
DECLARE
    deleted_count BIGINT;
BEGIN
    DELETE FROM ${table} WHERE scope_key = p_scope_key;
    GET DIAGNOSTICS deleted_count = ROW_COUNT;
    RETURN deleted_count;
END;
$$ LANGUAGE plpgsql;

-- ── facts_delete_session_facts ───────────────────────────────────
CREATE OR REPLACE FUNCTION ${schema}.facts_delete_session_facts(
    p_session_id TEXT
) RETURNS BIGINT AS $$
DECLARE
    deleted_count BIGINT;
BEGIN
    DELETE FROM ${table}
    WHERE session_id = p_session_id
      AND shared = FALSE;
    GET DIAGNOSTICS deleted_count = ROW_COUNT;
    RETURN deleted_count;
END;
$$ LANGUAGE plpgsql;
`;
}
