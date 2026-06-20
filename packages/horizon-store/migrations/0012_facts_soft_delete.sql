-- 0012_facts_soft_delete — soft-delete facts and protect crawl marks with an etag.
--
-- Final fact lifecycle additions:
--   deleted_at timestamptz  -- NULL = live; non-NULL = tombstone hidden from reads
--   etag bigint             -- crawl-relevant optimistic-concurrency token
--
-- The facts store is graph-agnostic. Deletes always tombstone + requeue; the
-- crawler may reconcile the graph and mark crawled, or the Facts Manager TTL
-- purge may eventually hard-delete the tombstone.
--
-- Tokens: {{SCHEMA}}.

ALTER TABLE "{{SCHEMA}}".facts ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
ALTER TABLE "{{SCHEMA}}".facts ADD COLUMN IF NOT EXISTS etag BIGINT NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_facts_tombstones
    ON "{{SCHEMA}}".facts (deleted_at) WHERE deleted_at IS NOT NULL;

CREATE OR REPLACE FUNCTION "{{SCHEMA}}".facts_touch() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        NEW.etag := COALESCE(NEW.etag, 0) + 1;
        NEW.last_crawled_at := NULL;
    ELSIF NEW.key IS DISTINCT FROM OLD.key
       OR NEW.value IS DISTINCT FROM OLD.value
       OR NEW.deleted_at IS DISTINCT FROM OLD.deleted_at THEN
        NEW.etag := COALESCE(OLD.etag, 0) + 1;
        NEW.last_crawled_at := NULL;
    END IF;

    -- Embedding is content-derived only. Delete/revive should not force a re-embed.
    IF TG_OP = 'INSERT' OR NEW.key IS DISTINCT FROM OLD.key OR NEW.value IS DISTINCT FROM OLD.value THEN
        NEW.updated_at := now();
        NEW.embedding := NULL;
        NEW.embedding_model := NULL;
        NEW.last_embed_error := NULL;
    END IF;
    RETURN NEW;
END $$;

DROP FUNCTION IF EXISTS "{{SCHEMA}}".facts_store(JSONB);
CREATE OR REPLACE FUNCTION "{{SCHEMA}}".facts_store(p_facts JSONB)
RETURNS INT
LANGUAGE sql AS $$
    WITH input AS (
        SELECT
            e->>'scopeKey' AS scope_key,
            e->>'key' AS key,
            e->'value' AS value,
            e->>'agentId' AS agent_id,
            e->>'sessionId' AS session_id,
            coalesce((e->>'shared')::boolean, false) AS shared,
            coalesce(ARRAY(SELECT jsonb_array_elements_text(e->'tags')), '{}'::text[]) AS tags
        FROM jsonb_array_elements(p_facts) e
    ), upserted AS (
        INSERT INTO "{{SCHEMA}}".facts (scope_key, key, value, agent_id, session_id, shared, transient, tags, updated_at)
        SELECT scope_key, key, value, agent_id, session_id, shared, NOT shared, tags, now()
        FROM input
        ON CONFLICT (scope_key) DO UPDATE SET
            key = EXCLUDED.key,
            value = EXCLUDED.value,
            agent_id = EXCLUDED.agent_id,
            session_id = EXCLUDED.session_id,
            shared = EXCLUDED.shared,
            transient = EXCLUDED.transient,
            tags = EXCLUDED.tags,
            deleted_at = NULL,
            updated_at = now()
        RETURNING 1
    )
    SELECT count(*)::int FROM upserted;
$$;

DROP FUNCTION IF EXISTS "{{SCHEMA}}".facts_delete(TEXT, BOOLEAN, TEXT, TEXT, BOOLEAN);
CREATE OR REPLACE FUNCTION "{{SCHEMA}}".facts_delete(
    p_key_or_pattern TEXT,
    p_pattern BOOLEAN DEFAULT FALSE,
    p_scope TEXT DEFAULT NULL,
    p_session_id TEXT DEFAULT NULL,
    p_unrestricted BOOLEAN DEFAULT FALSE
) RETURNS INT
LANGUAGE plpgsql AS $$
DECLARE
    deleted_count INT;
    v_scope TEXT;
BEGIN
    IF p_pattern THEN
        IF p_key_or_pattern IS NULL OR p_key_or_pattern = '' THEN
            RAISE EXCEPTION 'facts_delete pattern mode requires key';
        END IF;
        v_scope := coalesce(p_scope, 'session');
        IF v_scope NOT IN ('session', 'shared', 'all') THEN
            RAISE EXCEPTION 'facts_delete scope must be session, shared, or all';
        END IF;
        IF v_scope = 'all' AND p_unrestricted IS DISTINCT FROM TRUE THEN
            RAISE EXCEPTION 'facts_delete scope=all requires unrestricted=true';
        END IF;
        IF v_scope = 'session' AND p_session_id IS NULL THEN
            RAISE EXCEPTION 'facts_delete scope=session requires sessionId';
        END IF;

        UPDATE "{{SCHEMA}}".facts f
           SET deleted_at = now(), updated_at = now()
         WHERE f.deleted_at IS NULL
           AND f.key LIKE p_key_or_pattern
           AND (
            (v_scope = 'shared' AND f.shared = TRUE)
            OR (v_scope = 'session' AND f.shared = FALSE AND f.session_id = p_session_id)
            OR (v_scope = 'all' AND p_unrestricted = TRUE)
          );
    ELSE
        UPDATE "{{SCHEMA}}".facts
           SET deleted_at = now(), updated_at = now()
         WHERE scope_key = p_key_or_pattern
           AND deleted_at IS NULL;
    END IF;
    GET DIAGNOSTICS deleted_count = ROW_COUNT;
    RETURN deleted_count;
END;
$$;

CREATE OR REPLACE FUNCTION "{{SCHEMA}}".facts_delete_session(p_session_id TEXT) RETURNS INT
LANGUAGE sql AS $$
    WITH upd AS (
        UPDATE "{{SCHEMA}}".facts
           SET deleted_at = now(), updated_at = now()
         WHERE shared = FALSE
           AND session_id = p_session_id
           AND deleted_at IS NULL
        RETURNING 1
    )
    SELECT count(*)::int FROM upd;
$$;

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
    WHERE f.deleted_at IS NULL
      AND "{{SCHEMA}}".facts_acl(f.shared, f.session_id, p_reader, p_granted, p_unrestricted, p_scope)
      AND (p_key_pattern IS NULL OR f.key LIKE p_key_pattern)
      AND (p_scope_keys IS NULL OR f.scope_key = ANY (p_scope_keys))
      AND (p_tags IS NULL OR f.tags @> p_tags)
      AND (p_agent_id IS NULL OR f.agent_id = p_agent_id)
    ORDER BY f.updated_at DESC
    LIMIT p_limit;
$$;

CREATE OR REPLACE FUNCTION "{{SCHEMA}}".facts_stats(
    p_mode        TEXT,
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
    WHERE f.deleted_at IS NULL
      AND CASE p_mode
        WHEN 'shared'   THEN f.shared
        WHEN 'session'  THEN (NOT f.shared AND f.session_id = p_session_ids[1])
        WHEN 'sessions' THEN (NOT f.shared AND f.session_id = ANY (coalesce(p_session_ids, '{}')))
        ELSE FALSE
    END
    GROUP BY 1;
$$;

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
    WHERE f.deleted_at IS NULL
      AND (f.search_text <@> q.bq) < 0
      AND "{{SCHEMA}}".facts_acl(f.shared, f.session_id, p_reader, p_granted, p_unrestricted, p_scope)
      AND (p_ns_prefix IS NULL OR f.key LIKE p_ns_prefix)
      AND (p_tags IS NULL OR f.tags @> p_tags)
    ORDER BY f.search_text <@> q.bq ASC
    LIMIT p_pool;
$$;

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
    WHERE f.deleted_at IS NULL
      AND f.embedding IS NOT NULL
      AND f.embedding_model IS NOT DISTINCT FROM p_model
      AND "{{SCHEMA}}".facts_acl(f.shared, f.session_id, p_reader, p_granted, p_unrestricted, p_scope)
      AND (p_ns_prefix IS NULL OR f.key LIKE p_ns_prefix)
      AND (p_tags IS NULL OR f.tags @> p_tags)
      AND (1 - (f.embedding <=> p_vec)) >= coalesce(p_min, 0)
    ORDER BY f.embedding <=> p_vec ASC
    LIMIT p_pool;
$$;

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
        WHERE a.deleted_at IS NULL
          AND a.scope_key = p_scope_key
          AND a.embedding IS NOT NULL
          AND (p_model IS NULL OR a.embedding_model IS NOT DISTINCT FROM p_model)
          AND "{{SCHEMA}}".facts_acl(a.shared, a.session_id, p_reader, p_granted, p_unrestricted, p_scope)
    )
    SELECT f.scope_key, f.key, f.value, f.agent_id, f.session_id,
           f.shared, f.tags, f.created_at, f.updated_at,
           (1 - (f.embedding <=> a.embedding))::double precision AS sim
    FROM "{{SCHEMA}}".facts f, anchor a
    WHERE f.deleted_at IS NULL
      AND f.scope_key <> p_scope_key
      AND f.embedding IS NOT NULL
      AND f.embedding_model IS NOT DISTINCT FROM a.embedding_model
      AND "{{SCHEMA}}".facts_acl(f.shared, f.session_id, p_reader, p_granted, p_unrestricted, p_scope)
      AND (p_ns_prefix IS NULL OR f.key LIKE p_ns_prefix)
      AND (1 - (f.embedding <=> a.embedding)) >= coalesce(p_min, 0)
    ORDER BY f.embedding <=> a.embedding ASC
    LIMIT p_k;
$$;

DROP FUNCTION IF EXISTS "{{SCHEMA}}".facts_read_uncrawled(TEXT, INT, BOOLEAN);
CREATE OR REPLACE FUNCTION "{{SCHEMA}}".facts_read_uncrawled(
    p_ns_prefix     TEXT,
    p_limit         INT,
    p_embedded_only BOOLEAN DEFAULT FALSE
) RETURNS SETOF "{{SCHEMA}}".facts
LANGUAGE sql STABLE AS $$
    SELECT f.* FROM "{{SCHEMA}}".facts f
    WHERE f.last_crawled_at IS NULL
      AND (p_ns_prefix IS NULL OR f.key LIKE p_ns_prefix)
      AND (f.deleted_at IS NOT NULL OR NOT p_embedded_only OR f.embedding IS NOT NULL)
    ORDER BY f.id
    LIMIT p_limit;
$$;

CREATE OR REPLACE FUNCTION "{{SCHEMA}}".facts_mark_crawled(p_stamps JSONB)
RETURNS TABLE (marked INT, skipped INT)
LANGUAGE sql AS $$
    WITH stamps AS (
        SELECT e->>'scopeKey' AS scope_key,
               CASE WHEN (e->>'etag') ~ '^[0-9]+$' THEN (e->>'etag')::BIGINT ELSE NULL END AS etag
        FROM jsonb_array_elements(p_stamps) e
    ), upd AS (
        UPDATE "{{SCHEMA}}".facts f
           SET last_crawled_at = now()
          FROM stamps s
         WHERE f.scope_key = s.scope_key
           AND f.last_crawled_at IS NULL
           AND f.etag = s.etag
        RETURNING f.scope_key
    )
    SELECT (SELECT count(*) FROM upd)::int AS marked,
           ((SELECT count(*) FROM stamps) - (SELECT count(*) FROM upd))::int AS skipped;
$$;

CREATE OR REPLACE FUNCTION "{{SCHEMA}}".facts_purge_expired(
    p_ttl_seconds INT DEFAULT 21600,
    p_limit       INT DEFAULT 1000
) RETURNS BIGINT
LANGUAGE plpgsql AS $$
DECLARE
    purged BIGINT;
BEGIN
    WITH candidates AS (
        SELECT id
        FROM "{{SCHEMA}}".facts
        WHERE deleted_at IS NOT NULL
          AND (
            last_crawled_at IS NOT NULL
            OR deleted_at < now() - make_interval(secs => GREATEST(p_ttl_seconds, 0))
          )
        ORDER BY deleted_at, id
        LIMIT GREATEST(p_limit, 1)
        FOR UPDATE SKIP LOCKED
    ), del AS (
        DELETE FROM "{{SCHEMA}}".facts f
        USING candidates c
        WHERE f.id = c.id
        RETURNING 1
    )
    SELECT count(*) INTO purged FROM del;
    RETURN COALESCE(purged, 0);
END;
$$;

CREATE OR REPLACE FUNCTION "{{SCHEMA}}".facts_tombstone_stats(
    p_ttl_seconds INT DEFAULT 21600
) RETURNS TABLE (
    pending_total BIGINT,
    unreconciled BIGINT,
    ttl_blocked BIGINT,
    oldest_unreconciled_age_seconds DOUBLE PRECISION,
    reconciled_unswept BIGINT
)
LANGUAGE sql STABLE AS $$
    SELECT
        count(*) FILTER (WHERE deleted_at IS NOT NULL)::BIGINT AS pending_total,
        count(*) FILTER (WHERE deleted_at IS NOT NULL AND last_crawled_at IS NULL)::BIGINT AS unreconciled,
        count(*) FILTER (
            WHERE deleted_at IS NOT NULL
              AND last_crawled_at IS NULL
              AND deleted_at >= now() - make_interval(secs => GREATEST(p_ttl_seconds, 0))
        )::BIGINT AS ttl_blocked,
        EXTRACT(EPOCH FROM (now() - MIN(deleted_at) FILTER (
            WHERE deleted_at IS NOT NULL AND last_crawled_at IS NULL
        )))::DOUBLE PRECISION AS oldest_unreconciled_age_seconds,
        count(*) FILTER (WHERE deleted_at IS NOT NULL AND last_crawled_at IS NOT NULL)::BIGINT AS reconciled_unswept
    FROM "{{SCHEMA}}".facts;
$$;

CREATE OR REPLACE FUNCTION "{{SCHEMA}}".facts_force_purge(
    p_cutoff TIMESTAMPTZ,
    p_only_unreconciled BOOLEAN DEFAULT FALSE,
    p_key_prefix TEXT DEFAULT NULL,
    p_limit INT DEFAULT 1000
) RETURNS BIGINT
LANGUAGE plpgsql AS $$
DECLARE
    purged BIGINT;
BEGIN
    WITH candidates AS (
        SELECT id
        FROM "{{SCHEMA}}".facts
        WHERE deleted_at IS NOT NULL
          AND deleted_at < p_cutoff
          AND (p_only_unreconciled IS DISTINCT FROM TRUE OR last_crawled_at IS NULL)
          AND (p_key_prefix IS NULL OR starts_with(key, p_key_prefix))
        ORDER BY deleted_at, id
        LIMIT GREATEST(p_limit, 1)
        FOR UPDATE SKIP LOCKED
    ), del AS (
        DELETE FROM "{{SCHEMA}}".facts f
        USING candidates c
        WHERE f.id = c.id
        RETURNING 1
    )
    SELECT count(*) INTO purged FROM del;
    RETURN COALESCE(purged, 0);
END;
$$;

DROP FUNCTION IF EXISTS "{{SCHEMA}}".embedder_workflow(TEXT, INT, INT);
CREATE OR REPLACE FUNCTION "{{SCHEMA}}".embedder_workflow(p_mode text, p_interval int, p_batch int)
RETURNS text
LANGUAGE plpgsql AS $fn$
DECLARE
    v_url        text;
    v_model      text;
    v_key        text;
    v_keyhdr     text;
    v_bearer     text;
    v_inputfield text;
    v_timeout    int;
    v_headers    jsonb;
    v_select_sql text;
    v_too_large_sql text;
    v_resp_ok_sql text;
    v_batch_fail_sql text;
    v_zip_sql text;
    v_retry_fail_sql text;
    v_oversized_fail_sql text;
    v_alias text;
    v_resp_alias text;
    v_limit int;
BEGIN
    IF p_mode NOT IN ('batch', 'retry') THEN
        RAISE EXCEPTION 'embedder_workflow mode must be batch or retry';
    END IF;

    v_url        := df.getvar('hz_{{SCHEMA}}_url');
    v_model      := df.getvar('hz_{{SCHEMA}}_model');
    v_key        := df.getvar('hz_{{SCHEMA}}_key');
    v_keyhdr     := coalesce(df.getvar('hz_{{SCHEMA}}_keyhdr'), 'api-key');
    v_bearer     := coalesce(df.getvar('hz_{{SCHEMA}}_bearer'), 'false');
    v_inputfield := coalesce(df.getvar('hz_{{SCHEMA}}_inputfield'), 'input');
    v_timeout    := coalesce(df.getvar('hz_{{SCHEMA}}_timeout'), '30')::int;

    IF v_url IS NULL OR v_model IS NULL THEN
        RAISE EXCEPTION 'embedder not configured: call configureEmbedder first';
    END IF;

    v_headers := jsonb_build_object('content-type', 'application/json');
    IF v_key IS NOT NULL AND v_key <> '' THEN
        v_headers := v_headers || jsonb_build_object(
            v_keyhdr,
            CASE WHEN v_bearer = 'true' THEN 'Bearer ' || v_key ELSE v_key END
        );
    END IF;

    v_alias := p_mode;
    v_resp_alias := CASE WHEN p_mode = 'batch' THEN 'resp' ELSE 'retry_resp' END;
    v_limit := CASE WHEN p_mode = 'batch' THEN greatest(p_batch, 1) ELSE 1 END;

    v_select_sql := format(
        $q$SELECT jsonb_build_object(%L, jsonb_agg(t.txt ORDER BY t.id), 'model', %L)::text AS body,
                  array_agg(t.id ORDER BY t.id)::text AS ids,
                  array_agg(t.updated_at ORDER BY t.id)::text AS updated_ats,
                  bool_or(t.input_chars > 8000)::text AS has_oversized
           FROM (SELECT id, updated_at,
                   coalesce(key, '') || E'\n' || coalesce(value::text, '') AS txt,
                   char_length(coalesce(key, '') || E'\n' || coalesce(value::text, '')) AS input_chars
                 FROM "{{SCHEMA}}".facts
                 WHERE deleted_at IS NULL AND %s
                 ORDER BY id
                 LIMIT %s) t
           HAVING count(*) > 0$q$,
        v_inputfield,
        v_model,
        CASE WHEN p_mode = 'batch'
            THEN format('last_embed_error IS NULL AND (embedding IS NULL OR embedding_model IS DISTINCT FROM %L)', v_model)
            ELSE 'last_embed_error = -1'
        END,
        v_limit);

    v_too_large_sql := format($q$SELECT 1 WHERE coalesce(($%s.has_oversized)::boolean, false)$q$, v_alias);

    v_resp_ok_sql := format(
        $q$SELECT 1 WHERE "{{SCHEMA}}".embed_response_data_count($%s::jsonb) = cardinality(($%s.ids)::bigint[])$q$,
        v_resp_alias,
        v_alias);

    v_batch_fail_sql := format(
        $q$WITH selected AS (
               SELECT u.id, u.seen_updated_at
               FROM unnest(($%s.ids)::bigint[], ($%s.updated_ats)::timestamptz[]) AS u(id, seen_updated_at)
           )
           UPDATE "{{SCHEMA}}".facts f
              SET last_embed_error = -1,
                  embedding = NULL,
                  embedding_model = NULL
             FROM selected s
            WHERE f.id = s.id
              AND f.updated_at IS NOT DISTINCT FROM s.seen_updated_at
              AND f.last_embed_error IS NULL$q$,
        v_alias,
        v_alias);

    v_zip_sql := format(
        $q$WITH resp AS (SELECT ($%s::jsonb->>'body')::jsonb AS j),
                emb  AS (SELECT v.ord, v.e->'embedding' AS vec
                         FROM resp, jsonb_array_elements(resp.j->'data') WITH ORDINALITY AS v(e, ord)),
                tgt  AS (SELECT u.id, u.seen_updated_at, u.ord
                         FROM unnest(($%s.ids)::bigint[], ($%s.updated_ats)::timestamptz[]) WITH ORDINALITY AS u(id, seen_updated_at, ord)),
                upd AS (
                    UPDATE "{{SCHEMA}}".facts f
                       SET embedding = (emb.vec)::text::vector,
                           embedding_model = %L,
                           last_embed_error = NULL
                      FROM emb JOIN tgt ON tgt.ord = emb.ord
                     WHERE f.id = tgt.id
                       AND f.updated_at IS NOT DISTINCT FROM tgt.seen_updated_at
                     RETURNING f.id)
             SELECT count(*) FROM upd$q$,
        v_resp_alias,
        v_alias,
        v_alias,
        v_model);

    v_retry_fail_sql := format(
        $q$WITH resp AS (
                SELECT $%s::jsonb AS r
            ), tgt AS (
                SELECT u.id, u.seen_updated_at
                FROM unnest(($%s.ids)::bigint[], ($%s.updated_ats)::timestamptz[]) AS u(id, seen_updated_at)
            ), classified AS (
                SELECT tgt.id, tgt.seen_updated_at,
                       "{{SCHEMA}}".embed_response_terminal_code(resp.r) AS code
                FROM tgt, resp
            ), upd AS (
                UPDATE "{{SCHEMA}}".facts f
                   SET last_embed_error = classified.code,
                       embedding = NULL,
                       embedding_model = NULL
                  FROM classified
                 WHERE f.id = classified.id
                   AND f.updated_at IS NOT DISTINCT FROM classified.seen_updated_at
                 RETURNING f.id)
             SELECT count(*) FROM upd$q$,
        v_resp_alias,
        v_alias,
        v_alias);

    v_oversized_fail_sql := format(
        $q$WITH tgt AS (
                SELECT u.id, u.seen_updated_at
                FROM unnest(($%s.ids)::bigint[], ($%s.updated_ats)::timestamptz[]) AS u(id, seen_updated_at)
            ), upd AS (
                UPDATE "{{SCHEMA}}".facts f
                   SET last_embed_error = 1001,
                       embedding = NULL,
                       embedding_model = NULL
                  FROM tgt
                 WHERE f.id = tgt.id
                   AND f.updated_at IS NOT DISTINCT FROM tgt.seen_updated_at
                 RETURNING f.id)
             SELECT count(*) FROM upd$q$,
        v_alias,
        v_alias);

    RETURN df.loop(
        df.seq(
            df.sleep(greatest(p_interval, 1)::bigint),
            df.seq(
                df.as(df.sql(v_select_sql), v_alias),
                df.if_rows(v_alias,
                    df.seq(
                        df.as(df.sql(v_too_large_sql), v_alias || '_too_large'),
                        df.if_rows(v_alias || '_too_large',
                            CASE WHEN p_mode = 'batch' THEN df.sql(v_batch_fail_sql) ELSE df.sql(v_oversized_fail_sql) END,
                            df.seq(
                                df.as(df.http(v_url, 'POST', '$' || v_alias || '.body', v_headers, v_timeout), v_resp_alias),
                                df.seq(
                                    df.as(df.sql(v_resp_ok_sql), v_resp_alias || '_ok'),
                                    df.if_rows(v_resp_alias || '_ok',
                                        df.sql(v_zip_sql),
                                        CASE WHEN p_mode = 'batch' THEN df.sql(v_batch_fail_sql) ELSE df.sql(v_retry_fail_sql) END))))),
                    df.sql('SELECT 1')))),
        NULL);
END $fn$;
