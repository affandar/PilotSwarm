# TUI Apps — Off-the-Shelf Terminal Interface

> This document describes an older AppAdapter-oriented TUI design and is no longer the primary CLI guide. For the current supported path, use [Building CLI Apps](./cli/building-cli-apps.md) and [Building Agents For CLI Apps](./cli/building-agents.md).

This guide covers the **AppAdapter** framework for building rich terminal applications
on top of PilotSwarm. The runtime provides a shared `tui-core` — your app
provides an adapter that configures the agent, UI behavior, and how to load skills/agents/tools/MCP config.

**Prerequisite**: Read [building-apps.md](./building-apps.md) first for the five building
blocks (Skills, Agents, Tools, MCP Servers, Runtime).

## What You Get for Free

The `tui-core` framework handles all the terminal plumbing:

```
┌─────────────────────────────────────┬──────────────────────────┐
│ Sessions (top-left)                 │ Right Pane (full height) │
│  • session-1 ● running              │   (adapter-provided      │
│  • session-2 ~ waiting              │    log modes, metrics,   │
│  • session-3 ✓ done                 │    diagrams, etc.)       │
├─────────────────────────────────────│                          │
│ Chat (bottom-left)                  │                          │
│  You: Deploy auth-service           │                          │
│  @deployer: Applying manifests...   │                          │
│  [tool] deploy_service: done        │                          │
│  @deployer: Deployed ✓              │                          │
└─────────────────────────────────────┴──────────────────────────┘
 [Input: ________________________________________________] Ready
```

| Built-in Component | Description |
|--------------------|-------------|
| **Screen + layout** | Two-column blessed layout, resize with `[`/`]` |
| **Session list** | Status colors, change indicators, live status icons |
| **Chat pane** | Markdown rendering, scrollback, per-session buffers |
| **Input bar** | Text input, slash command dispatch |
| **Observer loop** | Polls `waitForStatusChange()`, pipes results to chat |
| **Orchestration polling** | Refreshes session list every 3s |
| **Session switching** | `j`/`k` navigate, `Enter` switch, history loaded on switch |
| **Pane navigation** | `Tab` cycle, `h`/`l` left/right, `p` back to prompt |
| **Cleanup** | Ctrl-C → abort observers → stop workers → disconnect |

## The AppAdapter Interface

Your adapter configures everything app-specific. The key addition over raw SDK usage is
**hooks** for loading skills, composing agents, reading tool definitions, and MCP config.

```typescript
interface AppAdapter {
  // ─── Identity ─────────────────────────────────────────
  title: string;                              // Screen title
  welcomeMessage: string[];                   // Blessed-tagged lines shown on startup
  helpLines: string[];                        // /help output

  // ─── Skills, Agents, Tools, MCP Loading ───────────────
  // Hooks for how to discover and load the five building blocks.
  // The TUI calls these at startup and passes results to the worker/client.

  /** Where skill directories live (relative to app root). */
  skillsDir?: string;                         // e.g., "./skills"

  /** Compose agents from loaded skills. Called after skills are loaded. */
  composeAgents?(skills: Skill[]): CustomAgent[];

  /** Provide tool implementations. Called to register on the worker. */
  getTools(): Tool[];

  /** Optional MCP server config for session creation (service-side). */
  getMcpServers?(): Record<string, any>;

  // ─── Agent Defaults ───────────────────────────────────
  agent: {
    systemMessage: string;                    // Orchestrator prompt (delegates to agents)
    model?: string;                           // Default LLM model
    orchestrationParams?: {
      dehydrateThreshold?: number;            // default: 30
      idleTimeout?: number;                   // default: 30
      inputGracePeriod?: number;              // default: 30
    };
    summarizePrompt?: string;                 // Auto-summarize on session attach
  };

  // ─── Runtime ──────────────────────────────────────────
  createClient(): Promise<PilotSwarmClient>;
  createWorkers?(client: PilotSwarmClient): Promise<Worker[]>;
  getInstancePrefix(): string;                // e.g., "session-", "smelter-"

  // ─── Session Management ───────────────────────────────
  createSession(client: PilotSwarmClient, agents: CustomAgent[]): Promise<PilotSwarmSession>;
  formatSessionLabel(orchId: string, info: InstanceInfo, heading?: string): string;
  loadHistory?(orchId: string, client: PilotSwarmClient): Promise<ChatLine[]>;

  // ─── UI Customization ─────────────────────────────────
  slashCommands: Map<string, SlashCommandDef>;
  rightPaneModes: RightPaneMode[];
  interpretCustomStatus?(cs: any): {
    chatLine?: string;
    statusBar?: string;
    liveStatus?: string;
  };

  // ─── Cleanup ──────────────────────────────────────────
  cleanup?(): Promise<void>;
}
```

## How the TUI Wires Everything Together

When you call `createTui(adapter)`, this is what happens:

```
  createTui(adapter)
       │
       ├─ 1. Load skills from adapter.skillsDir
       │      reads SKILL.md + tools.json from each subdirectory
       │
       ├─ 2. Compose agents via adapter.composeAgents(skills)
       │      maps skills → focused agents with filtered tools
       │
       ├─ 3. Get tool implementations via adapter.getTools()
       │      returns Tool objects with handlers
       │
       ├─ 4. Get MCP config via adapter.getMcpServers() (optional)
       │
       ├─ 5. Create client via adapter.createClient()
       │      connects to PostgreSQL
       │
       ├─ 6. Create workers via adapter.createWorkers(client)
       │      registers tools on workers
       │      starts polling for orchestrations
       │
       ├─ 7. Create blessed screen + panels
       │      session list, chat pane, input bar, right pane
       │
       ├─ 8. Wire input handling
       │      built-in keys + adapter.slashCommands
       │
       ├─ 9. Create initial session
       │      adapter.createSession(client, agents)
       │      passes systemMessage + customAgents + toolNames + mcpServers
       │
       ├─ 10. Start observer loop + orchestration polling
       │      adapter.interpretCustomStatus() for display
       │
       └─ 11. Show adapter.welcomeMessage, render, focus input
```

## Example: Minimal TUI Adapter

A complete TUI app in ~100 lines — a deployment assistant:

```typescript
// deploy-app/tui.js
import { createTui } from "pilotswarm/tui";
import { PilotSwarmClient, PilotSwarmWorker, loadSkills } from "pilotswarm-sdk";
import { deployService, checkHealth, rollback } from "./tools.js";

await createTui({
  title: "Deploy Bot",
  welcomeMessage: [
    "{bold}Deploy Bot{/bold} — Durable deployment assistant",
    "Type a deployment request or use /deploy <service> <env>",
  ],
  helpLines: [
    "/deploy <service> <env> — Deploy a service",
    "/status — Show active deployments",
    "/rollback <service> — Rollback last deployment",
  ],

  // ─── Skills, Agents, Tools ──────────────────────────
  skillsDir: "./skills",

  composeAgents(skills) {
    return [
      {
        name: "deployer",
        description: "Deploys services and monitors health",
        prompt: skills.filter(s => ["deploy", "observe"].includes(s.name))
                       .map(s => s.prompt).join("\n\n"),
        tools: skills.filter(s => ["deploy", "observe"].includes(s.name))
                      .flatMap(s => s.toolNames),
      },
    ];
  },

  getTools() {
    return [deployService, checkHealth, rollback];
  },

  // ─── Agent ──────────────────────────────────────────
  agent: {
    systemMessage: "You are a deployment assistant. Delegate to @deployer.",
    model: "claude-sonnet-4",
    orchestrationParams: { dehydrateThreshold: 120, idleTimeout: 120 },
  },

  // ─── Runtime ────────────────────────────────────────
  async createClient() {
    const client = new PilotSwarmClient({
      store: process.env.DATABASE_URL,
      blobEnabled: true,
    });
    await client.start();
    return client;
  },

  async createWorkers(client) {
    const w = new PilotSwarmWorker({
      store: process.env.DATABASE_URL,
      githubToken: process.env.GITHUB_TOKEN,
    });
    w.registerTools(this.getTools());
    await w.start();
    return [w];
  },

  getInstancePrefix() { return "session-"; },

  // ─── Session ────────────────────────────────────────
  async createSession(client, agents) {
    return client.createSession({
      model: this.agent.model,
      systemMessage: this.agent.systemMessage,
      customAgents: agents,
      toolNames: this.getTools().map(t => t.name),
    });
  },

  formatSessionLabel(orchId, info, heading) {
    const id = orchId.slice(8, 12);
    return heading ? `${heading} (${id})` : `(${id})`;
  },

  // ─── UI ─────────────────────────────────────────────
  slashCommands: new Map([
    ["/deploy", {
      description: "Deploy a service",
      handler: async (args, ctx) => {
        const [service, env] = args.split(" ");
        await ctx.send(`Deploy ${service} to ${env}`);
      },
    }],
    ["/status", {
      description: "Show deployments",
      handler: async (args, ctx) => {
        await ctx.send("What services are currently deployed? Give me a status summary.");
      },
    }],
  ]),

  rightPaneModes: [],  // No right pane for this simple app
});
```

Run it:
```bash
node --env-file=.env deploy-app/tui.js
```

## Adapter Hooks in Detail

### `skillsDir` + `loadSkills()`

The TUI calls `loadSkills(adapter.skillsDir)` at startup. This reads each subdirectory,
parsing `SKILL.md` frontmatter + body, and optionally `tools.json`:

```
skills/deploy/SKILL.md      → { name: "deploy", description: "...", prompt: "## Deploy\n...", toolNames: [...] }
skills/observe/SKILL.md     → { name: "observe", description: "...", prompt: "## Observe\n...", toolNames: [...] }
skills/deploy/scripts/       → available at runtime for tool handlers
```

If `skillsDir` is not set, no skills are loaded — you're in flat-tools mode.

### `composeAgents(skills)`

Called with loaded skills. Return an array of `CustomAgent` objects. This is where you
decide which skills go into which agent:

```typescript
composeAgents(skills) {
  const byName = Object.fromEntries(skills.map(s => [s.name, s]));

  return [
    {
      name: "builder",
      description: "...",
      prompt: [byName.build, byName.docker].map(s => s.prompt).join("\n\n"),
      tools: [byName.build, byName.docker].flatMap(s => s.toolNames),
    },
    // ...
  ];
}
```

If not provided, no agents are created — the LLM uses the flat tool list.

### `getTools()`

Returns tool implementations (`Tool[]`). These are registered on the worker and are
the actual handler code. The skill `tools.json` files just declare names — `getTools()`
provides the implementations.

```typescript
getTools() {
  return [
    deployService,   // Tool object with handler
    checkHealth,
    rollback,
  ];
}
```

### `interpretCustomStatus(cs)`

The orchestration publishes custom status as JSON. This hook tells the TUI how to display it:

```typescript
interpretCustomStatus(cs) {
  if (cs.status === "deploying") {
    return {
      chatLine: `{yellow-fg}Deploying ${cs.service} to ${cs.env}...{/yellow-fg}`,
      statusBar: `Deploying ${cs.service}...`,
      liveStatus: "running",
    };
  }
  if (cs.status === "monitoring") {
    return {
      statusBar: `Monitoring (${cs.checksCompleted}/${cs.totalChecks})`,
      liveStatus: "waiting",
    };
  }
}
```

### `rightPaneModes`

Each mode is a right-pane view. The user cycles through them with `m`:

```typescript
rightPaneModes: [
  {
    name: "deploy-log",
    label: "Deploy Logs",
    createPane: () => blessed.log({ /* ... */ }),
    onSwitch: (orchId) => { /* start streaming logs for this session */ },
  },
  {
    name: "metrics",
    label: "Metrics",
    createPane: () => blessed.log({ /* ... */ }),
    onSwitch: (orchId) => { /* fetch and display metrics */ },
  },
],
```

## Key Bindings (All Built-In)

| Key | Action |
|-----|--------|
| `n` | New session → `adapter.createSession()` |
| `Enter` | Switch to selected session |
| `j`/`k` | Navigate session list |
| `m` | Cycle right-pane modes (from `adapter.rightPaneModes`) |
| `r` | Refresh session list |
| `c` | Cancel active session |
| `d` | Delete session |
| `Tab` | Cycle panes |
| `h`/`l` | Left/right between panes |
| `p` | Back to input prompt |
| `[`/`]` | Resize right pane |
| `Esc→q` | Quit |

## Comparison: Raw SDK vs TUI Adapter

| | Raw SDK (building-apps.md) | TUI Adapter (this doc) |
|---|---|---|
| **UI** | You build it (or none) | Full terminal UI out of the box |
| **Skills** | `loadSkills()` yourself | `skillsDir` hook — loaded automatically |
| **Agents** | `customAgents` in `createSession()` | `composeAgents(skills)` hook |
| **Tools** | `worker.registerTools()` | `getTools()` hook — registered automatically |
| **Sessions** | Manual create/send/observe | Automatic create, observe, switch |
| **Status display** | You parse customStatus | `interpretCustomStatus()` hook |
| **Slash commands** | N/A | Declarative map |
| **Right pane** | N/A | Pluggable modes |
| **Lines of code** | 20-200 | ~100-200 (adapter only) |

## Further Reading

- [Building Apps](./building-apps.md) — Raw SDK: Skills, Agents, Tools, MCP Servers, Runtime
- [Architecture](./architecture.md) — SDK internals
- [Deploying to AKS](./deploying-to-aks.md) — Production deployment
