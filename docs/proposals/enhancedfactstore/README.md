# EnhancedFactStore Proposal

Design and specification set for the **EnhancedFactStore** — a strict superset of
PilotSwarm's `FactStore` that adds multi-signal retrieval and a durable
in-database embedding generator — **and**, as a **separate optional surface**, an
open knowledge graph (`GraphStore`). First providers: **HorizonDB**
(`@pilotswarm/horizon-store`) — `HorizonDBFactStore` (enhanced facts) and
`HorizonDBGraphStore` (AGE-only graph).

> **Canonical shape: [07-pilotswarm-integration.md](./07-pilotswarm-integration.md).**
> Docs 01–06 were first written with the graph bundled into `EnhancedFactStore`.
> The agreed shape splits them: the graph is a **separate, independently injected
> `GraphStore`** (its own provider `HorizonDBGraphStore` + `graphDatabaseUrl`); the
> **crawl queue** (`last_crawled_at` / `readUncrawledFacts` / `markFactsCrawled`)
> lives on the **base `FactStore`**; the enhanced fact provider is
> **`HorizonDBFactStore`**; the package is **`@pilotswarm/horizon-store`**. Where a
> doc still says `GraphInterface` or implies one bundled provider, read it through
> that shape.

## Documents

| # | Doc | Contents |
|---|-----|----------|
| 01 | [Functional Specification](./01-functional-spec.md) | Purpose, scope, actors, functional requirements, acceptance criteria. |
| 02 | [API Reference](./02-api-reference.md) | Target TypeScript interfaces for retrieval, the embedder lifecycle, and the graph crawler. |
| 03 | [Design](./03-design.md) | Component/data-model/embedder/retrieval/migration designs with diagrams. |
| 04 | [Test Specification](./04-test-spec.md) | Deterministic datasets, functional matrices, negative cases, embedder lifecycle, fail-fast, layout. |
| 05 | [Agent Tools Spec](./05-tools-spec.md) | LLM-facing tool contract (`facts_*` / `graph_*`), harvester loop, a **worked graph example** (§5a, diagrammed over the real pgsql-hackers corpus), and the Phase 2 context tools. |
| 06 | [Provider Test Plan](./06-provider-test-plan.md) | Executable plan for 04: no-mocks/full-validation ground rule, suite order, live-HorizonDB lifecycle, migration tests, real-endpoint embedder validation, and the Copilot-SDK harvester scenarios on the pgsql-hackers corpus. |
| 07 | [PilotSwarm Integration Plan](./07-pilotswarm-integration.md) | Execution plan for landing the contract in `packages/sdk`: dependency inversion (SDK owns `EnhancedFactStore`, HorizonDB implements it), provider injection, capability-gated tools, phased PR sequence (P0–P6), risks/rollback, and open decisions. |

## Phasing

- **Phase 1** — the orthogonal primitives (`searchFacts`, `similarFacts`, the
  graph API), the embedder, and harvester support (`readUncrawledFacts` /
  `markFactsCrawled`) that *populates* the graph's `EVIDENCED_BY` links.
- **Phase 2** — two compound cross-store reads, `searchGraphContext` and
  `similarGraphContext`, that *compose* the Phase 1 primitives into one
  relationship-aware bundle. They are gated behind Phase 1 because they only
  return useful results once a harvester has populated `EVIDENCED_BY`; against an
  unharvested graph they degrade to just the seed facts. See
  [01-functional-spec.md §7](./01-functional-spec.md).

## Key decisions captured here

- **Retrieval:** `searchFacts` is **facts-store-only** (`lexical`/`semantic`/`hybrid`
  — no graph mode); `similarFacts` (semantic kNN of a known fact, no re-embed;
  an inaccessible anchor behaves exactly like an unknown one). There is **no**
  dedicated `lineageFacts` — lineage is base
  `readFacts({ scope: "descendants" })`, ranked via `searchFacts`. There is **no**
  dedicated `relatedFacts` — graph relatedness is `searchGraphNodes({ seeds })` +
  `readFacts`. Signal type is orthogonal to which store you query. **ACL is part
  of the search procs' WHERE clause, before ranking/LIMIT** — never a
  post-ranking filter.
- **Embedder:** one durable, eternal `df.loop` that embeds **batches** via the
  array-input API and one `df.http` per batch — no "df-in-df" nesting. Config in
  `df.setvar` (sourced from `.env`/k8s); durable vars are **captured at
  `df.start` and immutable for the run** (pg_durable contract), so
  `configureEmbedder` **restarts a running loop** to apply new config/keys.
  The API key is in a durable var **for now** (plaintext-at-rest TODO).
  Lifecycle: `configureEmbedder` / `startEmbedder` / `stopEmbedder` /
  `embedderStatus`. Write-back stamps `embedding_model` and the **select-time**
  `content_hash`; rows embedded under another model count as un-embedded
  (pending + invisible to semantic search), so model rotation is a rolling
  re-embed.
- **Crawl tracking (base `FactStore`):** the facts table gains `last_crawled_at`
  (marks graph incorporation). It resets to `NULL` on any `storeFact` content
  change (trigger), so pending-crawl = `last_crawled_at IS NULL`. Harvester
  support — `readUncrawledFacts` (work queue) + `markFactsCrawled` (stamp done) —
  lives on the **base `FactStore`** (not the enhanced interface), so a base-facts
  deployment can feed a separate `GraphStore`. **Crawling is privileged** — the
  harvester reads all facts across scopes — and `markFactsCrawled` takes
  `{ scopeKey, contentHash }` receipts, stamping only when the hash still matches
  (mid-crawl edits stay queued).
- **Fail-fast:** `initialize()` requires `vector`, `age`,
  `pg_textsearch` (BM25), `pg_durable`+`df.http`; no feature flags, no Node
  fallback.
- **Phase 2 context reads:** `searchGraphContext` (query → graph → facts) and
  `similarGraphContext` (known fact → similar cluster → graph, with derived
  `factLinks`) compose the Phase 1 primitives into one ACL-checked, deduped
  bundle. Read-only; gated behind a harvested graph (`EVIDENCED_BY`).
- **Graph:** `GraphStore` (a **separate provider**, `HorizonDBGraphStore`) with
  `upsertGraphNode` + `upsertGraphEdge` (evidence
  **optional**, merge/union semantics; `upsertGraphEdge` absorbs `linkEvidence`;
  reinforcement counts only novel evidence); `mergeGraphNodes`;
  `deleteGraphNode` / `deleteGraphEdge`; reads
  `searchGraphNodes` (takes `seeds[]` of fact scopeKeys or node keys) /
  `searchGraphEdges` / `graphNeighbourhood`. Graph nodes carry **no embeddings** —
  the query entry point is the facts' vector index, pivoting in via `EVIDENCED_BY`
  seeds. **No cascade** from fact deletion into the graph — the KV ↔ graph linkage
  is **by convention, not contract**.
- **Graph trust model:** the graph is a **shared-scope surface** with no
  per-node/edge ACL — **ingestion is publication** (the privileged harvester
  decides what enters; extracted content is visible to all readers). Read-side
  compensation: all graph reads take the caller's access context, **`evidence`
  arrays are filtered to caller-accessible scopeKeys** (syntactic
  `shared:`/`session:<id>:` check) and inaccessible fact seeds are ignored;
  traversal still uses the full evidence set, so connectivity through
  inaccessible facts is preserved without disclosing their keys. See
  [01 §6.1a](./01-functional-spec.md).
- **Storage:** relational + vector access via **stored procedures**; graph access
  via a **typed Cypher layer**; all DDL via **numbered migrations** using a
  vendored migrator (merge back into `pg-migrator.ts` on graduation).
- **Base-API prerequisites (PilotSwarm core):** `FactRecord.scopeKey` +
  `ReadFactsQuery.scopeKeys` (bulk by-key read — every evidence round-trip
  depends on it), and **store-provider injection**: the caller passes the facts
  store provider in the PilotSwarm initializer; an `EnhancedFactStore` lights up
  the enhanced/graph tools and the base instructions name the matching skill
  per store. See [02-api-reference.md §1b–1c](./02-api-reference.md).
- **Connection targets (PilotSwarm core):** three independent connection strings
  — `store` (orchestration / `ps_duroxide`), `cmsFactsDatabaseUrl` (CMS), and the
  new `enhancedFactsDatabaseUrl` (EnhancedFactStore on HorizonDB). Resolution
  `enhancedFactsDatabaseUrl ?? cmsFactsDatabaseUrl ?? store`; all three may point
  at one database. Splitting the enhanced store onto its own HorizonDB also
  largely sidesteps the §6 schema collision (different databases).
- **Schema isolation (PilotSwarm core):** PilotSwarm's duroxide orchestration
  schema is renamed off the shared `duroxide` name (collides with pg_durable) to
  **`ps_duroxide`** via an **online, single-transaction** advisory-locked
  `ALTER SCHEMA` that renames *and* arms a recreation guard atomically. Old
  workers fail loud but can never recreate the old store; no fleet drain. Guard
  is an event trigger or a tombstone-schema + `REVOKE CREATE` (ownership-only).
  **Verified end-to-end on the live HorizonDB** via
  [`scripts/verify-schema-migration.mjs`](../../../incubator/horizon-facts/scripts/verify-schema-migration.mjs)
  (9/9; event triggers work for HorizonDB `hdbadmin` despite non-superuser) — see
  [03-design.md §6.7](./03-design.md).

## Status

Proposal — pending review before implementation. No product code has been
changed. One verification artifact has been added and run against the live
HorizonDB: [`scripts/verify-schema-migration.mjs`](../../../incubator/horizon-facts/scripts/verify-schema-migration.mjs)
(schema-rename conformance, 9/9). This set captures the agreed design so the
build can follow it.
