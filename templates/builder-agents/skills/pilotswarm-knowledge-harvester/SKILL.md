---
name: pilotswarm-knowledge-harvester
description: "Use when an SDK or CLI app needs to ingest external sources into durable, searchable knowledge and an open knowledge graph. Covers enabling the EnhancedFactStore + GraphStore providers, authoring a harvester:true agent, the crawl→graph→reader flow, ACL/scopeKey evidence, and tests."
---

# PilotSwarm Knowledge Harvester

Scaffold a knowledge-harvesting capability into a PilotSwarm app: a `harvester: true`
agent that crawls sources into the durable facts store, builds an open knowledge
graph, and exposes multi-signal retrieval (lexical + semantic + hybrid) to reader
agents. This is an **optional, opt-in** capability layered on top of a normal SDK
app — it does not change the default `store_fact` / `read_facts` / `delete_fact`
surface every agent already has.

Use this skill alongside `pilotswarm-sdk-builder`. Author and version the generated
agent files per `pilotswarm-agent-versioning`.

## Canonical References

- Enhanced facts + graph config: `https://github.com/affandar/pilotswarm/blob/main/docs/configuration.md#enhanced-facts--knowledge-graph-optional`
- Facts table + graph model: `https://github.com/affandar/pilotswarm/blob/main/docs/facts-table.md`
- Worked sample app: `https://github.com/affandar/pilotswarm/tree/main/examples/horizon-harvester`
- Deploying a harvester as a service: `https://github.com/affandar/pilotswarm/blob/main/docs/harvester-deployment.md`
- Env vars: `https://github.com/affandar/pilotswarm/blob/main/.env.example` (`HORIZON_*` block)

## When To Use This Pattern

Reach for a harvester when the app needs to turn external or accumulated content
(docs, tickets, web pages, prior session observations) into **durable, queryable
knowledge** that other agents retrieve later — not just transient context inside one
session. If the app only needs simple key/value memory, the built-in facts tools are
enough; do **not** stand up the enhanced providers.

## Prerequisites: The Graph Store Is Mandatory

**The entire harvest surface keys off `!!graphStore`.** The crawl queue
(`facts_read_uncrawled` / `facts_mark_crawled`) and the graph-write tools
(`graph_upsert_*` / `graph_merge_nodes` / `graph_delete_*`) exist **only when a
GraphStore is configured** (`graphDatabaseUrl` / `HORIZON_GRAPH_DATABASE_URL`).
Without a graph store the `harvester: true` flag grants **nothing extra** — there is
no crawl queue and nowhere to harvest into. For this pattern a graph store is not
optional; it *is* the pattern.

The **fact store underneath the graph** can be either tier, and that choice decides
what *search* the harvester and readers also get:

| Fact store (with a graph store) | Harvester also gets | Readers also get |
|---|---|---|
| **Base `PgFactStore`** (plain Postgres, no extensions) | the privileged crawl queue | graph traversal + graph write |
| **EnhancedFactStore** (HorizonDB: pgvector + pg_textsearch + pg_durable) | `facts_search` / `facts_similar` for resolution | `facts_search` / `facts_similar` alongside graph traversal + graph write |

Read it as two independent decisions:

1. **GraphStore — required.** An open knowledge graph (Apache AGE, via
   `@pilotswarm/horizon-store`) of entities/edges anchored to fact `scopeKey`
   evidence. Lights up the graph read tools for everyone and the crawl/graph-write
   surface for the harvester role. The crawl queue itself is a **vanilla-Postgres**
   column on the base `FactStore` (no extension), so the harvest runs even when the
   facts live in plain Postgres — as long as a graph store is present.
2. **EnhancedFactStore — recommended, not required.** Multi-signal retrieval + a
   durable in-DB embedder on a HorizonDB (preview) cluster. Adds `facts_search` /
   `facts_similar` / `search_skills` on top. On a **base** fact store the harvest still
   runs, but neither the harvester nor readers get fact search — they navigate by graph
   topology alone, and entity resolution leans on `graph_search_nodes` name/alias
   matching rather than `facts_similar`.

Wire whichever tiers you use on the **worker** from the canonical `HORIZON_*` env
vars with the SDK helper. It returns `{}` when no `HORIZON_*` vars are set, so the same
code runs unchanged in default (PgFactStore, no graph) deployments:

```typescript
import { PilotSwarmWorker, horizonConfigFromEnv } from "pilotswarm-sdk";

const worker = new PilotSwarmWorker({
    store: process.env.DATABASE_URL,
    githubToken: process.env.GITHUB_TOKEN,
    // HORIZON_GRAPH_DATABASE_URL (REQUIRED to harvest) + HORIZON_DATABASE_URL
    // (enhanced facts, optional) + _EMBED_* + _*_SCHEMA
    ...horizonConfigFromEnv(),
});
```

The **client** and **management client** must resolve the **same** facts target as
the worker, or session cleanup hits the wrong database. Spread `horizonConfigFromEnv()`
into those too (the facts fields are accepted there; graph/embed are worker-only and
harmlessly ignored).

> **Schema-collision guard.** When the graph reuses the facts database URL, the
> `graphSchema` MUST differ from the facts schema — the worker fails fast on a
> collision. The defaults (`horizon_facts` vs `horizon_graph`) are already distinct.

> **Lexical-only fallback.** Omit the `HORIZON_EMBED_*` vars to run search in
> lexical-only mode. Semantic returns nothing for un-embedded facts and hybrid
> degrades to lexical — never an error. Add the embedder later without code changes.

## Three Roles

| Role | `harvester` frontmatter | Gets | Responsibility |
|------|------------------------|------|----------------|
| **Harvester** | `harvester: true` | crawl queue (`facts_read_uncrawled` / `facts_mark_crawled`) + graph reconciliation (`graph_remove_evidence`) + graph writes (`graph_upsert_node` / `graph_upsert_edge` / `graph_merge_nodes` / `graph_delete_node` / `graph_delete_edge`) | Crawl sources into a dedicated `corpus/*` (source-capture) namespace, build/reconcile the graph, mark facts crawled |
| **Reader** | (none) | `facts_search` / `facts_similar` + graph reads (`graph_search_nodes` / `graph_search_edges` / `graph_neighbourhood`) + graph writes (`graph_upsert_*` / `graph_merge_nodes` / `graph_delete_*`) | Retrieve knowledge; pivot fact↔graph; may also incorporate into the shared graph |
| **Facts Manager** | system agent (dormant) | crawl + graph writes, but **does not crawl** unless an operator explicitly asks | Curate `intake/*` (task-agent observations) into reusable skills |

The harvester role is **authoritative per turn** — the runtime derives it from the
agent's own `harvester: true` frontmatter on every turn (replay-safe, survives
hydration). It is **never inherited** through spawn: a harvester that spawns a child
does not make the child a harvester. Only agents whose own definition declares
`harvester: true` get the privileged **crawl queue** (`facts_read_uncrawled` /
`facts_mark_crawled`), which reads facts across all scopes. The **graph-write** tools
(`graph_upsert_*` / `graph_merge_nodes` / `graph_delete_*`) are **not** gated by the
harvester role — they are available to every session except the read-only `agent-tuner`,
because the knowledge graph is shared. A harvester is simply the agent that owns the
systematic crawl→graph loop.

> The table's `Gets` column shows the **enhanced fact store + graph** tier. The
> `facts_search` / `facts_similar` tools in the Reader and Harvester rows require the
> **enhanced** fact store; on a **base** fact store + graph those rows lose fact search
> and keep only the graph tools (see Prerequisites). The crawl queue and graph
> read/write tools are present on either fact tier, as long as a graph store exists.

## Harvester Agent Template

Drop this into the app's `plugin/agents/` and adapt the prose to the domain. The
load-bearing parts are `harvester: true` and the crawl→graph→mark loop.

```markdown
---
schemaVersion: 1
version: 1.1.0
name: source-harvester
description: Crawls <your sources> into durable facts and builds the knowledge graph.
harvester: true
id: source-harvester
title: Source Harvester
---

# Source Harvester

You ingest <sources> into durable, searchable knowledge and an open knowledge graph.
You are the ONLY role allowed to crawl and write graph nodes/edges — do this
deliberately and idempotently.

## Crawl Cycle

1. **Capture sources.** Write each raw source item as a fact under your own
   `corpus/<source>/...` namespace (NOT `intake/*` — see Boundaries). `scope: shared`.
2. **Pull the backlog.** `facts_read_uncrawled(namespace="corpus/<source>/", limit=20)`
  returns facts that have never been crawled, whose content changed since the last
  crawl, or that were soft-deleted. Each row carries a `scopeKey`, `etag`, and
  possibly `deletedAt`.
  - Live row (`deletedAt` missing/null): incorporate it into the graph.
  - Deleted row (`deletedAt` set): call `graph_remove_evidence(scopeKey, namespace)`
    to remove that fact's graph anchors/evidence, then include it in the mark batch.
3. **Resolve before you create (similarity search).** For each fact, use
   `facts_similar(scopeKey)` to find related captures and `graph_search_nodes(kind,
   nameLike)` to check whether an entity already exists. Reuse the existing node key
   (add an alias when the surface form differs) instead of creating a near-duplicate.
4. **Build the graph.** For each entity: `graph_upsert_node(...)` with the fact's
   `scopeKey` as evidence. For each relationship: `graph_upsert_edge(...)`. Upserts
   are idempotent — re-running the same crawl converges, it does not duplicate.
5. **Mark crawled.** `facts_mark_crawled` takes a `stamps` array of
  `{ scopeKey, etag }` from the exact rows you processed. A skipped stamp means the
  fact changed since your read, was already marked, or no longer exists; re-read
  before declaring the backlog empty.
6. Repeat until `facts_read_uncrawled` returns empty, then stop.

## Recurring Harvest

To crawl on a schedule, use a durable timer — never a wake-and-poll loop:
`cron(seconds=3600, reason="hourly source harvest")` for fixed intervals, or
`cron_at(minute=0, hour=2, tz="America/Los_Angeles", reason="nightly harvest")` for
wall-clock. Cancel with `cron(action="cancel")`.

## Boundaries

- Write raw captures under your own `corpus/<source>/...` namespace. Do NOT write
  `intake/*` — that is the Facts Manager's curation queue for short task-agent
  observations, not a place for source documents.
- Resolve before you create: a `graph_search_nodes` / `facts_similar` check first
  keeps the graph deduplicated.
- Do not delete graph nodes/edges unless reconciling a confirmed source deletion.
- For a confirmed source deletion, prefer `graph_remove_evidence(scopeKey,
  namespace)` over broad node/edge deletes; it removes only that fact's evidence and
  deletes graph entities that become evidence-less.
- Keep each crawl turn bounded; large backlogs drain across multiple cycles.
```

## Reader Agents

Reader (task) agents need **no** special frontmatter. When the providers are
configured, the runtime injects a knowledge-awareness prompt block and exposes the
read tools automatically:

- `facts_search(query, mode="hybrid")` — fused lexical + semantic retrieval. **Enhanced fact store only.**
- `facts_similar(scopeKey)` — semantic kNN of a known fact. **Enhanced fact store only.**
- `graph_search_nodes` / `graph_search_edges` / `graph_neighbourhood` — topology. Present whenever a graph store exists.
- `graph_stats` — graph size + crawl backlog health.

Teach readers to **pivot**: find a seed fact via `facts_search`, then expand its
neighbourhood in the graph, then resolve the evidence facts behind the nodes. On a
**base** fact store + graph there is no `facts_search` / `facts_similar`, so readers
seed and navigate by graph topology alone (`graph_search_nodes` → `graph_neighbourhood`).

## ACL & Evidence Model

- Facts carry a `scopeKey` and respect the same ownership/lineage ACL as
  `read_facts`. Graph **reads are evidence-filtered**: a caller only sees nodes/edges
  evidenced by a `scopeKey` they can access. Graph **topology is shared**, but
  evidence is not.
- Graph reads resolve the **same lineage** as `read_facts` for the calling session —
  there is no separate graph ACL to keep in sync.
- The `agent-tuner` system agent is strictly read-only across facts and graph, even
  if an app forges a harvester flag — the runtime strips all mutations for the tuner.

## Tests To Generate

- A DB-less gating test asserting the harvester agent gets crawl + graph-write tools
  and a non-harvester reader does **not** (model on the SDK's
  `enhanced-tool-gating.test.js`).
- An HDB-gated composition test (skip when `HORIZON_DATABASE_URL` is unset) that runs
  one crawl→graph→reader round trip end to end (model on the SDK's
  `enhanced-composition.integration.test.js`).

## Checklist

- [ ] `HORIZON_*` env documented in the app's `.env.example`; real values gitignored.
- [ ] Worker, client, and management client all spread `horizonConfigFromEnv()`.
- [ ] Exactly the harvester agent(s) declare `harvester: true`; readers do not.
- [ ] Recurring crawl uses `cron` / `cron_at`, not a polling loop.
- [ ] `facts_mark_crawled` passes the unmodified `{ scopeKey, etag }` receipt in `stamps`.
- [ ] Deleted crawl rows (`deletedAt` set) call `graph_remove_evidence` before marking.
- [ ] Gating + composition tests added; composition test auto-skips without HDB.
