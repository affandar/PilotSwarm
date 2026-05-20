# TUI Architecture

This document describes the current PilotSwarm terminal UI architecture.

PilotSwarm now has one terminal UI stack:

- [`packages/cli/`](../packages/cli) — the terminal host and launcher binary
- [`packages/ui-core/`](../packages/ui-core) — state, controller logic, selectors, formatting, and shared view models
- [`packages/ui-react/`](../packages/ui-react) — shared React composition used by the terminal UI and portal

## Goals

- Keep one canonical terminal UI implementation.
- Put product behavior in shared layers instead of host-only code.
- Keep the host thin: keyboard input, terminal rendering, process lifecycle, clipboard, OS integration.
- Make portal/web parity possible without duplicating session-state logic.

## Layering

```text
┌──────────────────────────────────────────────────────────────┐
│ packages/cli                                                │
│ terminal host, input wiring, render loop, process lifecycle │
└──────────────────────────────┬───────────────────────────────┘
                               │
┌──────────────────────────────▼───────────────────────────────┐
│ packages/ui-react                                            │
│ pane composition, shared app shell, host-neutral React tree  │
└──────────────────────────────┬───────────────────────────────┘
                               │
┌──────────────────────────────▼───────────────────────────────┐
│ packages/ui-core                                             │
│ store, reducer, controller, selectors, history, formatting   │
└──────────────────────────────┬───────────────────────────────┘
                               │
┌──────────────────────────────▼───────────────────────────────┐
│ transports                                                   │
│ PilotSwarm client/management APIs, logs, artifacts, files    │
└──────────────────────────────────────────────────────────────┘
```

## Responsibilities

### `packages/ui-core`

Owns durable UI semantics:

- application state and reducer
- controller actions and async flows
- session/catalog refresh logic
- chat/history/activity derivation
- status-bar hints and modal data
- formatting utilities and terminal markup parsing

If a behavior should also exist in portal/web later, it should usually live here.

### `packages/ui-react`

Owns shared React composition:

- pane layout
- app shell
- modal composition
- reusable presentational structures

This layer should stay host-neutral. It should not know about raw terminal input or OS process details.

### `packages/cli`

Owns terminal-host specifics:

- terminal rendering primitives
- keyboard and mouse event handling
- clipboard integration
- OS file-opening and download helpers
- local embedded-worker boot and remote client mode
- graceful shutdown and screen cleanup

This layer should be as thin as practical.

## Runtime Shape

```text
run.sh / npx pilotswarm
        │
        ▼
packages/cli/bin/tui.js
        │
        ▼
packages/cli/src/bootstrap-env.js
        │
        ├─ resolve env, plugin dirs, branding, worker module
        └─ choose local vs remote mode
        │
        ▼
packages/cli/src/index.js
        │
        ├─ create transport
        ├─ create shared store
        ├─ create ui-core controller
        └─ render shared app through terminal platform
```

## Main Data Flows

### Session/catalog flow

```text
management client ──► ui-core controller ──► store ──► selectors ──► rendered panes
```

Session groups are loaded through the management client alongside sessions and
adapted into synthetic shared UI rows with IDs shaped like `group:<groupId>`.
The shared tree nests top-level grouped sessions under these `🗂` rows while
keeping real parent/child lineage intact. Selecting a group opens a group detail
view instead of a transcript. Groups are pure containers: sessions are moved in
or out through the move-to-group picker, and group deletion only succeeds after
all member sessions have been moved out. Groups use the same normalized owner
model as sessions (`users` plus a group-owner link), owner filters apply to
group rows, legacy ownerless groups can derive filter/display ownership from
their member sessions, and sessions can only move into groups with a matching owner. Root
session ordering keeps system
sessions first, then pinned groups, pinned single sessions, unpinned groups, and
then unpinned sessions. A fresh page/app load seeds the stable order inside each
band and group from session last-updated time, newest first; live refreshes then
keep that row order static so timestamp updates do not reshuffle the visible
list. If the user has no stored selection/expansion profile yet, the main
PilotSwarm system session is selected and all expandable group/parent rows start
collapsed.

### Chat/history flow

```text
CMS events + live status + local optimistic state
                    │
                    ▼
             history/selectors
                    │
                    ▼
               chat/activity panes
```

The chat pane can render either the durable transcript or a structured session
summary card. The mode is shared state in `ui-core`; the native TUI toggles it
with `s` while the portal exposes the same choice as a compact segmented control.

### Terminal interaction flow

```text
keyboard/mouse ──► packages/cli host ──► controller commands ──► store update
```

## Design Rules

- The TUI must use public PilotSwarm API surfaces, not runtime internals.
- Shared selectors/components are the source of truth for visible behavior.
- Terminal-only affordances belong in `packages/cli`, not `ui-core`.
- Product semantics should not depend on direct widget mutation.
- User-facing keybindings must be updated together with all visible help surfaces.

## Important Files

- [`packages/cli/src/index.js`](../packages/cli/src/index.js)
- [`packages/cli/src/app.js`](../packages/cli/src/app.js)
- [`packages/cli/src/platform.js`](../packages/cli/src/platform.js)
- [`packages/cli/src/node-sdk-transport.js`](../packages/cli/src/node-sdk-transport.js)
- [`packages/ui-core/src/controller.js`](../packages/ui-core/src/controller.js)
- [`packages/ui-core/src/selectors.js`](../packages/ui-core/src/selectors.js)
- [`packages/ui-core/src/history.js`](../packages/ui-core/src/history.js)
- [`packages/ui-react/src/components.js`](../packages/ui-react/src/components.js)

## Related Docs

- [TUI Design And Implementor Guide](./tui-implementor-guide.md)
- [Keybindings](./keybindings.md)
- [Building CLI Apps](./cli/building-cli-apps.md)
- [System Reference](./system-reference.md)
- [Architecture](./architecture.md)
