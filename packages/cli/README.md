# pilotswarm-cli

Terminal UI for PilotSwarm.

Install:

```bash
npm install pilotswarm-cli
```

For app-specific worker modules or direct SDK imports, also add:

```bash
npm install pilotswarm-sdk
```

Run locally against a plugin directory:

```bash
npx pilotswarm local --env .env --plugin ./plugin --worker ./worker-module.js
```

`pilotswarm-cli` provides the shipped TUI. Your app customizes it with `plugin/plugin.json`, `plugin/agents/*.agent.md`, `plugin/skills/*/SKILL.md`, and optional worker-side tools.

The shipped files inspector supports shared artifact browsing, download, local open, and delete flows. Binary artifacts download intact rather than being coerced through UTF-8 text previews.

Portal/runtime helpers that are intentionally shared with `pilotswarm-web`
are exported from `pilotswarm-cli/portal`.

Common docs:

- CLI apps: `https://github.com/affandar/PilotSwarm/blob/main/docs/cli/building-cli-apps.md`
- CLI agents: `https://github.com/affandar/PilotSwarm/blob/main/docs/cli/building-agents.md`
- Keybindings: `https://github.com/affandar/PilotSwarm/blob/main/docs/keybindings.md`
- DevOps sample: `https://github.com/affandar/PilotSwarm/tree/main/examples/devops-command-center`
