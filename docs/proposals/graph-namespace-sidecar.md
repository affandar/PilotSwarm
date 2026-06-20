# Graph Namespace Sidecar Registry Plan

## Problem

Graph namespaces are currently implicit. A namespace exists because facts,
graph nodes, or graph edges were written with a matching key prefix or graph
property. That makes corpus discovery awkward for a cold agent: it must sample
graph nodes or facts, infer namespace strings from results, and guess what each
knowledge base means.

The goal is to make graph knowledge bases explicitly discoverable without
turning graph listing into an AGE graph scan.

## Design Goals

- Provide a cheap, relational discovery surface for graph namespaces.
- Keep graph topology and evidence in the graph store.
- Keep namespace descriptions, schema hints, and harvesting metadata in a
  sidecar table owned by the graph provider.
- Always expose a `default` namespace for the unscoped/default graph.
- Register namespace discovery tools only when a graph store is configured.
- Let reader agents discover available corpora before searching.
- Let harvester agents register and maintain namespace metadata for the corpus
  they own.

## Sidecar Table

Add a graph-provider-owned relational table, tentatively named
`graph_namespaces`, in the Horizon facts schema.

Suggested columns include: `namespace` primary key, `display_name`,
`description`, `status`, `visibility`, `owner_agent_id`, timestamps,
`last_harvested_at`, `last_harvest_status`, `last_harvest_error`,
`source_type`, `source_description`, `harvester_agent_id`,
`harvester_config`, `node_schema`, `edge_schema`, `sample_queries`, and
`metadata`.

Seed a `default` row idempotently during migration. Graph records with no
namespace should be presented as belonging to `default` for discovery and
reporting. New graph write flows should still prefer explicit namespaces when
an app corpus is known.

No secrets should be stored in sidecar rows. Harvester configuration should name
secret keys or configuration handles, not secret values.

## Schema Metadata

`node_schema` should describe expected node kinds, required and optional
properties, examples, and naming conventions. Example node kinds might be
`person`, `message`, `thread`, `patch`, or `file`.

`edge_schema` should describe expected predicates, direction, and semantics. For
example, `authored` might connect `person -> message`, while `replies_to` might
connect `message -> message`.

`harvester_config` should describe how the graph is maintained: mode,
source namespace, crawl limit, delete handling, schedule, and non-secret notes.

## GraphStore Contract

Extend the SDK graph-store interface with namespace registry methods:

- `listGraphNamespaces({ prefix?, status?, includeStats?, includeSchema?, limit? })`
- `getGraphNamespace(namespace)`
- `upsertGraphNamespace(input)`
- `updateGraphNamespaceHarvest({ namespace, status, harvestedAt?, error?, metadata? })`

Optionally add `archiveGraphNamespace(namespace, reason?)` later. Prefer archive
over delete because graph data may still exist and old records remain easier to
interpret when the namespace row is retained.

## Provider Implementation Outline

For `@pilotswarm/horizon-store`:

1. Add a migration that creates `graph_namespaces` and seeds `default`.
2. Add indexes: primary key on `namespace`, index on `status`, and optional
   `namespace text_pattern_ops` for prefix listing.
3. Keep namespace listing relational. Do not scan AGE for namespace discovery.
4. Implement `listGraphNamespaces`, `getGraphNamespace`,
   `upsertGraphNamespace`, and `updateGraphNamespaceHarvest` in the provider.
5. If `includeStats` is requested, either call `graphStats({ namespace })` per
   namespace with a bounded limit or defer cached counts to a later migration.

## Tool Surface

Register tools only when `graphStore` is configured.

Reader tools for all graph-enabled sessions:

- `graph_list_namespaces`
- `graph_get_namespace`

`graph_list_namespaces` should accept `prefix`, `status`, `includeSchema`,
`includeStats`, and `limit`. By default it should return compact rows with
namespace, display name, description, status, source type, last harvest state,
node kinds, and edge predicates.

`graph_get_namespace` should return the full descriptor for one namespace,
including schema metadata and harvester metadata.

Write/update tools for harvester-capable sessions and facts-manager:

- `graph_upsert_namespace`
- `graph_update_namespace_harvest`
- `graph_archive_namespace`

`graph_upsert_namespace` registers or refreshes corpus metadata before or during
harvesting. `graph_update_namespace_harvest` updates harvest status, timestamp,
error, and optional metrics after a crawl. `graph_archive_namespace` should
start as facts-manager-only and should never delete graph data.

## Reader Agent Flow

Update graph-aware prompt guidance so a cold reader agent does this:

1. If graph tools are available and the task may need corpus/domain knowledge,
   call `graph_list_namespaces({ includeSchema: false, limit: 20 })`.
2. Pick the likely namespace from description, source type, node kinds, and edge
   predicates.
3. Call `graph_get_namespace({ namespace })` before deeper graph retrieval.
4. Use the selected namespace consistently with `facts_search`,
   `graph_search_nodes`, `graph_search_edges`, and `graph_neighbourhood`.
5. If no namespace fits, use `default` or ask the user which corpus to use.

## Harvester Flow

Update harvester guidance so each corpus-owning harvester:

1. Calls `graph_upsert_namespace` when it starts or before its first crawl.
2. Includes source description, node schema, edge schema, safe harvester config,
   and sample queries.
3. Uses the same namespace for `facts_read_uncrawled`, graph resolve/search,
   graph upserts, graph evidence reconciliation, and `facts_mark_crawled`.
4. Calls `graph_update_namespace_harvest` after each crawl, including failure
   status and a short error message when the crawl fails.

## Functional Tests

Provider-level HorizonDB tests:

1. Migration seeds `default`.
2. `upsertGraphNamespace` is idempotent and updates mutable fields.
3. `listGraphNamespaces({ prefix })` returns exact namespace and descendants.
4. `listGraphNamespaces({ status })` filters active and archived rows.
5. `updateGraphNamespaceHarvest` updates status, timestamp, error, and metadata.
6. Graph namespace methods are absent or unused when no graph store is configured.

SDK/tool tests:

1. A graph-enabled reader gets `graph_list_namespaces` and `graph_get_namespace`.
2. A baseline non-graph session does not get namespace tools.
3. A harvester gets `graph_upsert_namespace` and `graph_update_namespace_harvest`.
4. An ordinary reader does not get namespace write tools.
5. Facts-manager gets namespace write/reporting tools.
6. `graph_list_namespaces` stays compact unless `includeSchema=true`.

## Scenario Tests

1. Cold reader discovers available knowledge bases. Seed `default` and
   `corpus/pgsql-hackers`, ask what knowledge bases are available, and expect
   use of `graph_list_namespaces`.
2. Reader chooses a namespace before search. Seed two namespaces with distinct
   descriptions and expect namespace discovery before facts or graph search.
3. Harvester registers namespace before crawl. Verify `graph_upsert_namespace`
   is called and metadata is stored.
4. Harvester updates status after crawl. Verify `last_harvest_status="ok"` and
   `last_harvested_at` are updated.
5. Failed harvest records failure. Inject a crawl or tool failure and verify a
   `failed` status plus short error.
6. Default namespace fallback. With only `default`, the agent should identify
   `default` instead of claiming no graph knowledge.
7. Archived namespace avoided. Agents should omit archived namespaces unless
   asked for them.

## Documentation Updates

Update these surfaces when implementing:

- `docs/facts-table.md`
- `docs/harvester-deployment.md`
- `packages/sdk/src/graph-tools.ts` tool descriptions
- `packages/sdk/plugins/mgmt/agents/facts-manager.agent.md`
- graph-aware default prompt guidance
- Horizon harvester sample docs and agents, if the sample registers a namespace

## Important Constraint

Do not infer namespace discovery by scanning graph nodes on every list. The
sidecar registry should be the authoritative discovery surface. Graph scans can
remain useful for debugging, but `graph_list_namespaces` should be a cheap
relational query.