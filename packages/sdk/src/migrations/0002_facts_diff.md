# Diff for Facts migration 0002

Migration file: `facts-migrations.ts` — `migration_0002_stored_procedures`

## Table Changes

None.

## New Indexes

None.

## Function Changes

All functions are new — no baselines exist. Every Facts data-access query that was previously inline SQL in `PgFactStore` is now a stored procedure.

### `facts_store_fact` — new

```diff
@@
+ CREATE OR REPLACE FUNCTION SCHEMA.facts_store_fact(
+     p_scope_key TEXT, p_key TEXT, p_value JSONB,
+     p_agent_id TEXT, p_session_id TEXT,
+     p_shared BOOLEAN, p_transient BOOLEAN, p_tags TEXT[]
+ ) RETURNS VOID
```

- INSERT...ON CONFLICT on `scope_key`.
- On conflict: updates `value`, `agent_id`, `session_id`, `shared`, `transient`, `tags`, `updated_at`.

### `facts_read_facts` — new

```diff
@@
+ CREATE OR REPLACE FUNCTION SCHEMA.facts_read_facts(
+     p_scope TEXT, p_reader_session_id TEXT, p_granted_ids TEXT[],
+     p_key_pattern TEXT, p_tags TEXT[],
+     p_session_id TEXT, p_agent_id TEXT, p_limit INT
+ ) RETURNS TABLE (
+     key TEXT, value JSONB, agent_id TEXT, session_id TEXT,
+     shared BOOLEAN, tags TEXT[], created_at TIMESTAMPTZ, updated_at TIMESTAMPTZ
+ )
```

- Implements scope-based visibility:
  - `'shared'`: only `shared = TRUE` rows.
  - `'session'`: only `shared = FALSE` rows matching `p_reader_session_id`.
  - `'accessible'`/`'descendants'`: shared OR own session OR granted descendant sessions.
  - Fallback (no reader session): shared only.
- Optional filters: `key LIKE`, `tags @>`, `session_id =`, `agent_id =`.
- Dynamic SQL via `EXECUTE` for composable WHERE clauses.
- Ordered by `updated_at DESC`, limited to `p_limit`.

### `facts_delete_fact` — new

```diff
@@
+ CREATE OR REPLACE FUNCTION SCHEMA.facts_delete_fact(
+     p_scope_key TEXT
+ ) RETURNS BIGINT
```

- Deletes the row matching `scope_key`.
- Returns the count of deleted rows (0 or 1).

### `facts_delete_session_facts` — new

```diff
@@
+ CREATE OR REPLACE FUNCTION SCHEMA.facts_delete_session_facts(
+     p_session_id TEXT
+ ) RETURNS BIGINT
```

- Deletes all non-shared facts for the given session (`session_id = p AND shared = FALSE`).
- Returns the count of deleted rows.
