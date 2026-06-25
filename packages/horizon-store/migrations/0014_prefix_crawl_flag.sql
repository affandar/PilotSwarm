-- 0014_prefix_crawl_flag — multi-crawler Phase 1: prefix-scoped crawl flag.
--
-- Generalizes the single-crawler queue into N crawlers over DISJOINT key
-- prefixes. There is no registry / lock / per-crawler state here — that is the
-- Phase 2 design. Because each fact lives under exactly one crawler's prefix, no
-- two crawlers touch the same row, so the single shared last_crawled_at column
-- never contends.
--
--   - facts_like_prefix(text)     : escape % _ \ in a literal prefix so LIKE
--                                   matches it literally while still letting the
--                                   planner use a text_pattern_ops index range.
--   - facts_read_uncrawled        : param p_ns_prefix -> p_key_prefix, escaped
--                                   literal-prefix LIKE, ORDER BY key,id.
--   - facts_set_crawled_by_prefix : flip last_crawled_at for a whole literal prefix.
--   - facts_set_crawled_by_keys   : flip last_crawled_at for an explicit batch of
--                                   {scopeKey, etag?} receipts (1..500).
--   - facts_mark_crawled          : DROPPED — replaced by facts_set_crawled_by_keys.
--   - idx_facts_uncrawled_key     : (key text_pattern_ops, id) WHERE last_crawled_at IS NULL.
--
-- Crawl writes only touch last_crawled_at; facts_touch never bumps etag for a
-- last_crawled_at-only write, so a {scopeKey, etag} receipt survives a recrawl.
--
-- Tokens: {{SCHEMA}}.

-- Escape a literal key prefix into a LIKE pattern: backslash-escape the LIKE
-- metacharacters (\ % _) then append the trailing % wildcard. Pair with
-- `ESCAPE chr(92)` at the call site. chr(92) is a literal backslash; using it
-- avoids backslash-quoting ambiguity across SQL string forms.
CREATE OR REPLACE FUNCTION "{{SCHEMA}}".facts_like_prefix(p_prefix TEXT)
RETURNS TEXT LANGUAGE sql IMMUTABLE STRICT AS $$
    SELECT replace(replace(replace(p_prefix, chr(92), chr(92) || chr(92)),
                           '%', chr(92) || '%'), '_', chr(92) || '_') || '%';
$$;

-- Queue-prefix index: pending rows keyed by key for prefix range scans. The
-- text_pattern_ops opclass is required because the database collation is not C;
-- without it the LIKE-prefix range cannot use the index.
CREATE INDEX IF NOT EXISTS idx_facts_uncrawled_key
    ON "{{SCHEMA}}".facts (key text_pattern_ops, id)
    WHERE last_crawled_at IS NULL;

-- Read: pending facts (last_crawled_at IS NULL) across ALL scopes, narrowed by a
-- literal key prefix, oldest-first within the prefix. p_embedded_only is an
-- enhanced-store gate: skip live rows that have not embedded yet (tombstones
-- always surface so deletes can be reconciled).
DROP FUNCTION IF EXISTS "{{SCHEMA}}".facts_read_uncrawled(TEXT, INT, BOOLEAN);
CREATE OR REPLACE FUNCTION "{{SCHEMA}}".facts_read_uncrawled(
    p_key_prefix    TEXT,
    p_limit         INT,
    p_embedded_only BOOLEAN DEFAULT FALSE
) RETURNS SETOF "{{SCHEMA}}".facts
LANGUAGE sql STABLE AS $$
    SELECT f.* FROM "{{SCHEMA}}".facts f
    WHERE f.last_crawled_at IS NULL
      AND (p_key_prefix IS NULL
           OR f.key LIKE "{{SCHEMA}}".facts_like_prefix(p_key_prefix) ESCAPE chr(92))
      AND (f.deleted_at IS NOT NULL OR NOT p_embedded_only OR f.embedding IS NOT NULL)
    ORDER BY f.key, f.id
    LIMIT p_limit;
$$;

-- Prefix writer: flip last_crawled_at for a whole literal prefix.
--   crawled=true  : queued (NULL) -> now(); NEVER a tombstone (a blind flush
--                   must not turn unreconciled deletes into purgeable rows).
--   crawled=false : crawled -> NULL (recrawl); tombstones included.
-- affected = rows that changed state. skipped = rows that matched the prefix
-- selector but were already in the requested state. An empty prefix is a no-op
-- (defence in depth; the provider/tool layer rejects it outright).
CREATE OR REPLACE FUNCTION "{{SCHEMA}}".facts_set_crawled_by_prefix(
    p_key_prefix TEXT,
    p_crawled    BOOLEAN
) RETURNS TABLE (affected INT, skipped INT)
LANGUAGE sql AS $$
    WITH matched AS (
        SELECT f.id
        FROM "{{SCHEMA}}".facts f
        WHERE p_key_prefix IS NOT NULL
          AND p_key_prefix <> ''
          AND f.key LIKE "{{SCHEMA}}".facts_like_prefix(p_key_prefix) ESCAPE chr(92)
          AND (NOT p_crawled OR f.deleted_at IS NULL)
    ), upd AS (
        UPDATE "{{SCHEMA}}".facts f
           SET last_crawled_at = CASE WHEN p_crawled THEN now() ELSE NULL END
          FROM matched m
         WHERE f.id = m.id
           AND ( (p_crawled     AND f.last_crawled_at IS NULL)
              OR (NOT p_crawled AND f.last_crawled_at IS NOT NULL) )
        RETURNING f.id
    )
    SELECT (SELECT count(*) FROM upd)::int AS affected,
           ((SELECT count(*) FROM matched) - (SELECT count(*) FROM upd))::int AS skipped;
$$;

-- Explicit-batch writer: 1..500 {scopeKey, etag?} receipts.
--   with etag    : conditional — facts.etag must match, else skipped.
--   without etag : unconditional stomp of that key's crawl flag.
-- affected = rows that changed state. skipped = an existing fact matched the
-- scopeKey but did not change (etag mismatch, or already in the requested
-- state). A non-existent scopeKey is neither affected nor skipped.
CREATE OR REPLACE FUNCTION "{{SCHEMA}}".facts_set_crawled_by_keys(
    p_keys    JSONB,
    p_crawled BOOLEAN
) RETURNS TABLE (affected INT, skipped INT)
LANGUAGE plpgsql AS $$
DECLARE
    v_count INT;
    v_bad   BOOLEAN;
    v_dup   BOOLEAN;
BEGIN
    IF jsonb_typeof(p_keys) IS DISTINCT FROM 'array' THEN
        RAISE EXCEPTION 'facts_set_crawled_by_keys requires a JSON array';
    END IF;
    v_count := jsonb_array_length(p_keys);
    IF v_count = 0 OR v_count > 500 THEN
        RAISE EXCEPTION 'facts_set_crawled_by_keys requires 1..500 entries';
    END IF;

    SELECT
        bool_or(scope_key IS NULL OR scope_key = '' OR (has_etag AND (etag IS NULL OR etag <= 0))),
        count(*) <> count(DISTINCT scope_key)
      INTO v_bad, v_dup
    FROM (
        SELECT e->>'scopeKey' AS scope_key,
               (e ? 'etag') AS has_etag,
               CASE WHEN (e ? 'etag') AND (e->>'etag') ~ '^[0-9]+$'
                    THEN (e->>'etag')::BIGINT ELSE NULL END AS etag
        FROM jsonb_array_elements(p_keys) e
    ) q;
    IF v_bad OR v_dup THEN
        RAISE EXCEPTION 'facts_set_crawled_by_keys entries require unique scopeKey values and optional numeric etags';
    END IF;

    RETURN QUERY
    WITH input AS (
        SELECT e->>'scopeKey' AS scope_key,
               (e ? 'etag') AS has_etag,
               CASE WHEN (e ? 'etag') AND (e->>'etag') ~ '^[0-9]+$'
                    THEN (e->>'etag')::BIGINT ELSE NULL END AS etag
        FROM jsonb_array_elements(p_keys) e
    ), matched AS (
        SELECT f.id, i.has_etag, i.etag AS input_etag
        FROM "{{SCHEMA}}".facts f
        JOIN input i ON i.scope_key = f.scope_key
    ), upd AS (
        UPDATE "{{SCHEMA}}".facts f
           SET last_crawled_at = CASE WHEN p_crawled THEN now() ELSE NULL END
          FROM matched m
         WHERE f.id = m.id
           AND (NOT m.has_etag OR f.etag = m.input_etag)
           AND ( (p_crawled     AND f.last_crawled_at IS NULL)
              OR (NOT p_crawled AND f.last_crawled_at IS NOT NULL) )
        RETURNING f.id
    )
    SELECT (SELECT count(*) FROM upd)::int AS affected,
           ((SELECT count(*) FROM matched) - (SELECT count(*) FROM upd))::int AS skipped;
END;
$$;

-- The legacy single-shape receipt mark is replaced by facts_set_crawled_by_keys.
DROP FUNCTION IF EXISTS "{{SCHEMA}}".facts_mark_crawled(JSONB);
