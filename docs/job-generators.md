# JobGenerator controller

## Purpose and audience

This document is the implementation and operations reference for the existing
JobGenerator materialization subsystem. It is intended for PilotSwarm
engineers who maintain the controller and persistence layer, integrate with
the REST or SDK APIs, configure source providers, or run the controller.

It describes the currently implemented path from source evaluation through
exactly-once Job creation and initial JobSession induction. It is not an
authoring guide for lifecycle Markdown or a description of the future
state-machine user experience. Those concepts are covered by
[JobGenerator lifecycle state machines](./job-generator-lifecycles.md).

JobGenerator is a durable CMS aggregate that periodically evaluates an external
source and materializes one Job for each stable provider key. Definitions are
immutable versions; publishing a definition atomically makes it active.
Database uniqueness on `(generator_id, job_key)` makes reconciliation
exactly-once across retries and controller restarts.

A Job owns session history rather than being a session. `job_sessions` permits
many associations, keeps prior sessions, and uses a partial unique index to
allow at most one current session. Initial session IDs are reserved before the
PilotSwarm call. A failed call leaves the reservation retryable, and the
controller resends the bootstrap message with a stable client message ID.
Each Job is pinned to the immutable definition that first materialized it, so
session retries keep the same lifecycle and agent configuration even after a
new definition version becomes active.
Pending and failed initial sessions are retried from durable Job state even if
the source no longer returns that item. Session result writes are fenced by
the active generator lease and cycle owner so an expired worker cannot
overwrite a newer worker's result.

## REST API

`POST /api/v1/job-generators` atomically creates the mutable aggregate and
immutable definition version 1. The server ignores caller-supplied ownership
and stamps the authenticated principal.

```json
{
  "name": "HelloWorld",
  "cadenceSeconds": 300,
  "definition": {
    "sourceType": "example-source",
    "sourceConfig": {
      "filter": "active"
    },
    "lifecycleDefinition": {
      "expansionAgent": "helloworld-expand",
      "states": {
        "Greet": {
          "kind": "prompt",
          "prompt": "helloworld/greet"
        },
        "Done": {
          "kind": "auto"
        }
      },
      "blockingPrincipals": ["jobCreator"]
    },
    "affinities": {
      "repo": "service-repo",
      "gitRef": "main",
      "compute": ["devbox"],
      "model": "gpt-5.4"
    },
    "validationGates": [],
    "guardrails": {
      "maxOutstandingJobs": 5,
      "maxBlockedJobs": 2,
      "maxItemsPerCycle": 100,
      "maxAttemptsPerState": 3,
      "maxTotalSteps": 50
    }
  }
}
```

The owner-scoped read surface is:

| Method | Path | Result |
|---|---|---|
| `GET` | `/api/v1/job-generators` | Caller-owned generators; admins see all |
| `GET` | `/api/v1/job-generators/{id}` | Mutable aggregate |
| `GET` | `/api/v1/job-generators/{id}/definitions` | Immutable version history |
| `POST` | `/api/v1/job-generators/{id}/definitions` | Publish and activate a new definition version |
| `GET` | `/api/v1/job-generator-definitions/{id}` | One definition |
| `GET` | `/api/v1/job-generators/{id}/jobs` | Durable generated Jobs |
| `GET` | `/api/v1/job-generators/{id}/cycles` | Materialization history |
| `DELETE` | `/api/v1/job-generators/{id}` | Logically delete the generator and all induced Jobs |
| `GET` | `/api/v1/jobs/{id}` | One durable Job |
| `GET` | `/api/v1/jobs/{id}/sessions` | Ordered PilotSwarm session history |
| `DELETE` | `/api/v1/jobs/{id}` | Logically delete one Job without affecting its siblings |

Generator, definition, Job, and session-history reads require generator
ownership or admin role. An unauthorized point lookup returns `404`, avoiding
an existence oracle across users.

Deletion is owner-authorized and idempotent. A normal user may delete only a
generator they own or an individual Job induced by that generator; an
administrator may delete across owners. Deleted aggregates disappear from
normal list and point-read APIs. The service still resolves them internally
during a repeated delete so an interrupted cleanup can be retried by the
original owner without exposing the tombstone through the read surface.

## Persistence model

| Table | Responsibility | Key invariants |
|---|---|---|
| `job_generators` | Mutable registration, owner, cadence, state, watermark, counters, lease | Unique active owner/name; active definition belongs to the same generator |
| `job_generator_definitions` | Immutable source, lifecycle, affinities, validation, guardrails | Unique `(generator_id, version)`; update trigger rejects mutation |
| `job_generator_cycles` | One claimed evaluation/reconciliation pass | At most one running cycle per generator |
| `jobs` | Durable source-native work identity and lifecycle | Unique `(generator_id, job_key)`; pinned `definition_id` |
| `job_sessions` | Job-to-PilotSwarm execution history | Many per Job; globally unique session ID; at most one current |
| `job_state_runs` | One revision-fenced execution of a lifecycle state | Unique `(job_id, state_revision)`; one durable session association |
| `job_waits` | Canonical response, observed-condition, and timer wait state | Revision-fenced status; durable check leases, attempts, cursors, observations, deadlines, and wait boundaries |
| `job_external_operations` | Infrastructure-owned provider operation identity, evidence, and signal delivery | Idempotent per state run/provider/kind/key; generated correlation and signal keys; rebinds across session replacement |
| `job_journal_entries` | Ordered state-transition handoffs | Unique state run and idempotency key; append-only sequence per Job |
| `job_cleanup_tombstones` | Durable owner, actor, complete session closure, progress, failure, and outcome record for logical deletion | One tombstone per generator or Job; `pending`, `completed`, or retryable `failed` cleanup |

Registration is one database transaction: the generator references definition
version 1 through a deferred same-generator foreign key, so either both rows
commit or neither does. Publishing later configuration creates another
definition row and only changes `job_generators.active_definition_id`; existing
Jobs remain pinned to their original definition.

The registration portal preselects `devbox` as the compute affinity. This is a
UI default, not a server policy: REST callers may omit compute affinity or
provide another supported value.

User affinity is not a definition field. The server derives it from the
authenticated `JobGenerator` owner and stamps every induced root and child
session with that owner boundary. Duroxide combines the owner and repository
constraints into one exact `runTurn` routing tag, so a personal worker must
match both. Configure a personal worker with
`PILOTSWARM_WORKER_OWNER_PROVIDER`, `PILOTSWARM_WORKER_OWNER_SUBJECT`, and its
normal `PILOTSWARM_WORKER_TAGS` repo or `generic` tags. Partial owner
configuration and an owner-affined worker using the unrestricted `any` tag
filter fail at startup.

Owner-scoped workers intentionally do not accept legacy unowned `repo:*` or
`generic` work. Before converting an existing repository worker into a
personal worker, drain its pre-owner-affinity sessions or retain a legacy
global worker for those sessions until they complete. Do not advertise both
legacy and owner-scoped tags on a personal worker: that would let it dequeue
another user's unowned work during the compatibility window.

Session induction reserves the concrete session ID before creating the
PilotSwarm session, so `job_sessions` durably records the concrete
`job_id`/`session_id` relationship. Its current association transitions from
`reserved` to `unacked` after the turn is queued, then to `active` when a worker
enters `runTurn`.

## Owner-managed logical cleanup

The database transaction is the stop-new-work boundary. Deleting a
JobGenerator disables it, releases its lease, fails any running controller
cycle, and marks every induced Job deleted and cancelled. Deleting one Job
applies the same fencing only to that Job, leaving sibling Jobs available.
Both paths fail runnable state runs, release state leases, fail pending
external operations, block undelivered signals, and end current JobSession
associations. `JobStateRunStatus` has no cancelled value, so deletion records
runnable state runs as `failed` with `Job deleted` as the error.

Before enumerating a JobSession tree, cleanup marks it with a durable deletion
fence. Session sends and child creation check that fence, preventing new work
from entering the tree while its transitive deletion closure is captured.

PilotSwarm then terminates or deletes every known root session and descendant.
The complete transitive session-ID closure is persisted in the tombstone
before deletion starts, so retries still target descendants hidden behind
already soft-deleted intermediate sessions.
The API reports success only after the CMS no longer returns any of those
sessions. A partial session or orchestration failure records a `failed`
tombstone and returns an explicit cleanup error; retrying the same DELETE
continues from the durable tombstone. Stale controller work cannot recreate a
deleted generator, materialize more Jobs, complete a deleted cycle, or reserve
another JobSession.

This MVP does not physically purge generator, definition, Job, lifecycle,
journal, session-association, or tombstone rows. Retention policy and physical
purge are separate administrative concerns.

## Direct SDK registration

Use `PgSessionCatalog` after `initialize()`:

```ts
const { generator, definition } = await catalog.createJobGenerator({
  name: "active-items",
  owner: { provider: "entra", subject: "<object-id>" },
  cadenceSeconds: 300,
  definition: {
    sourceType: "example-source",
    sourceConfig: {
      filter: "active",
    },
    lifecycleDefinition: {
      initialPrompt: "Investigate {job.key}:\n{job.payload}",
      session: { model: "gpt-5.4", repo: "service-repo" },
    },
    affinities: { repo: "service-repo", gitRef: "main" },
    guardrails: { maxItemsPerCycle: 100 },
  },
});
```

Source providers are modules loaded by the platform-owned
`pilotswarm-job-generator-provider` runner. Domain modules implement the
versioned `SourceProvider` ABI and contain connector logic only; the runner
owns HTTP, bearer authentication, health, deadlines, cancellation, response
validation, and process lifecycle.

The controller communicates with each runner through a normalized HTTP
contract and POSTs the provider-specific configuration plus platform-owned
limits:

```json
{
  "generatorId": "generator-id",
  "definitionId": "definition-id",
  "config": {},
  "watermark": null,
  "limits": {
    "maxItemsPerCycle": 100
  }
}
```

`limits.maxItemsPerCycle` comes from the definition's top-level guardrails, so
providers can stop pagination before returning an oversized response. The
controller independently enforces the same limit. The provider response is:

```json
{
  "discoveries": [
    { "key": "stable-provider-key", "payload": {} }
  ],
  "watermark": {}
}
```

Provider IDs are opaque lowercase identifiers registered by the controller
deployment. Existing definitions retain their stored `sourceType`; no data
rewrite is required when an implementation moves out of the core repository.

## Configuration

Required:

- `DATABASE_URL` — PilotSwarm Postgres store.

Concrete source connectors are not implemented in this repository. Domain
repositories build modules against the public v1 ABI, compose them over the
platform-owned `pilotswarm-job-generator-provider` runner, and register the
resulting endpoint with the controller. For example, SQLmort owns both its
`ado_wiql` and `icm` modules; PilotSwarm does not import either connector.

Controller-side source configuration is:

- `JOBGEN_KUSTO_ENDPOINT`, optional `JOBGEN_KUSTO_TOKEN` — retained built-in
  compatibility adapter.
- `JOBGEN_SOURCE_PROVIDERS_JSON` — JSON array of remote provider registrations:
  `{"id":"example-source","endpoint":"http://provider/evaluate","tokenEnv":"OPTIONAL_TOKEN_ENV"}`.
  `tokenEnv` names an environment variable; credentials are never embedded in
  the registration JSON.

Legacy `JOBGEN_ICM_ENDPOINT`, `JOBGEN_ICM_TOKEN`, and `JOBGEN_ICM_DIRECT`
settings no longer register an evaluator. If any remain during migration, the
controller fails startup unless provider ID `icm` is present in
`JOBGEN_SOURCE_PROVIDERS_JSON`.
The same migration guard applies to `JOBGEN_ADO_WIQL_ENDPOINT`,
`JOBGEN_ADO_WIQL_TOKEN`, and `JOBGEN_ADO_WIQL_DIRECT`: these settings now
configure the provider-runner deployment, not JobGenerator core, and the
controller requires an explicit remote registration for provider ID
`ado_wiql`.

Optional loop settings are `JOBGEN_POLL_INTERVAL_MS` (15000),
`JOBGEN_CLAIM_LIMIT` (10), `JOBGEN_LEASE_SECONDS` (300), and
`JOBGEN_WORKER_ID`. `JOBGEN_SOURCE_PROVIDER_TIMEOUT_MS` bounds each remote
provider request and must be shorter than the generator lease; its default is
the smaller of 90000 milliseconds and 80 percent of the configured lease.
Controller shutdown cancels an in-flight provider request. Session induction is
enabled by default. Set
`JOBGEN_INDUCE_SESSIONS=false` when the controller should materialize Jobs
without reserving or starting PilotSwarm sessions. `JOBGEN_RUN_ONCE=true`
processes currently due generators once and exits.
The canonical JobWait scheduler is enabled by default. Set
`JOBGEN_WAIT_SCHEDULER_ENABLED=false` to disable it. Its optional settings are
`JOBGEN_WAIT_POLL_INTERVAL_MS` (500),
`JOBGEN_WAIT_DEFAULT_CHECK_INTERVAL_MS` (5000),
`JOBGEN_WAIT_RETRY_DELAY_MS` (1000),
`JOBGEN_WAIT_MAX_RETRY_DELAY_MS` (60000),
`JOBGEN_WAIT_CLAIM_LIMIT` (defaults to `JOBGEN_CLAIM_LIMIT`), and
`JOBGEN_WAIT_LEASE_SECONDS` (30).
`JOBGEN_MOCK_EXTERNAL_OPERATIONS=true` registers the deterministic mock
observer used by lifecycle demos; it is disabled by default and delivers
completions through the normal durable `sendSystemSignal` path.
The production Azure DevOps pull-request approval observer is registered by
default with the scheduler. It uses `JOBGEN_ADO_TOKEN`, then
`JOBGEN_ADO_PAT`/`AZURE_DEVOPS_EXT_PAT`, then `DefaultAzureCredential`. The
observer verifies the persisted PR source commit and uses Azure DevOps's current
enabled, blocking policy evaluations as the approval authority. Provider events
only accelerate a matching `pull_request_approval` check; reconciliation
polling remains authoritative. A companion `pull_request_completion` observer is
registered alongside it and shares the same credential precedence and repository
authorization. It verifies the persisted source commit, treats a completed PR as
the satisfying condition, an abandoned or otherwise incompatible PR as a terminal
disposition, and preserves the merge commit, completion actor, completion time,
and target branch as evidence. It never completes, abandons, or otherwise mutates
the pull request. Before using the shared credential, both observers require the
Job definition's `affinities.repo` value to match a server-owned
entry in `JOBGEN_ADO_REPOSITORY_BINDINGS`. The value is a JSON array such as
`[{"repo":"service-repo","organization":"contoso","project":"Project","repositoryId":"repository-guid"}]`.
An unbound affinity or mismatched target is rejected before any Azure DevOps
request. Repositories that require fresh approval after every source update
must configure their Azure DevOps branch policies to reset votes on source push;
the observer intentionally follows Azure DevOps's reported current policy state.
Missing provider configuration fails that cycle explicitly without advancing
its watermark.

Run the controller directly on a local machine:

```text
npm run job-generator
```

That command builds the SDK and controller, loads `.env.remote`, then runs the
continuous reconciliation loop. One controller instance claims due generators
without owner filtering, so it can materialize Jobs for all platform users
whose registrations share the configured PostgreSQL catalog.

When the build is already current (for example when only `.env.remote` changed),
skip the rebuild and launch the built CLI directly from the repo root:

```text
node --env-file=.env.remote packages/job-generator/dist/cli.js
```

This is the exact command `npm run job-generator` runs after its build steps.
The controller reads all `JOBGEN_*` settings — including
`JOBGEN_ADO_REPOSITORY_BINDINGS` — only at startup, so restart it after editing
`.env.remote`. On a devbox the Azure DevOps observers authenticate through the
signed-in `az login` identity via `DefaultAzureCredential`, so no PAT is
required. A successful start logs `adoRepositoryBindings=<n>` in the
`JobWait scheduler ready` line; confirm `<n>` matches the number of configured
bindings.
