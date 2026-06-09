# EnhancedFactStore Proposal

Design and specification set for the **EnhancedFactStore** — a strict superset of
PilotSwarm's `FactStore` that adds multi-signal retrieval, an open knowledge
graph, and a durable in-database embedding generator. First provider:
**HorizonDB** (`@incubator/horizon-facts`).

## Documents

| # | Doc | Contents |
|---|-----|----------|
| 01 | [Functional Specification](./01-functional-spec.md) | Purpose, scope, actors, functional requirements, acceptance criteria. |
| 02 | [API Reference](./02-api-reference.md) | Target TypeScript interfaces for retrieval, the embedder lifecycle, and the graph crawler. |
| 03 | [Design](./03-design.md) | Component/data-model/embedder/retrieval/migration designs with diagrams. |
| 04 | [Test Specification](./04-test-spec.md) | Deterministic datasets, functional matrices, negative cases, embedder lifecycle, fail-fast, layout. |
| 05 | [Agent Tools Spec](./05-tools-spec.md) | LLM-facing tool contract (`facts_*` / `graph_*`), harvester loop, and the Phase 2 context tools. |

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
  — no graph mode); `similarFacts` (semantic kNN of a known fact, no re-embed).
  There is **no** dedicated `lineageFacts` — lineage is base
  `readFacts({ scope: "descendants" })`, ranked via `searchFacts`. There is **no**
  dedicated `relatedFacts` — graph relatedness is `searchGraphNodes({ seeds })` +
  `readFacts`. Signal type is orthogonal to which store you query.
- **Embedder:** one durable, eternal `df.loop` that embeds **batches** via the
  array-input API and one `df.http` per batch — no "df-in-df" nesting. Config in
  `df.setvar` (sourced from `.env`/k8s); the API key is in a durable var **for
  now** (plaintext-at-rest TODO). Lifecycle: `configureEmbedder` /
  `startEmbedder` / `stopEmbedder` / `embedderStatus`.
- **Crawl tracking:** the facts table gains `last_crawled_at` (marks graph
  incorporation). It resets to `NULL` on any `storeFact` content
  change (trigger), so pending-crawl = `last_crawled_at IS NULL`. Harvester
  support: `readUncrawledFacts` (work queue) + `markFactsCrawled` (stamp done).
- **Fail-fast:** `initialize()` requires `vector`, `age`, `pg_durable`+`df.http`;
  no feature flags, no Node fallback.
- **Phase 2 context reads:** `searchGraphContext` (query → graph → facts) and
  `similarGraphContext` (known fact → similar cluster → graph, with derived
  `factLinks`) compose the Phase 1 primitives into one ACL-checked, deduped
  bundle. Read-only; gated behind a harvested graph (`EVIDENCED_BY`).
- **Graph:** `GraphInterface` with `upsertGraphNode` + `upsertGraphEdge` (evidence
  **optional**, merge/union semantics; `upsertGraphEdge` absorbs `linkEvidence`);
  `mergeGraphNodes`; `deleteGraphNode` / `deleteGraphEdge`; reads
  `searchGraphNodes` (takes `seeds[]` of fact scopeKeys or node keys) /
  `searchGraphEdges` / `graphNeighbourhood`. Graph nodes carry **no embeddings** —
  the query entry point is the facts' vector index, pivoting in via `EVIDENCED_BY`
  seeds. **No cascade** from fact deletion into the graph — the KV ↔ graph linkage
  is **by convention, not contract**.
- **Storage:** relational + vector access via **stored procedures**; graph access
  via a **typed Cypher layer**; all DDL via **numbered migrations** using a
  vendored migrator (merge back into `pg-migrator.ts` on graduation).
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
