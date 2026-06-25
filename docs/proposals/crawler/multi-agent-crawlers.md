# Multi-Agent Crawlers

## Status

**WIP / Draft.** Design exploration in progress. Not yet scheduled. Captures the
working design from an ongoing discussion; sections may still change.

A lighter **Phase 1 / MVP** that delivers multiple crawlers over *disjoint*
keyspaces with no registry/state/lock — just a prefix-scoped crawl flag on the
existing single `last_crawled_at` column — is specced separately in
[prefix-scoped-crawl-flag.md](./prefix-scoped-crawl-flag.md). This document is the
Phase 2 design (overlap support + enforced ownership).

## Summary

Today the fact crawl queue is a single global cursor: each fact row carries one
`last_crawled_at` stamp, so the first crawler to mark a fact drains that work
item for everyone. This supports exactly one logical graph harvester per facts
schema.

This proposal replaces the single global cursor with a **per-crawler checkpoint**
model so multiple independent crawlers (projections, extractors, sinks) can each
track their own progress over the same facts, plus a **first-class `isCrawler`
agent type** that owns its registration, keyspace, and version. The in-DB
embedder is recast as a singleton **system crawler**.

Core invariant: the `facts` table stays the source of truth, `facts.etag` stays
the source-version token, and crawl progress moves into a `(crawler_id, fact_id)`
state table. A crawler is pending on a fact when **either** the source changed
(`etag`) **or** the crawler's own config changed (`version`).

## Motivation

The crawl queue lives on the base `FactStore` as a nullable `last_crawled_at`
column plus the `facts_read_uncrawled` / `facts_mark_crawled` procs (base facts
migrations; horizon-store `migrations/0001`, `0004`, `0006`, `0012`). The
write-resets-pending-state trigger (`facts_touch`) sets `last_crawled_at = NULL`
and bumps `etag` on content/delete change.

That model has one cursor:

- `last_crawled_at IS NULL` is **the** queue. One crawler marking a fact removes
  it from the queue for all crawlers.
- The harvester prompt encodes "you are the ONLY role allowed to crawl"
  (`examples/horizon-harvester/plugin/agents/source-harvester.agent.md`).
- The embedder is a separate `pg_durable` loop that deliberately never touches
  `last_crawled_at` — it is conceptually already a second crawler, but modeled
  ad hoc.

We want:

- Multiple logical crawlers (graph builder, export sink, summarizer, a
  domain-specific extractor) with independent completion semantics.
- A clean, first-class way to declare and register a crawler.
- The embedder folded into the same mental model as a system crawler.

## Non-Goals / Decisions Locked In

- **No leases, no same-id parallelism.** A `crawler_id` is one durable consumer.
  If the same crawler implementation needs to run again or in parallel, it is a
  **different crawler with a different id**. There is no lease table and no
  `SKIP LOCKED` worker pool.
- **No crawler derivation.** There is no parent/derived crawler concept. Each
  `isCrawler` agent is exactly one crawler.
- **One embedder, one embedding column.** The embedder stays singleton per facts
  schema and keeps writing the single `facts.embedding` column. No per-crawler
  embedding projection table.
- **Config version is a `version` string, not a hash.** Compared by equality
  only; no ordering required. SemVer recommended but any non-empty string is
  valid.
- **Include/exclude keyspaces are simple literal prefixes**, stored as a JSON
  blob on the registry row (no regex, no globs, no separate rules table).

## Data Model

### `facts` (unchanged shape, reused tokens)

- `id BIGSERIAL` — internal identity, used by crawler state joins.
- `scope_key TEXT UNIQUE` — public/evidence/ACL identity (`shared:<key>` /
  `session:<id>:<key>`). Still the graph evidence key.
- `etag BIGINT` — source-version token, bumped by `facts_touch` on key/value or
  `deleted_at` change.
- `deleted_at TIMESTAMPTZ` — soft-delete tombstone.
- `embedding`, `embedded_at`, `embedding_model`, `last_embed_error` — the single
  embedder's columns.

`last_crawled_at` is retired from the meaning-bearing path (kept transiently for
back-compat / default-crawler mirroring during migration, then dropped).

### `fact_crawlers` (registry)

```sql
CREATE TABLE fact_crawlers (
  crawler_id          text PRIMARY KEY,        -- globally unique per schema
  kind                text NOT NULL,           -- graph | embedder | export | ...
  version             text NOT NULL,           -- config/projection version (equality compare)
  title               text,
  agent_id            text,                    -- bound agent definition id
  agent_name          text,
  enabled             boolean NOT NULL DEFAULT true,
  required_for_purge  boolean NOT NULL DEFAULT true,
  system              boolean NOT NULL DEFAULT false,

  owner_session_id    text,                    -- the LOCK (liveness-based)
  owner_claimed_at    timestamptz,

  config              jsonb NOT NULL DEFAULT '{}'::jsonb,

  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
```

`config` JSON blob holds the keyspace + namespace settings:

```json
{
  "includeKeyPrefixes": ["corpus/northwind/"],
  "excludeKeyPrefixes": ["corpus/northwind/drafts/"],
  "graphNamespaces": ["corpus/northwind"]
}
```

Prefix grammar is intentionally tiny: each entry is either the literal token
`"*"` (match all) or a literal starts-with prefix compared with
`fact.key.startsWith(prefix)`. **Exclude wins over include.** An empty include
array is invalid — "all keys" must be the explicit `["*"]` so unbounded access is
always deliberate.

### `fact_crawl_state` (per-crawler checkpoint)

```sql
CREATE TABLE fact_crawl_state (
  crawler_id        text   NOT NULL REFERENCES fact_crawlers(crawler_id),
  fact_id           bigint NOT NULL REFERENCES facts(id) ON DELETE CASCADE,
  processed_etag    bigint NOT NULL,
  processed_version text   NOT NULL,
  projected         boolean NOT NULL DEFAULT false,  -- did this crawler emit a projection for this fact?
  processed_at      timestamptz NOT NULL DEFAULT now(),
  last_error        text,
  PRIMARY KEY (crawler_id, fact_id)
);
```

### Pending rule

```text
pending(crawler, fact) :=
     crawler.enabled
 AND applies(fact.key, crawler.config.includeKeyPrefixes, crawler.config.excludeKeyPrefixes)
 AND ( no state row
     OR state.processed_etag    != fact.etag         -- source changed
     OR state.processed_version != crawler.version )  -- crawler config changed
```

Marking is a per-crawler compare-and-set on `etag` (and stamps `version`):

```sql
INSERT INTO fact_crawl_state (crawler_id, fact_id, processed_etag, processed_version, projected)
SELECT $crawler, f.id, f.etag, $version, $projected
FROM facts f JOIN stamps s ON s.fact_id = f.id
WHERE f.etag = s.etag
ON CONFLICT (crawler_id, fact_id) DO UPDATE
SET processed_etag = EXCLUDED.processed_etag,
    processed_version = EXCLUDED.processed_version,
    projected = EXCLUDED.projected,
    processed_at = now();
```

Crawler A marking a fact never affects crawler B. An edit/delete/revive bumps
`facts.etag`, so every crawler independently re-sees the new version.

## `scopeKey` vs `id`

Use **both**, deliberately:

- Internal relational tables (`fact_crawl_state`, etc.) key on `fact_id BIGINT`
  for cheap joins, FKs, and `ON DELETE CASCADE`.
- `scope_key` stays the **public / evidence / ACL** identity. The graph stores
  evidence as `:Fact {scope_key}` anchors and edge `evidence[]` arrays
  (`packages/horizon-store/src/graph-queries.ts`), and ACL decisions are made
  purely from the key shape (`scopeKeyAccessible`) without touching the facts
  table. Replacing `scopeKey` with `id` would make the graph less self-contained
  and ACL more fragile, and `scopeKey` survives reingestion/rebuild better than a
  local `BIGSERIAL`.

`FactRecord` therefore exposes both `id` and `scopeKey`. Crawler stamps can use
`{ id, etag }`; graph evidence continues to use `scopeKey`.

## The `isCrawler` Agent Type

Crawlers are a first-class agent type, declared in `.agent.md` frontmatter. This
follows the existing precedent where frontmatter becomes runtime config and
selected session/registry state:

- frontmatter → `AgentConfig` incl. `version`, `schemaVersion`, `id`, the
  existing `harvester` flag (`packages/sdk/src/agent-loader.ts`).
- capability derived from the **loaded agent definition** every turn, never
  trusted from serialized session state (`resolveHarvesterRole` in
  `packages/sdk/src/session-proxy.ts`).
- agent `schemaVersion`/`version` → prompt-layer descriptors persisted as the
  `session.prompt_layers` event (`packages/sdk/src/worker.ts`,
  `session-manager.ts`).

The new piece is **durable global materialization**: `isCrawler: true` frontmatter
becomes a row in `fact_crawlers`.

```yaml
---
schemaVersion: 1
version: 1.2.0
name: source-harvester
id: source-harvester
title: Source Harvester
description: Crawls source documents into facts and graph evidence.
isCrawler: true
crawler:
  id: graph/northwind
  kind: graph
  version: 1.2.0
  config:
    includeKeyPrefixes: ["corpus/northwind/"]
    excludeKeyPrefixes: ["corpus/northwind/drafts/"]
    graphNamespaces: ["corpus/northwind"]
  requiredForPurge: true
  enabled: true
---
```

An `isCrawler` agent **must** declare a `crawler` block. It is parsed and
validated; an invalid block fails the session (see below).

### The built-in default crawler

When a graph store is configured, PilotSwarm exposes a built-in `crawler` agent
alongside the generic agent. It is just an `isCrawler` agent with **unbounded**
access:

```yaml
isCrawler: true
crawler:
  id: graph/default
  kind: graph
  version: 1.0.0
  config:
    includeKeyPrefixes: ["*"]
    excludeKeyPrefixes: []
    graphNamespaces: ["*"]
  requiredForPurge: true
  enabled: true
```

There is no derivation — apps that want different scoping ship their own
`isCrawler` agent with its own id.

## Lifecycle: Session-as-Lock

Registration creation and the lock are **orchestration-owned**, claimed
atomically at session start before any LLM turn. The crawler agent only confirms
or edits afterward.

This runs only at `iteration === 0`, top-level, non-system, for an `isCrawler`
agent — the same gating shape as `resolveTopLevelAgentConfig` / the policy
rejection path in `packages/sdk/src/orchestration_1_0_52/runtime.ts`.

```text
1. resolve agent def (activity)              -> agentDef (carries crawler config)
2. validateCrawlerConfig(agentDef.crawler)   -> pure, deterministic
     invalid ⇒ FAIL session  [CRAWLER] <message>
3. readRegistration(crawler.id) (activity)   -> existing | null
4. branch on existing:
     null                      ⇒ claim(owner=self, expected=null)
                                    won  ⇒ initialPrompt = CONFIRM
                                    lost ⇒ FAIL "claimed concurrently"
     owner == self (replay)    ⇒ proceed (history-cached; no re-claim)
     owner != self, ACTIVE     ⇒ FAIL "crawler <id> is locked by session <owner>"
     owner != self, DORMANT    ⇒ stomp(expected=oldOwner, new=self)
                                    won  ⇒ initialPrompt = TAKEOVER (continue vs bump)
                                    lost ⇒ FAIL "claimed concurrently"
```

Every branch keys off an activity result captured in history, so replay is
deterministic. The selected `initialPrompt` and the resolved `crawlerId` are
written into the runTurn config before the first turn — exactly how `isHarvester`
is set authoritatively in `session-proxy.ts`. The model never supplies
`crawlerId`.

### The lock is liveness-based (no lease)

`owner_session_id` is the lock. "Active" = owner session in a non-terminal CMS
state (`pending|running|idle|waiting|input_required`); "dormant/stompable" =
`completed|cancelled|failed|error|deleted|nonexistent`. Dehydrated-but-not-
terminal is still active. No TTL, no heartbeat — consistent with the no-leases
decision. We trust duroxide crash recovery to move a wedged session to a terminal
state, after which it becomes stompable.

Claim/stomp is a compare-and-set so two concurrent starts cannot both win:

```sql
UPDATE fact_crawlers
   SET owner_session_id = $new, owner_claimed_at = now(), version = $version
 WHERE crawler_id = $id
   AND owner_session_id IS NOT DISTINCT FROM $expectedOwner   -- null=fresh, oldOwner=stomp
RETURNING crawler_id;   -- 0 rows ⇒ lost the race ⇒ FAIL
```

Liveness is a separate activity against CMS (facts store and CMS are different
schemas/stores and cannot join), so the sequence is read-registration →
check-owner-liveness → CAS-claim, all yields.

### Confirm / edit flow

- Orchestration injects an initial prompt containing the registered config and
  instructs the agent to confirm with the user.
- If the user wants changes, the agent calls `crawler_update_registration`, which
  CAS-guards on `owner_session_id == self`. After any update the agent re-reads
  the registry and treats it as source of truth.

### Takeover: continue vs bump

Falls out of the two-token pending rule:

- **Continue same version** ⇒ only `etag`-stale facts pending ⇒ a resume.
- **Bump version** ⇒ `processed_version` mismatches everywhere ⇒ full reprocess.

Caveat: bump = idempotent re-assert; it does not remove edges the new logic no
longer produces. A true rebuild needs clear-then-reprocess (drop the crawler's
graph namespace first). Default to reprocess; treat rebuild as an explicit,
namespace-scoped escalation.

## Tool Gating

Crawl tools (`facts_read_uncrawled`, `facts_mark_crawled`, graph writes) are
exposed only when the session's bound agent is `isCrawler` **and** owns its
registration. The binding is re-derived from the static agent def each turn (like
the harvester role); the handler injects the registry `crawlerId` and applies the
registered include/exclude prefixes + version. The model sees only:

```json
facts_read_uncrawled({ "limit": 20 })
facts_mark_crawled({ "stamps": [{ "id": 123, "etag": 7 }] })
```

Registration tools (`crawler_get_registration`, `crawler_update_registration`,
read-only `crawler_list_registrations`) are exposed only to crawler agents (and
the facts-manager for read).

## The Embedder as a System Crawler

Register a singleton system crawler `system/embedder` on facts-store init:

- `kind = embedder`, `system = true`.
- owns the single `facts.embedding` column (no projection table).
- `requiredForPurge = false` — the embedding lives on the fact row and is removed
  automatically on hard purge, so it need not block tombstone purge.
- `version` changes when embedder semantics change (model, dim, input recipe,
  oversize handling) → all applicable live facts requeue for re-embed via the
  `processed_version` mismatch.

The embedder loop reads its own pending set and marks `system/embedder` state on
success. It still never participates in the graph crawl.

## Deletes

Soft-delete unchanged at the row level: `facts_delete` sets `deleted_at` and
`facts_touch` bumps `etag`. The tombstone then becomes pending for **every**
enabled crawler whose keyspace matches:

1. `deleteFact` ⇒ `deleted_at = now()`, `etag++`.
2. each applicable crawler's state is now `etag`-stale ⇒ tombstone surfaces in
   its `readUncrawledFacts`. Tombstones bypass embedding gates and must always be
   delivered.
3. each crawler reconciles its own projection (graph: `graph_remove_evidence`;
   embedder: no-op, row purge clears the column; export: downstream delete).
4. crawler marks `(crawler_id, fact_id, etag)` processed.

Race behavior is preserved by the `etag` CAS: a stale live-mark fails after a
delete; a stale delete-mark fails after a revive.

### Hard purge gating (OPEN — see decisions)

Old check was `last_crawled_at IS NOT NULL`. New check becomes "all required
applicable crawlers have processed this tombstone's etag+version." Two candidate
semantics are under discussion (see Open Decisions).

## Session Deletion Cleanup

On hard delete, the orchestration — conditioned on still owning the row so a
previously-stomped session is a no-op — runs:

```text
if registration.owner_session_id == self:
    delete fact_crawlers    where crawler_id = self.crawlerId AND owner = self
    delete fact_crawl_state where crawler_id = self.crawlerId
```

This sits beside the existing per-session facts cleanup
(`deleteSessionFactsForSession`, `packages/horizon-store/src/horizon-store.ts`).

**Graph is NOT torn down by default.** Graph evidence is keyed by `scope_key`,
not `crawler_id`, so a crawler's contribution cannot be cleanly attributed —
and the default crawler's contribution may be the whole graph. Dropping
registration + crawl state releases the id; a future crawler claiming the same id
re-incorporates idempotently. Graph teardown stays an explicit, namespace-scoped
`graph_delete_namespace` op, never an implicit side effect of deleting a session.

## Determinism & Where Code Lives

- New orchestration logic ⇒ **freeze current `orchestration.ts` to a pinned
  version and register it** per the duroxide orchestration versioning rule.
  In-flight sessions must not see reordered yields.
- New activities: `readCrawlerRegistration`, `claimCrawlerRegistration` (CAS),
  `getSessionLiveness`, `updateCrawlerRegistration`, `deleteCrawlerRegistration`,
  `dropCrawlState`.
- `agent-loader` gains `isCrawler` + structured `crawler` block; `resolveAgentConfig`
  must project the block through (today it carries `harvester` but no config
  payload).
- Provider methods on the base PG facts store and HorizonDB (drop-in parity), all
  via stored procs with companion diff files.
- Config validation is a pure function reused at worker-load (early warning) and
  in the orchestration (hard fail).

## Open Decisions

1. **Purge-blocking semantics.**
   - (a) purge counts only crawlers whose owner is **active** — a dead crawler
     stops blocking, but a later "continue" won't reconcile already-purged
     deletes (same accepted TTL hazard already in the soft-delete proposal); or
   - (b) registration blocks regardless of liveness; the stomp-on-inactive flow is
     the remedy (start a new session for that id → take over → reconcile).
   - Leaning **(b)** to keep the delete-honoring invariant strong.
2. **Graph teardown on session delete.** Recommend **never implicitly**; explicit
   namespace op only.
3. **Config drift on takeover-continue.** Keep the registry's stored config
   (user previously tuned it); overwrite only on explicit edit.
4. **Purge applicability snapshot.** Use current crawler config for tombstone
   applicability (simpler). A delete-time snapshot is only needed for strict audit
   correctness; not starting there.

## Validation Rules (reference)

```text
isCrawler && !crawler                     -> "isCrawler agents must declare a `crawler` config block."
!isSlug(crawler.id)                       -> "crawler.id is required and must match [a-z0-9/_-]+."
!crawler.kind                             -> "crawler.kind is required (e.g. 'graph')."
!nonEmpty(crawler.version)                -> "crawler.version is required and must be a non-empty string."
includeKeyPrefixes not non-empty array    -> "includeKeyPrefixes must be a non-empty array (use [\"*\"] for all keys)."
includeKeyPrefixes not all strings        -> "includeKeyPrefixes must be strings."
excludeKeyPrefixes present, not strings   -> "excludeKeyPrefixes must be strings."
graphNamespaces present, not strings      -> "graphNamespaces must be strings (use [\"*\"] for all)."
```

## Test Sketch

- Two crawler ids both see a new fact; marking one does not drain the other.
- Edit after one crawler marks requeues only that crawler (via `etag`).
- Stale mark with old `etag` skips for that crawler only.
- Version bump requeues all applicable facts for one crawler; others untouched.
- Include/exclude: `/a/b/*` included, `/a/b/d/*` excluded — the `d` subtree never
  appears in that crawler's queue.
- Lock: second session for an active crawler id fails; a dormant owner is stomped;
  concurrent claims — exactly one wins.
- Takeover continue vs bump produce resume vs full reprocess.
- Session delete removes registration + crawl state, leaves the graph.
- Embedder system crawler: version bump re-embeds; embedder never blocks purge.
