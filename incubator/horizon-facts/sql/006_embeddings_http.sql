-- 006_embeddings_http.sql
-- In-DB EMBEDDING pipeline via pg_durable's df.http() (HorizonDB).
--
-- HorizonDB does NOT ship pgsql-http (the `http` extension). The supported way
-- to make an outbound HTTP call from inside the database is pg_durable's
-- df.http(), which runs the request as a DURABLE instance executed by the
-- pg_durable worker. This file installs:
--   1. embedding_config        — single-row endpoint config
--   2. embed_new_facts_durable — a PROCEDURE that embeds pending facts, one
--                                durable df.http() instance per fact.
--
-- This is the ONLY model inference HorizonDB runs (see CRAWLER-SPEC.md §3.3).
-- Harvesting is NOT here — it is done by user agents.
--
-- ── Why a PROCEDURE (not a function) ────────────────────────────────────────
-- df.start() enqueues a durable instance the worker runs in its OWN connection.
-- The worker cannot see the instance until the enqueuing transaction COMMITs.
-- A SQL function can't COMMIT, so the loop is a procedure: per fact it does
-- df.start(df.http(...)) → COMMIT → df.wait_for_completion → parse df.result →
-- UPDATE → COMMIT.
--
-- ── df.http allow-list (IMPORTANT) ──────────────────────────────────────────
-- df.http() only permits approved Azure service domains. The Azure AI Foundry
-- "unified" host *.services.ai.azure.com is BLOCKED ("not in the allowed
-- endpoint list"); the classic Azure OpenAI host *.openai.azure.com points at
-- the same deployment and IS allowed. Store the *.openai.azure.com host in
-- embedding_config.url. (The Node fallback embedPending() works with either.)
--
-- Requires: pg_durable in shared_preload_libraries + CREATE EXTENSION pg_durable,
--           and the `vector` extension. Grant HTTP usage to the running role:
--               SELECT df.grant_usage(current_user, true, false);
--
-- Usage: psql "$HORIZON_DATABASE_URL" -v schema=horizon_facts -f 006_embeddings_http.sql

\set schema horizon_facts

CREATE EXTENSION IF NOT EXISTS pg_durable;
CREATE EXTENSION IF NOT EXISTS vector;

-- Allow the current role to use df + df.http (idempotent).
SELECT df.grant_usage(current_user, true, false);

-- ── Endpoint config (single row) ────────────────────────────────────────────
-- SECURITY (incubation): api_key is stored here for the in-DB call. In
-- production, source it from Key Vault / managed identity, not a plaintext
-- column, and lock this table down with RLS / restricted grants.
CREATE TABLE IF NOT EXISTS :"schema".embedding_config (
    id              INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    url             TEXT NOT NULL,   -- MUST be a *.openai.azure.com host (allow-list)
    model           TEXT NOT NULL,
    dim             INT  NOT NULL,
    api_key         TEXT,
    key_header      TEXT NOT NULL DEFAULT 'api-key',
    input_field     TEXT NOT NULL DEFAULT 'input',
    timeout_seconds INT  NOT NULL DEFAULT 30,
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE :"schema".embedding_config
    ADD COLUMN IF NOT EXISTS timeout_seconds INT NOT NULL DEFAULT 30;

-- ── Durable embed: POST each pending fact → vector, via df.http() ────────────
CREATE OR REPLACE PROCEDURE :"schema".embed_new_facts_durable(
    p_batch INT DEFAULT 128,
    INOUT p_count INT DEFAULT 0
)
LANGUAGE plpgsql
AS $proc$
DECLARE
    c        :"schema".embedding_config%ROWTYPE;
    r        RECORD;
    txt      TEXT;
    v_body   TEXT;
    v_hdrs   JSONB;
    v_iid    TEXT;
    v_res    TEXT;
    v_emb    vector;
BEGIN
    SELECT * INTO c FROM :"schema".embedding_config WHERE id = 1;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'embedding_config not set; cannot embed in-DB';
    END IF;

    v_hdrs := jsonb_build_object(c.key_header, c.api_key, 'content-type', 'application/json');
    p_count := 0;

    FOR r IN
        SELECT id, key, value, content_hash
        FROM :"schema".facts
        WHERE embedding IS NULL
           OR last_embedded_hash IS DISTINCT FROM content_hash
        ORDER BY id
        LIMIT p_batch
    LOOP
        txt := concat_ws(' ', r.key, r.value->>'name', r.value->>'description', r.value->>'text');
        v_body := jsonb_build_object(c.input_field, txt, 'model', c.model)::text;

        -- Enqueue a durable HTTP instance and COMMIT so the worker can run it.
        v_iid := df.start(df.http(c.url, 'POST', v_body, v_hdrs, c.timeout_seconds), 'hz-embed', NULL);
        COMMIT;

        PERFORM df.wait_for_completion(v_iid, c.timeout_seconds + 10);
        v_res := df.result(v_iid);

        IF v_res IS NULL OR (v_res::jsonb ->> 'ok')::boolean IS NOT TRUE THEN
            RAISE EXCEPTION 'in-DB embed failed for fact %: %', r.id, COALESCE(v_res, '<null>');
        END IF;

        -- df.http result: {"ok":true,"body":"<raw json>","status":200,...}
        -- body is the AOAI response: {"data":[{"embedding":[...]}]}
        v_emb := (((v_res::jsonb ->> 'body')::jsonb -> 'data' -> 0 -> 'embedding')::text)::vector;

        UPDATE :"schema".facts
           SET embedding          = v_emb,
               embedded_at        = now(),
               embedding_model    = c.model,
               last_embedded_hash = r.content_hash
         WHERE id = r.id;

        p_count := p_count + 1;
        COMMIT;
    END LOOP;
END
$proc$;

-- ── Optional pg_durable maintenance loop (embeddings only — no harvesting) ───
-- Drive embed_new_facts_durable on a schedule. The loop body is a df.sql node
-- that CALLs the procedure; the procedure's own df.http instances are nested
-- durable work. Comment out if you prefer to call embedNewFactsInDb() on demand.
--
-- SELECT df.start(
--     df.loop(
--         df.seq(
--             df.wait_for_schedule('*/5 * * * *'),
--             df.sql('CALL horizon_facts.embed_new_facts_durable(128, NULL)')
--         ),
--         'true'
--     ),
--     'horizon-facts-embeddings',
--     NULL
-- );
