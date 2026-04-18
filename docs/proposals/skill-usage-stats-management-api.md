# Skill Usage & Cache Observability — Management API Additions

> **Two related proposals in one doc.** Part 1 (above) ships per-session
> and fleet-level **skill usage** stats (static + learned). Part 2 (below
> the divider) ships **prompt-cache observability**: a small Phase A gap
> fix for fleet cache totals + derived hit ratios, and a larger Phase B
> for per-turn cache breakdown via a new `turn.usage` event.

# Skill Usage Stats — Management API Addition

## Summary

Add three read-only methods to `PilotSwarmManagementClient` that report
which skills a session (or its full spawn tree) consumed, and a fleet-level
roll-up of skill usage by agent. Two flavors of skill are reported under a
unified `kind` discriminator:

- **`static`** — skills the model expanded via the Copilot SDK skill
  mechanism (files in plugin `skills/` directories). Source event:
  `skill.invoked` (already emitted by the SDK and persisted to
  `session_events` today).
- **`learned`** — curated knowledge under the `skills/` key prefix in the
  facts store, fetched by the agent via `read_facts`. Source event:
  **new** `learned_skill.read`, emitted by the `read_facts` tool wrapper
  whenever the request touches `skills/...`.

A single partial B-tree index covers both event types. No table changes.

## Motivation

Today an operator can see a session's tokens, snapshot bytes, and
hydration counters via `getSessionMetricSummary` / `getSessionTreeStats` /
`getFleetStats`, but there is no first-class way to ask:

- "Which skills did this session actually consume?"
- "Did the agent look at curated knowledge under `skills/`?"
- "How often was each skill invoked across this spawn tree?"
- "Which skills are dead weight across the fleet?"

This information matters for:

- **Skill curation** — decide which static or learned skills to keep,
  retire, or promote.
- **Prompt tuning** — verify the agent picks up the skills you expect.
- **Cost attribution** — correlate skill use with token spend.
- **Agent-tuner investigations** — answer "did the model load the right
  skill at the divergence point?" without scrolling raw events.

## Data Sources

### Static skills (already captured)

The Copilot SDK fires `skill.invoked` every time the model expands a
static skill. PilotSwarm's `ManagedSession` event collector already
persists these verbatim into `copilot_sessions.session_events`. Payload:

```jsonc
{
  "name":          "tui-architecture",
  "path":          "/path/to/SKILL.md",
  "pluginName":    "pilotswarm",
  "pluginVersion": "0.1.19",
  "description":   "..."
}
```

### Learned skills (new event)

The `read_facts` tool today returns matching facts but emits no
skill-specific signal. We add a thin wrapper around the existing
`read_facts` handler in `facts-tools.ts`. **Once per `read_facts` call**
that touches `skills/...` (either as a direct `key` or via a
`keyPattern` matching `skills/...`), the wrapper emits a single
`learned_skill.read` event:

```jsonc
{
  "type": "learned_skill.read",
  "data": {
    "name":         "skills/tui",        // the requested key OR pattern, normalized
    "scope":        "shared",            // shared | session | lineage
    "matchCount":   12,                  // how many facts came back
    "limit":        50,                  // what the caller asked for
    "callerSessionId": "abc-...",
    "callerAgentId":   "alpha"           // null for generic sessions
  }
}
```

Important: this is **one event per call**, not per returned key. A wide
read like `read_facts(keyPattern: 'skills/%')` records one
`learned_skill.read` with `name: "skills/%"` and `matchCount: N`. This
matches what the operator actually wants to know — "this session asked
the facts store for curated knowledge under X" — and avoids spamming the
event log on broad sweeps.

Backfill: not possible. Historical sessions never emitted this event;
post-deploy data will simply be richer than pre-deploy data.

## Design

### Migration 0005 — partial index + 3 stored procs

Per [the schema-migration skill](../../.github/skills/schema-migration/SKILL.md),
add a single migration `0005_skill_usage_procs` with one partial index
covering both event types and three new stored procs.

```sql
-- Single partial B-tree covers both static and learned skill events.
CREATE INDEX IF NOT EXISTS idx_<schema>_events_skill_signals
    ON <schema>.session_events (session_id, created_at DESC)
    WHERE event_type IN ('skill.invoked', 'learned_skill.read');
```

Procs:

```sql
-- cms_get_session_skill_usage(session_id, since)
-- Returns one row per (kind, name, plugin_name, plugin_version) for one session.
-- kind is 'static' | 'learned' (derived from event_type).

-- cms_get_session_tree_skill_usage(root_session_id, since)
-- Recursive CTE over sessions.parent_session_id; one row per
-- (session_id, kind, name, plugin_name, plugin_version). Roll-up to the
-- tree summary happens in the management client.

-- cms_get_fleet_skill_usage(since, include_deleted)
-- Joined to the sessions table so each row carries agent_id.
-- Returns rows of (agent_id, kind, name, plugin_name, plugin_version,
-- session_count, invocations, last_used_at).
```

### Management client API

```ts
// PilotSwarmManagementClient

type SkillKind = "static" | "learned";

interface SkillUsageRow {
    kind: SkillKind;
    /** Static: skill name. Learned: requested key or keyPattern (e.g. "skills/foo/%"). */
    name: string;
    pluginName: string | null;     // static skills only
    pluginVersion: string | null;  // static skills only
    invocations: number;
    firstUsedAt: Date;
    lastUsedAt: Date;
}

interface SessionSkillUsage {
    sessionId: string;
    skills: SkillUsageRow[];
    totalInvocations: number;
}

interface SessionTreeSkillUsage {
    rootSessionId: string;
    perSession: Array<{
        sessionId: string;
        agentId: string | null;
        skills: SkillUsageRow[];
    }>;
    rolledUp: SkillUsageRow[]; // merged across the whole tree
    totalInvocations: number;
}

interface FleetSkillUsageRow extends SkillUsageRow {
    agentId: string | null;
    sessionCount: number;
}

interface FleetSkillUsage {
    windowStart: Date | null;
    rows: FleetSkillUsageRow[];
}

class PilotSwarmManagementClient {
    getSessionSkillUsage(sessionId: string, opts?: { since?: Date }): Promise<SessionSkillUsage>;
    getSessionTreeSkillUsage(rootSessionId: string, opts?: { since?: Date }): Promise<SessionTreeSkillUsage>;
    getFleetSkillUsage(opts?: { since?: Date; includeDeleted?: boolean }): Promise<FleetSkillUsage>;
}
```

Naming mirrors the existing trio:

| Existing | New |
|---|---|
| `getSessionMetricSummary` | `getSessionSkillUsage` |
| `getSessionTreeStats` | `getSessionTreeSkillUsage` |
| `getFleetStats` | `getFleetSkillUsage` |

### Agent-facing tool wrappers

Following the pattern established in `inspect-tools.ts` / the agent-tuner
work, expose three thin wrappers as **always-on read-only tools**:

- `read_session_skill_usage(session_id, since_iso?)` — open to every
  agent for a session in its lineage; tuner can read any session.
- `read_session_tree_skill_usage(session_id, since_iso?)` — same
  lineage / tuner gating.
- `read_fleet_skill_usage(since_iso?, include_deleted?)` —
  **tuner-only**, fleet-wide.

Lineage gating reuses the same predicate as `read_agent_events`.

### `read_facts` interception

In `packages/sdk/src/facts-tools.ts`, plumb an optional `recordEvent`
callback into `createFactTools`. After the underlying `factStore.readFacts(...)`
returns, the wrapper inspects the request:

- If the call was made with a single `key` starting with `skills/`, emit
  one `learned_skill.read` with `name: key`.
- If the call was made with a `keyPattern` and the pattern starts with
  `skills/`, emit one `learned_skill.read` with `name: keyPattern`.
- Otherwise, no event.

The event is appended to the same per-turn captured-event list that
`ManagedSession` already persists at end-of-turn, so it travels through
the durable activity boundary the same way `skill.invoked` does. No
orchestration changes; no determinism risk.

The metadata-only knowledge-index lookup (used to build the prompt's
"available skills" preamble) does **not** route through `read_facts`, so
it is not double-counted.

### Portal & CLI surfacing

- **Portal** session detail / stats panel: a "Skills used" section
  listing `kind`, `name`, `invocations`, `lastUsedAt`. Static and learned
  rows are visually distinguished (e.g. different badge color).
- **TUI** stats inspector: a "Skills" tab inside the existing stats pane.
  Per-session view by default; `f` toggle to fleet view (tuner only)
  reuses `read_fleet_skill_usage`.
- **CLI**: `pilotswarm session skills <session-id>` and
  `pilotswarm fleet skills` shortcuts.

## Implementation

1. **Migration 0005.** Single partial index covering
   `('skill.invoked', 'learned_skill.read')`; three stored procs returning
   the unified row shape with a `kind` column. Companion `0005_diff.md`.
2. **CMS provider.** `getSessionSkillUsage`,
   `getSessionTreeSkillUsage`, `getFleetSkillUsage` on
   `SessionCatalogProvider` + `PgSessionCatalogProvider`. Tree provider
   returns per-row data; the client does the roll-up so SQL stays simple.
3. **`read_facts` interception.** `createFactTools` accepts a
   `recordEvent` callback. The `read_facts` handler emits
   `learned_skill.read` when applicable.
4. **Management client.** Adds the three methods. Result-shaping
   (rolled-up totals, per-session grouping) happens here.
5. **Inspect tools.** Register the three new read tools; lineage-gated
   for non-tuner; fleet variant tuner-only.
6. **Tests.** New file `packages/sdk/test/local/skill-usage.test.js`:
   - Static skill usage: a session that triggers `skill.invoked` shows
     `kind: 'static'` rows with correct counts/timestamps and plugin
     metadata.
   - Learned skill read: a session that calls `read_facts(keyPattern:
     'skills/%')` records a single `learned_skill.read` row with
     `kind: 'learned'` and `matchCount` reflected in the test data.
   - Mixed: both `kind` types appear in one session.
   - Tree query rolls up across parent + children.
   - Fleet query groups by `agentId`.
   - `since` filter excludes older events.
   - Lineage gate denies non-descendant target for non-tuner caller; tuner
     bypasses.

## Performance Notes

- All three queries filter on `event_type IN
  ('skill.invoked', 'learned_skill.read')`. Both are rare relative to the
  hot event types (`assistant.delta`, `tool.execution_*`). The partial
  index keeps only those rows, indexed by `(session_id, created_at DESC)`,
  which is the natural shape for all three procs.
- Per-session and tree queries are single-seek + range scans against the
  partial index.
- Fleet query is a range scan against the partial index joined to
  `sessions` for `agent_id`. Always pass a `since` lower bound when
  serving the default portal view (e.g. last 7 days).
- Index write cost is paid only when one of the two rare events fires —
  not on every event insert.

## Non-Goals

- **No "available skills" report.** That's `session.skills_loaded` and
  rarely interesting on its own.
- **No skill-quality scoring.** Just consumption counts and timestamps.
  Anything richer (e.g. "did the skill help") needs LLM evaluation —
  belongs in the agent-tuner workflow, not the stats API.
- **No per-key fan-out for learned reads.** One event per `read_facts`
  call. If we ever want per-key counts we can add a separate Tier 3
  later without breaking this API.
- **No write-back to `session_metric_summary`.** Skill counts are derived
  on demand. They don't deserve a denormalized column until a real
  performance hotspot shows up.

## Phasing

| Phase | Scope |
|-------|-------|
| 1 | Migration + `read_facts` interception + CMS provider + management API + tests |
| 2 | Tool wrappers (`read_session_skill_usage`, tree variant for all agents; fleet variant for tuner) |
| 3 | Portal "Skills used" panel + TUI Skills tab + CLI shortcuts |

Phase 1 is shippable on its own and immediately useful for ad-hoc SQL
and the agent-tuner. Phases 2 and 3 are polish.

---

# Prompt Cache Observability — Follow-On

The skill-usage work above lands the per-session and fleet stats pipeline.
This section folds in a related, smaller observability gap: prompt cache
hit/miss tracking that should be exposed alongside the existing token
counts.

## Where We Are Today

`session_metric_summaries` already stores the raw per-session cache token
counts populated by `extractMetricsFromUsage()` in `session-proxy.ts`:

| Column | Meaning |
|---|---|
| `tokens_input` | total prompt tokens (inclusive of cached prefix) |
| `tokens_output` | completion tokens |
| `tokens_cache_read` | cache HIT tokens (prefix served from cache) |
| `tokens_cache_write` | cache WRITE tokens (prefix newly cached this turn) |

`getSessionMetricSummary` and `getSessionTreeStats` expose all four.
Producer side already exists.

## Gaps to Fix (Phase A — small migration 0006)

1. **`getFleetStats` / `cms_get_fleet_stats_*` ignore cache columns.**
   Sums only `tokens_input` / `tokens_output`. Both the fleet totals and
   the `byAgent` breakdown should add `total_tokens_cache_read` and
   `total_tokens_cache_write`. Pure additive change to two existing
   stored procs.
2. **No derived `cacheHitRatio` field.** Every UI surface re-derives it
   from raw counts and re-handles the divide-by-zero case. Add
   `cacheHitRatio` (0..1, or `null` when `tokensInput` is 0) to the
   typed shapes returned by `getSessionMetricSummary`,
   `getSessionTreeStats`, and `getFleetStats`. Computed in the TS
   provider, not stored — definition lives in one place.
3. **TUI/portal don't surface the ratio.** The per-session Tokens card
   already shows `Cache Read` / `Cache Write` raw counts; add
   `Hit ratio  37.2%`. The fleet view's `Tokens By Model` block omits
   cache columns entirely; add them and a per-bucket hit ratio.

### Scope of migration 0006

- Add cache columns + ratio to `cms_get_fleet_stats_byagent` and
  `cms_get_fleet_stats_totals` (or whichever procs back `getFleetStats`).
- Companion `0006_diff.md`.
- No table changes; data is already there.

### Definition of `cacheHitRatio` (single source of truth)

```ts
function cacheHitRatio(tokensInput: number, tokensCacheRead: number): number | null {
    if (!tokensInput) return null;
    // tokens_input is the inclusive convention: total prompt tokens
    // including the cached prefix. So hit ratio = read / input.
    return Math.max(0, Math.min(1, tokensCacheRead / tokensInput));
}
```

Defined once in `cms.ts`, applied everywhere a typed summary is built.
SQL exposes it too via the same `read / NULLIF(input, 0)` shape so the
DB-side procs return identical numbers.

### Convention assumption

We assume `tokens_input` is the **inclusive** convention (total prompt
tokens including cached prefix). This matches OpenAI/Anthropic billing
shape. If a future provider reports `input_tokens` excluding cached
prefix, `extractMetricsFromUsage()` must normalize before storage —
that's a producer-side fix, not a consumer-side one. Document the
convention in `session-proxy.ts` next to the extractor.

## Phase C — Facts Stats (per-session, tree, shared)

The CMS-level summaries cover tokens, snapshot, hydrations, skills, and
cache. They do **not** cover the durable knowledge surface — the facts
table — which is the second largest source of cost and the primary
artifact of the knowledge pipeline. Phase C closes that gap with three
new aggregations bucketed by **knowledge namespace** (the first `/`
segment of the key).

### Why this matters

Without facts stats:

- "Has the Facts Manager been productive?" — requires raw SQL.
- "Why is hydration so big on this session?" — facts are part of the
  durable surface; large session-scoped facts inflate it. Operators
  can see snapshot bytes but can't attribute to facts vs other state.
- "Which knowledge namespace is growing?" — invisible.

### Bucketing

A single SQL helper, `facts_namespace_for_key(text) → text`, folds the
first path segment to one of:

```
skills | asks | intake | config | (other)
```

`IMMUTABLE` so PG can fold it into grouping expressions and re-use
plans. The set is the canonical knowledge-pipeline namespace map; new
namespaces fall through to `(other)` until promoted explicitly.

### Schema

No table changes. No new indexes. The existing `(session_id)` and
`(shared)` btree indexes filter the candidate rows; bucketing happens
in SQL on the filtered subset. Facts tables stay small relative to
`session_events`, so a sequential scan is fine. If facts grow
materially, a follow-up migration can add an expression index on
`facts_namespace_for_key(key)`.

### Stored procs (facts/0003)

All three return the same row shape:

| Column | Type | Meaning |
|---|---|---|
| `namespace` | TEXT | One of the bucket values above |
| `fact_count` | BIGINT | Number of facts in this bucket |
| `total_value_bytes` | BIGINT | `SUM(pg_column_size(value))` |
| `oldest_created_at` | TIMESTAMPTZ | Min `created_at` |
| `newest_updated_at` | TIMESTAMPTZ | Max `updated_at` |

| Proc | Filter |
|---|---|
| `facts_get_session_facts_stats(session_id)` | `WHERE session_id = $1 AND shared = FALSE` |
| `facts_get_facts_stats_for_sessions(session_ids[])` | `WHERE session_id = ANY($1) AND shared = FALSE` |
| `facts_get_shared_facts_stats()` | `WHERE shared = TRUE` |

The tree variant takes an explicit array because the parent/child
relation lives in the **CMS** schema, not facts. The management client
resolves descendants via `getDescendantSessionIds(rootId)` first and
passes the result to the facts schema. Avoids a cross-schema join,
which today doesn't exist anywhere in the codebase.

All three use `DROP FUNCTION IF EXISTS ... CASCADE` first so the
migration is idempotent under the same constraint that hit migration
0006 (`CREATE OR REPLACE FUNCTION` cannot change RETURNS TABLE shape).

### Privacy

These procs return **counts and bytes only**. Never values, keys, or
agent IDs. The whole point is "what's in there at a high level"; a
tuner that needs more should call `read_facts` with a key pattern.

### Management API

```ts
interface FactsStatsRow {
    namespace: "skills" | "asks" | "intake" | "config" | "(other)";
    factCount: number;
    totalValueBytes: number;
    oldestCreatedAt: Date | null;
    newestUpdatedAt: Date | null;
}

getSessionFactsStats(sessionId): Promise<{
    sessionId: string;
    rows: FactsStatsRow[];
    totalCount: number;
    totalBytes: number;
}>;

getSessionTreeFactsStats(sessionId): Promise<{
    rootSessionId: string;
    sessionIds: string[];          // resolved tree (root + descendants)
    rolledUp: FactsStatsRow[];
    totalCount: number;
    totalBytes: number;
}>;

getSharedFactsStats(): Promise<{
    rows: FactsStatsRow[];
    totalCount: number;
    totalBytes: number;
}>;
```

### Tuner inspect-tools

Three tuner-only `read_*_facts_stats` tools mirroring the management
methods. Registered only when `factStore` is wired through
`createInspectTools` (so non-tuner sessions never see them).

`session-manager.ts` passes the same `factStore` it uses for the
`read_facts` tool. Test coverage: `test/local/facts-stats.test.js`
seeds facts in different scopes and namespaces, asserts the bucketing
+ aggregation, and verifies the management API surface end-to-end.

### TUI / portal surface

Two new cards in the existing stats pane (shared between native TUI
and portal via `selectInspector`):

- **Per-session "Facts" card** — title shows `count · bytes`; body lists
  rows sorted by count, formatted as `namespace  count  bytes`. When
  the spawn tree's facts diverge from the session's own (i.e. children
  also have facts), append a `Tree (N sessions): count · bytes` line.
- **Fleet "Shared Facts" card** — same row format, fleet-wide shared
  scope only. Useful to spot Facts Manager activity at a glance.

Both fetches are folded into the existing `ensureSessionStats` /
`ensureFleetStats` paths, which only fire when the user opens the
**stats** inspector tab — so the queries do not run on every session
view. `Promise.all` + `.catch(() => null)` keeps a single failing query
from killing the rest.

## Phase B — Per-Turn Cache Stats

Phase A gives token-level totals. Phase B adds per-turn granularity so
operators can answer:

- "Did this *specific turn* benefit from cache?"
- "What's the cache hit rate trend over a long session?"
- "Which model / agent has the worst cache utilization on a per-call
  basis?"

### Approach: emit a `turn.usage` CMS event per turn

Same shape as `learned_skill.read` — durable append to `session_events`,
no new tables. Persisted via the existing `recordEvents` path so it
survives crash recovery the same way as `assistant.delta`,
`tool.execution_complete`, `skill.invoked`, `learned_skill.read`.

```jsonc
{
  "type": "turn.usage",
  "data": {
    "turnId":          "uuid",
    "model":           "gpt-4o",
    "inputTokens":      1234,
    "outputTokens":      456,
    "cacheReadTokens":   900,
    "cacheWriteTokens":  100,
    "durationMs":       4321,
    "toolCalls":           2,
    "stopReason":      "end_turn"
  }
}
```

Producer: in `ManagedSession`, where the existing `usage` is unpacked
for the metric-summary upsert, also append a `turn.usage` event to the
per-turn captured-event list. One event per turn.

### Migration 0007

- Partial index:
  ```sql
  CREATE INDEX idx_<schema>_events_turn_usage
      ON <schema>.session_events (session_id, created_at DESC)
      WHERE event_type = 'turn.usage';
  ```
- Three stored procs (mirroring the skill-usage trio):
  - `cms_get_session_turn_usage(session_id, since)` — one row per turn.
  - `cms_get_session_turn_usage_summary(session_id, since)` — single
    row roll-up: turn count, sums, avg / p50 / p95 cache_hit_ratio.
  - `cms_get_fleet_turn_usage(since, include_deleted, group_by)` —
    `group_by ∈ ('agent', 'model', 'agent_model')`. Returns turn count,
    token sums, cache-ratio percentiles per bucket.

### Management API

```ts
interface TurnUsageRow {
    turnId: string;
    model: string | null;
    createdAt: Date;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    durationMs: number | null;
    toolCalls: number | null;
    cacheHitRatio: number | null;
}

interface SessionTurnUsageSummary {
    turnCount: number;
    totalInputTokens: number;
    totalOutputTokens: number;
    totalCacheReadTokens: number;
    totalCacheWriteTokens: number;
    avgCacheHitRatio: number | null;
    p50CacheHitRatio: number | null;
    p95CacheHitRatio: number | null;
}

class PilotSwarmManagementClient {
    getSessionTurnUsage(sessionId: string, opts?: { since?: Date }): Promise<TurnUsageRow[]>;
    getSessionTurnUsageSummary(sessionId: string, opts?: { since?: Date }): Promise<SessionTurnUsageSummary>;
    getFleetTurnUsage(opts?: { since?: Date; includeDeleted?: boolean; groupBy?: "agent" | "model" | "agent_model" }): Promise<{ buckets: Array<{ key: string; summary: SessionTurnUsageSummary }> }>;
}
```

Plus tuner-only inspect tools mirroring the skill-usage trio:
`read_session_turn_usage`, `read_session_turn_usage_summary`,
`read_fleet_turn_usage`.

### Optional cute optimization (Phase B addendum)

Add two counters to `session_metric_summaries`:

- `turn_count` — +1 per turn
- `cache_hit_turn_count` — +1 per turn where `cacheReadTokens > 0`

Gives **turn-level cache hit rate** (`hit_turns / total_turns`) without
scanning events. Useful complementary signal to the token-level ratio:

- Token-level ratio answers "of all my prompt tokens, what fraction were
  cached?"
- Turn-level rate answers "of all my model calls, what fraction got any
  cache benefit at all?"

Two columns + two atomic increments in the existing upsert proc.
Trivially cheap; can ship inside Phase A migration 0006 if convenient,
or with Phase B 0007.

### TUI/portal surfacing for Phase B

- Per-session stats: add "Cache trend" mini-card showing avg ratio,
  last-N turns sparkline, and turn-level hit rate.
- Fleet stats: add cache hit ratio columns to the per-agent / per-model
  breakdown.

## Updated Phasing (combined)

| Phase | Scope |
|-------|-------|
| 1 | Skill-usage migration 0005 + read_facts interception + CMS provider + management API + tests **(SHIPPED)** |
| 2 | Skill-usage tool wrappers (tuner-only) **(SHIPPED)** |
| 3 | Skill-usage TUI Skills card + portal Skills section **(SHIPPED via shared selector)** |
| **A** | **Cache totals gap-fix: migration 0006 (fleet cache columns), `cacheHitRatio` derived field everywhere, TUI/portal token cards show hit ratio** |
| **B** | **Per-turn cache stats: migration 0007 (`turn.usage` event + 3 procs), management API + tuner inspect tools, optional `(turn_count, cache_hit_turn_count)` summary counters, TUI/portal cache trend card** |

Phase A is small and immediately useful (one migration, ~50 LoC
TypeScript, one selector update, one test file). Phase B is comparable
in scope to the skill-usage work above.
