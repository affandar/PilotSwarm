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

The graph store is an independent provider. `HorizonDBGraphStore` has its own
pool, never reads the facts table, and supports the `PgFactStore +
HorizonDBGraphStore` tier — where the HorizonDB database holds only the AGE
graph and has no facts schema or facts migration tables at all.

So the registry must be graph-owned and self-sufficient:

- It must not assume the facts schema or facts migration runner exists.
- The graph store must create and own the table itself.
- Introduce an explicit `registrySchema` / `HORIZON_GRAPH_REGISTRY_SCHEMA`
   config, default to `${graphName}_registry`, and `CREATE SCHEMA IF NOT EXISTS`
   it during graph initialize. Do not place the table inside the AGE-managed
   graph schema (`graphName` / `HORIZON_GRAPH_SCHEMA`).

### Sidecar Table

Add a graph-provider-owned relational table, tentatively named
`graph_namespaces`.

Keep the table minimal:

```text
namespace text primary key
archived boolean not null default false
frontmatter jsonb not null         -- compact name/description hints returned by list
source text                        -- how source fact keys map/link to namespace, details only
node_schema jsonb                  -- details only
edge_schema jsonb                  -- details only
harvest_config jsonb               -- static/non-secret harvest shape, details only
created_at timestamptz not null
updated_at timestamptz not null
```

There is no separate `status` column and no standalone `description` column.
`archived` is the only lifecycle state, and `frontmatter.description` is the
description.

Seed the `default` row idempotently when the table is created. `default` is the
registry entry for the unscoped graph partition (see Default Namespace). New
graph write flows should still prefer explicit namespaces when an app corpus is
known.

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

`graph_list_namespaces` should return only `namespace`, `archived`, and
`frontmatter` unless the caller asks for details.

`frontmatter` must be validated and bounded: default `name` to the namespace
when missing, require a `description`, and cap the serialized frontmatter size so
the compact list stays compact. Oversized frontmatter is rejected on upsert or
truncated in list output.

### Source

`source` describes how source fact keys map to the graph namespace. It is about
linkage, not operational status. Example:

```text
Facts under corpus/pgsql-hackers/* are harvested into graph namespace corpus/pgsql-hackers.
Graph evidence scopeKeys point back to those source facts.
```

### Default Namespace

`default` is defined as "no namespace" — graph records whose `namespace`
property is NULL.

- The registry stores a row with the literal key `default` to carry frontmatter
  for the NULL-namespace partition.
- The provider normalizes `default` and empty string to NULL on graph writes, so
  un-namespaced nodes/edges are the `default` partition.
- Graph reads for `default` translate to `namespace IS NULL`.
- `default` cannot be archived or deleted; it always exists.

This resolves the mismatch where graph queries filtering `namespace = 'default'`
would otherwise miss nodes written with no namespace property.

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

- `listGraphNamespaces({ prefix?, includeArchived?, includeDetails? })`
- `getGraphNamespace(namespace)`
- `upsertGraphNamespace(input)`
- `archiveGraphNamespace(namespace)`
- `deleteGraphNamespace(namespace)`

`listGraphNamespaces` returns `namespace`, `archived`, and `frontmatter` by
default, excludes archived rows unless `includeArchived=true`, and has no
pagination — the namespace set is small. With `includeDetails=true`, it may
include `source`, `node_schema`, `edge_schema`, and `harvest_config`.

`getGraphNamespace` returns the full descriptor for one namespace regardless of
`archived`, or null when the namespace has no registry row.

`upsertGraphNamespace` upserts by `namespace` (`ON CONFLICT (namespace) DO
UPDATE`) and may clear `archived` back to false.

`archiveGraphNamespace` sets `archived = true`. It is non-destructive and leaves
graph data searchable when explicitly targeted.

`deleteGraphNamespace` is destructive and facts-manager-only. It deletes the
registry row and drops graph data for that exact namespace (subtree deletion is
out of scope for v1; child namespaces are deleted explicitly). It deletes graph
data first, then the registry row, and is re-runnable so a mid-delete crash
recovers. It must not delete source facts. `default` cannot be deleted.

### Provider Implementation Outline

For `@pilotswarm/horizon-store`:

1. Do not stand up a second migration framework. The graph store today runs only
   the AGE bootstrap (0003) inline under an advisory xact lock and tracks no
   relational `schema_migrations`. Fold the sidecar into that same idempotent
   bootstrap in `initialize()`: `CREATE SCHEMA IF NOT EXISTS <registrySchema>`,
   `CREATE TABLE IF NOT EXISTS graph_namespaces (...)`, seed `default` via
   `INSERT ... ON CONFLICT DO NOTHING`, all under the existing advisory lock.
2. Add indexes: primary key on `namespace`, a partial index for active rows
   (`WHERE archived = false`), and optional `namespace text_pattern_ops` for
   prefix listing.
3. Maintain `updated_at` with a trigger, mirroring the existing `facts_touch()`
   pattern, so timestamps never drift from app code.
4. Keep namespace listing relational. Do not scan AGE for namespace discovery.
5. Implement `listGraphNamespaces`, `getGraphNamespace`, `upsertGraphNamespace`,
   `archiveGraphNamespace`, and `deleteGraphNamespace` in the graph provider.
6. Do not add per-crawl harvest writes. Namespace rows should change only when
   corpus details change, when a namespace is archived, or when a namespace is
   deleted.
7. `graphStats({ namespace })` already exists if an `includeStats` option is ever
   wanted; it is intentionally out of scope for v1.

### Tool Surface

Register tools only when `graphStore` is configured. Use the `graph_*` prefix
(collision-safe vs SDK built-ins; still run the tool-collision regression check).

Reader tools for all graph-enabled sessions:

- `graph_list_namespaces` — accepts `prefix`, `includeArchived`, `includeDetails`
  (no pagination).
- `graph_get_namespace` — returns the full descriptor for one namespace.

Write/delete tools:

- `graph_upsert_namespace`: harvester-capable sessions and facts-manager.
- `graph_archive_namespace`: harvester-capable sessions and facts-manager.
- `graph_delete_namespace`: facts-manager only, and only on explicit user
  request.

"Harvester-capable" means an agent whose frontmatter sets `harvester: true`,
plus `facts-manager`. A session without that capability that calls a write/delete
tool gets a clear permission error (mirroring the reserved-namespace errors in
the facts tools); the tool is not silently ignored. Only facts-manager can
delete, because deletion drops the namespace rather than hiding it.

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
where namespace discovery belongs (the cold-reader namespace flow lives here, not
in a separate reader section).

Graph guidance:

1. When a task may benefit from domain/corpus enrichment, call
   `graph_list_namespaces` and inspect frontmatter first.
2. Use frontmatter to decide whether graph search is worth doing at all and which
   namespace is relevant.
3. Call `graph_get_namespace({ namespace })` only when frontmatter is
   insufficient and details are needed.
4. Once a namespace is selected, use it consistently across `graph_search_nodes`,
   `graph_search_edges`, and `graph_neighbourhood`.
5. If graph hits return evidence scopeKeys, use `read_facts` or `facts_search`
   separately to retrieve source fact content.
6. If no namespace fits, use `default` (the unscoped/NULL partition) or ask the
   user which corpus to use.
7. Do not use graph namespace discovery as a replacement for fact-search mode
   selection.

### Namespace List Cache

Hold off on SessionManager prompt injection for now. Namespace discovery stays
tool-driven.

Cache `listGraphNamespaces` in the provider (one cache per graph store / worker,
shared across that worker's sessions), not in the per-session tool layer.

The namespace set is small, so cache two full in-memory snapshots and filter in
process — no per-parameter cache keys:

- Full compact snapshot (`namespace`, `archived`, `frontmatter`).
- Full details snapshot.

Serve `prefix` and `includeArchived` by filtering the snapshots in memory.

TTL is provider config (`namespaceCacheTtlMs`), default 60000 (one minute).

Invalidation rules:

- TTL expiry refreshes the snapshots.
- `upsertGraphNamespace`, `archiveGraphNamespace`, and `deleteGraphNamespace`
  invalidate the snapshots immediately in-process.
- Immediate invalidation is per-process only; other workers converge within the
  TTL. Global consistency is TTL-bounded, not instant.
- The TTL must be overridable in tests (tiny TTL or fake clock) so expiry tests
  do not sleep a minute.

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

1. Graph bootstrap creates the sidecar (in a DB with no facts schema) and seeds
   `default` idempotently across repeated/concurrent `initialize()` calls.
2. `upsertGraphNamespace` is idempotent, updates mutable fields, and can clear
   `archived` back to false.
3. Concurrent `upsertGraphNamespace` on the same namespace yields one row.
4. `listGraphNamespaces({ prefix })` is a string-prefix filter over registry
   rows (not an AGE subtree query).
5. `listGraphNamespaces` excludes archived rows by default and includes them with
   `includeArchived=true`.
6. Basic list output contains compact `frontmatter` and omits details.
7. `includeDetails=true` includes source, schema, and harvest config.
8. `getGraphNamespace` returns archived rows and returns null for a missing
   namespace.
9. `archiveGraphNamespace` sets `archived = true` and leaves graph data
   searchable when explicitly targeted.
10. `deleteGraphNamespace` deletes graph data for the exact namespace then the
    row, is re-runnable after a simulated mid-delete failure, and never touches
    source facts.
11. `default` cannot be archived or deleted, and `default` maps to
    `namespace IS NULL` on graph reads/writes.
12. Frontmatter validation: missing `name` defaults to the namespace; oversized
    frontmatter is rejected or truncated in list output.
13. Orphan/empty namespaces: graph data under an unregistered namespace is
    allowed (registry is authoritative for discovery), and a registry row with no
    graph data lists normally.
14. `updated_at` advances via trigger on update.

SDK/tool tests:

1. A graph-enabled reader gets `graph_list_namespaces` and `graph_get_namespace`.
2. A baseline non-graph session does not get namespace tools.
3. A harvester (`harvester: true`) gets `graph_upsert_namespace` and
   `graph_archive_namespace`.
4. An ordinary reader does not get namespace write/delete tools.
5. Facts-manager gets upsert, archive, and delete tools.
6. A non-harvester reader that invokes a write/delete tool gets a clear
   permission error, not a silent no-op.
7. `graph_delete_namespace` on `default` is rejected.
8. `graph_list_namespaces` stays compact unless `includeDetails=true`.

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

Namespace list cache tests (TTL injected small / fake clock):

1. Repeated compact `listGraphNamespaces` calls within the TTL hit the in-memory
   snapshot.
2. `prefix` and `includeArchived` are served by filtering the snapshot, not by
   re-querying per parameter.
3. `upsertGraphNamespace`, `archiveGraphNamespace`, and `deleteGraphNamespace`
   invalidate the snapshots immediately in-process.
4. After TTL expiry, the next call refreshes the snapshots from the table.
5. A second provider instance still serves its prior snapshot until its own TTL
   expiry (per-process invalidation; TTL-bounded convergence).

## Scenario Tests

1. Cold reader discovers available knowledge bases. Seed `default` and
   `corpus/pgsql-hackers`, ask what knowledge bases are available, and expect
   use of `graph_list_namespaces`.
2. Reader chooses a namespace before graph search. Seed two namespaces with
   distinct frontmatter and expect namespace discovery before graph traversal
   (fact search does not require namespace discovery first).
3. Reader loads details lazily. It should call `graph_get_namespace` only after
   choosing a likely namespace from frontmatter.
4. Harvester registers namespace before crawl. Verify `graph_upsert_namespace`
   is called and compact namespace details are stored.
5. Harvester does not rewrite namespace metadata per crawl. Run two crawl cycles
   and verify the row changes only when static details change.
6. Default namespace fallback. With only `default`, the agent should identify
   `default` (the NULL partition) instead of claiming no graph knowledge.
7. Archived namespace avoided. Agents should omit archived namespaces from
   discovery unless asked for them, even though direct search still works.
8. Facts-manager deletes namespace on explicit user request. Verify the registry
   row and that namespace's graph records are removed and source facts are not.

## Mini Eval Plan

This is a quality eval, not a gating test. Place it under the evals folder
(`packages/horizon-store/eval/`) with a separate eval runner that measures
behavior quality; it must not run in `./scripts/run-tests.sh` and must not be
subject to the no-retry gating rules. Implementation is deferred — skip it for
the initial implementation and add later.

When implemented, it runs HorizonDB-only when the HDB provider is enabled and
validates behavior rather than benchmarking retrieval quality exhaustively.

Seed two or three namespace rows with concise frontmatter, for example:

- `default`: general graph knowledge.
- `corpus/pgsql-hackers`: PostgreSQL mailing-list graph.
- `corpus/acme-support`: support-ticket graph.

For each graph-search eval prompt, record whether the agent:

1. Used namespace frontmatter from `graph_list_namespaces`.
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
- `packages/horizon-store/src/config.ts` (`registrySchema`, `namespaceCacheTtlMs`)
- `packages/sdk/src/graph-tools.ts` tool descriptions
- `packages/sdk/plugins/mgmt/agents/facts-manager.agent.md`
- graph-aware default prompt guidance
- Horizon harvester sample docs and agents, if the sample registers a namespace

## Important Constraint

Do not infer namespace discovery by scanning graph nodes on every list. The
sidecar registry should be the authoritative discovery surface. Graph scans can
remain useful for debugging, but `graph_list_namespaces` should be a cheap
relational query.