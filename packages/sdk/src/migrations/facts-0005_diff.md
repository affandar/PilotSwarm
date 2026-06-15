# Facts Migration 0005 — `facts_read_facts` exposes `scope_key` + accepts `scopeKeys`

**Enhancedfactstore 02 §1c base-API prerequisite.** Additive; ACL semantics unchanged.

## What changed vs 0004

`facts_read_facts` is dropped (the return shape changes, so `CREATE OR REPLACE`
alone is insufficient) and recreated with:

1. **Return table gains `scope_key TEXT`** as the first column. The TypeScript
   layer maps it to `FactRecord.scopeKey`, so callers can reference a fact by its
   canonical scope key — required for resolving graph `evidence` arrays back into
   facts.

2. **New trailing param `p_scope_keys TEXT[] DEFAULT NULL`** (10th arg). When
   **non-null** (even an empty array), an extra clause
   `f.scope_key = ANY(p_scope_keys)` is appended **inside** the visibility filter
   (so it can only narrow what the caller may already see — never a privilege
   escalation). An **empty array matches nothing** (`ANY('{}')` is false for all
   rows), i.e. "read exactly these zero facts" — it must never widen the read.
   `undefined`/`NULL` means "no scopeKeys filter". This is the bulk read-by-key
   path (`readFacts({ scopeKeys })`).

```diff
 DROP FUNCTION IF EXISTS facts_read_facts(TEXT, TEXT, TEXT[], TEXT, TEXT[], TEXT, TEXT, INT, BOOLEAN) CASCADE;

 CREATE OR REPLACE FUNCTION facts_read_facts(
     p_scope TEXT, p_reader_session_id TEXT, p_granted_ids TEXT[],
     p_key_pattern TEXT, p_tags TEXT[], p_session_id TEXT, p_agent_id TEXT,
     p_limit INT, p_unrestricted BOOLEAN DEFAULT FALSE,
+    p_scope_keys TEXT[] DEFAULT NULL
 ) RETURNS TABLE (
+    scope_key  TEXT,
     key TEXT, value JSONB, agent_id TEXT, session_id TEXT,
     shared BOOLEAN, tags TEXT[], created_at TIMESTAMPTZ, updated_at TIMESTAMPTZ
 ) AS $$
   ...
-  base_sql := 'SELECT f.key, f.value, ... FROM facts f WHERE ';
+  base_sql := 'SELECT f.scope_key, f.key, f.value, ... FROM facts f WHERE ';
   ... (visibility filter unchanged) ...
+  -- Bulk read-by-key (narrows within the visibility filter above). Non-null
+  -- but empty array matches nothing (zero facts requested).
+  IF p_scope_keys IS NOT NULL THEN
+    where_clauses := array_append(where_clauses,
+      'f.scope_key = ANY(' || quote_literal(p_scope_keys)::TEXT || '::TEXT[])');
+  END IF;
   ... (optional filters + ORDER BY + LIMIT unchanged) ...
```

## Safety / idempotency

- `DROP FUNCTION IF EXISTS ... CASCADE` then `CREATE OR REPLACE` — idempotent.
- The 10th param has `DEFAULT NULL`, so even a legacy 9-arg positional call still
  works; the TS layer now passes all 10.
- ACL is still applied first; `scopeKeys` only adds an `AND` clause, never widens.
- **Empty `scopeKeys` returns nothing** (governance: an empty evidence set must
  not become "return everything"). The TS layer distinguishes `undefined` (no
  filter) from `[]` (empty set).
