# TUI Technical Design Spec

## Status

Proposed.

## Audience

Maintainers implementing or refactoring the PilotSwarm terminal UI.

## Context

The current TUI is implemented as a single large file in `cli/tui.js`. It works, but its internal architecture is fragile in three recurring ways:

- Snapshot-vs-stream updates are merged by several separate code paths, with custom status, CMS history reloads, and live CMS event polling each mutating rendered buffers directly.
- Buffer ownership is ambiguous. Some code treats maps such as `sessionChatBuffers`, `sessionActivityBuffers`, `seqEventBuffers`, `workerLogBuffers`, and `orchLogBuffers` as durable state; other code treats blessed panes as mutable state and writes to them immediately.
- Rendering has duplicate paths. The frame loop coalesces screen renders, but multiple features still call `pane.log()`, `pane.setContent()`, `screen.render()`, and `screen.realloc()` directly.

This document defines a cleaner target design grounded in current behavior and constraints from PilotSwarm and duroxide.

The user-facing TUI spec was not present when this document was written. This design therefore derives required behavior from the existing TUI, `docs/tui-apps.md`, and the runtime architecture.

## 1. Goals And Non-Goals

### Goals

- Make session switching deterministic and fast.
- Establish a single source of truth for TUI state that is independent from blessed widget state.
- Remove duplicate render paths so every visible pane is derived from state, not incrementally hand-mutated.
- Make snapshot-vs-stream reconciliation explicit, testable, and bounded.
- Preserve the current feature set: multi-session chat, activity pane, worker logs, orchestration logs, sequence view, node map, markdown viewer, system sessions, model selection, command responses, and artifact download flows.
- Keep the TUI within the public PilotSwarm client and management boundaries. The TUI may read logs for observability, but must not reach into internal runtime modules.
- Create module seams that allow incremental extraction from `cli/tui.js` without a big-bang rewrite.

### Non-goals

- Replacing `neo-blessed`.
- Redesigning the user-facing interaction model.
- Changing PilotSwarm runtime semantics, CMS schemas, or orchestration behavior to accommodate the TUI.
- Solving durable runtime bugs in the TUI layer. If a problem is rooted in duroxide or runtime event semantics, the fix belongs there.
- Converting the TUI into a general-purpose app framework in this refactor. `docs/tui-apps.md` can continue to describe a future adapter model, but this design is for stabilizing the current TUI first.

## 2. Architectural Constraints From PilotSwarm And Duroxide

The TUI must conform to the following runtime realities:

- The TUI is a client of PilotSwarm, not part of the worker/runtime core. It must only use public client and management APIs plus external log streams for diagnostics.
- CMS is the source of truth for session catalog data, persisted message history, titles, parent-child relationships, and status versions.
- Duroxide custom status is live, ephemeral execution state. It is useful for responsiveness, but it is not an authoritative replay log.
- Worker logs are diagnostic only. They are not a correctness source for chat history or activity state.
- Orchestration status can reset or continue-as-new. The TUI must tolerate version resets and repeated live status snapshots.
- Sessions are long-lived and may migrate between workers after dehydration. Any node-affinity visualization is observational, not authoritative.
- Multiple sessions can update concurrently. The UI may only have one active session, but background sessions continue receiving live status changes.
- CMS history can lag live custom status. The TUI must therefore reconcile a persisted snapshot with later live observations without duplicating content.

These constraints imply a simple rule: persisted session content comes from CMS, live execution hints come from custom status, and diagnostics come from logs. The TUI must not confuse those channels.

## 3. Proposed Internal Architecture For The TUI

The target design is a small set of modules with explicit responsibilities.

### 3.1 Module layout

- `cli/tui/index.js`
  Starts the app, wires dependencies, owns process lifecycle.
- `cli/tui/app-state.js`
  Defines the in-memory state tree and reducer-style update functions.
- `cli/tui/controllers/session-controller.js`
  Session selection, session creation, rename/delete/cancel, session list refresh.
- `cli/tui/controllers/history-controller.js`
  CMS history loading, watermarks, replay reconciliation, active CMS poller.
- `cli/tui/controllers/observer-controller.js`
  Per-session live status observers, command-response handling, intermediate content promotion rules.
- `cli/tui/controllers/log-controller.js`
  Worker log streaming/tailing, orchestration log indexing, sequence-event derivation, node map data.
- `cli/tui/controllers/input-controller.js`
  Keyboard handling, prompt submission, slash commands, modal state.
- `cli/tui/render/view-models.js`
  Pure functions that convert app state into pane-specific render models.
- `cli/tui/render/blessed-renderer.js`
  The only module allowed to mutate blessed widgets.
- `cli/tui/render/frame-loop.js`
  Dirty-region scheduler and render coalescing.
- `cli/tui/services/pilotswarm-api.js`
  Thin adapters over `PilotSwarmClient` and `PilotSwarmManagementClient`.
- `cli/tui/services/markdown.js`
  Markdown rendering and link styling.
- `cli/tui/services/perf-trace.js`
  Perf tracing, counters, debug exports.

### 3.2 Architectural pattern

The TUI should follow a unidirectional data flow:

1. External input arrives from keyboard, CMS, management API, live observer, or log stream.
2. A controller converts that input into state mutations.
3. State mutations mark one or more view models dirty.
4. The frame loop asks pure selectors to build pane content from state.
5. The blessed renderer applies the minimal widget mutations.

No controller may write directly to blessed panes. No data service may mutate state. No renderer may fetch data.

## 4. State Model And Single-Source-Of-Truth Rules

The state tree should be explicit and normalized.

### 4.1 Root state

```js
{
  ui: {
    activeSessionId,
    focusedPane,
    logViewMode,
    mdViewActive,
    modal,
    startupLandingVisible,
    turnInProgress,
    layout,
    statusBarText,
  },
  sessions: {
    byId: Map<orchId, SessionRecord>,
    orderedIds: string[],
    selectedListId,
    collapsedParents: Set<string>,
  },
  history: {
    chatBySession: Map<orchId, ChatTranscript>,
    activityBySession: Map<orchId, ActivityTranscript>,
    cmsCursorBySession: Map<orchId, CmsCursor>,
    activeCmsPollerSessionId,
  },
  live: {
    observerBySession: Map<orchId, ObserverState>,
    statusBySession: Map<orchId, LiveStatus>,
    pendingCommands: Map<cmdId, PendingCommand>,
  },
  diagnostics: {
    workerLogsByWorker: Map<workerId, WorkerLogBuffer>,
    orchLogsBySession: Map<orchId, OrchestrationLogBuffer>,
    sequenceBySession: Map<orchId, SequenceBuffer>,
    nodeAffinityBySession: Map<orchId, NodeAffinityState>,
  },
  assets: {
    markdownFiles,
    artifactsBySession,
  }
}
```

### 4.2 Source-of-truth rules

- `sessions.byId` is the only source of truth for session metadata visible in the left pane.
- `history.chatBySession` is the only source of truth for chat content.
- `history.activityBySession` is the only source of truth for activity-pane content.
- `live.statusBySession` is the only source of truth for live badges and status-bar summaries.
- `diagnostics.*` stores diagnostic representations only. Diagnostic data must never be used to rebuild canonical chat or activity transcripts.
- Blessed widget state is never authoritative. Widgets are caches of rendered state only.

### 4.3 Buffer ownership rules

Each buffer has one owner.

- Chat transcript owner: history controller.
- Activity transcript owner: history controller for CMS events, observer controller for live-only activity entries.
- Sequence buffer owner: log controller.
- Worker log and orchestration log owners: log controller.
- Status bar owner: session controller and observer controller through a shared state update API.

If two modules need to affect the same pane, they must write different logical inputs into shared state and let selectors combine them. They must not both write rendered strings into the pane.

## 5. Event, Render, And Data-Flow Model

### 5.1 Input channels

There are exactly five event channels:

- User input: keypresses, prompt submissions, slash commands, modal actions.
- Session catalog updates: `listSessions()` refreshes via management client.
- Live execution updates: `waitForStatusChange()` observer results.
- CMS event stream: active-session persisted event polling/subscription.
- Diagnostic log stream: local tail or `kubectl logs`.

### 5.2 Processing rules

- Session catalog updates may only update session metadata, tree structure, change markers, and cached live-state fallbacks.
- Live execution updates may only update live status, command responses, provisional activity entries, and provisional assistant output markers.
- CMS event updates may only append persisted history and persisted activity entries.
- Log updates may only update diagnostic views.
- User input may trigger service calls and state changes, but never direct pane mutation.

### 5.3 Render model

Each pane gets a pure selector:

- session list selector
- chat pane selector
- activity pane selector
- worker logs selector
- orchestration logs selector
- sequence selector
- node map selector
- markdown viewer selector
- status bar selector

Selectors output plain render data, for example:

```js
{
  label,
  lines,
  scrollIntent,
  emptyState,
}
```

The blessed renderer applies that model. No selector performs I/O, markdown parsing side effects, or session mutation.

## 6. Boundary Between Runtime Data, CMS History, Live Status, And Rendered Buffers

This boundary must be strict.

### 6.1 Runtime data

Runtime data means session metadata and live orchestration status from the management API.

- Use it for session existence, titles, parent-child structure, created-at timestamps, `statusVersion`, and live state badges.
- Do not use it to rebuild chat text except for narrowly defined provisional content from live `turnResult` when CMS has not caught up.

### 6.2 CMS history

CMS history is the canonical persisted transcript.

- Chat transcript is derived from `user.message` and `assistant.message` events only.
- Activity transcript is derived from persisted non-chat events such as tool execution events and explicit session events.
- CMS history rebuild replaces the persisted portion of a transcript, then re-applies any still-provisional live content according to the dedup rules below.

### 6.3 Live status

Live status is provisional.

- `intermediateContent` and live completed `turnResult` may be surfaced immediately for responsiveness.
- Provisional entries must be tagged in state with an origin of `live-status` and a reconciliation key.
- When equivalent persisted CMS events arrive later, the provisional entry is removed or marked reconciled.

### 6.4 Rendered buffers

Rendered buffers are view artifacts.

- `chatBox`, `activityPane`, and right-pane widgets render from transcript state and view models.
- Widgets must not contain data that does not also exist in app state.
- Scroll position is UI state, not content state.

## 7. Rules For Session Switching, Observer Updates, CMS Reloads, And Deduplication

This section is the core of the refactor.

### 7.1 Session switching invariants

- Changing `ui.activeSessionId` is a single atomic state transition.
- Session switch never clears canonical buffers. It changes which session selectors read from.
- On switch, the renderer immediately paints cached state for the new session.
- Any background fetch triggered by the switch is keyed by session ID and discarded if that session is no longer active when the fetch completes.
- Only one active CMS poller exists at a time, always bound to `ui.activeSessionId`.
- Observers remain per-session and continue updating background session state even when inactive.

### 7.2 Snapshot-vs-stream rules

Define transcript layers for each session:

- Base layer: most recent persisted CMS transcript.
- Provisional layer: live-only entries not yet confirmed by CMS.
- Derived render layer: base plus provisional, in chronological order.

The UI renders `base + provisional`. Controllers never manually carry forward raw rendered lines.

### 7.3 Dedup keys

Every appendable transcript item needs a stable identity.

- CMS-backed items use `evt.seq` when available, otherwise `eventType + createdAt + normalized payload hash`.
- Live status completed turn results use `iteration + normalized content hash`.
- Live intermediate content uses `iteration + normalized content hash + 'intermediate'`.
- Activity rows use structured keys, not raw rendered strings.

### 7.4 Reconciliation rules

- If live provisional assistant content matches a later CMS `assistant.message`, drop the provisional copy.
- If a CMS reload produces the same or newer persisted cursor than before, rebuild the base transcript and then re-apply only provisional entries whose keys are still unmatched.
- If observer version resets because of continue-as-new, reset observer-local cursors but do not clear persisted transcript state.
- If the active CMS poller emits an event already present in base transcript, ignore it.
- Sequence view dedup is independent from chat dedup. Diagnostic replay does not share identity keys with canonical chat entries.

### 7.5 Observer update rules

- Observers may update live status for any session.
- Observers may append provisional transcript items for any session.
- Observers may not mutate rendered panes directly.
- Observers may not infer persisted history progress from widget content length or rendered line counts.

### 7.6 CMS reload rules

- CMS reload rebuilds structured transcript items first, then derives rendered lines.
- CMS reload never reads from blessed panes.
- CMS reload may be skipped by freshness policy, but that policy must be based on timestamp and cursor state, not on whether the pane “looks populated”.
- A forced reload invalidates only the CMS base layer for that session, not observer state or diagnostics.

## 8. Error Handling And Degraded-Mode Behavior

The TUI must continue operating when one data source degrades.

### 8.1 Database or CMS unavailable

- Keep the process alive.
- Keep the last rendered session state on screen.
- Freeze session metadata refresh and CMS history polling.
- Continue diagnostic log streaming if available.
- Surface a clear status bar error with next retry timing.
- Mark session list freshness as stale rather than blanking the list.

### 8.2 Management status unavailable

- Keep existing session list and transcripts.
- Mark live badges as stale.
- Retry on the normal observer cadence.

### 8.3 Worker log stream unavailable

- Degrade only worker/orchestration/sequence/node-map panes.
- Chat and activity panes continue from CMS and custom status.
- Expose a clear “diagnostic stream unavailable” indicator in the affected pane.

### 8.4 Markdown render or artifact failures

- Show raw text fallback.
- Record the error in perf trace and the activity/debug output.
- Do not poison session transcript state with renderer exceptions.

### 8.5 Session-specific failures

- Failure in one session observer must not terminate other observers.
- Failure loading one session’s CMS history must not clear that session’s existing cached transcript.

## 9. Instrumentation And Diagnosability Expectations

The current perf trace is useful and should become more structured.

### 9.1 Required counters and spans

- session switch start/end, including cache-hit vs CMS-reload timings
- CMS history load timing, event count, base transcript item count, provisional item count, dedup count
- observer wait timing, version transitions, iteration transitions, provisional appends, reconciliations
- render frame timing by pane and total render time
- widget mutation counts per frame
- worker log ingest count and dropped-line count
- sequence-buffer size, chat-buffer size, activity-buffer size

### 9.2 Required debug surfaces

- A debug dump command that serializes current app state excluding secrets
- A concise per-session diagnostic summary: base transcript cursor, provisional keys count, last CMS event seq, last live version, last live iteration
- A visible stale-data marker for session list and active transcript when their upstream source is offline

### 9.3 Logging expectations

- Trace state transitions, not just raw errors.
- Log dedup decisions with keys when debug tracing is enabled.
- Avoid logging entire assistant outputs unless explicitly in debug mode.

## 10. Refactoring Seams And Module Boundaries

The monolith should be split along ownership lines, not arbitrary line-count boundaries.

### 10.1 First-class seams

- API seam: all PilotSwarm and management client calls behind a service adapter.
- State seam: a central state store with update functions.
- Render seam: selectors and blessed renderer separated from controllers.
- Transcript seam: structured transcript items instead of free-form line arrays.
- Diagnostics seam: worker/orchestration/sequence views isolated from canonical session history.

### 10.2 Explicit anti-seams

These are patterns to remove during refactor:

- calling `pane.log()` outside the renderer
- calling `screen.render()` from controllers
- using rendered line counts as correctness watermarks
- using `activeOrchId` snapshots as a substitute for request-scoped ownership
- storing dedup state as ad hoc globals that are shared by unrelated panes

## 11. Migration Plan From Current Monolith

This should be done incrementally with behavior preserved after each phase.

### Phase 1: State and renderer extraction

- Introduce `app-state.js` and move all top-level maps and sets into a single exported state object.
- Introduce `blessed-renderer.js` and route all direct `screen.render()` calls through the frame loop module.
- Freeze a rule that only renderer code mutates widgets.

### Phase 2: Structured transcripts

- Replace `sessionChatBuffers` and `sessionActivityBuffers` string arrays with structured transcript items.
- Add selectors that convert structured items to rendered lines.
- Preserve existing UI output while removing direct buffer-to-widget writes.

### Phase 3: History and observer controllers

- Move `loadCmsHistory`, CMS poller logic, and observer logic into dedicated controllers.
- Replace watermark-based line carry-forward with base/provisional transcript reconciliation.
- Keep the current active-only CMS poller policy.

### Phase 4: Diagnostic views

- Extract worker log, orchestration log, sequence, and node map logic into the log controller.
- Ensure diagnostic buffers never affect chat or activity correctness.

### Phase 5: Session controller and tree model

- Extract session list refresh, collapse/expand state, selection restore, and session switch handling.
- Replace direct list item rebuilding scattered across the file with list selectors.

### Phase 6: Input and modal handling

- Extract prompt, slash commands, model picker, rename modal, markdown viewer interactions, and artifact actions.

### Phase 7: Verification pass

- Add tests around transcript reconciliation, session switching, continue-as-new observer resets, and stale-source degraded mode.
- Only after state and render paths are unified should further UX changes be made.

## 12. Risks And Open Questions

### Risks

- The current implementation encodes behavior in rendered strings. Extracting structured transcript items will surface implicit assumptions that need explicit schemas.
- Sequence view currently mixes CMS-seeded synthetic events with log-derived events. If left implicit, this will remain a source of confusing duplication.
- Session switching performance can regress if selectors rebuild large transcripts naively on every frame.
- Some features depend on timing-sensitive behavior during startup and reconnect; extraction must preserve those orderings.

### Open questions

- Should the active-only CMS poller remain the long-term design, or should inactive sessions get a low-frequency persisted-event sweep for better background accuracy?
- Should sequence view keep CMS-seeded synthetic events, or should it explicitly present “persisted history” and “live runtime trace” as separate layers?
- Do we want to formalize transcript item schemas in TypeScript even though `cli/tui.js` is currently JavaScript?
- Should the TUI keep supporting direct local log tailing and remote `kubectl` streaming through one controller, or split them behind separate transport adapters?

## Implementation Invariants Summary

The refactor should preserve these simple invariants:

- One canonical state tree.
- One renderer that owns blessed mutations.
- One active CMS poller.
- One observer per live session.
- One canonical transcript per session, split into base persisted items and provisional live items.
- Diagnostic buffers never determine canonical chat or activity output.
- Session switch changes selection state immediately and never waits on I/O to show cached content.

These invariants are intentionally simple. The current fragility comes from violating them in several small places rather than one large design flaw.