# Working On PilotSwarm

This guide is for contributors changing PilotSwarm itself: the SDK runtime, worker/session plumbing, TUI, plugins, prompts, or deployment story.

## Repo Map

The two most important packages are:

- `packages/sdk/` — durable runtime, worker, client, orchestration, CMS, plugin loading, model providers
- `packages/cli/` — shipped TUI/CLI wrapper around the SDK

The rest of the repo mostly supports those two packages:

- `docs/` — user docs, contributor docs, design notes, and proposals
- `scripts/` — deploy, reset, debug, and inspection helpers
- `deploy/` — Dockerfile and Kubernetes manifests

## Where To Work

### SDK / Runtime

Touch `packages/sdk/src/` when you are changing:

- orchestration state transitions
- activity wiring
- client/management behavior
- session hydration/dehydration
- model provider resolution
- plugin loading
- prompt/tool/runtime contracts

Files that matter most:

- [`packages/sdk/src/orchestration.ts`](../../packages/sdk/src/orchestration.ts)
- [`packages/sdk/src/worker.ts`](../../packages/sdk/src/worker.ts)
- [`packages/sdk/src/session-manager.ts`](../../packages/sdk/src/session-manager.ts)
- [`packages/sdk/src/managed-session.ts`](../../packages/sdk/src/managed-session.ts)
- [`packages/sdk/src/session-proxy.ts`](../../packages/sdk/src/session-proxy.ts)
- [`packages/sdk/src/client.ts`](../../packages/sdk/src/client.ts)
- [`packages/sdk/src/management-client.ts`](../../packages/sdk/src/management-client.ts)
- [`packages/sdk/src/types.ts`](../../packages/sdk/src/types.ts)

### TUI / CLI

Touch `packages/cli/` when you are changing:

- layout and rendering
- observer/poller lifecycle
- session switching behavior
- slash commands and input handling
- local vs remote TUI boot flow

Files that matter most:

- [`packages/cli/cli/tui.js`](../../packages/cli/cli/tui.js)
- [`packages/cli/bin/tui.js`](../../packages/cli/bin/tui.js)
- [`packages/cli/package.json`](../../packages/cli/package.json)

### Prompt / Plugin Surface

Touch `packages/sdk/plugins/` when you are changing:

- default instructions
- named agents
- system-agent behavior
- built-in skills

Files that matter most:

- [`packages/sdk/plugins/system/agents/default.agent.md`](../../packages/sdk/plugins/system/agents/default.agent.md)
- [`packages/sdk/plugins/mgmt/agents/pilotswarm.agent.md`](../../packages/sdk/plugins/mgmt/agents/pilotswarm.agent.md)
- [`packages/sdk/plugins/mgmt/agents/sweeper.agent.md`](../../packages/sdk/plugins/mgmt/agents/sweeper.agent.md)
- [`packages/sdk/plugins/mgmt/agents/resourcemgr.agent.md`](../../packages/sdk/plugins/mgmt/agents/resourcemgr.agent.md)

## Contributor Workflows

### Changing the orchestration

PilotSwarm versions orchestrations instead of editing deployed behavior in place.

When you change orchestration behavior:

1. Freeze the current latest orchestration into `packages/sdk/src/orchestration_<version>.ts`
2. Update `packages/sdk/src/orchestration.ts` to the new latest version
3. Wire the new version in `packages/sdk/src/orchestration-registry.ts`
4. Keep the client and worker on the shared registry constants instead of hard-coding versions in multiple files
5. Keep version-specific logs obvious in orchestration tracing

If the change affects replay behavior, `continueAsNew`, KV state, or command/event handling, treat it as a version bump even if the diff looks small.

### Changing the TUI

The TUI is still a large single file, so regressions often come from:

- two paths writing to the same pane
- observers restarting after a session is already terminal
- mixing CMS history with live updates
- global state that really needs to be session-scoped

Before changing rendering behavior:

- identify the render owner for the pane
- check session-switch paths
- check observer lifecycle and terminal-state shutdown
- check whether the bug is really data-flow vs paint/repaint

### Changing prompts, tool contracts, or agent behavior

Do not rely on prompt text alone.

For any behavior that must stay true, update all of these layers together:

- prompt or agent file
- tool descriptions / schemas
- runtime validation or normalization
- tests
- docs

This is especially important for:

- named system-agent spawning
- model selection for sub-agents
- artifact creation/export rules
- wait / ask_user semantics

See [Agent Contracts](../contracts/agent-contracts.md).

### Adding or changing a model provider

Provider changes usually touch:

- `packages/sdk/src/model-providers.ts`
- `packages/sdk/src/session-manager.ts`
- worker startup/config docs
- examples and `.env` documentation

If you add something like an AWS-hosted provider, make sure the change is reflected in:

- provider discovery/loading
- runtime provider resolution
- model listing for the LLM
- docs for SDK and CLI users

## Testing And Verification

Useful local checks:

```bash
npm run build --workspace=packages/sdk
npm test --workspace=packages/sdk
node --check packages/cli/cli/tui.js
```

For the broader local-only runtime test matrix, see [Local Integration Test Plan](./local-integration-test-plan.md).

Useful end-to-end flows:

- `npm run tui` — local embedded workers
- `npm run tui:remote` — client-only TUI against remote workers
- `node --env-file=.env packages/sdk/examples/chat.js`
- `node --env-file=.env.remote packages/sdk/examples/worker.js`

## Deploy And Reset Loop

Common operations:

```bash
./scripts/deploy-aks.sh
./scripts/deploy-aks.sh --skip-reset
node --env-file=.env scripts/db-reset.js
```

Use a full reset when you need a clean state for orchestration/version testing. Use `--skip-reset` for prompt or worker-only rollouts where preserving sessions is useful.

## Docs To Keep In Sync

When behavior changes, update the user-facing docs that explain it:

- [docs/sdk/building-apps.md](../sdk/building-apps.md)
- [docs/sdk/building-agents.md](../sdk/building-agents.md)
- [docs/cli/building-cli-apps.md](../cli/building-cli-apps.md)
- [docs/cli/building-agents.md](../cli/building-agents.md)
- [docs/contracts/agent-contracts.md](../contracts/agent-contracts.md)

If the change is architectural or operational, also check:

- [docs/architecture.md](../architecture.md)
- [docs/plugin-architecture-guide.md](../plugin-architecture-guide.md)
- [docs/system-reference.md](../system-reference.md)
- [docs/deploying-to-aks.md](../deploying-to-aks.md)

## Quick Contributor Checklist

- Reproduce the issue locally before patching if you can
- Prefer runtime backstops over prompt-only fixes
- Version orchestration changes
- Keep the default agent prompt and agent-contract docs aligned
- Verify with both local checks and at least one realistic end-to-end path
