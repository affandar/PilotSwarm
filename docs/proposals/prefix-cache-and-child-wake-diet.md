# Prefix cache and child-wake diet

Status: proposal, rev 2, 2026-08-30 (after adversarial review).
Target: orchestration 1.0.71 + pilotswarm-sdk 0.5.52.

Three changes that cut wasted input tokens on manager sessions. Measured on
waldemort chk (37 sessions, 3,025 model calls, 667M input tokens; see
`chk-token-waste-survey-2026-08-30` in the session memory).

| # | change | what it saves in the chk sample |
|---|---|---|
| P1 | keep the wake-up note out of the system message | 16M (GHCP) + 37M (Anthropic) uncached tokens on first calls, paid at ~10× the cached price |
| P2 | wake a parent for child updates less often | 28.7M tokens on child-triggered wake-ups that did no work |
| P3 | `check_agents` returns only what changed | ~1.3M chars per 124 calls, and it compounds in the transcript |

## Terms

- **Wake-up note.** The `[SYSTEM: …]` text PilotSwarm adds to a prompt when a
  session wakes up on its own: a timer ended, a cron fired, or a child
  session reported something. Built in `orchestration/turn.ts` (wait, cron)
  and `orchestration/queue.ts:895-940` (child updates).
- **System message.** The first part of every model request. The provider
  caches the request prefix. If the system message changes, the whole cache
  behind it is lost.
- **Child digest.** The buffer of child-session updates a parent collects
  before it wakes up. `state.pendingChildDigest`, window
  `CHILD_UPDATE_BATCH_MS = 30_000` (`orchestration/state.ts:204`).
- **Orchestration version.** The session loop code is frozen per version.
  Live code is `orchestration/` (1.0.70). **A session does not keep its
  version:** every continue-as-new hands off to the latest version
  (`lifecycle.ts:522` `continueAsNewVersioned(…, latestVersion)`), and a
  continue happens at least every 10 iterations
  (`state.ts:215 MAX_ITERATIONS_PER_EXECUTION`) or on any retry. So after a
  deploy, every live session is on the new version within ~10 iterations.
  Frozen versions matter only for replaying history, and for that short
  window. `session-manager.ts` is not versioned: it runs for every session
  at once.

---

## P1 — keep the wake-up note out of the system message

### Today

```
1. queue.ts / turn.ts build the prompt as  "<user text>\n\n[SYSTEM: <note>]"
2. turn.ts:300  extractPromptSystemContext() splits the note off the prompt
3. turn.ts:298-312  note (+ state.pendingSystemPrompt) → config.turnSystemPrompt
4. session-manager.ts:2421  _buildLastInstructionsSection merges
   config.turnSystemPrompt into the system message's last_instructions
5. turn.ts:469 / :506  config.turnSystemPrompt = undefined after the turn
```

The note differs on every wake-up, so the system message differs on every
wake-up. Measured on chk, first call after a wake-up within the cache TTL:

| provider | system message vs previous turn | n | input | cache hit |
|---|---|---|---|---|
| GHCP | different | 50 | 16.1M | 12% |
| GHCP | same, user prompt different | 25 | 7.3M | 93% |
| Anthropic-direct | different | 136 | 36.9M | 19% |
| Anthropic-direct | same (user prompt changed in nearly all) | 225 | 43.7M | 99% |

The "same" rows prove the cache breakpoint sits after the system message on
both providers. A change in the user turn alone is cheap. (Anthropic-direct
reports no `cacheExpiresAt`; it was bucketed by "gap since the previous
call under the 5-minute Anthropic TTL".)

### The note is not the only mover

Consecutive **user → user** turns (no wake-up note on either side) still
change the system-prompt size 24 times in 83 pairs (29%), and those calls
hit the cache at 12%. Examples: `05743ef2` +14,485 chars on one user turn;
`647180e6` +63 chars per turn, three turns running. The known candidate is
the knowledge block: `session-manager.ts:2378/2390` re-reads the open asks
(and, on base stores, skills) from the fact store on every compose. Any ask
opened anywhere on the fleet moves every session's prefix.

So P1 has two halves:

- **P1a** — the wake-up note (this section).
- **P1b** — find and freeze the other mover. First step: add a debug hook
  that hashes each composed system-message section per turn and records
  the hashes in a `session.prompt_sections` event. Then fix what moves.
  Likely fix: cache the knowledge index per session and refresh it only on
  a user turn, or move it to the user turn like the note.

P1a alone recovers the wake-up misses. P1b is needed to reach the 93–99%
seen on stable turns.

### As built (1.0.71, 2026-08-30)

Two deviations from the plan below, both to cut risk:

- `turnSystemPrompt` is still set. What changed is a new flag,
  `config.systemContextInPrompt = true`, set by 1.0.71 next to it.
  `session-manager.ts` renders `turnSystemPrompt` only when the flag is
  absent (`latest.systemContextInPrompt ? undefined : latest.turnSystemPrompt`).
  So ≤1.0.70 turns keep their old path with zero code change, the
  `system.message` recording in session-proxy is untouched, and the test
  harnesses that read `turnSystemPrompt` stay valid.
- The budget stash (`stashBudgetRefusedPrompt`) strips the block before its
  guards. Without that, the internal wake prompt no longer matched
  `INTERNAL_SYSTEM_TURN_PROMPT` by equality and was stashed as a user's
  words — three existing tests caught it.

New shared module: `packages/sdk/src/prompt-system-context.ts`
(`appendSystemContextBlock` / `splitSystemContextBlock`). Tests:
`test/local/prefix-cache-system-context.test.js` (4, drive the real
generator), `test/unit/orchestration-freeze-1-0-71.test.mjs` (8, structural
pins), `test/unit/prompt-system-context.test.mjs` (7), plus new cases in
`session-proxy-events` and `contracts`. All verified red with the fix
disabled.

### Change (P1a), in the new orchestration version

1. `turn.ts:298-312`: do not move the note into `config.turnSystemPrompt`.
   Keep it in the prompt string as a trailing block:
   `"<user text>\n\n<system_context>\n<note>\n</system_context>"`.
   Apply to BOTH note sources: the block extracted from the prompt (`:302`)
   and `state.pendingSystemPrompt` (`:298`, fed by `input.systemPrompt` and
   the shared-session preamble at `utils.ts:103`).
2. Keep `systemOnlyTurn` (`:307`) computed exactly as today: "the prompt had
   no user text, only a note". When true, the user text is
   `INTERNAL_SYSTEM_TURN_PROMPT` and the note follows it.
3. **Retries.** Today `RetryContext` carries the note in `turnSystemPrompt`
   (`turn.ts:62`, `:196`, `:494`), which becomes `input.systemPrompt` →
   `state.pendingSystemPrompt` (`state.ts:292`) on the retried execution.
   Under P1a the note is already inside `sourcePrompt`, so forwarding
   `turnSystemPrompt` too would deliver it twice. Drop `turnSystemPrompt`
   from the `runTurn.throw` `RetryContext`; the note rides in `sourcePrompt`
   only. Note the `turn.result.error` path (`turn.ts:1314-1319`) never
   carried `turnSystemPrompt`, so today that retry LOSES the note; P1a fixes
   that as a side effect.
4. **Recording.** Today the note is written to CMS as a `system.message`
   event, gated on `config.turnSystemPrompt` (`session-proxy.ts:3117-3123`),
   and `user.message` is skipped for system-only turns (`:3134`).
   `isInternalSystemPrompt` (`:392`) matches only prompts that START with
   `[SYSTEM:`. Under P1a a user prompt that interrupts a cron
   (`queue.ts:472`) would be stored as `user.message` with the
   `<system_context>` block inside it, and the note would be recorded
   nowhere. Fix in the activity: split the trailing block off before
   persisting; write the note as the same `system.message` event as today;
   persist `user.message` without the block. The portal and the analysis
   scripts keep working unchanged.
5. `session-manager.ts` is NOT changed. `_buildLastInstructionsSection`
   still renders `config.turnSystemPrompt` for executions on 1.0.70 and
   older during the hand-off window. It can be deleted in a later release
   once the compatibility floor passes 1.0.70.
6. `queueFollowup` (`lifecycle.ts:373-380`) also puts `[SYSTEM: …]` text
   into the user turn, but bare — it strips the brackets and does not wrap.
   Add one shared helper (`wrapSystemContext(text)`) and use it in both
   places so there is one shape.
7. Shared-session note: `utils.ts:74-83` neutralises a collaborator's
   `[SYSTEM:` text because the extractor lifts it. Under P1a nothing is
   lifted. The neutraliser must also cover a `<system_context>` tag typed by
   a collaborator.

### Test

1. Compose two consecutive turns for one session — a user turn, then a
   wait-resume turn — through `composeStructuredSystemMessage` on the new
   orchestration. Assert the system message is byte-identical. Revert the
   `turn.ts` change; the test must go red.
2. Force one `runTurn.throw` retry; assert the note appears exactly once in
   the retried prompt.
3. Field: re-run the chk analysis 24h after deploy, filtered by execution
   version (`sourceOrchestrationVersion` / the version in `session.turn_started`),
   NOT by session start. Distinct system-prompt sizes per session should
   drop; the residual is P1b's target.

---

### Measured on pilotswarm-aks (2026-08-30, before → after 1.0.71)

Same three prompts on both versions. Six 45-second `wait` cycles each:

| session | before (1.0.70) | after (1.0.71) |
|---|---|---|
| Sonnet 5, waits | 62–65% cached on every wake-up | 99% from the 2nd wake-up |
| gpt-5.6-sol, waits | 0% on every wake-up | 99% from the 3rd wake-up |
| Sonnet 5, child completions via `wait_for_agents` | 100% | 100% (control; never affected) |

The `session.prompt_sections` events named the one remaining mover:
`last_instructions` grows by exactly 491 chars at iteration 1 and never
again. That is `ensureTaskContext` appending the "[RECURRING TASK] Original
user request" block after the first turn — one guaranteed miss per session
(P1c, later: set it before the first turn). Also: same size is not same
content; a sol wake-up with a +0-char note still missed.

## P2 — wake a parent for child updates less often

### As built (1.0.71, 2026-08-30) — in the SAME version as P1a

- R1: `classifyChildUpdate` gets a `waitIsHeartbeat` flag on the snapshot;
  `turn.ts` sets it on the child's wait notification. A flagged wait is a
  heartbeat unless `material === true`, a non-heartbeat verdict hint, or the
  `QUESTION FOR PARENT:` coercion (that one must reach the parent or the
  child hangs). The `wait` tool takes `material?: boolean` in BOTH
  declarations and the flag rides the pendingAction into the result.
  Unflagged (≤1.0.70) snapshots keep the old rule, so replay is unchanged.
  Note: a wait result's `content` is the model's last reply text, NOT a
  deliberate message — it cannot be used as the material signal.
- R2: `queue.ts nextTimerCandidate` skips the digest candidate when the
  active timer is `wait|cron|cron_at` due within `CHILD_DIGEST_COALESCE_MS`
  (60s) and the digest carries no `failed|cancelled|deleted`. `processTimer`
  now calls `flushPendingChildDigestIntoPrompt` in the wait, cron and
  cron_at cases (all five `processPrompt` sites), so a held digest rides
  into that turn's prompt.
- R3: `childUpdateBatchMs(n) = clamp(30s, 15s × n, 300s)` in `state.ts`,
  applied at the candidate computation with `state.subAgents.length`.
- R4: `bufferChildUpdate` keeps one entry per child but a lifecycle update
  (completed/failed/cancelled/deleted) is never overwritten by a later
  wait/progress note (rank-based replace) — the existing "latest signal
  wins" test still holds for same-rank updates.
- Base prompt 1.18.0: tells children about `wait(..., material=true)` and
  parents that `check_agents` is a delta.

### Measured on pilotswarm-aks (2026-08-30, before → after P2+P3)

Identical prompt: a parent spawns 3 children (each five 40-second waits),
sets a 90-second cron, polls with `check_agents`.

| | before (P1 only) | after (P1+P2+P3) |
|---|---|---|
| parent turns | 6 | 4 |
| parent input tokens | 731K | 517K (−29%) |
| child-digest wake-ups | 2 | 0 |
| child wait notes suppressed | 0 | 5 per child, logged `classification=heartbeat` |
| completions delivered | own wake-ups | inside the cron turn (note grew 453→1,046 chars) |
| `check_agents` call 2 | full report | "1 changed" + 2 roster lines |
| outcome | ALL DONE | ALL DONE |

Tests: `test/local/child-wake-diet.test.js` (9: hold for cron in 45s,
no hold at 120s, failed child not held, idle timer not "will wake", 75s
window for five children, completion survives a later wait, child plain
wait sends nothing + records `child_update_suppressed`, `material:true`
reaches the parent, QUESTION FOR PARENT reaches the parent) and
`child-wait-heartbeat.test.js` (6, classifier). Red-checked: disabling the
hold fails the hold test.

### Today

```
1. A child finishes a turn → sends the parent [CHILD_UPDATE type=completed]   turn.ts:1082
   A child calls wait()   → sends the parent [CHILD_UPDATE type=wait]        turn.ts:1140
2. The child-side gate shouldWakeParentForChildUpdate() decides whether to
   send. Default policy material_change. A wait note with prose is
   "material" unless the text matches a heartbeat phrase
   (child-notifications.ts:194, isHeartbeatText :84)
3. The parent buffers updates for 30s (state.ts:204). The buffer keeps ONE
   entry per child; a second update from the same child replaces the first
   (lifecycle.ts:330-335)
4. queue.ts:200 nextTimerCandidate(): the digest timer races the parent's
   own timer (wait / cron / cron_at). Shorter wins.
5. If the digest wins, queue.ts:895-940 builds a wake-up note and the
   parent runs a full turn
6. flushPendingChildDigestIntoPrompt (lifecycle.ts:363) runs ONLY on the
   user-prompt drain path (queue.ts:504-505). A timer-fire turn
   (turn.ts processTimer) never flushes the digest
```

Furiosa (`0e1fe41f`, 690K-token context) had 18 child wake-ups carrying 41
updates: 20 `wait`, 20 `completed`, 1 `cancelled`. It woke three times in
two minutes (16:20:02, 16:20:44, 16:22:04), called `check_agents` once each
time, found nothing, and stopped. ~687K input tokens per wake-up. Across
the sample, child-triggered wake-ups that made no real tool call cost
28.7M tokens. (Cron and user turns that did nothing cost another 16M; P2
does not touch those.)

### Change (four parts)

**R1. A child's `wait` is a heartbeat by default — and `wait` gets a way to
say otherwise.** Today `turn.ts:1135-1137` sends
`{ kind: "wait", summary }` with no `material` flag and no verdict, and the
`wait` tool has no parameter to set one. So "the escalation path already
exists" is false for waits: after R1 a child could never interrupt its
parent from a `wait`. Furiosa's children are told to rely on
`wakeOn: material_change` and the parent is told not to poll
(fallback interval 300s; `0e1fe41f` fired its cron only twice in 23 turns).
So:
- Add `material?: boolean` to the `wait` tool schema (stub in
  `managed-session.ts` AND handler — copilot-instructions rule 5) and pass
  it through at `turn.ts:1136`.
- `classifyChildUpdate`: `kind === "wait"` → `heartbeat` unless
  `material === true` or a verdict is present.
- Tell children in the base prompt: "`wait({material: true})` when you have
  a finding the parent must see now."

**R2. If the parent will wake within 60 seconds anyway, hold the digest for
that wake-up.** `queue.ts:200` `nextTimerCandidate`: when `activeTimer.type`
is `wait | cron | cron_at` and `deadlineMs - now <= 60_000`, do not add the
`child-digest` candidate. (`idle`, `agent-poll`, `input-grace` do not run a
turn when they expire, so they do not count as "will wake anyway".)
Exception: a digest containing a `failed` or `cancelled` child keeps
today's behaviour. **And fix the flush:** call
`flushPendingChildDigestIntoPrompt` in each `processTimer` case (wait,
cron, cron_at; `turn.ts:1338-1470`) before `processPrompt`. Without that,
the held digest is not delivered on the timer turn and wakes the parent
separately right after — R2 would save nothing.

**R3. The 30-second window scales with fan-out.** Replace the constant with
`childUpdateBatchMs(state) = clamp(30_000, 15_000 × state.subAgents.length, 300_000)`
at `queue.ts:215`. Deterministic on replay: `nextTimerCandidate` reads only
replayed state plus `now`.

**R4. The digest keeps every update, not the last one per child.** With a
5-minute window a child's `completed` followed by its `wait` would today
overwrite the completion summary (`lifecycle.ts:330-335`). Append instead,
capped at 3 entries per child (oldest dropped), and render them in order.

Not doing: rewriting the digest text so the model can skip `check_agents`.
P3 makes `check_agents` cheap instead.

### Version rules

All of R1–R4 are orchestrator code or are called from it: new version. R1's
`classifyChildUpdate` is called by the CHILD's orchestrator
(`turn.ts:1135`), so the child's execution version governs. During the
hand-off window a child on 1.0.70 still sends `wait` notes and a parent on
1.0.71 still buffers them; nothing breaks, the saving just arrives when the
children hand off (≤10 iterations).

### Test

1. Unit: a `wait` update with prose → `heartbeat`; with `material: true` →
   `material`.
2. Replay test: parent with a cron due in 45s receives two child `completed`
   updates → no separate wake; the cron turn's prompt contains both. Same
   with the cron due in 120s → separate wake after the batch window. Same
   with a `failed` child and cron due in 45s → immediate wake.
3. Unit: two updates from one child inside one window → both rendered.
4. Field: Furiosa-shaped session on chk. Today 19 of 54 wake-ups do
   nothing. Target: 3 or fewer.

---

## P3 — `check_agents` returns only what changed

### As built (SDK, 2026-08-30)

Pure module `packages/sdk/src/check-agents-report.ts`
(`buildCheckAgentsReport(children, memo, {full})`), used by the live
`checkAgents` control bridge in `session-proxy.ts`. The memo is a CMS event
`session.check_agents_memo` `{at, perChild: {orchId: {status, hash}}}`,
read back with `catalog.getSessionEventsBefore(..., 5, [memoEvent])` (max
seq wins) and written fire-and-forget after each report; any read/write
failure yields the full report. Output capped at 1,000 chars with a pointer
to `read_agent_events`. `check_agents` takes `full?: boolean` in both
declarations. `orchestration/agents.ts:821` (pendingAction path) is left as
is. Tests: `test/unit/check-agents-report.test.mjs` (8).

### Today

The live handler is NOT `orchestration/agents.ts:821` (that path runs only
for the pendingAction route). It is `checkAgents` in
`session-proxy.ts:2316`, called from the control-tool bridge inside the
runTurn activity. It loads every direct child from CMS
(`loadDirectChildSessions()`, `:1553-1580`) and prints, per child, title /
status / contract / verdict / iterations / violations and
**`Output: agent.result` with no length cap**. On chk: 124 calls, median
5.5K chars, max 41K; Furiosa's average 12.7K with 84% of lines identical to
the previous call. Every copy stays in the transcript and is re-read on
every later model call.

`loadDirectChildSessions()` does not return `updatedAt`, and the
orchestrator's `state.subAgents` is not visible from the activity. So the
delta must be computed from state the activity writes itself.

### Change

```
1. Read the parent's check_agents memo from CMS:
     { lastSeenAt, perChild: { orchId: { status, resultHash } } }
   Write path: catalog.updateSession meta (management-client.ts:824) or
   the canvas KV (catalog.canvasKvWrite, :2088). One small JSON value.
2. For each child now:
     changed = memo missing
             OR status != memo.status
             OR sha1(result ?? error ?? "") != memo.resultHash
3. Changed children: today's full block, Output capped at 1,000 chars
   (the cap agents.ts:836 already uses)
4. Unchanged children: one roster line
     "  - Agent <orchId> · <status> · unchanged since <lastSeenAt>"
5. Header: "Sub-agent status report (N agents, K changed since <lastSeenAt>)"
6. Write the new memo. If the write fails, return the FULL report (fail
   open on information)
```

Optional argument `full: true` returns today's report. The tool description
says so, says `Output` is capped at 1,000 chars, and points at
`read_agent_events` for a child's complete result.

`orchestration/agents.ts:821` is orchestrator code. Do NOT change it with
the SDK-only ship; mirror the new shape there in the 1.0.71 cut.

### Consumers to check before shipping

- `isInternalSystemPrompt` (`session-proxy.ts:400`) matches the report by
  its first line; keep the `Sub-agent status report (` prefix.
- Manager prompts (waldemort `agent-manager`, `furiosa-hdb`; pilotswarm
  `default.agent.md`) tell the model to poll with `check_agents`. None
  parse the text, but they expect `Output` to be the child's final answer.
  Add one line to those prompts: "`check_agents` shows changes since your
  last call; use `full: true` or `read_agent_events` for everything."
- Tests that assert the report format (grep `Sub-agent status report` under
  `packages/sdk/test`).

### Not versioned

`session-proxy.ts` runs inside an activity. Its output is recorded, not
replayed. Ship it with the SDK, before the version cut.

### Test

1. Unit: three children, one changed → one full block, two roster lines;
   `full: true` → three full blocks.
2. Unit: `Output` over 1,000 chars is cut.
3. Unit: memo write fails → full report.
4. Field: Furiosa's `check_agents` results drop from ~12.7K chars to under
   3K on a quiet poll.

---

## Rollout

```
1. P3 (SDK-only, session-proxy.ts). Ship, watch chk transcripts shrink
2. P1b instrumentation (section hashes) — SDK-only, ship with P3
3. Freeze orchestration/ → orchestration_1_0_70/, register, bump
   DURABLE_SESSION_LATEST_VERSION to 1.0.71   (copilot-instructions.md:474)
4. P1a + P2 (+ the agents.ts mirror of P3) in 1.0.71. Full suite;
   multi-worker + chaos tests for replay
5. Release pilotswarm-sdk 0.5.52 → vendor into waldemort → deploy chk
   worker + portal (same path as v0.5.51 on 2026-08-30)
6. Re-run the chk analysis after 24h, filtered by execution version.
   Then read the section hashes and fix P1b
```

Every live session moves to 1.0.71 within ~10 iterations of the deploy, so
the field numbers should move within a day.

## Risks

- P1a: the Copilot CLI's own system-prompt sections can change between
  turns (`session.tools_updated` fires once per turn on `0e1fe41f`; the CLI
  adds board summary, memories and canvases to the prompt). The chk data
  says the prefix is stable enough to hit 93–99% when our note is absent,
  but P1b's hashes will show the truth.
- P2/R1: a child that has a real finding must now say `material: true` on
  its `wait`, or wait for its next completion. Prompts must teach this.
- P2/R2: a parent with no active `wait | cron | cron_at` timer is
  unaffected.
- P3: after a worker restart the memo is still in CMS, so the first call is
  still a delta. A stale memo can only cause a "changed" block to be shown
  once more, never hidden.

## Numbers not independently re-derived by the reviewer

"18 child wake-ups / 41 updates / 20 wait, 20 completed", "84% identical
lines", and "~687K per Furiosa wake-up" (consistent with the 649K average
input per call). Where the Anthropic `cache_control` marker sits could not
be read from the CLI bundle (native request builder); the 99% row is the
only evidence, and it is enough for P1a.
