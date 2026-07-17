# Internals: CMS Schema and Catalog

The CMS (the session catalog) is the PostgreSQL catalog of sessions and their
event streams. Source of truth:
[`packages/sdk/src/cms-migrations.ts`](../../../packages/sdk/src/cms-migrations.ts)
(numbered, idempotent migrations) and
[`packages/sdk/src/cms.ts`](../../../packages/sdk/src/cms.ts) (the
`PgSessionCatalog` client). Default schema name: `copilot_sessions`. See
[Architecture §3.4](../system.md#34-session-catalog-cms) for the high-level
write/read paths.

## Migration tracking

Migrations are applied by the shared `pg-migrator` into
`"<schema>".schema_migrations`:

```sql
CREATE TABLE schema_migrations (
    version    TEXT PRIMARY KEY,   -- e.g. "0001"
    name       TEXT NOT NULL,      -- e.g. "baseline"
    applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

The chain starts at `0001_baseline` (the schema as of v1.0.41) and currently
runs through twenty-plus migrations listed at the top of `cms-migrations.ts`
(metric summaries, stored procedures, session owners, user profiles,
reasoning effort, session groups, turn metrics, stop-turn
`active_turn_index`, …). Every statement is idempotent; fresh and existing
databases converge to the same shape.

## Table: `sessions`

One row per session (top-level or sub-agent). Baseline columns plus the
accumulated ALTERs:

| Column | Type | Notes |
|---|---|---|
| `session_id` | TEXT PK | |
| `orchestration_id` | TEXT | duroxide instance id (`session-<id>`) |
| `title` / `title_locked` | TEXT / BOOLEAN | auto-summarized title; lock prevents overwrite after manual rename |
| `state` | TEXT | session state machine (`pending`, `active`, `idle`, `waiting`, …) |
| `model` | TEXT | current qualified model id |
| `reasoning_effort` | TEXT | current reasoning-effort setting |
| `created_at` / `updated_at` / `last_active_at` | TIMESTAMPTZ | |
| `deleted_at` | TIMESTAMPTZ | soft delete (NULL = live) |
| `current_iteration` | INTEGER | LLM-turn counter mirror |
| `active_turn_index` | INTEGER | stop-turn targeting for the in-flight turn |
| `last_error` | TEXT | |
| `parent_session_id` | TEXT | sub-agent parent linkage |
| `is_system` / `agent_id` / `splash` | BOOLEAN / TEXT / TEXT | system-agent metadata |
| `wait_reason` | TEXT | why the session is waiting (durable timer, input, …) |
| `group_id` | TEXT | legacy session-group membership — no longer read or written since migration 0034 (placements live in `user_session_group_placements`; column dropped in a later release) |
| `short_summary` / `summary_state` / `summary_updated_at` | TEXT / JSONB / TIMESTAMPTZ | rolling summary machinery |

Partial indexes on `(state)` and `(updated_at DESC)` where `deleted_at IS NULL`.

## Table: `session_events`

Append-only event stream per session — the replay/catch-up backbone for every
UI (`GET /api/v1/management/sessions/:id/events?afterSeq=…`):

| Column | Type | Notes |
|---|---|---|
| `seq` | BIGSERIAL PK | **the cursor** — clients page/replay by `seq` |
| `session_id` | TEXT | indexed with `seq` |
| `event_type` | TEXT | e.g. `user.message`, `assistant.message`, `session.cron_fired` |
| `data` | JSONB | event payload |
| `worker_node_id` | TEXT | emitting worker |
| `created_at` | TIMESTAMPTZ | |

## Other tables

| Table | Purpose |
|---|---|
| `session_metric_summaries` | per-session token/cost/turn rollups (fleet stats) |
| `session_turn_metrics` | per-turn metrics (tokens, duration, reasoning effort) |
| `session_groups` / `session_group_owners` | session groups + per-user ownership (groups are private per-user organization) |
| `user_session_group_placements` | migration 0034: `(user_id, root_session_id) → group_id` — each viewer's private placement of a session tree in one of their own groups; composite FK into `session_group_owners` makes cross-user placement structurally impossible |
| `session_child_outcomes` | terminal outcomes of sub-agents for parent digests |
| `users` / `session_owners` | principals, per-user profile/keys, session ownership |

## The catalog client

`PgSessionCatalog` (in `cms.ts`) implements the `SessionCatalog` interface.
Reads and writes go through **stored procedures** (`cms_create_session`,
`cms_get_session`, `cms_list_sessions`, `cms_get_session_events`,
`cms_get_fleet_stats_totals`, …) rather than inline SQL — the proc names are
mapped once near the top of `cms.ts`. This keeps the SQL surface versioned by
the migration chain and lets read shapes evolve without touching callers.

Consumers: the worker (writes events, updates state), the portal server's
management surface, and the direct-mode management client. User-facing
clients never touch these tables — they see them through the Web API
(see [layering](../layering.md)).
