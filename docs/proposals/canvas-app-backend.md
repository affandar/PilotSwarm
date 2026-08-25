# Giving a canvas app a backend

Companion to [interactive-canvas-apps.md](interactive-canvas-apps.md).

## The reframe

PilotSwarm already has a backend. Workers hold repo caches, ADO clients, Kusto,
SQL. The portal holds the facts store, the graph, the artifact store, the CMS.
Between them that is a substantial service surface.

**The problem is not that there is no backend. It is that the only way to
invoke it is an LLM turn.**

Today a page that wants a number asks the model to go get it: the request
becomes a user message, the model reads it, decides which tool to call, calls
it, and writes the answer back. The model is doing routing that a schema could
do — at seconds-to-minutes of latency and real token cost, for something a
query could answer in 30 ms.

So the question is narrower and much more tractable than "build a backend":
**how does a page invoke work deterministically, without waking the model?**

## Four tiers

| Tier | What the page gets | Executes where | New infrastructure | Effort |
|---|---|---|---|---|
| 1 · Query | live reads over PG-backed data | portal, existing transport | none | ~4 d |
| 2 · Tools | repo, ADO, Kusto | a new executor service | **a deployment** | weeks |
| 3 · Code | arbitrary app functions | a FaaS | a product | no |

Tier 1 needs no new services and covers most of what these apps want. Tier 2
is a real project. Tier 3 is a different product.

A "Tier 0" (a page reading precomputed artifact bytes through the host,
`canvas-fetch`) was drafted and **removed by decision on 2026-08-24**. Static
content a page needs is authored into the document or written into the KV by
the agent; see `interactive-canvas-apps.md` Part K.

## Tier 1 — query: declared bindings

The portal can already execute **~76 read-only operations** with no worker
involved. A sample of what is one binding away from the page:

```
facts:read     readFacts · searchFacts (hybrid semantic + lexical) · similarFacts
graph          searchGraphNodes · searchGraphEdges · graphNeighbourhood · graphStats
session:read   listArtifacts · downloadArtifact · getSessionEvents · getSessionMetricSummary
fleet:read     getFleetStats · getSharedFactsStats · getFleetRetrievalUsage
```

These are Postgres queries. They answer in tens of milliseconds. They are
exactly the "backend" a review board, a dashboard, or a triage app wants.

### The mechanism: prepared statements, not string concatenation

The app declares named queries in its manifest, and the platform executes them
with the page filling only the holes the agent left:

```jsonc
"queries": {
  "related_incidents": {
    "op": "searchFacts",
    "args": { "namespace": "icm", "scope": "shared", "mode": "hybrid",
              "limit": 20, "query": "$q" },     // ← only $q is a hole
    "params": { "q": "string" }
  },
  "finding_evidence": {
    "op": "readFacts",
    "args": { "key_pattern": "pr-review/2252148/%", "limit": "$limit" },
    "params": { "limit": "number" }
  }
}
```

```js
const hits = await kv.query("related_incidents", { q: "walfilter timeout" });
```

The analogy is exact and load-bearing: **the agent writes the prepared
statement, the page binds the parameters.** The page can never supply an
operation name, a key pattern, or a scope — only values into typed holes.

### Why this is safe

It reuses machinery that already exists and is already default-closed:

- **Declared or nothing.** No `queries` block, no backend. Same stance as
  `responseContract`.
- **Same normalizer.** The binding grammar validates through the same path as
  the response contract and the manifest — one grammar, one validator.
- **The agent vouches.** The agent authored the binding when it drew the
  canvas; that is the identical trust stance as `fromArtifact`.
- **Read-only ops only.** The allowlist contains no mutating operation. Writes
  stay on the `req/*` suggest-and-promote path, where the owner is in the loop.
- **Scope is pinned by the template.** `key_pattern` is hardcoded by the agent,
  not supplied by the page, so a link bearer cannot widen a query into a
  general-purpose fact reader.

### The authority question

A query runs with the **session's** authority, not the viewer's. A link bearer
calling `related_incidents` reads what Alice's session may read.

That is why the pinned template matters more here than anywhere else. Three
rules make it bounded:

1. Only ops on the read-only allowlist may be bound.
2. Every argument is either a literal the agent wrote or a typed, validated
   parameter — never a page-supplied field name, pattern, or scope.
3. Results are capped (rows and bytes) and rate limited per connection, the
   same shape as KV writes.

An app that needs to expose *less* than the session can read should query
KV values the agent prepared rather than binding a live query.

### Cost

| Piece | Effort |
|---|---|
| Manifest `queries` grammar + normalizer | ~0.5 d |
| Binding validation and parameter substitution | ~0.5 d |
| Dispatch to the read-only op allowlist | ~1 d |
| postMessage channel + `kv.query()` helper | ~0.5 d |
| Rate limits, result caps, authz tests | ~1.5 d |

About **four days** for "the canvas gets a real backend" — because the backend
is already running and this is a safe doorway into it.

## Tier 2 — worker tools, and the cheaper substitute

repo-cache, `ado_rest` and Kusto live on workers, with worker credentials and
worker disk. They are not reachable from the portal.

Making them synchronously callable means either a worker ingress — which
[canvas-data-plane.md](canvas-data-plane.md) explicitly rejected, because
*"sessions are nomadic and workers get rolled; every migration would
re-handshake every viewer"* — or a new stateless tool-executor deployment with
its own credentials, duplicating worker tool code. That is weeks of work plus a
new operational surface, and it puts a second thing in front of ADO.

**Do not build it. Cache instead.**

The agent is already the executor. Let it fill a cache the page reads from
the KV:

```
1. Page asks for something not precomputed
       → req/<rid> { op: "expand", args: {...} }          (queued; owner-promoted if a collaborator asked)
2. Agent wakes, runs the worker tool, writes the answer into the KV
       → app/callers/foo  (≤16 KB; larger results become an artifact the page LINKS to)
3. Every viewer sees the key land live                    ~50 ms
4. Every later reader — and a regenerated session — finds it already there
```

First call is slow and costs a turn. Every subsequent read is free and
instant. For a review board, where the same item gets opened by several people
over several days, the hit rate is high and the miss is survivable.

**The agent is the cache-fill; the KV is the cache.** That is Tier 2's value
without a service.

## Tier 3 — arbitrary app code

Shipping executable app functions means sandboxing, resource limits, deploy,
versioning, secrets, multi-tenancy, and an abuse story. That is a serverless
platform, not a canvas feature.

The honest escape hatch already exists: a canvas may link out
(`<a target="_blank">` works; popups are allowed). **An app that genuinely
needs arbitrary server code is a web app, and should be one.** The canvas is
then the launcher and the live status board for it — which is a perfectly good
role and much less work than pretending otherwise.

## What to build

1. **Tier 1 first**, after the KV has been exercised. Four days, no new
   services, and it turns the portal's existing 76 read ops into an app
   platform.
2. **Tier 2 never, as stated.** Ship the cache-fill pattern instead and
   revisit only if a measured miss rate justifies a service.
3. **Tier 3 out of scope.** Link out.

## What this does not change

The three lanes stand. The KV is still small mutable shared state; artifacts
are still large immutable payload; `req/*` is still how anything gets *written*
or *thought about*, with the owner in the loop.

A backend adds one thing: **reads that do not cost a turn.** Everything that
mutates state, spends tokens, or touches the outside world keeps going through
the agent, because that is where the judgement and the accountability live.
