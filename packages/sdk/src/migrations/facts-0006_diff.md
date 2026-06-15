# Facts Migration 0006 — base-store crawl queue (vanilla PG, no extension)

**Enhancedfactstore 07 D3.** The facts↔graph crawl bridge lives on the **base**
facts store as plain facts-table bookkeeping, so a base-Postgres deployment can
feed a separate `GraphStore` harvester. Additive, idempotent, and **inert unless
a graph harvester runs**.

## New columns

```diff
+ ALTER TABLE facts ADD COLUMN IF NOT EXISTS content_hash    TEXT;
+ ALTER TABLE facts ADD COLUMN IF NOT EXISTS last_crawled_at TIMESTAMPTZ;
```

- `content_hash` — trigger-maintained `md5(key, value)`; the receipt key for the
  read→mark race guard.
- `last_crawled_at` — `NULL` ⇒ pending crawl. Reset to `NULL` whenever content
  changes.

Existing rows are backfilled with `content_hash`; `last_crawled_at` stays `NULL`
(correctly pending — nothing has crawled them).

## New index (work queue)

```diff
+ CREATE INDEX IF NOT EXISTS idx_<schema>_facts_uncrawled
+     ON facts (id) WHERE last_crawled_at IS NULL;
```

## New trigger — write resets pending state

```diff
+ CREATE OR REPLACE FUNCTION facts_touch() RETURNS trigger ... $$
+ DECLARE new_hash TEXT;
+ BEGIN
+   new_hash := md5(coalesce(NEW.key,'') || E'\x1f' || coalesce(NEW.value::text,''));
+   NEW.content_hash := new_hash;          -- always authoritative
+   IF TG_OP = 'INSERT' OR new_hash IS DISTINCT FROM OLD.content_hash THEN
+     NEW.last_crawled_at := NULL;          -- re-queue only on content change
+   END IF;
+   RETURN NEW;
+ END $$;
+ DROP TRIGGER IF EXISTS facts_touch ON facts;
+ CREATE TRIGGER facts_touch BEFORE INSERT OR UPDATE ON facts
+   FOR EACH ROW EXECUTE FUNCTION facts_touch();
```

`content_hash` is recomputed and assigned on **every** write (so a direct
tamper can't strand a row); `last_crawled_at` is reset to `NULL` **only** when
the embeddable content actually changed. Marking a fact crawled
(`UPDATE ... SET last_crawled_at = now()` with no key/value change) leaves the
stamp intact — the trigger recomputes the same hash and the `IF` does not fire.

## New procs — harvester work queue

```diff
+ -- Pending facts across ALL scopes (privileged), optional LITERAL key-prefix
+ -- narrowing via starts_with (no LIKE wildcards).
+ CREATE OR REPLACE FUNCTION facts_read_uncrawled(p_ns_prefix TEXT, p_limit INT)
+   RETURNS TABLE (scope_key, key, value, agent_id, session_id, shared, tags,
+                  created_at, updated_at, content_hash) ...
+   WHERE f.last_crawled_at IS NULL
+     AND (p_ns_prefix IS NULL OR starts_with(f.key, p_ns_prefix))
+   ORDER BY f.id LIMIT p_limit;

+ -- Stamp last_crawled_at = now() ONLY where content_hash still matches the
+ -- receipt (a fact edited mid-crawl stays queued). Mismatches skipped, not errors.
+ CREATE OR REPLACE FUNCTION facts_mark_crawled(p_stamps JSONB)
+   RETURNS TABLE (marked INT, skipped INT) ...
+   UPDATE facts SET last_crawled_at = now()
+     WHERE scope_key = stamp.scopeKey AND content_hash = stamp.contentHash;
```

## Safety / idempotency

- `ADD COLUMN IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`, `CREATE OR REPLACE
  FUNCTION`, `DROP TRIGGER IF EXISTS` + recreate — all idempotent.
- Vanilla PostgreSQL only — **no extension** (`vector`/`age`/etc. not required).
- On a deployment with no graph harvester, the columns are unused and the trigger
  just maintains `content_hash` — no behavioural change to existing reads/writes.
