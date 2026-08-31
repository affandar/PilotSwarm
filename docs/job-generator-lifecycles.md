# JobGenerator lifecycle state machines

## Purpose and audience

This document defines the architecture and behavioral contract for publishing,
resolving, executing, and observing durable Job state machines. It is intended
for PilotSwarm architects and engineers implementing lifecycle source loading,
policy, persistence, workers, transitions, waits, notifications, APIs, and
portal experiences. It also provides profile owners and advanced lifecycle
authors with the conceptual model and ownership boundaries their definitions
must follow.

This is a forward-looking design rather than an operations guide or a
step-by-step end-user authoring tutorial. The currently implemented
JobGenerator discovery, materialization, provider, and controller behavior is
documented in [JobGenerator controller](./job-generators.md).

## Status

This document describes the target lifecycle architecture for durable Jobs
created by a JobGenerator. The current implementation includes Job discovery,
exactly-once materialization, definition pinning, state runs, JobSession
history, Markdown-backed state execution, the Job journal, constrained atomic
transitions, durable Job waits, and infrastructure-owned external
operations. Lifecycle policy and semantic whole-graph validation remain future
work.

### Current MVP live-source mode

The MVP intentionally resolves a lifecycle source's mutable `requestedRef`
when each new state run begins so authors can iterate on Markdown without
publishing a complete immutable lifecycle version. The resolved commit, source
path, and Markdown digest are stored on that state run. Retries, waits, and
replacement workers reuse that durable snapshot even if the branch moves;
only a subsequently entered state resolves the ref again.

This is a temporary scope choice, not a relaxation of Job durability. Job
state, revision, state-run/session association, journal context, and required
work-product references remain durable and worker-independent. Full
Job-lifetime lifecycle, profile, and policy version pinning remains the target
publication model described below.

Successor sessions receive ordered journal summaries and can call
`read_job_source_session` with a journal entry's source Session ID to page
through that prior session's durable execution events. The catalog authorizes
the read from the current JobSession association and exposes only sessions
already referenced by the same Job's journal.

## Summary

A JobGenerator discovers source records and materializes durable Jobs. Each Job
then progresses through a durable state machine. State instructions are
authored as Markdown and remain in their separate user and platform sources.
In the current MVP mode, each new state run resolves the latest requested ref
and records the exact commit and digest it executes. When a worker activates
or resumes that run, it loads only the recorded file matching the Job's durable
current state.

The state loader is generic. It does not hardcode a particular state machine or
repository. Each resolved source provides a safe base path and filename prefix,
so the current state resolves conventionally to
`<basePath>/<filePrefix>.<state>.md`. Lifecycle profiles and policies will
determine which states exist, who may author them, and where extension
boundaries occur.

The Markdown files are the source of truth. The platform does not copy user and
platform files into a combined package or publish a compiled state-machine JSON
artifact. A later validation layer may parse pinned Markdown into an in-memory
or cached normalized graph.

Workers execute state runs, but the catalog remains authoritative for leases,
allowed transitions, state revisions, idempotency, and history. A worker may
disappear while a Job is parked on a response, observed-condition, or timer
wait; another worker can later resume the same durable state run.

## TL;DR

1. The platform defines reusable state-machine profiles with explicit
   extension points that repositories and users can plug into.
2. A user supplies the domain-specific behavior for the extension points they
   are allowed to control, such as how to diagnose and propose a fix for a
   particular class of bug.
3. The platform pins the user source and selected profile versions without
   copying their Markdown into a combined artifact.
4. Workers execute the concrete state machine autonomously. The catalog, not
   an individual worker, remains authoritative for state and transitions.
5. Execution alternates between active work, such as LLM prompts and tools,
   and durable response, observed-condition, or timer waits.
6. Workflows dehydrate during waits. They do not retain a worker, process, or
   in-memory call stack while waiting, and any eligible worker may resume them
   after the wake condition is satisfied.
7. Human participation does not define a wait kind. A response submitted
   through PilotSwarm satisfies a response wait; a human action recorded in an
   authoritative provider satisfies an observed-condition wait.

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
- Dehydrate workflows during response, observed-condition, and timer waits.
- Reuse durable session suspension for response waits.
- Enforce transitions atomically in the catalog.
- Preserve a durable Job journal between state runs so knowledge learned in one
  state is available to the next.
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
| Lifecycle state source | Immutable user or platform source containing conventionally named state Markdown |
| Effective lifecycle | Pinned state sources, policy, profile versions, and any validated runtime projection used by a Job |
| State run | One durable attempt to execute one Job state at one state revision |
| JobSession | PilotSwarm session associated with a Job and normally with one state run |
| Transition | Atomic movement from one official state to another |
| Job journal | Ordered, append-only history whose state-transition entries carry a concise `summary` and source-session reference |
| Job wait | Durable condition that parks a state run without retaining a worker |
| Response wait | Job wait satisfied by an authorized response submitted directly through PilotSwarm |
| Observed-condition wait | Job wait satisfied when PilotSwarm verifies a predicate in another authoritative system |
| Timer wait | Job wait satisfied when a durable time condition is reached |
| Detection mode | How PilotSwarm learns a wait may be satisfied: direct submission, polling, provider event, or hybrid |
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
- What should be captured in the transition summary.
- Which outcomes are possible.

Authors do not instruct portal users to perform transitions, and they do not
need to mention the runtime transition tool. During execution, the runtime
injects a `complete_state` tool whose allowed outcomes are derived from the
validated transition contract when that later validation layer is implemented.

### Ownership and composition

State ownership is policy, not loader behavior. For example, one policy may
define:

```text
User-authored diagnostic fragment:
  WorkDetailsGathered <-> Diagnosed -> FixProposed

Platform-owned delivery profile:
  FixProposed -> AutomatedCodeReviewApproved -> Validated -> PRPublished
      -> HumanCodeReviewApproved -> Committed
       |
       +-- significant findings --> Diagnosed
```

Under that policy:

- The user owns instructions and outgoing transitions before `FixProposed`.
- `FixProposed` is the handoff boundary.
- The platform owns instructions and transitions from `FixProposed` onward.
- A user-authored platform state such as `FixProposed.md` or `PRPublished.md`
  is rejected.

This is not a universal loader restriction. Another policy can select a
different handoff, different owned states, or allow a fully user-defined
machine.

## State source resolution, validation, and publication

Publication converts mutable repository and platform content into an immutable
definition by resolving mutable refs to immutable source coordinates. It does
not copy or assemble the state files:

```text
Job current state + pinned user/platform sources
                       |
                       v
Derive one <filePrefix>.<state>.md candidate per source
                       |
                       v
Read the exact file from each immutable source
                       |
                       v
Require exactly one match and execute that Markdown
```

For example, a Job in `FixProposed` may probe
`HelloWorld.FixProposed.md` in its pinned user source and
`StandardFix.FixProposed.md` in its pinned platform profile. If only the
platform file exists, that exact file is executed. A missing state or a state
present in multiple sources is an explicit error.

The source reader returns `null` only when the candidate file is absent. Access,
network, authentication, and source-integrity failures propagate rather than
being treated as absence. Loaded Markdown retains its original content and line
endings and may be cached by immutable source identity, path, and content
digest.

### State loader responsibilities

The initial generic loader must:

- Accept the durable current state and pinned user/platform source metadata.
- Derive a conventional candidate path for only that state in each source.
- Reject duplicate or ambiguous state definitions.
- Reject unsafe source-relative paths and filename prefixes.
- Preserve exact Markdown content and line endings.
- Return the owner, immutable source coordinates, source path, and content
  digest with the loaded Markdown.
- Distinguish a missing file from a source-read failure.

The loader deliberately does not:

- List or load unrelated state files.
- Copy user and platform files into a combined package.
- Parse `## Possible next states`.
- Validate transition targets, reachability, terminals, or handoffs.
- Enforce lifecycle profile ownership policy.
- Produce or persist a compiled graph JSON document.

### Deferred semantic validation

A later publication stage may:

- Parse the initial-state link from the root lifecycle document.
- Parse local next-state links and declared external handoffs.
- Reject missing local link targets.
- Detect unreachable states.
- Detect nonterminal states with no outgoing transition.
- Validate terminal-state and ownership rules.
- Produce stable outcome keys for runtime tools.

Any normalized graph produced for these operations is a derived projection of
the pinned Markdown sources, not a second authoring or storage contract.

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

A profile contains immutable state Markdown, a filename prefix, ownership
metadata, and a version or digest. Updating a profile creates a new version; it
does not mutate definitions or Jobs pinned to an older profile.

### Published lifecycle pins

The immutable JobGeneratorDefinition should retain:

```json
{
  "lifecycle": {
    "name": "Example",
    "initialState": "WorkDetailsGathered",
    "policy": {
      "name": "diagnostic-extension",
      "version": 1
    },
    "sources": [
      {
        "sourceId": "example-user",
        "owner": "user",
        "filePrefix": "Example",
        "basePath": "automation/lifecycles/example",
        "kind": "github",
        "repositoryUrl": "https://github.com/example/service-repo",
        "requestedRef": "refs/heads/users/demo/lifecycle",
        "resolvedCommit": "<commit>",
        "digest": "<source-digest>"
      },
      {
        "sourceId": "standard-fix-delivery@1",
        "owner": "platform",
        "filePrefix": "StandardFix",
        "basePath": "profiles/standard-fix",
        "kind": "ado",
        "repositoryUrl": "https://dev.azure.com/example/platform/_git/lifecycle-profiles",
        "resolvedCommit": "<commit>",
        "version": 1,
        "digest": "<profile-digest>"
      }
    ],
    "digest": "<effective-lifecycle-digest>"
  }
}
```

Runtime execution reads files only from these immutable pins. It never reads
the mutable branch represented by `requestedGitRef`; source clients may cache
files by the resolved commit or profile version.

## Required components

| Component | Responsibility |
|---|---|
| Lifecycle source client | Resolve Git refs and read lifecycle files using service authentication |
| Lifecycle state loader | Resolve and read the one pinned `Prefix.State.md` needed by an activated worker |
| Lifecycle semantic validator | Later parse and validate transitions as a derived runtime projection |
| Lifecycle policy evaluator | Enforce state catalogs, ownership, profiles, and extension boundaries |
| Lifecycle profile registry | Store versioned platform and repository state-machine fragments |
| Lifecycle publisher | Resolve mutable refs and pin source, profile, policy, and entry-state metadata in a definition |
| JobGenerator controller | Discover records, reconcile exactly-once Jobs, and initialize lifecycle execution |
| Job catalog | Store current state, revisions, leases, runs, transitions, and session associations |
| State-run worker | Execute one leased state run and create or resume its JobSession |
| Session runtime | Run agent instructions and provide durable wait and `ask_user` suspension |
| External-operation adapters | Start and observe builds, tests, deployments, and other asynchronous system work |
| Transition tool | Request one validator-approved state outcome |
| Attention dispatcher | Persist, deduplicate, deliver, and resolve human-attention notifications |
| Portal | Register lifecycle sources and display state, waits, ownership, attention, and history |

These are logical responsibilities. They do not all require separate services.
The loader, validator, and publisher can live with the management API or worker
SDK, and state-run leasing can use the existing PostgreSQL catalog. Attention
delivery should use a durable outbox so a notification failure cannot roll
back or duplicate a Job-state transaction.

## End-to-end Job lifecycle

### 1. Register and publish a JobGenerator

The author supplies:

- Source-provider configuration, such as a WIQL query.
- Cadence and guardrails.
- Repository and Git-ref affinities.
- Lifecycle source repository, Git ref, and root path.
- A lifecycle policy or profile selection when it is not supplied by a
  platform default.

The server resolves mutable lifecycle refs, pins the selected policy and
profile versions, and publishes an immutable JobGeneratorDefinition. Semantic
graph validation may be added as a later publication step.

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

1. Loads the Job and its pinned lifecycle sources.
2. Derives the current state's candidate path in each source and loads the
   exact Markdown from the one source that supplies it.
3. Creates or resumes the JobSession associated with the state run.
4. Injects the runtime state-completion protocol.
5. Executes the session.

Workers perform execution but do not decide which transitions are valid. The
catalog and pinned graph remain authoritative.

### 5. Perform active work or wait durably

A state run may alternate between active execution and three durable Job wait
kinds. Classify the wait by how completion becomes authoritative, not by
whether a human or automation performs the surrounding action:

| Mode | Satisfaction contract | Examples | Worker retained? |
|---|---|---|---|
| Active execution | The current worker completes an LLM, tool, or short API call | Prompt execution, local tool | Yes, while the call runs |
| Response wait | An authorized response is submitted directly through PilotSwarm | Resolve an ambiguity, select an option | No |
| Observed-condition wait | PilotSwarm verifies a predicate in another authoritative system | Build, validation, review approval, PR completion, deployment | No |
| Timer wait | A durable time condition is reached | Retry backoff, scheduled wake-up, deadline | No |

When a state must wait, the runtime checkpoints the workflow, releases the
worker, and resumes only through the corresponding durable boundary:

- `ask_user` persists a response wait owned by the JobSession.
- `start_external_operation` and `system_wait` persist an
  observed-condition wait whose result and evidence are owned by the state
  run.
- The durable scheduler makes a timer wait runnable after its time condition
  is reached.

Detection mode is separate from wait kind. A response normally arrives by
direct submission. An observed condition may be detected by polling, a
provider event, or a hybrid in which events accelerate detection and polling
guarantees reconciliation. A webhook about PR approval remains an
observed-condition wait because the repository provider, not the webhook, is
authoritative.

A person reviewing or completing a PR acts outside the JobSession, so those
are observed-condition waits rather than response waits. A build, test,
reviewer, or PR owner does not require an agent loop to remain alive and poll
in memory.

Examples of durable wake conditions include:

- A submitted build reaches a terminal status.
- A validation or test suite completes with recorded results.
- An automated code review finishes.
- Required human code-review approval appears in the repository provider.
- An authorized person completes or merges the pull request.
- A change or fix is present on the required target branch.
- A deployment containing the change completes in the target environment.
- A callback or event arrives for a correlation ID.
- A durable polling timer expires.
- A retry or deadline timer becomes due.
- An authorized person submits an answer through the session.
- A person or automation performs the requested action in an external system.

Observed-condition waits should be expressed as durable predicates over
external evidence, not as workers sleeping until a command finishes. For
example, a port wait may track a source commit, target repository, and target
branch until the required change is observed there. A deployment wait may
track an artifact or commit through a deployment system until the intended
environment reports completion.

On wake-up, any eligible worker may lease and resume the state run from its
persisted state.

### 6. Resolve each Job wait through its authoritative boundary

If state instructions require an answer inside the JobSession, the agent
invokes the existing durable `ask_user` tool. This is a response wait:

```text
Job current state: WorkDetailsGathered
State run: input_required
Session: input_required
Broad Job status: blocked
```

The Job has not transitioned. The worker releases the execution lease and may
process other work. The pending question remains owned by the durable session.

The portal presents the pending question and uses the existing session answer
path. After the user answers, any worker can lease and resume the same state
run and session.

For example, the Job owner may need to resolve an ambiguity or select among
explicit options before work can continue. PilotSwarm validates the submitted
response against the pending wait identity, responder policy, expected answer
shape, and Job state revision before making the state run runnable.

For an observed-condition wait, the state records the provider, target
resource, completion predicate, and polling cursor in its durable context,
then invokes `system_wait` with the signal key assigned to that observation.
A PilotSwarm observer claims due checks, polls the provider, persists current
evidence, and publishes the matching signal only after the predicate is
satisfied.

Observed-condition waits include:

- Waiting for builds.
- Waiting for validation.
- Waiting for automated code review.
- Waiting for human code review recorded in the repository provider.
- Waiting for an authorized person to complete or merge a pull request.

The last two remain observed-condition waits because the action occurs outside
PilotSwarm and a provider observer verifies it. No artificial `ask_user`
question is created. The portal should label the predicate specifically, such
as `Awaiting human code review` or `Awaiting PR completion`.

`HumanCodeReviewApproved` is a lifecycle state reached after review approval;
it is not itself a wait type. A subsequent transition from
`HumanCodeReviewApproved` to `Committed` uses a separate observed-condition
wait for PR completion.

A timer wait stores its time condition and deadline in durable state. The
scheduler, rather than a provider observer or submitted response, makes the
state run runnable when that condition is reached.

#### Current implementation status

Response waits are projected into the canonical durable `JobWait` model when a
JobSession invokes `ask_user`. The wait records the owning Job and state run,
expected state revision, question, allowed choices, responder policy, and
direct-submission detection mode. Answer submission satisfies that record
before resuming the durable session; stale, invalid, or duplicate submissions
are rejected, and a failed queue delivery reopens the same wait. Delivery state
is recorded as `pending` or `enqueued` so the acceptance-to-enqueue boundary is
observable. A process crash or ambiguous queue acknowledgement can still leave
a satisfied response in `pending`; a future scheduler/outbox recovery pass must
redrive that state before the platform can claim exactly-once response delivery.

The same model reserves `observed_condition` and `timer` kinds so portal and API
consumers use one taxonomy. The deterministic `mock` external-operation
provider remains the only implemented observed-condition producer today.
Provider-specific Azure DevOps observers and the durable due-work scheduler are
the next implementation slices.

### 7. Complete a state

The runtime generates an internal tool contract from the current state's
allowed outcomes:

```text
complete_state(
  outcome: one of the validated outcome keys,
  summary: string
)
```

Neither the lifecycle author nor the portal user invokes this tool directly.
The agent invokes it after satisfying the state instructions.

The server maps the outcome key to a destination from the immutable graph. It
then applies the transition with a state-revision compare-and-swap. If the
state or revision changed, the request is stale and fails without modifying
the Job.

State completion also produces one required text `summary`. The catalog writes
the summary as part of the same transaction that commits the transition. The
transition retains the concise context needed by the next state, while its
`session_id` links to the authoritative full execution record when additional
detail is needed. Structured evidence and artifact references are deferred.

If an agent returns prose without successfully invoking `complete_state`, the
state remains incomplete. The platform does not infer a transition from text.

### 8. Enter the next state

A successful transition:

- Appends a state-transition entry to the Job journal.
- Completes the source state run.
- Updates the Job's current state and revision.
- Reserves the next state run with a reference to the predecessor journal entry
  when the destination is nonterminal.
- Projects the new state into JobGenerator hierarchy reads.

The next state normally receives a new JobSession. This keeps state execution
history ordered and lets each session retain the exact instructions and tools
used for that state revision. Before executing the next state's Markdown, the
runtime injects the ordered Job journal, including each prior transition
summary and originating session reference. Workers can retrieve additional
detail from a durable source session when needed. A response wait resumes the
existing session for the same state run rather than creating a new one.

This handoff must not depend on an in-memory worker conversation. A different
worker must be able to start the next state after a restart and receive the
same persisted context.

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
- Surfacing durable response, observed-condition, and timer waits.
- Calling catalog operations on behalf of injected tools.
- Reporting explicit execution failures.

A worker is not responsible for:

- Mutating the effective lifecycle.
- Accepting arbitrary destination state names.
- Deciding ownership policy.
- Keeping state only in memory.
- Holding a worker slot during a Job wait.
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

While an interactive-input gate blocks `WorkDetailsGathered -> Diagnosed`, the
Job remains in `WorkDetailsGathered`. `blocked` is an operational status, not
an official business state. All durable waits project the broad Job lifecycle
status as `blocked`, which excludes the Job from runnable work.
`input_required` means the Job is waiting for an answer through the session.
`waiting` means it is waiting for an observed condition or timer. The matching
signal may represent either a machine-owned predicate, a human action observed
in another system, or a durable time condition. Resuming the same state run
returns the Job to `active`.

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
predecessor_journal_entry_id
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
association. Except for the initial state run,
`predecessor_journal_entry_id` identifies the journal entry that caused this
run to be created.

`wait_kind` distinguishes `response`, `observed_condition`, and `timer` waits.
Provider-specific correlation data belongs in `external_reference`;
credentials and secrets do not. Detection mode is recorded separately where
an observed condition supports polling, events, or hybrid reconciliation.

### Job journal

Add an ordered, append-only `job_journal_entries` table. The MVP requires
state-transition entries, while the journal can later support other durable Job
events:

```text
journal_entry_id
job_id
sequence
entry_kind
definition_id
from_state
to_state
from_revision
to_revision
state_run_id
session_id
outcome
summary
idempotency_key
transitioned_at
```

The journal append and Job update occur in one database transaction. A unique
idempotency key prevents a replayed tool call from creating duplicate history.
A state-transition journal entry is also the durable state-to-state handoff:

- `outcome` records the transition outcome used to select the destination.
- `summary` is the single free-form text field describing what the state
  learned or produced for the next state.
- `session_id` links to the full prompts, responses, tools, and pending or
  answered questions from the completed state when more detail is needed.

The next state runner loads the ordered Job journal before creating or resuming
its session. This makes prior summaries available across worker changes,
process restarts, and ownership handoffs.

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
| `POST` | `/api/v1/job-generators/{id}/definitions` | Publish a new immutable definition with pinned lifecycle sources |
| `GET` | `/api/v1/job-generator-definitions/{id}` | Read source coordinates, profiles, graph, and digest |
| `GET` | `/api/v1/jobs/{id}` | Read current state, revision, status, and active state run |
| `GET` | `/api/v1/jobs/{id}/journal` | Read the ordered Job journal |
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
- Loading the Job journal and referenced source-session context for a state run.
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
Previous-state transition summary
Pinned lifecycle digest
Job journal
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
When a transition has already committed, the successor run reconstructs its
input context from the Job journal and referenced source sessions rather than
from the failed worker's memory.

### Response waits

The session persists the pending question. No worker lease is held while the
session is `input_required`. Answering the question makes the same state run
runnable again. The attention request and notification outbox make the wait
discoverable without making notification delivery part of session correctness.

### Observed-condition waits

The agent starts platform-owned work through `start_external_operation`. The
catalog creates or returns the idempotent operation for the current state run
and generates its operation ID, provider correlation ID, and exact signal key;
the agent cannot supply or invent those identities. The agent then calls
`system_wait` with that returned key.

An external producer claims due operations, persists their result and evidence,
and delivers the matching signal through `sendSystemSignal`. Signal delivery
has its own durable lease, attempt count, retry time, and completion marker, so
producer restarts provide at-least-once delivery without duplicating the
external operation. Authoritative wait-started and wait-completed timestamps
live on the operation row; session events remain observational. Delivery waits
until the exact generated signal key is durably registered as parked.
Only the exact key thaws the wait; unrelated messages and mismatched signals do
not satisfy it. No worker is pinned while waiting for the external system.

The operation belongs to the state run, not to one disposable JobSession. If a
session is replaced before its wait completes, the same idempotent operation is
rebound to the state run's current session, delivery is re-armed, and the
immutable creating-session reference remains available for attribution.

After resumption the agent reads the durable record through
`get_external_operation`. An `external_operation` validation gate can prevent a
transition until a matching operation has succeeded, its signal has been
observed by the matching durable wait, and evidence has been persisted:

```json
{
  "type": "external_operation",
  "name": "PVS validation",
  "beforeState": "Validated",
  "provider": "mock",
  "kind": "pvs",
  "requireEvidence": true
}
```

`beforeState` names the destination state being protected. The initial
deterministic `mock` provider supports success and failure outcomes without
pretending that a real external service was called.

### Timer waits

The scheduler persists the wake time or deadline and makes the state run
runnable when the time condition is reached. A process does not sleep or
retain a worker while waiting. Repeated scheduler checks are idempotent and
cannot resume the same state revision twice.

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
- All state changes are audited in the append-only Job journal.
- State-to-state context uses concise journal summaries and source-session
  references; it does not copy secrets or entire session transcripts into
  every journal entry.
- Attention reads are scoped to the blocking principal or an administrator.
- Notification destinations are stored as protected references rather than
  embedding webhook secrets in lifecycle definitions.
- Point reads retain existing JobGenerator ownership and administrator checks.
- Secrets and source credentials are not stored in lifecycle source metadata.

## Example lifecycle

The initial demonstration uses a user-authored diagnostic fragment:

```text
WorkDetailsGathered <-> Diagnosed -> FixProposed
```

`WorkDetailsGathered` invokes durable `ask_user` before allowing the transition
to `Diagnosed`. The Job stays in `WorkDetailsGathered` while blocked. After the
answer, the session resumes, records a transition summary, and completes the
state.

`Diagnosed` produces the demonstration result and hands off to a
platform-owned profile:

```text
FixProposed -> AutomatedCodeReviewApproved -> Validated -> PRPublished
    -> HumanCodeReviewApproved -> Committed
     |
     +-- significant findings --> Diagnosed
```

Platform automation starts the configured code-review agent for `FixProposed`.
Significant findings return the Job to user-owned `Diagnosed`; otherwise the
state advances only when the latest review has no blocking findings. The
deterministic demonstration represents this review with a mock external
operation rather than launching a real review.

`AutomatedCodeReviewApproved` submits the reviewed commit to the Private
Validation Service exactly once through the external-operation interface. The
catalog records the provider correlation and generated signal key. Only the
matching completion signal thaws that state run, and the transition to
`Validated` is rejected until successful validation evidence is durable.

`Validated` prepares the change, pushes its branch, and publishes the pull
request before transitioning to `PRPublished`. The deterministic demonstration
uses a fictional URL and mock publication evidence rather than creating a real
pull request.

`PRPublished` uses an observed-condition wait for all required reviewers and
policies to approve the current source commit. It then enters
`HumanCodeReviewApproved`, which uses a separate observed-condition wait for an
authorized person to complete the pull request. Approval alone must never
complete it automatically. `Committed` is the terminal state and preserves the
pull-request and merge evidence.

The demonstration proves:

- Repository-authored Markdown publication.
- Branch-to-commit pinning.
- Exactly-once Job materialization.
- Worker-executed state runs.
- Durable response and observed-condition waits with cross-worker resumption.
- Infrastructure-generated external-operation identity and retryable signal delivery.
- Evidence-gated transitions that reject prose-only validation.
- Human-attention notification and dashboard discovery.
- Atomic, constrained transitions.
- User-to-platform lifecycle handoff.
- Terminal Job completion.

### Running the multi-Job demo

With the portal backend, JobGenerator controller, and a matching worker already
running, the standalone runner acts only as a portal user:

```powershell
python scripts\job-generator-lifecycle-demo.py `
  --repository-path C:\src\<lifecycle-repository> `
  --user-branch <user-lifecycle-branch> `
  --user-base-path <user-lifecycle-directory> `
  --platform-branch <platform-lifecycle-branch> `
  --platform-base-path <platform-lifecycle-directory> `
  --full-run `
  --response-wait-seconds 2 `
  --operation-delay-seconds 1 `
  <work-item-id> [<work-item-id> ...]
```

It canonicalizes legacy HTTPS or SSH Azure DevOps remotes, resolves both
lifecycle branches to immutable commits, registers the JobGenerator through
the portal API, and waits until every Job reaches the durable
`WorkDetailsGathered` response wait. It does not reset databases, build
components, launch services, control the browser, or stop backend processes.
Use `--portal-url` or `PILOTSWARM_PORTAL_URL` when the portal is not available
at `http://localhost:4311`.

During `--full-run`, `--response-wait-seconds` controls how long each Job
remains at its initial `ask_user` gate before the runner answers it. Jobs are
timed and answered independently, so one Job does not remain parked merely
because another has not reached the gate. `--operation-delay-seconds` controls
the `delayMs` requested from each deterministic mock automated-review, PVS,
pull-request publication, human-review, and PR-completion operation. Its
accepted range is 0 through 300 seconds. The previous
`--human-wait-seconds` and `--system-wait-seconds` names remain accepted as
hidden compatibility aliases.

Set `JOBGEN_MOCK_EXTERNAL_OPERATIONS=true` on the already-running JobGenerator
controller to enable the deterministic external-operation producer. Optional
`JOBGEN_MOCK_OPERATION_POLL_INTERVAL_MS` controls its poll interval.

## Implementation sequence

1. Implement exact current-state Markdown loading from separate pinned user and
   platform sources.
2. Implement the lifecycle policy model and versioned profile registry.
3. Extend definition publication to resolve and pin lifecycle source, profile,
   policy, and entry-state metadata.
4. Add Job current-state fields, state runs, transitions, and catalog
   operations.
5. Extend workers to lease state runs and execute the exact Markdown matching
   the Job's durable current state.
6. Add semantic graph validation, inject `complete_state`, and connect it to
   atomic catalog transitions.
7. Add durable external-wait projection and adapters for asynchronous system
   work.
8. Project existing `ask_user` suspension onto Job and state-run status.
9. Add attention requests, notification outbox delivery, and a blocked-work
   dashboard.
10. Add lifecycle registration, validation preview, and Job history to the
   portal.
11. Run the end-to-end demonstration and add integration coverage for restart,
   replay, stale revision, and ownership-boundary behavior.

These slices should remain independently deployable. State loading can land
before workers execute state machines, and worker support can land before the
portal exposes the full lifecycle visualization.
