# EnhancedFactStore — Test Specification

> Status: Proposal · Companion: [01-functional-spec.md](./01-functional-spec.md) ·
> [02-api-reference.md](./02-api-reference.md) · [03-design.md](./03-design.md)

## 0. Philosophy

These tests **do not trust the HorizonDB provider's implementation**. They assert
externally observable behaviour against **predictable datasets with known
outcomes**, and they include **negative cases** for every interface. They double
as a conformance test of HorizonDB itself: pgvector cosine ordering, AGE Cypher
correctness, and the pg_durable lifecycle.

**Rules** (inherited from the repo test charter): no retries, no arbitrary
sleeps to mask races (poll on observable outcomes instead), no weakened
assertions to paper over bugs, raise failures loudly.

## 1. Test datasets (deterministic)

### 1.1 Fact corpus `FX` (semantic determinism without a live endpoint)

Semantic tests must be deterministic, so they **seed hand-authored unit vectors**
directly into `facts.embedding` (no embed call). Use a tiny dimension (e.g.
`dim = 4`) and orthogonal/near-orthogonal vectors so cosine ordering is exact.

| id | key | shared | embedding (dim 4) | notes |
|----|-----|--------|-------------------|-------|
| F1 | `skills/jsonb` | true | `[1, 0, 0, 0]` | anchor |
| F2 | `skills/jsonb-subscript` | true | `[0.97, 0.24, 0, 0]` | closest to F1 |
| F3 | `skills/vacuum` | true | `[0, 1, 0, 0]` | orthogonal to F1 |
| F4 | `skills/replication` | true | `[0, 0, 1, 0]` | far from F1 |
| F5 | `session:S1:notes/a` | false (S1) | `[0.9, 0.1, 0, 0]` | ACL-scoped |
| F6 | `session:S2:notes/b` | false (S2) | `[0.95, 0.05, 0, 0]` | ACL-scoped, other session |

Expected cosine order from F1: **F2 > F5/F6 > F3 ≈ F4**. Exact ranks are computed
from the seeded vectors, not hard-coded magic numbers.

### 1.2 Lexical corpus

Reuse `FX` keys/values; lexical queries target known tokens (`"jsonb"`,
`"vacuum"`, `"replication"`).

### 1.3 Graph fixture `GX`

```
Entities:  jsonb-subscript(skill), vacuum(skill), planner(component),
           moody(person), alastor-moody(person  ← dup of moody)
Edges:     jsonb-subscript -[supersedes]-> vacuum         (evidence: F1)
           vacuum         -[tunes]->       planner        (evidence: F3)
           planner        -[owned_by]->    moody          (no evidence)
Evidence:  jsonb-subscript EVIDENCED_BY F1 (by convention)
```

Known neighbourhoods, predicates, and a deliberate duplicate (`alastor-moody`
≡ `moody`) for the merge test.

### 1.4 Live-endpoint dataset (gated)

A separate, env-gated group (`HORIZON_EMBED_URL` present) for the **real**
embedder loop: a small set of plain-text facts embedded by the actual endpoint
at the real dimension. Outcome-only assertions.

## 2. EnhancedFactStore — functional matrix

### 2.1 Base FactStore (regression)

| # | Case | Expectation |
|---|------|-------------|
| B1 | store + read shared fact | round-trips; `shared:` scope_key |
| B2 | store + read session fact | requires sessionId; `session:<id>:` scope_key |
| B3 | delete fact | `deleted: true`; gone on re-read |
| B4 | deleteSessionFactsForSession | removes only that session's non-shared facts |
| B5 | stats buckets (session/shared/multi-session) | correct namespace bucketing & byte counts |

### 2.1a Crawl tracking (`last_crawled_at`)

| # | Case | Expectation |
|---|------|-------------|
| C1 | new fact is uncrawled | `readUncrawledFacts` includes it (`last_crawled_at IS NULL`) |
| C2 | `markFactsCrawled([keys])` | `marked` count; facts drop out of `readUncrawledFacts` |
| C3 | `storeFact` replace resets crawl | re-storing a crawled fact resets `last_crawled_at` |
| C4 | `storeFact` no-op write does not reset | writing identical content leaves crawl stamp unchanged |
| C5 | `readUncrawledFacts` limit + ACL | bounded by `limit`; ACL-scoped |
| C6 | independent of embedding state | crawl reset does not clear an existing embedding (separate columns) |

### 2.2 Lexical search

| # | Case | Expectation |
|---|------|-------------|
| L1 | `searchFacts("jsonb", lexical)` | F1, F2 returned; lexical signal > 0 |
| L2 | `searchFacts("vacuum", lexical)` | F3 returned |
| L3 | **(neg)** `searchFacts("zzzznomatch", lexical)` | empty result, `count: 0` |
| L4 | **(neg)** empty query string | rejected or empty (defined, not a crash) |

### 2.3 Semantic search (seeded vectors)

| # | Case | Expectation |
|---|------|-------------|
| S1 | `searchFacts("...", semantic)` ranked by query embedding | order F2 > {F5,F6} > {F3,F4} |
| S2 | `minSemanticScore` cutoff | excludes below-threshold facts |
| S3 | **(neg)** semantic with no embedding endpoint configured | throws (documented) |
| S4 | **(neg)** anchor fact with NULL embedding | empty, not a crash |

### 2.4 `similarFacts` (semantic kNN of a known fact)

| # | Case | Expectation |
|---|------|-------------|
| SF1 | `similarFacts("shared:skills/jsonb")` | F2 first; anchor excluded from results |
| SF2 | `k` bound | returns ≤ k |
| SF3 | `minScore` | filters by cosine |
| SF4 | **(neg)** unknown scope_key | empty result |

### 2.5 Graph retrieval via seeds (replaces `relatedFacts`)

Graph relatedness is `searchGraphNodes({ seeds })` + `readFacts`, not a facts
method. See also §3.3.

| # | Case | Expectation |
|---|------|-------------|
| RF1 | `searchGraphNodes({ seeds: [fact evidencing jsonb-subscript], depth: 2 })` | returns nodes reachable via REL; each carries EVIDENCED_BY scopeKeys |
| RF2 | `readFacts(connected scopeKeys)` | returns the graph-connected facts (vacuum, planner side) |
| RF3 | **fact-pivot** — `searchFacts(q, semantic)` seeds → `searchGraphNodes` → `readFacts` | returns a fact pure-semantic `searchFacts` alone would miss |
| RF4 | depth bound | respects depth; no nodes beyond it |
| RF5 | **(neg)** seed fact with no graph linkage | empty (by convention, not error) |

### 2.6 Hybrid fusion (facts store only)

| # | Case | Expectation |
|---|------|-------------|
| H1 | hybrid over a term present lexically + semantically | top hit carries ≥1 signal; fused order sane |
| H2 | weight override (semantic=0) | behaves like lexical-only |
| H3 | weight override (lexical=0) | behaves like semantic-only |

### 2.7 ACL scoping (cross-cutting)

| # | Case | Expectation |
|---|------|-------------|
| A1 | reader = S1 | sees shared + S1 facts; **not** S2 facts (F6 excluded) |
| A2 | grantedSessionIds = [S2] | S1 reader now sees F6 |
| A3 | unrestricted | sees all |
| A4 | **(neg)** session fact without reader context | excluded |

### 2.8 Lineage scope (base `readFacts`, no dedicated method)

Lineage is the base API's `readFacts({ scope: "descendants" })`; ranking is via
`searchFacts`. There is no `lineageFacts`.

| # | Case | Expectation |
|---|------|-------------|
| LN1 | `readFacts({ sessionId, scope: "descendants" }, { grantedSessionIds })` | returns spawn-tree facts |
| LN2 | rank lineage keys via `searchFacts` | ranked within the lineage set |
| LN3 | **(neg)** unknown session | empty |

## 3. GraphInterface — functional matrix

### 3.1 upsertGraphNode

| # | Case | Expectation |
|---|------|-------------|
| GE1 | new node | `created: true`; canonical node_key |
| GE2 | upsert same name | `created: false`; aliases merged |
| GE3 | upsert with new aliases | union of aliases |
| GE4 | upsert with `evidence[]` | evidence unioned onto node (node provenance) |
| GE5 | **(neg)** empty name/kind | rejected with clear error |

### 3.2 upsertGraphEdge (evidence optional, merge semantics)

| # | Case | Expectation |
|---|------|-------------|
| GR1 | new edge **without evidence** | created (no rejection — evidence optional) |
| GR2 | new edge **with evidence** | created; evidence stored |
| GR3 | re-upsert same triple | reinforced: observations++, noisy-OR confidence |
| GR4 | re-upsert with new evidence only | evidence **unioned** (absorbs old linkEvidence) |
| GR5 | **(neg)** edge to missing endpoint node | throws |
| GR6 | predicate_key normalization | "revives argument from" ↔ stable predicate_key |

### 3.3 Query (searchGraphNodes / searchGraphEdges)

| # | Case | Expectation |
|---|------|-------------|
| GQ1 | searchGraphNodes by kind | returns matching nodes |
| GQ2 | searchGraphNodes nameLike (alias hit) | matches via alias (lexical, no embeddings) |
| GQ3 | searchGraphNodes seeds = fact scopeKeys | pivots via EVIDENCED_BY to nodes |
| GQ4 | searchGraphNodes seeds = node keys | expands directly from those nodes |
| GQ5 | searchGraphNodes returns EVIDENCED_BY scopeKeys | each hit carries evidence keys for readFacts |
| GQ6 | searchGraphEdges exact predicateKey | exact-equality match only |
| GQ7 | searchGraphEdges anchor fromKey | edges around the anchor |
| GQ8 | graphNeighbourhood depth 1 | direct neighbours + connecting edges |
| GQ9 | graphNeighbourhood depth clamp (>5 / <1) | clamped to 1..5 |
| GQ10 | **(neg)** searchGraphEdges predicate with no match | empty |
| GQ11 | **(neg)** graphNeighbourhood unknown key | empty subgraph |
| GQ12 | **(neg)** searchGraphNodes unknown seeds | empty |

### 3.4 mergeGraphNodes

| # | Case | Expectation |
|---|------|-------------|
| GM1 | merge `alastor-moody` → `moody` | aliases unioned onto survivor |
| GM2 | in/out edges repointed | survivor gains the duplicate's edges |
| GM3 | duplicate removed | `searchGraphNodes` no longer finds it |
| GM4 | **(neg)** merge into missing target | throws |

### 3.5 Deletes (no cascade)

| # | Case | Expectation |
|---|------|-------------|
| GD1 | deleteGraphEdge exact triple | `true`; edge gone |
| GD2 | deleteGraphNode | `true`; node + all incident edges gone (DETACH) |
| GD3 | **(neg)** deleteGraphEdge unknown triple | `false` |
| GD4 | **(neg)** deleteGraphNode unknown key | `false` |
| GD5 | **no cascade** — deleteFact then graph | graph provenance referencing the fact still present |

## 4. Embedder lifecycle (pg_durable)

Outcome-based for embedding effects; explicit df-state checks for lifecycle.

| # | Case | Expectation |
|---|------|-------------|
| E1 | `embedderStatus()` before start | `running: false` |
| E2 | `startEmbedder()` | `running: true`; one instance id |
| E3 | **double start** | second call no-op; **same** instance id; still exactly one instance for the label |
| E4 | outcome: pending facts embedded | within a few ticks, vectors populate at the real dim (live group) |
| E5 | outcome: changed fact re-embedded | mutate content → `embedded_at` advances |
| E6 | df-state while running | loop instance is `pending`/`running` |
| E7 | `stopEmbedder()` | `running: false`; instance `cancelled` |
| E8 | **double stop** | second call no-op; `running: false` |
| E9 | restart after stop | new running instance; embeds remaining pending |
| E10 | **(neg)** start without configured endpoint | throws (precondition) |

## 5. Preconditions / fail-fast

| # | Case | Expectation |
|---|------|-------------|
| P1 | initialize on a cluster missing `vector` | throws naming `vector` + fix |
| P2 | missing `age` | throws naming `age` |
| P3 | missing `pg_durable` / `df.http` | throws naming pg_durable + shared_preload + grant |
| P4 | all present | initializes; migrations applied; ready |

## 6. Stored-proc / migration conformance

| # | Case | Expectation |
|---|------|-------------|
| M1 | all relational+vector reads/writes call procs | no inline SQL in provider (lint/grep guard) |
| M2 | migrations idempotent | re-running `initialize()` is a no-op |
| M3 | advisory-lock concurrency | two concurrent initializers don't corrupt schema |
| M4 | numbered migration ordering | applied in order; version recorded |

### 6.1 Orchestration schema-rename conformance (PilotSwarm vs pg_durable)

Reuses the design artifact
[`scripts/verify-schema-migration.mjs`](../../../incubator/horizon-facts/scripts/verify-schema-migration.mjs)
(see [03-design.md §6.7](./03-design.md)). Safe on a live cluster (throwaway
schema names, self-cleaning). Required gate before enabling co-location.

| # | Case | Expectation |
|---|------|-------------|
| X1 | tx-atomic `ALTER SCHEMA … RENAME` | rows preserved; source name gone |
| X2 | event-trigger guard (variant a) creatable | `CREATE EVENT TRIGGER` permitted (verified on HorizonDB `hdbadmin`) |
| X3 | guard blocks retired name | recreating `duroxide` raises; blocked `CREATE` rolls back |
| X4 | guard is name-specific | other schema names still creatable |
| X5 | tombstone + `REVOKE CREATE` (variant b) | non-owner table creation denied |
| X6 | **(neg)** `duroxide` not ours | migration leaves it untouched (manual/fixture case) |

## 7. Test layout

```
incubator/horizon-facts/test/integration/
  _db.mjs                     # shared helpers, dataset builders, seeded-vector loader
  base-facts.test.mjs         # §2.1
  crawl-tracking.test.mjs     # §2.1a (last_crawled_at, readUncrawledFacts, markFactsCrawled)
  search-lexical.test.mjs     # §2.2
  search-semantic.test.mjs    # §2.3  (seeded vectors)
  similar-facts.test.mjs      # §2.4
  graph-seed-retrieval.test.mjs # §2.5  (searchGraphNodes seeds + fact-pivot)
  hybrid.test.mjs             # §2.6
  acl.test.mjs                # §2.7
  lineage.test.mjs            # §2.8  (base readFacts descendants scope)
  graph-nodes.test.mjs        # §3.1
  graph-edges.test.mjs        # §3.2
  graph-query.test.mjs        # §3.3
  graph-merge.test.mjs        # §3.4
  graph-delete.test.mjs       # §3.5
  embedder-lifecycle.test.mjs # §4  (start/stop/double-start/double-stop)
  embedder-live.test.mjs      # §4 live group (env-gated outcomes)
  preconditions.test.mjs      # §5
  migrations.test.mjs         # §6
```

Each suite must be runnable standalone and from the package's aggregate test
script. Sequential execution is acceptable where the shared cluster's parallel
init race (`tuple concurrently updated`) would otherwise interfere.

## 8. Exit criteria

- Every interface in [02-api-reference.md](./02-api-reference.md) has at least one
  positive and one negative test.
- Semantic ordering is asserted from seeded vectors (deterministic), not a live
  endpoint.
- Embedder lifecycle covers start, stop, double-start, double-stop, restart, and
  the missing-config precondition.
- Fail-fast preconditions covered for each required extension.
- A guard test proves no inline relational/vector SQL remains in the provider.
