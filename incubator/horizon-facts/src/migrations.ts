// @incubator/horizon-facts — Node-runnable schema setup.
//
// The sql/*.sql files use psql meta-commands (\set, :"schema") for manual apply.
// The adapter needs to bring the schema up through the `pg` driver, so the same
// DDL is expressed here as schema-parameterized statements. This mirrors
// PilotSwarm's SQL-in-TS migration pattern (facts-migrations.ts).
//
// Idempotent: every statement is IF NOT EXISTS / guarded, safe to re-run.

import { ident } from "./sql-util.js";

export interface SetupOptions {
    schema: string;
    graphName: string;
    /** Embedding vector dimension; MUST match the endpoint. */
    embeddingDim: number;
    /** When false, skip vector ANN DDL (lexical + graph only). */
    enableSemantic: boolean;
    /**
     * Vector ANN index method. "diskann" requires pg_diskann to be allow-listed;
     * "hnsw" uses pgvector's built-in HNSW; "auto" (default) prefers diskann and
     * falls back to hnsw when pg_diskann is unavailable.
     */
    annIndex?: "diskann" | "hnsw" | "auto";
}

/** Run the full schema setup (relational facts + AGE graph). */
export async function setupSchema(pool: any, opts: SetupOptions): Promise<void> {
    const s = ident(opts.schema);
    await pool.query(`CREATE SCHEMA IF NOT EXISTS ${s}`);

    // ── Base facts table (mirrors PilotSwarm FactRecord) ────────────────────
    await pool.query(`
        CREATE TABLE IF NOT EXISTS ${s}.facts (
            id          BIGSERIAL PRIMARY KEY,
            scope_key   TEXT NOT NULL UNIQUE,
            key         TEXT NOT NULL,
            value       JSONB NOT NULL,
            agent_id    TEXT,
            session_id  TEXT,
            shared      BOOLEAN NOT NULL DEFAULT FALSE,
            transient   BOOLEAN NOT NULL DEFAULT FALSE,
            tags        TEXT[] NOT NULL DEFAULT '{}',
            created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
            updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
        )
    `);

    // ── Lexical (pg_textsearch) ─────────────────────────────────────────────
    await pool.query(`
        ALTER TABLE ${s}.facts
            ADD COLUMN IF NOT EXISTS search_tsv tsvector
            GENERATED ALWAYS AS (
                setweight(to_tsvector('english', coalesce(key, '')), 'A') ||
                setweight(to_tsvector('english', coalesce(value->>'name', '')), 'A') ||
                setweight(to_tsvector('english', coalesce(value->>'description', '')), 'B') ||
                setweight(to_tsvector('english', coalesce(value->>'text', '')), 'C')
            ) STORED
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_facts_tsv ON ${s}.facts USING GIN (search_tsv)`);

    await pool.query(`
        ALTER TABLE ${s}.facts
            ADD COLUMN IF NOT EXISTS content_hash TEXT
            GENERATED ALWAYS AS (md5(coalesce(value::text, ''))) STORED
    `);

    // ── Semantic (pgvector ANN) ─────────────────────────────────────────────
    if (opts.enableSemantic) {
        await pool.query(`CREATE EXTENSION IF NOT EXISTS vector`);
        const dim = Math.trunc(opts.embeddingDim);
        await pool.query(`ALTER TABLE ${s}.facts ADD COLUMN IF NOT EXISTS embedding vector(${dim})`);
        await pool.query(`ALTER TABLE ${s}.facts ADD COLUMN IF NOT EXISTS embedded_at TIMESTAMPTZ`);
        await pool.query(`ALTER TABLE ${s}.facts ADD COLUMN IF NOT EXISTS embedding_model TEXT`);
        await pool.query(`ALTER TABLE ${s}.facts ADD COLUMN IF NOT EXISTS last_embedded_hash TEXT`);
        await ensureAnnIndex(pool, s, opts.annIndex ?? "auto");
        await pool.query(`
            CREATE INDEX IF NOT EXISTS idx_facts_needs_embedding
                ON ${s}.facts (id) WHERE embedding IS NULL
        `);
    }

    // ── AGE graph ───────────────────────────────────────────────────────────
    await setupGraph(pool, opts.graphName);
}

/**
 * Create the vector ANN index over `embedding` (cosine), preferring DiskANN.
 *
 * DiskANN (Azure's `pg_diskann` extension) gives better recall/latency at scale
 * than HNSW, but it must be allow-listed in the cluster's `azure.extensions`
 * parameter group. When `method` is "diskann" or "auto" we attempt to install
 * pg_diskann and build a diskann index; if that's unavailable (not allow-listed)
 * "auto" transparently falls back to HNSW, while "diskann" surfaces the error.
 *
 * Both AMs share the same `vector_cosine_ops` opclass and the same query
 * operator (`<=>`), so retrieval code is identical regardless of which is built.
 */
async function ensureAnnIndex(
    pool: any,
    s: string,
    method: "diskann" | "hnsw" | "auto",
): Promise<void> {
    const buildHnsw = () => pool.query(`
        CREATE INDEX IF NOT EXISTS idx_facts_embedding
            ON ${s}.facts USING hnsw (embedding vector_cosine_ops)
    `);

    if (method === "hnsw") {
        await buildHnsw();
        return;
    }

    try {
        await pool.query(`CREATE EXTENSION IF NOT EXISTS pg_diskann CASCADE`);
        await pool.query(`
            CREATE INDEX IF NOT EXISTS idx_facts_embedding
                ON ${s}.facts USING diskann (embedding vector_cosine_ops)
        `);
    } catch (err: any) {
        if (method === "diskann") {
            throw new Error(
                `DiskANN index requested but pg_diskann is unavailable: ${err?.message ?? err}. ` +
                `Add pg_diskann to the cluster's azure.extensions parameter group (and restart), ` +
                `or set annIndex: "hnsw"/"auto".`,
            );
        }
        // auto: fall back to HNSW.
        await buildHnsw();
    }
}

/**
 * Load the AGE shared library for this session.
 *
 * On vanilla Postgres, `LOAD 'age'` is required before using AGE. On managed
 * Postgres (Azure HorizonDB / Flexible Server) where `age` is in
 * `shared_preload_libraries`, the library is already loaded and an explicit
 * `LOAD` is rejected with `access to library "age" is not allowed`. In that
 * case the LOAD is unnecessary, so we tolerate that specific error.
 */
async function loadAge(client: any): Promise<void> {
    try {
        await client.query(`LOAD 'age'`);
    } catch (err: any) {
        const msg = String(err?.message ?? "");
        if (!/access to library "age" is not allowed/i.test(msg)) throw err;
        // Preloaded via shared_preload_libraries — nothing to do.
    }
}

/** Ensure the AGE extension is loaded and the named graph exists. */
export async function setupGraph(pool: any, graphName: string): Promise<void> {
    await pool.query(`CREATE EXTENSION IF NOT EXISTS age`);
    await loadAge(pool);
    await pool.query(`SET search_path = ag_catalog, "$user", public`);
    const { rows } = await pool.query(
        `SELECT 1 FROM ag_catalog.ag_graph WHERE name = $1`,
        [graphName],
    );
    if (rows.length === 0) {
        await pool.query(`SELECT ag_catalog.create_graph($1)`, [graphName]);
    }
}

/**
 * Prepare a connection/pool to run AGE Cypher: AGE requires `LOAD 'age'` and the
 * ag_catalog search_path on every session. Call before issuing cypher().
 */
export async function prepareAgeSession(client: any): Promise<void> {
    await loadAge(client);
    await client.query(`SET search_path = ag_catalog, "$user", public`);
}
