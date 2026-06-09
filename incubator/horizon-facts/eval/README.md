# Harvester Eval — Copilot SDK + Enhanced Facts + HorizonDB

An end-to-end **eval** that proves the enhanced-facts tool surface
([docs/proposals/enhancedfactstore/05-tools-spec.md](../../../docs/proposals/enhancedfactstore/05-tools-spec.md))
is usable by a real LLM. It builds a **harvester agent with the standard GitHub
Copilot SDK** (no PilotSwarm, no duroxide), hands it the enhanced-facts tools,
seeds a synthetic **pgsql-hackers mailing list** corpus into **HorizonDB**, lets
the agent crawl it into an open knowledge graph, then asserts the graph is
correct.

```
corpus (emails)  ──seed──▶  HorizonDB facts
                                   │
   Copilot SDK agent ── tools ─────┤  facts_read_uncrawled / facts_search
   (harvester prompt)              │  graph_search_nodes / graph_upsert_node
                                   │  graph_upsert_edge / facts_mark_crawled
                                   ▼
                            HorizonDB AGE graph  ──assert──▶ invariants
```

## Files

| File | Role |
|------|------|
| `corpus/pgsql-hackers.json` | Synthetic archived emails (the jsonb-subscript debate). |
| `store-adapter.mjs` | Maps the enhanced-API tool surface onto the incubating `HorizonFactStore`, and models crawl tracking (`last_crawled_at`) with marker facts. |
| `tools.mjs` | The LLM-facing tools (`defineTool`) + the harvester system prompt. |
| `harvester-eval.mjs` | Seeds the corpus, runs the agent, asserts graph invariants. |

## Run it

The eval is **doubly gated** and SKIPS (exit 0) unless both are set:

```bash
cd incubator/horizon-facts
npm install          # pulls @github/copilot-sdk
npm run build        # produces dist/ that the adapter imports

HORIZON_DATABASE_URL='postgres://user:pw@host/db?sslmode=require' \
GITHUB_TOKEN='gho_...' \
npm run eval:harvester
```

Optional env:

| Var | Default | Meaning |
|-----|---------|---------|
| `EVAL_MODEL` | `gpt-4o-mini` | Copilot model name. |
| `EVAL_PROVIDER` | — | Provider id, if your token needs an explicit provider. |
| `EVAL_TIMEOUT_MS` | `240000` | Max wall-clock for the agent harvest. |
| `EVAL_SCHEMA` | `horizon_facts_eval` | Postgres schema for the eval facts. |

Each run uses a unique namespace + AGE graph (`pg_eval_<runId>`) so repeated runs
never pollute each other; the per-run graph is dropped (best-effort) at the end.

## What it asserts

The agent's output is non-deterministic (it's an LLM), so the assertions check
**structural invariants**, not exact predicate strings:

1. **Dedup** — `Tom Lane` resolves to exactly **one** person node; the handle
   `tgl` is an **alias**, not a second person.
2. **Distinct entities** — `Andres Freund` is its own person node.
3. **Connectivity** — Tom Lane links to at least one patch/file/thread.
4. **Reinforcement** — the relationship stated in two messages is **one** edge
   with `observations >= 2` (noisy-OR confidence), not two edges.
5. **Provenance** — every edge carries ≥1 evidence `scope_key`; the reinforced
   edge accumulated evidence from both source messages.
6. **Queue drains** — no fact remains uncrawled after the run.

Exit code is `0` only if all invariants pass.

## Notes / boundaries

- This runs against the **current** `HorizonFactStore` (old method names) via the
  adapter. The tools the LLM sees are the **new** enhanced-API names from the
  tools spec. When the store is renamed to the new API, `store-adapter.mjs`
  collapses to pass-throughs.
- Crawl tracking is modeled here with `_crawlmark/*` marker facts because the
  incubating store predates the `last_crawled_at` column. Production uses the
  real column + reset trigger (see 03-design §2.1).
- `facts_search` runs in **lexical** mode here (the eval store has no embedding
  endpoint configured). Wire an embedding endpoint to exercise semantic/hybrid.
- The deterministic, DB-less version of this harvest flow (same invariants, no
  LLM, no DB) lives at [`poc/05-crawler.mjs`](../poc/05-crawler.mjs).
