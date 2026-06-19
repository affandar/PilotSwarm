# External API and Schema Delta

This note summarizes the external-facing API, tool, and schema changes in this branch relative to `main` at merge-base `c899412d65c2c47dc913b50e61137d66cf92a351`.

It is intentionally focused on surfaces app authors, agent authors, operators, and provider implementers can see. Internal retry state and provider implementation details are listed only when they explain why a public API was or was not added.

## Summary

`main` has a PostgreSQL-backed facts key/value store with three LLM tools:

- `store_fact`
- `read_facts`
- `delete_fact`

This branch adds a graph-aware, search-capable facts stack while keeping the core API small:

- Base `FactStore` gains batch writes, explicit pattern deletes, crawl-queue receipts, and `scopeKey` round trips.
- `EnhancedFactStore` is introduced as a strict opt-in superset for facts search and embedder lifecycle only.
- `GraphStore` is a separate provider surface, not part of `EnhancedFactStore`.
- LLM tools gain batch store, explicit pattern delete, facts search, similar facts, skill search, graph tools, crawl tools for harvesters, and an operator-only embedder lifecycle tool.
- HorizonDB schema adds vector/BM25/AGE support, graph-crawl tracking, and a two-loop durable embedder.

No public API exposes embedder failure rows. `last_embed_error` is internal embedder state.

## TypeScript Store API Delta

### Base `FactStore`

`main`:

```ts
interface FactStore {
  storeFact(input): Promise<{ key; shared; stored: true }>;
  readFacts(query, access?): Promise<{ count; facts }>;
  deleteFact(input): Promise<{ key; shared; deleted }>;
  deleteSessionFactsForSession(sessionId): Promise<number>;
  getSessionFactsStats(sessionId): Promise<FactsStatsRow[]>;
  getFactsStatsForSessions(sessionIds): Promise<FactsStatsRow[]>;
  getSharedFactsStats(): Promise<FactsStatsRow[]>;
}
```

This branch adds:

```ts
interface FactRecord {
  scopeKey: string;
}

interface ReadFactsQuery {
  scopeKeys?: string[];
}

interface FactStore {
  storeFact(input: StoreFactInput): Promise<StoredFactResult>;
  storeFacts(inputs: StoreFactInput[]): Promise<{ stored: number; facts: StoredFactResult[] }>;

  deleteFact(input: DeleteFactInput): Promise<{ key: string; shared: boolean; deleted: boolean }>;
  deleteFacts(input: DeleteFactsInput): Promise<{
    deleted: number;
    keyPattern: string;
    scope: "session" | "shared" | "all";
  }>;

  readUncrawledFacts(opts?: { namespace?: string; limit?: number }): Promise<{ count: number; facts: FactRecord[] }>;
  markFactsCrawled(stamps: { scopeKey: string }[]): Promise<{ marked: number; skipped: number }>;
}
```

Why:

- `scopeKey` gives graph evidence a stable, lossless pointer back to the facts row.
- `scopeKeys` lets graph evidence resolve back to facts without inventing a second lookup API.
- `storeFacts` avoids per-row tool/proc calls for harvesters and other large ingestion paths.
- `deleteFacts` gives cleanup a scoped bulk path without making wildcard deletes implicit.
- `readUncrawledFacts` / `markFactsCrawled` are minimal graph-harvester bookkeeping: one queue read, one receipt stamp.

Minimalist assessment:

- Pass. These are orthogonal primitives, not compound workflows.
- Pass. Batch write and pattern delete are extensions of existing write/delete behavior.
- Pass. Crawl tracking uses `scopeKey` receipts only; no content hash or extra receipt model is exposed.
- Watch item. `readUncrawledFacts` is privileged and specialized, but it lives on base `FactStore` because graph crawling is facts-table bookkeeping and does not require semantic search.

### `EnhancedFactStore`

`main` has no `EnhancedFactStore`.

This branch adds:

```ts
interface EnhancedFactStore extends FactStore {
  readonly capabilities: { search: boolean; embedder: boolean };

  searchFacts(query: string, opts?: SearchOpts, access?: AccessContext): Promise<SearchResult>;
  similarFacts(scopeKey: string, opts?: SimilarOpts, access?: AccessContext): Promise<SearchResult>;

  configureEmbedder(endpoint: EmbeddingEndpointConfig, opts?: { restartIfRunning?: boolean }): Promise<EmbedderStatus>;
  startEmbedder(opts?: { intervalSeconds?: number; batch?: number }): Promise<EmbedderStatus>;
  stopEmbedder(reason?: string): Promise<EmbedderStatus>;
  embedderStatus(): Promise<EmbedderStatus>;
}
```

Why:

- `searchFacts` and `similarFacts` are facts-store retrieval primitives only. There is no `graph` search mode.
- Embedder methods are lifecycle controls for the durable in-database embedding generator that powers semantic retrieval.
- `capabilities` lets the runtime gate tools without checking database/provider internals every turn.

Minimalist assessment:

- Pass. The enhanced interface adds exactly two retrieval primitives and four lifecycle methods.
- Pass. Graph is not mixed into this interface.
- Pass. Embedder failure records are not exposed as store-user API.
- Watch item. Embedder lifecycle is operational rather than app-level, so it is gated to the Facts Manager tool surface and should not be presented as ordinary task-agent functionality.

### `GraphStore`

`main` has no graph store API.

This branch adds a separate `GraphStore` surface for open graph reads/writes:

```ts
interface GraphStore {
  searchGraphNodes(query, access?): Promise<GraphNodeHit[]>;
  searchGraphEdges(query, access?): Promise<GraphEdgeHit[]>;
  graphNeighbourhood(query, access?): Promise<SubGraph>;

  upsertGraphNode(input): Promise<GraphNodeRef>;
  upsertGraphEdge(input): Promise<GraphEdgeRef>;
  mergeGraphNodes(input): Promise<GraphNodeRef>;
  deleteGraphNode(input): Promise<boolean>;
  deleteGraphEdge(input): Promise<boolean>;
}
```

Why:

- Graph storage and traversal are a separate concern from facts retrieval.
- Fact rows remain the source of ACL-checked evidence; graph nodes/edges are shared published structure.

Minimalist assessment:

- Pass. The graph is a separate injected provider, not an expansion of `EnhancedFactStore`.
- Pass. Graph APIs are primitive CRUD/query operations. Compound graph-context reads are deferred.

## LLM Tool Delta

### Existing tools changed

#### `store_fact`

`main`: stores one fact by `{ key, value, tags?, shared? }`.

This branch: still stores one fact, and also accepts:

```json
{
  "facts": [
    { "key": "...", "value": {}, "tags": ["..."], "shared": true }
  ]
}
```

The batch form returns `{ stored, facts }`; single-fact form keeps the previous ergonomic result shape.

Why:

- Harvester ingestion and corpus loading should not require one LLM/tool/proc call per row.

Minimalist assessment:

- Pass. One existing tool learned a batch shape instead of adding a second `store_facts` tool.

#### `delete_fact`

`main`: deletes one exact key, session-scoped by default or shared when `shared=true`.

This branch: exact delete remains unchanged. Pattern delete requires explicit opt-in:

```json
{
  "key": "corpus/example/*",
  "pattern": true,
  "scope": "session" | "shared" | "all"
}
```

`scope="all"` is Facts Manager only. `*` is normalized to SQL `%` by the provider.

Why:

- Cleanup needs bounded bulk deletion.
- Wildcards are dangerous if implicit, so pattern mode is opt-in and scoped.

Minimalist assessment:

- Pass. This extends existing delete semantics without adding broad destructive defaults.
- Pass. `scope="all"` is explicitly privileged.

### New facts/search tools

These register only when the runtime has an enhanced facts provider with search capability:

- `facts_search`
- `facts_similar`
- `search_skills`

Why:

- `read_facts` is literal key/tag lookup; it is not a relevance search API.
- Skill lookup is common enough to deserve a narrow skills-scoped helper, but full skill content still comes from `read_facts`.

Minimalist assessment:

- Pass. `facts_search` and `facts_similar` map one-to-one to store primitives.
- Pass. `search_skills` is a thin namespace-specific read helper, not a second memory system.

### New embedder tool

Facts Manager only:

```text
manage_embedder(action="status" | "start" | "stop" | "configure")
```

No `failures` action is exposed.

Why:

- Operators need to configure/start/stop/check the durable embedder.
- Row-level failures are embedder internals; normal store users do not need a public failure inbox.

Minimalist assessment:

- Pass. Operational lifecycle only.
- Pass. Failure diagnostics were deliberately removed from the public tool/store surface.

### Graph and harvester tools

Graph tools register only when a graph provider is injected. Harvester crawl tools are privileged and are not ordinary reader/task-agent tools.

External graph-read shape is primitive:

- `graph_search_nodes`
- `graph_search_edges`
- `graph_neighbourhood`

Graph-write shape is primitive:

- `graph_upsert_node`
- `graph_upsert_edge`
- `graph_merge_nodes`
- `graph_delete_node`
- `graph_delete_edge`

Minimalist assessment:

- Pass. No compound graph-context API was added in this change.
- Pass. Graph reads filter evidence by facts ACL instead of adding graph-private ACL models.

## Schema Delta

### Base facts schema

`main` facts schema already has the core `facts` table and `scope_key` uniqueness.

This branch adds these external-facing schema behaviors:

- `last_crawled_at TIMESTAMPTZ` tracks whether a fact needs graph incorporation.
- `facts_store_facts(jsonb)` stores batches.
- `facts_delete_facts(pattern, scope, sessionId, unrestricted)` deletes scoped patterns.
- `facts_read_uncrawled(namespace, limit)` reads the harvester queue.
- `facts_mark_crawled(stamps)` stamps queue receipts.
- `facts_read_facts` supports `scopeKeys` for bulk evidence round trips.

Internal simplification:

- Old content-hash crawl receipts are removed from the final model.
- `last_crawled_at IS NULL` is the only crawl queue condition.
- `markFactsCrawled` accepts `{ scopeKey }` only.

Minimalist assessment:

- Pass. One crawl-state column, no public content-hash protocol.
- Pass. Stored procedures match public methods; no inline SQL caller surface.

### HorizonDB enhanced facts schema

`main` has no Horizon provider package/schema.

This branch adds `@pilotswarm/horizon-store`, with migrations for:

- facts table parity with PilotSwarm facts
- vector column for semantic search
- BM25/search text generated from `key + value::text`
- AGE graph bootstrap
- graph node/edge support through separate graph schema objects
- graph crawl queue via `last_crawled_at`
- durable embedding workflows

Final embedder state is intentionally small:

```text
embedding
embedding_model
last_embed_error
```

Dropped from the final schema/model:

```text
content_hash
last_embedded_hash
embedded_at
last_embed_error_at
embed_retry_at
facts_embedding_failures(...)
```

Two durable embedder workflows replace the older single-loop shape:

```text
embedder_batch_workflow(interval, batch)
embedder_retry_workflow(interval)
```

Runtime labels:

```text
hz-embed-batch-cron:<schema>
hz-embed-retry-cron:<schema>
```

The old `hz-embed-cron:<schema>` label is cancelled when the new embedder starts/stops/reconfigures.

Minimalist assessment:

- Pass. The final state has no timestamps or hashes for embedding.
- Pass. Retry state is a single internal sentinel: `last_embed_error = -1`.
- Pass. Terminal failure is internal and not surfaced through store/tool APIs.
- Watch item. `last_embed_error` remains a column because the embedder needs to avoid repeatedly selecting terminally bad rows. It is not part of public user-facing semantics.

## Why The API Changed

The API changed to support three concrete workflows that `main` cannot express efficiently or safely:

1. **Graph-backed knowledge harvesting**
   Facts need stable scope-key receipts so harvested graph evidence can point back to facts, and crawlers need a small work queue.

2. **Large corpus ingestion and cleanup**
   Harvesters and Facts Manager flows need batch writes and bounded cleanup without thousands of single-row calls.

3. **Semantic retrieval without Node-side embedding loops**
   HorizonDB owns embeddings in the database via durable workflows, so semantic/hybrid search can be provider-backed and crash-resilient.

The changes intentionally avoid adding higher-level compound APIs where primitives compose cleanly:

- No `lineageFacts`; use `readFacts({ scope: "descendants" })` and rank with `searchFacts` when needed.
- No graph mode inside `facts_search`; graph reads are separate.
- No public embedding-failure inbox; failure rows are embedder state.
- No content-hash receipts; `scopeKey` and `last_crawled_at` are sufficient.

## Minimalist Criteria Verdict

Overall: **yes, with two explicit privileged/operational exceptions**.

Passes:

- APIs are mostly primitive operations, not bundled workflows.
- Batch write and pattern delete extend existing store semantics instead of adding parallel tools.
- Graph is separated from enhanced facts.
- Crawl tracking uses one column and one receipt type.
- Embedder lifecycle is small and does not expose row-level internals.
- Search and graph tools are capability-gated and role-gated.

Exceptions to watch:

- `readUncrawledFacts` / `markFactsCrawled` are specialized harvester methods on the base store. They are justified because crawl state belongs to the facts table, but they should stay privileged and not become ordinary task-agent tools.
- `manage_embedder` is operational control, not app memory. It is justified for Facts Manager/operator use only and should remain tightly gated.

Rejected as non-minimal:

- Public `readEmbeddingFailures` / `manage_embedder(action="failures")`.
- Public content-hash crawl receipts.
- A monolithic `EnhancedFactStore` that also owns graph writes/reads.
- Compound graph-context APIs in this phase.
