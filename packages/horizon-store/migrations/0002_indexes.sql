-- 0002_indexes — ANN index over facts.embedding + the lexical (BM25) index.
--
-- ANN: prefer pg_diskann (better recall/latency at scale on HorizonDB), fall
-- back to pgvector HNSW when pg_diskann is not allow-listed. Both share the
-- vector_cosine_ops opclass and the <=> operator, so the search procs are
-- identical either way.
--
-- Tokens: {{SCHEMA}}.

DO $$
BEGIN
    BEGIN
        CREATE EXTENSION IF NOT EXISTS pg_diskann CASCADE;
        EXECUTE 'CREATE INDEX IF NOT EXISTS idx_facts_embedding ON "{{SCHEMA}}".facts USING diskann (embedding vector_cosine_ops)';
    EXCEPTION WHEN OTHERS THEN
        EXECUTE 'CREATE INDEX IF NOT EXISTS idx_facts_embedding ON "{{SCHEMA}}".facts USING hnsw (embedding vector_cosine_ops)';
    END;
END $$;

-- Lexical (BM25) — pg_textsearch is a fail-fast precondition (01 §5.5).
-- Verified on live HorizonDB (pg_textsearch 1.3.0-dev): index AM `bm25`
-- requires WITH (text_config); `col <@> to_bm25query(q, idx)` returns the
-- NEGATIVE BM25 score (ascending order = best first; 0 = no match).
CREATE EXTENSION IF NOT EXISTS pg_textsearch;

CREATE INDEX IF NOT EXISTS idx_facts_lexical
    ON "{{SCHEMA}}".facts USING bm25 (search_text) WITH (text_config = 'english');
