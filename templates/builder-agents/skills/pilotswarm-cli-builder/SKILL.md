---
name: pilotswarm-cli-builder
description: "Use when creating or updating a plugin-driven CLI/TUI app on top of PilotSwarm. Covers plugin.json branding, agent/skill layout, worker modules, keybinding/help sync, and the DevOps sample structure."
---

# PilotSwarm CLI Builder

Build layered CLI/TUI apps on top of the shipped PilotSwarm interface.

## Canonical References

- CLI guide: `https://github.com/affandar/pilotswarm/blob/main/docs/cli/building-cli-apps.md`
- CLI agent guide: `https://github.com/affandar/pilotswarm/blob/main/docs/cli/building-agents.md`
- Keybindings: `https://github.com/affandar/pilotswarm/blob/main/docs/keybindings.md`
- DevOps sample: `https://github.com/affandar/pilotswarm/tree/main/examples/devops-command-center`

## Preferred Structure

```text
my-app/
├── plugin/
│   ├── plugin.json
│   ├── agents/
│   ├── skills/
│   ├── .mcp.json
│   └── session-policy.json
├── worker-module.js
└── README.md
```

## Workflow

1. Identify whether the app should use the shipped TUI rather than a custom UI.
2. Run a guided intake before scaffolding.
3. Create `plugin/plugin.json` when the user wants app branding.
4. Put prompts and personas in `plugin/agents/*.agent.md`.
5. Treat `plugin/agents/default.agent.md` as the app-wide default overlay under PilotSwarm's embedded framework base.
6. Put reusable domain knowledge in `plugin/skills/*/SKILL.md`.
7. Put runtime tool handlers in `worker-module.js`.
8. Add `session-policy.json` if the user does not want generic sessions.
9. Build `.env.example` and a gitignored `.env` from the PilotSwarm sample env shape when the user wants runnable scaffolding.
10. Add a README with local run instructions.

## Guided Intake Questions

Before generating files, ask:

1. Should the app allow generic sessions under the default agent, or should usage be steered into named agents through a restrictive session policy?
2. Which values should be plugged into `.env` now, especially `GITHUB_TOKEN` and `DATABASE_URL`?
3. If the user has not specified the agent roster, what workflows should the app support so you can derive the first agent set?
4. Which topology should the scaffold target?
   - local-only, using Docker Postgres
   - standard remote topology using AKS + PostgreSQL + Blob storage
   - custom topology supplied by the user

Do not guess these answers when the user has not provided them. Offer the standard topology choices explicitly so the guided experience stays fast.

## Env File Guidance

- Treat `DATABASE_URL` as the canonical PostgreSQL connection input.
- Do not generate redundant `PGHOST`, `PGPORT`, `PGUSER`, `PGPASSWORD`, or `PGDATABASE` entries unless the user explicitly needs them.
- Prefer a checked-in `.env.example` plus a local gitignored `.env`.
- Align the variable set with the PilotSwarm sample env shape, typically including:
  - `DATABASE_URL`
  - `GITHUB_TOKEN`
  - `LLM_PROVIDER_TYPE`
  - `LLM_ENDPOINT`
  - `LLM_API_KEY`
  - `LLM_API_VERSION`
  - optional storage or deployment variables for the chosen topology
- Only copy secrets from another repo or local file after the user explicitly asks for that behavior.

## Agent Derivation Guidance

- If the user names agents, scaffold those agents directly.
- If the user only describes workflows, derive a starter agent set from those workflows and explain the mapping.
- Keep the first scaffold minimal but coherent; do not invent a large agent roster without justification.

## `plugin.json` Guidance

Use `plugin.json` for metadata and TUI branding.

Example:

```json
{
  "name": "devops",
  "description": "DevOps Command Center",
  "version": "1.0.0",
  "tui": {
    "title": "DevOps Command Center",
    "splashFile": "./tui-splash.txt"
  }
}
```

## Guardrails

- Do not put tool implementations into agent markdown files.
- Do not model developer-facing builder behavior as runtime system agents.
- Keep prompts, skills, tool handlers, and branding in separate layers.
- If you add or change TUI keybindings, update help/keybinding surfaces together.
- Treat system-agent `initialPrompt` as bootstrap startup content, not a user-authored chat line.
- Assume apps consume `pilotswarm-cli` and `pilotswarm-sdk`; built-in PilotSwarm plugins are embedded in those packages, not copied into the app repo.
- Prefer generated app instructions that install `pilotswarm-cli` and `pilotswarm-sdk` from npm before suggesting local clone or link workflows.
