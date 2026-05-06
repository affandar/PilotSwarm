-- DB Optimization Phase 2 — EXPLAIN ANALYZE templates
--
-- Run these against your PostgreSQL database to verify query plans
-- and index usage for the three key optimized query paths.
--
-- Replace :schema with your CMS schema name (default: pilotswarm_cms)
-- Replace :session_id with a real session ID from your database
-- Replace :since with a timestamp, e.g. NOW() - INTERVAL '24 hours'
--
-- Usage (psql):
--   psql $DATABASE_URL -v schema=pilotswarm_cms -v session_id="your-session-id" -f explain-pack.sql
--
-- Or set variables manually:
--   \set schema pilotswarm_cms
--   \set session_id 'your-session-id'

-- ─── 1. Paged session listing ─────────────────────────────────────
--
-- Expected plan: Index Scan using idx_sessions_updated_at_session_id (or similar)
-- on sessions table. Should NOT be a Seq Scan on large fleets.
-- Look for: "Index Scan" on the ORDER BY columns (updated_at DESC, session_id DESC).

EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
SELECT *
FROM :schema.sessions s
WHERE s.deleted_at IS NULL
  AND (
    -- First page: no cursor
    TRUE
    -- Subsequent page (example cursor values):
    -- s.updated_at < '2026-04-30T00:00:00Z'::timestamptz
    -- OR (s.updated_at = '2026-04-30T00:00:00Z'::timestamptz AND s.session_id < 'cursor-session-id')
  )
ORDER BY s.updated_at DESC, s.session_id DESC
LIMIT 51;  -- 50 + 1 for hasMore probe


-- ─── 2. Session events by session_id with limit ───────────────────
--
-- Expected plan: Index Scan on session_events(session_id, seq).
-- Should NOT be a Seq Scan. Rows examined should equal LIMIT, not the full session count.
-- Look for: "Index Scan using session_events_session_id_seq_idx" (or equivalent).

EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
SELECT *
FROM :schema.session_events
WHERE session_id = :'session_id'
ORDER BY seq ASC
LIMIT 200;


-- ─── 3. Top event emitters aggregation ───────────────────────────
--
-- Expected plan: Seq Scan or Index Scan on session_events filtered by created_at.
-- The aggregation (GROUP BY worker_node_id, event_type) will be a HashAggregate.
-- This is inherently heavier than the two queries above; the window guard (30-day
-- max lookback enforced by the RPC layer) limits the scan range.
-- Look for: filter on created_at >= :since reducing rows before aggregation.
-- If the scan is too wide, consider adding an index on session_events(created_at).

EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
SELECT
    se.worker_node_id,
    se.event_type,
    COUNT(*)::BIGINT                      AS event_count,
    COUNT(DISTINCT se.session_id)::BIGINT AS session_count,
    MIN(se.created_at)                    AS first_seen_at,
    MAX(se.created_at)                    AS last_seen_at
FROM :schema.session_events se
WHERE se.worker_node_id IS NOT NULL
  AND se.created_at >= :since
GROUP BY se.worker_node_id, se.event_type
ORDER BY event_count DESC, last_seen_at DESC
LIMIT 20;


-- ─── Interpretation guide ─────────────────────────────────────────
--
-- Good signs:
--   • "Index Scan" (not "Seq Scan") on the keyset cursor columns
--   • "Rows Removed by Filter" close to 0 (index is selective)
--   • "Buffers: shared hit=N, read=0" (query is fully cached)
--   • Planning time <5ms, execution time matches latency expectations
--
-- Warning signs:
--   • "Seq Scan" on sessions or session_events for large tables
--   • "Rows Removed by Filter" >> "Rows" (poor selectivity)
--   • "Buffers: read=N" with large N (cold cache or missing index)
--   • "Sort" node with "Sort Method: external merge" (spilling to disk)
--
-- Indexes expected to exist after Phase 2 migrations:
--   • sessions(updated_at DESC, session_id DESC) — for listSessionsPage
--   • session_events(session_id, seq) — for getSessionEvents
--   • session_events(created_at) — beneficial for getTopEventEmitters (not added in Phase 2;
--     add as Phase 3 if EXPLAIN shows wide scans on large datasets)
