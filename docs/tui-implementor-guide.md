# TUI Design And Implementor Guide

This guide is the detailed contributor reference for the current PilotSwarm terminal UI.

Use it when you are:

- changing layout, rendering, or key handling
- adding a new pane, modal, or command
- debugging session refresh, scroll, or activity behavior
- deciding which layer should own a TUI behavior

This guide covers the current implementation built on Ink in [`packages/cli/`](../packages/cli), but "Ink" is now an implementation detail of the one shipped terminal UI.

## Read This With

- [TUI Architecture](./tui-architecture.md)
- [Keybindings](./keybindings.md)
- [Working On PilotSwarm](./contributors/working-on-pilotswarm.md)

## Mental Model

The TUI has three layers with a strict ownership split:

```text
terminal input / process lifecycle / clipboard / OS services
                           │
                           ▼
                 packages/cli  (host)
                           │
                           ▼
               packages/ui-react  (shared tree)
                           │
                           ▼
                packages/ui-core  (behavior)
                           │
                           ▼
         PilotSwarm transport + management/runtime APIs
```

The most important rule is:

- `ui-core` decides what the UI means
- `ui-react` decides how the shared app is composed
- `packages/cli` decides how that shared app is rendered and controlled in a terminal

If a fix can live below `packages/cli`, it usually should.

## Source Map

### Terminal host

- [`packages/cli/bin/tui.js`](../packages/cli/bin/tui.js) — CLI entrypoint
- [`packages/cli/src/bootstrap-env.js`](../packages/cli/src/bootstrap-env.js) — env, plugin, branding, mode resolution
- [`packages/cli/src/index.js`](../packages/cli/src/index.js) — host bootstrap, render lifecycle, shutdown
- [`packages/cli/src/app.js`](../packages/cli/src/app.js) — terminal input wiring, keybindings, modal dispatch, quit flow
- [`packages/cli/src/platform.js`](../packages/cli/src/platform.js) — terminal rendering primitives, pane frames, scrollbars, prompt drawing, selection
- [`packages/cli/src/node-sdk-transport.js`](../packages/cli/src/node-sdk-transport.js) — SDK/management/log/artifact bridge
- [`packages/cli/src/embedded-workers.js`](../packages/cli/src/embedded-workers.js) — local-mode worker bootstrap

### Shared UI behavior

- [`packages/ui-core/src/state.js`](../packages/ui-core/src/state.js) — initial state shape
- [`packages/ui-core/src/reducer.js`](../packages/ui-core/src/reducer.js) — pure state transitions
- [`packages/ui-core/src/controller.js`](../packages/ui-core/src/controller.js) — async flows and command handling
- [`packages/ui-core/src/commands.js`](../packages/ui-core/src/commands.js) — command ids, tabs, focus regions
- [`packages/ui-core/src/selectors.js`](../packages/ui-core/src/selectors.js) — visible view models and pane lines
- [`packages/ui-core/src/history.js`](../packages/ui-core/src/history.js) — CMS/live event normalization into chat/activity
- [`packages/ui-core/src/formatting.js`](../packages/ui-core/src/formatting.js) — markdown and terminal-markup parsing
- [`packages/ui-core/src/layout.js`](../packages/ui-core/src/layout.js) — pane sizing, focus traversal, prompt row math

### Shared composition

- [`packages/ui-react/src/components.js`](../packages/ui-react/src/components.js) — app shell, panes, modals
- [`packages/ui-react/src/platform.js`](../packages/ui-react/src/platform.js) — host platform context
- [`packages/ui-react/src/use-controller-state.js`](../packages/ui-react/src/use-controller-state.js) — store subscription hook

## Runtime Boot Flow

```text
run.sh / npm run tui / npx pilotswarm
        │
        ▼
packages/cli/bin/tui.js
        │
        ▼
bootstrap-env.js
        │
        ├─ resolve env file
        ├─ resolve plugin dirs and worker module
        ├─ resolve local vs remote mode
        └─ resolve branding/splash
        │
        ▼
index.js
        │
        ├─ setup host runtime logging
        ├─ create terminal platform
        ├─ create NodeSdkTransport
        ├─ create ui-core store + controller
        └─ render SharedPilotSwarmApp through Ink
```

Important implication:

- startup logic belongs in `packages/cli/src/index.js` and `bootstrap-env.js`
- shared app state should not be created in React components

## Input Pipeline

The terminal host owns raw input.

```text
keyboard / mouse
      │
      ▼
packages/cli/src/app.js
      │
      ├─ terminal-only shortcuts
      ├─ modal editing
      ├─ prompt editing
      ├─ focus/tab routing
      └─ controller.handleCommand(...)
               │
               ▼
      packages/ui-core/src/controller.js
               │
               ▼
             reducer
               │
               ▼
            selectors
               │
               ▼
          rendered panes
```

### What belongs in `app.js`

- translating raw `ink` key events into commands
- terminal-only affordances like mouse drag selection
- quit/ctrl-c handling
- prompt editing keystrokes
- modal text input wiring

### What does not belong in `app.js`

- deciding how a session row should look
- constructing activity/chat lines
- session refresh semantics
- artifact/file list derivation

If a behavior is currently implemented in `app.js` and also matters for portal or tests, it probably wants to move downward.

## Rendering Pipeline

The shared layers produce line models, not direct terminal widget mutations.

```text
state
  │
  ▼
selectors.js
  │   returns:
  │   - pane titles
  │   - body lines
  │   - sticky lines
  │   - modal models
  ▼
components.js
  │
  ▼
platform.Panel / platform.Lines / platform.TextInput
  │
  ▼
packages/cli/src/platform.js
  │
  ├─ wrap
  ├─ trim
  ├─ scroll
  ├─ selection highlighting
  ├─ scrollbars
  └─ Ink <Text>/<Box> output
```

This split is why most visible regressions are easiest to debug by asking:

1. Did `selectors.js` generate the wrong model?
2. Or did `platform.js` render a correct model incorrectly?

## State Model

The state tree is intentionally UI-oriented.

High-value areas:

- `state.connection` — mode, status, connection errors
- `state.sessions` — catalog, active session, flat tree, collapse state
- `state.history` — per-session normalized event/chat/activity data
- `state.ui` — focus region, inspector tab, modal state, scroll offsets, prompt draft
- `state.files` — artifacts, previews, browser scope, selection

Rules:

- Reducers should stay pure.
- Async calls live in the controller or transport.
- Selectors should consume normalized state, not reach into transports.

## Commands, Focus, And Tabs

The command registry in [`packages/ui-core/src/commands.js`](../packages/ui-core/src/commands.js) is the shared vocabulary for the app.

When you add a new command:

1. add or update the command id in `commands.js`
2. handle it in `controller.js`
3. wire the keybinding in `packages/cli/src/app.js`
4. update visible help in `selectors.js`
5. update [Keybindings](./keybindings.md)
6. update [.github/copilot-instructions.md](../.github/copilot-instructions.md) and the TUI skill if the maintenance rule changed

The TUI treats focus as explicit state, not as terminal-widget magic. Focus movement should go through shared focus regions and layout helpers, not hard-coded panel assumptions.

## Chat And Activity Semantics

`history.js` is where raw events become human-facing chat and activity.

That means:

- deduping live and persisted messages belongs there
- system-card extraction belongs there or in formatting/selectors
- activity summarization belongs there
- ephemeral streaming/noise filtering belongs there

Do not put event-shape interpretation in `components.js`.

A good test for ownership:

- if portal would want the same timeline semantics, put it in `history.js`
- if only the terminal cares about the visual treatment, put it in `platform.js`

## Files, Artifacts, And Preview

The artifact pipeline has three layers:

```text
NodeSdkTransport
   │  list/download/open/upload
   ▼
controller.js
   │  refresh selection, preview load, modal flow
   ▼
selectors.js
   │  file browser list + preview model
   ▼
components.js / platform.js
```

Rules:

- artifact I/O belongs in the transport
- selected-file and preview behavior belongs in the controller
- rendered file list/preview lines belong in selectors
- host-specific "open in OS default app" belongs in `packages/cli`

## Scroll And Selection

Scroll offsets are shared state. Selection highlighting is host rendering.

That split matters:

- whether a pane should be bottom-anchored is a shared behavior question
- how a scrollbar is drawn is a host question
- mouse drag region extraction is a host question
- which pane a copy operation applies to is part host, part shared frame registration

If scroll behavior is wrong, inspect:

- `controller.js` for offset updates
- `selectors.js` for sticky/body line counts
- `platform.js` for clipping/wrapping/scrollbar math

## Modals

The TUI uses a shared modal model rather than host-owned ad hoc dialogs.

Pattern:

1. controller opens modal by dispatching shared modal state
2. selectors derive display text/options/footer help
3. `components.js` chooses the matching shared modal shell
4. `app.js` routes keystrokes while the modal is open

If you add a modal, keep all four pieces in sync.

## Local Vs Remote Mode

The host supports two runtime shapes:

- local: embedded workers started by `embedded-workers.js`
- remote: management/client-only TUI with log streaming and no local workers

The view layer should not fork heavily for these modes. Prefer:

- transport capability checks
- state/selector differences
- generic status messages

Avoid host-only branches in many files unless the behavior is truly different.

## Common Change Patterns

### Add a new inspector tab

Touch:

- `commands.js`
- `state.js`
- `controller.js`
- `selectors.js`
- `components.js`
- `app.js` if keybindings/help change

### Add a new session-row badge

Usually touch:

- `selectors.js`
- maybe `context-usage.js` or another shared helper
- docs if the badge is user-visible and meaningful

### Change prompt editing

Usually touch:

- `app.js` for keys
- `controller.js` / `reducer.js` for prompt state changes
- `layout.js` for prompt row math
- `platform.js` for cursor and multi-line rendering
- `selectors.js` for hint text

### Change a visible chat/activity rule

Usually touch:

- `history.js`
- `formatting.js`
- `selectors.js`
- tests first, then platform only if rendering is the actual problem

## What To Avoid

- Do not rebuild shared view state inside React components.
- Do not add terminal escape parsing to selectors.
- Do not let the transport mutate view state directly.
- Do not hard-code keybinding copy in multiple places without updating all help surfaces.
- Do not treat the host as the source of truth for session semantics.

## Debugging Checklist

When a TUI bug shows up, narrow it quickly:

### Wrong text/content

- inspect `history.js`
- inspect `selectors.js`
- inspect controller state snapshots

### Wrong wrapping, clipping, cursor, or scrollbar

- inspect `packages/cli/src/platform.js`

### Wrong key behavior

- inspect `packages/cli/src/app.js`
- inspect command handling in `controller.js`

### Wrong modal behavior

- inspect `state.js`, `controller.js`, `selectors.js`, and `components.js` together

### Wrong local vs remote startup behavior

- inspect `bootstrap-env.js`
- inspect `index.js`
- inspect `node-sdk-transport.js`

## Validation Checklist

For most TUI changes, do at least these:

```bash
node --input-type=module -e "await import('./packages/cli/src/index.js'); await import('./packages/cli/src/platform.js'); await import('./packages/ui-react/src/components.js'); await import('./packages/ui-core/src/selectors.js')"
node packages/cli/bin/tui.js --help
```

And then at least one of:

- targeted selector/controller/history Vitest coverage
- `./run.sh local --db` for real interaction changes
- `./run.sh remote` for remote/log/management changes

## Related Docs

- [TUI Architecture](./tui-architecture.md)
- [Keybindings](./keybindings.md)
- [Working On PilotSwarm](./contributors/working-on-pilotswarm.md)
- [System Reference](./system-reference.md)
