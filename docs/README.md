# PilotSwarm Documentation

Start with the path that matches what you are trying to do.

## Choose Your Path

### I want to work on PilotSwarm itself

- [Working On PilotSwarm](./contributors/working-on-pilotswarm.md) — repo map, runtime/TUI/orchestration workflows, and contributor checklists
- [Architecture](./architecture.md) — how the durable runtime, CMS, client, and worker fit together
- [Plugin Architecture & Layering Guide](./plugin-architecture-guide.md) — deep reference for agents, skills, MCP, and merge semantics
- [System Reference](./system-reference.md) — file map, orchestration lifecycle, CMS schema, and invariants

### I want to build an app with the SDK

- [Getting Started](./getting-started.md) — install, configure PostgreSQL, and run locally
- [Building SDK Apps](./sdk/building-apps.md) — the recommended path for app developers using `PilotSwarmClient` and `PilotSwarmWorker`
- [Building Agents For SDK Apps](./sdk/building-agents.md) — the canonical guide for `default.agent.md`, named agents, skills, tools, and system agents
- [Builder Agent Templates](./builder-agents.md) — distributable Copilot custom agents for users building apps on top of PilotSwarm
- [Configuration](./configuration.md) — environment variables, blob storage, worker/client options
- [Examples](./examples.md) — runnable examples in the repo, including the DevOps Command Center layered-app sample

### I want to build an app with the CLI/TUI

- [Building CLI Apps](./cli/building-cli-apps.md) — how the shipped TUI works today, local vs remote mode, and where plugins and worker modules fit
- [Building Agents For CLI Apps](./cli/building-agents.md) — the agent-authoring path for plugin-driven CLI apps
- [Builder Agent Templates](./builder-agents.md) — distributable Copilot custom agents for users building layered PilotSwarm apps
- [Keybindings](./keybindings.md) — TUI controls and slash commands
- [Getting Started](./getting-started.md) — environment setup and first run
- [Examples](./examples.md) — includes the DevOps Command Center sample that uses CLI branding, system agents, and session policy

## Contracts And Reference

- [Agent Contracts](./contracts/agent-contracts.md) — prompt, tool, runtime, and naming rules that should stay true across code, docs, and tests
- [Deploying To AKS](./deploying-to-aks.md) — remote worker deployment and rollout workflow
- [Component Interactions](./component-interactions.md) — message flow and lifecycle diagrams
- [Layer Diagram](./layer-diagram.md) — fast mental model for the stack

## Internal Notes And Point-In-Time Docs

These are useful for contributors but are not the main onboarding path:

- [Orchestration Hardening Plan](./orchestration-hardening-plan.md)
- [TUI Cleanup Status](./tui-cleanup-status.md)
- [Implemented Proposals](./proposals-impl/README.md)
- [Proposal: Prompt Layering and Framework Precedence](./proposals-impl/prompt-layering-and-precedence.md)
- [Proposal: npm Packaging and Embedded PilotSwarm Plugins](./proposals-impl/npm-packaging-and-embedded-plugins.md)
- [Proposal: Preserve Worker Affinity For Durable Waits](./proposals-impl/wait-preserve-worker-affinity.md)
- [`docs/proposals/`](./proposals/)

## Legacy Guides

These older guides still contain useful detail, but they are no longer the primary entry points:

- [Building Apps On PilotSwarm](./building-apps.md)
- [Writing Agents, Skills, Tools & MCP Servers](./writing-agents.md)
- [TUI Apps](./tui-apps.md)
- [User Guide](./guide.md)

If you are new to the repo, prefer the persona-based docs above.
