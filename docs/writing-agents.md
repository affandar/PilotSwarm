# Writing Agents, Skills, Tools & MCP Servers for PilotSwarm

> This guide is now a legacy deep-dive. For the clearest current path, use [Building Agents For SDK Apps](./sdk/building-agents.md), [Building Agents For CLI Apps](./cli/building-agents.md), and [Agent Contracts](./contracts/agent-contracts.md).

This guide explains how to extend PilotSwarm with custom agents, skills, tools, and MCP servers —
and how each component flows through the client/worker architecture.

---

## Architecture: Client vs Worker

Understanding the split is essential before writing any extension.

```
┌─────────────────────────────────────────────────────────────────┐
│  PilotSwarmClient (lightweight, no GitHub token)                │
│                                                                 │
│  • Creates/resumes/deletes sessions                             │
│  • Sends prompts, receives events                               │
│  • References tools by NAME only (serializable strings)         │
│  • Has NO tool handlers, NO LLM access, NO session state        │
│  • Talks to duroxide via Client API (enqueueEvent, getStatus)   │
└────────────────────┬────────────────────────────────────────────┘
                     │  PostgreSQL (shared database)
┌────────────────────┴────────────────────────────────────────────┐
│  PilotSwarmWorker (requires GitHub token)                       │
│                                                                 │
│  • Loads agents, skills, MCP servers from plugin/ directory     │
│  • Owns SessionManager → ManagedSession → CopilotSession (SDK) │
│  • Runs LLM turns, executes tool handlers                       │
│  • Registers activities + orchestrations with duroxide Runtime  │
│  • Resolves tool NAMES → actual Tool objects with handlers      │
│  • Auto-starts system agents on boot                            │
└─────────────────────────────────────────────────────────────────┘
```

**Key rule**: The client only knows tool *names* (strings). The worker holds the actual tool *objects* (with handler functions). When a client creates a session with `toolNames: ["bash", "wait"]`, those names travel through duroxide as serializable data. The worker resolves them to real `Tool` instances at turn execution time.

---

## Plugin Directory Structure

All extensions live under a `plugin/` directory (configurable via `pluginDirs` in worker options):

```
plugin/
  plugin.json              ← Plugin metadata
  .mcp.json                ← MCP server configurations
  agents/
    default.agent.md       ← App-wide default overlay (NOT a selectable agent)
    planner.agent.md       ← User-invocable @planner agent
    pilotswarm.agent.md    ← System agent (auto-started)
    sweeper.agent.md       ← System agent (child of pilotswarm)
    resourcemgr.agent.md   ← System agent (child of pilotswarm)
  skills/
    concise-assistant/
      SKILL.md             ← Skill definition
    durable-timers/
      SKILL.md
      tools.json           ← Optional: tool names this skill needs
    sweeper/
      SKILL.md
      tools.json
```

### Loading Order (Worker Startup)

1. Worker reads each `pluginDirs` entry
2. **Agents**: Parses every `*.agent.md` in `agents/`
   - `default.agent.md` → becomes the app-wide default overlay for the plugin's sessions
   - Files with `system: true` → stored as system agents (auto-started)
   - Everything else → user-invocable agents (available via `@name`)
3. **Skills**: Each subdirectory of `skills/` with a `SKILL.md` → loaded as a skill
4. **MCP**: Reads `.mcp.json` from the plugin root → MCP server configs
5. All loaded items are passed to `SessionManager`, which forwards them to every `CopilotSession` created by the Copilot SDK

---

## Agents (`.agent.md`)

### File Structure

Every `.agent.md` file has two sections: **YAML frontmatter** and a **markdown body**.

```markdown
---
name: researcher
description: Deep research agent.
tools:
  - bash
  - write_artifact
  - export_artifact
---

# Research Agent

You are a research agent. When given a topic...

## Rules
- Cite sources where possible.
- Always produce a downloadable artifact.
```

### What Goes Where in the Prompt

This is the critical part — each section of the `.agent.md` maps to a specific part of the LLM's context:

```
┌──────────────────────────────────────────────────────────────────┐
│  YAML Frontmatter                                                │
│                                                                  │
│  name          → The @mention name. Users type @researcher       │
│  description   → Shown in agent picker UI                        │
│  tools         → Restricts which tools this agent can use        │
│  system        → If true, auto-started by workers (not @-able)   │
│  id            → Deterministic session UUID slug (system agents) │
│  title         → Display name in session list                    │
│  parent        → Parent system agent ID (for sub-agents)         │
│  splash        → Blessed markup banner for TUI display           │
│  initialPrompt → First user message sent to the agent            │
│                                                                  │
├──────────────────────────────────────────────────────────────────┤
│  Markdown Body                                                   │
│                                                                  │
│  Everything after the closing --- becomes the agent's            │
│  SYSTEM PROMPT (AgentConfig.prompt)                              │
│                                                                  │
│  This is what the LLM receives as its persona/instructions       │
│  via CopilotSession.setSystemMessage()                           │
└──────────────────────────────────────────────────────────────────┘
```

### Prompt Assembly Flow

Here's exactly how each piece flows through the system:

```
1. Worker loads .agent.md
   ├─ YAML frontmatter → AgentConfig fields (name, tools, system, etc.)
   └─ Markdown body    → AgentConfig.prompt

2. When a session uses this agent (via @mention or spawn_agent):
   ├─ AgentConfig.prompt → { mode: "replace", content: prompt }
   │                        ↓
   │                   SessionManager._buildSystemMessage()
   │                        ↓
   │                   CopilotSession.setSystemMessage(content)
   │                        ↓
   │                   LLM sees this as the SYSTEM PROMPT
   │
   └─ AgentConfig.initialPrompt → session.send(initialPrompt)
                                    ↓
                               First USER MESSAGE the LLM sees

3. For regular (non-agent) sessions:
   └─ PilotSwarm framework base + default.agent.md body → layered system prompt for app sessions
       ↓
   SessionManager prompt composition
       ↓
   Wrapped ahead of any client-provided runtime overlay
```

### The `default.agent.md` — App-Wide Default Overlay

`default.agent.md` is special. It is NOT a selectable agent. Its markdown body becomes the **app-wide default overlay** for sessions created from that plugin:

```markdown
---
name: default
description: Base agent — always-on system instructions.
tools:
  - wait
  - bash
---

# PilotSwarm Agent

You are a helpful assistant running in a durable execution environment.

## Critical Rules
1. Use the `wait` tool for any delays, polling, or recurring tasks.
2. NEVER use bash sleep, setTimeout, or setInterval.
```

The `tools` list in `default.agent.md` is ignored — it does not restrict tools. Only the markdown body matters.

PilotSwarm now composes prompts in layers:

```
[PilotSwarm framework base]
[app default.agent.md overlay, if any]
[active agent prompt, if any]
[runtime context overlay, if any]
```

PilotSwarm's own management agents use only the framework base plus the management-agent prompt. They do not inherit app `default.agent.md` overlays.

### Agent Types

#### User-Invocable Agents

Regular agents that users can invoke via `@name` in any session:

```yaml
---
name: planner
description: Creates structured plans for complex tasks.
tools:
  - bash
  - view
---
```

- Loaded by the worker, passed to every `CopilotSession` as `customAgents`
- The Copilot SDK handles `@mention` routing
- Their prompt replaces the default agent prompt when invoked

#### System Agents

Agents auto-started by the worker at boot. The LLM spawns child system agents at runtime:

```yaml
---
name: pilotswarm
system: true
id: pilotswarm
title: PilotSwarm Agent
tools:
  - get_system_stats
splash: |
  {bold}{green-fg}PilotSwarm Agent{/green-fg}{/bold}
initialPrompt: >
  You are now online. Spawn your sub-agents now.
---
```

| Field | Purpose |
|-------|---------|
| `system: true` | Marks as system agent. Worker auto-starts root agents. |
| `id` | Slug used to derive a deterministic UUID (`systemAgentUUID(id)`). All workers produce the same UUID. |
| `parent` | ID of the parent system agent. Child agents are spawned by the parent via `spawn_agent(agent_name: "child_id")`. |
| `title` | Display name in the TUI session list. |
| `splash` | Blessed markup banner shown in the TUI chat pane. |
| `initialPrompt` | Bootstrap prompt sent automatically after session creation. |

**Root vs Child system agents:**

- **Root** (no `parent`): Worker calls `_startSystemAgents()` → creates CMS row + starts orchestration + sends `initialPrompt`. Idempotent across multiple workers.
- **Child** (has `parent`): NOT auto-started. The parent agent spawns them at runtime via `spawn_agent(agent_name: "sweeper")`. The orchestration resolves the agent config, creates the child session, and sends `initialPrompt`.

### Frontmatter Reference

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | Yes | The `@mention` name or agent identifier. Lowercase, alphanumeric + hyphens. |
| `description` | string | Yes | One-line description shown in agent picker. |
| `tools` | string[] | No | Tool names this agent can use. Omit = inherit session tools. |
| `system` | boolean | No | Auto-started by workers. Not `@`-mentionable. |
| `id` | string | No | Deterministic UUID slug (system agents only). |
| `title` | string | No | Display name in session list. Falls back to `Name Agent`. |
| `parent` | string | No | Parent system agent `id`. Makes this a child system agent. |
| `splash` | string | No | TUI banner (blessed markup). Use YAML `|` block syntax. |
| `initialPrompt` | string | No | First user message. Use YAML `>` folded syntax for multi-line. |

---

## Skills (`SKILL.md`)

Skills are reusable prompt fragments that augment every session's knowledge. Unlike agents, skills don't replace the system prompt — they're injected as additional context by the Copilot SDK.

### Directory Structure

```
plugin/skills/
  my-skill/
    SKILL.md       ← Required. Skill definition.
    tools.json     ← Optional. Tools this skill needs.
```

### SKILL.md Format

```markdown
---
name: durable-timers
description: Expert knowledge on durable timer patterns.
---

# Durable Timer Patterns

You are running in a durable execution environment with a `wait` tool...

## Patterns

### Recurring Task
1. Do work
2. wait(interval_seconds)
3. Repeat
```

- **YAML frontmatter**: `name` and `description` (both optional, default to directory name).
- **Markdown body**: Additional knowledge injected into the LLM's context. This supplements (not replaces) the system prompt.

### tools.json (Optional)

Declares tool names this skill requires. These are registered with the session alongside the skill:

```json
{
    "tools": ["scan_completed_sessions", "cleanup_session"]
}
```

### How Skills Are Loaded

1. Worker scans each `skills/` subdirectory for `SKILL.md`
2. Skill directories are passed to `SessionManager` as `skillDirectories`
3. `SessionManager` forwards them to the Copilot SDK via `CopilotSession` config
4. The SDK injects skill prompts as additional context for the LLM

Skills are global — every session on the worker gets all loaded skills.

---

## Tools

Tools are functions the LLM can call. They have a **name**, **description**, **JSON Schema parameters**, and a **handler function**.

### Defining a Tool

```javascript
import { defineTool } from "@github/copilot-sdk";

const myTool = defineTool("greet_user", {
    description: "Greet a user by name",
    parameters: {
        type: "object",
        properties: {
            name: { type: "string", description: "The user's name" },
        },
        required: ["name"],
    },
    handler: async (args) => {
        return `Hello, ${args.name}!`;
    },
});
```

### Registering Tools on the Worker

Tools are registered on the **worker** because they contain handler functions (non-serializable):

```javascript
const worker = new PilotSwarmWorker({ ... });
worker.registerTools([myTool, anotherTool]);
```

Worker-level tools are available to ALL sessions on that worker. The `SessionManager` resolves tool names to actual `Tool` objects at turn execution time.

### Referencing Tools from the Client

The client never sees tool handlers. It references tools by **name** only:

```javascript
const session = await client.createSession({
    toolNames: ["greet_user", "bash", "wait"],
});
```

These names travel through duroxide as serializable strings. When the worker executes a turn, it resolves each name to the registered `Tool` object.

### Built-in Tools (Auto-Registered)

These tools are automatically registered by the worker and don't need explicit registration:

| Tool | Auto-registered when | Description |
|------|---------------------|-------------|
| `wait` | Always | Durable timer (survives restarts) |
| `spawn_agent` | Always | Spawn a sub-agent session |
| `check_agents` | Always | Check sub-agent status |
| `message_agent` | Always | Send message to sub-agent |
| `wait_for_agents` | Always | Block until sub-agents complete |
| `complete_agent` | Always | Terminate a sub-agent |
| `list_agents` | Always | List loaded agent definitions |
| `list_sessions` | Always | List all sessions |
| `scan_completed_sessions` | CMS available | Find stale sessions |
| `cleanup_session` | CMS available | Delete a stale session |
| `prune_orchestrations` | CMS available | Clean duroxide state |
| `write_artifact` | Always (local filesystem or blob) | Save file to shared storage |
| `export_artifact` | Always (local filesystem or blob) | Get downloadable link |
| `read_artifact` | Always (local filesystem or blob) | Read file from storage |
| `get_system_stats` | CMS available | Cluster stats |
| `get_infrastructure_stats` | CMS available | Compute/pod stats |
| `get_storage_stats` | CMS + Blob available | Blob storage stats |
| `get_database_stats` | CMS available | Database stats |

### Tool Resolution Flow

```
Client: createSession({ toolNames: ["bash", "greet_user"] })
  ↓
duroxide orchestration receives toolNames as serializable config
  ↓
Worker: SessionManager.createSession()
  ↓
  resolves "bash" → Tool object from toolRegistry
  resolves "greet_user" → Tool object from toolRegistry
  ↓
ManagedSession.runTurn()
  ↓
  copilotSession.registerTools([...resolved tools, ...system tools])
  ↓
  LLM sees all tools with descriptions and can call them
```

---

## MCP Servers (`.mcp.json`)

MCP (Model Context Protocol) servers provide additional tools via external processes or HTTP endpoints.

### Configuration

Create a `.mcp.json` file in your plugin root:

```json
{
    "context7": {
        "type": "http",
        "url": "https://context7-mcp--upstash.run.tools/mcp",
        "tools": ["resolve-library-id", "query-docs"]
    },
    "local-db": {
        "command": "node",
        "args": ["db-server.js"],
        "tools": ["*"],
        "env": {
            "DATABASE_URL": "${DATABASE_URL}"
        }
    }
}
```

### Server Types

**HTTP/SSE (remote)**:
```json
{
    "my-remote-server": {
        "type": "http",
        "url": "https://api.example.com/mcp",
        "tools": ["query", "search"],
        "headers": { "Authorization": "Bearer ${API_TOKEN}" }
    }
}
```

**Stdio (local process)**:
```json
{
    "my-local-server": {
        "command": "python",
        "args": ["mcp_server.py"],
        "tools": ["*"],
        "cwd": "/path/to/server",
        "env": { "PORT": "3000" }
    }
}
```

### Environment Variable Expansion

All string values support `${VAR}` expansion from `process.env`:

```json
{
    "url": "https://${MCP_HOST}/mcp",
    "headers": { "Authorization": "Bearer ${MCP_TOKEN}" }
}
```

### How MCP Servers Are Loaded

1. Worker reads `.mcp.json` from each plugin directory
2. Environment variables are expanded at load time
3. Config is passed to `SessionManager` as `mcpServers`
4. `SessionManager` forwards to the Copilot SDK via `CopilotSession` config
5. The SDK manages MCP server lifecycle (spawning stdio processes, connecting to HTTP endpoints)
6. MCP tools appear alongside regular tools in the LLM's tool list

---

## Complete Example: Building an Agent with Tools, Skills, and MCP

### 1. Define the tool (`examples/worker.js`)

```javascript
import { defineTool } from "@github/copilot-sdk";

const weatherTool = defineTool("get_weather", {
    description: "Get current weather for a city",
    parameters: {
        type: "object",
        properties: {
            city: { type: "string", description: "City name" },
        },
        required: ["city"],
    },
    handler: async (args) => {
        const resp = await fetch(`https://wttr.in/${args.city}?format=j1`);
        return JSON.stringify(await resp.json());
    },
});

worker.registerTools([weatherTool]);
```

### 2. Create the skill (`plugin/skills/weather-reporting/SKILL.md`)

```markdown
---
name: weather-reporting
description: Knowledge on weather data interpretation and formatting.
---

# Weather Reporting

When presenting weather data:
- Lead with current temperature and conditions
- Include humidity and wind speed
- Use °C unless the user specifies °F
- Flag any severe weather alerts
```

### 3. Create the agent (`plugin/agents/weather.agent.md`)

```markdown
---
name: weather
description: Weather monitoring and reporting agent.
tools:
  - get_weather
  - wait
  - write_artifact
  - export_artifact
---

# Weather Agent

You are a weather monitoring agent. You check weather conditions
and produce formatted reports.

## Rules
- Use get_weather for current conditions.
- For monitoring: check → report → wait(interval) → repeat.
- Always include an artifact link for reports.
- Use the wait tool for ALL delays.
```

### 4. Add MCP server (optional, `plugin/.mcp.json`)

```json
{
    "weather-api": {
        "type": "http",
        "url": "https://weather-mcp.example.com/mcp",
        "tools": ["forecast", "alerts"]
    }
}
```

### Usage

```
User: @weather monitor Seattle every 30 minutes
```

The agent will use `get_weather`, format the report, save with `write_artifact`, then `wait(1800)` and repeat.

---

## Writing Effective Agent Prompts

### Do: Be specific and constrained

```markdown
## Rules
- Output a numbered list, not prose.
- Each item: title, description, estimated effort.
- You ONLY handle database queries. If asked about frontend, say so.
```

### Do: Specify output format

```markdown
## Output Format
| Finding | Severity | Location | Suggestion |
|---------|----------|----------|------------|
```

### Do: Handle edge cases

```markdown
## Edge Cases
- If the query returns no results, say "No data found" — don't hallucinate.
- If the API fails after 3 retries, report the error and stop.
```

### Do: Enforce durable timer usage

```markdown
## Rules
- For ANY waiting/sleeping, use the `wait` tool.
- NEVER use bash sleep, setTimeout, or setInterval.
- You must ALWAYS call `wait` before ending a monitoring turn.
```

### Don't: Be vague

```markdown
## Rules
- Be helpful.        ← Too vague
- Do a good job.     ← Not actionable
- Follow best practices.  ← Meaningless to the LLM
```

---

## Deploying

Agents, skills, and MCP configs are loaded from `plugin/` at worker startup:

1. Add your files to the appropriate `plugin/` subdirectory
2. Rebuild and redeploy the worker
3. No database reset needed — extensions are loaded fresh on every worker start

For Docker/K8s deployments, ensure the plugin directory is included:

```dockerfile
COPY plugin/ ./plugin/
```

For tools registered via `worker.registerTools()`, the tool code must be in the worker's JavaScript bundle.
