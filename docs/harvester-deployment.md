# Deploying a Knowledge Harvester

This guide covers running a **harvester** — an agent that ingests external sources
into PilotSwarm's durable, searchable knowledge store and open knowledge graph — as a
deliberately-operated service. It complements the
[`pilotswarm-knowledge-harvester` builder skill](../templates/builder-agents/skills/pilotswarm-knowledge-harvester/SKILL.md)
and the worked [Horizon Harvester sample](../examples/horizon-harvester/README.md).

If you are new to the harvester pattern, read those two first. This guide is about
**topology and operations** once you want harvesting to run continuously rather than as
a one-off demo.

## When to run a dedicated harvester

Reach for a dedicated harvester service when:

- ingestion is **continuous or scheduled** (crawling on a cron), not a single batch;
- the crawl workload is **long-running and I/O-heavy** (graph writes, embedder calls)
  and you do not want it competing with interactive agent turns;
- you want ingestion to have its **own failure domain and scaling** independent of the
  app your users talk to.

If you only need occasional ingestion, you do **not** need a separate service — enable
the providers on your normal fleet (Topology A below) and run the harvester agent
there.

## The shared-knowledge model

The key idea: **the knowledge store is shared; the orchestration store is not.**
PilotSwarm resolves four targets independently (see
[Configuration → Enhanced Facts & Knowledge Graph](./configuration.md#enhanced-facts--knowledge-graph-optional)):

| Target | Config | What lives there |
|--------|--------|------------------|
| Orchestration / CMS | `store` (`DATABASE_URL`) | duroxide history, session catalog — **per app** |
| Enhanced facts | `enhancedFactsDatabaseUrl` (`HORIZON_DATABASE_URL`) | facts + embeddings on HorizonDB — **shareable** |
| Knowledge graph | `graphDatabaseUrl` (`HORIZON_GRAPH_DATABASE_URL`) | entities/edges (Apache AGE) — **shareable** |

> **A graph store is what enables harvesting.** The crawl queue and graph-write tools
> key off `!!graphStore` — without `HORIZON_GRAPH_DATABASE_URL` the `harvester: true`
> role grants nothing to harvest with. The enhanced facts target is **recommended but
> not required**: on a base fact store the harvest still runs (the crawl queue is plain
> Postgres, no extension), but agents lose `facts_search` / `facts_similar` and
> navigate by graph topology alone. See the builder skill's
> [Prerequisites](../templates/builder-agents/skills/pilotswarm-knowledge-harvester/SKILL.md)
> for the full capability matrix.

A harvester writes **`shared`-scope** facts (`shared:<key>`) and **shared graph
topology** to HorizonDB. Any worker — in the same app or a different one — that points
its `HORIZON_*` env at the **same HorizonDB schemas** sees that knowledge. Session
cleanup only ever touches per-app session-scoped facts (`session:<sessionId>:<key>`,
keyed by GUID), so a harvester service and a reader app can safely share one HorizonDB
without stepping on each other.

```text
        ┌────────────────────────────────────────────────────────┐
        │            HorizonDB  (shared knowledge store)          │
        │   horizon_facts.*  (facts + embeddings)                 │
        │   horizon_graph.*  (entities / edges, AGE)              │
        └────────────────────────────────────────────────────────┘
              ▲ writes shared facts + graph        ▲ reads (search + graph)
              │                                     │
   ┌──────────┴───────────┐            ┌────────────┴─────────────┐
   │  Harvester service   │            │   Reader app(s)          │
   │  own DATABASE_URL    │            │   own DATABASE_URL       │
   │  harvester: true     │            │   reader agents          │
   │  crawl → graph → mark│            │   facts_search + graph   │
   └──────────────────────┘            └──────────────────────────┘
```

## Topology choices

### Topology A — one HorizonDB-enabled fleet (simplest)

Enable the providers on your normal worker fleet. Every worker can then run both the
harvester agent and reader agents, because they all share one orchestration store and
one HorizonDB.

- **Pro:** nothing new to deploy — just add the `HORIZON_*` env to your existing
  workers and ship a `harvester: true` agent in your plugin.
- **Con:** no workload isolation. PilotSwarm workers in a single fleet are
  **homogeneous** — they all poll the same orchestration store and any worker may pick
  up any session (with warm-pod affinity for `runTurn`). There is **no per-agent queue
  partitioning**, so you cannot pin harvester turns to specific pods. A heavy crawl can
  occupy pods that would otherwise serve interactive turns.

Use Topology A unless crawl volume is large enough to warrant isolation.

### Topology B — dedicated harvester service + shared HorizonDB

Run the harvester as its **own PilotSwarm deployment** with its **own**
`DATABASE_URL` (orchestration + CMS), pointed at a **shared** HorizonDB. Your
user-facing app keeps its own `DATABASE_URL` and points its `HORIZON_*` at the same
HorizonDB for reads.

- **Pro:** true isolation. The crawl fleet scales, fails, and restarts independently;
  interactive latency is unaffected by ingestion load. Because the two deployments have
  **separate orchestration stores**, they never pick up each other's sessions — the
  isolation duroxide does not give you *within* a fleet, you get *between* deployments.
- **Con:** two deployments to operate, and facts/CMS are not transactionally
  consistent across stores (already true for any split-facts deployment where
  `cmsFactsDatabaseUrl` or `enhancedFactsDatabaseUrl` differs from `store`).

Topology B is the "dedicated harvester worker as its own service" model. The rest of
this guide assumes it; Topology A is the same configuration minus the second
deployment.

## Configuring the harvester service

The harvester service is an ordinary PilotSwarm worker (the standalone entrypoint at
[`packages/sdk/examples/worker.js`](../packages/sdk/examples/worker.js), or your own)
plus three things:

**1. Its own orchestration store + the shared HorizonDB env.** The standalone worker
and the CLI/portal embedded workers auto-wire the providers from `HORIZON_*` via
`horizonConfigFromEnv()`, so you only set env:

```bash
# Per-app orchestration + CMS (NOT shared with the reader app)
DATABASE_URL=postgres://…/harvester_orch
GITHUB_TOKEN=…

# Shared knowledge store (SAME values in the reader app)
HORIZON_DATABASE_URL=postgres://…@my-horizondb…/postgres?sslmode=require
HORIZON_GRAPH_DATABASE_URL=postgres://…@my-horizondb…/postgres?sslmode=require
HORIZON_FACTS_SCHEMA=horizon_facts        # optional; default horizon_facts
HORIZON_GRAPH_SCHEMA=horizon_graph        # AGE graph name; default horizon_graph — MUST differ from facts schema
HORIZON_GRAPH_REGISTRY_SCHEMA=horizon_graph_registry  # optional; default ${HORIZON_GRAPH_SCHEMA}_registry
HORIZON_NAMESPACE_CACHE_TTL_MS=60000       # optional namespace-list cache; 0 disables

# Embedder — REQUIRED for semantic/hybrid; omit ⇒ lexical-only (see Operating)
HORIZON_EMBED_URL=https://…/embeddings
HORIZON_EMBED_MODEL=text-embedding-3-small
HORIZON_EMBED_DIM=1536
HORIZON_EMBED_API_KEY=…
```

> **Schema-collision guard.** When the graph reuses the facts database URL, the graph
> schema MUST differ from the facts schema — AGE's `create_graph()` makes a PG schema
> named after the graph, and a collision corrupts both. The defaults
> (`horizon_facts` vs `horizon_graph`) are already distinct; the worker fails fast on a
> collision.

**2. A `harvester: true` agent in the plugin.** The crawl-queue tools
(`facts_read_uncrawled` / `facts_mark_crawled`) appear only when **both** the graph
store is configured (`HORIZON_GRAPH_DATABASE_URL`) **and** the session's own agent
declares `harvester: true`. The graph-write tools (`graph_upsert_node` /
`graph_upsert_edge` / `graph_merge_nodes` / `graph_delete_*`) need only the graph store
— they are available to **every** session except the read-only `agent-tuner`, because
the knowledge graph is shared. The harvester role is derived per turn from the resolved
agent — it is **not** granted by a `tools:` list and is **not** inherited when a
harvester spawns a non-harvester child; what it uniquely unlocks is the privileged crawl
queue. Model the agent on the sample's
[`source-harvester.agent.md`](../examples/horizon-harvester/plugin/agents/source-harvester.agent.md).

**3. A recurring crawl schedule.** Drive the crawl with a durable timer, never a
wake-and-poll loop:

```text
cron(seconds=3600, reason="hourly source harvest")
cron_at(minute=0, hour=2, tz="America/Los_Angeles", reason="nightly harvest")
```

The harvester wakes on its timer, drains `facts_read_uncrawled` into the graph, marks
each processed row crawled with its exact `{ scopeKey, etag }` receipt, and returns
dormant. Live rows are incorporated into the graph. Soft-deleted rows (`deletedAt`
set) are reconciled with `graph_remove_evidence(scopeKey, namespace)` before marking,
so only that source fact's graph anchors/evidence are removed.

**Where should a harvester write its raw captures?** Use a dedicated namespace like
`corpus/<source>/...` for source documents — it is the harvester's own input corpus.
Do **not** write `intake/*`: that namespace is the system **Facts Manager**'s curation
queue for short task-agent observations, which it triages into reusable skills. A
harvester that dumps source documents into `intake/*` pollutes that queue. The two
pipelines are independent: the harvester builds the graph from its `corpus/*` captures;
the Facts Manager curates `intake/*` observations into skills. If you do want the
Facts Manager running alongside a harvester deployment, enable the management agents on
whichever deployment should own curation (harvester service or reader app — pick one).

## Configuring reader apps

Reader agents need **no** special frontmatter. Point the reader deployment's
`HORIZON_*` at the **same** HorizonDB schemas and the runtime injects the
knowledge-awareness prompt and exposes the read tools (`facts_search`, `facts_similar`,
`graph_search_nodes`, `graph_neighbourhood`, `graph_stats`) automatically. The
CLI and portal wire this for you through `horizonConfigFromEnv()`.

> **The embedder gotcha — set `HORIZON_EMBED_*` on readers too.** Query-time embedding
> for `facts_search(mode="semantic"|"hybrid")` happens **worker-side**: the reader's
> worker embeds the query string before the vector search. A reader deployment **without
> `HORIZON_EMBED_*` silently degrades semantic/hybrid search to lexical-only** — no
> error, just worse recall. This is separate from the write-path embedder (below). Use
> the **same** endpoint, model, and `dim` everywhere, or query and stored vectors will
> not be comparable.

## Deploying

The harvester service deploys exactly like any other PilotSwarm worker — see
[Deploying To AKS](./deploying-to-aks.md) for the full mechanics. The only differences
are its own `DATABASE_URL` and the `HORIZON_*` env. Put the HorizonDB connection
strings and the embedder key in the deployment's secret (the worker manifest pulls env
via `envFrom: secretRef`), and ship the harvester plugin via `PLUGIN_DIRS`:

```yaml
# Harvester worker deployment (sketch — resolve names from your env, do not hardcode)
spec:
  replicas: 2                      # scale for crawl throughput, independent of the app
  template:
    spec:
      containers:
        - name: harvester
          image: <registry>/<app>-harvester:latest
          env:
            - name: PLUGIN_DIRS
              value: "/app/plugins/harvester"
          envFrom:
            - secretRef:
                name: <app>-harvester-secrets   # DATABASE_URL, GITHUB_TOKEN, HORIZON_*
```

Build images for the cluster's architecture (`docker buildx build --platform
linux/amd64` for AMD64 AKS nodes — see the
[Docker/AKS build convention](./deploying-to-aks.md)).

## Operating

**Two embedders, one of which is shared.** Keep these straight:

- **Write-path embedder** — a single eternal in-DB loop inside HorizonDB
  (`pg_durable`), advisory-locked to **one loop per facts schema across the whole
  fleet**. Any worker configured with `HORIZON_EMBED_*` + the enhanced store starts it
  idempotently on boot; worker shutdown intentionally does **not** stop it (it is a
  shared durable resource). You do not pick "who runs it" — just configure the same
  endpoint everywhere.
- **Query-path embedder** — worker-side, per request, on whichever deployment runs the
  search (see the reader gotcha above).

**Lexical-only fallback is always safe.** Omit `HORIZON_EMBED_*` to run search in
lexical (BM25) mode. Semantic returns nothing for un-embedded facts and hybrid degrades
to lexical — never an error. You can add the embedder later without code changes; the
in-DB loop backfills embeddings for existing facts.

**Embedding failures do not block the queue.** If the array batch fails, the
embedder marks those facts with its internal retry marker and retries them one
row at a time. A row that still fails gets an internal `last_embed_error` and is
skipped by the embedder until its content changes. Rewriting or summarizing a
failed fact with `store_fact` clears the internal error and requeues it for
normal batched embedding.

**Watch crawl-backlog health.** `graph_stats` reports graph size and the uncrawled
backlog. A backlog that only grows means the harvester is not keeping up — increase its
crawl frequency or replica count, or widen each crawl's `facts_read_uncrawled(limit=…)`.

**Run compatible store versions.** All services sharing a HorizonDB run the
`@pilotswarm/horizon-store` migrations against the shared schema (advisory-locked, so
concurrent init is safe). Keep the harvester and reader deployments on compatible
store versions so their migrations converge.

## Checklist

- [ ] Harvester deployment has its **own** `DATABASE_URL`; `HORIZON_*` points at the
      **shared** HorizonDB.
- [ ] Reader app's `HORIZON_*` (including `HORIZON_EMBED_*`) matches the harvester's —
      same schemas, same embedding endpoint/model/dim.
- [ ] Exactly the harvester agent declares `harvester: true`; readers do not.
- [ ] `HORIZON_GRAPH_SCHEMA` differs from `HORIZON_FACTS_SCHEMA` when sharing one DB.
- [ ] `HORIZON_GRAPH_REGISTRY_SCHEMA` differs from `HORIZON_GRAPH_SCHEMA` (AGE owns the graph schema).
- [ ] Recurring crawl uses `cron` / `cron_at`, not a polling loop.
- [ ] One deployment owns Facts-Manager curation of `intake/*`.
- [ ] Images built for the target node architecture.

## Related

- [Horizon Harvester sample](../examples/horizon-harvester/README.md) — runnable end-to-end
- [`pilotswarm-knowledge-harvester` builder skill](../templates/builder-agents/skills/pilotswarm-knowledge-harvester/SKILL.md)
- [Configuration → Enhanced Facts & Knowledge Graph](./configuration.md#enhanced-facts--knowledge-graph-optional)
- [Facts table + graph model](./facts-table.md)
- [Deploying To AKS](./deploying-to-aks.md)
