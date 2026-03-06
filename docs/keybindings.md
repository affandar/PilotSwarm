# PilotSwarm TUI — Keybinding Cheat Sheet

## Global (any pane, except when typing in input bar)

| Key | Action |
|-----|--------|
| `Esc` | Focus Sessions pane, start quit sequence |
| `Esc` → `q` | Quit (within 1 second) |
| `p` | Jump to input/prompt bar |
| `Tab` | Cycle focus: Sessions → Chat → Right pane(s) → Activity → Sessions |
| `h` | Move focus left (right pane → chat → sessions) |
| `l` | Move focus right (sessions → chat → right pane) |
| `m` | Cycle right-pane log mode: Workers → Orch Logs → Sequence → Node Map |
| `r` | Force full screen redraw |
| `[` | Shrink right column (grow left) |
| `]` | Grow right column (shrink left) |
| `u` | Dump active session to Markdown file (`dumps/`) |
| `Ctrl+C` | Quit immediately |

## Sessions Pane (focused on session list)

| Key | Action |
|-----|--------|
| `j` / `↓` | Move selection down |
| `k` / `↑` | Move selection up |
| `Enter` | Switch to selected session |
| `n` | Create new session (default model) |
| `Shift+N` | Create new session with model picker |
| `t` | Rename session (custom title or LLM summary) |
| `c` | Cancel selected session's orchestration |
| `d` | Delete selected session (cancel + remove from catalog) |
| `r` | Refresh session list |
| `q` | Quit |

## Chat Pane (focused on chat box)

| Key | Action |
|-----|--------|
| `j` / `↓` | Scroll down one line |
| `k` / `↑` | Scroll up one line |
| `Ctrl+D` | Page down |
| `Ctrl+U` | Page up |
| `g` | Scroll to top |
| `G` | Scroll to bottom |

## Activity Pane

| Key | Action |
|-----|--------|
| `j` / `↓` | Scroll down one line |
| `k` / `↑` | Scroll up one line |
| `Ctrl+D` | Page down |
| `Ctrl+U` | Page up |
| `g` | Scroll to top |
| `G` | Scroll to bottom |

## Right Panes (Worker Logs / Orch Logs / Sequence / Node Map)

| Key | Action |
|-----|--------|
| `j` / `↓` | Scroll down one line |
| `k` / `↑` | Scroll up one line |
| `Ctrl+D` | Page down |
| `Ctrl+U` | Page up |
| `g` | Scroll to top |
| `G` | Scroll to bottom |

## Input Bar (typing a message)

| Key | Action |
|-----|--------|
| `Enter` | Send message |
| `Esc` | Exit input bar → navigate TUI |
| `/` | Open slash command picker (when input is empty) |
| `Alt+Backspace` | Delete previous word |

## Slash Command Picker (when `/` pressed in empty input)

| Key | Action |
|-----|--------|
| `↑` / `↓` | Navigate commands |
| `Enter` | Select command, paste into input |
| `Esc` | Dismiss picker |

## Slash Commands (typed in input bar)

| Command | Action |
|---------|--------|
| `/models` | List all available models across providers |
| `/model <name>` | Switch model for this session (e.g. `/model azure-openai:gpt-4.1`) |
| `/info` | Show session info (model, iteration, affinity, hydration) |
| `/done` | Complete and close this session (cascades to sub-agents) |
| `/new` | Create a new session |
| `/help` | Show command list |

## Rename Dialog (after pressing `t`)

| Key | Action |
|-----|--------|
| `↑` / `↓` | Select: custom title / LLM summary / cancel |
| `Enter` | Confirm selection |
| `Esc` / `q` | Cancel |

## Model Picker (after pressing `Shift+N`)

| Key | Action |
|-----|--------|
| `j` / `↓` | Move selection down |
| `k` / `↑` | Move selection up |
| `Enter` | Create session with selected model |
| `Esc` / `q` | Cancel |
