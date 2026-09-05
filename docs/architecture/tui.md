# TUI Architecture

This document describes the current PilotSwarm terminal UI architecture.

PilotSwarm now has one terminal UI stack:

- [`packages/app/tui/`](../../packages/app/tui) — the terminal host and launcher binary
- [`packages/app/ui/core/`](../../packages/app/ui/core) — state, controller logic, selectors, formatting, and shared view models
- [`packages/app/ui/react/`](../../packages/app/ui/react) — shared React composition used by the terminal UI and portal

## Goals

- Keep one canonical terminal UI implementation.
- Put product behavior in shared layers instead of host-only code.
- Keep the host thin: keyboard input, terminal rendering, process lifecycle, clipboard, OS integration.
- Make portal/web parity possible without duplicating session-state logic.

## Layering

```text
┌──────────────────────────────────────────────────────────────┐
│ packages/app/tui                                                │
│ terminal host, input wiring, render loop, process lifecycle │
└──────────────────────────────┬───────────────────────────────┘
                               │
┌──────────────────────────────▼───────────────────────────────┐
│ packages/app/ui/react                                            │
│ pane composition, shared app shell, host-neutral React tree  │
└──────────────────────────────┬───────────────────────────────┘
                               │
┌──────────────────────────────▼───────────────────────────────┐
│ packages/app/ui/core                                             │
│ store, reducer, controller, selectors, history, formatting   │
└──────────────────────────────┬───────────────────────────────┘
                               │
┌──────────────────────────────▼───────────────────────────────┐
│ transports                                                   │
│ PilotSwarm client/management APIs, logs, artifacts, files    │
└──────────────────────────────────────────────────────────────┘
```

## Responsibilities

### `packages/app/ui/core`

Owns durable UI semantics:

- application state and reducer
- controller actions and async flows
- session/catalog refresh logic
- chat/history/activity derivation
- status-bar hints and modal data
- formatting utilities and terminal markup parsing

If a behavior should also exist in portal/web later, it should usually live here.

### `packages/app/ui/react`

Owns shared React composition:

- pane layout
- app shell
- modal composition
- reusable presentational structures

This layer should stay host-neutral. It should not know about raw terminal input or OS process details.

### `packages/app/tui`

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
packages/app/tui/bin/tui.js
        │
        ▼
packages/app/tui/src/bootstrap-env.js
        │
        ├─ resolve env, plugin dirs, branding, worker module
        └─ choose local vs remote mode
        │
        ▼
packages/app/tui/src/index.js
        │
        ├─ create transport
        ├─ create shared store
        ├─ create ui-core controller
        └─ render shared app through terminal platform
```

## Main Data Flows

### Live previews

The optional [ephemeral live plane](live-plane.md) supplies provisional
reasoning and answer snapshots to Web API transports. Shared history code
preserves identity across reasoning → answer → durable final, rejects late
previews, and leaves the durable cursor untouched. Browser-only collapsed
preview cards use bounded independent scroll areas and preserve their DOM
through durable message arrival. A successful turn boundary promotes the final
answer to ordinary chat; the direct native host
continues to use durable events. Do not put these reconciliation rules in
host-specific renderers.

### Session/catalog flow

```text
management client ──► ui-core controller ──► store ──► selectors ──► rendered panes
```

Session groups are loaded through the management client alongside sessions and
adapted into synthetic shared UI rows with IDs shaped like `group:<groupId>`.
The shared tree nests top-level grouped sessions under these `🗂` rows while
keeping real parent/child lineage intact. Selecting a group opens a group detail
view instead of a transcript. Groups are each viewer's **private per-user
organization**: the catalog returns only the viewer's own groups, session rows
carry the viewer's own placement (`viewerGroupId` on the wire, normalized to the
local `groupId` field the tree keys off), and placing or ungrouping a session
changes nothing for any other viewer. Sessions are placed in or out through the
move-to-group picker (`placeSessionsInGroup`); any readable non-system session
can be placed — mixed-owner selections are allowed and every one of the
viewer's groups is offered. Group deletion clears the viewer's placements and
never touches sessions, so non-empty groups delete cleanly. Root
session ordering keeps system
sessions first, then pinned groups, pinned single sessions, unpinned groups, and
then unpinned sessions. A fresh page/app load seeds the stable order inside each
band and group from session last-updated time, newest first; live refreshes then
keep that row order static so timestamp updates do not reshuffle the visible
list. If the user has no stored selection/expansion profile yet, the main
PilotSwarm system session is selected and all expandable group/parent rows start
collapsed.

### Admin model-provider flow

```text
listProviders + listModels + getModelDefaults
                                │
                                ▼
           ui-core state.admin.modelProviders
                                │
                                ▼
                   selectAdminConsole
                                │
                ┌─────────┴─────────┐
                ▼                   ▼
        native TUI          browser portal
```

The Admin Console is the shared owner of runtime provider lifecycle and model
routing. Model Providers has two pages: **My Providers** (personal credentials
and user default) and admin-only **Shared Providers** (shared credentials,
cluster/system defaults, and system-agent overrides). Providers use their
immutable name everywhere; there is no separate display label. Providers &
Budgets owns usage, limits, allowances, holds, and paused-session diagnostics.
Its user grid includes uncapped metered models; admins get a separate system
spend total and per-model breakdown.

Provider credentials are write-only. Neither provider/default reads nor shared
view models carry saved credentials. The browser keeps a password draft local
to the create/update sheet; the native wizard masks its draft and removes it
from shared state before awaiting either call. Cancel and completion clear both.

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
keyboard/mouse ──► packages/app/tui host ──► controller commands ──► store update
```

## Design Rules

- The TUI must use public PilotSwarm API surfaces, not runtime internals.
- Shared selectors/components are the source of truth for visible behavior.
- Terminal-only affordances belong in `packages/app/tui`, not `ui-core`.
- Product semantics should not depend on direct widget mutation.
- User-facing keybindings must be updated together with all visible help surfaces.

## Important Files

- [`packages/app/tui/src/index.js`](../../packages/app/tui/src/index.js)
- [`packages/app/tui/src/app.js`](../../packages/app/tui/src/app.js)
- [`packages/app/tui/src/platform.js`](../../packages/app/tui/src/platform.js)
- [`packages/app/tui/src/node-sdk-transport.js`](../../packages/app/tui/src/node-sdk-transport.js)
- [`packages/app/ui/core/src/controller.js`](../../packages/app/ui/core/src/controller.js)
- [`packages/app/ui/core/src/selectors.js`](../../packages/app/ui/core/src/selectors.js)
- [`packages/app/ui/core/src/history.js`](../../packages/app/ui/core/src/history.js)
- [`packages/app/ui/react/src/components.js`](../../packages/app/ui/react/src/components.js)

## Related Docs

- [TUI Design And Implementor Guide](../developer/contributing/tui-implementor-guide.md)
- [Keybindings](../user-guide/keybindings.md)
- [Building CLI Apps](../developer/building/cli-apps.md)
- [System Reference](./system-reference.md)
- [Architecture](./system.md)
