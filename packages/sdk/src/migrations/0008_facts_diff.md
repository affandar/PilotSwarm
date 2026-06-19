# Diff for Facts migration 0008

Migration file: `facts-migrations.ts` — `migration_0008_batch_store_pattern_delete`

## Function Changes

### `facts_store_facts(jsonb)` — new

Adds a batch upsert stored procedure. The JSON input is an array of objects with the normalized provider shape:

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

The function inserts or updates every row by `scope_key` and returns the number of upserted rows.

### `facts_store_fact(...)` — body modified

The single-row function now delegates to `facts_store_facts(jsonb_build_array(...))` so single and batch writes share the same stored-procedure path.

### `facts_delete_facts(text, text, text, boolean)` — new

Adds explicit pattern deletion:

```sql
facts_delete_facts(p_key_pattern, p_scope, p_session_id, p_unrestricted)
```

Scopes:

- `session`: delete non-shared facts matching `p_key_pattern` owned by `p_session_id`.
- `shared`: delete shared facts matching `p_key_pattern`.
- `all`: delete any matching facts, but only when `p_unrestricted = true`.

Invalid scopes, blank patterns, `session` without a session id, and `all` without `unrestricted` raise errors.

## Table Changes

None.
