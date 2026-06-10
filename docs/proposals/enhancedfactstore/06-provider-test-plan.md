# EnhancedFactStore — Provider Test Plan (live HorizonDB)

> Status: Proposal · Companion: [04-test-spec.md](./04-test-spec.md) (functional
> matrices — the *what*) · [05-tools-spec.md](./05-tools-spec.md) ·
> [03-design.md](./03-design.md)
>
> This document is the *how*: a methodical, unit-test-style execution plan for
> the full provider surface against a **real HorizonDB**, including the
> database-level migrations, plus the scenario tier that exercises the
> facts + harvester agent pattern on the pgsql-hackers sample corpus
> (`eval/corpus/pgsql-hackers.json`).

## 0. Ground rule — real surface only, no mocks

Every test exercises the **public provider surface against live databases**.
Concretely:

- **No stubbed endpoints.** The embedder is validated against the real
  embedding endpoint (`df.http` from inside HorizonDB to a reachable AOAI/OpenAI
  deployment). A run without the endpoint configured is an **incomplete** run,
  not a passing one.
- **No fake capability snapshots.** Fail-fast negatives run against a **real
  plain PostgreSQL** target, which genuinely lacks `vector`/`age`/
  `pg_textsearch`/`pg_durable`, and against a real low-privilege role on the
  HorizonDB for the grant negative.
- **No marker-fact shims / adapters.** Scenarios run on the real columns
  (`last_crawled_at`, `content_hash`, receipts) and the real method names; the
  eval's `_crawlmark/*` and old-API adapter are deleted.
- **No PilotSwarm runtime.** Agent scenarios drive the tool layer with the
  **GitHub Copilot SDK directly** (as the existing eval does).
- The only deterministic seams permitted — and they are *data*, not mocks:
  1. **Seeded fixture rows** (hand-authored unit vectors written into the real
     `facts.embedding` column) so ranking assertions are exact while still
     exercising real pgvector kNN/BM25/AGE paths.
  2. **Recorded tool-call replay** (re-issuing a previously captured sequence
     of real tool calls) where a scenario needs byte-identical reproducibility
     that an LLM cannot provide.

## 1. Harness & database lifecycle

- **Runner:** `node:test` `.mjs` suites under
  `incubator/horizon-facts/test/integration/` (existing convention). Suites
  SKIP (exit 0) when their env inputs are absent — but a **full-validation
  pass is defined as zero skips**; CI for this incubation must provide all
  inputs below.

  | Env | Used by | Meaning |
  |-----|---------|---------|
  | `HORIZON_DATABASE_URL` | all suites | the real HorizonDB (vector, age, pg_textsearch, pg_durable) |
  | `HORIZON_EMBED_URL` / `HORIZON_EMBED_KEY` (+model/dim) | embedder + semantic-pipeline suites | a real AOAI/OpenAI embeddings deployment **reachable from the HorizonDB** (df.http runs in-database) |
  | `PLAIN_DATABASE_URL` | preconditions suite | any real vanilla PostgreSQL (no Horizon extensions) for fail-fast negatives |
  | `GITHUB_TOKEN` (+`EVAL_MODEL`) | scenario tier | Copilot SDK agent runs |
- **Unit-test style on a live DB** means: each test creates exactly the state
  it asserts on, asserts one contract, and never depends on another test's
  leftovers. The database is real; the *isolation* is logical:
  - **One schema per run:** `hzt_<runId>` (timestamp+random, same pattern as
    the SDK's `pilotswarm_facts_it_*`). `initialize()` runs the full migration
    chain into it.
  - **One AGE graph per run:** `hzt_<runId>` (AGE graphs are cluster-global
    names, not schema-scoped — they MUST carry the runId).
  - **Teardown:** drop schema CASCADE + `drop_graph` on success; leave both in
    place on failure for forensics (print the names).
- **Sequencing:** suites run **sequentially** (shared cluster: AGE/`pg_durable`
  init races such as `tuple concurrently updated`). Within a suite, tests are
  ordered only where the fixture is deliberately shared (noted per suite).
- **Charter rules** (inherited): no retries, no arbitrary sleeps — poll on
  observable outcomes with a deadline; no weakened assertions; loud failures.
  Plus §0: no mocks anywhere.
- **Helpers (`_db.mjs`):** pool factory, runId/schema/graph names, FX/GX
  dataset builders, the seeded-vector loader (direct `UPDATE facts SET
  embedding=…` — test code is exempt from the no-inline-SQL rule, which binds
  the *provider* only), an `aclOf(sessionId, granted?, unrestricted?)` builder,
  and `pollUntil(fn, deadline)`.

## 2. Suite order

Ordered so that each layer only relies on layers already proven. One file per
suite; IDs reference the 04-test-spec matrices.

| # | Suite (file) | Surface | 04 IDs |
|---|--------------|---------|--------|
| 0 | `preconditions.test.mjs` | fail-fast on real targets (plain PG + grant role) | P1–P4, P1a, P3b, P5 |
| 1 | `migrations.test.mjs` | migration chain, idempotency, lock, triggers | M1–M4 + §3 below |
| 2 | `base-facts.test.mjs` | FactStore parity + `scopeKeys` | B1–B7 |
| 3 | `crawl-tracking.test.mjs` | queue, receipts, race guard | C1–C7 |
| 4 | `search-lexical.test.mjs` | BM25 | L1–L4 |
| 5 | `search-semantic.test.mjs` | seeded-vector kNN | S1–S5 |
| 6 | `similar-facts.test.mjs` | anchor kNN | SF1–SF5 |
| 7 | `hybrid.test.mjs` | fusion + weights | H1–H3 |
| 8 | `acl.test.mjs` | ACL-in-proc, recall, grants | A1–A5 |
| 9 | `graph-nodes.test.mjs` | upsert/merge node | GE1–GE5 |
| 10 | `graph-edges.test.mjs` | upsert edge, reinforcement dedup | GR1–GR8 |
| 11 | `graph-query.test.mjs` | reads, seeds, evidence filter | GQ1–GQ16 |
| 12 | `graph-merge.test.mjs` | entity resolution | GM1–GM4 |
| 13 | `graph-delete.test.mjs` | deletes, no cascade | GD1–GD5 |
| 14 | `lineage.test.mjs` | base descendants scope + rank | LN1–LN3 |
| 15 | `embedder-lifecycle.test.mjs` | df lifecycle against the real endpoint | E1–E3, E6–E12 |
| 16 | `embedder-outcomes.test.mjs` | embedding outcomes at real dim + end-to-end semantic over pipeline-embedded rows | E4, E5, E13, E14 |
| 17 | `context-search.test.mjs` *(Phase 2)* | searchGraphContext | CX1–CX5 |
| 18 | `context-similar.test.mjs` *(Phase 2)* | similarGraphContext | CS1–CS5 |
| 19 | `conformance.test.mjs` | static guards (grep/lint) | M1, exit criteria |

Suites 2–14 each build their fixture from the §5 builders into the run schema;
they do not share mutable state across suites (graph fixtures use per-suite
node-key prefixes so suite 11 can't be poisoned by suite 9 leftovers).

## 3. Migrations — what "including DB-level migrations" means concretely

The migration chain (03-design §5: `0001_facts_table … 0005_embedding_vars_loop`)
is itself a first-class test subject:

| # | Case | Method |
|---|------|--------|
| MG1 | **Fresh apply** | virgin schema → `initialize()` → every numbered migration applied **in order**, versions recorded in the migrations table; all expected objects exist (table, GIN tsv index, ANN index, AGE graph, procs, trigger, df helper procs) — assert via catalog queries, not provider calls |
| MG2 | **Idempotent re-run** | second `initialize()` on same schema = no-op; version rows unchanged; no duplicate objects |
| MG3 | **Advisory-lock concurrency** | two `initialize()` calls started concurrently (two pools) → both resolve, schema valid, versions recorded once (M3) |
| MG4 | **Partial-chain resume** | apply `0001..0003` manually, then `initialize()` → only `0004..` applied (migrator resumes, doesn't restart) |
| MG5 | **Trigger semantics** | direct-SQL probes of the `content_hash` trigger: INSERT sets hash + `last_crawled_at IS NULL`; UPDATE changing value resets `last_crawled_at` and leaves `last_embedded_hash` stale; UPDATE writing identical content changes **nothing** (C4's DB-level twin) |
| MG6 | **Downgrade/unknown version** | migrations table contains a version newer than the code knows → `initialize()` throws a precise error (never "repairs") |
| MG7 | **Schema-rename gate** | `scripts/verify-schema-migration.mjs` (9 checks, self-cleaning) stays a standalone, re-runnable gate — referenced, not duplicated, here (04 §6.1, X1–X6) |

Object-existence assertions in MG1 double as the contract that **all DDL lives
in migrations**: the suite greps the provider source for `CREATE TABLE|CREATE
INDEX|CREATE OR REPLACE FUNCTION` outside `migrations/` (suite 19, M1).

## 4. Preconditions (suite 0) — fail-fast on real targets only

You cannot drop `vector`/`age` on a shared HorizonDB — so the negatives use
**real databases that genuinely lack the pieces**, never simulated snapshots:

- **Live positive (P5):** the real HorizonDB → `initialize()` succeeds,
  migrations applied, ready.
- **Plain-Postgres negative (P1–P4):** `initialize()` against
  `PLAIN_DATABASE_URL` (vanilla PostgreSQL — really missing `vector`, `age`,
  `pg_textsearch`, `pg_durable`/`df.http`) → throws ONE precise error that
  **names every missing extension and its fix** (assert each name appears in
  the message; partial naming fails). This is also the contract for the
  resolution-chain misconfiguration case: enhanced store pointed at plain
  Postgres = loud startup failure.
- **Grant negative (P3b):** on the real HorizonDB, create a transient
  low-privilege role with the extensions visible but **no `df` usage grant** →
  `initialize()` as that role throws the grant-specific message
  (shared_preload + `GRANT` instructions). The role is created/dropped by the
  suite (HorizonDB `hdbadmin` can — verified by the §6.7 conformance run);
  the suite fails loudly if it lacks the right, rather than skipping the case.
- **Single-missing-piece coverage:** to prove the error is *itemized* (not
  just "something missing"), the plain-PG case optionally installs the
  extensions that vanilla Postgres *can* host (e.g. `vector` where available)
  and asserts the error narrows to exactly the still-missing set. Run
  opportunistically: if `CREATE EXTENSION vector` is not possible on the
  plain target, the all-missing assertion above already covers P1–P4.

## 5. Deterministic fixtures

- **`FX`** (04 §1.1) — 6 facts, hand-authored dim-4 unit vectors written
  directly into the real `embedding` column (+ matching `embedding_model`,
  `last_embedded_hash`) so cosine order is **exact**. Expected ranks are
  **computed in the test from the seeded vectors**, never hard-coded. This is
  deterministic *data*, not a mock: every query still runs the real proc, the
  real pgvector kNN, the real ANN index. The same ranking contracts are
  additionally smoke-checked over **pipeline-embedded** rows at the real
  dimension in suite 16 (robust assertions only: related pair outranks
  unrelated pair — real embeddings don't permit exact-order assertions).
- **`GX`** (04 §1.3) — the skill/person/component fixture with the deliberate
  `moody` / `alastor-moody` duplicate, written through the provider's own
  `upsertGraphNode`/`upsertGraphEdge` (the graph fixture is also a write-path
  test).
- **`GX+ACL`** — GX variant where one node carries mixed evidence
  (`shared:` + `session:S1:` + `session:S2:` keys) feeding GQ13–GQ16 and CX5.
- **Harvested fixture** (Phase 2) — FX ⋈ GX linked via `EVIDENCED_BY`, built
  through the provider's own graph write API (real `upsertGraphNode`/
  `upsertGraphEdge` calls with evidence) so CX/CS tests are deterministic
  without involving an LLM.

## 6. The per-method checklist (unit-style discipline)

For **every** public method the suite must contain, at minimum:

1. one happy-path case asserting the documented return shape **exactly**
   (extra/missing fields fail);
2. one negative case per documented error-semantics row (02 §6) — asserted on
   error message/type, or on the documented empty/`false` result;
3. one ACL case where the caller is scoped (not unrestricted), if the method
   takes/implies access;
4. idempotency or replay case where the contract claims it (`storeFact`
   upsert, `upsertGraphNode/Edge`, `markFactsCrawled` re-stamp, double
   start/stop, double configure).

Surface inventory the plan must cover (and suite 19 cross-checks against the
exported interface so a future method can't ship untested): the 9 base
`FactStore` methods (incl. `scopeKeys` reads), `searchFacts`, `similarFacts`,
`readUncrawledFacts`, `markFactsCrawled`, `configureEmbedder`, `startEmbedder`,
`stopEmbedder`, `embedderStatus`, and the 8 `GraphInterface` methods.

## 7. Embedder — real endpoint, end to end (suites 15–16)

`df.http` runs **inside the database**, so the endpoint must be a real
embeddings deployment reachable *from HorizonDB* (`HORIZON_EMBED_URL`). There
is no stub and no "skip if unset is OK" posture: an embedder suite that
skipped means the validation run is incomplete (§1).

**Suite 15 — lifecycle (real endpoint configured throughout):**
E1–E3 (status/start/double-start → single instance), E6 (df state while
running), E7–E9 (stop/double-stop/restart), E10 (start unconfigured throws —
the one case that runs *before* `configureEmbedder`), E11/E12
(configure-while-running restarts → **new** `instanceId`, still exactly one
instance per label; configure-while-stopped writes vars only). Assertions go
through `embedderStatus()` plus a direct query of the pg_durable instance
table filtered by the schema label — never deeper into df internals. Each
lifecycle test seeds a small pending set so ticks do real work (the loop is
exercised, not idling).

**Suite 16 — outcomes at the real dimension:**

- **E4** pending → embedded: seed plain-text facts, start, poll until
  `embedding IS NOT NULL` at the configured dim; then assert the **search
  outcome** — semantic `searchFacts` finds them, `similarFacts` orders a
  clearly-related pair above a clearly-unrelated one (robust assertions; real
  embeddings don't allow exact-order checks).
- **E5** edit → re-embed: mutate content, poll until `embedded_at` advances
  and `last_embedded_hash == content_hash` for the new content.
- **E13** mid-flight edit convergence: with a large pending batch in flight,
  edit one batched fact; terminal assertion is **convergence** — once edits
  stop, polling reaches a state where the fact's `last_embedded_hash` equals
  the *final* content's hash and `embedded_at` postdates the last edit. The
  select-time-hash write-back guarantees the loop cannot settle with a stale
  vector marked fresh; the test asserts the observable consequence (it always
  re-embeds the final content) rather than trying to freeze the race window.
- **E14** model rotation: `configureEmbedder` with a second real deployment
  (or deployment alias) → previously embedded rows become pending and
  re-embed; `embedding_model` updates; while mismatched, those rows are absent
  from semantic results (S5's live twin).

## 8. ACL matrix discipline (suites 6, 8, 11)

Every ACL test runs the **same query four ways** — `S1` reader, `S1+granted
S2`, `unrestricted`, and no-context — and asserts the four result sets against
a precomputed visibility table. Key cases beyond the matrix rows:

- **A5 (starvation):** ≥ `candidatePool`+10 inaccessible facts engineered to
  outrank the caller's single accessible match (seeded vectors make rank
  exact) → the match is still returned. This is the regression test that ACL
  lives in the proc's WHERE, not a post-filter.
- **SF5/GQ15 (oracle-freeness):** the inaccessible-anchor and
  inaccessible-seed results are asserted **deep-equal** to their unknown-key
  twins (SF4/GQ12) — same shape, same counts, same emptiness.
- **GQ13/14/16 (evidence filter):** node with mixed evidence → S1 sees
  shared+S1 keys only; connectivity through the hidden S2 evidence still
  works; `unrestricted` sees all keys.

## 9. Static conformance (suite 19)

- **M1 grep guard:** no inline relational/vector SQL in provider source —
  every data access is a proc call (or the typed Cypher layer for graph).
- **Numbered-migration guard:** files in `migrations/` match
  `^\d{4}_[a-z0-9_]+\.sql$`, strictly increasing, no gaps.
- **Interface-coverage guard:** every method on the exported
  `EnhancedFactStore` + `GraphInterface` types appears in at least one suite
  (simple static cross-check, fails when someone adds a method without tests).
- **04 exit criteria** re-asserted: every interface has ≥1 positive and ≥1
  negative test; semantic ordering from seeded vectors only.

---

## 10. Scenario tier — facts + harvester on the pgsql-hackers sample

**Two corpora, two assertion styles:**

- [`eval/corpus/pgsql-hackers.json`](../../../incubator/horizon-facts/eval/corpus/pgsql-hackers.json)
  — **synthetic**, 3 messages, deliberately authored so 1001/1002 restate one
  Tom Lane relationship (once via the alias `tgl`) and 1003 introduces Andres
  Freund disagreeing. Retained for the **hand-authored, exact** invariants —
  it's the only corpus where we *know* the planted alias and the planted
  reinforcement pair.
- [`eval/corpus/pgsql-hackers-real.json`](../../../incubator/horizon-facts/eval/corpus/pgsql-hackers-real.json)
  — **real archive data**: 60 messages from the actual pgsql-hackers
  *"[PATCH] Generic type subscripting"* thread (the series that became jsonb
  subscripting; 2017 segment — Dmitry Dolgov ×28, Arthur Zakirov ×19, Tom
  Lane ×6, Peter Eisentraut ×4, David Steele ×2, Oleg Bartunov ×1). Quoted
  reply lines stripped, bodies capped at 2500 chars; regenerable via
  `corpus/build-pgsql-hackers-real.mjs` (the full thread holds ~276 messages
  — raise `--max` to scale the eval further). The file carries a `metadata`
  block (participants, per-author counts, `multiMessageAuthors`); scale
  invariants are **computed from that metadata at assert time**, never
  hand-coded — so regenerating or enlarging the corpus regenerates the
  expectations with it.

Scenario→corpus mapping: **SC1 runs twice** — once on the synthetic corpus
(exact invariants below) and once on the real corpus (metadata-derived
invariants below). SC2, SC3, SC5, SC6 run on the **real** corpus (SC5 adds
one synthetic session-private fact as its control); SC4's reader runs against
the real harvest.

**Agent harness: the GitHub Copilot SDK, directly.** No PilotSwarm runtime —
the harvester and reader agents are Copilot-SDK agents (the existing
`eval/harvester-eval.mjs` pattern) given the real `facts_*`/`graph_*` tools
from [05-tools-spec.md](./05-tools-spec.md), wired straight onto the provider.
The eval's current adapter shims are **deleted**: real `last_crawled_at`
column + `contentHash` receipts (no `_crawlmark/*` marker facts), real method
names, privileged/unrestricted access for the harvester role.

Because LLM output is non-deterministic, scenarios assert **structural
invariants** (never exact predicate strings). Where a scenario needs
byte-identical reproducibility (SC2), it uses **recorded replay**: the
harness captures the exact sequence of real tool calls the agent made in SC1
and re-issues them verbatim against the store — same surface, same database,
deterministic input.

Seeding: each message stored as a fact `archive/pgsql-hackers/msg-<id>`
(shared), value = `{from, subject, body}`, tags `["pgsql-hackers"]`, into a
per-run namespace. The real embedder loop is started after seeding; scenarios
that take a semantic/hybrid entry (SC4, SC6) first poll until the corpus is
embedded (outcome check, per charter — no fixed sleeps).

### SC1 — Cold harvest (the canonical loop)

Seed the corpus → run the Copilot-SDK harvester agent until
`facts_read_uncrawled` returns 0 (bounded by `EVAL_TIMEOUT_MS`) → **record
every tool call** (for SC2).

**SC1a — synthetic corpus (3 messages, exact invariants):**

1. **Dedup:** exactly one `person` node for Tom Lane; `tgl` is an alias on it
   (resolve-before-create worked).
2. **Distinct entities:** Andres Freund is a separate person node.
3. **Connectivity:** Tom Lane reaches a patch/file/thread node within 2 hops.
4. **Reinforcement:** the 1001/1002 relationship is **one** edge with
   `observations == 2` and noisy-OR confidence — reinforced because each
   assertion carried a **different** evidence scopeKey (msg-1001, msg-1002).
5. **Provenance:** every edge carries ≥1 evidence key; the reinforced edge's
   evidence is exactly `{msg-1001, msg-1002}`.
6. **Queue drained + receipts:** no uncrawled fact remains; every
   `facts_mark_crawled` call in the recorded transcript passed the
   `contentHash` read from the queue, and the run totals satisfy
   `marked == Σ stamps`, `skipped == 0`.

**SC1b — real corpus (60 messages, invariants derived from
`corpus.metadata` at assert time — regenerating the corpus regenerates the
expectations):**

1. **Person dedup at scale:** for every `metadata.multiMessageAuthors` entry,
   exactly **one** person node exists whose `name` or `aliases` match it —
   across 60 real messages of varying salutations and sign-offs, no
   participant may split into duplicate person nodes.
2. **Connectivity:** every multi-message author reaches ≥1 non-person node
   (patch/file/thread/concept) within 2 hops.
3. **Reinforcement in the wild:** ≥1 edge has `observations >= 2` with ≥2
   **distinct** message scopeKeys in its evidence — a 28-message participant
   (Dmitry Dolgov) necessarily restates relationships; they must consolidate
   into reinforced edges, not duplicates.
4. **Provenance:** every edge carries ≥1 evidence scopeKey from the corpus
   namespace.
5. **Queue drained at scale:** all `metadata.messageCount` facts crawled with
   matching receipts (`skipped == 0`).

### SC2 — Replay immunity (confidence cannot inflate)

**Recorded replay** of SC1b (real corpus): snapshot the graph (nodes, aliases,
edges with `observations`/`confidence`/evidence), re-queue the corpus (direct
`last_crawled_at = NULL`), then re-issue SC1b's **recorded tool-call sequence
verbatim** against the same store — every `graph_upsert_edge` re-assert now
carries only already-known evidence → assert the post-replay graph snapshot is
**byte-identical** to SC1b's (no `observations` bump, no confidence drift, no
alias/evidence growth) and the queue drains again via the replayed
`facts_mark_crawled` calls (recorded hashes still match — content unchanged).
(GR7 at scenario scale —
the two-concurrent-harvesters / crash-retry story, on the real surface with
deterministic input.)

### SC3 — Edit → re-queue → incremental harvest

On the real corpus, post-SC1b: pick one message by a
`metadata.multiMessageAuthors` participant and edit its fact (`storeFact`
with an appended correction paragraph) → trigger resets only that fact's
`last_crawled_at` → re-run the harvester agent → assert: the queue contained
exactly that message; after harvest no edge it evidences is duplicated
(already-known evidence — reinforcement no-op per GR7), and any *new* relation
asserted from the appended text carries that message's scopeKey as evidence;
all other facts untouched (`last_crawled_at` unchanged). Proves the
edit→re-crawl lifecycle end to end, including the mark-with-stale-hash skip
when the test edits the fact *again* while the agent is mid-harvest (C7 at
scenario scale).

### SC4 — Reader answers a question via the fact-pivot

No harvester involvement; runs against SC1b's real-corpus graph. A
Copilot-SDK **reader** agent, given only the reader tools (no crawl-queue, no
graph writes), answers: *"Who authored the generic type subscripting patch,
and who pushed back on its design?"*

Expected entities are **derived from corpus metadata**, not hand-coded: the
author = sender of the earliest message (Dmitry Dolgov), the push-back set ⊆
the other `multiMessageAuthors` (Tom Lane, Peter Eisentraut, Arthur Zakirov,
David Steele). Asserted on the agent's tool transcript and final answer: a
`facts_search` (hybrid) entry → seeds → `graph_search_nodes({ seeds, depth: 2 })`
→ `facts_read({ scopeKeys: evidence })`; the answer names the author and ≥1
other multi-message participant, and every evidence key cited in the
transcript is a corpus scopeKey. Hybrid/semantic entry runs against the
**real** embedding pipeline (the corpus was embedded by the eternal loop after
seeding — scenarios poll for embedding completion before semantic entry).

### SC5 — Scoped publication (ingestion contract + evidence filter, end to end)

Seed the real corpus (shared) **plus** one synthetic session-private fact
`session:S1:drafts/reply-tgl` ("draft reply agreeing with Tom Lane's
naming objection…") → run the
privileged harvester over **all** of it (it may link the draft's entities into
the graph) → then read as three principals:

- **S2 reader:** sees the node/edge *content* the draft contributed (shared
  graph — publication happened), but **no** `session:S1:` key in any
  `evidence` array, and `facts_read` on returned evidence yields shared facts
  only.
- **S1 reader:** sees the draft's scopeKey in evidence and can read it back.
- **Unrestricted:** sees the full evidence set.

Also assert the inverse control: seeding `graph_search_nodes` with the S1
scopeKey as an S2 caller behaves exactly like an unknown seed. This is the
scenario-level proof of 01 §6.1a: *connections shared, pointers scoped* — and
it documents, as an executable example, what "harvesting a private fact is a
deliberate act of publication" means.

### SC6 — Context bundle (Phase 2, gated)

Against SC1b's harvested real-corpus graph:
`facts_context_search("generic type subscripting", breadth: normal)` returns
a bundle whose `facts` map exactly resolves every seed/node/edge evidence key
(CX2 at scenario scale). For `facts_context_similar`, anchor on the earliest
message (the patch submission): its `factLinks` must connect it to ≥1 other
message by the **same author** (metadata guarantees Dmitry Dolgov has 28 —
several evidence the same patch node), with the connecting predicates listed.
Degenerate twin: run the same two calls against a freshly-seeded, unharvested
copy of the corpus → seeds only, empty `nodes`/`edges`/`factLinks`.

### Scenario exit criteria

- SC1–SC5 pass against live HorizonDB + the real embedding endpoint with
  Copilot-SDK agents (model: `EVAL_MODEL`, default per eval README); SC6
  passes once Phase 2 lands. Structural invariants only — a failure is a
  contract/graph defect, never a predicate-wording diff.
- SC2's byte-identical assertion runs on the recorded replay of SC1's real
  tool calls — the one deterministic scenario, still entirely on the real
  surface.
- Real-corpus invariants are computed from `corpus.metadata` at assert time —
  regenerating or enlarging the corpus (`build-pgsql-hackers-real.mjs --max N`,
  thread holds ~276 messages) regenerates the expectations; no invariant may
  name a participant or message id literally except in the synthetic SC1a.
- The eval's marker-fact shims (`_crawlmark/*`) and old-API adapter are
  **deleted** — scenarios run on the real provider surface only. No
  PilotSwarm dependency anywhere in the scenario tier.
