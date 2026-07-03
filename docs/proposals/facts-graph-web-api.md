# Facts & Graph Web API

> **Status:** Implemented (2026-07-02)
> **Date:** 2026-07-02
> **Goal:** Give the PilotSwarm Web API a supported data-plane for the fact
> store and graph store, mirroring the SDK store contracts, so that remote
> callers — the MCP server first — can read/write facts and query the graph
> without a direct database connection. Completes the "no client holds DB
> credentials" story that [pilotswarm-web-api](./pilotswarm-web-api.md) began
> for sessions.
> **Builds on:** [pilotswarm-web-api](./pilotswarm-web-api.md) (implemented) —
> the operations table, generated routes, and web provider seam.
> **As-built:** the exact routes are generated from the operations table — see
> [docs/api/reference.md](../api/reference.md). One deviation from the sketch
> below: structured deletes use `POST …/delete` (facts, graph nodes/edges)
> rather than `DELETE` with a body, since DELETE bodies are unreliable across
> HTTP stacks and would break the "DELETE carries no body" table invariant.

---

## Summary

The Web API today exposes sessions, management, models, and artifacts, plus
facts/graph **statistics** (counts and bytes for the inspector/admin panes).
It does **not** expose the facts/graph **data-plane** — `readFacts` /
`storeFact` / `deleteFact` / `searchFacts` and the graph node/edge/namespace
operations. Those are methods on `FactStore` / `EnhancedFactStore` /
`GraphStore` (`packages/sdk/src/facts-store.ts`, `graph-store.ts`), reachable
today only by:

1. **agent tools in-turn** (`createFactTools`, `createGraphTools`), or
2. **constructing a store directly from a Postgres URL** via
   `createFactStoreForUrl` / `createGraphStoreForUrl`.

Path 2 is exactly the direct-database exposure that
[pilotswarm-web-api](./pilotswarm-web-api.md) removed for sessions. The MCP
server (`packages/mcp-server`) is its canonical consumer: its whole job is
`ctx.facts.readFacts/storeFact/deleteFact`, so it still requires a
`DATABASE_URL` and trusted server-side placement. It cannot move to the Web
API (and therefore cannot be Entra-gated) until the data-plane exists over
HTTP.

This proposal adds that data-plane as a **curated mirror** of the store
contracts, plus two isomorphic web store classes (`WebFactStore`,
`WebGraphStore`) that **implement the existing `FactStore` / `GraphStore`
interfaces** over `pilotswarm-api-client`. Because consumers are typed against
those interfaces, they gain web mode transparently — the MCP server's
`ctx.facts` becomes a `WebFactStore` under `--api-url` and every facts tool and
resource works unchanged.

---

## Background: the store layering

Two orthogonal axes, not one stack (see `facts-store.ts` / `graph-store.ts`):

- **`FactStore`** — the base contract the runtime programs to. Default
  implementation `PgFactStore` (plain Postgres).
- **`EnhancedFactStore extends FactStore`** — a strict superset adding
  retrieval: `searchFacts` (lexical | semantic | hybrid), `similarFacts`, the
  durable embedder loop, and a `capabilities` descriptor. Implementation
  `HorizonDBFactStore` (pgvector/HorizonDB). The runtime holds a base
  `FactStore` and narrows to enhanced at boot via `isEnhancedFactStore(store)`;
  calling a search method on a base store throws `EnhancedFactsUnsupportedError`.
- **`GraphStore`** — a genuinely separate interface (nodes/edges/namespaces).
  The code is explicit that graph is **not** part of `EnhancedFactStore`;
  it has its own `isGraphStore` guard. Implementation `HorizonDBGraphStore`
  (AGE-backed).

So "enhanced" is an optional *capability of the fact store*, and "graph" is a
*second store*. HorizonDB provides both; a plain-PG deployment provides
neither. The API must make this capability detection remote (see
`/facts/capabilities` below) rather than assume one deployment shape.

---

## Non-Goals

- **Per-user / per-session access control for facts.** `readFacts` carries an
  `AccessContext` (shared vs session-scoped visibility). This proposal keeps
  today's binary admission model: any admitted principal can reach shared
  facts, consistent with the portal. The one hard requirement (see Security)
  is that the server **derives** the access context from the authenticated
  principal and never trusts a client-supplied one — leaving a clean seam for
  a future scoping design. Designing that scoping model is out of scope.
- **Exposing crawler/sweeper/session-lifecycle internals** (`readUncrawledFacts`,
  `setFactsCrawled`, `purgeExpiredFacts`, `deleteSessionFactsForSession`).
  These are in-cluster system-agent machinery; mirroring them would freeze
  internal mechanics into a versioned contract for no consumer benefit.
- **A new auth provider.** The MCP server reuses the existing Entra stack; only
  the *credential acquisition* differs for a headless process (see MCP Auth).
- **Removing direct store construction.** `createFactStoreForUrl` /
  `createGraphStoreForUrl` remain for workers, the portal host, and internal
  testing — demoted to internal, like direct `{ store }`, not deleted.

---

## Tiered surface

The store interfaces mix three kinds of methods. Only the data-plane is public
unconditionally; operational methods are admin-gated; internals stay off the
API.

### Tier 1 — data-plane (any admitted caller)

Facts:

```text
GET    /api/v1/facts                    readFacts — query params mirror ReadFactsQuery
                                        (keyPattern, scopeKeys[], tags[], sessionId,
                                         agentId, limit, scope=accessible|shared|session|descendants)
POST   /api/v1/facts                    storeFact — body is StoreFactInput or StoreFactInput[]
                                        (key, value, tags?, shared?, agentId?, sessionId?)
DELETE /api/v1/facts                    deleteFact — body is DeleteFactInput
                                        (key, pattern?, scope=session|shared|all, shared?, sessionId?)
POST   /api/v1/facts/search             searchFacts(query, opts, mode)      [enhanced only]
POST   /api/v1/facts/similar            similarFacts(scopeKey, opts)         [enhanced only]
GET    /api/v1/facts/capabilities       { facts: true, enhanced, searchModes[], embedder, graph }
```

Graph:

```text
GET    /api/v1/graph/namespaces                 listGraphNamespaces / getGraphNamespace
POST   /api/v1/graph/nodes/search               searchGraphNodes(GraphNodeQuery)
POST   /api/v1/graph/edges/search               searchGraphEdges(GraphEdgeQuery)
POST   /api/v1/graph/neighbourhood              graphNeighbourhood(nodeKey, depth, opts)
POST   /api/v1/graph/nodes                      upsertGraphNode
POST   /api/v1/graph/edges                      upsertGraphEdge
DELETE /api/v1/graph/nodes/:nodeKey             deleteGraphNode
DELETE /api/v1/graph/edges                      deleteGraphEdge (body: from, to, predicateKey)
GET    /api/v1/graph/stats                      graphStats
```

Notes:
- **`/facts/capabilities` is the keystone.** It is `isEnhancedFactStore` /
  `isGraphStore` made remote. A plain-PG deployment returns
  `enhanced: false, graph: false`; clients feature-detect instead of guessing.
  `searchFacts` against a base store maps `EnhancedFactsUnsupportedError` to a
  clean `409 FACTS_ENHANCED_UNSUPPORTED` envelope, not a 500.
- **Reads are GET with query params; searches and writes are POST** with a JSON
  body (structured queries and values do not fit query strings). This is a
  deliberate, small deviation from "GET carries no body" — search is a read but
  its query object is a body. The operations table already supports `json`
  query params; searches use a body for ergonomics and size.
- Batch `storeFact` rides the store's existing single-or-array overload.

### Tier 2 — operational (admin-gated)

Introduces the API's **first per-route role check** (`req.auth.authorization.role
=== "admin"`), which is justified for fleet-operational actions and uses the
role already resolved by the authz engine but currently unenforced per-route.

```text
GET    /api/v1/facts/embedder                   embedderStatus                        [enhanced]
POST   /api/v1/facts/embedder/start             startEmbedder                          [enhanced, admin]
POST   /api/v1/facts/embedder/stop              stopEmbedder                           [enhanced, admin]
POST   /api/v1/facts/embedder/configure         configureEmbedder                      [enhanced, admin]
POST   /api/v1/facts/purge                       forcePurgeFacts                        [admin]
POST   /api/v1/graph/namespaces                  upsertGraphNamespace                   [admin]
DELETE /api/v1/graph/namespaces/:namespace       deleteGraphNamespace / archive         [admin]
```

`embedderStatus` (read) is available to any admitted caller; the mutating
embedder controls and purge/namespace-delete are admin-only.

### Tier 3 — internal, not mirrored

`readUncrawledFacts`, `setFactsCrawled`, `purgeExpiredFacts`,
`deleteSessionFactsForSession`, `removeGraphEvidence`, `mergeGraphNodes`.
Crawler/sweeper/session-lifecycle machinery driven by in-cluster system agents.
Not exposed.

---

## Architecture: mirror the interfaces, both directions

The value multiplies because both server and client mirror the *same*
interfaces the runtime already uses.

### Server

1. **Management client owns the stores.** `PilotSwarmManagementClient` already
   constructs the correctly-configured `_factStore` (used for stats and
   session cleanup — `management-client.ts:410`). Add a `_graphStore` built the
   same way, and expose thin data-plane methods (`readFacts`, `storeFact`,
   `deleteFact`, `searchFacts`, `similarFacts`, `factsCapabilities`, and the
   graph equivalents) that delegate to the stores with a server-derived
   `AccessContext`.
2. **Transport + runtime dispatch.** Thin `NodeSdkTransport` delegations →
   `PortalRuntime.call` cases → routes generated from new operations-table
   entries. The handler layer stays boring — `runtime.call` remains the single
   behavior point, exactly as for sessions.
3. **Capability + error mapping.** The runtime narrows with
   `isEnhancedFactStore` / `isGraphStore`; unsupported calls return
   `409 FACTS_ENHANCED_UNSUPPORTED` / `409 GRAPH_UNSUPPORTED` envelopes.

### Client (the elegant half)

Implement **`WebFactStore implements FactStore` (and `EnhancedFactStore` when
the deployment advertises it)** and **`WebGraphStore implements GraphStore`**,
both over `ApiClient`, in `pilotswarm-api-client` (or a small `pilotswarm-sdk`
web module — see Open Questions). Because they implement the existing
interfaces:

- The **MCP server** changes in one place: its context builder constructs
  `WebFactStore(apiClient)` instead of `createFactStoreForUrl(store)` when
  `--api-url` is set. `ctx.facts` stays typed as `FactStore`; every facts tool
  (`store_fact`/`read_facts`/`delete_fact`) and resource works unchanged. Graph
  tools get `WebGraphStore` the same way.
- **SDK users** get a supported answer to "how do I access facts/graph
  remotely": construct a `WebFactStore`/`WebGraphStore` against a deployment,
  or (future) reach them through the web-mode client. `createFactStoreForUrl`
  is demoted to internal, matching direct `{ store }`.

### MCP auth (headless)

The MCP server is launched by an MCP host (Claude Desktop, an agent runtime) —
no browser. Two credential paths, both on the existing Entra stack:

- **Dev / attended:** reuse the TUI's cached-token provider. The operator runs
  `pilotswarm auth login --api-url <url>` once; the MCP server reads the same
  `~/.config/pilotswarm/auth/<origin>.json` cache via the shared token provider.
- **Unattended / production:** a service principal (client-credentials) or
  workload/managed identity supplies the bearer token. Documented; the server
  takes `--api-url` plus a token source, mirroring how the TUI takes `--api-url`.

No-auth deployments need only `--api-url`.

---

## Security

- **Server-derived access context (role-aware).** `readFacts` / `searchFacts` /
  `similarFacts` accept an `AccessContext`; the server MUST build it from the
  authenticated principal and never from client input. As built: a **non-admin**
  admitted caller reads **shared facts only** — the server forces `scope="shared"`
  and drops any client-supplied `sessionId`, so one caller cannot read another
  session's private facts. **Admin** callers (and no-auth deployments, which are
  trusted/private) read unrestricted, like an operator with direct DB access.
  `deleteFact` likewise strips a client `unrestricted` and refuses `scope="all"`
  (a mass cross-session delete) — cross-cutting purges are the admin-gated
  `forcePurgeFacts`. The role check is where per-user scoping later refines.
- **Value size + rate limits.** `storeFact` values are arbitrary JSON; enforce
  the existing 2 MB body limit and return `413` on exceed. Batch stores are
  bounded.
- **Admin gating.** Tier 2 is the first per-route role check; it reads the
  already-resolved `req.auth.authorization.role`, no new auth machinery.
- **Envelope discipline.** Store errors (unsupported capability, not-found,
  conflict) map to typed 4xx envelopes; unexpected faults stay generic 500s
  (no connection-string/path leaks), consistent with the session routes.

---

## Delivery plan

1. **Facts data-plane (Tier 1).** Operations-table entries; mgmt-client
   methods + transport/runtime delegations; `WebFactStore` implementing
   `FactStore`/`EnhancedFactStore`; `/facts/capabilities`; capability→409
   mapping. E2E: facts round-trip (store → read → search when enhanced →
   delete) against the real portal server + Postgres/HorizonDB.
2. **Graph data-plane (Tier 1).** `_graphStore` on the mgmt client; graph
   routes; `WebGraphStore implements GraphStore`; graph E2E (upsert nodes/edges
   → search → neighbourhood → delete).
3. **MCP web mode.** Context builder selects `WebFactStore`/`WebGraphStore`
   under `--api-url`; token provider (cached-token for dev, service-principal
   documented); MCP E2E over the API in no-auth mode. Retire the direct-`--store`
   requirement from the MCP README's "planned" note.
4. **Operational surface (Tier 2).** Embedder controls + purge + namespace
   admin, behind the first per-route admin check. Admin E2E.

Docs regenerate from the operations table (`docs/api/reference.md`); update the
SDK facts/graph guides and the MCP README to lead with web mode.

---

## Open Questions

- **Package placement for the web stores.** `WebFactStore`/`WebGraphStore`
  implement SDK interfaces (`FactStore`/`GraphStore` live in `pilotswarm-sdk`)
  but should be usable by the Node MCP server without pulling the whole SDK.
  Options: (a) put them in `pilotswarm-sdk` web module (MCP already depends on
  the SDK); (b) put them in `pilotswarm-api-client` and have it depend on the
  SDK's type-only exports. (a) is simpler given current deps; confirm the MCP
  server does not need a browser build.
- **Search request shape.** `SearchOpts` (weights, mode, limits) is rich; settle
  a stable JSON body schema versioned with the operations table.
- **Graph query expressiveness.** `GraphNodeQuery`/`GraphEdgeQuery` are
  structured; decide whether to expose them verbatim or a curated subset first
  (start curated, widen on demand — same discipline as Tier 3).
- **Namespace defaulting.** Graph ops take an optional namespace
  (`DEFAULT_GRAPH_NAMESPACE`); decide whether the API defaults it server-side or
  requires it explicitly for multi-tenant clarity.

---

## Recommendation

Mirror the store contracts as a curated, tiered data-plane, and implement the
client side as `WebFactStore`/`WebGraphStore` that satisfy the existing
`FactStore`/`GraphStore` interfaces — so the MCP server (and future SDK
consumers) move to web mode by swapping one constructor, and the whole product
surface becomes Entra-gated end to end. Ship facts Tier 1 first (unblocks the
MCP server's core tools), then graph, then MCP web mode, then the admin-gated
operational surface. Keep per-user facts access control as a deliberate,
clearly-seamed follow-up.
