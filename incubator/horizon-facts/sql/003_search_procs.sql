-- 003_search_procs.sql
-- Enhanced retrieval procs. The CRITICAL invariant: these produce candidate
-- scope_keys via lexical/semantic/graph signals, but value + visibility are
-- ALWAYS resolved through the same ACL-bearing facts read path. A search can
-- only ever narrow what a caller could already read.
--
-- Usage: psql "$HORIZON_DATABASE_URL" -v schema=horizon_facts_poc -f 003_search_procs.sql

\set schema horizon_facts_poc

-- ── Lexical candidates (Phase 1) ────────────────────────────────────────────
-- Returns (scope_key, lexical_score). Caller fuses + ACL-filters.
CREATE OR REPLACE FUNCTION :"schema".facts_lexical_candidates(
    p_query        TEXT,
    p_namespace    TEXT,    -- optional 'skills/%' style prefix, NULL = any
    p_limit        INT
) RETURNS TABLE (scope_key TEXT, lexical_score REAL) AS $$
BEGIN
    RETURN QUERY
    SELECT f.scope_key,
           ts_rank(f.search_tsv, websearch_to_tsquery('english', p_query)) AS lexical_score
    FROM :"schema".facts f
    WHERE f.search_tsv @@ websearch_to_tsquery('english', p_query)
      AND (p_namespace IS NULL OR f.key LIKE p_namespace)
    ORDER BY lexical_score DESC
    LIMIT p_limit;
END;
$$ LANGUAGE plpgsql STABLE;

-- ── Semantic candidates (Phase 2) ───────────────────────────────────────────
-- p_query_embedding is produced by the AI pipeline / embedding model for the
-- query string. Returns (scope_key, cosine_similarity in 0..1).
CREATE OR REPLACE FUNCTION :"schema".facts_semantic_candidates(
    p_query_embedding vector(1536),
    p_namespace       TEXT,
    p_min_score       REAL,   -- discard below this cosine similarity
    p_limit           INT
) RETURNS TABLE (scope_key TEXT, semantic_score REAL) AS $$
BEGIN
    RETURN QUERY
    SELECT f.scope_key,
           (1 - (f.embedding <=> p_query_embedding))::REAL AS semantic_score
    FROM :"schema".facts f
    WHERE f.embedding IS NOT NULL
      AND (p_namespace IS NULL OR f.key LIKE p_namespace)
      AND (1 - (f.embedding <=> p_query_embedding)) >= p_min_score
    ORDER BY f.embedding <=> p_query_embedding ASC   -- nearest first
    LIMIT p_limit;
END;
$$ LANGUAGE plpgsql STABLE;

-- ── ACL resolution (unchanged governance) ───────────────────────────────────
-- Given a set of candidate scope_keys, return only those the caller may see,
-- with full values. This mirrors PilotSwarm's facts_read_facts visibility:
--   shared OR own-session OR granted-lineage-session.
-- (In integration this delegates to the real facts_read_facts; standalone PoC
-- implements the same predicate so the invariant is demonstrable.)
CREATE OR REPLACE FUNCTION :"schema".facts_resolve_visible(
    p_scope_keys        TEXT[],
    p_reader_session_id TEXT,
    p_granted_ids       TEXT[],
    p_unrestricted      BOOLEAN
) RETURNS TABLE (
    scope_key  TEXT,
    key        TEXT,
    value      JSONB,
    agent_id   TEXT,
    session_id TEXT,
    shared     BOOLEAN,
    tags       TEXT[],
    created_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ
) AS $$
BEGIN
    RETURN QUERY
    SELECT f.scope_key, f.key, f.value, f.agent_id, f.session_id,
           f.shared, f.tags, f.created_at, f.updated_at
    FROM :"schema".facts f
    WHERE f.scope_key = ANY(p_scope_keys)
      AND (
        p_unrestricted
        OR f.shared = TRUE
        OR (f.shared = FALSE AND f.session_id = p_reader_session_id)
        OR (f.shared = FALSE AND p_granted_ids IS NOT NULL
            AND f.session_id = ANY(p_granted_ids))
      );
END;
$$ LANGUAGE plpgsql STABLE;

-- NOTE: Fusion across lexical/semantic/graph candidates happens in the
-- application layer (src/query-builder.ts) so it stays unit-testable and we can
-- A/B weighted-normalization vs RRF. The procs above are deliberately
-- single-signal; the adapter calls them, fuses, then calls facts_resolve_visible.
