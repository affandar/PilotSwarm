-- 0004_facts_procs — ALL relational + vector data access (03-design §1: no
-- inline SQL in the provider; the 04 §6 M1 grep guard enforces it).
--
-- ACL convention (every read): the access predicate is part of the WHERE
-- clause, evaluated BEFORE ranking/LIMIT (01 §4.2 — never a post-filter).
-- Parameters: p_reader (caller session), p_granted (spawn-tree session ids),
-- p_unrestricted, p_scope ('accessible'|'shared'|'session'|'descendants').
--
-- Tokens: {{SCHEMA}}.

-- ── write ────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION "{{SCHEMA}}".facts_store(
    p_scope_key  TEXT,
    p_key        TEXT,
    p_value      JSONB,
    p_agent_id   TEXT,
    p_session_id TEXT,
    p_shared     BOOLEAN,
    p_tags       TEXT[]
) RETURNS void
LANGUAGE sql AS $$
    INSERT INTO "{{SCHEMA}}".facts (scope_key, key, value, agent_id, session_id, shared, transient, tags, updated_at)
    VALUES (p_scope_key, p_key, p_value, p_agent_id, p_session_id, p_shared, NOT p_shared, coalesce(p_tags, '{}'), now())
    ON CONFLICT (scope_key) DO UPDATE SET
        value = EXCLUDED.value, agent_id = EXCLUDED.agent_id, tags = EXCLUDED.tags,
        shared = EXCLUDED.shared, transient = EXCLUDED.transient, updated_at = now();
$$;

CREATE OR REPLACE FUNCTION "{{SCHEMA}}".facts_delete(p_scope_key TEXT) RETURNS boolean
LANGUAGE sql AS $$
    WITH del AS (DELETE FROM "{{SCHEMA}}".facts WHERE scope_key = p_scope_key RETURNING 1)
    SELECT count(*) > 0 FROM del;
$$;

CREATE OR REPLACE FUNCTION "{{SCHEMA}}".facts_delete_session(p_session_id TEXT) RETURNS int
LANGUAGE sql AS $$
    WITH del AS (DELETE FROM "{{SCHEMA}}".facts WHERE shared = FALSE AND session_id = p_session_id RETURNING 1)
    SELECT count(*)::int FROM del;
$$;

-- ── ACL predicate (shared by the read/search procs) ─────────────────────────

CREATE OR REPLACE FUNCTION "{{SCHEMA}}".facts_acl(
    f_shared BOOLEAN, f_session_id TEXT,
    p_reader TEXT, p_granted TEXT[], p_unrestricted BOOLEAN, p_scope TEXT
) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
    SELECT CASE
        WHEN p_unrestricted THEN TRUE
        WHEN p_scope = 'shared' THEN f_shared
        WHEN p_scope = 'session' THEN (NOT f_shared AND f_session_id = p_reader)
        WHEN p_scope = 'descendants' THEN (NOT f_shared AND f_session_id = ANY (coalesce(p_granted, '{}')))
        ELSE (f_shared OR f_session_id = p_reader OR f_session_id = ANY (coalesce(p_granted, '{}')))
    END;
$$;

-- ── read ─────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION "{{SCHEMA}}".facts_read(
    p_reader       TEXT,
    p_granted      TEXT[],
    p_unrestricted BOOLEAN,
    p_scope        TEXT,
    p_key_pattern  TEXT,
    p_scope_keys   TEXT[],
    p_tags         TEXT[],
    p_agent_id     TEXT,
    p_limit        INT
) RETURNS SETOF "{{SCHEMA}}".facts
LANGUAGE sql STABLE AS $$
    SELECT f.* FROM "{{SCHEMA}}".facts f
    WHERE "{{SCHEMA}}".facts_acl(f.shared, f.session_id, p_reader, p_granted, p_unrestricted, p_scope)
      AND (p_key_pattern IS NULL OR f.key LIKE p_key_pattern)
      AND (p_scope_keys IS NULL OR f.scope_key = ANY (p_scope_keys))
      AND (p_tags IS NULL OR f.tags @> p_tags)
      AND (p_agent_id IS NULL OR f.agent_id = p_agent_id)
    ORDER BY f.updated_at DESC
    LIMIT p_limit;
$$;

-- ── stats (namespace-bucketed, in SQL — not in Node) ─────────────────────────

CREATE OR REPLACE FUNCTION "{{SCHEMA}}".facts_stats(
    p_mode        TEXT,        -- 'session' | 'sessions' | 'shared'
    p_session_ids TEXT[]
) RETURNS TABLE (
    namespace TEXT, fact_count BIGINT, total_value_bytes BIGINT,
    oldest_created_at TIMESTAMPTZ, newest_updated_at TIMESTAMPTZ
)
LANGUAGE sql STABLE AS $$
    SELECT
        CASE WHEN split_part(f.key, '/', 1) IN ('skills', 'asks', 'intake', 'config')
             THEN split_part(f.key, '/', 1) ELSE '(other)' END AS namespace,
        count(*) AS fact_count,
        sum(octet_length(f.value::text))::bigint AS total_value_bytes,
        min(f.created_at) AS oldest_created_at,
        max(f.updated_at) AS newest_updated_at
    FROM "{{SCHEMA}}".facts f
    WHERE CASE p_mode
        WHEN 'shared'   THEN f.shared
        WHEN 'session'  THEN (NOT f.shared AND f.session_id = p_session_ids[1])
        WHEN 'sessions' THEN (NOT f.shared AND f.session_id = ANY (coalesce(p_session_ids, '{}')))
        ELSE FALSE
    END
    GROUP BY 1;
$$;

-- ── lexical search (BM25 via pg_textsearch — verified on live HorizonDB) ────
-- `search_text <@> to_bm25query(q, idx)` yields the NEGATIVE BM25 score
-- (0 = no match), so: match ⇔ d < 0, rank = -d, best-first = ORDER BY d ASC.
-- The ACL predicate sits in the same WHERE — before ranking and LIMIT.

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

-- ── semantic search (pgvector cosine; model-matched rows only — 01 §5.2) ────

CREATE OR REPLACE FUNCTION "{{SCHEMA}}".facts_search_semantic(
    p_vec          vector,
    p_model        TEXT,
    p_reader       TEXT,
    p_granted      TEXT[],
    p_unrestricted BOOLEAN,
    p_scope        TEXT,
    p_ns_prefix    TEXT,
    p_tags         TEXT[],
    p_min          DOUBLE PRECISION,
    p_pool         INT
) RETURNS TABLE (
    scope_key TEXT, key TEXT, value JSONB, agent_id TEXT, session_id TEXT,
    shared BOOLEAN, tags TEXT[], created_at TIMESTAMPTZ, updated_at TIMESTAMPTZ,
    sim DOUBLE PRECISION
)
LANGUAGE sql STABLE AS $$
    SELECT f.scope_key, f.key, f.value, f.agent_id, f.session_id,
           f.shared, f.tags, f.created_at, f.updated_at,
           (1 - (f.embedding <=> p_vec))::double precision AS sim
    FROM "{{SCHEMA}}".facts f
    WHERE f.embedding IS NOT NULL
      AND f.embedding_model IS NOT DISTINCT FROM p_model     -- mismatched model ⇒ treated as NULL embedding
      AND "{{SCHEMA}}".facts_acl(f.shared, f.session_id, p_reader, p_granted, p_unrestricted, p_scope)
      AND (p_ns_prefix IS NULL OR f.key LIKE p_ns_prefix)
      AND (p_tags IS NULL OR f.tags @> p_tags)
      AND (1 - (f.embedding <=> p_vec)) >= coalesce(p_min, 0)
    ORDER BY f.embedding <=> p_vec ASC
    LIMIT p_pool;
$$;

-- ── similarFacts (kNN of a known fact; anchor ACL-checked IN the proc) ──────
-- An existing-but-inaccessible anchor yields zero rows, byte-identical to an
-- unknown key (01 §4.3 — no similarity oracle). Neighbours must carry the
-- anchor's embedding_model (cross-model vectors are not comparable); when
-- p_model is supplied (an endpoint is configured) the anchor must match it too.

CREATE OR REPLACE FUNCTION "{{SCHEMA}}".facts_similar(
    p_scope_key    TEXT,
    p_model        TEXT,
    p_reader       TEXT,
    p_granted      TEXT[],
    p_unrestricted BOOLEAN,
    p_scope        TEXT,
    p_ns_prefix    TEXT,
    p_min          DOUBLE PRECISION,
    p_k            INT
) RETURNS TABLE (
    scope_key TEXT, key TEXT, value JSONB, agent_id TEXT, session_id TEXT,
    shared BOOLEAN, tags TEXT[], created_at TIMESTAMPTZ, updated_at TIMESTAMPTZ,
    sim DOUBLE PRECISION
)
LANGUAGE sql STABLE AS $$
    WITH anchor AS (
        SELECT a.embedding, a.embedding_model
        FROM "{{SCHEMA}}".facts a
        WHERE a.scope_key = p_scope_key
          AND a.embedding IS NOT NULL
          AND (p_model IS NULL OR a.embedding_model IS NOT DISTINCT FROM p_model)
          AND "{{SCHEMA}}".facts_acl(a.shared, a.session_id, p_reader, p_granted, p_unrestricted, p_scope)
    )
    SELECT f.scope_key, f.key, f.value, f.agent_id, f.session_id,
           f.shared, f.tags, f.created_at, f.updated_at,
           (1 - (f.embedding <=> a.embedding))::double precision AS sim
    FROM "{{SCHEMA}}".facts f, anchor a
    WHERE f.scope_key <> p_scope_key
      AND f.embedding IS NOT NULL
      AND f.embedding_model IS NOT DISTINCT FROM a.embedding_model
      AND "{{SCHEMA}}".facts_acl(f.shared, f.session_id, p_reader, p_granted, p_unrestricted, p_scope)
      AND (p_ns_prefix IS NULL OR f.key LIKE p_ns_prefix)
      AND (1 - (f.embedding <=> a.embedding)) >= coalesce(p_min, 0)
    ORDER BY f.embedding <=> a.embedding ASC
    LIMIT p_k;
$$;

-- ── crawl tracking (PRIVILEGED harvester surface — 01 §6.6) ─────────────────
-- No access context: the crawler reads everything by design. The mark is
-- guarded against the read→mark TOCTOU race: a stamp applies only WHERE
-- content_hash still equals the supplied hash; mismatches are skipped.

CREATE OR REPLACE FUNCTION "{{SCHEMA}}".facts_read_uncrawled(
    p_ns_prefix TEXT,
    p_limit     INT
) RETURNS SETOF "{{SCHEMA}}".facts
LANGUAGE sql STABLE AS $$
    SELECT f.* FROM "{{SCHEMA}}".facts f
    WHERE f.last_crawled_at IS NULL
      AND (p_ns_prefix IS NULL OR f.key LIKE p_ns_prefix)
    ORDER BY f.id
    LIMIT p_limit;
$$;

CREATE OR REPLACE FUNCTION "{{SCHEMA}}".facts_mark_crawled(p_stamps JSONB)
RETURNS TABLE (marked INT, skipped INT)
LANGUAGE sql AS $$
    WITH stamps AS (
        SELECT e->>'scopeKey' AS scope_key, e->>'contentHash' AS content_hash
        FROM jsonb_array_elements(p_stamps) e
    ),
    upd AS (
        UPDATE "{{SCHEMA}}".facts f
           SET last_crawled_at = now()
          FROM stamps s
         WHERE f.scope_key = s.scope_key
           AND f.content_hash = s.content_hash
        RETURNING f.scope_key
    )
    SELECT (SELECT count(*) FROM upd)::int AS marked,
           ((SELECT count(*) FROM stamps) - (SELECT count(*) FROM upd))::int AS skipped;
$$;
