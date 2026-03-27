# Documentation Audit

This pass reorganizes the docs around three concrete audiences:

1. Contributors working on PilotSwarm itself
2. Developers building apps on the PilotSwarm SDK
3. Developers building apps on the PilotSwarm CLI/TUI

The biggest requirement behind the restructure is that agent authoring must be obvious for both SDK and CLI users.

## New Primary Navigation

- [docs/README.md](./README.md) is now the documentation hub
- [docs/contributors/working-on-pilotswarm.md](./contributors/working-on-pilotswarm.md) is the contributor landing page
- [docs/sdk/building-apps.md](./sdk/building-apps.md) and [docs/sdk/building-agents.md](./sdk/building-agents.md) are the SDK path
- [docs/cli/building-cli-apps.md](./cli/building-cli-apps.md) and [docs/cli/building-agents.md](./cli/building-agents.md) are the CLI/TUI path
- [docs/contracts/agent-contracts.md](./contracts/agent-contracts.md) captures key prompt/tool/runtime contracts

## Current Doc Disposition

| Document | Status | Notes |
|---|---|---|
| [README.md](../README.md) | `updated` | Now points to persona-based docs first |
| [docs/README.md](./README.md) | `new` | Primary docs hub |
| [docs/getting-started.md](./getting-started.md) | `keep` | Strong setup guide; still the best install/onboarding doc |
| [docs/configuration.md](./configuration.md) | `keep` | Reference doc, not a persona landing page |
| [docs/architecture.md](./architecture.md) | `keep` | Core contributor reference |
| [docs/plugin-architecture-guide.md](./plugin-architecture-guide.md) | `keep` | Deep plugin reference |
| [docs/system-reference.md](./system-reference.md) | `keep` | Detailed contributor/system reference |
| [docs/deploying-to-aks.md](./deploying-to-aks.md) | `keep` | Operational guide for remote workers |
| [docs/keybindings.md](./keybindings.md) | `keep` | Focused TUI reference |
| [docs/examples.md](./examples.md) | `keep` | Example index |
| [docs/building-apps.md](./building-apps.md) | `legacy` | Kept for context, but replaced by persona-specific SDK/CLI docs |
| [docs/writing-agents.md](./writing-agents.md) | `legacy` | Still valuable detail, but replaced by dedicated SDK/CLI agent guides |
| [docs/tui-apps.md](./tui-apps.md) | `legacy` | Describes an older AppAdapter concept that is not the current CLI story |
| [docs/guide.md](./guide.md) | `legacy/deep` | Broad overview; no longer the best starting point |
| [docs/blog-*.md](./blog-test-swarm-cli.md) | `examples` | Good worked examples, not canonical reference docs |
| [docs/orchestration-hardening-plan.md](./orchestration-hardening-plan.md) | `internal` | Active engineering plan |
| [docs/tui-cleanup-status.md](./tui-cleanup-status.md) | `internal` | Point-in-time cleanup notes |
| [docs/proposals/*](./proposals/) | `internal` | Open or still-in-flight design notes, not primary user docs |
| [docs/proposals-impl/*](./proposals-impl/) | `internal/archive` | Implemented proposal writeups retained as historical design records |

## Why The Restructure Was Needed

### The old user path was not audience-based

Important content existed, but it was spread across:

- a generic README
- `building-apps.md`
- `writing-agents.md`
- `guide.md`
- `tui-apps.md`

That made it hard to answer simple questions like:

- “I just want to build an SDK app. Where do I start?”
- “What exactly is an agent file?”
- “How do CLI apps differ from SDK apps?”

### The old TUI guide no longer matched the current code

[docs/tui-apps.md](./tui-apps.md) describes an AppAdapter framework. The current CLI package instead exposes a shipped TUI binary plus:

- a plugin directory via `--plugin`
- an optional local worker module via `--worker`
- local and remote execution modes

That mismatch was a major source of confusion, so the new CLI docs describe the current shipping behavior.

### Agent authoring was split across too many docs

Agent behavior and packaging were spread across:

- plugin docs
- runtime docs
- older app-building docs
- prompt files in `packages/sdk/plugins`

The new SDK and CLI agent guides pull the critical path into one place for each audience.

## Remaining Follow-Up Work

- Tighten `docs/guide.md` or retire it once its unique value is clearer
- Add more screenshots and “day one” examples for the CLI path
- Add explicit contract tests that mirror [docs/contracts/agent-contracts.md](./contracts/agent-contracts.md)
- Keep the persona docs updated as the orchestration and CLI continue to evolve
