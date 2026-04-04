# Proposal: Inline Sub-Agent Tools And Explicit Turn Boundaries

> **Status:** Proposal
> **Date:** 2026-04-01
> **Goal:** Stop treating `spawn_agent` and other non-suspending control tools as turn-breaking events. Only end a turn when the model naturally finishes or explicitly asks to suspend.

---

## Summary

PilotSwarm currently uses `session.abort()` inside `ManagedSession` as an internal control-flow escape hatch for several tools:

- `spawn_agent`
- `message_agent`
- `check_agents`
- `wait_for_agents`
- `list_sessions`
- `complete_agent`
- `cancel_agent`
- `delete_agent`

That design made it easy to hand orchestration work back to `orchestration.ts`, but it also introduced an important semantic bug:

- a normal `spawn_agent` call looks like an aborted Copilot turn
- the parent model cannot continue reasoning after a spawn unless replay logic reconstructs the rest of the turn
- session status can be misclassified as `failed` because tool handoff aborts and real failures are too easy to confuse

The better model is:

- most tools, including sub-agent tools, should run inline and return a normal tool result back to the model
- only explicit suspension tools should stop the turn
- the model should decide when it is done with all tool and MCP calling for that turn

This proposal keeps durable orchestration behavior, but narrows turn-breaking behavior to explicit suspension points.

---

## Problem

### Current behavior

`ManagedSession.runTurn()` uses `session.abort()` to break out of the Copilot SDK turn when a control-plane tool fires. That is currently implemented in [managed-session.ts](/Users/affandar/workshop/drox/pilotswarm/packages/sdk/src/managed-session.ts).

For `spawn_agent`, the flow today is roughly:

1. The model calls `spawn_agent(...)`.
2. The tool handler pushes `{ type: "spawn_agent", ... }` into `pendingActions`.
3. The tool handler calls `session.abort()`.
4. `runTurn()` returns a synthetic `TurnResult`.
5. `orchestration.ts` handles the spawn outside the model turn.
6. Any additional tool calls from the same assistant response have to be carried as `queuedActions`.

### Why this is a bad fit for `spawn_agent`

This model is appropriate for tools that truly suspend a turn, such as:

- `wait`
- `wait_on_worker`
- `ask_user`
- `wait_for_agents`

It is a poor fit for `spawn_agent` and related control tools because the model may reasonably want to:

- spawn several children
- inspect the returned IDs
- send initial messages
- check status
- list sibling sessions
- do more parent-side reasoning
- then explicitly call `wait_for_agents`, `wait`, or simply finish the turn

Cutting the turn at the first spawn means the model loses normal same-turn continuity.

### User-visible symptoms

- parent sessions can look failed even when child sessions completed successfully
- `abort` and cancellation events are harder to interpret in traces
- replay complexity grows because queued control actions must be reconstructed outside the LLM turn
- the TUI can show misleading red failed rows for sessions that really only performed normal control-plane work

---

## Design Goal

PilotSwarm should follow this rule:

> A turn ends only when the model naturally finishes its response, or when it explicitly invokes a suspension tool.

In other words:

- tool calls and MCP server calls are part of the same turn
- `spawn_agent` should behave like a normal side-effecting tool call
- suspension should remain explicit

---

## Proposed Tool Taxonomy

### Inline tools

These should execute inline and return a normal tool result to the model without breaking the turn:

- `spawn_agent`
- `message_agent`
- `check_agents`
- `list_sessions`
- `complete_agent`
- `cancel_agent`
- `delete_agent`
- `list_available_models`
- normal user tools
- MCP server tools

### Suspension tools

These should remain explicit turn-breaking operations:

- `wait`
- `wait_on_worker`
- `ask_user`
- `wait_for_agents`

### Notes on `cron`

`cron` is already conceptually closer to an inline configuration tool than a suspension tool. It should remain inline:

- set or cancel recurring schedule
- let the model continue the turn
- let the model decide whether to finish normally, emit text, or separately call `wait`

---

## High-Level Architecture Change

The core change is to move non-suspending control-tool execution into the live `runTurn()` activity path instead of bouncing it back through an abort-based orchestration replay path.

### Current ownership

- `ManagedSession` exposes the tools to the model
- `ManagedSession` cannot directly fulfill `spawn_agent`, so it emits a synthetic pending action
- `orchestration.ts` owns the real side effects

### Proposed ownership

- `ManagedSession` still exposes the tools to the model
- `SessionProxy` injects a synchronous `controlToolBridge` into `ManagedSession.runTurn()`
- inline control tools call that bridge directly from the worker activity
- the model keeps going in the same Copilot turn
- `orchestration.ts` only receives:
  - normal completed results
  - explicit suspension results
  - real errors

---

## Proposed Module Changes

### `packages/sdk/src/managed-session.ts`

Change `ManagedSession.runTurn()` so that:

- inline control tools do not push `pendingActions`
- inline control tools do not call `session.abort()`
- inline control tools call injected async handlers and return structured tool output
- only suspension tools request turn termination

Introduce a `ControlToolBridge` shape similar to:

```ts
type ControlToolBridge = {
  spawnAgent(args): Promise<{ agentId: string; sessionId: string; status: "running" }>;
  messageAgent(args): Promise<{ ok: true }>;
  checkAgents(args): Promise<{ agents: AgentStatus[] }>;
  listSessions(args): Promise<{ sessions: SessionSummary[] }>;
  completeAgent(args): Promise<{ ok: true }>;
  cancelAgent(args): Promise<{ ok: true }>;
  deleteAgent(args): Promise<{ ok: true }>;
};
```

Also introduce a dedicated internal suspension signal for `wait`, `ask_user`, and `wait_for_agents`.

The preferred design is:

- do not use `session.abort()` for inline tools
- use either a sentinel exception or an explicit internal return channel for suspension

If the Copilot SDK still requires abort to stop a turn, reserve that mechanism only for suspension tools.

### `packages/sdk/src/session-proxy.ts`

Extend the `runTurn` activity to build and pass the `ControlToolBridge` into `ManagedSession.runTurn()`.

That bridge should implement inline side effects by reusing the same lower-level helpers currently used by the orchestration manager:

- spawn child session
- send message to child
- inspect child session state
- list sessions
- complete/cancel/delete child session

This activity already has access to:

- `SessionManager`
- `PilotSwarmClient`
- `SessionCatalogProvider`
- worker-local runtime configuration

So it is the right place to provide synchronous inline control operations.

### `packages/sdk/src/orchestration.ts`

Simplify orchestration flow:

- remove `spawn_agent` from the turn-breaking replay path
- remove replay dependence for `message_agent`, `check_agents`, `list_sessions`, `complete_agent`, `cancel_agent`, and `delete_agent`
- keep explicit result handling only for:
  - `completed`
  - `wait`
  - `input_required`
  - `wait_for_agents`
  - `error`

This should reduce reliance on:

- `pendingToolActions`
- `queuedActions`
- replay ordering edge cases after `session.abort()`

### `packages/sdk/src/session-status.ts`

Status handling should stop assuming that aborted tool handoff implies failure.

This proposal does not require a new session state to land first, but it strongly suggests:

- realign terminal-state sync so only actual orchestration failure writes `failed`
- treat explicit user cancellation separately from failure

That status work is related, but secondary to the main turn-boundary fix.

---

## Pseudocode

### Current flow

```ts
function spawn_agent_handler(args) {
  turnState.pendingActions.push({
    type: "spawn_agent",
    ...args,
  });
  session.abort();
  return "aborted";
}

function runTurn(prompt) {
  sdk.send(prompt);
  wait until session.idle or session.error;

  if (pendingActions.length > 0) {
    return pendingActions[0];
  }

  return completed(finalContent);
}

function orchestration_loop() {
  result = yield session.runTurn(prompt);

  if (result.queuedActions.length > 0) {
    pendingToolActions.push(...result.queuedActions);
  }

  switch (result.type) {
    case "spawn_agent":
      spawnChildSession(...);
      queueFollowup("Sub-agent spawned successfully...");
      return;
  }
}
```

### Proposed flow

```ts
async function runTurn(prompt, bridge) {
  let nextInput = prompt;

  while (true) {
    const assistant = await sdk.sendAndCollect(nextInput);

    if (!assistant.toolCalls.length) {
      return completed(assistant.content);
    }

    const toolResults = [];

    for (const toolCall of assistant.toolCalls) {
      switch (toolCall.name) {
        case "spawn_agent": {
          const result = await bridge.spawnAgent(toolCall.args);
          toolResults.push(asToolResult(toolCall, result));
          break;
        }

        case "message_agent": {
          const result = await bridge.messageAgent(toolCall.args);
          toolResults.push(asToolResult(toolCall, result));
          break;
        }

        case "check_agents": {
          const result = await bridge.checkAgents(toolCall.args);
          toolResults.push(asToolResult(toolCall, result));
          break;
        }

        case "list_sessions": {
          const result = await bridge.listSessions(toolCall.args);
          toolResults.push(asToolResult(toolCall, result));
          break;
        }

        case "complete_agent":
        case "cancel_agent":
        case "delete_agent": {
          const result = await bridge[toolCall.name](toolCall.args);
          toolResults.push(asToolResult(toolCall, result));
          break;
        }

        case "wait":
        case "wait_on_worker":
        case "ask_user":
        case "wait_for_agents": {
          return suspendFromTool(toolCall.name, toolCall.args, assistant.partialContent);
        }

        default: {
          const result = await runRegularTool(toolCall);
          toolResults.push(asToolResult(toolCall, result));
          break;
        }
      }
    }

    nextInput = toolResults;
  }
}
```

### Proposed orchestration flow

```ts
function orchestration_loop() {
  while (true) {
    if (pendingPrompt) {
      result = yield session.runTurn(pendingPrompt, controlToolBridge);
      pendingPrompt = undefined;
    } else if (fifo.hasItems()) {
      result = processNextFifoItem();
    } else {
      blockForNextMessageOrTimer();
      continue;
    }

    switch (result.type) {
      case "completed":
        writeLatestResponse(result.content);
        maybeArmCronOrIdleTimer();
        break;

      case "wait":
        persistWaitState(result);
        armWaitTimer(result);
        break;

      case "input_required":
        persistQuestion(result);
        armInputWait(result);
        break;

      case "wait_for_agents":
        persistWaitingForAgents(result.agentIds);
        armAgentWait(result.agentIds);
        break;

      case "error":
        handleRealTurnError(result);
        break;
    }
  }
}
```

### Key behavioral difference

Under the proposal, this is valid within one model turn:

```text
1. spawn_agent(...)
2. spawn_agent(...)
3. check_agents()
4. message_agent(...)
5. wait_for_agents(...)
```

Today, step 1 already breaks the turn.

Under the proposal, the turn only suspends at step 5 because the model explicitly chose to wait.

---

## Required Semantics

### 1. Inline tools must preserve order

If the model emits several tool calls in one response:

- execute them in order
- feed their results back in order
- let later tool calls depend on earlier inline results

### 2. Suspension tools are terminal in a tool batch

If a model emits:

```text
spawn_agent(...)
wait_for_agents(...)
message_agent(...)
```

that is ambiguous. Once suspension is requested, the rest of the tool batch should not continue.

Recommended rule:

- suspension tools must be the last tool call in a batch
- if not, return a structured tool error to the model explaining that suspension tools must be last

### 3. Child bookkeeping must be available inline

Inline `check_agents`, `message_agent`, and `wait_for_agents` need a current view of child state.

That state must be available through the bridge without depending on replayed followup text.

### 4. Parent status must not become `failed` because a control tool fired

A normal `spawn_agent` or `message_agent` flow must not generate a terminal failure state.

---

## Migration Plan

### Phase 1: Introduce the bridge

- add `ControlToolBridge` to `ManagedSession.runTurn()`
- implement inline bridge methods in `session-proxy.ts`
- keep current orchestration handlers in place for compatibility

### Phase 2: Narrow turn-breaking tools

- convert `spawn_agent`, `message_agent`, `check_agents`, `list_sessions`, `complete_agent`, `cancel_agent`, and `delete_agent` to inline tools
- keep `wait`, `wait_on_worker`, `ask_user`, and `wait_for_agents` as suspending

### Phase 3: Simplify orchestration replay

- remove replay dependence for non-suspending control tools
- shrink `queuedActions` usage
- remove now-dead followup text paths that only existed to reconstruct broken turns

### Phase 4: Tighten status semantics

- stop mapping control-flow aborts to `failed`
- decide whether explicit cancellation should stay `completed` or become a first-class `cancelled` session state

---

## Risks

### SDK tool-loop behavior

If the Copilot SDK does not tolerate a long inline control-tool sequence well, we may still need a sentinel-based early exit for suspension tools only.

### Reentrancy and side effects

Inline `spawn_agent` means child creation can now happen during an active model turn. The bridge must ensure:

- child sessions are created idempotently
- duplicate named-agent spawning still respects dedup guards
- child-tracker state is updated before later inline tools inspect it

### Status drift

If `getStatus()` and `getInstanceInfo()` continue to disagree about terminal state, the session list can still lie even after inline tool execution is fixed. That should be cleaned up as part of the same implementation stream.

---

## Recommendation

PilotSwarm should stop treating `spawn_agent` as a turn-breaking tool.

The best target behavior is:

- inline control tools stay inside the same model turn
- suspension remains explicit
- the orchestration resumes control only when the model actually finishes or intentionally suspends

That matches the mental model users expect, reduces replay complexity, and removes a major source of false failure classification around sub-agent fanout.
