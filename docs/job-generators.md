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
    "sourceType": "kusto",
    "sourceConfig": {
      "query": "SourceRecords | take 100",
      "keyColumn": "RecordId"
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
| `GET` | `/api/v1/jobs/{id}` | One durable Job |
| `GET` | `/api/v1/jobs/{id}/sessions` | Ordered PilotSwarm session history |

Generator, definition, Job, and session-history reads require generator
ownership or admin role. An unauthorized point lookup returns `404`, avoiding
an existence oracle across users.

## Persistence model

| Table | Responsibility | Key invariants |
|---|---|---|
| `job_generators` | Mutable registration, owner, cadence, state, watermark, counters, lease | Unique owner/name; active definition belongs to the same generator |
| `job_generator_definitions` | Immutable source, lifecycle, affinities, validation, guardrails | Unique `(generator_id, version)`; update trigger rejects mutation |
| `job_generator_cycles` | One claimed evaluation/reconciliation pass | At most one running cycle per generator |
| `jobs` | Durable source-native work identity and lifecycle | Unique `(generator_id, job_key)`; pinned `definition_id` |
| `job_sessions` | Job-to-PilotSwarm execution history | Many per Job; globally unique session ID; at most one current |
| `job_state_runs` | One revision-fenced execution of a lifecycle state | Unique `(job_id, state_revision)`; one durable session association |
| `job_external_operations` | Infrastructure-owned external work, authoritative wait state, and signal delivery | Idempotent per state run/provider/kind/key; generated correlation and signal keys; rebinds across session replacement |
| `job_journal_entries` | Ordered state-transition handoffs | Unique state run and idempotency key; append-only sequence per Job |

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

## Direct SDK registration

Use `PgSessionCatalog` after `initialize()`:

```ts
const { generator, definition } = await catalog.createJobGenerator({
  name: "active-incidents",
  owner: { provider: "entra", subject: "<object-id>" },
  cadenceSeconds: 300,
  definition: {
    sourceType: "icm",
    sourceConfig: { owningTeamId: 12345 },
    lifecycleDefinition: {
      initialPrompt: "Investigate {job.key}:\n{job.payload}",
      session: { model: "gpt-5.4", repo: "service-repo" },
    },
    affinities: { repo: "service-repo", gitRef: "main" },
    guardrails: { maxItemsPerCycle: 100 },
  },
});
```

The HTTP adapters POST `{generatorId, definitionId, config, watermark}` and
expect provider results containing stable keys:

- ADO WIQL: `workItems`, `value`, or `items`; key is `id`/`key`.
- IcM: `incidents`, `value`, or `items`; key is `incidentId`/`IncidentId`.
- Kusto: standard `Tables[0].Columns/Rows`, or `items`; set
  `sourceConfig.keyColumn` when the key column is not `key`.

## Configuration

Required:

- `DATABASE_URL` — PilotSwarm Postgres store.

The native `ado_wiql` provider requires no controller endpoint configuration.
Its generator definition supplies `sourceConfig.wiql`. Optional
`sourceConfig.organization` and `sourceConfig.project` values select a
different scope; otherwise the controller reads the devbox defaults configured
by `az devops configure`. It constructs the query endpoint and authenticates
through `DefaultAzureCredential`.

Configure endpoints only for adapter-backed provider types used by active
definitions:

- `JOBGEN_ICM_ENDPOINT`, optional `JOBGEN_ICM_TOKEN`
- `JOBGEN_KUSTO_ENDPOINT`, optional `JOBGEN_KUSTO_TOKEN`

Optional loop settings are `JOBGEN_POLL_INTERVAL_MS` (15000),
`JOBGEN_CLAIM_LIMIT` (10), `JOBGEN_LEASE_SECONDS` (300), and
`JOBGEN_WORKER_ID`. Session induction is enabled by default. Set
`JOBGEN_INDUCE_SESSIONS=false` when the controller should materialize Jobs
without reserving or starting PilotSwarm sessions. `JOBGEN_RUN_ONCE=true`
processes currently due generators once and exits.
`JOBGEN_MOCK_EXTERNAL_OPERATIONS=true` also
starts the deterministic mock operation producer used by lifecycle demos; it
is disabled by default and delivers completions through the normal durable
`sendSystemSignal` path.
`JOBGEN_ADO_WIQL_ENDPOINT` remains an optional
compatibility override for a fixed endpoint or normalized adapter; set
`JOBGEN_ADO_WIQL_DIRECT=true` when the override accepts the native REST shape.
Without a static token, the native provider uses `DefaultAzureCredential`,
allowing a signed-in devbox session or workload identity to refresh access
tokens continuously. PilotSwarm managed-identity variables are honored.
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
