# Building CLI Apps

This guide is for people building on the shipped PilotSwarm CLI/TUI.

If you want one concrete layered-app reference while reading this guide, use the DevOps sample in [examples/devops-command-center](../../examples/devops-command-center).

If you want reusable Copilot custom agents that help scaffold this kind of app in another repository, see [Builder Agent Templates](../builder-agents.md).

The current CLI story is simple:

- you use the existing TUI binary
- you provide a plugin directory
- optionally, you provide a worker module with custom tools

This is different from the older `tui-apps.md` AppAdapter concept. Today, the supported path is plugin- and worker-module-driven.

## What The CLI Package Is

`pilotswarm-cli` ships a terminal UI with two modes:

- `local` — embeds workers in the same process as the TUI
- `remote` — runs only the client/TUI and connects to already-running workers

The binary names are:

- `pilotswarm`
- `pilotswarm-cli`

## When To Use This Path

Choose the CLI/TUI path when:

- you want a ready-made multi-session terminal UI
- you are happy with the built-in layout and interaction model
- you mainly want to customize prompts, skills, tools, and plugins

Choose the SDK path when:

- you want a different UI or service API
- you need app-specific behavior outside the shipped TUI
- you want to embed PilotSwarm into another product

## The Two Extension Hooks

### 1. Plugin directory

The plugin directory supplies:

- `plugin.json`
- `agents/*.agent.md`
- `skills/*/SKILL.md`
- `.mcp.json`

`plugin.json` is not just metadata anymore. The CLI reads it for TUI branding:

- `tui.title` → terminal/tab title and root system-session title
- `tui.splash` or `tui.splashFile` → startup splash and root system-session splash

Pass it with:

```bash
npx pilotswarm --plugin ./plugin
```

### 2. Worker module

The worker module supplies local worker-side code such as custom tools.

Pass it with:

```bash
npx pilotswarm --plugin ./plugin --worker ./worker-tools.js
```

The module is loaded in local mode and can export:

- `tools`
- `systemMessage`
- `skillDirectories`
- `customAgents`
- `mcpServers`

The most common use is exporting `tools`.

## Recommended App Layout

```text
my-cli-app/
├── .env
├── plugin/
│   ├── plugin.json
│   ├── agents/
│   │   ├── default.agent.md
│   │   └── reviewer.agent.md
│   ├── skills/
│   │   └── code-review/
│   │       └── SKILL.md
│   └── .mcp.json
└── worker-tools.js
```

For a fuller example with layered agents, skills, session policy, TUI branding, and mock tools, see [examples/devops-command-center](../../examples/devops-command-center).

Minimal `plugin.json` example:

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

## Minimal Worker Module

```js
import { defineTool } from "pilotswarm-sdk";

const summarizeRepo = defineTool("summarize_repo", {
  description: "Summarize the current repository",
  parameters: {
    type: "object",
    properties: {},
  },
  handler: async () => {
    return "Repository summary goes here.";
  },
});

export default {
  tools: [summarizeRepo],
};
```

## Running Locally

```bash
npx pilotswarm local --env .env --plugin ./plugin --worker ./worker-tools.js
```

In local mode:

- the TUI starts the client
- the TUI starts embedded workers
- your plugin directory and worker module are loaded in the same process

This is the easiest way to build and test a CLI app.

## Running Against Remote Workers

```bash
npx pilotswarm remote --env .env.remote --store "$DATABASE_URL"
```

In remote mode:

- the TUI is client-only
- your local `--plugin` and `--worker` do not magically change the remote workers
- the remote worker image or process must already include the same plugins and tool code

This is the most important CLI caveat.

## What You Can And Cannot Customize Today

### Easy

- prompts
- agents
- skills
- MCP config
- local worker-side tools
- model and app-level default prompt overlays

### Harder / contributor-level

- layout
- panes
- rendering rules
- observer lifecycle
- session-list behavior
- prompt editor behavior and keybindings

For those, you are working on PilotSwarm itself. See [Working On PilotSwarm](../contributors/working-on-pilotswarm.md).

## TUI Contracts Worth Knowing

- The CLI always prefers the root `pilotswarm` system session as the initially selected session when it exists.
- `?` opens the keybinding modal in navigation modes.
- In prompt mode, `Esc` returns focus to navigation mode.
- The prompt editor supports multiline input: `Option+Enter` inserts a newline instead of submitting.
- If you change keybindings in the TUI implementation, update the startup help hint, the help modal, and any contextual status hints together.

## What To Read Next

- [Building Agents For CLI Apps](./building-agents.md)
- [Keybindings](../keybindings.md)
- [Examples](../examples.md)
- [Getting Started](../getting-started.md)
