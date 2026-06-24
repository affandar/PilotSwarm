-- 0011_unified_api_embedder_workflow — collapse public proc names and expose
-- one internal embedder workflow function started in two durable modes.
--
-- Public-ish provider procs after this migration:
--   facts_store(jsonb)                                  -- single or batch input
--   facts_delete(text, boolean, text, text, boolean)    -- exact or pattern
--   embedder_workflow(text, int, int)                   -- mode = batch | retry
--
-- The runtime still starts two durable loop instances so batch work and one-row
-- retries do not block each other. They are modes of one workflow, not two
-- separate schema concepts.

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

DROP FUNCTION IF EXISTS "{{SCHEMA}}".facts_store(TEXT, TEXT, JSONB, TEXT, TEXT, BOOLEAN, TEXT[]);
DROP FUNCTION IF EXISTS "{{SCHEMA}}".facts_store_batch(JSONB);

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

        DELETE FROM "{{SCHEMA}}".facts f
        WHERE f.key LIKE p_key_or_pattern
          AND (
            (v_scope = 'shared' AND f.shared = TRUE)
            OR (v_scope = 'session' AND f.shared = FALSE AND f.session_id = p_session_id)
            OR (v_scope = 'all' AND p_unrestricted = TRUE)
          );
    ELSE
        DELETE FROM "{{SCHEMA}}".facts WHERE scope_key = p_key_or_pattern;
    END IF;
    GET DIAGNOSTICS deleted_count = ROW_COUNT;
    RETURN deleted_count;
END;
$$;

DROP FUNCTION IF EXISTS "{{SCHEMA}}".facts_delete(TEXT);
DROP FUNCTION IF EXISTS "{{SCHEMA}}".facts_delete_pattern(TEXT, TEXT, TEXT, BOOLEAN);

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
                 WHERE %s
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

DROP FUNCTION IF EXISTS "{{SCHEMA}}".embedder_batch_workflow(INT, INT);
DROP FUNCTION IF EXISTS "{{SCHEMA}}".embedder_retry_workflow(INT);
