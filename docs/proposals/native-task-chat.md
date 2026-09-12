# Tasks and waits in chat

Design proposal, 2026-09-08. Builds on the native Copilot subagent spike.
The native task cards and chronological warning cards are implemented on the
spike branch. Durable/async wait cards below remain deferred design work.

The implementation observes native tasks through bounded read-only registry
refreshes and existing lifecycle events. The portal receives latest-value
snapshots independently of assistant streaming; the TUI also renders compact
task summaries. Raw task-change notifications no longer become Activity rows.
Existing recordings reconstruct from lifecycle events and failed-turn summaries.

Local spike launchers must pass the app's `getPluginDirsFromEnv()` result as
the worker's `pluginDirs`, matching the portal's agent catalog. Without it,
the standalone SDK worker has no bundled DeepWiki definition even though the
portal lists it. Native `swarm-*` profiles and durable named agents remain
separate; a named durable spawn must provide `agent_name`.

## Proposed experience

Show native delegation as a compact, expandable task group in the conversation.
It appears at the point where Copilot delegates and updates in place. Keep the
assistant's explanation and final answer as ordinary chat messages.

Each row has:

- A status icon paired with a readable label, so color is never the only signal.
- A short task title taken from the dispatch description, falling back to its
  display name. The profile name belongs in expanded details.
- Elapsed time and tool-call count, when known. No fabricated completion
  percentage or ETA.
- One abridged progress line while running, or one result line after completion.
  Text wraps on narrow screens; long results remain behind the disclosure.

The group header reads `Native tasks` with a branching icon and counts such as
`1 running · 1 done`. The Native label identifies same-worker Copilot execution.
Use the product's theme colors: blue for running, green for done, amber for
waiting, red for failure, and muted styling for stopped/interrupted tasks.

Clicking a row reveals the task scope, profile, resolved model and reasoning,
result or error, and a short recent-activity list. A deeper action can focus the
existing Activity panel on that task. Do not insert the full child transcript
into the parent's chat or call another model just to summarize a task.

Show up to three task rows per group, prioritizing active and failed rows when
there are more, with a disclosure for the remainder. Do not reorder visible
rows on progress updates. Completed groups can collapse to a one-line count;
preserve the user's expansion choice while new events arrive. Each task's row
stays anchored at its original delegation, ahead of the resulting answer.

Group contiguous delegations from the same assistant message. A later narrated
delegation can create another group; grouping must not move work across user
messages or reorder the conversation. When there is no narrated assistant
message, the task group itself occupies the delegation's chronological slot.

## State semantics

| Display | Evidence | Presentation |
| --- | --- | --- |
| Starting | Native `task` requested but no child start confirmed | Quiet pending icon |
| Running | Child start or current task snapshot reports running | Running icon, elapsed time, latest intent/tool |
| Waiting | SDK reports idle without a confirmed terminal result | Pause icon; never equate idle with success |
| Done | Native completion confirmed | Check icon, duration, abridged result |
| Failed | Native failure or denied/failed parent task invocation | Error icon, concise reason, details available |
| Stopped | Cancellation attributable to the user or confirmed parent stop | Stop icon with reason |
| Interrupted | Worker/turn replacement confirms an unfinished native task was lost | Neutral interruption icon; no success claim |
| Reconnecting | Only the observation connection is stale | Retain last state with a stale indicator until reconciled |

A denied request must get a failed row even if no native agent ID was allocated.
One failed file read inside an otherwise successful investigation is a recovered
tool error in details, not a failed task. Optional token details should clearly
distinguish cumulative input, cached input, and context usage; omit them from the
abridged row.

Cleanup is not a user cancellation. The spike retires completed native agents
by cancelling/removing their reusable runtime records. Once completion is
confirmed, those bookkeeping operations must not change Done to Stopped or
erase the historical row. Absence from `tasks.list()` is not proof of completion.

## Use the task-change feed as a refresh signal

`session.background_tasks_changed` is an empty, ephemeral invalidation event in
the pinned SDK. It is useful for this feature, but is not itself a chat item.

The worker should:

1. Create/update task identity immediately from `task` invocation and
   `subagent.started`/`configured` events.
2. Coalesce task-change notifications over about 300 ms and read
   `session.rpc.tasks.list()`. Allow only one request in flight and retain a
   dirty flag for a trailing refresh; cap ordinary refreshes at two per second.
3. Refresh progress for active native agent tasks using
   `tasks.getProgress({ id })`. Its `latestIntent` and `recentActivity` fields
   already provide useful display data. Existing native tool events can supply
   the latest tool label and counts without additional RPCs on every tool call.
4. Publish a compact latest-value snapshot through the session's live channel.
   No additional model calls, client-to-CLI connection, or browser polling loop
   is needed. An elapsed-time display can tick locally.
5. Apply explicit completion/failure events promptly and retain the result from
   the parent task's completion output. Flush terminal summary state before
   cleanup removes the runtime task record and before the turn commits.

Do not call `tasks.waitForPending`, `refresh`, cancellation, or background
promotion just to paint the UI. Observation must not alter execution behavior.
Dispose observers/timers at session release. Tag reads with a session generation
and discard late responses from a replaced worker/session or older revision.
Bound observation RPCs and treat refresh/publish failures as stale telemetry;
they must not fail or hold open an otherwise successful model turn. Reconcile
on the next notification or viewer reconnect.

## Persistence, replay, and identity

Use the existing persisted native start/completion/failure events and the parent
task result as the historical source of truth. Add a bounded terminal summary
event only if the existing result shape cannot support reliable reconstruction;
do not persist every progress refresh. Remove empty task-change notifications
from the persistence path and hide already-recorded copies in Activity.

The compact view model should carry owner session ID, turn/attempt identity,
parent tool-call ID, native agent ID when available, original start sequence,
title, profile, status, timing, tool/error counts, progress/result preview, and
the terminal reason. Names are not unique identifiers. Correlate the initial
tool request with the eventual native agent instead of creating a second row.

Build the same task rows during historical replay and live append in the shared
history reducer. Reloading must not duplicate tasks, lose their anchor, or leave
an old task spinning indefinitely. Repeated and out-of-order notifications must
be idempotent. Pages beginning after a task's start need its persisted summary
or a correlated lookup, not an invented start time.

Live snapshots obey existing session ownership/access checks. Treat task text
as untrusted display content, bound preview lengths, and avoid putting shell
arguments, full prompts, environment data, or raw reasoning in the abridged row.
Screen readers announce state transitions, not every tool update or timer tick.
Respect reduced motion and preserve scroll position when rows update or expand.

## Scope and implementation

Start with native agent tasks. Their shell commands stay inside task details,
so a 35-tool investigation does not produce 35 chat cards. A later addition can
show long-running top-level commands with a Terminal indicator.

Durable PilotSwarm children remain separate sessions. If shown in this pattern,
label them `Agent session`, use a distinct network icon, and offer Open session.
Their state comes from PilotSwarm's session/child events, not Copilot's native
task registry. In particular, never present an ad-hoc child titled DeepWiki as
the registered DeepWiki agent unless its actual profile binding confirms that.

The first implementation would add:

- A worker task observer near `ManagedSession`, feeding a compact task snapshot
  alongside the existing live-turn publishing path in `session-proxy.ts`.
- Shared task derivation in `packages/app/ui/core/src/history.js`, used by both
  bulk replay and live append.
- Native task groups in the active portal chat renderer, plus a concise textual
  counterpart in the TUI. Preserve ordinary assistant streaming behavior.
- Filtering of empty task-change activity rows, including existing history.

No individual stop, steer, retry, or promote controls in this first pass: those
need their own lifecycle contracts. The existing parent Stop action continues
to stop native work through the spike's tested cancellation path.

## Acceptance checks

- Live start/progress/completion updates one row, with no blank activity spam.
- Many invalidations produce bounded RPC/publish traffic; a final event arriving
  during an in-flight refresh cannot be lost or overwritten by old data.
- A task denied before starting is visible as failed; recovered child tool
  errors do not turn successful work red.
- Done survives runtime cleanup, reload, history paging, and replay.
- Idle remains Waiting; stale transport remains Reconnecting; confirmed worker
  loss is distinguished from a successful result.
- Stop interrupts active children and preserves already completed task results.
- Multiple concurrent tasks with identical names remain distinct and correctly
  associated with their own parent tool calls and sessions.
- Expanded details and scroll position survive live updates; keyboard access,
  theme contrast, reduced motion, and a 360 px viewport remain usable.

## Extend the pattern to durable waits

Use the same compact rows, status icons, abridged text, and expandable details
for durable agent sessions, one-shot timers, schedules, and questions. Give each
kind its own state model. The Copilot task-change feed only describes native
work; durable waits come from PilotSwarm orchestration state and session events.

### What the system already knows

| Kind | Existing information | Small additions needed |
| --- | --- | --- |
| Agent sessions | Child session/orchestration IDs, task, bound agent ID, status, results, parent relationship; exact wait targets in durable state | Publish the resolved wait target IDs and a stable wait identity in structured status |
| Timer | Reason, duration, start time, active timer deadline, wait start/end events | Expose the authoritative current deadline and correlate start/end events |
| Schedule | Active flag, reason, interval or wall-clock kind, timezone, next wall-clock fire, fire counts, lifecycle events | Consistent next-fire deadline for interval schedules, stable schedule/cycle identity |
| Question | Question, choices, freeform policy, input-required event, pending question, answer API and queued-answer UI | Stable request ID/revision, with answer validation against the current request |

Source references in this checkout:

- `packages/sdk/src/types.ts`: `SubAgentEntry`, `SessionStatusSignal`.
- `packages/sdk/src/orchestration/agents.ts`: `wait_for_agents`,
  `isAgentWaitSettledStatus`, and `buildWaitForAgentsFollowup`.
- `packages/sdk/src/orchestration/turn.ts`: durable wait, input-required, timer
  resume, and `schedulePostTurnContinuation`.
- `packages/sdk/src/orchestration/lifecycle.ts`: `publishStatus` schedule fields.
- `packages/sdk/src/client.ts`: `getSession` pending question and timer fields.
- `packages/app/ui/core/src/selectors.js`: `buildPendingQuestionMessage` and
  `buildAnsweredPendingQuestionMessage`.

### Agent session waits

At dispatch, insert an `Agent sessions` group with a network icon. When the
parent calls `wait_for_agents`, annotate the existing rows in the current group
with `Waiting for results` and the exact targets. If it waits for sessions
dispatched earlier, show a compact wait card at the current conversation point
that references those sessions; do not move their original dispatch cards.

Show a count such as `1 result ready · 1 running`, followed by up to three
stable rows. Each row has its title, status, abridged latest response or result,
and an Open session action through existing session navigation/access checks.
Expanded details may show the task and actual named-agent binding. Do not use
the title as evidence of a binding. A parent waiting for one child must not
appear to wait for every child in the session tree.

Separate the lifecycle of the wait from the lifecycle of the child session:

- A durable child that is idle after answering is `Result ready`; it can
  satisfy the wait while remaining available for another prompt. If no answer
  is confirmed, use `Idle`, not an invented successful result.
- `input_required` means `Needs input`, not successful completion. It is a
  settled state for the barrier, allowing the parent to handle the question
  when the wait resolves. Do not silently route a child's question to the user
  if the parent is responsible for answering it.
- Running children and children sleeping on timers remain pending.
- Failures and cancellations stay visible as their own outcomes. The parent
  can resume to handle those outcomes; a resolved wait is not proof all work
  succeeded.

Use existing child session status/result updates without subscribing to every
descendant's full transcript. Prefer existing response previews; no model call
for summaries. The internal 30-second agent polling timer is an implementation
detail, not an ETA or a user-facing countdown. A durable wait survives worker
replacement; do not apply native-task interruption semantics to it.

### One-shot timers

Show `Waiting · Retry the deployment check`, with `Resumes at 18:45 · 2m left`
and a clock icon. Expanded details carry the original duration and reason.
`wait` and `wait_on_worker` share this presentation; worker affinity belongs in
details only if needed. Short waits performed inside the model turn remain
ordinary tool activity unless they become materially long.

Compute remaining time from the authoritative current deadline. In particular,
`getSession().waitingUntil` currently uses `Date.now() + waitSeconds`, so repeated
reads move that value forward. Fix that projection before using it for this UX.
Timer interruption/resumption can change the deadline; the original start
event alone is not always sufficient. At zero, show `Resuming…` until the
orchestrator confirms the transition. Do not claim the timer resumed a model
turn solely because the browser clock reached zero.

The worker and orchestration can both emit `session.wait_started`, with slightly
different affinity field names. Normalize and correlate those records to one
wait episode. Budget refusal or another actionable block should carry its real
reason, not look like an ordinary requested delay.

### Schedules

Keep one compact schedule card anchored where the schedule was established.
Show the reason, recurrence, timezone when relevant, next run, and most recent
outcome. During a run it reads `Checking now`; between runs, `Next check …`.
Quiet firings update that card instead of creating more chat messages.
Material findings remain ordinary assistant messages at their actual time.

A schedule is independent of the session's current activity: it can remain
active while the session works or asks a question. It must not permanently
show the parent as blocked. A one-shot timer ending and a schedule firing are
different events; one fire does not complete the schedule. Only cancellation
or exhaustion of a bounded schedule closes its card.

Interval scheduling can be relative to the end of a cycle. Describe it as
`Wait 15 minutes between checks` when that is the actual policy, not as a
fixed wall-clock cadence. If no next deadline is committed during a run, show
the recurrence without inventing a timestamp. Wall-clock schedules retain
their configured timezone in details even if the next fire is displayed locally.

Do not add Pause, Run now, Skip, or Stop schedule buttons until their command
semantics are verified. The existing Stop turn behavior can re-arm the schedule,
so it must not be presented as a way to stop monitoring.

### Questions

Upgrade the existing Question card into the same visual family, with a
`Needs your input` indicator, the complete question, choice controls, and a
freeform answer when permitted. Use the existing answer submission path.
Do not add a second question card alongside the current selector-generated one.

Choice selection does not submit automatically. Submission is explicit, and
`Answer queued` follows server acknowledgement; `Answered` follows consumption.
Preserve the answer draft during status updates. Repeated identical questions
must have different identities. Reject an answer to a stale request instead of
accidentally applying it to a newly raised question.

Show which session owns a question. Initially, child questions can be opened in
the child session; inline child answers require the same target identity,
authorization, and current-request checks. Worker hold/grace timers are not
deadlines for a human response and should not be displayed as such.

### Shared projection and incremental rollout

Add a typed, additive wait projection to the existing session status transport:
`id`, `revision`, `kind`, `startedAt`, `state`, and source-specific data such as
resolved child session IDs, canonical wake deadline, or question request ID.
Schedules need a separate projection because they can coexist with a current
wait. Persist stable identity and final outcome across continuation and replay;
publish changing status through the existing live channel. Do not parse
`waitReason` text to identify the kind or derive targets from all children.

Use one shared card renderer with distinct source adapters. The first version
can ship durable child waits, timers, schedules, and the existing question
experience without changing scheduling behavior. Question choice buttons and
new lifecycle controls can follow once the request identity contract is ready.
Keep this document design-only; orchestration changes will need the repository's
versioning workflow when implemented.

### Change footprint and responsiveness to prompts

Implement the projection as optional JSON fields on session status, durable
state, and correlated events. No new relational tables or columns are expected
for this scope. UI-only reconstruction is possible for a limited first pass,
but cannot reliably identify every wait episode and its resolved targets.
The complete design therefore includes small orchestration changes to publish
and retain that metadata, plus SDK/API types and UI reducers/rendering. Any
change to orchestration helpers must ship in a new orchestration version while
preserving frozen versions. Rendering old sessions must tolerate missing fields.
Question request validation additionally changes the answer contract; defer
that work if the first version only restyles the existing question experience.

Durable waits already accept new prompts. `queue.ts:drain` races the next timer
against the message queue, and `popNextDispatchFifoItem` prefers queued prompts
and answers over queued timers. Do not introduce a modal overlay, disable the
composer because status is `waiting`, or make sending wait for a card refresh.
Message receipt, worker activation, and model response are distinct stages;
normal worker availability and rehydration latency still apply.

The card must reflect the existing interruption behavior:

- A prompt during an agent wait clears `waitingForAgentIds` and the agent-poll
  timer. It does not cancel the children. Close that wait episode as
  `Interrupted by your message`, keep the child task rows live, and show the
  parent's response normally. A later `wait_for_agents` creates another wait
  episode. Do not promise automatic restoration of the old barrier.
- A prompt during a one-shot timer preserves the remaining duration, runs the
  user's turn, then ordinarily resumes that remaining duration. The countdown
  must pause/update accordingly, and the original wall-clock deadline can move.
- An interval cron wait likewise preserves its remaining interval across the
  interactive turn. A wall-clock schedule preserves its scheduled timestamp;
  if that time passes during the response, the fire runs afterward. Existing
  explicit cancellation/reset and terminal-session behavior still apply.
- A pending user question uses the existing answer path. Currently the main
  composer treats its submission as the answer; independently sending an
  unrelated prompt while a question is pending would require an explicit
  routing affordance.

This responsiveness claim concerns durable waits between model turns. Native
synchronous Copilot delegation remains inside an active parent model turn;
giving it the same prompt-interruption semantics would be separate work.

Test prompt arrival before and at timer expiry, during child completion, and
after worker release. Assert prompt receipt is visible without waiting for
task telemetry; child sessions continue after the parent wait is interrupted;
and resumed timers/schedules retain their existing semantics.

Additional acceptance checks:

- A subset wait shows only its resolved targets, including targets inferred
  when the tool omitted explicit IDs.
- Child idle with an answer, child question, failure, and cancellation preserve
  their distinct meanings while allowing the parent's actual wait to resolve.
- Repeat waits on the same child produce distinct episodes without duplicate
  dispatch rows; historical rows keep the outcome of their own episode.
- Waits and schedules survive worker replacement, reconnect, history paging,
  and orchestration continuation without false interruption or new cards.
- Timer countdowns do not reset on polling; interrupt/resume uses the updated
  deadline. Duplicate start events do not create duplicate cards.
- Quiet schedule cycles update in place; a fire does not end a schedule; a
  pending question can coexist with an active schedule.
- Repeated question text cannot collide; stale answers cannot target a new
  request; queued and consumed answers remain distinguishable.
