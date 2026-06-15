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

## Evaluation

The incubator ships a two-axis evaluation surface — **system** evals (is the
harvest correct, durable, fast?) and **quality** evals (does the graph actually
help an LLM answer better than parametric knowledge + live web?). The full system
overview — how the harvester builds the KB and how every eval tier fits together —
is in [docs/harvester-and-eval.md](./docs/harvester-and-eval.md).

| Tier | Where | What it proves |
| --- | --- | --- |
| Scenario (system) | [eval/README.md](./eval/README.md) | Cold/incremental harvest, replay determinism, scoped publication, reader fact-pivot |
| Quality (single model) | [eval/graph-quality.mjs](./eval/graph-quality.mjs) | Graph arm vs parametric+web baseline, blind-judged against corpus ground truth |
| **Quality (cross-model sweep)** | [eval/sweep/](./eval/sweep/) | A 3×3×3 **harvester × query × judge** tensor that isolates judge bias |

### Cross-model sweep

The sweep answers "is the graph really better, or just a lucky model / biased
judge?" by sweeping three independent axes into a score tensor and generating a
bias-aware report grounded in a deterministic numeric summary. Latest run
(`pgsql-hackers-recent`, N=8 questions/cell, 216 graded rows):

> **graph 4.76 vs baseline 2.42** (Δ +2.34 on a 1–5 scale), graph winning 163/216
> head-to-head with no judge able to flip the verdict — and it holds with the
> graph answers being *shorter* than the baseline. Honestly deflated to a
> ~+1.8–2.0 *substantive* edge once baseline web-timeout failures are separated
> out (see the report's methodology + caveats).

- Results: [eval/sweep/REPORT.md](./eval/sweep/REPORT.md) (narrative) + [eval/sweep/summary.json](./eval/sweep/summary.json) (authoritative numbers).
- Run + interpret: skill [horizon-facts-eval-sweep/SKILL.md](../../.github/skills/horizon-facts-eval-sweep/SKILL.md) and agent [horizon-facts-eval-sweep.agent.md](../../.github/agents/horizon-facts-eval-sweep.agent.md) (commands + manual graph-validation queries).
- The bulky per-cell intermediates (`scores/`, `transcripts/`, `logs/`) are gitignored and regenerable; the driver, config, pinned `questions.json`, and final `REPORT.md` / `summary.json` are tracked, so any run reproduces.

## Specs & docs

**Enhanced facts store (this incubator):**
[SPEC.md](./SPEC.md) (base design) ·
[CRAWLER.md](./CRAWLER.md) / [CRAWLER-SPEC.md](./CRAWLER-SPEC.md) (open-graph crawler) ·
[GAP-ANALYSIS.md](./GAP-ANALYSIS.md).
Upstream provider contract + tool/test specs:
[docs/proposals/enhancedfactstore/](../../docs/proposals/enhancedfactstore/)
(`01-functional-spec` · `02-api-reference` · `03-design` · `04-test-spec` ·
`05-tools-spec` · `06-provider-test-plan`).

**Harvester & evaluation:**
[docs/harvester-and-eval.md](./docs/harvester-and-eval.md) (full system overview) ·
[eval/README.md](./eval/README.md) (scenario tier) ·
[eval/sweep/REPORT.md](./eval/sweep/REPORT.md) (latest cross-model sweep).
