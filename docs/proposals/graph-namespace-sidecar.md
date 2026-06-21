# Graph And Fact Search Enhancements - Namespaces & Search Strategy Selection

## Problem

Graph namespaces are currently implicit. A namespace exists because facts,
graph nodes, or graph edges were written with a matching key prefix or graph
property. That makes corpus discovery awkward for a cold agent: it must sample
graph nodes or facts, infer namespace strings from results, and guess what each
knowledge base means.

The goal is to make graph knowledge bases explicitly discoverable without
turning namespace listing into an AGE graph scan or adding high-churn fields.

## Design Goals

- Provide a cheap, relational discovery surface for graph namespaces.
- Keep the registry graph-provider-owned and graph-lifecycle-owned.
- Keep the default list response compact enough for normal agent cold-start flows.
- Always expose a `default` namespace for the unscoped/default graph.
- Register namespace discovery tools only when a graph store is configured.
- Let reader agents decide whether a graph corpus is relevant before searching.
- Let harvester agents register static corpus/schema/harvest-shape details
  without writing per-crawl stats.
- Keep fact-search retrieval-mode selection separate from graph-search/domain
   enrichment guidance.

## Part 1 - Graph Namespace Registry

### Schema Placement

The sidecar table belongs to the graph schema, not the Horizon facts schema.

For HorizonDB/AGE, create the registry in the graph-owned relational schema
associated with the graph provider lifecycle. If the provider needs a new
explicit config value, add one, for example `graphSchema` /
`HORIZON_GRAPH_SCHEMA`. Do not create this table in the facts schema just
because the source evidence lives in facts.

### Sidecar Table

Add a graph-provider-owned relational table, tentatively named
`graph_namespaces`.

Keep the table minimal:

```text
namespace text primary key
status text not null              -- active | archived
frontmatter jsonb not null         -- compact name/description hints returned by list
description text                   -- detailed human description, details only
source text                        -- how source fact keys map/link to namespace
node_schema jsonb                  -- details only
edge_schema jsonb                  -- details only
harvest_config jsonb               -- static/non-secret harvest shape, details only
created_at timestamptz not null
updated_at timestamptz not null
```

`status` has only two states for now: `active` and `archived`.

Seed a `default` row idempotently during migration. Graph records with no
namespace should be presented as belonging to `default` for discovery and
reporting. New graph write flows should still prefer explicit namespaces when
an app corpus is known.

No secrets should be stored in sidecar rows. `harvest_config` should name secret
keys or configuration handles, not secret values.

### Frontmatter

`frontmatter` is the lightweight discovery contract. Use the same minimal shape
as skill-file YAML frontmatter: a short name and description that help an LLM
decide whether to load details or search the graph.

Example shape:

```yaml
---
name: pgsql-hackers
description: PostgreSQL hackers mailing-list discussion graph. Use when the user asks about PostgreSQL patch discussions, mailing-list threads, people, or design history.
---
```

`graph_list_namespaces` should return only `namespace`, `status`, and
`frontmatter` unless the caller asks for details.

### Source

`source` describes how source fact keys map to the graph namespace. It is about
linkage, not operational status. Example:

```text
Facts under corpus/pgsql-hackers/* are harvested into graph namespace corpus/pgsql-hackers.
Graph evidence scopeKeys point back to those source facts.
```

### Schema And Harvest Shape

`node_schema` describes expected node kinds, properties, examples, and naming
conventions.

`edge_schema` describes expected predicates, direction, and semantics. For
example, `authored` might connect `person -> message`, while `replies_to` might
connect `message -> message`.

`harvest_config` describes static, non-secret harvest shape: source namespace,
expected crawl mode, extraction rules, delete handling, and schedule/config
names. It must not be updated on every crawl and must not carry stats.

### GraphStore Contract

Extend the SDK graph-store interface with namespace registry methods:

- `listGraphNamespaces({ prefix?, status?, includeDetails?, limit? })`
- `getGraphNamespace(namespace)`
- `upsertGraphNamespace(input)`
- `archiveGraphNamespace(namespace)`
- `deleteGraphNamespace(namespace)`

`listGraphNamespaces` returns `namespace`, `status`, and `frontmatter` by
default. With `includeDetails=true`, it may include `description`, `source`,
`node_schema`, `edge_schema`, and `harvest_config`.

`archiveGraphNamespace` sets `status = archived`. It is non-destructive.

`deleteGraphNamespace` is destructive and should be facts-manager-only. The
intended semantics are to delete the namespace registry row and drop graph data
owned by that namespace. It must not delete source facts unless a future explicit
option says so.

### Provider Implementation Outline

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
   when corpus details change, when a namespace is archived, or when a
   namespace is deleted.

### Tool Surface

Register tools only when `graphStore` is configured.

Reader tools for all graph-enabled sessions:

- `graph_list_namespaces`
- `graph_get_namespace`

`graph_list_namespaces` should accept `prefix`, `status`, `includeDetails`, and
`limit`.

`graph_get_namespace` returns the full descriptor for one namespace.

Write/delete tools:

- `graph_upsert_namespace`: harvester-capable sessions and facts-manager.
- `graph_archive_namespace`: harvester-capable sessions and facts-manager.
- `graph_delete_namespace`: facts-manager only, and only when the user requests
  destructive deletion.

Harvesters can archive a corpus they own when it is retired. Only facts-manager
should be able to delete a namespace, because deletion drops the namespace rather
than merely hiding it from normal discovery.

### Reader Agent Flow

Update graph-aware prompt guidance so a cold reader agent does this:

1. Call `graph_list_namespaces({ limit: 20 })` when graph knowledge may help.
2. Use each row's `frontmatter` to decide whether a namespace is relevant.
3. Call `graph_get_namespace({ namespace })` only when details are needed.
4. Use the selected namespace consistently with `facts_search`,
   `graph_search_nodes`, `graph_search_edges`, and `graph_neighbourhood`.
5. If no namespace fits, use `default` or ask the user which corpus to use.

## Part 2 - Search Strategy Selection

There are two independent search surfaces:

- Fact search: retrieve source facts with `facts_search` / `facts_similar`.
- Graph search: inspect graph structure, enrichment, and domain links with
  `graph_list_namespaces`, `graph_get_namespace`, `graph_search_nodes`,
  `graph_search_edges`, and `graph_neighbourhood`.

They can be used together, but neither is a prerequisite for the other.

### Fact Search Skill

Update the `facts_search` tool description and the search-mode skill/prompt so
agents choose the right fact retrieval mode.

This guidance is about `lexical` vs `semantic` vs `hybrid`; it is not graph
namespace discovery guidance.

Strategy rules:

1. Default to `semantic` for natural-language questions.
2. Use `hybrid` as the one-shot recheck when a semantic top hit is weak,
   adjacent, or off-topic.
3. Reserve `lexical` for exact tokens, identifiers, error codes, proper nouns,
   quoted phrases, or single exact terms.
4. If a namespace is already known from the user, session context, or graph
   namespace frontmatter, pass it to `facts_search`.
5. Do not switch to graph search merely to choose `lexical` vs `semantic` vs
   `hybrid`.

### Graph Search Skill

Add a separate graph-search skill/prompt section for domain enrichment. This is
where namespace discovery belongs.

Graph guidance:

1. When a task may benefit from domain/corpus enrichment, inspect namespace
   frontmatter first with `graph_list_namespaces`.
2. Use frontmatter to decide whether graph search is worth doing at all.
3. Call `graph_get_namespace` only when frontmatter is insufficient and details
   are needed.
4. Once a namespace is selected, use it consistently in graph tools.
5. If graph hits return evidence scopeKeys, use `read_facts` or `facts_search`
   separately to retrieve source fact content.
6. Do not use graph namespace discovery as a replacement for fact-search mode
   selection.

### SessionManager Frontmatter Cache

Consider adding a small SessionManager-owned cache of namespace frontmatter when
a graph store is configured.

Rationale:

- Namespace frontmatter is tiny and changes rarely.
- Injecting a compact list into the base prompt can help cold agents decide
  whether graph search is relevant without spending a tool call.
- It prevents the graph search skill from needing to begin every turn with a
  discovery call.

Constraints:

- Cache only active namespaces.
- Inject only `namespace`, `status`, and frontmatter `name` / `description`.
- Cap by count and token budget, for example the first 20 active namespaces or a
  hard prompt-budget slice.
- Refresh on worker/session startup and periodically with a conservative TTL.
- If the cache is absent, stale, or truncated, agents can still call
  `graph_list_namespaces`.
- Never inject node schema, edge schema, harvest config, or source details into
  the default prompt.

Design preference: use cache injection as an optimization, not as the only
discovery mechanism. `graph_list_namespaces` remains the authoritative tool.

## Harvester Flow

Update harvester guidance so each corpus-owning harvester:

1. Calls `graph_upsert_namespace` when it starts, before first crawl, or when
   corpus/schema/harvest details change.
2. Includes compact `frontmatter`, source linkage, node schema, edge schema, and
   static non-secret harvest configuration.
3. Uses the same namespace for `facts_read_uncrawled`, graph resolve/search,
   graph upserts, graph evidence reconciliation, and `facts_mark_crawled`.
4. Does not update namespace details after every crawl.
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

`facts_search` strategy tests:

1. The fact-search skill tells agents when to use `semantic`, `hybrid`, and
   `lexical`.
2. The fact-search skill does not require graph namespace discovery before every
   search.
3. If a namespace is already known, `facts_search` guidance preserves it.
4. Baseline non-graph sessions do not mention unavailable graph namespace tools
   as if they were callable.

Graph search skill tests:

1. The graph-search skill tells agents to inspect namespace frontmatter before
   deeper graph traversal.
2. The graph-search skill treats graph enrichment as optional and independent
   from fact-search mode selection.
3. The graph-search skill tells agents to use evidence scopeKeys to retrieve
   source facts when graph hits need grounding.

SessionManager cache tests:

1. Graph-enabled sessions receive a compact namespace frontmatter block when
   active namespaces exist.
2. The injected block omits archived namespaces and detail-heavy fields.
3. Sessions without a graph store receive no namespace frontmatter block.
4. When the cache is truncated, the prompt tells agents to call
   `graph_list_namespaces` for the full list.

## Scenario Tests

1. Cold reader discovers available knowledge bases. Seed `default` and
   `corpus/pgsql-hackers`, ask what knowledge bases are available, and expect
   use of `graph_list_namespaces`.
2. Reader chooses a namespace before search. Seed two namespaces with distinct
   frontmatter and expect namespace discovery before facts or graph search.
3. Reader loads details lazily. It should call `graph_get_namespace` only after
   choosing a likely namespace from frontmatter.
4. Harvester registers namespace before crawl. Verify `graph_upsert_namespace`
   is called and compact namespace details are stored.
5. Harvester does not write per-crawl stats. Run two crawl cycles and verify the
   namespace row changes only when static details change.
6. Default namespace fallback. With only `default`, the agent should identify
   `default` instead of claiming no graph knowledge.
7. Archived namespace avoided. Agents should omit archived namespaces unless
   asked for them.
8. Facts-manager deletes namespace on explicit user request. Verify namespace
   registry row and namespace-owned graph records are removed.

## Mini Eval Plan

Add a small HorizonDB-only eval that runs when the HDB provider is enabled. It
should validate behavior, not benchmark retrieval quality exhaustively.

Seed two or three namespace rows with concise frontmatter, for example:

- `default`: general graph knowledge.
- `corpus/pgsql-hackers`: PostgreSQL mailing-list graph.
- `corpus/acme-support`: support-ticket graph.

For each graph-search eval prompt, record whether the agent:

1. Used injected namespace frontmatter or called `graph_list_namespaces`.
2. Chose the expected namespace from frontmatter.
3. Used graph search only when enrichment was relevant.
4. Avoided `graph_get_namespace` unless the prompt required details.
5. Used evidence scopeKeys to retrieve source facts when needed.

For fact-search strategy eval prompts, record whether the agent:

1. Chose `semantic` for natural-language questions.
2. Used `hybrid` only as the one-shot recheck when semantic evidence was weak.
3. Used `lexical` for exact identifiers, error codes, quoted phrases, or single
   exact terms.
4. Preserved a known namespace when one was already supplied.

Suggested prompts:

- "Find PostgreSQL discussion history about MERGE planning."
- "Look up what the support corpus says about billing escalations."
- "What graph knowledge bases are available?"
- "Search the default graph for deployment notes."
- "I don't know which corpus has this; tell me which graph namespace you would
   use before searching."
- "Search facts for error code 42P07."
- "Find semantically similar facts about interrupted graph harvest recovery."

Pass criteria:

- Namespace-specific graph prompts choose the matching namespace before graph
   traversal.
- Discovery prompts answer from namespace frontmatter without loading full
   details for every namespace.
- Fact-search prompts choose the expected retrieval mode independently from
   graph search.
- The default fallback prompt uses `default`.
- No eval prompt requires per-crawl namespace updates or graph scans.

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