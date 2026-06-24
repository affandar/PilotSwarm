-- 0010_minimal_two_loop_embedder — finalize the minimal embedder state model
-- and split pg_durable embedding into independent batch and retry loops.
--
-- Final embedding state:
--   embedding, embedding_model, last_embed_error
--
-- last_embed_error convention:
--   NULL = healthy/eligible
--   -1   = internal single-row retry marker
--   > 0  = terminal row-level embedding failure
--
-- The embedder never reads or writes last_crawled_at. Graph crawler paths own
-- that column.
--
-- Tokens: {{SCHEMA}}.

ALTER TABLE "{{SCHEMA}}".facts ADD COLUMN IF NOT EXISTS last_embed_error INT;
ALTER TABLE "{{SCHEMA}}".facts DROP COLUMN IF EXISTS content_hash;
ALTER TABLE "{{SCHEMA}}".facts DROP COLUMN IF EXISTS last_embedded_hash;
ALTER TABLE "{{SCHEMA}}".facts DROP COLUMN IF EXISTS embedded_at;
ALTER TABLE "{{SCHEMA}}".facts DROP COLUMN IF EXISTS last_embed_error_at;
ALTER TABLE "{{SCHEMA}}".facts DROP COLUMN IF EXISTS embed_retry_at;

DROP FUNCTION IF EXISTS "{{SCHEMA}}".embedder_workflow(int, int);

DROP INDEX IF EXISTS "{{SCHEMA}}".idx_facts_embed_retry;
DROP INDEX IF EXISTS "{{SCHEMA}}".idx_facts_last_embed_error;
CREATE INDEX IF NOT EXISTS idx_facts_embed_retry
    ON "{{SCHEMA}}".facts (id) WHERE last_embed_error = -1;
CREATE INDEX IF NOT EXISTS idx_facts_last_embed_error
    ON "{{SCHEMA}}".facts (last_embed_error, id) WHERE last_embed_error > 0;

CREATE OR REPLACE FUNCTION "{{SCHEMA}}".embed_error_code(p_status INT, p_body TEXT) RETURNS INT
LANGUAGE sql IMMUTABLE AS $$
    SELECT CASE
        WHEN p_body ILIKE '%maximum input length%'
          OR p_body ILIKE '%maximum context length%'
          OR p_body ILIKE '%too many tokens%'
          OR p_body ILIKE '%too%many%token%'
          OR p_body ILIKE '%input%too%long%'
          OR p_body ILIKE '%token%limit%'
          OR p_body ILIKE '%exceed%token%'
          OR p_body ILIKE '%requested%token%'
            THEN 1001
        WHEN p_status = 400 THEN 1400
        WHEN p_status = 401 THEN 1401
        WHEN p_status = 403 THEN 1403
        WHEN p_status = 429 THEN 1429
        WHEN p_status BETWEEN 500 AND 599 THEN 1500
        ELSE 9999
    END;
$$;

CREATE OR REPLACE FUNCTION "{{SCHEMA}}".facts_touch() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'INSERT' OR NEW.key IS DISTINCT FROM OLD.key OR NEW.value IS DISTINCT FROM OLD.value THEN
        NEW.updated_at := now();
        NEW.last_crawled_at := NULL;
        NEW.embedding := NULL;
        NEW.embedding_model := NULL;
        NEW.last_embed_error := NULL;
    END IF;
    RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION "{{SCHEMA}}".facts_store_batch(p_facts JSONB)
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
            value = EXCLUDED.value,
            agent_id = EXCLUDED.agent_id,
            session_id = EXCLUDED.session_id,
            shared = EXCLUDED.shared,
            transient = EXCLUDED.transient,
            tags = EXCLUDED.tags,
            updated_at = now()
        RETURNING 1
    )
    SELECT count(*)::int FROM upserted;
$$;

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
    SELECT "{{SCHEMA}}".facts_store_batch(jsonb_build_array(jsonb_build_object(
        'scopeKey', p_scope_key,
        'key', p_key,
        'value', p_value,
        'agentId', p_agent_id,
        'sessionId', p_session_id,
        'shared', p_shared,
        'tags', coalesce(p_tags, '{}'::text[])
    )));
$$;

CREATE OR REPLACE FUNCTION "{{SCHEMA}}".facts_delete_pattern(
    p_key_pattern TEXT,
    p_scope TEXT,
    p_session_id TEXT,
    p_unrestricted BOOLEAN DEFAULT FALSE
) RETURNS INT
LANGUAGE plpgsql AS $$
DECLARE
    deleted_count INT;
BEGIN
    IF p_key_pattern IS NULL OR p_key_pattern = '' THEN
        RAISE EXCEPTION 'facts_delete_pattern requires a key pattern';
    END IF;
    IF p_scope NOT IN ('session', 'shared', 'all') THEN
        RAISE EXCEPTION 'facts_delete_pattern scope must be session, shared, or all';
    END IF;
    IF p_scope = 'all' AND p_unrestricted IS DISTINCT FROM TRUE THEN
        RAISE EXCEPTION 'facts_delete_pattern scope=all requires unrestricted=true';
    END IF;
    IF p_scope = 'session' AND p_session_id IS NULL THEN
        RAISE EXCEPTION 'facts_delete_pattern scope=session requires sessionId';
    END IF;

    DELETE FROM "{{SCHEMA}}".facts f
    WHERE f.key LIKE p_key_pattern
      AND (
        (p_scope = 'shared' AND f.shared = TRUE)
        OR (p_scope = 'session' AND f.shared = FALSE AND f.session_id = p_session_id)
        OR (p_scope = 'all' AND p_unrestricted = TRUE)
      );
    GET DIAGNOSTICS deleted_count = ROW_COUNT;
    RETURN deleted_count;
END;
$$;

DROP FUNCTION IF EXISTS "{{SCHEMA}}".facts_embedding_failures(TEXT, INT[], INT);

CREATE OR REPLACE FUNCTION "{{SCHEMA}}".embedder_batch_workflow(p_interval int, p_batch int)
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
    v_batch_sql text;
    v_batch_too_large_sql text;
    v_resp_ok_sql text;
    v_batch_fail_sql text;
    v_zip_sql text;
BEGIN
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

    v_batch_sql := format(
        $q$SELECT jsonb_build_object(%L, jsonb_agg(t.txt ORDER BY t.id), 'model', %L)::text AS body,
                  array_agg(t.id ORDER BY t.id)::text AS ids,
                array_agg(t.updated_at ORDER BY t.id)::text AS updated_ats,
                bool_or(t.input_chars > 8000)::text AS has_oversized
           FROM (SELECT id, updated_at,
                   coalesce(key, '') || E'\n' || coalesce(value::text, '') AS txt,
                   char_length(coalesce(key, '') || E'\n' || coalesce(value::text, '')) AS input_chars
                 FROM "{{SCHEMA}}".facts
                 WHERE last_embed_error IS NULL
                   AND (embedding IS NULL OR embedding_model IS DISTINCT FROM %L)
                 ORDER BY id
                 LIMIT %s) t
           HAVING count(*) > 0$q$,
        v_inputfield, v_model, v_model, greatest(p_batch, 1));

    v_batch_too_large_sql := $q$SELECT 1 WHERE coalesce(($batch.has_oversized)::boolean, false)$q$;

    v_resp_ok_sql := $q$SELECT 1
        WHERE "{{SCHEMA}}".embed_response_data_count($resp::jsonb) = cardinality(($batch.ids)::bigint[])$q$;

    v_batch_fail_sql := $q$WITH selected AS (
           SELECT u.id, u.seen_updated_at
           FROM unnest(($batch.ids)::bigint[], ($batch.updated_ats)::timestamptz[]) AS u(id, seen_updated_at)
       )
       UPDATE "{{SCHEMA}}".facts f
          SET last_embed_error = -1,
              embedding = NULL,
              embedding_model = NULL
         FROM selected s
        WHERE f.id = s.id
          AND f.updated_at IS NOT DISTINCT FROM s.seen_updated_at
          AND f.last_embed_error IS NULL$q$;

    v_zip_sql := format(
        $q$WITH resp AS (SELECT ($resp::jsonb->>'body')::jsonb AS j),
                emb  AS (SELECT v.ord, v.e->'embedding' AS vec
                         FROM resp, jsonb_array_elements(resp.j->'data') WITH ORDINALITY AS v(e, ord)),
                tgt  AS (SELECT u.id, u.seen_updated_at, u.ord
                         FROM unnest(($batch.ids)::bigint[], ($batch.updated_ats)::timestamptz[]) WITH ORDINALITY AS u(id, seen_updated_at, ord)),
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
        v_model);

    RETURN df.loop(
        df.seq(
            df.sleep(greatest(p_interval, 1)::bigint),
            df.seq(
                df.as(df.sql(v_batch_sql), 'batch'),
                df.if_rows('batch',
                    df.seq(
                        df.as(df.sql(v_batch_too_large_sql), 'batch_too_large'),
                        df.if_rows('batch_too_large',
                            df.sql(v_batch_fail_sql),
                            df.seq(
                                df.as(df.http(v_url, 'POST', '$batch.body', v_headers, v_timeout), 'resp'),
                                df.seq(
                                    df.as(df.sql(v_resp_ok_sql), 'resp_ok'),
                                    df.if_rows('resp_ok', df.sql(v_zip_sql), df.sql(v_batch_fail_sql)))))),
                    df.sql('SELECT 1')))),
        NULL);
END $fn$;

CREATE OR REPLACE FUNCTION "{{SCHEMA}}".embedder_retry_workflow(p_interval int)
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
    v_retry_sql text;
    v_retry_too_large_sql text;
    v_retry_resp_ok_sql text;
    v_retry_zip_sql text;
    v_retry_fail_sql text;
    v_retry_oversized_fail_sql text;
BEGIN
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

    v_retry_sql := format(
        $q$SELECT jsonb_build_object(%L, jsonb_agg(t.txt ORDER BY t.id), 'model', %L)::text AS body,
                  array_agg(t.id ORDER BY t.id)::text AS ids,
                array_agg(t.updated_at ORDER BY t.id)::text AS updated_ats,
                bool_or(t.input_chars > 8000)::text AS has_oversized
           FROM (SELECT id, updated_at,
                   coalesce(key, '') || E'\n' || coalesce(value::text, '') AS txt,
                   char_length(coalesce(key, '') || E'\n' || coalesce(value::text, '')) AS input_chars
                 FROM "{{SCHEMA}}".facts
                 WHERE last_embed_error = -1
                 ORDER BY id
                 LIMIT 1) t
           HAVING count(*) > 0$q$,
        v_inputfield, v_model);

    v_retry_too_large_sql := $q$SELECT 1 WHERE coalesce(($retry.has_oversized)::boolean, false)$q$;

    v_retry_resp_ok_sql := $q$SELECT 1
        WHERE "{{SCHEMA}}".embed_response_data_count($retry_resp::jsonb) = cardinality(($retry.ids)::bigint[])$q$;

    v_retry_zip_sql := format(
        $q$WITH resp AS (SELECT ($retry_resp::jsonb->>'body')::jsonb AS j),
                emb  AS (SELECT v.ord, v.e->'embedding' AS vec
                         FROM resp, jsonb_array_elements(resp.j->'data') WITH ORDINALITY AS v(e, ord)),
                tgt  AS (SELECT u.id, u.seen_updated_at, u.ord
                         FROM unnest(($retry.ids)::bigint[], ($retry.updated_ats)::timestamptz[]) WITH ORDINALITY AS u(id, seen_updated_at, ord)),
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
        v_model);

    v_retry_fail_sql := $q$WITH resp AS (
                SELECT $retry_resp::jsonb AS r
            ), tgt AS (
                SELECT u.id, u.seen_updated_at
                FROM unnest(($retry.ids)::bigint[], ($retry.updated_ats)::timestamptz[]) AS u(id, seen_updated_at)
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
             SELECT count(*) FROM upd$q$;

    v_retry_oversized_fail_sql := $q$WITH tgt AS (
                SELECT u.id, u.seen_updated_at
                FROM unnest(($retry.ids)::bigint[], ($retry.updated_ats)::timestamptz[]) AS u(id, seen_updated_at)
            ), upd AS (
                UPDATE "{{SCHEMA}}".facts f
                   SET last_embed_error = 1001,
                       embedding = NULL,
                       embedding_model = NULL
                  FROM tgt
                 WHERE f.id = tgt.id
                   AND f.updated_at IS NOT DISTINCT FROM tgt.seen_updated_at
                 RETURNING f.id)
             SELECT count(*) FROM upd$q$;

    RETURN df.loop(
        df.seq(
            df.sleep(greatest(p_interval, 1)::bigint),
            df.seq(
                df.as(df.sql(v_retry_sql), 'retry'),
                df.if_rows('retry',
                    df.seq(
                        df.as(df.sql(v_retry_too_large_sql), 'retry_too_large'),
                        df.if_rows('retry_too_large',
                            df.sql(v_retry_oversized_fail_sql),
                            df.seq(
                                df.as(df.http(v_url, 'POST', '$retry.body', v_headers, v_timeout), 'retry_resp'),
                                df.seq(
                                    df.as(df.sql(v_retry_resp_ok_sql), 'retry_resp_ok'),
                                    df.if_rows('retry_resp_ok', df.sql(v_retry_zip_sql), df.sql(v_retry_fail_sql)))))),
                    df.sql('SELECT 1')))),
        NULL);
END $fn$;
