# Enhanced Facts Interface on HorizonDB — Design Spec

> Incubation spec. Optional, HorizonDB-only. Not integrated with PilotSwarm yet.

This document covers three things, in order:

1. **Data model** — what goes where (and, critically, what does *not* move).
2. **Compute / API / frequency** — what moves which pieces where, and how often.
3. **Scenarios** — how the system gets used end to end.

---

## 0. Mental model

One **authoritative** store, three **derived** read indexes, one **durable**
maintenance engine — all inside a single HorizonDB instance.

```
                ┌──────────────────────────────────────────────┐
                │                  HorizonDB                    │
                │                                              │
   writes ─────▶│  facts (AUTHORITATIVE: value + ACL + scope)  │
                │     │            │            │              │
                │     │ derives    │ derives    │ derives      │
                │     ▼            ▼            ▼              │
                │  search_tsv   embedding     AGE overlay      │
                │  (lexical)    (semantic)    (structure ids)  │
                │     ▲            ▲            ▲              │
   reads  ◀─────│  facts_search_facts()  (fuses all three,     │
                │   then ACL-filters via existing proc logic)  │
                │                                              │
                │  pg_durable worker (duroxide):               │
                │   embed → relate → reconcile → age-out       │
                └──────────────────────────────────────────────┘
```

The existing PilotSwarm `facts` semantics are unchanged. Everything new is an
index or an overlay that can be dropped and rebuilt from `facts` rows.

---

## 1. Data Model — what goes where

### 1.1 Authoritative table: `facts` (enriched, semantics unchanged)

Existing columns (unchanged): `id, scope_key, key, value JSONB, agent_id,
session_id, shared, transient, tags TEXT[], created_at, updated_at`.

New **HorizonDB-only** columns:

| Column | Type | Source | Purpose |
| --- | --- | --- | --- |
| `search_tsv` | `tsvector` | **generated, stored** from `key` + value text | Lexical recall |
| `embedding` | `vector(D)` | HTTP embedding endpoint (async) | Semantic recall |
| `embedded_at` | `timestamptz` | embedding pipeline | Embedding freshness |
| `content_hash` | `text` | generated/trigger from `value` | Detect value change → re-embed |
| `embedding_model` | `text` | embedding pipeline | Which model produced `embedding` |
| `last_embedded_hash` | `text` | embedding pipeline | `content_hash` at last embed (re-embed gate) |

`search_tsv` is `GENERATED ALWAYS AS (...) STORED` — it stays in sync on every
write with zero moving parts. `embedding` is nullable and filled asynchronously
by calling a **configurable HTTP embedding endpoint** (OpenAI/Azure-OpenAI‑
compatible) passed to the provider — this replaces HorizonDB's built‑in
`aiModelManagement`. The `pg_durable` loop calls it in‑DB over HTTP
([sql/006](./sql/006_embeddings_http.sql)); a Node fallback (`embedPending()`)
covers clusters without the `http` extension.

### 1.2 Derived indexes

| Index | On | Kind | Maintained by |
| --- | --- | --- | --- |
| `idx_facts_tsv` | `search_tsv` | GIN | Postgres (automatic) |
| `idx_facts_embedding` | `embedding` | HNSW (vector ANN) | Postgres (automatic on write of embedding) |

### 1.3 AGE graph overlay — **structure only, ids not values**

**Nodes** (each holds the SQL id + cheap metadata, never the JSONB value):

| Label | Key property | Other props |
| --- | --- | --- |
| `Session` | `id` | `agent_id`, `is_system`, `root_id` |
| `Fact` | `scope_key` | `key`, `namespace`, `shared` |
| `Skill` | `scope_key` | `name` *(a Fact in the `skills/` namespace)* |
| `Agent` | `id` | — |
| `Tag` | `name` | — |

**Edges:**

| Edge | From → To | Kind | Built by |
| --- | --- | --- | --- |
| `SPAWNED` | Session → Session | structural (deterministic) | session create |
| `STORED` | Session → Fact | structural | fact write |
| `AUTHORED` | Agent → Fact | structural | fact write |
| `TAGGED` | Fact → Tag | structural | fact write |
| `DERIVED_FROM` | Fact(intake) → Skill | structural | Facts Manager curation |
| `RELATED_TO` | Fact → Fact `{score, model, computed_at}` | **derived (semantic)** | pg_durable pipeline |

### 1.4 The "what goes where" table (the important one)

| Data element | Authoritative home | Also represented in | Never in |
| --- | --- | --- | --- |
| Fact value (JSONB) | `facts.value` | — | graph, vector, tsvector |
| ACL / scope / shared | `facts` cols + procs | — | graph (enforced only in procs) |
| Lexical text | `facts.search_tsv` (derived) | GIN index | — |
| Embedding | `facts.embedding` (derived) | HNSW index | graph (only the *edge* lives there) |
| Lineage / authorship / tags | `facts` rows + CMS | AGE (ids only) | — |
| Semantic relatedness | — | AGE `RELATED_TO` (derived) | facts table |

**Invariant:** to read a value you always end at the `facts` table through a
stored proc that applies ACLs. The graph and vector index only ever produce
**candidate `scope_key`s**; values and visibility are resolved afterward.

---

## 2. Compute / API / Frequency — what moves what, how often

### 2.1 Moving pieces

| # | Piece | Trigger | Frequency | Compute | Sync/Async |
| --- | --- | --- | --- | --- | --- |
| 1 | `search_tsv` | every fact insert/update | per write | trivial (in-Postgres) | **sync**, free |
| 2 | `content_hash` | every fact insert/update | per write | hash of value | **sync**, free |
| 3 | Structural AGE upsert | fact write / session spawn | per write | one `MERGE` | **async** (reconciled) |
| 4 | Embedding generation | rows with `embedding IS NULL` or `content_hash` changed | idle-batched | 1 HTTP embed call/fact (batched) | **async** (pg_durable HTTP → endpoint) |
| 5 | `RELATED_TO` edges | newly/re-embedded fact | per embedded fact | 1 ANN query + k `MERGE` | **async** (pg_durable) |
| 6 | Reconciliation | timer | every N min / idle | diff graph vs table | **async** (pg_durable) |
| 7 | Age-out / prune | timer | cron (e.g. daily) | mark aged skills, prune edges | **async** (pg_durable) |

Key property: the **write path stays cheap and synchronous** (only #1/#2, which
Postgres does for free). Everything expensive (#4–#7) is deferred to the
idle-aware `pg_durable` worker and is crash-safe via duroxide replay.

### 2.2 The pg_durable maintenance loop

```sql
SELECT durable.start(
  durable.loop(
    durable.wait_idle(0.20, 3)
    ~> durable.func('embed_new_facts',      '{"batch": 128}')   -- #4
    ~> durable.func('refresh_related_edges','{"k": 8, "min": 0.75}') -- #5
    ~> durable.func('reconcile_graph',      '{}')               -- #6
  )
);
-- separate daily schedule for age-out (#7)
```

Determinism: `embed_new_facts`, `refresh_related_edges`, etc. are **activities**
(`durable.func`) — they do the IO. The loop/orchestration only schedules them.

### 2.3 API surface — `EnhancedFactStore`

A superset of the current `FactStore`. All existing methods pass through
unchanged; the new capability is **one unified read** plus two graph reads.

```ts
interface EnhancedFactStore extends FactStore {
  // Unified retrieval. mode picks which signals to use; hybrid fuses all three.
  searchFacts(
    query: string,
    opts: SearchOpts,        // mode, scope, limit, weights, tags, namespace
    access: AccessContext,   // readerSessionId, grantedSessionIds, unrestricted
  ): Promise<SearchResult>;

  // Semantic neighbours of a known fact (RELATED_TO traversal, ACL-filtered).
  relatedFacts(scopeKey: string, opts: RelatedOpts, access: AccessContext): Promise<SearchResult>;

  // Lineage-scoped retrieval: traverse the spawn tree in AGE, optionally rank by
  // lexical/semantic relevance, then ACL-filter. Replaces recursive-CTE lineage.
  lineageFacts(sessionId: string, opts: LineageOpts, access: AccessContext): Promise<SearchResult>;
}
```

`SearchOpts.mode`: `"lexical" | "semantic" | "graph" | "hybrid"`.
`SearchOpts.weights`: relative weights for fusion (lexical / semantic / graph).

### 2.4 Read-path data flow (every search)

```
search_facts(query, mode=hybrid, access)
  1. lexical:  search_tsv @@ websearch_to_tsquery(query)        → (scope_key, ts_rank)
  2. semantic: embedding <=> embed(query)  [ANN top-N]          → (scope_key, cos_sim)
  3. graph:    AGE proximity from caller's lineage/related      → (scope_key, graph_score)
  4. fuse:     weighted rank fusion over the union of candidates → ranked scope_keys
  5. resolve:  facts_read_facts(scope_keys, access)  ← ACL + scope + spawn-tree
  6. return:   only rows the caller may see, in fused order
```

Steps 1–4 produce candidates; step 5 is the **same governance proc** as today.
Search can only ever return a subset of what `read_facts` would already allow.

---

## 3. Scenarios

### S1 — Semantic recall (the headline use case)
Agent asks: *"how did we fix the hydration blob-missing issue?"*
`searchFacts(query, mode=hybrid)` → embeds the query, ANN-matches the curated
`skills/` fact about hydration even though the agent never typed "blob",
fuses with lexical hits, ACL-filters, returns the skill. Today's `LIKE` can't
find this at all.

### S2 — Lexical upgrade over `LIKE` (drop-in win)
Agent calls the equivalent of `read_facts(key_pattern: 'skills/%')` but as
`searchFacts("hydrate session worker", mode=lexical)`. Stemming makes
"hydrate" match "hydration"; `ts_rank` orders by relevance not recency; no
`%`/`_` wildcard-injection risk. Same ACLs.

### S3 — Lineage-scoped recall
A child session asks *"what did my spawn tree already learn about model X?"*
`lineageFacts(sessionId, { query: "model X timeouts" })` traverses `SPAWNED`
edges in AGE to get the tree, ranks members semantically, then ACL-filters.
Replaces the recursive-CTE `getLineageSessionIds` + separate value query.

### S4 — Facts Manager dedup before curation
Before promoting an `intake/` observation to a curated `skills/` fact, the
Facts Manager calls `relatedFacts(intakeKey, { minScore: 0.85 })` to find
near-duplicate intake/skills via `RELATED_TO`. It merges instead of creating a
near-identical skill — keeping the curated set clean.

### S5 — Skill provenance
*"Which observations produced this skill?"* Traverse `DERIVED_FROM` backwards
from a `Skill` node to its source `intake/` facts — useful for the agent-tuner
auditing whether a learned skill is well-supported.

### S6 — Cold-start backfill
On first enablement, historical facts have `embedding IS NULL`. The
`embed_new_facts` pipeline drains the backlog during idle windows; lexical
search (S2) works immediately while semantic recall warms up. Fully
crash-safe — a worker restart resumes mid-backlog via replay.

### S7 — Drift heal & age-out
`reconcile_graph` periodically repairs any structural edge the async write path
missed (so a flaky AGE call can never corrupt the authoritative table), and the
daily age-out marks stale skills and prunes their `RELATED_TO` edges.

---

## 4. Phased incubation plan

| Phase | Ships | Depends on | Risk |
| --- | --- | --- | --- |
| P1 | `search_tsv` + GIN + `facts_search_facts` (lexical only) | pg_textsearch | low |
| P2 | `embedding` + HNSW + `embed_new_facts` pipeline + semantic mode | AI pipelines, pg_durable | med |
| P3 | AGE overlay + structural backfill + `lineageFacts` | AGE | med |
| P4 | `RELATED_TO` + `relatedFacts` + dedup + hybrid fusion | all four | higher |

Each phase is independently demoable in `poc/` and testable. Integration into
PilotSwarm is a **separate, later** decision gated on P1–P4 validation.

## 5. Open questions (to resolve during incubation)

- Embedding dimension/model and cost per fact at PilotSwarm volumes.
- AGE + HNSW performance characteristics on preview HorizonDB at scale.
- Whether structural graph upserts should be in-proc (sync, always consistent)
  or pipeline-fed (async, self-healing) — current lean: **pipeline-fed +
  reconcile**, so a graph hiccup can never fail a fact write.
- Fusion algorithm: weighted normalized scores vs reciprocal rank fusion (RRF).
  The DB-less core in `src/query-builder.ts` lets us A/B both offline.
