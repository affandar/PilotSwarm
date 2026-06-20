# Facts Migration 0010 — Soft Delete + Crawl Etag

Migration file: `facts-migrations.ts` — `migration_0010_soft_delete_etag`

## Table Changes

### `facts` — modified

```diff
 ALTER TABLE facts
+  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
+  ADD COLUMN IF NOT EXISTS etag BIGINT NOT NULL DEFAULT 0;
```

`deleted_at IS NULL` means live. Non-null rows are tombstones: hidden from agent
reads, still available to the crawl queue until graph reconciliation or TTL
purge. `etag` is the crawl optimistic-concurrency token returned by
`facts_read_uncrawled` and required by `facts_mark_crawled`.

## New Indexes

```sql
CREATE INDEX IF NOT EXISTS idx_SCHEMA_facts_tombstones
    ON SCHEMA.facts (deleted_at) WHERE deleted_at IS NOT NULL;
```

## Function Changes

### `facts_touch` — body modified (baseline: 0007)

```diff
 CREATE OR REPLACE FUNCTION SCHEMA.facts_touch() RETURNS trigger
 LANGUAGE plpgsql AS $$
 BEGIN
-    IF TG_OP = 'INSERT' OR NEW.key IS DISTINCT FROM OLD.key OR NEW.value IS DISTINCT FROM OLD.value THEN
+    IF TG_OP = 'INSERT' THEN
+        NEW.etag := COALESCE(NEW.etag, 0) + 1;
+        NEW.last_crawled_at := NULL;
+    ELSIF NEW.key IS DISTINCT FROM OLD.key
+       OR NEW.value IS DISTINCT FROM OLD.value
+       OR NEW.deleted_at IS DISTINCT FROM OLD.deleted_at THEN
+        NEW.etag := COALESCE(OLD.etag, 0) + 1;
         NEW.last_crawled_at := NULL;
     END IF;
     RETURN NEW;
 END $$;
```

### `facts_store_fact(jsonb)` — body modified (baseline: 0009)

```diff
 ON CONFLICT (scope_key) DO UPDATE SET
+    key        = EXCLUDED.key,
     value      = EXCLUDED.value,
     agent_id   = EXCLUDED.agent_id,
     session_id = EXCLUDED.session_id,
     shared     = EXCLUDED.shared,
     transient  = EXCLUDED.transient,
     tags       = EXCLUDED.tags,
+    deleted_at = NULL,
     updated_at = now()
```

Re-storing a tombstoned key revives it and lets `facts_touch` bump `etag` / reset
`last_crawled_at` through the `deleted_at` transition.

### `facts_delete_fact(...)` — body modified (baseline: 0009)

Physical deletes become idempotent soft deletes:

```diff
-DELETE FROM facts f
-WHERE f.key LIKE p_key_or_pattern
+UPDATE facts f
+   SET deleted_at = now(), updated_at = now()
+ WHERE f.deleted_at IS NULL
+   AND f.key LIKE p_key_or_pattern
    AND (...scope predicate...);

-DELETE FROM facts WHERE scope_key = p_key_or_pattern;
+UPDATE facts
+   SET deleted_at = now(), updated_at = now()
+ WHERE scope_key = p_key_or_pattern
+   AND deleted_at IS NULL;
```

### `facts_delete_session_facts(text)` — body modified (baseline: 0002)

```diff
-DELETE FROM facts
-WHERE session_id = p_session_id
-  AND shared = FALSE;
+UPDATE facts
+   SET deleted_at = now(), updated_at = now()
+ WHERE session_id = p_session_id
+   AND shared = FALSE
+   AND deleted_at IS NULL;
```

### `facts_read_facts(...)` — return shape + body modified (baseline: 0005)

Return table gains `deleted_at` and `etag`, and the read filters tombstones:

```diff
 RETURNS TABLE (...
     created_at TIMESTAMPTZ,
-    updated_at TIMESTAMPTZ
+    updated_at TIMESTAMPTZ,
+    deleted_at TIMESTAMPTZ,
+    etag       BIGINT
 )

-FROM facts f WHERE
+FROM facts f WHERE f.deleted_at IS NULL AND
```

### Facts stats procs — body modified (baseline: 0003)

`facts_get_session_facts_stats`, `facts_get_facts_stats_for_sessions`, and
`facts_get_shared_facts_stats` now include `f.deleted_at IS NULL` so tombstones
do not appear in operator facts totals.

### `facts_read_uncrawled(text, int)` — return shape modified (baseline: 0007)

```diff
 RETURNS TABLE (...
     created_at   TIMESTAMPTZ,
-    updated_at   TIMESTAMPTZ
+    updated_at   TIMESTAMPTZ,
+    deleted_at   TIMESTAMPTZ,
+    etag         BIGINT
 )
```

The queue intentionally does **not** filter `deleted_at`; tombstones are work
items for graph evidence removal.

### `facts_mark_crawled(jsonb)` — receipt shape modified (baseline: 0007)

```diff
 WITH stamps AS (
-    SELECT e->>'scopeKey' AS scope_key
+    SELECT e->>'scopeKey' AS scope_key,
+           CASE WHEN (e->>'etag') ~ '^[0-9]+$' THEN (e->>'etag')::BIGINT ELSE NULL END AS etag
     FROM jsonb_array_elements(p_stamps) e
 ), upd AS (
     UPDATE facts f
        SET last_crawled_at = now()
       FROM stamps s
      WHERE f.scope_key = s.scope_key
        AND f.last_crawled_at IS NULL
+       AND f.etag = s.etag
 )
```

Missing or stale etags skip rather than mark, preventing lost updates when facts
are deleted, revived, or edited while a crawler batch is in flight.

## New Functions

### `facts_purge_expired(p_ttl_seconds int, p_limit int)`

Hard-deletes tombstones that are either reconciled (`last_crawled_at IS NOT
NULL`) or older than the TTL. Uses `FOR UPDATE SKIP LOCKED` for concurrent Facts
Manager passes. Within a batch the candidates are ordered
`(last_crawled_at IS NULL), deleted_at, id` so already-reconciled tombstones are
reclaimed first — a lagging (but not dead) crawler's unreconciled tombstones get
maximum time before the TTL backstop reclaims them and strands graph evidence.

### `facts_tombstone_stats(p_ttl_seconds int)`

Returns backlog counters: pending total, unreconciled, TTL-blocked,
oldest-unreconciled age in seconds, and reconciled-unswept.

### `facts_force_purge(p_cutoff timestamptz, p_only_unreconciled boolean, p_key_prefix text, p_limit int)`

Operator-directed hard purge for tombstones older than a cutoff. The tool layer
is responsible for confirmation gating.