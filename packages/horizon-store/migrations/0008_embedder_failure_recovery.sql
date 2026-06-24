-- 0008_embedder_failure_recovery — isolate failed embedding rows so one bad
-- fact cannot block the durable embedder backlog.
--
-- Behaviour:
--   - facts.last_embed_error stores a numeric terminal error code for the
--     current row value. NULL means the row remains eligible for embedding.
--   - facts.embed_retry_at marks a row selected from a failed batch for one-row
--     retry. It is transient workflow state on the fact row itself.
--   - facts_touch clears last_embed_error and embed_retry_at on INSERT/content
--     change, and clears the embedding itself so edits reset the row to normal
--     pending embedding without content/embedding hash columns.
--   - A failed batch marks its rows with embed_retry_at. The loop then processes
--     those rows one at a time before selecting new batches. A single-row failure
--     marks that fact terminally failed and stamps last_crawled_at so an
--     embedded-only graph harvester is not starved forever.
--   - facts_embedding_failures exposes counts and samples for the Facts Manager.
--
-- Error code convention:
--   1001 input_too_large
--   1400 provider_bad_request
--   1401 provider_authentication_failed
--   1403 provider_authorization_failed
--   1429 provider_rate_limited
--   1500 provider_server_error
--   1901 provider_malformed_response
--   9999 unknown_embedding_error
--
-- Tokens: {{SCHEMA}}.

ALTER TABLE "{{SCHEMA}}".facts ADD COLUMN IF NOT EXISTS last_embed_error INT;
ALTER TABLE "{{SCHEMA}}".facts ADD COLUMN IF NOT EXISTS last_embed_error_at TIMESTAMPTZ;
ALTER TABLE "{{SCHEMA}}".facts ADD COLUMN IF NOT EXISTS embed_retry_at TIMESTAMPTZ;

ALTER TABLE "{{SCHEMA}}".facts DROP COLUMN IF EXISTS last_embedded_hash;
ALTER TABLE "{{SCHEMA}}".facts DROP COLUMN IF EXISTS content_hash;

CREATE INDEX IF NOT EXISTS idx_facts_last_embed_error
    ON "{{SCHEMA}}".facts (last_embed_error, id) WHERE last_embed_error IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_facts_embed_retry
    ON "{{SCHEMA}}".facts (embed_retry_at, id) WHERE embed_retry_at IS NOT NULL;

CREATE OR REPLACE FUNCTION "{{SCHEMA}}".embed_error_label(p_code INT) RETURNS TEXT
LANGUAGE sql IMMUTABLE AS $$
    SELECT CASE p_code
        WHEN 1001 THEN 'input_too_large'
        WHEN 1400 THEN 'provider_bad_request'
        WHEN 1401 THEN 'provider_authentication_failed'
        WHEN 1403 THEN 'provider_authorization_failed'
        WHEN 1429 THEN 'provider_rate_limited'
        WHEN 1500 THEN 'provider_server_error'
        WHEN 1901 THEN 'provider_malformed_response'
        WHEN 9999 THEN 'unknown_embedding_error'
        ELSE 'unknown_embedding_error'
    END;
$$;

CREATE OR REPLACE FUNCTION "{{SCHEMA}}".embed_error_code(p_status INT, p_body TEXT) RETURNS INT
LANGUAGE sql IMMUTABLE AS $$
    SELECT CASE
        WHEN p_body ILIKE '%maximum input length%' OR p_body ILIKE '%too many tokens%' OR p_body ILIKE '%input%too%long%'
            THEN 1001
        WHEN p_status = 400 THEN 1400
        WHEN p_status = 401 THEN 1401
        WHEN p_status = 403 THEN 1403
        WHEN p_status = 429 THEN 1429
        WHEN p_status BETWEEN 500 AND 599 THEN 1500
        ELSE 9999
    END;
$$;

CREATE OR REPLACE FUNCTION "{{SCHEMA}}".embed_response_data_count(p_resp JSONB) RETURNS INT
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
    j JSONB;
BEGIN
    IF NOT coalesce((p_resp->>'ok')::boolean, false) THEN
        RETURN -1;
    END IF;
    IF coalesce(CASE WHEN (p_resp->>'status') ~ '^\d+$' THEN (p_resp->>'status')::int ELSE 0 END, 0) NOT BETWEEN 200 AND 299 THEN
        RETURN -1;
    END IF;
    j := (p_resp->>'body')::jsonb;
    IF jsonb_typeof(j->'data') <> 'array' THEN
        RETURN -2;
    END IF;
    RETURN jsonb_array_length(j->'data');
EXCEPTION WHEN OTHERS THEN
    RETURN -2;
END $$;

CREATE OR REPLACE FUNCTION "{{SCHEMA}}".embed_response_terminal_code(p_resp JSONB) RETURNS INT
LANGUAGE sql IMMUTABLE AS $$
    SELECT CASE
        WHEN "{{SCHEMA}}".embed_response_data_count(p_resp) = -2 THEN 1901
        ELSE "{{SCHEMA}}".embed_error_code(
            coalesce(CASE WHEN (p_resp->>'status') ~ '^\d+$' THEN (p_resp->>'status')::int ELSE 0 END, 0),
            coalesce(p_resp->>'body', ''))
    END;
$$;

CREATE OR REPLACE FUNCTION "{{SCHEMA}}".facts_touch() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'INSERT' OR NEW.key IS DISTINCT FROM OLD.key OR NEW.value IS DISTINCT FROM OLD.value THEN
        NEW.updated_at := now();
        NEW.last_crawled_at := NULL;
        NEW.embedding := NULL;
        NEW.embedded_at := NULL;
        NEW.embedding_model := NULL;
        NEW.last_embed_error := NULL;
        NEW.last_embed_error_at := NULL;
        NEW.embed_retry_at := NULL;
    END IF;
    RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION "{{SCHEMA}}".facts_embedding_failures(
    p_ns_prefix   TEXT DEFAULT NULL,
    p_error_codes INT[] DEFAULT NULL,
    p_limit       INT DEFAULT 20
) RETURNS TABLE (
    row_kind TEXT,
    code INT,
    label TEXT,
    count BIGINT,
    oldest_at TIMESTAMPTZ,
    newest_at TIMESTAMPTZ,
    max_input_chars BIGINT,
    scope_key TEXT,
    key TEXT,
    value JSONB,
    agent_id TEXT,
    session_id TEXT,
    shared BOOLEAN,
    tags TEXT[],
    created_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ,
    last_embed_error INT,
    last_embed_error_at TIMESTAMPTZ,
    input_chars BIGINT
)
LANGUAGE sql STABLE AS $$
    WITH failed AS (
        SELECT f.*,
               char_length(coalesce(f.key, '') || E'\n' || coalesce(f.value::text, ''))::bigint AS input_chars
        FROM "{{SCHEMA}}".facts f
        WHERE f.last_embed_error IS NOT NULL
          AND (p_ns_prefix IS NULL OR f.key LIKE p_ns_prefix)
          AND (p_error_codes IS NULL OR f.last_embed_error = ANY(p_error_codes))
    ), stats AS (
        SELECT f.last_embed_error AS code,
               "{{SCHEMA}}".embed_error_label(f.last_embed_error) AS label,
               count(*)::bigint AS count,
               min(f.last_embed_error_at) AS oldest_at,
               max(f.last_embed_error_at) AS newest_at,
               coalesce(max(f.input_chars), 0)::bigint AS max_input_chars
        FROM failed f
        GROUP BY f.last_embed_error
    ), samples AS (
        SELECT f.*
        FROM failed f
        ORDER BY f.last_embed_error_at DESC NULLS LAST, f.id DESC
        LIMIT greatest(0, least(coalesce(p_limit, 20), 500))
    )
    SELECT 'stat'::text AS row_kind,
           s.code, s.label, s.count, s.oldest_at, s.newest_at, s.max_input_chars,
           NULL::text AS scope_key, NULL::text AS key, NULL::jsonb AS value,
           NULL::text AS agent_id, NULL::text AS session_id, NULL::boolean AS shared,
           NULL::text[] AS tags, NULL::timestamptz AS created_at, NULL::timestamptz AS updated_at,
           NULL::int AS last_embed_error, NULL::timestamptz AS last_embed_error_at,
           NULL::bigint AS input_chars
    FROM stats s
    UNION ALL
    SELECT 'fact'::text AS row_kind,
           f.last_embed_error AS code,
           "{{SCHEMA}}".embed_error_label(f.last_embed_error) AS label,
           NULL::bigint AS count, NULL::timestamptz AS oldest_at, NULL::timestamptz AS newest_at,
           NULL::bigint AS max_input_chars,
           f.scope_key, f.key, f.value, f.agent_id, f.session_id, f.shared, f.tags,
           f.created_at, f.updated_at, f.last_embed_error,
           f.last_embed_error_at, f.input_chars
    FROM samples f
    ORDER BY row_kind DESC, count DESC NULLS LAST, newest_at DESC NULLS LAST, last_embed_error_at DESC NULLS LAST;
$$;

DROP FUNCTION IF EXISTS "{{SCHEMA}}".facts_mark_crawled(JSONB);

CREATE OR REPLACE FUNCTION "{{SCHEMA}}".facts_mark_crawled(p_stamps JSONB)
RETURNS TABLE (marked INT, skipped INT)
LANGUAGE sql AS $$
    WITH stamps AS (
        SELECT e->>'scopeKey' AS scope_key
        FROM jsonb_array_elements(p_stamps) e
    ),
    upd AS (
        UPDATE "{{SCHEMA}}".facts f
           SET last_crawled_at = now()
          FROM stamps s
         WHERE f.scope_key = s.scope_key
           AND f.last_crawled_at IS NULL
        RETURNING f.scope_key
    )
    SELECT (SELECT count(*) FROM upd)::int AS marked,
           ((SELECT count(*) FROM stamps) - (SELECT count(*) FROM upd))::int AS skipped;
$$;

CREATE OR REPLACE FUNCTION "{{SCHEMA}}".embedder_workflow(p_interval int, p_batch int)
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
    v_batch_sql  text;
    v_resp_ok_sql text;
    v_batch_fail_sql text;
    v_zip_sql    text;
    v_retry_sql  text;
    v_retry_exists_sql text;
    v_retry_resp_ok_sql text;
    v_retry_zip_sql text;
    v_retry_fail_sql text;
BEGIN
    v_url        := df.getvar('hz_{{SCHEMA}}_url');
    v_model      := df.getvar('hz_{{SCHEMA}}_model');
    v_key        := df.getvar('hz_{{SCHEMA}}_key');
    v_keyhdr     := coalesce(df.getvar('hz_{{SCHEMA}}_keyhdr'), 'api-key');
    v_bearer     := coalesce(df.getvar('hz_{{SCHEMA}}_bearer'), 'false');
    v_inputfield := coalesce(df.getvar('hz_{{SCHEMA}}_inputfield'), 'input');
    v_timeout    := coalesce(df.getvar('hz_{{SCHEMA}}_timeout'), '30')::int;

    IF v_url IS NULL OR v_model IS NULL THEN
        RAISE EXCEPTION 'embedder not configured: call configureEmbedder first (durable vars hz_{{SCHEMA}}_url / hz_{{SCHEMA}}_model missing)';
    END IF;

    v_headers := jsonb_build_object('content-type', 'application/json');
    IF v_key IS NOT NULL AND v_key <> '' THEN
        v_headers := v_headers || jsonb_build_object(
            v_keyhdr,
            CASE WHEN v_bearer = 'true' THEN 'Bearer ' || v_key ELSE v_key END
        );
    END IF;

        v_batch_sql := format(
                $q$WITH retry AS (
                             SELECT id
                             FROM "{{SCHEMA}}".facts
                             WHERE embed_retry_at IS NOT NULL
                                 AND last_embed_error IS NULL
                             ORDER BY embed_retry_at, id
                             LIMIT 1
                     )
                     SELECT jsonb_build_object(%L, jsonb_agg(t.txt ORDER BY t.id), 'model', %L)::text AS body,
                    array_agg(t.id ORDER BY t.id)::text AS ids,
                    array_agg(t.updated_at ORDER BY t.id)::text AS updated_ats
                FROM (SELECT id, updated_at,
                        coalesce(key, '') || E'\n' || coalesce(value::text, '') AS txt
                 FROM "{{SCHEMA}}".facts
                 WHERE last_embed_error IS NULL
                                     AND embed_retry_at IS NULL
                   AND NOT EXISTS (SELECT 1 FROM retry)
                   AND (embedding IS NULL
                        OR embedding_model IS DISTINCT FROM %L)
                 ORDER BY id
                 LIMIT %s) t
           HAVING count(*) > 0$q$,
                v_inputfield, v_model, v_model, greatest(p_batch, 1));

    v_resp_ok_sql := $q$SELECT 1
        WHERE "{{SCHEMA}}".embed_response_data_count($resp::jsonb) = cardinality(($batch.ids)::bigint[])$q$;

    v_batch_fail_sql := $q$WITH selected AS (
           SELECT u.id, u.seen_updated_at
           FROM unnest(($batch.ids)::bigint[], ($batch.updated_ats)::timestamptz[]) AS u(id, seen_updated_at)
       )
       UPDATE "{{SCHEMA}}".facts f
          SET embed_retry_at = now()
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
                       SET embedding          = (emb.vec)::text::vector,
                           embedded_at        = now(),
                           embedding_model    = %L,
                           last_embed_error = NULL,
                                                     last_embed_error_at = NULL,
                                                     embed_retry_at = NULL
                      FROM emb JOIN tgt ON tgt.ord = emb.ord
                     WHERE f.id = tgt.id
                                             AND f.updated_at IS NOT DISTINCT FROM tgt.seen_updated_at
                                         RETURNING f.id)
                     SELECT count(*) FROM upd$q$,
        v_model);

    v_retry_sql := format(
        $q$WITH picked AS (
             SELECT id, updated_at
                             FROM "{{SCHEMA}}".facts
                             WHERE embed_retry_at IS NOT NULL
                                 AND last_embed_error IS NULL
                             ORDER BY embed_retry_at, id
               LIMIT 1
           )
           SELECT jsonb_build_object(%L, jsonb_agg(t.txt ORDER BY t.id), 'model', %L)::text AS body,
                    array_agg(t.id ORDER BY t.id)::text AS ids,
                    array_agg(t.updated_at ORDER BY t.id)::text AS updated_ats
                FROM (SELECT f.id, f.updated_at,
                        coalesce(f.key, '') || E'\n' || coalesce(f.value::text, '') AS txt
                                 FROM "{{SCHEMA}}".facts f
                   JOIN picked p ON p.id = f.id AND p.updated_at IS NOT DISTINCT FROM f.updated_at) t
           HAVING count(*) > 0$q$,
                v_inputfield, v_model);

        v_retry_exists_sql := $q$SELECT 1
                FROM "{{SCHEMA}}".facts
                WHERE embed_retry_at IS NOT NULL
                    AND last_embed_error IS NULL
                LIMIT 1$q$;

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
                       SET embedding          = (emb.vec)::text::vector,
                           embedded_at        = now(),
                           embedding_model    = %L,
                           last_embed_error = NULL,
                                                     last_embed_error_at = NULL,
                                                     embed_retry_at = NULL
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
                       last_embed_error_at = now(),
                     last_crawled_at = now(),
                     embed_retry_at = NULL
                  FROM classified
                 WHERE f.id = classified.id
                                     AND f.updated_at IS NOT DISTINCT FROM classified.seen_updated_at
                 RETURNING f.id)
             SELECT count(*) FROM upd$q$;

    RETURN df.loop(
        df.seq(
            df.sleep(greatest(p_interval, 1)::bigint),
            df.seq(
                df.as(df.sql(v_batch_sql), 'batch'),
                df.seq(
                    df.if_rows('batch',
                        df.seq(
                            df.as(df.http(v_url, 'POST', '$batch.body', v_headers, v_timeout), 'resp'),
                            df.seq(
                                df.as(df.sql(v_resp_ok_sql), 'resp_ok'),
                                df.if_rows('resp_ok',
                                    df.sql(v_zip_sql),
                                    df.sql(v_batch_fail_sql)))),
                        df.sql('SELECT 1')),
                    df.loop(
                        df.seq(
                            df.as(df.sql(v_retry_sql), 'retry'),
                            df.if_rows('retry',
                                df.seq(
                                    df.as(df.http(v_url, 'POST', '$retry.body', v_headers, v_timeout), 'retry_resp'),
                                    df.seq(
                                        df.as(df.sql(v_retry_resp_ok_sql), 'retry_resp_ok'),
                                        df.if_rows('retry_resp_ok',
                                            df.sql(v_retry_zip_sql),
                                            df.sql(v_retry_fail_sql)))),
                                df.sql('SELECT 1'))),
                        df.sql(v_retry_exists_sql))))),
        NULL);
END $fn$;
