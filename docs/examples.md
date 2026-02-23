# Example Applications

## Chat App (`examples/chat.js`)

A minimal interactive chat that demonstrates the core SDK in single-process mode — great for getting started.

### Running

```bash
npm run chat
# or
node --env-file=.env examples/chat.js
```

### What It Demonstrates

- **Single-process setup** — `DurableCopilotWorker` + `DurableCopilotClient` in one process
- **Interactive conversation** — readline-based chat loop
- **Live event streaming** — `session.on()` prints events as they fire
- **Durable timers** — ask the agent to wait and it uses the durable timer infrastructure
- **User input** — the `ask_user` tool prompts via readline when the LLM needs clarification

### Example Session

```
🤖 Durable Copilot Chat (v2)
   Store: PostgreSQL

   Type a message, press Enter. Type 'exit' to quit.

you> What's 2 + 2?
   [1] assistant.turn_start
   [2] assistant.message — 2 + 2 = 4
   [3] assistant.usage — in=142 out=8

2 + 2 = 4

you> Wait 10 seconds then tell me a joke
   [4] tool.execution_start — wait
   [5] tool.execution_complete — wait
   ... (10 second durable timer) ...
   [6] assistant.message — Why don't scientists trust atoms? Because they make up everything!

Why don't scientists trust atoms? Because they make up everything!
```

### Key Code

```javascript
// Worker + Client in same process
const worker = new DurableCopilotWorker({ store, githubToken });
await worker.start();
const client = new DurableCopilotClient({ store, blobEnabled: true });
await client.start();

// Create session with user input handler
const session = await client.createSession({
    onUserInputRequest: async (request) => {
        const answer = await prompt(`\n❓ ${request.question}\n> `);
        return { answer };
    },
});

// Chat loop
const response = await session.sendAndWait(input, 300_000);
```

---

## TUI (`examples/tui.js`)

A full-featured terminal UI for managing multiple concurrent durable sessions, with real-time log visualization and a sequence diagram view.

### Running

```bash
# Local mode — 4 embedded workers + TUI
npm run tui

# Remote mode — AKS workers, TUI is client-only
npm run tui:remote

# Or use the convenience script
./run.sh              # local mode
./run.sh remote       # remote mode
```

### What It Demonstrates

- **Multi-session management** — create and switch between sessions in a sidebar
- **Live worker logs** — per-pod log panes showing orchestration and activity events
- **Sequence diagrams** — visual timeline of orchestration → activity → timer flows
- **Session dehydration/hydration** — watch sessions migrate between pods
- **Durable timers in action** — sessions that run for hours with periodic wake-ups
- **Crash recovery** — kill a pod and watch the session resume on another

### Layout

```
┌─ Sessions ──┬─ Chat ──────────────────────┬─ Workers ─────────────┐
│ ⚡ session-1│ [07:38:08] You: give me     │ TIME  pod-1  pod-2    │
│ ⏳ session-2│ facts about the cosmos      │ 15:38 ◆ orch start    │
│ 💤 session-3│ every 1 minute              │ 15:38 ● runTurn       │
│             │                              │ 15:38 ◆ timer 60s    │
│             │ [07:38:18] 🤖 Copilot:      │                       │
│             │ 🌌 Cosmos Fact #1: The      │                       │
│             │ observable universe          │                       │
│             │ contains approximately       │                       │
│             │ 2 trillion galaxies...       │                       │
└─────────────┴──────────────────────────────┴───────────────────────┘
```

### Session Status Icons

| Icon | Status | Meaning |
|------|--------|---------|
| ⚡ | `running` | LLM turn in progress |
| ⏳ | `waiting` | Durable timer counting down |
| 🙋 | `input_required` | Waiting for user input |
| 💤 | `idle` | Waiting for new message |
| ⚠ | `error` | Activity failed, retrying |

### Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `n` | New session |
| `↑/↓` | Navigate sessions |
| `Enter` | Switch to selected session |
| `Tab` | Cycle focus (sessions → chat → input) |
| `Ctrl+D` | Delete selected session |
| `l` | Toggle log view mode |
| `Ctrl+C` / `q` | Quit |

### Log View Modes

Press `l` to cycle through:

1. **Per-Pod** — raw worker logs grouped by pod name
2. **Per-Orchestration** — logs filtered for the selected session
3. **Sequence Diagram** — visual timeline of events across pods

---

## Worker (`examples/worker.js`)

A headless worker process for production deployment. This is what runs inside each AKS pod.

### Running

```bash
npm run worker
# or
node --env-file=.env.remote examples/worker.js
```

### What It Does

- Connects to PostgreSQL
- Polls for pending orchestrations
- Executes LLM turns via the Copilot SDK
- Handles session dehydration/hydration
- Graceful shutdown on `SIGTERM`/`SIGINT`

See [Deploying to AKS](deploying-to-aks.md) for the full production setup.

---

## Test Suite (`examples/test.js`)

Automated test harness covering the full SDK:

```bash
npm test
# or
node --env-file=.env examples/test.js
```

### Tests

| Test | What It Verifies |
|------|-----------------|
| Simple Q&A | Basic prompt → response |
| Tool Calling | `defineTool()` integration via `withClient` helper |
| Short Wait | In-process wait (< threshold) |
| Durable Timer | Long wait → dehydrate → timer → hydrate |
| Multi-turn | Conversation memory across turns |
| send() + wait() | Fire-and-forget + reconnect |
| User Input | `ask_user` tool → `onUserInputRequest` |
| Event Persistence | CMS `session_events` recording |
| session.on() Events | Real-time event subscription |
| Tool on Worker | Explicit `worker.setSessionConfig()` tool registration |
| Session Resume | Create → send → `resumeSession()` → verify context |
| Session List | `client.listSessions()` returns created sessions |
| Session Info | `session.getInfo()` returns status and iterations |
| Session Delete | `client.deleteSession()` removes from list |
| Event Type Filter | `session.on(type, handler)` filters correctly |
| Worker-Registered Tools | `worker.registerTools()` + `toolNames` in remote mode |
| Registry + Session Tools | Combining `registerTools()` and per-session `setSessionConfig()` |

Run a specific test:

```bash
node --env-file=.env examples/test.js --test="durable"
```
