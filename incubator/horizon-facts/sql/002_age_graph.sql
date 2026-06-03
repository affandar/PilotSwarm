-- 002_age_graph.sql
-- Phase 3 AGE overlay: structure-only graph mirroring sessions ↔ facts ↔ skills.
-- HorizonDB-only. The graph stores ids + cheap metadata, NEVER fact values/ACLs.
--
-- Usage: psql "$HORIZON_DATABASE_URL" -f 002_age_graph.sql

LOAD 'age';
SET search_path = ag_catalog, "$user", public;

-- Create the graph (idempotent guard).
SELECT create_graph('horizon_facts')
WHERE NOT EXISTS (SELECT 1 FROM ag_graph WHERE name = 'horizon_facts');

-- ── Structural backfill ─────────────────────────────────────────────────────
-- Deterministic: every edge below is a pure function of existing rows, so this
-- is safe to run/re-run outside any pg_durable orchestration.

-- 1) Fact / Skill nodes from the facts table. (Skill = fact in skills/ namespace.)
--    MERGE keeps it idempotent. We pass rows in via cypher() parameters in the
--    PoC harness; this file documents the canonical Cypher.
--
-- For each fact row:
--   SELECT * FROM cypher('horizon_facts', $$
--     MERGE (f:Fact { scope_key: $scope_key })
--     SET f.key = $key, f.namespace = $namespace, f.shared = $shared
--   $$, $params) AS (v agtype);
--
-- When namespace = 'skills', additionally label it Skill:
--   MERGE (s:Skill { scope_key: $scope_key }) SET s.name = $name

-- 2) Session nodes + SPAWNED edges from the CMS (parent links).
--   MERGE (p:Session { id: $parent_id })
--   MERGE (c:Session { id: $child_id })
--   MERGE (p)-[:SPAWNED]->(c)

-- 3) STORED edges: which session wrote which fact.
--   MATCH (s:Session { id: $session_id }), (f:Fact { scope_key: $scope_key })
--   MERGE (s)-[:STORED]->(f)

-- 4) AUTHORED edges: which agent wrote which fact.
--   MERGE (a:Agent { id: $agent_id })
--   WITH a MATCH (f:Fact { scope_key: $scope_key })
--   MERGE (a)-[:AUTHORED]->(f)

-- 5) TAGGED edges: fan a fact's tags[] into Tag nodes.
--   UNNEST tags → MERGE (t:Tag { name: $tag }) MERGE (f)-[:TAGGED]->(t)

-- 6) DERIVED_FROM edges: intake fact → curated skill (written at curation time).
--   MATCH (i:Fact { scope_key: $intake_key }), (s:Skill { scope_key: $skill_key })
--   MERGE (i)-[:DERIVED_FROM]->(s)

-- RELATED_TO edges are NOT built here — they are derived from embeddings by the
-- pg_durable pipeline in 004_pipelines.sql (refresh_related_edges).

-- ── Example lineage traversal (ACL applied afterward in 003) ─────────────────
-- Get every session id in the spawn tree rooted at $root, then the enhanced
-- search proc resolves fact values + visibility through the facts table.
--   MATCH (root:Session { id: $root })-[:SPAWNED*0..]->(s:Session)
--   RETURN s.id
