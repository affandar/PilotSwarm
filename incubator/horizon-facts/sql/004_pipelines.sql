-- 004_pipelines.sql
-- Phase 2/4 durable maintenance pipelines (pg_durable / duroxide).
-- These are the ONLY place embedding + relatedness compute happens. They run in
-- the in-database background worker, idle-aware and crash-safe via replay.
--
-- Determinism rule: embed_new_facts / refresh_related_edges / reconcile_graph /
-- age_out_skills are ACTIVITIES (durable.func) — they do the IO. The loop only
-- schedules them. Never put IO directly in the orchestration body.
--
-- Usage: psql "$HORIZON_DATABASE_URL" -f 004_pipelines.sql

-- ── Activity contracts (registered Rust/SQL UDFs in HorizonDB) ───────────────
-- embed_new_facts(batch INT):
--   SELECT rows WHERE embedding IS NULL OR content_hash <> last_embedded_hash
--   → call AI-pipeline embedding model
--   → UPDATE facts SET embedding, embedded_at = now(), embedding_model = $model
--   Returns count embedded.
--
-- refresh_related_edges(k INT, min REAL):
--   For each fact embedded since last run:
--     ANN top-k neighbours over embedding (excluding self, above `min`)
--     MERGE (a:Fact)-[:RELATED_TO { score, model, computed_at }]->(b:Fact)
--   Returns count of edges upserted.
--
-- reconcile_graph():
--   Diff structural edges (STORED/SPAWNED/AUTHORED/TAGGED) vs the facts/CMS
--   tables; MERGE missing, drop orphaned. Makes the async structural writer
--   self-healing so a flaky AGE call can never corrupt the authoritative table.
--
-- age_out_skills():
--   Mark skills past TTL/usage thresholds as aged-out; prune their RELATED_TO.

-- ── The main maintenance loop (continuous, idle-gated) ───────────────────────
-- wait_idle(max_cpu_fraction, max_active_sessions) only proceeds when the DB is
-- quiet, so memory upkeep never competes with live PilotSwarm traffic.
SELECT df.start(
    df.loop(
        df.wait_idle(0.20, 3)
        ~> df.func('embed_new_facts',       '{"batch": 128}')
        ~> df.func('refresh_related_edges', '{"k": 8, "min": 0.75}')
        ~> df.func('reconcile_graph',       '{}')
    ),
    'horizon-facts-maintenance'
);

-- ── Daily age-out (separate schedule) ───────────────────────────────────────
SELECT df.start(
    df.loop(
        df.wait_for_schedule('0 4 * * *')         -- 04:00 daily
        ~> df.func('age_out_skills', '{}')
    ),
    'horizon-facts-age-out'
);

-- Observability: all pipeline state lives in pg_durable's tables — inspect with
--   SELECT df.status('horizon-facts-maintenance');
--   SELECT * FROM df.instances WHERE label LIKE 'horizon-facts-%';
