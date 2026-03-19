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
3. Treat `plugin/agents/default.agent.md` as the app-wide default overlay, not as a replacement for PilotSwarm's embedded framework base.
4. Define tools with `defineTool()` in worker-side code.
5. Register tool handlers on the worker.
6. Reference those handlers from sessions via `toolNames`.
7. Keep client session config serializable.
8. Add `session-policy.json` if the user does not want generic sessions.
9. Build `.env.example` and a gitignored `.env` from the PilotSwarm sample env shape when the user wants runnable scaffolding.
10. Add a local example or test that exercises the intended app flow.

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

## Validation Guidance

- When the user wants runnable scaffolding, do more than write files: install dependencies and run a smoke test.
- Do not treat `--help` output or a dry import as proof that the full app path actually starts.
- Check the declared runtime requirements and compare them against the current machine.
- If the scaffold defaults or inferred decisions matter, record them in the generated README.

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
- Keep session policy and agent restrictions in config files rather than hand-wavy prompt text.
- Use the DevOps sample as the reference for the layered split, not as a literal one-size-fits-all template.
- Assume apps consume `pilotswarm-sdk`, whose built-in framework and management plugins are embedded rather than copied into the app repo.
- Prefer generated app instructions that install `pilotswarm-sdk` from npm before falling back to local file or link workflows.
