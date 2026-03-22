# Portal: PilotSwarm Web Experience

> **Status:** Proposal  
> **Date:** 2026-03-22  
> **Goal:** Feature-parity browser portal mirroring the TUI, with terminal-in-browser chat and splash screens.

---

## Overview

The Portal is a browser-based companion to the TUI that provides the **exact same capabilities** — session management, real-time chat, agent splash screens, sequence diagrams, node maps, artifact downloads, and observability — rendered in a modern web interface. The main chat window uses a **terminal-in-browser** (xterm.js) to preserve the TUI's aesthetic: colored output, ASCII splash art, spinner animations, and blessed-style formatting.

**Same backend. Same APIs. Different surface.**

```
┌──────────────────────────────────────────────────────────────┐
│                    PilotSwarm Portal                         │
│                                                              │
│   Browser (React + xterm.js)                                 │
│        │                                                     │
│        ├── PilotSwarmClient  (WebSocket bridge)               │
│        ├── PilotSwarmManagementClient                         │
│        └── PilotSwarmWorker  (same process or remote)         │
│              │                                               │
│              └── duroxide + Copilot SDK                       │
└──────────────────────────────────────────────────────────────┘
```

---

## Architecture

### API Boundary (unchanged)

The Portal uses the **same public API surface** as the TUI — no internal module imports:

| API | Portal usage |
|-----|-------------|
| `PilotSwarmClient` | Create/resume sessions, send/receive messages, subscribe to events |
| `PilotSwarmManagementClient` | List sessions, rename, cancel, delete, dump, list models |
| `PilotSwarmWorker` | Embedded mode (same-process) or connect to remote AKS workers |
| `SessionBlobStore` | Artifact download |

### Server Component

A lightweight **Express + WebSocket** server bridges browser clients to the PilotSwarm SDK:

```
packages/portal/
  server.js          — Express + WS server, SDK bridge
  public/            — Static React app (built)
  src/
    App.tsx          — Root layout (sidebar + main + right panel)
    components/
      Sidebar.tsx            — Session list (tree view)
      ChatTerminal.tsx       — xterm.js terminal for chat + splash
      InputBar.tsx           — Message input with slash commands
      ActivityPane.tsx       — Tool execution timeline
      LogViewer.tsx          — Per-worker / per-orchestration logs
      SequenceDiagram.tsx    — Swimlane diagram (SVG)
      NodeMap.tsx            — Worker node grid
      MarkdownViewer.tsx     — File browser + preview
      HelpOverlay.tsx        — Keyboard shortcut reference
      SplashScreen.tsx       — Full-screen startup splash
      AgentPicker.tsx        — Agent selection modal
      StatusBar.tsx          — Context-sensitive hints
    hooks/
      useSession.ts          — Session state + event subscription
      useWebSocket.ts        — WS connection management
    lib/
      ansi.ts                — Convert blessed tags → ANSI for xterm.js
      theme.ts               — Color constants matching TUI palette
```

### Data Flow

```
Browser                         Server                      PilotSwarm
───────                         ──────                      ──────────
  │  WS: createSession(agent)    │                              │
  │ ──────────────────────────►  │  client.createSession()      │
  │                              │ ──────────────────────────►  │
  │                              │                              │
  │                              │  ◄── on("turn_complete")     │
  │  ◄── WS: event(turn_complete)│                              │
  │                              │                              │
  │  WS: send(message)          │                              │
  │ ──────────────────────────►  │  session.send(message)       │
  │                              │ ──────────────────────────►  │
  │                              │                              │
  │                              │  ◄── on("response", chunk)   │
  │  ◄── WS: event(response)    │                              │
```

---

## Layout & Mocks

### Mock 1: Startup — Splash Screen

The startup splash renders in the **xterm.js terminal**, preserving the ASCII art exactly as the TUI shows it. The browser chrome wraps it with a dark background and subtle branding.

```
┌─────────────────────────────────────────────────────────────────────────┐
│  ⬤ ⬤ ⬤   PilotSwarm Portal                              ☰  👤  ⚙️   │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│                                                                         │
│             ____  _ __      __  _____                                   │
│            / __ \(_) /___  / /_/ ___/      ______ __________ ___        │
│           / /_/ / / / __ \/ __/\__ \ | /| / / __ `/ ___/ __ `__ \      │
│          / ____/ / / /_/ / /_ ___/ / |/ |/ / /_/ / /  / / / / / /      │
│         /_/   /_/_/\____/\__//____/|__/|__/\__,_/_/  /_/ /_/ /_/       │
│                                                                         │
│           Durable AI Agent Orchestration                                │
│           Crash recovery · Durable timers · Sub-agents · Multi-node     │
│           Powered by duroxide + GitHub Copilot SDK                      │
│                                                                         │
│                                                                         │
│                        Connecting...                                    │
│                                                                         │
│                                                                         │
│                                                                         │
├─────────────────────────────────────────────────────────────────────────┤
│  Ready                                                     v0.8.0      │
└─────────────────────────────────────────────────────────────────────────┘
```

**Colors**: Cyan → Magenta → Yellow gradient on the ASCII art (matching TUI). Dark background (#1a1a2e). White tagline.

---

### Mock 2: Main Layout — Active Session

Three-column layout that mirrors the TUI's left/right split, with the chat terminal as the centerpiece.

```
┌────────────────────────────────────────────────────────────────────────────────────┐
│  ⬤ ⬤ ⬤   PilotSwarm Portal                                    ☰  👤  ⚙️        │
├──────────────┬─────────────────────────────────────┬───────────────────────────────┤
│  SESSIONS    │  deploy-fix-march (ab12cd34)        │  ≡ Per-Worker Logs     [m]   │
│              │  model: claude-sonnet-4-20250514  iter: 3     │                             │
│  ▸ * Deploy  │─────────────────────────────────────│  ┌─ worker-7x92k ──────────┐ │
│    fix-march │  [14:32:01] You:                    │  │ ● runTurn ab12cd34       │ │
│    (ab12cd34)│  Fix the deployment pipeline for    │  │ ● registerTools [3]      │ │
│              │  the March release. The staging      │  │ ◆ orchestration yield    │ │
│    . Generic │  environment is timing out.          │  │ ● runTurn complete       │ │
│    session   │                                     │  └──────────────────────────┘ │
│    (ef56gh78)│  [14:32:08] Copilot:                │  ┌─ worker-3m41n ──────────┐ │
│              │  I'll investigate the staging        │  │ ● runTurn ef56gh78       │ │
│  ≋ PilotSwarm│  deployment pipeline. Let me check  │  │ (idle)                   │ │
│    Agent     │  the configuration and recent        │  └──────────────────────────┘ │
│              │  changes.                            │                               │
│  ≋ Sweeper   │                                     │──────────────────────────────│
│    Agent     │  ▶ read_file pipeline.yml            │  ACTIVITY                     │
│              │  ✓ read_file (2.1s)                  │  [14:32:09] ▶ read_file       │
│              │  ▶ search_code "timeout"             │    pipeline.yml               │
│              │  ⠋ Thinking…                         │  [14:32:11] ✓ read_file 2.1s  │
│              │                                     │  [14:32:11] ▶ search_code     │
│              │                                     │    query="timeout"             │
├──────────────┼─────────────────────────────────────┼───────────────────────────────┤
│              │  you: █                              │  j/k scroll · m cycle mode    │
│  n new · ? help                                    │  ? help · Esc quit            │
└──────────────┴─────────────────────────────────────┴───────────────────────────────┘
```

**Key details:**
- **Left sidebar**: Session tree with status icons (*, ~, ., ?, !) and colors (green/yellow/white/cyan/red)
- **Center**: xterm.js terminal rendering chat with ANSI colors, URLs clickable, spinner animated
- **Right panel**: Toggleable between Per-Worker Logs / Per-Orchestration / Sequence Diagram / Node Map
- **Bottom-right**: Activity pane (tool calls with timing)
- **Status bar**: Context-sensitive keybinding hints (same as TUI)

---

### Mock 3: Agent Picker Modal

When pressing `n` for new session, a centered modal appears:

```
┌─────────────────────────────────────────────────────────────────────┐
│                                                                     │
│     ┌─────────────────────────────────────────────────────┐         │
│     │          Create New Session                         │         │
│     │                                                     │         │
│     │   ┌─────────────────────────────────────────────┐   │         │
│     │   │  ▸ Generic Session                          │   │         │
│     │   │    Open-ended work, any topic               │   │         │
│     │   │                                             │   │         │
│     │   │    Investigator                             │   │         │
│     │   │    Incident response + root cause analysis  │   │         │
│     │   │                                             │   │         │
│     │   │    Deployer                                 │   │         │
│     │   │    Deployment automation + rollback          │   │         │
│     │   │                                             │   │         │
│     │   │    Reporter                                 │   │         │
│     │   │    Status reports + summaries                │   │         │
│     │   └─────────────────────────────────────────────┘   │         │
│     │                                                     │         │
│     │   [Enter] Select   [Esc] Cancel   [↑/↓] Navigate   │         │
│     └─────────────────────────────────────────────────────┘         │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

---

### Mock 4: Agent Splash in Chat Terminal

After selecting "Investigator", the xterm.js terminal shows the agent's branded splash:

```
┌─────────────────────────────────────────────────────────────────────┐
│  SESSIONS    │  Investigator (9a8b7c6d)                            │
│              │  model: claude-sonnet-4-20250514                              │
│  ▸ ? Invest- │─────────────────────────────────────────────────────│
│    igator    │                                                     │
│    (9a8b7c6d)│     ___                 _   _             _         │
│              │    |_ _|_ ____   _____ | |_(_) __ _  __ _| |_ ___  │
│              │     | || '_ \ \ / / _ \| __| |/ _` |/ _` | __/ _ \ │
│              │     | || | | \ V / (_) | |_| | (_| | (_| | || (_) |│
│              │    |___|_| |_|\_/ \___/ \__|_|\__, |\__,_|\__\___/ │
│              │                                 |___/               │
│              │                                                     │
│              │   Incident Response + Root Cause Analysis           │
│              │                                                     │
│              │   Guided flow: service, timeframe, symptoms,        │
│              │   recent deploy, user impact.                       │
│              │                                                     │
│              │                                                     │
│              │   ⠋ Waiting for input…                              │
│              │                                                     │
├──────────────┼─────────────────────────────────────────────────────│
│              │  you: █                                             │
└──────────────┴─────────────────────────────────────────────────────┘
```

---

### Mock 5: Sequence Diagram View

Press `m` to cycle the right panel to the sequence diagram (SVG-rendered, not ASCII):

```
┌──────────────┬──────────────────────┬──────────────────────────────────────┐
│  SESSIONS    │  Chat (ab12cd34)     │  ≡ Sequence Diagram            [m]  │
│              │                      │                                      │
│  ▸ * Deploy  │  [14:32:01] You:     │  TIME       worker-7x   worker-3m   │
│    (ab12cd34)│  Fix the pipeline…   │  ─────────────────────────────────── │
│              │                      │  14:32:02   ┌─────────┐             │
│              │  [14:32:08] Copilot:  │             │ runTurn  │             │
│              │  I'll investigate…   │             │ ab12cd34 │             │
│              │                      │  14:32:04   │ read_file│             │
│              │                      │             │ ✓ 2.1s   │             │
│              │                      │  14:32:06   │ search   │             │
│              │                      │             │ …        │             │
│              │                      │  14:32:08   │ ✓ done   │             │
│              │                      │             └─────────┘             │
│              │                      │  14:32:09              ┌──────────┐ │
│              │                      │                        │ runTurn  │ │
│              │                      │                        │ ef56gh78 │ │
│              │                      │                        └──────────┘ │
│              │                      │                                      │
├──────────────┼──────────────────────┼──────────────────────────────────────┤
│              │  you: █              │  j/k scroll · g/G top/bottom        │
└──────────────┴──────────────────────┴──────────────────────────────────────┘
```

**Portal advantage**: Real SVG swimlanes with smooth scrolling, hover tooltips on activities, and zoom — versus the TUI's ASCII approximation.

---

### Mock 6: Node Map View

```
┌──────────────┬──────────────────────┬──────────────────────────────────────┐
│  SESSIONS    │  Chat (ab12cd34)     │  ≡ Node Map                    [m]  │
│              │                      │                                      │
│              │                      │   worker-7x92k    worker-3m41n       │
│              │                      │  ┌─────────────┐ ┌─────────────┐    │
│              │                      │  │ * ab12cd34   │ │ . ef56gh78  │    │
│              │                      │  │   Deploy fix │ │   Generic   │    │
│              │                      │  │              │ │             │    │
│              │                      │  │ ≋ PilotSwarm │ │ ≋ Sweeper   │    │
│              │                      │  │   Agent      │ │   Agent     │    │
│              │                      │  └─────────────┘ └─────────────┘    │
│              │                      │                                      │
│              │                      │   Legend:                            │
│              │                      │   * running  ~ waiting  . idle      │
│              │                      │   ? input    ! error                 │
│              │                      │                                      │
├──────────────┼──────────────────────┼──────────────────────────────────────┤
│              │  you: █              │  j/k scroll · g/G top/bottom        │
└──────────────┴──────────────────────┴──────────────────────────────────────┘
```

---

### Mock 7: Help Overlay

Press `?` for a full-screen help overlay (same content as TUI):

```
┌─────────────────────────────────────────────────────────────────────────┐
│                                                                         │
│   ┌───────────────────────────────────────────────────────────────┐     │
│   │                    Keyboard Shortcuts                         │     │
│   │                                                               │     │
│   │  NAVIGATION                    SESSION LIST                   │     │
│   │  ─────────                    ────────────                    │     │
│   │  Tab / Shift+Tab  Cycle panes  j/k  Navigate sessions        │     │
│   │  h / l            Left/Right   Enter  Switch to session       │     │
│   │  p                Focus prompt n  New session                 │     │
│   │  ?                This help    N  New + model picker          │     │
│   │  Esc → q          Quit         t  Rename session              │     │
│   │                                c  Cancel session              │     │
│   │  CHAT PANE                     d  Delete session              │     │
│   │  ─────────                     +/-  Expand/collapse tree      │     │
│   │  j/k  Scroll up/down                                         │     │
│   │  g/G  Top / Bottom            RIGHT PANEL                     │     │
│   │  e    Expand history          ───────────                     │     │
│   │  a    Artifact picker         m  Cycle: Logs → Seq → NodeMap  │     │
│   │  u    Dump to Markdown        v  Toggle Markdown viewer       │     │
│   │                                                               │     │
│   │  INPUT                        SLASH COMMANDS                  │     │
│   │  ─────                        ──────────────                  │     │
│   │  Enter        Send            /models  List models            │     │
│   │  Alt+Enter    Newline         /model   Switch model           │     │
│   │  Alt+←/→      Word move      /info    Session info            │     │
│   │  /            Slash commands  /done    Close session           │     │
│   │                               /new     New session             │     │
│   │                                                               │     │
│   │                        [Esc] Close                            │     │
│   └───────────────────────────────────────────────────────────────┘     │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

---

### Mock 8: Markdown Viewer

Press `v` to open the file browser + preview:

```
┌──────────────┬──────────────────────┬──────────────────────────────────────┐
│  SESSIONS    │  Chat (ab12cd34)     │  FILES               │ PREVIEW      │
│              │                      │                      │              │
│              │  [14:32:01] You:     │  ▸ 📥 incident-      │ # Incident   │
│              │  Fix the pipeline…   │    report.md         │ Report       │
│              │                      │                      │              │
│              │  [14:32:08] Copilot: │    📥 deploy-        │ ## Summary   │
│              │  I'll investigate…   │    runbook.md        │              │
│              │                      │                      │ The staging  │
│              │                      │    📄 dump-          │ pipeline was │
│              │                      │    ab12cd34.md       │ timing out   │
│              │                      │                      │ due to a     │
│              │                      │                      │ misconfigured│
│              │                      │                      │ health check.│
│              │                      │                      │              │
│              │                      │                      │ ## Root Cause│
│              │                      │                      │ ...          │
├──────────────┼──────────────────────┼──────────────────────┴──────────────┤
│              │  you: █              │  j/k navigate · Enter preview · v close│
└──────────────┴──────────────────────┴──────────────────────────────────────┘
```

---

## Technology Stack

| Layer | Choice | Rationale |
|-------|--------|-----------|
| **Terminal-in-browser** | [xterm.js](https://xtermjs.org/) | Industry standard, supports ANSI colors, mouse, resize. Used by VS Code, GitHub Codespaces. |
| **Frontend framework** | React 18+ | Component model maps 1:1 to TUI panes. |
| **Styling** | Tailwind CSS | Dark theme, utility classes for rapid prototyping. |
| **Sequence diagrams** | SVG (custom) or [Mermaid](https://mermaid.js.org/) | Richer than ASCII; zoom/pan/hover. |
| **Server** | Express + `ws` | Minimal bridge; same process can embed `PilotSwarmWorker`. |
| **Transport** | WebSocket | Real-time bidirectional stream for events, status, logs. |
| **Build** | Vite | Fast dev server, HMR, TypeScript. |
| **Blessed tag → ANSI** | Custom converter | Translate `{cyan-fg}...{/cyan-fg}` → `\x1b[36m...\x1b[0m` for xterm.js. |

---

## Feature Parity Matrix

| Feature | TUI | Portal | Notes |
|---------|-----|--------|-------|
| Startup splash (ASCII art) | ✓ | ✓ | xterm.js renders identical ANSI output |
| Agent splash screens | ✓ | ✓ | Same ASCII art, same colors |
| Session list (tree) | ✓ | ✓ | React sidebar with collapse/expand |
| Status icons (* ~ . ? !) | ✓ | ✓ | Color-coded, same symbols |
| Unseen change indicator (●) | ✓ | ✓ | Badge on session item |
| Real-time chat | ✓ | ✓ | xterm.js with streaming writes |
| Thinking spinner | ✓ | ✓ | Animated in xterm.js |
| URL detection + click | ✓ | ✓ | xterm.js link provider (native) |
| Tool call activity | ✓ | ✓ | React component, same format |
| Per-worker logs | ✓ | ✓ | Streamed via WS, colored per pod |
| Per-orchestration logs | ✓ | ✓ | Filtered view |
| Sequence diagram | ✓ | ✓+ | **Enhanced**: SVG with hover/zoom |
| Node map | ✓ | ✓+ | **Enhanced**: interactive grid |
| Markdown viewer | ✓ | ✓+ | **Enhanced**: real Markdown rendering |
| Artifact download | ✓ | ✓ | Browser download dialog |
| Session dump | ✓ | ✓ | Download as .md |
| Agent picker modal | ✓ | ✓ | React modal |
| Model selection | ✓ | ✓ | /model command or picker |
| Slash commands | ✓ | ✓ | Autocomplete dropdown |
| Keyboard shortcuts | ✓ | ✓ | Global key handler, same bindings |
| Help overlay | ✓ | ✓ | Modal with same content |
| Layout resize | ✓ | ✓ | Drag handles on panel borders |
| Mouse support | ✓ | ✓ | Native browser mouse |
| Session rename | ✓ | ✓ | Inline edit or LLM summarize |
| Cancel/delete session | ✓ | ✓ | Context menu + keyboard |
| System agent isolation | ✓ | ✓ | Same UX rules |
| Vim keybindings (j/k/g/G) | ✓ | ✓ | When focus is on scrollable panes |
| Status bar hints | ✓ | ✓ | Bottom bar, context-sensitive |
| Multi-worker support | ✓ | ✓ | Same embedded or remote modes |

---

## Portal-Only Enhancements (free from terminal constraints)

These come naturally from being in a browser — no extra effort beyond using web-native capabilities:

| Enhancement | Description |
|-------------|-------------|
| **SVG sequence diagrams** | Pan, zoom, hover tooltips on activities — vs ASCII approximation |
| **Rich Markdown preview** | Rendered HTML with syntax highlighting vs terminal approximation |
| **Browser notifications** | Desktop notifications when a session needs input or completes |
| **Drag-to-resize panels** | Smooth panel resizing vs `[`/`]` key increments |
| **Session deep links** | URL routes per session: `/session/ab12cd34` — shareable |
| **Copy-paste** | Native browser clipboard vs terminal escape codes |
| **Search in chat** | Ctrl+F browser search across rendered conversation |
| **Multiple tabs** | Open multiple sessions in browser tabs simultaneously |
| **Responsive layout** | Collapse sidebar on mobile; full-screen chat on narrow viewports |

---

## Implementation Phases

### Phase 1: Core Shell (MVP)
- Express + WS server bridging `PilotSwarmClient`
- React app with xterm.js chat terminal
- Startup splash rendering (blessed tags → ANSI)
- Single session: create, send, receive, display
- Input bar with Enter to send

### Phase 2: Session Management
- Session sidebar with tree view
- Agent picker modal + agent splashes
- Session switching, create, rename, cancel, delete
- Status icons + unseen change indicators
- Slash commands with autocomplete

### Phase 3: Observability Panels
- Activity pane (tool timeline)
- Per-worker log streaming
- Per-orchestration filtered logs
- Log mode cycling (`m` key)

### Phase 4: Advanced Views
- SVG sequence diagram
- Node map grid
- Markdown viewer (file list + preview)
- Artifact picker + download

### Phase 5: Polish
- Full keyboard shortcut parity
- Help overlay
- Status bar hints
- Browser notifications
- Session deep links / URL routing
- Responsive layout for narrow viewports

---

## Wireframe: Responsive Behavior

**Desktop (>1200px)**: Full three-column layout as shown in mocks above.

**Tablet (768-1200px)**: Two columns — sidebar collapses to icon strip, right panel becomes a slide-out drawer.

```
┌──┬──────────────────────────────────────────┐
│📋│  Chat Terminal (ab12cd34)                │
│  │                                          │
│📋│  [14:32:01] You: Fix the pipeline…       │
│  │                                          │
│≋ │  [14:32:08] Copilot: I'll investigate…   │
│  │                                          │
│≋ │  ⠋ Thinking…                             │
│  │                                          │
│  │                                          │
├──┼──────────────────────────────────────────┤
│  │  you: █                          [≡] [?] │
└──┴──────────────────────────────────────────┘
      ↑ icon sidebar                  ↑ drawer toggle
```

**Mobile (<768px)**: Single column, bottom nav tabs.

```
┌──────────────────────────────┐
│  PilotSwarm  ☰               │
├──────────────────────────────┤
│                              │
│  [14:32:08] Copilot:         │
│  I'll investigate the        │
│  staging deployment…         │
│                              │
│  ⠋ Thinking…                 │
│                              │
│                              │
├──────────────────────────────┤
│  you: █                      │
├──────────────────────────────┤
│  💬 Chat  📋 Sessions  📊 Logs│
└──────────────────────────────┘
```

---

## Color Theme

Matching the TUI's dark terminal aesthetic:

```css
:root {
  --bg-primary:    #1a1a2e;    /* deep navy */
  --bg-secondary:  #16213e;    /* panel backgrounds */
  --bg-surface:    #0f3460;    /* cards, modals */
  --text-primary:  #e0e0e0;    /* main text */
  --text-muted:    #888888;    /* gray hints */
  --accent-cyan:   #00d4ff;    /* chat border, links */
  --accent-green:  #00ff88;    /* running, success */
  --accent-yellow: #ffd700;    /* sessions border, waiting */
  --accent-red:    #ff4444;    /* focused border, errors */
  --accent-magenta:#ff00ff;    /* splash gradient, in-progress */
  --border-default:#333333;    /* unfocused pane borders */
  --border-focus:  #ff4444;    /* red focus ring (matching TUI) */
}
```

---

## Open Questions

1. **Auth**: Should the portal require authentication? The TUI runs locally with access to `.env`. The portal server would need a token management strategy for multi-user scenarios.

2. **Deployment**: Ship as a single binary/container alongside the worker? Or separate deployment?

3. **Real-time transport**: Pure WebSocket vs Server-Sent Events for the event stream? WS allows bidirectional (send messages too), SSE is simpler for read-only streams.

4. **xterm.js vs rich HTML chat**: The proposal uses xterm.js for maximum TUI fidelity. An alternative is rendering chat as styled HTML `<div>`s with a terminal font — easier to add features like inline images, collapsible tool calls, etc. The splash screens would still render in xterm.js either way. **Hybrid approach**: xterm.js for splash + active output, HTML for historical messages?

5. **Package name**: `pilotswarm-portal`? `@pilotswarm/portal`?
