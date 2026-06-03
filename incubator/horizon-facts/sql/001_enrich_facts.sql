-- 001_enrich_facts.sql
-- Phase 1+2 storage enrichment for the enhanced facts interface.
-- HorizonDB-only. Idempotent. Operates on a schema-qualified facts table.
--
-- Usage: psql "$HORIZON_DATABASE_URL" -v schema=horizon_facts_poc -f 001_enrich_facts.sql
-- (PoCs substitute :schema; default below is for standalone runs.)

\set schema horizon_facts_poc

-- Standalone PoC table mirroring PilotSwarm's facts shape. When integrated this
-- block is skipped (the real facts table already exists) and only the ALTERs run.
CREATE SCHEMA IF NOT EXISTS :"schema";

CREATE TABLE IF NOT EXISTS :"schema".facts (
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
);

-- ── Lexical (pg_textsearch) ─────────────────────────────────────────────────
-- Generated, stored tsvector over key + the searchable text inside the value.
-- Weighted: key (A) > name (A) > description (B) > free text (C).
ALTER TABLE :"schema".facts
    ADD COLUMN IF NOT EXISTS search_tsv tsvector
    GENERATED ALWAYS AS (
        setweight(to_tsvector('english', coalesce(key, '')), 'A') ||
        setweight(to_tsvector('english', coalesce(value->>'name', '')), 'A') ||
        setweight(to_tsvector('english', coalesce(value->>'description', '')), 'B') ||
        setweight(to_tsvector('english', coalesce(value->>'text', '')), 'C')
    ) STORED;

CREATE INDEX IF NOT EXISTS idx_facts_tsv
    ON :"schema".facts USING GIN (search_tsv);

-- ── Semantic (vector ANN) ───────────────────────────────────────────────────
-- Dimension must match the embedding model (see .env HZ_EMBED_DIM). 1536 here.
-- Requires the vector type to be available in HorizonDB.
ALTER TABLE :"schema".facts ADD COLUMN IF NOT EXISTS embedding       vector(1536);
ALTER TABLE :"schema".facts ADD COLUMN IF NOT EXISTS embedded_at     TIMESTAMPTZ;
ALTER TABLE :"schema".facts ADD COLUMN IF NOT EXISTS embedding_model TEXT;

-- content_hash: detects when the value changed so the pipeline re-embeds.
ALTER TABLE :"schema".facts
    ADD COLUMN IF NOT EXISTS content_hash TEXT
    GENERATED ALWAYS AS (md5(coalesce(value::text, ''))) STORED;

-- HNSW ANN index over cosine distance. Built incrementally as rows get embedded.
CREATE INDEX IF NOT EXISTS idx_facts_embedding
    ON :"schema".facts USING hnsw (embedding vector_cosine_ops);

-- Partial index to let the embed pipeline quickly find work.
CREATE INDEX IF NOT EXISTS idx_facts_needs_embedding
    ON :"schema".facts (id)
    WHERE embedding IS NULL;
