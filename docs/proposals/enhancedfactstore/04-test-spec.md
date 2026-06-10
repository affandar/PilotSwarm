# EnhancedFactStore — Test Specification

> Status: Proposal · Companion: [01-functional-spec.md](./01-functional-spec.md) ·
> [02-api-reference.md](./02-api-reference.md) · [03-design.md](./03-design.md)

## 0. Philosophy

These tests **do not trust the HorizonDB provider's implementation**. They assert
externally observable behaviour against **predictable datasets with known
outcomes**, and they include **negative cases** for every interface. They double
as a conformance test of HorizonDB itself: pgvector cosine ordering, AGE Cypher
correctness, and the pg_durable lifecycle.

**No mocks — real surface only.** Every test runs against live databases and
live services: the real HorizonDB, a real plain PostgreSQL for fail-fast
negatives, the real embedding endpoint (reachable from the database —
`df.http` executes in-DB), and real Copilot-SDK agents for the scenario tier
(no PilotSwarm runtime). No stubbed endpoints, no simulated capability
snapshots, no marker-fact shims. The only deterministic seams are *data*:
hand-seeded vectors in the real `embedding` column (real pgvector still
executes every query) and recorded real-tool-call replay where byte-identical
reproducibility is required. A run with skipped suites is **incomplete**, not
passing. Execution mechanics live in
[06-provider-test-plan.md](./06-provider-test-plan.md).

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

### 1.4 Live-endpoint dataset (required for full validation)

A group requiring `HORIZON_EMBED_URL` for the **real** embedder loop: a small
set of plain-text facts embedded by the actual endpoint at the real dimension.
Outcome-only assertions (presence, dim, convergence, robust relative ordering
of clearly-related vs clearly-unrelated pairs — real embeddings do not permit
exact-order assertions; those come from the seeded `FX` corpus). This group
SKIPs without the env var, but a full-validation pass requires it to have run
(§0).

## 2. EnhancedFactStore — functional matrix

### 2.1 Base FactStore (regression)

| # | Case | Expectation |
|---|------|-------------|
| B1 | store + read shared fact | round-trips; `shared:` scope_key |
| B2 | store + read session fact | requires sessionId; `session:<id>:` scope_key |
| B3 | delete fact | `deleted: true`; gone on re-read |
| B4 | deleteSessionFactsForSession | removes only that session's non-shared facts |
| B5 | stats buckets (session/shared/multi-session) | correct namespace bucketing & byte counts |
| B6 | `readFacts({ scopeKeys })` bulk read | returns exactly the accessible subset of the requested keys; records expose `scopeKey` |
| B7 | **(neg)** `scopeKeys` containing inaccessible/unknown keys | silently omitted, not an error |

### 2.1a Crawl tracking (`last_crawled_at`)

| # | Case | Expectation |
|---|------|-------------|
| C1 | new fact is uncrawled | `readUncrawledFacts` includes it (`last_crawled_at IS NULL`); each row carries `contentHash` |
| C2 | `markFactsCrawled(stamps)` with matching hashes | `marked` count; facts drop out of `readUncrawledFacts` |
| C3 | `storeFact` replace resets crawl | re-storing a crawled fact resets `last_crawled_at` |
| C4 | `storeFact` no-op write does not reset | writing identical content leaves crawl stamp unchanged |
| C5 | `readUncrawledFacts` is privileged + bounded | spans ALL scopes (shared + every session, no access ctx); bounded by `limit`; `namespace` prefix filter applies |
| C6 | independent of embedding state | crawl reset does not clear an existing embedding (separate columns) |
| C7 | **(race)** edit between read and mark | fact edited after `readUncrawledFacts` → `markFactsCrawled` with the stale `contentHash` is **skipped** (`skipped: 1`); fact stays uncrawled and re-enters the queue |

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
| S5 | model-mismatched rows excluded | a row whose `embedding_model` ≠ configured model never appears in semantic results (treated as NULL embedding) |

### 2.4 `similarFacts` (semantic kNN of a known fact)

| # | Case | Expectation |
|---|------|-------------|
| SF1 | `similarFacts("shared:skills/jsonb")` | F2 first; anchor excluded from results |
| SF2 | `k` bound | returns ≤ k |
| SF3 | `minScore` | filters by cosine |
| SF4 | **(neg)** unknown scope_key | empty result |
| SF5 | **(neg/acl)** anchor exists but is another session's fact | empty result, byte-identical to SF4 (no existence/similarity oracle) |

### 2.5 Graph retrieval via seeds

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
| A5 | **ACL precedes ranking** — seed > `candidatePool` inaccessible rows that outrank the caller's only accessible match | the accessible match is still returned (ACL predicate is inside the proc's WHERE, before rank/LIMIT — not a post-filter) |

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
| GR4 | re-upsert with new evidence only | evidence **unioned** (absorbs old linkEvidence); observations++ (novel evidence) |
| GR5 | **(neg)** edge to missing endpoint node | throws |
| GR6 | predicate_key normalization | "revives argument from" ↔ stable predicate_key |
| GR7 | **(dedup)** re-upsert with only already-known evidence | idempotent no-op: `observations` and `confidence` unchanged (duplicate harvest cannot inflate confidence) |
| GR8 | evidence-less re-upsert | still reinforces (observations++, noisy-OR) — dedup applies only to evidence-carrying assertions |

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
| GQ13 | **(acl)** evidence filter — node evidenced by shared + S1 + S2 facts, reader = S1 | hit's `evidence` contains the shared + S1 keys only; S2's key absent |
| GQ14 | **(acl)** traversal through inaccessible evidence | two S1-accessible facts connected only via a node/edge evidenced by an S2 fact are still reached from each other's seeds — connectivity preserved, S2 key never disclosed |
| GQ15 | **(acl)** inaccessible seed ignored | seeding with another session's fact scopeKey behaves exactly like GQ12 (unknown seed) — no probe oracle |
| GQ16 | **(acl)** harvester reads unrestricted | same query with `unrestricted` returns the full, unfiltered `evidence` arrays |

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

## 3a. Phase 2 — compound context reads (depends on `EVIDENCED_BY`)

These exercise `searchGraphContext` / `similarGraphContext`. They require a
harvested fixture (`GX` nodes/edges linked to `FX` facts via `EVIDENCED_BY`).
The degenerate cases run against an **unharvested** corpus (facts only, empty
graph) to prove graceful fallback.

### 3a.1 `searchGraphContext`

| # | Case | Expectation |
|---|------|-------------|
| CX1 | query matches seed facts, graph harvested | `seeds` non-empty; `nodes`/`edges` reached via `EVIDENCED_BY`; `facts` map covers every referenced scopeKey |
| CX2 | bundle is **exactly** self-resolving | every `node.evidence` / `edge.evidence` / seed key is present as a key in `facts` — holds even when nodes also carry inaccessible evidence, because graph reads ACL-filter `evidence` (GQ13) |
| CX3 | `breadth`/`depth` bounding | higher breadth reaches more nodes; `depth` clamped to 1..3 |
| CX4 | **degenerate** — unharvested graph | `nodes`/`edges` empty; `facts` equals the seed set |
| CX5 | **(acl)** unreachable fact evidenced by a reachable node | excluded from `facts` (ACL re-applied on final read) |

### 3a.2 `similarGraphContext`

| # | Case | Expectation |
|---|------|-------------|
| CS1 | anchor fact, harvested graph | cluster from `similarFacts` seeds the graph; `nodes`/`edges` returned |
| CS2 | `factLinks` derivation | two cluster facts sharing a node yield a `FactLink` with `via` node + `predicates` |
| CS3 | `factLinks` bounded | capped at `maxFactLinks`; shared-node (1-hop) links only |
| CS4 | **degenerate** — no shared nodes / unharvested | `factLinks` empty; `facts` equals the cluster |
| CS5 | read-only | neither graph nor crawl state mutated (compare before/after) |

## 4. Embedder lifecycle (pg_durable)

Outcome-based for embedding effects; explicit df-state checks for lifecycle.
**All embedder tests run against the real embedding endpoint** (`df.http`
in-database to `HORIZON_EMBED_URL`) — there is no stub tier. Lifecycle tests
seed a small pending set so the loop does real work while its state machine is
asserted.

| # | Case | Expectation |
|---|------|-------------|
| E1 | `embedderStatus()` before start | `running: false` |
| E2 | `startEmbedder()` | `running: true`; one instance id |
| E3 | **double start** | second call no-op; **same** instance id; still exactly one instance for the label |
| E4 | outcome: pending facts embedded | within a few ticks, vectors populate at the real dim; semantic search then finds them and a related pair outranks an unrelated one (robust assertion) |
| E5 | outcome: changed fact re-embedded | mutate content → poll until `embedded_at` advances and `last_embedded_hash == content_hash` of the new content |
| E6 | df-state while running | loop instance is `pending`/`running` |
| E7 | `stopEmbedder()` | `running: false`; instance `cancelled` |
| E8 | **double stop** | second call no-op; `running: false` |
| E9 | restart after stop | new running instance; embeds remaining pending |
| E10 | **(neg)** start without configured endpoint | throws (precondition) |
| E11 | `configureEmbedder` while running | loop **restarted**: `running` stays true, `instanceId` changes, exactly one instance for the label; new config in effect (vars are captured at `df.start` — pg_durable contract). Every call restarts (no config-equality check); a second configure yields another fresh instance, still exactly one for the label |
| E12 | `configureEmbedder` while stopped | vars written only; no instance started |
| E13 | mid-flight edit converges | with a large batch in flight, edit a batched fact; once edits stop, poll until `last_embedded_hash` equals the **final** content's hash and `embedded_at` postdates the last edit — the select-time-hash write-back means the loop can never settle with a stale vector marked fresh |
| E14 | model rotation re-embeds | reconfigure with a second real deployment/model → previously-embedded rows become pending and are re-embedded; `embedding_model` updated; mismatched rows absent from semantic results during the transition (S5's live twin) |

## 5. Preconditions / fail-fast

Negatives run against **real databases that genuinely lack the pieces** — no
simulated capability snapshots. `PLAIN_DATABASE_URL` points at a vanilla
PostgreSQL (no Horizon extensions); the grant negative uses a transient
low-privilege role created on the real HorizonDB.

| # | Case | Expectation |
|---|------|-------------|
| P1–P4 | `initialize()` against plain PostgreSQL | throws ONE precise, **itemized** error naming **every** missing piece — `vector`, `age`, `pg_textsearch` (BM25 — no ts_rank fallback), `pg_durable`/`df.http` — each with its fix; partial naming fails the test. Also the contract for the resolution-chain misconfiguration (enhanced store pointed at plain Postgres ⇒ loud startup failure) |
| P1a | piecewise narrowing (opportunistic) | where the plain target permits `CREATE EXTENSION vector`, install it and assert the error narrows to exactly the still-missing set (proves itemization, not a blanket message) |
| P3b | real low-privilege role on HorizonDB, extensions present but no `df` usage grant | `initialize()` as that role throws the grant-specific message (shared_preload + GRANT instructions); role created/dropped by the suite |
| P5 | all present (real HorizonDB) | initializes; migrations applied; ready |

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
  context-search.test.mjs     # §3a.1  (searchGraphContext — Phase 2)
  context-similar.test.mjs    # §3a.2  (similarGraphContext + factLinks — Phase 2)
  embedder-lifecycle.test.mjs # §4  (start/stop/double-start/double-stop/reconfigure-restart, real endpoint)
  embedder-outcomes.test.mjs  # §4  (E4/E5/E13/E14 — outcomes at the real dimension)
  preconditions.test.mjs      # §5  (needs PLAIN_DATABASE_URL for the negatives)
  migrations.test.mjs         # §6
```

Scenario tier (Copilot-SDK agents on the pgsql-hackers corpus, §9) lives under
`eval/` per [06-provider-test-plan.md §10](./06-provider-test-plan.md).

Each suite must be runnable standalone and from the package's aggregate test
script. Sequential execution is acceptable where the shared cluster's parallel
init race (`tuple concurrently updated`) would otherwise interfere.

## 8. Scenario tier (Copilot SDK, pgsql-hackers corpus)

End-to-end facts + harvester agent scenarios, defined in detail in
[06-provider-test-plan.md §10](./06-provider-test-plan.md). Agents are built
**directly on the GitHub Copilot SDK** (no PilotSwarm runtime) and drive the
real tool surface (05-tools-spec) against live HorizonDB + the real embedding
endpoint. Assertions are structural invariants (LLM output is
non-deterministic); SC2 uses recorded replay of SC1's real tool calls for its
byte-identical check.

**Corpora:** a synthetic 3-message corpus (`pgsql-hackers.json`) with
hand-planted invariants, and a **real** 60-message corpus
(`pgsql-hackers-real.json`) pulled from the public pgsql-hackers archives
("[PATCH] Generic type subscripting" — 6 participants, regenerable via
`build-pgsql-hackers-real.mjs`, ~276 messages available). Real-corpus
invariants are **derived from the corpus `metadata` block at assert time**
(participants, per-author counts, multi-message authors) — never hand-coded.

| # | Scenario | Corpus | Core invariant |
|---|----------|--------|----------------|
| SC1a | Cold harvest (exact) | synthetic | one Tom Lane node (`tgl` an alias); Andres distinct; reinforced edge `observations == 2` with evidence `{msg-1001, msg-1002}`; every edge ≥1 evidence; queue drained with hash receipts, `skipped == 0` |
| SC1b | Cold harvest (scale) | real | per `metadata`: every multi-message author = exactly one person node; each reaches a non-person node ≤2 hops; ≥1 edge reinforced from ≥2 distinct messages; every edge ≥1 corpus evidence key; all `messageCount` facts crawled, `skipped == 0` |
| SC2 | Replay immunity | real | re-queue + replay SC1b's recorded tool calls → graph snapshot byte-identical (no observation/confidence/alias/evidence drift) |
| SC3 | Edit → re-queue → incremental harvest | real | only the edited fact re-enters the queue; reinforcement no-op on known evidence; stale-hash mark skipped if edited mid-harvest |
| SC4 | Reader fact-pivot | real | reader answers "who authored the patch / who pushed back": names the earliest-message author + ≥1 other multi-message participant (both metadata-derived); all cited evidence ⊆ corpus scopeKeys |
| SC5 | Scoped publication | real + 1 synthetic private fact | private fact harvested ⇒ content visible to all (ingestion = publication) but its scopeKey absent from other sessions' `evidence` arrays; inaccessible seed behaves as unknown |
| SC6 | Context bundle *(Phase 2)* | real | `facts_context_search` exactly self-resolving; anchor the earliest message → `factLinks` connect it to ≥1 same-author message via a shared node; unharvested twin degrades to seeds |

## 9. Exit criteria

- Every interface in [02-api-reference.md](./02-api-reference.md) has at least one
  positive and one negative test.
- **No mocks anywhere**; every suite ran against the live targets — a run with
  skipped suites is incomplete, not passing (§0).
- Exact semantic ordering is asserted from seeded vectors (deterministic data
  in the real `embedding` column); the real-endpoint group additionally proves
  the pipeline end to end at the real dimension (robust assertions).
- Embedder lifecycle covers start, stop, double-start, double-stop, restart,
  reconfigure-while-running (restart with new instance id), and the
  missing-config precondition — all against the real endpoint.
- Fail-fast preconditions covered on real targets: itemized plain-Postgres
  error + HorizonDB grant negative.
- A guard test proves no inline relational/vector SQL remains in the provider.
- SC1–SC5 pass with Copilot-SDK agents; SC6 on Phase 2 landing.
