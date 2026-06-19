# 07 — PilotSwarm Integration Plan

> **Status:** Proposal — execution plan, pending review. No `packages/sdk`
> product code has been changed by this document; the incubator-side provider
> split (**P0**) has since been implemented and validated — see P0 below.
>
> This is the **PilotSwarm-core execution plan** that operationalizes the design
> captured in [01](./01-functional-spec.md)–[06](./06-provider-test-plan.md) and
> the incubator [GAP-ANALYSIS](../../../incubator/horizon-facts/GAP-ANALYSIS.md)
> "Out of scope (this pass)" backlog. Docs 01–06 specify *what* the
> EnhancedFactStore is and prove the HorizonDB provider in isolation; this doc
> specifies *how* it lands in `packages/sdk` as a sequence of reviewable,
> PR-sized changes.

---

## 0. What this delivers — and three decisions taken

**Goal (from the user):** PilotSwarm's runtime should depend on the
**`EnhancedFactStore` interface**, with **`HorizonDBFactStore`** as the concrete
provider wired in behind it, plus an **optional, separately-injected `GraphStore`**
(its own provider, `HorizonDBGraphStore`). Classic dependency inversion: the SDK
owns the contracts, the incubator implements them.

> **What "the EnhancedFactStore proposal" actually is.** Despite the name, this
> series delivers **two separable things**: (1) a set of **fact-store
> enhancements** — multi-signal search, semantic similarity, the durable embedder,
> and the crawl queue — layered on the base `FactStore` as `EnhancedFactStore`;
> and (2) an **optional, independent knowledge graph** (`GraphStore`) with its own
> provider, URL, and lifecycle. They compose but neither requires the other (see
> the tier table in §1.4): you can take enhanced facts with no graph, or base
> facts with a graph, or both.

Three forks were not answerable from the repo. They were taken **autonomously**
per the recommendations below; any can be overridden in review (see
[§6](#6-open-decisions-for-the-reviewer)).

| Fork | Decision taken | Why |
|------|----------------|-----|
| **D1 — non-HorizonDB deployments** | Keep **two segregated interfaces**: `PgFactStore` stays a plain `FactStore` (base CRUD + stats, **no throwing stubs**); `EnhancedFactStore` is the strict superset that `HorizonDBFactStore` implements. The runtime answers "base or enhanced?" with the structural guard `isEnhancedFactStore(store)` and reads a `capabilities` descriptor **on the enhanced interface** to gate sub-features (§1.4). | Vanilla Postgres (local dev, Docker appliance, OSS) has no `vector`/`age`/`pg_textsearch`/`pg_durable`. Programming to the base `FactStore` and narrowing by capability keeps the default path untouched and avoids forcing `PgFactStore` to grow methods that exist only to throw (Liskov / interface-segregation). |
| **D2 — graph surface** | The graph is its **own optional injected interface `GraphStore`**, implemented by a **separate provider `HorizonDBGraphStore`** (AGE-only), with its own `graphDatabaseUrl` — **not** a capability bolted onto the fact store and **not** the same object as the fact store. The bundled HorizonDB case is simply **two independent providers pointed at one database**; graph presence is `!!graphStore`. | The facts KV and the graph are already *"two separate lifecycles linked only by convention"* (01 §2, 03 §6.4), backed by independent extensions (pgvector/textsearch vs AGE). Two segregated providers make the code shape match that contract, keep each `initialize()` fail-fast to **only its own extensions** (so **base-facts + graph** = PG + AGE is genuinely real), and remove the `graph` capability boolean and any fact-store sniff — graph-tool gating is just `!!graphStore`. |
| **D3 — facts↔graph crawl bridge** | The crawl queue (`last_crawled_at` column + `readUncrawledFacts` / `markFactsCrawled`) lives on the **base `FactStore`**, added by additive **vanilla-PG** migrations (nullable column + content-reset trigger + two procs — **no extension**). It surfaces as harvester tools only for an **app-defined harvester role** (opt-in), and only when a `graphStore` is configured — graph harvesting is app-specific, **not** a built-in facts-manager job (§1.5). | The crawl queue is facts-table bookkeeping whose only purpose is feeding a graph harvester, so it belongs with facts, not with the search axis. On the base store it gives **base-facts + graph** a real incremental work queue instead of a full table scan, and keeps the search/embedder axis cleanly separate. The embedder never reads or writes `last_crawled_at`. |

Net effect: the **default deployment stays on `PgFactStore`** with no new
extensions and no behaviour change — the one additive `last_crawled_at` column is
vanilla PG and inert unless a graph harvester runs. Facts, search, and graph are
**three independently selectable axes**: configuring a `GraphStore` lights up the
graph tools; selecting the HorizonDB enhanced provider lights up search + the
durable embedder; you can take either, both, or neither.

---

## 1. Architecture — dependency inversion

### 1.1 Interface ownership moves into the SDK

Today the incubator **mirrors** the SDK's facts types locally (its `types.ts` is
a copy, not an import — see
[GAP-ANALYSIS](../../../incubator/horizon-facts/GAP-ANALYSIS.md) "Out of scope").
This plan **inverts** that:

```
packages/sdk  (owns the contracts)               incubator/horizon-facts (implements them)
─────────────────────────────────────            ──────────────────────────────────────
FactStore                 (base CRUD + stats + crawl queue)  ◀── import ──  HorizonDBFactStore
  └─ EnhancedFactStore    (+ search / similar / embedder)    ◀── import ──  HorizonDBFactStore
GraphStore                (graph read/write — SEPARATE        ◀── import ──  HorizonDBGraphStore
                           provider, optional, injected)                  (AGE-only, its own provider)
FactsCapabilities         (capability descriptor: { search, embedder })
isEnhancedFactStore()     (structural type guard: base vs enhanced)
scopeKeyAccessible()      (syntactic ACL helper)
DTOs: SearchOpts, SearchResult, ScoredFact, SimilarOpts,
      CrawledFactStamp (base — crawl queue),
      EmbeddingEndpointConfig, EmbedderStatus,
      Graph* query/hit/input/ref types
```

- The runtime programs to the **base `FactStore`** contract and **narrows to
  `EnhancedFactStore` by capability detection** (`isEnhancedFactStore(store)`,
  §1.4) wherever the enhanced retrieval surface is needed. `PgFactStore`
  implements `FactStore` only — it never grows throwing stubs; `HorizonDBFactStore`
  implements the full `EnhancedFactStore`. This is exactly the "is it a
  `FactStore` or an `EnhancedFactStore`?" question, answered structurally, once,
  at worker boot.
- **`GraphStore` is a separate, independently injected interface with its own
  provider** — not part of `EnhancedFactStore`, not a capability boolean, **not the
  same object** as the fact store. `HorizonDBGraphStore` (AGE-only) is the graph
  provider; `HorizonDBFactStore` implements `EnhancedFactStore` only. The worker
  takes an **optional second injection** (`graphStore?`), so the graph is present
  iff one was configured (`!!graphStore`). The bundled HorizonDB case is just
  **two independent providers pointed at the same database** (two pools, two
  `initialize()`s, each asserting only its own extensions) — there is no
  shared-instance special case to reason about.
- The **crawl queue** (`readUncrawledFacts` / `markFactsCrawled` + the
  `last_crawled_at` column) is part of the **base `FactStore`**, not the enhanced
  one — it is facts-table bookkeeping that feeds whatever `GraphStore` is
  configured (§1.4, P1). Vanilla PG, no extension.

### 1.2 The injection seam already exists

PilotSwarm already centralizes facts-store construction; the change is contained:

| Seam | File | Change |
|------|------|--------|
| Facts construction | [`createFactStoreForUrl(url, schema?, opts?)`](../../../packages/sdk/src/facts-store.ts) | Add provider selection: return `HorizonDBFactStore` when the enhanced provider is selected, else `PgFactStore`. **Guarded dynamic import** of the HorizonDB package so the SDK builds/runs without it. |
| Graph construction | new `createGraphStoreForUrl(url, schema?, opts?)` in a sibling `graph-store.ts` | **Exactly parallel to the facts constructor** — same `create…ForUrl(url, schema?, opts?)` shape, same guarded dynamic import — returning a `GraphStore` by constructing `HorizonDBGraphStore` (its own AGE-only provider). Called **only when `graphDatabaseUrl` is set** (§1.3). No `factStore` argument, no instance reuse, no structural sniff — a self-contained constructor symmetric with the facts one. |
| Worker wiring | [`worker.ts`](../../../packages/sdk/src/worker.ts) (createFactStore → `initialize()` → `sessionManager.setFactStore()`) | Resolve the facts connection string + capabilities, and **optionally** a `graphStore` from `graphDatabaseUrl`, threaded via a new `sessionManager.setGraphStore()`. Otherwise unchanged — it already speaks the interfaces. |
| Session wiring | [`session-manager.ts`](../../../packages/sdk/src/session-manager.ts) (`setFactStore` / `setGraphStore` / `createFactTools` / `createGraphTools`) | Stores stay typed as `FactStore` (+ optional `GraphStore`); `isEnhancedFactStore` + `capabilities` + `!!graphStore` are read once and threaded in. Tool registration is gated on **role × capability × graph-present** (§1.5), reusing the existing `agentIdentity` filter. |
| Tools | [`facts-tools.ts`](../../../packages/sdk/src/facts-tools.ts) `createFactTools()` + a sibling `createGraphTools()` (new `graph-tools.ts`) | Facts retrieval tools registered when `caps.search`; **graph tools registered when a `graphStore` is present** (independent of the facts axis); both additionally gated by role (reader vs harvester). |
| Prompt / skill index | [`session-manager.ts` `_buildKnowledgeToolInstructionsSection`](../../../packages/sdk/src/session-manager.ts) + [`knowledge-index.ts`](../../../packages/sdk/src/knowledge-index.ts) | The existing `tool_instructions` knowledge block becomes capability-aware (§1.5): base store → today's block, unchanged; enhanced store → **drops** the capped-50 skills push and exposes `search_skills`, which the agent calls every turn (§1.6); graph present → also names the graph read tools. |

Everything between (`ManagedSession`, the CMS event hooks, the facts-manager
wake-up, stats) is already provider-agnostic and needs **no change**.

### 1.3 Connection targets (from 02 / the series README)

Facts, CMS and orchestration use three connection strings resolved
most-specific-first; the **graph adds a fourth, opt-in** target:

```
graphDatabaseUrl          (explicit, OPT-IN)              → GraphStore (AGE) — unset ⇒ no graph store, no graph tools
enhancedFactsDatabaseUrl  ?? cmsFactsDatabaseUrl ?? store → EnhancedFactStore (HorizonDB)
cmsFactsDatabaseUrl       ?? store                       → CMS
store                                                    → orchestration (ps_duroxide)
```

The graph is **never selected implicitly**: with no `graphDatabaseUrl` there is no
graph store and no graph tools, even on an enhanced facts deployment. The
`GraphStore` is **always its own provider** (`HorizonDBGraphStore`) with its own
connection — even when `graphDatabaseUrl` points at the **same** database as the
facts store. The bundled HorizonDB case is therefore just "both URLs name one
database": two independent providers, two small pools, each asserting only its own
extensions (facts → pgvector/textsearch/pg_durable; graph → AGE). A distinct
`graphDatabaseUrl` (e.g. base PG facts + a separate AGE database) is the same code
path with a different URL. The facts / CMS / orch targets may still all point at
one database. Splitting the enhanced store onto its own HorizonDB also sidesteps
the schema collision with `pg_durable` (different databases) — see the
`ps_duroxide` rename in
[03-design §6.7](./03-design.md) (already verified end-to-end on live HorizonDB,
9/9, via
[`verify-schema-migration.mjs`](../../../incubator/horizon-facts/scripts/verify-schema-migration.mjs)).

### 1.4 Capability detection & the graph injection seam

Each worker constructs **exactly one** facts store (base `FactStore` or its strict
superset `EnhancedFactStore`) and **optionally one** `graphStore`. Nothing else in
the runtime needs to know which provider built them — it asks the facts store for
its type, and checks whether a graph store was injected:

```ts
// packages/sdk/src/facts-store.ts
export function isEnhancedFactStore(s: FactStore): s is EnhancedFactStore {
  return typeof (s as any).searchFacts === "function"
      && typeof (s as any).capabilities === "object";
}
// Graph presence is NOT a fact-store sniff — `GraphStore` is its own provider,
// injected separately. The graph is present iff the worker was handed one:
//   const graphEnabled = !!graphStore;
```

- **Structural, not a flag.** No `factsProvider` string is consulted at the call
  sites; the guard is the single source of truth. (A `factsProvider` config knob
  may still *select* which provider to construct — §2 P3 — but detection
  downstream is always the guard.)
- **`capabilities` lives on the enhanced interface only**, and now covers just the
  retrieval axis: `EnhancedFactStore` exposes
  `capabilities: { search: boolean; embedder: boolean }` so a provider can
  advertise *partial* support (e.g. search but no embedder). The base `FactStore`
  has no such property — it never pretends. **Graph is no longer a capability** —
  it is the separate `graphStore` injection.
- **Graph is a second, optional injection — not derived from the fact store.** The
  worker is handed `graphStore?` separately; `!!graphStore` is the single source
  of truth for graph-tool registration. A base or enhanced fact store composes
  with a graph store or none, in any combination.
- **Computed once, threaded in.** The worker evaluates the guard + capabilities +
  `!!graphStore` at boot and hands the result to `SessionManager`, so both tool
  registration and prompt composition (§1.5) read the same snapshot. Nothing is
  recomputed per turn, and **none of it touches the duroxide orchestration
  generator** — detection and registration happen at session creation, outside the
  replayed code path, so there is no nondeterminism exposure.

Why segregated interfaces beat "one interface that throws":

- `PgFactStore` is not forced to implement `searchFacts`/graph methods just to
  throw — Liskov and interface-segregation stay intact.
- Partial providers are expressible via `capabilities` without a combinatorial
  explosion of throwing stubs.
- The "is it base or enhanced?" question the runtime actually asks maps 1:1 onto a
  `typeof` check the compiler also understands (the `s is EnhancedFactStore`
  narrowing).

#### The graph is a third, independently injected axis

`GraphStore` is **not** discovered on the fact store; it is injected separately
and present iff configured:

```ts
// worker boot — two symmetric, independent constructors
const factStore  = await createFactStoreForUrl(factsUrl, …);   // base OR enhanced
const graphStore = graphUrl
  ? await createGraphStoreForUrl(graphUrl, …)                 // own AGE-only provider; undefined ⇒ no graph tools
  : undefined;
sessionManager.setFactStore(factStore);
sessionManager.setGraphStore(graphStore);
```

No cross-argument, no reuse branch, no structural sniff: the graph constructor is
a peer of the facts constructor. When `graphUrl` names the same database as the
facts store, that is two providers sharing one database — not one object in two
slots.

This yields three orthogonal, independently selectable axes and the deployment
tiers they compose into:

| facts axis | graph axis | What you get | Backing |
|-----------|:---------:|--------------|---------|
| base `FactStore` | — | today's KV facts + skills pipeline | vanilla PG |
| base `FactStore` | `GraphStore` | KV facts **+ knowledge graph** (lexical / lineage / kind / node seeding; **no vectors**) | `PgFactStore` (vanilla PG) + `HorizonDBGraphStore` (AGE only) |
| `EnhancedFactStore` | — | semantic / hybrid search + embedder, **no graph** | `HorizonDBFactStore` (pgvector / textsearch / pg_durable) |
| `EnhancedFactStore` | `GraphStore` | full surface: semantic seeding → graph expansion | `HorizonDBFactStore` + `HorizonDBGraphStore` — one HorizonDB (bundled) or split |

**Why base-facts + graph composes (the payoff of the split).** A graph store
needs only two things from the fact layer, and both are on the **base**
`FactStore` (§1.1, P1), never on the enhanced one:

1. `FactRecord.scopeKey` + `ReadFactsQuery.scopeKeys` — so graph `evidence`
   arrays reference real facts and resolve back to values
   (`graphStore.searchGraphNodes(...)` → scopeKeys → `factStore.readFacts({ scopeKeys })`,
   composed at the tool layer in two calls).
2. The crawl queue (`readUncrawledFacts` / `markFactsCrawled`) — the harvester's
   incremental work list.

Evidence-ACL filtering is **syntactic** (`scopeKeyAccessible()` on
`shared:` / `session:<id>:` prefixes) and needs the caller's `AccessContext`, not
any enhanced method. The **only** graph seeding strategy that requires an enhanced
fact store is the *semantic* pivot; `nameLike`, `kind`, node-key, and **lineage**
(base `readFacts({ scope: "descendants" })`) seeding all work on base facts. So
`PgFactStore` + `GraphStore` is a coherent, fully usable tier — a knowledge graph
with lexical/lineage seeding and no vector dependency.

### 1.5 How agents adapt (facts axis × graph axis × role)

Adaptation is the **cross product of three orthogonal axes**:

1. **Facts capability** (worker-wide): base vs enhanced, and — when enhanced —
   which of `{ search, embedder }` is on.
2. **Graph presence** (worker-wide): whether a `graphStore` was injected
   (`!!graphStore`).
3. **Session role** (`agentIdentity`, per session): the default/task agent, or one
   of the system agents (`facts-manager`, `agent-tuner`, `pilotswarm`, `sweeper`,
   `resourcemgr`).

The cross product drives two things: **which tools are registered** on the
session, and **which prompt sections** the session sees.

#### Tool registration matrix

| Tool group | Who (role) | Gated on |
|------------|-----------|----------|
| `store_fact` / `read_facts` / `delete_fact` (base KV) | every session | always |
| `facts_search` / `facts_similar` (reader retrieval) | every reader session, incl. **agent-tuner** | `isEnhancedFactStore` && `caps.search` |
| `search_skills` (skills-scoped skill pull) | every reader session except facts-manager (it owns the namespace) | `isEnhancedFactStore` && `caps.search` |
| `graph_search_nodes` / `graph_search_edges` / `graph_neighbourhood` (reader graph) | every reader session, incl. **agent-tuner** | **`!!graphStore`** |
| `graph_stats` (read-only: node/edge counts, last-crawled summary) | **facts-manager** + **agent-tuner** | **`!!graphStore`** |
| `facts_read_uncrawled` / `facts_mark_crawled` (crawl queue) | app **harvester role** + **facts-manager** (tools present, **dormant** — not prompted to crawl) | **`!!graphStore`** |
| `graph_upsert_*` / `graph_merge_nodes` / `graph_delete_*` (graph write/delete) | app **harvester role** + **facts-manager** (dormant) | **`!!graphStore`** |

The graph rows key off **`!!graphStore`**, never the facts capability — a
base-facts + graph deployment gets the full graph tool surface with no search
tools, and an enhanced-facts + no-graph deployment gets search but no graph.

**Active graph harvesting is app-specific; the tools are not.** PilotSwarm ships
the crawl-queue + graph-write/delete tools, but *deciding what to crawl and how to
extract entities/edges* is domain knowledge it cannot supply generically. So:

- The **app's harvester role** (an app-built agent the operator assigns the role,
  §1.4) is the **active crawler** — it is both granted the tools **and** prompted
  to crawl with app-specific extraction.
- The **facts-manager** is granted the **same harvester tools** (so it *can*
  become a harvester on demand if the operator asks) but is **dormant by
  default** — it is **not** prompted to crawl, and **no crawling happens out of
  the box**. It additionally gets read-only `graph_stats` so it can *report* on
  the graph (size, last-crawled time) without taking any mutating action.
- **agent-tuner** gets **every read tool** — base `read_facts`, `facts_search` /
  `facts_similar`, the graph reads, and `graph_stats` — but **never** a
  write/delete/crawl tool. Its read-only invariant is preserved and widened to the
  full read surface.
- The **sweeper** is unchanged: it sweeps **facts** via the existing cascading
  session delete and nothing more. It **never deletes graph nodes** — graph
  deletion is a harvester-only capability. As a corollary, an app that wants graph
  cleanup adds the `graph_delete_*` tools to **its own harvester sessions**
  (documented in the builder templates, P7).

This is realized exactly where role-gating already lives: `createFactTools()`
(+ a sibling `createGraphTools()`) plus the `agentIdentity` / config filter in
`SessionManager` (today that filter already does
`… !isTunerSession || tool.name === "read_facts"` and the reserved-namespace
checks for `facts-manager`). The new inputs are the capability snapshot,
`!!graphStore`, and the opt-in harvester-role flag from §1.4.

#### Prompt adaptation (one existing seam, made capability-aware)

Today the system message already gets a facts-knowledge block injected through
[`_buildKnowledgeToolInstructionsSection`](../../../packages/sdk/src/session-manager.ts)
→ the `tool_instructions` section of `composeStructuredSystemMessage`. We make
**that same builder** capability-aware:

- **Base store** → the block is exactly today's: write `intake/`, read the curated
  skill index, load full skills with `read_facts`.
- **Enhanced facts** → the block **drops** today's capped-50 skills push and
  instead names `facts_search` / `facts_similar` and the dedicated `search_skills`
  tool, instructing the agent to **call `search_skills` every turn** with a
  task-derived query (§1.6). (Open `asks/*` still surface on their existing small
  push path.)
- **Graph present** → the block additionally names the graph read tools and the
  seed pivot (facts you found → `graph_search_nodes({ seeds })`). This branch keys
  off `!!graphStore`, so it lights up for base-facts + graph too — just without
  the semantic-seed sentence.
- The matching skill to load is named per axis: base fact skill, the enhanced
  retrieval skill, and/or the graph skill.

No new section and no new composition path — it is an additive branch inside the
one builder that already owns this block.

#### Per-agent walkthrough

- **Default / task agent** (the base agent, `default.agent.md`)
  - *Base store, no graph:* unchanged — `store_fact` / `read_facts` / `delete_fact`,
    write `intake/<topic>/<session>`, read the injected skill index, load full
    skills on demand. This is today's "Shared Knowledge Pipeline" prompt section.
  - *Enhanced facts:* the framework's per-turn skills push is **dropped** —
    `loadKnowledgeIndexFromFactStore` no longer injects the capped-50 slice.
    Instead the agent gets `facts_search` / `facts_similar` and a dedicated
    `search_skills` tool, and the base instructions tell it to **call
    `search_skills(query=…)` at the start of every turn**, querying its actual task
    (e.g. "azure deployments", "horizondb connection errors") — as many times as
    needed for different facets. Similar DB cost to today's push (~one search per
    turn) but paid by the `search_skills` handler in the SessionManager, and it
    returns *ranked relevant* skills instead of an arbitrary 50-slice. The base
    instructions also note that, **beyond skills, the agent can retrieve its own
    facts/memory with `facts_search` (lexical / semantic / hybrid) and
    `facts_similar`** — semantic and hybrid recall over the whole accessible
    corpus is **often more effective than** the base `read_facts` key-pattern /
    `LIKE` scan, which only matches literal keys. Intake writing is unchanged.
  - *Graph present (with either facts axis):* plus the graph read tools, and: *from
    facts you found, seed `graph_search_nodes({ seeds })` to pull connected
    context.* Intake writing is unchanged throughout.

- **facts-manager** (the curator — harvester-*capable* on demand, dormant by default)
  - *Base store, no graph:* unchanged — curates `intake/*` into `skills/*` +
    `asks/*` as KV facts (its existing curation cycle). It is already excluded from
    the consumer skill-index injection because it *owns* that namespace.
  - *Enhanced facts:* its cycle gains better dedup/merge — `facts_similar` /
    `facts_search` over `skills/` to find a near-duplicate before writing (§1.6).
  - *Graph present:* it **receives the full harvester tool surface** (crawl queue +
    `graph_upsert_*` / `graph_merge_nodes` / `graph_delete_*`) so it **can** become
    a harvester if the operator asks — but it is **not** prompted to crawl and
    there is **no crawling by default**. It also gets read-only `graph_stats` for
    reporting (node/edge counts, last-crawled time) with no mutating action. On
    demand it can render the **whole graph as a Markdown / Mermaid artifact** and
    answer questions about graph structure — the **graph-debug skill** (§1.6),
    injected only when `!!graphStore`.

- **Application harvester agent** (app-defined; the actual graph builder)
  - There is **no built-in graph harvester.** Entity/edge extraction is
    domain-specific, so the application builds its own harvester agent and the
    operator assigns it the **opt-in harvester role**. Only then is it both granted
    the crawl-queue (base store) + graph-write tools **and prompted to crawl**,
    gated on `!!graphStore`.
  - Its loop is the standard one: `facts_read_uncrawled` → extract entities/edges
    with app logic → `graph_upsert_*` → `facts_mark_crawled`. PilotSwarm supplies
    the **tools and the crawl queue**; the app supplies the **extraction policy**.
    A harvester builder-agent template + a crawling guide (P7) bootstrap this.
  - This works on **base-facts + graph** too — harvesting needs the crawl queue
    and the graph, not vectors.

- **agent-tuner** (read-only investigator — **all** read tools)
  - *Base store, no graph:* `read_facts` + the facts-stats inspect tools (today).
  - *Enhanced facts / graph present:* gets **every read tool** — `facts_search` /
    `facts_similar`, the graph reads (`graph_search_*` / `graph_neighbourhood`),
    and `graph_stats` — for investigations (e.g. "find sessions semantically
    similar to this failure", "traverse what this incident connects to"). It also
    gains the **graph-debug skill** (§1.6): answer *what graph-search query a given
    session ran and what it returned*. That forensic requires graph searches to be
    recorded as durable session events and surfaced via a management API + a
    tuner-only inspect tool, per the observability rule in copilot-instructions
    (P4). Still **no** write / delete / crawl tools — the read-only invariant
    holds, now over the full read surface.

- **sweeper** (fact housekeeping)
  - Continues to sweep **facts** exactly as today — the cascading delete when a
    session (and its descendants) is removed. **Nothing graph-specific.** It
    **never deletes graph nodes**: graph deletion is a harvester-only capability,
    so a deleted session's facts disappear while any graph provenance they backed
    stays until a harvester prunes it (no cross-store cascade, §3 #7). An app that
    wants graph cleanup adds the `graph_delete_*` tools to **its own harvester
    sessions** — covered by the builder templates (P7).

- **pilotswarm / resourcemgr** (orchestration & housekeeping)
  - Facts are incidental to their roles. They keep base KV always and receive the
    reader retrieval/graph tools when the store is enhanced / a graph is present,
    but their prompts are **not materially changed** — tool availability does not
    imply prompt emphasis. They never get harvester power.

### 1.6 The skill-creation pipeline under the EnhancedFactStore

**Bottom line: the pipeline's *contract* does not change. It is forward-compatible
for free, and gains three opt-in, capability-gated quality enhancements.**

#### Intakes and skills are a schematized subset of the base fact store

The knowledge pipeline is **not a separate store** — it is a *schematized subset
of the base `FactStore`*, expressed entirely through reserved key namespaces and
fixed JSON value schemas (see
[shared-skills-pipeline.md](../shared-skills-pipeline.md)):

- **facts-manager only reads `intake/*` and produces `skills/*` (+ `asks/*`).** It
  is the sole writer of the curated namespaces; task agents only write raw
  `intake/*` observations and only read `skills/*` / `asks/*`. That boundary is
  enforced in `createFactTools()` today and is unchanged here.
- Both intakes and skills are **ordinary fact rows** — a reserved key prefix plus
  a fixed value schema, nothing more.

Because they are just base facts, **this subset carries into the
`EnhancedFactStore` unchanged**: the durable embedder embeds `skills/*` (and
`intake/*`) rows automatically, so they become searchable/graphable **with no
namespace-model change, no migration of the pipeline, and no change to the
facts-manager curation cycle, its access control, or its schemas**. The honest
answer to "does the skill pipeline need to change?" is **no, not structurally** —
everything in `shared-skills-pipeline.md` and `facts-manager.agent.md` runs
verbatim on either store; the enhanced store only adds *optional* retrieval
quality on top (below).

#### What improves (opt-in, gated on capabilities)

1. **Read side — replace the framework skills push with a per-turn `search_skills`
   call (enhanced store).** Today
   [`loadKnowledgeIndexFromFactStore`](../../../packages/sdk/src/knowledge-index.ts)
   does a linear `keyPattern="skills/%"` scan **capped at 50** and pushes that
   slice into every prompt during system-message composition. Past a few hundred
   skills, anything beyond the first 50 is effectively invisible. On the enhanced
   store we change this to:
   - **Drop the capped-50 skills push.** The framework no longer reads the skills
     index during prompt composition.
   - **Expose a dedicated `search_skills` tool** (registered only when
     `isEnhancedFactStore && caps.search`) — a thin, skills-scoped wrapper over
     `searchFacts(namespace="skills", scope="shared")` returning ranked skill hints
     (key + name + description) to then `read_facts` in full.
   - **Instruct the agent to call `search_skills` every turn**, querying its actual
     task (the LLM owns the query, which sidesteps the "the latest prompt is a cron
     wake-up" problem). Example queries: `"azure deployments"`,
     `"horizondb connection errors"`, `"terraform s3 backend"`. It may be called
     **as many times as needed** for different facets of the work.
   - **Cost note (the deliberate trade).** This is **similar DB cost to today** —
     roughly one search per turn instead of the per-turn skills read — but the call
     is now an LLM-invoked tool handled in the **SessionManager**, not a
     framework-issued prompt-composition read, and it returns *ranked relevant*
     skills rather than an arbitrary 50-slice, so it scales past a few hundred
     skills. Keeping it simple — one search per turn, no caching layer — is the
     point.
   - **Base store is unchanged** — with no search available, it keeps today's
     capped-50 push verbatim.

2. **Write side — better dedup/merge during curation.** The facts-manager cycle
   already tries to "merge intakes covering the same topic." With `facts_similar` /
   `facts_search` over `skills/`, it can find an existing near-duplicate skill to
   *update* instead of spawning a parallel one — directly attacking the
   "LLMs are inconsistent writers" problem the pipeline exists to solve.

3. **Write side (most speculative) — a parallel knowledge graph.** When a
   `graphStore` is configured **and** the operator stands up a harvester, a graph
   can be built from intake/skills: nodes (tools, errors, configs, services)
   joined by free-text edges ("fixed by", "caused by", "requires"). Readers
   traverse it via `graph_search_nodes({ seeds })` from facts they already found.
   **PilotSwarm does not ship a built-in harvester for this** — graph extraction
   is app-specific, so the application supplies the harvester agent (or the
   operator opts the facts-manager into the harvester role; §1.5). Per the series,
   KV and graph are **separate lifecycles linked only by convention**
   (`EVIDENCED_BY`); the curated `skills/` KV stays authoritative, the graph is a
   derived, rebuildable index. This works with **either** facts axis — the
   harvest loop needs the crawl queue (base) and the graph, not vectors.

4. **Read/debug side — a shared graph-debug skill (operator + tuner).** When
   `!!graphStore`, inject a single **graph-debug skill** into the **facts-manager**
   and **agent-tuner** sessions only (ordinary sessions never see it):
   - **facts-manager** uses it to render the **whole graph as a Markdown / Mermaid
     artifact** (`write_artifact` + `export_artifact`) and to answer ad-hoc
     questions about graph structure and `graph_stats` on demand.
   - **agent-tuner** uses it for **forensics**: "what graph-search query did
     session X run, and what did it get back?" This relies on the graph-search
     observability wiring (P4): each graph search emits a durable `graph.searched`
     event (query + result digest), exposed via a `PilotSwarmManagementClient`
     read method and a tuner-only `read_*` inspect tool.
   - It is the **same** skill content for both, scoped by the tools each role
     holds, and **only injected when `!!graphStore`**.

#### What explicitly does NOT change

- The three namespaces (`intake/` / `asks/` / `skills/`) and their hard
  access-control boundary in `createFactTools()`.
- The curation cycle, confidence progression, schemas, and TTL/expiry.
- The reactive `[FACTS_INTAKE …]` wake-up and the 6-hour maintenance cron.
- Base-store deployments — byte-for-byte today's behavior.

#### Sequencing

None of these are required for the core seam (P1–P5). They are a natural,
clearly-bounded follow-on once an enhanced store is live, tracked as **P8**
(optional). Enhancement 1 (the `search_skills` tool + the per-turn base
instruction) is the recommended first target; enhancement 3 (graph harvest) is the
most speculative and adds facts-manager prompt surface, so it must go through
agent-tuning + an `agent-tuning-log` entry and a `facts-manager.agent.md` version
bump per the repo rules.

---

## 2. Phased execution plan

Each phase is independently reviewable and, except where noted, independently
shippable. File references are starting points, not exhaustive.

### P0 — Incubator provider split (DONE)

**Goal:** prove the D1/D2/D3 shape in the incubator before any SDK/runtime work,
by splitting the single bundled provider into the two segregated providers the
rest of this plan hoists.

**Status: complete** in [`incubator/horizon-facts`](../../../incubator/horizon-facts)
— not yet hoisted to the SDK contract (that is P1/P2) and not wired into
PilotSwarm.

- Split `HorizonFactStore` → **`HorizonDBFactStore`** (implements
  `EnhancedFactStore` only: facts + search/similar + crawl queue + embedder) and a
  new **`HorizonDBGraphStore`** (implements `GraphStore`) — a **separate AGE-only
  provider** with its own pool whose `initialize()` asserts only `age` and runs
  only the graph bootstrap migration.
- Each provider's fail-fast is scoped to **only its own extensions** (facts →
  `vector` / `pg_textsearch` / `pg_durable`; graph → `age`), which is what makes
  the **base-facts + graph** tier real. The graph provider never reads the facts
  table — evidence→value resolution stays the tool-layer composition
  (`graphStore.searchGraphNodes(...)` → `factStore.readFacts({ scopeKeys })`).
- `GraphInterface` renamed to **`GraphStore`** (deprecated alias retained); the
  tool factory is now `createFactsTools(factStore, graphStore, …)` with the graph
  + crawl-queue tools gated on `!!graphStore`.
- **Validated on live HorizonDB:** 105/105 integration + 18/18 DB-less unit; a
  scoped agentic harvest built 16 nodes / 24 edges with 0 tool errors; and the
  **cross-provider evidence round-trip** (graph node evidence resolved through the
  separate fact provider) + the seed pivot both pass.
- **Risk:** n/a (landed). **Reversible:** incubator-only; nothing in `packages/sdk`
  or the runtime changed yet.

### P1 — SDK contract + base-API prerequisites (no HorizonDB needed)

**Goal:** establish `EnhancedFactStore` as the SDK's canonical contract and land
the base-API widenings every enhanced round-trip depends on, with zero behavior
change to the default path.

- Add to [`packages/sdk/src/types.ts`](../../../packages/sdk/src/types.ts) /
  [`facts-store.ts`](../../../packages/sdk/src/facts-store.ts):
  - `FactRecord.scopeKey` and `ReadFactsQuery.scopeKeys` (bulk by-key read).
  - The **base-store crawl queue**: `readUncrawledFacts` / `markFactsCrawled` +
    the `CrawledFactStamp` DTO on `FactStore` itself (D3) — pure facts-table
    bookkeeping, no extension.
  - The `EnhancedFactStore` interface (+ search / similar / embedder DTOs) and the
    **separate `GraphStore`** interface (the 02 §5 graph method set, now an
    independently injected SDK contract) + `scopeKeyAccessible()` + a
    `FactsCapabilities` descriptor (`{ search, embedder }` — no `graph`).
  - An `EnhancedFactsUnsupportedError`.
- Two facts migrations (each + companion `NNNN_diff.md`) per the
  [schema-migration skill](../../../.github/skills/schema-migration/SKILL.md):
  **`0005`** adds `scope_key` exposure to `facts_read_facts` and accepts
  `scopeKeys`; **`0006`** adds the crawl queue — a nullable `last_crawled_at`
  column, a content-change reset trigger, and `facts_read_uncrawled` /
  `facts_mark_crawled` procs. Both are **vanilla PG, no extension**, idempotent,
  and never edit a prior migration.
- Leave `PgFactStore` as a **plain `FactStore`** — it gains `scopeKey`/`scopeKeys`
  **and the crawl queue** (just facts-table SQL, so base deployments can harvest a
  graph), but **no** enhanced methods, **no** `capabilities`, and it does **not**
  implement `GraphStore`. The guard `isEnhancedFactStore(PgFactStore)` is `false`,
  and no graph store exists unless one is injected (§1.4). No throwing stubs;
  `EnhancedFactsUnsupportedError` is retained only for callers that bypass the
  guard and hard-cast.
- **Tests:** existing
  [`facts.test.js`](../../../packages/sdk/test/local/facts.test.js) /
  [`facts-stats.test.js`](../../../packages/sdk/test/local/facts-stats.test.js) /
  [`facts-lineage-contracts.test.js`](../../../packages/sdk/test/local/facts-lineage-contracts.test.js)
  stay green; add a unit test asserting `isEnhancedFactStore(PgFactStore)` is
  `false`, that the base crawl queue round-trips on `PgFactStore`, and that no
  enhanced/graph tools are surfaced without an enhanced store / graph store.
- **Risk:** low. **Reversible:** trivially (additive types + two additive,
  nullable migrations).

### P2 — Promote the incubator to a workspace package

**Goal:** make the HorizonDB provider a buildable monorepo package that
**imports** the SDK contract instead of mirroring it.

- Move `incubator/horizon-facts` → `packages/horizon-store` (decision 4, §6),
  rename `@incubator/horizon-facts` → `@pilotswarm/horizon-store` — the package
  ships **both** the (already-split, P0) facts and graph providers, hence
  `horizon-store` not `horizon-facts`.
- Replace its local `types.ts` contract with `import { … } from "@pilotswarm/sdk"`
  so `HorizonDBFactStore implements EnhancedFactStore` and `HorizonDBGraphStore
  implements GraphStore` bind to the **hoisted SDK contract** (P1) instead of the
  mirrored copy. The two-provider split itself is **already done (P0)**; P2 only
  moves the package and inverts the type dependency. Each provider keeps its own
  pool and its extension-scoped fail-fast, and the graph provider still never
  reads the facts table.
- Keep it self-contained at runtime (its only runtime dep stays `pg`); the SDK
  dependency is **type-only** where possible to avoid a cycle.
- Keep the vendored migrator for now; plan the merge-back into
  [`pg-migrator.ts`](../../../packages/sdk/src/pg-migrator.ts) on graduation
  (distinct advisory-lock seed `HORIZON_FACTS_LOCK_SEED` already chosen).
- **Tests:** the package's DB-less unit tests run in CI; the live integration
  tests stay gated on `HORIZON_DATABASE_URL`.
- **Risk:** medium (workspace wiring, potential type cycle). **Reversible:** yes
  (revert the move; the SDK contract from P1 stands alone).

### P3 — Provider selection + injection + schema isolation

**Goal:** booting with the enhanced provider configured yields a real
`HorizonDBFactStore`; the default path is unchanged.

- Config additions to
  [`PilotSwarmWorkerOptions` / `PilotSwarmClientOptions`](../../../packages/sdk/src/types.ts):
  `enhancedFactsDatabaseUrl?`, **`graphDatabaseUrl?`** (opt-in graph), an explicit
  `factsProvider?: "pg" | "horizon"` (default inferred: `horizon` iff
  `enhancedFactsDatabaseUrl` is set), and `horizonEmbed?` (the
  `EmbeddingEndpointConfig`, sourced from env).
- In [`createFactStoreForUrl()`](../../../packages/sdk/src/facts-store.ts):
  resolve provider; for `horizon`, **dynamically import** `@pilotswarm/horizon-store`
  and `HorizonDBFactStore.create(...)`. A missing package throws a clear, actionable
  error **only when horizon is explicitly selected**.
- Add the parallel **graph-store constructor** `createGraphStoreForUrl()` (new
  `graph-store.ts`, mirroring `createFactStoreForUrl()`): when `graphDatabaseUrl`
  is set, it constructs a `HorizonDBGraphStore` (its own AGE-only provider, own
  pool) and the worker threads it via `sessionManager.setGraphStore()`. No
  `factStore` argument, no instance reuse — a self-contained peer of the facts
  constructor. Unset → no graph store, no graph tools.
- Wire the connection-string resolution from [§1.3](#13-connection-targets-from-02--the-series-readme).
- Land the `ps_duroxide` schema rename (design + verification already done in the
  incubator) as its own commit within this phase, since the enhanced store on the
  same cluster collides with `pg_durable` on the `duroxide` schema name.
- **Tests:** a boot test with `factsProvider:"horizon"` against
  `HORIZON_DATABASE_URL` (skips when unset); a test asserting the default path
  still constructs `PgFactStore`; and graph-injection tests — `graphStore` is
  **absent** when `graphDatabaseUrl` is unset, and **present and the same
  instance** when it equals the horizon facts URL.
- **Risk:** medium-high (the schema rename touches orchestration). **Reversible:**
  provider selection yes; the schema rename is guarded/online but is a forward
  migration — gate behind the rename-verification script before deploy.

### P4 — Enhanced + graph tools (capability-gated)

**Goal:** agents can search and traverse when the provider supports it; base
`store_fact` / `read_facts` / `delete_fact` are unchanged everywhere.

- In [`facts-tools.ts`](../../../packages/sdk/src/facts-tools.ts) `createFactTools()`
  (+ a sibling `createGraphTools()` in `graph-tools.ts`), add the reader tools
  (`facts_search`, `facts_similar`,
  `graph_search_nodes`, `graph_search_edges`, `graph_neighbourhood`) and the
  **harvester** tools (`facts_read_uncrawled`, `facts_mark_crawled`,
  `graph_upsert_node`, `graph_upsert_edge`, `graph_merge_nodes`,
  `graph_delete_node`, `graph_delete_edge`) per [05-tools-spec](./05-tools-spec.md).
- Gate registration on the §1.5 **role × capability × graph-present** matrix:
  facts retrieval tools when `isEnhancedFactStore(store) && caps.search`; **graph
  read tools + `graph_stats` when `!!graphStore`**; crawl-queue + graph-write/delete
  tools for the **app harvester role and the facts-manager** (the latter granted
  the tools but **dormant** — registered, not prompted to crawl), only when
  `!!graphStore`. **agent-tuner gets every read tool** (base + enhanced + graph
  reads + `graph_stats`) and **no** mutating tool. Reader tools go to all other
  non-harvester sessions.
- **Observability wiring (graph searches):** record each graph search as a durable
  session event (`graph.searched`, with the query + a result digest), expose it via
  a `PilotSwarmManagementClient` read method, and wrap it as a tuner-only `read_*`
  inspect tool — per the observability rule in copilot-instructions. This is what
  lets the agent-tuner graph-debug skill (§1.6) answer "what did session X search
  and get back."
- Make the agent **prompts** capability-aware in the same phase: extend
  [`_buildKnowledgeToolInstructionsSection`](../../../packages/sdk/src/session-manager.ts)
  so the `tool_instructions` block names the retrieval/graph tools that were
  actually registered and the matching skill to load (§1.5). Base store → today's
  block, unchanged.
- Names are already `facts_*` / `graph_*` (collision-safe), but run the
  [`tool-name-collisions.test.js`](../../../packages/sdk/test/local/tool-name-collisions.test.js)
  regression and the SDK-built-in audit from the contributor instructions.
- **Tests:** capability-gating unit test (no enhanced tools registered for
  `PgFactStore`); an enhanced-tools integration test gated on `HORIZON_DATABASE_URL`.
- **Risk:** medium. **Reversible:** yes (tools are additive and gated).

### P5 — Durable embedder lifecycle

**Goal:** facts get embedded asynchronously so semantic/hybrid search returns
real results.

- On worker boot, when `horizonEmbed` is configured: **observe then ensure** —
  read `embedderStatus()` and only `configureEmbedder()` + `startEmbedder()` when
  the durable loop is not already running, so a rolling fleet converges on
  exactly one loop per schema. This is **non-fatal**: if configure/start fails
  (endpoint down, transient lock), the worker still boots and semantic/hybrid
  search degrades to lexical until a later boot or explicit configure succeeds.
- **No stop on worker shutdown.** The embed loop is a **shared, fleet-wide
  durable resource** (one per schema in `pg_durable`), not owned by any single
  worker. Stopping it when one worker drains would halt embedding for the whole
  fleet and a rolling restart would leave it stopped. It is therefore an
  **operator-owned** resource: stop it explicitly (`stopEmbedder()`) only when
  decommissioning the schema, never as part of ordinary `worker.stop()`.
- The loop itself is durable/idempotent **inside** HorizonDB (`pg_durable`), so
  this is just lifecycle control — it must **never** run inline in orchestration
  (determinism boundary, [§3](#3-cross-cutting-invariants)).
- Embedding state follows the minimal model in
  [08-embedding-handling.md](./08-embedding-handling.md): a batch loop embeds
  ordinary pending rows, a retry loop handles `last_embed_error = -1`, terminal
  failures are positive `last_embed_error` codes, and crawler state is untouched.
- Secrets: the embedder API key lives in a durable var (plaintext-at-rest) — an
  accepted incubation TODO; do not log it; source from env/k8s only.
- **Tests:** an embedder-status integration test against a real endpoint
  (`HORIZON_EMBED_*`), gated; assert pending→embedded transition makes a fact
  semantically findable.
- **Risk:** medium. **Reversible:** yes (don't configure the embedder → semantic
  search simply returns nothing for un-embedded facts).

### P6 — Test strategy

**Goal:** prove drop-in equivalence and exercise the new surface, with everything
runnable via [`scripts/run-tests.sh`](../../../scripts/run-tests.sh).

- **Provider-parity suite:** run the existing facts contracts against
  `HorizonDBFactStore` (gated on `HORIZON_DATABASE_URL`, auto-skip otherwise) —
  proves the superset honors the base contract.
- **Enhanced suite:** search modes (lexical/semantic/hybrid), `similarFacts`,
  crawl queue receipts, and graph reader/harvester flows.
- **Composition suite (base-facts + graph):** a `PgFactStore` paired with a
  `GraphStore` — assert graph reads/writes work with lexical / lineage / kind /
  node seeding and **no** search tools registered, and that the base crawl queue
  drives an incremental harvest. Gated on graph availability.
- **Capability-limited suite:** assert `isEnhancedFactStore(PgFactStore)` is
  `false`; with no `graphStore`, no graph tools (and no crawl-queue tools) are
  surfaced on either reader or harvester sessions; and the base-store knowledge
  block is unchanged.
- Register every new `test/local/*.test.js` in both the `SUITES` array in
  [`run-tests.sh`](../../../scripts/run-tests.sh) and the `test:local` script per
  the contributor rule (no orphaned manual-only tests). **No retries, no
  weakened assertions** ([test integrity rules](../../../.github/copilot-instructions.md)).
- **Risk:** low. **Reversible:** n/a.

### P7 — Docs, sample, templates (the significant-rollout rule)

- Update [`docs/configuration.md`](../../../docs/configuration.md) (new
  `enhancedFactsDatabaseUrl` / `factsProvider` / `HORIZON_EMBED_*`),
  [`docs/facts-table.md`](../../../docs/facts-table.md), and the architecture
  docs; keep `.env.example` / `.model_providers.example.json` shape in sync.
- Refresh the DevOps sample and builder templates **only if** facts behavior is
  builder-visible (enhanced tools change what app authors can wire).
- **New — graph-harvester crawling guide** (`docs/`): explains the facts↔graph
  crawl queue, the harvester loop (`facts_read_uncrawled` → extract →
  `graph_upsert_*` → `facts_mark_crawled`), the shared-graph trust model, and how
  an app stands up its own harvester. The canonical "how to build a harvester"
  reference.
- **New — harvester-crawler builder-agent template** under
  [`templates/builder-agents/`](../../../templates/builder-agents/) (a
  `*-harvester.agent.md` + companion skill) so app authors can scaffold a
  domain-specific harvester. Per the agent-versioning skill it ships
  `schemaVersion: 1` + a `version`; keep `docs/builder-agents.md` and the template
  README in sync.
- **Builder-template instruction (graph delete):** document in the builder
  templates that **graph nodes/edges are deleted only by harvester sessions** —
  the app adds `graph_delete_*` to its own harvester agents; the sweeper never
  touches the graph. App authors who want graph cleanup wire it there.
- **Phase 2** context tools (`searchGraphContext` / `similarGraphContext`,
  `facts_context_*`) remain **deferred** — gated behind a harvested graph, per
  the series README. Not in this integration.

### P8 — Knowledge-pipeline enhancement (optional, gated on an enhanced store)

**Goal:** let the existing shared-skills pipeline *use* the enhanced surface. The
pipeline's contract is unchanged (§1.6) — this phase is purely additive quality,
and only runs when `isEnhancedFactStore(store)` is true.

- **Read side (highest value):** on the enhanced store, **drop** the capped-50
  skills push (`loadKnowledgeIndexFromFactStore`) and instead expose a dedicated
  `search_skills` tool (registered only when `isEnhancedFactStore && caps.search`)
  — a thin wrapper over `searchFacts(namespace="skills", scope="shared")` returning
  ranked skill hints to `read_facts` in full. Modify the default agent's base
  instructions (enhanced-only) to **call `search_skills` every turn** with a
  task-derived query (examples: `"azure deployments"`, `"horizondb connection
  errors"`), callable as many times as needed. Similar DB cost to today's push but
  paid by the LLM-invoked tool handler and returning ranked-relevant results; no
  caching layer. The base store keeps today's push verbatim.
- **Write side:** teach the facts-manager curation cycle to `facts_similar` /
  `facts_search` over `skills/` before creating a skill, to update an existing
  near-duplicate instead of spawning a parallel one.
- **Write side (most speculative):** expose the crawl-queue + graph-write tools to
  an **app-defined, opt-in harvester role** (the facts-manager also holds the
  tools but stays dormant; §1.5). PilotSwarm ships the tools and the crawl queue;
  the **application** builds the harvester agent (`facts_read_uncrawled` → app
  extraction → `graph_upsert_*` → `facts_mark_crawled`).
- **Debug/observability side:** add the shared **graph-debug skill** (§1.6) for
  the **facts-manager** (graph → Markdown/Mermaid artifact, structure/stats Q&A)
  and the **agent-tuner** (session graph-search forensics), injected only when
  `!!graphStore`. Requires the `graph.searched` event + management API + tuner
  inspect tool from P4.
- **Agent versioning:** bump `facts-manager.agent.md`, `agent-tuner.agent.md`, and
  the default agent's knowledge-pipeline section, and record the change in both
  agent-tuning logs per the repo rules.
- **Tests:** an enhanced-store test asserting `search_skills` is registered, the
  capped-50 push is **not** applied, and topical queries surface the right skills
  beyond 50; a base-store test asserting the capped-50 push is byte-for-byte
  unchanged and `search_skills` is **not** registered.
- **Risk:** low–medium, fully gated. **Reversible:** yes (base store / unset caps
  → today's pipeline).

---

## 3. Cross-cutting invariants

These hold across all phases and are non-negotiable (carried from the series +
[copilot-instructions](../../../.github/copilot-instructions.md)):

1. **The `facts` table stays authoritative.** tsvector / vector / AGE are derived
   indexes; the graph stores **ids + structure, never values or ACLs**.
2. **Governance unchanged.** Scope / `shared` / `transient` / namespace ACLs /
   spawn-tree visibility are enforced in stored procedures; search modes are
   extra `AND` clauses **inside** the existing visibility filter — they can only
   narrow what a caller can already see. ACL is in the proc `WHERE`, **before**
   ranking/LIMIT.
3. **Determinism boundary.** Anything LLM/IO (embedding, distillation,
   relatedness) runs as a `pg_durable` activity — **never** inline in the duroxide
   orchestration. The embedder is lifecycle-controlled, not driven by the
   orchestrator.
4. **Rebuildable.** Every derived artifact can be dropped and rebuilt from
   `facts` rows.
5. **Default path is sacred.** No change selects HorizonDB or a graph implicitly;
   vanilla Postgres deployments keep working with `PgFactStore` and **no new
   extensions**. The P1 crawl-queue migration adds one nullable column + a trigger
   in vanilla PG (no extension) and is inert unless a graph harvester runs.
6. **Stored procs + numbered migrations only.** No new inline SQL; every
   migration ships a companion `NNNN_diff.md`.
7. **Graph is an optional, separate store.** Facts never depend on a graph; the
   `GraphStore` is injected separately and absent by default. The only facts↔graph
   coupling is the base-store crawl queue + the `EVIDENCED_BY` evidence
   convention — never a hard FK or a cross-store cascade.

---

## 4. Sequencing & dependencies

```
P0 (incubator provider split — DONE) ──▶ hoisted by P2
P1 ──▶ P2 ──▶ P3 ──▶ P4 ──▶ P5 ──▶ P8 (optional: knowledge-pipeline enhancement)
 │             │
 └─────────────┴────────────────▶ P6 (tests track each phase)  ──▶ P7 (docs)
```

- P0 (incubator provider split) is **done** — it gates the package move (P2), not
  the SDK contract (P1).
- P1 is a safe standalone PR (contract + base-API widening); it can merge before
  the package exists.
- P2 depends on P0 (hoists the already-split providers) and P1 (imports the
  hoisted contract).
- P3 depends on P2 (constructs the provider) and carries the `ps_duroxide`
  rename.
- P4 depends on P3 (needs a live capability-advertising provider).
- P5 depends on P3 (embedder lives in the provider) and makes P4's semantic
  search meaningful.
- P8 (optional) depends on P4 + P5 — the knowledge-pipeline enhancement only has
  teeth once reader tools exist and facts are actually embedded (§1.6).
- A **thin vertical slice** (P1–P3 + the parity slice of P6) de-risks the seam
  before investing in P4–P5. Recommended first PR boundary.

---

## 5. Risks & rollback

| Risk | Mitigation | Rollback |
|------|------------|----------|
| Enhanced methods reachable on the default path | Segregated interfaces + `isEnhancedFactStore` guard (`PgFactStore` has no enhanced methods to call); guarded dynamic import; default never selects horizon | Provider selection is config-gated; unset → `PgFactStore` |
| `last_crawled_at` migration touches the default facts schema | Additive nullable column + trigger in vanilla PG (no extension); inert unless a harvester runs; idempotent migration + diff file | Column is nullable and unused on base deployments; drop in a down-migration if ever needed |
| Graph store misconfigured or unreachable | Graph is opt-in and isolated — unset `graphDatabaseUrl` → no graph tools; a failed graph init disables graph tools without affecting facts | Unset `graphDatabaseUrl` → facts run exactly as before |
| `ps_duroxide` rename disrupts orchestration | Online single-transaction advisory-locked `ALTER SCHEMA` with recreation guard; pre-verified 9/9 on live HorizonDB | Forward migration — gate on the verification script; keep old workers failing loud (never recreate old store) |
| Type cycle between SDK and provider package | Type-only imports across the boundary; provider runtime dep stays `pg` | Revert P2 move; P1 contract stands alone |
| Tool-name collision with SDK built-ins | `facts_*`/`graph_*` prefixes + run the collision regression every SDK bump | Rename offending tool to `ps_<name>` per contributor rule |
| Embedder API key at rest | Durable var, env-sourced, never logged; flagged incubation TODO | Don't configure embedder → feature dark |
| In-flight orchestration replay after schema/tool changes | Follow duroxide orchestration-versioning skill; reset DB on orchestration changes per deploy convention | Standard duroxide version-freeze + DB reset |

---

## 6. Open decisions for the reviewer

1. **D1 (default path):** resolved to *two segregated interfaces with structural
   capability detection* — `PgFactStore` stays a plain `FactStore` (no throwing
   stubs), `EnhancedFactStore` is the superset, and the runtime answers "base or
   enhanced?" via `isEnhancedFactStore(store)` + a `capabilities` descriptor on
   the enhanced interface (§1.4, §1.5). This supersedes the earlier sketch of a
   throwing `EnhancedFactStore`. Alternative still open: **make HorizonDB required
   and drop `PgFactStore`** — a single contract, but every deployment (local dev,
   Docker appliance, OSS) must then run AGE + pgvector + pg_textsearch +
   pg_durable. Override only if PilotSwarm is committing to HorizonDB as its
   substrate.
2. **D2 (graph):** resolved to *the graph is its own optional injected SDK
   interface `GraphStore`* (own `graphDatabaseUrl`, presence `!!graphStore`),
   composable with **either** a base or an enhanced fact store — not a capability
   boolean on the fact store (§1.4). It is implemented by a **separate provider**
   `HorizonDBGraphStore` (AGE-only); the bundled HorizonDB case is two independent
   providers pointed at one database, not one shared object. This supersedes the
   earlier "graph is a capability on the enhanced store" sketch (and the
   short-lived "one class backs both / shared instance" variant), and shrinks the
   `capabilities` bag to `{ search, embedder }`. Still open: whether to keep graph
   traversal **agent/tool-facing only** (this doc's stance) or also let runtime
   code consume the injected `GraphStore` later — the injected interface makes
   that possible without re-plumbing.
3. **D3 (crawl bridge):** resolved to *put the crawl queue on the base
   `FactStore`* via an additive vanilla-PG migration (§1.1, P1), so **base-facts +
   graph** harvests incrementally. Alternative: leave it on the enhanced store —
   simpler (no base-schema change) but base + graph would then full-scan to
   harvest. Override if the base-schema migration is unwanted.
4. **Package name / location:** **resolved** — the provider package moves to
   `packages/horizon-store` as `@pilotswarm/horizon-store`, pulled out of
   `incubator/`. It is named `horizon-store` (not `horizon-facts`) because it ships
   **both** the `HorizonDBFactStore` and `HorizonDBGraphStore` providers. The
   class split + renames are **P0 — done in the incubator** (validated 105/105 on
   live HorizonDB); the directory move itself is the **P2** deliverable.
5. **First PR boundary:** full P1–P7 vs. the recommended thin slice (P1–P3 +
   parity tests) first, then layer P4–P7.

---

## 7. Relationship to the rest of the series

- **01–06** — the EnhancedFactStore design + the HorizonDB provider, originally
  validated in isolation, **now reconciled to this doc's shape** (separate
  `GraphStore` provider, crawl queue on the base `FactStore`,
  `HorizonDBFactStore` / `HorizonDBGraphStore` naming, `@pilotswarm/horizon-store`
  package). Each carries an alignment note pointing here as canonical.
- **GAP-ANALYSIS "Out of scope (this pass)"** — the exact PilotSwarm-core backlog
  (`scopeKey`/`scopeKeys`, provider injection, `enhancedFactsDatabaseUrl`,
  `ps_duroxide`). **This doc is that work, sequenced.**
- **Eval upgrade (06 scenario tier on the real corpus)** — follows once the
  provider lands; the incubator's `store-adapter.mjs` collapses to pass-throughs.
