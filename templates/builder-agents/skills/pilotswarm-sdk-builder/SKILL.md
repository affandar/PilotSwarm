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

1. Separate plugin content from runtime code.
2. Treat `plugin/agents/default.agent.md` as the app-wide default overlay, not as a replacement for PilotSwarm's embedded framework base.
3. Define tools with `defineTool()` in worker-side code.
4. Register tool handlers on the worker.
5. Reference those handlers from sessions via `toolNames`.
6. Keep client session config serializable.
7. Add a local example or test that exercises the intended app flow.

## Guardrails

- Do not assume the client can execute tools.
- Do not collapse prompts, worker logic, and app wiring into one file unless the user explicitly wants a tiny demo.
- Prefer plugin files for prompts and skills even in SDK-first apps.
- Keep session policy and agent restrictions in config files rather than hand-wavy prompt text.
- Use the DevOps sample as the reference for the layered split, not as a literal one-size-fits-all template.
- Assume apps consume `@affandar/pilotswarm`, whose built-in framework and management plugins are embedded rather than copied into the app repo.
