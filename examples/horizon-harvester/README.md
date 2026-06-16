# Horizon Harvester (SDK Example)

Demonstrates PilotSwarm's **optional** EnhancedFactStore + knowledge-graph
providers: a `harvester: true` agent crawls a mock knowledge source into durable,
searchable facts and builds an open knowledge graph, and a reader agent answers
questions over the result using multi-signal search + graph traversal.

This is the worked example referenced by the `pilotswarm-knowledge-harvester`
builder skill.

## What it shows

- **Wiring the providers from env** — the worker and client are configured with
  `horizonConfigFromEnv()`, which maps the `HORIZON_*` env vars to the worker's
  `enhancedFactsDatabaseUrl` / `graphDatabaseUrl` / `horizonEmbed` / `*Schema` fields.
- **The harvester role** — `source-harvester` declares `harvester: true`, so it (and
  only it) gets the crawl queue (`facts_read_uncrawled` / `facts_mark_crawled`) and
  graph-write tools (`graph_upsert_node` / `graph_upsert_edge` / …).
- **The crawl→graph→reader flow** — ingest documents as `corpus/*` facts (a dedicated
  source-capture namespace, kept separate from the Facts Manager's `intake/*` curation
  queue), drain the
  crawl queue, extract entities/edges into the graph anchored to fact `scopeKey`
  evidence, mark facts crawled with their `contentHash` receipt, then retrieve.
- **The reader role** — `librarian` has no harvester frontmatter; it gets
  `facts_search` / `facts_similar` and the graph **read** tools, and pivots from a
  seed fact into the graph neighbourhood.

## Requirements

| Env var | Purpose |
|---------|---------|
| `DATABASE_URL` | PostgreSQL for the PilotSwarm CMS + orchestration |
| `GITHUB_TOKEN` | GitHub Copilot API token |
| `HORIZON_DATABASE_URL` | HorizonDB enhanced facts store (`pgvector` + `pg_textsearch` + `pg_durable`) |
| `HORIZON_GRAPH_DATABASE_URL` | Knowledge graph target (Apache AGE) — may reuse the facts URL with a distinct graph schema |
| `HORIZON_EMBED_*` | **Optional** durable embedder. Omit ⇒ search runs lexical-only (semantic returns nothing for un-embedded facts; hybrid degrades to lexical) |

See the `HORIZON_*` block in the repo-root [`.env.example`](../../.env.example) for the
full list and the HorizonDB setup notes. Without a HorizonDB cluster this sample
cannot run — it fails fast with a clear message rather than silently degrading to a
plain fact store.

## A graph store is required (and base vs enhanced facts)

Harvesting **requires a knowledge graph**. The crawl queue and graph-write tools the
`source-harvester` uses appear only when `HORIZON_GRAPH_DATABASE_URL` is set — the
`harvester: true` flag alone grants nothing. This sample enforces that: it fails fast
if either `HORIZON_DATABASE_URL` or `HORIZON_GRAPH_DATABASE_URL` is missing.

The fact store underneath the graph decides what **search** the agents also get:

- **This sample uses the full tier** — an **enhanced** fact store **plus** a graph — so
  the harvester can resolve entities with `facts_similar` and the `librarian` answers
  with `facts_search` over the graph neighbourhood.
- **A base fact store + graph** would still harvest (the crawl queue is plain
  Postgres, no extension required), but neither agent would get `facts_search` /
  `facts_similar` — they would navigate by graph topology alone
  (`graph_search_nodes` → `graph_neighbourhood`).

See the builder skill's
[Prerequisites](../../templates/builder-agents/skills/pilotswarm-knowledge-harvester/SKILL.md)
for the full capability matrix.

## Run

From the repo root:

```bash
# full flow: harvest, then ask a question that traverses the graph
./scripts/run-horizon-harvester-sample.sh

# just build the knowledge base
HARVESTER_SCENARIO=harvest ./scripts/run-horizon-harvester-sample.sh

# just answer (after a harvest has populated the store + graph)
HARVESTER_SCENARIO=ask ./scripts/run-horizon-harvester-sample.sh
```

Or call the app directly:

```bash
node --env-file=.env examples/horizon-harvester/sdk-app.js
```

## Visualize the graph

Export the harvested knowledge graph to a Markdown file with a Mermaid diagram
(summary tables + a color-coded node/edge graph). Run a harvest first.

```bash
# writes examples/horizon-harvester/graph.md
./scripts/export-horizon-harvester-graph.sh

# or to a path you choose
./scripts/export-horizon-harvester-graph.sh /tmp/northwind-graph.md
```

This is the file-artifact form of the `graph-debug` skill. The sample graph is small,
so it renders the whole graph; for a large production graph you would bound the export
(one seed, depth ≤ 2, or a single kind). The generated `graph.md` is gitignored.

## Structure

```text
horizon-harvester/
├── plugin/
│   ├── agents/
│   │   ├── default.agent.md        # app-wide overlay
│   │   ├── source-harvester.agent.md  # harvester: true — crawls + builds the graph
│   │   └── librarian.agent.md      # reader — search + graph pivot
│   ├── plugin.json
│   ├── session-policy.json         # allowlist: only the two named agents
│   └── tui-splash.txt
├── scripts/
│   ├── cleanup-local-db.js     # cleanup/teardown (wrapped by clean-horizon-harvester-sample.sh)
│   └── graph-to-mermaid.mjs    # graph → Markdown/Mermaid export (wrapped by export-horizon-harvester-graph.sh)
├── sdk-app.js                      # worker + client wiring + scenario runner
└── tools.js                        # mock knowledge source (Northwind Robotics)
```

The three repo-root entry points for this sample:

| Script | Does |
|--------|------|
| `scripts/run-horizon-harvester-sample.sh` | Harvest and/or ask (`HARVESTER_SCENARIO=full\|harvest\|ask`) |
| `scripts/export-horizon-harvester-graph.sh` | Export the graph to a Markdown/Mermaid file |
| `scripts/clean-horizon-harvester-sample.sh` | Clean up (`--facts` / `--drop` escalate to HorizonDB) |

## The mock domain

`tools.js` exposes a tiny "documentation site" for a fictional company, **Northwind
Robotics**, with four services (`checkout-api`, `inventory-svc`, `robotics-control`,
`telemetry-pipeline`), three teams (Platform, Fulfillment, Hardware), and their leads.
The documents embed clear ownership, leadership, and dependency relationships, so the
harvester has concrete entities and edges to build:

- service `OWNED_BY` team
- team `LED_BY` person
- service `DEPENDS_ON` service

The default "ask" scenario — *"if telemetry-pipeline has an outage, which services are
affected, and which teams own them?"* — forces the librarian to traverse `DEPENDS_ON`
and `OWNED_BY` edges rather than answer from a single fact.

## Cleanup

From the repo root, the clean wrapper has three escalating levels:

```bash
# Local only: drop the local duroxide + copilot_sessions schemas + session files
./scripts/clean-horizon-harvester-sample.sh

# + delete this sample's corpus/northwind facts from HorizonDB (keep schema + embedder)
./scripts/clean-horizon-harvester-sample.sh --facts

# Full teardown: cancel the durable embedder loop, drop the AGE graph (horizon_graph),
# and DROP SCHEMA horizon_facts CASCADE
./scripts/clean-horizon-harvester-sample.sh --drop
```

The HorizonDB facts + graph live on a separate cluster and are **not** touched unless
you pass `--facts` or `--drop`. The underlying node script can also be called directly
with the equivalent env flags:

```bash
cd examples/horizon-harvester
node --env-file=../../.env scripts/cleanup-local-db.js                          # local only
HARVESTER_CLEAN_HORIZON=1 node --env-file=../../.env scripts/cleanup-local-db.js # + corpus facts
HARVESTER_DROP_HORIZON=1  node --env-file=../../.env scripts/cleanup-local-db.js # full teardown
```

Use the full teardown to start completely clean — for example to re-harvest after an
embed-input change, since the durable embed loop survives a schema drop and must be
cancelled for a fresh loop to pick up new settings. (The manual equivalent for the
graph is `LOAD 'age'; SET search_path = ag_catalog, "$user", public; SELECT
drop_graph('horizon_graph', true);`.)

## Related docs

- [Enhanced Facts & Knowledge Graph](../../docs/configuration.md#enhanced-facts--knowledge-graph-optional)
- [Facts table + graph model](../../docs/facts-table.md)
- Builder skill: `templates/builder-agents/skills/pilotswarm-knowledge-harvester/SKILL.md`
