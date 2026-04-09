# DevOps Command Center

A sample PilotSwarm application that demonstrates building an agent-powered DevOps platform with incident response, deployment management, infrastructure monitoring, storage-backed artifacts, and durable handoff workflows across the shipped TUI and SDK.

All tools return **mock data** — no real cloud APIs are called.

## What's Included

### Agents

| Agent | Type | Purpose |
|-------|------|---------|
| **Watchdog** | System (always-on) | Monitors service health using durable timers, alerts on anomalies |
| **Janitor** | System (always-on) | Scans for stale deployments and failed releases on a schedule |
| **Investigator** | User-creatable | Investigates incidents — queries metrics/logs, spawns sub-agents for parallel analysis, and can consume exported artifact handoffs |
| **Deployer** | User-creatable | Manages deployments with pre-flight checks, approval gates (`ask_user`), and rollback |
| **Reporter** | User-creatable | Generates formatted status reports aggregating metrics across services and can export detailed reports as downloadable artifacts |
| **Builder** | User-creatable | Starts mock worker-local builds and monitors remote builds with the right affinity strategy |

### Tools (Mock)

| Tool | Description |
|------|-------------|
| `query_metrics` | CPU, memory, error rate, throughput, p99 latency for a service |
| `query_logs` | Log entries filtered by severity and keyword |
| `list_deployments` | Active, failed, and rolled-back deployments |
| `deploy_service` | Execute a deployment (returns deployment ID) |
| `rollback_service` | Roll back a deployment by ID |
| `get_service_health` | Health check results (database, cache, dependencies) |
| `start_local_build` | Starts a mock build stored in worker-local memory |
| `get_local_build_status` | Checks a worker-local build and indicates whether affinity must still be preserved |
| `start_remote_build` | Starts a mock remote build that can be monitored from any worker |
| `get_remote_build_status` | Checks a remote build without needing worker affinity |

### Session Policy

Allowlist mode — only `investigator`, `deployer`, `reporter`, and `builder` can be created by users. Generic sessions are blocked. System agents (`watchdog`, `janitor`) auto-start and are deletion-protected.

### Skills

- **incident-response** — Triage checklist, common root causes, correlation patterns, escalation criteria
- **deployment-safety** — Pre-flight checks, rollback triggers, monitoring patterns

## Prerequisites

- PostgreSQL running locally (or `DATABASE_URL` pointing to one)
- `GITHUB_TOKEN` with Copilot access
- PilotSwarm installed (`npm install` from repo root)

Create a `.env` file in the repo root:

```bash
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/pilotswarm
GITHUB_TOKEN=your-token-here
```

## Running with the TUI

From the repo root:

```bash
npx pilotswarm local \
  --env .env \
  --plugin ./examples/devops-command-center/plugin \
  --worker ./examples/devops-command-center/worker-module.js
```

Or use the helper script:

```bash
./scripts/run-devops-cli-sample.sh
```

The TUI title and startup splash are loaded automatically from the plugin metadata.

This launches the full TUI with:
- Agent picker showing Investigator, Deployer, Reporter, and Builder when you press `n`
- `Shift+N` opening the model picker first, then the same agent picker
- Watchdog + Janitor running as system agents in the sidebar
- Sequence diagram showing sub-agent spawning
- Session rename with `t`, cancel with `c`, done with `d`, delete with `D`
- Vertical session-list resizing with `{` and `}`
- Theme switching with `Shift+T`, persisted to `~/.config/pilotswarm/config.json`
- Storage-backed Files inspector on `m`, including `u` upload, `a` download, `f` filter, `v` fullscreen preview, and `o` open-local-copy when supported
- Prompt reference autocomplete:
  - `@query` + `Tab` inserts the selected artifact as an `artifact://sessionId/file` reference
  - `@@query` + `Tab` inserts a durable `session://sessionId` reference you can keep in notes or reuse in SDK prompts

Because this sample uses an allowlist session policy, generic sessions are blocked. `n` will offer only the named DevOps agents instead of a generic-session choice.

Named-agent titles keep their agent prefix when renamed. For example, renaming an Investigator session to `CPU Spike Investigation` becomes `Investigator: CPU Spike Investigation`.

The Files inspector in this sample is storage-backed, so uploads, downloads, and previews operate on shared session artifacts rather than a worker-local directory. That makes it useful for cross-session handoffs and SDK-driven follow-up work.

Try the Builder agent in the TUI with prompts like:
- `Start a new build from the devops-command-center repo on this worker and monitor it until complete.`
- `Start a mock remote build for the devops-command-center repo and monitor it until complete.`

The local-build path should use 40-second durable waits with `preserveWorkerAffinity: true` while the build is running. The remote-build path should use the same polling loop without affinity preservation.

Try the newer artifact-centric TUI flows with prompts like:
- `Generate a detailed status report for payment-service, save it as a markdown artifact, and include the download link.`
- `Review @payment-service-status-report and tell me the next three investigation steps.` then press `Tab`
- `Capture a durable handoff note for this investigation, then paste @@payment-service when you want a stable session breadcrumb in the prompt.` then press `Tab`

`session://...` references are durable operator breadcrumbs. They remain visible and clickable in chat, but they do not magically expose hidden session memory to the model. Pair them with explicit instructions or `artifact://...` links when you want another session to reuse work safely.

## Running with SDK (Programmatic)

```bash
cd examples/devops-command-center
node --env-file=../../.env sdk-app.js
```

Or use the helper script from the repo root:

```bash
./scripts/run-devops-sdk-sample.sh
```

By default this runs the incident-investigation scenario. You can also run the new build flows:

```bash
cd examples/devops-command-center
DEVOPS_SCENARIO=build-local node --env-file=../../.env sdk-app.js
DEVOPS_SCENARIO=build-remote node --env-file=../../.env sdk-app.js
```

These scenarios create a Builder session, stream tool calls, and demonstrate:
- worker-local build monitoring with 40-second durable waits and `preserveWorkerAffinity: true`
- remote build monitoring with the same polling cadence but ordinary waits

The sample also includes artifact-oriented SDK scenarios:

```bash
cd examples/devops-command-center
DEVOPS_SCENARIO=report-artifact node --env-file=../../.env sdk-app.js
DEVOPS_SCENARIO=artifact-handoff node --env-file=../../.env sdk-app.js
```

These demonstrate:
- asking the Reporter to write a detailed markdown report, export it, and return an `artifact://...` link
- feeding that `artifact://...` link into a second session so the Investigator can read the stored artifact and continue the workflow
- carrying a stable `session://...` breadcrumb alongside the artifact reference for operator-visible handoff metadata

In raw SDK code there is no `@` / `@@` autocomplete layer, but the same underlying references still work: you can pass literal `artifact://sessionId/filename` and `session://sessionId` strings in `sendAndWait(...)` prompts when you already have them.

## Resetting Local State

To drop database schemas and clean up local session state, artifacts, and session store files:

```bash
node --env-file=../../.env examples/devops-command-center/scripts/cleanup-local-db.js
```

This removes:
- Local artifact files for sessions tracked in the CMS (`~/.copilot/artifacts/<sessionId>/`)
- Local session state dirs (`~/.copilot/session-state/<sessionId>/`)
- Local session store archives (`~/.copilot/session-store/<sessionId>.tar.gz`, `.meta.json`)
- Database schemas (`duroxide`, `copilot_sessions`)

Schemas are recreated automatically on next start.

## Running Tests

```bash
npx vitest run examples/devops-command-center/sdk-app.test.js
```

Tests verify:
- Session policy blocks generic sessions and unknown agents
- Named agent sessions create with correct title/agentId
- Investigator, Deployer, Reporter, and Builder call the expected tools
- Agent namespacing (`devops:investigator`, `devops:watchdog`)
- Session rename via management client
- System agents cannot be created directly by users

## Directory Structure

```
devops-command-center/
├── README.md                      ← This file
├── plugin/
│   ├── plugin.json                ← Plugin metadata (name: "devops")
│   ├── session-policy.json        ← Allowlist policy
│   ├── agents/
│   │   ├── default.agent.md       ← App-wide default instructions layered under PilotSwarm's framework base
│   │   ├── watchdog.agent.md      ← System: health monitor with durable timers
│   │   ├── janitor.agent.md       ← System: cleanup scheduler
│   │   ├── investigator.agent.md  ← Incident investigation, sub-agent spawning
│   │   ├── deployer.agent.md      ← Deployment management, approval gates
│   │   ├── reporter.agent.md      ← Status report generation
│   │   └── builder.agent.md       ← Worker-local vs remote build monitoring
│   └── skills/
│       ├── incident-response/
│       │   └── SKILL.md           ← Triage, correlation, escalation knowledge
│       └── deployment-safety/
│           └── SKILL.md           ← Pre-flight checks, rollback triggers
├── scripts/
│   └── cleanup-local-db.js        ← Local reset: drops schemas + cleans artifacts, session state, store
├── tools.js                       ← Mock tools (metrics, deploys, local builds, remote builds)
├── worker-module.js               ← Worker module for TUI (exports tools)
├── sdk-app.js                     ← SDK example (programmatic usage)
└── sdk-app.test.js                ← Integration tests
```

## Features Demonstrated

| PilotSwarm Feature | Where |
|-------------------|-------|
| Session policy (allowlist) | `session-policy.json` — only 4 agents creatable |
| App default prompt layering | `plugin/agents/default.agent.md` — mock-lab rules layered under the PilotSwarm framework base |
| System agents | `watchdog.agent.md`, `janitor.agent.md` — auto-start, deletion-protected |
| Agent namespacing | All agents qualified as `devops:*` |
| Custom tools | `tools.js` — 10 mock tools registered via `worker.registerTools()` |
| Skills | `incident-response/`, `deployment-safety/` — domain knowledge |
| Sub-agent spawning | Investigator fans out parallel queries |
| Durable timers | Watchdog uses `wait` tool for periodic monitoring |
| Affinity-aware waits | Builder preserves worker affinity only for worker-local builds |
| Storage-backed artifacts | Reporter and Investigator can exchange markdown via `write_artifact`, `read_artifact`, and `export_artifact` |
| Prompt reference workflow | TUI `@` / `@@` autocomplete inserts durable artifact/session references that can also be reused from SDK prompts |
| `ask_user` | Deployer asks for human approval before deploying |
| Title prefixing | Named-agent sessions keep their prefix, e.g. "Investigator: CPU Spike Analysis" |
| TUI layering | Sample plugin branding, named-agent session picker, and worker-module tools all run on the shipped terminal UI host |
| Management client | Rename sessions, cancel, delete |
