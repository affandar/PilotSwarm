-- 0007_embed_key_value_text — embed the KEY + the FULL VALUE, not the
-- cherry-picked search_text columns (03-design §3, embed-input correctness).
--
-- WHY. The 0005 embedder built its per-fact input from `search_text`, a STORED
-- generated column that concatenates only a fixed set of conventional value
-- fields:
--
--   coalesce(key,'') || ' ' || value->>'name' || ' ' || value->>'description'
--                    || ' ' || value->>'text' || ' ' || value->>'body'
--                    || ' ' || value->>'subject'
--
-- For a fact whose value uses ANY other shape — e.g. a harvested document
-- stored as { "title": ..., "content": ... } — none of those fields match, so
-- search_text collapses to essentially just the key and the embedding carries
-- almost no signal. The vector column then exists but is useless for semantic /
-- hybrid retrieval and for the harvester's facts_similar refinement (0006).
--
-- FIX. Embed `key` + a delimiter + the WHOLE value rendered as text, so the
-- embedding represents the entire fact regardless of value shape:
--
--   coalesce(key,'') || E'\n' || coalesce(value::text,'')
--
-- This mirrors how content_hash already keys off `key || value::text` (0001):
-- the embed input now covers exactly what the hash covers, so "content changed
-- ⇒ re-embed" stays coherent. `search_text` (lexical/BM25) is intentionally
-- left unchanged — this migration only changes the EMBEDDING input text.
--
-- Only the `t.txt` projection inside v_batch_sql changes versus 0005; the loop
-- shape, batching, config-var reads, and zip-back write-back are identical. This
-- is a CREATE OR REPLACE of the workflow BUILDER. A loop instance that is
-- already running was baked from the old function body at df.start and will keep
-- using the old text until it is cancelled and restarted (configureEmbedder
-- restart, stopEmbedder + startEmbedder, or a fresh deploy after the schema +
-- durable instance are dropped). New deployments pick it up immediately.
--
-- Tokens: {{SCHEMA}}.

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
    --
    -- Embed input (CHANGED in 0007): key + delimiter + the FULL value as text,
    -- so any value shape is represented — not just the search_text fields.
    v_batch_sql := format(
        $q$SELECT jsonb_build_object(%L, jsonb_agg(t.txt ORDER BY t.id), 'model', %L)::text AS body,
                  array_agg(t.id ORDER BY t.id)::text   AS ids,
                  array_agg(t.content_hash ORDER BY t.id)::text AS hashes
           FROM (SELECT id, content_hash,
                        coalesce(key, '') || E'\n' || coalesce(value::text, '') AS txt
                 FROM "{{SCHEMA}}".facts
                 WHERE embedding IS NULL
                    OR last_embedded_hash IS DISTINCT FROM content_hash
                    OR embedding_model IS DISTINCT FROM %L
                 ORDER BY id
                 LIMIT %s) t
           HAVING count(*) > 0$q$,
        v_inputfield, v_model, v_model, greatest(p_batch, 1));

    -- Zip-back: data[i] ↔ ids[i] positionally (WITH ORDINALITY); write the
    -- SELECT-time hash, stamp the model. (Unchanged from 0005.)
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
