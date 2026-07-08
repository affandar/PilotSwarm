---
name: pilotswarm-tui
description: Modify or extend the PilotSwarm terminal UI. Covers the shared-first architecture across ui-core, ui-react, and packages/app/tui, the current layout and visual conventions, prompt/question behavior, and the requirement to keep maintainer docs updated as the TUI evolves.
---

# PilotSwarm TUI

Use this skill when changing any of:

- `packages/app/ui/core/`
- `packages/app/ui/react/`
- `packages/app/tui/`
- `run.sh`
- TUI-specific docs or UI behavior

## Read First

- [docs/architecture/tui.md](../../../docs/architecture/tui.md)
- [docs/developer/contributing/tui-implementor-guide.md](../../../docs/developer/contributing/tui-implementor-guide.md)
- [docs/user-guide/keybindings.md](../../../docs/user-guide/keybindings.md)
- [packages/app/ui/core/src/controller.js](../../../packages/app/ui/core/src/controller.js)
- [packages/app/ui/core/src/selectors.js](../../../packages/app/ui/core/src/selectors.js)
- [packages/app/ui/react/src/components.js](../../../packages/app/ui/react/src/components.js)
- [packages/app/tui/src/app.js](../../../packages/app/tui/src/app.js)
- [packages/app/tui/src/platform.js](../../../packages/app/tui/src/platform.js)

## Core Architecture

The terminal UI is not a monolith.

- `ui-core` owns state, controller logic, selectors, formatting, and transport-facing behavior.
- `ui-react` owns shared React composition and stays host-neutral.
- `packages/app/tui` is the thin terminal host: keyboard wiring, terminal rendering, process lifecycle, clipboard, downloads, and OS integration.

Do not move host rendering details into `ui-core`.
Do not move controller or selector semantics into `packages/app/tui`.
Do not bypass shared selectors/components with host-only UI logic unless the behavior is truly terminal-specific.

## Product Rules

- Preserve the existing PilotSwarm terminal workflow and information density.
- Pane titles live in borders, not as duplicate content inside panes.
- Keep title run data plain. The portal may use a slim painted card header, while the TUI should render pane titles without a highlighted header background. When panes narrow, drop low-priority title metadata like session ids or recent-window labels before squeezing content.
- Named-agent session titles should lead with the user-assigned title or uniquifier, then the agent type, then the agent/persona metadata, e.g. `M61 Conductor · R2D Train Watcher · Mad-Eye Moody`; do not render agent-name prefixes before the useful title in session rows or chat pane headers.
- System sessions render with the machinery marker `⚙` in yellow. Leave one text space after the marker in title-bearing rows/headers; the terminal renderer already gives this symbol enough visual width.
- Chat pane headers stay compact: show the title, collapse count, short session id when space allows, and transient live-progress labels. Do not duplicate model/context/window metadata there; the portal desktop Sessions row selected-detail line carries model/reasoning/context details instead.
- Session stats should use the same `model:effort` display convention, falling back to the active session row's `reasoningEffort` when the metric summary was produced without that field.
- Session/tree/fleet/user stats by-model cards show `turnCount` alongside token totals so model switches can be audited per turn bucket. Keep effort variants distinct in the model label.
- The shared controller supports switching the selected session's model through the same model/reasoning pickers as New+Model. The switch ends the current turn boundary and the orchestration schedules an automatic bootstrap continuation on the selected model; if the target model has a default reasoning effort use it, otherwise clear stale effort. System-session switches use this same durable `set_model` command path; explicit restart actions remain separate.
- Failed LLM `set_session_model` calls are also terminal and schedule an automatic bootstrap correction continuation on the unchanged model. Failed control-plane switches are rejected before command acceptance and should not create chat continuations.
- The portal sequence inspector may render expandable `session.turn_completed` dividers. Keep the collapsed row compact (`Mod`, input/output tokens, duration) with provider/reasoning omitted from the model label; expanded details can show full model, effort, cache, tool, worker, and result data. The native TUI sequence view remains line-oriented unless a terminal-specific design is added deliberately.
- Shared selectors are the source of truth for visible state.
- Session rows should show interval cron as `[cron <duration>]` and wall-clock cron as `[cron <next client-local time>]` from shared selector state; status clearing must remove stale wall-clock cron fields when `cronActive` becomes false. Do not expose the internal `cron_at` tool name in row badges.
- Waiting/timer row visuals should stay stable across same-age stale detail refreshes. Row status icons may change, but the new row visual status must remain stable for at least 5 seconds before the visible icon/color flips; a row that is visibly waiting should not briefly lose its `~` icon or cron badge unless a newer session update, running state, or terminal state actually clears the wait.
- The sequence and activity panes should render wall-clock `cron_at` lifecycle events with the same visible `cron` label and magenta styling as interval cron, including a visible wake-up indicator when `session.cron_at_fired` arrives.
- Non-user / non-assistant transcript items render as cards, except dedicated read-only chat-pane views: the session summary and session group details render as plain structured markdown without a card border. Cross-session `[SESSION_MESSAGE ...]` and `[SESSION_MESSAGE_RESPONSE ...]` protocol prompts are product-visible transcript items and must render as dedicated session request/reply cards, not collapsed activity-only system notices.
- Mouse copy must stay pane-local.
- Prompt/question behavior and keybinding help must stay synchronized with actual bindings.
- Files, logs, sequence, nodes, activity, and chat are all product surfaces and should not silently regress.
- Live-updating logs and activity panes should wrap long lines rather than extending horizontally.
- Live-updating logs and activity panes should auto-follow only while the user is at the bottom; scrolling upward pauses follow mode until the user returns to the bottom.
- In the sessions pane, `f` opens the session owner filter; keep terminal help text and docs aligned with that binding.
- In the sessions pane, `Ctrl+G` opens the move-to-group picker for the selected top-level non-system sessions, or for the active top-level non-system session when multi-select is off. The picker includes `[New Group]`, existing groups, and `[No Group]`; keep status hints and keybinding docs aligned with that binding.
- In the sessions pane, `P` pins or unpins the active top-level session. Pinned rows render with a `📌` marker. System sessions, child (sub-agent) sessions, and sessions contained in a group cannot be pinned; moving a pinned session into a group drops the pin automatically. Pin state persists across portal devices through `users.profile_settings.pinnedSessionIds`; the portal does not use browser localStorage/cookies as a preference cache. The native TUI uses the user config file (`pinnedSessionIds`). Pins for sessions that no longer exist or that are no longer top-level are pruned automatically on the next session refresh.
- Session groups are shared TUI/portal pure-container rows. They render as top-level `🗂` rows, can be pinned independently, and do not open a transcript. Session ordering bands are: system sessions first, pinned groups, pinned single sessions, unpinned groups, then unpinned sessions. On fresh page/app load, seed row order within each band and group by last-updated time, newest first; during live refreshes preserve stable row order so timestamp changes do not churn the visible list. Sessions inside a group are not pinnable; child rows follow the stable unpinned order. Leave two text spaces after the marker so terminal renderers do not crowd the title. Selecting a group opens a plain markdown group details view with metric and member tables in the chat pane; inspector and activity panes show a generic prompt to select a session instead of sequence/log/activity details. Groups use the same normalized owner model as sessions, participate in the owner filter, and can only contain sessions with the same owner. Group rows show the same owner-initials prefix as session rows, deriving it from member sessions when legacy groups have no direct group owner. Groups do not support cancel/complete bulk actions; delete is allowed only after all sessions are moved out. In the portal, the Sessions pane header exposes a `Group` / `Group (n)` button that opens the shared move-to-group picker.
- In the portal desktop Sessions column, row data is structured: title and collapse count stay on the primary line, timestamps/member counts render as muted metadata, cron/context badges render on their own badge line, and the selected row may reveal richer status/model/context metadata. Mobile Main Sessions keeps the flattened clipped single-line row path; mobile Chat Focus Sessions may use the same structured rows as desktop, with horizontal scrolling where needed. Keep the native TUI flattening path available for terminal rows.
- System session actions are restart actions: Done prompts for `Complete & Restart`, Cancel prompts for `Terminate & Restart`, and Delete prompts for `Hard Delete & Restart`. They all route through `restartSystemSession`, not ordinary `completeSession` / `cancelSession` / `deleteSession`. In the portal Sessions pane, the ordinary `Terminate` button becomes `Restart` for system sessions and opens a disposition picker with those three restart choices.
- In the chat pane, `s` toggles between the transcript and the current session summary view; keep the portal top-toolbar `Summary` / `Chat` toggle and TUI keybinding help in sync. Do not add a second Chat/Summary control inside the chat pane header. Summary and group details are read-only views: the portal hides/disables the prompt composer and suppresses transient live-progress labels there.
- On mobile portal layouts, the top toolbar stays on exactly two rows: `New/Model/Switch/Filter` on row 1, and `Theme/Chat-or-Summary/Focus/Admin` on row 2. Portal connection/status text lives in the app header under the version pill, not in the toolbar.
- Theme picker selection previews immediately in both portal and shared UI state. `Apply Theme` commits the previewed theme; `Cancel`, `Close`, backdrop click, or `Esc` restores the theme that was active when the picker opened.
- In chat-focus mode, the Sessions pane supports horizontal scrolling so long session titles are fully readable; do not force focus-mode session rows to truncate with ellipses.
- Summary markdown tables must render as real HTML tables in the portal. If summary text arrives with escaped newline sequences (`\\n`) in otherwise tabular markdown, normalize and render the table structure instead of showing raw pipe-delimited text.
- In the sessions pane, `V` toggles multi-select mode (seeded with the active session). `Space` toggles selection on the active row, `Ctrl+G` moves every selected top-level non-system session through the move-to-group picker, `c` cancels every selected session in one confirmation (system sessions and groups are skipped), `d` completes selected sessions, `D` hard-deletes selected sessions, and `Esc` exits select mode. The portal mirrors selection with Cmd/Ctrl-click and Shift-click on session rows; the panel header reveals `Clear`, `Group (n)`, and `Terminate (n)`. `Terminate (n)` opens the same three-disposition picker for Complete, Cancel, and Hard Delete.
- In the stats inspector, `f` cycles between the session, fleet, and users views; keep terminal and portal behavior aligned.
- In the sessions pane, `n` fast-starts a generic session with the default model when generic sessions are allowed; if generic sessions are disabled, it falls back to the model-first creation flow when models are available, or the agent picker. `Shift+N` opens the model picker, then reasoning effort when applicable, then the generic/named-agent picker.
- The New/New+Model agent picker is fed by `transport.listCreatableAgents()`, not by worker logs. In remote mode, `packages/app/tui/src/node-sdk-transport.js` builds that metadata from `PLUGIN_DIRS`; if `session-policy.json.creation.bundledAgents` opts into SDK-bundled agents such as `generic-crawler`, the transport must expand those names from `packages/sdk/plugins/default-agents/` into `creatableAgents` so both native remote TUI and portal bootstrap show them.
- The fleet stats view shows a compact `Fact Tombstones` card when facts tombstone
	backlog is nonzero. The card is fed by `getFactsTombstoneStats` through the shared
	transport/controller/reducer path and renders pending, unreconciled, TTL-blocked,
	oldest, and reconciled counts in `packages/app/ui/core/src/selectors.js`.
- In the files inspector, `x` deletes the selected artifact after confirmation; keep terminal and portal behavior aligned.
- In the native TUI, the files inspector should render inside the standard outer inspector shell rather than introducing a second files-specific top-level shell.
- In the portal inspector, reserve a consistent header row height so tabs with header actions and tabs without them start their tab strip at the same vertical position; keep inspector tab/action buttons compact rather than oversized.
- In the portal desktop workspace, Sessions render as a left-side column next to Chat. As the sessions/chat divider moves left, rows degrade from wrapped text to no-wrap rows with horizontal scrolling, then the Sessions pane disappears completely while the divider remains visible and can be dragged back open. The sessions/chat column divider and the main inspector divider are resizable; the right-column inspector/activity divider is resizable vertically. Preserve double-click reset plus arrow-key resizing on the drag handles, collapse panes once the divider is pushed far enough toward one edge, and keep the divider visible so a collapsed pane can be dragged back open.
- Persist portal theme, owner filter, pinned sessions, collapsed-session ids, active (selected) session id, chat transcript/summary mode, and pane split adjustments in `users.profile_settings` so browser/mobile sessions share the same preferences. The portal must not read or write browser localStorage/cookies for these preferences; it may only clear old legacy keys/cookies at startup. The native TUI persists the same `pinnedSessionIds`, `collapsedSessionIds`, `activeSessionId`, theme/filter/view mode, and pane adjustments in its user config file. If no stored `activeSessionId`/`collapsedSessionIds` exist yet, the shared default is the main PilotSwarm system session selected with every group/parent session collapsed.
- In the native TUI, keep the session/chat divider shared and capped: it is the chat resize control, and it must not let the top sessions pane grow beyond 50% of the full window height.
- Busy/system-session prompt sends now use a shared pending outbox: queued prompts render in chat as pending user items, `Enter` on an empty draft flushes the queued batch, `Up`/`Down` at the prompt boundary navigate queued items, and `Esc` cancels the selected queued item. Keep portal, TUI, status hints, and docs aligned with that behavior.
- Pending-question answers render an optimistic asked/answered transcript item as soon as the user submits. Keep that item visible while `sendAnswer` is in flight and after it is accepted, then let the durable `user.message` transcript replace it once history sync catches up; stale session refreshes must not restore the old question card or hide the submitted exchange.
- Recoverable live Copilot transport warnings (`Connection is closed` / `Live Copilot connection lost`) should remain stable in the chat pane while the session is still running a retry; running detail refreshes must not clear and re-add the same warning card.
- The chat live-activity `Working` card is governed by the session's running state, not by whether an assistant message has already appeared in the transcript. Assistant output can land before a turn is fully complete; keep the card visible until the session stops running.
- The Admin Console (`Shift+A` in the native TUI; toolbar `Admin` button in the portal) is a workspace-replacing surface for per-user settings. It must never display the raw GitHub Copilot key text — `selectAdminConsole` and `selectAdminGhcpKeyEditorModal` only carry the `githubCopilotKeySet` boolean and a masked editor value. The TUI and portal share the `state.admin` slice in `ui-core` and route every mutation through the controller (`beginAdminEditGhcpKey`, `setAdminGhcpKeyDraft`, `cancelAdminEditGhcpKey`, `saveAdminGhcpKey`, `clearAdminGhcpKey`, `refreshAdminProfile`); keep both hosts in sync if you add a new admin setting. Do not globally block New/New+Model when the per-user GitHub key is unset: GitHub models should fail only at create time when neither env `GITHUB_TOKEN` nor the per-user key is available, and non-GitHub providers must remain usable.
- Outbox items render with three visible delivery states next to the user-message label: `○` pending (client only), `✓` queued (durably enqueued), `✓✓` sent (persisted as a transcript `user.message`). Synchronous sends coalesce into a single durable enqueue; merge boundaries are not user-visible. Keep the glyph mapping in [packages/app/ui/core/src/selectors.js](../../../packages/app/ui/core/src/selectors.js) consistent across portal and TUI.

## Keybinding Rule

When a keybinding changes, update all user-facing surfaces together:

- the actual binding in `packages/app/tui/src/app.js`
- status-bar hints in `packages/app/ui/core/src/selectors.js`
- prompt affordance / placeholder copy
- modal/footer/detail help copy
- startup/help copy if present
- `.github/copilot-instructions.md`

## TUI vs Portal Divergences

The native TUI and browser portal share `ui-core` state and `ui-react` components but diverge in these areas:

| Aspect | Native TUI (`packages/app/tui`) | Portal (`packages/app/web`) |
|--------|----------------------------|---------------------------|
| Border radius | N/A (terminal box-drawing) | **Slight rounding** (`6px` / `8px`) — subtle corners, not pills |
| Scrollbars | Native terminal scrolling | **Custom dark scrollbars** — slim, theme-matched thumbs/tracks instead of browser-default white scrollbars |
| Structured chat blocks | Box-drawing cards/tables rendered as terminal text | **Web-native cards/tables** — the portal converts shared box-drawing system notices and markdown tables into wrapped HTML blocks for layout fidelity |
| Status bar / keybinding hints | Rendered in a status strip below the workspace | **Removed** — the portal has no keybinding hints strip; status/error text is shown in the toolbar next to New/Refresh/Theme buttons |
| Footer | Status strip + prompt | **No page-wide footer** — the prompt composer lives inside the chat pane so it stays scoped to Chat instead of spanning inspector/activity columns |
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
node --input-type=module -e "await import('./packages/app/ui/react/src/components.js'); await import('./packages/app/tui/src/platform.js')"
./run.sh local --db
```

Use targeted selector/controller smokes for shared UI logic. Boot the live TUI when changing layout, keybindings, prompt flow, modal behavior, or terminal rendering.
