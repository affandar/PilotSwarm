# PilotSwarm Tour Guide

A one-agent PilotSwarm package that teaches PilotSwarm's own architecture as a
paced, guided tour. It exists as a sample of three things an agent can do that
are easy to miss:

| Feature | Where | What it does |
|---|---|---|
| **Self-start** | `initialPrompt` | The runtime sends it as the first user message when a session starts blank, so the agent opens the conversation instead of waiting |
| **Splash art** | `splash` / `splashMobile` | Terminal-markup banner shown when the session is selected; the mobile variant is swapped in when the pane is narrower than the art |
| **Scoped MCP** | `mcpServers` + `inheritDefaultMcpServers: false` | Attaches only this package's DeepWiki server, and none of the deployment's defaults |

There is no separate "autostart" switch — an agent is self-starting precisely
because it declares an `initialPrompt`.

## Layout

```
pilotswarm-tour-guide/
├── plugin.json                                  # manifest mode
├── .mcp.json                                    # one remote http server: deepwiki
├── agents/pilotswarm-tour-guide.agent.md        # the tour; self-starting, with splashes
├── skills/pilotswarm-architecture/SKILL.md      # the compact map, preloaded into the prompt
└── README.md
```

The skill is deliberately short: a preloaded skill is inlined into the prompt
on every turn, so it carries the map and nothing more. Everything past it comes
from DeepWiki against `affandar/PilotSwarm` at question time.

## Splash art alignment

Box-drawing art only closes if every line has the same **visible** width once
markup is stripped. To check:

```bash
node --input-type=module -e '
import fs from "node:fs";
const fm = fs.readFileSync("agents/pilotswarm-tour-guide.agent.md", "utf8").split("---")[1];
for (const key of ["splash", "splashMobile"]) {
  const lines = fm.split(new RegExp(`^${key}: \\|$`, "m"))[1].split("\n").slice(1);
  const widths = [];
  for (const line of lines) {
    if (/^[a-zA-Z#]/.test(line)) break;
    widths.push(line.trim() ? [...line.replace(/\{\/?[a-z-]+\}/g, "")].length : 0);
  }
  console.log(key, widths.join(", "));
}'
```

## Related

The manifest, agent, skill and MCP contracts this package implements are
documented in
[Building an Agent Package for PilotSwarm](../../../docs/building-agent-packages.md).
For a larger, multi-agent package with worker tools, see
[finance-research-lab](../finance-research-lab/).
