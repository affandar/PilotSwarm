# `@incubator/horizon-facts` — Enhanced Facts Interface (INCUBATING)

> ⚠️ **Status: incubation.** This package is intentionally **not** part of the
> `packages/*` workspace and is **not** wired into PilotSwarm. It exists to
> design, prototype, and validate a HorizonDB-only enhanced facts interface in
> isolation, with tests and PoCs, *before* any integration decision is made.

## What this is

An **optional, enhanced read interface** over the PilotSwarm Facts Store, built
exclusively on **Azure HorizonDB** (preview) capabilities:

| HorizonDB capability | Role here |
| --- | --- |
| `pg_textsearch` | Ranked lexical recall (upgrade over today's `LIKE` / `key_pattern`) |
| HTTP embedding endpoint | In-DB embedding generation via a configurable endpoint + semantic (vector ANN) recall |
| Apache AGE | Relationship/lineage graph overlay (structure only) |
| `pg_durable` | Durable, idle-aware maintenance pipeline (embeddings only) |

> **Embeddings come from a configurable HTTP endpoint, not HorizonDB's built-in
> `aiModelManagement`.** You pass an OpenAI/Azure-OpenAI-compatible embeddings
> endpoint to the provider; the `pg_durable` loop calls it over HTTP from inside
> the database (`sql/006`), and a Node fallback (`embedPending()`) covers
> clusters without the `http` extension. See [CRAWLER-SPEC.md](./CRAWLER-SPEC.md) §3.

## Hard design rules (carried from PilotSwarm)

1. **The `facts` table stays authoritative.** tsvector, vector, and AGE are
   *derived indexes/overlays* — never the source of truth. The graph stores
   **ids and structure, never fact values or ACLs**.
2. **Governance is unchanged.** Scope (`scope_key`), `shared` / `transient`,
   namespace ACLs, and spawn-tree visibility are still enforced by stored
   procedures. Search modes are extra `AND` clauses inside the existing
   visibility filter — they can only narrow what a caller already sees.
3. **Determinism boundary.** Anything LLM/IO (embedding, distillation,
   relatedness) runs as a `pg_durable` **activity**, never inline orchestration.
4. **Rebuildable.** Every derived artifact (tsvector, embeddings, AGE graph)
   can be dropped and rebuilt from `facts` rows.

## Layout

```
incubator/horizon-facts/
  SPEC.md            ← the design: data model, compute/API/frequency, scenarios
  CRAWLER.md         ← open, ontology-free LLM graph crawler (entities + free-form relationships)
  CRAWLER-SPEC.md    ← implementation contract: API, schema, compute tiers, PG mailing-list example
  src/
    types.ts          ← EnhancedFactStore + GraphCrawlerInterface contracts + DTOs
    config.ts         ← provider config incl. the embedding HTTP endpoint
    embedding-client.ts ← Node-side embeddings client (query-time + test reference)
    query-builder.ts  ← DB-less hybrid ranking/fusion + SQL fragment builders (unit-tested)
    graph-model.ts    ← DB-less open-graph quality core: canonicalize, predicate, confidence (unit-tested)
    migrations.ts     ← Node-runnable schema + AGE setup (mirrors sql/001–005)
    http-embedding.ts ← Node-runnable in-DB HTTP embedding pipeline (mirrors sql/006)
    horizon-store.ts  ← HorizonFactStore: drop-in EnhancedFactStore + open-graph crawler
    agent-tools.ts    ← optional agent tools (search / related / graph) for injection
    index.ts          ← public exports
  sql/
    001_enrich_facts.sql  ← tsvector + embedding columns + indexes
    002_age_graph.sql     ← AGE node/edge model + structural backfill
    003_search_procs.sql  ← facts_search_facts + related/lineage procs
    004_pipelines.sql     ← pg_durable maintenance pipeline (embeddings only)
    005_open_graph.sql    ← open Entity / REL / EVIDENCED_BY graph for the crawler
    006_embeddings_http.sql ← in-DB HTTP embedding pipeline (replaces aiModelManagement)
  poc/                ← runnable harnesses (lexical/hybrid/crawler run DB-less today)
  test/               ← DB-less unit tests (run in CI without HorizonDB)
    integration/      ← live tests against a real HorizonDB (skip without HORIZON_DATABASE_URL)
```

## Drop-in replacement

`HorizonFactStore` implements the full PilotSwarm `FactStore` API
(`storeFact` / `readFacts` / `deleteFact` / stats / …) with identical semantics,
so it can replace `PgFactStore` anywhere. It **adds** retrieval methods
(`searchFacts` / `relatedFacts` / `lineageFacts`) and the open-graph crawler
(`upsertEntity` / `assertRelationship` / …). Apps opt into the extras; nothing
in the base behavior changes.

```js
import { HorizonFactStore, createFactsTools } from "@incubator/horizon-facts";

const store = await HorizonFactStore.create({
  connectionString: process.env.HORIZON_DATABASE_URL,
  embedding: { url: EMBED_URL, model: "text-embedding-3-small", dim: 1536, apiKey: KEY },
});
await store.initialize();

// ...use exactly like the existing FactStore, plus:
await store.searchFacts("jsonb subscripting", { mode: "hybrid" }, { unrestricted: true });

// Optionally inject tools into your agents:
const tools = createFactsTools(store, { graphWrite: true }); // spread into worker.registerTools([...])
```

## Running

```bash
cd incubator/horizon-facts
npm install
npm run build
npm test                 # DB-less unit tests — no HorizonDB needed
npm run poc:crawler      # open-graph harvest scenario — runs DB-less today

# Live integration tests against a real HorizonDB (auto-skip if unset):
export HORIZON_DATABASE_URL=postgres://user:pw@host/db
npm run test:integration # pg_durable HTTP embeddings, AGE Cypher, full provider
```

See [SPEC.md](./SPEC.md) for the base design, [CRAWLER.md](./CRAWLER.md) /
[CRAWLER-SPEC.md](./CRAWLER-SPEC.md) for the open-graph crawler.
