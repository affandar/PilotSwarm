# Portal: PilotSwarm Native Web Experience

> **Status:** Proposal  
> **Date:** 2026-03-22  
> **Goal:** A native web UI with full TUI feature parity — no terminal emulation, pure web-native rendering.

---

## Philosophy

Drop the terminal metaphor for _most_ things — rich text instead of ANSI, SVG instead of ASCII diagrams, CSS animations instead of spinner characters, real Markdown rendering instead of terminal approximation. **Exception: splash screens keep their ASCII art.** The ASCII art is the brand. It works in the TUI, it works on the web (monospace `<pre>` with CSS color), and maintaining one set of splash content for both surfaces is a significant advantage.

Same backend. Same SDK APIs. Same splash art. Better everything else.

---

## Architecture

```
Browser (React + Vite)
  │
  ├── WebSocket ──► Portal Server (Express + ws)
  │                    │
  │                    ├── PilotSwarmClient
  │                    ├── PilotSwarmManagementClient
  │                    └── PilotSwarmWorker (embedded or remote)
  │                           │
  │                           └── duroxide + Copilot SDK
  │
  └── REST (session list, models, artifacts)
```

Same API boundary rules as the TUI — only public `PilotSwarmClient`, `PilotSwarmManagementClient`, and `PilotSwarmWorker` APIs. No internal module imports.

---

## Layout

Three-region responsive shell: **sidebar**, **main content**, **inspector panel**.

```
┌──────────────────────────────────────────────────────────────────────────────┐
│  ● PilotSwarm                                          🔍  ⚙️  ?  user ▾   │
├─────────────┬────────────────────────────────────────┬───────────────────────┤
│             │                                        │                       │
│  SIDEBAR    │           MAIN CONTENT                 │   INSPECTOR           │
│  (260px)    │           (flex)                       │   (360px, collapsible)│
│             │                                        │                       │
│  Sessions   │  Chat / Splash / Agent Picker          │  Activity / Logs /    │
│  tree +     │                                        │  Sequence / NodeMap / │
│  controls   │                                        │  Markdown Viewer      │
│             │                                        │                       │
├─────────────┼────────────────────────────────────────┤                       │
│             │  Input                                 │                       │
├─────────────┴────────────────────────────────────────┴───────────────────────┤
│  Status bar                                                                  │
└──────────────────────────────────────────────────────────────────────────────┘
```

---

## Mock 1: Startup Splash

The **same ASCII art** from [tui-splash.txt](../../packages/cli/cli/tui-splash.txt) rendered in a monospace `<pre>` block with CSS-applied colors. Dark background, centered, with a "+ New Session" button below. One splash source for both TUI and web.

```
┌──────────────────────────────────────────────────────────────────────────────┐
│  ● PilotSwarm                                                    ⚙️  ?     │
├──────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│                                                                              │
│                  ┌──────────────────────────────────────────┐                │
│                  │                                          │                │
│                  │     ____  _ __      __  _____            │                │
│                  │    / __ \(_) /___  / /_/ ___/            │                │
│                  │   / /_/ / / / __ \/ __/\__ \  | /| /    │                │
│                  │  / ____/ / / /_/ / /_ ___/ / |/ |/      │                │
│                  │ /_/   /_/_/\____/\__//____/|__/|__/     │                │
│                  │                                          │                │
│                  │   Durable AI Agent Orchestration          │                │
│                  │   Crash recovery · Durable timers ·       │                │
│                  │   Sub-agents · Multi-node scaling          │                │
│                  │   Powered by duroxide + GitHub Copilot SDK │                │
│                  │                                          │                │
│                  └──────────────────────────────────────────┘                │
│                    ↑ monospace <pre>, dark card, centered                    │
│                    ↑ line colors: cyan → magenta → yellow (CSS classes)      │
│                                                                              │
│                       ┌───────────────────────┐                              │
│                       │   + New Session        │   ← primary button          │
│                       └───────────────────────┘                              │
│                                                                              │
│                                                                              │
├──────────────────────────────────────────────────────────────────────────────┤
│  Connected · 2 workers online                                    v0.8.0     │
└──────────────────────────────────────────────────────────────────────────────┘
```

**Rendering details:**
- The ASCII art lives in a shared file (e.g. `tui-splash.txt` or a new `splash.txt` in a shared location)
- Blessed tags (`{cyan-fg}`, `{magenta-fg}`, `{yellow-fg}`) are converted to CSS `<span>` classes: `.splash-cyan { color: #00d4ff }`, `.splash-magenta { color: #ff00ff }`, `.splash-yellow { color: #ffd700 }`
- Background: radial gradient `#0d0d1a` → `#1a1a2e`
- The `<pre>` block is inside a centered card with subtle border and `border-radius: 8px`
- Entrance animation: card fades up 300ms, button pulses gently once
- Same converter can be reused for agent splashes

---

## Mock 2: Agent Picker

Clicking "+ New Session" opens a card-based agent picker (not a list — each agent gets a visual card).

```
┌──────────────────────────────────────────────────────────────────────────────┐
│  ● PilotSwarm                                                    ⚙️  ?     │
├──────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│                         Choose an Agent                                      │
│                    24px, white, centered                                     │
│                                                                              │
│    ┌──────────────────┐  ┌──────────────────┐  ┌──────────────────┐         │
│    │                  │  │                  │  │                  │         │
│    │     ✦            │  │     🔍           │  │     🚀           │         │
│    │  Generic         │  │  Investigator    │  │  Deployer        │         │
│    │                  │  │                  │  │                  │         │
│    │  Open-ended work │  │  Incident resp-  │  │  Deployment      │         │
│    │  any topic       │  │  onse + root     │  │  automation +    │         │
│    │                  │  │  cause analysis  │  │  rollback mgmt   │         │
│    │  ─── white ───   │  │  ─── red ───    │  │  ─── blue ───   │         │
│    └──────────────────┘  └──────────────────┘  └──────────────────┘         │
│                                                                              │
│    ┌──────────────────┐                                                      │
│    │                  │     Model: claude-sonnet-4-20250514 ▾                           │
│    │     📊           │     (dropdown selector)                              │
│    │  Reporter        │                                                      │
│    │                  │                                                      │
│    │  Status reports  │                                                      │
│    │  + summaries     │                                                      │
│    │                  │                                                      │
│    │  ─── green ───  │                                                      │
│    └──────────────────┘                                                      │
│                                                                              │
│                                                    [Cancel]  [Create]        │
├──────────────────────────────────────────────────────────────────────────────┤
│  Select an agent type                                            v0.8.0     │
└──────────────────────────────────────────────────────────────────────────────┘
```

**Details:**
- Cards have a 1px border in the agent's accent color, darkened at rest, full brightness on hover
- Hover: card lifts 2px (`box-shadow` + `translateY(-2px)`), border glows
- Selected: solid accent border + checkmark badge
- Model dropdown in the bottom area — default pre-selected, can override before creating
- Keyboard: arrow keys to navigate cards, Enter to select, `n` to skip and create generic

---

## Mock 3: Active Session — Chat View

Chat messages rendered as styled HTML blocks — not monospace terminal text.

```
┌──────────────────────────────────────────────────────────────────────────────┐
│  ● PilotSwarm                                          🔍  ⚙️  ?  user ▾   │
├─────────────┬────────────────────────────────────────┬───────────────────────┤
│  SESSIONS   │  deploy-fix-march                      │ ACTIVITY              │
│  ─────────  │  claude-sonnet-4-20250514 · iter 3 · ab12cd34      │ ─────────             │
│             │────────────────────────────────────────│                       │
│  + New      │                                        │ 14:32:09              │
│             │  ┌─ You ──────────── 14:32:01 ─┐      │ ▶ read_file           │
│ ▸ ● Deploy  │  │ Fix the deployment pipeline  │      │   pipeline.yml        │
│   fix-march │  │ for the March release. The   │      │                       │
│   ab12cd34  │  │ staging environment is        │      │ 14:32:11              │
│             │  │ timing out.                   │      │ ✓ read_file  2.1s     │
│   ○ Generic │  └──────────────────────────────┘      │                       │
│   ef56gh78  │                                        │ 14:32:11              │
│             │  ┌─ Copilot ─────── 14:32:08 ─┐       │ ▶ search_code         │
│  ≋ System   │  │                             │       │   query="timeout"     │
│  ─────────  │  │ I'll investigate the staging│       │                       │
│  ≋ PilotSwarm│  │ deployment pipeline. Let me │       │ 14:32:14              │
│    Agent    │  │ check the configuration and │       │ ✓ search_code  2.8s   │
│  ≋ Sweeper  │  │ recent changes.             │       │                       │
│    Agent    │  │                             │       │───────────────────────│
│             │  │ ▸ read_file pipeline.yml  ✓ │       │ LOGS  Per-Worker  ▾   │
│             │  │   2.1s                      │       │ ─────────────────     │
│             │  │ ▸ search_code "timeout"  ✓  │       │                       │
│             │  │   2.8s                      │       │ worker-7x92k          │
│             │  │                             │       │ ● runTurn ab12cd34    │
│             │  │ The timeout is caused by a  │       │ ● registerTools [3]   │
│             │  │ misconfigured health check  │       │ ◆ orch yield          │
│             │  │ in `pipeline.yml` on line   │       │ ● runTurn complete    │
│             │  │ 42. The `timeout` value is  │       │                       │
│             │  │ set to `5s` but the staging │       │ worker-3m41n          │
│             │  │ container takes ~30s to     │       │ ● runTurn ef56gh78    │
│             │  │ initialize.                 │       │ (idle)                │
│             │  │                             │       │                       │
│             │  └─────────────────────────────┘       │                       │
│             │                                        │                       │
│             │  ┌─ ⠋ Thinking… ───────────────┐       │                       │
│             │  └─────────────────────────────┘       │                       │
│             │                                        │                       │
│─────────────│────────────────────────────────────────│                       │
│             │  ┌──────────────────────────────────┐  │                       │
│             │  │  Message PilotSwarm…         ⏎  │  │                       │
│             │  └──────────────────────────────────┘  │                       │
├─────────────┴────────────────────────────────────────┴───────────────────────┤
│  p prompt · ? help · Esc quit                            2 workers · 3 sess │
└──────────────────────────────────────────────────────────────────────────────┘
```

**Chat rendering details:**

- **User messages**: Right-aligned (or left with distinct bg), rounded card, subtle dark border, white text
- **Copilot messages**: Left-aligned card, slightly lighter background (`#1e2a3a`), full Markdown rendering:
  - Inline code in `monospace` with darker bg pill
  - Code blocks with syntax highlighting (Shiki/Prism)
  - Links as real clickable `<a>` tags
  - Lists, headings, tables — full Markdown
- **Tool calls**: Collapsible accordion inside the message card
  - Header: `▸ read_file pipeline.yml ✓ 2.1s` — green check on success, red X on failure
  - Click to expand: shows arguments + truncated result
  - Yellow `▶` while running, green `✓` complete, red `✗` failed
- **Thinking indicator**: Pulsing dot animation (CSS `@keyframes`), not ASCII spinner
- **Timestamps**: Muted gray, right-aligned in message header

---

## Mock 4: Agent Splash (in-chat)

When a session opens with an agent, the splash renders as the **same ASCII art from the TUI** inside a styled `<pre>` card in the chat area. Blessed color tags are converted to CSS spans. The card gets a subtle accent border matching the agent's color.

```
│────────────────────────────────────────│
│                                        │
│  ┌─ red accent border ───────────────┐│
│  │                                    ││
│  │   ___                 _   _        ││
│  │  |_ _|_ ____   _____ | |_(_) __ _ ││
│  │   | || '_ \ \ / / _ \| __| |/ _` |││
│  │   | || | | \ V / (_) | |_| | (_| |││
│  │  |___|_| |_|\_/ \___/ \__|_|\__, |││
│  │                               |___/││
│  │                                    ││
│  │  Incident Response +               ││
│  │  Root Cause Analysis               ││
│  │                                    ││
│  │  Guided flow: service, timeframe,  ││
│  │  symptoms, recent deploy, user     ││
│  │  impact.                           ││
│  │                                    ││
│  │             monospace <pre>        ││
│  │             CSS color per line     ││
│  └────────────────────────────────────┘│
│                                        │
│  ● Waiting for your first message…    ││
│                                        │
```

**Each agent's splash card uses the same ASCII art source as the TUI.** The only web-specific addition is the accent border color on the card:

| Agent | Card border | Text color source |
|-------|-------------|-------------------|
| Generic | `#888` (gray) | blessed tags → CSS |
| Investigator | `#ff4444` (red) | blessed `{red-fg}` → `.splash-red` |
| Deployer | `#0088ff` (blue) | blessed `{blue-fg}` → `.splash-blue` |
| Reporter | `#00ff88` (green) | blessed `{green-fg}` → `.splash-green` |
| System agents | `#ffd700` (yellow) | blessed `{yellow-fg}` → `.splash-yellow` |

---

## Mock 5: Sequence Diagram (Inspector Panel)

Click the "Sequence" tab in the inspector. This is a **real SVG** — not ASCII:

```
│ INSPECTOR                              │
│ [Activity] [Logs ▾] [Sequence] [Nodes] │
│ ───────────────────────────────────────│
│                                        │
│  ┌─ worker-7x92k ─┐  ┌─ worker-3m41n ─┐│
│  │                 │  │                 ││
│  │  ┌───────────┐  │  │                 ││
│  │  │ runTurn   │  │  │                 ││
│  │  │ ab12cd34  │  │  │                 ││
│  │  │           │  │  │                 ││
│  │  │ ▸ read    │  │  │                 ││
│  │  │   2.1s ✓  │  │  │                 ││
│  │  │           │  │  │                 ││
│  │  │ ▸ search  │  │  │  ┌───────────┐ ││
│  │  │   2.8s ✓  │  │  │  │ runTurn   │ ││
│  │  │           │  │  │  │ ef56gh78  │ ││
│  │  │ ✓ done    │  │  │  │           │ ││
│  │  └───────────┘  │  │  │ (idle)    │ ││
│  │                 │  │  └───────────┘ ││
│  └─────────────────┘  └─────────────────┘│
│                                        │
│  ──────── time axis (top to bottom) ───│
│                                        │
│  Hover: tooltip with full activity     │
│  details, duration, arguments          │
│  Click: jump to that turn in chat      │
│  Scroll: mouse wheel or drag           │
│  Zoom: pinch or Ctrl+scroll            │
│                                        │
```

---

## Mock 6: Node Map (Inspector Panel)

```
│ INSPECTOR                              │
│ [Activity] [Logs ▾] [Sequence] [Nodes] │
│ ───────────────────────────────────────│
│                                        │
│  2 Workers Online                      │
│                                        │
│  ┌─── worker-7x92k ───────────────┐   │
│  │  ● Deploy fix-march  (ab12cd34)│   │
│  │  ≋ PilotSwarm Agent            │   │
│  │                                 │   │
│  │  CPU ━━━━━━━░░░ 62%             │   │
│  │  Mem ━━━━░░░░░░ 41%             │   │
│  └─────────────────────────────────┘   │
│                                        │
│  ┌─── worker-3m41n ───────────────┐   │
│  │  ○ Generic session   (ef56gh78)│   │
│  │  ≋ Sweeper Agent               │   │
│  │                                 │   │
│  │  CPU ━━░░░░░░░░ 18%             │   │
│  │  Mem ━━━░░░░░░░ 33%             │   │
│  └─────────────────────────────────┘   │
│                                        │
│  Legend                                │
│  ● running  ○ idle  ◐ waiting          │
│  ◑ input    ◉ error                    │
│                                        │
```

---

## Mock 7: Markdown Viewer (Inspector Panel)

```
│ INSPECTOR                              │
│ [Activity] [Logs ▾] [Sequence] [Nodes] │
│ [📄 Files]                             │
│ ───────────────────────────────────────│
│                                        │
│  FILES                                 │
│  ┌─────────────────────────────────┐   │
│  │ ▸ 📥 incident-report.md        │   │
│  │   📥 deploy-runbook.md         │   │
│  │   📄 dump-ab12cd34.md          │   │
│  └─────────────────────────────────┘   │
│                                        │
│  PREVIEW                               │
│  ┌─────────────────────────────────┐   │
│  │ # Incident Report              │   │
│  │                                 │   │
│  │ ## Summary                      │   │
│  │                                 │   │
│  │ The staging pipeline was timing │   │
│  │ out due to a misconfigured      │   │
│  │ health check in `pipeline.yml`. │   │
│  │                                 │   │
│  │ ## Root Cause                   │   │
│  │                                 │   │
│  │ The `timeout` value on line 42  │   │
│  │ was set to `5s` but the staging │   │
│  │ container requires ~30s.        │   │
│  │                                 │   │
│  │ ```yaml                         │   │
│  │ healthCheck:                    │   │
│  │   timeout: 5s  # ← was this    │   │
│  │   timeout: 30s # ← now this    │   │
│  │ ```                             │   │
│  └─────────────────────────────────┘   │
│  [⬇ Download]  [📋 Copy]  [🗑 Delete]  │
│                                        │
```

**Web advantage**: Real rendered Markdown with syntax-highlighted code blocks, not terminal approximation.

---

## Mock 8: Slash Command Autocomplete

Typing `/` in the input bar shows a dropdown:

```
│  ┌──────────────────────────────────┐  │
│  │  /models    List available models│  │
│  │  /model     Switch model         │  │
│  │  /info      Session info         │  │
│  │  /done      Close session        │  │
│  │  /new       New session          │  │
│  │  /help      Show all commands    │  │
│  └──────────────────────────────────┘  │
│  ┌──────────────────────────────────┐  │
│  │  /█                          ⏎  │  │
│  └──────────────────────────────────┘  │
```

Fuzzy-filtered as you type. Arrow keys to select, Enter to execute, Esc to dismiss.

---

## Mock 9: Help Overlay

Press `?` anywhere. A centered modal with grouped shortcuts:

```
┌──────────────────────────────────────────────────────────────────────┐
│                                                                      │
│   ┌──────────────────────────────────────────────────────────────┐   │
│   │                   Keyboard Shortcuts                     ✕   │   │
│   │──────────────────────────────────────────────────────────────│   │
│   │                                                              │   │
│   │  NAVIGATION                      SESSIONS                   │   │
│   │                                                              │   │
│   │  Tab          Cycle panels       n        New session        │   │
│   │  Shift+Tab    Cycle reverse      N        New + model pick   │   │
│   │  p            Focus input        Enter    Switch session     │   │
│   │  h / l        Left / right       t        Rename             │   │
│   │  ?            This help          c        Cancel             │   │
│   │  Esc          Exit / quit        d        Delete             │   │
│   │                                  j / k    Navigate list      │   │
│   │  CHAT                            +/-      Expand/collapse    │   │
│   │                                                              │   │
│   │  j / k        Scroll             INSPECTOR                   │   │
│   │  g / G        Top / bottom                                   │   │
│   │  e            Load more history  m        Cycle view mode    │   │
│   │  a            Artifact picker    v        Markdown viewer    │   │
│   │  u            Dump to .md        [ / ]    Resize panels      │   │
│   │                                                              │   │
│   │  INPUT                           SLASH COMMANDS              │   │
│   │                                                              │   │
│   │  Enter        Send               /models  List models        │   │
│   │  Alt+Enter    Newline            /model   Switch model       │   │
│   │  Alt+←/→      Word jump         /info    Session info        │   │
│   │  /            Commands           /done    Close session       │   │
│   │                                                              │   │
│   │                          [Esc] Close                         │   │
│   └──────────────────────────────────────────────────────────────┘   │
│                                                                      │
└──────────────────────────────────────────────────────────────────────┘
```

---

## Mock 10: Session Sidebar Detail

The sidebar is more than a flat list — it's a structured, interactive tree:

```
│  SESSIONS                        │
│  ─────────────────────────────── │
│  ┌─ + New Session ─────────────┐ │
│  └─────────────────────────────┘ │
│                                  │
│  USER SESSIONS                   │
│                                  │
│  ▸ ● Deploy fix-march           │
│    │  ab12cd34 · claude-sonnet-4-20250514    │
│    │  iter 3 · 2 min ago         │
│    │                             │
│    └─ ● sub-agent: check-pods   │
│       cd34ef56 · child           │
│                                  │
│    ○ Generic session             │
│      ef56gh78 · claude-sonnet-4-20250514     │
│      idle · 15 min ago           │
│                                  │
│  SYSTEM                          │
│                                  │
│  ≋ PilotSwarm Agent              │
│    always-on · yellow accent     │
│                                  │
│  ≋ Sweeper Agent                 │
│    always-on · yellow accent     │
│                                  │
│  ≋ Resource Manager              │
│    always-on · yellow accent     │
│                                  │
│  ─────────────────────────────── │
│  3 sessions · 2 system           │
│                                  │
```

**Interactions:**
- Click session → switch to it
- Right-click → context menu: Rename / Cancel / Delete / Dump
- Drag divider to resize sidebar
- Collapse tree with `▸` / `▾` chevrons
- Unseen changes: blue dot badge on session row
- Status dot colors: green (●), gray (○), yellow (◐), cyan (◑), red (◉)
- System sessions grouped separately, cannot be deleted/cancelled

---

## Comparison: TUI vs Native Web

| Aspect | TUI (blessed) | Native Web |
|--------|--------------|------------|
| **Splash screen** | ASCII art with ANSI color codes | Same ASCII art, monospace `<pre>` with CSS colors |
| **Chat messages** | Monospace, blessed tags, manual line wrapping | Rich HTML, full Markdown, syntax highlighting |
| **Tool calls** | Inline text `▶ tool_name ✓` | Collapsible accordion with arguments + result |
| **Thinking indicator** | ASCII spinner `⠋⠙⠹` | CSS pulsing dots or skeleton animation |
| **URLs** | ANSI color + underline, terminal click handler | Real `<a href>` tags, native browser behavior |
| **Sequence diagram** | ASCII columns, fixed-width | SVG with zoom, pan, hover tooltips, click-to-jump |
| **Node map** | ASCII grid | Card layout with utilization bars |
| **Markdown viewer** | Terminal-approximated render | Real Markdown → HTML with Shiki highlighting |
| **Slash commands** | Basic picker list | Fuzzy-filter autocomplete dropdown |
| **Session tree** | Single-column list with indent | Interactive tree with context menus, badges |
| **Layout resize** | `[` / `]` in 8-char increments | Drag handles, smooth resize |
| **Notifications** | Terminal bell or status flash | Browser Notification API |
| **Multi-session** | Tab-switch with key | Click, or Cmd+click for split view |
| **Copy/paste** | Terminal clipboard | Native browser clipboard |
| **Search** | Not available | Ctrl+F across rendered chat |

---

## Technology Stack

| Layer | Choice | Rationale |
|-------|--------|-----------|
| **Framework** | React 18 + TypeScript | Component model maps 1:1 to panes |
| **Styling** | Tailwind CSS + CSS variables | Dark theme, rapid iteration |
| **Markdown** | `react-markdown` + `rehype-highlight` + Shiki | Rich rendering with syntax highlighting |
| **Diagrams** | Custom SVG (React components) | Full control over swimlanes, interactivity |
| **Build** | Vite | Fast HMR, TypeScript, ESM-native |
| **Server** | Express + `ws` | Minimal SDK bridge |
| **Transport** | WebSocket (bidirectional) | Real-time events + message sending |
| **State** | Zustand or React Context | Lightweight, no Redux overhead |
| **Routing** | React Router | `/`, `/session/:id`, `/settings` |
| **Animations** | Framer Motion | Splash entrance, panel transitions |

---

## Package Structure

```
packages/portal/
  package.json
  vite.config.ts
  server.js              — Express + WS bridge to PilotSwarm SDK
  index.html             — SPA entry
  src/
    main.tsx             — React root
    App.tsx              — Shell layout (sidebar / main / inspector)
    theme.ts             — Color tokens, dark theme
    ws.ts                — WebSocket client wrapper

    components/
      layout/
        Shell.tsx            — Top-level app shell
        Sidebar.tsx          — Session tree panel
        Inspector.tsx        — Right panel (tabbed)
        StatusBar.tsx        — Bottom status + hints
        PanelDivider.tsx     — Draggable resize handle

      chat/
        ChatView.tsx         — Message list + scroll
        MessageCard.tsx      — Single message (user / copilot)
        ToolCallAccordion.tsx — Collapsible tool result
        ThinkingIndicator.tsx — Pulsing dot animation
        InputBar.tsx         — Message input + slash commands
        SlashCommandMenu.tsx — Autocomplete dropdown

      splash/
        StartupSplash.tsx    — ASCII art landing (shared splash source)
        AgentSplash.tsx      — ASCII art agent card (shared splash source)
        AgentPicker.tsx      — New session card grid
        blessedToHtml.ts     — Convert blessed tags → CSS-colored <span>s

      inspector/
        ActivityPane.tsx     — Tool execution timeline
        LogViewer.tsx        — Per-worker / per-orch logs
        SequenceDiagram.tsx  — SVG swimlane
        NodeMap.tsx          — Worker grid cards
        MarkdownViewer.tsx   — File browser + preview

      overlay/
        HelpOverlay.tsx      — Keyboard shortcut modal
        SessionInfoModal.tsx — /info display
        ConfirmDialog.tsx    — Delete/cancel confirmation

    hooks/
      useSession.ts        — Active session state + events
      useSessions.ts       — Session list + management
      useWebSocket.ts      — WS connection lifecycle
      useKeyboard.ts       — Global keyboard shortcut handler
      useInspector.ts      — Inspector tab state + cycling

    lib/
      api.ts               — WS message protocol types
      format.ts            — Timestamp formatting, status labels
      theme.ts             — CSS variable definitions
```

---

## Implementation Phases

### Phase 1: Shell + Chat (MVP)
- Express + WS server bridging `PilotSwarmClient`
- React shell with sidebar (static) + chat pane + input bar
- Message rendering: user/copilot cards with Markdown
- Single session: create, send, receive
- Thinking indicator
- Startup splash (static, styled)

### Phase 2: Session Management
- Live session list from `ManagementClient.listSessions()`
- Session tree with parent/child hierarchy
- Create / switch / rename / cancel / delete
- Agent picker cards
- Agent splash cards in chat
- Status indicators (dot colors + labels)
- Unseen change badges

### Phase 3: Inspector Panel
- Activity timeline (tool calls)
- Per-worker log streaming
- Per-orchestration filtered view
- Tab cycling (`m` key)
- Panel resize (drag handle)

### Phase 4: Advanced Views
- SVG sequence diagram with zoom/pan/hover
- Node map with worker cards
- Markdown viewer (file list + rendered preview)
- Artifact picker + browser download

### Phase 5: Polish + Shortcuts
- Full keyboard shortcut parity
- Help overlay modal
- Context-sensitive status bar hints
- Slash command autocomplete
- Browser notifications
- URL routing (`/session/:id`)
- Responsive breakpoints (tablet/mobile)
- Entrance animations (Framer Motion)

---

## Packaging: `pilotswarm-web`

The web experience ships as a **separate npm package**: `pilotswarm-web`.

```
packages/
  sdk/       → pilotswarm-sdk     (runtime, unchanged)
  cli/       → pilotswarm-cli     (TUI, unchanged)
  portal/    → pilotswarm-web     (new)
```

**Why separate:**
- Different dependency tree: React, Vite, Tailwind, etc. — none of which the TUI or SDK need
- Different build pipeline: Vite for the frontend, plain tsc for the SDK
- Independent release cadence: web UI can iterate faster without touching runtime
- Clean install story: `npm install pilotswarm-web` pulls only what you need
- SDK stays a peer dependency — the portal server imports `pilotswarm-sdk` at runtime

**Dependency graph:**
```
pilotswarm-web
  ├── pilotswarm-sdk  (peer dependency)
  ├── express
  ├── ws
  ├── react, react-dom
  ├── vite (devDependency)
  └── tailwindcss (devDependency)

pilotswarm-cli
  └── pilotswarm-sdk  (dependency)

pilotswarm-sdk
  └── duroxide, @anthropic-ai/sdk, etc.
```

**Usage:**
```bash
# Install
npm install pilotswarm-web

# Run (starts Express server + serves built React app)
npx pilotswarm-web --env .env.remote
npx pilotswarm-web --port 3000
npx pilotswarm-web --workers 4           # embedded workers
npx pilotswarm-web --workers 0           # remote workers (AKS)

# Or use alongside the CLI
npm install pilotswarm-cli pilotswarm-web
npx pilotswarm           # TUI
npx pilotswarm-web       # Web portal
```

**Shared splash content:** The ASCII art splash files live in `pilotswarm-sdk` (or a shared `splash/` directory) so both `pilotswarm-cli` and `pilotswarm-web` read from the same source. One change to a splash file updates both surfaces.

---

## Open Questions

1. **Auth**: Local-only (same as TUI) or multi-user with GitHub OAuth?
2. **Split view**: Allow opening two sessions side-by-side in the main content area?
3. **Chat export**: Besides Markdown dump, offer PDF or HTML export?
4. **Theme**: Dark-only (matching TUI) or offer a light theme toggle?
5. **Shared splash location**: Keep in `pilotswarm-sdk` or create a tiny `pilotswarm-splash` shared package?
