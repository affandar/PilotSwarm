# Diff for Facts migration 0007

Migration file: `facts-migrations.ts` — `migration_0007_minimal_crawl_queue`

## Table Changes

### `facts` — modified

```diff
- content_hash TEXT
```

The crawl queue final schema no longer stores a content hash. Pending crawl state is represented only by `last_crawled_at IS NULL`.

## New Indexes

None.

## Function Changes

### `facts_touch()` — body modified (baseline: 0006)

```diff
-CREATE OR REPLACE FUNCTION SCHEMA.facts_touch() RETURNS trigger
-LANGUAGE plpgsql AS $$
-DECLARE
-    new_hash TEXT;
-BEGIN
-    new_hash := md5(coalesce(NEW.key, '') || E'\\x1f' || coalesce(NEW.value::text, ''));
-    NEW.content_hash := new_hash;
-    IF TG_OP = 'INSERT' OR new_hash IS DISTINCT FROM OLD.content_hash THEN
-        NEW.last_crawled_at := NULL;
-    END IF;
-    RETURN NEW;
-END $$;
+CREATE OR REPLACE FUNCTION SCHEMA.facts_touch() RETURNS trigger
+LANGUAGE plpgsql AS $$
+BEGIN
+    IF TG_OP = 'INSERT' OR NEW.key IS DISTINCT FROM OLD.key OR NEW.value IS DISTINCT FROM OLD.value THEN
+        NEW.last_crawled_at := NULL;
+    END IF;
+    RETURN NEW;
+END $$;
```

### `facts_read_uncrawled(text, int)` — return shape modified (baseline: 0006)

```diff
 ) RETURNS TABLE (
     scope_key    TEXT,
     key          TEXT,
     value        JSONB,
     agent_id     TEXT,
     session_id   TEXT,
     shared       BOOLEAN,
     tags         TEXT[],
     created_at   TIMESTAMPTZ,
-    updated_at   TIMESTAMPTZ,
-    content_hash TEXT
+    updated_at   TIMESTAMPTZ
 )
```

The returned receipt is now `scopeKey` only.

### `facts_mark_crawled(jsonb)` — stamp shape modified (baseline: 0006)

```diff
 WITH stamps AS (
-    SELECT e->>'scopeKey' AS scope_key, e->>'contentHash' AS content_hash
+    SELECT e->>'scopeKey' AS scope_key
     FROM jsonb_array_elements(p_stamps) e
 ),
 upd AS (
     UPDATE SCHEMA.facts f
        SET last_crawled_at = now()
       FROM stamps s
      WHERE f.scope_key = s.scope_key
-       AND f.content_hash = s.content_hash
+       AND f.last_crawled_at IS NULL
     RETURNING f.scope_key
 )
```

A skipped stamp now means the fact is already marked or does not exist, rather than a content-hash mismatch.
