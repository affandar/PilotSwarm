# PilotSwarm MCP Server

Exposes PilotSwarm sessions, agents, facts, and models to any MCP-compatible client via the [Model Context Protocol](https://modelcontextprotocol.io/). Connect Claude Desktop, Copilot CLI, Cursor, VS Code, ChatGPT, or any MCP client to a running PilotSwarm instance.

## Quick Start

### Stdio Transport (recommended for local IDEs)

```bash
npx -y -p pilotswarm-mcp-server pilotswarm-mcp --store "$DATABASE_URL" --model-providers .model_providers.json
```

### HTTP Transport (recommended for remote/shared access)

```bash
PILOTSWARM_MCP_KEY=your-secret-key npx -y -p pilotswarm-mcp-server pilotswarm-mcp \
  --transport http --port 3100 \
  --store "$DATABASE_URL" --model-providers .model_providers.json
```

> The package is published as `pilotswarm-mcp-server`; the executable bin is `pilotswarm-mcp`. Use `npx -p pilotswarm-mcp-server pilotswarm-mcp` (or install globally) so npm resolves the right package.

> **Prerequisite:** A running PostgreSQL database and a PilotSwarm worker. The MCP server creates a `PilotSwarmClient` internally — it needs the same database the worker connects to.

---

## Connecting MCP Clients

Each client below shows both **Stdio** (local, recommended) and **HTTP** (remote/shared) configurations.

> **HTTP prerequisite:** Start the HTTP server first:
> ```bash
> PILOTSWARM_MCP_KEY=your-secret-key npx -y -p pilotswarm-mcp-server pilotswarm-mcp \
>   --transport http --port 3100 \
>   --store "$DATABASE_URL" --model-providers .model_providers.json
> ```

### GitHub Copilot CLI

Add to your `.mcp.json` (project root or `~/.copilot/`):

**Stdio (local):**

```json
{
  "mcpServers": {
    "pilotswarm": {
      "type": "stdio",
      "command": "npx",
      "args": [
        "-y",
        "-p", "pilotswarm-mcp-server",
        "pilotswarm-mcp",
        "--store", "postgresql://user:pass@localhost:5432/pilotswarm",
        "--model-providers", ".model_providers.json"
      ]
    }
  }
}
```

**HTTP (remote):**

```json
{
  "mcpServers": {
    "pilotswarm": {
      "type": "http",
      "url": "http://your-host:3100/mcp",
      "headers": {
        "Authorization": "Bearer ${PILOTSWARM_MCP_KEY}"
      }
    }
  }
}
```

### Claude Desktop

Edit `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

**Stdio (local):**

```json
{
  "mcpServers": {
    "pilotswarm": {
      "command": "npx",
      "args": [
        "-y",
        "-p", "pilotswarm-mcp-server",
        "pilotswarm-mcp",
        "--store", "postgresql://user:pass@localhost:5432/pilotswarm",
        "--model-providers", ".model_providers.json"
      ]
    }
  }
}
```

**HTTP (remote):**

```json
{
  "mcpServers": {
    "pilotswarm": {
      "url": "http://your-host:3100/mcp",
      "headers": {
        "Authorization": "Bearer ${PILOTSWARM_MCP_KEY}"
      }
    }
  }
}
```

### Claude Code (CLI)

Add a `.mcp.json` in your project root:

**Stdio (local):**

```json
{
  "mcpServers": {
    "pilotswarm": {
      "type": "stdio",
      "command": "npx",
      "args": [
        "-y",
        "-p", "pilotswarm-mcp-server",
        "pilotswarm-mcp",
        "--store", "postgresql://user:pass@localhost:5432/pilotswarm",
        "--model-providers", ".model_providers.json"
      ]
    }
  }
}
```

**HTTP (remote):**

```json
{
  "mcpServers": {
    "pilotswarm": {
      "type": "http",
      "url": "http://your-host:3100/mcp",
      "headers": {
        "Authorization": "Bearer ${PILOTSWARM_MCP_KEY}"
      }
    }
  }
}
```

### Cursor

Open **Settings → MCP** and add a server, or edit `~/.cursor/mcp.json`:

**Stdio (local):**

```json
{
  "mcpServers": {
    "pilotswarm": {
      "command": "npx",
      "args": [
        "-y",
        "-p", "pilotswarm-mcp-server",
        "pilotswarm-mcp",
        "--store", "postgresql://user:pass@localhost:5432/pilotswarm",
        "--model-providers", ".model_providers.json"
      ]
    }
  }
}
```

**HTTP (remote):**

```json
{
  "mcpServers": {
    "pilotswarm": {
      "url": "http://your-host:3100/mcp",
      "headers": {
        "Authorization": "Bearer ${PILOTSWARM_MCP_KEY}"
      }
    }
  }
}
```

### VS Code (Copilot)

Add `.vscode/mcp.json` to your workspace:

**Stdio (local):**

```json
{
  "servers": {
    "pilotswarm": {
      "type": "stdio",
      "command": "npx",
      "args": [
        "-y",
        "-p", "pilotswarm-mcp-server",
        "pilotswarm-mcp",
        "--store", "postgresql://user:pass@localhost:5432/pilotswarm",
        "--model-providers", ".model_providers.json"
      ]
    }
  }
}
```

**HTTP (remote):**

```json
{
  "servers": {
    "pilotswarm": {
      "type": "http",
      "url": "http://your-host:3100/mcp",
      "headers": {
        "Authorization": "Bearer ${PILOTSWARM_MCP_KEY}"
      }
    }
  }
}
```

### ChatGPT (via HTTP)

ChatGPT supports MCP via HTTP transport only.

```
URL:  http://your-host:3100/mcp
Auth: Bearer token via PILOTSWARM_MCP_KEY
```

### Generic HTTP Client

Test with curl:

```bash
# Initialize a session
curl -X POST http://127.0.0.1:3100/mcp \
  -H "Authorization: Bearer $PILOTSWARM_MCP_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "initialize",
    "params": {
      "protocolVersion": "2025-03-26",
      "capabilities": {},
      "clientInfo": { "name": "curl", "version": "1.0.0" }
    }
  }'
```

The response includes an `mcp-session-id` header — pass it in subsequent requests:

```bash
# List tools
curl -X POST http://127.0.0.1:3100/mcp \
  -H "Authorization: Bearer $PILOTSWARM_MCP_KEY" \
  -H "Content-Type: application/json" \
  -H "mcp-session-id: <session-id-from-above>" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}'
```

### Programmatic (Node.js SDK)

Connect using the official MCP SDK:

```js
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const transport = new StreamableHTTPClientTransport(
  new URL("http://127.0.0.1:3100/mcp"),
  {
    requestInit: {
      headers: { "Authorization": "Bearer your-key" },
    },
  }
);

const client = new Client({ name: "my-app", version: "1.0.0" });
await client.connect(transport);

// List available tools
const { tools } = await client.listTools();
console.log(tools.map((t) => t.name));

// Create a session
const result = await client.callTool({
  name: "create_session",
  arguments: { title: "My Session" },
});
console.log(result);
```

---

## CLI Options

| Flag | Default | Description |
|------|---------|-------------|
| `--transport` | `stdio` | Transport mode: `stdio` or `http` |
| `--port` | `3100` | HTTP server port (only used with `--transport http`) |
| `--store` | `$DATABASE_URL` | PostgreSQL connection string |
| `--model-providers` | — | Path to model providers JSON config |
| `--plugin` | — | Plugin directory (repeatable for multiple dirs) |
| `--log-level` | `error` | Log level |

---

## Available Tools (20)

### Session Management

| Tool | Description |
|------|-------------|
| `create_session` | Create a new PilotSwarm session, optionally bound to a named agent |
| `send_message` | Send a fire-and-forget message to a session |
| `send_and_wait` | Send a message and wait for the response (default timeout: 120 s) |
| `send_answer` | Answer a pending `input_required` question in a session |
| `abort_session` | Cancel a running session with an optional reason |
| `rename_session` | Rename a session title |
| `delete_session` | Soft-delete a session |
| `list_sessions` | Discovery — list all sessions with status, model, agent info, and parent/child relationships |
| `get_session_detail` | Discovery — get detailed info for a session including status, context usage, cron state, and pending questions |
| `get_session_events` | Discovery — read the CMS event stream for a session, with `after_seq` pagination and long-poll support |

### Agent Management

| Tool | Description |
|------|-------------|
| `spawn_agent` | Spawn a sub-agent within a session |
| `message_agent` | Send a message to a running sub-agent |
| `cancel_agent` | Cancel a running sub-agent with an optional reason |
| `list_agents` | Discovery — list all sub-agents (child sessions) with name, status, model, parent, and task; filter by parent or status |

### Knowledge (Facts)

| Tool | Description |
|------|-------------|
| `store_fact` | Store a key-value fact (shared or session-scoped) |
| `read_facts` | Query facts by key pattern, tags, or session scope |
| `delete_fact` | Delete a fact by key |

### Model & Commands

| Tool | Description |
|------|-------------|
| `list_models` | Discovery — list all available LLM models, optionally grouped by provider |
| `switch_model` | Change the model for a session |
| `send_command` | Send an arbitrary orchestration command to a session |

---

## Available Resources (15)

| URI | Description |
|-----|-------------|
| `pilotswarm://sessions` | List all sessions with status |
| `pilotswarm://sessions/{id}` | Detailed info for a specific session |
| `pilotswarm://sessions/{id}/messages` | Chat history for a session |
| `pilotswarm://sessions/{id}/events` | CMS event stream for a session |
| `pilotswarm://sessions/{id}/dump` | Full session dump (config, state, messages, events) |
| `pilotswarm://agents/{agentId}` | System-agent detail (one resource per running system agent, enumerated dynamically) |
| `pilotswarm://agents/{agentId}/events` | Event stream for a system agent (enumerated dynamically) |
| `pilotswarm://facts` | Query the knowledge/facts store |
| `pilotswarm://facts/skills` | Index of skill facts |
| `pilotswarm://facts/skills/{key}` | Detail for a specific skill fact |
| `pilotswarm://facts/asks` | Index of ask (open-question) facts |
| `pilotswarm://facts/asks/{key}` | Detail for a specific ask fact |
| `pilotswarm://facts/intake` | Intake (raw) facts feed |
| `pilotswarm://facts/intake/{keyPattern}` | Intake facts filtered by key pattern |
| `pilotswarm://models` | Available LLM models grouped by provider |

---

## Authentication

- **Stdio** — No auth needed. Process-level isolation provides security (the MCP client spawns the server as a child process).
- **HTTP** — Requires the `PILOTSWARM_MCP_KEY` environment variable. All requests must include an `Authorization: Bearer <key>` header. The server refuses to start if the key is not set.

CORS is enabled for all origins, with `mcp-session-id` and `mcp-protocol-version` exposed as response headers.

---

## Architecture

The MCP server uses the official [@modelcontextprotocol/sdk](https://github.com/modelcontextprotocol/typescript-sdk) and [Hono](https://hono.dev/) for the HTTP layer.

**Stdio mode** — a single `McpServer` instance connects to one stdio transport.

**HTTP mode** — each HTTP client session gets its own `McpServer` + `WebStandardStreamableHTTPServerTransport` pair. This is required by the MCP SDK (each `server.connect(transport)` call is one-shot). Client sessions are tracked by the `mcp-session-id` header and cleaned up on disconnect.

**Shared context** — all server instances share a single `PilotSwarmClient`, `PilotSwarmManagementClient`, `PgFactStore`, and `ModelProviderRegistry`. Tools and resources dispatch to these shared services regardless of which MCP session they belong to.

```
MCP Client (Claude, Cursor, etc.)
    │
    ├── stdio ──→ McpServer ──→ Shared Context ──→ PilotSwarm DB
    │
    └── HTTP ───→ Hono /mcp ──→ Per-session McpServer ──→ Shared Context ──→ PilotSwarm DB
```
