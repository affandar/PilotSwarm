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

## Keybinding Rule

When a keybinding changes, update all user-facing surfaces together:

- the actual binding in `packages/cli/src/app.js`
- status-bar hints in `packages/ui-core/src/selectors.js`
- prompt affordance / placeholder copy
- modal/footer/detail help copy
- startup/help copy if present
- `.github/copilot-instructions.md`

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
