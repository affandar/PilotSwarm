# Proposal: Generate Session Transcript

Status: draft for review · Depends on the service-session machinery shipped for
session regeneration (orchestration `1.0.68`, CMS migration 0037).

## TL;DR

Add a **"Generate Transcript"** action that dumps a session's history into
durable artifacts, in one of three modes:

1. **Session summary** — an LLM-written prose summary of the conversation.
2. **Full transcript** — every prompt and response, formatted, in one artifact.
3. **All events** — the full transcript **plus** a second artifact carrying the
   non-prompt activity-stream events (tool calls, turns, lifecycle, …).

It is reachable three ways, mirroring `regenerate`: a **Lifecycle → Generate
Transcript** button in the portal, an agent-callable **`generate_transcript`**
self-tool, and a **`generate_transcript`** MCP tool + management method. The work
runs as a **transcript-generator service session** — the same visible, read-only,
sweeper-reclaimed session class we built for the regen distiller — so it's
observable and reuses proven infrastructure, but it never touches the epoch-flip
machinery.

## Motivation

The event history already exists in CMS (`session_events`), but there's no
first-class way to get a *readable, shareable* copy of a session:

- `get_session_events` (`packages/app/mcp/src/tools/sessions.ts:815`) returns raw
  paged JSON — faithful but not a transcript, and capped/paginated for machines.
- `export_execution_history` (`packages/app/mcp/src/tools/observability.ts:190`)
  exports the **orchestration** history to an artifact — useful for debugging the
  durable execution, not for reading the conversation.
- There is no LLM **summary** path, and nothing an **agent** can call on itself to
  snapshot its own conversation.

Users want "give me this session as a document" (to read, attach, hand off, or
archive); agents want the same as a tool (e.g. to summarize a long sub-task before
reporting up). This proposal fills that gap and deliberately reuses the
service-session model so we don't invent a second execution vehicle.

## Feature spec

### Modes and outputs

All artifacts are written **bound to the target session** (not the generator
session), so they appear in its artifact list and survive the generator's cleanup —
exactly how the distiller writes its dumps (`session-proxy.ts:3915-3941`).

| Mode | Artifact(s) | Format | Needs LLM |
|---|---|---|---|
| `summary` | `transcript-summary-<sid>-<ts>.md` | markdown prose | **yes** |
| `full` | `transcript-<sid>-<ts>.md` | markdown, role-labelled turns | no |
| `all_events` | `transcript-<sid>-<ts>.md` **+** `events-<sid>-<ts>.jsonl` | markdown + ndjson | no |

- **`full`** renders the transcript event set — `user.message` /
  `assistant.message` / `system.message` (the `TRANSCRIPT_TYPES` the archiver
  already uses, `regen-worker.ts:88`) — chronologically, each turn as
  `## <role> · seq <n> · <ts>` followed by its content.
- **`all_events`** additionally emits every *other* event (`tool.execution_*`,
  `assistant.turn_*` / `reasoning` / `usage`, the `session.*` lifecycle family,
  `runtime.*`) as one ndjson line per event `{seq, type, at, data}` — faithful to
  the stream, since `SessionEvent.data` is heterogeneous `unknown` (`cms.ts:21`)
  and shouldn't be flattened to a `content` string. (Open decision: also offer a
  rendered markdown view of the events.)
- **`summary`** reads the transcript and produces a prose digest. Model policy
  reuses the distiller chain: per-call override → cluster default → fallback
  (`lifecycle.ts` distiller model resolution). Unlike the distiller it never falls
  back to a "deterministic" summary — if no model is available the `summary` mode
  simply fails with a clear error (the `full` mode is the deterministic option).

### Surfaces

- **Portal** — a "Generate Transcript" button in the Lifecycle modal
  (`web-app.js:4700-4742`, beside "Regenerate Context") opening a confirm modal
  with a **3-way mode `<select>`** modelled exactly on the regen distill-mode
  picker (`web-app.js:4528-4552`). On completion, surface the new artifact(s) with
  a link into the artifact viewer.
- **Agent self-tool** — `generate_transcript({ mode })`, declared in
  `systemToolDefs()` and handled per-turn like `regenerate_context`
  (`managed-session.ts:528`, `:1280`). Lets a session snapshot itself.
- **MCP + management** — `generate_transcript` MCP tool (session-scoped, in
  `sessions.ts` next to `regenerate_session`) → `mgmt.generateTranscript(sessionId,
  { mode })` (`management-client.ts`, mirroring `regenerateSession`).

### Authorization

Transcript generation is **read-only** and has **no epoch/lifecycle side effects**,
so it needs none of the regen gates (no cooldown, no min-age, no once-per-epoch).
It requires `session:read` on the target. It refuses to run *on* a service session
(you don't transcript the ⚗ helpers), consistent with regen refusing system/service
targets (`management-client.ts:1346-1351`).

## Architecture

### Reuse the service-session model — a new `service_kind`

Introduce `service_kind = "transcript-generator"`. It reuses the distiller's
half-pipeline (spawn → service session → collect → self-complete → sweep) and skips
the regen-specific half (archive-for-distill → flip/continue-as-new):

- **Spawn** — a `runTranscriptSpawn` activity modelled on `runRegenSpawnDistiller`
  (`session-proxy.ts:3737`): deterministic UUIDv5 id (idempotent on retry),
  `service_of = <target>`, `service_kind = "transcript-generator"`, parented under
  the **tree root** (`:3820`), `markSessionService` stamp (`:3841`), seeded with a
  mode-specific prompt.
- **Orchestration** — a small stage machine like `advanceRegenPipeline`
  (`lifecycle.ts:865`) but only: `preparing` (write the source archive) → for
  `summary`, `summarizing` (poll the generator's assistant message, 10s poll / 5m
  deadline like `DISTILLER_POLL_MS`/`DISTILLER_SESSION_DEADLINE_MS`) → `collect`
  (bind artifacts to the target) → `done`. For `full`/`all_events` the generator
  never needs an LLM turn, so those complete in `preparing`+`collect` without a
  model call (mirrors the distiller's `llm` vs `deterministic` split).
- **Self-completion + sweep** — identical to the distiller: enqueue `done` →
  `beginGracefulShutdown` (`lifecycle.ts:757`) → the ordinary stale-terminal
  sweeper reclaims it (`sweeper-tools.ts:91`). No special-casing.

Generalize the service-session lockdown. Today
`isServiceSession = agentIdentity === "regen-distiller"`
(`managed-session.ts:1816`) hard-codes one kind; the in-code comment already says
to "generalize to a `config.serviceKind` check if a second service kind ever
appears." This feature is that second kind — switch it to test `config.serviceKind`
and give the transcript generator only the tool(s) it needs.

### The event-source question (the crux)

A service session can only read **artifacts** — `read_transcript_page` downloads a
name-gated jsonl artifact scoped to `service_of` (`distiller-tools.ts:71-78`); it
cannot query the event stream, and the lockdown strips `read_agent_events`. So the
events must be materialized as an artifact first. Two options:

- **(A) Pre-archive activity (recommended).** A server-side activity (with CMS
  access) reads the events and writes the jsonl the generator will consume — a
  generalization of `runRegenArchive` (`regen-worker.ts:119`) that (i) parameterizes
  the event-type filter (transcript-only for `full`/`summary`; **all** types for
  `all_events`) instead of the hard-coded `TRANSCRIPT_TYPES`, and (ii) lifts the
  `ARCHIVE_EVENT_LIMIT = 1_000` / single-epoch scope (see below). For `full` /
  `all_events` this activity *also just writes the user-facing artifacts directly*
  — no service session round-trip needed for the deterministic formatting.
- **(B) New CMS-gated tool.** A `read_events_page` analog of `read_transcript_page`
  that calls `getSessionEvents(service_of, …)` with the same
  `serviceKind === "transcript-generator" && serviceOf` call-time gate
  (`distiller-tools.ts:59-69`). More flexible for the summarizer, but adds a tool +
  a live-CMS read path from a service session.

Recommended split: **(A)** materializes the source and writes the deterministic
artifacts; the **`summary`** mode's service session reads that same archive via the
existing pager to produce its digest. This keeps exactly one code path reading CMS
(the activity) and reuses `read_transcript_page` unchanged for the LLM step.

### Do the deterministic modes even need a session?

Strictly, `full` and `all_events` are pure reads → formatted writes and could be a
synchronous management call (like `exportExecutionHistory`). But the ask is to use
"the same system session model," and a uniform, **observable** ⚗ generator session
(visible under the parent, progress events, artifacts attributed consistently) is
worth the small overhead. Proposal: model all three as the service session, with
the deterministic modes doing their formatting inside the `preparing`/`collect`
activities and only `summary` spending an LLM turn. (Open decision below if we'd
rather make `full`/`all_events` a synchronous export and reserve the session for
`summary`.)

## Scope, caps, and epochs

The distiller archive is capped at `ARCHIVE_EVENT_LIMIT = 1_000` events and only the
**current epoch** (`regen-worker.ts:84`, paged backward from `MAX_SEQ`). A
transcript export should default to the **full session**:

- Walk `session_events` in seq order without the 1000 cap (streamed to the artifact
  in pages so memory stays bounded).
- Span **all epochs**, not just the current one — after a regeneration the live
  event stream continues across the flip, but older epochs' detail was archived;
  the export should stitch the current stream with any prior
  `transcript-e<N>-*.jsonl` archives, or clearly scope to "since last regeneration"
  with an option for full history. (Open decision: default scope.)

## Divergences from the distiller (the hard parts)

1. **Live vs archived source.** The distiller reads an archive the regen pipeline
   *writes first*; here we materialize the archive ourselves from live CMS events.
   The SDK's on-disk `~/.copilot/session-state` tar snapshots
   (`session-store.ts:21`) are opaque and **not** a transcript source — don't touch
   them; CMS `session_events` is the only queryable history.
2. **Event-stream access from a service session** — solved by the pre-archive
   (option A) rather than granting the generator live CMS reads.
3. **Heterogeneous event data** — `all_events` must emit structured `data` per
   type, not assume `evt.data.content` (which `read_transcript_page` does,
   `distiller-tools.ts:92`). ndjson passthrough avoids lossy flattening.
4. **Scope** — lift the 1000-event / single-epoch caps for a real full transcript.
5. **No commit machinery** — reuse only the spawn/service/collect/sweep half; never
   enter the epoch flip (`lifecycle.ts:966`). Distinct `service_kind` keeps the two
   pipelines from sharing state.

## Milestones

- **M1 — deterministic export.** Pre-archive activity + `full` and `all_events`
  modes writing artifacts; MCP + management surface; agent `generate_transcript`
  tool (modes `full`/`all_events`). No LLM, no UI yet. Smallest useful slice.
- **M2 — service-session modeling.** Wrap the export in a `transcript-generator`
  service session (generalize `isServiceSession`), observable + sweeper-reclaimed;
  progress events.
- **M3 — LLM summary.** `summary` mode via the service session reading the archive;
  model policy chain; failure surfaced (no deterministic summary fallback).
- **M4 — UI.** Lifecycle → Generate Transcript button + 3-way mode confirm modal +
  artifact link, mirroring the regen control end to end.

## Open decisions

1. **Deterministic modes: service session or synchronous export?** Uniform ⚗
   session (consistency, observability) vs. a plain synchronous `export…` call for
   `full`/`all_events` with the session reserved for `summary`.
2. **Default scope** — whole session across epochs, or "since last regeneration"
   with an opt-in for full history.
3. **`all_events` format** — ndjson only (faithful) vs. also a rendered markdown
   view of the activity stream.
4. **Mode combination** — single-select (like regen distill-mode) vs. allow e.g.
   summary + full together in one run.
5. **Event-source tool** — pre-archive only (A), or also ship `read_events_page`
   (B) for richer future service-session event access.
6. **Summary shape** — freeform prose vs. a structured schema (headline, key
   decisions, open threads, participants) that renders consistently.
