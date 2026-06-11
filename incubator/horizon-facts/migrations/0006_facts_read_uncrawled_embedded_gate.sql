-- 0006_facts_read_uncrawled_embedded_gate — add an OPTIONAL embedding gate to
-- the crawl-queue read (01 §5.2 / §6.6 harvester surface).
--
-- Why: the harvester now refines the graph with similarity search over each
-- fact's STORED embedding (facts_similar). A fact with no embedding yet cannot
-- be similarity-refined, so handing it to the harvester early produces a
-- thinner graph. With p_embedded_only => TRUE the queue read SKIPS facts whose
-- embedding is still NULL; they stay uncrawled and reappear on a later turn
-- once the in-DB embed loop (0005) has filled them in. The ungated 2-arg
-- behaviour is preserved as the default (FALSE) so the done-check and any
-- embedding-less deployment keep draining the whole queue.
--
-- Signature change (added param) cannot be done with CREATE OR REPLACE, so the
-- old 2-arg function is dropped first; the new 3-arg form has a DEFAULT so the
-- prior 2-arg call sites bind unchanged.
--
-- Tokens: {{SCHEMA}}.

DROP FUNCTION IF EXISTS "{{SCHEMA}}".facts_read_uncrawled(TEXT, INT);

CREATE OR REPLACE FUNCTION "{{SCHEMA}}".facts_read_uncrawled(
    p_ns_prefix     TEXT,
    p_limit         INT,
    p_embedded_only BOOLEAN DEFAULT FALSE
) RETURNS SETOF "{{SCHEMA}}".facts
LANGUAGE sql STABLE AS $$
    SELECT f.* FROM "{{SCHEMA}}".facts f
    WHERE f.last_crawled_at IS NULL
      AND (p_ns_prefix IS NULL OR f.key LIKE p_ns_prefix)
      AND (NOT p_embedded_only OR f.embedding IS NOT NULL)
    ORDER BY f.id
    LIMIT p_limit;
$$;
