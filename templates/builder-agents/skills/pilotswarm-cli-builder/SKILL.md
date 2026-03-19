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
├── .env.example
├── package.json
├── plugin/
│   ├── plugin.json
│   ├── agents/
│   ├── skills/
│   ├── .mcp.json
│   └── session-policy.json
├── scripts/
│   ├── run-local.js
│   └── cleanup-local-db.js
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
10. Add checked-in scripts for local launch and local database cleanup.
11. Make generated scripts executable and verify the executable bit.
12. Add a README with local run instructions.

## Guided Intake Questions

Before generating files, ask:

1. Should the app allow generic sessions under the default agent, or should usage be steered into named agents through a restrictive session policy?
2. What should be used for `GITHUB_TOKEN` in `.env`?
3. What should be used for `DATABASE_URL` in `.env`?
4. What local database name should the scaffold use? If unspecified, default it explicitly to the workspace name.
5. If the user has not specified the agent roster, what workflows should the app support so you can derive the first agent set?
6. Which topology should the scaffold target?
   - local-only, using Docker Postgres
   - standard remote topology using AKS + PostgreSQL + Blob storage
   - custom topology supplied by the user

Do not guess these answers when the user has not provided them. Offer the standard topology choices explicitly so the guided experience stays fast.

## Env File Guidance

- Treat `DATABASE_URL` as the canonical PostgreSQL connection input.
- For local-first scaffolds, assume GitHub Copilot is the only model provider unless the user explicitly asks for another provider.
- For local-first scaffolds, do not include `LLM_PROVIDER_TYPE`, `LLM_ENDPOINT`, `LLM_API_KEY`, or `LLM_API_VERSION` by default.
- Do not generate redundant `PGHOST`, `PGPORT`, `PGUSER`, `PGPASSWORD`, or `PGDATABASE` entries unless the user explicitly needs them.
- Prefer a checked-in `.env.example` plus a local gitignored `.env`.
- Align the variable set with the chosen topology rather than blindly copying every sample env field.
- For local-first scaffolds, the default env surface should usually be:
  - `DATABASE_URL`
  - `GITHUB_TOKEN`
- Add optional storage or deployment variables only when the topology requires them.
- Only copy secrets from another repo or local file after the user explicitly asks for that behavior.

## Local Database Guidance

- Ask the user for the local database name separately from `DATABASE_URL` when scaffolding a local-first app.
- If the user does not care, default the database name to the workspace name.
- Generate a checked-in local cleanup script for the local database and document what it removes.
- Keep the cleanup script scoped to local development and name it clearly, for example `scripts/cleanup-local-db.js`.

## Launcher Script Guidance

- For runnable CLI scaffolds, prefer generating a checked-in launcher under `scripts/`.
- Use the launcher as the canonical entrypoint for local and remote modes.
- Keep `package.json` scripts thin and point them at the launcher.
- Use the launcher for env selection, preflight checks, and isolated compatibility workarounds.
- If a dependency or runtime issue requires a workaround, keep that logic in the launcher or setup scripts rather than scattering it across README steps and npm scripts.
- Generated scripts should include a Node shebang so they can be run directly from the shell.
- After creating scripts, make them executable and verify that the executable bit was actually applied.

## Validation Guidance

- When the user wants runnable scaffolding, do more than write files: install dependencies and run a smoke test.
- Do not treat `--help` output as proof that the app actually starts; prefer the real startup path when practical.
- Check the declared runtime requirements and compare them against the current machine.
- If scripts are intended to be run directly, verify direct execution rather than only `node script.js`.
- If the scaffold defaults or inferred decisions matter, record them in the generated README.

## Compatibility Guidance

- If the generated app hits a known dependency issue during setup, isolate the workaround in setup or launcher scripts and explain why it exists.
- Prefer deterministic fixes that can be re-applied after reinstall, such as `postinstall` or a verified pre-launch patch step, over one-off manual instructions.
- Remove or simplify compatibility shims once the upstream dependency is fixed.

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
