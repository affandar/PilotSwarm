# Plugin Architecture & Layering Guide

PilotSwarm's plugin system lets you extend every part of the runtime — agents, skills, MCP servers, tools, and model providers — through a layered architecture that separates built-in system behavior from application customization. This guide is the complete technical reference for how plugins are structured, loaded, and merged.

For practical examples, see [Blog 1: Test Swarm CLI](./blog-test-swarm-cli.md) and [Blog 2: Travel Event Scanner SDK](./blog-travel-event-scanner-sdk.md).

---

## 1. What Is a Plugin?

A plugin is a directory containing any combination of:

| Component | Location | Format |
|-----------|----------|--------|
| Agents | `agents/*.agent.md` | YAML frontmatter + markdown |
| Skills | `skills/<name>/SKILL.md` | YAML frontmatter + markdown |
| MCP servers | `.mcp.json` at directory root | JSON object |
| Metadata | `plugin.json` at directory root | JSON (informational only) |

Tools and model providers are configured in code or JSON rather than inside plugin directories.

---

## 2. Three-Tier Loading Model

PilotSwarm loads plugins in a strict four-stage pipeline. Each stage can override or extend the previous.

### Tier 1: System (`packages/sdk/plugins/system/`)

Always loaded. Cannot be disabled. Provides the foundational behavior every session needs.

```text
packages/sdk/plugins/system/
├── agents/
│   └── default.agent.md        # Base system message for ALL sessions
└── skills/
    ├── durable-timers/
    │   └── SKILL.md             # wait tool usage knowledge
    └── sub-agents/
        └── SKILL.md             # spawn_agent patterns
```

The `default.agent.md` agent is special — its prompt is **prepended** to every other agent's prompt as the base system message. It is never listed as a selectable agent.

### Tier 2: Management (`packages/sdk/plugins/mgmt/`)

Loaded by default. Opt out by passing `disableManagementAgents: true` to `PilotSwarmWorker`.

```text
packages/sdk/plugins/mgmt/
├── agents/
│   ├── pilotswarm.agent.md      # Master orchestrator (system agent)
│   ├── resourcemgr.agent.md     # Infrastructure monitoring (system agent)
│   └── sweeper.agent.md         # Session cleanup (system agent)
└── skills/
    └── sweeper/
        └── SKILL.md             # Cleanup domain knowledge
```

Management agents have `system: true` and are started automatically by the worker. They run as long-lived background sessions with their own durable orchestrations.

### Tier 3: Application (`pluginDirs`)

Your custom plugins. Pass one or more directories via the `pluginDirs` option:

```typescript
const worker = new PilotSwarmWorker({
  githubToken: process.env.GITHUB_TOKEN,
  databaseConnectionString: process.env.DATABASE_URL,
  pluginDirs: ["./plugins/my-app"],
});
```

Directory structure follows the same layout:

```text
plugins/my-app/
├── plugin.json
├── .mcp.json
├── agents/
│   └── analyst.agent.md
└── skills/
    └── data-analysis/
        └── SKILL.md
```

### Tier 4: Direct Config (Inline)

Override everything with inline options on `PilotSwarmWorker`:

```typescript
const worker = new PilotSwarmWorker({
  githubToken: process.env.GITHUB_TOKEN,
  databaseConnectionString: process.env.DATABASE_URL,
  skillDirectories: ["./extra-skills"],
  customAgents: [
    {
      name: "reviewer",
      description: "Code review agent",
      prompt: "You are a code reviewer. Be thorough.",
      tools: ["bash", "grep"],
    },
  ],
  mcpServers: {
    "my-api": {
      type: "http",
      url: "https://api.example.com/mcp",
      tools: ["search"],
    },
  },
});
```

---

## 3. Agent Definitions (`.agent.md`)

Agents are defined as Markdown files with YAML frontmatter. The frontmatter declares metadata and the body provides the system prompt.

### Field Reference

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | **Yes** | Unique agent identifier. Used for selection and collision resolution. |
| `description` | string | No | Short description shown in agent lists. |
| `tools` | string[] | No | Tool names this agent can access. |
| `system` | boolean | No | If `true`, agent is auto-started by the worker as a background session. |
| `id` | string | No | Deterministic slug for system agents (e.g. `"sweeper"`). Used to derive a stable session UUID. |
| `title` | string | No | Display name in session lists. Falls back to capitalized `name` + " Agent". |
| `parent` | string | No | Parent system agent's `id`. Makes this agent a child spawned by the parent. |
| `splash` | string | No | Blessed markup banner shown in the TUI when the session is selected. |
| `initialPrompt` | string | No | First prompt sent when a system agent is created. |

### Example Agent File

```markdown
---
name: analyst
description: Analyzes datasets and produces summary reports.
tools:
  - bash
  - write_artifact
  - export_artifact
---

# Data Analyst Agent

You are a data analyst. When given a dataset:

1. Load and inspect the data structure.
2. Compute summary statistics.
3. Write findings to a markdown report using `write_artifact`.
4. Export the report with `export_artifact` and include the artifact link.

Be concise. Use tables for numeric summaries.
```

---

## 4. Special Agents

### `default.agent.md`

The agent with `name: default` has unique behavior:

- Its prompt is **prepended** to every other agent's system prompt, separated by `---`.
- It is never listed as a selectable agent.
- Only one `default` agent should exist. If multiple tiers define one, the last tier wins.
- It defines baseline rules (wait tool usage, artifact creation, sub-agent behavior) that apply to all sessions.

### System Agents (`system: true`)

System agents are background sessions started automatically when the worker launches. They require an `id` field, which is hashed into a deterministic UUID so the session persists across worker restarts.

Root system agents (no `parent` field) are started directly. Child system agents (with a `parent` field) are spawned by the parent at runtime via `spawn_agent(agent_name="<name>")`.

Example hierarchy:

```text
pilotswarm (root, system: true, id: "pilotswarm")
├── sweeper (system: true, id: "sweeper", parent: "pilotswarm")
└── resourcemgr (system: true, id: "resourcemgr", parent: "pilotswarm")
```

---

## 5. Skills

Skills inject domain knowledge into the LLM context. They are directories, not standalone files.

### Directory Structure

```text
skills/
└── data-analysis/
    ├── SKILL.md          # Required — frontmatter + knowledge body
    └── tools.json        # Optional — declares tool dependencies
```

### SKILL.md Format

```markdown
---
name: data-analysis
description: Knowledge for analyzing structured datasets
---

When analyzing data, follow these steps:

1. Always validate the data schema before computing statistics.
2. Check for null values and outliers.
3. Prefer median over mean for skewed distributions.
4. Report sample size alongside every metric.
```

### tools.json Format

```json
{
  "tools": ["bash", "write_artifact"]
}
```

Tools listed here are made available to sessions that load this skill.

### Skill vs. Agent

| Aspect | Skill | Agent |
|--------|-------|-------|
| Purpose | Inject domain knowledge | Define a persona with tools and behavior |
| File | `SKILL.md` in a named directory | `*.agent.md` |
| System prompt | Appended as context | Becomes the primary system prompt |
| Tool binding | Optional (`tools.json`) | Explicit (`tools` frontmatter field) |
| Selectable | No — loaded by directory | Yes — selected by name |
| Collision | Additive (all directories combined) | Name collision → last tier wins |

---

## 6. MCP Server Configuration

MCP (Model Context Protocol) servers extend agent capabilities with external tools. Configure them in a `.mcp.json` file at the root of any plugin directory.

### Format

The file is a JSON object where each key is a server name:

```json
{
  "code-search": {
    "command": "node",
    "args": ["./mcp-servers/code-search.js"],
    "tools": ["search_code", "get_file"],
    "env": {
      "INDEX_PATH": "${SEARCH_INDEX}"
    },
    "cwd": "/app",
    "timeout": 30000
  },
  "remote-api": {
    "type": "http",
    "url": "https://api.example.com/mcp",
    "tools": ["query", "summarize"],
    "headers": {
      "Authorization": "Bearer ${API_TOKEN}"
    }
  }
}
```

### Server Types

| Type | Transport | Key Fields |
|------|-----------|------------|
| `local` / `stdio` | Subprocess (stdin/stdout) | `command`, `args`, `env`, `cwd`, `timeout` |
| `http` | HTTP request/response | `url`, `headers`, `timeout` |
| `sse` | Server-Sent Events | `url`, `headers`, `timeout` |

The `type` field defaults to `local` if omitted and `command` is present.

### Environment Variable Expansion

All string values support `${VAR_NAME}` syntax. Variables are expanded from `process.env` at load time:

```json
{
  "my-server": {
    "type": "http",
    "url": "${MCP_SERVER_URL}",
    "headers": {
      "Authorization": "Bearer ${MCP_TOKEN}"
    },
    "tools": ["*"]
  }
}
```

Unresolved variables expand to empty strings.

---

## 7. Tool Registration (Code Layer)

Tools add callable functions to the LLM's repertoire. Unlike agents and skills (file-based), tools are defined in TypeScript/JavaScript and registered on the worker.

### Defining a Tool

```typescript
import { defineTool } from "pilotswarm";

const greetTool = defineTool("greet", {
  description: "Greet a user by name",
  parameters: {
    type: "object",
    properties: {
      name: { type: "string", description: "The user's name" },
    },
    required: ["name"],
  },
  handler: async ({ name }) => {
    return { message: `Hello, ${name}!` };
  },
});
```

### Registering on the Worker

```typescript
import { PilotSwarmWorker, defineTool } from "pilotswarm";

const fetchUrlTool = defineTool("fetch_url", {
  description: "Fetch content from a URL",
  parameters: {
    type: "object",
    properties: {
      url: { type: "string", description: "URL to fetch" },
    },
    required: ["url"],
  },
  handler: async ({ url }) => {
    const res = await fetch(url);
    return { status: res.status, body: await res.text() };
  },
});

const worker = new PilotSwarmWorker({
  githubToken: process.env.GITHUB_TOKEN,
  databaseConnectionString: process.env.DATABASE_URL,
});

worker.registerTools([fetchUrlTool]);
```

### Client-Side Tool References

The client never holds tool handler functions (they aren't serializable). Instead, it references tools by name:

```typescript
const session = await client.createSession({
  toolNames: ["greet", "fetch_url"],
});
```

The worker resolves these names against its tool registry at execution time. This separation is what allows the client and worker to run on different machines.

---

## 8. Model Providers

Model providers configure which LLMs are available and how to authenticate with them.

### File Format (`model_providers.json`)

```json
{
  "providers": [
    {
      "id": "github-copilot",
      "type": "github",
      "githubToken": "env:GITHUB_TOKEN",
      "models": [
        { "name": "claude-opus-4", "description": "Best reasoning", "cost": "high" },
        { "name": "claude-sonnet-4", "description": "Fast and capable", "cost": "medium" },
        { "name": "gpt-4o", "description": "OpenAI flagship", "cost": "medium" }
      ]
    },
    {
      "id": "azure-openai",
      "type": "azure",
      "baseUrl": "https://my-resource.openai.azure.com/openai",
      "apiKey": "env:AZURE_OPENAI_KEY",
      "apiVersion": "2024-10-21",
      "models": [
        { "name": "gpt-4.1-mini", "description": "Low-cost Azure deployment", "cost": "low" }
      ]
    }
  ],
  "defaultModel": "github-copilot:claude-opus-4"
}
```

### Provider Types

| Type | Auth | Endpoint |
|------|------|----------|
| `github` | `githubToken` (Copilot API) | Automatic — no `baseUrl` needed |
| `azure` | `apiKey` | `baseUrl` pointing to Azure OpenAI resource |
| `openai` | `apiKey` | `https://api.openai.com/v1` |
| `anthropic` | `apiKey` | `https://api.anthropic.com` |

### Secret Syntax

API keys and tokens use `env:VAR_NAME` to reference environment variables:

```json
{
  "githubToken": "env:GITHUB_TOKEN",
  "apiKey": "env:AZURE_OPENAI_KEY"
}
```

This keeps secrets in `.env` files while the provider config stays in version control.

### Qualified Model Names

Models are identified by `provider:model` strings (e.g. `github-copilot:claude-opus-4`). The SDK also accepts bare model names and resolves them to the first matching provider.

### Discovery Order

1. **Explicit path** — `modelProvidersPath` option on `PilotSwarmWorker`
2. **Auto-discover** — searches for `.model_providers.json` in the current working directory and `/app/`
3. **Environment variable fallback** — builds a config from `LLM_ENDPOINT`, `LLM_API_KEY`, `GITHUB_TOKEN`, etc.

---

## 9. Loading Order & Merge Semantics

The complete loading pipeline:

```text
┌─────────────────────────────────────────────────────┐
│  Tier 1: System plugins (always)                    │
│    → default.agent.md saved as base system message  │
│    → skills/durable-timers, skills/sub-agents       │
├─────────────────────────────────────────────────────┤
│  Tier 2: Management plugins (unless disabled)       │
│    → pilotswarm, sweeper, resourcemgr agents        │
│    → sweeper skill                                  │
├─────────────────────────────────────────────────────┤
│  Tier 3: Application plugins (pluginDirs)           │
│    → custom agents, skills, MCP servers             │
├─────────────────────────────────────────────────────┤
│  Tier 4: Direct config (inline options)             │
│    → skillDirectories, customAgents, mcpServers     │
├─────────────────────────────────────────────────────┤
│  Post-merge: prepend default.agent.md prompt        │
│    → every non-default agent gets system message    │
└─────────────────────────────────────────────────────┘
```

### Collision Rules

| Component | Collision Behavior |
|-----------|-------------------|
| Agents | Name collision → **later tier wins** (agent is replaced) |
| Skills | **Additive** — all skill directories are combined, no collision |
| MCP servers | Name collision → **later tier wins** (server config is replaced) |
| Tools | Last `registerTools()` call wins for the same tool name |
| `default.agent.md` | Last tier's version becomes the base system message |

### System Message Prepend

After all tiers are merged, the `default.agent.md` prompt is prepended to every loaded agent's prompt:

```text
[default.agent.md prompt]
---
[agent-specific prompt]
```

This ensures baseline rules (wait tool usage, artifact creation, sub-agent patterns) apply to every session regardless of which agent is active.

---

## 10. Best Practices

**Keep plugins focused.** Each plugin directory should represent a single application or feature domain. Don't mix unrelated agents and skills in the same directory.

**Use the system tier for invariants.** If a rule must apply to every session without exception, put it in `default.agent.md`. Don't duplicate it across individual agents.

**Prefer skills over long agent prompts.** Extract reusable domain knowledge into skills. Agents should define persona and tool access; skills should provide the how-to knowledge.

**Name tools descriptively.** Tool names are string references that flow through duroxide serialization. Names like `fetch_url` are better than `f` or `tool1`.

**Use `env:` for secrets.** Never hardcode API keys in `model_providers.json` or `.mcp.json`. Use `env:VAR_NAME` and `${VAR_NAME}` syntax respectively.

**Disable management agents in tests.** Set `disableManagementAgents: true` to avoid spawning sweeper and resource manager during integration tests.

**Use `plugin.json` for documentation.** While not used for loading, it's the right place to record your plugin's name, version, and author for human readers.

```json
{
  "name": "travel-scanner",
  "description": "Event scanning and itinerary planning tools for travel apps.",
  "version": "0.2.0",
  "author": "Your Name"
}
```

**Test tool handlers independently.** Since tools are plain async functions wrapped in `defineTool()`, you can unit test them without standing up a full PilotSwarm worker.
