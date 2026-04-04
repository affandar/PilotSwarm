# PilotSwarm Orchestration Loop & Queue Drain Problem

## Current Architecture

```
 EXTERNAL PRODUCERS                          DURABLE QUEUE                        ORCHESTRATION
 ═══════════════════                         ═════════════                        ═════════════

 ┌──────────────────┐                   ┌───────────────────────┐
 │ Client.send()    │ ──{ prompt }────► │                       │
 │ (user message)   │                   │    "messages" queue   │
 └──────────────────┘                   │                       │
                                        │  Duroxide FIFO queue  │
 ┌──────────────────┐                   │  Survives CAN         │
 │ sendToSession()  │ ──{ prompt }────► │  Cap: 20 carry-fwd    │
 │ (message_agent)  │                   │                       │
 └──────────────────┘                   │  ┌─┐┌─┐┌─┐┌─┐┌─┐┌─┐ │
                                        │  │1││2││3││4││5││6│ │         ┌────────────────────┐
 ┌──────────────────┐                   │  └─┘└─┘└─┘└─┘└─┘└─┘ │ ──────►│                    │
 │ Child orchestr.  │ ──{ prompt:    ─► │                       │ dequeue│  ORCHESTRATION     │
 │ (CHILD_UPDATE)   │  [CHILD_UPDATE    │  Types in queue:      │  one   │  GENERATOR         │
 │                  │   from=X          │  • user prompt        │  at a  │                    │
 │  on wait()       │   type=wait]      │  • child update       │  time  │  [L651]            │
 │  on completed    │  }                │  • command             │        │                    │
 └──────────────────┘                   │  • answer              │        └────────────────────┘
                                        │  • bootstrap prompt   │
 ┌──────────────────┐                   │                       │
 │ Mgmt client      │ ──{ type:"cmd" ► │                       │
 │ (commands)       │   cmd:"done" }    │                       │
 └──────────────────┘                   │                       │
                                        │                       │
 ┌──────────────────┐                   │                       │
 │ Client (answer)  │ ──{ answer }────► │                       │
 └──────────────────┘                   └───────────────────────┘
```

## Orchestration Loop Structure

```
┌══════════════════════════════════════════════════════════════════════════════════════┐
║                                                                                    ║
║   OUTER LOOP: while (true)  [L651]                                                 ║
║   ════════════════════════════════                                                  ║
║                                                                                    ║
║   ┌───────────────────────────────────────────────────────────────────────────┐     ║
║   │ A. INTERNAL REPLAY                                                       │     ║
║   │    pendingToolActions queued? ──► replay one, stay in outer loop          │     ║
║   └──────────────────────────────────┬────────────────────────────────────────┘     ║
║                                      │ no                                          ║
║                                      ▼                                             ║
║   ┌───────────────────────────────────────────────────────────────────────────┐     ║
║   │ B. PROMPT ACQUISITION                                                    │     ║
║   │                                                                          │     ║
║   │    pendingPrompt? ──► use it                                             │     ║
║   │    pendingMessage? ──► use it                                            │     ║
║   │    else:                                                                 │     ║
║   │      ┌─────────────────────────────────────────────────────────┐         │     ║
║   │      │ PROMPT INNER LOOP: while (!gotPrompt)  [L674]          │         │     ║
║   │      │                                                         │         │     ║
║   │      │   ┌──► dequeueEvent("messages") ◄── BLOCKS HERE        │         │     ║
║   │      │   │         │                                           │         │     ║
║   │      │   │         ├── { type:"cmd" }                          │         │     ║
║   │      │   │         │    handle command                         │         │     ║
║   │      │   │         │    maybe CAN ──────────────────────► EXIT │         │     ║
║   │      │   │         │    else: ──────────────────────┐          │         │     ║
║   │      │   │         │                                │          │         │     ║
║   │      │   │         ├── [CHILD_UPDATE from=X ...]    │          │         │     ║
║   │      │   │         │    applyChildUpdate()          │          │         │     ║
║   │      │   │         │    ────────────────────────────┘          │         │     ║
║   │      │   │         │    LOOP BACK (dequeue next) ◄──────┐     │         │     ║
║   │      │   │         │                     ▲              │     │         │     ║
║   │      │   │         │                     │   POPS ONLY  │     │         │     ║
║   │      │   │         │                     │   ONE MSG    │     │         │     ║
║   │      │   │         │                     │   PER ITER   │     │         │     ║
║   │      │   │         │                     └──────────────┘     │         │     ║
║   │      │   │         ├── { prompt:"..." }                       │         │     ║
║   │      │   │         │    gotPrompt = true ──► EXIT INNER LOOP  │         │     ║
║   │      │   │         │                                          │         │     ║
║   │      │   │         └── unknown                                │         │     ║
║   │      │   │              ignore, loop back ────────────────────┘         │     ║
║   │      │   │                                                     │         │     ║
║   │      │   └─────────────────────────────────────────────────────┘         │     ║
║   │      └─────────────────────────────────────────────────────────┘         │     ║
║   └──────────────────────────────────┬───────────────────────────────────────┘     ║
║                                      │ got a prompt                                ║
║                                      ▼                                             ║
║   ┌───────────────────────────────────────────────────────────────────────────┐     ║
║   │ C. HYDRATE if needed [L865]                                              │     ║
║   │ D. RUN ONE LLM TURN [L922]                                              │     ║
║   └──────────────────────────────────┬───────────────────────────────────────┘     ║
║                                      │ TurnResult                                  ║
║                                      ▼                                             ║
║   ┌───────────────────────────────────────────────────────────────────────────┐     ║
║   │ E. RESULT DISPATCH                                                       │     ║
║   │                                                                          │     ║
║   │    ┌─── completed ──────────────────────────────────────────────┐        │     ║
║   │    │                                                            │        │     ║
║   │    │   IDLE INNER LOOP [L1169]                                  │        │     ║
║   │    │   ┌────────────────────────────────────────────────┐       │        │     ║
║   │    │   │ while deadline not reached:                    │       │        │     ║
║   │    │   │   race(                                        │       │        │     ║
║   │    │   │     dequeueEvent("messages"), ◄── ONE POP     │       │        │     ║
║   │    │   │     idleTimer                                  │       │        │     ║
║   │    │   │   )                                            │       │        │     ║
║   │    │   │   ├── CHILD_UPDATE → apply, loop               │       │        │     ║
║   │    │   │   ├── user msg → stash, CAN ───────────► EXIT  │       │        │     ║
║   │    │   │   └── timer → dehydrate, CAN ──────────► EXIT  │       │        │     ║
║   │    │   └────────────────────────────────────────────────┘       │        │     ║
║   │    └────────────────────────────────────────────────────────────┘        │     ║
║   │                                                                          │     ║
║   │    ┌─── wait ───────────────────────────────────────────────────┐        │     ║
║   │    │                                                            │        │     ║
║   │    │   WAIT INNER LOOP [L1269]                                  │        │     ║
║   │    │   ┌────────────────────────────────────────────────┐       │        │     ║
║   │    │   │ while wait timer active:                       │       │        │     ║
║   │    │   │   race(                                        │       │        │     ║
║   │    │   │     dequeueEvent("messages"), ◄── ONE POP     │       │        │     ║
║   │    │   │     waitTimer                                  │       │        │     ║
║   │    │   │   )                                            │       │        │     ║
║   │    │   │   ├── CHILD_UPDATE → apply, adjust, loop       │       │        │     ║
║   │    │   │   ├── user msg → interrupt, CAN ───────► EXIT  │       │        │     ║
║   │    │   │   └── timer → wait done, CAN ──────────► EXIT  │       │        │     ║
║   │    │   └────────────────────────────────────────────────┘       │        │     ║
║   │    └────────────────────────────────────────────────────────────┘        │     ║
║   │                                                                          │     ║
║   │    ┌─── input_required ─────────────────────────────────────────┐        │     ║
║   │    │   dequeueEvent("messages") → expect { answer }             │        │     ║
║   │    │   CAN with synthesized prompt ─────────────────────► EXIT  │        │     ║
║   │    └────────────────────────────────────────────────────────────┘        │     ║
║   │                                                                          │     ║
║   │    ┌─── wait_for_agents ────────────────────────────────────────┐        │     ║
║   │    │                                                            │        │     ║
║   │    │   AGENT-WAIT LOOP [L1763]                                  │        │     ║
║   │    │   ┌────────────────────────────────────────────────┐       │        │     ║
║   │    │   │ for iter < 360:                                │       │        │     ║
║   │    │   │   all agents done? → break                     │       │        │     ║
║   │    │   │   race(                                        │       │        │     ║
║   │    │   │     dequeueEvent("messages"), ◄── ONE POP     │       │        │     ║
║   │    │   │     30s poll timer                              │       │        │     ║
║   │    │   │   )                                            │       │        │     ║
║   │    │   │   ├── CHILD_UPDATE → apply, loop               │       │        │     ║
║   │    │   │   ├── user msg → CAN ──────────────────► EXIT  │       │        │     ║
║   │    │   │   └── poll timer → SDK status check, loop      │       │        │     ║
║   │    │   └────────────────────────────────────────────────┘       │        │     ║
║   │    └────────────────────────────────────────────────────────────┘        │     ║
║   │                                                                          │     ║
║   │    ┌─── spawn/message/check/etc ────────────────────────────────┐        │     ║
║   │    │   queueFollowupAndMaybeContinue()                          │        │     ║
║   │    │   continue outer loop or CAN ──────────────────────► EXIT  │        │     ║
║   │    └────────────────────────────────────────────────────────────┘        │     ║
║   │                                                                          │     ║
║   └──────────────────────────────────────────────────────────────────────────┘     ║
║                                                                                    ║
║   EXIT = yield* versionedContinueAsNew(...)  ──────────────────────────────► EXIT  ║
║          return "";                                                                ║
║                                                                                    ║
╚══════════════════════════════════════════════════════════════════════════════════════╝
```

## The Queue Drain Problem

```
TIME ──────────────────────────────────────────────────────────────────────────────►

CHILD SESSIONS:
                    ┌── child 1 calls wait() ──────────────────────────────────
                    │   sends CHILD_UPDATE type=wait to parent queue
                    │
                    ├── child 2 calls wait() ──────────────────────────────────
                    │   sends CHILD_UPDATE type=wait to parent queue
                    │
                    ├── child 3 calls wait() ──────────────────────────────────
                    │   sends CHILD_UPDATE type=wait to parent queue
                    │
                    │   ... children keep re-sending on every wait cycle ...
                    │
                    ▼

PARENT QUEUE:       enqueue ►►►►►►►►►►►►►►►►►►►►►►►►►►►►►►►►►►►►►►►►►►►►►►►
                    ┌──────────────────────────────────────────────────────┐
                    │CU│CU│CU│CU│CU│CU│CU│CU│CU│CU│CU│CU│CU│usr│CU│CU│CU│..│
                    │w1│w2│w3│w1│w2│w1│w3│w2│w1│w3│w2│w1│w3│prm│w1│w2│w3│  │
                    └──────────────────────────────────────────────────────┘
                                                         ▲
                                                         │
                                                    user's "ANSWER: BLUE"
                                                    buried under child updates

PARENT ORCH:        ◄── dequeue (one at a time)
                    turn 1: pop CU:w1 → apply → LLM turn → spawn_agent (retry)
                                                              │
                                                              ▼ completed
                                                         IDLE LOOP:
                                                           pop CU:w2 → apply
                                                           timer fires!
                                                              │
                                                              ▼
                                                    ╔═══════════════════╗
                                                    ║  continueAsNew    ║
                                                    ║  carry fwd ≤ 20  ║
                                                    ╚═══════════════════╝
                                                              │
                    turn 2: pop CU:w3 → apply → LLM turn →   │
                                                              │
                                          ... same pattern ...│
                                                              │
                    turn N:                                    │
                         ╔══════════════════════════════════╗  │
                         ║  queue has 25+ items             ║  │
                         ║  CAN carries only 20             ║  │
                         ║                                  ║  │
                         ║  ⚠ DROPPED:                      ║  │
                         ║    items 21-25 including          ║  │
                         ║    the user's "ANSWER: BLUE"     ║  │
                         ║                                  ║  │
                         ║  duroxide WARN log:              ║  │
                         ║  "Dropping carry-forward event   ║  │
                         ║   beyond limit of 20"            ║  │
                         ╚══════════════════════════════════╝
                                          │
                                          ▼
                              child stays blocked forever
                              parent keeps retrying spawn
                              user prompt lost


  ROOT CAUSE:    Every inner loop and every CAN transition
                 pops only ONE message at a time.

                 If children produce updates faster than the
                 parent drains them, the queue grows until
                 the 20-item carry-forward cap overflows.

                 User prompts and message_agent replies can
                 be among the dropped items.
```

## The Fix: Drain-First Before Any CAN

```
                                          │
                    ┌─────────────────────▼──────────────────────┐
                    │                                            │
                    │  DRAIN HELPER (before any CAN or timer)    │
                    │                                            │
                    │  ┌──► tryDequeue("messages")               │
                    │  │       │                                  │
                    │  │       ├── null (empty) → DONE            │
                    │  │       │                  queue is clean  │
                    │  │       │                  safe to CAN     │
                    │  │       │                                  │
                    │  │       ├── CHILD_UPDATE                   │
                    │  │       │   apply (coalesce dups)          │
                    │  │       │   LOOP BACK ─────────────────┐  │
                    │  │       │              ▲               │  │
                    │  │       │              │  drain next   │  │
                    │  │       │              └───────────────┘  │
                    │  │       │                                  │
                    │  │       ├── command                        │
                    │  │       │   handle inline                  │
                    │  │       │   LOOP BACK ─────────────────┐  │
                    │  │       │              ▲               │  │
                    │  │       │              └───────────────┘  │
                    │  │       │                                  │
                    │  │       └── user prompt / answer           │
                    │  │           STOP DRAIN                     │
                    │  │           hand to caller ──► process     │
                    │  │                                          │
                    │  │  bounded by MAX_DRAIN_PER_TURN           │
                    │  │  (safety valve against infinite drain)   │
                    │  │                                          │
                    │  └──────────────────────────────────────┘  │
                    │                                            │
                    └────────────────────────────────────────────┘

  RESULT:
    ✓ All child updates consumed before CAN
    ✓ User prompts found immediately (not buried)
    ✓ CAN carries ~0 stale messages
    ✓ No more carry-forward drops
    ✓ message_agent replies reach the child
```
