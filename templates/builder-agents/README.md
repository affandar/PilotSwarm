# PilotSwarm Builder Agents

These are distributable Copilot custom-agent templates for users who are building apps on top of PilotSwarm.

They are not active in this repository. Copy them into the target repository you want to assist.

## Included Agents

- `pilotswarm-cli-builder` — scaffolds plugin-driven CLI/TUI apps built on the shipped PilotSwarm UI
- `pilotswarm-sdk-builder` — scaffolds SDK-first apps and services built around `PilotSwarmClient` and `PilotSwarmWorker`
- `pilotswarm-azure-deployer` — prepares PilotSwarm-based apps for Azure / AKS deployment, including env templates, manifests, and worker observability

## Included Skills (split for focused retrieval)

- `pilotswarm-cli-builder` — CLI/TUI scaffold guidance, env files, launcher scripts
- `pilotswarm-sdk-builder` — SDK app scaffold guidance, client/worker split, tests
- `pilotswarm-azure-deployer` — deployment workflow, manifests, env checklist, `RUST_LOG` observability
- `pilotswarm-aks-identity` — cross-cluster AKS access, Workload Identity, kubectl patterns
- `pilotswarm-azure-lessons` — RBAC conditional access workaround, PostgreSQL region restrictions, Key Vault + CSI

These templates assume apps consume:

- `pilotswarm-sdk`
- `pilotswarm-cli`

from npm:

```bash
npm install pilotswarm-sdk
npm install pilotswarm-cli
```

and that PilotSwarm's built-in framework and management plugins are embedded in those packages while app `default.agent.md` files act as app-wide overlays.

The CLI builder template also assumes runnable scaffolds should:

- generate checked-in launcher and cleanup scripts
- make those scripts executable
- verify direct script execution rather than only relying on `node script.js`

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
    ├── pilotswarm-azure-deployer/
    │   └── SKILL.md
    ├── pilotswarm-aks-identity/
    │   └── SKILL.md
    └── pilotswarm-azure-lessons/
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
