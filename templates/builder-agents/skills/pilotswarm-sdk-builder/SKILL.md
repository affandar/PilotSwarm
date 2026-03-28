---
name: pilotswarm-sdk-builder
description: "Use when creating or updating an SDK-first app on top of PilotSwarm. Covers the client/worker split, plugin layering, tool registration, tests, and the DevOps sample structure."
---

# PilotSwarm SDK Builder

Build layered SDK-first applications on top of PilotSwarm.

## Canonical References

- SDK guide: `https://github.com/affandar/pilotswarm/blob/main/docs/sdk/building-apps.md`
- SDK agent guide: `https://github.com/affandar/pilotswarm/blob/main/docs/sdk/building-agents.md`
- Plugin architecture: `https://github.com/affandar/pilotswarm/blob/main/docs/plugin-architecture-guide.md`
- DevOps sample: `https://github.com/affandar/pilotswarm/tree/main/examples/devops-command-center`

## Preferred Structure

```text
my-sdk-app/
├── plugin/
│   ├── agents/
│   ├── skills/
│   ├── .mcp.json
│   └── session-policy.json
├── scripts/
│   ├── run.sh
│   └── cleanup-local-db.js
├── src/
│   ├── tools.ts
│   ├── worker.ts
│   ├── client.ts
│   └── app.ts
└── test/
```

## Workflow

1. Run a guided intake before scaffolding.
2. Separate plugin content from runtime code.
3. Treat `plugin/agents/default.agent.md` as the app-wide default overlay, not as a replacement for PilotSwarm's embedded framework base. It is **not** a selectable session agent — PilotSwarm excludes it at all three layers (worker, client, TUI). Do not name any other agent file `default`.
4. Define tools with `defineTool()` in worker-side code.
5. Register tool handlers on the worker.
6. Reference those handlers from sessions via `toolNames`.
7. Keep client session config serializable.
8. Add `session-policy.json` if the user does not want generic sessions. The policy is enforced in both local and remote modes.
9. Build `.env.example` and a gitignored `.env` by copying/adapting the PilotSwarm repo's example env shape when the user wants runnable scaffolding.
10. Build `.model_providers.example.json` and a gitignored `.model_providers.json` by copying/adapting the PilotSwarm repo's example model-catalog shape when the scaffold needs a custom model catalog.
11. Add a checked-in cleanup script that drops database schemas and removes session state (handles both local and remote modes).
12. Add a local example or test that exercises the intended app flow.
13. When agents need durable structured memory or cross-agent shared state, use PilotSwarm's built-in facts tools (`store_fact`, `read_facts`, `delete_fact`). They are available to every agent session by default, including system agents, and should be treated as the primary memory mechanism instead of inventing a one-off app-specific table.
14. When agents need recurring autonomous work (monitoring, polling, periodic cleanup), use the durable `cron` tool: `cron(seconds=N, reason="...")` to start, `cron(action="cancel")` to stop. Cron schedules survive process restarts and worker failovers. Prefer cron over `wait` loops for periodic tasks.
15. Agents can read their context usage (current tokens, token limit) from the session status `contextUsage` field. Use this for agents that need to manage context window budgets or trigger compaction.

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
- If the app needs a non-default model catalog, check in `.model_providers.example.json`, create the real `.model_providers.json` locally from it, and keep provider keys in `.env` / `.env.remote`.
- Do not generate redundant `PGHOST`, `PGPORT`, `PGUSER`, `PGPASSWORD`, or `PGDATABASE` entries unless the user explicitly needs them.
- Prefer a checked-in `.env.example` plus a local gitignored `.env`.
- Prefer a checked-in `.model_providers.example.json` plus a local gitignored `.model_providers.json`.
- Add both `.env` and `.model_providers.json` to `.gitignore` in runnable scaffolds.
- Align the variable set with the PilotSwarm sample env shape, typically including:
	- `DATABASE_URL`
	- `GITHUB_TOKEN`
	- `LLM_PROVIDER_TYPE`
	- `LLM_ENDPOINT`
	- `LLM_API_KEY`
	- `LLM_API_VERSION`
	- optional storage or deployment variables for the chosen topology
- Only copy secrets from another repo or local file after the user explicitly asks for that behavior.

## Validation Guidance

- When the user wants runnable scaffolding, do more than write files: install dependencies and run a smoke test.
- Do not treat `--help` output or a dry import as proof that the full app path actually starts.
- Check the declared runtime requirements and compare them against the current machine.
- If the scaffold defaults or inferred decisions matter, record them in the generated README.

## Launcher Script Guidance

- Generate a single `scripts/run.sh` that supports both local and remote modes:
  - `./scripts/run.sh` or `./scripts/run.sh local` — local mode
  - `./scripts/run.sh remote` — remote mode connecting to AKS workers
- Wire `package.json` scripts to point at `run.sh`:
  - `"start": "./scripts/run.sh"` for local
  - `"start:remote": "./scripts/run.sh remote"` for remote
- Use `.env` for local mode and `.env.remote` for remote mode. The script selects the right file based on the mode argument.
- Include preflight checks (env file exists, plugin dir exists).
- Make the script executable and verify the executable bit after creation.
- Keep compatibility workarounds in the launcher or `postinstall` scripts, not scattered across README steps.

## Compatibility Guidance

- If the generated app hits a known dependency issue during setup, isolate the workaround in setup scripts or a clearly documented bootstrap path and explain why it exists.
- Prefer deterministic fixes that can be re-applied after reinstall, such as `postinstall` or setup-time verification, over one-off manual instructions.
- Remove or simplify compatibility shims once the upstream dependency is fixed.

## Agent Derivation Guidance

- If the user names agents, scaffold those agents directly.
- If the user only describes workflows, derive a starter agent set from those workflows and explain the mapping.
- Keep the first scaffold minimal but coherent; do not invent a large agent roster without justification.

## Guardrails

- Do not assume the client can execute tools.
- Do not collapse prompts, worker logic, and app wiring into one file unless the user explicitly wants a tiny demo.
- Prefer plugin files for prompts and skills even in SDK-first apps.
- Keep session policy and agent restrictions in config files rather than hand-wavy prompt text. The policy is enforced in both local and remote modes.
- Never use `"default"` as an agent name for session-bound agents — PilotSwarm reserves it as a prompt overlay and rejects session creation for it at the client layer.
- Use the DevOps sample as the reference for the layered split, not as a literal one-size-fits-all template.
- Assume apps consume `pilotswarm-sdk`, whose built-in framework and management plugins are embedded rather than copied into the app repo.
- Assume PostgreSQL-backed apps can opt into the built-in facts tools with agent `tools` lists instead of re-implementing fact storage from scratch.
- Prefer generated app instructions that install `pilotswarm-sdk` from npm before falling back to local file or link workflows.

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
- Follow the pattern in PilotSwarm's DevOps sample `scripts/cleanup-local-db.js`.
- Document what the cleanup script removes in the generated README.
