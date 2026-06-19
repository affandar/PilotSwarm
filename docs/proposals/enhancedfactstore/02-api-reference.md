# EnhancedFactStore — API Reference

> Status: Proposal · Companion: [01-functional-spec.md](./01-functional-spec.md) ·
> [03-design.md](./03-design.md) · [04-test-spec.md](./04-test-spec.md)
>
> This is the API contract for the EnhancedFactStore. TypeScript signatures are
> illustrative.
>
> **Shape alignment ([07-pilotswarm-integration.md](./07-pilotswarm-integration.md) is
> canonical):** the graph is a **separate injected `GraphStore`** (its own provider
> `HorizonDBGraphStore` + `graphDatabaseUrl`), not bundled into `EnhancedFactStore`;
> the **crawl queue** (`readUncrawledFacts` / `markFactsCrawled`) lives on the **base
> `FactStore`**; the enhanced provider is **`HorizonDBFactStore`**; the package is
> **`@pilotswarm/horizon-store`**. Read `GraphInterface` / `factsStoreProvider` /
> "one bundled provider" wording below through that shape.

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

### 1b. Store-provider selection (packages/sdk)

The enhanced store is selected by **dependency injection, not URL sniffing**: the
caller passes a `FactStore` provider into the PilotSwarm initializer.

```ts
interface PilotSwarmConfig {
  // …connection keys above…
  factsStoreProvider?: FactStore;   // default: PgFactStore on the resolved facts URL
}
```

- When the provided store implements `EnhancedFactStore` (capability-detected),
  the worker **lights up the additional features**: the `facts_search` /
  `facts_similar` / crawl-queue / `graph_*` tools are registered alongside the
  base fact tools (05-tools-spec), and Phase 2 context tools once enabled.
- Base agent instructions are **store-aware**: the worker's base prompt calls out
  which skill/tooling surface to load depending on the provided store (base
  `FactStore` → base fact tools only; `EnhancedFactStore` → the enhanced
  retrieval + graph skill).
- With no provider supplied, behaviour is exactly today's: `PgFactStore` against
  the resolved facts URL. The enhanced provider's `initialize()` still fails fast
  (§6) if its target lacks the required extensions — supplying an
  `EnhancedFactStore` pointed at plain Postgres is a startup error by design.

### 1c. Base-API prerequisites (packages/sdk)

Two small, additive SDK changes the composition patterns below depend on:

```ts
interface FactRecord {
  scopeKey: string;                 // NEW — canonical scope key, exposed on reads
  // …existing fields…
}

interface ReadFactsQuery {
  scopeKeys?: string[];             // NEW — read an explicit set of facts by scope_key
  // …existing fields…
}
```

`scopeKeys` is the by-key bulk read used to resolve graph `evidence` back into
facts (`readFacts({ scopeKeys }, access)`); ACL applies as for any read. Without
these, the seed/evidence round-trips in §3 and §8 are not expressible.

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
On content change it clears derived embedding state and resets
`last_crawled_at → NULL` (§3a) in stores that carry those columns. See
[08-embedding-handling.md](./08-embedding-handling.md).

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

  // Graph retrieval/relatedness is NOT here — see §5 GraphStore.
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
> const nodes = await graph.searchGraphNodes({ seeds, depth: 2 }, acl);   // evidence ACL-filtered
> const connectedKeys = nodes.flatMap(n => n.evidence);
> const related = await store.readFacts({ scopeKeys: connectedKeys }, acl);   // §1c base-API addition
> ```

### 3a. Crawl tracking (generic crawler support)

```ts
/** Crawl-queue receipt: the scope key returned by readUncrawledFacts. */
interface CrawledFactStamp { scopeKey: string; }

// NOTE (07 D3): the crawl queue lives on the BASE `FactStore`, not the enhanced
// interface — it is vanilla facts-table bookkeeping (a nullable `last_crawled_at`
// column + two procs, no extension), so a base-facts deployment can feed any
// external crawler/consumer. A graph harvester is one possible consumer, not a
// built-in store responsibility.
interface FactStore {
  storeFact(input: StoreFactInput): Promise<StoredFactResult>;
  storeFact(input: StoreFactInput[]): Promise<{ stored: number; facts: StoredFactResult[] }>;
  deleteFact(input: DeleteFactInput): Promise<{ key: string; shared: boolean; deleted: boolean }>;
  deleteFact(input: DeleteFactInput & { pattern: true }): Promise<{ deleted: number; keyPattern: string; scope: "session" | "shared" | "all" }>;

  /**
   * Facts not yet consumed by a crawler (last_crawled_at IS NULL).
   * PRIVILEGED: crawler roles are trusted; this read spans ALL facts
   * (shared + every session), regardless of caller session. Each returned
   * fact carries its scopeKey for the markFactsCrawled receipt.
   */
  readUncrawledFacts(opts: { namespace?: string; limit?: number }):
    Promise<{ count: number; facts: FactRecord[] }>;

  /**
  * Stamp last_crawled_at = now() after a crawler consumes these facts.
  * PRIVILEGED (same trust as readUncrawledFacts). Skipped stamps mean
  * the fact was already marked or no longer exists.
   */
  markFactsCrawled(stamps: CrawledFactStamp[]): Promise<{ marked: number; skipped: number }>;
}
```

`storeFact` is overloaded for single-row and batch ingestion. `deleteFact` has an
explicit pattern-delete mode (`*` globs normalize to SQL `%`) and must be scoped:
ordinary agents use `session` or `shared`; Facts Manager can use `all` for
privileged cleanup.

- `last_crawled_at` resets to `NULL` automatically on any `storeFact` content
  change (DB trigger on `key` / `value`). Pending-crawl is
  therefore `last_crawled_at IS NULL`.
- Example graph-fill loop: `readUncrawledFacts` → extract → `upsertGraphNode` /
  `upsertGraphEdge` → `markFactsCrawled(stamps)`. A non-graph crawler can consume
  the same queue for another sink.
- **Privileged surface.** Crawling is a deliberate, host-granted capability:
  these two methods are only exposed to the harvester role (they are not
  registered as tools for ordinary reader agents). They take no
  `AccessContext` because the crawler reads everything by design.

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
- **Config snapshot semantics (pg_durable contract).** Durable variables are
  *captured at `df.start()` and immutable for the run* — pg_durable explicitly
  forbids `df.setvar` from inside a running durable function. An eternal loop
  therefore never observes a var change. Consequently `configureEmbedder`
  writes the durable vars and, **if the loop is running, restarts it**
  (`df.cancel` + `df.start` under the same stable label) so the new config —
  including a rotated API key — takes effect immediately. `embedderStatus()`
  reports the new `instanceId` after a restart. When the loop is stopped,
  `configureEmbedder` only writes the vars.
- **Model rotation.** The configured `model` is stamped per row
  (`embedding_model`). A fact is **pending** when
  `last_embed_error IS NULL` and (`embedding IS NULL OR embedding_model IS
  DISTINCT FROM <configured model>`) — i.e. rows embedded under a different model
  are treated as having NULL embeddings and are re-embedded by the loop. Semantic
  search likewise ignores mismatched-model vectors. Changing `dim` still requires
  a migration of the `vector(N)` column.

## 5. GraphStore

> **Separate provider (07 D2).** `GraphStore` is its own interface, implemented by
> a **separate provider** `HorizonDBGraphStore` (AGE-only) and injected
> independently of the fact store. It is **not** part of `EnhancedFactStore`.

> **Shared-scope surface (ingestion contract).** The graph has no per-node/edge
> ACL: incorporating a fact **publishes** its extracted entities/relationships
> to every reader (the privileged harvester decides what to publish — see
> [01 §6.1a](./01-functional-spec.md)). Reads compensate at the pointer level:
> all graph reads take the caller's `AccessContext`, returned `evidence` arrays
> are **filtered to caller-accessible scopeKeys** (syntactic check on
> `shared:` / `session:<id>:`), and seed fact scopeKeys the caller cannot read
> are ignored. Traversal uses the full evidence set internally; the harvester
> reads `unrestricted`.

```ts
interface GraphStore {
  // read (evidence arrays ACL-filtered; inaccessible seeds ignored)
  searchGraphNodes(q: GraphNodeQuery, access: AccessContext): Promise<GraphNodeHit[]>;   // takes seeds[] for fact-pivot
  searchGraphEdges(q: GraphEdgeQuery, access: AccessContext): Promise<GraphEdgeHit[]>;
  graphNeighbourhood(nodeKey: string, depth: number, access: AccessContext): Promise<SubGraph>;

  // write (upsert + merge; evidence OPTIONAL, unions in)
  upsertGraphNode(n: GraphNodeInput): Promise<GraphNodeRef>;
  // Re-assert reinforces (observations++, noisy-OR) ONLY when the assertion
  // carries ≥1 evidence scopeKey not already on the edge, or carries no
  // evidence at all. Re-asserting with only already-known evidence is an
  // idempotent no-op (evidence union unchanged, no confidence bump) — so a
  // duplicate/replayed harvest of the same fact cannot inflate confidence.
  upsertGraphEdge(e: GraphEdgeInput): Promise<GraphEdgeRef>;
  // Repointed edges that collide with an existing survivor triple COMBINE
  // (evidence union, observations sum, noisy-OR) — but only when the duplicate
  // edge carries NOVEL evidence; an all-known-evidence collision just drops
  // the duplicate (the GR7 principle extended to merges, so a replayed merge
  // cannot double-count).
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
  seeds?: string[];                         // fact scopeKeys OR node keys — anchors from a prior searchFacts().
                                            // Fact seeds the caller cannot read are ignored (treated as unknown).
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
  evidence: string[];                       // EVIDENCED_BY fact scopeKeys, FILTERED to caller-accessible
                                            // keys — feed straight into readFacts (always resolvable)
  score?: number;
}

interface GraphEdgeRef {
  fromKey: string; toKey: string; predicate: string; predicateKey: string;
  confidence: number; observations: number; reinforced: boolean;
}
interface GraphEdgeHit {
  fromKey: string; toKey: string; predicate: string; predicateKey: string;
  confidence: number; observations: number; evidence: string[];   // ACL-filtered, as above
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
| `similarFacts` anchor exists but is **not accessible** to the caller | Empty result — identical to an unknown scope_key, so inaccessible facts are not distinguishable from absent ones (no similarity oracle). |
| `upsertGraphEdge` to a missing endpoint node | Throws (both endpoints must exist). |
| `mergeGraphNodes` into a missing target | Throws. |
| `graphNeighbourhood` / delete on unknown key | Returns empty / `false` (not an error). |
| `searchGraphNodes` with unknown seeds | Returns empty (not an error). |
| `searchGraphNodes` with seeds the caller cannot read | Those seeds are ignored — indistinguishable from unknown (no probe oracle on private facts). |
| `startEmbedder` when already running | No-op; returns existing status. |
| `stopEmbedder` when already stopped | No-op; returns `{ running: false }`. |
| `configureEmbedder` while running | Writes vars, **restarts** the loop (cancel + start, same label, new `instanceId`) — vars are captured at `df.start`. |
| `markFactsCrawled` stamp for an already-marked or missing fact | Skipped, counted in `skipped` (not an error). |

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
  `readFacts`, so an unreachable fact never leaks via a reachable node. The
  underlying graph reads also filter `evidence` arrays to the caller's ACL
  (§5), so the bundle is **exactly self-resolving**: every `evidence` key on
  every returned node/edge has an entry in `facts`.
- `factLinks` (similar only) is bounded by `maxFactLinks` and 1-hop shared nodes.
