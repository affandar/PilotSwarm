# Proposal: PilotSwarm MCP Server & Companion Agent

## Status

Proposed

## Summary

Ship a new `packages/mcp-server` package (`pilotswarm-mcp-server`) that exposes PilotSwarm's management surface as an MCP (Model Context Protocol) server. It connects to the same PostgreSQL database and blob store as the workers — no AKS cluster access required. A lightweight companion `.agent.md` file is included so users can install the server into GitHub CLI (or any MCP-capable host) and get an agent that can operate PilotSwarm conversationally.

---

## Motivation

The TUI is powerful but requires a terminal, SSH, or port-forward to the cluster. Many workflows — checking session status, sending a message, browsing events, renaming sessions, picking models — are lightweight management operations that don't need a full terminal UI.

An MCP server makes the same operations available to any MCP-capable host: GitHub Copilot in VS Code, GitHub CLI (`gh copilot`), Claude Desktop, or custom agents. The user gets PilotSwarm fleet management inside their existing AI assistant.

---

## Architecture

```
┌──────────────────────────┐
│  MCP Host (gh copilot,   │
│  VS Code, Claude, etc.)  │
└────────┬─────────────────┘
         │ MCP (stdio or HTTP/SSE)
┌────────▼─────────────────┐
│  pilotswarm-mcp-server   │
│  (Node.js process)       │
│                          │
│  ┌────────────────────┐  │
│  │ Management Client  │  │──▶ PostgreSQL (CMS + duroxide + facts)
│  │ (from SDK)         │  │
│  └────────────────────┘  │
│                          │──▶ Azure Blob Storage (session dumps, optional)
└──────────────────────────┘
```

The MCP server is a thin adapter layer over `PilotSwarmManagementClient` and `PilotSwarmClient` from the SDK. It translates MCP tool calls into client method calls. Neither client requires a GitHub token or AKS credentials — both connect only to PostgreSQL (and optionally blob storage).

### What it can see

- PostgreSQL: CMS tables (session catalog, events), duroxide tables (orchestration status, KV), facts tables
- Blob storage: session dehydration blobs (for dump only, read-only)
- Model providers config: `.model_providers.json` (local file, read-only)

### What it cannot see

- AKS cluster (no kubectl, no pod logs, no deployment manifests)
- GitHub API (no token, no Copilot SDK)
- Worker internals (no CopilotSession, no tool handlers)

---

## MCP Tools

8 tools, each with options to cover multiple underlying operations. Every tool maps to `PilotSwarmClient` or `PilotSwarmManagementClient` methods. All read/write against PostgreSQL — no cluster-level operations.

### `create_session`

Create a new session, optionally bound to a named agent.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `agentId` | string | No | Agent to bind (omit for generic session) |
| `model` | string | No | Model override (qualified `provider:model` or bare name) |
| `prompt` | string | No | Initial message to send immediately after creation |

Returns: `{ sessionId, agentId?, model? }`

### `list_sessions`

List all sessions with status summary.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `status` | string | No | Filter by status: `running`, `idle`, `waiting`, `completed`, `failed` |
| `agentId` | string | No | Filter by agent |
| `includeSystem` | boolean | No | Include system sessions (default: false) |

Returns: array of `{ sessionId, title, agentId, status, model, iterations, createdAt, parentSessionId? }`

### `get_session`

Get a session's detail, optionally including extended data.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `sessionId` | string | Yes | Session ID |
| `include` | string[] | No | Extra data to include: `"status"`, `"response"`, `"dump"` |

- Default: returns session view (title, agent, status, model, iterations, context usage, pending question, error)
- `"status"`: adds live orchestration status + customStatus version
- `"response"`: adds latest KV-backed response payload (the last LLM output)
- `"dump"`: adds full Markdown dump of session + descendants

Returns: `{ session, status?, response?, dump? }`

### `get_session_events`

Read the CMS event stream for a session, or long-poll for status changes.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `sessionId` | string | Yes | Session ID |
| `afterSeq` | number | No | Return events after this sequence number (for paging) |
| `limit` | number | No | Max events to return (default: 50) |
| `wait` | boolean | No | If true, long-poll until new events or status change arrives |
| `waitTimeoutMs` | number | No | Long-poll timeout (default: 30000) |
| `afterVersion` | number | No | For wait mode: block until customStatusVersion exceeds this |

Returns: `{ events, latestSeq, statusChange? }`

### `update_session`

Rename, cancel, or delete a session.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `sessionId` | string | Yes | Session ID |
| `action` | string | Yes | `"rename"`, `"cancel"`, or `"delete"` |
| `title` | string | For rename | New title (max 60 chars) |
| `reason` | string | No | Reason for cancel/delete |

Returns: `{ success: true }`

### `send_to_session`

Send a message, answer, or command to a session.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `sessionId` | string | Yes | Session ID |
| `type` | string | Yes | `"message"`, `"answer"`, or `"command"` |
| `content` | string | Yes | Prompt text (message), answer text (answer), or command name (command) |
| `args` | object | No | For commands: additional args (e.g. `{ model: "gpt-4o" }`) |

Returns: `{ sent: true }`

### `list_models`

List available models, optionally grouped by provider.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `groupByProvider` | boolean | No | If true, return models grouped by provider (default: flat list) |

Returns: `{ models, defaultModel?, providers? }`

### `query_facts`

Read or list facts from the knowledge pipeline.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `mode` | string | Yes | `"read"` (return fact values) or `"list_keys"` (return keys only) |
| `keyPattern` | string | Yes | Key pattern (e.g. `"skills/%"`, `"asks/%"`) |
| `scope` | string | No | `"shared"` or `"session"` (default: `"shared"`) |
| `limit` | number | No | Max results (default: 50) |

Returns: `{ facts }` or `{ keys }`

---

## MCP Resources

Resources provide read-only context that hosts can browse, reference, or subscribe to without consuming tool calls. Declared with `resources: { subscribe: true, listChanged: true }`.

### Session Resources

| Resource URI | Type | Description |
|---|---|---|
| `pilotswarm://sessions` | Static | All sessions — compact list with status, agent, title, model |
| `pilotswarm://sessions/{id}` | Template | Single session detail (orchestration status, context usage, pending question, error) |
| `pilotswarm://sessions/{id}/events` | Template | CMS event stream for a session (JSON array, last 100) |
| `pilotswarm://sessions/{id}/dump` | Template | Full Markdown dump of session + descendants |

### System Agent Resources

Each system agent is a well-known singleton with a deterministic session ID. These resources surface their current state and recent activity without needing to know the session ID.

| Resource URI | Description |
|---|---|
| `pilotswarm://agents/sweeper` | Sweeper session detail: status, last cleanup run, iterations, error state |
| `pilotswarm://agents/sweeper/events` | Sweeper event stream — cleanup actions, pruned sessions, errors |
| `pilotswarm://agents/resourcemgr` | Resource Manager session detail: status, last scan, infrastructure stats |
| `pilotswarm://agents/resourcemgr/events` | Resource Manager event stream — storage/db stats, purge actions, scaling |
| `pilotswarm://agents/facts-manager` | Facts Manager session detail: status, curation stats, last run |
| `pilotswarm://agents/facts-manager/events` | Facts Manager event stream — skill promotions, ask creations, intake processing |

Internally these resolve to `getSession(systemAgentUUID("sweeper"))` etc. — the MCP host doesn't need to know the UUID.

### Model Resources

| Resource URI | Description |
|---|---|
| `pilotswarm://models` | Full model catalog: all models across providers, grouped, with default |

### Knowledge Pipeline Resources

Curated skills, open asks, and raw intake facts from the facts store.

| Resource URI | Description |
|---|---|
| `pilotswarm://facts/skills` | All promoted skills — curated knowledge distilled by the Facts Manager. Each skill has key, name, description, confidence, instructions, evidence count. |
| `pilotswarm://facts/skills/{key}` | Single skill by key (e.g. `pilotswarm://facts/skills/skills/terraform-s3-backend`). Full fact value including instructions, caveats, version, linked intakes. |
| `pilotswarm://facts/asks` | All open asks — topics the Facts Manager is seeking corroboration on. Key, summary, status. |
| `pilotswarm://facts/asks/{key}` | Single ask detail. |
| `pilotswarm://facts/intake` | Recent intake observations (last 50) — raw agent-contributed evidence awaiting curation. Restricted to shared scope (Facts Manager intake rules still apply for writes). |
| `pilotswarm://facts/intake/{keyPattern}` | Intake observations filtered by key pattern (e.g. `intake/terraform/%`). |

### Resource Subscriptions

With `subscribe: true`, hosts can subscribe to specific resources and receive `notifications/resources/updated` when they change:

- **Session resources**: push when session status transitions (idle→running, running→waiting, etc.)
- **System agent resources**: push when the agent runs a new iteration
- **Skill resources**: push when the Facts Manager promotes or updates a skill
- **Ask resources**: push when a new ask is created or resolved

Change detection uses CMS `updatedAt` timestamps and facts store `updatedAt` for efficient polling.

---

## Configuration

The MCP server reads its config from environment variables (same names as the worker/TUI):

| Variable | Required | Description |
|---|---|---|
| `PILOTSWARM_STORE` | Yes | PostgreSQL connection string |
| `AZURE_STORAGE_CONNECTION_STRING` | No | Blob store for session dumps |
| `MODEL_PROVIDERS_PATH` | No | Path to `.model_providers.json` |
| `PILOTSWARM_CMS_SCHEMA` | No | CMS schema (default: `copilot_sessions`) |
| `PILOTSWARM_DUROXIDE_SCHEMA` | No | Duroxide schema (default: `duroxide`) |
| `PILOTSWARM_FACTS_SCHEMA` | No | Facts schema (default: `pilotswarm_facts`) |

### MCP Host Configuration

**GitHub CLI / VS Code** (`.mcp.json` or MCP settings):

```json
{
  "pilotswarm": {
    "type": "stdio",
    "command": "npx",
    "args": ["pilotswarm-mcp-server"],
    "env": {
      "PILOTSWARM_STORE": "postgresql://user:pass@host:5432/pilotswarm?sslmode=require"
    }
  }
}
```

**HTTP mode** (for remote/shared access):

```bash
npx pilotswarm-mcp-server --http --port 3100
```

---

## Companion Agent

A lightweight `.agent.md` file that tells the LLM how to use the MCP tools effectively. This ships in `templates/builder-agents/agents/` and can be installed into `.github/agents/` or used directly.

```yaml
---
name: pilotswarm-operator
description: Manage PilotSwarm sessions, agents, and knowledge pipeline via MCP
tools:
  - create_session
  - list_sessions
  - get_session
  - get_session_events
  - update_session
  - send_to_session
  - list_models
  - query_facts
---
```

The agent prompt covers:

- **Session lifecycle**: how to list, inspect, message, answer, cancel, delete sessions
- **Status interpretation**: what idle/running/waiting/dehydrated/completed/failed mean, how to read context usage and pending questions
- **Agent awareness**: how sessions map to agents, parent/child relationships, system vs user sessions
- **Event reading**: how to page through events, interpret event types (llm-response, tool-call, tool-result, error, etc.)
- **Knowledge pipeline**: when to read facts, how fact scopes work (session vs shared)
- **Model selection**: how to list models, understand providers, send `/model` commands
- **Conversational patterns**: e.g. "check on session X" → `get_session` + `get_latest_response`, "what's the swarm doing" → `list_sessions` filtered to running

---

## Package Structure

```
packages/mcp-server/
  package.json          # pilotswarm-mcp-server
  tsconfig.json
  src/
    index.ts            # Entry point — parse args, create server, start
    server.ts           # MCP server setup — register tools, resources, connect transport
    tools.ts            # Tool definitions (name, description, inputSchema, handler)
    resources.ts        # Resource definitions (URI templates, read handlers)
    config.ts           # Env parsing and validation
  bin/
    pilotswarm-mcp.js   # CLI entry point (#!/usr/bin/env node)
```

### Dependencies

- `@modelcontextprotocol/sdk` — MCP server SDK (stdio + HTTP transports)
- `pilotswarm-sdk` — `PilotSwarmManagementClient`, types, fact store

No other runtime dependencies. The MCP server is intentionally lightweight.

### npm Packaging

Published as `pilotswarm-mcp-server` with a `bin` entry so `npx pilotswarm-mcp-server` works out of the box. The `pilotswarm-sdk` peer dependency ensures version alignment.

---

## Implementation Plan

### Phase 1: Core MCP Server

1. Scaffold `packages/mcp-server` with package.json, tsconfig, bin entry.
2. Implement `config.ts` — env parsing, validation, defaults.
3. Implement `server.ts` — create MCP server, register stdio transport.
4. Implement `tools.ts` — all session management + messaging + status tools, each delegating to `PilotSwarmManagementClient`.
5. Implement `resources.ts` — session list, session detail, events, dump, models.
6. Smoke test locally: `PILOTSWARM_STORE=... node bin/pilotswarm-mcp.js` with MCP inspector.

### Phase 2: Companion Agent

1. Write `pilotswarm-operator.agent.md` covering all tools and conversational patterns.
2. Add to `templates/builder-agents/agents/`.
3. Test with `gh copilot` using MCP config pointing to local server.

### Phase 3: HTTP Transport & Auth

1. Add `--http` / `--port` flags for HTTP/SSE transport.
2. Add optional bearer token auth for remote deployments.
3. Document deployment as a sidecar or standalone service.

### Phase 4: Facts Tools

1. Expose `read_facts` and `list_fact_keys` as MCP tools.
2. Wire to `FactStore` via management client.

---

## Scope Boundaries

### In scope

- All operations available through `PilotSwarmManagementClient`
- Session creation via `PilotSwarmClient` (no GitHub token needed)
- Read-only access to facts store
- Session dumps via blob store
- Model catalog browsing
- Both stdio and HTTP transports

### Out of scope

- **AKS cluster operations**: no kubectl, no pod logs, no deployments, no scaling. Use the `pilotswarm-aks-deployer` agent/skill for that.
- **Tool registration**: tools are registered on workers, not through the management/client surface.
- **Real-time streaming**: MCP tools are request/response. `wait_for_status_change` provides long-polling. True streaming (SSE push for events) is a future enhancement via MCP's notification mechanism.

---

## Security Considerations

- The MCP server has **full read/write access** to the PilotSwarm database. It can cancel and delete sessions. The connection string is the security boundary.
- HTTP mode should require auth (bearer token or mTLS) in production.
- No secrets are logged or exposed through MCP tool responses.
- The server never executes arbitrary code — it only translates MCP calls to management client methods.
- Input validation: session IDs are validated as UUIDs, prompts are length-bounded, model names are checked against the catalog.

---

## Related

- [Management Client Boundary Cleanup](management-client-boundary-cleanup.md) — the refactor that created the management API surface this MCP server wraps
- [Plugin Architecture Guide](../plugin-architecture-guide.md) — MCP server config format (`.mcp.json`)
- [Building Apps](../building-apps.md) — SDK usage patterns
- [TUI Design Spec](../proposals/tui-design-spec.md) — TUI operations reference
