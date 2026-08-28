# JobGenerator lifecycle state machines

## Purpose and audience

This document defines the architecture and behavioral contract for composing,
publishing, executing, and observing durable Job state machines. It is intended
for PilotSwarm architects and engineers implementing lifecycle compilation,
policy, persistence, workers, transitions, waits, notifications, APIs, and
portal experiences. It also provides profile owners and advanced lifecycle
authors with the conceptual model and ownership boundaries their definitions
must follow.

This is a forward-looking design rather than an operations guide or a
step-by-step end-user authoring tutorial. The currently implemented
JobGenerator discovery, materialization, provider, and controller behavior is
documented in [JobGenerator controller](./job-generators.md).

## Status

This document describes the proposed lifecycle architecture for durable Jobs
created by a JobGenerator. Job discovery, exactly-once materialization,
definition pinning, JobSession history, and durable `ask_user` suspension
already exist. Lifecycle compilation, Job state execution, and transition
history remain to be implemented.

## Summary

A JobGenerator discovers source records and materializes durable Jobs. Each Job
then progresses through an immutable, versioned state machine. State
instructions are authored as Markdown, compiled into a normalized graph, and
snapshotted into the JobGeneratorDefinition that created the Job.

The compiler is generic. It does not hardcode a particular state machine or
repository. Lifecycle profiles and policies determine which states exist, who
may author them, and where extension boundaries occur. One profile may allow a
repository author to control a diagnostic phase before handing off to a
platform-owned delivery phase. Another profile may allow a completely
user-defined state machine.

Workers execute state runs, but the catalog remains authoritative for leases,
allowed transitions, state revisions, idempotency, and history. A worker may
disappear while a Job is waiting for human input; another worker can later
resume the same durable state run.

## TL;DR

1. The platform defines reusable state-machine profiles with explicit
   extension points that repositories and users can plug into.
2. A user supplies the domain-specific behavior for the extension points they
   are allowed to control, such as how to diagnose and propose a fix for a
   particular class of bug.
3. The platform compiles the user-authored fragment, applies policy, and
   combines it with the selected profile to instantiate one immutable,
   concrete state machine for that domain.
4. Workers execute the concrete state machine autonomously. The catalog, not
   an individual worker, remains authoritative for state and transitions.
5. Execution alternates between active work, such as LLM prompts and tools,
   and waits on external systems, timers, or human input.
6. Workflows dehydrate during waits. They do not retain a worker, process, or
   in-memory call stack while waiting, and any eligible worker may resume them
   after the wake condition is satisfied.
7. Humans participate only when their input is blocking progress. The platform
   creates an attention request, can notify the responsible humans through
   configured webhook-backed channels such as email or messaging, and exposes
   all blocked Jobs in a dashboard for users who prefer to monitor them.

The normal operating mode is autonomous execution. Human interaction is an
exception represented as durable, observable blocked work rather than a
required step between every state.

## Goals

- Let authors describe state behavior in readable Markdown.
- Keep transition syntax small and deterministic.
- Support repository-specific, platform-provided, and user-defined state
  machines.
- Compose user-authored fragments with platform-owned lifecycle profiles.
- Pin every Job to an immutable effective lifecycle.
- Execute state runs on any eligible worker without worker affinity.
- Dehydrate workflows during external-system, timer, and human-input waits.
- Reuse durable session suspension for human-input gates.
- Enforce transitions atomically in the catalog.
- Expose current state, waits, ownership, and history in the portal.
- Notify responsible humans when their input blocks an otherwise autonomous
  workflow.
- Preserve exactly-once Job materialization independently of state execution.

## Non-goals

- Inferring transitions from unstructured agent prose.
- Requiring authors to write a YAML state-machine schema.
- Letting agents or clients submit arbitrary destination states.
- Keeping a worker process alive while waiting for a person.
- Allowing a mutable branch to change the lifecycle of an existing Job.
- Building a separate human-input system alongside the existing session
  `ask_user` behavior.
- Requiring a graphical state-machine editor for the initial implementation.

## Vocabulary

| Term | Meaning |
|---|---|
| JobGenerator | Mutable registration that periodically discovers source records |
| JobGeneratorDefinition | Immutable version containing source, lifecycle, affinity, validation, and guardrail configuration |
| Job | Durable identity for one discovered source record |
| Lifecycle source | Repository, Git ref, and root Markdown file supplied for publication |
| State machine fragment | States and transitions authored by one owner, such as a repository team |
| Lifecycle profile | Versioned state machine or composable fragment provided by a platform or repository |
| Lifecycle policy | Rules describing allowed profiles, state ownership, extension points, and overrides |
| Effective lifecycle | Fully composed, validated, immutable graph used by a Job |
| State run | One durable attempt to execute one Job state at one state revision |
| JobSession | PilotSwarm session associated with a Job and normally with one state run |
| Transition | Atomic movement from one official state to another |
| External wait | Dehydrated execution waiting for a system process, event, or timer |
| Human wait | Dehydrated execution waiting for a person while the Job remains in its current state |
| Attention request | Durable indication that named humans or principals are blocking progress |

The state machine belongs to the Job. A session is execution history for a
state run; it is not the Job itself and does not own authoritative Job state.

## Authoring model

### Files

An authored lifecycle starts with one root file and one file per authored
state:

```text
Example.job.md
Example.WorkDetailsGathered.md
Example.Diagnosed.md
```

The root file identifies the initial state and, when required by policy, the
handoff to another lifecycle fragment:

```markdown
# Example lifecycle

## Initial state

[WorkDetailsGathered](./Example.WorkDetailsGathered.md)

## Platform handoff

`FixProposed`
```

A state file contains the instructions for that state and its possible next
states:

```markdown
# Work details gathered

Review the available details. Ask the user for any information required to
confirm a diagnosis.

## Possible next states

- [Diagnosed](./Example.Diagnosed.md) - the diagnosis is supported.
- [WorkDetailsGathered](./Example.WorkDetailsGathered.md) - more details are required.
```

Local Markdown links identify states owned by the same fragment. A declared
handoff state may be referenced by its canonical state name without requiring
the author to provide a file for that state.

### Authors describe outcomes, not tools

Lifecycle authors describe:

- What the agent should accomplish in the state.
- When human input is required.
- What evidence should be preserved.
- Which outcomes are possible.

Authors do not instruct portal users to perform transitions, and they do not
need to mention the runtime transition tool. During execution, the runtime
injects a `complete_state` tool whose allowed outcomes are derived from the
compiled graph.

### Ownership and composition

State ownership is policy, not compiler behavior. For example, one policy may
define:

```text
User-authored diagnostic fragment:
  WorkDetailsGathered <-> Diagnosed -> FixProposed

Platform-owned delivery profile:
  FixProposed -> ... -> Integrated
```

Under that policy:

- The user owns instructions and outgoing transitions before `FixProposed`.
- `FixProposed` is the handoff boundary.
- The platform owns instructions and transitions from `FixProposed` onward.
- A user-authored `FixProposed.md` or `Integrated.md` is rejected.

This is not a universal compiler restriction. Another policy can select a
different handoff, different owned states, or allow a fully user-defined
machine.

## Compilation and publication

Publication converts mutable repository content into an immutable effective
lifecycle.

```text
Lifecycle source coordinates
          |
          v
Resolve Git ref to commit
          |
          v
Load root and linked Markdown files
          |
          v
Parse states, instructions, and transitions
          |
          v
Apply lifecycle policy and ownership rules
          |
          v
Compose selected lifecycle profiles
          |
          v
Validate the effective graph
          |
          v
Snapshot content, normalized graph, and digest
          |
          v
Publish immutable JobGeneratorDefinition
```

### Compiler responsibilities

The generic compiler must:

- Resolve and normalize state identities.
- Parse the initial-state link.
- Parse local next-state links.
- Parse a declared external handoff state.
- Reject duplicate or ambiguous state definitions.
- Reject missing local link targets.
- Prevent links from escaping the lifecycle source directory.
- Detect unreachable states.
- Detect nonterminal states with no outgoing transition.
- Validate terminal-state rules.
- Produce stable outcome keys for runtime tools.
- Produce a deterministic normalized graph and digest.

### Policy responsibilities

The selected lifecycle policy must:

- Define which lifecycle profiles may be selected.
- Define the official state catalog, when one is required.
- Define which principals may author each state or fragment.
- Define required entry and handoff states.
- Define whether authored states may override profile states.
- Define whether complete user-owned state machines are permitted.
- Define administrative transitions such as cancellation independently of
  user-authored business transitions.

### Profile registry responsibilities

The profile registry stores versioned lifecycle fragments, for example:

```text
standard-fix-delivery@1
repository-specific-triage@2
custom-only@1
```

A profile contains normalized state definitions, instructions, transitions,
ownership metadata, and a digest. Updating a profile creates a new version;
it does not mutate definitions or Jobs pinned to an older profile.

### Published lifecycle snapshot

The immutable JobGeneratorDefinition should retain:

```json
{
  "lifecycle": {
    "source": {
      "repository": "service-repo",
      "requestedGitRef": "refs/heads/users/demo/lifecycle",
      "resolvedCommit": "<commit>",
      "rootPath": "automation/lifecycles/Example.job.md",
      "digest": "<source-digest>"
    },
    "policy": {
      "name": "diagnostic-extension",
      "version": 1
    },
    "profiles": [
      {
        "name": "standard-fix-delivery",
        "version": 1,
        "digest": "<profile-digest>"
      }
    ],
    "effectiveGraph": {
      "entryState": "WorkDetailsGathered",
      "states": {}
    },
    "digest": "<effective-lifecycle-digest>"
  }
}
```

Runtime execution reads the snapshot. It does not fetch or reparse the branch
on every state run.

## Required components

| Component | Responsibility |
|---|---|
| Lifecycle source client | Resolve Git refs and read lifecycle files using service authentication |
| State-machine compiler | Parse Markdown and produce a deterministic normalized graph |
| Lifecycle policy evaluator | Enforce state catalogs, ownership, profiles, and extension boundaries |
| Lifecycle profile registry | Store versioned platform and repository state-machine fragments |
| Lifecycle publisher | Compose and snapshot the effective lifecycle into a definition |
| JobGenerator controller | Discover records, reconcile exactly-once Jobs, and initialize lifecycle execution |
| Job catalog | Store current state, revisions, leases, runs, transitions, and session associations |
| State-run worker | Execute one leased state run and create or resume its JobSession |
| Session runtime | Run agent instructions and provide durable wait and `ask_user` suspension |
| External-operation adapters | Start and observe builds, tests, deployments, and other asynchronous system work |
| Transition tool | Request one compiler-approved state outcome |
| Attention dispatcher | Persist, deduplicate, deliver, and resolve human-attention notifications |
| Portal | Register lifecycle sources and display state, waits, ownership, attention, and history |

These are logical responsibilities. They do not all require separate services.
The compiler and publisher can live with the management API, and state-run
leasing can use the existing PostgreSQL catalog. Attention delivery should use
a durable outbox so a notification failure cannot roll back or duplicate a
Job-state transaction.

## End-to-end Job lifecycle

### 1. Register and publish a JobGenerator

The author supplies:

- Source-provider configuration, such as a WIQL query.
- Cadence and guardrails.
- Repository and Git-ref affinities.
- Lifecycle source repository, Git ref, and root path.
- A lifecycle policy or profile selection when it is not supplied by a
  platform default.

The server resolves the lifecycle source, compiles and validates it, composes
the selected profiles, and publishes an immutable JobGeneratorDefinition.

### 2. Discover source records

The JobGenerator controller leases a due generator, evaluates its source
provider, and reconciles discoveries. Database uniqueness on
`(generator_id, job_key)` continues to make this exactly-once across retries.

### 3. Initialize a Job

A newly materialized Job is pinned to the active immutable definition and
initialized with:

```text
current_state = effectiveLifecycle.entryState
state_revision = 1
```

The controller or state-run coordinator reserves the first state run. The
source provider is no longer required for that Job to continue through its
lifecycle.

### 4. Lease and execute a state run

Any eligible worker may lease the runnable state run. The worker:

1. Loads the Job and its pinned effective lifecycle.
2. Loads the current state's snapshotted instructions.
3. Creates or resumes the JobSession associated with the state run.
4. Injects the runtime state-completion protocol.
5. Executes the session.

Workers perform execution but do not decide which transitions are valid. The
catalog and pinned graph remain authoritative.

### 5. Perform active work or wait durably

A state run may alternate between three execution modes:

| Mode | Examples | Worker retained? | Human blocking? |
|---|---|---|---|
| Active execution | LLM prompt, local tool, short API call | Yes, while the call runs | No |
| External wait | Build completion, validation completion, port to a branch, deployment completion, timer | No | No |
| Human wait | Diagnosis confirmation, approval, missing information | No | Yes |

An active LLM or tool call consumes a worker while that call is running. When
the state must wait for an asynchronous system process, the runtime persists
the external reference and wake condition, checkpoints the workflow, releases
the worker, and schedules or subscribes to a durable wake-up. A build or test
does not require an agent loop to remain alive and poll in memory.

Examples of durable wake conditions include:

- A submitted build reaches a terminal status.
- A validation or test suite completes with recorded results.
- A change or fix is present on the required target branch.
- A deployment containing the change completes in the target environment.
- A callback or event arrives for a correlation ID.
- A durable polling timer expires.
- A retry or deadline timer becomes due.
- A human submits an answer.

These waits should be expressed as durable predicates over external evidence,
not as workers sleeping until a command finishes. For example, a port wait may
track a source commit, target repository, and target branch until the required
change is observed there. A deployment wait may track an artifact or commit
through a deployment system until the intended environment reports completion.

On wake-up, any eligible worker may lease and resume the state run from its
persisted state.

### 6. Wait for human input and request attention

If state instructions require human input, the agent invokes the existing
durable `ask_user` tool.

```text
Job current state: WorkDetailsGathered
State run: input_required
Session: input_required
Broad Job status: blocked
```

The Job has not transitioned. The worker releases the execution lease and may
process other work. The pending question remains owned by the durable session.

Entering `input_required` also creates or updates a durable attention request
for the responsible principals. An attention dispatcher writes notifications
through configured adapters, such as email or a messaging webhook. Delivery is
idempotent for the Job, state revision, and pending question so worker retries
do not repeatedly notify the same person.

The portal displays the blocked Job in an attention queue and uses the existing
session answer path. A user may act from a notification deep link or discover
the work by monitoring the dashboard. After the user answers, the attention
request is resolved and any worker can lease and resume the same state run and
session.

### 7. Complete a state

The runtime generates an internal tool contract from the current state's
allowed outcomes:

```text
complete_state(
  outcome: one of the compiled outcome keys,
  reason: string,
  evidence?: object
)
```

Neither the lifecycle author nor the portal user invokes this tool directly.
The agent invokes it after satisfying the state instructions.

The server maps the outcome key to a destination from the immutable graph. It
then applies the transition with a state-revision compare-and-swap. If the
state or revision changed, the request is stale and fails without modifying
the Job.

If an agent returns prose without successfully invoking `complete_state`, the
state remains incomplete. The platform does not infer a transition from text.

### 8. Enter the next state

A successful transition:

- Appends a Job transition record.
- Completes the source state run.
- Updates the Job's current state and revision.
- Reserves the next state run when the destination is nonterminal.
- Projects the new state into JobGenerator hierarchy reads.

The next state normally receives a new JobSession. This keeps state execution
history ordered and lets each session retain the exact instructions and tools
used for that state revision. A human wait resumes the existing session for
the same state run rather than creating a new one.

### 9. Cross an ownership boundary

When a Job enters a handoff state, the effective graph selects the instructions
owned by the next fragment or profile. Workers execute user-owned and
platform-owned states through the same mechanism. Ownership affects
publication and portal attribution, not the worker protocol.

For example:

```text
Diagnosed --complete_state--> FixProposed
  user-owned                   platform-owned
```

The Job remains pinned to the profile version composed at publication time.

### 10. Reach a terminal state

Entering a terminal state atomically:

- Records the final transition.
- Completes the previous state run.
- Sets the Job's official current state to the terminal state.
- Sets the broad Job lifecycle status to `completed` or `cancelled`.
- Prevents additional state runs from being leased.

A terminal state may have platform-authored Markdown for documentation or
entry behavior, but it does not require an agent session when no work must be
performed after entry.

## Worker responsibility

Each worker executes the state run it has leased. A worker is responsible for:

- Loading the pinned instructions and transition contract.
- Creating or resuming the associated JobSession.
- Running the agent turn.
- Surfacing durable external and human-input suspension.
- Calling catalog operations on behalf of injected tools.
- Reporting explicit execution failures.

A worker is not responsible for:

- Mutating the effective lifecycle.
- Accepting arbitrary destination state names.
- Deciding ownership policy.
- Keeping state only in memory.
- Holding a worker slot during an external or human wait.
- Advancing a state based solely on an agent's final text.
- Overwriting a transition committed by another worker.

The worker that starts a state run does not need to be the worker that resumes
or completes it.

## State and status model

The official state machine and broad operational status answer different
questions.

| Field | Example | Purpose |
|---|---|---|
| `current_state` | `WorkDetailsGathered` | Official business lifecycle position |
| `state_revision` | `3` | Concurrency and idempotency fence |
| `lifecycle_state` | `blocked` | Broad operational status for scheduling and UI |
| State-run status | `waiting` or `input_required` | Execution status of the current state revision |
| Session status | `input_required` | Durable orchestration status and pending question |

While a human-input gate blocks `WorkDetailsGathered -> Diagnosed`, the Job
remains in `WorkDetailsGathered`. `blocked` is an operational status, not an
official business state. An external-system wait is also dehydrated but does
not imply that a human is blocking the Job. A nonhuman wait may retain the
broad Job lifecycle status `active` while the state-run status is `waiting`;
only an unresolved human-input dependency projects the Job as `blocked`.

## Persistence model

### Jobs

Extend the existing Jobs table with:

```text
current_state
state_revision
current_state_entered_at
```

The existing broad `lifecycle_state` remains useful for values such as
`pending_session`, `active`, `blocked`, `completed`, and `cancelled`.

### State runs

Add an append-oriented `job_state_runs` table:

```text
state_run_id
job_id
definition_id
state_name
state_revision
state_owner
status
session_id
attempt
wait_kind
wait_reason
wait_started_at
external_reference
lease_owner
lease_expires_at
started_at
completed_at
error
```

There is at most one active state run for a Job state revision. A session ID is
reserved before starting session execution so retries retain a durable
association.

`wait_kind` distinguishes external-system, timer, and human-input waits.
System-specific correlation data belongs in `external_reference`; credentials
and secrets do not.

### Transitions

Add an append-only `job_transitions` table:

```text
transition_id
job_id
definition_id
from_state
to_state
from_revision
to_revision
state_run_id
session_id
outcome
reason
evidence
idempotency_key
transitioned_at
```

The transition and Job update occur in one database transaction. A unique
idempotency key prevents a replayed tool call from creating duplicate history.

### Atomic transition

The authoritative update follows compare-and-swap semantics:

```sql
UPDATE jobs
SET current_state = :to_state,
    state_revision = state_revision + 1,
    current_state_entered_at = now(),
    updated_at = now()
WHERE job_id = :job_id
  AND current_state = :from_state
  AND state_revision = :expected_revision;
```

The transaction must also verify that the pinned effective graph contains the
requested edge. A zero-row update indicates a stale or competing transition.

### Attention requests

Add a durable attention-request and notification-outbox model:

```text
attention_request_id
job_id
state_run_id
session_id
state_revision
blocking_principal
question
status
deduplication_key
created_at
resolved_at

notification_outbox_id
attention_request_id
channel
destination_reference
status
attempt
next_attempt_at
delivered_at
```

The transaction that marks a Job blocked creates the attention request and
outbox record. Delivery happens asynchronously. Resolving the pending question
closes the attention request even if one notification channel is temporarily
unavailable.

## API surfaces

The management API needs:

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api/v1/job-generator-lifecycles/validate` | Resolve and preview a lifecycle without publishing |
| `POST` | `/api/v1/job-generators` | Register a generator and publish definition version 1 |
| `POST` | `/api/v1/job-generators/{id}/definitions` | Publish a new immutable definition and lifecycle snapshot |
| `GET` | `/api/v1/job-generator-definitions/{id}` | Read source coordinates, profiles, graph, and digest |
| `GET` | `/api/v1/jobs/{id}` | Read current state, revision, status, and active state run |
| `GET` | `/api/v1/jobs/{id}/transitions` | Read ordered transition history |
| `GET` | `/api/v1/jobs/{id}/state-runs` | Read state execution and session history |
| `GET` | `/api/v1/attention-requests` | List unresolved work blocking the current principal |

The existing session messaging endpoint remains the way portal users answer
`ask_user`. There is no public endpoint that lets a user directly force an
arbitrary Job transition.

Internal catalog operations are also required for:

- Reserving and leasing state runs.
- Acknowledging state-run execution.
- Marking a state run as waiting or failed.
- Completing a state with an allowed outcome.
- Recovering expired state-run leases.
- Creating and resolving attention requests.
- Claiming and completing notification-outbox deliveries.

## Portal experience

### Registration

The registration form should collect:

```text
Lifecycle repository
Git ref
Root lifecycle file
Lifecycle policy/profile
```

Validation preview should show:

- Resolved commit.
- User-authored states.
- Composed profile states.
- State ownership.
- Initial and handoff states.
- Effective transition graph.
- Validation failures.

The server reloads and validates the source during publication even if the
portal already displayed a successful preview.

### Job hierarchy

The portal should show:

```text
Current official state
Broad operational status
State owner
Pending transition or outcome
Pending human question
Current state session
Pinned lifecycle digest
Transition history
```

An input-required Job could appear as:

```text
State: WorkDetailsGathered
Owner: User lifecycle
Status: Blocked
Pending: Diagnosed
Action: Answer required
```

### Attention dashboard

The portal should provide a principal-scoped view of unresolved attention
requests:

```text
Blocked Jobs
  Job
  Generator
  Current state
  Blocking question
  Waiting since
  Deadline or escalation
  Open session
```

The dashboard is the authoritative pull experience. Notification channels are
the push experience and should deep-link to the same Job and pending question.
Users are not expected to monitor every autonomous Job or manually approve
ordinary state transitions.

After a handoff:

```text
State: FixProposed
Owner: standard-fix-delivery@1
Status: Active
```

## Reliability and recovery

### Worker failure

State-run leases expire. Another worker can reclaim the run and use its durable
session association and stable message IDs to resume or safely retry.

### Human waits

The session persists the pending question. No worker lease is held while the
session is `input_required`. Answering the question makes the same state run
runnable again. The attention request and notification outbox make the wait
discoverable without making notification delivery part of session correctness.

### External-system waits

The durable state run records the operation correlation and wake condition.
Callbacks, event consumers, or scheduled polling make the run eligible again.
No worker is pinned while waiting for the external system.

### Duplicate tool calls

The transition idempotency key returns the already-committed result. A
different transition for the same state revision fails the compare-and-swap.

### Definition updates

Publishing a new JobGeneratorDefinition affects only subsequently materialized
Jobs. Existing Jobs continue using their pinned source commit, profile
versions, effective graph, and digest.

### Source disappearance

Once materialized, a Job continues independently of whether its source record
still matches the provider query. Source reconciliation cannot silently remove
or reset lifecycle state.

### Invalid agent completion

If the agent finishes without `complete_state`, the state run remains
incomplete and is handled according to retry guardrails. The runtime records an
explicit error rather than guessing a transition.

## Security and governance

- Lifecycle source reads use service or delegated repository authorization.
- Publication verifies that the registering principal may access the source.
- Paths are normalized and constrained to the lifecycle source directory.
- User content cannot replace a profile-owned state unless policy explicitly
  allows it.
- Runtime tools derive the Job identity from the session association, not tool
  arguments supplied by the agent.
- Transition targets come from the pinned effective graph.
- All state changes are audited in append-only transition history.
- Attention reads are scoped to the blocking principal or an administrator.
- Notification destinations are stored as protected references rather than
  embedding webhook secrets in lifecycle definitions.
- Point reads retain existing JobGenerator ownership and administrator checks.
- Secrets and source credentials are not stored in lifecycle snapshots.

## Example lifecycle

The initial demonstration uses a user-authored diagnostic fragment:

```text
WorkDetailsGathered <-> Diagnosed -> FixProposed
```

`WorkDetailsGathered` invokes durable `ask_user` before allowing the transition
to `Diagnosed`. The Job stays in `WorkDetailsGathered` while blocked. After the
answer, the session resumes, records evidence, and completes the state.

`Diagnosed` produces the demonstration result and hands off to a
platform-owned profile:

```text
FixProposed -> Integrated
```

The initial platform profile may use this minimal transition for plumbing
validation. A later version can insert additional standard delivery states
without changing the user fragment or the compiler.

The demonstration proves:

- Repository-authored Markdown publication.
- Branch-to-commit pinning.
- Exactly-once Job materialization.
- Worker-executed state runs.
- Durable external and human suspension with cross-worker resumption.
- Human-attention notification and dashboard discovery.
- Atomic, constrained transitions.
- User-to-platform lifecycle handoff.
- Terminal Job completion.

## Implementation sequence

1. Implement the compiler, lifecycle policy model, and profile registry.
2. Extend definition publication to resolve, compose, and snapshot lifecycle
   sources.
3. Add Job current-state fields, state runs, transitions, and catalog
   operations.
4. Extend workers to lease and execute state runs.
5. Inject `complete_state` and connect it to atomic catalog transitions.
6. Add durable external-wait projection and adapters for asynchronous system
   work.
7. Project existing `ask_user` suspension onto Job and state-run status.
8. Add attention requests, notification outbox delivery, and a blocked-work
   dashboard.
9. Add lifecycle registration, validation preview, and Job history to the
   portal.
10. Run the end-to-end demonstration and add integration coverage for restart,
   replay, stale revision, and ownership-boundary behavior.

These slices should remain independently deployable. The compiler and
persistence can land before workers execute state machines, and worker support
can land before the portal exposes the full lifecycle visualization.
