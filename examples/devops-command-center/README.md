# DevOps Command Center

A sample PilotSwarm application that demonstrates building an agent-powered DevOps platform with incident response, deployment management, and infrastructure monitoring.

All tools return **mock data** — no real cloud APIs are called.

## What's Included

### Agents

| Agent | Type | Purpose |
|-------|------|---------|
| **Watchdog** | System (always-on) | Monitors service health using durable timers, alerts on anomalies |
| **Janitor** | System (always-on) | Scans for stale deployments and failed releases on a schedule |
| **Investigator** | User-creatable | Investigates incidents — queries metrics/logs, spawns sub-agents for parallel analysis |
| **Deployer** | User-creatable | Manages deployments with pre-flight checks, approval gates (`ask_user`), and rollback |
| **Reporter** | User-creatable | Generates formatted status reports aggregating metrics across services |

### Tools (Mock)

| Tool | Description |
|------|-------------|
| `query_metrics` | CPU, memory, error rate, throughput, p99 latency for a service |
| `query_logs` | Log entries filtered by severity and keyword |
| `list_deployments` | Active, failed, and rolled-back deployments |
| `deploy_service` | Execute a deployment (returns deployment ID) |
| `rollback_service` | Roll back a deployment by ID |
| `get_service_health` | Health check results (database, cache, dependencies) |

### Session Policy

Allowlist mode — only `investigator`, `deployer`, and `reporter` can be created by users. Generic sessions are blocked. System agents (`watchdog`, `janitor`) auto-start and are deletion-protected.

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

## Running with TUI

From the repo root:

```bash
npx pilotswarm \
  --plugin ./examples/devops-command-center/plugin \
  --worker ./examples/devops-command-center/worker-module.js \
  --env .env
```

The TUI title and startup splash are loaded automatically from the plugin metadata.

This launches the full TUI with:
- Agent picker showing Investigator, Deployer, Reporter (press `n`)
- Watchdog + Janitor running as system agents in the sidebar
- Sequence diagram showing sub-agent spawning
- Session rename with `t`, cancel with `c`, delete with `d`

## Running with SDK (Programmatic)

```bash
cd examples/devops-command-center
node --env-file=../../.env sdk-app.js
```

This runs a scripted scenario: creates an Investigator session, sends an incident prompt, streams tool calls, and prints the root cause analysis.

## Running Tests

```bash
npx vitest run examples/devops-command-center/sdk-app.test.js
```

Tests verify:
- Session policy blocks generic sessions and unknown agents
- Named agent sessions create with correct title/agentId
- Investigator, Deployer, and Reporter call the expected tools
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
│   │   └── reporter.agent.md      ← Status report generation
│   └── skills/
│       ├── incident-response/
│       │   └── SKILL.md           ← Triage, correlation, escalation knowledge
│       └── deployment-safety/
│           └── SKILL.md           ← Pre-flight checks, rollback triggers
├── tools.js                       ← Mock tools (query_metrics, deploy_service, etc.)
├── worker-module.js               ← Worker module for TUI (exports tools)
├── sdk-app.js                     ← SDK example (programmatic usage)
└── sdk-app.test.js                ← Integration tests
```

## Features Demonstrated

| PilotSwarm Feature | Where |
|-------------------|-------|
| Session policy (allowlist) | `session-policy.json` — only 3 agents creatable |
| App default prompt layering | `plugin/agents/default.agent.md` — mock-lab rules layered under the PilotSwarm framework base |
| System agents | `watchdog.agent.md`, `janitor.agent.md` — auto-start, deletion-protected |
| Agent namespacing | All agents qualified as `devops:*` |
| Custom tools | `tools.js` — 6 mock tools registered via `worker.registerTools()` |
| Skills | `incident-response/`, `deployment-safety/` — domain knowledge |
| Sub-agent spawning | Investigator fans out parallel queries |
| Durable timers | Watchdog uses `wait` tool for periodic monitoring |
| `ask_user` | Deployer asks for human approval before deploying |
| Title prefixing | Sessions show "Investigator: CPU Spike Analysis" |
| Management client | Rename sessions, cancel, delete |
