---
name: pilotswarm-tui
description: Modify or extend the PilotSwarm terminal UI. Covers the shared-first architecture across ui-core, ui-react, and packages/cli, the current layout and visual conventions, prompt/question behavior, and the requirement to keep maintainer docs updated as the TUI evolves.
---

# PilotSwarm TUI

Use this skill when changing any of:

- `packages/ui-core/`
- `packages/ui-react/`
- `packages/cli/`
- `run.sh`
- TUI-specific docs or UI behavior

## Read First

- [docs/tui-architecture.md](../../../docs/tui-architecture.md)
- [docs/tui-implementor-guide.md](../../../docs/tui-implementor-guide.md)
- [docs/keybindings.md](../../../docs/keybindings.md)
- [packages/ui-core/src/controller.js](../../../packages/ui-core/src/controller.js)
- [packages/ui-core/src/selectors.js](../../../packages/ui-core/src/selectors.js)
- [packages/ui-react/src/components.js](../../../packages/ui-react/src/components.js)
- [packages/cli/src/app.js](../../../packages/cli/src/app.js)
- [packages/cli/src/platform.js](../../../packages/cli/src/platform.js)

## Core Architecture

The terminal UI is not a monolith.

- `ui-core` owns state, controller logic, selectors, formatting, and transport-facing behavior.
- `ui-react` owns shared React composition and stays host-neutral.
- `packages/cli` is the thin terminal host: keyboard wiring, terminal rendering, process lifecycle, clipboard, downloads, and OS integration.

Do not move host rendering details into `ui-core`.
Do not move controller or selector semantics into `packages/cli`.
Do not bypass shared selectors/components with host-only UI logic unless the behavior is truly terminal-specific.

## Product Rules

- Preserve the existing PilotSwarm terminal workflow and information density.
- Pane titles live in borders, not as duplicate content inside panes.
- Shared selectors are the source of truth for visible state.
- Non-user / non-assistant transcript items render as cards.
- Mouse copy must stay pane-local.
- Prompt/question behavior and keybinding help must stay synchronized with actual bindings.
- Files, logs, sequence, nodes, activity, and chat are all product surfaces and should not silently regress.
- Live-updating logs and activity panes should wrap long lines rather than extending horizontally.
- Live-updating logs and activity panes should auto-follow only while the user is at the bottom; scrolling upward pauses follow mode until the user returns to the bottom.
- In the stats inspector, `f` toggles between the session view and fleet view; keep terminal and portal behavior aligned.
- In the native TUI, the files inspector should render inside the standard outer inspector shell rather than introducing a second files-specific top-level shell.
- In the portal inspector, reserve a consistent header row height so tabs with header actions and tabs without them start their tab strip at the same vertical position; keep inspector tab/action buttons compact rather than oversized.

## Keybinding Rule

When a keybinding changes, update all user-facing surfaces together:

- the actual binding in `packages/cli/src/app.js`
- status-bar hints in `packages/ui-core/src/selectors.js`
- prompt affordance / placeholder copy
- modal/footer/detail help copy
- startup/help copy if present
- `.github/copilot-instructions.md`

## TUI vs Portal Divergences

The native TUI and browser portal share `ui-core` state and `ui-react` components but diverge in these areas:

| Aspect | Native TUI (`packages/cli`) | Portal (`packages/portal`) |
|--------|----------------------------|---------------------------|
| Border radius | N/A (terminal box-drawing) | **Slight rounding** (`6px` / `8px`) — subtle corners, not pills |
| Scrollbars | Native terminal scrolling | **Custom dark scrollbars** — slim, theme-matched thumbs/tracks instead of browser-default white scrollbars |
| Structured chat blocks | Box-drawing cards/tables rendered as terminal text | **Web-native cards/tables** — the portal converts shared box-drawing system notices and markdown tables into wrapped HTML blocks for layout fidelity |
| Status bar / keybinding hints | Rendered in a status strip below the workspace | **Removed** — the portal has no keybinding hints strip; status/error text is shown in the toolbar next to New/Refresh/Theme buttons |
| Footer | Status strip + prompt | **Prompt only** — maximizes prompt box space |
| Session collapse default | **Starts collapsed** — sessions that become parents are auto-collapsed on initial bulk load, but manual expand stays respected across refreshes | **Starts collapsed** — same shared reducer behavior |
| Session collapse toggle | Keyboard shortcut in `app.js` | **Click** — clicking a session with children toggles collapse/expand in `SessionPane` |

The auto-collapse-on-load logic lives in `ui-core/src/reducer.js` (shared). It collapses sessions when they first become parents, including nested parents, but must not re-collapse a row the user already expanded during later `sessions/loaded` refreshes. Initial active selection should be the first visible flat-tree row after collapse, not the first raw session object.

## Workflow

1. Decide which layer owns the change.
2. Implement it in the lowest correct shared layer.
3. Verify with a targeted smoke check.
4. Update this skill if the TUI’s design expectations changed.
5. Update `.github/copilot-instructions.md` if contributor maintenance expectations changed.

## Verification

Prefer fast local checks for TUI work:

```bash
node --input-type=module -e "await import('./packages/ui-react/src/components.js'); await import('./packages/cli/src/platform.js')"
./run.sh local --db
```

Use targeted selector/controller smokes for shared UI logic. Boot the live TUI when changing layout, keybindings, prompt flow, modal behavior, or terminal rendering.
