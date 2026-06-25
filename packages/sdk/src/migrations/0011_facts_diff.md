# Facts Migration 0011 — Prefix-Scoped Crawl Flag (Multi-Crawler Phase 1)

Migration file: `facts-migrations.ts` — `migration_0011_prefix_crawl_flag`

Generalizes the single-crawler queue into N crawlers over **disjoint** key
prefixes. No registry / lock / per-crawler state (that is Phase 2). Replaces the
public `facts_mark_crawled` receipt mark with a selection × flag writer
(`facts_set_crawled_by_prefix` / `facts_set_crawled_by_keys`) and switches the
read filter from `starts_with` to an escaped literal-prefix `LIKE` backed by a
`text_pattern_ops` index.

## Table Changes

None.

## Index Changes

```diff
-CREATE INDEX IF NOT EXISTS idx_SCHEMA_facts_uncrawled
-    ON SCHEMA.facts (id) WHERE last_crawled_at IS NULL;
+CREATE INDEX IF NOT EXISTS idx_SCHEMA_facts_uncrawled_key
+    ON SCHEMA.facts (key text_pattern_ops, id) WHERE last_crawled_at IS NULL;
```

The id-only partial index is dropped. The new `(key text_pattern_ops, id)`
partial index serves both prefix range scans (`key LIKE 'prefix%'`) and the
global drain (`ORDER BY key, id`). `text_pattern_ops` is required because the
database collation is not `C`; without it the LIKE-prefix range cannot use the
index.

## Function Changes

### `facts_like_prefix(text)` — new

```diff
+CREATE OR REPLACE FUNCTION SCHEMA.facts_like_prefix(p_prefix TEXT)
+RETURNS TEXT LANGUAGE sql IMMUTABLE STRICT AS $$
+    SELECT replace(replace(replace(p_prefix, chr(92), chr(92) || chr(92)),
+                           '%', chr(92) || '%'), '_', chr(92) || '_') || '%';
+$$;
```

Escapes the LIKE metacharacters (`\ % _`) in a literal key prefix and appends the
trailing `%` wildcard, so a prefix containing `%` or `_` matches literally. Paired
with `ESCAPE chr(92)` at the call site (`chr(92)` is a literal backslash; using it
avoids backslash-quoting ambiguity across SQL string forms). `IMMUTABLE` so the
planner folds `facts_like_prefix($1)` to a constant and applies the LIKE→index
range optimization.

### `facts_read_uncrawled(text, int)` — signature + body modified (baseline: 0010)

Parameter renamed (`p_ns_prefix` → `p_key_prefix`), which requires
`DROP FUNCTION` before re-create. Return columns unchanged.

```diff
-DROP FUNCTION IF EXISTS SCHEMA.facts_read_uncrawled(TEXT, INT);
 CREATE OR REPLACE FUNCTION SCHEMA.facts_read_uncrawled(
-    p_ns_prefix TEXT,
-    p_limit     INT
+    p_key_prefix TEXT,
+    p_limit      INT
 ) RETURNS TABLE ( scope_key TEXT, key TEXT, value JSONB, agent_id TEXT,
                   session_id TEXT, shared BOOLEAN, tags TEXT[], created_at TIMESTAMPTZ,
                   updated_at TIMESTAMPTZ, deleted_at TIMESTAMPTZ, etag BIGINT )
 LANGUAGE sql STABLE AS $$
     SELECT f.scope_key, f.key, f.value, f.agent_id, f.session_id, f.shared,
            f.tags, f.created_at, f.updated_at, f.deleted_at, f.etag
     FROM SCHEMA.facts f
     WHERE f.last_crawled_at IS NULL
-      AND (p_ns_prefix IS NULL OR starts_with(f.key, p_ns_prefix))
-    ORDER BY f.id
+      AND (p_key_prefix IS NULL
+           OR f.key LIKE SCHEMA.facts_like_prefix(p_key_prefix) ESCAPE chr(92))
+    ORDER BY f.key, f.id
     LIMIT p_limit;
 $$;
```

`starts_with` → escaped literal-prefix `LIKE` (index-friendly). `ORDER BY f.id` →
`ORDER BY f.key, f.id` to align with the new index and let `LIMIT` stop early
inside a crawler's keyspace.

### `facts_set_crawled_by_prefix(text, boolean)` — new

```diff
+CREATE OR REPLACE FUNCTION SCHEMA.facts_set_crawled_by_prefix(
+    p_key_prefix TEXT, p_crawled BOOLEAN
+) RETURNS TABLE (affected INT, skipped INT) LANGUAGE sql AS $$
+    WITH matched AS (
+        SELECT f.id FROM SCHEMA.facts f
+        WHERE p_key_prefix IS NOT NULL AND p_key_prefix <> ''
+          AND f.key LIKE SCHEMA.facts_like_prefix(p_key_prefix) ESCAPE chr(92)
+          AND (NOT p_crawled OR f.deleted_at IS NULL)
+    ), upd AS (
+        UPDATE SCHEMA.facts f
+           SET last_crawled_at = CASE WHEN p_crawled THEN now() ELSE NULL END
+          FROM matched m WHERE f.id = m.id
+           AND ( (p_crawled AND f.last_crawled_at IS NULL)
+              OR (NOT p_crawled AND f.last_crawled_at IS NOT NULL) )
+        RETURNING f.id
+    )
+    SELECT (SELECT count(*) FROM upd)::int,
+           ((SELECT count(*) FROM matched) - (SELECT count(*) FROM upd))::int;
+$$;
```

Flip `last_crawled_at` for a whole literal prefix. `crawled=true` never touches a
tombstone (`deleted_at IS NULL` filter) so a blind flush cannot turn unreconciled
deletes into purgeable rows; `crawled=false` (recrawl) includes tombstones.
`affected` = rows that changed state; `skipped` = rows that matched the prefix but
were already in the requested state. Empty/NULL prefix is a no-op (the
provider/tool layer rejects empty outright).

### `facts_set_crawled_by_keys(jsonb, boolean)` — new

```diff
+CREATE OR REPLACE FUNCTION SCHEMA.facts_set_crawled_by_keys(
+    p_keys JSONB, p_crawled BOOLEAN
+) RETURNS TABLE (affected INT, skipped INT) LANGUAGE plpgsql AS $$
+  -- guards: array shape, 1..500 entries, unique non-empty scopeKeys, numeric etags
+  -- input -> matched (JOIN facts ON scope_key) -> upd (etag CAS when present,
+  --          state-change filter) ; affected = upd, skipped = matched - upd
+$$;
```

Explicit-batch writer for `1..500` `{scopeKey, etag?}` receipts. An entry with
`etag` is a conditional write (`facts.etag` must match, else skipped); without
`etag` it stomps. `affected` = rows that changed state; `skipped` = an existing
fact matched the scopeKey but did not change (etag mismatch, or already in the
requested state). A non-existent scopeKey is neither affected nor skipped. Raises
on a non-array, empty/over-500 batch, duplicate/blank scopeKey, or a present
etag that is not a positive integer.

### `facts_mark_crawled(jsonb)` — dropped (baseline: 0010)

```diff
-CREATE OR REPLACE FUNCTION SCHEMA.facts_mark_crawled(p_stamps JSONB)
-RETURNS TABLE (marked INT, skipped INT) ...
+DROP FUNCTION IF EXISTS SCHEMA.facts_mark_crawled(JSONB);
```

Replaced at the public provider/tool layer by `facts_set_crawled_by_keys` (the
`crawled=true` path is the old receipt mark).
