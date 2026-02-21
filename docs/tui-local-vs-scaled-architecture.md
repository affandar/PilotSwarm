# TUI Architecture: Local Mode & Scaled Mode

This document explains how the TUI chat app works in two deployment modes:

1. **Local mode** — `examples/tui.js` with `MODE=local` (default)
2. **Scaled mode** — `examples/tui.js --mode scaled` or `examples/tui-scaled.js`

The key difference is **who owns the runtime**: in local mode the TUI process itself runs orchestrations; in scaled mode remote worker pods do.

---

## 1. Local TUI Architecture

In local mode the TUI process is **both client and worker**. It calls `client.start()`, which boots a duroxide runtime inside the same Node process. The store can be SQLite (dev) or remote PostgreSQL (`tui-remote.js` pattern) — "local" refers to where code executes, not where the database lives.

### 1.1 Component Diagram

```
┌──────────────────────────────────────────────────────────────────────┐
│                      Local TUI Process (examples/tui.js)             │
│                                                                      │
│  ┌──────────────┐       ┌───────────────────────────────────────┐    │
│  │  Blessed UI  │       │  DurableCopilotClient                 │    │
│  │  ┌────────┐  │       │                                       │    │
│  │  │ Chat   │  │       │  ┌─────────────────────────────────┐  │    │
│  │  │ Pane   │  │       │  │ duroxide Runtime (in-process)   │  │    │
│  │  └────────┘  │       │  │                                 │  │    │
│  │  ┌────────┐  │       │  │  durableSessionOrchestration    │  │    │
│  │  │ Log    │  │       │  │         │                       │  │    │
│  │  │ Pane   │◄─────────┤  │         ▼                       │  │    │
│  │  └────────┘  │       │  │  runAgentTurn activity           │  │    │
│  │  ┌────────┐  │       │  │    │            │               │  │    │
│  │  │ Input  │  │       │  │    ▼            ▼               │  │    │
│  │  │ Bar    │  │       │  │ SessionMgr   System Tools       │  │    │
│  │  └────────┘  │       │  │ + Copilot     (wait, input)     │  │    │
│  └──────────────┘       │  │   SDK/CLI                       │  │    │
│                         │  └──────┬──────────────────────────┘  │    │
│                         └─────────┼─────────────────────────────┘    │
└─────────────────────────────────┼────────────────────────────────────┘
                                  │
                    ┌─────────────▼──────────────┐
                    │  Store (SQLite or Postgres) │
                    └─────────────┬──────────────┘
                                  │
                    ┌─────────────▼──────────────┐
                    │    GitHub Copilot API       │
                    └────────────────────────────┘
```

### 1.2 Turn Sequence

```
 User            TUI Process          Orchestration        runAgentTurn       Copilot SDK/CLI
  │                   │                    │                    │                    │
  │  enter prompt     │                    │                    │                    │
  │──────────────────▶│                    │                    │                    │
  │                   │  sendAndWait()     │                    │                    │
  │                   │───────────────────▶│                    │                    │
  │                   │                    │  schedule activity │                    │
  │                   │                    │───────────────────▶│                    │
  │                   │                    │                    │  sendAndWait()     │
  │                   │                    │                    │───────────────────▶│
  │                   │                    │                    │                    │
  │                   │                    │                    │◀─── TurnResult ───┤
  │                   │                    │◀── TurnResult ────┤                    │
  │                   │◀── status update ──┤                    │                    │
  │◀── render ────────┤                    │                    │                    │
  │                   │                    │                    │                    │
```

### 1.3 Pseudocode

```typescript
// ── Boot ──────────────────────────────────────────────────────────

async function bootLocalTui() {
  initTracing({ logFile: `/tmp/duroxide-tui-${process.pid}.log` });

  const client = new DurableCopilotClient({
    store,                           // "sqlite::memory:" or "postgres://..."
    githubToken: process.env.GITHUB_TOKEN,
    blobConnectionString,            // optional — enables dehydration
  });

  await client.start();              // boots duroxide runtime IN this process

  const session = await client.createSession({
    systemMessage: "You are a helpful assistant.",
    onUserInputRequest: async (req) => {
      showQuestion(req.question);
      const answer = await waitForUserAnswer();
      return { answer, wasFreeform: true };
    },
  });
}

// ── User submits a message ────────────────────────────────────────

async function onUserSubmit(prompt: string) {
  if (turnInProgress) {
    await session.sendEvent("interrupt", { prompt });
    return;
  }

  turnInProgress = true;
  const response = await session.sendAndWait(prompt, 0, (intermediate) => {
    renderIntermediate(intermediate);
  });
  renderFinal(response);
  turnInProgress = false;
}
```

---

## 2. Scaled TUI Architecture

In scaled mode the TUI is **client-only** — it calls `client.startClientOnly()`, which creates a duroxide `Client` (no `Runtime`). It can enqueue orchestrations and read results, but does not execute any work.

Separately, one or more **worker pods** (`examples/worker.js`) each call `client.start()`. They compete for work from the same Postgres via `SELECT FOR UPDATE SKIP LOCKED`.

### 2.1 Component Diagram

```
┌─────────────────────────────────────────┐
│  Scaled TUI Process (client-only)       │
│                                         │
│  ┌───────────┐  ┌───────────────────┐   │
│  │ Blessed UI│  │ DurableCopilotClient│  │
│  │ ┌───────┐ │  │   startClientOnly() │  │
│  │ │ Chat  │ │  │   (no Runtime)      │  │
│  │ ├───────┤ │  └─────────┬───────────┘  │
│  │ │ Orch  │ │            │              │
│  │ │ Panel │ │            │ enqueue /    │
│  │ ├───────┤ │            │ poll status  │
│  │ │Worker │ │            │              │
│  │ │ Logs  │◄──kubectl────┤              │
│  │ └───────┘ │  logs -f   │              │
│  └───────────┘            │              │
└───────────────────────────┼──────────────┘
                            │
              ┌─────────────▼──────────────┐
              │     Remote PostgreSQL       │
              │  (orchestrations, events,   │
              │   timers, activities)       │
              └──────┬─────────────┬───────┘
                     │             │
        ┌────────────▼───┐  ┌─────▼────────────┐
        │  Worker Pod A  │  │  Worker Pod B     │
        │  worker.js     │  │  worker.js        │
        │                │  │                   │
        │ ┌────────────┐ │  │ ┌──────────────┐  │
        │ │ duroxide   │ │  │ │ duroxide     │  │
        │ │ Runtime    │ │  │ │ Runtime      │  │
        │ ├────────────┤ │  │ ├──────────────┤  │
        │ │ Orchestr.  │ │  │ │ Orchestr.    │  │
        │ │ + Activity │ │  │ │ + Activity   │  │
        │ ├────────────┤ │  │ ├──────────────┤  │
        │ │ SessionMgr │ │  │ │ SessionMgr   │  │
        │ │ + Copilot  │ │  │ │ + Copilot    │  │
        │ │   SDK/CLI  │ │  │ │   SDK/CLI    │  │
        │ └─────┬──────┘ │  │ └──────┬───────┘  │
        └───────┼────────┘  └────────┼──────────┘
                │                    │
                └────────┬───────────┘
                         ▼
              ┌─────────────────────┐
              │  GitHub Copilot API │
              └─────────────────────┘
```

### 2.2 Turn Sequence

```
 User        Scaled TUI         Postgres        AKS Worker Pod      Copilot SDK/CLI
  │              │                  │                  │                    │
  │ enter prompt │                  │                  │                    │
  │─────────────▶│                  │                  │                    │
  │              │  startOrch /     │                  │                    │
  │              │  raiseEvent      │                  │                    │
  │              │─────────────────▶│                  │                    │
  │              │                  │◀── poll + lock ──┤                    │
  │              │                  │                  │                    │
  │              │                  │                  │  sendAndWait()     │
  │              │                  │                  │───────────────────▶│
  │              │                  │                  │◀─── TurnResult ───┤
  │              │                  │                  │                    │
  │              │                  │◀── write status ─┤                    │
  │              │  waitForStatus   │                  │                    │
  │              │  Change loop     │                  │                    │
  │              │◀─────────────────┤                  │                    │
  │◀── render ───┤                  │                  │                    │
  │              │                  │                  │                    │
```

### 2.3 Pseudocode

```typescript
// ── Scaled TUI (client-only) ──────────────────────────────────────

async function bootScaledTui() {
  const client = new DurableCopilotClient({
    store: process.env.DATABASE_URL,   // remote Postgres
  });

  await client.startClientOnly();      // no local runtime — just a DB client

  const session = await client.createSession({
    systemMessage: "You are a helpful assistant.",
    onUserInputRequest: async (req) => {
      showQuestion(req.question);
      const answer = await waitForUserAnswer();
      return { answer, wasFreeform: true };
    },
  });

  streamWorkerLogs();                  // kubectl logs -f → per-pod TUI panes
}

// ── Worker Pod (examples/worker.js) ───────────────────────────────

async function bootWorkerPod() {
  const runtimesPerPod = parseInt(process.env.RUNTIMES_PER_POD || "1");
  const podName = process.env.POD_NAME || os.hostname();

  for (let i = 0; i < runtimesPerPod; i++) {
    const client = new DurableCopilotClient({
      store: process.env.DATABASE_URL,
      githubToken: process.env.GITHUB_TOKEN,
      workerNodeId: `${podName}-rt-${i}`,
      blobConnectionString: process.env.AZURE_STORAGE_CONNECTION_STRING,
    });

    await client.start();              // runtime polls Postgres for work
  }

  await new Promise(() => {});         // block forever — runtimes poll in background
}

// ── Sending a message (same API as local) ─────────────────────────

async function onUserSubmit(prompt: string) {
  if (turnInProgress) {
    await session.sendEvent("interrupt", { prompt });
    return;
  }

  turnInProgress = true;
  // Enqueued to Postgres → picked up by a remote worker
  const response = await session.sendAndWait(prompt, 0, (intermediate) => {
    renderIntermediate(intermediate);
  });
  renderFinal(response);
  turnInProgress = false;
}
```

---

## 3. Local vs Scaled — What Changes

> **Note:** "Local" means the runtime executes in the TUI process. The database
> can still be remote Postgres (`examples/tui-remote.js` pattern).

| Aspect | Local TUI | Scaled TUI |
|---|---|---|
| Startup API | `client.start()` | `client.startClientOnly()` |
| Where orchestrations execute | Same process as TUI | Remote AKS worker pods |
| `githubToken` needed by TUI? | Yes — runtime runs turns | No — workers hold the token |
| Store | SQLite or Postgres | Remote Postgres (shared) |
| Logs in UI | Local tracing file | `kubectl logs -f` from pods |
| Scale-out | Single runtime | N pods competing for work |

---

## 4. Shared Execution Model (Both Modes)

Regardless of mode, the durable execution loop is identical:

- One orchestration instance per session (`session-<sessionId>`)
- `runAgentTurn` activity returns a `TurnResult`: `completed`, `wait`, `input_required`, `cancelled`, or `error`
- The orchestration publishes custom status on every transition; the client reads it via `waitForStatusChange`
- Interrupts arrive as `"interrupt"` events and are handled with `ctx.race`

### Orchestration Loop

```typescript
function* durableSessionOrchestration(ctx: OrchestratorContext, input: TurnInput) {
  let { prompt, iteration } = input;

  while (iteration < input.maxIterations) {
    // Race: run the turn vs user interrupt
    const turnTask    = ctx.scheduleActivity("runAgentTurn", { ...input, prompt });
    const interruptEv = ctx.waitForEvent("interrupt");
    const race        = yield ctx.race(turnTask, interruptEv);

    if (race.index === 1) {
      // Interrupted — restart with the new prompt
      yield ctx.continueAsNew({ ...input, prompt: race.value.prompt, iteration });
      return;
    }

    const result: TurnResult = race.value;
    iteration++;

    switch (result.type) {
      case "completed":
        ctx.setCustomStatus({ status: "idle", turnResult: result });
        const next = yield ctx.waitForEvent("next-message");
        prompt = next.prompt;
        break;

      case "wait":
        // Dehydrate if the wait is long, then durable timer
        if (result.seconds > dehydrateThreshold) {
          yield ctx.scheduleActivity("dehydrateSession", { sessionId });
        }
        yield ctx.continueAsNew({ ...input, pendingTimer: result });
        return;

      case "input_required":
        ctx.setCustomStatus({ status: "input_required", question: result.question });
        const answer = yield ctx.waitForEvent("user-input");
        prompt = `Asked: "${result.question}" — Answered: "${answer}"`;
        break;

      case "error":
        throw new Error(result.message);
    }
  }
}
```

---

## 5. Mental Model

```
  LOCAL MODE                           SCALED MODE

  ┌─────────────────────┐             ┌──────────────┐      ┌──────────────┐
  │    TUI Process       │             │  TUI Process  │      │ Worker Pods  │
  │                      │             │  (client-only)│      │ (N replicas) │
  │  UI + Runtime        │             │  UI only      │      │ Runtime only │
  │  ════════════        │             │  ═════════    │      │ ═══════════  │
  │  client.start()      │             │  startClient  │      │ client.start │
  │  owns orchestration  │             │  Only()       │      │ ()           │
  │  owns Copilot CLI    │             │               │      │ owns CLI     │
  │  owns tools          │             │               │      │ owns tools   │
  └──────────┬───────────┘             └───────┬───────┘      └───────┬──────┘
             │                                 │                      │
             ▼                                 └──────────┬───────────┘
  ┌─────────────────────┐                                 ▼
  │ SQLite or Postgres   │                     ┌─────────────────────┐
  └─────────────────────┘                      │   Remote Postgres   │
                                               └─────────────────────┘

  Best for: dev / debug                 Best for: production / scale-out
```

The durable contract — `createSession`, `sendAndWait`, `sendEvent` — is identical in both modes. Only runtime placement changes.
