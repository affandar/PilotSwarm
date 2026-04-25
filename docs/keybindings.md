# PilotSwarm TUI — Keybinding Reference

This document matches the current terminal UI behavior in [`run.sh`](/Users/affandar/workshop/drox/pilotswarm/run.sh) and [`packages/cli/src/app.js`](/Users/affandar/workshop/drox/pilotswarm/packages/cli/src/app.js).

## Global Navigation

These keys work whenever focus is not in the prompt editor.

| Key | Action |
|-----|--------|
| `q` | Quit |
| `Ctrl+C` | Quit immediately |
| `Esc` | Return focus to Sessions |
| `Tab` / `Shift+Tab` | Cycle focus between panes |
| `h` / `l` | Move focus left / right |
| `p` | Focus the prompt editor |
| `n` | Create a new session |
| `Shift+N` | Open the model picker before creating a session |
| `r` | Refresh sessions and visible data |
| `a` | Open the linked-item picker for current chat artifacts and visible URLs |
| `m` | Cycle inspector tab (`sequence` → `logs` → `nodes` → `history` → `files` → `stats`) |
| `[` / `]` | Resize the main split |
| `c` | Cancel the selected session |
| `d` | Mark the selected session done |
| `Shift+D` | Delete the selected session |

## Sessions Pane

| Key | Action |
|-----|--------|
| `j` / `↓` | Move selection down |
| `k` / `↑` | Move selection up |
| `Ctrl+D` / `PageDown` | Page down |
| `Ctrl+U` / `PageUp` | Page up |
| `f` | Open the session owner filter |
| `+` / `=` | Expand the selected parent session |
| `-` | Collapse the selected session |
| `t` | Rename the selected session |

## Chat, Activity, Sequence, Logs, and Node Map

| Key | Action |
|-----|--------|
| `j` / `↓` | Scroll down |
| `k` / `↑` | Scroll up |
| `Ctrl+D` / `PageDown` | Page down |
| `Ctrl+U` / `PageUp` | Page up |
| `g` | Jump to top |
| `G` | Jump to bottom |
| `e` | Expand older chat history (chat pane only) |
| mouse wheel | Scroll the focused pane |
| drag with mouse | Select text and copy it to the clipboard |

### Logs-only

| Key | Action |
|-----|--------|
| `t` | Toggle tail mode |
| `f` | Open the log-filter dialog |

## Stats Inspector

| Key | Action |
|-----|--------|
| `f` | Cycle between `session`, `fleet`, and `users` stats views |

## Files Inspector

### File list

| Key | Action |
|-----|--------|
| `j` / `k` | Move file selection |
| `f` | Open the files-filter dialog (`Selected session` vs `All sessions`) |
| `x` | Delete the selected artifact (with confirmation) |
| `v` | Toggle fullscreen files mode |
| `o` | Open the selected file in the OS default app |

### Preview

| Key | Action |
|-----|--------|
| `j` / `k` | Scroll preview |
| `Ctrl+D` / `Ctrl+U` | Page preview down / up |
| `g` / `G` | Jump to preview top / bottom |
| `x` | Delete the selected artifact (with confirmation) |
| `v` | Toggle fullscreen files mode |
| `Esc` | Exit fullscreen files mode |
| `o` | Open the selected file in the OS default app |

## Prompt Editor

| Key | Action |
|-----|--------|
| `Enter` | Send the current message, or queue it behind pending prompts for busy/system sessions |
| `Option+Enter` / `Alt+Enter` | Insert a newline |
| `Ctrl+J` | Insert a newline |
| `Ctrl+A` | Attach a local file to the draft |
| `Esc` | Leave prompt mode and return to Sessions, or cancel the selected queued pending prompt |
| `←` / `→` | Move cursor by character |
| `↑` / `↓` | Move cursor vertically across prompt lines, then enter/leave queued pending-prompt editing at the top/bottom boundary |
| `Option+←` / `Option+→` | Move cursor by word |
| `Backspace` / `Delete` | Delete one character |
| `Option+Backspace` / `Option+Delete` | Delete the previous word |

Notes:

- The prompt grows to a three-line viewport and then scrolls as you keep adding lines.
- Attached files are uploaded immediately and inserted into the outgoing prompt as `artifact://...` references when the message is sent.
- Every send first lands in a per-session local outbox, then transitions through three durability states shown next to each user message in chat:
  - `○` pending — client-only, not yet acknowledged by the runtime
  - `✓` queued — durably enqueued to the orchestration, waiting to be processed
  - `✓✓` sent — persisted as a `user.message` in the durable transcript; the LLM has it
- Multiple synchronous sends coalesce into a single durable enqueue. Pressing `Enter` on an empty draft forces an immediate dispatch of any still-pending items.
- Pressing `↑` at the top prompt boundary recalls the most recent pending item for editing. Pressing `↓` at the bottom boundary moves forward through pending items and eventually returns to the live draft.
- `Esc` while editing a recalled pending item cancels that item before it becomes durable.

## Modals and Dialogs

| Context | Keys |
|---------|------|
| model picker | `j/k`, arrows, `Enter`, `Esc` |
| session agent picker | `j/k`, arrows, `Enter`, `Esc` |
| session owner filter | `j/k`, arrows, `Space`, `Esc` |
| linked-item picker | `j/k`, arrows, `Enter`, `Esc`, `a` |
| log/files filters | `Tab` / `Shift+Tab`, `j/k`, arrows, `Enter`, `Esc` |
| rename dialog | type text, `←/→`, `Home`, `End`, `Backspace`, `Enter`, `Esc` |
| attach-file dialog | type path, `←/→`, `Home`, `End`, `Backspace`, `Enter`, `Esc` |
