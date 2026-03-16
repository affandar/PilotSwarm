# Local Integration Test Plan

This plan is for a comprehensive local test matrix that exercises the PilotSwarm runtime without the TUI.

The target topology is:

- PostgreSQL running locally in a container
- two PilotSwarm workers running locally
- a shared local filesystem for session state via `sessionStateDir`
- a local `FilesystemSessionStore` when we need durable dehydration without Azure
- no blob storage
- no TUI
- tests drive the system through `PilotSwarmClient`, `PilotSwarmWorker`, `PilotSwarmManagementClient`, CMS reads, and process control

## Goals

We want a local test suite that catches the same classes of regressions we keep finding manually:

- orchestration replay and versioning issues
- continue-as-new edge cases
- KV-backed response/command transport issues
- command/message races like `/done`
- multi-worker resume and handoff behavior
- system-agent and sub-agent contract regressions
- prompt/tool/runtime contract drift
- CMS and event-history consistency bugs

## Non-Goals

- TUI rendering behavior
- Azure Blob Storage integration
- AKS-only operational behavior

Those should still have separate coverage, but they are not the focus of this plan.

## Local Test Topology

Each test run should create an isolated environment:

- one Docker Postgres instance or one shared local Postgres container
- unique `duroxideSchema` per suite or per test file
- unique `cmsSchema` per suite or per test file
- one shared temporary `sessionStateDir`
- two workers with different `workerNodeId` values

Example worker topology:

```text
client
  |
  +-- worker-a (workerNodeId=local-a)
  |
  +-- worker-b (workerNodeId=local-b)

shared Postgres
shared sessionStateDir on local disk
```

This lets us test:

- warm resumes
- worker handoff
- dehydration through the session-store abstraction without Azure
- shared local-session files
- multi-worker races

## Test Harness Requirements

The local harness should provide reusable helpers for:

- creating unique schema names
- creating a unique temp `sessionStateDir`
- starting/stopping one or two workers
- optionally starting workers in child processes instead of only in-process
- resetting schemas between tests
- waiting for CMS/event conditions
- collecting worker logs for assertions
- driving client and management-client flows without the TUI

Recommended helper shape:

```text
packages/sdk/test/helpers/
  local-env.js
  local-workers.js
  assertions.js
  fixtures.js
  cms-helpers.js
```

Recommended scripts:

```text
packages/sdk/test/local/
  smoke.test.js
  durability.test.js
  multi-worker.test.js
  commands.test.js
  sub-agents.test.js
  contracts.test.js
  chaos.test.js
```

## Environment Setup

### PostgreSQL

Recommended local container:

```bash
docker run --rm --name pilotswarm-pg \
  -e POSTGRES_PASSWORD=postgres \
  -e POSTGRES_DB=pilotswarm \
  -p 5432:5432 \
  postgres:16
```

Example env:

```bash
export DATABASE_URL=postgresql://postgres:postgres@localhost:5432/pilotswarm
export GITHUB_TOKEN=...
```

### Local session store

When a test needs the durable dehydrate/hydrate path but should stay fully local,
prefer `FilesystemSessionStore` over Azurite or Azure Blob Storage.

That gives us:

- the same session-store lifecycle shape as production
- no cloud dependency
- local archives we can inspect during test failures

Blob-specific behavior like SAS URLs and artifact cleanup should still have a
separate Azure or Azurite-backed test layer.

### Shared local session state

Each suite should create a temp directory such as:

```text
/tmp/pilotswarm-test-<run-id>/session-state
```

and pass it to both workers via `sessionStateDir`.

### Schema isolation

Each suite should generate unique names, for example:

- `duroxide_it_<timestamp>_<pid>`
- `copilot_sessions_it_<timestamp>_<pid>`

This avoids cross-test pollution and removes the need to drop shared global schemas during normal local runs.

## Test Levels

### Level 1: Single-session smoke

Purpose:

- confirm the runtime still works end-to-end in the happy path

Cases:

- create session
- simple Q&A
- multi-turn memory
- event persistence
- session resume by ID
- session list
- session info
- session delete

These already exist in some form and should remain the basic green gate.

### Level 2: Durability and orchestration behavior

Purpose:

- verify timer, retry, hydration, and continue-as-new behavior

Cases:

- short wait stays in-process
- long wait crosses the durable threshold
- wait completes and returns the correct response
- `input_required` round-trip
- repeated waits across multiple iterations
- continue-as-new after idle
- continue-as-new after waiting
- continue-as-new after `input_required`
- command event preserved across continue-as-new
- command response still delivered if completion happens immediately after the command
- retry flow on turn failure
- max retry exhaustion
- error status propagation

### Level 3: Multi-worker local topology

Purpose:

- verify behavior when two workers share the same store and local session-state directory

Cases:

- worker A starts a session, worker B can observe and later resume it
- long wait started on worker A completes after worker A is stopped and worker B is started
- session can resume from shared local `sessionStateDir` with a local `FilesystemSessionStore`
- worker handoff after idle/dehydration
- multiple sessions spread across the two workers
- `maxSessionsPerRuntime` respected under local contention
- no duplicate execution of the same orchestration turn across workers

### Level 4: Command and event-queue semantics

Purpose:

- verify slash-command-like flows at the orchestration level, without the TUI

Cases:

- command event returns a command response
- command response is delivered via KV-backed path
- command response survives continue-as-new
- `/done` equivalent command while the session is running
- `/done` equivalent command during the post-response idle window
- command on a waiting session
- command on an already completed session
- duplicate command IDs are handled safely
- stray command event does not corrupt prompt processing

### Level 5: Sub-agent and system-agent flows

Purpose:

- verify the highest-risk orchestration contract area

Cases:

- named agent spawn via `agent_name`
- malformed `task="sweeper"` / `task="resourcemgr"` normalization for system parents
- custom ad hoc agent via `task=...` still works and is not over-normalized
- multiple tool actions returned from one LLM turn are drained durably
- `message_agent`
- `check_agents`
- `wait_for_agents`
- `cancel_agent`
- `delete_agent`
- `complete_agent`
- parent receives child completion updates
- child session metadata includes expected `agentId`, `title`, `isSystem`
- root system agents and child system agents come up correctly with expected deterministic identity

### Level 6: KV/customStatus transport

Purpose:

- verify the hybrid signaling model directly

Cases:

- completed response written to `response.latest` and observed correctly
- wait-with-content response written to `response.latest`
- `input_required` prompt written to `response.latest`
- command response written to `command.response.<id>`
- `customStatus` carries only signal fields needed by the observer path
- response/command versions move monotonically enough for reader dedupe
- no duplicate payload display across continue-as-new
- legacy compatibility path still works if a frozen orchestration publishes old-style status payloads

### Level 7: CMS and event-history consistency

Purpose:

- verify the persisted read model that clients and TUI depend on

Cases:

- `session_events.seq` is strictly increasing
- expected event types are persisted
- transient/delta events are not persisted when they should not be
- title/model/system metadata written correctly
- parent/child links in CMS are correct
- session state transitions are correct in CMS
- no duplicate final messages written on completed sessions

### Level 8: Prompt/tool/runtime contract tests

Purpose:

- turn the fragile contracts into explicit assertions

Cases:

- `default.agent.md` is always part of the base prompt path
- `mode: "replace"` does not remove the worker base prompt
- sub-agent model override must use an exact `provider:model` from `list_available_models`
- guessed/shortened model names are rejected
- known named agents are spawned via canonical metadata path
- tool descriptions and runtime validation agree on allowed spawn/model behavior

### Level 9: Local chaos tests

Purpose:

- reproduce realistic failures locally, without AKS

Cases:

- kill worker process during a long wait, then start another worker
- stop one worker while another is still polling
- stop both workers, restart both, confirm sessions resume
- worker crash after tool completion but before the next orchestration step
- command/message arrival during worker restart
- session deletion during or immediately after completion

These tests are easiest if the harness can launch workers in child processes rather than only in-process objects.

## Priority Order

### P0

- single-session smoke
- durability and continue-as-new
- `/done` / command races
- multi-worker handoff with shared `sessionStateDir`
- named-system-agent spawn contract

### P1

- KV/customStatus transport coverage
- child-agent lifecycle coverage
- CMS consistency coverage
- local chaos restarts

### P2

- higher concurrency/load tests
- long-running soak tests
- performance thresholds and regression budgets

## Suggested Test Implementation Phases

### Phase 1: Harden the harness

Build helpers for:

- unique schemas
- temp dirs
- one- and two-worker topologies
- CMS assertions
- worker log capture

### Phase 2: Close the biggest regression holes

Implement P0:

- continue-as-new
- `/done`
- multi-worker resume
- system-agent spawn contract
- queued multi-action turn handling

### Phase 3: Expand transport and lifecycle coverage

Implement:

- KV/customStatus cases
- command-response cases
- child-agent lifecycle
- CMS consistency

### Phase 4: Add chaos and concurrency

Implement:

- child-process worker restarts
- worker kill/restart tests
- concurrent session fan-out and fairness

## Suggested Commands

Eventually the suite should expose commands like:

```bash
npm run test --workspace=packages/sdk
npm run test:local:smoke --workspace=packages/sdk
npm run test:local:durability --workspace=packages/sdk
npm run test:local:multi-worker --workspace=packages/sdk
npm run test:local:chaos --workspace=packages/sdk
```

## Success Criteria

We should consider the local integration plan successful when:

- the major orchestration regressions we have recently fixed are each covered by at least one automated test
- the suite runs locally with only Docker Postgres plus a GitHub token
- the suite does not depend on the TUI
- two-worker tests run against shared Postgres and shared local `sessionStateDir`
- failures clearly identify whether the bug is in orchestration logic, worker/client wiring, or CMS persistence

## Immediate Next Cases To Add

If we implement this incrementally, I would start with these five:

1. `/done` command arriving during the post-response idle window
2. system parent calling `spawn_agent(task=\"sweeper\")` and getting a canonical named child
3. long wait started on worker A, resumed by worker B with shared local `sessionStateDir`
4. command response delivered even when the session completes immediately afterward
5. multiple tool actions emitted in one turn are all executed durably
