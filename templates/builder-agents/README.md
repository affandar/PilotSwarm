# PilotSwarm Builder Agents

These are distributable Copilot custom-agent templates for users who are building apps on top of PilotSwarm.

They are not active in this repository. Copy them into the target repository you want to assist.

## Included Agents

- `pilotswarm-cli-builder` — scaffolds plugin-driven CLI/TUI apps built on the shipped PilotSwarm UI
- `pilotswarm-portal-builder` — scaffolds browser-portal customization, portal branding, and auth add-on wiring
- `pilotswarm-sdk-builder` — scaffolds SDK-first apps and services built around `PilotSwarmClient` and `PilotSwarmWorker`
- `pilotswarm-azure-deployer` — prepares PilotSwarm-based apps for Azure / AKS deployment, including env templates, manifests, and worker observability

## Included Skills (split for focused retrieval)

- `pilotswarm-cli-builder` — CLI/TUI scaffold guidance, env files, launcher scripts
- `pilotswarm-portal-builder` — portal branding, `plugin.json.portal`, auth add-ons, and deployment wiring
- `pilotswarm-sdk-builder` — SDK app scaffold guidance, client/worker split, tests
- `pilotswarm-agent-versioning` — `.agent.md` schema/version frontmatter and version bump guidance
- `pilotswarm-hybrid-datastore` — stock PostgreSQL runtime storage plus optional HorizonDB enhanced facts/search/graph wiring
- `pilotswarm-knowledge-harvester` — optional EnhancedFactStore + knowledge-graph wiring, `crawler: true` agent template, crawl→graph→reader flow, ACL/evidence model, tests
- `pilotswarm-duroxide-versioning` — durable orchestration versioning, continue-as-new upgrades, compatibility rules
- `pilotswarm-azure-deployer` — deployment workflow, manifests, env checklist, `RUST_LOG` observability
- `pilotswarm-aks-identity` — cross-cluster AKS access, Workload Identity, kubectl patterns
- `pilotswarm-azure-lessons` — RBAC conditional access workaround, PostgreSQL region restrictions, Key Vault + CSI
- `pilotswarm-three-tier` — dedicated worker-cluster topology for long-running or dehydration-resistant jobs

These templates assume apps consume:

- `pilotswarm-sdk`
- `pilotswarm` (the app package: TUI + portal + MCP bins)

from npm:

```bash
npm install pilotswarm-sdk
npm install pilotswarm
```

and that PilotSwarm's built-in framework and management plugins are embedded in those packages while app `default.agent.md` files act as app-wide overlays.

If the target app needs a custom model catalog, check in `.model_providers.example.json`, create a local gitignored `.model_providers.json` from it, and keep actual credentials in `.env` / `.env.remote`. Runnable scaffolds should copy and adapt PilotSwarm's own example files, set up both `.env` and `.model_providers.json` from those corresponding examples, and add the real files to `.gitignore`.

PilotSwarm includes built-in facts tools (`store_fact`, `read_facts`, `delete_fact`) on workers, and they are available to every agent session by default, including system agents. Use them for durable structured memory and shared cross-agent state instead of inventing an app-specific facts table unless the app truly needs one.

PilotSwarm also ships optional SDK-bundled named agents under its `default-agents` tier. They stay hidden unless an app opts in through `session-policy.json` with `creation.bundledAgents`, for example `"bundledAgents": ["generic-crawler"]`. Builder templates should teach that opt-in instead of copying bundled agent files, unless the app needs to customize the agent.

Every generated app `.agent.md` should include `schemaVersion: 1` and a `version` string. Use `version: 1.0.0` for new agents by default, prefer SemVer for app convenience, and bump the version string when changing an existing agent's prompt behavior, tool expectations, workflow guidance, metadata, output shape, or child-contract expectations.

Generated agents should use `cron(seconds=N, reason="...")` for fixed-interval recurring work and `cron_at(minute=M, hour=H, tz="Area/City", reason="...")` for wall-clock schedules. Do not teach agents to wake every N minutes just to check whether a calendar time has arrived. For long-running child sessions, include `contract.wakeOn` guidance so watcher children default to `material_change` instead of waking parents for no-op heartbeats.

Artifact workflows should assume the consolidated `write_artifact` / `read_artifact` / `list_artifacts` surface. Files that already exist on the worker (builds, archives, binaries) upload via `write_artifact({fromFile})` and download via `read_artifact({toFile})` — bytes stream server-side and every result carries a `sha256` plus the `artifact://` link. Reserve inline `content` (with `contentType` + base64 for small binaries) for text the agent is authoring, and explain that the browser portal downloads binary artifacts rather than previewing them inline.

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
│   ├── pilotswarm-portal-builder.agent.md
│   ├── pilotswarm-sdk-builder.agent.md
│   └── pilotswarm-azure-deployer.agent.md
└── skills/
    ├── pilotswarm-cli-builder/
    │   └── SKILL.md
    ├── pilotswarm-portal-builder/
    │   └── SKILL.md
    ├── pilotswarm-sdk-builder/
    │   └── SKILL.md
    ├── pilotswarm-agent-versioning/
    │   └── SKILL.md
    ├── pilotswarm-hybrid-datastore/
    │   └── SKILL.md
    ├── pilotswarm-knowledge-harvester/
    │   └── SKILL.md
    ├── pilotswarm-duroxide-versioning/
    │   └── SKILL.md
    ├── pilotswarm-azure-deployer/
    │   └── SKILL.md
    ├── pilotswarm-aks-identity/
    │   └── SKILL.md
    ├── pilotswarm-three-tier/
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

## Topology Baseline (all templates assume this)

Every deployment exposes one integration surface: the portal's Web API
(`/api/v1` + `/api/v1/ws`). Clients — TUI (`npx pilotswarm remote --api-url`),
SDK apps (`new PilotSwarmClient({ apiUrl })`), the MCP server
(`pilotswarm-mcp --api-url`), and custom UXes on `pilotswarm-sdk/api` —
hold only the portal URL (plus an Entra token where auth is enabled). Only
workers and the portal server itself hold `DATABASE_URL`/blob/`HORIZON_*`
secrets. Direct `{ store }` client construction is for single-process demos,
tests, and cleanup scripts. See
`https://github.com/affandar/pilotswarm/blob/main/docs/architecture/layering.md`.

## Canonical References

- Starter Docker quickstart:
  `https://github.com/affandar/pilotswarm/blob/main/docs/quickstart/docker.md`
- CLI guide:
  `https://github.com/affandar/pilotswarm/blob/main/docs/developer/building/cli-apps.md`
- Portal guide:
  `https://github.com/affandar/pilotswarm/blob/main/packages/app/web/README.md`
- CLI agent guide:
  `https://github.com/affandar/pilotswarm/blob/main/docs/developer/building/cli-agents.md`
- SDK guide:
  `https://github.com/affandar/pilotswarm/blob/main/docs/developer/building/sdk-apps.md`
- SDK agent guide:
  `https://github.com/affandar/pilotswarm/blob/main/docs/developer/building/sdk-agents.md`
- Plugin architecture:
  `https://github.com/affandar/pilotswarm/blob/main/docs/developer/building/plugins.md`
- AKS deployment:
  `https://github.com/affandar/pilotswarm/blob/main/docs/developer/deploy/aks.md`
- DevOps sample:
  `https://github.com/affandar/pilotswarm/tree/main/examples/devops-command-center`

## Maintenance Rule

If PilotSwarm adds features or changes behavior relevant to app builders, update these templates as part of the same change whenever practical.
