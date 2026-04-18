# Diff for facts migration 0004

Migration file: `facts-migrations.ts` — `migration_0004_facts_read_unrestricted`

## Why

The agent-tuner is read-only by definition (no `store_fact` /
`delete_fact` access — see facts-tools.ts namespace gates), but its job
is to investigate **arbitrary** sessions, not just those in its own
spawn lineage. The previous `facts_read_facts` proc enforced lineage
visibility for any non-null `reader_session_id`, which silently
returned 0 rows whenever the tuner queried a session that wasn't in
its own lineage. The screenshot in the conversation that prompted this
migration showed the tuner running every variant of the read-facts
call (descendants/accessible/session-direct) against four sibling
session IDs and getting `0 rows` for each — the facts existed; the
gate was wrong for this caller.

## Schema Changes

None.

## Stored Procedure Changes

### `facts_read_facts` — bumped signature

Adds a trailing `p_unrestricted BOOLEAN DEFAULT FALSE` parameter.

When `p_unrestricted = TRUE`:

- The visibility OR-group is replaced with `TRUE`.
- All optional filters (`p_key_pattern`, `p_session_id`, `p_agent_id`,
  `p_tags`) still apply.
- `p_scope` and `p_reader_session_id` are ignored.

When `p_unrestricted = FALSE` (default), the proc behaves exactly as
before — same scope/lineage semantics for normal task agents.

`DROP FUNCTION IF EXISTS ... CASCADE` is required first because PG
won't let `CREATE OR REPLACE FUNCTION` change the parameter list.

## Caller Plumbing

- `FactStore.readFacts(query, access)` — `access` gains
  `unrestricted?: boolean`.
- `PgFactStore.readFacts` passes the flag as the 9th positional arg
  (defaulted to `false` so existing callers are unaffected).
- `createFactTools.read_facts` handler enables `unrestricted` only
  when `agentIdentity === "agent-tuner"`. The namespace-write/delete
  gates already block tuner writes; this widens reads only.

## No new indexes

The unrestricted path uses the same indexes the gated path does
(`session_id`, `key`, `tags`).
