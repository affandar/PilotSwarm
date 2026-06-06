# EnhancedFactStore — API Reference

> Status: Proposal · Companion: [01-functional-spec.md](./01-functional-spec.md) ·
> [03-design.md](./03-design.md) · [04-test-spec.md](./04-test-spec.md)
>
> This reflects the **target** API after the refactor. Types that change name are
> noted inline. TypeScript signatures are illustrative.

## 1. Configuration

```ts
/** OpenAI/Azure-OpenAI-compatible embeddings endpoint (database-agnostic). */
interface EmbeddingEndpointConfig {
  url: string;             // POST url (incl. any api-version query)
  model: string;           // model/deployment name sent in the body
  dim: number;             // vector dimension; MUST equal the vector(N) column
  apiKey?: string;         // sourced from .env / k8s secret
  apiKeyHeader?: string;   // default "api-key" (use "Authorization" for OpenAI)
  bearer?: boolean;        // prefix key with "Bearer " (OpenAI style)
  inputField?: string;     // request body field for the text(s). default "input"
  headers?: Record<string, string>;
  timeoutMs?: number;      // default 30_000
}

interface HorizonFactsConfig {
  connectionString: string;   // the Enhanced facts target (HorizonDB)
  schema?: string;            // default "horizon_facts"
  graphName?: string;         // default "horizon_facts"
  embedding?: EmbeddingEndpointConfig;
  annIndex?: "diskann" | "hnsw" | "auto";  // default "auto"
  poolMax?: number;
  useManagedIdentity?: boolean;
  aadUser?: string;
}
```

### 1a. PilotSwarm-level connection targets (packages/sdk)

The EnhancedFactStore target is selected by a new optional connection key on the
PilotSwarm client/worker/management-client. All three targets MAY be the same
database.

```ts
interface PilotSwarmConfig {
  store: string;                       // orchestration (ps_duroxide)
  cmsFactsDatabaseUrl?: string;        // CMS;  ?? store
  enhancedFactsDatabaseUrl?: string;   // EnhancedFactStore (HorizonDB);  ?? cmsFactsDatabaseUrl ?? store
  duroxideSchema?: string;             // default "ps_duroxide"
  cmsSchema?: string;                  // default "copilot_sessions"
  enhancedFactsSchema?: string;        // default "horizon_facts"
  // …existing fields…
}
```

Resolution: `enhancedFactsDatabaseUrl ?? cmsFactsDatabaseUrl ?? store`. Unset keys
reproduce today's single-/dual-database behaviour (fully back-compat). See
[03-design.md §1a](./03-design.md) for the topology and its interaction with the
§6 schema-isolation migration.

## 2. Base FactStore (unchanged)

```ts
interface FactStore {
  initialize(): Promise<void>;
  storeFact(input: StoreFactInput): Promise<{ key: string; shared: boolean; stored: true }>;
  readFacts(query: ReadFactsQuery, access?: AccessContext): Promise<{ count: number; facts: FactRecord[] }>;
  deleteFact(input: DeleteFactInput): Promise<{ key: string; shared: boolean; deleted: boolean }>;
  deleteSessionFactsForSession(sessionId: string): Promise<number>;
  getSessionFactsStats(sessionId: string): Promise<FactsStatsRow[]>;
  getFactsStatsForSessions(sessionIds: string[]): Promise<FactsStatsRow[]>;
  getSharedFactsStats(): Promise<FactsStatsRow[]>;
  close(): Promise<void>;
}
```

`storeFact` remains the write primitive and doubles as upsert (create/replace).
On content change it recomputes `content_hash` (re-mark embedding pending) and
resets `last_crawled_at → NULL` (§3a) in stores that carry those columns.

## 3. EnhancedFactStore — retrieval

```ts
interface EnhancedFactStore extends FactStore {
  /** Retrieval over the FACTS STORE ONLY: lexical / semantic / hybrid. */
  searchFacts(query: string, opts: SearchOpts, access: AccessContext): Promise<SearchResult>;

  /** Semantic nearest-neighbours of a known fact (pgvector cosine kNN, no re-embed). */
  similarFacts(scopeKey: string, opts: SimilarOpts, access: AccessContext): Promise<SearchResult>;

  // Graph retrieval/relatedness is NOT here — see §5 GraphInterface.
  // The old `relatedFacts` is removed: compose searchGraphNodes({ seeds }) + readFacts.
  // `lineageFacts` is removed: use base readFacts({ scope: "descendants" }), rank via searchFacts.
}
```

### Option shapes

```ts
type SearchMode = "lexical" | "semantic" | "hybrid";   // NO "graph"

interface SearchOpts {
  mode?: SearchMode;                       // default "hybrid"
  scope?: ReadFactsQuery["scope"];
  namespace?: string;                      // key-prefix filter, e.g. "skills"
  tags?: string[];
  limit?: number;                          // default 20
  candidatePool?: number;                  // per-signal pool before fusion (50)
  weights?: { lexical?: number; semantic?: number };
  minSemanticScore?: number;               // 0..1
}

interface SimilarOpts  { k?: number; minScore?: number; namespace?: string; }   // semantic

interface ScoredFact extends FactRecord {
  score: number;
  signals: { lexical?: number; semantic?: number };
}
interface SearchResult { count: number; mode: SearchMode; facts: ScoredFact[]; }
```

> **Composing semantic entry + graph expansion** (replaces `relatedFacts`):
> ```ts
> const seeds = (await store.searchFacts(q, { mode: "semantic" }, acl)).facts.map(f => f.scopeKey);
> const nodes = await graph.searchGraphNodes({ seeds, depth: 2 });
> const connectedKeys = nodes.flatMap(n => n.evidence);
> const related = await store.readFacts({ keys: connectedKeys }, acl);
> ```

### 3a. Crawl tracking (harvester support)

```ts
interface EnhancedFactStore {
  /** Facts not yet incorporated into the graph (last_crawled_at IS NULL), ACL-scoped. */
  readUncrawledFacts(opts: { limit?: number }, access?: AccessContext): Promise<{ count: number; facts: FactRecord[] }>;

  /** Stamp last_crawled_at = now() after incorporating these facts into the graph. */
  markFactsCrawled(scopeKeys: string[]): Promise<{ marked: number }>;
}
```

- `last_crawled_at` resets to `NULL` automatically on any `storeFact` content
  change (DB trigger on `content_hash`). Pending-crawl is
  therefore `last_crawled_at IS NULL`.
- Harvester loop: `readUncrawledFacts` → extract → `upsertGraphNode` /
  `upsertGraphEdge` → `markFactsCrawled`.

## 4. Embedding lifecycle

```ts
interface EmbedderStatus {
  running: boolean;        // true while the durable loop is pending/running
  instanceId?: string;     // pg_durable instance id of the loop
  status?: string;         // raw df status (pending/running/completed/cancelled/failed)
}

interface EnhancedFactStore {
  /** Record/replace the endpoint config in durable variables (df.setvar). */
  configureEmbedder(endpoint: EmbeddingEndpointConfig): Promise<void>;

  /** Start the single eternal batch-embedding loop. Idempotent. */
  startEmbedder(opts?: { intervalSeconds?: number; batch?: number }): Promise<EmbedderStatus>;

  /** Cancel the loop. No-op if already stopped. */
  stopEmbedder(reason?: string): Promise<EmbedderStatus>;

  /** Current lifecycle state. */
  embedderStatus(): Promise<EmbedderStatus>;
}
```

**Notes**

- `startEmbedder` defaults: `intervalSeconds = 5`, `batch = 128`.
- Idempotency keys off a stable pg_durable label per schema
  (`hz-embed-cron:<schema>`).
- Config is read from durable vars at each tick, so `configureEmbedder` can be
  called while running and the loop picks up the change on the next iteration.

## 5. GraphInterface

```ts
interface GraphInterface {
  // read
  searchGraphNodes(q: GraphNodeQuery): Promise<GraphNodeHit[]>;   // was searchEntities; takes seeds[]
  searchGraphEdges(q: GraphEdgeQuery): Promise<GraphEdgeHit[]>;   // was searchEdges/searchRelationships
  graphNeighbourhood(nodeKey: string, depth: number): Promise<SubGraph>;  // was neighbourhood

  // write (upsert + merge; evidence OPTIONAL, unions in)
  upsertGraphNode(n: GraphNodeInput): Promise<GraphNodeRef>;      // was upsertEntity
  upsertGraphEdge(e: GraphEdgeInput): Promise<GraphEdgeRef>;      // was upsertEdge; absorbs linkEvidence
  mergeGraphNodes(fromKey: string, intoKey: string, reason: string): Promise<void>;  // was mergeEntities

  // delete (no cross-store cascade)
  deleteGraphNode(nodeKey: string): Promise<boolean>;            // was deleteEntity; DETACH DELETE
  deleteGraphEdge(fromKey: string, toKey: string, predicateKey: string): Promise<boolean>;  // was deleteEdge
}
```

### Write inputs

```ts
interface GraphNodeInput {                 // was EntityInput / EntityAssertion
  kind: string;            // free text: person, patch, file, ...
  name: string;
  aliases?: string[];      // merged into existing aliases on upsert
  evidence?: string[];     // OPTIONAL fact scope_keys; unioned on upsert (node provenance)
  agentId: string;
}

interface GraphEdgeInput {                 // was EdgeInput / RelAssertion
  fromKey: string;         // nodeKey OR fact scope_key (by convention)
  toKey: string;
  predicate: string;       // free text, e.g. "revives argument from"
  confidence?: number;     // 0..1, default 1.0
  evidence?: string[];     // OPTIONAL; unioned on upsert (edge provenance)
  agentId: string;
  model?: string;
}
```

### Read inputs / outputs

```ts
interface GraphNodeQuery {                  // was EntityQuery
  kind?: string;
  nameLike?: string;                        // lexical match on name/aliases (no embeddings)
  seeds?: string[];                         // fact scopeKeys OR node keys — anchors from a prior searchFacts()
  depth?: number;                           // hops to expand from seeds, clamped 1..5
  minConfidence?: number;
  limit?: number;
}

interface GraphEdgeQuery {                  // was RelQuery / EdgeQuery
  predicate?: string;                       // EXACT text (app-owned ontology)
  predicateKey?: string;                    // EXACT normalized key (preferred)
  fromKey?: string;                         // anchor endpoints (explore mode)
  toKey?: string;
  minConfidence?: number;
  limit?: number;
}

interface GraphNodeRef { nodeKey: string; kind: string; name: string; aliases: string[]; created: boolean; }
interface GraphNodeHit {
  nodeKey: string; kind: string; name: string; aliases: string[];
  evidence: string[];                       // EVIDENCED_BY fact scopeKeys — feed straight into readFacts
  score?: number;
}

interface GraphEdgeRef {                     // was RelRef / EdgeRef
  fromKey: string; toKey: string; predicate: string; predicateKey: string;
  confidence: number; observations: number; reinforced: boolean;
}
interface GraphEdgeHit {                      // was RelHit / EdgeHit
  fromKey: string; toKey: string; predicate: string; predicateKey: string;
  confidence: number; observations: number; evidence: string[];
}

interface SubGraph {
  nodes: { nodeKey: string; kind: string; name: string }[];
  edges: { fromKey: string; toKey: string; predicate: string; confidence: number }[];
}
```

## 6. Error semantics

| Condition | Behaviour |
|-----------|-----------|
| Missing extension at `initialize()` | Throws, naming the missing extension + fix. |
| `searchFacts(semantic/hybrid)` with no embedding endpoint | Throws (semantic requires query embedding). |
| `upsertGraphEdge` to a missing endpoint node | Throws (both endpoints must exist). |
| `mergeGraphNodes` into a missing target | Throws. |
| `graphNeighbourhood` / delete on unknown key | Returns empty / `false` (not an error). |
| `searchGraphNodes` with unknown seeds | Returns empty (not an error). |
| `startEmbedder` when already running | No-op; returns existing status. |
| `stopEmbedder` when already stopped | No-op; returns `{ running: false }`. |

## 7. Removed surface

- `relatedFacts` (graph-traversal-returns-facts) — compose
  `searchGraphNodes({ seeds })` + `readFacts` instead.
- `lineageFacts` — lineage is base `readFacts({ scope: "descendants" })` (rank via
  `searchFacts`); no dedicated method.
- `searchFacts` `"graph"` mode — `searchFacts` is facts-store-only
  (`lexical`/`semantic`/`hybrid`).
- `HttpEmbeddingCapability`, `inDbHttp`, all capability-flag branching and Node
  fallback.
- `_embedPendingNode`, `_embedNewFactsInDbOnce`.
- `startRecurringEmbedder` / `stopRecurringEmbedder` / `recurringEmbedderStatus`
  (replaced by `startEmbedder` / `stopEmbedder` / `embedderStatus`).
- `linkEvidence` (folded into `upsertGraphNode` / `upsertGraphEdge`).
- The `Entity*` / `Rel*` / `Edge*` and `GraphCrawlerInterface` names (renamed to
  `GraphNode*` / `GraphEdge*` / `GraphInterface`).
- Mandatory-evidence rejection on edge assertion.
