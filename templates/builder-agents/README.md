# PilotSwarm Builder Agents

These are distributable Copilot custom-agent templates for users who are building apps on top of PilotSwarm.

They are not active in this repository. Copy them into the target repository you want to assist.

## Included Agents

- `pilotswarm-cli-builder` — scaffolds plugin-driven CLI/TUI apps built on the shipped PilotSwarm UI
- `pilotswarm-sdk-builder` — scaffolds SDK-first apps and services built around `PilotSwarmClient` and `PilotSwarmWorker`
- `pilotswarm-azure-deployer` — prepares PilotSwarm-based apps for Azure / AKS deployment, including env templates, workload identity, and cross-cluster AKS guidance

These templates assume apps consume:

- `@affandar/pilotswarm`
- `@affandar/pilotswarm-cli`

and that PilotSwarm's built-in framework and management plugins are embedded in those packages while app `default.agent.md` files act as app-wide overlays.

## Install Into Another Repo

Copy these folders into the target repository:

```text
.github/
├── agents/
│   ├── pilotswarm-cli-builder.agent.md
│   ├── pilotswarm-sdk-builder.agent.md
│   └── pilotswarm-azure-deployer.agent.md
└── skills/
    ├── pilotswarm-cli-builder/
    │   └── SKILL.md
    ├── pilotswarm-sdk-builder/
    │   └── SKILL.md
    └── pilotswarm-azure-deployer/
        └── SKILL.md
```

One way to install from a clone of the PilotSwarm repo:

```bash
mkdir -p .github/agents .github/skills
cp templates/builder-agents/agents/*.agent.md .github/agents/
cp -R templates/builder-agents/skills/* .github/skills/
```

## Canonical References

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

## Maintenance Rule

If PilotSwarm adds features or changes behavior relevant to app builders, update these templates as part of the same change whenever practical.
