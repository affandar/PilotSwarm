# Gap analysis — incubator code vs. EnhancedFactStore specs (01–06)

> Status: **CLOSED** — all gaps below were fixed in the spec-conformance
> rebuild and verified against the live HorizonDB: 116/117 integration+unit
> tests pass, 0 fail; the 1 skip is preconditions P1–P4, which by design need
> a real vanilla Postgres (`PLAIN_DATABASE_URL`) and run once CI provides one.
> BM25 verified live (pg_textsearch 1.3.0-dev: `bm25` AM, `<@>` = negative
> score); the eternal batch embedder loop (incl. `$batch.body` whole-body
> substitution and select-time-hash write-back) verified live; restart-on-
> configure verified live. Spec refs:
> [01](../../docs/proposals/enhancedfactstore/01-functional-spec.md) ·
> [02](../../docs/proposals/enhancedfactstore/02-api-reference.md) ·
> [03](../../docs/proposals/enhancedfactstore/03-design.md) ·
> [04](../../docs/proposals/enhancedfactstore/04-test-spec.md) ·
> [05](../../docs/proposals/enhancedfactstore/05-tools-spec.md) ·
> [06](../../docs/proposals/enhancedfactstore/06-provider-test-plan.md)

The incubator predates the proposal review; it implements the *old* API
(`relatedFacts`/`lineageFacts`/`linkEvidence`, `Entity` labels, marker-fact
crawl tracking, SQL-in-TS setup). The specs supersede it. Gaps, by area:

## A. API surface (types.ts vs 02)

| # | Gap | Spec requirement | Fix |
|---|-----|------------------|-----|
| A1 | `SearchMode` includes `"graph"`; `SearchWeights.graph` | facts-store-only: `lexical\|semantic\|hybrid` | remove graph mode/weight |
| A2 | `relatedFacts` / `lineageFacts` / `LineageOpts` / `RelatedOpts` exist | removed — compose via graph seeds / base `readFacts(descendants)` | delete; add `similarFacts(scopeKey, SimilarOpts, access)` |
| A3 | `FactRecord` lacks `scopeKey`; `ReadFactsQuery` lacks `scopeKeys` | 02 §1c base-API prerequisite | add both |
| A4 | `GraphCrawlerInterface` (searchEntities / assertRelationship / linkEvidence / mergeEntities); no deletes | 02 §5 `GraphInterface`: `searchGraphNodes(q, access)` (with `seeds[]`+`depth`), `searchGraphEdges(q, access)`, `graphNeighbourhood(k, d, access)`, `upsertGraphNode`, `upsertGraphEdge` (absorbs linkEvidence), `mergeGraphNodes`, `deleteGraphNode`, `deleteGraphEdge` | full rewrite; `Entity`→`GraphNode` label, `entity_key`→`node_key` |
| A5 | no crawl-tracking API | `readUncrawledFacts({namespace,limit})`, `markFactsCrawled(CrawledFactStamp[])` → `{marked, skipped}` | add (privileged, hash receipts) |
| A6 | graph hits don't carry `evidence` | `GraphNodeHit.evidence` / `GraphEdgeHit.evidence`, ACL-filtered | assemble + filter |

## B. Behaviour (horizon-store.ts vs 01/03)

| # | Gap | Spec requirement | Fix |
|---|-----|------------------|-----|
| B1 | inline SQL for every relational/vector access | stored procs only (acceptance #10; 04 M1 grep guard) | move all relational/vector access into procs (migration 0004) |
| B2 | stats computed in Node by pulling all rows | proc-side namespace bucketing | 3 stats procs |
| B3 | evidence **mandatory** on edges (`validateAssertion`) | evidence OPTIONAL | accept evidence-less asserts |
| B4 | every re-assert reinforces (`decideEdgeMerge`) | reinforce only on **novel** evidence (or evidence-less); known-evidence re-assert = no-op | evidence-aware merge decision |
| B5 | no `seeds` pivot; nodes found by name/kind only | `searchGraphNodes({seeds})` pivots fact scopeKeys via `EVIDENCED_BY`, node keys expand directly, `depth` 1..5 | implement seed pivot Cypher |
| B6 | no evidence ACL filter; no seed ACL check | 01 §6.1a/§6.5: evidence arrays filtered to caller ACL (syntactic scope_key check); inaccessible seeds ignored | filter at result assembly |
| B7 | `upsertEntity` ignores evidence (only `linkEvidence` creates anchors) | `upsertGraphNode({evidence})` unions evidence → `:Fact` anchors + `EVIDENCED_BY` | wire into upsert |
| B8 | `mergeEntities` recreates edges blindly (duplicate-triple drift); doesn't repoint `EVIDENCED_BY` | union into existing identical triples; repoint evidence edges | harden merge |
| B9 | `similarFacts` anchor not ACL-checked (`relatedFacts` reads any anchor) | inaccessible anchor ≡ unknown → empty (no similarity oracle) | ACL-check anchor in proc |
| B10 | semantic search ignores `embedding_model` | rows with mismatched model are invisible to semantic search and pending for the embedder | add model predicate to procs |
| B11 | `content_hash` = generated column over `value` only | trigger-maintained hash over embeddable content (key+value), resetting `last_crawled_at` on change | BEFORE trigger (generated col can't drive the reset) |
| B12 | no `last_crawled_at` column (eval used `_crawlmark/*` marker facts) | column + trigger reset + receipts | migration 0001 + procs |
| B13 | semantic search with no endpoint returns `[]` | throws (02 §6) | throw |
| B14 | missing `CHECK (NOT (shared AND transient))` (SDK parity) | base schema parity | add |

## C. Embedder (http-embedding.ts vs 01 §5 / 03 §3)

| # | Gap | Spec requirement | Fix |
|---|-----|------------------|-----|
| C1 | **df-in-df**: loop CALLs a plpgsql proc that does `df.start(df.http)` + `wait_for_completion` per fact | ONE eternal `df.loop`; batch select `\|=> 'batch'`; ONE `df.http` per batch (`{var}` config, `$batch.body`); zip-back with select-time hashes | rewrite as pure df workflow (migration 0005 holds helper SQL only) |
| C2 | config in `embedding_config` table | durable vars (`df.setvar`), captured at `df.start` | per-schema-named vars; vars are the single config source (Node query-time client reads them via `df.getvar`) |
| C3 | `configureEmbedder` assumes running loop picks up changes | vars are immutable per run → **restart-on-configure** (cancel + start, same label) | implement |
| C4 | per-fact HTTP (one request per fact) | batch per tick via array-input API | aggregate body in SQL step |
| C5 | embeds only `embedding IS NULL OR hash distinct` | + `embedding_model IS DISTINCT FROM configured` (model rotation) | extend predicate |

## D. Initialization / migrations (migrations.ts vs 01 §5.5 / 03 §5)

| # | Gap | Spec requirement | Fix |
|---|-----|------------------|-----|
| D1 | SQL-in-TS idempotent setup; standalone psql files in `sql/` | numbered `migrations/000N_*.sql` via a **vendored** `pg-migrator` (merge-back TODO header) | new `migrations/` + `horizon-migrator.ts`; delete `sql/` |
| D2 | no fail-fast: semantic optional, extensions created ad hoc | `initialize()` throws ONE itemized error naming every missing piece (`vector`, `age`, `pg_textsearch`, `pg_durable`+`df.http`+grant) | preconditions check before migrating |
| D3 | lexical = `tsvector`/`ts_rank` | **BM25 via `pg_textsearch`** (no silent fallback) | install + use BM25 scoring in lexical proc (probe live API) |

## E. Tools (agent-tools.ts vs 05)

Old names (`facts_search` w/ graph mode, `facts_related`,
`graph_search_entities`, `graph_assert_relationship`, `graph_link_evidence`)
→ spec names (`facts_search` lex/sem/hybrid, `facts_similar`, `facts_read`,
`facts_read_uncrawled` + `facts_mark_crawled` [harvester-only, privileged],
`graph_search_nodes` [seeds], `graph_search_edges`, `graph_neighbourhood`,
`graph_upsert_node`, `graph_upsert_edge`, `graph_merge_nodes`,
`graph_delete_node`/`_edge`). Reader/harvester role split per 05 intro.

## F. Tests (vs 04 §7 / 06)

Existing 3 suites test the old API. Replace with the 04 §7 layout
(suite-per-file, runId schema+graph, sequential), covering the new matrices
(B/C/L/S/SF/H/A/GE/GR/GQ/GM/GD/LN/E/P/M). Embedder outcome suites use the
real endpoint from `.env` (no stubs, per 06 §0 — the in-process embedding stub
in `_db.mjs` is retired for provider tests; seeded dim-4 vectors carry the
deterministic ranking assertions).

## Out of scope (this pass)

- **Phase 2** (`searchGraphContext` / `similarGraphContext`, `facts_context_*`
  tools) — spec-gated behind a harvested graph; ship Phase 1 first.
- **PilotSwarm core changes** (02 §1a–1c: `enhancedFactsDatabaseUrl`,
  provider injection, `ReadFactsQuery.scopeKeys` in `packages/sdk`, the
  `ps_duroxide` rename) — adjacent prerequisites, separate change. The
  incubator implements `scopeKeys`/`scopeKey` locally (its types mirror, not
  import, the SDK's).
- **Eval upgrade** (06 scenario tier on the real corpus) — follows once the
  provider lands; `store-adapter.mjs` collapses to pass-throughs.
