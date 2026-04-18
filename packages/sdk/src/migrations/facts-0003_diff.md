# Diff for facts migration 0003

Migration file: `facts-migrations.ts` — `migration_0003_facts_stats_procs`

## Table Changes

None.

## New Indexes

None. The existing `(session_id)` and `(shared)` indexes already filter
the candidate rows; namespace bucketing is computed in SQL via
`split_part`. Facts tables stay small relative to `session_events`, so a
sequential scan over the filtered subset is acceptable. If the facts
store grows materially, a follow-up migration can add a partial index
keyed on the namespace expression.

## New Helper Function

```sql
CREATE OR REPLACE FUNCTION facts_namespace_for_key(p_key TEXT)
    RETURNS TEXT AS $$
    -- Returns the first '/' segment when it is one of:
    --   skills | asks | intake | config
    -- otherwise returns '(other)'.
$$ LANGUAGE plpgsql IMMUTABLE;
```

`IMMUTABLE` so PG can fold it into grouping expressions and reuse plans.

## New Stored Procedures

All three return the same row shape:

| Column | Type | Meaning |
|---|---|---|
| `namespace` | TEXT | Bucket: `skills`, `asks`, `intake`, `config`, `(other)` |
| `fact_count` | BIGINT | Number of facts in this bucket |
| `total_value_bytes` | BIGINT | `SUM(pg_column_size(value))` over the bucket |
| `oldest_created_at` | TIMESTAMPTZ | Min `created_at` |
| `newest_updated_at` | TIMESTAMPTZ | Max `updated_at` |

### `facts_get_session_facts_stats(p_session_id TEXT)` — new

Aggregates **non-shared** facts owned by one session. `WHERE session_id =
p_session_id AND shared = FALSE`. Used for the per-session "Facts" card.

### `facts_get_facts_stats_for_sessions(p_session_ids TEXT[])` — new

Same shape, aggregated across an array of session IDs. The management
client resolves the spawn-tree IDs from the CMS first
(`getDescendantSessionIds`), then calls this proc — keeps cross-schema
joins out of SQL.

### `facts_get_shared_facts_stats()` — new

Aggregates **shared** facts (`WHERE shared = TRUE`). Used for the global
shared-facts breakdown on the fleet stats card.

All three use `DROP FUNCTION IF EXISTS ... CASCADE` first so the
migration is idempotent under the same gotcha that bit migration 0006
on the CMS side (`CREATE OR REPLACE` cannot change RETURNS TABLE shape).

## Backfill / Compatibility

- No data migration; reads only.
- Pre-existing facts are aggregated correctly because all rows have a
  populated `key` column from migration 0001.
