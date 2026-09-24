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

Durable signal waits retain their shared metadata through CMS-only list
refreshes: `updatedAt` alone is not evidence that a wait ended. A rich detail
read, valid `statusVersion`, or explicit signal metadata (including `null`)
establishes authority; freshness checks still prevent stale reads from erasing
or reviving a wait. Preserve an interrupting provider-budget wait's own
status/reason/timer alongside the saved signal wait. Shared Stop eligibility
includes running turns and valid, non-interrupted signal waits with status
`waiting`; ordinary timers and cron waits do not become Stop targets.

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

### Webhook management flow

Settings/Admin → Webhooks uses `state.admin.webhooks`, the shared
`webhook-controller.js` commands, `webhook-forms.js` field schemas and
`webhook-validation.js` JSON/config validation. `selectWebhookConsole` supplies
both hosts with resource capabilities, read/pending/errors, selected revisions,
receipt paging/timelines and viewer-scoped health. Native `webhook-input.js`
translates keys only; `webhook-tui.js` and `webhook-panel.js` render the same
semantic view. The browser's ordinary Tab focus traversal remains browser-native.

Every update captures `expectedRevision`; a stale write refreshes and requires
explicit re-edit, never retry. The existing confirmation flow owns revoke and
receipt replay (`{confirmed:true}` only after confirmation). Neither action
terminates a session. Read visibility and mutation authorization remain server
decisions, including on auth-disabled deployments; profile admission is not an
implicit admin grant.

The Health page uses `getWebhookMetrics().retention` and the canonical
`updateWebhookRetentionPolicy` operation. Its shared field editor captures a
revision; no UI timer deletes data or extends a replay deadline. Receipt replay
uses server availability plus the client-visible absolute deadline and is
rechecked at confirmation. Expired/revoked/exhausted endpoint warnings preserve
the independent signal-wait lifecycle.

One-time endpoint capabilities are private controller memory, **not** store
actions, selectors, persisted preferences or general statuses. Only the mounted
capability view can read them. Reducer navigation/identity invalidation and
controller disposal erase the reference and reject late responses. Native
rendering does not register those lines in the pointer-selection cache; explicit
copy is a separate user gesture. Only numeric wrapping/scroll limits cross back
from the terminal renderer.

Connector delivery addresses are different: they contain a public connector ID,
not a capability, and belong in the shared read-only view model. Compose them
only from bootstrap `webhooks.publicOrigin` plus `/hooks/c/<encoded-id>`, or
show a labeled relative path when no origin is supplied. Both hosts use the
same explicit clipboard flow, without opening or fetching the address.

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
