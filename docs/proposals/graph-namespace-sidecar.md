# Graph Namespace Sidecar Registry Plan

## Problem

Graph namespaces are currently implicit. A namespace exists because facts,
graph nodes, or graph edges were written with a matching key prefix or graph
property. That makes corpus discovery awkward for a cold agent: it must sample
graph nodes or facts, infer namespace strings from results, and guess what each
knowledge base means.

The goal is to make graph knowledge bases explicitly discoverable without
turning namespace listing into an AGE graph scan or adding high-churn metadata.

## Design Goals

- Provide a cheap, relational discovery surface for graph namespaces.
- Keep the registry graph-provider-owned and graph-lifecycle-owned.
- Keep the default list response compact enough for normal agent cold-start flows.
- Always expose a `default` namespace for the unscoped/default graph.
- Register namespace discovery tools only when a graph store is configured.
- Let reader agents decide whether a graph corpus is relevant before searching.
- Let harvester agents register static corpus/schema/harvest-shape metadata
  without writing per-crawl stats.

## Schema Placement

The sidecar table belongs to the graph schema, not the Horizon facts schema.

For HorizonDB/AGE, create the registry in the graph-owned relational schema
associated with the graph provider lifecycle. If the provider needs a new
explicit config value, add one, for example `graphSchema` /
`HORIZON_GRAPH_SCHEMA`. Do not create this table in the facts schema just
because the source evidence lives in facts.

## Sidecar Table

Add a graph-provider-owned relational table, tentatively named
`graph_namespaces`.

Keep the table minimal:

```text
namespace text primary key
display_name text
status text not null              -- active | archived
frontmatter jsonb not null         -- compact discovery hints returned by list
description text                   -- detailed human description, details only
source text                        -- how source fact keys map/link to namespace
node_schema jsonb                  -- details only
edge_schema jsonb                  -- details only
harvest_config jsonb               -- static/non-secret harvest shape, details only
created_at timestamptz not null
updated_at timestamptz not null
```

Remove these from the design:

- `visibility`
- `owner_agent_id`
- `harvester_agent_id`
- harvest crawl stats such as `last_harvested_at`, `last_harvest_status`, and
  `last_harvest_error`
- generic `metadata`

`status` has only two states for now: `active` and `archived`.

Seed a `default` row idempotently during migration. Graph records with no
namespace should be presented as belonging to `default` for discovery and
reporting. New graph write flows should still prefer explicit namespaces when
an app corpus is known.

No secrets should be stored in sidecar rows. `harvest_config` should name secret
keys or configuration handles, not secret values.

## Frontmatter

`frontmatter` is the lightweight discovery contract. It should mirror the role
frontmatter plays in skill files: short hints that help an LLM decide whether a
namespace is relevant before loading details or searching the graph.

Example shape:

```json
{
  "summary": "PostgreSQL hackers mailing-list discussion graph",
  "keywords": ["postgresql", "pgsql-hackers", "mailing list", "patches"],
  "domains": ["database", "open source", "postgres"],
  "nodeKinds": ["person", "message", "thread", "topic", "patch"],
  "edgePredicates": ["authored", "replies_to", "mentions", "discusses"]
}
```

`graph_list_namespaces` should return `frontmatter` in its basic response. It
should not return verbose schemas or harvest configuration unless the caller asks
for details.

## Source

Use one `source` field instead of `source_type` and `source_description`.

`source` describes how source fact keys map to the graph namespace. It is about
linkage, not operational status. Example:

```text
Facts under corpus/pgsql-hackers/* are harvested into graph namespace corpus/pgsql-hackers.
Graph evidence scopeKeys point back to those source facts.
```

## Schema And Harvest Shape

`node_schema` describes expected node kinds, properties, examples, and naming
conventions. Example node kinds might be `person`, `message`, `thread`, `patch`,
or `file`.

`edge_schema` describes expected predicates, direction, and semantics. For
example, `authored` might connect `person -> message`, while `replies_to` might
connect `message -> message`.

`harvest_config` describes static, non-secret harvest shape: source namespace,
expected crawl mode, extraction rules, delete handling, and schedule/config
names. It must not be updated on every crawl and must not carry stats.

## GraphStore Contract

Extend the SDK graph-store interface with namespace registry methods:

- `listGraphNamespaces({ prefix?, status?, includeDetails?, limit? })`
- `getGraphNamespace(namespace)`
- `upsertGraphNamespace(input)`
- `archiveGraphNamespace(namespace)`
- `deleteGraphNamespace(namespace)`

`listGraphNamespaces` defaults to compact output: `namespace`, `displayName`,
`status`, and `frontmatter`. With `includeDetails=true`, it may include
`description`, `source`, `node_schema`, `edge_schema`, and `harvest_config`.

`archiveGraphNamespace` sets `status = archived`. It is non-destructive.

`deleteGraphNamespace` is destructive and should be facts-manager-only. The
intended semantics are to delete the namespace registry row and drop graph data
owned by that namespace. It must not delete source facts unless a future explicit
option says so.

## Provider Implementation Outline

For `@pilotswarm/horizon-store`:

1. Add a graph-schema migration that creates `graph_namespaces` and seeds
   `default`.
2. Add indexes: primary key on `namespace`, index on `status`, and optional
   `namespace text_pattern_ops` for prefix listing.
3. Keep namespace listing relational. Do not scan AGE for namespace discovery.
4. Implement `listGraphNamespaces`, `getGraphNamespace`,
   `upsertGraphNamespace`, `archiveGraphNamespace`, and
   `deleteGraphNamespace` in the graph provider.
5. Do not add per-crawl harvest status writes. Namespace rows should change only
   when corpus metadata changes, when a namespace is archived, or when a
   namespace is deleted.

## Tool Surface

Register tools only when `graphStore` is configured.

Reader tools for all graph-enabled sessions:

- `graph_list_namespaces`
- `graph_get_namespace`

`graph_list_namespaces` should accept `prefix`, `status`, `includeDetails`, and
`limit`. Its default output must stay compact and include `frontmatter`.

`graph_get_namespace` returns the full descriptor for one namespace.

Write/delete tools:

- `graph_upsert_namespace`: harvester-capable sessions and facts-manager.
- `graph_archive_namespace`: harvester-capable sessions and facts-manager.
- `graph_delete_namespace`: facts-manager only, and only when the user requests
  destructive deletion.

Harvesters can archive a corpus they own when it is retired. Only facts-manager
should be able to delete a namespace, because deletion drops the namespace rather
than merely hiding it from normal discovery.

## Reader Agent Flow

Update graph-aware prompt guidance so a cold reader agent does this:

1. If graph tools are available and the task may need corpus/domain knowledge,
   call `graph_list_namespaces({ limit: 20 })`.
2. Use each row's `frontmatter` to decide whether a namespace is relevant.
3. Call `graph_get_namespace({ namespace })` only when it needs details.
4. Use the selected namespace consistently with `facts_search`,
   `graph_search_nodes`, `graph_search_edges`, and `graph_neighbourhood`.
5. If no namespace fits, use `default` or ask the user which corpus to use.

## Harvester Flow

Update harvester guidance so each corpus-owning harvester:

1. Calls `graph_upsert_namespace` when it starts, before first crawl, or when
   corpus/schema/harvest metadata changes.
2. Includes compact `frontmatter`, source linkage, node schema, edge schema, and
   static non-secret harvest configuration.
3. Uses the same namespace for `facts_read_uncrawled`, graph resolve/search,
   graph upserts, graph evidence reconciliation, and `facts_mark_crawled`.
4. Does not update namespace metadata after every crawl.
5. Calls `graph_archive_namespace` when its corpus is intentionally retired.

## Functional Tests

Provider-level HorizonDB tests:

1. Migration creates the graph-schema sidecar and seeds `default`.
2. `upsertGraphNamespace` is idempotent and updates mutable fields.
3. `listGraphNamespaces({ prefix })` returns exact namespace and descendants.
4. `listGraphNamespaces({ status })` filters `active` and `archived` rows.
5. Basic list output contains compact `frontmatter` and omits details.
6. `includeDetails=true` includes description, source, schema, and harvest config.
7. `archiveGraphNamespace` sets `status = archived` without deleting graph data.
8. `deleteGraphNamespace` drops the registry row and namespace-owned graph data.

SDK/tool tests:

1. A graph-enabled reader gets `graph_list_namespaces` and `graph_get_namespace`.
2. A baseline non-graph session does not get namespace tools.
3. A harvester gets `graph_upsert_namespace` and `graph_archive_namespace`.
4. An ordinary reader does not get namespace write/delete tools.
5. Facts-manager gets upsert, archive, and delete tools.
6. `graph_list_namespaces` stays compact unless `includeDetails=true`.

## Scenario Tests

1. Cold reader discovers available knowledge bases. Seed `default` and
   `corpus/pgsql-hackers`, ask what knowledge bases are available, and expect
   use of `graph_list_namespaces`.
2. Reader chooses a namespace before search. Seed two namespaces with distinct
   frontmatter and expect namespace discovery before facts or graph search.
3. Reader loads details lazily. It should call `graph_get_namespace` only after
   choosing a likely namespace from frontmatter.
4. Harvester registers namespace before crawl. Verify `graph_upsert_namespace`
   is called and compact metadata is stored.
5. Harvester does not write per-crawl stats. Run two crawl cycles and verify the
   namespace row changes only when static metadata changes.
6. Default namespace fallback. With only `default`, the agent should identify
   `default` instead of claiming no graph knowledge.
7. Archived namespace avoided. Agents should omit archived namespaces unless
   asked for them.
8. Facts-manager deletes namespace on explicit user request. Verify namespace
   registry row and namespace-owned graph records are removed.

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