-- 0001_facts_table — base facts table (PilotSwarm parity) + enrichment columns
-- + the write-resets-pending-state trigger (03-design §2.1).
--
-- Tokens substituted by horizon-migrator: {{SCHEMA}}, {{EMBEDDING_DIM}}.

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS "{{SCHEMA}}".facts (
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
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (NOT (shared AND transient)),

    -- Enrichment (EnhancedFactStore): all derived/rebuildable.
    -- The embeddable/searchable text: key + the conventional value fields.
    -- (immutable expression required for a generated column: || + coalesce)
    search_text TEXT GENERATED ALWAYS AS (
        coalesce(key, '')
            || ' ' || coalesce(value->>'name', '')
            || ' ' || coalesce(value->>'description', '')
            || ' ' || coalesce(value->>'text', '')
            || ' ' || coalesce(value->>'body', '')
            || ' ' || coalesce(value->>'subject', '')
    ) STORED,
    content_hash       TEXT,                                   -- trigger-maintained (NOT generated:
                                                               -- a BEFORE trigger must read+reset on change)
    last_crawled_at    TIMESTAMPTZ,                            -- NULL ⇒ pending crawl
    embedding          vector({{EMBEDDING_DIM}}),              -- NULL until embedded
    embedded_at        TIMESTAMPTZ,
    embedding_model    TEXT,
    last_embedded_hash TEXT
);

-- Base indexes (SDK parity).
CREATE INDEX IF NOT EXISTS idx_facts_key       ON "{{SCHEMA}}".facts (key);
CREATE INDEX IF NOT EXISTS idx_facts_tags      ON "{{SCHEMA}}".facts USING GIN (tags);
CREATE INDEX IF NOT EXISTS idx_facts_session   ON "{{SCHEMA}}".facts (session_id);
CREATE INDEX IF NOT EXISTS idx_facts_agent     ON "{{SCHEMA}}".facts (agent_id);
CREATE INDEX IF NOT EXISTS idx_facts_shared    ON "{{SCHEMA}}".facts (shared);
CREATE INDEX IF NOT EXISTS idx_facts_transient ON "{{SCHEMA}}".facts (transient);

-- Work-queue indexes.
CREATE INDEX IF NOT EXISTS idx_facts_uncrawled
    ON "{{SCHEMA}}".facts (id) WHERE last_crawled_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_facts_needs_embedding
    ON "{{SCHEMA}}".facts (id) WHERE embedding IS NULL;

-- Write-resets-pending-state (01-functional-spec §6.6, 03-design §2.1):
-- recompute content_hash from the embeddable content; when it changes,
-- (a) reset last_crawled_at → NULL so the harvester re-crawls, and
-- (b) leave last_embedded_hash stale so the embedder re-embeds.
-- Identical-content writes change NOTHING (C4).
CREATE OR REPLACE FUNCTION "{{SCHEMA}}".facts_touch() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    new_hash TEXT;
BEGIN
    new_hash := md5(coalesce(NEW.key, '') || E'\x1f' || coalesce(NEW.value::text, ''));
    IF TG_OP = 'INSERT' OR new_hash IS DISTINCT FROM OLD.content_hash THEN
        NEW.content_hash := new_hash;
        NEW.last_crawled_at := NULL;
    END IF;
    RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS facts_touch ON "{{SCHEMA}}".facts;
CREATE TRIGGER facts_touch
    BEFORE INSERT OR UPDATE ON "{{SCHEMA}}".facts
    FOR EACH ROW EXECUTE FUNCTION "{{SCHEMA}}".facts_touch();
