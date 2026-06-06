// @incubator/horizon-facts — in-database embedding pipeline via pg_durable.
//
// Node-runnable mirror of sql/006_embeddings_http.sql. Installs the embedding
// config row plus a durable PROCEDURE that embeds pending facts by calling the
// configured endpoint over HTTP FROM INSIDE the database using pg_durable's
// df.http() primitive (HorizonDB does NOT ship pgsql-http; df.http is the
// supported in-DB HTTP path).
//
// Execution model (why a PROCEDURE, not a function):
//   df.start() enqueues a durable instance that the pg_durable worker runs in
//   its OWN connection. The worker cannot see the instance until the enqueuing
//   transaction COMMITs. A plain SQL function can't COMMIT, so the pipeline is a
//   PROCEDURE that does start → COMMIT → df.wait_for_completion → parse → UPDATE
//   per fact. Each embedding is a real durable df.http instance.
//
// Returns a capability report so callers/tests can tell whether the in-DB path
// is actually available on this cluster (df.http present + usage granted).

import type { EmbeddingEndpointConfig } from "./config.js";
import { ident } from "./sql-util.js";

export interface HttpEmbeddingCapability {
    /** True if pg_durable's df.http() is present (the in-DB HTTP primitive). */
    inDbHttp: boolean;
    /** True if the full pipeline (config + durable procedure) was installed. */
    installed: boolean;
    /** The endpoint host actually used in-DB (after allow-list normalization). */
    effectiveUrl?: string;
    /** Populated when inDbHttp is false, or for advisory notes (e.g. host rewrite). */
    note?: string;
}

/**
 * pg_durable's df.http() enforces an egress allow-list: only approved Azure
 * service domains are permitted. The Azure AI Foundry "unified" host
 * (`*.services.ai.azure.com`) is NOT on that list and is rejected with
 * "is not in the allowed endpoint list", but the classic Azure OpenAI host
 * (`*.openai.azure.com`) points at the same deployment and IS allowed.
 *
 * The Node fallback (embedPending) uses Node fetch and works with either host;
 * only the in-DB df.http() path needs this rewrite. We rewrite ONLY the URL we
 * store for the in-DB pipeline, and report it via the capability note.
 */
export function toAllowlistedAzureHost(url: string): { url: string; rewritten: boolean } {
    try {
        const u = new URL(url);
        if (u.hostname.endsWith(".services.ai.azure.com")) {
            const sub = u.hostname.slice(0, -".services.ai.azure.com".length);
            u.hostname = `${sub}.openai.azure.com`;
            return { url: u.toString(), rewritten: true };
        }
    } catch {
        /* not a parseable URL — leave as-is */
    }
    return { url, rewritten: false };
}

/**
 * Install the in-DB embedding pipeline for `schema`, pointed at `endpoint`.
 * Idempotent. Does NOT throw if df.http is missing — it reports that via the
 * returned capability so the caller can fall back to embedPending().
 */
export async function setupHttpEmbedding(
    pool: any,
    schema: string,
    endpoint: EmbeddingEndpointConfig,
): Promise<HttpEmbeddingCapability> {
    const s = ident(schema);

    // 1. Is df.http() present? (pg_durable preloaded + extension created.)
    const { rows: cap } = await pool.query(
        `SELECT EXISTS (
            SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
            WHERE n.nspname = 'df' AND p.proname = 'http'
         ) AS has_df_http`);
    if (!cap[0]?.has_df_http) {
        return {
            inDbHttp: false,
            installed: false,
            note: "df.http() not found. Ensure pg_durable is in shared_preload_libraries " +
                  "and CREATE EXTENSION pg_durable has run. Falling back to embedPending().",
        };
    }

    // 2. Grant the current role df + HTTP usage (best-effort; idempotent).
    try {
        await pool.query(`SELECT df.grant_usage(current_user, true, false)`);
    } catch {
        /* may already be granted, or insufficient privilege — surfaced later if it matters */
    }

    // 3. df.http allow-list: normalize the Foundry host to the classic AOAI host.
    const { url: effectiveUrl, rewritten } = toAllowlistedAzureHost(endpoint.url);

    // 4. Config row (single-row table).
    await pool.query(`
        CREATE TABLE IF NOT EXISTS ${s}.embedding_config (
            id              INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
            url             TEXT NOT NULL,
            model           TEXT NOT NULL,
            dim             INT  NOT NULL,
            api_key         TEXT,
            key_header      TEXT NOT NULL DEFAULT 'api-key',
            input_field     TEXT NOT NULL DEFAULT 'input',
            timeout_seconds INT  NOT NULL DEFAULT 30,
            updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
        )
    `);
    // Tolerate pre-existing tables from older installs that lack timeout_seconds.
    await pool.query(
        `ALTER TABLE ${s}.embedding_config ADD COLUMN IF NOT EXISTS timeout_seconds INT NOT NULL DEFAULT 30`);

    await pool.query(
        `INSERT INTO ${s}.embedding_config
            (id, url, model, dim, api_key, key_header, input_field, timeout_seconds, updated_at)
         VALUES (1, $1, $2, $3, $4, $5, $6, $7, now())
         ON CONFLICT (id) DO UPDATE SET
            url = EXCLUDED.url, model = EXCLUDED.model, dim = EXCLUDED.dim,
            api_key = EXCLUDED.api_key, key_header = EXCLUDED.key_header,
            input_field = EXCLUDED.input_field, timeout_seconds = EXCLUDED.timeout_seconds,
            updated_at = now()`,
        [
            effectiveUrl,
            endpoint.model,
            endpoint.dim,
            endpoint.apiKey ?? null,
            endpoint.apiKeyHeader ?? "api-key",
            endpoint.inputField ?? "input",
            endpoint.timeoutMs ? Math.ceil(endpoint.timeoutMs / 1000) : 30,
        ],
    );

    // 5. Durable embedding procedure. start → COMMIT → wait → parse → UPDATE,
    //    one df.http() durable instance per fact. INOUT p_count returns the
    //    number embedded.
    await pool.query(`
        CREATE OR REPLACE PROCEDURE ${s}.embed_new_facts_durable(
            p_batch INT DEFAULT 128,
            INOUT p_count INT DEFAULT 0
        )
        LANGUAGE plpgsql
        AS $proc$
        DECLARE
            c        ${s}.embedding_config%ROWTYPE;
            r        RECORD;
            txt      TEXT;
            v_body   TEXT;
            v_hdrs   JSONB;
            v_iid    TEXT;
            v_res    TEXT;
            v_emb    vector;
        BEGIN
            SELECT * INTO c FROM ${s}.embedding_config WHERE id = 1;
            IF NOT FOUND THEN
                RAISE EXCEPTION 'embedding_config not set; cannot embed in-DB';
            END IF;

            v_hdrs := jsonb_build_object(c.key_header, c.api_key, 'content-type', 'application/json');
            p_count := 0;

            FOR r IN
                SELECT id, key, value, content_hash
                FROM ${s}.facts
                WHERE embedding IS NULL
                   OR last_embedded_hash IS DISTINCT FROM content_hash
                ORDER BY id
                LIMIT p_batch
            LOOP
                txt := concat_ws(' ', r.key, r.value->>'name', r.value->>'description', r.value->>'text');
                v_body := jsonb_build_object(c.input_field, txt, 'model', c.model)::text;

                -- Enqueue a durable HTTP instance and COMMIT so the pg_durable
                -- worker (separate connection) can pick it up.
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

                UPDATE ${s}.facts
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
    `);

    return {
        inDbHttp: true,
        installed: true,
        effectiveUrl,
        note: rewritten
            ? `df.http allow-list: rewrote endpoint host to ${new URL(effectiveUrl).hostname} ` +
              `(*.services.ai.azure.com is blocked in-DB; *.openai.azure.com is allowed).`
            : undefined,
    };
}
