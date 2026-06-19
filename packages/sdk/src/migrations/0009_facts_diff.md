# Diff for Facts migration 0009

Migration file: `facts-migrations.ts` — `migration_0009_unified_store_delete_api`

## Function Changes

### `facts_store_fact(jsonb)` — new unified signature

Replaces the separate plural proc name with the singular store proc name. The public `FactStore.storeFact()` API now accepts either one `StoreFactInput` or an array of inputs; both modes call this single stored procedure.

```sql
facts_store_fact(p_facts jsonb) returns int
```

Input JSON is the same normalized provider array introduced in migration `0008`:

```json
{
  "scopeKey": "shared:corpus/a",
  "key": "corpus/a",
  "value": { "text": "..." },
  "agentId": "agent-id-or-null",
  "sessionId": "session-id-or-null",
  "shared": true,
  "transient": false,
  "tags": ["tag"]
}
```

The migration drops the older single-row overload and the transitional `facts_store_facts(jsonb)` proc so the external stored-proc surface has one store verb.

### `facts_delete_fact(text, boolean, text, text, boolean)` — new unified signature

Replaces exact-only delete plus the transitional plural pattern-delete proc with one singular delete proc.

```sql
facts_delete_fact(
  p_key_or_pattern text,
  p_pattern boolean default false,
  p_scope text default null,
  p_session_id text default null,
  p_unrestricted boolean default false
) returns bigint
```

Modes:

- `p_pattern = false`: `p_key_or_pattern` is a `scope_key` and the proc performs exact delete.
- `p_pattern = true`: `p_key_or_pattern` is a SQL LIKE pattern and the proc applies `session` / `shared` / `all` scope checks.

The migration drops the old one-argument exact-delete overload and the transitional `facts_delete_facts(text, text, text, boolean)` proc.

## Table Changes

None.
