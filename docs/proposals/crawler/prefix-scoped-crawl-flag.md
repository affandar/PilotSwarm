# Prefix-Scoped Crawl Flag (Phase 1 Multi-Crawler)

## Status

**WIP / Draft.** Phase 1 / MVP of
[multi-agent-crawlers.md](./multi-agent-crawlers.md). Delivers "multiple crawlers
over different keyspaces" with two new stored procs and a couple of tool
parameters — **no** crawler registry, per-crawler state table, lock, or
`isCrawler` agent type. Those remain the Phase 2 design in the companion doc.

## Summary

The facts table already carries a single `last_crawled_at` column, and
`facts_read_uncrawled` already filters the queue by a literal key prefix. That is
enough to support **N crawlers over disjoint key prefixes**: because each fact
lives under exactly one crawler's prefix, no two crawlers ever touch the same
row, so the single shared column never contends.

This phase makes that usable by:

1. **Renaming the read filter `namespace` → `keyPrefix`** for symmetry with the
   write side (it already matches on `facts.key`). Crawler agents are free to use
   their graph namespace string as the key prefix.
2. **Adding explicit-key and prefix selections to the crawl-flag writer**:
  `facts_set_crawled` can flip the crawled flag for an explicit batch of up to
  **500 scope-key receipts** (each with an optional `etag`), or for a whole key
  prefix, in one call.
3. **Adding a `crawled` boolean**: `crawled: false` clears the flag, which is the
   documented way to **trigger a recrawl** of a key batch or a whole prefix.

## Goal / Non-Goals

- **Goal:** multiple crawlers, each owning a **disjoint** key prefix, crawling
  independently over the same facts store. Crawlers are not graph-only; a graph
  crawler is one consumer, but the same crawl flag can drive exports, summaries,
  or other projections.
- **Non-goal:** two crawlers over the **same / overlapping** keys. A single
  `last_crawled_at` column cannot track two independent progress cursors; that
  needs the per-crawler `(crawler_id, fact_id)` state table in
  [multi-agent-crawlers.md](./multi-agent-crawlers.md). Disjointness here is an
  operator/app **convention**, not enforced by the store.
- **Non-goal:** enforcing ownership. These remain privileged crawler tools. A
  misconfigured or misbehaving crawler can mark/requeue keys outside its intended
  prefix; Phase 1 relies on crawler prompt/config discipline, just like the
  current privileged harvester queue.
- **Non-goal:** changing orchestration. This phase is stored procedures, provider
  methods, and tools only. It does not add activities or yields, so it does not
  require a duroxide orchestration version freeze.

## Background (current shapes)

- `facts.last_crawled_at TIMESTAMPTZ` — `NULL` ⇒ pending crawl. The `facts_touch`
  trigger resets it to `NULL` (and bumps `etag`) on key/value or `deleted_at`
  change.
- `facts_read_uncrawled(p_ns_prefix, p_limit[, p_embedded_only])` — returns
  `last_crawled_at IS NULL` rows, filtered by key prefix. Today the base store
  uses `starts_with`, while Horizon uses raw `LIKE` via `namespacePrefix()`; this
  proposal replaces both with escaped-prefix `LIKE` plus a prefix index.
- `facts_mark_crawled(p_stamps JSONB)` — current legacy precise per-fact receipt
  mark with an optimistic `etag` compare-and-set plus a `last_crawled_at IS NULL`
  queue-membership guard. This proposal replaces it at the public provider/tool
  layer with `setFactsCrawled` / `facts_set_crawled`.
- Tools `facts_read_uncrawled` / `facts_mark_crawled` are currently defined in
  [graph-tools.ts](../../../packages/sdk/src/graph-tools.ts#L375-L416), gated to
  the harvester role (`canHarvest`). This proposal replaces the write tool with
  `facts_set_crawled`.

## Design

### 1. Read: rename `namespace` → `keyPrefix`, standardize literal prefix matching

The read filter already operates on `facts.key`; only the parameter name changes,
for symmetry with the write side. Both stores standardize on **literal prefix**
matching. The SQL implementation uses escaped `LIKE ... ESCAPE '\'` so `%`, `_`,
and `\` in keys are matched literally while PostgreSQL can still use a prefix
index. HorizonDB's current raw `LIKE` + `namespacePrefix()` `%` append is replaced
with the same escaped-prefix helper used by the base store.

Base / stock PG facts store:

```sql
CREATE OR REPLACE FUNCTION facts_like_prefix(p_prefix TEXT) RETURNS TEXT
LANGUAGE sql IMMUTABLE STRICT AS $$
  SELECT replace(replace(replace(p_prefix, E'\\', E'\\\\'), '%', E'\\%'), '_', E'\\_') || '%';
$$;
```

```sql
CREATE OR REPLACE FUNCTION facts_read_uncrawled(
  p_key_prefix TEXT,
  p_limit      INT
) RETURNS SETOF facts
LANGUAGE sql STABLE AS $$
    SELECT f.* FROM facts f
    WHERE f.last_crawled_at IS NULL
      AND (p_key_prefix IS NULL OR f.key LIKE facts_like_prefix(p_key_prefix) ESCAPE E'\\')
  ORDER BY f.key, f.id
  LIMIT p_limit;
$$;
```

Enhanced / Horizon facts store adds the optional embedding gate:

```sql
CREATE OR REPLACE FUNCTION facts_read_uncrawled(
  p_key_prefix    TEXT,
  p_limit         INT,
  p_embedded_only BOOLEAN DEFAULT FALSE
) RETURNS SETOF facts
LANGUAGE sql STABLE AS $$
  SELECT f.* FROM facts f
  WHERE f.last_crawled_at IS NULL
    AND (p_key_prefix IS NULL OR f.key LIKE facts_like_prefix(p_key_prefix) ESCAPE E'\\')
      AND (f.deleted_at IS NOT NULL OR NOT p_embedded_only OR f.embedding IS NOT NULL)
    ORDER BY f.key, f.id
    LIMIT p_limit;
$$;
```

The crawler surface works on stock PG, including when a stock PG fact store is
combined with a graph store. `embeddedOnly` is not part of the base crawler
contract; it is an enhanced-store option for Horizon-style facts that have an
embedding column and semantic tools. Base PG callers use `keyPrefix + limit`.

Both stores add a queue-prefix index:

```sql
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_facts_uncrawled_key
  ON facts (key text_pattern_ops, id)
  WHERE last_crawled_at IS NULL;
```

The escaped `LIKE` form preserves literal-prefix semantics while allowing
PostgreSQL to plan an index range scan. Ordering by `(key, id)` aligns with the
index and lets `LIMIT` stop early inside each crawler's keyspace. Prefix
`crawled:false` updates scan the crawled side (`last_crawled_at IS NOT NULL`) and
may be slower; that path is intended for explicit recrawl/admin use, not the hot
read loop.

Operational notes:

- Build the new prefix queue index concurrently on existing large deployments
  where the migration runner supports non-transactional index creation; otherwise
  plan an equivalent operational pre-step before the rollout.
- Marking rows crawled moves them out of the partial `last_crawled_at IS NULL`
  index, so large writes are real index-maintenance work. Broad prefix writes
  should be used deliberately; very large recrawls can be paged by keyspace or by
  explicit `scopeKeys` batches.

Crawler agents often store source facts under the same string they use as a graph
namespace (e.g. facts under `corpus/northwind/…` and graph namespace
`corpus/northwind`), so a graph crawler can pass its graph namespace as the
`keyPrefix`. Non-graph crawlers can use any key-prefix convention they own.

### 2. Mark: selection × flag

`facts_set_crawled` becomes "set the crawled flag on a selection":

| selection | `crawled: true` | `crawled: false` |
|---|---|---|
| `scopeKeys: [{ scopeKey, etag? }]` (≤ 500) | mark listed keys crawled; rows with `etag` are conditional, rows without `etag` stomp | mark listed keys uncrawled; rows with `etag` are conditional, rows without `etag` stomp |
| `keyPrefix: "corpus/a/"` | coarse prefix flush, **no etag**, skips tombstones | recrawl under prefix (incl. tombstones) |

- **`scopeKeys` is the explicit-key path.** After a crawler processes rows returned
  by `facts_read_uncrawled`, it passes those rows as `{ scopeKey, etag }` entries
  to mark the exact versions crawled. For ad hoc/admin updates, the caller may
  omit `etag`; a missing `etag` intentionally **stomps** the listed key's crawl
  flag regardless of source version. `crawled:false` is allowed on the same batch
  shape and clears `last_crawled_at` to put the listed facts back on the radar.
- **`keyPrefix` is the coarse wildcard path.** It flips a whole literal prefix at
  once and has no per-row etag, so it is intentionally coarser than `scopeKeys`.
- These selections are intentionally unscoped beyond the caller-provided
  keys/prefix; crawler tools are privileged and can stomp any fact they name.

### 3. New proc: `facts_set_crawled_by_prefix`

```sql
CREATE OR REPLACE FUNCTION facts_set_crawled_by_prefix(
    p_key_prefix TEXT,
    p_crawled    BOOLEAN
) RETURNS TABLE (affected INT, skipped INT)
LANGUAGE sql AS $$
    WITH matched AS (
        SELECT f.id
        FROM facts f
        WHERE p_key_prefix IS NOT NULL
          AND f.key LIKE facts_like_prefix(p_key_prefix) ESCAPE E'\\'
          AND (NOT p_crawled OR f.deleted_at IS NULL)
    ), upd AS (
        UPDATE facts f
           SET last_crawled_at = CASE WHEN p_crawled THEN now() ELSE NULL END
          FROM matched m
         WHERE f.id = m.id
           AND ( (p_crawled     AND f.last_crawled_at IS NULL)        -- queued  → crawled
              OR (NOT p_crawled AND f.last_crawled_at IS NOT NULL) )  -- crawled → requeued
        RETURNING f.id
    )
    SELECT (SELECT count(*) FROM upd)::int AS affected,
           ((SELECT count(*) FROM matched) - (SELECT count(*) FROM upd))::int AS skipped;
$$;
```

### 3b. New proc: `facts_set_crawled_by_keys`

The explicit-batch sibling. Takes up to 500 entries of `{ scopeKey, etag? }`. The
cap and duplicate-key checks are enforced in the provider/tool layer, and the
proc should reject invalid direct SQL calls too.

Each entry is independent:

- with `etag` ⇒ conditional write (`facts.etag` must match)
- without `etag` ⇒ unconditional stomp of that key's crawl flag

This supports the old single-row stamped path, the single-scope-key path, and
batch recrawl through one API.

```sql
CREATE OR REPLACE FUNCTION facts_set_crawled_by_keys(
    p_keys    JSONB,
    p_crawled BOOLEAN
) RETURNS TABLE (affected INT, skipped INT)
LANGUAGE plpgsql AS $$
BEGIN
  IF jsonb_typeof(p_keys) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'facts_set_crawled_by_keys requires a JSON array';
  END IF;

  IF jsonb_array_length(p_keys) = 0 OR jsonb_array_length(p_keys) > 500 THEN
    RAISE EXCEPTION 'facts_set_crawled_by_keys requires 1..500 entries';
  END IF;

  IF EXISTS (
    WITH input AS (
      SELECT e->>'scopeKey' AS scope_key,
             e ? 'etag' AS has_etag,
             CASE WHEN e ? 'etag' AND (e->>'etag') ~ '^[0-9]+$' THEN (e->>'etag')::BIGINT ELSE NULL END AS etag
      FROM jsonb_array_elements(p_keys) e
    )
    SELECT 1 FROM input
    WHERE scope_key IS NULL OR scope_key = '' OR (has_etag AND etag IS NULL)
  ) OR EXISTS (
    WITH input AS (
      SELECT e->>'scopeKey' AS scope_key
      FROM jsonb_array_elements(p_keys) e
    )
    SELECT 1 FROM input GROUP BY scope_key HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'facts_set_crawled_by_keys entries require unique scopeKey values and optional numeric etags';
  END IF;

  RETURN QUERY
  WITH input AS (
    SELECT e->>'scopeKey' AS scope_key,
         e ? 'etag' AS has_etag,
         CASE WHEN e ? 'etag' AND (e->>'etag') ~ '^[0-9]+$' THEN (e->>'etag')::BIGINT ELSE NULL END AS etag
    FROM jsonb_array_elements(p_keys) e
  ), matched AS (
    SELECT f.id, f.scope_key, f.etag, i.has_etag, i.etag AS input_etag
    FROM facts f
    JOIN input i ON i.scope_key = f.scope_key
  ), upd AS (
        UPDATE facts f
           SET last_crawled_at = CASE WHEN p_crawled THEN now() ELSE NULL END
      FROM matched m
     WHERE f.id = m.id
       AND (NOT m.has_etag OR f.etag = m.input_etag)
       AND ( (p_crawled     AND f.last_crawled_at IS NULL)
          OR (NOT p_crawled AND f.last_crawled_at IS NOT NULL) )
    RETURNING f.scope_key
    )
  SELECT (SELECT count(*) FROM upd)::int AS affected,
         ((SELECT count(*) FROM matched) - (SELECT count(*) FROM upd))::int AS skipped;
END;
$$;
```

The SQL sketch is illustrative; implementation can factor the repeated `input`
CTE differently. The public provider/tool surface should call
`facts_set_crawled_by_keys` / `facts_set_crawled_by_prefix` directly; no separate
`markFactsCrawled` provider method or `facts_mark_crawled` tool is needed.

### 4. Tombstone handling

- **`scopeKeys` may mark tombstones.** With `etag`, this is the safe delete
  reconciliation path: `graph_remove_evidence` + `facts_set_crawled(scopeKeys:
  [{ scopeKey, etag }])`. Without `etag`, it is an explicit stomp and may mark a
  tombstone reconciled without proving the crawler saw the current delete version;
  this is allowed because crawler tools are privileged.
- **`keyPrefix` `crawled:true` skips tombstones** (`deleted_at IS NOT NULL`). A
  blind prefix flush must not turn an arbitrary set of unreconciled deletes into
  purgeable rows.
- **`crawled:false` includes tombstones** for both `scopeKeys` and `keyPrefix` —
  re-surfacing a soft-deleted fact for delete reconciliation is safe and sometimes
  desirable.

For both procs, `skipped` means "an existing fact matched the selector but did not
change to the requested crawl state." For `scopeKeys`, an etag mismatch or already
target-state row is skipped; a non-existent scope key is neither affected nor
skipped. For `keyPrefix`, already-target-state rows are skipped; on
`crawled:true`, tombstones are not part of the matched set because the prefix
writer deliberately does not reconcile deletes.

### 5. Etag safety / coarseness

- **`scopeKeys` entries with `etag`** keep the `facts.etag = input.etag` CAS, so a
  fact edited between read and mark is **not** falsely marked crawled or uncrawled
  (the entry skips; the caller can re-read).
- **`scopeKeys` entries without `etag`** and all **`keyPrefix` writes** are
  explicit stomps. A read→edit→bulk-mark window can lose an update: the edited row
  gets marked crawled even though its new content was not processed. This is
  **documented privileged behavior**; use etag-bearing `scopeKeys` for the normal
  receipt mark loop. A later edit re-queues the row via the trigger.

### 6. Guardrails: batch cap & no accidental match-all

- **`scopeKeys` and reads are capped at 500.** The provider/tool layer rejects a
  scope-key batch of more than 500 entries (the proc also defends with
  `jsonb_array_length`) and caps `facts_read_uncrawled.limit` at 500; crawlers page
  through larger sets.
- **No empty / match-all selection.** `p_key_prefix IS NULL` is a no-op, and an
  **empty string** `keyPrefix` (which would match everything) is
  rejected, as is an empty `scopeKeys` array or a blank `scopeKey` entry — so the
  LLM cannot flush or requeue the entire store by accident. A crawler that
  genuinely owns all keys passes its real owning prefix.

## Tool Surface (LLM-facing)

```jsonc
facts_read_uncrawled({
  keyPrefix?: string,    // literal key prefix; a crawler may pass its graph namespace
  limit?: number         // default 20, capped at 500
})

// enhanced/Horizon stores may also accept embeddedOnly in the same args
facts_read_uncrawled({ keyPrefix?: string, limit?: number, embeddedOnly?: boolean })

facts_set_crawled({
  scopeKeys?: [{ scopeKey: string, etag?: number }],  // explicit batch, max 500; etag optional per key
  keyPrefix?: string,                                  // wildcard selection
  crawled?:   boolean                                  // default true; false = recrawl
})
```

- Exactly one of `scopeKeys` / `keyPrefix` is required.
- `scopeKeys` is capped at **500**; a larger array is rejected. Each entry is
  `{ scopeKey, etag? }`; `etag` makes that entry conditional, omission stomps.
- `crawled` defaults to `true` for both selections. `crawled:false` requeues the
  selected rows.
- `namespace` is accepted as a **deprecated alias** for `keyPrefix` on
  `facts_read_uncrawled` for one release so existing harvester prompts/tests keep
  working.

**Tool description deltas:**

- `facts_read_uncrawled`: "`keyPrefix` — restrict the queue to a literal key
  prefix (a crawler may reuse its graph namespace as this prefix)."
- `facts_set_crawled`: "Pass `scopeKeys` entries after processing rows from
  `facts_read_uncrawled`; include each row's `etag` to make that entry conditional,
  or omit `etag` to force/stomp. Pass `keyPrefix` to flip a whole prefix at once.
  Set `crawled:false` on `scopeKeys` or `keyPrefix` to put facts **back on the
  radar for recrawl** (e.g. after changing extraction logic)."

## Provider API

```ts
// base contract; namespace kept as deprecated alias
readUncrawledFacts(opts: { keyPrefix?: string; namespace?: string; limit?: number })
  : Promise<{ count: number; facts: FactRecord[] }>;

// enhanced/Horizon extension
readUncrawledFacts(opts: { keyPrefix?: string; namespace?: string; limit?: number; embeddedOnly?: boolean })
  : Promise<{ count: number; facts: FactRecord[] }>;

setFactsCrawled(input: {
  scopeKeys?: Array<{ scopeKey: string; etag?: number }>;
  keyPrefix?: string;
  crawled?: boolean;
}): Promise<{ affected: number; skipped: number }>;          // scopeKeys ≤ 500 (throws if exceeded)
```

Both the base `FactStore` (PG) and `HorizonDBFactStore` implement these for
drop-in parity.

## Files To Touch

- `packages/horizon-store/migrations/NNNN_prefix_crawl_flag.sql` (+ companion diff
  note) — rename read param to `p_key_prefix`, replace raw `LIKE` / `starts_with`
  with escaped-prefix `LIKE`, add `facts_like_prefix`, add the queue-prefix index,
  and add `facts_set_crawled_by_prefix` / `facts_set_crawled_by_keys`.
- `packages/sdk/src/facts-migrations.ts` (new migration) +
  `packages/sdk/src/migrations/NNNN_diff.md`.
- `packages/sdk/src/facts-store.ts` + `packages/horizon-store/src/horizon-store.ts`
  — provider methods, drop `namespacePrefix()` `%` append, `keyPrefix` rename +
  alias, empty-prefix guard, single `setFactsCrawled` write method.
- `packages/sdk/src/graph-tools.ts` — replace `facts_mark_crawled` with
  `facts_set_crawled`; update params/descriptions (`keyPrefix`, `crawled`,
  `namespace` alias).
- `examples/horizon-harvester/plugin/agents/source-harvester.agent.md` — use
  `keyPrefix`; document recrawl via `crawled:false`; bump agent `version`.
- `packages/horizon-store/docs/harvester-and-eval.md`,
  `docs/harvester-deployment.md`, and the builder skill
  `templates/builder-agents/skills/pilotswarm-knowledge-harvester/SKILL.md` — keep
  the taught pattern in sync.

## Relationship to Phase 2

This phase is forward-compatible with the per-crawler design: the tool shape
(`scopeKeys` vs `keyPrefix`, plus optional per-key `etag` and the `crawled` boolean) is unchanged
when `last_crawled_at` is later generalized into `fact_crawl_state(crawler_id,
fact_id, …)`. Phase 2 adds **overlap support + enforced ownership**; Phase 1 ships
the disjoint-keyspace common case now.

---

# Test Plan

Tests live alongside the existing crawl tests
(`packages/horizon-store/test/integration/crawl-tracking.test.mjs`,
`migrations.test.mjs`) and the SDK facts suite. Every case runs against **both**
stores (base PG + HorizonDB) for parity.

## A. Read — `keyPrefix` filtering

- **A1 literal prefix:** facts under `a/b/` and `a/c/`; `read(keyPrefix="a/b/")`
  returns only the `a/b/` rows.
- **A2 null prefix:** `read(keyPrefix=null)` returns all uncrawled rows.
- **A3 literal `%`/`_`:** a key `a%b/1` with `read(keyPrefix="a%b/")` matches it;
  a key `axb/1` does **not** match (proves escaped literal prefix matching, not
  raw `LIKE` wildcards).
- **A4 stock PG has no embedding gate:** on the base PG store,
  `read(keyPrefix="a/b/")` works without any embedding column or `embeddedOnly`
  contract.
- **A4h enhanced embeddedOnly gate:** on Horizon/enhanced facts, with
  `embeddedOnly=true`, a live row with `embedding IS NULL` is excluded; once
  embedded it appears; a **tombstone** appears regardless of embedding.
- **A5 tombstone surfaces:** soft-deleted row (`deleted_at` set,
  `last_crawled_at NULL`) is returned by `read`.
- **A6 namespace alias:** `read(namespace="a/b/")` behaves identically to
  `read(keyPrefix="a/b/")` (deprecation shim).

## B. Set Crawled — scopeKeys with etags (precise conditional behavior)

- **B1 happy path:** `setCrawled(scopeKeys=[{scopeKey, etag}])` for a queued row with
  matching etag ⇒ `affected=1`, row now `last_crawled_at` set.
- **B2 stale etag:** edit the fact after reading (etag bumps); the old entry ⇒
  `skipped=1`, row stays queued.
- **B3 already crawled:** re-marking a crawled row ⇒ `skipped` (membership guard).
- **B4 mixed batch:** counts split correctly across affected/skipped.
- **B5 single-key case:** one `scopeKeys` entry works as the single-scope-key API.
- **B6 conditional recrawl:** `setCrawled(scopeKeys=[{scopeKey, etag}], crawled=false)`
  requeues only if the etag still matches; stale etag skips.
- **B7 missing scopeKey:** a listed non-existent scope key is neither affected nor
  skipped.
- **B8 receipt survives recrawl:** after `setCrawled(scopeKeys=[{scopeKey}],
  crawled=false)`, the fact's `etag` is unchanged, so a later conditional
  `setCrawled(scopeKeys=[{scopeKey, etag: old}], crawled=true)` still matches.

## C. Set Crawled — coarse flush, `crawled:true` (prefix & scopeKeys)

- **C1 prefix flush:** three queued rows under `a/b/`; `setCrawled(keyPrefix="a/b/",
  crawled=true)` ⇒ `affected=3`, all set; rows under `a/c/` untouched.
- **C2 only queued:** a row under `a/b/` already crawled is not re-touched
  (`affected` counts only `last_crawled_at IS NULL` rows).
- **C3 prefix skips tombstones:** a tombstone under `a/b/` is **not** marked
  crawled by the prefix flush (stays queued).
- **C4 literal prefix:** `%`/`_` matched literally (mirror of A3).
- **C5 disjoint isolation:** flush under `a/` leaves every `b/` row's
  `last_crawled_at` unchanged.
- **C6 scopeKeys stomp flush:** `setCrawled(scopeKeys=[{scopeKey: k1}, {scopeKey: k2}],
  crawled=true)` ⇒ `affected=2` for the two listed rows; an unlisted queued row is
  untouched.
- **C7 scopeKeys can stomp tombstones:** a tombstone whose scopeKey is in the batch
  is marked crawled when listed without etag (privileged stomp behavior).
- **C8 scopeKeys conditional tombstone:** the same tombstone with matching etag is
  marked crawled; stale etag skips.

## D. Set Crawled — `crawled:false` (recrawl)

- **D1 prefix recrawl:** crawled rows under `a/b/`; `setCrawled(keyPrefix="a/b/",
  crawled=false)` ⇒ they return to `last_crawled_at NULL` and reappear in
  `read`.
- **D2 includes tombstones:** a reconciled (crawled) tombstone under `a/b/` is
  re-surfaced by `crawled:false`.
- **D3 scopeKeys stomp recrawl:** `setCrawled(scopeKeys=[{scopeKey: k1}, {scopeKey: k2}],
  crawled=false)` requeues those two facts without requiring etags; unlisted rows
  untouched.
- **D4 idempotent:** running D1 twice ⇒ second call `affected=0` and `skipped`
  equals the already-uncrawled matched rows; no error.
- **D5 disjoint isolation:** recrawl under `a/` does not requeue any `b/` row.
- **D6 scopeKeys recrawl includes tombstones:** a crawled tombstone whose scopeKey
  is listed is re-surfaced, with or without etag depending on whether the caller
  wants a conditional or stomp recrawl.

## E. Guardrails / validation

- **E1 empty prefix rejected:** tool/provider call with `keyPrefix=""` throws a
  clear validation error (no whole-store flush/requeue).
- **E2 exactly-one selection:** `scopeKeys` and `keyPrefix` together ⇒ validation
  error; neither ⇒ validation error.
- **E3 null prefix proc no-op:** `facts_set_crawled_by_prefix(NULL, …)` ⇒
  `affected=0`, `skipped=0`.
- **E4 scopeKeys cap:** a batch of 501 entries ⇒ validation error; exactly 500 is
  accepted.
- **E5 empty scopeKeys rejected:** `setCrawled(scopeKeys=[])` ⇒ validation error.
- **E6 invalid etags rejected:** non-numeric / non-positive etags in `scopeKeys`
  entries are validation errors.
- **E7 duplicate scopeKeys rejected:** duplicate `scopeKey` entries in one batch are
  rejected so affected/skipped counts stay unambiguous.

## F. Trigger interaction

- **F1 content change re-queues after bulk flush:** flush `a/b/` crawled, then
  edit a row's value ⇒ trigger resets `last_crawled_at NULL` and bumps `etag` ⇒
  row reappears in `read`.
- **F2 identical write keeps crawl flag:** writing identical content to a crawled row
  does **not** requeue it.
- **F3 delete re-queues:** soft-deleting a crawled fact bumps `etag`, resets
  `last_crawled_at NULL`, and the tombstone surfaces in `read`.
- **F4 set-crawled does not bump etag:** `setCrawled(..., crawled=true)` and
  `setCrawled(..., crawled=false)` do not change `etag`.
- **F5 enhanced set-crawled does not reset embedding:** on Horizon/enhanced facts,
  toggling `last_crawled_at` does not clear `embedding`, `embedded_at`, or
  `embedding_model`.
- **F6 set-crawled vs embedder independence:** on Horizon/enhanced facts, setting a
  not-yet-embedded fact crawled does not block or disturb the embedder; embedding
  is driven by `embedding IS NULL`, not `last_crawled_at`.

## G. Multi-crawler scenario (integration)

- **G1 disjoint queues:** crawler A reads/sets crawled for `corpus/a/`, crawler B
  reads/sets crawled for `corpus/b/`; A's writes never drain B's queue and vice
  versa.
- **G2 independent recrawl:** A issues `setCrawled(keyPrefix="corpus/a/",
  crawled=false)`; only A's keyspace re-surfaces, B unaffected.
- **G3h embedder independence (Horizon/enhanced only):** the embedder loop never
  changes `last_crawled_at`, and crawl ops never change `embedding` — verify a
  flush / recrawl leaves embedding columns intact and vice versa.

## H. Coarseness (documented behavior, asserted intentionally)

- **H1 conditional scopeKeys is race-safe:** read a fact, edit it, then `setCrawled(scopeKeys=[{scopeKey, etag: old}],
  crawled=true)` ⇒ `skipped`; row stays queued (same as B2).
- **H2 prefix flush is coarse:** read a fact under `a/b/`, edit it, then
  `setCrawled(keyPrefix="a/b/", crawled=true)` ⇒ the edited row **is** marked crawled
  (lost-update window). Assert this so the coarse semantics are intentional, not a
  silent regression; a subsequent edit re-queues it (F1).
- **H3 concurrent conditional writes:** two conditional `setCrawled(scopeKeys=[{scopeKey,
  etag}], crawled=true)` calls racing the same queued fact produce one `affected`
  and one `skipped`.
- **H4 stomp bypasses race safety by design:** after an edit bumps etag, a
  `scopeKeys` entry without etag still flips the crawl flag.

## I. Parity

- **I1** every non-enhanced case is asserted identically against the base PG
  `FactStore` and the HorizonDB store, since both implement the same core procs
  and provider methods.
- **I2** enhanced-only cases (`A4h`, `G3h`) run only against the Horizon/enhanced
  store. Stock PG crawler behavior is covered by `A4`.

## J. Performance / query plans

- **J1 prefixed read uses prefix index:** on a seeded table large enough to avoid
  trivial plans, `read(keyPrefix="a/b/")` plans as an index scan/range scan over
  `idx_facts_uncrawled_key`, not a sequential scan.
- **J2 wildcard escaping still uses index:** keys containing literal `%`, `_`, and
  `\` match only their literal prefixes and still use the prefix index.
- **J3 read/write cap round-trip:** `read(limit=500)` followed by
  `setCrawled(scopeKeys=<500 receipts>)` succeeds in one call; `read(limit=501)` is
  capped/rejected per provider contract and `setCrawled` with 501 entries is
  rejected.
- **J4 broad prefix recrawl is documented admin work:** test a large
  `setCrawled(keyPrefix="a/", crawled=false)` for correctness; do not require an
  index-only plan for this path because it intentionally scans crawled rows.
