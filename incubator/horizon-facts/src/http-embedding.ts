// @incubator/horizon-facts — in-database HTTP embedding pipeline setup.
//
// Node-runnable mirror of sql/006_embeddings_http.sql. Installs the `http`
// extension, the embedding_config row, and the horizon_embed_text /
// embed_new_facts functions so pg_durable (or a direct SELECT) can embed facts
// by POSTing to the configured endpoint from inside the database.
//
// Returns a capability report so callers/tests can tell whether the in-DB HTTP
// path is actually available on this cluster.

import type { EmbeddingEndpointConfig } from "./config.js";
import { ident } from "./sql-util.js";

export interface HttpEmbeddingCapability {
    /** True if `CREATE EXTENSION http` succeeded (pgsql-http available). */
    httpExtension: boolean;
    /** True if the full pipeline (config + functions) was installed. */
    installed: boolean;
    /** Populated when httpExtension is false. */
    note?: string;
}

/**
 * Install the in-DB HTTP embedding pipeline for `schema`, pointed at `endpoint`.
 * Idempotent. Does NOT throw if the http extension is missing — it reports that
 * via the returned capability so the caller can fall back to embedPending().
 */
export async function setupHttpEmbedding(
    pool: any,
    schema: string,
    endpoint: EmbeddingEndpointConfig,
): Promise<HttpEmbeddingCapability> {
    const s = ident(schema);

    let httpExtension = false;
    try {
        await pool.query(`CREATE EXTENSION IF NOT EXISTS http`);
        httpExtension = true;
    } catch (err: any) {
        return {
            httpExtension: false,
            installed: false,
            note: `http extension unavailable: ${err?.message ?? err}. ` +
                  `Use embedPending() (Node fallback) or install pgsql-http / rework for pg_net.`,
        };
    }

    await pool.query(`
        CREATE TABLE IF NOT EXISTS ${s}.embedding_config (
            id          INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
            url         TEXT NOT NULL,
            model       TEXT NOT NULL,
            dim         INT  NOT NULL,
            api_key     TEXT,
            key_header  TEXT NOT NULL DEFAULT 'api-key',
            input_field TEXT NOT NULL DEFAULT 'input',
            updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
        )
    `);

    await pool.query(
        `INSERT INTO ${s}.embedding_config (id, url, model, dim, api_key, key_header, input_field, updated_at)
         VALUES (1, $1, $2, $3, $4, $5, $6, now())
         ON CONFLICT (id) DO UPDATE SET
            url = EXCLUDED.url, model = EXCLUDED.model, dim = EXCLUDED.dim,
            api_key = EXCLUDED.api_key, key_header = EXCLUDED.key_header,
            input_field = EXCLUDED.input_field, updated_at = now()`,
        [
            endpoint.url,
            endpoint.model,
            endpoint.dim,
            endpoint.apiKey ?? null,
            endpoint.apiKeyHeader ?? "api-key",
            endpoint.inputField ?? "input",
        ],
    );

    await pool.query(`
        CREATE OR REPLACE FUNCTION ${s}.horizon_embed_text(p_text TEXT)
        RETURNS vector
        LANGUAGE plpgsql
        AS $fn$
        DECLARE
            c           ${s}.embedding_config%ROWTYPE;
            req_headers http_header[];
            resp        http_response;
            emb_json    JSONB;
        BEGIN
            SELECT * INTO c FROM ${s}.embedding_config WHERE id = 1;
            IF NOT FOUND THEN
                RAISE EXCEPTION 'embedding_config not set';
            END IF;
            req_headers := ARRAY[]::http_header[];
            IF c.api_key IS NOT NULL THEN
                req_headers := req_headers || http_header(c.key_header, c.api_key);
            END IF;
            SELECT * INTO resp FROM http((
                'POST', c.url, req_headers, 'application/json',
                jsonb_build_object(c.input_field, p_text, 'model', c.model)::text
            )::http_request);
            IF resp.status <> 200 THEN
                RAISE EXCEPTION 'embedding endpoint % returned %', c.url, resp.status;
            END IF;
            emb_json := (resp.content::jsonb) -> 'data' -> 0 -> 'embedding';
            IF emb_json IS NULL THEN
                RAISE EXCEPTION 'embedding response missing data[0].embedding';
            END IF;
            RETURN (emb_json::text)::vector;
        END;
        $fn$;
    `);

    await pool.query(`
        CREATE OR REPLACE FUNCTION ${s}.embed_new_facts(p_batch INT DEFAULT 128)
        RETURNS INT
        LANGUAGE plpgsql
        AS $fn$
        DECLARE
            r       RECORD;
            n       INT := 0;
            txt     TEXT;
            c_model TEXT;
        BEGIN
            SELECT model INTO c_model FROM ${s}.embedding_config WHERE id = 1;
            FOR r IN
                SELECT id, key, value, content_hash
                FROM ${s}.facts
                WHERE embedding IS NULL
                   OR last_embedded_hash IS DISTINCT FROM content_hash
                ORDER BY id
                LIMIT p_batch
            LOOP
                txt := concat_ws(' ', r.key, r.value->>'name', r.value->>'description', r.value->>'text');
                UPDATE ${s}.facts
                   SET embedding          = ${s}.horizon_embed_text(txt),
                       embedded_at        = now(),
                       embedding_model    = c_model,
                       last_embedded_hash = r.content_hash
                 WHERE id = r.id;
                n := n + 1;
            END LOOP;
            RETURN n;
        END;
        $fn$;
    `);

    return { httpExtension: true, installed: true };
}
