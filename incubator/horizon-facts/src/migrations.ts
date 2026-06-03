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
    /** When false, skip vector/HNSW DDL (lexical + graph only). */
    enableSemantic: boolean;
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
        await pool.query(`
            CREATE INDEX IF NOT EXISTS idx_facts_embedding
                ON ${s}.facts USING hnsw (embedding vector_cosine_ops)
        `);
        await pool.query(`
            CREATE INDEX IF NOT EXISTS idx_facts_needs_embedding
                ON ${s}.facts (id) WHERE embedding IS NULL
        `);
    }

    // ── AGE graph ───────────────────────────────────────────────────────────
    await setupGraph(pool, opts.graphName);
}

/** Ensure the AGE extension is loaded and the named graph exists. */
export async function setupGraph(pool: any, graphName: string): Promise<void> {
    await pool.query(`CREATE EXTENSION IF NOT EXISTS age`);
    await pool.query(`LOAD 'age'`);
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
    await client.query(`LOAD 'age'`);
    await client.query(`SET search_path = ag_catalog, "$user", public`);
}
