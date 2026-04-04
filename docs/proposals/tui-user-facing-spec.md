# PilotSwarm TUI User-Facing Product Spec

## Status

Draft

## Purpose

- Define the user-facing contract for the PilotSwarm terminal UI.
- Describe what the TUI is for, what users can expect it to do, and how it should behave under normal and degraded conditions.
- Provide a spec maintainers and contributors can implement against even if the internal architecture, data sources, or pane layout are cleaned up.

## Non-Goals

- This is not an implementation design for the current host implementation, CMS, duroxide, or Kubernetes log plumbing.
- This is not a complete internal architecture spec for management APIs or orchestration internals.
- This does not require preserving the current monolithic code structure or exact pane implementation.
- This does not treat every current debug surface as permanently required; it defines the user value those surfaces must provide.

## Primary User Personas

### 1. Operator

- Runs PilotSwarm locally or against a deployed environment.
- Needs to create sessions, send prompts, monitor progress, inspect results, and recover after interruptions.
- Values speed, clear status, and confidence that work is not lost.

### 2. Maintainer

- Uses the TUI to understand whether the system is healthy and whether sessions are progressing correctly.
- Needs visibility into session state, activity, and runtime behavior without dropping to raw databases or ad hoc scripts for common cases.
- Values accurate status, useful diagnostics, and predictable degraded behavior.

### 3. Contributor / Agent Author

- Uses the TUI to exercise agents, tools, models, and artifacts during development.
- Needs to verify session behavior, inspect activity, switch models, and understand what the user experience should be.
- Values a stable interaction model and a clear boundary between product UX and implementation detail.

## Primary Workflows

- Start the TUI and connect to a local or remote PilotSwarm environment.
- See existing sessions quickly and determine which ones are running, waiting, completed, failed, or special system sessions.
- Create a new session and begin a conversation immediately.
- Switch between sessions without losing history, scroll position expectations, or the ability to resume work.
- Observe active work through chat output, status text, recent activity, and optional diagnostic views.
- Rename, cancel, complete, or delete sessions from the session list.
- Inspect model/session metadata when needed.
- Download and read artifacts produced by agents.
- Recover from transient database, worker, or network interruptions without corrupting the user’s view of session state.

## Core User-Facing Capabilities

### Session management

- The TUI must show a session list that acts as the primary navigation surface.
- Users must be able to create a new session from the keyboard.
- Users must be able to create a new session with a chosen model when model selection is available.
- Users must be able to switch the active session from the session list.
- Users must be able to rename a session with either a custom title or a generated summary.
- Users must be able to cancel an in-flight session.
- Users must be able to mark a session done or otherwise close out the work from the UI when that concept is supported by the runtime.
- Users must be able to delete a session when deletion is supported, with clear handling for protected or non-deletable sessions.

### Conversation and output

- The active session must have a chat view that shows user and assistant messages in chronological order.
- Markdown output must be legible in the terminal and preserve important structure such as headings, lists, code blocks, links, and emphasis.
- The chat view must support scrollback and must not unexpectedly jump while the user is reading older content.
- Messages recovered from persisted history and messages arriving live must appear as one coherent timeline.
- The TUI must avoid showing duplicated final answers, duplicated tool completions, or stale turn output after reconnect, resume, or orchestration rollover.

### Activity and diagnostics

- The UI must expose a concise activity view for the active session showing recent non-chat progress such as tool activity, reasoning markers, turn boundaries, or status transitions.
- The UI may expose richer diagnostic views such as worker logs, orchestration logs, sequence diagrams, or node maps.
- Diagnostic views are secondary to the chat workflow and must not block normal session use.
- If diagnostic data is unavailable, the rest of the TUI must continue to function.

### Commands and model controls

- The TUI must provide a command entry path through the input bar and slash commands.
- Users must be able to discover available slash commands from inside the TUI.
- Commands that change model or session behavior must report the resulting state clearly in chat, status, or session metadata.

### Artifacts and exports

- If a session produces downloadable artifacts, the TUI must surface that fact from the conversation stream in a recognizable way.
- Users must be able to open an artifact picker for the active session.
- Downloading an artifact must produce a local file path and a visible success or failure result.
- The TUI may provide a built-in markdown viewer for downloaded session artifacts or dumps.
- Export and dump actions must not destroy the session or mutate its conversation history.

## Information Architecture

## Screen model

- The default screen model is a multi-pane workspace with:
  - a session list
  - an active-session conversation pane
  - an input area
  - a status line
  - a secondary diagnostics area
- The current implementation uses a left-column session and chat layout plus a right-side diagnostics area with a sticky activity pane. A redesign may change the geometry, but these user-facing functions must remain addressable.
- One session is always the active context for chat, input, activity, artifacts, and most metadata actions.
- Secondary surfaces such as command pickers, model pickers, rename dialogs, artifact pickers, and markdown viewers may appear as overlays or focused temporary modes.

## Required user-visible surfaces

### Session list

- Shows the available sessions.
- Shows a label, state, and enough visual distinction to identify the active selection.
- Distinguishes special system sessions from normal user sessions.
- Supports refresh and keyboard navigation.

### Chat pane

- Shows the active session transcript.
- Is the primary reading surface.
- Supports scrolling independently from other panes.

### Input bar

- Is the primary compose surface.
- Accepts free-form text.
- Supports slash command entry and command discovery.
- Must make it obvious when the user is typing versus navigating.

### Status line

- Shows the current short-lived operational state.
- Must be used for transient feedback such as connecting, waiting, downloading, errors, and mode switches.
- Must not be the only place where durable or important information is communicated.

### Activity view

- Shows recent session activity separate from the user-facing transcript.
- Must remain concise and recent rather than becoming a raw append-only dump.

### Diagnostic views

- Provide runtime-oriented perspectives such as per-worker logs, orchestration logs, sequence flow, or node mapping.
- Users must be able to switch diagnostic modes from the keyboard.
- The currently selected diagnostic mode must be visible.

### Document / artifact viewer

- Provides in-TUI reading for exported markdown artifacts and session dumps when available.
- Must have a clear entry and exit path.

## Session Model From A User Perspective

- A session is the durable unit of work and conversation.
- A session has an identity, title, model, current state, and message history.
- Users should expect a session to survive TUI restarts and worker movement unless it is explicitly deleted.
- Users may resume old sessions and continue the conversation from prior context.
- A session may be idle, waiting, running, done, cancelled, or failed.
- The TUI must present these states in user language without requiring knowledge of orchestration internals.
- A session may move between workers or be rehydrated behind the scenes. From the user’s perspective, this must look like continuity of the same session, not a new conversation.
- If a session cannot currently accept input, the UI must explain whether it is busy, unavailable, cancelled, or failed.
- Session history loading must be good enough that switching into a session gives the user a coherent recent context without manual repair.

## Responsiveness And Reliability Expectations

- Startup should provide immediate visual feedback that the TUI is launching and connecting.
- The UI should remain navigable during background polling, session refresh, or status waits.
- Keyboard input must remain responsive while background updates occur.
- Switching focus or panes should feel immediate.
- Session switching should show either the session content or an explicit loading state; it must not leave the user with a blank ambiguous screen.
- Polling, replay, or refresh mechanisms must not cause chat lines to flicker, reorder unexpectedly, or repeat terminal results.
- Temporary backend unavailability should degrade status freshness before it breaks the whole UI.
- On reconnect or recovery, the TUI should reconcile back to the latest durable session state without requiring the user to restart unless recovery truly fails.
- Shutdown should stop observers and background work cleanly enough that quitting does not hang indefinitely.

## Interaction Model And Keyboard UX Expectations

- The TUI is keyboard-first. All core workflows must be possible without a mouse.
- Users must be able to understand which pane has focus.
- There must be a consistent distinction between navigation mode and text-entry mode.
- Focus traversal must be predictable across sessions, chat, diagnostics, activity, and overlays.
- Important global actions must work regardless of the currently focused non-input pane.
- The current keymap includes navigation, pane switching, resizing, session actions, slash commands, artifact access, markdown viewing, and quit flows. A redesign may revise specific keys, but must preserve discoverability and consistency.
- Built-in help must describe the currently supported keys and commands from within the TUI.
- Potentially destructive actions such as delete should require an intentional gesture and provide clear feedback.
- Escape paths must be reliable: users need an obvious way to leave overlays, exit typing mode, and quit the program.

## Error Handling And Degraded Behavior

- Connection failures must be surfaced in plain language, not just stack traces.
- If the database or management plane is temporarily unavailable, the TUI must continue rendering the last known state and clearly indicate that updates are stale or retrying.
- If live status cannot be fetched, the user must still be able to read existing history and navigate sessions when possible.
- If diagnostic streams fail, chat and session management must continue when possible.
- If a session action fails, the UI must report what failed and whether the user can retry safely.
- If artifact download fails, the session remains usable and the failure is local to that action.
- If a session is found to be failed, dead, or cancelled, the UI must say so explicitly and stop implying that work is still progressing.
- Recovery logic must prefer correctness over apparent liveness: showing no new result yet is better than showing the wrong or duplicated result.
- Unhandled internal errors should be contained to the smallest possible surface and should not crash the entire TUI when a narrower failure mode is possible.

## Accessibility And Legibility Expectations

- The interface must remain usable in a standard terminal without depending on color alone.
- Focus, selection, active state, and severity must have at least one non-color indicator such as border style, icon, label, or text.
- Text should be readable at common terminal sizes without requiring wide desktop layouts.
- The layout should degrade gracefully on smaller terminals by reducing optional detail before breaking core chat and session workflows.
- Scroll position and clipping behavior must be understandable; users should not lose their place due to automatic redraws.
- Unicode, emoji, and markdown rendering should not corrupt alignment or make surrounding text unreadable.
- Help text, state labels, and command names must be written in plain language.

## Out Of Scope And Future-Facing Ideas

- Multi-select or bulk session actions.
- Mouse-first interaction patterns.
- Rich graphical dashboards beyond terminal constraints.
- Full log exploration parity with dedicated observability tools.
- Collaborative multi-user editing of the same TUI instance.
- In-place editing of agent definitions, tools, or runtime configuration.
- Formal plugin API design for third-party TUI panels.
- Cross-session search, saved filters, and advanced workspace views.

## Open Questions

- Which diagnostic views are part of the core product versus explicitly optional runtime/debug tooling?
- Should the activity view remain a separate pane, merge into chat metadata, or become a collapsible detail view?
- What is the minimum session metadata users should be able to inspect without dropping into slash commands?
- Should delete always be available, or should some session classes be hidden from destructive actions by default?
- How should special system sessions be presented so they are visible but not confused with user work?
- Should model changes be scoped only per session, or should the TUI also offer a global default model choice?
- What confirmation model is appropriate for cancel, done, and delete so the UI stays fast without being too easy to misuse?
- On small terminals, which surfaces collapse first: diagnostics, activity, session list density, or status detail?
- Should artifact viewing be limited to markdown, or should the TUI define a broader document preview contract?
- Which reliability states should be explicitly surfaced to users: reconnecting, stale data, replaying history, waiting for worker, or all of the above?

## Product Boundary This Spec Defines

- The TUI is a user-facing session workspace, not a thin shell over internal runtime primitives.
- The product contract is defined in terms of sessions, conversation, activity, diagnostics, artifacts, and management actions.
- Internal sources such as CMS tables, orchestration history, worker placement, and log transport may change as long as the user-facing behavior in this spec remains intact or improves.
