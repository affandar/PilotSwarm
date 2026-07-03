# PilotSwarm Documentation

Five sections, in reading order. Pick your door.

## 1. [Quick Start](./quickstart/docker.md)

Running in minutes.

- [Docker Quickstart](./quickstart/docker.md) — the fastest path: browser portal + SSH TUI + two workers from one `pilotswarm-starter` image
- [Local Setup](./quickstart/local.md) — from source: install, PostgreSQL, first run

## 2. [User Guide](./user-guide/README.md)

Driving sessions as an end user — scenario-based, from "say hello" to
multi-hour multi-agent workflows.

- [Terminal UI track](./user-guide/tui.md) · [Browser portal track](./user-guide/portal.md)
- [Keybindings](./user-guide/keybindings.md) — TUI controls and slash commands

## 3. [Architecture](./architecture/README.md)

How the system works. Start at the layering map, then descend.

- [Layering — One Way In](./architecture/layering.md) — every user-facing surface rides the Web API; the map of the whole system
- [Architecture deep dive](./architecture/system.md) — durable runtime, CMS, client, worker
- [Orchestration design](./architecture/orchestration/design.md) (+ [the loop, oriented](./architecture/orchestration/loop.md))
- [System reference](./architecture/system-reference.md) — file map, lifecycle, schema, invariants
- [Facts store design](./architecture/facts.md) · [Session creation policy](./architecture/session-creation-policy.md) · [TUI architecture](./architecture/tui.md)
- [Internals](./architecture/internals/README.md) — CMS schema, session manager

## 4. [API Reference](./api/reference.md)

The Web API — the one integration surface — and every client over it.

- [Web API Reference](./api/reference.md) — every operation, auth, errors, WebSocket streaming (generated from the operations table)
- [Building a Custom UX](./api/building-a-custom-ux.md) — your own UI over the API: bootstrap, subscribe, replay, browser sign-in
- [Choosing a Client](./api/clients.md) — raw HTTP vs `ApiClient` vs SDK clients vs MCP: which to use when

## 5. [Developer Guide](./developer/README.md)

Building **on** PilotSwarm, deploying it, and contributing **to** it.

**Building apps**
- [SDK apps](./developer/building/sdk-apps.md) (+ [agents](./developer/building/sdk-agents.md), [facts & graph](./developer/building/facts-and-graph.md))
- [CLI/TUI apps](./developer/building/cli-apps.md) (+ [agents](./developer/building/cli-agents.md))
- [Plugin architecture & layering](./developer/building/plugins.md) · [Builder agent templates](./developer/building/builder-agents.md)
- [Examples](./developer/building/examples.md) — runnable samples incl. the DevOps Command Center

**Deploying**
- [Deploying to AKS](./developer/deploy/aks.md) (+ [topology](./developer/deploy/aks-topology.md))
- [Portal Entra app roles](./developer/deploy/entra-app-roles.md) · [Knowledge harvester](./developer/deploy/harvester.md) · [Observability](./developer/deploy/observability.md)

**Reference**
- [Configuration](./developer/reference/configuration.md) — env vars, storage, worker/client options
- [Agent contracts](./developer/reference/agent-contracts.md) — prompt/tool/runtime rules that stay true across code, docs, tests

**Contributing to PilotSwarm**
- [Working on PilotSwarm](./developer/contributing/working-on-pilotswarm.md) — repo map, workflows, checklists
- [TUI implementor guide](./developer/contributing/tui-implementor-guide.md)
- [Local test spec](./developer/contributing/local-test-spec.md) · [integration test plan](./developer/contributing/local-integration-test-plan.md) · [facts table tests](./developer/contributing/facts-table-tests.md)

---

**Design records** (not onboarding material): [proposals](./proposals/) — open designs ·
[proposals-impl](./proposals-impl/README.md) — implemented designs, kept as history ·
[bugreports](./bugreports/) · [_archive](./_archive/) — retired point-in-time docs.
