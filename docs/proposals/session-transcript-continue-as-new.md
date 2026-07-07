# Session Regenerate — Transcript Continue-As-New (Epoch Rebirth)

## Status

Proposed. Full design: orchestration, distiller, UX, management API, tests.

Complementary to
[agent-manager-continue-as-new.md](agent-manager-continue-as-new.md). That
proposal creates a **new top-level session** that semantically continues a
source session — right when the source is broken, retired, or being re-homed,
and when losing its live identity (children, cron, queue) is acceptable. This
proposal covers the more common case: a session that is **healthy and
mid-mission but whose LLM transcript has degraded** through repeated
compaction. Identity must survive — sub-agent tree, cron schedules, pending
queue, facts, artifacts, group membership, UI history all stay — and only the
Copilot SDK transcript is retired and reborn.

The two proposals share the **Distiller** component and the **ResumePackage**
schema.

## Naming

| Term | Meaning |
| --- | --- |
| **Regenerate** | User-facing verb everywhere (UI, MCP, chat). "Regenerate this session's context." |
| **Transcript epoch** | Monotonic counter; each regenerate bumps it. Epoch 0 is the session's first transcript. |
| **Distiller** | External LLM pass, fresh context, that reads the session's full closure and emits a ResumePackage. |
| **ResumePackage** | Structured, versioned handoff document that seeds the new epoch. |
| **Closure** | Everything the session's work touched: transcript, summaryState, facts written/read, artifacts, child roster + contracts + child summaries, cron state, CMS tail. |

Internal identifiers use `continue_as_new` / `regenerate` consistently:
command `cmd: "regenerate"`, event `session.regenerated`, tool
`regenerate_context` (agent), tool `regenerate_session` (MCP).

## Summary

Add a first-class **Regenerate** operation to the durable-session
orchestration. When triggered — from the UI's Manage menu, from the
management API/MCP, or by asking the session itself in chat — the
orchestration:

1. finishes the current turn and quiesces (the turn loop is the single
   writer; regenerate is just another queue item — no locks),
2. archives the full current transcript to the artifact store,
3. runs the **Distiller** — an external LLM call with fresh context over the
   whole closure — producing a **ResumePackage**,
4. bumps the **transcript epoch**: fresh Copilot SDK session (empty
   transcript, same agent definition / system prompt / tools),
5. seeds the new epoch with a bootstrap prompt built from the ResumePackage
   and forces a **grounding turn** (`requiredTool: read_facts`) so the reborn
   session re-reads authoritative state before acting,
6. continues the same duroxide orchestration — same sessionId, children,
   cron, queue.

This is the LLM-transcript analogue of what the orchestration already does
for its own history (duroxide continue-as-new bounds `historySizeBytes`
regardless of iteration count). The transcript is the one continuity layer
with no rebirth mechanism today — it can only compact in place, and in-place
compaction demonstrably compounds errors.

## Motivation

Evidence from a production incident (2026-07-07; details generalized):

- A steady-state watcher session ran 4.6 days / 363 iterations through
  **≥13 in-place compactions**: two hard failures (`400 No tool output found
  for function call` — dangling tool call in the submitted transcript), three
  compactions that started and never completed, one stuck `state:"running"`
  for 3+ hours ([#54](https://github.com/affandar/PilotSwarm/issues/54)).
- One compaction squashed **277 messages / 106.6k tokens** minutes before the
  session needed exactly that evidence. It then confidently reconstructed its
  own recent history *wrong* — filing a detailed platform bug report that the
  CMS event stream flatly refuted. Same session self-retracted a second
  misdiagnosis the same day.
- Economics: ~66k tokens fixed per-turn overhead against a 200k window meant
  compaction fired roughly hourly at ~160k input each — millions of tokens a
  day summarizing summaries of summaries.

Structural problems, independent of the #54 bugs:

1. **Same model, degraded context.** The compactor summarizes from inside the
   already-tight window; it cannot see what earlier compactions dropped.
2. **Iterated lossy encoding.** Each pass re-summarizes prior summaries;
   confabulation risk grows with compaction generation.
3. **Transcript-only view.** Compaction cannot see the closure — facts,
   children, artifacts — which holds most of the durable truth.
4. **No audit.** Dropped messages leave no epoch boundary, no archive, no
   record of what was lost.

Regenerate inverts all four: fresh full-size context; one distillation from
the complete closure; facts/children/artifacts as first-class inputs; an
archived, auditable epoch boundary.

### Why not the Agent-Manager clone flow?

`continue_session_as_new` (agent-manager proposal) creates a **new session
id**. For a session with live operational identity that is the wrong shape:

| Concern | Clone (new sessionId) | Regenerate (this proposal) |
| --- | --- | --- |
| Children's `parentSessionId` / `[CHILD_UPDATE]` routing | breaks | unaffected |
| Cron / cron_at schedules | must re-arm by hand | carried in orchestration state |
| Pending queue / in-flight digests | left behind | carried |
| Session-scoped facts & artifacts | copied / re-keyed | unaffected |
| UI history, groups, pins | new session | continuous, epoch divider |
| Best for | broken/retired sessions, re-homing | healthy sessions, degraded context |

## Goals

- Same sessionId, orchestration, children, cron, queue across regeneration.
- Distillation by an external LLM with fresh context over the full closure.
- Old transcript archived (never destroyed), epoch boundary evented.
- Three trigger surfaces: chat ask → agent tool; UI Manage menu; MCP /
  management API.
- **Terminate button becomes "Manage"** — one entry point for Regenerate,
  Mark Completed, Cancel, Delete.
- Deterministic, replay-safe mechanics (orchestration version bump).
- Fail-safe: any failure before the epoch flip leaves the session untouched.

## Non-Goals

- No rewriting duroxide history (that layer already has continue-as-new).
- No cross-session cloning (agent-manager proposal).
- No model/agent-definition change during regenerate in v1 (same config).
- No lease/lock primitives — quiescence rides the single-writer turn loop.
- Bulk regenerate in v1 (single session only; bulk stays for
  complete/cancel/delete).

---

# Design

## 1. Continuity layers

The platform has three continuity layers; this adds the fourth:

1. **Duroxide history** — bounded by orchestration continue-as-new
   (`MAX_HISTORY_SIZE_BEFORE_CONTINUE_AS_NEW_BYTES`, `buildContinueInput`).
2. **Versioned transcript snapshots** — per-turn CAS commits
   (`snapshotVersion`, session-proxy versioned snapshot store).
3. **summaryState** — agent-maintained structured summary
   (`update_session_summary`, `SessionSummaryState`).
4. **(new) Transcript epochs** — bounded transcript lifetime via
   distill + rebirth.

## 2. Epoch model

- `transcriptEpoch: number` (default 0) added to `OrchestrationInput` and
  `DurableSessionState`, threaded through `buildContinueInput` like
  `snapshotVersion`.
- Versioned snapshot store keys gain an epoch component: a new epoch starts
  from an empty store; old-epoch snapshots stay readable for
  forensics/rollback, GC'd after the new epoch has M successful turns
  (default 5) or N days (default 7), whichever later.
- `transcriptEpoch` stamped on `session.*` lifecycle events, `contextUsage`,
  session detail, and metrics.

## 3. Trigger surfaces

### 3a. Chat — "ask the session to regenerate"

New agent tool `regenerate_context` (same family as
`update_session_summary`), available to top-level and child sessions:

```ts
regenerate_context({ reason?: string })
```

- Implemented as a new `TurnAction` (like cron/wait actions): the tool
  records the action, the turn ends normally, then the orchestration runs the
  regenerate pipeline. The agent's final message before the flip is delivered
  to the user ("Archiving my context and regenerating — back in a moment.").
- Rate-limited: once per epoch per 6h (config). Rejections return a tool
  error string the agent can relay.
- The agent may call it on its own judgment (it can see its compaction
  telemetry via contextUsage) or because the user asked in chat
  ("please regenerate your context").

### 3b. UI — Manage menu (Terminate button renamed)

See [UX design](#ux-design) below.

### 3c. Management API / MCP

- Orchestration command (the canonical path — same shape as `set_model`):

  ```ts
  mgmt.sendCommand(sessionId, {
    cmd: "regenerate",
    instructions?: string,     // operator guidance passed to the distiller
    distillerModel?: string,   // override; default from config
  })
  ```

- Management client convenience: `regenerateSession(sessionId, opts)`
  wrapping the command and returning `{ accepted, epoch }`.
- MCP tool (in `packages/app/mcp/src/tools/sessions.ts`):

  ```ts
  regenerate_session({
    session_id: string,
    instructions?: string,
    wait?: boolean,            // long-poll until session.regenerated / failed
  })
  ```

  Gated like other mutating session tools (owner or admin role); listed in
  `get_capabilities`. `get_session_detail` gains
  `transcriptEpoch`, `lastRegeneratedAt`, `regenerateState`
  (`idle | archiving | distilling | rebooting | grounding`).
- Web API parity endpoint (v0.5.0 parity theme):
  `POST /api/sessions/:id/regenerate` → same command; `202 { epoch }`.

### 3d. Policy (automatic — ships off in v1)

Evaluated at turn boundaries from counters the contextUsage reducer will
track (`compactionCount`, `compactionGeneration`, cumulative
`tokensRemoved`):

- `compactionCount` since epoch start ≥ 6, or
- `compactionGeneration` ≥ 2 (a compaction whose input begins with a prior
  compaction summary — summarizing a summary), or
- ≥ 2 consecutive failed/stuck compactions — making regenerate the
  **remediation path for #54**: when in-place compaction cannot proceed,
  escalate to rebirth instead of retrying a broken compactor, or
- cumulative `tokensRemoved` ≥ 300k, or
- epoch age ≥ D days (default off).

## 4. The Distiller

An **activity** (I/O-heavy — never orchestration-generator code), invoked
like `runTurn`. Fresh context, configurable model (`distillerModel` config;
default the session's model; deployments with a large-context tier point
there — never silently smaller than the session's model).

**Inputs — the closure:**

| Source | Content |
| --- | --- |
| Transcript archive | full current-epoch transcript (exported in step 1) |
| `summaryState` + `shortSummary` | the agent's own structured summary |
| `taskContext` | immutable original mission |
| Facts | keys+values the session wrote; keys recently read (provenance from facts store / CMS events) |
| Artifacts | listing + sizes; small key artifacts inlined |
| Sub-agent roster | `subAgents[]` with task, status, contract; each child's `shortSummary` |
| Cron state | `cronSchedule` / `cronAtSchedule` reasons and cadence |
| CMS tail | recent `session.*` / error events (bounded) |
| Trigger context | operator/agent `instructions`/`reason`, verbatim |

Large transcripts distill **map-reduce**: deterministic chunking by turn
boundaries (~100k tokens/chunk) → parallel per-chunk extraction activities →
merge pass. The orchestration sees only activity results (replay-safe).

**Prompt principles** (these are the design, not implementation detail):

- **Pointers over copies.** Facts/artifacts are ground truth; the package
  says *what to read and when*, it does not duplicate content.
- **Verbatim over paraphrase** for user standing instructions and
  commitments — exactly what iterated compaction mangles.
- **Carry the scar tissue.** Corrections/retractions made this epoch are the
  highest-value lines; they prevent re-derailing. (Both incident
  misdiagnoses would have been prevented by a carried correction.)
- **Adversarial completeness pass.** A second cheap call reviews the package
  against the closure: "could a competent stranger resume from this? what
  load-bearing item is missing?" Findings merge into the package.

## 5. ResumePackage (v1 schema)

Extension of `SessionSummaryState`; stored as artifact
(`resume/epoch-<N>.json`) and session fact.

```ts
interface ResumePackage {
  schemaVersion: 1;
  sourceEpoch: number;
  distilledAt: string;
  distiller: { model: string; inputTokens: number; chunks: number };

  mission: string;                       // == taskContext, verbatim
  standingInstructions: string[];        // user directives in force, VERBATIM
  currentState: Record<string, unknown>; // domain state machine
  workingSet: Array<{ item: string; status: string; next: string }>;
  commitments: Array<{ what: string; when?: string }>;
  childRoster: Array<{ agentId: string; task: string; contract?: string;
                       cadence?: string; expect: string }>;
  schedule: { cron?: string; cronAt?: string };
  factsMap: Array<{ key: string; holds: string; readWhen: string }>;  // POINTERS
  artifactsMap: Array<{ filename: string; holds: string }>;
  pitfalls: string[];                    // self-corrections made this epoch
  openQuestions: string[];
  recentTail: string;                    // last K turns, trimmed, hard byte cap
}
```

## 6. Regenerate pipeline (two-phase, fail-safe)

Processed as a queue item at a turn boundary (inherent quiescence;
consistent with the no-lease posture):

1. **Archive** *(activity, idempotent per epoch)* — export current
   transcript → `transcript/epoch-<N>.jsonl` artifact. Failure → abort,
   `session.regenerate_failed { stage: "archive" }`, session unchanged.
2. **Distill** *(activities, retried)* — ResumePackage + completeness pass;
   store artifact + fact. Failure after retries → abort, event, unchanged.
3. **Flip epoch** *(pure orchestration state)* — `transcriptEpoch++`,
   `snapshotVersion = 0` (new epoch namespace), rotate affinity via existing
   `releaseAffinity`. Next `runTurn` finds an empty epoch-scoped snapshot
   store → fresh SDK session, same agent definition / system prompt / tool
   surface. `ensureTaskContext` re-applies `[RECURRING TASK]` from
   `taskContext` exactly as today.
4. **Seed + ground** — first prompt of the new epoch (`bootstrapPrompt:
   true`, `requiredTool: "read_facts"`):

   ```text
   [SYSTEM: Context regenerated (transcript continue-as-new). You are the
   same session resuming your own work; your previous transcript (epoch <N>,
   <turns> turns) was archived and distilled into the resume package below.
   Your sub-agents, schedules, facts, and artifacts are untouched and live.

   <resume brief rendered from ResumePackage>

   Before any other action: read the facts listed in factsMap to verify
   current ground truth, then call update_session_summary to re-establish
   your summary. Do not trust recalled details that conflict with facts.]
   ```

5. **Commit** — `session.regenerated` event `{ fromEpoch, toEpoch,
   archivedTurns, archivedBytes, distiller stats, packageBytes, trigger }`.
   Old-epoch snapshots retained until M successful turns (rollback = flip
   `transcriptEpoch` back), then GC'd; the archive artifact is permanent.

**Timers:** an active cron/wait timer is captured like the existing
interrupted-timer paths (`interruptedCronTimer` / `interruptedWaitTimer`)
and re-armed after the grounding turn — cadence preserved.

**Children:** unaffected. `subAgents[]`, contracts, pending child digests
live in orchestration state and carry through `buildContinueInput`. A
`[CHILD_UPDATE]` arriving mid-regenerate queues durably and is delivered to
the new epoch's second turn. Children get the same feature independently.

**User messages mid-regenerate:** queue durably (they already do); the UI
shows a "will be delivered after regeneration" affordance.

**Edge cases:**

| Case | Behavior |
| --- | --- |
| Regenerate while a turn is running | queued; executes at the boundary |
| Second regenerate while one pending | rejected (`already_pending`) |
| `input_required` session | allowed; the pending question is carried in the ResumePackage (`openQuestions`) and re-asked in the grounding turn |
| Brand-new session (< 5 turns) | rejected (`too_young`) — nothing to distill |
| System sessions | excluded in v1 (`restart_system_session` exists) |
| Bulk selection in UI | Regenerate hidden/disabled ("select a single session") |
| Distiller emits invalid package | schema validation fails → retry → abort-safe |
| Worker dies mid-pipeline | duroxide replay: archive/distill activities are idempotent; flip is atomic orchestration state |

## 7. Tiered memory (v2)

- Index archived epochs into the enhanced-facts/embedder store under
  `archive/<sessionId>/epoch-<N>` at archive time.
- New session tool `recall_archive(query, epoch?)` — retrieval over the
  session's own past transcripts. The working set is injected; everything
  else stays queryable. This makes regenerate non-lossy in practice and
  indefinite-lifetime sessions viable.

## 8. Cost

Incident numbers: in-place compaction ≈160k input tokens/pass at roughly
hourly cadence (≈4M/day) while degrading quality. One regenerate distillation
over the same session's archive is a one-time map-reduce on the order of a
single day of compaction churn, produces a strictly better result, and resets
the transcript so routine compaction becomes rare in the new epoch.
Policy-triggered regeneration every few days is cheaper than the status quo.

---

# UX design

## 9. Manage button (rename of Terminate)

Current state (`packages/app/ui/react/src/web-app.js`): a "Terminate" button
(`~L1859–1958`) opens a `terminatePicker` modal with three stacked actions —
Mark Completed / Cancel Session / Delete Session — then per-action confirm
modals via `controller.pickTerminateAction(action)`
(`packages/app/ui/core/src/controller.js` ~L4012).

**Changes:**

- Button label `Terminate` → **`Manage`** (bulk: `Manage (N)`), tooltip:
  "Manage this session — regenerate context, complete, cancel, or delete".
- Modal `terminatePicker` → **`managePicker`** (internal rename, tests
  updated; no alias kept — the modal type is not persisted).
- Modal title: "Manage session". Body: `What should happen to "<title>"?`
- Actions, in order:

  | # | Label | Style | Availability |
  | --- | --- | --- | --- |
  | 1 | **Regenerate Context** | primary | single session, not system, ≥5 turns, no regenerate pending |
  | 2 | Mark Completed | default | as today |
  | 3 | Cancel Session | default | as today |
  | 4 | Delete Session | danger | as today |

  Bulk selection: Regenerate row hidden; rows 2–4 keep today's bulk
  behavior. System-restart variant of the picker: unchanged (restart
  dispositions), no Regenerate row in v1.

- **Regenerate confirm modal** (new, follows the existing per-action confirm
  pattern):

  ```
  Regenerate context for "<title>"?

  The session's conversation transcript will be archived and distilled into
  a resume package by a fresh model pass. The session keeps its identity —
  sub-agents, schedules, facts, and artifacts are untouched. This typically
  takes a minute or two; incoming messages are queued meanwhile.

  [ Optional instructions for the distiller … (textarea) ]

              [ Cancel ]   [ Regenerate ]
  ```

## 10. In-progress & timeline UX

- **Status chip** on the session (list + header): `Regenerating…` with
  stage from `regenerateState` (`archiving → distilling → rebooting →
  grounding`), driven by CMS events. Prompt input stays enabled but shows a
  hint: "Message will be delivered after regeneration."
- **Epoch divider** in the chat timeline (new selector + `index.css` rule
  `.ps-epoch-divider`):

  ```
  ── ⟳ Context regenerated · epoch 3 · 363 turns archived ──
        [view archive] [view resume package]
  ```

  Links open the artifact viewer on `transcript/epoch-<N>.jsonl` and
  `resume/epoch-<N>.json`.
- **Session detail panel:** `Epoch 3 · regenerated 2× · last 2026-07-07
  17:40Z`; failure row when the last attempt failed
  (`Regenerate failed at distilling — view event`).
- **Chat-initiated flow:** user types "regenerate your context" → agent
  calls `regenerate_context` → agent's sign-off message renders → status
  chip cycles → epoch divider → grounding turn's summary message renders.
  The user experiences it as the session briefly "rebooting" in place.
- **TUI parity:** the TUI session menu gains the same Manage entries;
  transport already flows through `node-sdk-transport.js` → management
  client, so only menu wiring is needed.

## 11. Microcopy

| Surface | Copy |
| --- | --- |
| Button | `Manage` |
| Picker action | `Regenerate Context` |
| Confirm CTA | `Regenerate` |
| Status chip | `Regenerating — distilling…` |
| Queued-input hint | `Delivered after regeneration` |
| Divider | `Context regenerated · epoch <N> · <T> turns archived` |
| Failure toast | `Regenerate failed (<stage>). Session unchanged.` |
| Agent tool rejection | `Regenerate unavailable: <already_pending|too_young|rate_limited>` |

---

# Management API design

## 12. Surfaces & gating

| Layer | Addition |
| --- | --- |
| Orchestration | `handleCommand` case `"regenerate"` (lifecycle.ts, alongside `set_model`) |
| Management client | `regenerateSession(sessionId, { instructions?, distillerModel? })` → `{ accepted, epoch }`; `getSessionDetail` exposes epoch fields |
| MCP (`packages/app/mcp/src/tools/sessions.ts`) | `regenerate_session { session_id, instructions?, wait? }`; registered only when capabilities allow; owner/admin gated like `abort_session` |
| Web API | `POST /api/sessions/:id/regenerate` → 202 `{ epoch }`; `GET /api/sessions/:id` includes `transcriptEpoch`, `regenerateState`, `lastRegeneratedAt` |
| Events | `session.regenerate_started`, `session.regenerate_stage { stage }`, `session.regenerated`, `session.regenerate_failed { stage, error }` |
| Audit | command carries actor (owner/admin/agent/policy) into the events |

`wait: true` on the MCP tool long-polls session events (same machinery as
`get_session_events wait=true`) until `session.regenerated` or
`session.regenerate_failed`, then returns the terminal event payload.

---

# Implementation points

- `packages/sdk/src/types.ts` — `OrchestrationInput.transcriptEpoch`,
  `ResumePackage`, event payloads, command type.
- `packages/sdk/src/orchestration/` (version bump → 1.0.59):
  - `state.ts` — `transcriptEpoch`, `pendingRegenerate`.
  - `lifecycle.ts` — `handleCommand` case; `buildContinueInput` threading.
  - `queue.ts` — pipeline dispatch at turn boundaries; policy hook.
  - `turn.ts` — epoch-scoped snapshot params; grounding-turn dispatch
    (`requiredTool`); `regenerate_context` TurnAction handling.
  - `utils.ts` — contextUsage reducer: `compactionCount`,
    `compactionGeneration`, cumulative `tokensRemoved`.
- `packages/sdk/src/session-proxy.ts` — epoch component in snapshot keys;
  fresh-epoch start; transcript export for archiving.
- `packages/sdk/src/managed-session.ts` — `regenerate_context` agent tool
  (rate limit, guards); distiller activity registration.
- New `packages/sdk/src/distiller.ts` — closure assembly, chunking, prompts,
  package validation, completeness pass. Shared with Agent-Manager clone.
- `packages/sdk/src/management-client.ts` — `regenerateSession`, detail
  fields.
- `packages/app/mcp/src/tools/sessions.ts` — `regenerate_session`.
- Web API routes — regenerate endpoint + detail fields.
- `packages/app/ui/core/src/controller.js` — `managePicker` rename,
  `pickManageAction("regenerate")`, confirm modal, regenerate dispatch,
  status-chip state.
- `packages/app/ui/core/src/selectors.js` — epoch divider + regenerate
  state selectors.
- `packages/app/ui/react/src/web-app.js` — Manage button, managePicker
  modal (4 actions), confirm modal with instructions textarea, chip,
  divider rendering.
- `packages/app/web/src/index.css` — `.ps-epoch-divider`, chip styles.
- `packages/app/tui/` — Manage menu parity.

---

# Test plan

## Orchestration (`packages/sdk/test/local/`)

- **Command intake:** `regenerate` queued mid-turn executes at boundary;
  second request while pending → `already_pending`; `< 5` turns →
  `too_young`; system session → rejected.
- **Two-phase safety:** archive activity failure → no state change +
  `regenerate_failed{stage:"archive"}`; distill failure after retries → no
  state change; flip is atomic (no partial epoch state under fault
  injection — reuse the counter fault-injection harness).
- **Epoch store:** new epoch starts from empty snapshot store; old-epoch
  snapshots readable; GC after M turns; rollback flips epoch back and next
  turn hydrates the old transcript.
- **Timers:** active cron captured and re-armed with cadence preserved;
  wait timers likewise; cron fires queued during pipeline don't double-fire.
- **Children:** pending child digest delivered post-regenerate;
  `[CHILD_UPDATE]` routing unaffected; roster lands in ResumePackage.
- **Grounding:** first new-epoch turn has `bootstrapPrompt`, resume brief,
  `requiredTool: "read_facts"`; `update_session_summary` re-established;
  `input_required` question re-asked.
- **Agent tool:** `regenerate_context` records a TurnAction; turn completes
  before pipeline; rate-limit enforced; rejection strings surface.
- **Policy counters:** reducer tracks compactionCount / generation /
  tokensRemoved from event streams, including #54 fixture sequences
  (failed + stuck compactions); thresholds trigger exactly once.
- **Replay determinism:** full pipeline deterministic under duroxide
  replay; activities idempotent per epoch.

## Distiller (unit)

- Deterministic chunking by turn boundaries; stable across replays.
- Schema validation rejects malformed packages; retry path.
- Verbatim standing-instruction preservation through a synthetic noisy
  transcript (paraphrase = test failure).
- Pointers-not-copies: package byte cap enforced; fact values not inlined.
- Completeness pass merges findings; second pass is bounded.
- Map-reduce merge equals single-shot on small inputs.

## UI core (`controller` / `selectors`, alongside existing UI tests)

- Manage button label/tooltip states (single, bulk, system).
- `managePicker` shows Regenerate only when eligible; bulk hides it.
- `pickManageAction("regenerate")` → confirm modal → dispatch with
  instructions; cancel path clean.
- Status chip transitions from `regenerate_stage` events; terminal on
  `regenerated` / `regenerate_failed`.
- Epoch divider selector renders from `session.regenerated` events with
  artifact links; ordering stable in history pagination.
- Queued-input hint while regenerating.

## MCP / API (integration)

- `regenerate_session` happy path; `wait:true` long-poll returns terminal
  event; permission denial for non-owner; capability listing.
- Web API endpoint 202 + detail fields; parity with MCP result.
- Full smoke: seed session with N turns + facts + a child + cron →
  regenerate → assert same sessionId, epoch+1, child update delivered,
  cron cadence preserved, summaryState re-established, archive + package
  artifacts exist.

---

# Rollout & milestones

1. **M1 — Plumbing + manual regenerate.** Epoch model, command, archive,
   naive single-shot distiller, bootstrap + grounding, events, MCP tool,
   orchestration tests. Policy off. No UI yet (MCP-only).
2. **M2 — UX.** Manage rename, managePicker, confirm modal, chip, epoch
   divider, TUI parity, UI tests.
3. **M3 — Distiller quality.** Full closure assembly, map-reduce,
   completeness pass, ResumePackage v1 shared with Agent-Manager clone,
   distiller tests.
4. **M4 — Policy + remediation.** Compaction counters, auto-trigger, #54
   escalation (failed/stuck compaction → regenerate), `regenerate_context`
   agent tool + rate limits.
5. **M5 (v2) — Tiered memory.** Archive indexing + `recall_archive`.

# Open decisions

1. **Distiller model source** — config knob per deployment; recommendation:
   default to the session's model, never silently smaller.
2. **Policy defaults** — proposed thresholds above; ship off, gather epoch
   metrics, then enable.
3. **Agent-initiated in M1 or M4?** Recommendation: M4 — the manual paths
   exercise the pipeline first; the incident shows agents *can* detect
   degradation, but rate-limit design deserves real epoch metrics.
4. **Runtime systemMessage appends** — regenerate re-derives config from the
   agent definition; recommendation: drop accumulated appends and let the
   ResumePackage carry semantics (appends are a smell).
5. **Epoch GC horizon** — M successful turns vs N days; archive artifacts
   permanent either way.
6. **`managePicker` internal rename** — clean rename + test updates
   (recommended; modal type isn't persisted) vs keeping a `terminatePicker`
   alias for outstanding branches.
