# EnhancedFactStore — Functional Specification

> Status: Proposal · Incubation package: `@pilotswarm/horizon-store`
> Companion docs: [02-api-reference.md](./02-api-reference.md) ·
> [03-design.md](./03-design.md) · [04-test-spec.md](./04-test-spec.md)
>
> **Shape alignment (canonical: [07-pilotswarm-integration.md](./07-pilotswarm-integration.md)).**
> The graph is a **separate, independently injected `GraphStore`** (own provider
> `HorizonDBGraphStore` + `graphDatabaseUrl`), not bundled into
> `EnhancedFactStore`; the **crawl queue** lives on the **base `FactStore`**; the
> enhanced fact provider is **`HorizonDBFactStore`**. Read `GraphInterface` /
> bundled-provider wording below through that shape.

## 1. Purpose

The **EnhancedFactStore** is a strict superset of PilotSwarm's existing
`FactStore`. It keeps the full key/value (KV) facts API unchanged and adds three
capabilities on top:

1. **Multi-signal retrieval** — lexical, semantic (vector), and graph-aware
   search over the same fact corpus.
2. **An open knowledge graph** — a free-form graph of nodes/edges that a harvesting
   ("crawler") agent populates from facts, with no fixed ontology.
3. **A provider-internal embedding generator** — facts are embedded durably and
   automatically, entirely inside the database.

The first concrete provider is **HorizonDB** (Azure HorizonDB preview), but the
interface is database-agnostic. The embedding endpoint is an OpenAI/Azure-OpenAI
HTTP contract that any provider can consume.

## 1a. Where the EnhancedFactStore sits (logical view)

```mermaid
flowchart TB
  APP["App agents (the app)<br/>read role + harvester role"]
  EFS["EnhancedFactStore<br/>facts, vector, graph, embedder<br/>(HorizonDB)"]
  PS["PilotSwarm runtime"]
  CMS["CMS<br/>session catalog"]
  DUR["Duroxide<br/>durable orchestration"]

  APP -->|Tool execution| EFS
  APP -->|runs on| PS
  PS -->|consumes| CMS
  PS -->|consumes| DUR
```

**Reading the view (logical, not physical)**

- **App agents = the app.** The same app acts in a **read role** and a
  **harvester role**. Logically, agents **call tools directly** on the
  EnhancedFactStore — the arrow labelled **Tool execution** is exactly that. The
  physical mechanics (prompts through `PilotSwarmClient`, durable turns on
  duroxide, the worker dispatching tool handlers) are intentionally omitted here.
- **Agents run on PilotSwarm.** The application executes on top of the PilotSwarm
  runtime.
- **PilotSwarm sits on duroxide and consumes CMS.** The runtime consumes both the
  **CMS** (session catalog) and **Duroxide** (durable orchestration) as its
  substrate.
- **The EnhancedFactStore is the app's knowledge surface**, physically resident in
  HorizonDB (facts + pgvector + AGE graph + the in-DB embedder).

> Physical detail — for the record: a tool call travels LLM → worker-internal tool
> handler → `EnhancedFactStore` API (e.g. `factStore.storeFact(...)`) → stored proc
> / typed Cypher → HorizonDB. It does **not** route back out through
> `PilotSwarmClient`. The logical view above collapses that path to the single
> **Tool execution** arrow.

## 2. Scope & non-goals

**In scope**

- A drop-in superset of `FactStore` (existing callers keep working).
- Lexical + semantic + graph retrieval and hybrid fusion.
- A durable, in-database embedding pipeline with a simple lifecycle
  (configure → start → stop → status).
- An open graph interface (nodes, edges, neighbourhood, merge,
  delete).

**Adjacent (PilotSwarm core, prerequisite)**

- **`scopeKeys` on the base read API.** `ReadFactsQuery` gains
  `scopeKeys?: string[]` (bulk read of an explicit fact set) and `FactRecord`
  exposes `scopeKey`. Every seed/evidence round-trip in this spec
  (`searchFacts` seeds → graph → `readFacts({ scopeKeys })`) depends on it.
  Additive, ACL-scoped like any read. `packages/sdk` change. See
  [02-api-reference.md §1c](./02-api-reference.md).

- **Store-provider injection.** The caller provides the facts-store provider in
  the PilotSwarm initializer (`factsStoreProvider`); supplying an
  `EnhancedFactStore` lights up the additional features — the enhanced
  retrieval / crawl-queue / graph tools — and the base agent instructions call
  out which skill to load based on the store provided. No provider ⇒ today's
  `PgFactStore`. `packages/sdk` change. See
  [02-api-reference.md §1b](./02-api-reference.md).

- **Separate connection target for the enhanced store.** PilotSwarm gains an
  optional `enhancedFactsDatabaseUrl` (+ `enhancedFactsSchema`) so the
  EnhancedFactStore can live on its own HorizonDB while orchestration (`store`)
  and CMS (`cmsFactsDatabaseUrl`) stay on plain Postgres. Resolution is
  `enhancedFactsDatabaseUrl ?? cmsFactsDatabaseUrl ?? store`, so all three MAY be
  the same database. See [03-design.md §1a](./03-design.md). `packages/sdk` change.

- **Orchestration schema isolation.** PilotSwarm's duroxide state provider and
  HorizonDB's pg_durable both default to the `duroxide` schema. PilotSwarm's
  default orchestration schema is renamed to **`ps_duroxide`** via an **online,
  single-transaction** migration that renames and arms a recreation guard
  atomically — old workers fail loud but cannot recreate the old store (no fleet
  drain, no rolling-deploy split-brain). See [03-design.md §6](./03-design.md).
  This is a `packages/sdk` change, not part of the incubator, but is a
  prerequisite for co-located deployments.

**Non-goals (for this iteration)**

- A fixed ontology or schema for graph predicates (predicates are free text).
- A contractual link between the KV facts store and the graph. **The harvester
  agent manages the facts KV and the facts graph as two separate lifecycles; the
  linkage between them is by convention, not enforced by this contract.**
- Cascade deletion from facts into the graph (see §6.4).
- Cross-database or multi-tenant graph isolation.
- Production-grade secret handling for the embedding key (see §5.4).

## 3. Actors

The **crawler/harvester is not a separate party — it is a role the application
plays.** Both the application's read path and its harvesting path are the same
"app"; either can write facts and/or assert graph nodes/edges into the graph. The
table below separates these by *role*, not by deployment boundary.

| Actor | Role |
|-------|------|
| **Application (read role)** | Reads facts and runs search / similar queries (incl. base `readFacts` lineage scope). |
| **Application (harvester/crawler role)** | Writes facts (KV) and/or asserts graph nodes/edges into the graph. The harvester is **part of the app itself**, not an external service. |
| **Provider runtime** | Configures the store, runs migrations, owns the durable embedding generator. |
| **HorizonDB / Postgres** | Executes stored procedures, pgvector ops, AGE Cypher, and the pg_durable embedding loop. |

> Because the harvester is just the app in its write role, the KV facts and the
> graph are written by the **same application**, but still as two separate
> lifecycles linked only by convention (see §2 non-goals and §6.4). "Harvester
> agent" elsewhere in these docs means the app acting in this role.

## 4. Functional requirements — retrieval (EnhancedFactStore)

### 4.1 Base FactStore (unchanged)

`storeFact`, `readFacts`, `deleteFact`, `deleteSessionFactsForSession`,
`getSessionFactsStats`, `getFactsStatsForSessions`, `getSharedFactsStats`,
`initialize`, `close` behave exactly as today. All access is ACL-scoped
(shared / session / granted / unrestricted).

`storeFact` remains the write primitive and doubles as upsert (create/replace).
Any content change re-marks the fact **pending for embedding** (recomputes
`content_hash`) and **resets crawl state** (`last_crawled_at → NULL`, §6.6) in
stores that track those columns.

### 4.2 `searchFacts(query, opts, access)` — facts store only

Retrieval **over the facts store only**. `mode ∈ { lexical, semantic, hybrid }`
(default `hybrid`). **There is no `graph` mode** — graph retrieval is a separate
API (§6). Signal type (text/semantic/hybrid) is orthogonal to *which store* you
query; `searchFacts` is purely the facts store.

- **lexical** — BM25 keyword match over fact key + value text. `query` is a
  **keyword/terms query**, not a natural-language sentence.
- **semantic** — pgvector cosine kNN over `facts.embedding` (query embedded at
  call time via the Node embedding client). `query` is **natural language**.
- **hybrid** — weighted fusion of lexical + semantic; a missing signal
  contributes 0. `query` is used **both ways** (BM25 + embedded).

The `query` argument's expected shape therefore depends on `mode`; tool layers
that expose `searchFacts` to an LLM must make this explicit so the model passes
keywords (not a sentence) in lexical mode.

**ACL is applied inside the search procedures, before ranking and `LIMIT`** —
the access predicate (shared / session / granted / unrestricted) is part of the
candidate `WHERE` clause, exactly as in the base store's `readFacts` proc. This
guarantees a session-scoped caller's accessible matches are never starved out of
a bounded candidate pool by inaccessible higher-ranked rows, and removes the
side-channel where pool exhaustion reveals that inaccessible matches exist. The
provider MAY additionally re-check ACL on the assembled result as
defense-in-depth, but post-filtering is never the primary mechanism. Every hit
carries per-signal score contributions for debuggability. `searchFacts` output (an array of fact
scopeKeys) is the natural **seed** for a follow-on graph query (§6.5) — that is
how the "semantic entry point → graph expansion" pattern is composed by the
caller, rather than being hidden inside a `graph` mode.

### 4.3 `similarFacts(scopeKey, opts, access)`

Pure **semantic** nearest-neighbours of a known fact (cosine kNN over the fact's
**stored** vector — no re-embedding, no query string). Never touches the graph.
Returns ACL-filtered `ScoredFact[]` with a `semantic` signal. Distinct from
`searchFacts` by **anchor type**: an existing fact key, not query text.

The **anchor itself is ACL-checked first**: anchoring on a fact that exists but
is not accessible to the caller returns an empty result, indistinguishable from
an unknown `scopeKey`. (Otherwise result rankings would act as a similarity
oracle against private facts.)

> **No dedicated `relatedFacts`.** Graph-aware relatedness belongs to the graph
> API: `searchGraphNodes({ seeds: [...] })` expands from seed facts/nodes, then
> `readFacts` on the connected fact keys returns facts. This keeps facts
> retrieval (this section) orthogonal to graph traversal (§6).

> **No dedicated `lineageFacts`.** Lineage scoping is already in the base `FactStore`:
> `readFacts({ sessionId, scope: "descendants" }, { grantedSessionIds })` reads
> spawn-tree facts. To rank them, pass the query through `searchFacts` (which is
> ACL-filtered the same way). No dedicated lineage retrieval method is needed.

## 5. Functional requirements — embedding generator

### 5.1 Lifecycle (the only public embedding surface)

| Operation | Behaviour |
|-----------|-----------|
| `configureEmbedder(endpoint)` | Record the embedding endpoint config (url, model, dim, key, key header, input field) into durable config. **If the loop is running, restart it** (cancel + start, same label) — pg_durable captures durable variables at `df.start()` and they are immutable for the run, so a restart is the only way a running loop can observe new config (incl. key rotation). |
| `startEmbedder({ intervalSeconds, batch })` | Launch a single durable, eternal loop that embeds pending facts in batches. Idempotent. |
| `stopEmbedder()` | Cancel the loop. No-op if already stopped. |
| `embedderStatus()` | Report `{ running, instanceId?, status? }`. |

Callers never trigger embedding directly and never wait on a durable instance.
They write facts and observe the **outcome**: the vector appears and semantic
search returns the fact.

### 5.2 What "pending" means

A fact needs embedding when

```
embedding IS NULL
OR last_embedded_hash IS DISTINCT FROM content_hash
OR embedding_model    IS DISTINCT FROM <configured model>
```

Storing a fact with changed content re-marks it pending, so the loop re-embeds
it on its next tick. Content hashing makes re-embedding idempotent (no
re-billing for unchanged content).

**Model rotation.** The model used to generate an embedding is stored with it
(`embedding_model`, stamped by the loop). Any row whose `embedding_model`
differs from the currently configured model is treated **as if its embedding
were NULL** — pending for the embedder, ignored by semantic search — because
vectors from different models are not comparable. Rotating the model therefore
triggers a rolling re-embed of the corpus with no manual reset. Changing the
vector **dimension** additionally requires a migration of the `vector(N)`
column.

### 5.3 Batch embedding

The loop embeds a **batch per tick** using the endpoint's array-input API
(`input: [t1, t2, …]` → `data[]` in order) — one HTTP request per batch, not per
fact. Vectors are mapped back to facts positionally.

**Write-back is guarded against mid-flight edits.** The batch captures each
fact's `content_hash` at **select time**; the write-back sets
`last_embedded_hash = <hash captured at select>` (never the row's current
`content_hash`) and stamps `embedding_model`. A fact edited while the HTTP call
was in flight therefore still satisfies `last_embedded_hash IS DISTINCT FROM
content_hash` and is re-embedded on the next tick — a stale vector can never be
marked fresh.

### 5.4 Configuration & secrets

- url / model / dim / key header / input field are stored as **durable function
  variables** (`df.setvar`), sourced from `.env` or the Kubernetes secret at
  start time.
- The **API key** is, for now, also placed in a durable variable. This is
  plaintext-at-rest (per-user RLS only). **This is a known, accepted limitation
  for incubation**; a follow-up will move the secret to a runtime-injected
  credential. The code and design doc must carry an explicit TODO.

### 5.5 Preconditions (fail fast)

`initialize()` verifies the cluster has the required extensions and capabilities
(`vector`, `age`, `pg_textsearch` (BM25 lexical ranking), `pg_durable` with
`df.http` present and usage granted). If any are missing, initialization
**throws a precise error** naming the missing piece and the fix. There are no
feature flags or silent fallbacks. (Lexical mode is specified as **BM25**;
plain `tsvector`/`ts_rank` is not an acceptable silent substitute, hence the
`pg_textsearch` precondition.)

## 6. Functional requirements — open graph (crawler)

### 6.1 Model

A free-form property graph: **graph nodes** (free-text `kind`, `name`, `aliases`)
connected by `REL` edges (free-text `predicate`, `confidence`, `observations`,
optional `evidence`). There is **no fixed ontology** — predicates are invented by
the app's harvester role. **Graph nodes carry no embeddings** — the graph is
navigated by text match (`nameLike`), by `kind`, and by traversal from seeds; it
does not have a vector index. The query entry point for "what connects to these
facts" is the **facts'** vector index (via `searchFacts` seeds), not node vectors.

### 6.1a The graph is a shared-scope surface (ingestion contract)

The graph carries **no per-node/per-edge ACL**. Its trust model is split between
the two boundaries:

- **Ingestion (write) — the contract.** Incorporating a fact into the graph
  **publishes** the extracted entities and relationships (node `kind`/`name`/
  `aliases`, edge `predicate`s) to **every** reader, regardless of the source
  fact's ACL. The harvester is privileged precisely so it can make this call:
  it decides *what* is appropriate to publish, typically by targeting the
  corpus it was deployed for (the `namespace` filter on the crawl queue).
  Harvesting a session-private fact is allowed but is a deliberate act of
  publication — extracted content cannot be retroactively scoped.
- **Read — the filter.** Graph topology and node/edge content are readable by
  everyone, but the **`evidence` arrays returned by every graph read are
  filtered to the caller's ACL** (§6.5): a fact scopeKey the caller could not
  `readFacts` is omitted from results. **Traversal is not affected** — paths
  still route through evidence the caller cannot see, so two accessible facts
  connected only via an inaccessible one are still discovered as connected; the
  caller just never sees the inaccessible fact's key (its existence, owning
  session, and key text stay private). Fact **bodies** were already protected
  by the ACL on `readFacts`.

In short: *connections and extracted content are shared; fact pointers and fact
bodies are scoped.* What enters the graph is governed at ingestion time by the
harvester, not at read time by the store.

### 6.2 The harvest sequence (search → resolve → assert)

```
1. Harvest    : read facts (readFacts / searchFacts)
2. Extract    : LLM proposes (kind, name) nodes and (from, predicate, to) edges
3. Resolve    : searchGraphNodes({ kind, nameLike }) → match existing or mint new
4. Upsert ends: upsertGraphNode(GraphNodeInput) for each endpoint → canonical nodeKey
5. Upsert edge: upsertGraphEdge(GraphEdgeInput) → create or reinforce (merge semantics)
6. Accrue     : re-call upsertGraphNode/upsertGraphEdge with new evidence[] to union in
```

### 6.3 Write semantics (upsert + merge)

- **`upsertGraphNode(GraphNodeInput)`** — create, or merge `aliases` (and union
  optional `evidence`) into the existing node. Returns canonical `GraphNodeRef`.
- **`upsertGraphEdge(GraphEdgeInput)`** — create, or reinforce an existing edge
  (noisy-OR `confidence`, `observations++`) and **union** any supplied
  `evidence`. This single verb also serves as the evidence-linking primitive:
  call it again with only new evidence to add provenance to an edge.
  **Reinforcement counts only novel observations:** an assertion reinforces iff
  it carries ≥1 evidence scopeKey not already on the edge, or carries no
  evidence at all. Re-asserting with only already-known evidence is an
  idempotent no-op — a duplicate harvest of the same fact (replay, concurrent
  harvesters, re-crawl after a lost race) cannot inflate `observations` or
  `confidence`.
- **Evidence is OPTIONAL.** Evidence-less assertions are accepted rather than
  rejected. *(TODO: re-evaluate mandatory evidence for graph trust.)*
- **`mergeGraphNodes(fromKey, intoKey, reason)`** — node resolution / dedup:
  union aliases onto the survivor, repoint in/out edges, delete the duplicate.

### 6.4 Delete API

| Operation | Behaviour |
|-----------|-----------|
| `deleteGraphNode(nodeKey)` | `DETACH DELETE` the node and all incident `REL` / evidence edges. Returns whether a node matched. |
| `deleteGraphEdge(fromKey, toKey, predicateKey)` | Delete one exact edge triple. Returns whether an edge matched. |

**No cascade.** Deleting a fact via `deleteFact` does **not** touch the graph.
Because the KV/graph linkage is by convention, a deleted fact may remain
referenced by graph provenance until a harvester or maintenance pass removes it.
This is intentional for this iteration.

### 6.5 Read API

All graph reads take the caller's `AccessContext` and apply the **evidence
filter** of §6.1a: returned `evidence` arrays contain only fact scopeKeys the
caller could `readFacts` (a syntactic check — `shared:` always passes;
`session:<id>:` passes iff `<id>` is the reader's or a granted session, or the
caller is unrestricted). Traversal internally uses the **full** evidence set.
The privileged harvester reads with `unrestricted` and sees everything.

- **`searchGraphNodes(GraphNodeQuery, access)`** — find/expand graph nodes.
  Inputs are combinable: `kind`, `nameLike` (lexical match on name/aliases), and
  **`seeds: string[]`** — an array of **fact scopeKeys OR node keys** that anchors
  the query. Seeds let the caller feed `searchFacts` output straight into the
  graph (fact seeds pivot via `EVIDENCED_BY`; node seeds expand directly).
  **Seed fact scopeKeys are ACL-checked first**: a seed the caller could not
  read is ignored (treated as unknown), so seeding cannot be used to probe
  whether a private fact evidences anything. `depth` (1..5) bounds traversal
  from the seeds. Each returned node carries its `EVIDENCED_BY` fact scopeKeys
  (ACL-filtered) so the caller can `readFacts` in one follow-on hop.
- **`searchGraphEdges(GraphEdgeQuery, access)`** — two modes only:
  **anchor-and-explore** (`fromKey`/`toKey` set) or **exact-predicate**
  (`predicate` / `predicateKey`, exact equality, no fuzzy match). Returned edge
  `evidence` is ACL-filtered.
- **`graphNeighbourhood(nodeKey, depth, access)`** — bounded subgraph (depth
  clamped 1..5) around an anchor node.

### 6.6 Crawl tracking (harvester support)

To make the harvester easy to write, the facts table carries a **`last_crawled_at`**
column that marks whether a fact has already been incorporated into the graph.

- **Reset on write.** Whenever a fact's content changes via `storeFact`
  (upsert/create/replace), `last_crawled_at` is reset to `NULL`. This is
  enforced by a DB trigger keyed on `content_hash` change, so no write path can
  forget it.
- **Pending crawl = `last_crawled_at IS NULL`.** A freshly created or freshly
  updated fact is, by definition, uncrawled until the harvester re-incorporates
  it.
- **Crawling is privileged.** The harvester is a trusted role: it crawls **all**
  facts (shared + every session), so `readUncrawledFacts` / `markFactsCrawled`
  take no access context and are exposed only to the harvester role — they are
  not registered as tools for ordinary reader agents.
- **`readUncrawledFacts({ namespace?, limit? })`** — enhanced-store read that
  returns facts with `last_crawled_at IS NULL` (optionally restricted to a key
  prefix, bounded by `limit`), across all scopes. This is the harvester's work
  queue. Each returned fact carries its `contentHash`, which is the receipt for
  `markFactsCrawled`.
- **`markFactsCrawled(stamps: { scopeKey, contentHash }[])`** — enhanced-store
  write that stamps `last_crawled_at = now()` for the given facts after they
  have been incorporated into the graph. **Race-guarded:** each stamp applies
  only `WHERE content_hash` still equals the supplied hash, so a fact edited
  between read and mark keeps `last_crawled_at = NULL` and re-enters the queue
  (the mid-crawl edit can never be silently swallowed). Returns
  `{ marked, skipped }`; mismatches are skipped, not errors.

The harvester loop becomes: `readUncrawledFacts` → extract → `upsertGraphNode` /
`upsertGraphEdge` → `markFactsCrawled(stamps)`. Because any later edit resets the
column, stale facts automatically re-enter the queue. `last_crawled_at` is
independent of the embedding pending-state (`content_hash` vs
`last_embedded_hash`); a write resets both.

## 7. Phase 2 — compound cross-store reads (context APIs)

> **Phasing.** Everything above is **Phase 1**: the orthogonal primitives
> (`searchFacts`, `similarFacts`, the graph API) plus the harvester support that
> *populates* the graph. The two APIs below are **Phase 2** — they *compose*
> those primitives into one call. They are gated behind Phase 1 because **they
> only return useful results once a harvester has populated `EVIDENCED_BY`**
> links between facts and graph nodes. Against an empty/unharvested graph they
> degrade to "just the seed facts" — correct, but unremarkable. Ship Phase 1
> first; turn these on once the graph has evidence.

Both methods perform the cross-store join a caller would otherwise wire by hand
(`searchFacts`/`similarFacts` → `searchGraphNodes({ seeds })` → `readFacts`) and
return a **single normalized, relationship-aware bundle** an LLM can read. The
Phase 1 primitives stay pure; this is an additive "context" surface on top.

### 7.1 `searchGraphContext(query, opts, access)` — query → graph → facts

Entry by **query text**. Pipeline:

1. `searchFacts(query, { mode, limit: seedLimit }, access)` → seed facts.
2. `searchGraphNodes({ seeds: seedScopeKeys, depth }, access)` → reached nodes
   plus their `EVIDENCED_BY` fact keys.
3. `readFacts` over every referenced fact key (seeds + evidence), ACL re-applied.

Returns a `GraphContextResult` (02-api-reference §8): the entry descriptor, the
scored seed facts, the reached `nodes`, the `edges` among them, and a deduped
`facts` map keyed by `scopeKey` so every node/edge/seed resolves back to its
source fact without a second call.

### 7.2 `similarGraphContext(scopeKey, opts, access)` — known fact → similar cluster → graph → facts

Entry by an **existing fact**. Pipeline:

1. `similarFacts(scopeKey, { k }, access)` → a semantically-related **cluster**.
2. Seed the graph with the **anchor + the whole cluster** and expand
   (`searchGraphNodes({ seeds, depth })`).
3. `readFacts` over all referenced fact keys.

Because multiple related facts pivot in together, the result also surfaces the
relationships **among** the cluster. It returns a `SimilarGraphContextResult`
that extends the bundle above with **`factLinks`** — derived fact↔fact links
("these two facts are related *because* both evidence node X via predicates …"),
the structure that makes the cluster legible to an LLM. `factLinks` is bounded
(capped pairs; shared-node hops only) so the derivation stays cheap.

### 7.3 Requirements

- Both re-apply ACL on the final `readFacts`; a fact unreachable to the caller
  never appears, even if a reachable node evidences it. Because the underlying
  graph reads filter `evidence` arrays to the caller's ACL (§6.1a), the bundle
  is **exactly self-resolving**: every `evidence` key on every returned
  node/edge is present in the `facts` map — no dangling keys for facts the
  caller cannot read.
- Both are **read-only** and side-effect free; they never write the graph or
  mutate crawl state.
- With no graph evidence, `nodes` / `edges` / `factLinks` are empty and `facts`
  equals the seed set — a graceful, correct degenerate.
- Bounding knobs (`seedLimit`, `depth` clamped 1..3, `expandLimit`, `factLimit`)
  cap each stage; the tool wrapper (05-tools-spec §6) collapses them into a
  single `breadth` preset for LLM callers.

## 8. Acceptance criteria

1. All existing `FactStore` behaviour is preserved (base CRUD, ACL, stats).
   The base API additions (`FactRecord.scopeKey`, `ReadFactsQuery.scopeKeys`)
   round-trip: `readFacts({ scopeKeys })` returns exactly the accessible subset.
2. `searchFacts` returns correctly ranked, ACL-filtered results in `lexical`
   (BM25), `semantic`, and `hybrid` modes over the **facts store only** (no
   graph mode). The ACL predicate is applied **inside the search procs, before
   ranking/LIMIT** — an accessible match is returned even when the global
   top-`candidatePool` is dominated by inaccessible rows.
3. `similarFacts` (semantic kNN of a known fact, no re-embedding) is distinct
   from `searchFacts` (query-text anchored). An existing-but-inaccessible
   anchor returns empty, indistinguishable from an unknown key.
4. The graph API (`searchGraphNodes` with `seeds[]`, `searchGraphEdges`,
   `graphNeighbourhood`) performs graph retrieval independently; feeding
   `searchFacts` output as `seeds` returns graph-expanded connections that pure
   facts search would miss.
5. **Crawl tracking:** a new fact has `last_crawled_at IS NULL`;
   `markFactsCrawled` stamps it **only when the supplied `contentHash` still
   matches** (a mid-crawl edit is skipped and stays queued); any subsequent
   `storeFact` content change resets it to `NULL`; `readUncrawledFacts` returns
   exactly the pending set across **all** scopes (privileged), each row
   carrying the `contentHash` receipt.
6. `startEmbedder` creates exactly **one** durable instance; a second start is a
   no-op returning the same instance; `stopEmbedder` cancels it; a second stop is
   a no-op. `configureEmbedder` while running restarts the loop (new instance,
   same label) and the new config takes effect — durable vars are captured at
   `df.start` and immutable for a run.
7. After `startEmbedder`, pending facts get embedded and changed facts get
   re-embedded — observed via the vector/search outcome, never via df internals.
   A fact edited while its batch was in flight remains pending (select-time
   hash write-back). Rows embedded under a different `embedding_model` are
   pending and excluded from semantic search.
8. `initialize()` fails fast with a precise error when an extension is missing
   (`vector`, `age`, `pg_textsearch`, `pg_durable`/`df.http`).
9. Graph upsert/merge/delete behave per §6, with evidence optional;
   re-asserting an edge with only already-known evidence does not reinforce.
9a. **Shared-graph contract + evidence filter:** graph topology and node/edge
    content are readable by every caller, but `evidence` arrays in all graph
    read results contain only caller-accessible fact scopeKeys, and seed fact
    scopeKeys the caller cannot read are ignored. Traversal through
    inaccessible evidence still connects accessible facts.
10. All data access (relational + vector) goes through stored procedures; graph
    access goes through a typed Cypher layer; all DDL ships as numbered
    migrations (no SQL embedded in TypeScript source).

**Phase 2 (compound context reads — gated behind a populated graph):**

11. `searchGraphContext` returns the seed facts, the nodes/edges reached via
    their `EVIDENCED_BY` seeds, and a deduped `facts` map — equivalent to the
    manual `searchFacts → searchGraphNodes → readFacts` pipeline in one call.
12. `similarGraphContext` additionally returns `factLinks` connecting cluster
    facts through shared nodes; against an unharvested (evidence-free) graph both
    APIs degrade to exactly the seed facts (empty `nodes`/`edges`/`factLinks`).
13. Both context APIs re-apply ACL on the final read and never mutate the graph
    or crawl state.
