# Main Orchestration Loop

The full design — module layout, runtime model, drain/decide pseudocode,
TurnResult dispatch, sub-agents, shutdown cascade, CAN, hydration, replay
invariants — is documented in [Orchestration Design](./orchestration-design.md).

This file remains as a short orientation for newcomers.

## What The Orchestration Owns

The orchestration is the durable coordinator for a session. It owns:

- dequeueing user / control / child events
- deciding when to run an LLM turn
- timers (`wait`, `cron`, idle, input grace, agent-poll)
- sub-agent bookkeeping
- hydration / dehydration decisions
- `continueAsNew` boundaries
- durable custom status for the live session view

It does **not** own tool implementations or Copilot SDK session logic. Those
live in worker activities and the session manager.

## Mental Model

```text
client / child sessions / commands
              │
              ▼
      duroxide message queue
              │
              ▼
          drain (queue + timer fires → KV FIFO)
              │
              ▼
          decide (pop one unit of work)
              │
      ┌───────┼────────┬──────────────┐
      │       │        │              │
      ▼       ▼        ▼              ▼
   runTurn   timers  child state   continueAsNew
```

## Source

- [`packages/sdk/src/orchestration/`](../packages/sdk/src/orchestration/) —
  current latest (v1.0.52). Eight modules: `index`, `runtime`, `state`,
  `lifecycle`, `queue`, `turn`, `agents`, `utils`.
- [`packages/sdk/src/orchestration_1_0_*.ts`](../packages/sdk/src/) — frozen
  prior versions (replay only). Registered in `orchestration-registry.ts`.

## Where To Read Next

- [Orchestration Design](./orchestration-design.md) — the comprehensive doc
- [Architecture](./architecture.md)
- [Component Interactions](./component-interactions.md)
