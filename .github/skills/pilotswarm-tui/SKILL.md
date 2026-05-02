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
- Keep title run data plain. The portal may use a slim painted card header, while the TUI should render pane titles without a highlighted header background. When panes narrow, drop low-priority title metadata like session ids or recent-window labels before squeezing content.
- Named-agent session titles should lead with the user-assigned title or uniquifier, then the agent type, then the agent/persona metadata, e.g. `M61 Conductor · R2D Train Watcher · Mad-Eye Moody`; do not render agent-name prefixes before the useful title in session rows or chat pane headers.
- Chat pane headers show the short model name after the title; when a session has a reasoning effort, append it to that model label as `model:effort` (for example `gpt-5.5:xhigh`). Keep this as display metadata only; the canonical runtime model id stays separate from `reasoningEffort`.
- Session stats should use the same `model:effort` display convention, falling back to the active session row's `reasoningEffort` when the metric summary was produced without that field.
- Shared selectors are the source of truth for visible state.
- Non-user / non-assistant transcript items render as cards.
- Mouse copy must stay pane-local.
- Prompt/question behavior and keybinding help must stay synchronized with actual bindings.
- Files, logs, sequence, nodes, activity, and chat are all product surfaces and should not silently regress.
- Live-updating logs and activity panes should wrap long lines rather than extending horizontally.
- Live-updating logs and activity panes should auto-follow only while the user is at the bottom; scrolling upward pauses follow mode until the user returns to the bottom.
- In the sessions pane, `f` opens the session owner filter; keep terminal help text and docs aligned with that binding.
- In the sessions pane, `P` pins or unpins the active top-level session. Pinned sessions render below system sessions and above the rest of the list with a `📌` marker. System sessions and child (sub-agent) sessions cannot be pinned. Pin state persists across portal devices through `users.profile_settings.pinnedSessionIds`; the portal does not use browser localStorage/cookies as a preference cache. The native TUI uses the user config file (`pinnedSessionIds`). Pins for sessions that no longer exist are pruned automatically on the next session refresh.
- In the sessions pane, `V` toggles multi-select mode (seeded with the active session). `Space` toggles selection on the active row, `c` cancels every selected session in one confirmation (system sessions are skipped), and `Esc` exits select mode. Multi-select supports cancel only — `d` (done) and `D` (delete) are blocked while more than one row is selected. The portal mirrors this with Cmd/Ctrl-click and Shift-click on session rows; the panel header reveals a `Clear` button and the `Terminate` button switches to `Terminate (n)` so it routes straight to the bulk cancel flow.
- In the stats inspector, `f` cycles between the session, fleet, and users views; keep terminal and portal behavior aligned.
- In the files inspector, `x` deletes the selected artifact after confirmation; keep terminal and portal behavior aligned.
- In the native TUI, the files inspector should render inside the standard outer inspector shell rather than introducing a second files-specific top-level shell.
- In the portal inspector, reserve a consistent header row height so tabs with header actions and tabs without them start their tab strip at the same vertical position; keep inspector tab/action buttons compact rather than oversized.
- In the portal desktop workspace, both split boundaries are resizable: the main column divider and the inspector/activity divider. Keep the right-column activity pane slightly taller by default than the historical 28% split, preserve double-click reset plus arrow-key resizing on the drag handle, collapse either inspector or activity completely once the divider is pushed far enough toward one edge, and keep the divider visible so a collapsed pane can be dragged back open.
- Persist portal theme, owner filter, pinned sessions, and pane split adjustments in `users.profile_settings` so browser/mobile sessions share the same preferences. The portal must not read or write browser localStorage/cookies for these preferences; it may only clear old legacy keys/cookies at startup. The native TUI still persists these values in its user config file unless a change explicitly unifies that host too.
- Keep the session/chat divider shared and capped: it is the chat resize control, and it must not let the top sessions pane grow beyond 50% of the full window height.
- Busy/system-session prompt sends now use a shared pending outbox: queued prompts render in chat as pending user items, `Enter` on an empty draft flushes the queued batch, `Up`/`Down` at the prompt boundary navigate queued items, and `Esc` cancels the selected queued item. Keep portal, TUI, status hints, and docs aligned with that behavior.
- The Admin Console (`Shift+A` in the native TUI; toolbar `Admin` button in the portal) is a workspace-replacing surface for per-user settings. It must never display the raw GitHub Copilot key text — `selectAdminConsole` and `selectAdminGhcpKeyEditorModal` only carry the `githubCopilotKeySet` boolean and a masked editor value. The TUI and portal share the `state.admin` slice in `ui-core` and route every mutation through the controller (`beginAdminEditGhcpKey`, `setAdminGhcpKeyDraft`, `cancelAdminEditGhcpKey`, `saveAdminGhcpKey`, `clearAdminGhcpKey`, `refreshAdminProfile`); keep both hosts in sync if you add a new admin setting. Do not globally block New/New+Model when the per-user GitHub key is unset: GitHub models should fail only at create time when neither env `GITHUB_TOKEN` nor the per-user key is available, and non-GitHub providers must remain usable.
- Outbox items render with three visible delivery states next to the user-message label: `○` pending (client only), `✓` queued (durably enqueued), `✓✓` sent (persisted as a transcript `user.message`). Synchronous sends coalesce into a single durable enqueue; merge boundaries are not user-visible. Keep the glyph mapping in [packages/ui-core/src/selectors.js](../../../packages/ui-core/src/selectors.js) consistent across portal and TUI.

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
