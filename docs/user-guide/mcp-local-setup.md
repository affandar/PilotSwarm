# Managing PilotSwarm from your AI assistant (local MCP setup)

The PilotSwarm MCP server runs **locally** — each MCP host (Claude Code, GitHub
Copilot CLI, VS Code) spawns it as a child process, and it talks to the
deployed Web API **as you**, using your cached Entra login. Nothing extra is
deployed; the only cluster dependency is the portal that is already running.

```
MCP host (Claude Code / Copilot / VS Code)
   └─ spawns → pilotswarm-mcp (local, stdio)
                  └─ HTTPS → https://pilotswarm-portal.westus3.cloudapp.azure.com/api/v1
                              (your Entra identity; your role = your tool surface)
```

Direct mode (`--store`) is test-only. Web API mode is the only supported way
to run this against a real deployment.

## One-time prerequisites

1. **Build the server** (until the `pilotswarm` npm package ships, clients
   point at the repo-local build):

   ```bash
   cd <repo> && npm install && npm run build -w packages/sdk && (cd packages/app/mcp && ../../../node_modules/.bin/tsc)
   ```

2. **Authenticate once** against the deployment:

   ```bash
   node packages/app/tui/bin/pilotswarm.js auth login --api-url https://pilotswarm-portal.westus3.cloudapp.azure.com
   ```

   This caches a refresh token under `~/.config/pilotswarm/auth/`; the MCP
   server silently reuses and refreshes it. Your Entra **app role**
   (admin/user) decides the tool surface — admin-only tools (embedder
   start/stop, facts_admin, restart_system_session, graph namespace writes)
   only register for admin credentials.

## Client configs (already checked in for this repo)

All three configs live in the repo and spawn the same local bin:

| Client | Config file | Notes |
|---|---|---|
| **Claude Code** | `.mcp.json` (repo root) | Picked up automatically when you run `claude` in the repo. Approve the server on first use, then try: *"use pilotswarm get_capabilities"*. |
| **VS Code (Copilot)** | `.vscode/mcp.json` | Uses `${workspaceFolder}`; enable MCP in Copilot settings, then the `pilotswarm` server appears in agent mode's tool picker. |
| **Copilot CLI** | `.copilot/mcp-config.json` | Repo-scoped; absolute path so it also works from `~/.copilot/` if you copy it there. |

To use from **outside this repo**, replace the relative path with the absolute
one (`/…/pilotswarm/packages/app/mcp/dist/bin/pilotswarm-mcp.js`).

## Smoke checklist (any client)

1. `get_capabilities` → expect `mode: "web"`, your `admin` flag, and the
   deployment's facts/graph flags.
2. `get_system_status` → policy + creatable agents. (Its worker count covers
   portal-**embedded** workers only — `0` is normal when workers run as
   dedicated pods. Prompted sessions queue durably either way; the
   `worker_claimed` field on the `create_session` response tells you whether
   one has picked the run up yet.)
3. `list_sessions {limit: 10}` → paginated fleet view.
4. Create → drive → inspect: `create_session {title}` →
   `send_and_wait {session_id, message}` → `get_session_events`,
   `get_session_metrics`, `list_artifacts`.

## What you can do (tool families)

- **Sessions & turns**: create/message/answer/rename/complete/abort/delete,
  `stop_turn`, queued-message cancel, custom events.
- **Sub-agents (read-only)**: `list_agents`, `get_agent_tree`,
  `get_session_tree_stats`, `list_child_outcomes` — spawning stays inside the
  parent session's reasoning loop by design.
- **Groups**: `list_session_groups` (your groups only — groups are private
  per-user organization), `manage_session_group`
  (create/update/**place**/delete; assign/move are deprecated aliases of
  place, cancel/complete are deprecated). `place` puts sessions you can read
  into your own groups without changing what anyone else sees.
- **Artifacts**: list/get/upload/delete session files.
- **Knowledge**: facts CRUD, hybrid `search_facts`, `similar_facts`,
  graph search/neighbourhood/upserts, namespaces, embedder lifecycle.
- **Observability & debugging**: `debug_session` (the agent-tuner's read-only
  evidence bundle — events, metrics, retrieval/graph usage, orchestration
  stats, execution history — in one call), `get_session_metrics`,
  `get_fleet_overview`, execution-history export.
- **Discovery**: `get_capabilities`, `get_system_status`,
  `pilotswarm://capabilities` resource.

Full catalog and security model: [packages/app/mcp/README.md](../../packages/app/mcp/README.md).
