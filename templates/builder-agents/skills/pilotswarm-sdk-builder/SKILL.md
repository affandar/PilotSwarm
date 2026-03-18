---
name: pilotswarm-sdk-builder
description: "Use when creating or updating an SDK-first app on top of PilotSwarm. Covers the client/worker split, plugin layering, tool registration, tests, and the DevOps sample structure."
---

# PilotSwarm SDK Builder

Build layered SDK-first applications on top of PilotSwarm.

## Canonical References

- SDK guide: `https://github.com/microsoft/pilotswarm/blob/main/docs/sdk/building-apps.md`
- SDK agent guide: `https://github.com/microsoft/pilotswarm/blob/main/docs/sdk/building-agents.md`
- Plugin architecture: `https://github.com/microsoft/pilotswarm/blob/main/docs/plugin-architecture-guide.md`
- DevOps sample: `https://github.com/microsoft/pilotswarm/tree/main/examples/devops-command-center`

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
2. Define tools with `defineTool()` in worker-side code.
3. Register tool handlers on the worker.
4. Reference those handlers from sessions via `toolNames`.
5. Keep client session config serializable.
6. Add a local example or test that exercises the intended app flow.

## Guardrails

- Do not assume the client can execute tools.
- Do not collapse prompts, worker logic, and app wiring into one file unless the user explicitly wants a tiny demo.
- Prefer plugin files for prompts and skills even in SDK-first apps.
- Keep session policy and agent restrictions in config files rather than hand-wavy prompt text.
- Use the DevOps sample as the reference for the layered split, not as a literal one-size-fits-all template.