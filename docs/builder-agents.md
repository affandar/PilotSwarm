# Builder Agent Templates

PilotSwarm ships distributable template files for Copilot custom agents that help users build apps on top of PilotSwarm.

These are not runtime agents inside PilotSwarm. They are authoring-time helpers meant to be copied into another repository.

## Template Source

In this repo, the templates live in:

`templates/builder-agents/`

That folder is intentionally non-active. Nothing there is loaded into this repository's own `.github/agents/` surface.

## Included Templates

- `pilotswarm-cli-builder`
- `pilotswarm-portal-builder`
- `pilotswarm-sdk-builder`
- `pilotswarm-agent-versioning`
- `pilotswarm-azure-deployer`

## Included Skills

- `pilotswarm-cli-builder`
- `pilotswarm-portal-builder`
- `pilotswarm-sdk-builder`
- `pilotswarm-agent-versioning`
- `pilotswarm-hybrid-datastore`
- `pilotswarm-knowledge-harvester`
- `pilotswarm-azure-deployer`
- `pilotswarm-aks-identity`
- `pilotswarm-azure-lessons`
- `pilotswarm-three-tier`

## Install Into Another Repository

Copy the contents into the target repository as:

```text
.github/
├── agents/
└── skills/
```

Example install commands:

```bash
mkdir -p .github/agents .github/skills
cp templates/builder-agents/agents/*.agent.md .github/agents/
cp -R templates/builder-agents/skills/* .github/skills/
```

## Canonical Public References

- CLI guide:
  `https://github.com/affandar/pilotswarm/blob/main/docs/cli/building-cli-apps.md`
- Portal guide:
  `https://github.com/affandar/pilotswarm/blob/main/packages/portal/README.md`
- CLI agent guide:
  `https://github.com/affandar/pilotswarm/blob/main/docs/cli/building-agents.md`
- SDK guide:
  `https://github.com/affandar/pilotswarm/blob/main/docs/sdk/building-apps.md`
- SDK agent guide:
  `https://github.com/affandar/pilotswarm/blob/main/docs/sdk/building-agents.md`
- Plugin architecture:
  `https://github.com/affandar/pilotswarm/blob/main/docs/plugin-architecture-guide.md`
- AKS deployment:
  `https://github.com/affandar/pilotswarm/blob/main/docs/deploying-to-aks.md`
- DevOps sample:
  `https://github.com/affandar/pilotswarm/tree/main/examples/devops-command-center`

## Design Intent

- `pilotswarm-cli-builder` helps users build plugin-driven CLI/TUI apps on top of the shipped PilotSwarm UI.
- `pilotswarm-portal-builder` helps users customize the shipped browser portal with plugin-driven branding, named-agent exposure, and optional auth add-ons.
- `pilotswarm-sdk-builder` helps users build SDK-first services and applications around `PilotSwarmClient` and `PilotSwarmWorker`.
- `pilotswarm-azure-deployer` helps users package and deploy PilotSwarm-based apps to Azure / AKS, with explicit env-template and cross-cluster workload-identity guidance.
- `pilotswarm-hybrid-datastore` (skill) helps builders wire the stock-PostgreSQL runtime store alongside optional HorizonDB enhanced facts/search/graph providers without changing the default Docker image.
- `pilotswarm-knowledge-harvester` (skill) helps the SDK builder add a knowledge-harvesting capability: a `crawler: true` agent that crawls sources into the durable facts store, builds the open knowledge graph, and exposes multi-signal search to reader agents through the optional EnhancedFactStore / GraphStore providers.

The CLI and SDK builder templates are intended to be guided builders, not guess-heavy code generators. They should ask about session policy, env-file setup, initial agent roster, and target topology before scaffolding files.

Builder templates should assume:

- npm packages are consumed as `pilotswarm-sdk` and `pilotswarm-cli`
- PilotSwarm's built-in framework and management plugins are embedded in those packages
- app `default.agent.md` files are overlays layered under the embedded PilotSwarm framework base
- if an app needs a custom model catalog, check in `.model_providers.example.json`, create a local gitignored `.model_providers.json` from it, and keep provider keys in `.env` / `.env.remote`
- builder templates should scaffold both `.env.example` and `.model_providers.example.json` from PilotSwarm's own example-file shape, then create local `.env` / `.model_providers.json` copies and add those real files to `.gitignore`
- optional SDK-bundled named agents are hidden by default and should be exposed through `session-policy.json.creation.bundledAgents`, for example `"bundledAgents": ["generic-crawler"]`; templates should teach that policy opt-in instead of copying bundled agent files unless the app needs custom behavior
- every generated app `.agent.md` should include `schemaVersion: 1` and a `version` string; new agents should default to `version: 1.0.0`, and edits to existing agents should bump the version string according to the app's versioning style
- generated recurring agents should use `cron(seconds=N, reason="...")` for fixed intervals and `cron_at(minute=M, hour=H, tz="Area/City", reason="...")` for wall-clock schedules; do not build wall-clock jobs with wake-and-check polling loops
- generated delegation flows should document `contract.wakeOn` for child sessions: `any` for chatty short-lived work, `material_change` for watchers, and `completion` for done/blocked/error-only children
- Azure deployment guidance should prefer `kubectl create secret generic ... --from-env-file=...` when semicolon-bearing values such as Azure Storage connection strings are involved
- builder guidance should treat `write_artifact` / `export_artifact` as the canonical text-and-binary artifact path, using `contentType` plus base64 encoding for binary files and documenting download-only browser behavior for non-text previews

## Maintenance Rule

When PilotSwarm gains features or changes builder-relevant behavior, update these template agents and skills alongside the docs and examples they reference.
