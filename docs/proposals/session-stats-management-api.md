# Proposal: Session Stats Management API

**Status:** Draft
**Date:** 2026-04-13

## Summary

Add per-session metric summaries to the CMS catalog so that `PilotSwarmManagementClient` can serve exact per-session stats and fleet-wide aggregates directly from PostgreSQL. Fleet metrics are SQL aggregates over per-session rows — no external telemetry backend required.

This is the **Management API** half of the observability story. The **OTel** half (dashboards, alerting, time-window rates) is a separate follow-on described in `runtime-metrics.md`.

---

## Design Principles

1. **One summary row per session** — row count scales with session count, not session duration or turn count.
2. **Upsert, never append** — workers update the summary row in place using atomic SQL increments. No new rows are created per turn, per dehydration, or per token usage event.
3. **Denormalized** — `agent_id`, `model`, and `parent_session_id` are copied into the summary row at creation time so fleet queries never need to join the sessions table.
4. **Survives deletion** — summary rows are retained when a session is soft-deleted. This preserves historical token spend and lifecycle data for fleet accounting. Fleet queries filter on a `deleted_at` column in the summary table when live-only views are needed.
5. **Fleet stats are aggregates** — `getFleetStats()` is `SUM` / `COUNT` / `GROUP BY agent_id, model` over the summary table alone.
6. **Descendant aggregates** — a session can return its own stats or a rolled-up aggregate of itself plus all children/grandchildren that ever ran, using the `parent_session_id` lineage.
7. **No time-series in this table** — rates, moving averages, and historical trends belong in the OTel export path, not in the catalog.

---

## Current Schema

### `{schema}.sessions`

```sql
CREATE TABLE IF NOT EXISTS {schema}.sessions (
    session_id        TEXT PRIMARY KEY,
    orchestration_id  TEXT,
    title             TEXT,
    title_locked      BOOLEAN NOT NULL DEFAULT FALSE,
    state             TEXT NOT NULL DEFAULT 'pending',
    model             TEXT,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_active_at    TIMESTAMPTZ,
    deleted_at        TIMESTAMPTZ,
    current_iteration INTEGER NOT NULL DEFAULT 0,
    last_error        TEXT,
    parent_session_id TEXT,
    wait_reason       TEXT,
    is_system         BOOLEAN NOT NULL DEFAULT FALSE,
    agent_id          TEXT,
    splash            TEXT
);
```

### `{schema}.session_events`

```sql
CREATE TABLE IF NOT EXISTS {schema}.session_events (
    seq           BIGSERIAL PRIMARY KEY,
    session_id    TEXT NOT NULL,
    event_type    TEXT NOT NULL,
    data          JSONB,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    worker_node_id TEXT
);
```

### Current schema evolution

Today `PgSessionCatalogProvider.initialize()` runs `CREATE TABLE IF NOT EXISTS` then a sequence of `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` statements. There is no version tracking, no ordering guarantee, and no transactional migration boundary.

---

## Proposed Changes

### New table: `{schema}.session_metric_summaries`

One row per session. Created by a schema migration. Updated in place via atomic increments.

```sql
CREATE TABLE IF NOT EXISTS {schema}.session_metric_summaries (
    session_id              TEXT PRIMARY KEY
                            REFERENCES {schema}.sessions(session_id)
                            ON DELETE SET NULL,
        -- FK kept for referential integrity during normal operation.
        -- ON DELETE SET NULL: if sessions row is hard-deleted, the summary
        -- row stays with session_id intact (PK is NOT NULL, so we use a
        -- trigger or skip the FK — see note below).

    -- Denormalized from sessions (copied at creation, not updated later)
    agent_id                TEXT,
    model                   TEXT,
    parent_session_id       TEXT,

    -- Persistence (monotonic counters and last-known sizes)
    snapshot_size_bytes     BIGINT NOT NULL DEFAULT 0,
    dehydration_count       INTEGER NOT NULL DEFAULT 0,
    hydration_count         INTEGER NOT NULL DEFAULT 0,
    lossy_handoff_count     INTEGER NOT NULL DEFAULT 0,
    last_dehydrated_at      TIMESTAMPTZ,
    last_hydrated_at        TIMESTAMPTZ,
    last_checkpoint_at      TIMESTAMPTZ,

    -- Token usage (cumulative totals)
    tokens_input            BIGINT NOT NULL DEFAULT 0,
    tokens_output           BIGINT NOT NULL DEFAULT 0,
    tokens_cache_read       BIGINT NOT NULL DEFAULT 0,
    tokens_cache_write      BIGINT NOT NULL DEFAULT 0,

    -- Soft-delete tracking (mirrored from sessions on delete)
    deleted_at              TIMESTAMPTZ,

    -- Timestamps
    created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

**FK note:** Because summary rows must survive session deletion, the FK cannot use `ON DELETE CASCADE`. The simplest approach is to **not add an FK constraint at all** and instead treat `session_id` as a logical reference. The summary row is created alongside the session and its `deleted_at` is set when `softDeleteSession()` runs. Hard deletes of the sessions table (e.g., during reset) also drop the summaries table, so orphans are not a concern in practice.

### Indexes

```sql
CREATE INDEX IF NOT EXISTS idx_{schema}_sms_agent_model
    ON {schema}.session_metric_summaries(agent_id, model);
CREATE INDEX IF NOT EXISTS idx_{schema}_sms_parent
    ON {schema}.session_metric_summaries(parent_session_id);
CREATE INDEX IF NOT EXISTS idx_{schema}_sms_updated
    ON {schema}.session_metric_summaries(updated_at DESC);
```

Fleet queries group by `agent_id, model` directly on the summary table — no join to `sessions` needed. The `parent_session_id` index supports descendant aggregate lookups.

### Row lifecycle

| Event | Effect |
|-------|--------|
| `createSession()` in CMS | Insert a zeroed summary row with denormalized `agent_id`, `model`, `parent_session_id` via `ON CONFLICT DO NOTHING` |
| `softDeleteSession()` in CMS | Set `deleted_at = now()` on the summary row. **Row is not removed.** |
| Worker dehydrate/hydrate/checkpoint/usage | Upsert with atomic increments (see Write Points below) |
| Schema reset / hard delete | Summary table is dropped with the schema |

Summary rows accumulate over time. For fleet queries that should only reflect live sessions, filter on `deleted_at IS NULL`. For total historical accounting (e.g., "how many tokens have all sessions ever consumed?"), query without the filter.

---

## Write Points

All writes are **upserts with atomic increments**, not full-row replacements. This is safe for concurrent workers because each field is updated with `column = column + $1` or `column = $1` as appropriate.

### 1. Persistence — dehydrate success

**Where:** `dehydrateSession` activity in `session-proxy.ts` (line ~1041), after the successful `dehydrate()` call and before the CMS event write.

```sql
INSERT INTO {schema}.session_metric_summaries (session_id, agent_id, model, parent_session_id, snapshot_size_bytes, dehydration_count, last_dehydrated_at, updated_at)
VALUES ($1, $3, $4, $5, $2, 1, now(), now())
ON CONFLICT (session_id) DO UPDATE SET
    snapshot_size_bytes = $2,
    dehydration_count = session_metric_summaries.dehydration_count + 1,
    last_dehydrated_at = now(),
    updated_at = now();
```

Values: `$1` = sessionId, `$2` = tarSizeBytes, `$3` = agentId, `$4` = model, `$5` = parentSessionId. The denormalized columns are included in every upsert INSERT clause but are not overwritten on conflict (they are set once at creation).

### 2. Persistence — hydrate success

**Where:** `hydrateSession` activity in `session-proxy.ts` (line ~1139), after the successful `hydrate()` call.

```sql
INSERT INTO {schema}.session_metric_summaries (session_id, hydration_count, last_hydrated_at, updated_at)
VALUES ($1, 1, now(), now())
ON CONFLICT (session_id) DO UPDATE SET
    hydration_count = session_metric_summaries.hydration_count + 1,
    last_hydrated_at = now(),
    updated_at = now();
```



### 3. Persistence — lossy handoff

**Where:** `recordLossyHandoffEvent` in `session-proxy.ts` (line ~100), alongside the existing `session.lossy_handoff` CMS event.

```sql
INSERT INTO {schema}.session_metric_summaries (session_id, lossy_handoff_count, updated_at)
VALUES ($1, 1, now())
ON CONFLICT (session_id) DO UPDATE SET
    lossy_handoff_count = session_metric_summaries.lossy_handoff_count + 1,
    updated_at = now();
```

### 4. Persistence — checkpoint

**Where:** `checkpointSession` activity in `session-proxy.ts`, after the successful `checkpoint()` call.

```sql
INSERT INTO {schema}.session_metric_summaries (session_id, snapshot_size_bytes, last_checkpoint_at, updated_at)
VALUES ($1, $2, now(), now())
ON CONFLICT (session_id) DO UPDATE SET
    snapshot_size_bytes = $2,
    last_checkpoint_at = now(),
    updated_at = now();
```

### 5. Token usage

**Where:** The `onEvent` callback inside the `runTurn` activity in `session-proxy.ts` (line ~822). When `eventType === "assistant.usage"`, extract the token fields from `event.data` and fire a single upsert.

```sql
INSERT INTO {schema}.session_metric_summaries (session_id, tokens_input, tokens_output, tokens_cache_read, tokens_cache_write, updated_at)
VALUES ($1, $2, $3, $4, $5, now())
ON CONFLICT (session_id) DO UPDATE SET
    tokens_input = session_metric_summaries.tokens_input + $2,
    tokens_output = session_metric_summaries.tokens_output + $3,
    tokens_cache_read = session_metric_summaries.tokens_cache_read + $4,
    tokens_cache_write = session_metric_summaries.tokens_cache_write + $5,
    updated_at = now();
```

### 6. Session creation (zero-row seed)

**Where:** `createSession()` in `PgSessionCatalogProvider`, after the existing `INSERT INTO sessions`.

```sql
INSERT INTO {schema}.session_metric_summaries (session_id, agent_id, model, parent_session_id)
VALUES ($1, $2, $3, $4)
ON CONFLICT (session_id) DO NOTHING;
```

`$2` = agentId, `$3` = model, `$4` = parentSessionId — all copied from the `createSession()` arguments.

---

## Read Surface

### `SessionCatalogProvider` additions

```ts
interface SessionMetricSummary {
    sessionId: string;
    agentId: string | null;
    model: string | null;
    parentSessionId: string | null;
    snapshotSizeBytes: number;
    dehydrationCount: number;
    hydrationCount: number;
    lossyHandoffCount: number;
    lastDehydratedAt: number | null;
    lastHydratedAt: number | null;
    lastCheckpointAt: number | null;
    tokensInput: number;
    tokensOutput: number;
    tokensCacheRead: number;
    tokensCacheWrite: number;
    deletedAt: number | null;
}

interface FleetStats {
    /** Time window applied. Null if no filter was used. */
    windowStart: number | null;
    /** Earliest `created_at` of any session included in this result. */
    earliestSessionCreatedAt: number | null;
    byAgent: Array<{
        agentId: string | null;
        model: string | null;
        sessionCount: number;
        totalSnapshotSizeBytes: number;
        totalDehydrationCount: number;
        totalHydrationCount: number;
        totalLossyHandoffCount: number;
        totalTokensInput: number;
        totalTokensOutput: number;
    }>;
    totals: {
        sessionCount: number;
        totalSnapshotSizeBytes: number;
        totalTokensInput: number;
        totalTokensOutput: number;
    };
}

/** Aggregate of a session and all its descendants. */
interface SessionTreeStats {
    rootSessionId: string;
    /** Stats for the root session alone. */
    self: SessionMetricSummary;
    /** Rolled-up totals including root + all descendants. */
    tree: {
        sessionCount: number;
        totalTokensInput: number;
        totalTokensOutput: number;
        totalTokensCacheRead: number;
        totalTokensCacheWrite: number;
        totalDehydrationCount: number;
        totalHydrationCount: number;
        totalLossyHandoffCount: number;
        totalSnapshotSizeBytes: number;
    };
}
```

### Catalog provider methods

```ts
getSessionMetricSummary(sessionId: string): Promise<SessionMetricSummary | null>;
getSessionTreeStats(sessionId: string): Promise<SessionTreeStats | null>;
getFleetStats(opts?: { includeDeleted?: boolean; since?: Date }): Promise<FleetStats>;
upsertSessionMetricSummary(sessionId: string, updates: Partial<SessionMetricSummaryUpdates>): Promise<void>;
markSessionMetricSummaryDeleted(sessionId: string): Promise<void>;
pruneDeletedSummaries(olderThan: Date): Promise<number>;
```

### `getSessionMetricSummary` — single-row read

```sql
SELECT * FROM {schema}.session_metric_summaries WHERE session_id = $1;
```

Returns the session's own stats regardless of whether it has been deleted.

### `getSessionTreeStats` — self + descendant aggregate

Uses the same recursive CTE pattern as the existing `getDescendantSessionIds`:

```sql
WITH RECURSIVE tree AS (
    SELECT session_id FROM {schema}.session_metric_summaries
    WHERE session_id = $1
    UNION ALL
    SELECT m.session_id FROM {schema}.session_metric_summaries m
    INNER JOIN tree t ON m.parent_session_id = t.session_id
)
SELECT
    COUNT(*)::int                                    AS session_count,
    COALESCE(SUM(tokens_input), 0)::bigint           AS total_tokens_input,
    COALESCE(SUM(tokens_output), 0)::bigint          AS total_tokens_output,
    COALESCE(SUM(tokens_cache_read), 0)::bigint      AS total_tokens_cache_read,
    COALESCE(SUM(tokens_cache_write), 0)::bigint     AS total_tokens_cache_write,
    COALESCE(SUM(dehydration_count), 0)::int         AS total_dehydration_count,
    COALESCE(SUM(hydration_count), 0)::int           AS total_hydration_count,
    COALESCE(SUM(lossy_handoff_count), 0)::int       AS total_lossy_handoff_count,
    COALESCE(SUM(snapshot_size_bytes), 0)::bigint    AS total_snapshot_size_bytes
FROM {schema}.session_metric_summaries
WHERE session_id IN (SELECT session_id FROM tree);
```

The management client combines this with the single-row read to return a `SessionTreeStats` object containing both `self` and `tree`.

Because `parent_session_id` is denormalized into the summary table and rows survive deletion, this query returns the full historical tree even if some children have been soft-deleted.

### `getFleetStats` — aggregate query (no join)

Accepts optional filters:
- `includeDeleted: true` — include soft-deleted sessions in the result.
- `since: Date` — only include sessions whose `created_at >= since`. This limits the result to a time window (e.g., last 30 days).

The response includes `earliestSessionCreatedAt` — the `MIN(created_at)` of all rows that matched the filter. This tells the caller the actual coverage of the result.

```sql
-- Per-group breakdown
SELECT
    agent_id,
    model,
    COUNT(*)::int                                          AS session_count,
    COALESCE(SUM(snapshot_size_bytes), 0)::bigint          AS total_snapshot_size_bytes,
    COALESCE(SUM(dehydration_count), 0)::int               AS total_dehydration_count,
    COALESCE(SUM(hydration_count), 0)::int                 AS total_hydration_count,
    COALESCE(SUM(lossy_handoff_count), 0)::int             AS total_lossy_handoff_count,
    COALESCE(SUM(tokens_input), 0)::bigint                 AS total_tokens_input,
    COALESCE(SUM(tokens_output), 0)::bigint                AS total_tokens_output
FROM {schema}.session_metric_summaries
WHERE deleted_at IS NULL          -- omit for includeDeleted=true
  AND created_at >= $1             -- omit if no `since` filter
GROUP BY agent_id, model;

-- Totals + earliest session date
SELECT
    COUNT(*)::int                                          AS session_count,
    ...
    MIN(created_at)                                        AS earliest_session_created_at
FROM {schema}.session_metric_summaries
WHERE deleted_at IS NULL
  AND created_at >= $1;
```

No join to `sessions` needed because `agent_id` and `model` are denormalized.

### `markSessionMetricSummaryDeleted` — soft-delete mirror

Called from `softDeleteSession()` in the catalog provider:

```sql
UPDATE {schema}.session_metric_summaries SET deleted_at = now(), updated_at = now() WHERE session_id = $1;
```

### `pruneDeletedSummaries` — hard-delete old dead rows

Removes summary rows for sessions that were soft-deleted before the given cutoff. Returns the number of rows removed.

```sql
DELETE FROM {schema}.session_metric_summaries
WHERE deleted_at IS NOT NULL AND deleted_at < $1
RETURNING session_id;
```

This is the mechanism that bounds table growth. Callers choose the retention window:

```ts
// Prune deleted summaries older than 90 days
const cutoff = new Date(Date.now() - 90 * 86400_000);
const pruned = await catalog.pruneDeletedSummaries(cutoff);
```

The sweeper agent or a management CLI command can call this periodically. It is **not** called automatically during normal operation.

### `PilotSwarmManagementClient` methods

```ts
getSessionMetricSummary(sessionId: string): Promise<SessionMetricSummary | null>;
getSessionTreeStats(sessionId: string): Promise<SessionTreeStats | null>;
getFleetStats(opts?: { includeDeleted?: boolean; since?: Date }): Promise<FleetStats>;
pruneDeletedSummaries(olderThan: Date): Promise<number>;
```

These are thin wrappers that call the catalog provider methods above.

### Transport / Portal wiring

Add `getSessionMetricSummary`, `getSessionTreeStats`, `getFleetStats`, and `pruneDeletedSummaries` to:
- `NodeSdkTransport` in `packages/cli/src/node-sdk-transport.js`
- `PortalRuntime.call()` in `packages/portal/runtime.js`
- `BrowserPortalTransport` in `packages/portal/src/browser-transport.js`

Same pattern as existing `getOrchestrationStats`.

---

## Schema Migration Plan

### Migration framework

Replace the ad hoc `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` approach in `PgSessionCatalogProvider.initialize()` with a versioned migration runner.

#### Migration state table

```sql
CREATE TABLE IF NOT EXISTS {schema}.schema_migrations (
    version     TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

#### Migration runner behavior

1. `initialize()` creates the schema and the `schema_migrations` table.
2. Acquires a PostgreSQL advisory lock keyed by a hash of the schema name. This prevents concurrent workers from double-applying migrations.
3. Reads all applied versions from `schema_migrations`.
4. Applies each pending migration in version order, within a transaction per migration.
5. Records the version in `schema_migrations` after each successful migration.
6. Releases the advisory lock.
7. If a migration fails, the transaction rolls back and startup fails fast.

#### Migration file convention

Migrations live in `packages/sdk/migrations/cms/` as plain `.sql` files:

```
packages/sdk/migrations/cms/
  0001_baseline.sql
  0002_session_metric_summaries.sql
```

The version is the numeric prefix. The name is the rest of the filename.

Migrations are embedded into the build output (read at runtime from the filesystem or bundled as string constants).

### Migration 0001: Baseline

Captures the current live schema exactly. This migration is a no-op for fresh databases (because `CREATE TABLE IF NOT EXISTS` and `ADD COLUMN IF NOT EXISTS` are idempotent), but it gives existing deployments a recorded baseline version.

```sql
-- 0001_baseline.sql
-- Baseline: captures the CMS schema as of v1.0.41.
-- All statements are idempotent so this is safe for both fresh and existing databases.

CREATE TABLE IF NOT EXISTS {schema}.sessions (
    session_id        TEXT PRIMARY KEY,
    orchestration_id  TEXT,
    title             TEXT,
    title_locked      BOOLEAN NOT NULL DEFAULT FALSE,
    state             TEXT NOT NULL DEFAULT 'pending',
    model             TEXT,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_active_at    TIMESTAMPTZ,
    deleted_at        TIMESTAMPTZ,
    current_iteration INTEGER NOT NULL DEFAULT 0,
    last_error        TEXT,
    parent_session_id TEXT,
    wait_reason       TEXT,
    is_system         BOOLEAN NOT NULL DEFAULT FALSE,
    agent_id          TEXT,
    splash            TEXT
);

CREATE TABLE IF NOT EXISTS {schema}.session_events (
    seq            BIGSERIAL PRIMARY KEY,
    session_id     TEXT NOT NULL,
    event_type     TEXT NOT NULL,
    data           JSONB,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    worker_node_id TEXT
);

CREATE INDEX IF NOT EXISTS idx_{schema}_sessions_state
    ON {schema}.sessions(state) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_{schema}_sessions_updated
    ON {schema}.sessions(updated_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_{schema}_events_session_seq
    ON {schema}.session_events(session_id, seq);

-- Column migrations (idempotent for existing DBs)
ALTER TABLE {schema}.sessions ADD COLUMN IF NOT EXISTS parent_session_id TEXT;
ALTER TABLE {schema}.sessions ADD COLUMN IF NOT EXISTS is_system BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE {schema}.sessions ADD COLUMN IF NOT EXISTS wait_reason TEXT;
ALTER TABLE {schema}.sessions ADD COLUMN IF NOT EXISTS agent_id TEXT;
ALTER TABLE {schema}.sessions ADD COLUMN IF NOT EXISTS splash TEXT;
ALTER TABLE {schema}.sessions ADD COLUMN IF NOT EXISTS title_locked BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE {schema}.session_events ADD COLUMN IF NOT EXISTS worker_node_id TEXT;
```

### Migration 0002: Session metric summaries

```sql
-- 0002_session_metric_summaries.sql
-- Add per-session metric summary table for management API stats.

CREATE TABLE IF NOT EXISTS {schema}.session_metric_summaries (
    session_id              TEXT PRIMARY KEY,
    agent_id                TEXT,
    model                   TEXT,
    parent_session_id       TEXT,
    snapshot_size_bytes     BIGINT NOT NULL DEFAULT 0,
    dehydration_count       INTEGER NOT NULL DEFAULT 0,
    hydration_count         INTEGER NOT NULL DEFAULT 0,
    lossy_handoff_count     INTEGER NOT NULL DEFAULT 0,
    last_dehydrated_at      TIMESTAMPTZ,
    last_hydrated_at        TIMESTAMPTZ,
    last_checkpoint_at      TIMESTAMPTZ,
    tokens_input            BIGINT NOT NULL DEFAULT 0,
    tokens_output           BIGINT NOT NULL DEFAULT 0,
    tokens_cache_read       BIGINT NOT NULL DEFAULT 0,
    tokens_cache_write      BIGINT NOT NULL DEFAULT 0,
    deleted_at              TIMESTAMPTZ,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_{schema}_sms_agent_model
    ON {schema}.session_metric_summaries(agent_id, model);
CREATE INDEX IF NOT EXISTS idx_{schema}_sms_parent
    ON {schema}.session_metric_summaries(parent_session_id);
CREATE INDEX IF NOT EXISTS idx_{schema}_sms_updated
    ON {schema}.session_metric_summaries(updated_at DESC);

-- Backfill: create a zeroed summary row for every existing session (including deleted).
-- Copy denormalized columns from the sessions table.
INSERT INTO {schema}.session_metric_summaries (session_id, agent_id, model, parent_session_id, deleted_at)
SELECT session_id, agent_id, model, parent_session_id, deleted_at
FROM {schema}.sessions
ON CONFLICT (session_id) DO NOTHING;
```

---

## Scaling Properties

| Dimension | Growth | Reason |
|-----------|--------|--------|
| Row count | O(all-time sessions) | One row per session ever created, retained after deletion |
| Row size | Fixed ~200 bytes | Counters, timestamps, and denormalized text columns only |
| Write frequency | O(turns + lifecycle events) | But writes are upserts to a fixed row, not appends |
| Write contention | Low | Each session's row is updated by at most one worker at a time (session affinity) |
| Fleet query cost | O(all-time sessions) | Single `GROUP BY` scan on summary table alone, no join |
| Descendant query cost | O(tree depth × tree size) | Recursive CTE on `parent_session_id` within the summary table |

The table does **not** grow with:
- session duration (a session running for days has the same one row)
- turn count (token counters are incremented in place)
- event count (events stay in `session_events`; the summary is a separate fixed row)
- dehydration cycles (counter incremented, not a new row)

Note: because rows survive deletion, the table grows monotonically until pruned. Use `pruneDeletedSummaries(olderThan)` to hard-delete summary rows for sessions that were soft-deleted before the given cutoff. For example, a 90-day retention policy:

```ts
await catalog.pruneDeletedSummaries(new Date(Date.now() - 90 * 86400_000));
```

The sweeper agent or a scheduled management command can call this. It is not automatic.

---

## Test Plan

All tests use `vitest` with `describe`/`it`, isolated schemas via `createTestEnv()`, and follow PilotSwarm test conventions.

### Test file

`packages/sdk/test/local/session-stats.test.js`

### Suite 1: Migration framework

**Test 1: Fresh database applies all migrations in order**

- Create a `PgSessionCatalogProvider` with a fresh schema.
- Call `initialize()`.
- Verify `schema_migrations` table exists with versions `0001` and `0002`.
- Verify `session_metric_summaries` table has the expected columns.

**Test 2: Existing database upgrades without data loss**

- Create a `PgSessionCatalogProvider` with an empty schema.
- Manually run the old-style `CREATE TABLE` + `ALTER TABLE` statements to simulate a pre-migration database.
- Insert a test session and some events.
- Create a new `PgSessionCatalogProvider` against the same schema.
- Call `initialize()`.
- Verify migrations `0001` and `0002` are recorded.
- Verify the pre-existing session and events are intact.
- Verify the backfill created a zeroed summary row for the pre-existing session.

**Test 3: Concurrent startup does not double-apply**

- Start two `PgSessionCatalogProvider.create()` + `initialize()` calls in parallel against the same schema.
- Verify both complete without error.
- Verify `schema_migrations` contains exactly one entry per migration version (no duplicates).

**Test 4: Failed migration rolls back cleanly**

- Inject a deliberately broken migration (e.g., `CREATE TABLE existing_table (...)` without `IF NOT EXISTS` where the table already exists with a different shape).
- Verify `initialize()` throws.
- Verify the broken migration is not recorded in `schema_migrations`.
- Verify the schema is unchanged (no partial DDL applied).

### Suite 2: Summary row lifecycle

**Test 5: Session creation seeds a zeroed summary row**

- Create a session via `catalog.createSession(sessionId)`.
- Read the summary row directly.
- Verify all counters are 0 and timestamps are null (except `created_at`).

**Test 6: Session deletion marks summary row as deleted but retains it**

- Create a session and verify the summary row exists with `deleted_at IS NULL`.
- Add some token usage to the summary.
- Call `catalog.softDeleteSession(sessionId)`.
- Verify the summary row still exists.
- Verify `deleted_at` is set.
- Verify token counters are preserved.

### Suite 3: Persistence upserts

**Test 7: Dehydrate updates summary atomically**

- Create a session with a summary row.
- Call `upsertSessionMetricSummary(sessionId, { snapshotSizeBytes: 12345, dehydrationCountIncrement: 1 })`.
- Read the summary row.
- Verify `snapshot_size_bytes = 12345`, `dehydration_count = 1`, `last_dehydrated_at` is recent.

**Test 8: Hydrate updates summary atomically**

- Starting from a dehydrated state (Test 7 state).
- Call upsert with `hydrationCountIncrement: 1`.
- Verify `hydration_count = 1`, `last_hydrated_at` is recent.

**Test 9: Multiple dehydrations increment counter**

- Dehydrate the same session 3 times.
- Verify `dehydration_count = 3`.
- Verify the row count for this session is still 1 (no extra rows created).

**Test 10: Lossy handoff updates summary**

- Call upsert with `lossyHandoffCountIncrement: 1`.
- Verify `lossy_handoff_count = 1`.

### Suite 4: Token usage upserts

**Test 11: Token usage increments cumulatively**

- Call upsert with `tokensInputIncrement: 100, tokensOutputIncrement: 50`.
- Call upsert again with `tokensInputIncrement: 200, tokensOutputIncrement: 75`.
- Read the summary row.
- Verify `tokens_input = 300`, `tokens_output = 125`.

**Test 12: Token usage and persistence are independent**

- Dehydrate a session (sets persistence fields).
- Add token usage (sets token fields).
- Verify both sets of fields are correct — one upsert does not zero out the other.

### Suite 5: Fleet aggregate reads

**Test 13: Fleet stats aggregate across sessions**

- Create 3 sessions: agent-a with model-x, agent-a with model-y, agent-b with model-x.
- Set varying token counts and dehydration/hydration counters.
- Call `getFleetStats()`.
- Verify `byAgent` groups match expected counts and sums.
- Verify `totals` match the grand totals.

**Test 14: Deleted sessions excluded by default, included with flag**

- Create 2 sessions, add token usage to both, soft-delete one.
- Call `getFleetStats()` (default).
- Verify only the non-deleted session appears.
- Call `getFleetStats({ includeDeleted: true })`.
- Verify both sessions appear and totals include the deleted session's tokens.

**Test 15: Fleet stats with time-window filter**

- Create 3 sessions at staggered times (or with manually set `created_at` via direct SQL).
- Call `getFleetStats({ since: <cutoff that excludes the oldest session> })`.
- Verify only the 2 newer sessions appear in the result.
- Verify `earliestSessionCreatedAt` matches the oldest of the 2 included sessions.
- Call `getFleetStats()` without `since`.
- Verify all 3 sessions appear and `earliestSessionCreatedAt` matches the oldest overall.

**Test 15b: Empty fleet returns zero totals and null earliest date**

- Call `getFleetStats()` on a fresh schema with no sessions.
- Verify `totals.sessionCount = 0`, all sums are 0, and `earliestSessionCreatedAt` is null.

### Suite 5b: Pruning

**Test 15c: Prune removes deleted summaries older than cutoff**

- Create 3 sessions, add token usage to all, soft-delete all 3.
- Set `deleted_at` on 2 of them to 100 days ago (via direct SQL).
- Call `pruneDeletedSummaries(new Date(Date.now() - 90 * 86400_000))`.
- Verify return value is 2.
- Verify the 2 old rows are gone.
- Verify the recently-deleted row still exists.

**Test 15d: Prune does not touch non-deleted rows**

- Create 2 sessions, do not delete them.
- Call `pruneDeletedSummaries(new Date())` (cutoff = now).
- Verify return value is 0.
- Verify both summary rows still exist.

**Test 15e: Prune does not break tree stats for remaining sessions**

- Create parent + child, add tokens, soft-delete child, set child `deleted_at` to 100 days ago.
- Call `pruneDeletedSummaries(new Date(Date.now() - 90 * 86400_000))` — prunes child.
- Call `getSessionTreeStats(parentId)`.
- Verify `tree.sessionCount = 1` (only parent remains) and child tokens are gone from tree totals.

### Suite 6: Descendant / tree aggregates

**Test 16: Session tree stats includes children**

- Create a parent session and 2 child sessions (with `parent_session_id` set).
- Add different token counts to each.
- Call `getSessionTreeStats(parentId)`.
- Verify `self` matches the parent's own stats.
- Verify `tree.sessionCount = 3`.
- Verify `tree.totalTokensInput` = sum of parent + both children.

**Test 17: Session tree stats includes grandchildren**

- Create parent → child → grandchild chain.
- Add token counts to all three.
- Call `getSessionTreeStats(parentId)`.
- Verify `tree.sessionCount = 3` and totals include the grandchild.

**Test 18: Session tree stats includes deleted children**

- Create parent + child, add tokens, soft-delete the child.
- Call `getSessionTreeStats(parentId)`.
- Verify the child's tokens are still included in tree totals.

**Test 19: Session with no children returns tree = self**

- Create a session with no children.
- Call `getSessionTreeStats(sessionId)`.
- Verify `tree.sessionCount = 1` and all tree totals equal self values.

### Suite 7: Denormalization correctness

**Test 20: Summary row captures agent_id and model from session creation**

- Create a session with `agentId: 'test-agent'` and `model: 'gpt-5.4'`.
- Read the summary row.
- Verify `agent_id = 'test-agent'` and `model = 'gpt-5.4'`.

**Test 21: Summary row captures parent_session_id**

- Create a parent session and a child session with `parentSessionId` set.
- Read the child's summary row.
- Verify `parent_session_id` matches the parent.

**Test 22: Fleet stats group by denormalized agent_id and model without join**

- Create sessions with different agent/model combinations.
- Soft-delete the sessions table rows (simulating a scenario).
- Verify `getFleetStats({ includeDeleted: true })` still returns correct groups — proving the summary table is self-contained.

### Suite 8: Management client integration

**Test 23: End-to-end session stats through management client**

- Use `withClient(env, ...)` to start a worker + client pair.
- Create a session via client.
- Call `mgmt.getSessionMetricSummary(sessionId)`.
- Verify a zeroed stats object is returned with correct `agentId` and `model`.
- Simulate a dehydrate (or trigger one via a durable wait).
- Re-read stats.
- Verify persistence counters incremented.

**Test 24: Tree stats through management client**

- Start a session that spawns a sub-agent.
- Wait for the sub-agent to complete at least one turn.
- Call `mgmt.getSessionTreeStats(parentSessionId)`.
- Verify `tree.sessionCount >= 2` and token totals include child usage.

**Test 25: Fleet stats through management client**

- Same setup as Test 23 but with multiple sessions.
- Call `mgmt.getFleetStats()`.
- Verify aggregates match individual session stats.

### Test registration

Add `session-stats.test.js` to:
- `SUITES` array in `scripts/run-tests.sh`
- `test:local` npm script in `packages/sdk/package.json`

---

## What This Does Not Cover

- **Time-window rates** (tokens/sec, hydrations/min) — those belong in the OTel export path.
- **Per-turn breakdowns** — the summary table stores cumulative totals only.
- **Historical snapshots** — the summary is a point-in-time view, not a time series.
- **Knowledge pipeline stats** — those will be a separate summary table in a future migration.
- **OTel instrumentation** — described in `runtime-metrics.md`, implemented after this is stable.
