# Open Graph Crawler — LLM-built relationships, no fixed ontology

> Incubation spec, extends [SPEC.md](./SPEC.md). HorizonDB-only. Not integrated
> with PilotSwarm yet.

The base design ([SPEC.md](./SPEC.md)) gives the AGE overlay a **fixed**
structural schema (`SPAWNED`, `STORED`, …) plus one derived semantic edge
(`RELATED_TO`). This document adds an **open** layer: a harvesting agent (LLM)
discovers entities and asserts arbitrary relationships between facts and nodes,
with **no predefined ontology**, while keeping the graph trustworthy and
queryable.

## 1. The problem

Worked example (used throughout): **harvest the PostgreSQL mailing list.**

> A committer comments on a patch. That patch touches code files. The discussion
> revives a topic argued about months ago in a different thread, by different
> people, touching overlapping files.

The interesting knowledge is the *web of associations*: person ↔ patch ↔ files
↔ topic ↔ prior-thread. None of these relationships fit a fixed schema we could
enumerate up front — "revives an argument from", "reviewed-but-disagreed",
"touches the same subsystem as", "supersedes". We want the crawler to **invent
the predicate** when it sees the relationship, not pick from a dropdown.

## 2. Design principles (carried + new)

Carried from the base design:
- **`facts` table stays authoritative.** Harvested raw content (mailing-list
  messages, patch metadata) lands as facts. Entities/edges are an overlay.
- **Determinism boundary.** The crawler is a PilotSwarm *agent session*; its LLM
  calls and graph writes are activities, never orchestration-inline.

New principles for the open layer:
- **No fixed ontology, but mandatory provenance.** Edge *labels* are free text;
  edge *metadata* is strict. Every assertion records who/why/confidence/evidence.
- **Search before you create.** The crawler must query existing entities/edges
  first and reuse them — entity resolution is the crawler's primary job, not an
  afterthought. The interface makes search the path of least resistance.
- **Assertions reinforce, not duplicate.** Re-observing the same relationship
  bumps confidence + observation count instead of creating a parallel edge.
- **The graph is evidence-linked.** Every entity and edge points back to the
  `Fact` rows that justify it, so any assertion is auditable and rebuildable.

## 3. Open data model

Two generic node/edge types layered *next to* the fixed structural ones.

### 3.1 `Entity` node (open `kind`, no fixed set)

| Property | Meaning |
| --- | --- |
| `entity_key` | canonical dedup key: `<kind>:<normalized-name>` (see §5.1) |
| `kind` | free text — `person`, `patch`, `code_file`, `thread`, `topic`, … |
| `name` | display surface form (first-seen or canonical) |
| `aliases` | array of observed surface forms (`["Tom Lane", "tgl"]`) |
| `created_by` | harvesting agent id |
| `created_at` / `updated_at` | timestamps |

Entities are **not** facts — they're lightweight nodes. Their supporting
evidence lives in `Fact` rows linked via `EVIDENCED_BY`.

### 3.2 `REL` edge (open `predicate`, strict metadata)

A single AGE edge label `REL` carries a free-text `predicate`, so AGE stays
happy with a known label while semantics stay open.

| Property | Meaning |
| --- | --- |
| `predicate` | free-text relationship, verbatim (`"revives argument from"`) |
| `predicate_key` | normalized grouping key (see §5.2) |
| `confidence` | 0..1, combined across observations (noisy-OR, §5.3) |
| `observations` | how many times asserted independently |
| `asserted_by` | agent id(s) |
| `evidence` | array of `Fact.scope_key` justifying the edge |
| `model` | LLM model that asserted it |
| `first_seen` / `last_seen` | timestamps |

### 3.3 `EVIDENCED_BY` edge — Entity/REL → Fact

Links any node or assertion back to the authoritative facts that justify it.
This is what makes the open graph auditable and rebuildable.

```
(Entity)-[:EVIDENCED_BY]->(Fact)
```

> Governance note: `EVIDENCED_BY` points at `Fact` nodes by `scope_key` only.
> Reading the underlying value still goes through the ACL-bearing facts proc, so
> the open graph never leaks fact contents past their scope. For a public corpus
> like the PG mailing list, those facts are `shared`, but the invariant holds
> for mixed/private corpora too.

## 4. The harvesting interface

The crawler does not get raw graph write access. It gets a **small, opinionated
tool surface** that makes "search → resolve → assert" the natural flow and bakes
in dedup/provenance.

```ts
interface GraphCrawlerInterface {
  // ── SEARCH (reuse existing knowledge first) ──────────────────────────────
  searchFacts(query, opts, access): Promise<SearchResult>;        // from base SPEC
  searchEntities(q: EntityQuery): Promise<EntityHit[]>;           // by kind/name/alias/neighbourhood
  searchRelationships(q: RelQuery): Promise<RelHit[]>;            // by predicate/endpoint/evidence
  neighbourhood(entityKey, depth, opts): Promise<SubGraph>;       // local graph around a node

  // ── ASSERT (create/reinforce, always with provenance) ────────────────────
  upsertEntity(e: EntityAssertion): Promise<EntityRef>;          // dedups via entity_key + alias merge
  assertRelationship(r: RelAssertion): Promise<RelRef>;          // reinforces matching edge, else creates
  linkEvidence(nodeRef, factScopeKeys): Promise<void>;           // EVIDENCED_BY edges
  mergeEntities(fromKey, intoKey, reason): Promise<void>;        // entity resolution (alias collapse)
}
```

Every `assertRelationship` **requires** `evidence` (≥1 fact scope_key),
`confidence`, and the asserting `agentId`/`model`. The interface rejects an
assertion with no evidence — that is the structural guard against hallucinated
edges.

## 5. Quality mechanics (the DB-less, unit-tested core)

Because the graph is LLM-built and ontology-free, three pure functions keep it
from degenerating into noise. They live in `src/graph-model.ts` and are tested
without a database.

### 5.1 Entity canonicalization → `entity_key`
Surface-form dedup only (case, whitespace, punctuation, diacritics). Semantic
identity (`"Tom Lane"` ≡ `"tgl"`) is **not** string-solvable — that's resolved
by the crawler via `searchEntities` + `mergeEntities`, which records an alias.

### 5.2 Predicate normalization → `predicate_key`
Free text stays verbatim in `predicate`; `predicate_key` is a normalized slug
(lowercased, stemmed-ish, snake) so `"revives argument from"` and
`"revives the argument from"` group together for querying and analytics —
**without** forcing a closed vocabulary.

### 5.3 Confidence reinforcement (noisy-OR)
Independent re-observation should *increase* confidence, not overwrite it:

$$c_{new} = 1 - (1 - c_{old})(1 - c_{obs})$$

with `observations += 1` and `last_seen = now()`. Two 0.6 observations →
0.84, three → 0.936. Monotonic, saturating, order-independent.

## 6. Harvest loop (the PG mailing-list scenario, end to end)

The crawler is a PilotSwarm agent session running this loop per harvested item:

```
for each new mailing-list message / patch:
  1. INGEST   store raw content as shared Fact(s)            → facts table
  2. EMBED    (pipeline) backfills embeddings                 → semantic recall
  3. RECALL   searchFacts(semantic+lexical) + searchEntities  → find prior threads,
              known committers, code files, topics already in the graph
  4. RESOLVE  for each mentioned actor/file/patch:
                searchEntities → reuse, or upsertEntity (alias-merge surface forms)
  5. ASSERT   for each relationship the LLM perceives:
                assertRelationship({
                  from, to, predicate: <free text>,        // invented, not from a list
                  confidence, evidence: [factKeys], agentId, model
                })  → reinforces if it already exists
  6. LINK     linkEvidence(node/edge, evidenceFactKeys)      → EVIDENCED_BY
```

Concretely, one message might yield:

```
(person:tom-lane)        -[REL "comments on" conf .95]->     (patch:v3-fix-jsonb-subscript)
(patch:v3-fix-...)       -[REL "touches" conf .9]->          (code_file:src/backend/utils/adt/jsonbsubs.c)
(patch:v3-fix-...)       -[REL "revives argument from" .7]-> (thread:2025-jsonb-subscript-semantics)
(person:tom-lane)        -[REL "previously disagreed with" .6]-> (person:another-committer)
each edge -[EVIDENCED_BY]-> (Fact: the archived message)
```

No schema migration was needed to express "revives argument from" or
"previously disagreed with" — the crawler minted those predicates on the spot.

## 7. Querying the result — two modes only

The graph is queried in exactly two ways. There is **no semantic/fuzzy predicate
matching** — an agent cannot ask "find a predicate that means X". It either
discovers predicates by exploring, or it already knows the predicate name.

### Mode 1 — anchor-and-explore (discover predicates)
The agent finds a starting node by other means (fact search → entity), then reads
its edges and **sees which predicates actually exist**. Predicates are returned
as data; the agent reasons over them and follows the interesting ones.

```
searchFacts("jsonb subscripting debate")  → fact → entity:thread
  → neighbourhood(thread, depth=2)
  → edges back: ["revives argument from", "comments on", "touches", …]
  → follow "revives argument from" edges to find who keeps reopening it
```

Use `neighbourhood(entityKey, depth)`, or `searchRelationships({ fromKey })` /
`{ toKey }` to read edges around a known node.

### Mode 2 — exact-predicate (agent-owned ontology)
When a calling agent maintains its **own** agreed-upon vocabulary in its layer
(not in this graph), it queries the exact edge type. Match is exact equality on
`predicate` or, preferably, the surface-stable `predicateKey`.

```
searchRelationships({ predicateKey: "touche", toKey: "code_file:…jsonbsubs-c", minConfidence: 0.8 })
  → every patch that "touches" that file
```

The graph stays ontology-free; any shared vocabulary lives in the agent layer.
This system neither defines nor enforces that ontology — it just answers exact
predicate queries when an agent supplies a name it already knows.

### Examples
- *"Who keeps reviving the JSONB debate?"* → Mode 1: anchor on the thread, explore.
- *"Which patches touch this file?"* (agent knows `touches`) → Mode 2: exact query.
- *"Explain this edge."* → follow `EVIDENCED_BY` to the archived messages.

`predicate_key` still normalizes surface variants so exact queries are
surface-stable (`"comments on"` and `"comment on"` share one key), but it is used
for **grouping/equality**, not fuzzy search.

## 8. Guardrails against open-ontology rot

| Risk | Mitigation |
| --- | --- |
| Hallucinated edges | `evidence` is mandatory; no evidence → rejected |
| Predicate sprawl | `predicate_key` grouping collapses surface variants; periodic predicate-count report (pg_durable) for visibility |
| Duplicate entities | search-first interface + `entity_key` dedup + `mergeEntities` alias collapse |
| Low-quality assertions | `confidence` + `observations`; queries can threshold |
| Drift / unauditable claims | every node/edge is `EVIDENCED_BY` real facts; graph is rebuildable |

## 9. What's incubated here vs later

Incubated now (DB-less, testable + SQL + PoC skeleton):
- `graph-model.ts`: canonicalization, predicate normalization, confidence
  reinforcement, edge-merge decision — unit tested.
- `sql/005_open_graph.sql`: `Entity`/`REL`/`EVIDENCED_BY` Cypher + assertion
  helpers with provenance.
- `poc/05-crawler.mjs`: the search→resolve→assert loop driving the PG
  mailing-list example (LLM call + AGE writes stubbed at the boundary).

Later (post-validation): real LLM crawler agent, predicate-cluster analytics,
entity-resolution heuristics beyond surface form, integration into PilotSwarm as
a harvesting agent type.
