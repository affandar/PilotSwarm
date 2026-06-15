# Open Graph Crawler — Design Spec

Status: incubation. Companion to [SPEC.md](./SPEC.md) (base hybrid facts store)
and the narrative in [CRAWLER.md](./CRAWLER.md). This document is the
implementation contract: **API first**, then the data model, then a precise
breakdown of *what runs where* (AI pipeline vs pg_durable vs synchronous call),
closing with the PostgreSQL mailing-list worked example.

The crawler turns the authoritative `facts` table into an **open, ontology-free
knowledge graph**: an LLM harvesting agent invents entities and free-text
relationships, every edge carries mandatory provenance back to the facts that
justify it, and the graph is queried two ways only — *anchor-and-explore* or
*exact-predicate*.

---

## 1. API (the contract)

All types live in [src/types.ts](./src/types.ts). The graph is reached through
one interface, `GraphCrawlerInterface`, split into **query** and **assert**
halves. Pure quality logic (canonicalization, predicate normalization,
confidence math, validation) lives in [src/graph-model.ts](./src/graph-model.ts)
and is DB-less + unit-tested.

```ts
interface GraphCrawlerInterface {
  // ── query (two modes only) ────────────────────────────────────────────
  searchEntities(q: EntityQuery): Promise<EntityHit[]>;        // find an anchor
  neighbourhood(entityKey: string, depth: number): Promise<SubGraph>;  // explore
  searchRelationships(q: RelQuery): Promise<RelHit[]>;         // exact-predicate

  // ── assert (provenance mandatory) ─────────────────────────────────────
  upsertEntity(e: EntityAssertion): Promise<EntityRef>;
  assertRelationship(r: RelAssertion): Promise<RelRef>;
  linkEvidence(nodeOrEdgeKey: string, factScopeKeys: string[]): Promise<void>;
  mergeEntities(fromKey: string, intoKey: string, reason: string): Promise<void>;
}
```

### 1.1 Query — two modes, no fuzzy matching

**Mode 1 — anchor-and-explore.** The agent finds a node by other means (a fact
search in `EnhancedFactStore.searchFacts` → an entity), then reads its edges and
*discovers* which predicates exist.

```ts
searchEntities({ kind?, nameLike?, limit? }): EntityHit[]
neighbourhood(entityKey, depth): SubGraph    // { nodes[], edges[] }
searchRelationships({ fromKey?, toKey?, minConfidence?, limit? }): RelHit[]
```

**Mode 2 — exact-predicate.** When a calling agent maintains its **own** agreed
vocabulary (in the agent layer, not in this graph), it queries the exact edge
type. Equality only — never `LIKE`, never semantic similarity.

```ts
searchRelationships({
  predicate?: string,      // exact text, e.g. "revives argument from"
  predicateKey?: string,   // preferred: surface-stable key, e.g. "revive_argument"
  fromKey?, toKey?, minConfidence?, limit?
}): RelHit[]
```

The graph **neither defines nor enforces** an ontology. `predicateKey` exists so
that exact queries are surface-stable (`"comments on"` and `"comment on"` resolve
to one key), used for grouping/equality, not discovery.

### 1.2 Assert — write half, provenance enforced

```ts
upsertEntity({ kind, name, aliases?, evidence?, agentId }): EntityRef
  // create-or-reuse by canonical entity_key; merges aliases; never duplicates.

assertRelationship({
  fromKey, toKey, predicate, confidence, evidence /* ≥1 */, agentId, model?
}): RelRef
  // validateAssertion() rejects empty evidence BEFORE any write.
  // decideEdgeMerge() reinforces a matching edge (noisy-OR + obs++) or creates.

linkEvidence(nodeOrEdgeKey, factScopeKeys[]): void
  // EVIDENCED_BY edges to authoritative Fact rows (scope_key refs only).

mergeEntities(fromKey, intoKey, reason): void
  // entity resolution: repoint edges, union aliases, record reason.
```

The invariant that makes an LLM-built graph trustworthy: **no evidence ⇒
rejected**. Proven in [poc/05-crawler.mjs](./poc/05-crawler.mjs).

---

## 2. Data model / schema

Defined in [sql/005_open_graph.sql](./sql/005_open_graph.sql), layered **next to**
the fixed structural graph from [sql/002_age_graph.sql](./sql/002_age_graph.sql)
in the same AGE graph `horizon_facts`.

### 2.1 Label-stable, semantics-open

AGE wants known labels; we want open semantics. Resolution: **exactly three
labels**, with all semantics in properties.

| AGE label | Role | Open field |
| --- | --- | --- |
| `(:Entity)` | any node | `kind` (free text: person, patch, code_file, topic…) |
| `-[:REL]->` | any relationship | `predicate` (free text, LLM-minted) |
| `-[:EVIDENCED_BY]->` | provenance | — (node/edge → `Fact`) |

No migration is ever needed to express a new entity kind or predicate.

### 2.2 Property contracts

```
(:Entity {
   entity_key   : "<norm-kind>:<norm-name>"   -- canonical dedup key (PK-like)
   kind, name, aliases[]                       -- aliases pre-merged app-side
   created_by, created_at, updated_at
})

-[:REL {
   predicate       : "revives argument from"   -- free text, the edge "type"
   predicate_key   : "revive_argument"         -- normalized; exact-query key
   confidence      : 0.0..1.0                  -- combined (noisy-OR) across obs
   observations    : int                       -- reinforcement count
   asserted_by     : [agentId, …]
   evidence        : [fact.scope_key, …]       -- REQUIRED, non-empty
   model           : "<llm>"
   first_seen, last_seen
}]->

-[:EVIDENCED_BY]-> (:Fact { scope_key })        -- Fact nodes from 002 backfill
```

### 2.3 Authority & rebuildability

The authoritative store is the **`facts` table**, not the graph. Every `Entity`
should have ≥1 `EVIDENCED_BY`; every `REL` has non-empty `evidence`. This makes
the open graph a **derived projection** — it can be rebuilt or reconciled from
facts, and any edge whose evidence facts vanished is detectable and prunable.

### 2.4 Quality core (DB-less)

[src/graph-model.ts](./src/graph-model.ts) holds the policy the adapter applies:

| Function | Purpose |
| --- | --- |
| `normalizeName` / `entityKey` | surface-form dedup → canonical `entity_key` |
| `predicateKey` | normalize free-text predicate → grouping/equality key |
| `mergeAliases` | union surface forms without dups |
| `validateAssertion` | reject empty-evidence assertions (the guard) |
| `decideEdgeMerge` | create-vs-reinforce + noisy-OR confidence |

---

## 3. Implementation — what runs where

This is the crux. Three distinct compute tiers, never conflated.

```
┌─ SYNC (request path) ───────────────────────────────────────────────┐
│  USER AGENT harvests: it reads facts, calls its own LLM, and asserts │
│  through the GraphCrawlerInterface tool. Crawler call →               │
│  HorizonFactStore adapter → AGE Cypher / facts SQL. Bounded,         │
│  transactional, returns to the caller. ALL graph writes live here.   │
└──────────────────────────────────────────────────────────────────────┘
┌─ AI PIPELINE (model inference) ─────────────────────────────────────┐
│  (a) HARVEST extraction — the USER AGENT's own LLM turn (in the      │
│      PilotSwarm session), NOT a HorizonDB pipeline call. Emits       │
│      entities+predicates, then asserts via the sync API.             │
│  (b) Fact EMBEDDINGS for searchFacts — the ONLY model inference run  │
│      by HorizonDB, inside a pg_durable activity.                     │
└──────────────────────────────────────────────────────────────────────┘
┌─ PG_DURABLE (duroxide background, idle-gated, crash-safe) ──────────┐
│  EMBEDDINGS + graph maintenance ONLY. No harvesting. Schedules       │
│  activities; replayable. Defined in 004_pipelines.sql.               │
└──────────────────────────────────────────────────────────────────────┘
```

### 3.1 Synchronous calls (the request path) — where harvesting happens

**Harvesting is done by the user's agents, not by the database.** A user agent
running in a PilotSwarm session reads facts, runs its own LLM turn to extract
entities + free-text predicates, and writes them through the
`GraphCrawlerInterface` tool. Every call is a **sync, bounded** DB operation in
the `HorizonFactStore` adapter (the not-yet-built middle layer). No HorizonDB
model inference, no background work — **all graph writes flow through here.**

| Call | Tier | Work |
| --- | --- | --- |
| `searchEntities` | SYNC | AGE `MATCH (:Entity)` by name/alias |
| `neighbourhood` | SYNC | AGE variable-length `MATCH` to depth |
| `searchRelationships` | SYNC | AGE `MATCH ()-[:REL]->()`, exact `predicate_key` |
| `upsertEntity` | SYNC | `entityKey()` then `MERGE (:Entity)` |
| `assertRelationship` | SYNC | `validateAssertion` + `decideEdgeMerge` → `CREATE`/`SET` |
| `linkEvidence` | SYNC | `MERGE (e)-[:EVIDENCED_BY]->(:Fact)` |
| `mergeEntities` | SYNC | repoint edges + union aliases + delete dup |

The **quality decisions are pure** (graph-model.ts, no IO); the adapter only
applies their output as Cypher. That's why they're unit-testable DB-less, and
why the same guards apply no matter which agent asserts.

### 3.2 AI pipeline (model inference)

1. **Harvest extraction** is the **user agent's own LLM turn** inside its
   PilotSwarm session — it reads a fact plus RECALL context and emits
   `{ entities[], rels[] }` with free-text predicates and per-rel confidence,
   then asserts via the sync API (§3.1). This is **not** a HorizonDB AI-pipeline
   call and **not** a pg_durable activity. The database never harvests.
2. **Fact embeddings** for `searchFacts` anchor discovery — the existing
   `embed_new_facts` activity. This is the **only** model inference HorizonDB
   runs, and it does so inside pg_durable (§3.3) by calling a **configurable
   HTTP embedding endpoint** (OpenAI/Azure-OpenAI-compatible) passed to the
   provider — replacing HorizonDB's built-in `aiModelManagement`.

> There is **no** predicate embedding and **no** entity-semantic search. Mode 2
> is exact-match only, so embeddings exist solely to power `searchFacts` anchor
> discovery (Mode 1).

### 3.3 pg_durable (embeddings + maintenance ONLY — no harvesting)

pg_durable does **not** build the graph. It keeps the facts embedded (so agents
can find anchors) and keeps the graph consistent with the authoritative facts
table. One idle-gated, crash-safe loop, unchanged from
[sql/004_pipelines.sql](./sql/004_pipelines.sql) — activities do the IO, the loop
only schedules.

| Activity | Tier | Work |
| --- | --- | --- |
| `embed_new_facts` | pg_durable + HTTP | embed facts where `embedding IS NULL` by POSTing to the configured endpoint from inside the DB (`sql/006`); powers `searchFacts` anchor discovery. Node fallback: `embedPending()` |
| `refresh_related_edges` | pg_durable + SYNC SQL | ANN top-k → `RELATED_TO` edges for `relatedFacts` |
| `reconcile_graph` | pg_durable + SYNC SQL | drop `Entity`/`REL` whose evidence facts vanished; keep graph rebuildable from facts |
| `predicate_report` | pg_durable + SYNC SQL | roll up distinct `predicate_key` + counts for **visibility only** (sprawl monitoring, not querying) |

No `harvest_fact`, no `apply_harvest`, no `select_unharvested_facts` activity —
harvesting is an agent responsibility, not a database one. The graph grows only
when a user agent asserts.

### 3.4 Determinism boundary (why embeddings sit in an activity)

duroxide replays orchestrations. `Date.now()`, `Math.random()`, and **model
calls** are non-deterministic, so the one inference HorizonDB does run
(`embed_new_facts`) must sit inside an activity (`durable.func`), recorded once
in history and replayed from the record. The loop only schedules. Harvesting
avoids this concern entirely by living in the agent layer, outside duroxide's
maintenance orchestration.

---

## 4. Worked example — the PostgreSQL hackers mailing list

Scenario: ingest `pgsql-hackers` archives as facts, then let the crawler build an
open graph of who argues about what across patches, files, and threads. Runnable
DB-less today via [poc/05-crawler.mjs](./poc/05-crawler.mjs) (LLM + AGE stubbed).

### 4.1 Two archived messages arrive as facts

```
Fact shared:archive/pgsql-hackers/msg/1001  (Tom Lane reviews a JSONB subscript patch)
Fact shared:archive/pgsql-hackers/msg/1002  (a follow-up, signed "tgl", same debate)
```

### 4.2 A user harvesting agent processes msg/1001

A user agent (in its PilotSwarm session) reads the fact, runs its own LLM turn,
and asserts through the crawler tool. The database does no harvesting.

```
agent reads fact 1001 (e.g. via searchFacts / readFacts)
agent LLM turn extracts → {
  entities: [person "Tom Lane" (tgl), patch "v3 fix jsonb subscript",
             code_file "src/backend/utils/adt/jsonbsubs.c",
             thread "2025 jsonb subscript semantics"],
  rels: [ Tom Lane --comments on(.95)--> patch,
          patch --touches(.9)--> code_file,
          patch --revives argument from(.7)--> thread ] }
SYNC API calls:
  upsertEntity ×4  (canonical entity_key each)
  assertRelationship ×3  (evidence=[1001])  → all created
```

No schema change expressed `"revives argument from"` — it was minted on the spot.

### 4.3 The agent processes msg/1002 (the interesting part)

```
agent LLM turn on 1002 → person "tgl", patch (same), rel "comment on"(.8)
SYNC API calls:
  RESOLVE: searchEntities(person,"tgl") matches existing "Tom Lane" by alias
           → reuse person:tom-lane, record "tgl" as an alias  (NOT a new node)
  assertRelationship(tom-lane --comment on--> patch, evidence=[1002]):
     predicate_key("comment on") == predicate_key("comments on") == "comment"
     → REINFORCE existing edge: confidence 0.95 ⊕ 0.80 = 0.99 (noisy-OR),
       observations 1→2, evidence [1001, 1002]
```

This is the whole value: identity resolved by **search-first**, the edge
**reinforced not duplicated**, provenance accumulated.

### 4.4 An evidence-free assertion is rejected

```
assertRelationship(tom-lane --secretly controls--> topic, evidence=[])
  → validateAssertion: "at least one evidence fact is required" → REJECTED
```

### 4.5 Querying the result

```
Mode 1 (explore):  searchFacts("jsonb subscripting debate") → thread entity
                   neighbourhood(thread, 2) → predicates: [revive_argument,
                   comment, touche] → follow "revive_argument" edges
Mode 2 (exact):    searchRelationships({ predicateKey:"touche",
                   toKey:"code_file:…jsonbsubs-c", minConfidence:0.8 })
                   → every patch that touches that file
Explain:           follow EVIDENCED_BY → msg/1001, msg/1002
```

### 4.6 Verified invariants (from the PoC)

- `tgl` collapsed into one `person:tom-lane` (alias, not duplicate).
- `"comments on"` + `"comment on"` → one edge, confidence **0.990**, obs **2**,
  evidence from **both** messages.
- `"revives argument from"` / `"touches"` minted with **zero** schema change.
- evidence-free `"secretly controls"` **rejected**.

```
✔ all open-graph invariants held (dedup, reinforcement, evidence guard, provenance)
```

---

## 5. Build status & boundaries

| Layer | State |
| --- | --- |
| API contracts ([types.ts](./src/types.ts)) | done |
| Quality core ([graph-model.ts](./src/graph-model.ts)) | done, unit-tested |
| Open-graph schema ([sql/005](./sql/005_open_graph.sql)) | Cypher spec written |
| Embeddings + maintenance loop ([sql/004](./sql/004_pipelines.sql)) | written (embeddings only — no harvesting) |
| HTTP embedding pipeline ([sql/006](./sql/006_embeddings_http.sql), [http-embedding.ts](./src/http-embedding.ts)) | done — in-DB HTTP + Node fallback |
| `HorizonFactStore` adapter ([horizon-store.ts](./src/horizon-store.ts)) | done — drop-in EnhancedFactStore + crawler, integration-tested |
| Optional agent tools ([agent-tools.ts](./src/agent-tools.ts)) | done — opt-in tool injection |
| Harvesting agent (prompt) | **not built** — lives in the user's agent layer, not the DB |

The PoC stubs exactly two boundaries: `extractRelationships()` (the AI-pipeline
LLM call) and `InMemoryGraph` (the AGE adapter). Everything between — resolve,
validate, reinforce, evidence-link — is the real, tested logic.
