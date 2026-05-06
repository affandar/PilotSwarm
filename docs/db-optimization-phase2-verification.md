# DB Optimization Phase 2 — Verification Guide

## What was optimized (Parts 1–5)

| Part | Change | Impact |
|------|--------|--------|
| **1 — RPC caps** | Added `clampInt`/`clampLimit`/`enforceMaxWindowDays` guards in `portal/runtime.js`. Applied limit caps (getSessionEvents/Before: max 500; getSessionTurnMetrics: max 500) and 30-day window guards on all analytics endpoints. | Prevents unbounded reads via the RPC layer regardless of caller intent. |
| **2 — Keyset pagination** | Added `cms_list_sessions_page` SQL function (migration 0011) + `listSessionsPage()` through all layers (SDK → transport → runtime → browser). | Replaces full-table `listSessions` scans with `O(page)` cursor reads. The `+1 hasMore` probe keeps page-existence checks cheap. |
| **3 — SQL-side read bounds** | Migration 0012 added `GREATEST(1, LEAST(COALESCE(p_limit, 200), 500))` bounds to `cms_get_session_events`, `cms_get_session_events_before`, and `cms_get_session_turn_metrics`. | Defense-in-depth: SQL cap applies even if the app layer is bypassed. |
| **4 — Pool guardrails** | `buildPgGuardrailConfig()` in `cms.ts` and `facts-store.ts` reads `DB_POOL_MAX`, `PG_QUERY_TIMEOUT_MS`, `PG_CONNECTION_TIMEOUT_MS`, `PG_IDLE_TIMEOUT_MS`, `PG_STATEMENT_TIMEOUT_MS` from env. Defaults: pool max 10, query timeout 15 s, connection timeout 5 s, idle timeout 30 s. | Prevents connection pool exhaustion and runaway queries under load. |
| **5 — Diagnostics endpoint** | Migration 0013 added `cms_get_top_event_emitters(p_since, p_limit)` + `getTopEventEmitters()` through all layers. Aggregates `(worker_node_id, event_type)` pairs by event count within a time window (max 30 days, max 100 rows). | Allows operators to identify noisy workers/event types without a SQL console. |

---

## Running the verification scripts

All scripts live in `scripts/db-optimization/`. They require Node.js 20+ and a running portal instance.

### Common environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORTAL_URL` | `http://localhost:3001` | Base URL of the running portal |
| `RPC_COOKIE` | _(empty)_ | Full `Cookie` header value (e.g. `session=abc123`) |
| `RPC_TOKEN` | _(empty)_ | Bearer token (used if `RPC_COOKIE` is not set) |

### 1. RPC smoke test

Calls 4 key endpoints and reports status, latency, and payload size.

```bash
PORTAL_URL=http://localhost:3001 \
RPC_COOKIE="session=your-session-cookie" \
node scripts/db-optimization/rpc-smoke.js
```

**Sample output:**

```
DB Optimization Phase 2 — RPC Smoke Test
========================================================================
Target: http://localhost:3001

Endpoint                                           Status  Latency     Size (bytes)
------------------------------------------------------------------------
listSessionsPage (limit=10)                        200     42ms        3847
getSessionEvents (limit=50, no session — ...)      200     18ms        12
getFleetTurnAnalytics (since=30d ago)              200     95ms        2104
getTopEventEmitters (since=1h ago, limit=10)       200     61ms        823
------------------------------------------------------------------------

Expected: all status 200, latency <500ms, payload <50 KB for bounded reads.
```

**Acceptable ranges:**
- Status: `200` for all calls
- Latency: `<200ms` for `listSessionsPage` and `getSessionEvents`; `<500ms` for analytics aggregations
- Payload: `<10 KB` per page; if `listSessionsPage` returns >50 KB, the page limit is too large or rows are very wide

**Regression signals:**
- Status `500` → DB connection issue or migration not applied
- Latency >1 s on `listSessionsPage` → missing index on `(updated_at DESC, session_id DESC)`
- Latency >2 s on `getTopEventEmitters` → consider adding `session_events(created_at)` index

---

### 2. Response size comparison

Compares unbounded `listSessions` vs paged `listSessionsPage`.

```bash
PORTAL_URL=http://localhost:3001 \
RPC_COOKIE="session=your-session-cookie" \
PAGE_LIMIT=50 \
node scripts/db-optimization/response-size-check.js
```

**Sample output:**

```
listSessions  (unbounded)          : 187,432 bytes  [HTTP 200]
listSessionsPage (limit=50)        :  18,621 bytes  [HTTP 200]

Reduction ratio : 10.1x
```

**Interpretation:**
- Ratio **≥ 5x** → pagination is working as intended; significant network/parse savings
- Ratio **2–5x** → moderate reduction; fleet has fewer sessions or page is relatively large
- Ratio **< 2x** → fleet is small or close in size to PAGE_LIMIT; this is normal on dev environments

---

### 3. EXPLAIN ANALYZE (PostgreSQL)

Three query templates covering the key optimized paths.

```bash
psql $DATABASE_URL \
  -v schema=pilotswarm_cms \
  -v session_id="your-real-session-id" \
  -v since="NOW() - INTERVAL '24 hours'" \
  -f scripts/db-optimization/explain-pack.sql
```

**What to look for:**

| Query | Healthy | Warning |
|-------|---------|---------|
| Paged sessions | `Index Scan` on `updated_at, session_id` | `Seq Scan` on large tables |
| Session events | `Index Scan` using `(session_id, seq)` index | Rows examined >> LIMIT |
| Top emitters | `HashAggregate` after filtered Index/Seq Scan | Very large `Rows Removed by Filter` |

---

## Rollout checklist

### Local → Staging

1. Run `npx tsc --project packages/sdk/tsconfig.json --noEmit` (TypeScript clean)
2. Run `npm -C packages/portal test` — expect 53 tests passing
3. Run `npx vitest run packages/sdk/test/local/portal-phase2-rpc.test.js` — expect all tests passing
4. Start local portal; run `rpc-smoke.js` — all 200, latency <200ms
5. Run `response-size-check.js` — ratio ≥2x (dev fleets are small)
6. Deploy to staging; re-run `rpc-smoke.js` against staging URL
7. Check `explain-pack.sql` on staging DB — confirm index usage on paged sessions query

### Staging → Production

1. Confirm migration lock: all 13 migrations (0001–0013) applied (`SELECT * FROM <schema>.schema_migrations ORDER BY version`)
2. Run `rpc-smoke.js` against production URL (read-only; smoke calls are safe)
3. Check DB connection pool metrics: `DB_POOL_MAX` should be set in prod env (recommend 20–50)
4. Confirm `PG_QUERY_TIMEOUT_MS` is set (recommend 15000 for prod)
5. Monitor `getTopEventEmitters` usage — if p99 latency >500ms, add index:
   ```sql
   CREATE INDEX CONCURRENTLY idx_session_events_created_at
       ON pilotswarm_cms.session_events (created_at DESC);
   ```

---

## Rollback checklist

### If a migration causes issues

Migrations 0011–0013 are all `CREATE OR REPLACE FUNCTION` — they are safe to re-run and do not modify table schema. To roll back a function:

```sql
-- Drop the specific function if needed
DROP FUNCTION IF EXISTS pilotswarm_cms.cms_list_sessions_page(INT, TIMESTAMPTZ, TEXT, BOOL);
DROP FUNCTION IF EXISTS pilotswarm_cms.cms_get_top_event_emitters(TIMESTAMPTZ, INT);
```

Then remove or decrement the version in `schema_migrations`.

### If pool guardrails cause issues

The pool configuration is read from environment variables at startup. To revert:

```bash
# Revert to built-in SDK defaults (guardrails remain enabled with defaults)
unset PG_QUERY_TIMEOUT_MS
unset PG_CONNECTION_TIMEOUT_MS
unset PG_IDLE_TIMEOUT_MS
unset PG_STATEMENT_TIMEOUT_MS
unset DB_POOL_MAX
```

Restart the portal process. No code change needed.

### If RPC caps cause issues

The guard helpers (`clampLimit`, `enforceMaxWindowDays`) in `portal/runtime.js` are the single point of control. If a specific endpoint cap is too aggressive for a use case, adjust the `max` argument in the relevant `case` block in `runtime.js`:

```javascript
// Example: raise getSessionEvents max from 500 to 1000
clampLimit(safeParams.limit, 200, 1000)  // was 500
```

Re-run the portal test suite after any change to `runtime.js`.
