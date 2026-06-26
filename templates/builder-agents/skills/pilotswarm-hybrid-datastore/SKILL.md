---
name: pilotswarm-hybrid-datastore
description: "Use when a PilotSwarm app needs stock PostgreSQL for runtime storage plus HorizonDB for enhanced facts, semantic/lexical search, and the knowledge graph. Covers env topology, horizonConfigFromEnv wiring, harvester agents, Azure secret/resource guidance, and the rule that Docker defaults remain stock Postgres."
---

# PilotSwarm Hybrid Datastore

Use this skill when an app needs the production hybrid topology:

- **Runtime store:** stock PostgreSQL via `DATABASE_URL` for Duroxide state,
  CMS/session catalog, ordinary facts fallback, and default Docker/local runs.
- **Enhanced facts store:** HorizonDB via `HORIZON_DATABASE_URL` for lexical,
  semantic, and hybrid fact search.
- **Graph store:** HorizonDB via `HORIZON_GRAPH_DATABASE_URL` for the open
  knowledge graph and harvester crawl receipts.

This is an opt-in provider configuration. It does **not** require a custom
PilotSwarm Docker image. The starter/local Docker path should continue to run on
stock PostgreSQL by default unless the user explicitly asks for a HorizonDB
environment.

## Canonical References

- Configuration guide: `https://github.com/affandar/pilotswarm/blob/main/docs/configuration.md#enhanced-facts--knowledge-graph-optional`
- Horizon Harvester sample: `https://github.com/affandar/pilotswarm/tree/main/examples/horizon-harvester`
- Harvester deployment guide: `https://github.com/affandar/pilotswarm/blob/main/docs/harvester-deployment.md`
- Horizon provider package: `https://github.com/affandar/pilotswarm/tree/main/packages/horizon-store`
- Environment examples: `.env.example` and `.env.horizondb.example`

## Provider Slots

Keep the slots separate in app code, env templates, docs, and deployment assets:

| Slot | Env | Provider | Purpose |
| --- | --- | --- | --- |
| Runtime | `DATABASE_URL` | stock PostgreSQL | Duroxide orchestration state, CMS/session catalog, runtime facts fallback |
| Enhanced facts | `HORIZON_DATABASE_URL` | HorizonDB | `facts_search`, `facts_similar`, durable embed loop |
| Graph | `HORIZON_GRAPH_DATABASE_URL` | HorizonDB | graph namespaces, graph read/write tools, harvester crawl receipts |

`DATABASE_URL` remains mandatory for PilotSwarm runtime storage. HorizonDB does
not replace it. When no `HORIZON_*` vars are present, the same app should still
start with stock PostgreSQL and no enhanced facts/graph tools.

## Worker, Client, And Management Wiring

For SDK apps, wire the same Horizon facts target into worker, client, and
management client by spreading `horizonConfigFromEnv()` everywhere the runtime
accepts storage/provider options:

```ts
import {
  PilotSwarmClient,
  PilotSwarmManagementClient,
  PilotSwarmWorker,
  horizonConfigFromEnv,
} from "pilotswarm-sdk";

const store = process.env.DATABASE_URL;
const horizon = horizonConfigFromEnv();

const worker = new PilotSwarmWorker({
  store,
  githubToken: process.env.GITHUB_TOKEN,
  ...horizon,
});

const client = new PilotSwarmClient({ store, ...horizon });
const management = new PilotSwarmManagementClient({ store, ...horizon });
```

The client/management paths ignore worker-only graph/embed settings safely, but
they must agree on the facts target so cleanup, lineage reads, and management
diagnostics do not hit the wrong database.

## Env Template Guidance

For normal local and starter-Docker scaffolds, keep `.env.example` stock-PG first:

```env
DATABASE_URL=postgres://postgres:postgres@localhost:5432/pilotswarm
GITHUB_TOKEN=
```

Add a separate optional hybrid block or `.env.horizondb.example` for HorizonDB:

```env
# Runtime store: stock PostgreSQL
DATABASE_URL=postgres://postgres:postgres@localhost:5432/pilotswarm

# Enhanced facts/search store: HorizonDB
HORIZON_DATABASE_URL=postgres://<user>:<pass>@<horizon-host>:5432/<db>?sslmode=require
HORIZON_FACTS_SCHEMA=horizon_facts

# Graph store: HorizonDB
HORIZON_GRAPH_DATABASE_URL=postgres://<user>:<pass>@<horizon-host>:5432/<db>?sslmode=require
HORIZON_GRAPH_SCHEMA=horizon_graph

# Optional durable embed loop
HORIZON_EMBED_ENDPOINT=
HORIZON_EMBED_MODEL=text-embedding-3-small
HORIZON_EMBED_DIM=1536
HORIZON_EMBED_API_KEY=
```

The facts and graph schemas must be distinct when they share one HorizonDB
database. The defaults `horizon_facts` and `horizon_graph` are intentionally
separate.

## Harvester Agent Pattern

When the app needs durable source ingestion, consult `pilotswarm-knowledge-harvester`
and generate a `plugin/agents/<source>-harvester.agent.md` with:

```yaml
---
schemaVersion: 1
version: 1.1.0
name: source-harvester
description: Crawls source documents into durable facts and the graph.
crawler: true
---
```

Load-bearing rules:

- Harvester agents write raw source captures under `corpus/<source>/...`, not
  `intake/*`.
- Graph store is required for the harvester crawl queue and graph tools.
- Enhanced facts are recommended for `facts_search` / `facts_similar`, but graph
  crawl and reconciliation can run with base facts plus graph.
- Harvester cycles must mark crawl receipts with the exact `{ scopeKey, etag }`
  values returned by `facts_read_uncrawled`.
- Deleted crawl rows (`deletedAt`) must call `graph_remove_evidence(scopeKey,
  namespace)` before marking crawled.
- Recurring harvests use `cron` / `cron_at`, never a hand-rolled polling loop.

## Azure / AKS Guidance

For Azure deployments, document and validate two database targets:

1. Runtime PostgreSQL (`DATABASE_URL`): ordinary Azure Database for PostgreSQL or
   another stock PostgreSQL-compatible service.
2. HorizonDB (`HORIZON_DATABASE_URL` / `HORIZON_GRAPH_DATABASE_URL`): enhanced
   facts/search and graph. This may be one HorizonDB cluster with separate
   schemas, or separate clusters when the user wants stronger isolation.

Kubernetes secret guidance should include both runtime and optional Horizon vars,
using `kubectl create secret generic ... --from-env-file=.env.remote` when values
contain shell-significant delimiters. If HorizonDB is unavailable or its required
extensions are not allow-listed, the worker can still deploy against stock
PostgreSQL; enhanced facts, graph tools, and harvester agents remain disabled.

## Docker Constraint

Do not change Dockerfiles or the starter image just to support the hybrid store.
The shipped image should continue to boot with stock PostgreSQL. Hybrid mode is
selected by env/provider configuration at runtime.

## Checklist

- [ ] `DATABASE_URL` documented as runtime stock PostgreSQL.
- [ ] `HORIZON_DATABASE_URL` documented only for enhanced facts/search.
- [ ] `HORIZON_GRAPH_DATABASE_URL` documented only for graph/harvester crawl.
- [ ] Worker, client, and management client spread `horizonConfigFromEnv()`.
- [ ] Harvester/crawler agent has `crawler: true` and source-specific corpus namespace.
- [ ] Azure secret docs include both runtime and Horizon vars.
- [ ] Docker/starter docs still default to stock PostgreSQL.