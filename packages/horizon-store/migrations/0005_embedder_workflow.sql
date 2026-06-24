-- 0005_embedder_workflow — pg_durable grant + the eternal batch-embedding
-- loop builder (03-design §3).
--
-- The loop is ONE durable instance per schema (label hz-embed-cron:<schema>):
--
--   df.loop( df.seq( df.sleep(interval),
--            df.as(df.sql(<batch select>), 'batch'),
--            df.if_rows('batch',
--                df.seq(df.as(df.http(url, POST, '$batch.body', hdrs), 'resp'),
--                       df.sql(<zip-back update>)),
--                df.sql('SELECT 1')) ) )
--
-- One HTTP request per BATCH (array-input API), never per fact — no df-in-df.
--
-- Config snapshot semantics: endpoint config lives in durable vars
-- (hz_<schema>_url/_model/...; written by configureEmbedder). This builder
-- reads them via df.getvar() and bakes LITERALS into the workflow definition,
-- so the running instance captures config at df.start exactly like {var}
-- substitution would — and configureEmbedder restarts the loop to apply
-- changes. (Literal-baking avoids the whole-body '{var}' escaping risk
-- flagged in 03-design §7 for everything except the body, which must be the
-- runtime step result '$batch.body'.)
--
-- Write-back guard: last_embedded_hash is set from the hashes captured at
-- SELECT time ($batch.hashes), never the row's current content_hash — a fact
-- edited mid-flight stays pending (01 §5.3).
--
-- Tokens: {{SCHEMA}}.

CREATE EXTENSION IF NOT EXISTS pg_durable;

DO $$
BEGIN
    PERFORM df.grant_usage(current_user, true, false);
EXCEPTION WHEN OTHERS THEN
    NULL;  -- may already be granted / insufficient privilege; surfaced by preconditions if it matters
END $$;

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
    v_zip_sql    text;
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

    -- Batch select: ONE row (or zero when nothing pending — HAVING) carrying
    -- the ready-to-send body plus positional ids/hashes for the zip-back.
    -- Pending = NULL embedding, stale hash, or model mismatch (01 §5.2).
    v_batch_sql := format(
        $q$SELECT jsonb_build_object(%L, jsonb_agg(t.txt ORDER BY t.id), 'model', %L)::text AS body,
                  array_agg(t.id ORDER BY t.id)::text   AS ids,
                  array_agg(t.content_hash ORDER BY t.id)::text AS hashes
           FROM (SELECT id, content_hash, coalesce(search_text, '') AS txt
                 FROM "{{SCHEMA}}".facts
                 WHERE embedding IS NULL
                    OR last_embedded_hash IS DISTINCT FROM content_hash
                    OR embedding_model IS DISTINCT FROM %L
                 ORDER BY id
                 LIMIT %s) t
           HAVING count(*) > 0$q$,
        v_inputfield, v_model, v_model, greatest(p_batch, 1));

    -- Zip-back: data[i] ↔ ids[i] positionally (WITH ORDINALITY); write the
    -- SELECT-time hash, stamp the model.
    v_zip_sql := format(
        $q$WITH resp AS (SELECT ($resp::jsonb->>'body')::jsonb AS j),
                emb  AS (SELECT v.ord, v.e->'embedding' AS vec
                         FROM resp, jsonb_array_elements(resp.j->'data') WITH ORDINALITY AS v(e, ord)),
                tgt  AS (SELECT u.id, u.h, u.ord
                         FROM unnest(($batch.ids)::bigint[], ($batch.hashes)::text[]) WITH ORDINALITY AS u(id, h, ord))
           UPDATE "{{SCHEMA}}".facts f
              SET embedding          = (emb.vec)::text::vector,
                  embedded_at        = now(),
                  embedding_model    = %L,
                  last_embedded_hash = tgt.h
             FROM emb JOIN tgt ON tgt.ord = emb.ord
            WHERE f.id = tgt.id$q$,
        v_model);

    RETURN df.loop(
        df.seq(
            df.sleep(greatest(p_interval, 1)::bigint),
            df.seq(
                df.as(df.sql(v_batch_sql), 'batch'),
                df.if_rows('batch',
                    df.seq(
                        df.as(df.http(v_url, 'POST', '$batch.body', v_headers, v_timeout), 'resp'),
                        df.sql(v_zip_sql)),
                    df.sql('SELECT 1')))),
        NULL);
END $fn$;
