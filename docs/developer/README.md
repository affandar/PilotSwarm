# Developer Guide

Two tracks: building **on** PilotSwarm, and contributing **to** it.

## Building on PilotSwarm

Start with [SDK apps](./building/sdk-apps.md) (services, harnesses, custom
workflows) or [CLI/TUI apps](./building/cli-apps.md) (plugin-driven terminal
apps). Both paths share the same plugin model —
[Plugin architecture & layering](./building/plugins.md) is the deep reference.

- Agent authoring: [for SDK apps](./building/sdk-agents.md) · [for CLI apps](./building/cli-agents.md)
- [Facts & graph from the SDK](./building/facts-and-graph.md)
- [Builder agent templates](./building/builder-agents.md) — reusable Copilot agents that scaffold PilotSwarm apps
- [Examples](./building/examples.md) — runnable samples, including the DevOps Command Center

Building a **UI** rather than an app? That's the API section:
[Building a Custom UX](../api/building-a-custom-ux.md).

## Deploying

- [Deploying to AKS](./deploy/aks.md) — the full rollout workflow (+ [topology](./deploy/aks-topology.md))
- [Portal Entra app roles](./deploy/entra-app-roles.md) — auth setup for Entra deployments
- [Knowledge harvester](./deploy/harvester.md) — a `crawler: true` ingestion service
- [Observability](./deploy/observability.md) — OpenTelemetry/SigNoZ wiring

## Reference

- [Configuration](./reference/configuration.md) — every env var and option
- [Agent contracts](./reference/agent-contracts.md) — rules that stay true across code, docs, and tests

## Contributing to PilotSwarm

[Working on PilotSwarm](./contributing/working-on-pilotswarm.md) is the
landing page: repo map, workflows, checklists. Then:

- [TUI implementor guide](./contributing/tui-implementor-guide.md)
- [Local test spec](./contributing/local-test-spec.md) · [Local integration test plan](./contributing/local-integration-test-plan.md)
- [Facts table test spec](./contributing/facts-table-tests.md)
- Root [CONTRIBUTING.md](../../CONTRIBUTING.md) — PR conventions, test requirements
