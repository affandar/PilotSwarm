# PilotSwarm Plugin Architecture

A comprehensive technical reference for developers building plugins and extending PilotSwarm with custom agents, skills, tools, and MCP servers.

## 1. Overview

Plugins are self-contained packages of **agents**, **skills**, **tools**, and **MCP server configurations** that extend PilotSwarm's capabilities. They provide a standardized way to package reusable LLM functionality and durable primitives.

### What Plugins Contain

- **Agents** — LLM personas (Copilot `.agent.md` files) with system instructions, tool bindings, and optional UI enhancements
- **Skills** — Reusable knowledge bundles (Markdown + optional TypeScript) that agents reference to improve behavior
- **Tools** — Executable functions registered with the worker that agents can call (TypeScript)
- **MCP Servers** — Model Context Protocol servers for accessing external systems (local processes or remote APIs)

### Three-Tier Layering Model

PilotSwarm plugins are organized into three logical tiers, loaded in order:

1. **System Tier** — SDK-bundled system plugins (`packages/sdk/plugins/system/`)
   - Default agent configuration
   - Durable timer patterns and sub-agent utilities
   - Always loaded, fundamental to runtime behavior

2. **Management Tier** — SDK-bundled management plugins (`packages/sdk/plugins/mgmt/`)
   - Master orchestrator, resource manager, session sweeper
   - Auto-started system agents that manage the runtime
   - Can be opted out via `disableManagementAgents: true`

3. **Application Tier** — Consumer app plugins (`my-app/plugins/` or custom paths)
   - Custom agents, domain-specific skills, and tools
   - Loaded from directories specified in `pluginDirs` option
   - Merged with system and management tiers

---

## 2. Directory Layout

### SDK System Plugins

```
packages/sdk/plugins/system/
├── agents/
│   └── default.agent.md              # System prompt prepended to all agents
└── skills/
    ├── durable-timers/
    │   └── SKILL.md                  # Patterns for durable timers and polling
    └── sub-agents/
        └── SKILL.md                  # Patterns for spawning and managing sub-agents
```

### SDK Management Plugins

```
packages/sdk/plugins/mgmt/
├── agents/
│   ├── pilotswarm.agent.md           # Master orchestrator (system agent)
│   ├── resourcemgr.agent.md          # Resource monitor (system agent)
│   └── sweeper.agent.md              # Session cleanup (system agent)
└── skills/
    └── sweeper/
        ├── SKILL.md                  # Sweeper knowledge
        └── tools.json                # Tool registry (metadata)
```

### Application Plugins

```
my-app/plugins/
├── agents/
│   ├── planner.agent.md              # Custom agent definition
│   └── reviewer.agent.md             # Another custom agent
├── skills/
│   ├── code-review/
│   │   └── SKILL.md
│   └── task-planning/
│       └── SKILL.md
├── .mcp.json                         # MCP server configs
└── plugin.json                       # Optional plugin metadata
```

### Top-Level Configuration Files

```
my-app/
├── .model_providers.json             # Multi-provider LLM configuration (centralized)
├── plugins/                          # Application plugins (can have multiple plugin dirs)
└── custom-plugins/                   # Another plugin directory (optional)
```

---

## 3. Loading Order & Merge Rules

The worker loads plugins in four stages during initialization. Each stage can add agents, skills, tools, and MCP servers, with later stages overriding earlier ones where applicable.

### Four-Stage Loading

**Stage 1: System Plugins** (always loaded)
```typescript
const sdkPluginsDir = path.resolve(__sdkDir, "..", "plugins");
const systemDir = path.join(sdkPluginsDir, "system");
this._loadPluginDir(systemDir);
```

**Stage 2: Management Plugins** (opt-out via `disableManagementAgents`)
```typescript
if (!config.disableManagementAgents) {
    const mgmtDir = path.join(sdkPluginsDir, "mgmt");
    this._loadPluginDir(mgmtDir);
}
```

**Stage 3: Application Plugins** (from `pluginDirs` option)
```typescript
for (const pluginDir of (config.pluginDirs || [])) {
    const absDir = path.resolve(pluginDir);
    this._loadPluginDir(absDir);
}
```

**Stage 4: Direct Configuration** (inline options override all)
```typescript
if (config.skillDirectories?.length) {
    this._loadedSkillDirs.push(...config.skillDirectories);
}
if (config.customAgents?.length) {
    this._loadedAgents.push(...config.customAgents);
}
if (config.mcpServers) {
    Object.assign(this._loadedMcpServers, config.mcpServers);
}
```

### Merge Semantics

| Component | Merge Behavior | Conflict Resolution |
|-----------|----------------|---------------------|
| **Agents** | Later tiers override earlier tiers by name | Last definition wins |
| **Skills** | Merged additively; all available to all agents | All included |
| **Tools** | Registered cumulatively on worker | All available to all sessions |
| **MCP Servers** | Later tiers override earlier tiers by name | Last definition wins |
| **System Prompt** | `default.agent.md` always prepended as base | System message prepended to all agents (can be overridden with `mode: replace`) |

### Special Case: Default Agent Prompt

When a `default` agent is found in any tierI now have all the necessary context. Creating the comprehensive plugin architecture document:

```markdown
# PilotSwarm Plugin Architecture

## Overview

Plugins are the primary mechanism for extending PilotSwarm with custom agents, skills, tools, and Model Context Protocol (MCP) servers. They are **composable bundles** of configuration and code that layer together following a deterministic loading order.

### What Plugins Contain

A plugin directory is a standard layout that the worker scans at startup:

```
my-plugin/
├── agents/              # Agent definitions (.agent.md files)
├── skills/              # Skill metadata and documentation
│   └── my-skill/
│       └── SKILL.md
├── .mcp.json            # MCP server configurations
└── plugin.json          # Optional plugin manifest
```

Each file type serves a specific purpose:

- **`.agent.md` files** — Define agents with YAML frontmatter + markdown body (system prompt)
- **`SKILL.md` files** — Document skills (patterns, techniques) for agents to reference by name
- **`.mcp.json`** — Declare Model Context Protocol servers (local processes or HTTP endpoints)
- **`tools.json`** — Optional list of tools associated with a skill (metadata)
- **`plugin.json`** — Optional manifest with plugin name, description, version, author

Plugins are loaded in four tiers:
1. **System plugins** (always) — Core PilotSwarm infrastructure
2. **Management plugins** (opt-out) — Orchestration and maintenance agents
3. **App plugins** (opt-in) — Consumer/deployment-specific plugins
4. **Direct config** (highest priority) — Inline options in `PilotSwarmWorkerOptions`

---

## Directory Layout

### System Plugins (SDK-Bundled)

Located inside the SDK package:

```
packages/sdk/plugins/system/
├── agents/
│   └── default.agent.md          # Default system message for all sessions
└── skills/
    ├── durable-timers/
    │   └── SKILL.md              # Durable timer patterns
    └── sub-agents/
        └── SKILL.md              # Sub-agent orchestration patterns
```

The `default.agent.md` agent is special:
- It defines the base system message prepended to all other agents
- Its prompt becomes `_defaultAgentPrompt` in the worker
- Non-system agents automatically receive this prepended to their prompt

### Management Plugins (SDK-Bundled)

Located inside the SDK package (disabled with `disableManagementAgents: true`):

```
packages/sdk/plugins/mgmt/
├── agents/
│   ├── pilotswarm.agent.md       # Master orchestrator (system agent)
│   ├── resourcemgr.agent.md      # Resource manager (system agent)
│   └── sweeper.agent.md          # Session cleanup (system agent)
└── skills/
    └── sweeper/
        ├── SKILL.md
        └── tools.json            # Tool list for this skill
```

These are **system agents** — automatically started by the worker when it boots (if CMS is enabled). Each has a deterministic UUID derived from its `id` field.

### Consumer App Plugins

Located in your application directory (referenced via `pluginDirs`):

```
my-app/
├── plugins/
│   ├── my-assistant-plugin/
│   │   ├── agents/
│   │   │   ├── planner.agent.md
│   │   │   └── researcher.agent.md
│   │   ├── skills/
│   │   │   ├── web-search/
│   │   │   │   └── SKILL.md
│   │   │   └── document-generation/
│   │   │       └── SKILL.md
│   │   ├── .mcp.json
│   │   └── plugin.json
│   │
│   └── another-plugin/
│       ├── agents/
│       ├── skills/
│       └── .mcp.json
│
├── .model_providers.json         # Model provider registry
└── worker-config.js              # Setup code
```

Each plugin directory is independent. Agents and skills within one plugin can be used by agents in another plugin (merged at worker startup).

---

## Loading Order & Merge Rules

The worker loads plugins in **four sequential stages**. Each stage appends to the previous, with **later stages overriding earlier ones** for agents with the same name (by design — allows deployment configuration to shadow SDK defaults).

### Stage 1: System Plugins (Always)

```typescript
// From packages/sdk/plugins/system/
const systemDir = path.resolve(__sdkDir, "..", "plugins", "system");
this._loadPluginDir(systemDir);
```

**Result:**
- `_defaultAgentPrompt` set from `default.agent.md`
- System skills registered: `durable-timers`, `sub-agents`

### Stage 2: Management Plugins (Opt-Out)

```typescript
// From packages/sdk/plugins/mgmt/ (unless disableManagementAgents=true)
if (!options.disableManagementAgents) {
    const mgmtDir = path.resolve(__sdkDir, "..", "plugins", "mgmt");
    this._loadPluginDir(mgmtDir);
}
```

**Result:**
- Management agents registered: `pilotswarm`, `resourcemgr`, `sweeper` (all system agents)
- Management skills registered: `sweeper`

### Stage 3: App Plugins (From pluginDirs)

```typescript
const pluginDirs = options.pluginDirs ?? [];
for (const pluginDir of pluginDirs) {
    const absDir = path.resolve(pluginDir);
    this._loadPluginDir(absDir);
}
```

**Result:**
- Consumer agents and skills appended to the loaded lists

### Stage 4: Direct Config (Highest Priority)

```typescript
if (options.skillDirectories?.length) {
    this._loadedSkillDirs.push(...options.skillDirectories);
}
if (options.customAgents?.length) {
    this._loadedAgents.push(...options.customAgents);
}
if (options.mcpServers) {
    Object.assign(this._loadedMcpServers, options.mcpServers);
}
```

**Result:**
- Inline configuration merged last

### Merge Semantics

| Layer | Agents | Skills | Tools | MCP Servers | System Prompt |
|-------|--------|--------|-------|-------------|---------------|
| **Agents** | Later stages **override** by name (last writer wins) | N/A | N/A | N/A | `default.agent.md` from system always prepended |
| **Skills** | N/A | **Additive** — all skills available to all agents | N/A | N/A | N/A |
| **Tools** | N/A | N/A | **Additive** — all tools registered on worker | N/A | N/A |
| **MCP Servers** | N/A | N/A | N/A | **Override by name** (later stages shadow earlier) | N/A |

**Example**: If system defines agent `turbo` and app defines agent `turbo`, the app version is used. If both system and app define MCP server `sqlite`, the app config wins.

### Special: System Prompt Prepending

After all agents are loaded, the worker prepends the system prompt to each non-system agent:

```typescript
if (this._defaultAgentPrompt) {
    for (const agent of this._loadedAgents) {
        agent.prompt = `${this._defaultAgentPrompt}\n\n---\n\n${agent.prompt}`;
    }
}
```

This happens **only once at startup** — the prepended prompt is baked into the agent config and travels through duroxide.

---

## Agent Definitions

Agents are defined in `.agent.md` files with YAML frontmatter followed by markdown body.

### File Format

```markdown
---
name: planner
description: Breaks down complex tasks into structured plans.
system: false
id: custom-planner
title: Task Planner
parent: pilotswarm
tools:
  - bash
  - write_artifact
  - read_artifact
initialPrompt: >
  Start by asking the user for their main objective.
  Then create a step-by-step plan.
splash: |
  {bold}{green-fg}
   ┌─ Planner Agent ─┐
   │ Breaking tasks  │
   │ into steps...   │
   └─────────────────┘
  {/green-fg}{/bold}
---

# Planner Agent

You are a planning expert. Your job is to:

1. Listen to user requests
2. Break them into atomic steps
3. Assign each step a priority and estimated time
4. Present the plan clearly

Use structured JSON for plans. Each step should have:
- description
- estimated_time_seconds
- dependencies (array of previous step indices)
```

### YAML Frontmatter Fields

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `name` | string | Yes | Unique agent name (derived from filename if omitted) |
| `description` | string | No | 1-2 sentence description for UI lists |
| `tools` | array | No | Tool names this agent can use (e.g., `["bash", "grep"]`) |
| `system` | boolean | No | If `true`, agent is auto-started by worker on boot |
| `id` | string | No (required if `system: true`) | Unique slug for system agents; used to derive deterministic session UUID |
| `title` | string | No | Display name in session list (defaults to capitalized name + " Agent") |
| `parent` | string | No | ID slug of parent system agent (e.g., `"pilotswarm"`) — makes this a sub-agent |
| `initialPrompt` | string | No | Message to send when agent first starts; uses YAML `>` (folded) or `\|` (literal) syntax |
| `splash` | string | No | Blessed markup banner shown in TUI when session is selected |

### System Agent Contract

System agents are special: they are deterministic, always-on, and undeletable. **Requirements:**

1. **Must have `id` field** — derives a fixed session UUID via:
   ```typescript
   systemAgentUUID(id: string) → "12345678-1234-5678-1234-567890abcdef"
   ```

2. **Must have `system: true`** — marks the agent as critical infrastructure

3. **UUID is deterministic** — same `id` in any worker produces the same UUID, ensuring the same session is resumed across restarts

4. **Auto-started on worker boot** — when CMS is enabled, system agents are automatically started with `initialPrompt` sent immediately

5. **Undeletable via UI** — clients cannot delete system sessions (enforced in TUI)

6. **Can have sub-agents** — use `parent` field to set parent relationship
   ```yaml
   name: resource-monitor
   parent: pilotswarm
   system: true
   id: resource-monitor
   ```

### Deriving Agent Name from Filename

If the `name` field is omitted, it's derived from the `.agent.md` filename:

```
planner.agent.md     → name: "planner"
task-tracker.agent.md → name: "task-tracker"
my_assistant.agent.md → name: "my_assistant"
```

### Splash Screen Support

Optional `splash` field renders in the TUI using **blessed markup** (see [blessed docs](http://blessed.js.org/)):

```yaml
splash: |
  {bold}{blue-fg}╔════════════════╗{/blue-fg}
  ║   My Agent    ║
  ╚════════════════╝{/bold}{/blue-fg}
  Status: {green-fg}Ready{/green-fg}
```

Supported markup:
- `{bold}` / `{/bold}` — bold text
- `{color-fg}` / `{/color-fg}` — foreground colors (e.g., `{red-fg}`, `{green-fg}`, `{blue-fg}`)
- `{color-bg}` / `{/color-bg}` — background colors

---

## Skills

Skills are **documentation and patterns** that agents can reference by name. They don't execute code directly — instead, they provide expert knowledge.

### File Format

Each skill lives in its own directory with a `SKILL.md` file:

```
my-plugin/skills/
├── web-search/
│   └── SKILL.md
├── data-analysis/
│   └── SKILL.md
└── report-generation/
    ├── SKILL.md
    └── tools.json  (optional)
```

The `SKILL.md` uses the same YAML frontmatter + markdown body format:

```markdown
---
name: web-search
description: Techniques for searching and scraping web content.
---

# Web Search Patterns

You are an expert at finding information on the web.

## Techniques

### Breadth-First Search
1. Start with a broad query
2. Narrow based on results
3. Compare multiple sources

### Fact-Checking
- Always verify with at least 2 sources
- Check publication dates
- Look for editorial reviews

## Tools You Have
- `curl` — fetch web pages
- `grep` — search content
- `python-beautifulsoup` — parse HTML
```

### Registering Skills in Agent YAML

Skills are **loaded into the agent's system context** when the agent is created. Agent frontmatter doesn't directly reference skills. Instead:

1. Worker loads all skill `SKILL.md` files into `skillDirectories`
2. Worker passes `skillDirectories` to SDK's `SessionConfig`
3. SDK automatically injects skills into each session
4. Agent sees skills as part of its augmented system message

**Result**: All agents have access to all skills by default.

### Optional `tools.json`

A skill can include `tools.json` to document which tools it uses:

```json
{
  "tools": ["curl", "bash", "write_artifact"]
}
```

This is **metadata only** — it doesn't restrict or enable tools. It helps document skill dependencies for UI/documentation purposes.

---

## Tools

Tools are **TypeScript/JavaScript code** that agents can invoke. They are registered on the worker and referenced by name in agent configurations.

### Tool Registration

Tools are registered at the worker level using `worker.registerTools()`:

```typescript
import { defineTool } from "@github/copilot-sdk";

const myTool = defineTool({
    name: "my-tool",
    description: "Does something useful.",
    inputSchema: {
        type: "object",
        properties: {
            input: { type: "string", description: "What to process" }
        },
        required: ["input"]
    },
    handler: async (args) => {
        console.log("Processing:", args.input);
        return { result: "done" };
    }
});

worker.registerTools([myTool]);
```

**Key points:**
- Tools are non-serializable (contain handler functions)
- Only registered on the **worker**, not passed through duroxide
- Tools must be registered **before** `worker.start()`
- Multiple calls to `registerTools()` accumulate (they all become available)

### Referencing Tools in Agents

Agent YAML references tools by name (serializable strings):

```yaml
---
name: researcher
tools:
  - my-tool
  - bash
  - write_artifact
---
```

The worker resolves these names to actual `Tool` objects at execution time via its `toolRegistry` map.

### Tool Resolution Flow

1. **Client creates session** with `toolNames: ["my-tool", "bash"]`
2. **Client sends through duroxide** (names are serializable)
3. **Worker receives in activity** — looks up names in `toolRegistry`
4. **Worker resolves to Tool objects** and passes to SDK's `CopilotSession`
5. **Agent can invoke tools** — SDK handles the rest

This two-phase approach allows **distributed execution**: client and worker can run on different machines, and only names cross the process boundary.

### Built-In Tools

PilotSwarm includes several built-in tools (registered automatically):

- **`wait`** — durable timer (survives restarts)
- **`bash`** — execute bash commands
- **`write_artifact`** — save files to shared storage
- **`export_artifact`** — generate download links
- **`read_artifact`** — read files from shared storage
- **`list_available_models`** — list configured LLM models
- **`get_system_stats`** — query cluster stats (management agents)
- **`scan_completed_sessions`** — find finished sessions (sweeper)
- **`cleanup_session`** — delete a session (sweeper)

---

## MCP Config

Model Context Protocol (MCP) servers provide tools and resources to agents. They can be local processes (stdio) or remote HTTP endpoints.

### File Format

Define MCP servers in `.mcp.json` at the plugin root:

```json
{
  "sqlite": {
    "type": "local",
    "command": "node",
    "args": ["./sqlite-mcp-server.js"],
    "tools": ["*"],
    "env": {
      "DB_PATH": "/var/lib/myapp.db"
    },
    "timeout": 5000
  },
  "github-api": {
    "type": "http",
    "url": "https://mcp.example.com/github",
    "tools": ["list_repos", "create_issue", "add_comment"],
    "headers": {
      "Authorization": "Bearer ${GITHUB_MCP_TOKEN}"
    },
    "timeout": 10000
  },
  "weather-service": {
    "type": "sse",
    "url": "https://weather.example.com/mcp",
    "tools": ["*"]
  }
}
```

### Config Fields

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `type` | `local`, `http`, `sse` | No | Defaults to `local` for stdio-based servers |
| `command` | string | For `local` | Executable name (e.g., `"node"`, `"python"`) |
| `args` | array | For `local` | Arguments to pass to command |
| `url` | string | For `http`/`sse` | Endpoint URL |
| `tools` | array | Yes | Tool names exposed (`["*"]` = all tools) |
| `env` | object | No | Environment variables for local processes |
| `headers` | object | No | HTTP headers for remote servers |
| `timeout` | number | No | Timeout in milliseconds |
| `cwd` | string | No | Working directory for local processes |

### Environment Variable Expansion

String values in `.mcp.json` support `${VAR}` syntax to reference environment variables:

```json
{
  "secure-api": {
    "type": "http",
    "url": "https://api.example.com/v1",
    "headers": {
      "Authorization": "Bearer ${API_KEY}",
      "X-Service": "${SERVICE_NAME}"
    }
  }
}
```

At load time, the worker expands `${API_KEY}` to the value of `process.env.API_KEY`, etc.

### MCP Server Merging

If multiple plugins define the same MCP server name, **later tiers override** (same as agents):

```
System plugins:     {sqlite: {...}, myserver: {...}}
+ Mgmt plugins:     {myserver: {...}}  ← overrides system
+ App plugins:      {myserver: {...}}  ← overrides both
= Result:           {sqlite: ..., myserver: {...from app}}
```

---

## Model Providers

Model providers define multiple LLM endpoints, enabling **multi-provider deployments**. Models are identified by normalized names: `provider:model`.

### File Format

Create `.model_providers.json` at the app root:

```json
{
  "providers": [
    {
      "id": "github-copilot",
      "type": "github",
      "githubToken": "env:GITHUB_TOKEN",
      "models": [
        "gpt-4",
        "gpt-4-turbo",
        { "name": "claude-opus-4", "description": "High-performing reasoning model", "cost": "high" }
      ]
    },
    {
      "id": "azure-openai",
      "type": "azure",
      "baseUrl": "https://myorg.openai.azure.com/openai",
      "apiKey": "env:AZURE_API_KEY",
      "apiVersion": "2024-10-21",
      "models": [
        { "name": "gpt-4-mini", "description": "Fast, cheap model", "cost": "low" },
        { "name": "gpt-4-32k", "description": "Large context window", "cost": "high" }
      ]
    },
    {
      "id": "openai",
      "type": "openai",
      "baseUrl": "https://api.openai.com/v1",
      "apiKey": "env:OPENAI_API_KEY",
      "models": [
        "gpt-4o",
        "gpt-4o-mini"
      ]
    },
    {
      "id": "anthropic",
      "type": "anthropic",
      "baseUrl": "https://api.anthropic.com",
      "apiKey": "env:ANTHROPIC_API_KEY",
      "models": [
        "claude-3-5-sonnet",
        "claude-3-opus"
      ]
    },
    {
      "id": "local",
      "type": "openai",
      "baseUrl": "http://localhost:8000/v1",
      "models": [
        "llama-2"
      ]
    }
  ],
  "defaultModel": "github-copilot:gpt-4"
}
```

### Auto-Discovery

If no `modelProvidersPath` is specified in worker options, the worker searches for `.model_providers.json`:

1. `.model_providers.json` in current working directory
2. `.model_providers.json` in `/app/`
3. Legacy `model_providers.json` in cwd
4. Legacy `model_providers.json` in `/app/`

If found, it's loaded. Otherwise, the worker falls back to building a config from legacy environment variables.

### Model Naming

Models are identified in two ways:

- **Qualified name** (preferred): `provider:model`
  ```
  github-copilot:gpt-4
  azure-openai:gpt-4-mini
  local:llama-2
  ```

- **Bare name** (legacy): Just the model name
  ```
  gpt-4           (resolved to first provider that has it)
  gpt-4-mini
  ```

Agents and sessions can use either format when specifying a model. The worker normalizes to qualified names.

### Configuration Schema

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `id` | string | Yes | Unique provider ID (e.g., `"azure-openai"`) |
| `type` | `"github"`, `"azure"`, `"openai"`, `"anthropic"` | Yes | Provider type |
| `githubToken` | string | For `type: "github"` | GitHub token; supports `env:VAR` syntax |
| `baseUrl` | string | For non-GitHub types | API endpoint (required for Azure, OpenAI, Anthropic) |
| `apiKey` | string | No | API key; supports `env:VAR` syntax |
| `apiVersion` | string | For Azure | Azure API version (defaults to `"2024-10-21"`) |
| `models` | array | Yes | Model names or objects with `{name, description?, cost?}` |
| `defaultModel` | string | No | Fallback model in `provider:model` format |

### Usage in Sessions

When creating a session, specify a model:

```typescript
const session = client.createSession({
    model: "azure-openai:gpt-4-mini",  // Quoted name
    toolNames: ["bash", "write_artifact"]
});
```

The worker resolves the provider and passes the correct SDK config to the LLM.

---

## Configuration

The `PilotSwarmWorkerOptions` interface controls plugin loading and plugin defaults:

```typescript
interface PilotSwarmWorkerOptions {
    // ─── Store ──────────────────────────────────────
    store: string;              // postgres://... or sqlite://...
    
    // ─── LLM Provider ────────────────────────────────
    githubToken?: string;       // GitHub token (unless custom provider specified)
    provider?: {                // Custom LLM provider (OpenAI, Azure, Anthropic, local)
        type?: "openai" | "azure" | "anthropic";
        baseUrl: string;
        apiKey?: string;
        azure?: { apiVersion?: string };
    };
    modelProvidersPath?: string; // Path to .model_providers.json
    
    // ─── Plugins & Skills ────────────────────────────
    pluginDirs?: string[];      // App plugin directories to load
    skillDirectories?: string[]; // Additional skill directories
    customAgents?: Array<{      // Inline agents (stage 4)
        name: string;
        description?: string;
        prompt: string;
        tools?: string[] | null;
    }>;
    mcpServers?: Record<string, any>; // Inline MCP configs
    disableManagementAgents?: boolean; // Skip stage 2 (defaults: false)
    
    // ─── System Message ─────────────────────────────
    systemMessage?: string;     // Override default system prompt
    
    // ─── Schema Names ────────────────────────────────
    duroxideSchema?: string;    // Duroxide tables (defaults: "duroxide")
    cmsSchema?: string;         // CMS tables (defaults: "copilot_sessions")
    
    // ─── Performance ────────────────────────────────
    waitThreshold?: number;     // Seconds; waits shorter than this don't dehydrate
    sessionIdleTimeoutMs?: number; // Inactive session timeout
    turnTimeoutMs?: number;     // LLM turn timeout
    maxSessionsPerRuntime?: number; // Max concurrent sessions
    
    // ─── Storage ────────────────────────────────────
    blobConnectionString?: string; // Azure Blob for session dehydration
    blobContainer?: string;     // Defaults: "copilot-sessions"
    sessionStateDir?: string;   // Local state dir; defaults: ~/.copilot/session-state
}
```

### Plugin Loading Configuration

```typescript
const worker = new PilotSwarmWorker({
    store: "postgres://localhost:5432/pilotswarm",
    githubToken: process.env.GITHUB_TOKEN,
    
    // Load app plugins from these directories
    pluginDirs: [
        "./plugins",
        "/etc/myapp/plugins"
    ],
    
    // Additional skill directories not in plugins
    skillDirectories: [
        "./skills-override"
    ],
    
    // Disable management agents for headless/minimal deployments
    disableManagementAgents: false,
    
    // Inline agents (useful for small custom agents)
    customAgents: [
        {
            name: "inline-agent",
            description: "Created programmatically",
            prompt: "You are a helpful assistant.",
            tools: ["bash"]
        }
    ],
    
    // Additional MCP servers
    mcpServers: {
        "my-custom-mcp": {
            type: "http",
            url: "http://localhost:3000/mcp",
            tools: ["*"]
        }
    },
    
    // Model provider configuration
    modelProvidersPath: "./config/.model_providers.json"
});
```

### Loading Flowchart

```
PilotSwarmWorker constructor:
   1. Parse options
   2. Load Stage 1 (system plugins) via _loadPlugins()
   3. Load Stage 2 (mgmt plugins, if !disableManagementAgents)
   4. Load Stage 3 (app plugins from pluginDirs)
   5. Load Stage 4 (directconfig: skillDirectories, customAgents, mcpServers)
   6. Prepend defaultAgentPrompt to all agents
   7. Create SessionManager with merged config
   8. Return ready worker

worker.start():
   1. Create duroxide provider
   2. Create CMS (if PostgreSQL)
   3. Auto-start system agents (via CMS)
   4. Connect runtime
```

---

## Summary: Plugin Loading Example

Here's a complete end-to-end example:

**Directory structure:**
```
my-app/
├── plugins/
│   └── analysis-suite/
│       ├── agents/
│       │   ├── data-analyst.agent.md
│       │   └── report-generator.agent.md
│       ├── skills/
│       │   ├── statistical-methods/
│       │   │   └── SKILL.md
│       │   └── visualization/
│       │       └── SKILL.md
│       ├── .mcp.json
│       └── plugin.json
├── .model_providers.json
└── server.js
```

**Worker initialization:**
```typescript
import { PilotSwarmWorker, PilotSwarmClient } from "@github/pilotswarm";

const worker = new PilotSwarmWorker({
    store: "postgres://localhost/pilotswarm",
    githubToken: process.env.GITHUB_TOKEN,
    pluginDirs: ["./plugins"],
    modelProvidersPath: "./.model_providers.json",
    disableManagementAgents: false
});

await worker.start();

// At this point:
// - Stage 1: System plugins loaded (default agent + durable-timers, sub-agents skills)
// - Stage 2: Management plugins loaded (pilotswarm, resourcemgr, sweeper agents + tools)
// - Stage 3: App plugins loaded (data-analyst, report-generator agents + skills)
// - System agents auto-started (pilotswarm, resourcemgr, sweeper)
```

**Resulting configuration:**
- **Agents available**: default, pilotswarm, resourcemgr, sweeper, data-analyst, report-generator
- **Skills available**: durable-timers, sub-agents, sweeper, statistical-methods, visualization
- **Models available**: All providers from `.model_providers.json` with `provider:model` identifiers
- **MCP servers**: Any servers defined in analysis-suite/.mcp.json

Clients can now create sessions with any of these agents, and agents have access to all available skills and tools.

---

## Best Practices

### 1. Use System Agents Sparingly
System agents are heavyweight (always-on, undeletable, deterministic UUID). Reserve them for infrastructure tasks like monitoring and cleanup.

### 2. Skills > Agents for Knowledge
If you're just documenting patterns or techniques, use a SKILL.md instead of creating an agent. Skills are lightweight and all agents can use them.

### 3. Qualified Model Names
Always use qualified names (`provider:model`) in production. Bare names are fragile — they depend on provider load order.

### 4. Environment Variables in Config
Use `env:VAR` syntax in `.mcp.json` and `.model_providers.json` to keep secrets out of JSON files:
```json
{
  "apiKey": "env:MY_SECRET_KEY",
  "headers": {
    "Authorization": "Bearer ${AUTH_TOKEN}"
  }
}
```

### 5. Plugin Directory Independence
Keep each plugin directory self-contained. One plugin shouldn't depend on files from another plugin directory.

### 6. Document Tool Dependencies
If your skill uses specific tools, list them in `tools.json` for documentation:
```json
{
  "tools": ["bash", "write_artifact", "my-custom-tool"]
}
```

### 7. Disable Management Agents for Headless Deployments
For server-only deployments without a UI, set `disableManagementAgents: true` to reduce overhead:
```typescript
new PilotSwarmWorker({
    store: "postgres://...",
    disableManagementAgents: true
});
```

---

## See Also

- [Architecture Overview](architecture.md) — High-level runtime design
- [Getting Started](getting-started.md) — Quick setup guide
- [Writing Agents](writing-agents.md) — Agent design patterns
- [Durable Timers Skill](../packages/sdk/plugins/system/skills/durable-timers/SKILL.md) — Timer patterns
- [@github/copilot-sdk](https://github.com/github/copilot-sdk) — SDK reference
