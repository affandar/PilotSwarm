# pilotswarm

The PilotSwarm application package — one install gives you every user-facing
surface of a [PilotSwarm](https://github.com/affandar/pilotswarm) deployment:

| Bin | What it is |
|---|---|
| `pilotswarm` | Terminal UI. `pilotswarm remote --api-url <portal-url>` attaches to any deployment (auto Entra sign-in); `pilotswarm local` runs an embedded dev stack. `pilotswarm-cli` is an alias. |
| `pilotswarm-web` | The portal server: hosts the browser UI **and** the deployment's Web API (`/api/v1` + `/api/v1/ws`) — the single integration surface every client rides. |
| `pilotswarm-mcp` | MCP server exposing PilotSwarm sessions/facts/models to Claude Code, Claude Desktop, Copilot CLI, VS Code, Cursor, or any MCP client. |

Requires **Node 24+**. Everything below assumes you already have a deployment's
portal URL — that URL is the only thing you need to configure.

---

## Quickstart

### 1. Install

```bash
npm install -g pilotswarm
```

(Or skip the install and prefix every command with `npx -p pilotswarm`.)

### 2. Sign in to a deployment

```bash
pilotswarm auth login --api-url https://portal.example.com
```

This opens your browser for Entra sign-in and caches the token under
`~/.config/pilotswarm/auth/<origin>.json`. **Every surface in this package —
the TUI and the MCP server — reads that same cache**, so you sign in once per
deployment, not once per client.

If the deployment has auth disabled, the command simply tells you so and there
is nothing to do.

```bash
pilotswarm auth status --api-url https://portal.example.com   # who am I, is the token still good
pilotswarm auth logout --api-url https://portal.example.com   # drop cached tokens for that origin
```

On a headless box (no browser), add `--device-code` to use the device-code flow
instead — but note many corporate tenants block device code via Conditional
Access.

### 3. Run the TUI

```bash
pilotswarm remote --api-url https://portal.example.com
```

The `remote` positional is required — `--api-url` without it is an error,
because bare `pilotswarm` means *local* mode. You can drop the flag entirely by
setting `PILOTSWARM_API_URL`, or by putting it in a `.env.remote` file next to
you (remote mode auto-loads `.env.remote`; local mode auto-loads `.env`):

```bash
export PILOTSWARM_API_URL=https://portal.example.com
pilotswarm remote
```

Step 2 is optional in practice: the TUI runs the same sign-in lazily on start
if no cached token is found. Running `auth login` first just gets the browser
dance out of the way before the full-screen UI takes over your terminal, and it
is what makes the MCP servers below work without any further setup.

Useful TUI flags: `-m, --model <name>` (initial model), `-p, --plugin <dir>`
(plugin directory), `-e, --env <file>` (env file), `-h, --help`.

---

## Connect your AI assistant (MCP)

`pilotswarm-mcp` is a local, stdio MCP server: your assistant spawns it as a
child process, and it calls the deployment's Web API **as you**, reusing the
token cached by `pilotswarm auth login`. Nothing extra is deployed, and no
secret goes into the config file — just the URL.

```
MCP host (Claude Code / Claude Desktop / Copilot CLI / VS Code)
   └─ spawns → pilotswarm-mcp (local, stdio)
                  └─ HTTPS → https://portal.example.com/api/v1
                             (your identity; your role decides your tool surface)
```

Your Entra app role gates the surface: admin-only tools (embedder start/stop,
`facts_admin`, `restart_system_session`, graph-namespace writes) register only
for admin credentials.

### Claude Code

```bash
claude mcp add pilotswarm -- npx -y -p pilotswarm pilotswarm-mcp \
  --api-url https://portal.example.com
```

Or check a `.mcp.json` into the project root so your whole team gets it:

```json
{
  "mcpServers": {
    "pilotswarm": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "-p", "pilotswarm", "pilotswarm-mcp",
               "--api-url", "https://portal.example.com"]
    }
  }
}
```

### Claude Desktop

Edit `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS)
or `%APPDATA%\Claude\claude_desktop_config.json` (Windows), then restart the
app:

```json
{
  "mcpServers": {
    "pilotswarm": {
      "command": "npx",
      "args": ["-y", "-p", "pilotswarm", "pilotswarm-mcp",
               "--api-url", "https://portal.example.com"]
    }
  }
}
```

### GitHub Copilot CLI

Write `.copilot/mcp-config.json` in the repo (or `~/.copilot/mcp-config.json`
to have it everywhere):

```json
{
  "mcpServers": {
    "pilotswarm": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "-p", "pilotswarm", "pilotswarm-mcp",
               "--api-url", "https://portal.example.com"]
    }
  }
}
```

### VS Code (Copilot)

Add `.vscode/mcp.json` to the workspace — note the key is `servers`, not
`mcpServers`. The server then shows up in agent mode's tool picker:

```json
{
  "servers": {
    "pilotswarm": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "-p", "pilotswarm", "pilotswarm-mcp",
               "--api-url", "https://portal.example.com"]
    }
  }
}
```

### Cursor

Same shape as Claude Desktop, in `~/.cursor/mcp.json` (or **Settings → MCP**).

### Check that it worked

Ask your assistant to call `get_capabilities`. You should get back
`mode: "web"`, your `admin` flag, and the deployment's facts/graph flags. Then
`list_sessions` for a fleet view, and `create_session` → `send_and_wait` to
drive one.

If it fails to start, run the same command by hand — the error is much easier
to read outside the MCP host:

```bash
npx -y -p pilotswarm pilotswarm-mcp --api-url https://portal.example.com --log-level info
```

The usual cause is a missing or expired token: re-run
`pilotswarm auth login --api-url <url>`.

### Non-interactive credentials (CI, service principals, containers)

There is no browser to sign in with, so hand the server a bearer token
directly:

```bash
PILOTSWARM_API_TOKEN=<token> npx -y -p pilotswarm pilotswarm-mcp \
  --api-url https://portal.example.com
```

### Remote / shared MCP over HTTP

For a shared endpoint rather than a per-user child process, run the server with
the HTTP transport and a bearer key clients must present:

```bash
PILOTSWARM_MCP_KEY=your-secret-key npx -y -p pilotswarm pilotswarm-mcp \
  --transport http --port 3100 --api-url https://portal.example.com
```

Clients then point at `http://your-host:3100/mcp` with an
`Authorization: Bearer ${PILOTSWARM_MCP_KEY}` header. Read the
[security model](https://github.com/affandar/pilotswarm/blob/main/packages/app/mcp/README.md#security-model)
before exposing this beyond localhost: the key is shared, and every client
behind it has the full scope of the deployment.

Full tool catalog, resources, and every flag:
[MCP server README](https://github.com/affandar/pilotswarm/blob/main/packages/app/mcp/README.md).

---

## Other surfaces

**Run everything locally** (embedded workers, no deployment, no auth) — the fast
way to try PilotSwarm or develop a plugin:

```bash
pilotswarm local            # bare `pilotswarm` does the same
pilotswarm local -p ./plugin -n 4
```

**Host a portal** — serves the browser UI and the Web API that every client
above rides on. Needs worker-side env (`DATABASE_URL`, model providers, …):

```bash
pilotswarm-web --plugin ./plugin
```

**Library surfaces** (used by the shipped UIs; importable for custom hosts):

- `pilotswarm/ui-core` — framework-free UI controller/state/selectors
- `pilotswarm/ui-react` — the shared React composition (Ink + DOM)
- `pilotswarm/host` — node-host layer (SDK transport, plugin/config resolution)
- `pilotswarm/web` — the portal server entry (`startServer`)

Building an app or service instead of a UI? You want
[`pilotswarm-sdk`](https://www.npmjs.com/package/pilotswarm-sdk) — including
its zero-dependency wire client at `pilotswarm-sdk/api`.

---

Docs: [Quick Start](https://github.com/affandar/pilotswarm/blob/main/docs/quickstart/docker.md) ·
[User Guide](https://github.com/affandar/pilotswarm/blob/main/docs/user-guide/README.md) ·
[MCP Setup](https://github.com/affandar/pilotswarm/blob/main/docs/user-guide/mcp-local-setup.md) ·
[Web API Reference](https://github.com/affandar/pilotswarm/blob/main/docs/api/reference.md) ·
[Architecture / Layering](https://github.com/affandar/pilotswarm/blob/main/docs/architecture/layering.md)
