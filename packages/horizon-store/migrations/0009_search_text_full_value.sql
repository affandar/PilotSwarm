-- 0009_search_text_full_value — make lexical/BM25 search follow the public
-- store_fact contract.
--
-- The original generated search_text column indexed only a handful of
-- conventional JSON fields (name, description, text, body, subject). The
-- store_fact tool accepts any JSON-serializable value, and migration 0007
-- already moved embedding input to key + value::text for that reason. This
-- migration brings lexical search into the same shape so facts with fields such
-- as content, summary, detail, problem, or arbitrary nested JSON are searchable.
--
-- Tokens: {{SCHEMA}}.

DROP FUNCTION IF EXISTS "{{SCHEMA}}".facts_search_lexical(TEXT, TEXT, TEXT[], BOOLEAN, TEXT, TEXT, TEXT[], INT);
DROP INDEX IF EXISTS "{{SCHEMA}}".idx_facts_lexical;

ALTER TABLE "{{SCHEMA}}".facts DROP COLUMN IF EXISTS search_text;
ALTER TABLE "{{SCHEMA}}".facts ADD COLUMN search_text TEXT GENERATED ALWAYS AS (
    coalesce(key, '') || E'\n' || coalesce(value::text, '')
) STORED;

CREATE EXTENSION IF NOT EXISTS pg_textsearch;

CREATE INDEX IF NOT EXISTS idx_facts_lexical
    ON "{{SCHEMA}}".facts USING bm25 (search_text) WITH (text_config = 'english');

CREATE OR REPLACE FUNCTION "{{SCHEMA}}".facts_search_lexical(
    p_query        TEXT,
    p_reader       TEXT,
    p_granted      TEXT[],
    p_unrestricted BOOLEAN,
    p_scope        TEXT,
    p_ns_prefix    TEXT,
    p_tags         TEXT[],
    p_pool         INT
) RETURNS TABLE (
    scope_key TEXT, key TEXT, value JSONB, agent_id TEXT, session_id TEXT,
    shared BOOLEAN, tags TEXT[], created_at TIMESTAMPTZ, updated_at TIMESTAMPTZ,
    rank DOUBLE PRECISION
)
LANGUAGE sql STABLE AS $$
    SELECT f.scope_key, f.key, f.value, f.agent_id, f.session_id,
           f.shared, f.tags, f.created_at, f.updated_at,
           (-(f.search_text <@> q.bq))::double precision AS rank
    FROM "{{SCHEMA}}".facts f,
         (SELECT to_bm25query(p_query, '{{SCHEMA}}.idx_facts_lexical') AS bq) q
    WHERE (f.search_text <@> q.bq) < 0
      AND "{{SCHEMA}}".facts_acl(f.shared, f.session_id, p_reader, p_granted, p_unrestricted, p_scope)
      AND (p_ns_prefix IS NULL OR f.key LIKE p_ns_prefix)
      AND (p_tags IS NULL OR f.tags @> p_tags)
    ORDER BY f.search_text <@> q.bq ASC
    LIMIT p_pool;
$$;
