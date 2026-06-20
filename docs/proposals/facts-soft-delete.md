# Facts Soft Delete and Graph Reconciliation

## Status

Proposed.

Prerequisite groundwork has landed: the store/delete surfaces were unified in
base facts migration `0009` (`unified_store_delete_api`) and horizon migration
`0011` (`unified_api_embedder_workflow`). This proposal builds on that unified
API.

## Summary

Replace physical fact deletion with a soft-delete marker so a separate process
can keep the knowledge graph consistent with the facts store. Today a deleted
fact row vanishes, leaving dangling `EVIDENCED_BY` anchors and stale edge
`evidence[]` entries in the graph. With soft delete, a deleted fact stays
durably visible to the graph-reconciliation pipeline until the graph has been
cleaned up, after which the row is hard-deleted by the Facts Manager.

The design reuses the existing crawl ledger and is **graph-agnostic**: the facts
store never needs to know whether a graph or crawler exists. A soft-deleted row
is hidden from reads immediately and hard-deleted by the Facts Manager once either
the crawler has reconciled it (`last_crawled_at` set) or a configurable TTL has
elapsed (default 6h). The TTL bounds tombstone lifetime even when no crawler
runs; setting it to `0` reclaims rows on the next maintenance pass.

## Motivation

The facts store and the knowledge graph are two stores stitched together by
fact `scope_key`. Graph nodes/edges reference facts through `EVIDENCED_BY`
anchors and edge `evidence[]` arrays. There is no first-class ACL or lifecycle
link between them: the graph filters evidence visibility by `scope_key` shape,
not by whether the fact row still exists.

Physical deletion is therefore lossy for graph maintenance:

- `facts_delete_fact` / `facts_delete` remove the row outright.
- After the row is gone, nothing durable records that the `scope_key` was
  deleted.
- The graph keeps pointing at a fact that no longer exists; resolving that
  evidence via `read_facts` silently returns nothing.

This also blocks safe future session **forking**. Forking copies private facts
and duplicates graph evidence anchors; deleting a fork's fact must remove only
that fork's evidence without disturbing the source. That requires a delete
signal the graph pipeline can observe.

## Current State

### Two fact stores, both pair with the graph

- **`PgFactStore`** — base store, migrations in
  [facts-migrations.ts](../../packages/sdk/src/facts-migrations.ts), latest
  version `0009`. Unified procs: `facts_store_fact`, `facts_delete_fact`. Reads:
  `facts_read_facts`, `facts_read_unrestricted`. Crawl ledger:
  `facts_read_uncrawled`, `facts_mark_crawled`.
- **`HorizonDBFactStore`** — enhanced store, migrations in
  [packages/horizon-store/migrations/](../../packages/horizon-store/migrations),
  latest `0011`. Unified procs: `facts_store`, `facts_delete`. Reads:
  `facts_read`, `facts_search_lexical`, `facts_search_semantic`, `facts_similar`,
  `facts_stats`. Crawl ledger: `facts_read_uncrawled`, `facts_mark_crawled`.
  Durable embedder: `embedder_workflow(mode, interval, batch)`.

The graph (`HorizonDBGraphStore`) can pair with **either** fact store, so soft
delete must land in **both** to be correct.

### The crawl ledger already exists

Both stores carry a `last_crawled_at` column and a `facts_touch` trigger that, on
insert or key/value change, force-sets `last_crawled_at := NULL` to re-queue the
fact for crawling. `last_crawled_at IS NULL` is the harvester / graph-sync work
queue. There is **no `content_hash`** (both stores dropped it — base `0007`,
horizon `0008`/`0010`); the embedder rides the same reset-on-write pattern,
gating on `embedding IS NULL` (the trigger NULLs `embedding` on content change),
independent of the crawl signal.

## Design

### `deleted_at` marker

Add a nullable `deleted_at TIMESTAMPTZ` column to `facts` in both stores
(`NULL` = live). The timestamp doubles as the soft-delete flag (`deleted_at IS
NOT NULL`) and as the TTL clock for the Facts Manager's purge pass. No separate
boolean.

### Purge gate: reconciled OR TTL-expired

`last_crawled_at` stays the crawler's "I reconciled this" signal; `deleted_at`
drives the time-based backstop. A tombstone is hard-delete-eligible when it has
been reconciled **or** its TTL has elapsed:

```sql
deleted_at IS NOT NULL
AND (last_crawled_at IS NOT NULL OR deleted_at < now() - $ttl)
```

| `deleted_at` | `last_crawled_at` | meaning | action |
|---|---|---|---|
| NULL | NULL | live, needs (re)crawl | agent-visible; harvester incorporates |
| NULL | not null | live, reconciled | agent-visible |
| set, within TTL | NULL | deleted, graph not yet reconciled | hidden from reads; **keep** |
| set | not null | deleted, graph reconciled | hidden; **Facts Manager hard-deletes** |
| set, past TTL | NULL | deleted, crawler missed its window | hidden; **Facts Manager hard-deletes (TTL backstop)** |

A healthy crawler purges tombstones within seconds (the `last_crawled_at` arm);
with no crawler (or one that is down), the TTL governs. `ttl = 0` makes every
tombstone eligible on the next Facts Manager pass — the explicit "no crawler"
setting.

### Reads hide soft-deleted facts

Add `AND deleted_at IS NULL` to every agent-facing read proc:

- base: `facts_read_facts`, `facts_read_unrestricted`
- horizon: `facts_read`, `facts_search_lexical`, `facts_search_semantic`,
  `facts_similar`, `facts_stats`

### The crawl queue exposes, does not filter

`facts_read_uncrawled` keeps returning `last_crawled_at IS NULL` rows but adds
`deleted_at` and `etag` columns (`etag` is the optimistic-concurrency token —
see **Concurrency & Lost Updates**). The consumer branches:

- `deleted_at IS NULL` → incorporate into the graph (today's behavior).
- `deleted_at IS NOT NULL` → remove the fact's `EVIDENCED_BY` anchors and strip
  its `scope_key` from edge `evidence[]`.

Either way the consumer then calls `facts_mark_crawled` with the `etag` it read,
which sets `last_crawled_at = now()` **only if the row's `etag` is unchanged** —
flipping a reconciled tombstone into the hard-delete-eligible state immediately,
ahead of the TTL. If the row moved since the read, the mark is skipped and the
row is re-read in its current state.

### Soft delete is an UPDATE

`facts_delete_fact` / `facts_delete` become an `UPDATE`, not a `DELETE`:

```sql
UPDATE facts
   SET deleted_at = now()
 WHERE scope_key = p_scope_key
   AND deleted_at IS NULL;
```

The store is graph-agnostic. The extended `facts_touch` trigger (see
**Concurrency & Lost Updates**) fires on the `deleted_at` change: it bumps
`etag` and resets `last_crawled_at := NULL`, re-queuing the tombstone for the
crawler. If a crawler exists it reconciles and stamps `last_crawled_at`; if none
does, the row ages out via the TTL. Session-scoped bulk delete
(`facts_delete_session*`) does the same live-row-only `UPDATE ... WHERE
session_id = ... AND deleted_at IS NULL`.

Soft delete is idempotent. Deleting an already-tombstoned row should not refresh
`deleted_at`, bump `etag`, reset `last_crawled_at`, or extend the TTL window.

### Revive on re-store

`scope_key` is `UNIQUE`. Re-storing a soft-deleted key must revive the row, not
collide. `facts_store_fact` / `facts_store` `ON CONFLICT (scope_key) DO UPDATE`
clears `deleted_at` (back to `NULL`). Because the extended `facts_touch` trigger
fires on the `deleted_at` transition (not just key/value), the revived fact
re-enters the crawl queue and bumps `etag` **even when the new value is
identical** to the pre-deletion value — closing the identical-value revive race
(see **Concurrency & Lost Updates**).

### Graph-agnostic by construction

The facts store never branches on whether a graph/crawler exists. Change
detection is pure reset-on-write: the `facts_touch` trigger resets the pending
markers on a content change — `last_crawled_at := NULL` (re-queue crawl) and, in
horizon, `embedding := NULL` (re-queue embed). There is **no `content_hash`**
(both stores dropped it), and the "no crawler" case is handled entirely by the
TTL, not by a graph-awareness flag — no settings table, no
`facts_reconciliation_enabled()`.

The embedder is independent of crawl reconciliation: it gates on `embedding IS
NULL` and its candidate query gains `AND deleted_at IS NULL` so tombstones are
not embedded. The soft-delete path deliberately does **not** reset `embedding`
(a delete/revive must not force a re-embed).

### Facts Manager: TTL purge, backlog monitoring, force-purge

Fact-tombstone cleanup belongs to the **Facts Manager**, not the Sweeper. The
Facts Manager already owns the facts lifecycle (skill-TTL expiry via
`config/facts-manager/skill-ttl`, intake retention via
`config/facts-manager/retention-window`), already carries facts tools, and
already runs a 6h maintenance pass — so TTL-based tombstone purge is the same
kind of work it already does. The Sweeper stays scoped to session lifecycle and
orchestration pruning and gains nothing here. The Facts Manager grows three
capabilities on its maintenance pass, as privileged facts tools
([facts-tools.ts](../../packages/sdk/src/facts-tools.ts)) gated to the
facts-manager identity.

**1. TTL purge (periodic).** Batch hard-delete eligible tombstones via
`facts_purge_expired(p_ttl_seconds, p_limit)`:

```sql
DELETE FROM facts
 WHERE ctid IN (
   SELECT ctid FROM facts
    WHERE deleted_at IS NOT NULL
      AND (last_crawled_at IS NOT NULL OR deleted_at < now() - make_interval(secs => p_ttl_seconds))
    ORDER BY deleted_at
    LIMIT p_limit
    FOR UPDATE SKIP LOCKED);
```

The TTL is **configurable in the Facts Manager session**, not a deploy-time
constant. It is a `config/facts-manager/tombstone-ttl` fact (default 6h) seeded
alongside the existing `config/facts-manager/*` defaults and read each
maintenance pass — the same mechanism as `skill-ttl` and `cycle-interval`. An
operator can change it conversationally ("set the tombstone TTL to 1 hour";
"purge tombstones now" → `0`) or by editing the fact, and the purge tool also
accepts a `ttlSeconds` override. `0` means purge on the next pass. No new
reserved namespace is needed — `config/facts-manager/` is already reserved to
this agent.

**2. Backlog monitoring (per cycle).** A `facts_tombstone_stats()` proc reports:

- `pending_total` — all tombstones not yet purged
- `unreconciled` — `deleted_at IS NOT NULL AND last_crawled_at IS NULL`
- `ttl_blocked` — unreconciled **and** still inside the TTL window (cannot purge yet)
- `oldest_unreconciled_age_seconds` — `max(now() - deleted_at)` where
  `last_crawled_at IS NULL` (the headline crawler-lag number)
- `reconciled_unswept` — `last_crawled_at IS NOT NULL` (should hover near zero)

The Facts Manager logs these each maintenance pass and emits an event when
`oldest_unreconciled_age_seconds` crosses a threshold (e.g. 80% of TTL) — an
early warning that the crawler is behind before the TTL backstop strands graph
evidence.

**3. Operator force-purge (on demand).** A confirmation-gated tool backed by
`facts_force_purge(p_cutoff, p_only_unreconciled, p_key_prefix, p_limit)` that
hard-deletes tombstones older than a cutoff regardless of TTL or reconciliation:

```sql
DELETE FROM facts
 WHERE deleted_at IS NOT NULL AND deleted_at < p_cutoff
   [AND last_crawled_at IS NULL]       -- when p_only_unreconciled
   [AND key LIKE p_key_prefix || '%']; -- optional namespace bound
```

Force-purge bypasses graph reconciliation and therefore **strands graph
evidence** for any unreconciled rows it removes; when a graph is configured it
must be paired with a graph-hygiene pass (drop edges/nodes whose evidence no
longer resolves). It is scoped to tombstones only (`deleted_at IS NOT NULL`) —
never live facts.

### Observability wiring (per repo rule)

The backlog signal must be reachable by the agent-manager/tuner through a tool,
not just a Facts Manager log. Wire it the standard way:

- persist via `facts_tombstone_stats()` (both stores)
- `getFactsTombstoneStats()` on `PilotSwarmManagementClient`
- a `read_facts_tombstone_stats` inspect tool (manager/tuner sessions)
- a stats-pane selector in `ui-core/selectors.js` (native TUI + portal)
- a `*-stats.test.js` covering the proc + management API + inspect tool

## Concurrency & Lost Updates

The crawl queue is an at-least-once queue with an **optimistic compare-and-set
mark**. `facts_read_uncrawled` is a non-locking `SELECT ... WHERE last_crawled_at
IS NULL` (no `FOR UPDATE`, no `SKIP LOCKED`), and `facts_mark_crawled` stamps
`last_crawled_at = now()`. There is **no `content_hash` anywhere** — both stores
dropped it (base `0007`, horizon `0008`/`0010`); change detection is pure
reset-on-write in `facts_touch`. The mark is `scopeKey`-only today, guarded
solely by `last_crawled_at IS NULL`.

That guard prevents double-marking but **not** state-change races: a soft-delete
or revive resets `last_crawled_at := NULL`, so a stale in-flight mark still sees
`NULL` and wrongly succeeds.

### The races

**Race 1 — incorporate, then soft-delete (lost delete → dangling evidence).**

| step | event |
|---|---|
| T1 | crawler reads F as **live**, starts incorporating → adds evidence |
| T2 | F is soft-deleted → `deleted_at=now()`, re-queued |
| T3 | crawler `mark_crawled([F])` → `last_crawled_at IS NULL` still true → **marks reconciled** |

F now looks reconciled but its evidence was *added*, never removed; the
reconciled-arm TTL purge then deletes the row → **permanent dangling evidence**.

**Race 2 — remove evidence, then revive (orphaned live fact).** Mirror image: the
crawler reads F as deleted and strips evidence; F is revived; the stale mark
stamps the now-live fact as incorporated → a live fact with no evidence that is
never re-incorporated.

**Race 3 — revive with identical value.** Under a key/value-only requeue trigger,
deleting then re-storing F with the same value clears `deleted_at` but never
resets `last_crawled_at` → the revived live fact is never re-incorporated.

### The fix: a per-row `etag`

A single monotonic `etag BIGINT NOT NULL DEFAULT 0` is the optimistic-
concurrency token. It restores exactly what the removed `content_hash` receipt
used to provide, extended to cover deletes. The name is intentionally `etag`, not
`version`, to avoid confusion with agent prompt versions and orchestration
versions.

- **Bump in the trigger**, scoped to crawl-relevant state. Extend `facts_touch`
  so the requeue/bump also fires on `deleted_at` change, while the embedding
  reset stays key/value-only:

  ```sql
  IF TG_OP = 'INSERT' THEN
      NEW.etag            := COALESCE(NEW.etag, 0) + 1;
      NEW.last_crawled_at := NULL;          -- requeue crawl
  ELSIF NEW.key        IS DISTINCT FROM OLD.key
     OR NEW.value      IS DISTINCT FROM OLD.value
     OR NEW.deleted_at IS DISTINCT FROM OLD.deleted_at
  THEN
      NEW.etag            := COALESCE(OLD.etag, 0) + 1;
      NEW.last_crawled_at := NULL;          -- requeue crawl
  END IF;
  IF TG_OP = 'INSERT'
     OR NEW.key   IS DISTINCT FROM OLD.key
     OR NEW.value IS DISTINCT FROM OLD.value
  THEN
      NEW.embedding := NULL; ...            -- requeue embed (content only; horizon)
  END IF;
  ```

- **Read returns it.** `facts_read_uncrawled` returns `etag` alongside
  `deleted_at`.

- **Mark guards on it** (compare-and-set):

  ```sql
  UPDATE facts f SET last_crawled_at = now()
    FROM stamps s
   WHERE f.scope_key = s.scope_key
     AND f.last_crawled_at IS NULL          -- queue-membership guard (double-mark)
     AND f.etag = s.etag;                   -- state guard (lost-update)
  ```

The `etag` bump does **not** fire on a `last_crawled_at`-only write, so the
mark never perturbs the token. With this:

- Race 1: soft-delete bumps `etag` → the mark's `etag = s.etag` fails →
  skip → F stays queued → re-read as a *delete* → reconciled correctly.
- Race 2: revive bumps `etag` → mark skips → re-read as *live* → re-incorporated.
- Race 3: revive fires the `deleted_at` arm → bumps `etag` + resets
  `last_crawled_at` even when the value is identical → re-queued.

As a bonus, the token also closes the **pre-existing** edit-during-crawl
staleness (a value edited between read and mark bumps `etag`, so the stale
mark skips) — a gap that opened when the `content_hash` receipt was removed.

### Why only the mark guards

Optimistic concurrency applies to **read-modify-write** consumers — the crawl
mark is the only one (read queue → reconcile graph → write back). Blind
`facts_store` / `facts_delete`-by-`scope_key` stay unguarded: they are
last-writer-wins by design, and an agent storing a fact must not fail because a
crawler happened to read it. Those writes still bump `etag` (so any in-flight
mark notices), but never block.

### Benign and accepted interleavings

- **Purge deletes a tombstone while a delete-reconcile crawl is in flight.**
  `mark` matches 0 rows (`skipped`); graph evidence removal is idempotent.
  Harmless.
- **Two crawlers read the same row.** `last_crawled_at IS NULL` lets only the
  first mark win; the second is skipped. Incorporate and evidence-removal are
  both idempotent, so the duplicate work is wasteful, not wrong. No row locks /
  `SKIP LOCKED` required.

There is one accepted TTL/force-purge hazard: if a crawler read a **live** fact,
then the fact is soft-deleted and hard-purged before that in-flight crawler
finishes, the stale live crawler can still add evidence and then fail to mark
because the row is gone. That strands evidence. The mitigation is operational and
explicit: the TTL must exceed the maximum expected crawl batch duration when a
crawler is running, and `tombstone-ttl = 0` is only appropriate when the operator
knows no crawler is running. Force-purge is documented as intentionally capable
of stranding graph evidence.

## Implementation Surface

### Base store — facts migration `0010`

- `ALTER TABLE facts ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ`
- `ALTER TABLE facts ADD COLUMN IF NOT EXISTS etag BIGINT NOT NULL DEFAULT 0`
- partial index `WHERE deleted_at IS NOT NULL`
- extend `facts_touch`: bump `etag` + reset `last_crawled_at := NULL` on
  key/value **and** `deleted_at` change (see Concurrency & Lost Updates)
- `facts_store_fact` → clear `deleted_at` on conflict (revive)
- `facts_delete_fact` (exact + pattern modes) → soft `UPDATE SET deleted_at = now()`
  for live rows only (`deleted_at IS NULL`), preserving idempotency
- `facts_read_facts`, `facts_read_unrestricted` → `AND deleted_at IS NULL`
- `facts_read_uncrawled` → return `deleted_at` + `etag` (no filter)
- `facts_mark_crawled` → add `AND etag = receipt.etag` CAS guard; the tool
  schema requires `etag` in every mark receipt
- new `facts_purge_expired(p_ttl_seconds, p_limit)`,
  `facts_tombstone_stats()`, `facts_force_purge(p_cutoff, …)`
- companion diff at `packages/sdk/src/migrations/0010_facts_diff.md`
- TS: `facts-store.ts` `fn` map + new `FactStore` methods (purge / stats /
  force-purge); thread `etag` through `readUncrawledFacts` → `markFactsCrawled`

### Horizon store — migration `0012_facts_soft_delete.sql`

Mirror of the above against `facts_store`, `facts_delete`, `facts_read`,
`facts_search_lexical`, `facts_search_semantic`, `facts_similar`, `facts_stats`,
`facts_read_uncrawled`, and the `embedder_workflow` candidate query (add
`AND deleted_at IS NULL`). Add `deleted_at` + `etag`; extend `facts_touch` to
bump `etag` + reset `last_crawled_at` on key/value **and** `deleted_at`
change, while keeping the `embedding := NULL` reset on key/value **only** (a
delete/revive must not force a re-embed). `facts_mark_crawled` gains the
`etag` CAS guard. Plain SQL file (no diff-file convention in horizon-store).

### Graph-sync consumer

Extend the crawler / graph-sync that drains `facts_read_uncrawled` to branch on
`deleted_at` and remove graph evidence for deleted facts before marking them
crawled.

### Facts Manager

- privileged purge / stats / force-purge tools in
  [facts-tools.ts](../../packages/sdk/src/facts-tools.ts), bound to `factStore`
  and gated to the facts-manager identity; the purge tool reads/seeds
  `config/facts-manager/tombstone-ttl` and accepts a `ttlSeconds` override
  (`0` = purge on next pass)
- no new reserved namespace — `config/facts-manager/` is already in
  `RESERVED_WRITE_PREFIXES` / `RESERVED_DELETE_PREFIXES`
- Facts Manager agent prompt
  ([facts-manager.agent.md](../../packages/sdk/plugins/mgmt/agents/facts-manager.agent.md)):
  add `config/facts-manager/tombstone-ttl` to the seeded config defaults, run the
  TTL purge + emit backlog stats each maintenance pass, and expose force-purge on
  operator request; bump `version`
- the Sweeper is explicitly **not** involved — it keeps only session-lifecycle
  and orchestration-pruning duties

### Harvester sample

[examples/horizon-harvester/](../../examples/horizon-harvester) is the worked
example that must exercise soft delete end-to-end:

- **Crawl consumer.** The harvester's `facts_read_uncrawled` drain branches on
  `deleted_at`: incorporate when live, remove `EVIDENCED_BY` anchors + strip edge
  `evidence[]` when deleted, then `facts_mark_crawled` with the read `etag`.
- **New scenario.** Add a delete/reconcile path to
  `scripts/run-horizon-harvester-sample.sh` (e.g. `HARVESTER_SCENARIO=delete`):
  harvest → graph evidence present → soft-delete a `corpus/*` source fact →
  harvester reconcile pass → evidence removed → Facts Manager purge (or `ttl = 0`
  / force-purge) drops the tombstone.
- **Visualize.** `scripts/export-horizon-harvester-graph.sh` should show the
  before/after (evidence anchor gone).
- **Agents.** `plugin/agents/source-harvester.agent.md` learns the delete-branch
  behavior; the `librarian` reader is unaffected (reads already filter
  `deleted_at`). Bump each agent's `version`.
- **Keep in sync** (per repo rule): the three repo-root harvester scripts, the
  sample `README.md` (Run / Visualize / Cleanup), the builder skill
  `templates/builder-agents/skills/pilotswarm-knowledge-harvester/SKILL.md`, and
  `docs/harvester-deployment.md`.

## Test Plan

### Functional

- Soft delete hides a fact from all agent reads while the row persists.
- Within TTL and unreconciled (`last_crawled_at IS NULL`): survives a Facts Manager pass.
- Reconciled (`last_crawled_at` set): hard-deleted by the Facts Manager before TTL.
- Past TTL and unreconciled: hard-deleted by the Facts Manager (TTL backstop).
- `ttl = 0`: a tombstone is purged on the next Facts Manager pass.
- Re-storing a soft-deleted key revives it (visible again) and re-enters the
  crawl queue.
- A soft delete surfaces in `facts_read_uncrawled` with `deleted_at` set + a
  bumped `etag`; live uncrawled facts surface with `deleted_at IS NULL`.
- Re-deleting an already-tombstoned row is a no-op: it does not change
  `deleted_at`, bump `etag`, reset `last_crawled_at`, or extend the TTL window.
- Embedder skips `deleted_at IS NOT NULL` rows; a soft-delete does **not** reset
  `embedding` (no needless re-embed), but a value edit does.
- `facts_force_purge(cutoff)` removes matching tombstones regardless of TTL /
  reconciliation; refuses without the confirmation flag; never touches live rows.
- `facts_tombstone_stats()` reports correct pending / unreconciled / ttl_blocked /
  oldest-age counts; reachable via management client + inspect tool.
- Parity: identical behavior across base and horizon stores.

### Concurrency (deterministic proc-level interleavings)

Force the interleavings by calling the procs in a fixed order — no threads
needed; the `etag` CAS makes the outcome deterministic. Run each against
**both** stores.

- **Race 1 (incorporate→delete):** `read_uncrawled` captures `etag=e`;
  soft-delete F; `mark_crawled([{scopeKey, etag: e}])` → asserts `skipped`,
  F still `last_crawled_at IS NULL` with `deleted_at` set; a re-read returns F
  flagged as a delete.
- **Race 2 (remove→revive):** soft-delete F; read tombstone `etag=e`; revive
  F; `mark_crawled(e)` → `skipped`; F live, `last_crawled_at IS NULL`; re-read
  returns F as live/incorporate.
- **Race 3 (revive identical value):** soft-delete F; reconcile (`mark_crawled`
  succeeds); re-store F with an identical value; assert `etag` bumped and
  `last_crawled_at` reset to `NULL` (re-queued).
- **Double-mark (two crawlers):** two reads capture `etag=e`; first
  `mark_crawled(e)` marks; second `mark_crawled(e)` → `skipped` (the
  `last_crawled_at IS NULL` guard).
- **Stale-etag mark (pre-existing edit race):** edit F's value between read and
  mark; `mark_crawled(old_etag)` → `skipped`.
- **Missing etag receipt:** `mark_crawled([{ scopeKey }])` is rejected by tool
  schema validation or counted as skipped by the proc; it must never mark a row.
- **Purge during delete-reconcile crawl (benign):** read tombstone;
  `facts_purge_expired` (or `facts_force_purge`) deletes the row;
  `mark_crawled` → `skipped`, no error.
- **Accepted TTL/force-purge hazard:** read F as live; soft-delete F; hard-purge
  the tombstone before the stale live crawler marks. Assert mark is skipped and
  document that any evidence the stale crawler added may be stranded. This test
  verifies the behavior is understood, not that it is prevented; operational
  mitigation is `tombstone-ttl` > max crawler batch duration and `ttl = 0` only
  when no crawler is running.
- **TTL backstop:** an unreconciled tombstone older than the TTL is purged even
  though `last_crawled_at IS NULL`.

### Harvester sample (end-to-end)

- A sample-level scenario that harvests a `corpus/*` doc, builds graph evidence,
  soft-deletes a source fact, runs the harvester reconcile pass, and asserts the
  `EVIDENCED_BY` anchor + edge `evidence[]` entry are gone, then the Facts
  Manager purge removes the tombstone (see **Harvester sample** under
  Implementation Surface).

## Open Questions

1. **Who removes graph evidence for a deleted fact?**
   - (Recommended) The crawler / graph-sync that already drains
     `facts_read_uncrawled` handles the `deleted_at` branch — removing
     `EVIDENCED_BY` anchors and edge `evidence[]` — then marks crawled. The
     Facts Manager only does the TTL / row hard-delete. Clean separation; only
     one actor touches the graph.
   - Alternative: the Facts Manager owns both evidence removal and hard-delete,
     but it would need a graph handle it does not have today.
2. **Default TTL** — 6h proposed. Long enough to absorb crawler restarts /
   backlog, short enough to bound tombstone accumulation. Configurable **in the
   Facts Manager session** via a `config/facts-manager/tombstone-ttl` fact,
   alongside `skill-ttl` and `cycle-interval`; not a deploy-time constant.
3. **Force-purge + graph hygiene** — should `facts_force_purge` automatically
   trigger a graph-hygiene pass when a graph is configured, or just report the
   orphan count and leave the hygiene pass to the operator?
4. **Pattern / bulk delete semantics** — `facts_delete_fact` pattern mode and
   `facts_delete_session*` should soft-delete every matched row; confirm there is
   no path that still needs a true physical delete.
5. **Transient facts** — `transient = true` facts are session-scoped scratch and
   never crawled. Should they hard-delete directly (bypass soft delete), since
   the TTL would otherwise hold them briefly for no benefit?
6. **Backfill** — existing rows get `deleted_at = NULL` (live); historical
   physical deletes are unrecoverable (only future deletes are observable). No
   backfill needed.
7. **TTL backstop vs strict reconciliation** — accept that a crawler down longer
   than the TTL leaves dangling graph evidence (mitigated: evidence resolution
   fails closed, and a graph-hygiene sweep is the long-term backstop), or add a
   crawler-liveness check that pauses TTL purge while the crawler is known down?

## Relationship to Forking

Soft delete makes fork option (2) — copy private facts **and** duplicate graph
evidence anchors — safe and symmetric:

- Forking emits upserts under new fork `scope_key`s, which re-arm the incorporate
  queue.
- Deleting a fork's fact emits a soft delete, which re-arms the reconciliation
  queue, and the graph-sync removes only that fork's evidence — never the
  source's.
