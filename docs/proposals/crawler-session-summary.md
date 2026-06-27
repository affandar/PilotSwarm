# Proposal: Sticky Crawler Session Summary

- **Status:** Draft
- **Date:** 2026-06-26
- **Scope:** `generic-crawler` bundled agent (and any app `crawler: true` agent)
- **Surface:** `update_session_summary` tool → `sessions.summary_state` / `short_summary`

## Problem

The crawler runs a long, multi-stage lifecycle (scope → design → pilot → full
crawl → incremental refresh) and a single session can stay alive for hours or
days while a cron child keeps the corpus fresh. An operator glancing at the
session today sees a free-form `summary` string that drifts in shape every turn:
sometimes a sentence, sometimes a bullet list, sometimes nothing. There is no
stable, at-a-glance "where is this crawl right now" view.

We want the crawler to publish a **fixed-format table** in its session summary
that is **super sticky** — the same rows, in the same order, every single update.
Only the values change; the structure never drifts. An operator should be able to
read the same eleven lines at minute 1 and at day 3 and always know exactly where
to look.

## Background: what the runtime already gives us

Session summaries are agent-maintained via the existing tool:

```
update_session_summary({ summary_state, short_summary? })
```

It writes `sessions.summary_state` (JSONB), `sessions.short_summary`, and
`sessions.summary_updated_at`. The validated shape (`SessionSummaryState`,
`schemaVersion: 1`) is:

| Field | Type | Role |
|-------|------|------|
| `intent` *(required)* | string | What the session is trying to accomplish |
| `summary` *(required)* | string | Latest state — **Markdown allowed, including tables** |
| `state` | object | `{ cmsState, runtimeMode?, waitReason?, blocked?, terminal? }` |
| `openQuestions` | `[{ question, askedAt?, blocking? }]` | Outstanding decisions |
| `blockers` | `string[]` | What's stopping progress |
| `nextActions` | `string[]` | Planned next steps |
| `domain` | object | **App-specific stable shape (free-form JSON)** |
| `links` | `[{ title, url }]` | Key hyperlinks |
| `structureChangeLog` | `[{ changedAt, reason, before, after }]` | Records format changes |

The original summary-state design (`docs/proposals/base-infra-improvements-may-26.md`)
made a deliberate call:

> Agents should be encouraged to use compact Markdown tables inside `summary` …
> but the base runtime should **not** impose a table schema on applications.
> Applications can fill in `domain` with their own stable shape.

So this proposal is exactly the intended extension point: the crawler defines its
own stable table (rendered in `summary`) backed by a stable, versioned `domain`
shape. No base-runtime change is required.

## Proposal

### 1. The canonical crawler dashboard (goes in `summary`)

Every `update_session_summary` call from a crawler renders this **exact** table —
the same twelve rows, the same order, every time. Unknown values render as `—`,
never omitted, so the shape is constant from the first turn:

```markdown
| Crawl | |
|---|---|
| **Stage** | 9/10 · Run the full crawl |
| **Source** | Hacker News API · topic search |
| **Answers** | trending cloud-PG topics; who the active voices are |
| **Corpus** | `corpus/hackernews/` |
| **Graph** | `pilot/hackernews-cloud-pg` · technical-opinion lens |
| **Models** | ingest `gpt-5.4-mini` · graph `claude-sonnet-4.6` |
| **Facts** | raw 11,126 · crawled 11,126 · backlog 0 |
| **Graph** | 7,511 nodes · 11,279 edges |
| **Last crawl** | 2026-06-26 18:46Z (+42 facts) |
| **Refresh** | cron 10m · next 18:50Z |
| **Pilot** | validated · 3 sample queries |
| **Health** | ok |
```

Fixed row contract (never reordered, never dropped):

1. **Stage** — `<n>/10 · <stage name>` from the lifecycle
2. **Source** — source + mining method (API / files / storage / web)
3. **Answers** — the 1–3 questions the corpus exists to answer
4. **Corpus** — raw fact key prefix
5. **Graph** — graph namespace + schema lens (e.g. social vs technical)
6. **Models** — ingest model · graph-extraction model
7. **Facts** — `raw N · crawled N · backlog N`
8. **Graph** — `N nodes · N edges`
9. **Last crawl** — timestamp + delta since previous cycle
10. **Refresh** — cron schedule + next wake, or `none`
11. **Pilot** — `pending` / `validated · k sample queries` / `n/a`
12. **Health** — `ok` or `blocked: <reason>`

`short_summary` (the one-liner for session lists) is derived from the same data:
`Stage 9/10 · 11,126 facts · 7,511 nodes · cron 10m`.

### 2. The machine-readable mirror (goes in `domain.crawler`)

The table is for humans; `domain.crawler` is the stable, versioned source of truth
so the values can be diffed across turns and a structured UI pane can render it
later without parsing Markdown. Same keys every update:

```jsonc
"domain": {
  "crawler": {
    "schemaVersion": 1,
    "stage": { "n": 9, "of": 10, "name": "Run the full crawl" },
    "source": { "label": "Hacker News API", "method": "api" },
    "answers": ["trending cloud-PG topics", "who the active voices are"],
    "corpusPrefix": "corpus/hackernews/",
    "graphNamespace": "pilot/hackernews-cloud-pg",
    "lens": "technical-opinion",
    "models": { "ingest": "gpt-5.4-mini", "graph": "claude-sonnet-4.6" },
    "facts": { "raw": 11126, "crawled": 11126, "backlog": 0 },
    "graph": { "nodes": 7511, "edges": 11279 },
    "lastCrawl": { "at": "2026-06-26T18:46:54Z", "deltaFacts": 42 },
    "refresh": { "mode": "cron", "everySeconds": 600, "nextAt": "2026-06-26T18:50:00Z" },
    "pilot": { "status": "validated", "sampleQueries": 3 },
    "health": { "ok": true, "blocker": null }
  }
}
```

The Markdown table in `summary` MUST be a faithful render of `domain.crawler`.
If the two ever disagree, `domain.crawler` wins.

### 3. Stickiness rules (the core requirement)

1. **Full idempotent rewrite.** Every update replaces the whole table and the
   whole `domain.crawler` object. The crawler never patches one row — that is how
   partial drift creeps in.
2. **Complete row set, always.** All twelve rows render every time. Not-yet-known
   values are `—`; counts that are genuinely zero are `0`. Never omit a row.
3. **Fixed order, fixed labels.** Rows never reorder and labels never change
   within a session.
4. **Versioned schema.** The shape is pinned by `domain.crawler.schemaVersion`.
   The crawler may only emit a shape it declares.
5. **Change = logged.** If the contract ever changes mid-session (a new metric row
   is genuinely needed), the crawler bumps `schemaVersion` **and** appends a
   `structureChangeLog` entry (`reason`, `before`, `after`). This is the single
   sanctioned escape hatch; routine updates never touch it.

### 4. Lifecycle → which fields go live when

The table exists from turn one; fields fill in as the lifecycle advances. Nothing
ever disappears once set.

| Lifecycle stage | Fields that become populated |
|-----------------|------------------------------|
| 1 Scope source | Source, Health (blocker if access fails) |
| 2 Questions | Answers |
| 3 Domain & propose | Graph lens (proposed) |
| 4 Schema design | Corpus, Graph namespace |
| 5 Schema tuning | Lens (finalized) |
| 6 Models | Models |
| 7 Present plan | Stage advances; nextActions = the plan |
| 8 Pilot | Pilot status, first Facts/Graph counts, sample queries in `links` |
| 9 Full crawl | Facts, Graph, Last crawl, Backlog refreshed each batch |
| 10 Keep fresh | Refresh (cron schedule + next wake); each wake updates Last crawl + deltas |

Mapping to the base summary fields:

- `intent` — one stable line: *"Crawl `<source>` into `<corpus>` + graph
  `<namespace>` to answer: `<questions>`."*
- `nextActions` — the next lifecycle step(s).
- `blockers` — e.g. `"reddit.com returns 403; need OAuth app credentials"`.
- `openQuestions` — e.g. `"Cap of 500 — total, or per topic?"` (`blocking: true`
  while it gates the crawl).
- `links` — graph namespace, and the starter queries handed to the user at pilot.
- `state` — base CMS/runtime fields, unchanged.

### 5. When to update

To stay useful without spamming CMS writes, the crawler updates the summary:

- once on first run (write the skeleton with `—` placeholders),
- at each lifecycle stage transition,
- at the end of each ingest/graph batch during the full crawl (counts move),
- on every cron wake (Last crawl + deltas + next wake),
- whenever Health flips (a blocker appears or clears).

It does **not** rewrite the summary on every tool call within a batch.

## Implementation sketch

This is agent-prompt + light tooling; no orchestration or schema change.

1. **Agent prompt.** Add a "Session summary" section to
   `packages/sdk/plugins/default-agents/agents/generic-crawler.agent.md` (bump
   `version`) specifying the canonical table, the `domain.crawler` shape, the
   stickiness rules, and the update cadence above. Each lifecycle stage gains a
   one-line "update the summary" reminder.
2. **(Optional) UI renderer.** A `domain.crawler` selector in
   `packages/ui-core/src/selectors.js` could render the dashboard as a native
   pane in the TUI/portal summary view instead of relying on the Markdown render.
   Out of scope for v1; the Markdown table already renders today.
3. **Test guard.** A deterministic prompt test (mirroring
   `Generic Crawler Lifecycle Prompt`) asserts the summary contract — all twelve
   row labels and the `domain.crawler` keys — so the format can't silently drift.
   Optionally, an e2e assertion that a crawler turn produces a `summary_state`
   whose `domain.crawler.schemaVersion === 1` and whose `summary` contains every
   row label.

## Worked example (first run, blocked)

Before any source is reachable, the table is already fully shaped:

```markdown
| Crawl | |
|---|---|
| **Stage** | 1/10 · Scope the source and mining strategy |
| **Source** | reddit.com · web (unauthenticated) |
| **Answers** | — |
| **Corpus** | — |
| **Graph** | — |
| **Models** | — |
| **Facts** | raw 0 · crawled 0 · backlog 0 |
| **Graph** | 0 nodes · 0 edges |
| **Last crawl** | — |
| **Refresh** | none |
| **Pilot** | pending |
| **Health** | blocked: reddit 403, need OAuth creds |
```

Same twelve rows as the day-3 example above — only the values differ. That is the
stickiness guarantee.

## Non-goals

- No base-runtime table schema. The base stays format-agnostic; this contract is
  the crawler app's stable shape, exactly as the original design intended.
- No change to `update_session_summary`, CMS columns, or orchestration.
- Not a replacement for the crawl's end-of-run textual summary; the dashboard is
  the *live* state, the closing summary is the *narrative*.

## Open questions

1. **Render path:** ship v1 as Markdown-in-`summary` only, or also add the
   `domain.crawler` UI selector now so the dashboard is a first-class pane?
2. **Per-topic breakdown:** keep Facts/Graph as single totals (sticky, simple), or
   allow an optional fixed sub-table per configured topic? Sub-tables risk drift;
   leaning totals-only for v1.
3. **Generalization:** should the same `domain.<agent>` sticky-table pattern be
   documented for other long-lived agents (monitors, harvesters), or stay
   crawler-specific until a second consumer appears?
