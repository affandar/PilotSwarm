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
├── .gitignore
├── .env.example
├── .model_providers.example.json
├── package.json
├── plugin/
│   ├── plugin.json
│   ├── agents/
│   ├── skills/
│   ├── .mcp.json
│   └── session-policy.json
├── scripts/
│   ├── run.sh
│   └── cleanup-local-db.js
├── worker-module.js
└── README.md
```

## Workflow

1. Identify whether the app should use the shipped TUI rather than a custom UI.
2. Run a guided intake before scaffolding.
3. Create `plugin/plugin.json` when the user wants app branding.
4. Put prompts and personas in `plugin/agents/*.agent.md`.
5. Treat `plugin/agents/default.agent.md` as the app-wide default overlay under PilotSwarm's embedded framework base. It is **not** a selectable session agent — PilotSwarm excludes it from the agent picker, the client rejects `createSession` calls with `agentId: "default"`, and the worker never adds it to `allowedAgentNames`. Do not name any other agent file `default`.
6. Put reusable domain knowledge in `plugin/skills/*/SKILL.md`.
7. Put runtime tool handlers in `worker-module.js`.
8. Add `session-policy.json` if the user does not want generic sessions. The policy is enforced in both local and remote modes — the TUI reads it from the plugin directory even when there are no embedded workers.
9. Build `.env.example` and a gitignored `.env` by copying/adapting the PilotSwarm repo's example env shape when the user wants runnable scaffolding.
10. Build `.model_providers.example.json` and a gitignored `.model_providers.json` by copying/adapting the PilotSwarm repo's example model-catalog shape when the scaffold needs a custom model catalog.
11. Add checked-in scripts for launch and database cleanup (both local and remote modes).
12. Make generated scripts executable and verify the executable bit.
13. Add a README with local run instructions.
14. When agents need durable structured memory or shared coordination state, use PilotSwarm's built-in facts tools (`store_fact`, `read_facts`, `delete_fact`) as the primary memory layer. They are available to every agent session by default, including system agents, so do not build a separate fact table unless the app truly requires it.
15. When agents need recurring autonomous work (monitoring, polling, periodic cleanup), use the durable `cron` tool: `cron(seconds=N, reason="...")` to start, `cron(action="cancel")` to stop. Cron schedules survive process restarts and worker failovers. Prefer cron over `wait` loops for periodic tasks.
16. Agents can read their context usage (current tokens, token limit) from the session status. The TUI displays this in the status bar. Use this for agents that need to manage context window budgets or trigger compaction.

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
- If the app needs a non-default model catalog, check in `.model_providers.example.json`, create the real `.model_providers.json` locally from it, and keep provider keys in `.env` / `.env.remote`.
- For local-first scaffolds, assume GitHub Copilot is the only model provider unless the user explicitly asks for another provider.
- For local-first scaffolds, do not include `LLM_PROVIDER_TYPE`, `LLM_ENDPOINT`, `LLM_API_KEY`, or `LLM_API_VERSION` by default.
- Do not generate redundant `PGHOST`, `PGPORT`, `PGUSER`, `PGPASSWORD`, or `PGDATABASE` entries unless the user explicitly needs them.
- Prefer a checked-in `.env.example` plus a local gitignored `.env`.
- Prefer a checked-in `.model_providers.example.json` plus a local gitignored `.model_providers.json`.
- Add both `.env` and `.model_providers.json` to `.gitignore` in runnable scaffolds.
- Align the variable set with the chosen topology rather than blindly copying every sample env field.
- For local-first scaffolds, the default env surface should usually be:
  - `DATABASE_URL`
  - `GITHUB_TOKEN`
- Add optional storage or deployment variables only when the topology requires them.
- Only copy secrets from another repo or local file after the user explicitly asks for that behavior.

## Database Cleanup Guidance

- Generate a single cleanup script (`scripts/cleanup-local-db.js`) that handles both local and remote modes:
  - `node scripts/cleanup-local-db.js` — uses `.env` (local)
  - `node scripts/cleanup-local-db.js remote` — uses `.env.remote`
- Parse `sslmode` from the `DATABASE_URL` and pass `ssl: { rejectUnauthorized: false }` to the `pg` client when connecting to Azure PostgreSQL. Follow the pattern in the DevOps sample's cleanup script.
- Query session IDs from CMS (`copilot_sessions.sessions`) before dropping schemas.
- In local mode, also remove local files for each session:
  - Artifact directories at `~/.copilot/artifacts/<sessionId>/`
  - Session state dirs at `~/.copilot/session-state/<sessionId>/`
  - Session store archives at `~/.copilot/session-store/<sessionId>.tar.gz` and `.meta.json`
- In remote mode, skip local file cleanup (artifacts live in blob storage).
- Drop `duroxide` and `copilot_sessions` schemas.
- In remote mode, print the `kubectl rollout restart` command to recreate schemas.
- Wire `package.json` scripts:
  - `"cleanup": "node scripts/cleanup-local-db.js"`
  - `"cleanup:remote": "node scripts/cleanup-local-db.js remote"`
- Follow the pattern in PilotSwarm's DevOps sample `scripts/cleanup-local-db.js`.

## Launcher Script Guidance

- Generate a single `scripts/run.sh` that supports both local and remote modes:
  - `./scripts/run.sh` or `./scripts/run.sh local` — local mode with embedded workers
  - `./scripts/run.sh remote` — remote mode connecting to AKS workers
- Wire `package.json` scripts to point at `run.sh`:
  - `"start": "./scripts/run.sh"` for local
  - `"start:remote": "./scripts/run.sh remote"` for remote
- Use `.env` for local mode and `.env.remote` for remote mode. The script selects the right file based on the mode argument.
- Include preflight checks (env file exists, plugin dir exists, worker module exists for local).
- Use `exec npx pilotswarm ...` for local and `exec npx pilotswarm remote ...` for remote.
- Make the script executable and verify the executable bit after creation.
- Keep compatibility workarounds in the launcher or `postinstall` scripts, not scattered across README steps.

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
- Assume PostgreSQL-backed apps can opt into the built-in facts tools with agent `tools` lists instead of re-implementing fact storage from scratch.
- Prefer generated app instructions that install `pilotswarm-cli` and `pilotswarm-sdk` from npm before suggesting local clone or link workflows.
