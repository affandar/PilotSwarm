# EnhancedFactStore — API Reference

> Status: Proposal · Companion: [01-functional-spec.md](./01-functional-spec.md) ·
> [03-design.md](./03-design.md) · [04-test-spec.md](./04-test-spec.md)
>
> This is the API contract for the EnhancedFactStore. TypeScript signatures are
> illustrative.

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
  /**
   * Retrieval over the FACTS STORE ONLY: lexical / semantic / hybrid.
   * NOTE: `query` is interpreted by `opts.mode` — a BM25 keyword query for
   * `lexical`, natural-language text (embedded) for `semantic`, and both for
   * `hybrid`. Callers/tool layers should surface this so an LLM passes keywords
   * (not a sentence) in lexical mode.
   */
  searchFacts(query: string, opts: SearchOpts, access: AccessContext): Promise<SearchResult>;

  /** Semantic nearest-neighbours of a known fact (pgvector cosine kNN, no re-embed). */
  similarFacts(scopeKey: string, opts: SimilarOpts, access: AccessContext): Promise<SearchResult>;

  // Graph retrieval/relatedness is NOT here — see §5 GraphInterface.
  // There is no `relatedFacts`: compose searchGraphNodes({ seeds }) + readFacts.
  // There is no `lineageFacts`: use base readFacts({ scope: "descendants" }), rank via searchFacts.
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

> **Composing semantic entry + graph expansion**:
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
  searchGraphNodes(q: GraphNodeQuery): Promise<GraphNodeHit[]>;   // takes seeds[] for fact-pivot
  searchGraphEdges(q: GraphEdgeQuery): Promise<GraphEdgeHit[]>;
  graphNeighbourhood(nodeKey: string, depth: number): Promise<SubGraph>;

  // write (upsert + merge; evidence OPTIONAL, unions in)
  upsertGraphNode(n: GraphNodeInput): Promise<GraphNodeRef>;
  upsertGraphEdge(e: GraphEdgeInput): Promise<GraphEdgeRef>;      // evidence unions in on re-assert
  mergeGraphNodes(fromKey: string, intoKey: string, reason: string): Promise<void>;

  // delete (no cross-store cascade)
  deleteGraphNode(nodeKey: string): Promise<boolean>;            // DETACH DELETE
  deleteGraphEdge(fromKey: string, toKey: string, predicateKey: string): Promise<boolean>;
}
```

### Write inputs

```ts
interface GraphNodeInput {
  kind: string;            // free text: person, patch, file, ...
  name: string;
  aliases?: string[];      // merged into existing aliases on upsert
  evidence?: string[];     // OPTIONAL fact scope_keys; unioned on upsert (node provenance)
  agentId: string;
}

interface GraphEdgeInput {
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
interface GraphNodeQuery {
  kind?: string;
  nameLike?: string;                        // lexical match on name/aliases (no embeddings)
  seeds?: string[];                         // fact scopeKeys OR node keys — anchors from a prior searchFacts()
  depth?: number;                           // hops to expand from seeds, clamped 1..5
  minConfidence?: number;
  limit?: number;
}

interface GraphEdgeQuery {
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

interface GraphEdgeRef {
  fromKey: string; toKey: string; predicate: string; predicateKey: string;
  confidence: number; observations: number; reinforced: boolean;
}
interface GraphEdgeHit {
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

## 7. Intentionally out of scope

Design decisions about what this API deliberately does **not** offer, and what to
use instead:

- **No `relatedFacts` method** (a "graph traversal that returns facts"). Keep the
  facts and graph surfaces orthogonal; compose `searchGraphNodes({ seeds })` +
  `readFacts`, or use the Phase 2 `searchGraphContext` (§8).
- **No `lineageFacts` method.** Lineage is base `readFacts({ scope: "descendants" })`,
  ranked via `searchFacts`.
- **No `"graph"` mode on `searchFacts`.** `searchFacts` is facts-store-only
  (`lexical`/`semantic`/`hybrid`); graph retrieval is a separate surface.
- **No mandatory-evidence rejection** on edge assertion. Evidence is optional and
  unions in on upsert; the graph stays permissive rather than failing writes.

## 8. Phase 2 — compound context reads

> **Phase 2.** These *compose* the Phase 1 primitives; they are gated behind a
> harvester having populated `EVIDENCED_BY`. With an unharvested graph they
> return exactly the seed facts (empty `nodes`/`edges`/`factLinks`). See
> [01-functional-spec.md §7](./01-functional-spec.md).

```ts
interface ContextOpts {
  mode?: SearchMode;        // entry searchFacts mode (searchGraphContext only)
  seedLimit?: number;       // facts entering the graph (default 10)
  depth?: number;           // graph hops from seeds, clamped 1..3 (default 1)
  expandLimit?: number;     // max nodes reached (default 50)
  factLimit?: number;       // max facts read back (default 50)
}
interface SimilarContextOpts extends Omit<ContextOpts, "mode"> {
  k?: number;               // similarFacts cluster size (default 8)
  minScore?: number;        // cluster cosine floor (0..1)
  maxFactLinks?: number;    // cap on derived fact↔fact links (default 50)
}

interface ContextNode { nodeKey: string; kind: string; name: string; aliases: string[]; evidence: string[]; }
interface ContextEdge {
  fromKey: string; toKey: string; predicate: string; predicateKey: string;
  confidence: number; observations: number; evidence: string[];
}

interface GraphContextResult {
  entry:  { query: string; mode: SearchMode };
  seeds:  ScoredFact[];                  // facts that entered the graph
  nodes:  ContextNode[];                 // entities reached via EVIDENCED_BY
  edges:  ContextEdge[];                 // relationships among them
  facts:  Record<string, FactRecord>;    // every referenced fact, deduped, keyed by scopeKey
}

/** A fact↔fact link inferred from a shared graph node. */
interface FactLink {
  aScopeKey: string; bScopeKey: string;
  via: { nodeKey: string; name: string }[];   // shared node(s) both facts evidence
  predicates: string[];                        // predicates on the connecting edges
}

interface SimilarGraphContextResult extends Omit<GraphContextResult, "entry"> {
  entry:     { scopeKey: string };       // the anchor fact
  factLinks: FactLink[];                 // cluster legibility — why facts relate
}

interface EnhancedFactStore {
  /** query → searchFacts → graph(seeds) → readFacts, as one ACL-checked bundle. */
  searchGraphContext(query: string, opts: ContextOpts, access: AccessContext): Promise<GraphContextResult>;

  /** known fact → similarFacts cluster → graph(seeds) → readFacts (+ factLinks). */
  similarGraphContext(scopeKey: string, opts: SimilarContextOpts, access: AccessContext): Promise<SimilarGraphContextResult>;
}
```

**Notes**

- Read-only; never writes the graph or mutates crawl state.
- ACL is applied on the entry retrieval **and** re-applied on the final
  `readFacts`, so an unreachable fact never leaks via a reachable node.
- `factLinks` (similar only) is bounded by `maxFactLinks` and 1-hop shared nodes.
