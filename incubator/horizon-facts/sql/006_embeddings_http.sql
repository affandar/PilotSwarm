-- 006_embeddings_http.sql
-- pg_durable EMBEDDING pipeline via an HTTP endpoint (replaces HorizonDB's
-- built-in aiModelManagement). The maintenance loop calls embed_new_facts(),
-- which embeds each pending fact by POSTing to a configured embeddings endpoint
-- from INSIDE the database using the `http` (pgsql-http) extension.
--
-- This is the ONLY model inference HorizonDB runs (see CRAWLER-SPEC.md §3.3).
-- Harvesting is NOT here — it is done by user agents.
--
-- Requires: the `http` extension (pgsql-http). If your cluster ships `pg_net`
-- instead, the synchronous embed function must be reworked around its async
-- request/poll API — see the Node fallback (`embedPending()`) for bootstrapping.
--
-- Usage: psql "$HORIZON_DATABASE_URL" -v schema=horizon_facts -f 006_embeddings_http.sql

\set schema horizon_facts

CREATE EXTENSION IF NOT EXISTS http;
CREATE EXTENSION IF NOT EXISTS vector;

-- ── Endpoint config (single row) ────────────────────────────────────────────
-- SECURITY (incubation): api_key is stored here for the in-DB call. In
-- production, source it from Key Vault / managed identity, not a plaintext
-- column, and lock this table down with RLS / restricted grants.
CREATE TABLE IF NOT EXISTS :"schema".embedding_config (
    id          INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    url         TEXT NOT NULL,
    model       TEXT NOT NULL,
    dim         INT  NOT NULL,
    api_key     TEXT,
    key_header  TEXT NOT NULL DEFAULT 'api-key',
    input_field TEXT NOT NULL DEFAULT 'input',
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── Synchronous embed: POST text → vector ───────────────────────────────────
CREATE OR REPLACE FUNCTION :"schema".horizon_embed_text(p_text TEXT)
RETURNS vector
LANGUAGE plpgsql
AS $fn$
DECLARE
    c            :"schema".embedding_config%ROWTYPE;
    req_headers  http_header[];
    resp         http_response;
    body         JSONB;
    emb_json     JSONB;
BEGIN
    SELECT * INTO c FROM :"schema".embedding_config WHERE id = 1;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'embedding_config not set; insert the endpoint row first';
    END IF;

    req_headers := ARRAY[]::http_header[];
    IF c.api_key IS NOT NULL THEN
        req_headers := req_headers || http_header(c.key_header, c.api_key);
    END IF;

    body := jsonb_build_object(c.input_field, p_text, 'model', c.model);

    SELECT * INTO resp FROM http((
        'POST',
        c.url,
        req_headers,
        'application/json',
        body::text
    )::http_request);

    IF resp.status <> 200 THEN
        RAISE EXCEPTION 'embedding endpoint % returned %', c.url, resp.status;
    END IF;

    -- OpenAI/AOAI response shape: { "data": [ { "embedding": [...] } ] }
    emb_json := (resp.content::jsonb) -> 'data' -> 0 -> 'embedding';
    IF emb_json IS NULL THEN
        RAISE EXCEPTION 'embedding endpoint response missing data[0].embedding';
    END IF;

    -- jsonb array text "[..]" casts directly to vector.
    RETURN (emb_json::text)::vector;
END;
$fn$;

-- ── Activity: embed a batch of pending facts ────────────────────────────────
-- Selects facts that are unembedded OR whose content changed, embeds each, and
-- records model + content hash so re-embeds only happen when content changes.
CREATE OR REPLACE FUNCTION :"schema".embed_new_facts(p_batch INT DEFAULT 128)
RETURNS INT
LANGUAGE plpgsql
AS $fn$
DECLARE
    r           RECORD;
    n           INT := 0;
    txt         TEXT;
    c_model     TEXT;
BEGIN
    SELECT model INTO c_model FROM :"schema".embedding_config WHERE id = 1;

    FOR r IN
        SELECT id, key, value, content_hash
        FROM :"schema".facts
        WHERE embedding IS NULL
           OR last_embedded_hash IS DISTINCT FROM content_hash
        ORDER BY id
        LIMIT p_batch
    LOOP
        txt := concat_ws(' ',
            r.key,
            r.value->>'name',
            r.value->>'description',
            r.value->>'text');

        UPDATE :"schema".facts
           SET embedding          = :"schema".horizon_embed_text(txt),
               embedded_at        = now(),
               embedding_model    = c_model,
               last_embedded_hash = r.content_hash
         WHERE id = r.id;

        n := n + 1;
    END LOOP;

    RETURN n;
END;
$fn$;

-- ── pg_durable maintenance loop (optional; embeddings only — no harvesting) ──
-- Register once. The loop idle-gates and only schedules embed_new_facts; the
-- activity does the HTTP IO. Comment out if df.* is not present on your cluster
-- (the Node `embedPending()` fallback covers bootstrap/testing).
--
-- SELECT df.start(
--     df.loop(
--         df.wait_idle(0.20, 3)
--         ~> df.func('embed_new_facts', '{"batch": 128}')
--     ),
--     'horizon-facts-embeddings'
-- );
