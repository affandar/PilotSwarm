-- 005_open_graph.sql
-- Open, ontology-free graph layer for the LLM crawler. See CRAWLER.md.
-- HorizonDB + AGE only. Generic Entity / REL / EVIDENCED_BY with strict
-- provenance, layered NEXT TO the fixed structural graph from 002_age_graph.sql.
--
-- Usage: psql "$HORIZON_DATABASE_URL" -f 005_open_graph.sql

LOAD 'age';
SET search_path = ag_catalog, "$user", public;

SELECT create_graph('horizon_facts')
WHERE NOT EXISTS (SELECT 1 FROM ag_graph WHERE name = 'horizon_facts');

-- ── Design notes (the open layer is "label-stable, semantics-open") ──────────
-- AGE wants known labels, so we use exactly three labels:
--   (:Entity)            — open `kind` property (person/patch/code_file/topic/…)
--   -[:REL]->            — open `predicate` property (free text)
--   -[:EVIDENCED_BY]->   — node/edge → Fact provenance
-- Semantics live in PROPERTIES, not labels, so no migration is ever needed to
-- express a new entity kind or relationship predicate.

-- ── Canonical Cypher the crawler interface emits ────────────────────────────
-- (Parameterized via cypher(graph, $$ … $$, $params). Shown here as the spec.)

-- upsertEntity(kind, name, entity_key, aliases[], agent_id):
--   MERGE (e:Entity { entity_key: $entity_key })
--   ON CREATE SET e.kind=$kind, e.name=$name, e.aliases=$aliases,
--                 e.created_by=$agent_id, e.created_at=timestamp(), e.updated_at=timestamp()
--   ON MATCH  SET e.aliases=$aliases, e.updated_at=timestamp()   -- aliases pre-merged app-side
--   RETURN e

-- assertRelationship(from_key, to_key, predicate, predicate_key, conf,
--                    observations, evidence[], agent_id, model):
--   The app layer (graph-model.ts decideEdgeMerge) decides create vs reinforce
--   and computes the new confidence/observations, then emits ONE of:
--
--   -- create:
--   MATCH (a { entity_key: $from_key }), (b { entity_key: $to_key })
--   CREATE (a)-[r:REL { predicate:$predicate, predicate_key:$predicate_key,
--                       confidence:$conf, observations:1,
--                       asserted_by:[$agent_id], evidence:$evidence,
--                       model:$model, first_seen:timestamp(), last_seen:timestamp() }]->(b)
--   RETURN r
--
--   -- reinforce (matched on from/to/predicate_key):
--   MATCH (a { entity_key:$from_key })-[r:REL { predicate_key:$predicate_key }]->(b { entity_key:$to_key })
--   SET r.confidence=$conf, r.observations=$observations,
--       r.evidence=$evidence, r.last_seen=timestamp(),
--       r.asserted_by = CASE WHEN $agent_id IN r.asserted_by THEN r.asserted_by
--                            ELSE r.asserted_by + $agent_id END
--   RETURN r

-- linkEvidence(node_key, fact_scope_keys[]):
--   MATCH (e { entity_key:$node_key })
--   UNWIND $fact_scope_keys AS sk
--     MATCH (f:Fact { scope_key: sk })
--     MERGE (e)-[:EVIDENCED_BY]->(f)
-- (Fact nodes come from 002_age_graph backfill; EVIDENCED_BY references ids only.)

-- mergeEntities(from_key, into_key):  entity resolution / alias collapse.
--   MATCH (from:Entity { entity_key:$from_key }), (into:Entity { entity_key:$into_key })
--   -- repoint REL edges, union aliases, then delete the duplicate node.
--   (Implemented as a small multi-statement helper in the adapter; AGE lacks a
--    single-call node-merge, so this is done explicitly and is reconciled by the
--    pg_durable reconcile_graph activity.)

-- ── Querying the open graph (two modes only — see CRAWLER.md §7) ────────────
-- Mode 2, exact-predicate (agent supplies a name from its own ontology):
--   MATCH (a:Entity)-[r:REL]->(b:Entity)
--   WHERE r.predicate_key = $predicate_key AND r.confidence >= $min_conf
--   RETURN a.entity_key, r.predicate, r.confidence, b.entity_key
--
-- Mode 1, anchor-and-explore (read the predicates that exist around a node):
--   neighbourhood(entity_key, depth):
--   MATCH (e:Entity { entity_key:$entity_key })-[r:REL*1..$depth]-(n:Entity)
--   RETURN e, r, n
-- There is no fuzzy/semantic predicate match; predicate_key equality only.

-- ── Provenance / audit guarantee ────────────────────────────────────────────
-- Every REL has non-empty `evidence` (enforced app-side in validateAssertion;
-- no evidence ⇒ the assertion never reaches Cypher). Every Entity should have at
-- least one EVIDENCED_BY edge. reconcile_graph (004_pipelines.sql) flags any
-- Entity/REL whose evidence facts no longer exist, keeping the graph rebuildable
-- and auditable from the authoritative facts table.
