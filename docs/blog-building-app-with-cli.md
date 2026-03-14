# Building a Support Bot with PilotSwarm CLI

*A complete walkthrough for developers getting started with durable Copilot agents*

---

## What You'll Build

In this tutorial, we'll build a **customer support bot** that demonstrates the full power of PilotSwarm:

- 🤖 **Custom agents** — A frontend agent that handles user queries and a background escalation agent
- 🛠️ **Custom tools** — Create tickets, lookup customer profiles, and add notes
- ⏱️ **Durable timers** — Wait for external events (customer responses, ticket updates) without holding a process
- 🎯 **Skill-based workflow** — Reusable ticket management logic packaged as a skill
- 🔄 **Auto-scaling** — Run on a single machine or deploy to Kubernetes (AKS) with automatic session recovery
- 💾 **Resilience** — Sessions survive crashes, node migrations, and process restarts

By the end, you'll have a bot that handles real customer conversations, escalates to humans when needed, and continues seamlessly even if the process crashes.

---

## Prerequisites

Before you start, make sure you have:

| Requirement | Version | Why |
|---|---|---|
| **Node.js** | ≥ 24 | Runtime for JavaScript/TypeScript |
| **npm** | ≥ 10 | Package manager |
| **PostgreSQL** | ≥ 14 | Durability layer (or use SQLite for local dev) |
| **GitHub token** | with Copilot access | For Copilot LLM access (or use Azure OpenAI/OpenAI) |

Optional for deployment:
- **Docker** — to containerize your app
- **Azure CLI** + **kubectl** — for AKS deployment
- **Azure Storage Account** — for session dehydration across pods

### Quick Setup Check

```bash
node --version      # Node.js 24+
npm --version       # npm 10+
psql --version      # PostgreSQL 14+
echo $GITHUB_TOKEN  # Must be set or use .env
```

---

## Part 1: Project Setup

Let's create the directory structure for our support bot:

```bash
mkdir my-support-bot
cd my-support-bot
npm init -y
npm install pilotswarm
npm install @github/copilot-sdk
```

Now create the project structure:

```
my-support-bot/
├── plugins/                          # Agent & skill definitions
│   ├── agents/
│   │   ├── support.agent.md          # Main support agent
│   │   └── escalation.agent.md       # Auto-escalation system agent
│   ├── skills/
│   │   └── ticket-management/
│   │       └── SKILL.md              # Reusable ticket workflow
│   ├── plugin.json                   # Plugin manifest
│   └── .mcp.json                     # MCP servers (optional)
├── src/
│   ├── tools/
│   │   ├── create-ticket.ts          # Tool implementations
│   │   ├── lookup-customer.ts
│   │   ├── add-ticket-note.ts
│   │   └── index.ts
│   ├── worker.ts                     # Tool registration
│   └── config.ts
├── .model_providers.json             # LLM provider config
├── .env                              # Environment variables
├── package.json
└── tsconfig.json
```

Create `package.json` (update as needed):

```json
{
  "name": "my-support-bot",
  "version": "1.0.0",
  "type": "module",
  "scripts": {
    "build": "tsc",
    "dev": "npx pilotswarm-cli local --plugin ./plugins --env .env --workers 2",
    "start": "node --env-file=.env dist/worker.js"
  },
  "dependencies": {
    "pilotswarm": "workspace:*",
    "@github/copilot-sdk": "^0.5.0"
  },
  "devDependencies": {
    "typescript": "^5.3",
    "@types/node": "^20.0"
  }
}
```

Create `tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ES2022",
    "moduleResolution": "bundler",
    "lib": ["ES2022"],
    "outDir": "./dist",
    "rootDir": "./src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules"]
}
```

---

## Part 2: Writing Tools

Tools are the hands of your agent — they execute real actions. Let's define three core tools for our support bot.

### File: `src/tools/create-ticket.ts`

```typescript
import { defineTool } from "@github/copilot-sdk";

export const createTicketTool = defineTool("create_ticket", {
  description: "Create a new customer support ticket in the system. Returns a ticket ID.",
  parameters: {
    type: "object" as const,
    properties: {
      customerId: {
        type: "string",
        description: "The customer ID (e.g., 'cust_12345')"
      },
      subject: {
        type: "string",
        description: "Brief subject line of the issue"
      },
      description: {
        type: "string",
        description: "Detailed description of the customer's problem"
      },
      priority: {
        type: "string",
        enum: ["low", "medium", "high", "urgent"],
        description: "Ticket priority level"
      }
    },
    required: ["customerId", "subject", "description", "priority"]
  },
  handler: async (params) => {
    // In a real app, this would write to a database or API
    const ticketId = `ticket_${Date.now()}`;
    console.log(`Created ticket: ${ticketId}`, params);
    return {
      success: true,
      ticketId,
      message: `Ticket ${ticketId} created and queued for resolution.`
    };
  }
});

export const lookupCustomerTool = defineTool("lookup_customer", {
  description: "Look up customer information by ID or email.",
  parameters: {
    type: "object" as const,
    properties: {
      customerId: {
        type: "string",
        description: "Customer ID (e.g., 'cust_12345')"
      },
      email: {
        type: "string",
        description: "Customer email address"
      }
    }
  },
  handler: async (params) => {
    // Mock customer database
    const customers: Record<string, any> = {
      "cust_001": {
        id: "cust_001",
        name: "Alice Johnson",
        email: "alice@example.com",
        accountAge: "2 years",
        totalSpent: "$5,200",
        openTickets: 0
      },
      "cust_002": {
        id: "cust_002",
        name: "Bob Smith",
        email: "bob@example.com",
        accountAge: "6 months",
        totalSpent: "$800",
        openTickets: 2
      }
    };
    
    const customer = customers[params.customerId || "cust_001"];
    if (!customer) {
      return { success: false, error: "Customer not found" };
    }
    return { success: true, customer };
  }
});

export const addTicketNoteTool = defineTool("add_ticket_note", {
  description: "Add a note to a ticket (e.g., for escalation, status updates).",
  parameters: {
    type: "object" as const,
    properties: {
      ticketId: {
        type: "string",
        description: "The ticket ID"
      },
      note: {
        type: "string",
        description: "The note to add"
      },
      internal: {
        type: "boolean",
        description: "If true, the note is internal (not visible to customer)",
        default: false
      }
    },
    required: ["ticketId", "note"]
  },
  handler: async (params) => {
    console.log(`Added note to ${params.ticketId}:`, params.note);
    return {
      success: true,
      message: `Note added to ticket ${params.ticketId}`
    };
  }
});
```

### File: `src/tools/index.ts`

```typescript
export { createTicketTool, lookupCustomerTool, addTicketNoteTool } from "./create-ticket.js";
```

---

## Part 3: Registering Tools in the Worker

The worker is where tools are registered globally. Any session can then reference these tools by name.

### File: `src/worker.ts`

```typescript
import { PilotSwarmWorker } from "pilotswarm";
import { createTicketTool, lookupCustomerTool, addTicketNoteTool } from "./tools/index.js";
import fs from "node:fs";
import path from "node:path";

const worker = new PilotSwarmWorker({
  // Database connection (auto-creates schema)
  store: process.env.DATABASE_URL || "sqlite::memory:",
  
  // GitHub token for Copilot API (or use model_providers.json)
  githubToken: process.env.GITHUB_TOKEN,
  
  // Path to model providers config (optional, defaults to .model_providers.json)
  modelProvidersPath: ".model_providers.json",
  
  // Enable session dehydration to blob storage (for multi-node scaling)
  blobStore: process.env.AZURE_STORAGE_CONNECTION_STRING ? {
    connectionString: process.env.AZURE_STORAGE_CONNECTION_STRING,
    containerName: process.env.AZURE_STORAGE_CONTAINER || "copilot-sessions"
  } : undefined,
  
  // Plugin directories (agents, skills, MCP servers)
  pluginDirs: ["./plugins"],
  
  // Logging level
  logLevel: process.env.LOG_LEVEL || "info"
});

// Register tools globally — available to all sessions
worker.registerTools([
  createTicketTool,
  lookupCustomerTool,
  addTicketNoteTool
]);

// Start the worker
await worker.start();
console.log("✅ Worker started. Listening for orchestrations...");
```

---

## Part 4: Writing the Support Agent

Agents are defined as Markdown files with YAML frontmatter. This is where you specify the agent's name, described tools, skills, and system instructions.

### File: `plugins/agents/support.agent.md`

```markdown
---
name: support
description: Customer support agent that handles queries, creates tickets, and manages escalations.
tools:
  - create_ticket
  - lookup_customer
  - add_ticket_note
  - wait              # Built-in durable timer
  - bash              # For running shell commands (optional)
  - write_artifact    # Built-in artifact storage
---

# Support Bot Agent

You are a helpful customer support agent for our company. Your job is to:

1. **Listen** — Carefully understand the customer's issue.
2. **Investigate** — Use `lookup_customer()` to get their account history.
3. **Solve** — Try to resolve the issue quickly.
4. **Escalate** — If you can't resolve it, create a ticket and mark it for escalation.

## Key Capabilities

### Durable Waiting

You have a `wait` tool that works across process restarts:

```
Use `wait(seconds)` whenever you need to pause, check back later, or poll for updates.
Examples:
  - Wait for a human to respond: wait(300)  # 5 minutes
  - Poll a system status: wait(60) in a loop
  - Schedule a follow-up check: wait(86400)  # tomorrow
```

**IMPORTANT**: Never use `setTimeout`, `sleep`, or bash delays. Always use the `wait` tool.

### Artifact Storage

Use `write_artifact()` to save ticket summaries, then `export_artifact()` to make them downloadable.

## System Instructions

- Be polite and professional.
- Always get customer ID or email to look them up first.
- Offer solutions before escalating.
- Include relevant context in escalation notes (customer history, what you tried).
- Set realistic expectations — tell the customer when they'll hear back.
```

### File: `plugins/agents/escalation.agent.md`

```markdown
---
name: escalation
description: Auto-escalation system agent that monitors and follows up on tickets.
system: true
id: escalation-bot
title: PilotSwarm Escalation Agent
tools:
  - add_ticket_note
  - wait
splash: |
  {bold}{yellow-fg}
   ⚠️  ESCALATION BOT
  {/yellow-fg}{/bold}
    {white-fg}Auto-monitoring high-priority tickets{/white-fg}
    {cyan-fg}Status: Ready{/cyan-fg}
initialPrompt: >
  You are the escalation bot. Every 60 seconds, check if there are any high-priority tickets
  waiting for more than 30 minutes. If found, mark them for immediate human review.
  Use the wait tool to implement the polling loop.
---

# Escalation Bot

You run continuously in the background, monitoring high-priority tickets.

## Responsibilities

1. Poll for new high-priority tickets every 60 seconds
2. If a ticket has been open > 30 min, add an internal note: "Escalated to Level 2"
3. Continue monitoring until told to stop

## Important

- Use `wait(60)` between polling cycles
- Always use the `wait` tool, never bash sleep
- Keep notes professional and actionable
```

---

## Part 5: Writing a Skill (Reusable Workflows)

Skills are libraries of knowledge that agents can use. Let's create a reusable ticket management skill.

### File: `plugins/skills/ticket-management/SKILL.md`

```markdown
---
name: ticket-management
description: Best practices for handling customer tickets efficiently and professionally.
---

# Ticket Management Skill

Expert guidance on managing customer support tickets in a fast, professional way.

## Ticket Lifecycle

### 1. Triage (Initial Assessment)
- **Gather info**: Name, account, issue description
- **Assess priority**: How urgent? Does customer have open tickets?
- **Check history**: Are they a VIP customer? Have they had this issue before?
- **Estimate resolution**: Can you solve it now, or does it need escalation?

### 2. Resolution Path
- **Self-service**: Can they fix it by following docs?
- **Live assistance**: Do they need real-time help?
- **Escalation**: Should a specialist take over?

### 3. You Should Escalate If
- ✅ Customer reports a bug in our product
- ✅ Customer requests a feature we don't support
- ✅ Customer has been waiting > 30 min for a response
- ✅ Customer has multiple open tickets (potential churn risk)
- ✅ Customer is a high-value account (check `accountAge` and `totalSpent`)

### 4. Follow-up
- Always include an ETA: "A human will review this within 2 hours"
- For non-urgent issues, set a `wait(7200)` and check back
- For urgent issues, escalate immediately and add an internal note

## Template: Escalation Note

```
**Escalation Note**
- Customer: [Name] (ID: [cust_X])
- Issue: [Brief description]
- Resolution Attempted: [What you tried]
- Reason for Escalation: [Why human is needed]
- Priority: [low/medium/high/urgent]
- Next Steps: [What should human do]
```

## Best Practices

1. **Always personalize** — Use the customer's name
2. **Show empathy** — Acknowledge their frustration
3. **Set expectations** — Be clear about timelines
4. **Document thoroughly** — Future agents will thank you
5. **Follow up** — If they haven't replied in 24 hours, send a gentle reminder
```

---

## Part 6: Plugin Manifest

The `plugin.json` file tells PilotSwarm where to find your agents and skills.

### File: `plugins/plugin.json`

```json
{
  "name": "my-support-bot",
  "description": "Customer support bot with escalation workflow and ticket management.",
  "version": "1.0.0",
  "author": {
    "name": "Your Name",
    "email": "you@example.com"
  },
  "license": "MIT",
  "agents": "agents/",
  "skills": "skills/"
}
```

---

## Part 7: Model Providers Configuration

Tell PilotSwarm which LLM to use. You can run GitHub Copilot, Azure OpenAI, OpenAI, or Anthropic.

### File: `.model_providers.json`

For **GitHub Copilot** (default):

```json
{
  "providers": [
    {
      "id": "github-copilot",
      "type": "github",
      "githubToken": "env:GITHUB_TOKEN",
      "models": [
        {
          "name": "claude-opus-4",
          "description": "Most capable model, best for complex reasoning"
        },
        {
          "name": "claude-sonnet-4",
          "description": "Balanced quality and speed"
        }
      ]
    }
  ],
  "defaultModel": "github-copilot:claude-sonnet-4"
}
```

For **Azure OpenAI**:

```json
{
  "providers": [
    {
      "id": "azure-openai",
      "type": "azure",
      "baseUrl": "https://my-resource.openai.azure.com/openai",
      "apiKey": "env:AZURE_OPENAI_KEY",
      "apiVersion": "2024-10-21",
      "models": [
        "gpt-4.1-mini",
        "gpt-4.1"
      ]
    }
  ],
  "defaultModel": "azure-openai:gpt-4.1"
}
```

For **OpenAI**:

```json
{
  "providers": [
    {
      "id": "openai",
      "type": "openai",
      "baseUrl": "https://api.openai.com/v1",
      "apiKey": "env:OPENAI_API_KEY",
      "models": [
        "gpt-4-turbo",
        "gpt-4-mini"
      ]
    }
  ],
  "defaultModel": "openai:gpt-4-turbo"
}
```

---

## Part 8: Environment Configuration

Create a `.env` file with secrets and connection strings:

```bash
# ──── LLM Provider ────────────────────────────
# Option A: GitHub Copilot (Copilot API)
GITHUB_TOKEN=ghp_your_token_here

# Option B: Azure OpenAI
# AZURE_OPENAI_KEY=your-azure-key
# AZURE_OPENAI_ENDPOINT=https://resource.openai.azure.com

# Option C: OpenAI
# OPENAI_API_KEY=sk-...

# ──── Database ────────────────────────────────
# PostgreSQL (recommended for production)
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/support_bot

# Or SQLite for local development (in-memory)
# DATABASE_URL=sqlite::memory:

# ──── Optional: Azure Blob Storage ────────────
# For session dehydration in multi-pod deployments
# AZURE_STORAGE_CONNECTION_STRING=DefaultEndpointsProtocol=https;...
# AZURE_STORAGE_CONTAINER=copilot-sessions

# ──── Logging ─────────────────────────────────
LOG_LEVEL=info
```

---

## Part 9: Running the Bot

### Local Mode (Single Process with Embedded Workers)

This runs the CLI with 2 embedded workers (agents run inline, no separate process):

```bash
npm run dev
# or: npx pilotswarm-cli local --plugin ./plugins --env .env --workers 2
```

The TUI will open. You can now:
1. Create a new session
2. Chat with the support bot
3. Watch it create tickets, escalate issues, and use durable timers

### Running Headless (Worker Only)

If you want to run the worker separately and connect with a client:

```bash
npm run build
node --env-file=.env dist/worker.js
```

Then in another terminal, connect a client:

```javascript
import { PilotSwarmClient } from "pilotswarm";

const client = new PilotSwarmClient({
  store: process.env.DATABASE_URL
});
await client.start();

const session = await client.createSession({
  toolNames: ["create_ticket", "lookup_customer", "add_ticket_note"]
});

const response = await session.sendAndWait(
  "Hi! I'm having trouble with my account.",
  300_000  // 5 min timeout
);

console.log(response.message);
```

### Production Deployment (AKS + Docker)

For production, you'll run workers on Kubernetes and the CLI connects back:

```bash
# 1. Build the Docker image
docker build -f deploy/Dockerfile.worker -t my-support-bot:latest .

# 2. Deploy to AKS (helper script)
./scripts/deploy-aks.sh --image my-support-bot:latest

# 3. Connect the TUI (remote mode)
npx pilotswarm-cli remote --store postgresql://... --context my-aks-cluster
```

---

## Part 10: Under the Hood — How It All Works

### 3-Tier Plugin Loading

PilotSwarm loads plugins in three tiers:

1. **System Plugins** (SDK built-in)
   - Default agent with wait, bash, artifact tools
   - Sub-agent tools (spawn_agent, message_agent, check_agents)
   - Durable timer skill

2. **Management Plugins** (SDK built-in)
   - PilotSwarm agent (orchestrator)
   - Sweeper agent (cleanup)
   - Resource manager (monitoring)

3. **Your App Plugins** (from `--plugin ./plugins`)
   - support.agent.md
   - escalation.agent.md
   - ticket-management skill

When a user creates a session, they can pick which agent to start with. If the agent has `system: true`, it auto-starts.

### Durability in Action

Here's what happens when your support agent calls `wait(300)`:

```
┌─ Client ────────────┐
│  "Wait 5 min"       │
└──────────┬──────────┘
           │
           ↓
┌─ Duroxide Orchestration ─────────────────────┐
│ 1. Receive command from client               │
│ 2. Yield scheduleTimer(300 seconds)          │
│ 3. Record timer in PostgreSQL                │
│ 4. Yield activity.runTurn()                  │
│ 5. Worker executes the wait                  │
│ 6. Timer fires in 300 seconds (even if      │
│    process dies and restarts)                │
└─────────────────────────────────────────────┘
           │
           ↓
┌─ Worker ────────────────────┐
│ 1. Session sleeps (async)   │
│ 2. Process can die or move  │
│ 3. On next worker startup   │
│    timer wakes session      │
│ 4. Agent continues from     │
│    exact same point         │
└─────────────────────────────┘
```

### Tools Registration Flow

```
Worker starts
  ↓
worker.registerTools([createTicketTool, ...])
  ↓
Agent.agent.md specifies: tools: [create_ticket, ...]
  ↓
Session created by client with: toolNames: ["create_ticket", ...]
  ↓
When agent calls create_ticket():
  1. Orchestration yields activity.runTurn()
  2. Worker finds tool in registry
  3. Tool handler executes
  4. Result flows back to agent
```

---

## Next Steps & Resources

🎯 **What to Try Next:**
- Add more tools (check status, apply discounts, etc.)
- Create sub-agents (one for billing, one for tech support)
- Deploy to AKS with multi-node scaling
- Add Azure Blob storage for session dehydration
- Hook up real databases/APIs instead of mocks

📚 **Learn More:**
- [Architecture Guide](../docs/architecture.md) — Deep dive into orchestration
- [Writing Agents](../docs/writing-agents.md) — Advanced agent patterns
- [Deploying to AKS](../docs/deploying-to-aks.md) — Production setup
- [Skills & Sub-Agents](../docs/building-apps.md) — Advanced features

💬 **Questions?**
- Check the [GitHub Discussions](https://github.com/microsoft/pilotswarm/discussions)
- File an issue on [GitHub Issues](https://github.com/microsoft/pilotswarm/issues)

---

## Troubleshooting

### "Module not found" errors
Make sure you ran `npm install` and `npm run build`:
```bash
npm install
npm run build
```

### Database won't connect
Check your `DATABASE_URL` in `.env`:
```bash
# PostgreSQL
psql $DATABASE_URL  # Should not error

# SQLite (for local dev)
DATABASE_URL=sqlite::memory:  # Works in-memory
```

### Agent won't start
Make sure `plugin.json` exists and points to agents:
```json
{
  "agents": "agents/",
  "skills": "skills/"
}
```

And the YAML frontmatter is valid:
```markdown
---
name: support
description: (description)
---
```

### Tools not available
Check that tools are registered in the worker:
```typescript
worker.registerTools([createTicketTool, ...]);  // Must be before worker.start()
```

And that the agent's frontmatter lists them:
```markdown
tools:
  - create_ticket
  - lookup_customer
```

---

## Summary

You now have a fully functional support bot that:
✅ Handles customer queries intelligently  
✅ Creates and escalates tickets  
✅ Waits for external events using durable timers  
✅ Uses reusable skills  
✅ Survives crashes and node migrations  
✅ Scales from laptop to Kubernetes cluster  

Happy building! 🚀
