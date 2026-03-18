# PilotSwarm TUI — Keybinding Cheat Sheet

This document matches the current shipped TUI behavior.

## Global Navigation Mode

These keys work when focus is not in the prompt editor.

| Key | Action |
|-----|--------|
| `?` | Open the keybinding help modal |
| `Esc` | Return to the Sessions pane and arm the quit sequence |
| `Esc` → `q` | Quit within 1 second |
| `Ctrl+C` | Quit immediately |
| `p` | Jump to the prompt editor |
| `Tab` / `Shift+Tab` | Cycle focus between panes |
| `h` / `l` | Move focus left / right |
| `m` | Cycle log mode: Workers → Orchestration → Sequence → Node Map |
| `v` | Toggle markdown viewer |
| `[` / `]` | Resize the right column |
| `r` | Force a full redraw |
| `u` | Dump the active session to `dumps/` |
| `a` | Open artifact picker for the active session |

## Sessions Pane

| Key | Action |
|-----|--------|
| `j` / `↓` | Move selection down |
| `k` / `↑` | Move selection up |
| `Enter` | Switch to selected session |
| `n` | Create a new session |
| `Shift+N` | Create a new session with the model picker |
| `t` | Rename session (typed title or LLM summary) |
| `+` / `=` | Expand sub-agent tree |
| `-` | Collapse sub-agent tree |
| `c` | Cancel selected session |
| `d` | Delete selected session |
| `r` | Refresh session list |

## Chat, Activity, Logs, and Node Map

These apply to the chat pane, activity pane, orchestration logs, worker logs, sequence view, and node map.

| Key | Action |
|-----|--------|
| `j` / `↓` | Scroll down |
| `k` / `↑` | Scroll up |
| `Ctrl+D` | Page down |
| `Ctrl+U` | Page up |
| `g` | Jump to top |
| `G` | Jump to bottom |
| `e` | Expand history for the active session |
| mouse wheel | Scroll the focused pane |

## Prompt Editor

| Key | Action |
|-----|--------|
| `Enter` | Submit prompt |
| `Option+Enter` | Insert newline and expand the prompt editor |
| `Esc` | Exit prompt mode and return to navigation |
| `/` | Open slash-command picker when the prompt is empty |
| `←` / `→` | Move by character |
| `Option+←` / `Option+→` | Move by word |
| `Backspace` | Delete backward by character |
| `Option+Backspace` | Delete backward by word |
| `Delete` | Delete forward by character |

## Markdown Viewer

### File list

| Key | Action |
|-----|--------|
| `j` / `k` | Move file selection |
| `Enter` | Open selected file in preview pane |
| `d` | Delete selected exported file |
| `v` | Exit markdown viewer |

### Preview pane

| Key | Action |
|-----|--------|
| `j` / `k` | Scroll preview |
| `g` / `G` | Jump to top / bottom |
| `Ctrl+D` / `Ctrl+U` | Page down / up |
| `o` | Open current file in `$EDITOR` |
| `y` | Copy current file path |
| `v` | Exit markdown viewer |

## Slash Command Picker

| Key | Action |
|-----|--------|
| `↑` / `↓` | Navigate commands |
| `Enter` | Select command |
| `Esc` | Dismiss picker |

## Slash Commands

| Command | Action |
|---------|--------|
| `/models` | List all available models across providers |
| `/model <name>` | Switch model for this session |
| `/info` | Show session info |
| `/done` | Complete and close this session |
| `/new` | Create a new session |
| `/help` | Show command list in chat |

## Modal Pickers and Dialogs

| Context | Keys |
|---------|------|
| help modal | `j/k`, arrows, `Ctrl+D/U`, `g/G`, mouse wheel, `Esc`, `?`, `q` |
| model picker | `j/k`, arrows, `Enter`, `Esc`, `q` |
| rename dialog | arrows, `Enter`, `Esc`, `q` |
| artifact picker | arrows, `Enter`, `Esc`, `q`, `a` |
