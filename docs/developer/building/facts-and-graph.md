# Facts & Graph (SDK)

PilotSwarm's memory subsystem has two halves an SDK app can read and write:

- **Facts** — a key/value memory keyed by scope, with optional tags, semantic
  search, and an embedder. This is where agents persist what they learn.
- **Graph** — nodes and edges (a knowledge graph) derived from facts, with
  namespaces and neighbourhood queries.

This guide shows how to reach both from an SDK app, over the [Web API](../../api/reference.md)
(the supported path) or directly against the store (internal/testing).

The authoritative wire surface — every operation, its HTTP verb, params, and
which are admin-gated — is [docs/api/reference.md](../../api/reference.md), generated
from the operations table. This guide is the programmatic (TypeScript) view.

## Store layering

Three interfaces, in two families:

```text
FactStore                     ← base: store/read/delete facts, stats
  └─ EnhancedFactStore        ← adds: searchFacts, similarFacts, embedder controls

GraphStore                    ← separate interface: nodes, edges, namespaces
```

`EnhancedFactStore` **extends** `FactStore`, so an enhanced store is a superset —
everything a base store does, plus search. `GraphStore` is a **separate**
interface, not a subtype of either. A deployment can have any combination:
base facts only, enhanced facts, and/or a graph.

- `PgFactStore` (Postgres) implements the base `FactStore`.
- The search-capable backend implements `EnhancedFactStore`.
- The graph backend implements `GraphStore`.

Because these are backend-dependent, **don't assume** search or graph exist —
detect capabilities first (below).

## Getting a store over the Web API

`createWebFactStore(api)` and `createWebGraphStore(api)` build clients that
**implement the same `FactStore` / `GraphStore` interfaces** the runtime programs
against, backed by HTTP. Any consumer typed as `FactStore` (the MCP server, SDK
tools) works unchanged over a deployment — no database credentials.

```ts
import { ApiClient } from "pilotswarm-sdk/api";
import { createWebFactStore, createWebGraphStore, isEnhancedFactStore } from "pilotswarm-sdk";

const api = new ApiClient({
  apiUrl: "https://portal.example.com",
  getAccessToken,           // omit on a no-auth deployment
});

// Reads /facts/capabilities first, so isEnhancedFactStore(facts) is accurate —
// the remote equivalent of "is this a PgFactStore or an enhanced store?".
const facts = await createWebFactStore(api);

// Returns null when the deployment has no graph store.
const graph = await createWebGraphStore(api);
```

`createWebFactStore` returns a `WebEnhancedFactStore` when the deployment
advertises search, and a plain `WebFactStore` otherwise. `createWebGraphStore`
returns `null` when there is no graph store — always null-check it.

### Capability detection

Never call `searchFacts` (or any graph method) without checking first. The type
guards work identically on web and direct stores:

```ts
import { isEnhancedFactStore, isGraphStore } from "pilotswarm-sdk";

if (isEnhancedFactStore(facts)) {
  const hits = await facts.searchFacts("deployment runbook");
}

if (graph && isGraphStore(graph)) {
  const nodes = await graph.searchGraphNodes({ nameLike: "payment" });
}
```

Calling an enhanced-only op on a base deployment throws
`EnhancedFactsUnsupportedError` (`.code = "FACTS_ENHANCED_UNSUPPORTED"`); a graph
op with no graph store throws with `.code = "GRAPH_UNSUPPORTED"`. Over HTTP both
surface as a clean `409`, not a `500`.

## Reading and writing facts

```ts
// Store (single or batch). shared:true = visible to everyone; shared:false with
// a sessionId = private to that session.
await facts.storeFact({ key: "runbooks/deploy", value: { steps: [...] }, shared: true, tags: ["ops"] });
await facts.storeFact([
  { key: "runbooks/rollback", value: { steps: [...] }, shared: true },
  { key: "scratch/last-run", value: { at: Date.now() }, shared: false, sessionId },
]);

// Read by key pattern (SQL LIKE), tags, or explicit scope keys.
const { count, facts: rows } = await facts.readFacts({ keyPattern: "runbooks/%", scope: "shared", limit: 50 });

// Delete: exact by key, or pattern within a scope.
await facts.deleteFact({ key: "scratch/last-run", shared: false, sessionId });
await facts.deleteFact({ key: "runbooks/%", pattern: true, scope: "shared" });

// Enhanced only:
if (isEnhancedFactStore(facts)) {
  const results = await facts.searchFacts("how do we roll back", { limit: 10 });
  const near = await facts.similarFacts("shared:runbooks/deploy", { limit: 5 });
}
```

## Reading and writing the graph

```ts
if (graph) {
  // Nodes are identified by (kind, name); upsert returns the derived nodeKey.
  const payments = await graph.upsertGraphNode({ kind: "service", name: "payments", agentId: "my-app" });
  const ledger = await graph.upsertGraphNode({ kind: "service", name: "ledger", agentId: "my-app" });
  await graph.upsertGraphEdge({ fromKey: payments.nodeKey, toKey: ledger.nodeKey, predicate: "calls", agentId: "my-app" });

  const hits = await graph.searchGraphNodes({ nameLike: "payment" });
  const sub = await graph.graphNeighbourhood(payments.nodeKey, 2);
  const stats = await graph.graphStats();          // { nodeCount, edgeCount }

  // Namespaces isolate graphs.
  const namespaces = await graph.listGraphNamespaces();
}
```

## Management-client data-plane

If you already hold a `PilotSwarmManagementClient`, the same facts/graph
operations are methods on it, so you don't need to construct a separate store.
Facts **reads** take an `{ admin }` flag that controls visibility (see access
control below):

```ts
const mgmt = new PilotSwarmManagementClient({ apiUrl, getAccessToken });
await mgmt.start();

const caps = mgmt.factsCapabilities();            // { search, embedder, graph }
const { facts } = await mgmt.readFacts({ keyPattern: "runbooks/%" }, { admin: true });
await mgmt.storeFact({ key: "runbooks/x", value: {...}, shared: true });
const hits = await mgmt.searchFacts("rollback", { limit: 10 }, { admin: true });

const nodes = await mgmt.searchGraphNodes({ nameLike: "payment" });
```

## Access control

Access is enforced **server-side**, from the authenticated principal — never from
the client. `AccessContext` arguments on the web stores exist for interface
parity and are ignored on the wire.

Today's model is binary, and deliberately conservative for non-admins:

- **Admin callers** (and **no-auth** deployments, where every caller is
  privileged) read **unrestricted** — like an operator with direct DB access.
- A **non-admin** admitted caller is limited to **shared** facts. The server
  forces `scope: "shared"` and drops any client-supplied `sessionId`, so a
  non-admin cannot read another session's private facts by targeting it.
- `deleteFact` never honors a client `unrestricted` flag and refuses
  `scope: "all"` for non-admins; cross-cutting purges go through the admin-gated
  `forcePurgeFacts`.

> Per-user facts scoping (beyond shared-vs-private) is intentionally future work.
> The role check on reads is the seam where it will land.

### Admin-gated (Tier 2) operations

These require the admin role over the Web API (a `403` otherwise); they are the
operational controls, not the data plane:

- `startEmbedder` / `stopEmbedder`, `forcePurgeFacts`
- `upsertGraphNamespace` / `deleteGraphNamespace`

### Not exposed over the Web API

In-cluster crawler/sweeper/harvester machinery is not part of the public surface
and throws if called on a web store: `readUncrawledFacts`, `setFactsCrawled`,
`purgeExpiredFacts`, `deleteSessionFactsForSession`, `configureEmbedder` (carries
secrets), and the graph reconciliation methods `mergeGraphNodes` /
`removeGraphEvidence`.

## Direct (internal/testing) construction

For same-process tests you can build a store straight from a connection string.
This is internal/testing-only — apps should go through the Web API.

```ts
import { createFactStoreForUrl, createGraphStoreForUrl } from "pilotswarm-sdk";

const facts = await createFactStoreForUrl(process.env.DATABASE_URL, factsSchema);
await facts.initialize();
```

## What to read next

- [Web API Reference](../../api/reference.md) — the authoritative wire surface
- [Building SDK Apps](./sdk-apps.md)
- [Configuration](../reference/configuration.md)
