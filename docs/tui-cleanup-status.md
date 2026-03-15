# TUI Cleanup Status

This note captures the current TUI stabilization work in progress, what has already
been tightened up, what is still fragile, and the order of the next cleanup passes.

## Goal

The current TUI is useful, but it has been carrying several classes of fragility:

- session switches can race with history reloads and live updates
- database-loaded transcript history can mix with live observer output
- input-required prompts and interrupts can get routed using stale global UI state
- worker/stdout noise can leak into the terminal UI
- render artifacts can leave stale characters behind after pane changes

The immediate goal of this cleanup pass is to make the TUI deterministic and
session-scoped first. Visual repaint artifacts are being treated as a separate
rendering problem and are not the primary focus of the current cleanup track.

## Completed So Far

### 1. Session history reloads are now session-scoped and generation-safe

`loadCmsHistory()` now uses:

- `sessionHistoryLoadGeneration`
- `sessionRenderedCmsSeq`
- `sessionRecoveredTurnResult`

This reduces the old class of bugs where:

- a slow history reload finished after the user already switched elsewhere
- live observer output got overwritten by a later DB reload
- completed turn content was rendered twice, once from live status and once from CMS

### 2. CMS event dedupe is now per session instead of global

The old `_cmsRenderedSeqs` global dedupe set has been removed. The active CMS poller
now dedupes using per-session rendered sequence tracking.

This makes session switching less likely to cross-contaminate transcript state or
skip valid events from a different orchestration.

### 3. Input routing is now per-session instead of global

The old global `turnInProgress` approach was too coarse. The TUI now tracks:

- `sessionPendingTurns`
- `sessionPendingQuestions`

This makes it much safer to:

- switch away from a session and come back later
- answer an `input_required` question after navigation
- send an interrupt to a busy session without depending on one global UI flag

### 4. Pending-question handling is tied to the originating session

`pendingUserInput` now carries the originating orchestration id. User answers are
sent back to the session that asked the question, not whichever session happens to
be active by the time the user types.

### 5. Session switching restores buffers first, then reloads history

`switchToOrchestration()` now:

- stops the active CMS poller
- restores cached chat/activity buffers immediately
- starts or resumes the observer for the selected orchestration
- reloads CMS history in the background
- restarts CMS polling only for the active session

This improves responsiveness and makes the switch path less destructive.

### 6. Worker log noise has been reduced

Two raw SDK diagnostics were removed from `packages/sdk/src/managed-session.ts`, and
the TUI also filters older worker log lines that match the old debug patterns.

This reduces terminal corruption from unexpected stdout/stderr-style noise while
the alt-screen UI is active.

### 7. Chat/activity pane updates are more buffer-driven

The TUI now leans more on per-session buffers plus invalidate helpers instead of
direct widget mutation during every async path. This does not fully solve the
rendering artifact issue, but it does make transcript state easier to reason about.

## Current Open Issues

### 1. Render artifacts after session switch

This is the main unresolved visual problem.

Current status:

- disabling `smartCSR` helped some cases
- a full hard repaint removed more artifacts but flickered too much
- a shared lightweight refresh path is now being tried instead

This remains mostly a rendering-layer problem, not the highest-leverage state
cleanup problem.

### 2. Transcript consistency still needs more QA

The worst race conditions are reduced, but we still need to hammer on:

- history reload while live updates are arriving
- switching between active sessions rapidly
- expanding history while the session is still live
- live status recovery after dehydrate/resume cycles

### 3. Interrupt and resume flows need more end-to-end validation

The routing model is better now, but we still need broader validation on:

- busy-session interrupts
- answer-after-switch flows
- resume after long idle/waiting periods
- terminal orchestration states and retry paths

## Deliberately Deferred For Now

The following is intentionally not the main focus of the next cleanup pass:

- the stray-character rendering issue

It is still real, but it is being treated as a separate rendering problem so the
core session/state cleanup can keep moving.

## Next Cleanup Steps

### Next pass: non-rendering fragility

Focus on state correctness and simpler control flow:

1. Audit the observer/CMS handoff around turn completion and input-required states.
2. Reduce remaining global state in the TUI where session-scoped state is more correct.
3. Tighten error handling around send/interrupt/answer flows.
4. Add a small reproducibility checklist for session-switch, interrupt, and history-load cases.

### After the TUI cleanup pass

Move to runtime hardening:

1. simplify and harden the main orchestration loop
2. use newer Duroxide key-value store capabilities where they meaningfully reduce complexity
3. review prompt and tool contracts to make session behavior more predictable

## Files Most Relevant To This Cleanup

- `packages/cli/cli/tui.js`
- `packages/sdk/src/managed-session.ts`

Key TUI areas:

- `loadCmsHistory()`
- `startObserver()`
- `startCmsPoller()`
- `switchToOrchestration()`
- `handleInput()`

## Suggested Working Order From Here

1. finish the remaining non-rendering TUI cleanup
2. run focused manual repros on session switching, history expansion, answers, and interrupts
3. only then come back to the render artifact issue if it is still worth the tradeoff
4. move on to orchestration-loop hardening and prompt/tool cleanup
