# Orchestration Flat Event Loop

## Status

Proposed

## Problem

The current orchestration in `orchestration.ts` has 5+ nested `while` loops, each with its own bespoke message-dequeue/timer-race/continueAsNew logic. This causes:

1. **Queue overflow** — child updates pile up because each inner loop pops only one message per iteration before hitting a `continueAsNew` boundary. Duroxide's carry-forward cap of 20 drops the overflow, losing user prompts and `message_agent` replies.
2. **Parent-child deadlock** — reproduced by `parent-child-roundtrip.test.js`. The parent never drains its queue fast enough to see the user's reply to the child.
3. **Code complexity** — the same dequeue/parse/child-update/timer-race pattern is duplicated across idle, wait, cron, input_required, and wait_for_agents branches.

## Core Insight

The orchestration has exactly two input sources and one output:

| Source | What |
|---|---|
| **Messages** | User prompts, child updates, commands, answers — all on the duroxide `"messages"` queue |
| **Timers** | Durable wait timers, cron timers, idle timers |
| **LLM turn** | The single output — produces a `TurnResult` that updates orchestration state |

Everything else is routing logic around those three things.

## Design

Replace the nested loops with one flat event loop. The loop keeps iterating as long as there is buffered work to process. It only does `continueAsNew` when:

1. **No buffered work remaining** — the KV work buffer is empty, there are no pending tool actions, and there is nothing immediately ready to process.
2. **Iteration count > 100** — safety valve against unbounded history growth.

### Loop Shape

```
iteration = 0

while (true) {
    iteration++

    // 1. CAN if iteration > 100 (check FIRST to avoid runaway loops)
    if (iteration > 100) {
        continueAsNew(carry state)
        return
    }

    // 2. DRAIN: greedily move immediately available work into KV.
    //    The drain treats the duroxide queue and timer expirations as
    //    external intake only. Everything it sees gets normalized into
    //    KV buckets, then the rest of the loop processes from KV.
    //
    //    Message routing:
    //    - child updates → apply to local state (coalesce duplicates)
    //    - commands → handle inline
    //    - user prompt → stash into KV (pending.prompts.*), keep draining
    //    - answer → stash into KV (pending.answers.*), keep draining
    //    - unknown → log and skip
    //
    //    Timer routing:
    //    - wait/cron/idle timer fired → stash into KV (pending.timers.*), keep draining
    //
    //    CRITICAL: drain does not stop just because a prompt, answer,
    //    or timer fired. It keeps moving work into KV until there is
    //    nothing immediately available to intake, or MAX_DRAIN_PER_TURN
    //    is hit.
    drain()

    // 3. DECIDE: process one buffered item in order.
    //    Priority order:
    //    1. pending.timers.*
    //    2. pending.prompts.*
    //    3. pending.answers.*
    //    4. pending tool actions / child-state work
    if (has item in any KV bucket OR has pending tool actions OR has agents-done) {
        process one buffered item
        apply TurnResult / update state
        continue
    }

    // 4. No buffered work → CAN (safe checkpoint, we're genuinely idle).
    //    Any active timer state is carried forward and the next execution's
    //    drain pass may block on dequeueEvent vs that timer.
    continueAsNew(carry state)
    return
}
```

### Key Rule

**Drain first, decide second, checkpoint last.** The current code does the opposite — it waits first, processes one item, then potentially hits CAN before draining the rest.

### State Becomes Explicit Data

```ts
interface OrchState {
    phase: "idle" | "running" | "waiting" | "input_required" | "waiting_for_agents";
    activeTimer: { deadlineMs: number; reason: string; type: "wait" | "cron" | "idle" } | null;
    cronSchedule: { intervalSeconds: number; reason: string } | null;
    pendingToolActions: TurnAction[];
    subAgents: SubAgentEntry[];
    iteration: number;
}
```

Timer state, cron schedules, and the current phase are data fields, not implicit "which inner loop am I in" control flow.

## What Changes

| Today | New |
|---|---|
| 5+ nested `while` loops | 1 flat `while (true)` |
| Each result type has its own dequeue/timer-race code | One shared drain + one shared KV-backed decide step |
| Child updates processed inline per-loop, one at a time | Batch-drained at the top of every iteration |
| Timer state is implicit in which inner loop we're in | Timer state is explicit data (`activeTimer`, `cronSchedule`) |
| `continueAsNew` scattered across every branch | One CAN decision point: iteration > 100 or no buffered work |
| Queue overflows because we CAN with undrained backlog | Queue is drained aggressively before CAN |

## What Stays The Same

- Duroxide primitives (`dequeueEvent`, `scheduleTimer`, `race`, `continueAsNewVersioned`)
- Session lifecycle (hydrate, dehydrate, checkpoint)
- LLM turn interface (`session.runTurn()`)
- TurnResult types and their semantics (completed, wait, cron, spawn_agent, message_agent, etc.)
- Sub-agent tracking (`subAgents` array)
- CMS event recording
- KV response/status publishing
- Orchestration versioning — old versions stay frozen

## Message Types on the Queue

All messages arrive as JSON on the same `"messages"` queue:

| Type | Shape | Routed by |
|---|---|---|
| User prompt | `{ prompt: "...", bootstrap?: true }` | `client.send()`, `sendToSession()` |
| Child update | `{ prompt: "[CHILD_UPDATE from=X type=Y ...]\n..." }` | Child orchestration `sendToSession()` |
| Command | `{ type: "cmd", cmd: "...", id: "...", args: {...} }` | `mgmt.sendCommand()` |
| Answer | `{ answer: "...", wasFreeform: true }` | `mgmt.sendAnswer()`, client input handler |
| Arbitrary | `{ ... }` | `session.sendEvent()` (escape hatch) |

The drain helper classifies each message by shape and routes it.

## Drain Helper Pseudocode

The drain helper **never stops early for a user prompt, answer, or timer**. It normalizes everything into the orchestration's KV store and keeps pulling intake until there is nothing immediately available, or the per-drain cap is hit.

The timer race happens **inside** the drain loop, not as a separate step. Timers and queue messages are both just intake sources that get normalized into KV work items.

```ts
function* drainMessageQueue(): Generator<any, DrainResult, any> {
    let drained = 0;
    const pendingPrompts: any[] = [];
    const pendingAnswers: any[] = [];
    const pendingTimers: any[] = [];
    const seenChildUpdates = new Set();

    for (let i = 0; i < MAX_DRAIN_PER_TURN; i++) {
        // Race: try to dequeue vs active timer (if any)
        let msg: any;
        if (state.activeTimer) {
            const msgFuture = ctx.dequeueEvent("messages");
            const timerFuture = ctx.scheduleTimer(state.activeTimer.remainingMs);
            const race = yield ctx.race(msgFuture, timerFuture);

            if (race.index === 1) {
                // Timer won — stash it to KV as a work item, keep draining
                pendingTimers.push({
                    type: state.activeTimer.type,
                    reason: state.activeTimer.reason,
                    firedAtMs: yield ctx.utcNow(),
                });
                state.activeTimer = null;
                // Keep draining in case there are queued messages too.
                continue;
            }
            msg = typeof race.value === "string" ? JSON.parse(race.value) : race.value;
        } else {
            // No timer — non-blocking dequeue only
            msg = yield* tryDequeueNonBlocking();
            if (!msg) break;  // nothing immediately available
        }

        drained++;

        // Route the message into KV buckets
        if (msg.type === "cmd") {
            yield* handleCommand(msg);  // commands are immediate, not buffered
            continue;
        }

        const childUpdate = parseChildUpdate(msg.prompt);
        if (childUpdate) {
            const key = `${childUpdate.sessionId}|${childUpdate.updateType}`;
            if (!seenChildUpdates.has(key)) {
                seenChildUpdates.add(key);
                yield* applyChildUpdate(childUpdate);  // child state is immediate
            }
            continue;
        }

        if (msg.answer !== undefined) {
            pendingAnswers.push(msg);
            continue;  // stash, keep draining
        }

        if (msg.prompt) {
            pendingPrompts.push(msg);
            continue;  // stash, keep draining
        }

        ctx.traceInfo(`[drain] skipping unknown: ${JSON.stringify(msg).slice(0, 120)}`);
    }

    // Flush all stashed items to KV (the replay-safe work buffer)
    if (pendingPrompts.length > 0) flushToBuckets("pending.prompts", pendingPrompts);
    if (pendingAnswers.length > 0) flushToBuckets("pending.answers", pendingAnswers);
    if (pendingTimers.length > 0)  flushToBuckets("pending.timers", pendingTimers);

    return { drained };
}
```

### Timer inside drain — why this matters

Timers are just another work item that gets stashed into KV during drain. They don't have special control flow — they're buffered the same way prompts and answers are. This means:

1. If 10 child updates arrive, then a cron timer fires, then 5 more child updates arrive — the drain processes all 15 child updates AND records the timer in `pending.timers`. The decide step then processes the timer in order.

2. If a user prompt and a wait timer fire at the same time — both land in KV. The decide step sees them and processes them in priority order (timers first, then prompts).

3. If the queue is empty and we have an active timer — the drain may block on `race(dequeue, timer)`. When the timer fires, it's stashed to `pending.timers` in KV and drain continues trying to dequeue. If nothing else is immediately available, drain returns and the decide step picks up the timer from KV.

4. After a timer fires, the drain **keeps draining**. If messages arrived while the timer was pending, they get consumed in the same drain pass rather than being left for carry-forward.

The two-stage model: **Queue + Timers → KV (drain) → Process (decide)**. Everything flows through KV. Outside the drain helper, the loop only ever reads from KV to decide what to do next.

### Why KV instead of in-memory stash

The KV store is the **replay-safe in-memory buffer**. The architecture is two-stage:

```
  duroxide queue          KV store              process
  (external intake)       (work buffer)         (one at a time)
  ─────────────────►  ─────────────────►  ──────────────────►

    Queue → KV:           KV → decide:
    - greedy              - ordered
    - batch               - one item per outer iteration
    - bounded             - reads are free (in-memory)
    - coalesces dups      - removes item after processing
```

The duroxide event queue is the external intake — messages land here from clients, children, management. The KV store is the internal work buffer — the drain step moves everything from the queue into KV, and the rest of the loop only ever reads from KV.

This separation guarantees:

1. **The queue is fully emptied** — no items left to carry forward and potentially drop at CAN.
2. **User prompts are never lost** — they're in KV even if CAN fires before we process them.
3. **Processing order is preserved within each buffered type** — KV buckets maintain FIFO within prompts, answers, and timers. The decide step pulls items in priority order across those types.
4. **The decide step has a single source** — it reads from KV, not from a mix of queue state, in-memory variables, and carry-forward leftovers.
5. **Replay safety** — KV survives CAN and crash recovery via the duroxide ack mechanism. In-memory variables don't.

### KV Limits and Bucketing Strategy

Duroxide enforces hard limits on KV:

| Limit | Value |
|---|---|
| `MAX_KV_KEYS` | 100 keys per orchestration instance |
| `MAX_KV_VALUE_BYTES` | 16 KiB per value |

To stay within these limits while supporting high-throughput work buffering, we **partition into 5 ordered buckets per type**:

```
pending.prompts.0   pending.prompts.1   ...   pending.prompts.4
pending.answers.0   pending.answers.1   ...   pending.answers.4
pending.timers.0    pending.timers.1    ...   pending.timers.4
```

That's 15 keys total for the three buffered work types — still well under the 100-key cap. Each bucket holds a JSON array. When draining:

1. Append to the current bucket.
2. If the serialized bucket would exceed ~14 KiB, rotate to the next bucket.
3. If all 5 buckets are full for a given type (5 × ~14 KiB = ~70 KiB per type — an extreme edge case), stop stashing that type and log a warning. The remaining queue items will carry forward normally.

When deciding (step 3 of the main loop):

1. Read timer buckets first, then prompt buckets, then answer buckets.
2. Within each type, read buckets 0–4 in order.
3. Process the first pending item from the lowest-numbered non-empty bucket.
4. After processing, remove it and compact within that type.

KV reads are in-memory during a single execution — they're essentially free. Writes update the in-memory snapshot and get persisted at the next ack. So the bucketed approach adds no meaningful latency.

```ts
const PROMPT_BUCKETS = 5;
const ANSWER_BUCKETS = 5;
const TIMER_BUCKETS = 5;
const MAX_BUCKET_BYTES = 14 * 1024;  // ~14 KiB, under the 16 KiB hard limit

function promptBucketKey(index: number): string {
    return `pending.prompts.${index}`;
}
function answerBucketKey(index: number): string {
    return `pending.answers.${index}`;
}
function timerBucketKey(index: number): string {
    return `pending.timers.${index}`;
}
```

## CAN Decision

```ts
// Only CAN when:
// 1. No buffered work remains (safe to reset history)
// 2. Iteration > 100 (safety valve)

if (iteration > MAX_ITERATIONS) {
    yield* versionedContinueAsNew(buildContinueInput());
    return "";
}

// Nothing buffered to process — good CAN point
if (noBufferedWork) {
    yield* versionedContinueAsNew(buildContinueInput());
    return "";
}
```

## Implementation Order

1. **Add drain helper** to the existing orchestration (incremental, testable with existing suite)
2. **Collapse idle/wait/cron inner loops** into timer state + KV-buffered timer work items
3. **Collapse agent-wait loop** into phase state + drain
4. **Move CAN** to the single decision point
5. **Freeze** current orchestration as `orchestration_1_0_31.ts`, register new version as `1.0.32`

Each step is individually testable against the existing suite. The parent-child roundtrip regression validates the queue-overflow fix.

## Risk Mitigation

- Old orchestration version stays frozen. In-flight sessions on `1.0.31` replay correctly.
- New version `1.0.32` is registered alongside old ones via `orchestration-registry.ts`.
- Existing test suite validates both drain behavior and all existing features.
- `parent-child-roundtrip.test.js` validates the specific queue-overflow fix.
- `repro-parent-child-model-compare.mjs` validates the fix across `gpt-5.4` and `claude-opus-4.6`.

## What This Fixes

1. **Queue overflow / carry-forward drops** — messages batch-drained before any CAN
2. **Lost user prompts** — user messages found during drain, not buried under child updates
3. **Parent-child deadlock** — parent drains child updates eagerly, processes user prompt immediately
4. **Code complexity** — one loop instead of five nested ones
5. **Timer management** — timers are data, not control flow
6. **Child update coalescing** — duplicate wait updates from the same child collapsed during drain
