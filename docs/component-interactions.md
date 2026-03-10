# PilotSwarm — Component Interactions

How every component talks to every other component. Use this to trace any behavior.

---

## Communication Matrix

```
              Client    Worker    Orchestration    CMS    Blob    Duroxide
Client          —       (none)    enqueueEvent     R/W    (none)  Client API
Worker        (none)      —       (registered)     R/W    R/W     Runtime API
Orchestration (polled)  (calls)       —           (none)  (none)  yields
CMS            reads    writes       (none)         —    (none)   (none)
Blob          (none)    R/W          (none)       (none)    —     (none)
Duroxide      Client    Runtime       hosts       (none)  (none)    —
```

### Key:
- **Client → Orchestration:** `duroxideClient.enqueueEvent()` (async, fire-and-forget)
- **Client ← Orchestration:** `duroxideClient.waitForStatusChange()` (polling customStatus)
- **Orchestration → Worker:** `yield ctx.scheduleActivity()` (duroxide dispatches to worker)
- **Worker → CMS:** Direct PG writes (events, session state updates)
- **Worker → Blob:** Direct Azure Blob uploads/downloads
- **Client → CMS:** Direct PG reads (session lists, event replay)

---

## Inter-Process Communication

### Client ↔ Orchestration (via duroxide)

```
Client sends prompt:
  client.duroxideClient.enqueueEvent(
    orchId,           // "session-{uuid}"
    "messages",       // queue name
    JSON.stringify({ prompt })
  )

Client reads result:
  client.duroxideClient.waitForStatusChange(
    orchId,
    timeout
  )
  → returns { customStatus: '{"status":"idle","turnResult":{...}}' }
```

### Orchestration ↔ Worker (via duroxide activities)

```
Orchestration calls activity:
  yield ctx.scheduleActivityOnSession(
    "runTurn",
    { sessionId, prompt, config },
    affinityKey       // routes to specific worker
  )

Activity returns:
  → TurnResult { type, content, ... }
```

### Worker → CMS (direct PG)

```
On turn start:
  catalog.updateSession(id, { state: "running", lastActiveAt })

On event fired:
  catalog.recordEvents(id, [{ eventType, data }])

On turn end:
  catalog.updateSession(id, { state: "idle", lastError: null })
```

### Client ← CMS (direct PG read)

```
List sessions:
  catalog.listSessions() → SessionRow[]

Get events (cursor-based):
  catalog.getSessionEvents(id, afterSeq, limit) → SessionEvent[]
```

---

## Session Config Resolution

Config is split across serializable (travels through duroxide) and non-serializable (stays in memory):

```
                     ┌─────────────────────────┐
                     │  SerializableSessionConfig│ ← travels through duroxide
                     │  • model                  │
                     │  • systemMessage           │
                     │  • toolNames (strings)     │
                     │  • waitThreshold           │
                     │  • workingDirectory        │
                     └───────────┬───────────────┘
                                 │
                     ┌───────────▼───────────────┐
                     │  ManagedSessionConfig      │ ← stays on worker
                     │  • tools (Tool objects)    │
                     │  • hooks (SDK hooks)       │
                     │  + everything above        │
                     └───────────────────────────┘

Resolution order (SessionManager.getOrCreate):
  1. Worker defaults (system message, loaded skills, loaded agents)
  2. SerializableSessionConfig from OrchestrationInput
  3. Per-session config from worker.setSessionConfig()
  4. Resolve toolNames → Tool objects via worker registry
  5. Merge system tools (wait, ask_user, spawn_agent, etc.)
  6. Create/resume CopilotSession with merged config
```

---

## Event Flow: SDK → CMS → Client

```
CopilotSession fires event
         │
         ▼
ManagedSession.on() callback
         │
         ├─ Is ephemeral? (message_delta, reasoning_delta, user.message)
         │   └─ Yes → skip CMS, deliver in-process only
         │
         └─ No → catalog.recordEvents(sessionId, [{ eventType, data }])
                        │
                        ▼
                  CMS session_events table
                        │
                        ▼
              Client polls via session.on()
                        │
                        ▼
              getSessionEvents(id, afterSeq)
                        │
                        ▼
              Delivered to user callback
```

---

## Sub-Agent Lifecycle

```
Parent LLM calls spawn_agent("research X")
         │
         ▼
ManagedSession intercepts → abort turn
         │
         ▼
Returns { type: "spawn_agent", task: "research X" }
         │
         ▼
Parent orchestration:
  yield manager.spawnChildSession(parentId, config, task, nestingLevel+1)
         │
         ▼
spawnChildSession activity:
  1. Generate childSessionId (deterministic for system agents)
  2. Create ephemeral PilotSwarmClient
  3. client.createSession({ sessionId, parentSessionId, nestingLevel })
     → CMS row created
     → child orchestration started
  4. session.send(task)
     → task enqueued to child orchestration
  5. Return childSessionId
         │
         ▼
Parent orchestration:
  subAgents.push({ orchId, sessionId, task, status: "running" })
  continueAsNew (loops, waits for updates)
         │
         ▼
Child orchestration runs independently
  → dequeues task → runTurn → completed
  → sends [CHILD_UPDATE] to parent via sendToSession
         │
         ▼
Parent dequeues [CHILD_UPDATE]
  → updates subAgents[].status = "completed"
  → subAgents[].result = child output
  → next runTurn sees updated status
```

---

## Dehydration / Rehydration Cycle

```
SESSION WARM (in-memory on Worker A)
         │
         ├─ Idle timeout (30s)
         ├─ Wait timer > dehydrateThreshold
         └─ Error with blobEnabled
         │
         ▼
DEHYDRATE:
  1. yield session.dehydrate("idle_timeout")
     → Worker A: tar SESSION_STATE_DIR/{sessionId}/
     → Upload: {sessionId}.tar.gz + .meta.json
     → Delete local files
     → Free CopilotSession from memory
  2. yield ctx.newGuid() → new affinityKey
  3. continueAsNew({ needsHydration: true, affinityKey: newKey })
         │
         ▼
SESSION COLD (state only in Blob + CMS + Duroxide)
         │
         ├─ User sends new prompt
         ├─ Timer fires
         └─ Child update arrives
         │
         ▼
REHYDRATE (any worker):
  1. needsHydration == true
  2. yield session.hydrate()
     → Worker B: download {sessionId}.tar.gz
     → Extract to SESSION_STATE_DIR/{sessionId}/
     → Create new CopilotSession from files
  3. needsHydration = false
  4. Continue with prompt + resume context
         │
         ▼
SESSION WARM (in-memory on Worker B)
```

---

## Error Recovery

```
Turn failure:
  retryCount < 3?
    ├─ Yes → yield ctx.scheduleTimer(15s/30s/60s)
    │        → continueAsNew({ prompt, retryCount+1 })
    │        → if blobEnabled: dehydrate first
    └─ No  → setStatus("error", { retriesExhausted: true })
             → park in error state
             → wait for user to send new prompt

Hydration failure:
  hydrateAttempts < 3?
    ├─ Yes → yield ctx.newGuid() (new affinity key)
    │        → retry hydrate on different worker
    └─ No  → setStatus("error")
             → continue to next dequeue (skip turn)

Activity failure:
  → Duroxide handles retry per activity retry policy
  → If exhausted: exception propagates to orchestration
  → Orchestration catches and applies backoff

Worker crash:
  → In-memory sessions lost
  → Duroxide retries pending activities on other workers
  → Orchestration replays from history
  → Sessions rehydrate from blob on next activity
```

---

## Wire Formats

### Orchestration Custom Status (JSON)

```json
{
  "status": "idle",
  "turnResult": {
    "type": "completed",
    "content": "Here's the fix..."
  },
  "iteration": 5,
  "error": null
}
```

### Duroxide Event Queue Message

```json
{
  "prompt": "Fix this bug"
}
```

### Command Message (via event queue)

```json
{
  "type": "cmd",
  "cmd": "set_model",
  "model": "gpt-4-turbo"
}
```

### Child Update Message (via event queue)

```json
{
  "prompt": "[CHILD_UPDATE] agent session-abc status=completed result=\"Research complete: ...\""
}
```
