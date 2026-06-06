# EnhancedFactStore Proposal

Design and specification set for the **EnhancedFactStore** — a strict superset of
PilotSwarm's `FactStore` that adds multi-signal retrieval, an open knowledge
graph, and a durable in-database embedding generator. First provider:
**HorizonDB** (`@incubator/horizon-facts`).

## Documents

| # | Doc | Contents |
|---|-----|----------|
| 01 | [Functional Specification](./01-functional-spec.md) | Purpose, scope, actors, functional requirements, naming changes, acceptance criteria. |
| 02 | [API Reference](./02-api-reference.md) | Target TypeScript interfaces for retrieval, the embedder lifecycle, and the graph crawler. |
| 03 | [Design](./03-design.md) | Component/data-model/embedder/retrieval/migration designs with diagrams. |
| 04 | [Test Specification](./04-test-spec.md) | Deterministic datasets, functional matrices, negative cases, embedder lifecycle, fail-fast, layout. |

## Key decisions captured here

- **Retrieval:** `searchFacts` is **facts-store-only** (`lexical`/`semantic`/`hybrid`
  — no graph mode); `similarFacts` (semantic kNN of a known fact, no re-embed);
  `lineageFacts` is **removed** — lineage is base `readFacts({ scope: "descendants" })`,
  ranked via `searchFacts`. `relatedFacts` is **removed** — graph relatedness is
  `searchGraphNodes({ seeds })` + `readFacts`. Signal type is orthogonal to which
  store you query.
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
- **Renames:** `relatedFacts`→removed (`searchGraphNodes({ seeds })` + `readFacts`);
  `searchFacts` `graph` mode→removed (facts-only); `GraphCrawlerInterface`→`GraphInterface`;
  `Entity*`→`GraphNode*` (`upsertEntity`→`upsertGraphNode`, `searchEntities`→`searchGraphNodes`,
  `mergeEntities`→`mergeGraphNodes`, `deleteEntity`→`deleteGraphNode`, `entityKey`→`nodeKey`);
  `Edge*`/`Rel*`→`GraphEdge*` (`upsertEdge`→`upsertGraphEdge`, `searchEdges`→`searchGraphEdges`,
  `deleteEdge`→`deleteGraphEdge`); `neighbourhood`→`graphNeighbourhood`.

## Status

Proposal — pending review before implementation. No product code has been
changed. One verification artifact has been added and run against the live
HorizonDB: [`scripts/verify-schema-migration.mjs`](../../../incubator/horizon-facts/scripts/verify-schema-migration.mjs)
(schema-rename conformance, 9/9). This set captures the agreed design so the
build can follow it.
