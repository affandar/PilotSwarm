# Agent Manager and Continue-As-New Sessions

## Status

Proposed.

This proposal supersedes the read-only posture in
[agent-tuner-system-agent.md](agent-tuner-system-agent.md). The old Agent Tuner
was designed as an investigator that could not mutate state. This proposal
renames that system agent to Agent Manager and intentionally gives it privileged
read/write authority across PilotSwarm so it can repair, migrate, clone, and
continue sessions.

## Summary

Rename the current `agent-tuner` system agent to `agent-manager` and turn it
from a read-only diagnostic agent into an operator-directed management agent.
Agent Manager gets the union of every read and write capability exposed to any
agent in the system, plus new manager-only tools for top-level session creation,
session grouping, and semantic session cloning.

The flagship workflow is `continue_session_as_new`: given a source session whose
snapshot is too large, whose tool state is broken, or whose current run is
failing, Agent Manager creates a fresh top-level continuation session, copies
private facts into that new session, summarizes the source session's prompts and
CMS events, and sends a bootstrap instruction telling the new session that it is
a continuation of the old one.

This is PilotSwarm's product-level analogue to Duroxide continue-as-new. It does
not rewrite durable orchestration history in place; it creates a new session
with semantic state transferred forward.

## Motivation

Long-running agents accumulate large snapshots, dense transcript history,
private facts, and implicit operational state. When one starts failing, the
current recovery options are blunt:

- keep pushing the same large session and hope the next turn recovers
- manually create another session and re-explain the entire context
- copy a few facts by hand and lose hidden/private state
- cancel or delete the old session and lose useful forensic evidence

This is especially painful for harvesters and other background agents. A
harvester can spend hours building source context, private facts, and a plan,
then become hard to continue because its snapshot is huge or a tool path starts
failing. Operators need a way to say: "make a fresh session that knows what this
one knew and continue from there."

Agent Manager fills that gap.

## Goals

- Rename the system agent from Agent Tuner to Agent Manager.
- Give Agent Manager god-mode access: unrestricted reads and writes across the
  union of all existing agent capabilities.
- Add top-level session creation tools for generic sessions and named agents.
- Allow Agent Manager to assign new sessions to session groups.
- Add `continue_session_as_new` to clone context from one session to another.
- Copy non-shared/private facts from source session to target session by
  default.
- Summarize relevant CMS events, prompts, summaries, errors, and tool activity
  into a compact handoff prompt.
- Support two target-start modes:
  - `ask_before_start`: target recaps inherited state and waits for the operator
    to say `start`.
  - `start_immediately`: target begins continuing the work immediately.
- Keep ordinary agents' existing access boundaries intact.

## Non-Goals

- Do not mutate or compact the source session's existing duroxide history.
- Do not binary-clone Copilot SDK snapshot blobs.
- Do not make every system agent privileged.
- Do not grant privileges by display title or prompt text.
- Do not expose manager-only tools to app agents.
- Do not make session pinning a fake CMS property. Pinning is currently a
  per-user UI/profile preference and should be treated separately from group
  assignment.

## Current System State

The current `agent-tuner` is a read-only system agent at
`packages/sdk/plugins/mgmt/agents/agent-tuner.agent.md`.

Read-only behavior is hardcoded in several layers:

- `packages/sdk/src/session-manager.ts` strips mutating system and sub-agent
  tools from `agent-tuner` sessions.
- `packages/sdk/src/managed-session.ts` repeats turn-time filtering for the
  same read-only behavior.
- `packages/sdk/src/session-proxy.ts` blocks `update_session_summary`,
  `send_session_message`, and `reply_session_message` for `agent-tuner`.
- `packages/sdk/src/facts-tools.ts` blocks `store_fact` and `delete_fact` for
  `agent-tuner`, while allowing unrestricted fact reads.
- `packages/sdk/src/graph-tools.ts` treats `agent-tuner` as read-only: it gets
  unrestricted graph reads and `graph_stats`, but not graph writes or crawl
  queue tools.
- `packages/sdk/src/inspect-tools.ts` exposes deep diagnostic tools only when
  `agentIdentity === "agent-tuner"`.

Several required building blocks already exist:

- `PilotSwarmClient.createSession()` creates top-level generic sessions when no
  `parentSessionId` is supplied.
- `PilotSwarmClient.createSessionForAgent()` creates top-level named-agent
  sessions with model, reasoning effort, owner, group id, and optional bootstrap
  prompt.
- `PilotSwarmManagementClient` supports session groups:
  `createSessionGroup`, `listSessionGroups`, `listGroupSessions`,
  `updateSessionGroup`, and `moveSessionsToGroup`.
- CMS stores session summaries, event streams, model/reasoning metadata, parent
  links, group ids, and owners.
- Facts distinguish shared facts from session-scoped private facts.

## Proposed Identity

Canonical system-agent identity:

```yaml
schemaVersion: 1
version: 2.0.0
name: agent-manager
id: agent-manager
title: Agent Manager
system: true
parent: pilotswarm
```

The prompt file should move from:

```text
packages/sdk/plugins/mgmt/agents/agent-tuner.agent.md
```

to:

```text
packages/sdk/plugins/mgmt/agents/agent-manager.agent.md
```

The prompt must be rewritten from "read-only diagnostic agent" to
"privileged operator-directed manager".

### Compatibility

There are two viable migration choices:

1. **Alias for one release.** Treat `agent-tuner` as a legacy alias for
   `agent-manager` in runtime checks. Existing persisted tuner sessions gain
   manager privileges until reset. This is operationally smooth but turns old
   sessions into god-mode sessions.
2. **New identity only.** Bootstrap only `agent-manager`; old `agent-tuner`
   sessions remain read-only or are left to be removed/reset. This is safer but
   requires operators to use the new session.

Recommendation: use a short-lived explicit alias, but make it noisy in logs and
agent output. Define:

```ts
const AGENT_MANAGER_IDS = new Set(["agent-manager", "agent-tuner"]);
function isAgentManager(agentIdentity?: string): boolean {
  return AGENT_MANAGER_IDS.has(agentIdentity || "");
}
```

Then remove the alias in a later release once deployed environments have reset
or migrated system sessions.

## Privilege Model

Agent Manager gets the union of all current read/write capabilities.

### Reads

Agent Manager has unrestricted read access to:

- all CMS sessions, including system sessions and deleted rows when supported
- all session events
- session summaries and metric summaries
- session tree and fleet stats
- user/owner stats
- duroxide orchestration stats and execution history
- all facts, including private session facts and reserved namespaces
- all graph reads and graph stats
- model/provider lists

### Writes

Agent Manager can mutate:

- its own summary
- other sessions via session-message tools
- facts in any namespace, including `intake/*`, `skills/*`, `asks/*`, and
  `config/facts-manager/*`
- graph nodes and edges
- crawl queue state when graph/facts store supports it
- top-level sessions through new manager-only tools
- session groups through new manager-only tools

### Guardrails

This is god mode, not casual escalation. Guardrails should be explicit:

- Grant only by canonical system identity, never by title.
- Manager-only tools should be registered only for `isAgentManager()`.
- Every manager mutation should record a CMS event for audit.
- Destructive operations require explicit confirmation flags.
- Tool descriptions should say "operator-directed privileged operation".

Suggested audit event types:

- `agent_manager.session_created`
- `agent_manager.session_cloned`
- `agent_manager.facts_copied`
- `agent_manager.group_created`
- `agent_manager.group_assigned`
- `agent_manager.clone_bootstrap_sent`

## Tool Surface

### Existing Tools Agent Manager Should Receive

Agent Manager should receive all existing ordinary and privileged tools:

- System and scheduling tools: `wait`, `wait_on_worker`, `cron`, `cron_at`.
- System mutation tools: `update_session_summary`, `send_session_message`,
  `reply_session_message`.
- Sub-agent controls: `spawn_agent`, `check_agents`, `message_agent`,
  `wait_for_agents`, `complete_agent`, and cancel/delete controls where present.
- Fact tools: `store_fact`, `read_facts`, `delete_fact`, `facts_search`,
  `facts_similar`, `search_skills`, and `manage_embedder` when configured.
- Graph tools: `graph_search_nodes`, `graph_search_edges`,
  `graph_neighbourhood`, `graph_stats`, `graph_upsert_node`,
  `graph_upsert_edge`, `graph_merge_nodes`, `graph_delete_node`,
  `graph_delete_edge`, `facts_read_uncrawled`, `facts_mark_crawled`.
- Inspect tools: all current tuner-only tools.

### New Tool: `create_top_level_session`

Creates a new root session, not a sub-agent.

Parameters:

```ts
{
  agent_name?: string;
  title?: string;
  model?: string;
  reasoning_effort?: "low" | "medium" | "high" | "xhigh";
  group_id?: string | null;
  owner?: SessionOwnerInfo | null;
  initial_prompt?: string;
  start_behavior?: "created_only" | "send_initial_prompt";
}
```

Behavior:

- If `agent_name` is present, call `PilotSwarmClient.createSessionForAgent()`.
- If `agent_name` is omitted, call `PilotSwarmClient.createSession()`.
- Never set `parentSessionId`.
- Preserve model, reasoning effort, owner, and group id.
- If `initial_prompt` is supplied and `start_behavior` is
  `send_initial_prompt`, send it as a bootstrap prompt.
- Return session id, title, model, reasoning effort, group id, agent id, and
  whether a bootstrap prompt was sent.

### New Tool: `create_or_update_session_group`

Creates or updates a session group.

Parameters:

```ts
{
  group_id?: string;
  title: string;
  description?: string | null;
  owner?: SessionOwnerInfo | null;
  metadata?: Record<string, unknown>;
}
```

Behavior:

- If `group_id` exists, update title/description/metadata.
- Otherwise create a new group.
- Return group id, title, owner, metadata, and member count.

### New Tool: `list_session_groups`

Lists session groups with owner and member metadata.

Parameters:

```ts
{
  owner_query?: string;
  owner_kind?: "user" | "system" | "unowned";
  limit?: number;
}
```

### New Tool: `move_sessions_to_group`

Moves one or more sessions into an existing group, or out of groups.

Parameters:

```ts
{
  group_id: string | null;
  session_ids: string[];
}
```

Behavior:

- Wrap `PilotSwarmManagementClient.moveSessionsToGroup()`.
- Preserve existing owner compatibility rules.
- Return moved, skipped, and errors when possible.

### Pinning Note

Session/group pinning is currently persisted as per-user profile/UI preference,
not as a CMS property on sessions or groups. Agent Manager should not pretend to
pin sessions by writing CMS session rows.

A later tool may be added if needed:

```ts
set_profile_pinned_items({ owner, pinned_session_ids, pinned_group_ids })
```

That tool should be owner-scoped and should write `users.profile_settings`, not
session rows.

## Continue-As-New Workflow

### New Tool: `continue_session_as_new`

Creates a fresh top-level session that semantically continues a source session.

Parameters:

```ts
{
  source_session_id: string;
  target_agent_name?: string;
  title?: string;
  model?: string;
  reasoning_effort?: "low" | "medium" | "high" | "xhigh";
  group_id?: string | null;
  copy_private_facts?: boolean;
  copy_shared_facts?: boolean;
  fact_key_prefix?: string;
  overwrite_facts?: boolean;
  event_limit?: number;
  include_event_types?: string[];
  start_behavior?: "ask_before_start" | "start_immediately";
  user_instructions?: string;
  after_clone_action?: "none" | "cancel" | "complete";
  confirm_after_clone_action?: boolean;
}
```

Defaults:

- `target_agent_name`: source `agentId` when it is a creatable named agent;
  otherwise generic.
- `title`: `Continuation of <source title>`.
- `model`: source model, falling back to configured default.
- `reasoning_effort`: source reasoning effort when present.
- `group_id`: source group id.
- `copy_private_facts`: true.
- `copy_shared_facts`: false.
- `event_limit`: 300.
- `start_behavior`: `ask_before_start`.
- `after_clone_action`: `none`.

### Clone Flow

1. Normalize and validate `source_session_id`.
2. Read source session metadata from CMS:
   - title
   - agent id
   - model
   - reasoning effort
   - owner
   - group id
   - state
   - iterations
   - short summary and summary state
   - last error and wait reason
3. Resolve target session shape:
   - named agent vs generic
   - model/reasoning
   - title
   - owner
   - group
4. Create target top-level session.
5. Copy private facts, if requested.
6. Read and summarize source CMS events.
7. Write clone metadata facts into the target session.
8. Send a bootstrap prompt to the target session.
9. Optionally cancel or complete the source session, only with explicit
   confirmation.
10. Return a structured clone receipt.

## Fact Copy Semantics

Private/session-scoped source facts should become private/session-scoped target
facts. They should not be made shared.

Default behavior:

- Preserve keys, values, and tags where supported by the fact-store API.
- Add provenance via target-local clone manifest facts.
- If a target key already exists, fail before partial copy unless
  `overwrite_facts=true`.

Suggested target-local manifest facts:

- `clone/source`
- `clone/context-summary`
- `clone/copied-facts-manifest`
- `clone/event-summary`

Example `clone/source` value:

```json
{
  "sourceSessionId": "...",
  "targetSessionId": "...",
  "clonedAt": "2026-06-18T00:00:00.000Z",
  "copiedPrivateFactCount": 42,
  "eventSeqRange": { "first": 100, "last": 860 },
  "operatorInstructions": "Continue the harvester after fixing the failing tool path."
}
```

Shared facts should not be copied by default because they are already globally
visible. If `copy_shared_facts=true`, the first implementation should prefer a
manifest/reference over duplicating shared rows.

## Event Summary Semantics

Use CMS events as the durable source of truth. Do not dump raw full history into
the new prompt.

Default event types to summarize:

- `user.message`
- `assistant.message`
- `tool.execution_start`
- `tool.execution_complete`
- `tool.execution_error`
- `session.error`
- `system.message`, only when needed and heavily summarized
- summary update events
- fact and graph write events, when present

Summary output should include:

- objective
- current state
- completed work
- pending work
- blockers/errors
- important facts/graph changes
- recent operator prompts
- continuation instructions

Caps:

- hard event count cap
- hard byte cap
- chunked summary if needed
- full raw history stays in CMS; target receives only the operational handoff

## Bootstrap Prompt

For `ask_before_start`:

```text
[SYSTEM: You are a fresh top-level continuation of session <sourceSessionId>.

You are not a child or sub-agent of that session. You were created by Agent
Manager to continue its work with a smaller snapshot.

Inherited context:
<summary>

Private facts copied:
<count> private facts from <sourceSessionId> were copied into your private fact
scope. Use read_facts to inspect them as needed.

Operator instructions:
<user_instructions>

First recap your inherited state and your intended next actions. Then wait for
the operator to say "start" before doing further work.]
```

For `start_immediately`, replace the last paragraph with:

```text
Begin continuing the work now.]
```

## Implementation Points

Likely files:

- `packages/sdk/plugins/mgmt/agents/agent-manager.agent.md`
- `packages/sdk/src/session-manager.ts`
- `packages/sdk/src/managed-session.ts`
- `packages/sdk/src/session-proxy.ts`
- `packages/sdk/src/facts-tools.ts`
- `packages/sdk/src/graph-tools.ts`
- `packages/sdk/src/inspect-tools.ts`
- new `packages/sdk/src/agent-manager-tools.ts`
- tests under `packages/sdk/test/local/`

Implementation notes:

- Keep manager tools out of orchestration generator code. The clone workflow is
  I/O-heavy and belongs in tool handlers/activities.
- Reuse `PilotSwarmClient` for session creation so orchestration startup remains
  consistent with existing clients.
- Reuse `PilotSwarmManagementClient` or CMS provider methods for groups and
  event reads.
- Use stored procedures for any new CMS data access.
- Record manager audit events through CMS.

## Testing Plan

Add focused local tests.

### Tool Gating

- Agent Manager has mutating system tools.
- Agent Manager has sub-agent controls.
- Agent Manager has fact write/delete tools.
- Agent Manager has unrestricted fact read behavior.
- Agent Manager has graph write/delete tools.
- Agent Manager has crawl queue tools when graph store is configured.
- Ordinary agents do not get manager-only tools.

### Top-Level Session Tools

- `create_top_level_session` without `agent_name` creates a root generic session.
- `create_top_level_session` with `agent_name` creates a root named-agent
  session with correct `agentId`, title, model, and reasoning effort.
- Created sessions have no `parentSessionId`.
- Group assignment works.

### Continue-As-New

- Source private facts are copied to target private facts.
- Shared facts are not duplicated by default.
- Source event summary is included in bootstrap prompt.
- `ask_before_start` instructs target to recap and wait.
- `start_immediately` instructs target to begin.
- Clone receipt records source id, target id, fact counts, and event range.

### Regression

- Existing ordinary lineage gates remain intact for normal agents.
- Existing facts-manager namespace behavior remains intact for normal agents.
- Existing graph read/write availability remains intact for non-manager agents.

## Rollout Plan

1. Implement Agent Manager identity and privilege model.
2. Update prompt, docs, and tests.
3. Deploy with old `agent-tuner` alias if chosen.
4. Add manager-only top-level session/group tools.
5. Add `continue_session_as_new`.
6. Test clone workflow locally.
7. Deploy without DB reset only if no orchestration version changes are required.

## Open Decisions

1. Should legacy `agent-tuner` sessions become god-mode through an alias during
   migration?
2. Should Agent Manager be allowed to mutate per-user pinned session/group
   profile settings in the first implementation?
3. Should event summaries be deterministic only in v1, or use an LLM summarizer?
4. Should `continue_session_as_new` leave the source running by default, or offer
   a default completion/cancel action?
5. Should private fact copy preserve exact keys or rewrite under a
   `continued/<source-session-id>/...` namespace to avoid collisions?

## Recommended First Milestone

Implement this in two slices:

1. **Agent Manager privilege rename.** Rename prompt/identity, remove read-only
   restrictions, expose the full tool union, and add tool-gating tests.
2. **Continue-as-new.** Add manager-only top-level session/group tools and the
   clone workflow with private fact copy, event summary, and bootstrap prompt.

This keeps the god-mode security review separate from the more complex context
transfer workflow.