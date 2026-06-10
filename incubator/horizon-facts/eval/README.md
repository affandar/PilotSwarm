# Scenario tier — Copilot SDK agents on the real provider surface

The [06-provider-test-plan §10](../../../docs/proposals/enhancedfactstore/06-provider-test-plan.md)
scenario tier: **GitHub Copilot SDK** agents (no PilotSwarm) drive the
provider's own LLM tool surface ([src/agent-tools.ts](../src/agent-tools.ts),
per [05-tools-spec](../../../docs/proposals/enhancedfactstore/05-tools-spec.md))
against live HorizonDB. There is **no adapter**: the tools the model sees ARE
the provider's descriptors, bridged 1:1 into the SDK (`eval/tools.mjs`), with
one eval-side policy on top — the harvester role REQUIRES evidence on graph
writes (the 05 golden-rule norm, enforced so the model self-corrects in-loop).

```
corpus (emails) ──seed──▶ HorizonDB facts ◀── facts_read_uncrawled / facts_mark_crawled
                                   │
   Copilot SDK agent ── tools ─────┤  graph_search_nodes / graph_upsert_node / graph_upsert_edge
   (harvester / reader prompts)    ▼
                            HorizonDB AGE graph ──assert──▶ structural invariants
```

## Files

| File | Role |
|------|------|
| `scenarios.mjs` | The scenario runner (SC1a, and the real-corpus chain SC1b→SC5→SC2→SC3→SC4). |
| `tools.mjs` | Copilot-SDK bridge over `createFactsTools` (+ recording for SC2 replay) and the harvester/reader prompts. |
| `corpus/pgsql-hackers.json` | **Synthetic** 3-message corpus with hand-planted invariants (the `tgl` alias, the 1001/1002 restatement). |
| `corpus/pgsql-hackers-real.json` | **Real** archive data: 60 messages from the actual "[PATCH] Generic type subscripting" thread; `metadata` drives the derived invariants. |
| `corpus/build-pgsql-hackers-real.mjs` | Regenerates the real corpus from the public postgresql.org archives (`--max`, ~276 messages available). |

## Run

```bash
cd incubator/horizon-facts
npm run build
npm run eval:harvester               # SC1a only (synthetic, ~1 min)
npm run eval:scenarios               # everything (SC1a + real-corpus chain, ~15 min)
npm run eval:scenarios -- real       # real-corpus chain only
```

Gates (SKIPs exit 0 when missing): `HORIZON_DATABASE_URL` and a GitHub token
(`GITHUB_TOKEN` env → repo root `.env` → `gh auth token`). Optional:
`HORIZON_EMBED_*` (real endpoint → SC4 runs hybrid; else lexical),
`EVAL_MODEL` (default `claude-haiku-4.5`), `EVAL_LIMIT` (cap the real corpus
for cheap dev runs — invariants re-derive from the seeded subset, so a capped
run stays honest), `EVAL_ROUND_TIMEOUT_MS` (activity watchdog — a round fails
only on agent SILENCE, long productive turns are fine), `EVAL_MAX_ROUNDS`.

Each run uses per-run schemas/graphs (`hzev_*`), dropped at the end.

## Scenarios & invariants

LLM output is non-deterministic, so assertions are **structural invariants**;
SC2 gets byte-identical determinism from **recorded replay** of SC1b's actual
mutating tool calls.

- **SC1a — cold harvest, synthetic (exact, hand-authored):** one Tom Lane node
  with `tgl` as an alias (never two person nodes); Andres Freund distinct;
  Tom connected within 2 hops; the 1001/1002 restatement is ONE edge with
  `observations == 2` and evidence from both messages; every edge evidenced;
  queue drained with hash receipts.
- **SC1b — cold harvest, real corpus (derived from `corpus.metadata`):** every
  multi-message author resolves to exactly one person node and reaches a
  non-person node ≤2 hops; ≥1 edge reinforced from ≥2 distinct messages;
  every edge evidenced; queue drained; **receipts honest** — every fact ends
  marked; a skipped stamp mid-run is the receipt guard working (bad/stale
  hash rejected) and must be retried, which a drained queue proves.
- **SC5 — scoped publication:** a session-private draft seeded alongside the
  corpus IS harvested into the shared graph (content published — by design);
  other sessions see the node content but NOT the private evidence pointer;
  the owner sees it; seeding with the private scopeKey from another session
  behaves exactly like an unknown seed.
- **SC2 — replay immunity:** snapshot graph → re-queue everything → re-issue
  the recorded mutating calls verbatim → graph **byte-identical** and the
  replayed receipts resolve exactly as the original run did.
- **SC3 — edit → re-queue → incremental:** editing one message re-queues only
  it; the incremental harvest drains it without duplicating triples or
  touching other facts' crawl stamps.
- **SC4 — reader fact-pivot:** a reader-role agent answers "who authored the
  patch / who pushed back" via `facts_search → graph_search_nodes(seeds) →
  facts_read(evidence)`; the answer names the earliest-message author + ≥1
  other multi-message participant, citing only corpus scopeKeys.

Exit code is `0` only if every invariant passes.

## What the eval caught while being built (why it exists)

- A model under volume pressure will **mark facts crawled without extracting**
  (queue drains, graph stays empty) — countered by small batches, per-email
  processing, and the minimum-extraction + never-mark-before-incorporate rules
  in the harvester prompt.
- **Evidence-less asserts break replay determinism** (GR8: they always
  reinforce) — countered by the harvester-policy evidence requirement.
- Two real provider bugs: AGE `MERGE` racing **duplicate :Fact anchors** under
  parallel tool calls (fixed: duplicate-anchor-proof linking + assembly dedup)
  and **merge repoint double-counting on replay** (fixed: evidence-aware
  combine, the GR7 principle extended to merges).
