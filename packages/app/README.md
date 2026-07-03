# pilotswarm

The PilotSwarm application package — one install gives you every user-facing
surface of a [PilotSwarm](https://github.com/affandar/pilotswarm) deployment:

| Bin | What it is |
|---|---|
| `pilotswarm` | Terminal UI. `pilotswarm remote --api-url <portal-url>` attaches to any deployment (auto Entra sign-in); `pilotswarm local` runs an embedded dev stack. `pilotswarm-cli` is an alias. |
| `pilotswarm-web` | The portal server: hosts the browser UI **and** the deployment's Web API (`/api/v1` + `/api/v1/ws`) — the single integration surface every client rides. |
| `pilotswarm-mcp` | MCP server exposing PilotSwarm sessions/facts/models to Claude Desktop, Cursor, or any MCP client. `--api-url <portal-url>` is the supported mode. |

```bash
npm install -g pilotswarm

# attach the TUI to a deployment — the URL is the only credential you need
pilotswarm remote --api-url https://portal.example.com

# host a portal (needs worker-side env: DATABASE_URL etc.)
pilotswarm-web --plugin ./plugin

# expose a deployment to an MCP client
pilotswarm-mcp --api-url https://portal.example.com
```

Library surfaces (used by the shipped UIs; importable for custom hosts):

- `pilotswarm/ui-core` — framework-free UI controller/state/selectors
- `pilotswarm/ui-react` — the shared React composition (Ink + DOM)
- `pilotswarm/host` — node-host layer (SDK transport, plugin/config resolution)
- `pilotswarm/web` — the portal server entry (`startServer`)

Building an app or service instead of a UI? You want
[`pilotswarm-sdk`](https://www.npmjs.com/package/pilotswarm-sdk) — including
its zero-dependency wire client at `pilotswarm-sdk/api`.

Docs: [Quick Start](https://github.com/affandar/pilotswarm/blob/main/docs/quickstart/docker.md) ·
[User Guide](https://github.com/affandar/pilotswarm/blob/main/docs/user-guide/README.md) ·
[Web API Reference](https://github.com/affandar/pilotswarm/blob/main/docs/api/reference.md) ·
[Architecture / Layering](https://github.com/affandar/pilotswarm/blob/main/docs/architecture/layering.md)
