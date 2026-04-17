# Agent Tuner — System Diagnostic Agent

## Summary

Introduce `agent-tuner`, a read-only system agent that helps an operator
diagnose why a session, agent, or orchestration is not behaving as
expected, and proposes concrete prompt or configuration changes. The tuner
has unrestricted read access to CMS state, durable facts, duroxide
orchestration history, KV state, per-orchestration runtime stats, and
worker resource metrics. It cannot mutate any of them.

This complements the [`read_agent_events`](read-agent-events-tool.md)
proposal: that tool is the building block; the agent-tuner is the
operator-facing investigator that uses it together with a much wider
read-only toolset.

## Motivation

Today an operator who needs to understand "why did this agent do that"
has to:

- open the portal, find the session, scroll the activity pane
- correlate that with duroxide history via the management client or
  `scripts/_debug_*.js` helpers
- inspect per-session metric summaries directly in the database
- read the agent prompt, the system prompt block, and any injected fact
  blocks separately
- piece together a hypothesis manually

There is no integrated, agent-driven investigator that can pull all of
this together, reason about it, and produce an actionable finding plus a
proposed prompt or config change. The tuner agent fills that gap.

## Design Principles

1. **Read-only.** Tuner cannot mutate facts (other than its own findings
   namespace), cannot send messages, cannot spawn or cancel agents,
   cannot touch orchestrations or KV state.
2. **Operator-facing.** Spawned on demand by an operator (portal action,
   CLI shortcut, or another agent) with a target session id; produces a
   single finding-plus-recommendation report and exits.
3. **Bounded.** One investigation per session. Continuous monitoring is
   what `pilotswarm` and `resourcemgr` already do.
4. **Audited.** Every tuner tool call is recorded in a dedicated audit
   table the tuner cannot read back.
5. **No auto-fix.** Tuner proposes diffs; humans apply them.

## Agent Definition

- **Identity.** `agentIdentity = "agent-tuner"`, `isSystem = true`.
  Excluded from `check_agents` listings the way `sweeper` is.
- **Location.** `packages/sdk/plugins/mgmt/agents/agent-tuner.agent.md`
  alongside the other system agents.
- **Lifecycle.** Not a persistent supervisor. Spawned on demand,
  performs one investigation, exits. No cron. The `pilotswarm` agent (or
  a portal/CLI action) is what creates a tuner session with the target
  session id pre-baked into the prompt.
- **Bundled knowledge.** Three skills under
  `packages/sdk/plugins/mgmt/skills/` are made available to the tuner via
  the standard skills loader:
  - `pilotswarm-architecture/SKILL.md` — runtime model: sessions, runTurn,
    hydration, lossy handoff, cron, lineage. Sourced from
    `docs/architecture.md` and `docs/orchestration-loop.md`.
  - `prompt-layering/SKILL.md` — how the system prompt, agent.md, attached
    skills, and injected fact blocks compose. Sourced from
    `docs/design-default-agent.md`.
  - `duroxide-replay/SKILL.md` — determinism rules and common
    nondeterminism failure modes. Sourced from
    `.github/copilot-instructions.md` and the `debug-orchestration` skill.

## Toolset

The tuner uses tools registered in
`packages/sdk/src/inspect-tools.ts` (created by the `read_agent_events`
proposal). All entries below are read-only.

### Wrappers over `PilotSwarmManagementClient`

These already exist in
[packages/sdk/src/management-client.ts](../packages/sdk/src/management-client.ts);
the tuner just gets thin tool wrappers. Lineage gate is bypassed for
`agentIdentity === "agent-tuner"`.

| Tool | Backed by | Use |
|---|---|---|
| `list_all_sessions` | `listSessions()` | Locate target by description; see siblings |
| `read_session_info` | `getSession(id)` | Title, agent, model, status, iterations, error, waitReason, pendingQuestion, contextUsage, orchestrationStatus, orchestrationVersion |
| `read_session_status` | `getSessionStatus(id)` | Live `customStatus` + `customStatusVersion` |
| `read_session_tree` | `getSessionTreeStats(id)` | Spawn tree with rolled-up stats |
| `read_session_metric_summary` | `getSessionMetricSummary(id)` | Tokens (input/output/cache_read/cache_write), snapshot bytes, dehydrations, hydrations, lossy handoffs, last hydrated/dehydrated/checkpoint timestamps |
| `read_fleet_stats` | `getFleetStats({ includeDeleted, since })` | Cross-session baselines by agent and model |
| `read_agent_events` | `getSessionEvents` / `getSessionEventsBefore` | Paginated transcript per session |
| `read_latest_response` | `getLatestResponse(id)` | Final user-facing payload for the most recent turn |
| `read_command_response` | `getCommandResponse(id, cmdId)` | Confirm what an operator-issued cancel/done/delete actually did |
| `read_orchestration_stats` | `getOrchestrationStats(id)` | History event count + bytes, queue pending, KV key count + bytes, current `orchestrationVersion` |
| `read_execution_history` | `getExecutionHistory(id, executionId?)` | Raw duroxide history for current/specified execution |
| `list_executions` | thin pass-through to `client.listExecutions` | Enumerate executions when an orchestration was restarted/recovered |
| `list_models` | `listModels()` | Compare actual vs. expected model |
| `list_providers` | `listProviders()` | Spot a missing/disabled provider |
| `dump_session` | `SessionDumper` | Bundle for offline review or attach to a finding |

### Direct duroxide reads (narrow escapes)

Wrap each as a tool taking `session_id`; the orchId is constructed
internally so the tuner never sees raw orchIds.

| Tool | Underlying call | Use |
|---|---|---|
| `read_orchestration_instance_info` | `client.getInstanceInfo(orchId)` | Current execution id, status, version, parent instance |
| `list_orchestrations_by_status` | `client.listInstancesByStatus(status)` | Find every Running / Failed / Suspended orchestration for fleet sweeps |
| `read_kv_key` | `client.getValue(orchId, key)` | Inspect KV-backed state. Restricted to a known-key allow-list (`RESPONSE_LATEST_KEY`, `commandResponseKey(*)`, `cron/*`). |

### Facts (unrestricted read)

| Tool | Notes |
|---|---|
| `read_facts_unrestricted(key_pattern, scope?)` | Same as `read_facts` but the tuner sees all scopes including `intake/*` (normally facts-manager-only). |

### Worker resource snapshot

| Tool | Notes |
|---|---|
| `read_worker_resource_snapshot` | `process.memoryUsage()` + active session count for the worker the tuner runs on. Mirrors what the TUI header shows. Useful for "was the worker memory-bound when this happened" questions. |

### Explicit deny-list

The tuner must never have wrappers for any of these:

- `enqueueEvent`, `sendCommand`, `cancelInstance`, `terminateInstance`,
  `deleteInstance`, `purgeInstance`
- Anything that mutates orchestration state, KV, queue, or history
- `setValue` on duroxide KV
- `spawn_agent`, `message_agent`, `cancel_agent`, `complete_agent`
- Any `store_fact` write outside the `tuning/findings/<session-id>`
  namespace; writes elsewhere are rejected by the facts policy guard.

## Stats Surfaces (full breadth)

The tuner has unrestricted read access to:

**Per-session**
- `read_session_metric_summary` — tokens (input, output, cache_read,
  cache_write), `snapshotSizeBytes`, dehydration/hydration counts,
  `lossy_handoff_count`, `last_dehydrated_at`, `last_hydrated_at`,
  `last_checkpoint_at`.
- `read_orchestration_stats` — duroxide history event count, history
  byte size, queue pending count, KV user key count, KV total value bytes,
  current `orchestrationVersion`.
- `read_execution_history` — exact event-by-event ground truth for the
  current execution.
- `read_session_tree` — rolled-up token / snapshot / dehydration totals
  across the whole spawn tree.

**Fleet**
- `read_fleet_stats({ includeDeleted, since })` — fleet-wide
  token / snapshot / dehydration aggregates broken down by agent and
  model.
- `list_orchestrations_by_status` — which orchestrations are stuck or
  lossy across the whole deployment.

**Process (worker-level)**
- `read_worker_resource_snapshot` — RSS and active-session count for the
  worker the tuner is running on.

This combined set lets the tuner reason about:

- token-budget regressions (skill or prompt bloat)
- snapshot bloat (oversized facts or KV state)
- hydration thrash (excessive cron or message_agent traffic)
- history-size growth (orchestration version too long-lived)
- KV bloat (per-session caches not being trimmed)
- lossy handoff frequency (worker churn)
- queue depth (slow activities, dehydrated-but-pending sessions)

## Operator Interface

- **Portal.** A "Tune this session" action on any session detail view
  creates a tuner session with the target session id pre-baked into the
  prompt.
- **CLI / TUI.** `pilotswarm tune <session-id>` shortcut that does the
  same.
- **From another agent.** Any user agent can request a tuning session by
  writing `tuning/requests/<session-id>` with a description; the
  `pilotswarm` supervisor agent picks it up and spawns a tuner.

## Investigation Protocol (encoded in agent.md)

The tuner prompt enforces this sequence:

1. Restate the operator's expectation in one sentence.
2. Identify the target session(s) by id or by description.
3. Pull `read_session_info` and the spawn tree.
4. Tail `read_agent_events` newest-first; walk backwards until the
   divergence point is identified. Force `event_types` filters and
   `limit = 20` per call to control token cost.
5. If the symptom is a replay or orchestration error, pull
   `read_execution_history`, `read_orchestration_stats`, and the
   relevant KV keys.
6. If the symptom is a behavioral/prompt issue, reconstruct the active
   prompt layers at the divergence turn — system prompt, agent.md,
   attached skills, injected fact blocks.
7. Produce: **finding** + **evidence** (event seqs, history event ids,
   log lines cited) + **proposed fix** (prompt diff, model swap, skill
   addition, configuration change).
8. If the operator wants the finding persisted, write it to
   `tuning/findings/<session-id>`. Do not write anywhere else.

## Audit

New CMS table:

```sql
CREATE TABLE IF NOT EXISTS {schema}.tuner_audit (
    seq                  BIGSERIAL PRIMARY KEY,
    tuner_session_id     TEXT NOT NULL,
    target_session_id    TEXT,
    tool_name            TEXT NOT NULL,
    args_summary         JSONB,
    called_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_{schema}_tuner_audit_target
    ON {schema}.tuner_audit(target_session_id, called_at DESC);
CREATE INDEX IF NOT EXISTS idx_{schema}_tuner_audit_tuner
    ON {schema}.tuner_audit(tuner_session_id, seq);
```

Every tuner tool call writes a row before returning. The tuner cannot
read this table — closes the recursive-introspection loop.

Operators can read it via the portal or a new
`PilotSwarmManagementClient.getTunerAudit({ targetSessionId, sinceSeq, limit })`
helper.

## Schema Migration

One migration: `0006_tuner_audit` (sequence number depends on what is
on `main` at implementation time). Companion diff file
`packages/sdk/src/migrations/0006_diff.md` per repo conventions. No
changes to existing tables.

## Test Plan

New file `packages/sdk/test/local/agent-tuner.test.js`:

- Tuner spawns and produces a finding for a deliberately misbehaving
  custom agent (e.g. one with a contradictory prompt).
- Tuner can read across the full spawn tree, including grandchildren and
  system agents (other than itself and other tuner sessions).
- Tuner cannot send messages or spawn agents — tool list assertion.
- Tuner write attempts to `skills/*` or `intake/*` fail; writes to
  `tuning/findings/*` succeed.
- Tuner audit log contains rows for every read tool call, with correct
  `target_session_id`.
- `prompt-layering`, `pilotswarm-architecture`, and `duroxide-replay`
  skills are materialized and surfaced via `<skill>` injection in the
  tuner's context.
- Cross-tuner isolation: tuner A cannot read tuner B's events or audit.
- Tuner cannot read its own audit table.
- Token-budget enforcement: `read_agent_events` defaults to `limit = 20`
  for tuner sessions and rejects unbounded scans.

Add the suite to `scripts/run-tests.sh` and the `test:local` npm script.

## Phasing

| Phase | Scope |
|-------|-------|
| 1 | `inspect-tools.ts` registers the management-client read wrappers above. Lineage gate enforced for non-tuner callers; bypassed for `agentIdentity === "agent-tuner"`. |
| 2 | Direct duroxide read tools: `read_orchestration_instance_info`, `list_orchestrations_by_status`, allow-listed `read_kv_key`, `read_worker_resource_snapshot`. |
| 3 | `agent-tuner.agent.md` + bundled skills + system-agent registration. Toolset = phases 1 + 2 minus all mutating tools. |
| 4 | `tuner_audit` table + audit-write wrapper around every tuner tool call. |
| 5 | Portal "Tune this session" action and CLI `pilotswarm tune <id>` shortcut. |
| 6 | Tests covering tuner spawn, full read access, mutation denial, audit completeness, recursive isolation. |

Each phase is independently shippable. Phase 1 is the foundation; phases
2 and 3 add capability; phase 4 closes the audit loop; phase 5 is UX
polish.

## Non-Goals

- Auto-mutating production agent prompts. Humans apply diffs.
- Continuous monitoring. The tuner does one investigation and exits;
  ongoing supervision lives in `pilotswarm` and `resourcemgr`.
- New mutating capability of any kind. If a future need surfaces, it gets
  its own proposal.

## Risks

- **Sensitive data exposure.** Tuner reads can include raw prompts and
  tool outputs from any session. The audit table makes the access
  reviewable, but the privilege itself is broad. Operator-only
  invocation discipline matters.
- **Token cost of investigations.** A long spawn tree with deep transcripts
  can blow past context limits. The investigation protocol forces
  filtered, paginated reads.
- **Drift between tuner skills and reality.** The bundled skills are
  static markdown sourced from `docs/`. Treat them as a maintained surface;
  update them whenever runtime model, prompt layering, or orchestration
  versioning rules change.
