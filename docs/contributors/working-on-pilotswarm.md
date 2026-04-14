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

- [`packages/cli/src/app.js`](../../packages/cli/src/app.js)
- [`packages/cli/src/platform.js`](../../packages/cli/src/platform.js)
- [`packages/cli/src/index.js`](../../packages/cli/src/index.js)
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
4. Keep the client, worker, and every `continueAsNewVersioned(...)` target on the shared latest-version constant instead of hard-coding latest targets in multiple files
5. Stamp the source orchestration version into the carried `OrchestrationInput` so the new latest handler can normalize older state when needed
6. Keep version-specific logs obvious in orchestration tracing

If the change affects replay behavior, `continueAsNew`, KV state, or command/event handling, treat it as a version bump even if the diff looks small.

The compatibility bar is higher than “old JSON still parses”:

- The latest handler must accept input snapshots from the oldest orchestration version that is still registered in the repo.
- Compatibility is behavioral, not just syntactic. If version `N` can `continueAsNew` from state point `X`, version `N+1` must resume correctly from `X`.
- If the new handler only works when resumed from a new point `Y`, keep the older handoff on the frozen handler or add explicit source-version normalization in the new handler.

### Changing the TUI

The TUI is a shared stack across:

- `packages/ui-core/` — controller, reducer, selectors, shared formatting
- `packages/ui-react/` — shared React component tree
- `packages/cli/` — terminal host, input handling, platform adapter, boot flow

Start with:

- [TUI Architecture](../tui-architecture.md)
- [TUI Design And Implementor Guide](../tui-implementor-guide.md)

Before changing rendering behavior:

- identify whether the issue lives in shared state/view models vs terminal-host rendering
- check session-switch paths and observer lifecycle
- check whether the change also affects portal/shared rendering helpers
- keep keybinding docs and TUI maintenance notes in sync

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
./scripts/run-tests.sh                         # full test suite (vitest)
./scripts/run-tests.sh --suite=smoke           # just smoke tests
cd packages/sdk && npx vitest run test/local/smoke-basic.test.js  # single file
node --check packages/cli/bin/tui.js
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
