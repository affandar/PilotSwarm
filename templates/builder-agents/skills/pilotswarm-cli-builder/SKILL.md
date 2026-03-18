---
name: pilotswarm-cli-builder
description: "Use when creating or updating a plugin-driven CLI/TUI app on top of PilotSwarm. Covers plugin.json branding, agent/skill layout, worker modules, keybinding/help sync, and the DevOps sample structure."
---

# PilotSwarm CLI Builder

Build layered CLI/TUI apps on top of the shipped PilotSwarm interface.

## Canonical References

- CLI guide: `https://github.com/microsoft/pilotswarm/blob/main/docs/cli/building-cli-apps.md`
- CLI agent guide: `https://github.com/microsoft/pilotswarm/blob/main/docs/cli/building-agents.md`
- Keybindings: `https://github.com/microsoft/pilotswarm/blob/main/docs/keybindings.md`
- DevOps sample: `https://github.com/microsoft/pilotswarm/tree/main/examples/devops-command-center`

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
2. Create `plugin/plugin.json` when the user wants app branding.
3. Put prompts and personas in `plugin/agents/*.agent.md`.
4. Put reusable domain knowledge in `plugin/skills/*/SKILL.md`.
5. Put runtime tool handlers in `worker-module.js`.
6. Add `session-policy.json` if the app should restrict which agents users may create.
7. Add a README with local run instructions.

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