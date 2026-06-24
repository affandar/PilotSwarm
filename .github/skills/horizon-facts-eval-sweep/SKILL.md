---
name: horizon-facts-eval-sweep
description: Run and analyze the horizon-facts cross-model evaluation sweep (graph-grounded vs parametric+web closed-QA), sweeping harvester × query × judge models into a 3×3×3 score tensor with an LLM-generated bias-aware report. Use when collecting fresh sweep results, re-running a subset of cells, changing the model set, or interpreting judge bias.
---

# Horizon-Facts Eval Sweep

Use this skill when the user wants to measure whether the harvested knowledge graph
actually improves answer quality — and to do it **across multiple models** so the
result is not an artifact of one model or one biased judge.

The sweep fills a **3×3×3 tensor** over three independent axes:

- **harvester model** — built the knowledge graph from the corpus
- **query model** — answered the questions (both arms: graph vs parametric+web)
- **judge model** — graded the blinded answers against corpus ground truth

Judging is split from answering so the **same answers** are graded by every judge
model — that is how judge bias is measured.

## Canonical Files

- Config: `incubator/horizon-facts/eval/sweep/sweep.config.json`
- Driver: `incubator/horizon-facts/eval/sweep/run-sweep.mjs`
- Report generator (LLM): `incubator/horizon-facts/eval/sweep/generate-report.mjs`
- Per-cell eval primitive: `incubator/horizon-facts/eval/graph-quality.mjs` (modes: `gen` | `answer` | `judge` | `run`)
- Question set (generated once): `incubator/horizon-facts/eval/sweep/questions.json`
- Transcripts (per harvester×query): `incubator/horizon-facts/eval/sweep/transcripts/<H>__<Q>.json`
- Scores (per harvester×query×judge): `incubator/horizon-facts/eval/sweep/scores/<H>__<Q>__<J>.json`
- Numeric summary: `incubator/horizon-facts/eval/sweep/summary.json`
- Generated report: `incubator/horizon-facts/eval/sweep/REPORT.md`
- Per-cell logs (gitignored): `incubator/horizon-facts/eval/sweep/logs/`

## Prerequisites

- `HORIZON_DATABASE_URL` (HorizonDB) and a GitHub token (`GITHUB_TOKEN` env → repo
  `.env` → `gh auth token`).
- **Embeddings** (`HORIZON_EMBED_*`) should be configured before harvesting so each
  graph is built embedded (semantic search + similarity refinement). The driver
  warns if they are absent. Keep `sweep.config.json embedDim` matching the embed dim.
- Build first: `cd incubator/horizon-facts && npm run build`.
- Verify the target models resolve against the Copilot SDK before a long run (a
  trivial `createSession` + "say OK" per model id). `claude-opus-4.8`,
  `claude-sonnet-4.6`, and `gpt-5.5` were verified working on 2026-06-11.

## Cost Model (set expectations first)

The sweep is **LLM-bound and long-running**. Per axis:

- harvests are the most expensive (minutes per fact × corpus size); opus/gpt-5.5
  are slower and pricier than haiku/sonnet
- answer cells = harvesters × queries (e.g. 9), each running both arms over all questions
- judge cells = harvesters × queries × judges (e.g. 27), but cheap (no DB/web)

Bound cost via the corpus size and `questionCount` in the config. Reuse the existing
`pgsql-hackers-recent.json` corpus rather than pulling more unless asked.

## Workflow

1. Read this skill and `eval/sweep/sweep.config.json`. Confirm the model set + corpus + question count with the user if changing them.
2. `node eval/sweep/run-sweep.mjs status` — see what's done/pending (resumable).
3. `node eval/sweep/run-sweep.mjs gen` — build the shared question set once (fixed `genModel`).
4. Harvest each model: `node eval/sweep/run-sweep.mjs harvest <H>` → `hz_sw_<H>` / `hzg_sw_<H>`.
5. Answer each harvester×query cell: `node eval/sweep/run-sweep.mjs answer <H> <Q>` (persists a transcript; no judging).
6. Judge each cell with each judge model: `node eval/sweep/run-sweep.mjs judge <H> <Q> <J>` (DB-free, parallel-safe).
7. `node eval/sweep/run-sweep.mjs report` — compute the deterministic tensor + bias aggregates and have `reportModel` write `REPORT.md`.
8. Or run the whole thing sequentially + resumably: `node eval/sweep/run-sweep.mjs all`.

For a fully parallel run, dispatch **one subagent per answer cell** (each owns a
`<H>×<Q>` transcript); harvests fan out as one subagent per harvester model. Judge
cells are cheap and can be batched. Because every step is file-backed and skips
existing outputs, partial failures resume cleanly.

## Interpreting the Report — Bias Controls

The report and `summary.json` are built to answer "is the graph really better, or is
the judge biased / are answers just longer?":

- **Marginals** by harvester / query / judge — isolate each axis.
- **Judge leniency** — mean graph score each judge awards.
- **Same-family favoritism** — does a judge score answers from its own model family higher? (`sameFamilyQueryGraphMean` vs `diffFamilyQueryGraphMean`).
- **Inter-judge agreement** — score spread across judges on the same answer; unanimous vs split decisions. If conclusions hold across all three judges, judge bias is not driving the result.
- **Verbosity** — Pearson correlation of score vs answer length. A high correlation means length may be buying score.
- **Abstention** — baseline low-score / web-use rates. A graph win driven by baseline punting is real but must be visible.

If the graph wins everywhere, do not celebrate — scrutinize these controls and state
plainly whether any of them inflate the result.

## Constraints

- Do not hand-edit generated artifacts (`REPORT.md`, `summary.json`, `scores/*`, `transcripts/*`). Regenerate via the driver.
- Do not weaken the eval to make the graph win (no custom system prompts to compensate, no retries, no assertion softening). If an arm fails, investigate.
- Keep harvests consistent: same corpus, same embedding config across all harvester models, or the comparison is not apples-to-apples.
- One graph per harvester model (`hz_sw_<H>`). Query/judge runs READ the shared graphs (reads do not mutate) — never re-harvest per query.
- Record findings + the model compatibility result in repo memory after a sweep.
- Clean up sweep schemas when done if the user asks: for each `<H>`, `DROP SCHEMA IF EXISTS "hz_sw_<H>" CASCADE;` + `SELECT drop_graph('hzg_sw_<H>', true);`.
