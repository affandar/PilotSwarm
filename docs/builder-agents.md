# Builder Agent Templates

PilotSwarm ships distributable template files for Copilot custom agents that help users build apps on top of PilotSwarm.

These are not runtime agents inside PilotSwarm. They are authoring-time helpers meant to be copied into another repository.

## Template Source

In this repo, the templates live in:

`templates/builder-agents/`

That folder is intentionally non-active. Nothing there is loaded into this repository's own `.github/agents/` surface.

## Included Templates

- `pilotswarm-cli-builder`
- `pilotswarm-sdk-builder`
- `pilotswarm-azure-deployer`

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
- `pilotswarm-sdk-builder` helps users build SDK-first services and applications around `PilotSwarmClient` and `PilotSwarmWorker`.
- `pilotswarm-azure-deployer` helps users package and deploy PilotSwarm-based apps to Azure / AKS, with explicit env-template and cross-cluster workload-identity guidance.

Builder templates should assume:

- npm packages are consumed as `pilotswarm-sdk` and `pilotswarm-cli`
- PilotSwarm's built-in framework and management plugins are embedded in those packages
- app `default.agent.md` files are overlays layered under the embedded PilotSwarm framework base

## Maintenance Rule

When PilotSwarm gains features or changes builder-relevant behavior, update these template agents and skills alongside the docs and examples they reference.
