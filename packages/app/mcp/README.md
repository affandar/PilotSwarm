# PilotSwarm MCP Server

Exposes PilotSwarm sessions, agents, facts, and models to any MCP-compatible client via the [Model Context Protocol](https://modelcontextprotocol.io/). Connect Claude Desktop, Copilot CLI, Cursor, VS Code, ChatGPT, or any MCP client to a running PilotSwarm instance.

> **Web API mode is the default.** `--api-url https://portal.example.com` talks to a deployment through the portal's [Web API](../../docs/api/reference.md) — the only credential this process holds is the deployment URL (plus a bearer token on Entra deployments: run `pilotswarm auth login --api-url <url>` once and the server reads the cached token, or set `PILOTSWARM_API_TOKEN` for service principals / CI). **Direct mode** (`--store "$DATABASE_URL"`) connects straight to the database and is internal-only — for tests and trusted placement alongside workers; see [Direct mode](#direct-mode-internal). The debug `dump_session` tool is direct-mode only. See [Layering](../../docs/architecture/layering.md) for the full picture.

## Quick Start

### Stdio Transport (recommended for local IDEs)

```bash
npx -y -p pilotswarm pilotswarm-mcp --api-url https://portal.example.com
```

### HTTP Transport (recommended for remote/shared access)

```bash
PILOTSWARM_MCP_KEY=your-secret-key npx -y -p pilotswarm pilotswarm-mcp \
  --transport http --port 3100 \
  --api-url https://portal.example.com
```

> The package is published as `pilotswarm`; the executable bin is `pilotswarm-mcp`. Use `npx -p pilotswarm pilotswarm-mcp` (or install globally) so npm resolves the right package.

> **Prerequisite:** A running PilotSwarm deployment — all you need is its URL. On an Entra deployment, authenticate once with `pilotswarm auth login --api-url <url>` (or set `PILOTSWARM_API_TOKEN`).

---

## Connecting MCP Clients

Each client below shows both **Stdio** (local, recommended) and **HTTP** (remote/shared) configurations.

> **HTTP prerequisite:** Start the HTTP server first:
> ```bash
> PILOTSWARM_MCP_KEY=your-secret-key npx -y -p pilotswarm pilotswarm-mcp \
>   --transport http --port 3100 \
>   --api-url https://portal.example.com
> ```

### GitHub Copilot CLI

Add to `.copilot/mcp-config.json` (repo-scoped) or `~/.copilot/mcp-config.json` (global):

**Stdio (local):**

```json
{
  "mcpServers": {
    "pilotswarm": {
      "type": "stdio",
      "command": "npx",
      "args": [
        "-y",
        "-p", "pilotswarm",
        "pilotswarm-mcp",
        "--api-url", "https://portal.example.com"
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
        "-p", "pilotswarm",
        "pilotswarm-mcp",
        "--api-url", "https://portal.example.com"
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
        "-p", "pilotswarm",
        "pilotswarm-mcp",
        "--api-url", "https://portal.example.com"
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
        "-p", "pilotswarm",
        "pilotswarm-mcp",
        "--api-url", "https://portal.example.com"
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
        "-p", "pilotswarm",
        "pilotswarm-mcp",
        "--api-url", "https://portal.example.com"
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

## Direct mode (internal)

For tests and trusted co-located placement (same network boundary as the
workers and database), the server can bypass the Web API and connect straight
to the datastore:

```bash
npx -y -p pilotswarm pilotswarm-mcp --store "$DATABASE_URL" --model-providers .model_providers.json
```

This is not a supported integration surface — it holds database credentials,
skips the deployment's authorization seam, and is kept for internal use. One
debug capability lives only here: the `pilotswarm://sessions/{id}/dump`
resource (`dump_session`), which reads session state files off disk.

---

## CLI Options

| Flag | Default | Env var | Description |
|------|---------|---------|-------------|
| `--api-url` | — | `PILOTSWARM_API_URL` | Deployment URL (Web API mode — the default way to run). Mutually exclusive with `--store`. |
| `--transport` | `stdio` | — | Transport mode: `stdio` or `http` |
| `--port` | `3100` | — | HTTP server port (only used with `--transport http`) |
| `--host` | `127.0.0.1` | `PILOTSWARM_MCP_HOST` | Host/interface to bind the HTTP server to |
| `--allowed-hosts` | bound host + `127.0.0.1`/`localhost`/`[::1]` on `--port` | `PILOTSWARM_MCP_ALLOWED_HOSTS` | Comma-separated `host:port` allowlist for the `Host` header (DNS-rebinding defense). Required when fronting the server with a reverse proxy or public hostname. |
| `--max-sessions` | `256` | `PILOTSWARM_MCP_MAX_SESSIONS` | Maximum concurrent MCP sessions; new sessions beyond the cap are rejected with `503` |
| `--session-idle-timeout-ms` | `300000` (5 min) | `PILOTSWARM_MCP_SESSION_IDLE_MS` | Close sessions whose last request was more than this many ms ago (sweeper runs every ~30s). Set to `0` to disable. Required to prevent slot-leaks from one-shot HTTP clients that disconnect without `DELETE /mcp`. |
| `--store` | — | `DATABASE_URL` | PostgreSQL connection string ([direct mode](#direct-mode-internal), internal) |
| `--model-providers` | — | — | Path to model providers JSON config (direct mode; web mode lists models through the API) |
| `--plugin` | — | — | Plugin directory (repeatable for multiple dirs) |
| `--log-level` | `error` | — | Log verbosity for lifecycle messages: `debug`, `info`, `warn`, `error`, or `silent` |

### HTTP-only env vars

| Env var | Required | Description |
|---------|----------|-------------|
| `PILOTSWARM_MCP_KEY` | Yes (HTTP transport) | Bearer token clients must present in `Authorization: Bearer <key>`. Server refuses to start without it. |
| `PILOTSWARM_MCP_HOST` | No | Same as `--host` |
| `PILOTSWARM_MCP_ALLOWED_HOSTS` | No | Same as `--allowed-hosts` |
| `PILOTSWARM_MCP_MAX_SESSIONS` | No | Same as `--max-sessions` |
| `PILOTSWARM_MCP_SESSION_IDLE_MS` | No | Same as `--session-idle-timeout-ms` |

---

## Available Tools

**Tool registration is capability-gated.** The base surface is always
registered; enhanced-facts tools appear only when the deployment reports
`search: true`, graph tools only when it reports `graph: true`, web-only tools
(artifacts, system status, session events, execution-history export) only in
`--api-url` mode, and **[admin]**-tagged tools only when the server's
credential carries the deployment's admin role (or `anonymous` on a no-auth
deployment). Absent capability ⇒ the tool is absent from `tools/list` — start
with `get_capabilities` to see the shape of this server.

### Discovery

| Tool | Description |
|------|-------------|
| `get_capabilities` | Mode (web/direct), admin role, facts search/embedder flags, graph availability, embedded-worker count, default model, and `capability_catalog` — a summary of the deployment's session-capability catalog (MCP server names + default flags, skill names, tool groups with member counts; `null` = not published) |
| `get_system_status` | Embedded-worker count (0 is normal with dedicated worker pods), session-creation policy, creatable agents, log config, full capability catalog (`include: ['capabilities']`) *(web)* |

### Session Management

| Tool | Description |
|------|-------------|
| `create_session` | Create a new PilotSwarm session, optionally bound to a named agent; optional `capabilities` applies a per-tree enable/disable override (MCP servers, skills, tools — tool entries may be group names) over the agent's profile |
| `configure_session` | Reconfigure a running session tree's capability override (same axis shape as `create_session` capabilities; `null` clears; applies on the next turn and cascades to the whole tree). Web API mode only — registered in both modes, but direct mode returns an error |
| `send_message` | Send a fire-and-forget message to a session |
| `send_and_wait` | Send a message and wait for the response (default timeout: 120 s) |
| `send_answer` | Answer a pending `input_required` question in a session |
| `abort_session` | Cancel a running session with an optional reason |
| `rename_session` | Rename a session title |
| `delete_session` | Soft-delete a session |
| `list_sessions` | Discovery — list all sessions with status, model, agent info, and parent/child relationships; keyset pagination via `limit`/`cursor`/`include_deleted` |
| `get_session_detail` | Discovery — get detailed info for a session including status, context usage, cron state, and pending questions; web mode adds `capability_override` (the stored per-tree capability override, `null` = none) |
| `get_session_events` | Discovery — CMS event stream with `after_seq` forward paging, `before_seq` history paging, `event_types` server-side filter, and long-poll support |
| `get_session_access` | Effective caller access, visibility, relation, and owner for one session tree |
| `set_session_visibility` | Set `private`, `shared_read`, or `shared_write` on an owned session tree |
| `grant_session_share` / `revoke_session_share` | Owner/admin targeted read/write grant management |
| `list_session_shares` | Owner/admin listing of targeted grants on a session tree |
| `list_known_users` | Bounded member directory used to resolve a grantee; helper only, not an allowlist |
| `list_authz_audit` | Owner audit for one session or admin fleet-wide authorization audit |

### Turn & Queue Control

| Tool | Description |
|------|-------------|
| `stop_turn` | Abort the in-flight turn; the session stays alive |
| `complete_session` | Mark a session completed (successful terminal state, distinct from cancel) |
| `cancel_pending_messages` | Cancel queued messages by the `client_message_ids` they were sent with |
| `send_session_event` | Inject a custom named event into a session *(web)* |

### Session Groups

| Tool | Description |
|------|-------------|
| `list_session_groups` | List YOUR groups (private per-user organization); `include_sessions` adds the sessions you placed in each |
| `manage_session_group` | `action: create \| update \| place \| assign \| move \| cancel \| complete \| delete` — `place` puts sessions you can read into your own groups (assign/move are deprecated aliases; cancel/complete are deprecated) |

### Artifacts *(web)*

| Tool | Description |
|------|-------------|
| `list_artifacts` | List a session's artifacts |
| `get_artifact` | Metadata + text content + authenticated binary `download_url` |
| `upload_artifact` | Upload text or base64 binary into a session (2 MB envelope limit) |
| `delete_artifact` | Delete an artifact |

### Observability

| Tool | Description |
|------|-------------|
| `debug_session` | The agent-tuner's diagnostic surface as one tool — `include: [info, status, latest_response, events, summary, tokens_by_model, tree_stats, skill_usage, retrieval_usage, facts_stats, orchestration_stats, execution_history, child_outcomes, graph_node_usage, graph_edge_search_usage, graph_searches]`, per-axis error isolation |
| `get_session_metrics` | Per-session/tree metrics — `include: [summary, tokens_by_model, skill_usage, retrieval_usage, facts_stats, orchestration_stats]` |
| `get_fleet_overview` | Fleet aggregates — `include: [stats, skill_usage, retrieval_usage, graph_node_usage, user_stats, top_emitters, shared_facts, tombstones]` |
| `list_child_outcomes` | What each sub-agent concluded, without transcript dumps |
| `get_execution_history` | Raw duroxide execution events (orchestration forensics) |
| `export_execution_history` | Export execution history to a session artifact *(web)* |

### Enhanced Facts *(iff deployment reports `search: true`)*

| Tool | Description |
|------|-------------|
| `search_facts` | Lexical (BM25) / semantic / hybrid retrieval with scores |
| `similar_facts` | Semantic nearest-neighbours of a known fact |
| `embedder_status` | Durable embedder lifecycle state |
| `start_embedder` / `stop_embedder` | Embedder loop control **[admin]** |

### Knowledge Graph *(iff deployment reports `graph: true`)*

| Tool | Description |
|------|-------------|
| `graph_search_nodes` / `graph_search_edges` | Lexical/anchored graph search |
| `graph_neighbourhood` | Bounded subgraph expansion around a node |
| `graph_stats` | Node/edge counts per namespace |
| `graph_upsert_node` / `graph_upsert_edge` | Evidence-unioning writes |
| `graph_delete_node` / `graph_delete_edge` | Deletes (no cross-store cascade) |
| `list_graph_namespaces` / `get_graph_namespace` | Corpus registry reads |
| `upsert_graph_namespace` / `delete_graph_namespace` | Corpus registry writes **[admin]** |

### System **[admin]**

| Tool | Description |
|------|-------------|
| `restart_system_session` | Bounce a system agent (sweeper, resourcemgr, …) with `disposition: complete \| terminate \| hard_delete` |
| `facts_admin` | `action: purge` (tombstoned facts) or `prune_summaries` — destructive housekeeping |

### External MCP boundary

The PilotSwarm MCP server is an **external surface**: it accepts tool calls from clients outside the agent's reasoning loop (Claude Desktop, custom MCP clients, ops tooling). It mutates only **top-level sessions**.

**Sub-agent lifecycle is not part of the external surface.** Creating, messaging, and cancelling a sub-agent are operations whose semantics depend on the parent session's reasoning context — only the parent has the context to decide why, when, and with what task to spawn or message a child. Those operations are exposed only to the in-loop LLM via the orchestration's `spawn_agent` tool and related command handlers.

External MCP clients can **inspect** the sub-agent tree freely:

- `list_agents` — list direct children, filter by parent/status
- `list_registered_agents` — read the catalog of agent definitions
- `get_agent_tree` — recursive subtree from a root session
- `get_session_tree_stats` — aggregated metrics across a subtree
- `get_session_detail`, `get_session_events` — work on any session id, including child sessions
- `pilotswarm://agents/{agentId}` resources — read-only details for *system* sub-agents (sweeper, resourcemgr, etc.); not a generic per-child resource

External clients **cannot** spawn, message, or cancel a sub-agent. Calling a removed tool name returns the standard MCP "unknown tool" error.

Top-level session control (`create_session`, `send_message`, `delete_session`, etc.) is unaffected by this boundary — those tools remain on the external surface.

Session visibility still applies to every MCP operation. A server running with
`--api-url` acts as the cached Entra principal from `pilotswarm auth login` (or
the supplied bearer token): unreadable sessions are absent/not-found, writes
require owner/admin, `shared_write`, or a targeted write grant, and sharing
metadata is owner/admin only.

### Agent Management

| Tool | Description |
|------|-------------|
| `list_agents` | Discovery — list all sub-agents (child sessions) with name, status, model, parent, and task; filter by parent or status |
| `list_registered_agents` | Discovery — read PilotSwarm's catalog of registered agent definitions visible to this MCP server (name, title, description, system flag, parent constraint). Pure read; no creation affordance. |
| `get_agent_tree` | Discovery — recursive sub-agent subtree rooted at a session id, bounded by `max_depth` (default 5). |
| `get_session_tree_stats` | Discovery — aggregated metrics for a session and all its descendants: token totals, session count, dehydration / hydration counts, per-model breakdown, cache hit ratio. |

### Knowledge (Facts)

| Tool | Description |
|------|-------------|
| `store_fact` | Store a key-value fact (shared or session-scoped) |
| `read_facts` | Query facts by key pattern, tags, or session scope (caller-trusted — see [Security model](#security-model)) |
| `delete_fact` | Delete a fact by key |

### Model & Commands

| Tool | Description |
|------|-------------|
| `list_models` | Discovery — list all available LLM models, optionally grouped by provider (web mode reads them through the API; direct mode reads `--model-providers`) |
| `switch_model` | Change the model for a session (web mode uses the API's model-switch operation — the same path as the portal UI) |
| `send_command` | Send an arbitrary orchestration command to a session ([direct mode](#direct-mode-internal) only — raw command plumbing is not exposed over the Web API) |

---

## Available Resources

| URI | Description |
|-----|-------------|
| `pilotswarm://capabilities` | Capability descriptor: mode, admin, facts/graph flags |
| `pilotswarm://sessions/{id}/artifacts` | Artifacts for a session *(web)* |
| `pilotswarm://graph/stats` | Graph node/edge counts *(iff graph)* |
| `pilotswarm://graph/namespaces` | Registered graph namespaces *(iff graph)* |
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

Two independent boundaries: inbound (MCP clients → this server) and outbound (this server → the deployment).

**Inbound (MCP transport):**

- **Stdio** — No auth needed. Process-level isolation provides security (the MCP client spawns the server as a child process).
- **HTTP** — Requires the `PILOTSWARM_MCP_KEY` environment variable. All requests must include an `Authorization: Bearer <key>` header. The server refuses to start if the key is not set.

**Outbound (Web API mode):**

- **No-auth deployment** — nothing to configure.
- **Entra deployment** — the server resolves a token from `PILOTSWARM_API_TOKEN` (service principal / CI) or the cache written by `pilotswarm auth login --api-url <url>`. The deployment's own authorization (role → admin gates, facts read scoping) applies to every call this server makes.

CORS is enabled for all origins, with `mcp-session-id` and `mcp-protocol-version` exposed as response headers.

---

## Security model

The MCP server treats every connected client as trusted with the full scope of the underlying PilotSwarm deployment. Concretely:

- **Authentication is at the transport, not at the tool.** Stdio mode relies on OS-level process isolation; HTTP mode relies on a single shared bearer key (`PILOTSWARM_MCP_KEY`). There is no per-client identity that the server could map to a particular PilotSwarm session.
- **Tools that take a `session_id` accept it as caller input.** This is true of `read_facts`, `store_fact`, `delete_fact`, and the session-management tools. The server does **not** verify that the calling MCP client "owns" the session it names, because it has no notion of client ownership in the first place. A client that can call the tool can scope its call to any session ID it knows or guesses.
- **Implication for `read_facts`.** Any client authorized to talk to this MCP endpoint can read facts scoped to any session — including facts another caller wrote with `session_id` set to a different session. The `reader_session_id` and `granted_session_ids` parameters are likewise caller-supplied and exist to drive the SDK's fact-access checks; they are not themselves authenticated.
- **What the server does enforce.** DNS-rebinding defense via the `Host` header allowlist (`--allowed-hosts`), constant-time bearer comparison, a per-process session cap (`--max-sessions`), and standard CORS headers. These protect the endpoint perimeter; they do not subdivide privilege between clients past the perimeter.

If your deployment needs a stricter per-client privilege boundary (e.g. each MCP client may only read facts for sessions it owns), the right place to add it is the transport / auth layer — for example, by issuing per-client bearer keys, mapping each key to an allowed session-ID set, and enforcing that mapping in middleware before the tool dispatch. The current tool layer intentionally does not pretend to enforce a boundary it cannot see.

---

## Architecture

The MCP server uses the official [@modelcontextprotocol/sdk](https://github.com/modelcontextprotocol/typescript-sdk) and [Hono](https://hono.dev/) for the HTTP layer.

**Stdio mode** — a single `McpServer` instance connects to one stdio transport.

**HTTP mode** — each HTTP client session gets its own `McpServer` + `WebStandardStreamableHTTPServerTransport` pair. This is required by the MCP SDK (each `server.connect(transport)` call is one-shot). Client sessions are tracked by the `mcp-session-id` header and cleaned up on disconnect.

**Shared context** — all server instances share a single `PilotSwarmClient`, `PilotSwarmManagementClient`, and `FactStore`. Tools and resources dispatch to these shared services regardless of which MCP session they belong to. In Web API mode those are the `{ apiUrl }` clients plus a `WebFactStore`; in direct mode they connect straight to the datastore (`PgFactStore` + `ModelProviderRegistry`).

```
MCP Client (Claude, Cursor, etc.)
    │
    ├── stdio ──→ McpServer ──→ Shared Context ──┬─ web:    /api/v1 ──→ deployment
    │                                            │
    └── HTTP ───→ Hono /mcp ──→ Per-session      └─ direct: PilotSwarm DB (internal)
                                McpServer ──→ Shared Context
```
