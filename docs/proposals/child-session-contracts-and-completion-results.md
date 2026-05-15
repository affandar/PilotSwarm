# Proposal: Child Session Contracts And Completion Results

> **Status:** Proposal
> **Date:** 2026-05-13
> **Goal:** Make parent/child agent coordination explicit, inspectable, and mechanically verifiable across PilotSwarm applications.

---

## Summary

PilotSwarm currently supports parent sessions spawning and managing child
sessions, but the contract between parent and child is mostly prose. A child can
complete, be marked done, or be cancelled without producing a structured result
that the parent, portal, TUI, MCP server, or SDK can inspect uniformly.

The May 2026 Waldemort HorizonDB hackathon campaign made this visible at scale:
one root session spawned 27 descendant sessions. Children produced useful facts
and final messages, but parent/child communication was still loose. Some children
were terminated or cancelled without durable markdown artifacts. Parent sessions
had to infer missing outputs from transcripts.

This proposal adds base PilotSwarm primitives for:

- typed child-session contracts
- explicit completion results
- contract validation
- artifact and fact output tracking
- structured parent-facing child summaries
- fan-out/fan-in helpers
- bounded polling semantics

Application-specific policy, such as which HorizonDB facts or markdown reports
are required, should remain in the application plugin. PilotSwarm should provide
the generic coordination layer.

---

## Problem

### Current behavior

Today, child coordination is distributed across several mechanisms:

- `spawn_agent` creates a child with a prose task.
- `message_agent` can send follow-up prose.
- `complete_agent`, `cancel_agent`, `done`, or equivalent session commands move
  lifecycle state.
- Child outputs are usually visible as final assistant messages, facts, tool
  calls, and artifacts, but there is no canonical completion payload.
- `session.agent_spawned` records useful metadata, but not a typed contract.

The runtime can tell that a child exists and that it eventually stopped. It
cannot reliably tell what the child promised to produce, what it actually
produced, or whether a parent closed the child before the promised outputs were
present.

### User-visible symptoms

- Parent agents scrape child transcripts or rely on final assistant messages.
- Missing artifacts are discovered late, often by a human operator.
- `cancel` loses important partial-result semantics.
- Long polling sessions can run until an operator or parent cancels them.
- Fan-out/fan-in is hand-rolled in prompts instead of supported by the runtime.
- Portal/TUI session trees show state, but not output-contract health.

---

## Evidence From Waldemort

The HorizonDB hackathon campaign is a concrete stress case:

- Root session: `47a0cf62-93a5-49d6-a81f-3d362320f908`
- Descendant sessions: 27
- Root events: 16,801
- Typical child spawn event data: `{ task, agentId, childSessionId }`
- Child outputs were mostly fact writes and final assistant text.
- Sampled leaves showed hundreds of fact writes but only two file/edit/write
  tool calls.
- Every sampled successful child was closed by a parent-side `done` command.
- A long ARM watcher child was cancelled after many polling cycles, leaving the
  parent to interpret the partial state.

The problem is not Waldemort-specific. Any PilotSwarm workflow that delegates
work to children can hit the same loose contract boundary.

---

## Design Goals

1. A parent can state exactly what it expects a child to produce.
2. A child can complete with a structured result, not just a final message.
3. The runtime can validate expected outputs before declaring completion.
4. A cancelled or timed-out child can still publish a partial result.
5. Parent sessions, Portal, TUI, SDK clients, and MCP clients can all query the
   same child-result model.
6. Existing uncontracted sessions remain supported.

## Non-Goals

- Do not encode application-specific fact schemas in the base runtime.
- Do not require every quick exploratory child to have a strict contract.
- Do not make markdown artifacts mandatory globally.
- Do not remove existing final assistant messages or transcript views.

---

## Proposed Ownership By Layer

### Agent Instructions

Base PilotSwarm should provide generic guidance that agents can inherit:

- When delegating work, include a clear contract if the task has required
  outputs.
- When completing delegated work, provide a structured result:
  - verdict
  - summary
  - outputs produced
  - blockers
  - follow-up actions
- Do not mark a child complete if known required outputs are missing.

This should be a small shared instruction pattern, not a long domain runbook.
Application plugins can extend it with domain-specific requirements.

### Skills

Base PilotSwarm can include a generic coordination skill, for example:

- how to use child-session contracts
- how to complete with a structured result
- how to use fan-out/fan-in helpers
- how to write partial results on cancel or timeout

Domain-specific skills, such as Waldemort's HorizonDB pgbench or region-affinity
rules, should remain in the application plugin.

### Tools

Existing control tools should grow contract/result-aware variants or optional
parameters:

- `spawn_agent(task, agentId?, contract?)`
- `message_agent(sessionId, message, contractPatch?)`
- `complete_agent(sessionId, result?)`
- `cancel_agent(sessionId, reason, partialResult?)`
- `wait_for_agents(sessionIds, options?)`
- `check_agents(sessionIds?)`

Tool results should return the child contract status and last structured result
when available.

The model should not need to scrape child final messages to understand whether a
contract was satisfied.

### MCP Server

Expose the same primitives through MCP so operators and external tools can
inspect child coordination state:

- `get_session_contract(sessionId)`
- `get_session_result(sessionId)`
- `list_child_results(parentSessionId)`
- `list_contract_violations(parentSessionId?)`
- `get_session_tree_outputs(rootSessionId)`

These should be read-only by default. Mutating MCP endpoints, if added, should
reuse the same SDK validation path as the in-session tools.

### Base Orchestration / SDK Code

This is the primary implementation home. The SDK/runtime should provide:

- persisted contract records
- persisted completion result records
- lifecycle events for contract registration, output publication, validation,
  completion, cancellation, timeout, and violation
- validation hooks for facts/artifacts where stores are configured
- a typed result API used by Portal, TUI, MCP, and application code

---

## Data Model

### Child Session Contract

Proposed TypeScript shape:

```ts
export interface ChildSessionContract {
  contractId?: string;
  parentSessionId: string;
  childSessionId: string;
  purpose?: string;
  expectedFacts?: ExpectedFact[];
  expectedArtifacts?: ExpectedArtifact[];
  successCriteria?: string[];
  blockerPolicy?: "allow-blocked-result" | "require-success";
  deadlineAt?: string;
  maxPollCount?: number;
  maxWallClockMs?: number;
  metadata?: Record<string, unknown>;
}

export interface ExpectedFact {
  key: string;
  scope?: "shared" | "session";
  required?: boolean;
  schemaRef?: string;
}

export interface ExpectedArtifact {
  path: string;
  contentType?: string;
  required?: boolean;
}
```

The base runtime should not interpret `schemaRef` beyond preserving it and
passing it to application validators, if registered.

### Child Session Result

```ts
export type ChildSessionVerdict =
  | "success"
  | "partial"
  | "blocked"
  | "failed"
  | "cancelled"
  | "timed_out";

export interface ChildSessionResult {
  sessionId: string;
  parentSessionId?: string;
  verdict: ChildSessionVerdict;
  summary: string;
  factsWritten?: OutputReference[];
  artifactsWritten?: OutputReference[];
  blockers?: string[];
  nextActions?: string[];
  contractViolations?: ContractViolation[];
  completedAt: string;
  finalAssistantMessageSeq?: number;
  reasoningSummary?: string;
  metadata?: Record<string, unknown>;
}

export interface OutputReference {
  kind: "fact" | "artifact" | "url" | "work-item" | "other";
  key?: string;
  path?: string;
  url?: string;
  title?: string;
  metadata?: Record<string, unknown>;
}

export interface ContractViolation {
  code:
    | "missing_fact"
    | "missing_artifact"
    | "schema_invalid"
    | "deadline_exceeded"
    | "poll_budget_exhausted"
    | "completed_without_result";
  message: string;
  expected?: unknown;
  observed?: unknown;
}
```

### Storage

Possible CMS additions:

- `session_contracts`
  - `contract_id`
  - `parent_session_id`
  - `child_session_id`
  - `contract_json`
  - `created_at`
  - `updated_at`

- `session_results`
  - `session_id`
  - `parent_session_id`
  - `verdict`
  - `summary`
  - `result_json`
  - `created_at`
  - `updated_at`

This should be additive and optional. Existing sessions without contracts or
results remain valid.

---

## Runtime Events

Add or standardize these events:

- `session.contract_registered`
- `session.contract_updated`
- `session.fact_published`
- `session.artifact_published`
- `session.result_submitted`
- `session.contract_validated`
- `session.contract_violation`
- `session.completed`
- `session.cancelled_with_partial_result`
- `session.poll_budget_exhausted`

`session.completed` should be emitted for both normal completion and explicit
`complete_agent`/`done` flows. Legacy completion can synthesize a minimal result
from the last assistant message.

---

## Tool Semantics

### `spawn_agent`

`spawn_agent` should accept an optional contract:

```json
{
  "agentId": "perf-test-runner",
  "task": "Run a pgbench smoke test...",
  "contract": {
    "purpose": "Collect region-valid pgbench smoke metrics",
    "expectedFacts": [
      { "key": "result/pgbench-smoke/hdb-hack-westus3-16c", "scope": "shared" }
    ],
    "expectedArtifacts": [
      { "path": "reports/hdb-hack-westus3-16c-pgbench.md" }
    ],
    "successCriteria": ["region affinity verified", "result fact written"],
    "maxWallClockMs": 1800000
  }
}
```

The tool result should include the child ID and registered contract ID.

### `complete_agent` / `done`

Completion should accept a structured result. If the child has a contract, the
runtime should validate expected outputs and attach violations.

Policy choices:

- Strict mode: refuse completion when required outputs are missing.
- Advisory mode: allow completion but record violations.

Strict mode should be opt-in at first for backward compatibility.

### `cancel_agent`

Cancellation should optionally require a partial result:

```json
{
  "reason": "ARM operation remained Updating after 30 minutes",
  "partialResult": {
    "verdict": "timed_out",
    "summary": "Four replica PUTs were accepted but no read replica appeared.",
    "factsWritten": [
      { "kind": "fact", "key": "result/horizondb/westus3-16c-read-replicas-20260513" }
    ],
    "blockers": ["ARM operation did not converge before timeout"]
  }
}
```

If no partial result is supplied, the runtime should emit a warning or violation
for contracted sessions.

### `wait_for_agents`

`wait_for_agents` should return child results, not just status:

```ts
interface WaitForAgentsResult {
  children: Array<{
    sessionId: string;
    status: string;
    result?: ChildSessionResult;
    contract?: ChildSessionContract;
    violations?: ContractViolation[];
  }>;
}
```

---

## Fan-Out / Fan-In Helper

Many workflows spawn one child per target and then aggregate results. PilotSwarm
should provide a helper in the SDK and tool layer:

```ts
spawnAgentBatch({
  parentSessionId,
  children: [
    { agentId, task, contract },
    { agentId, task, contract },
  ],
  joinPolicy: "all-settled" | "all-success" | "first-success",
});
```

The paired wait API should return a structured aggregate:

- all successful results
- partial results
- blocked children
- failed children
- missing outputs
- suggested parent next action

This keeps common orchestration patterns out of ad hoc prompts.

---

## Bounded Polling Primitive

Long-running polling sessions need a first-class budget:

```ts
interface PollBudget {
  maxIterations?: number;
  maxWallClockMs?: number;
  intervalMs?: number;
  partialResultFactKey?: string;
  onBudgetExhausted?: "complete_timed_out" | "ask_parent" | "cancel";
}
```

When budget is exhausted, the runtime should produce a `timed_out` result with
last-known state instead of relying on an external parent cancellation.

This is generic. Applications decide what state to record.

---

## Portal And TUI Experience

Portal and TUI should render contract health in session trees:

- expected facts/artifacts
- produced facts/artifacts
- result verdict
- contract violations
- blocked children
- cancelled children with or without partial results
- poll budget remaining or exhausted

The parent timeline should include a compact child result card when a child
finishes. Operators should not need to open every child transcript for basic
status.

---

## MCP / Management API

The management API and MCP server should expose:

- `listSessionContracts(rootOrParentSessionId)`
- `getSessionContract(sessionId)`
- `getSessionResult(sessionId)`
- `listChildResults(parentSessionId)`
- `getSessionTreeOutputStatus(rootSessionId)`
- `listContractViolations(rootSessionId?)`

These APIs should be usable by:

- Portal
- TUI
- operators
- external MCP clients
- audit/report-generation agents

---

## Backward Compatibility

- Contracts are optional.
- Existing sessions without contracts are treated as legacy sessions.
- A minimal result can be synthesized from the final assistant message for
  display purposes, but it should be marked `source: legacy_synthesized`.
- Strict validation starts disabled by default.
- Application plugins can opt into strict validation per agent, per session, or
  per tool call.

---

## Implementation Plan

### Phase 1: Data and event model

- Add CMS tables or columns for contracts and results.
- Add TypeScript types in the SDK.
- Emit contract registration and result submission events.
- Add read APIs in management client.

### Phase 2: Tool integration

- Extend `spawn_agent`, `complete_agent`, `cancel_agent`, and `wait_for_agents`.
- Preserve old signatures.
- Return structured result payloads where available.

### Phase 3: Validation hooks

- Validate expected artifacts against the configured artifact store.
- Validate expected facts when a fact store is configured.
- Add application hook for schema validation by `schemaRef`.
- Support advisory mode first, strict mode later.

### Phase 4: Portal/TUI/MCP surfaces

- Add result cards to session tree views.
- Add contract violation badges.
- Add MCP/management endpoints for tree output status.

### Phase 5: Fan-out and polling helpers

- Add batch spawn/join helper.
- Add bounded polling primitive.
- Integrate poll budget exhaustion with structured results.

---

## Acceptance Criteria

- A parent can spawn a child with expected facts and artifacts.
- The child can complete with a structured result.
- `wait_for_agents` returns the structured child result.
- Portal/TUI can display whether the child satisfied its contract.
- Cancelling a contracted child without a partial result records a visible
  warning or violation.
- Existing uncontracted sessions continue to work.
- A Waldemort-style campaign with regional children can be audited without
  transcript scraping.

---

## Open Questions

- Should strict validation be configured globally, per plugin, per agent, or per
  contract?
- Should fact/artifact publication be inferred from tool calls, explicitly
  declared by the child, or both?
- How much reasoning summary should be included in `ChildSessionResult` without
  exposing excessive hidden chain-of-thought detail?
- Should contracts live only in CMS, or also in orchestration input/history for
  full replayability?
- Should `done` become a structured completion command, or should structured
  result submission be a separate tool that `done` verifies?

---

## Relationship To Application Plugins

This proposal intentionally stops at generic coordination primitives.

Applications such as Waldemort should still own:

- domain fact schemas
- domain artifact requirements
- domain validation rules
- agent-specific skills
- safety policies around secrets, destructive operations, and environment scope

PilotSwarm should provide the rails so those policies are not enforced only by
prompt discipline.