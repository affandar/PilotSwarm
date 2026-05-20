# Proposal: Base Infrastructure Improvements — May 2026

> **Status:** Proposal
> **Date:** 2026-05-16
> **Goal:** Make PilotSwarm coordination, system-agent scheduling, cross-session communication, live summaries, and grouped session management explicit, inspectable, and mechanically verifiable.

---

## Improvement Categories

This proposal groups the May 2026 base-infrastructure work into six categories:

| Category | Outcome |
|---|---|
| Child contracts and results | Parent/child delegation has typed contracts, structured results, and validation. |
| Deferred child-wait optimization | Event-driven parent waits move to a later phase; current work keeps existing `wait_for_agents` behavior. |
| Session groups | Operators can create CMS-backed groups and apply session-list operations in bulk. |
| System-agent scheduling | Root and resource-manager polling stop; facts/sweeper become low-frequency and facts-manager becomes reactive. |
| Cross-session coordination | All PilotSwarm sessions can discover and message other sessions through a runtime-managed request/response path. |
| Live session summaries | Every session keeps a short, structured summary fresh for UX, diagnostics, and session discovery. |

---

## Summary

PilotSwarm has the core durable-session foundation in place, but several base
coordination patterns are still too prompt-driven or polling-heavy. Parent/child
contracts are mostly prose, system agents wake up more often than they need to,
sessions cannot ask peer sessions for help through a first-class channel, and
operators often have to open a transcript to answer "what is this session doing
right now?"

This becomes especially visible in larger session fleets: one parent can spawn
many descendants, multiple long-running sessions may be watching related work,
and important observations may live in transcripts instead of a shared summary
or curated fact pipeline.

This proposal adds base PilotSwarm primitives for:

- typed child-session contracts
- explicit completion results
- contract validation
- artifact and fact output tracking
- structured parent-facing child summaries
- first-class session groups for bulk UX and lifecycle operations
- reactive facts-manager intake processing
- cross-session discovery and request/response messaging
- short live session summaries maintained by each LLM
- UX surfaces that show current state without asking the agent again

Application-specific policy, such as which domain facts or markdown reports are
required, should remain in the application plugin. PilotSwarm should provide the
generic coordination layer.

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
- Parent sessions that only want to wait for children still wake periodically to
  poll child state.
- Related top-level sessions cannot be created, viewed, pinned, collapsed, or
  terminated as one first-class group.
- Root and resource-manager system sessions wake on a fixed cadence even when
  there is no actionable work.
- Facts-manager intake is discovered by polling instead of being pushed through
  a reactive queue.
- Sessions that could help each other cannot communicate through a sanctioned,
  durable request/response path.
- Operators repeatedly ask long-running sessions for "the latest" because the
  latest state is not maintained as a compact summary.

---

## Design Goals

1. A parent can state exactly what it expects a child to produce.
2. A child can complete with a structured result, not just a final message.
3. The runtime can validate expected outputs before declaring completion.
4. A cancelled or timed-out child can still publish a partial result.
5. Parent sessions, runtime code, SDK internals, Portal, and TUI can all use the
  same child-result model without exposing parent/child contracts as a
  standalone operator query surface.
6. Existing uncontracted sessions remain supported.
7. Event-driven parent waits are desirable, but deferred to a later phase.
8. Operators can create session groups and apply top-level session-list
   operations to every session in the group.
9. Root and resource-manager system sessions should not use recurring polling
   loops.
10. Facts-manager and sweeper should use low-frequency maintenance cadences, with
    facts-manager also waking reactively on intake.
11. All sessions should be able to discover and message other PilotSwarm
    sessions, including children and grandchildren.
12. Every session should maintain a short summary state that the UX can show
    without prompting the session.

## Non-Goals

- Do not encode application-specific fact schemas in the base runtime.
- Do not require every quick exploratory child to have a strict contract.
- Do not make markdown artifacts mandatory globally.
- Do not remove existing final assistant messages or transcript views.
- Do not add external protocol surfaces as part of this work.
- Do not overload parent/child session lineage to mean session group membership.
- Do not make cross-session messaging bypass user-visible audit trails.
- Do not require application-specific summary schemas in the base framework.
- Do not expose child contract/result records through dedicated management API
  endpoints in the first implementation. They are internal coordination
  substrate; user-facing UX should summarize their health without requiring
  operators to query raw contracts.
- Do not implement fan-out/fan-in helpers in this proposal. Batch delegation can
  be reconsidered after the contract/result substrate is stable.
- Do not implement the bounded polling primitive in this proposal. It remains a
  separate follow-up once the base coordination model has settled.

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
- Keep `session.summary_state` fresh with a short current-state summary, open
  questions, blocker/completion/cancellation state, and domain-specific status.
- Before churning for too long or declaring blocked, look for related sessions
  and ask for help or context through the cross-session request/response path.
- When another session shares key reusable information, encourage it to submit
  an intake observation to facts-manager rather than leaving the detail only in
  chat.
- Treat root and resource-manager recurring polling as retired; use reactive
  wake-ups or operator prompts instead.
- Treat facts-manager as reactive to intake events plus low-frequency
  maintenance, not a tight polling loop.

This should be a small shared instruction pattern, not a long domain runbook.
Application plugins can extend it with domain-specific requirements.

### Skills

Base PilotSwarm can include a generic coordination skill, for example:

- how to use child-session contracts
- how to complete with a structured result
- how to write partial results on cancel or timeout

Domain-specific skills, such as benchmark procedures or environment-specific
validation rules, should remain in the application plugin.

### Tools

Existing control tools should grow contract/result-aware variants or optional
parameters:

- `spawn_agent(task, agentId?, contract?)`
- `message_agent(sessionId, message, contractPatch?)`
- `complete_agent(sessionId, result?)`
- `cancel_agent(sessionId, reason, partialResult?)`
- `wait_for_agents(sessionIds, options?)`
- `check_agents(sessionIds?)`
- `list_sessions(filters?)` available to all sessions
- `send_session_message(sessionId, request, options?)`
- `reply_session_message(requestId, response)`
- `update_session_summary(summaryState)`

Tool results should return the child contract status and last structured result
when available.

The model should not need to scrape child final messages to understand whether a
contract was satisfied.

### Base Orchestration / SDK Code

This is the primary implementation home. The SDK/runtime should provide:

- persisted contract records
- persisted completion result records
- persisted state for contract registration, output publication, validation,
  completion, cancellation, timeout, and violation
- validation hooks for facts/artifacts where stores are configured
- a typed result API used by the runtime, tool handlers, Portal/TUI view models,
  and application code
- reactive queue routing for facts-manager intake
- cross-session request/response queues and KV state
- summary-state persistence and UX read APIs

---

## Data Model

### Child Session Contract

Proposed TypeScript shape:

```ts
export interface ChildSessionContract {
  contractId?: string;
  parentSessionId: string;
  childSessionId: string;
  validationMode?: "advisory" | "strict";
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

Strict validation is contract-scoped. The effective validation mode is resolved
in this order: explicit `contract.validationMode`, agent default, plugin/app
default, then runtime default `advisory`. Phase 1 should default every contract
to advisory unless the contract explicitly opts into strict mode.

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
  contractRevision?: number;
  verdict: ChildSessionVerdict;
  summary: string;
  factsWritten?: OutputReference[];
  artifactsWritten?: OutputReference[];
  blockers?: string[];
  nextActions?: string[];
  contractViolations?: ContractViolation[];
  completedAt: string;
  finalAssistantMessageSeq?: number;
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
    | "completed_without_result";
  message: string;
  expected?: unknown;
  observed?: unknown;
}
```

Output references are explicitly declared by the child in the structured result.
The base runtime should not infer canonical fact/artifact publication from tool
calls in Phase 1. If agents later prove unreliable about declared outputs,
additional validation can compare declarations against fact/artifact stores and
tool traces.

`ChildSessionResult` intentionally has no `reasoningSummary`. The result should
contain outcome summary, evidence references, blockers, next actions, and
metadata, not hidden chain-of-thought style rationale.

### Child Outcome Record

`session_child_outcomes` is one row per child session. It is the current
coordination outcome for that child, with revision history stored inside JSON
fields. If the parent sends the child back for follow-up work, the runtime should
append a new contract revision to the same row rather than inserting another row
for the same `child_session_id`.

```ts
export interface SessionChildOutcomeRecord {
  childSessionId: string;
  parentSessionId: string;
  contractJson?: {
    current: ChildSessionContract;
    revisions: ChildContractRevision[];
  };
  resultJson?: {
    current?: ChildSessionResult;
    revisions: ChildResultRevision[];
  };
  verdict?: ChildSessionVerdict;
  summary?: string;
  completedAt?: string;
}

export interface ChildContractRevision {
  revision: number;
  updatedAt: string;
  updatedBySessionId: string;
  reason?: string;
  contract: ChildSessionContract;
}

export interface ChildResultRevision {
  revision: number;
  submittedAt: string;
  submittedBySessionId: string;
  result: ChildSessionResult;
}
```

CMS is the source of truth for the structured contract and result. Existing tool
input/output traces preserve the original payload for audit. Orchestration
history should keep only deterministic references needed to continue, such as
`childSessionId`, `contractId`, current revision, and optionally a compact
contract hash/version. Validation reads the CMS outcome state through activities
or tool handlers; orchestration generator logic should not branch on mutable
contract JSON.

Implementation details:

- Tools: extend existing in-session control tools only: `spawn_agent` accepts an
  optional `contract`, `message_agent` accepts an optional `contractPatch`,
  `complete_agent` / `done` accept an optional structured `result`,
  `cancel_agent` accepts an optional `partialResult`, and `wait_for_agents`
  returns result/violation summaries where available.
- Base instructions/skills: add child-contract guidance to the default agent
  prompt and a small base coordination skill in the same changelist as the tool
  implementation. Do not pre-tune management agents before the substrate exists.
  When the substrate lands, update agent-tuner guidance so it understands
  parent/child contracts and outcomes as internal coordination records surfaced
  through tool traces and UI summaries, not as public management APIs.
- Base infra: persist current contract/result state and revision history in the
  single `session_child_outcomes` row for the child from activity/tool handlers.
  The orchestration should not add a new public command path solely for
  contracts; it should pass contract/result payloads through the existing spawn,
  complete, cancel, message, and wait paths. Parent follow-up work appends a new
  contract revision on the same child outcome row.
- Events: rely on existing tool input/output tracing for auditability. Do not add
  per-contract CMS events such as `session.contract_registered` or
  `session.contract_validated` unless a later UX requirement proves table state
  and tool traces are insufficient.
- Tests: add local sub-agent tests for contracted spawn, structured completion,
  cancellation with partial result, missing required output in advisory mode,
  strict-mode refusal or violation behavior, parent follow-up that appends a new
  contract revision on the same outcome row, and legacy uncontracted children.
- Backward compatibility: Phase 1 preserves old tool signatures and synthesizes
  legacy display results from final assistant messages when no structured result
  exists. Phase 2 can require structured results for newly-created contracted
  sessions and stop synthesizing results for sessions created after that cutoff.

### Session Summary State

Every session should maintain one stable summary shape that can be rendered
without asking the agent for a fresh update. The structure should not drift from
turn to turn: users will experience cognitive dissonance if the same session's
"latest state" keeps changing format.

```ts
export interface SessionSummaryState {
  schemaVersion: 1;
  updatedAt: string;
  intent: string;
  summary: string;
  state: {
    cmsState: string;
    runtimeMode?: string;
    waitReason?: string;
    blocked?: boolean;
    terminal?: boolean;
  };
  openQuestions: Array<{
    question: string;
    askedAt?: string;
    blocking?: boolean;
  }>;
  blockers: string[];
  nextActions: string[];
  domain?: Record<string, unknown>;
  links: Array<{
    title: string;
    url: string;
  }>;
  structureChangeLog: Array<{
    changedAt: string;
    reason: string;
    before: string;
    after: string;
  }>;
}
```

The type name intentionally does not include `V1`; the `schemaVersion` field is
the version marker. `intent` is the model's current understanding of what the
session is trying to accomplish, summarized in a few lines. `summary` is the
latest progress/state toward that intent. Base guidance should keep this short:
a few sentence summary, open questions/blockers, key hyperlinks, and domain data
that is free form JSON. Agents should be encouraged to use compact Markdown
tables inside `summary` or a domain-specific string field when a table makes the
state easier to scan, but the base runtime should not impose a table schema on
applications. Applications can fill in `domain` with their own stable shape. If
an agent changes its summary structure in a way users would notice, it should
add a clear `structureChangeLog` entry explaining what changed and why.

Implementation details:

- Tools: add `update_session_summary(summaryState)` for in-session updates and
  include `short_summary` / `summary_updated_at` in `list_sessions` results.
- Base instructions/skills: update the default agent guidance and any base
  coordination skill in the same implementation changelist, asking agents to
  write a summary on first run when none exists, then update it only when there
  is real update or progress toward the session intent. The agent-tuner guidance
  should understand stale/missing summaries as a prompt or product-quality issue,
  not automatically as an orchestration stall.
- Base infra: add a CMS stored procedure to update `short_summary`,
  `summary_state`, and `summary_updated_at`; call it from the tool handler.
- Tests: add a local management/SDK test that updates a summary, lists sessions,
  and verifies old sessions with `summary_state = null` still render through the
  transcript/latest-response fallback.
- Backward compatibility: Phase 1 keeps summaries nullable and warning-only.
  Phase 2 can make summary refresh mandatory for first-run summaries and
  material progress/intent changes in sessions created after the cutover, while
  retaining historical fallback rendering for older sessions.

### Cross-Session Message

Sessions should be able to send durable requests to any other PilotSwarm session,
including children, grandchildren, sibling trees, and unrelated top-level
sessions.

```ts
export interface SessionMessageRequest {
  requestId: string;
  fromSessionId: string;
  toSessionId: string;
  subject: string;
  body: string;
  reason?: "help" | "guidance" | "fact-request" | "status-request" | "handoff";
  expectsResponse?: boolean;
  expiresAt?: string;
  createdAt: string;
}

export interface SessionMessageResponse {
  requestId: string;
  fromSessionId: string;
  toSessionId: string;
  verdict: "answered" | "declined" | "blocked" | "stale";
  body: string;
  factsSuggested?: OutputReference[];
  createdAt: string;
}
```

This should be a runtime-managed request/response channel, not direct transcript
mutation. Messages must be visible through queue/KV records so operators can
audit why sessions influenced each other without writing a CMS event for every
request.

### Concrete Additive CMS Schema

Use one migration with only nullable columns and additive tables. Existing rows
remain valid and require no backfill beyond optional summary defaults in the UI.
SQL below uses the default `copilot_sessions` schema; the actual migration must
substitute the configured CMS schema the same way existing CMS migrations do.

```sql
ALTER TABLE copilot_sessions.sessions
  ADD COLUMN IF NOT EXISTS group_id TEXT,
  ADD COLUMN IF NOT EXISTS short_summary TEXT,
  ADD COLUMN IF NOT EXISTS summary_state JSONB,
  ADD COLUMN IF NOT EXISTS summary_updated_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_copilot_sessions_sessions_group_id
  ON copilot_sessions.sessions(group_id)
  WHERE deleted_at IS NULL AND group_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS copilot_sessions.session_groups (
  group_id     TEXT PRIMARY KEY,
  title        TEXT NOT NULL,
  description  TEXT,
  owner        JSONB,
  metadata     JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS copilot_sessions.session_child_outcomes (
  child_session_id  TEXT PRIMARY KEY,
  parent_session_id TEXT NOT NULL,
  contract_json     JSONB,
  result_json       JSONB,
  verdict           TEXT,
  summary           TEXT,
  completed_at      TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_copilot_sessions_child_outcomes_parent
  ON copilot_sessions.session_child_outcomes(parent_session_id);
```

Notes:

- `sessions.group_id` points at `session_groups.group_id` by convention. Do not
  add a hard foreign key in the first migration; older deployments and partial
  restores should not fail because a group row is missing.
- Do not add `is_group`, `closed_at`, or `group_metadata` to `sessions`. Groups
  live in `session_groups`; sessions only need `group_id`.
- Do not add `closed_at` or other lifecycle fields to `session_groups` in this
  proposal. A group is a visual container, not an entity with runtime lifecycle.
- Do not add separate contract and result tables. `session_child_outcomes`
  covers optional contracts and optional terminal/partial results in one place,
  with current contract/result plus revision history stored in JSON fields.
- Do not add a CMS `session_messages` table in the first pass. Cross-session
  requests and responses should use durable event queues plus KV records; add a
  CMS table later only if operator audit/search needs cannot be met from KV and
  existing session history.
- Existing sessions have `group_id = null`, `summary_state = null`, and no
  `session_child_outcomes` row. All existing reads and UI flows must continue to
  work.

---

## Runtime Events

CMS events are expensive. Phase 1 should add no high-frequency CMS events.

Use table writes, Duroxide queues, and KV state for the new machinery:

- child contracts/results: `session_child_outcomes`
- groups: `session_groups` plus `sessions.group_id`
- summaries: `sessions.short_summary`, `sessions.summary_state`, and
  `sessions.summary_updated_at`
- facts-manager intake: facts-manager event queue, not CMS `session_events`
- cross-session messages: request/response queues and KV, not CMS
  `session_events`

Only add a new CMS event if a user-visible timeline milestone has no table or KV
state to query. The initial proposal adds zero new CMS event types.

Implementation details:

- Tool input/output traces remain the canonical audit trail for contract-bearing
  `spawn_agent`, `complete_agent`, `cancel_agent`, and `wait_for_agents` calls.
- Durable queues, not CMS events, carry facts-manager intake and cross-session
  request/response wake-ups.
- Tests should assert that contracted child workflows do not create new CMS event
  types beyond existing tool traces, while facts intake and cross-session
  messaging create their expected queue/KV records.
- Phase 2 cleanup can revisit CMS event additions only if operators need
  timeline/search behavior that cannot be served from tables, KV records, or
  existing tool traces.

---

## Tool Semantics

### `spawn_agent`

`spawn_agent` should accept an optional contract:

```json
{
  "agentId": "perf-test-runner",
  "task": "Run a benchmark smoke test for the checkout API canary.",
  "contract": {
    "purpose": "Collect canary benchmark smoke metrics",
    "expectedFacts": [
      { "key": "result/benchmark-smoke/checkout-api-canary", "scope": "shared" }
    ],
    "expectedArtifacts": [
      { "path": "reports/checkout-api-canary-benchmark.md" }
    ],
    "successCriteria": ["benchmark completed", "result fact written"],
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
  "reason": "Provisioning operation remained pending after 30 minutes",
  "partialResult": {
    "verdict": "timed_out",
    "summary": "The requested resource change was accepted but did not converge before the deadline.",
    "factsWritten": [
      { "kind": "fact", "key": "result/provisioning/checkout-api-canary-20260516" }
    ],
    "blockers": ["Provisioning operation did not converge before timeout"]
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

`wait_for_agents` already exists as the parent-facing "wait on sub-agents" tool.
The proposal should extend that tool rather than add a parallel one.

Implementation details:

- Tool schemas must preserve the current arguments and add optional structured
  fields only. Tool results should include compact outcome summaries, not raw
  CMS rows.
- Base instructions/skills should be updated only when these schema changes land
  so agents learn to provide structured results without seeing unavailable
  fields during earlier deployments.
- Orchestration/activity changes should reuse the existing spawn, complete,
  cancel, and wait activities. The new work is payload persistence and
  validation, not a separate child-contract orchestration branch.
- Tests should include schema backward compatibility, stub/handler parity for
  tool definitions, revisioned `message_agent(..., contractPatch)` behavior, and
  regression coverage for legacy calls without contract or result fields.
- Phase 2 cleanup can remove prompt fallbacks that tell agents to scrape child
  final messages once structured results are reliably present for new sessions.

---

## Deferred Work

Event-driven parent waits, fan-out/fan-in helpers, and bounded polling are
explicitly deferred from this proposal. Their detailed goals, tool ideas,
runtime notes, tests, and compatibility plans live in
[base-infra-deferred-items-may-26.md](./base-infra-deferred-items-may-26.md).

This proposal should not add deferred-work schema, events, tools, prompt
guidance, UI, or tests unless the active scope is deliberately reopened.

---

## Session Groups

### Goal

A session group is a first-class CMS entity for managing related top-level
sessions in bulk. Operators should be able to create a group, create sessions
inside it, expand or collapse it in the session tree, pin or unpin it, and apply
the same lifecycle operations available from the top-level session list.

Groups are not agent sessions. They do not have a running orchestration, a model,
or a transcript.

### Recommended CMS shape

Add a dedicated `session_groups` table and one nullable `sessions.group_id`
column. Groups are not fake sessions, and session rows do not need an `is_group`
flag.

Rules:

- `session_groups` rows have no orchestration and no transcript.
- `sessions.group_id` points by convention to `session_groups.group_id`.
- `parent_session_id` keeps its current meaning: agent parent/child lineage.
- Top-level sessions can belong to a group through `group_id`.
- Child sessions should inherit their nearest top-level ancestor's `group_id`
  for filtering, aggregate stats, and bulk operations, while still rendering
  under their actual `parent_session_id`.

This avoids turning groups into fake parents. A group is a UX and management
container; parent/child remains the execution tree.

If we want multi-group membership later, add a
`session_group_memberships(group_id, session_id)` table. For now, one group per
session is simpler and keeps session-list reads cheap.

### Group container semantics

Groups are visual containers with convenience batch operations. They are not
agent sessions, do not have a lifecycle state, and should not add `closed`,
`archived`, `group_waiting`, or similar values to the public session-status
union.

Creating a session can assign it to a group with `groupId`. Moving an existing
session into or out of a group is intentionally out of scope for the first pass.
If it is needed later, add it as a separate operation after creation-time group
assignment is stable.

Group batch operations apply to member sessions and descendants, excluding
system sessions where appropriate. Deleting a group is destructive: it batch
deletes the underlying sessions first, waits until those sessions have been
deleted from CMS, and only then deletes the `session_groups` row. There is no
"delete only the group row" mode in this proposal.

The group row should expose aggregate fields in management views:

```ts
interface SessionGroupSummary {
  groupId: string;
  memberCount: number;
  runningCount: number;
  waitingCount: number;
  completedCount: number;
  failedCount: number;
  cancelledCount: number;
  latestActivityAt?: string;
  latestSummaryUpdatedAt?: string;
}
```

### SDK and management operations

Add management APIs:

- `createSessionGroup({ title, owner?, metadata? })`
- `updateSessionGroup(groupId, { title?, description?, metadataPatch? })`
- `listSessionGroups()`
- `listGroupSessions(groupId)`
- `completeSessionGroup(groupId, options?)`
- `cancelSessionGroup(groupId, reason?)`
- `deleteSessionGroup(groupId)`

Creating a session should accept `groupId`. Child session creation should inherit
the group automatically; callers should not need to pass it on every spawn.

### Portal and TUI behavior

The session tree should render groups as top-level session-list items, using the
same top-level list as ordinary sessions. All group rows sort before all
non-grouped top-level sessions. Ungrouped sessions remain visible after the
groups.

Within a group, top-level member sessions sort by latest `summary_updated_at`
descending; child rows still render under their real parents, with sibling order
using the same summary timestamp rule where applicable. Session groups also sort
by the latest `summary_updated_at` among their member sessions. For backward
compatibility, if a session or group has no summary timestamp, keep the existing
sort behavior for that row until summaries exist.

Use a distinct compact group icon/badge, separate from the system-agent marker.
The shared UI renders groups with the `🗂` grouped files/tabs marker.

```text
🗂 Release validation
  Session A
    child A1
  Session B
    child B1
Session C
```

UX expectations:

- Expand/collapse group independently of session parent/child collapse.
- Pin/unpin groups; pinned groups sort above unpinned groups, and all groups
  still sort before non-grouped top-level sessions.
- A group container does not count against the session tree max-depth-of-3 rule.
  A tree such as `group -> parent -> subparent -> child` is valid because the
  depth budget starts at the first real session under the group.
- Multi-select inside a group works the same as top-level multi-select.
- Terminate/complete/cancel group prompts once, then applies to all non-system
  member sessions and their descendants.
- Delete group prompts once, batch deletes all underlying member sessions and
  descendants, verifies those sessions are deleted from CMS, and then deletes
  the group row. If any member cannot be deleted, the group row remains and the
  operation reports the blocked member.
- Group rows should not open a chat transcript. Selecting one opens a group
  details view with members, aggregate status, stats, and bulk actions.

### Future extension

Many-to-many group membership remains a later extension. The first pass uses
`sessions.group_id` plus `session_groups` only.

Implementation details:

- Tools/APIs: add management operations for group CRUD and batch helpers:
  `createSessionGroup`, `updateSessionGroup`, `listSessionGroups`,
  `listGroupSessions`, `completeSessionGroup`, `cancelSessionGroup`, and
  `deleteSessionGroup`. Session creation accepts an optional `groupId`; do not
  add a move-session-to-group API in the first pass.
- Base instructions/skills: no agent prompt changes are needed for basic group
  UX. The agent-tuner lifecycle skill should be updated in the implementation
  changelist so it recognizes group rows as visual containers with no
  orchestration or transcript, and so it reasons about group sorting by summary
  timestamps.
- Base infra: add CMS stored procedures for group CRUD, group creation-time
  membership, batch complete/cancel/delete helpers, and aggregate group
  summaries. Child session creation inherits the nearest top-level ancestor
  `group_id` in the session-manager/session-proxy path.
- Portal/TUI: add group rows to shared session-tree selectors, with group-first
  sorting, summary-timestamp sorting, selected-row visual stability during
  resort, and depth counting that ignores the group container.
- Tests: add CMS/management tests for create/list/update/delete, child
  inheritance, group-first sorting in selectors, group/member sorting by latest
  summary timestamp with fallback to current sorting when timestamps are null,
  selected-session stability during a 30-second resort, bulk cancel/complete
  excluding system sessions, delete-group success that deletes member sessions
  before deleting the group row, delete-group partial failure that keeps the
  group row until all member sessions are gone, and repeated delete calls that
  are idempotent after member deletion has already started.
- Backward compatibility: Phase 1 leaves `group_id` nullable and avoids hard
  foreign keys. Phase 2 can add stronger validation for missing groups once
  restore and migration behavior is proven.

---

## System-Agent Scheduling And Reactivity

### Polling policy

The root PilotSwarm session and resource-manager session should stop using
recurring polling loops. They should wake from direct operator prompts or
implementation-defined reactive runtime stimuli, and otherwise remain dormant.
Management surfaces should not send ordinary cross-session messages to stimulate
these system agents. This proposal does not define concrete root/resource-manager
event names; keep that payload taxonomy in the implementation changelist where
the wake path is built.

Facts-manager and sweeper still need background maintenance, but their recurring
cadence should move to once every 6 hours:

- `facts-manager`: `cron(seconds=21600, reason="facts-manager maintenance")`
- `sweeper`: `cron(seconds=21600, reason="scan for stale sessions and prune orchestration history")`

The 6-hour facts-manager cron is only a safety/maintenance pass. Normal intake
processing should be reactive.

### Reactive facts-manager intake

All intake writes must flow through facts-manager's event queue. The fact storage
tool should enqueue a facts-manager event whenever a shared `intake/*` fact is
written or updated.

Proposed flow:

1. Any session calls `store_fact` for a shared `intake/*` key.
2. The fact store commits the fact.
3. The tool/runtime enqueues a facts-manager event, for example:

   ```json
   {
     "type": "facts.intake_written",
     "key": "intake/build/linux-linker/session-1234",
     "sourceSessionId": "session-1234",
     "factVersion": 7
   }
   ```

4. Facts-manager wakes, reads only the referenced intake or a bounded batch, and
   processes it.
5. Facts-manager updates its queue/KV intake cursor and returns to a
   dormant/reactive state.

This removes the need for tight polling while keeping the knowledge pipeline
responsive.

Implementation details:

- Tools: extend `store_fact` so only a successful `shared=true` write whose key
  starts with `intake/` enqueues a facts-manager intake message after the fact is
  committed. Session-scoped `intake/*`, shared non-`intake/*`, and
  facts-manager writes to `skills/`, `asks/`, or `config/facts-manager/` do not
  enqueue. Add a facts-manager internal read/process tool only if the existing
  `read_facts` surface cannot process bounded intake batches safely.
- Base instructions/skills: update root PilotSwarm, Resource Manager, Facts
  Manager, Sweeper, and their skills in the same changelist as the runtime
  change. Do not land prompt changes ahead of the new wake paths.
- Base infra: add a durable facts-manager intake queue and cursor/KV records for
  queued and processed intake. Root and Resource Manager should rely on direct
  operator prompts or an implementation-defined reactive wake path instead of
  self-refresh cron.
- Tests: add local tests that shared `intake/*` writes enqueue exactly one intake
  message, non-intake or non-shared facts do not, facts-manager can drain a
  bounded batch, and configured maintenance cron is 6 hours for Facts Manager
  and Sweeper.
- Backward compatibility: Phase 1 keeps the old cron path available but changes
  default prompts/config to low-frequency/reactive behavior. Phase 2 can remove
  obsolete short-interval config defaults and stale prompt text after live
  deployments have moved off the old loops.

### Agent guidance

Base prompts should encourage agents to write intake facts when they discover
reusable operational knowledge, but also to ask peer sessions with relevant
context to write their own observations. Facts-manager should curate evidence
that has an attributable source session rather than accepting opaque summaries
from unrelated agents.

---

## Cross-Session Discovery And Messaging

All sessions in PilotSwarm should be able to discover and exchange messages with
all other sessions in the same PilotSwarm deployment, including children and
grandchildren. This is broader than `message_agent`, which is parent-local and
sub-agent-oriented.

### Discovery

`list_sessions` should be available to all sessions. To make discovery useful,
each session should expose:

- title
- agent id
- owner metadata, where visible
- lifecycle state
- parent session id
- group id
- short summary
- summary updated timestamp

The `short_summary` column should be updated by the LLM as part of
`update_session_summary`. This lets agents find "similar looking" or relevant
sessions without scraping transcripts.

Initial `list_sessions(filters?)` filters:

- `query`: text search over title, agent id, short summary, summary intent, and
  visible owner metadata.
- `sessionId`: exact session lookup.
- `agentId`: exact named-agent id.
- `state`: one or more lifecycle states.
- `parentSessionId`: direct children of a parent.
- `rootSessionId`: sessions in a spawn tree.
- `groupId`: sessions assigned to a group; `null` means ungrouped sessions.
- `ownerQuery` and `ownerKind`: same owner filtering semantics as management
  session lookup, where visible to the requesting session.
- `includeSystem`: include system sessions when true; default false for ordinary
  sessions unless policy allows them.
- `includeChildren`: include child sessions in addition to top-level sessions.
- `updatedSince`: sessions with recent activity or summary updates.
- `summaryUpdatedSince`: sessions with recent summary updates.
- `limit` and `cursor`: pagination.

The result should include safe discovery fields only, not transcripts, raw tool
arguments, private facts, or raw child contract records.

### Request/response path

Cross-session communication should use a separate event queue plus KV-backed
request/response state:

- request queue: `session_messages`
- response queue: `session_message_responses`
- KV request key: `session_message/request/<requestId>`
- KV response key: `session_message/response/<requestId>`

The sender should receive an acknowledgement when the request is queued. If
`expectsResponse = true`, the sender can wait on a response with a TTL. The
recipient sees the request as a system-context item, not as an unaudited user
message.

Because Duroxide KV writes happen in orchestration code, `send_session_message`
should not write request KV directly from the tool handler. The tool handler
should validate the static payload shape and return a queued orchestration
action. The sender's orchestration then performs the deterministic rate-limit
reservation, writes sender-owned request KV, and enqueues the recipient wake. The
recipient's orchestration processes the request from its queue and may reply;
the reply wakes the sender orchestration, which writes sender-owned response KV
and clears any outstanding-response reservation.

Phase 1 rate limits:

- no broadcast API; every message names one `toSessionId`,
- max 10 cross-session messages per sender per rolling 10 minutes,
- max 3 messages from the same sender to the same target per rolling 10 minutes,
- max 5 outstanding requests expecting a response per sender,
- request body size capped at about 8 KB,
- sender-facing `rate_limited` responses include retry-after metadata.

The rate-limit counters should live in the sender orchestration's KV state, so
all sends from one sender are serialized by that sender's orchestration. Use
`ctx.utcNow()` for deterministic bucket timestamps; do not use wall-clock time in
the generator. System agents can receive higher configured caps, but there
should be no unlimited default.

Phase 1 allows cross-session discovery and messaging across the fleet. Owner,
group, agent-policy, and other scope constraints are intentionally deferred; see
[base-infra-deferred-items-may-26.md](./base-infra-deferred-items-may-26.md).

### Agent guidance

Agents should be encouraged to:

- search for similar sessions when they have churned for too long,
- ask a relevant session for help or current context before declaring blocked,
- share concise guidance rather than entire transcripts,
- point sessions with reusable information toward facts-manager intake,
- include links to relevant artifacts, facts, or docs when replying.

Cross-session messaging should be auditable and rate-limited. A session should
not broadcast broadly unless explicitly asked by the operator or a system policy.

Implementation details:

- Tools: add `list_sessions(filters?)` to ordinary sessions with safe fields,
  plus `send_session_message(sessionId, request, options?)` and
  `reply_session_message(requestId, response)`. Keep `message_agent` for
  parent-local child control.
- Base instructions/skills: update the base coordination guidance so agents ask
  relevant peer sessions for help after meaningful churn, avoid broad
  broadcasts, and encourage source sessions to write reusable facts themselves.
  Update agent-tuner guidance in the implementation changelist so it treats
  cross-session messages as auditable coordination records, not user prompts,
  and checks request IDs when diagnosing peer influence.
- Base infra: add sender-owned request/response KV records, sender-owned
  rate-limit KV counters, and recipient queues. Route recipient requests as
  system-context items. Enforce rate limits inside the sender orchestration when
  processing the queued send action, before enqueueing the recipient wake. Do not
  add owner/group policy constraints in Phase 1.
- Tests: cover list visibility, request enqueue/ack, recipient wake-up,
  response delivery, response TTL expiry, sender-orchestration rate limiting,
  no KV writes from the tool handler/activity path, and auditability via KV
  records without CMS event spam.
- Backward compatibility: Phase 1 keeps cross-session messaging additive and
  leaves `message_agent` unchanged. Phase 2 can route parent/child messaging
  through the same substrate internally if it reduces duplicated code.

---

## Live Session Summary State

Every session should keep a summary state fresh. This solves the common
long-running-agent problem where operators repeatedly ask "what's the latest?"
even though the answer should already be available.

### Summary content

The base framework should ask agents to keep summaries structured, tabular, and
short. Preferred shape:

1. A few-sentence current summary.
2. Domain state in a compact free-form shape. Agents should use Markdown tables
  where they make the state easier to scan.
3. Any open questions or blockers.
4. Key hyperlinks to docs, artifacts, dashboards, issues, or facts.

At minimum, the summary tab should show:

- the session intent as the LLM currently understands it,
- current runtime state, including cron waiting, child-waiting, sleeping, or
  input-required state,
- unanswered questions the session has asked,
- terminal or exceptional state: blocked, completed, cancelled, or failed,
- domain-specific summary, such as current release-train status for a release
  watcher.

### Refresh policy

The LLM should refresh `summary_state` only when one of these is true:

- this is the first run and the session has no summary yet,
- there is a meaningful update or progress toward the current session intent,
- the session intent itself changed,
- an open question, blocker, next action, or key link changed,
- the session is reporting completion, cancellation, blocked state, or another
  terminal/exceptional state that changes the user's understanding of progress.

The LLM should not rewrite `summary_state` merely because a turn happened, a
timer fired, a cron sleep is about to begin, or a cross-session request was
processed with no material progress.

The runtime should not enforce summary freshness. If a summary is stale, the UX
should still show the stale timestamp clearly; users or operators can ask the
session to update it.

### UX

The chat pane should have a Summary tab. It should not become the default view
globally. Instead, the TUI and portal should persist the user's selected chat
view in user profile settings and restore that choice across sessions/devices
where the profile is available. The transcript remains available as the detailed
history tab.

The Summary tab should render:

- status chip and wait reason,
- current intent,
- short summary,
- domain summary,
- open questions,
- blockers and next actions,
- key links,
- last updated timestamp.

This should also feed session list tooltips and session-picker search, so agents
and operators can find relevant sessions by what they are currently doing.

Implementation details:

- Tools: add `update_session_summary(summaryState)` as the write path and expose
  `short_summary` in session discovery. Do not require agents to write directly
  to CMS.
- Base instructions/skills: update default instructions and base coordination
  skills when the tool exists, asking agents to refresh summaries only on first
  run or real progress/intent changes. Update agent-tuner guidance in the same
  changelist so stale summaries are interpreted as user-visible stale state, not
  orchestration stalls or enforcement failures.
- Base infra: validate only the base envelope (`schemaVersion`, timestamps,
  intent, summary, lifecycle fields, arrays, links). Leave `domain` free form
  and application-owned.
- Tests: cover summary write/list/read flows, malformed envelope rejection,
  intent preservation, free-form domain payload preservation, stale timestamp
  rendering, and "no-op turn does not require summary rewrite" behavior.
- Backward compatibility: Phase 1 renders transcript/latest-response fallback
  for missing summaries. There is no stale-summary refusal path in this
  proposal.

---

## Portal And TUI Experience

Portal and TUI should render contract health in session trees:

- expected facts/artifacts
- produced facts/artifacts
- result verdict
- contract violations
- blocked children
- cancelled children with or without partial results
- group aggregate status and batch-operation state
- short session summary and last summary refresh timestamp
- cross-session message requests and responses
- facts-manager reactive intake status

The parent timeline should include a compact child result card when a child
finishes. Operators should not need to open every child transcript for basic
status. The Summary tab should be available, but the selected chat view should
come from the user's saved profile preference rather than automatically changing
for long-running sessions.

The session list may resort periodically, for example every 30 seconds, as
summary timestamps change. Resorting must not move the currently selected
session's content, active chat view, scroll position, or visual vertical anchor.
Rows and groups around the selected session may reorder, but the selected row
should remain visually stable.

Implementation details:

- Tools/APIs: use existing session list/detail reads plus the new group,
  summary, and cross-session message APIs. Do not add standalone management
  endpoints for raw child contracts.
- Base instructions/skills: UI-facing prompt updates should land with the tool
  and data implementation, especially summary refresh guidance and peer-message
  etiquette.
- Base infra: extend shared UI selectors so native TUI and portal consume the
  same group sorting, summary fallback, selected-row anchor behavior, saved-view
  preference, and child-result badge model.
- Tests: add selector tests for group-first ordering, summary-timestamp sorting,
  max-depth behavior, selected-row stability during resort, summary fallback,
  saved summary/transcript view preference, and result badge derivation; add
  portal/TUI smoke coverage where practical.
- Backward compatibility: Phase 1 displays child-result health only when present
  and falls back to existing transcript views. Phase 2 can simplify UI branches
  for sessions created after summaries/results become mandatory.

---

## Management API And Public Surface

The management API should expose group, summary, and cross-session coordination
operations. It should not expose dedicated parent/child contract query
endpoints; those records are an internal substrate used by tool results and UI
status summaries.

- `createSessionGroup(input)`
- `listSessionGroups(filters?)`
- `listGroupSessions(groupId)`
- `updateSessionGroup(groupId, patch)`
- `completeSessionGroup(groupId, options?)`
- `cancelSessionGroup(groupId, reason?)`
- `deleteSessionGroup(groupId)`
- `updateSessionSummary(sessionId, summaryState)`
- `listSessionMessages(sessionId, filters?)`
- `sendSessionMessage(input)`
- `replySessionMessage(requestId, response)`

These APIs should be usable by:

- Portal
- TUI
- operators
- audit/report-generation agents

Implementation details:

- Tools/APIs: keep parent/child contract details on in-session tool returns and
  internal SDK/service methods. Public management methods focus on groups,
  summaries, and cross-session messages.
- Base instructions/skills: no management-agent prompt update should land before
  these APIs exist. When they do, update the relevant management agents in the
  same changelist.
- Base infra: all new CMS reads/writes go through stored procedures. Cross-session
  message reads use KV/queue-backed APIs rather than a CMS `session_messages`
  table in Phase 1.
- Tests: add API contract tests for group CRUD, creation-time group assignment,
  group delete ordering, summary update/read, and cross-session message
  request/response. Add negative contract tests that raw child contracts are not
  exposed through public management methods and that moving an existing session
  between groups is not available in Phase 1.
- Backward compatibility: Phase 1 keeps existing management APIs stable and adds
  nullable fields. Phase 2 can remove legacy aliases or compatibility payloads
  only after downstream callers have moved to the new surfaces.

---

## Backward Compatibility

- All CMS changes are additive: nullable columns, new tables, and indexes only.
- Do not change or tighten existing `sessions.state` values, constraints, or
  required fields.
- Do not require existing sessions to have a group, summary, child outcome, or
  cross-session message state.
- Do not add hard foreign keys from `sessions.group_id` in the first migration;
  missing group rows must not break existing session reads.
- Contracts are optional.
- Existing sessions without contracts are treated as legacy sessions.
- A minimal result can be synthesized from the final assistant message for
  display purposes, but it should be marked `source: legacy_synthesized`.
- Raw child contracts/results are not exposed as dedicated public management API
  endpoints in Phase 1.
- Strict validation starts disabled by default.
- Application plugins can opt into strict validation per agent, per session, or
  per tool call.
- Existing sessions without `summary_state` remain valid and render a fallback
  transcript/latest-response view. Rows without `summary_updated_at` keep the
  existing sort behavior until summaries exist.
- Cross-session messaging is additive; `message_agent` remains supported for
  parent-local sub-agent control.
- The initial system-agent polling changes can land as prompt/config updates
  before deeper runtime reactivity is complete.

---

## Implementation Plan

### Phase 1: Data and state model

- Add `sessions.group_id`, `sessions.short_summary`,
  `sessions.summary_state`, and `sessions.summary_updated_at`.
- Add `session_groups`.
- Add `session_child_outcomes`.
- Add KV-backed storage for cross-session message requests and responses.
- Add TypeScript types in the SDK.
- Do not add new CMS event types in this phase.
- Add internal SDK reads for child outcomes and public management reads for
  groups, summaries, and cross-session messages.

### Phase 2: Child wait and tool integration

- Extend `spawn_agent`, `complete_agent`, `cancel_agent`, and `wait_for_agents`.
- Preserve old signatures.
- Return structured result payloads where available.
- Keep existing `wait_for_agents` polling behavior until the deferred
  event-driven wait phase.

### Phase 3: Validation hooks

- Validate expected artifacts against the configured artifact store.
- Validate expected facts when a fact store is configured.
- Add application hook for schema validation by `schemaRef`.
- Support advisory mode first, strict mode later.

### Phase 4: Session group management

- Add `createSessionGroup`, `completeSessionGroup`, `cancelSessionGroup`, and
  `deleteSessionGroup` management APIs.
- Make session creation accept `groupId`.
- Make child session creation inherit the nearest ancestor group.
- Add aggregate group summaries for list and detail views.

### Phase 5: System-agent scheduling and facts-manager reactivity

- Remove root PilotSwarm and resource-manager recurring cron guidance.
- Add an implementation-defined reactive wake path for root/resource-manager.
- Change facts-manager and sweeper recurring maintenance cadence to 6 hours.
- Add facts-manager intake event enqueueing from `store_fact` for shared
  `intake/*` writes.
- Teach facts-manager to process bounded intake batches from its event queue.
- Add queue-depth/cursor diagnostics for queued and processed intake without
  writing per-intake CMS events.

### Phase 6: Cross-session messaging and live summaries

- Make `list_sessions` available to all sessions with safe summary fields.
- Add cross-session request/response APIs, queues, and KV persistence.
- Add `update_session_summary` and base prompt guidance for keeping summaries
  fresh only on first run or meaningful progress/intent changes.
- Render stale summary timestamps clearly; do not enforce summary freshness.

### Phase 7: Portal/TUI/management surfaces

- Render group rows in the session tree with independent expand/collapse state.
- Support group pin/unpin and group batch session actions.
- Add the Summary tab to the chat pane and persist the user's selected chat view
  in profile settings.
- Surface cross-session message requests/responses.
- Surface facts-manager reactive intake status.
- Add result cards to session tree views.
- Add contract violation badges.
- Keep raw child contract records out of standalone public management endpoints.

### Deferred Phase: Event-driven parent waits

- Replace steady parent polling in ordinary `wait_for_agents` with child update
  wake-ups plus a high safety TTL.
- Reuse existing child update messages, durable queues, and runtime state.
- Do not add CMS events for child-wait progress.
- See [base-infra-deferred-items-may-26.md](./base-infra-deferred-items-may-26.md).

### Deferred Phase: Fan-out/fan-in helper

- Add batch spawn/join helpers only after child contracts and structured results
  have stabilized.
- Keep `spawnAgentBatch`, `spawn_agent_batch`, join policies, and join timeout
  behavior out of the current implementation phases.
- See [base-infra-deferred-items-may-26.md](./base-infra-deferred-items-may-26.md).

### Deferred Phase: Bounded polling primitive

- Add polling budgets, poll exhaustion behavior, and any associated UI only in a
  separate proposal.
- See [base-infra-deferred-items-may-26.md](./base-infra-deferred-items-may-26.md).

---

## Acceptance Criteria

- A parent can spawn a child with expected facts and artifacts.
- The child can complete with a structured result.
- `wait_for_agents` returns the structured child result.
- Portal/TUI can display whether the child satisfied its contract.
- Cancelling a contracted child without a partial result records a visible
  warning or violation.
- An operator can create a session group, create new sessions inside it, and
  expand/collapse it independently of child-session nesting.
- Existing sessions are assigned to groups only at session creation time in this
  proposal; moving an existing session between groups is deferred.
- Pin/unpin and bulk complete/cancel/delete actions work on group rows.
- Deleting a group batch-deletes underlying sessions first and deletes the group
  row only after those sessions are gone from CMS.
- Groups and sessions inside groups sort by latest summary update, with missing
  summary timestamps falling back to the previous sort behavior.
- Periodic resorting keeps the selected session visually stable and preserves
  the selected content/view.
- Root PilotSwarm and resource-manager sessions do not maintain recurring
  polling cron loops.
- Root PilotSwarm and resource-manager sessions wake from direct operator prompts
  or an implementation-defined reactive wake path, not management-surface
  cross-session messages.
- Facts-manager and sweeper maintenance cron runs every 6 hours.
- A shared `intake/*` fact write queues an intake event to facts-manager.
- Any session can list sessions and send an auditable request/response message
  to any other session in the deployment.
- Session rows expose a short summary and structured `summary_state` that the UX
  can render without asking the agent for a fresh update.
- The chat pane has a Summary tab with current intent, current state, open
  questions, blocked or terminal state, domain summary, and key links. The
  selected chat view is restored from user profile settings.
- Existing uncontracted sessions continue to work.
- A large delegated workflow with many child sessions can be audited without
  transcript scraping.
- Event-driven parent waits are explicitly deferred and are not required for
  this phase.

---

## Relationship To Application Plugins

This proposal intentionally stops at generic coordination primitives.

Applications should still own:

- domain fact schemas
- domain artifact requirements
- domain validation rules
- agent-specific skills
- safety policies around secrets, destructive operations, and environment scope

PilotSwarm should provide the rails so those policies are not enforced only by
prompt discipline.

---

## Final Schema And Event Delta

This is the union list for the proposal. Implementation PRs should keep this
section current as choices are finalized.

### CMS schema changes

Add nullable columns to `copilot_sessions.sessions`:

- `group_id TEXT`
- `short_summary TEXT`
- `summary_state JSONB`
- `summary_updated_at TIMESTAMPTZ`

Add indexes:

- `idx_copilot_sessions_sessions_group_id` on `sessions(group_id)` where
  `deleted_at IS NULL AND group_id IS NOT NULL`
- `idx_copilot_sessions_child_outcomes_parent` on
  `session_child_outcomes(parent_session_id)`

Add `copilot_sessions.session_groups`:

- `group_id TEXT PRIMARY KEY`
- `title TEXT NOT NULL`
- `description TEXT`
- `owner JSONB`
- `metadata JSONB NOT NULL DEFAULT '{}'::jsonb`
- `created_at TIMESTAMPTZ NOT NULL DEFAULT now()`
- `updated_at TIMESTAMPTZ NOT NULL DEFAULT now()`

Add `copilot_sessions.session_child_outcomes`:

- `child_session_id TEXT PRIMARY KEY`
- `parent_session_id TEXT NOT NULL`
- `contract_json JSONB`
- `result_json JSONB`
- `verdict TEXT`
- `summary TEXT`
- `completed_at TIMESTAMPTZ`
- `created_at TIMESTAMPTZ NOT NULL DEFAULT now()`
- `updated_at TIMESTAMPTZ NOT NULL DEFAULT now()`

Explicitly out of scope for Phase 1:

- no `sessions.is_group`
- no `sessions.closed_at`
- no `sessions.group_metadata`
- no `session_groups.closed_at` or group runtime-state field
- no hard foreign key from `sessions.group_id` to `session_groups.group_id`
- no `session_messages` CMS table
- no bounded-polling columns or tables

### Durable KV and queue state

Add KV records:

- `session_message/request/<requestId>`
- `session_message/response/<requestId>`
- `session_message/rate/sender/<senderSessionId>/<bucket>`
- `session_message/rate/sender_target/<senderSessionId>/<targetSessionId>/<bucket>`
- `session_message/outstanding/<senderSessionId>/<requestId>`
- facts-manager intake cursor/checkpoint keys, with exact names chosen in the
  implementation PR

Add durable queues:

- facts-manager intake queue
- cross-session message request queue
- cross-session message response queue

### CMS event type changes

Add no new CMS `session_events.event_type` values in Phase 1.

Existing tool invocation/result tracing should capture the inputs and outputs
for contract-aware `spawn_agent`, `complete_agent`, `cancel_agent`, and
`wait_for_agents` calls. Do not add separate CMS events for contract registered,
contract validated, result submitted, or contract violation in the first pass.

### Durable queue message types

Add queue message payload types:

- `facts.intake_written`
- `session.message_requested`
- `session.message_responded`

These are durable queue/KV coordination records, not CMS `session_events`.
