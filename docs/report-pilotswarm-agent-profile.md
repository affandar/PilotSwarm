# PilotSwarm Agent System: Code Profile & Monitoring/Self-Healing Assessment

**Date**: 2026-03-17
**Scope**: Full codebase analysis of `pilotswarm` — architecture, agent model, and applicability to infrastructure monitoring and self-healing.

---

## Table of Contents

1. [System Overview](#1-system-overview)
2. [What Is an Agent?](#2-what-is-an-agent)
3. [How an Agent Is Built](#3-how-an-agent-is-built)
4. [Agent Execution Model](#4-agent-execution-model)
5. [Durability & Crash Recovery](#5-durability--crash-recovery)
6. [Multi-Agent Orchestration](#6-multi-agent-orchestration)
7. [Applying PilotSwarm to Monitoring & Self-Healing](#7-applying-pilotswarm-to-monitoring--self-healing)
8. [Architecture for a Monitoring/Self-Healing Deployment](#8-architecture-for-a-monitoringself-healing-deployment)
9. [Gaps & Considerations](#9-gaps--considerations)
10. [Recommendations](#10-recommendations)

---

## 1. System Overview

PilotSwarm is a **durable execution runtime** for LLM-powered agents built on top of the GitHub Copilot SDK. It solves the hard problems of running autonomous agents in production:

| Capability | How |
|---|---|
| **Crash recovery** | Sessions resume from last checkpoint via duroxide (Microsoft's durable orchestration engine) backed by PostgreSQL |
| **Durable timers** | Long waits (>=30s) are persisted — the process can shut down, and the agent resumes when the timer fires |
| **Multi-node scaling** | Sessions migrate between worker pods via Azure Blob Storage dehydration/rehydration |
| **Persistent history** | Full conversation + event history stored in PostgreSQL (CMS) |
| **Sub-agent spawning** | Agents can create, monitor, message, and terminate child agents (up to 3 levels deep) |
| **Plugin system** | Agents, skills, tools, and MCP servers loaded from plugin directories |

### Core Architecture

```
+---------------------------------------------------------------------+
|  PilotSwarmClient (lightweight, no LLM access)                      |
|  - Creates/resumes/deletes sessions                                 |
|  - Sends prompts, receives events                                   |
|  - References tools by NAME only (serializable strings)             |
+--------------------+------------------------------------------------+
                     |  PostgreSQL (shared state)
+--------------------+------------------------------------------------+
|  PilotSwarmWorker (runs LLM turns, executes tools)                  |
|  - Loads agents/skills/MCP from plugin directories                  |
|  - Owns SessionManager -> ManagedSession -> CopilotSession (SDK)    |
|  - Registers duroxide orchestrations + activities                   |
|  - Resolves tool NAMES -> actual Tool objects with handlers         |
|  - Auto-starts system agents on boot                                |
+---------------------------------------------------------------------+
```

### Key Source Files

| File | Purpose |
|---|---|
| `packages/sdk/src/orchestration.ts` | Main durable execution loop (~1,500 lines) |
| `packages/sdk/src/managed-session.ts` | Session wrapper, system tool definitions (wait, spawn_agent, etc.) |
| `packages/sdk/src/session-manager.ts` | Session lifecycle, CopilotSession creation, tool resolution |
| `packages/sdk/src/worker.ts` | Runtime initialization, plugin loading, tool registry |
| `packages/sdk/src/client.ts` | Client API for session management |
| `packages/sdk/src/cms.ts` | PostgreSQL session catalog (state, events) |
| `packages/sdk/src/agent-loader.ts` | `.agent.md` file parsing |
| `packages/sdk/src/model-providers.ts` | Multi-provider LLM registry |
| `packages/sdk/src/blob-store.ts` | Azure Blob session state persistence |
| `packages/sdk/src/types.ts` | All TypeScript interfaces and types |

---

## 2. What Is an Agent?

An **Agent** in PilotSwarm is a durable, autonomous LLM worker defined by three things:

1. **A system prompt** — personality, rules, and behavior (markdown)
2. **A set of tools** — functions the LLM can call (API calls, shell commands, database queries, etc.)
3. **An execution context** — managed by the durable orchestration engine (crash-recoverable, timer-capable, sub-agent-aware)

### Agent Configuration (from `.agent.md` files)

```typescript
interface AgentConfig {
    name: string;           // Unique identifier (e.g., "sweeper")
    description?: string;   // Human-readable description
    prompt: string;         // System message (the markdown body)
    tools?: string[];       // Tool names this agent can use
    system?: boolean;       // Auto-started, runs forever, protected from deletion
    id?: string;            // Deterministic UUID slug (for system agents)
    title?: string;         // Display name
    parent?: string;        // Parent system agent (for hierarchical agents)
    initialPrompt?: string; // First prompt sent when spawned
    namespace?: string;     // Plugin namespace
    splash?: string;        // TUI banner
}
```

### Agent Lifecycle States

An agent's session moves through these states:

```
pending -> running -> idle <-> running
                   \-> waiting -> (timer fires) -> running
                   \-> input_required -> (user replies) -> running
                   \-> completed (non-system agents only)
                   \-> failed / error (with retry logic)
```

| State | Meaning |
|---|---|
| `pending` | Session created, not yet started |
| `running` | LLM turn in progress |
| `idle` | Turn complete, waiting for next message |
| `waiting` | Durable timer scheduled — process can shut down safely |
| `input_required` | Awaiting user/external input |
| `completed` | Task finished (sub-agents terminate here) |
| `failed` / `error` | Error occurred, may retry with exponential backoff |

### Two Types of Agents

**User-invocable agents** — Created on demand, terminate when done:
- Invoked via `@name` mention or `spawn_agent()` tool call
- Good for: one-shot tasks, investigations, report generation

**System agents** — Auto-started at boot, run forever:
- Marked with `system: true` in frontmatter
- Protected from deletion
- Good for: monitoring loops, maintenance, self-healing

---

## 3. How an Agent Is Built

### Step 1: Define the Agent (`.agent.md` file)

An agent is a single markdown file with YAML frontmatter:

```markdown
---
name: health-checker
description: Monitors service health and triggers remediation.
system: true
id: health-checker
title: Health Checker Agent
tools:
  - check_service_health
  - restart_service
  - send_alert
  - wait
  - bash
initialPrompt: >
  You are a PERMANENT health-check agent. Run forever.
  Step 1: Check all registered services.
  Step 2: Report status. If any are unhealthy, attempt remediation.
  Step 3: Call wait(60) to sleep for 60 seconds.
  Step 4: Repeat from step 1.
  CRITICAL: Always end every turn by calling wait.
---

# Health Checker Agent

You monitor the health of registered services and take
corrective action when issues are detected.

## Monitoring Loop
1. Call check_service_health for each service.
2. If all healthy: report concise status, call wait(60).
3. If unhealthy:
   a. Attempt restart_service.
   b. Wait 30s, re-check.
   c. If still unhealthy after 3 attempts, call send_alert.
4. Continue loop.

## Rules
- Use the wait tool for ALL delays. Never use bash sleep.
- Be concise -- counts and short IDs only.
- Never restart a service more than 3 times in 10 minutes.
```

The YAML frontmatter controls **what the agent is**. The markdown body controls **how the agent behaves** (it becomes the LLM's system prompt).

### Step 2: Define Custom Tools

Tools are JavaScript/TypeScript functions registered on the worker:

```typescript
import { defineTool } from "@github/copilot-sdk";

const checkServiceHealth = defineTool("check_service_health", {
    description: "Check the health of a named service",
    parameters: {
        type: "object",
        properties: {
            service: { type: "string", description: "Service name (e.g., 'api-gateway')" },
        },
        required: ["service"],
    },
    handler: async ({ service }) => {
        // Hit your actual health endpoint
        const resp = await fetch(`https://${service}.internal/health`);
        return JSON.stringify({
            service,
            status: resp.ok ? "healthy" : "unhealthy",
            statusCode: resp.status,
            latencyMs: resp.headers.get("x-response-time"),
        });
    },
});

const restartService = defineTool("restart_service", {
    description: "Restart a service by triggering a rolling restart in Kubernetes",
    parameters: {
        type: "object",
        properties: {
            service: { type: "string" },
            reason: { type: "string" },
        },
        required: ["service", "reason"],
    },
    handler: async ({ service, reason }) => {
        // Use the Kubernetes API client (not shell commands) for safety.
        // Example using @kubernetes/client-node:
        //   const k8s = require("@kubernetes/client-node");
        //   const kc = new k8s.KubeConfig(); kc.loadFromDefault();
        //   const appsApi = kc.makeApiClient(k8s.AppsV1Api);
        //   // Patch the deployment to trigger a rollout restart
        //   await appsApi.patchNamespacedDeployment(service, "production", ...);
        // Alternatively, use execFile (not exec) to avoid shell injection:
        //   const { execFileSync } = require("child_process");
        //   execFileSync("kubectl", ["rollout", "restart", `deployment/${service}`, "-n", "production"]);
        return JSON.stringify({ success: true, service, action: "rolling-restart", reason });
    },
});

// Register on the worker
worker.registerTools([checkServiceHealth, restartService]);
```

### Step 3: Register in a Plugin Directory

```
my-monitoring-plugin/
  plugin.json                    # { "name": "monitoring" }
  agents/
    health-checker.agent.md      # System agent (runs forever)
    incident-responder.agent.md  # User-invocable agent
    log-analyzer.agent.md        # User-invocable agent
  skills/
    runbook-knowledge/
      SKILL.md                   # Injects runbook knowledge into all sessions
  .mcp.json                      # External tool servers (Datadog, PagerDuty, etc.)
  session-policy.json            # Access control
```

### Step 4: Wire into the Worker

```typescript
const worker = new PilotSwarmWorker({
    pluginDirs: ["./my-monitoring-plugin"],
    // ... database, blob storage, etc.
});

worker.registerTools([checkServiceHealth, restartService, sendAlert]);
await worker.start();
// System agents auto-start. health-checker begins its monitoring loop.
```

### Plugin Loading Order

The worker loads plugins in tiers:

1. **Tier 1 (SDK System)** — `plugins/system/` — base system message, durable timer skills (always loaded)
2. **Tier 2 (SDK Management)** — `plugins/mgmt/` — sweeper, resource manager (optional)
3. **Tier 3 (App Plugins)** — your `pluginDirs` entries
4. **Tier 4 (Direct Config)** — inline `customAgents`, `skillDirectories`, `mcpServers`

---

## 4. Agent Execution Model

### The Turn Loop

Every agent session runs inside a **durable generator function** — a state machine that survives crashes:

```
while (true) {
    1. Wait for next prompt (user message, timer wake, child update)
    2. Hydrate session if needed (restore from blob storage)
    3. Run LLM turn via CopilotSession
       - LLM sees: system prompt + conversation history + available tools
       - LLM may call tools (bash, APIs, spawn_agent, wait, etc.)
       - Copilot SDK handles tool call loop internally
    4. Handle turn result:
       - "completed" -> go idle, wait for next message
       - "wait" -> schedule durable timer, optionally dehydrate
       - "input_required" -> park and wait for user response
       - "spawn_agent" -> create child session
       - "error" -> retry with exponential backoff (max 3)
    5. continueAsNew -> checkpoint state, prevent history bloat
}
```

### System Tools (Auto-Injected)

Every agent automatically gets these tools:

| Tool | Purpose |
|---|---|
| `wait(seconds, reason)` | Durable timer — survives process restarts |
| `ask_user(question, choices)` | Request user input |
| `spawn_agent(task, agent_name?, model?)` | Create a child agent |
| `message_agent(agent_id, message)` | Send message to child |
| `check_agents()` | Poll all sub-agent statuses |
| `wait_for_agents(agent_ids)` | Block until children complete |
| `complete_agent(agent_id)` | Gracefully terminate child |
| `cancel_agent(agent_id)` | Force-terminate child |
| `list_sessions()` | List all sessions |
| `list_available_models()` | Show available LLM models |

### Turn Result Types

The orchestration handles these results from each LLM turn:

```typescript
type TurnResult =
    | { type: "completed"; content: string }
    | { type: "wait"; seconds: number; reason: string }
    | { type: "input_required"; question: string; choices?: string[] }
    | { type: "spawn_agent"; task: string; model?: string; ... }
    | { type: "message_agent"; agentId: string; message: string }
    | { type: "check_agents" }
    | { type: "wait_for_agents"; agentIds?: string[] }
    | { type: "error"; message: string }
```

### Multi-Action Handling

If the LLM emits multiple tool calls requiring orchestration-level handling (e.g., spawn two agents in one turn), they are queued and replayed sequentially:

```typescript
if ("queuedActions" in result && Array.isArray(result.queuedActions)) {
    pendingToolActions.push(...result.queuedActions);
    // Next iteration replays these without a new LLM call
}
```

---

## 5. Durability & Crash Recovery

This is the core differentiator that makes PilotSwarm viable for production monitoring.

### How State Survives Crashes

All agent state is captured in a serializable `OrchestrationInput` struct:

```typescript
interface OrchestrationInput {
    sessionId: string;
    config: SerializableSessionConfig;  // No functions -- only strings/arrays
    iteration: number;                  // Turn counter
    subAgents: SubAgentEntry[];         // Tracked child agents
    retryCount: number;                 // Consecutive failures
    taskContext: string;                // Original task (survives truncation)
    needsHydration: boolean;            // Restore from blob on next turn
    affinityKey: string;               // Worker pinning
    // ... timers, thresholds, checkpoints
}
```

This struct travels through duroxide's PostgreSQL-backed persistence. If the worker process dies mid-turn:

1. **Duroxide replays** the generator from the last `continueAsNew` checkpoint
2. **Session rehydrates** from Azure Blob Storage (conversation history)
3. **Agent resumes** with a system message: `"The session was dehydrated and has been rehydrated on a new worker."`
4. **Timers survive** — a `wait(3600)` scheduled before crash fires on schedule

### Retry Logic

If an LLM turn fails (network error, timeout, rate limit):

- **Attempt 1**: Retry after 15s
- **Attempt 2**: Retry after 30s
- **Attempt 3**: Retry after 60s
- **After 3 failures**: Park in `error` state, wait for next message (agent doesn't die)

### Dehydration Triggers

| Trigger | Threshold | What Happens |
|---|---|---|
| Long wait | >=30s (configurable) | Blob upload, release worker affinity, timer in PostgreSQL |
| Idle timeout | 30s after turn completion | Blob upload, release worker, rehydrate on next message |
| Input grace period | Configurable | If waiting for user input too long, dehydrate |

### Worker Migration

When a session dehydrates, it gets a new `affinityKey` (random GUID). Any available worker can pick it up. This enables:
- **Rolling deployments** — sessions migrate to new pods automatically
- **Auto-scaling** — sessions spread across available workers
- **Failure recovery** — crashed worker's sessions picked up by survivors

---

## 6. Multi-Agent Orchestration

### Spawning Sub-Agents

Any agent can spawn children (up to 3 levels: root -> child -> grandchild):

```
Parent Agent
  |-- spawn_agent("Monitor database replication lag") -> Child 1
  |-- spawn_agent(agent_name: "log-analyzer") -> Child 2 (named agent)
  +-- spawn_agent("Check SSL certificate expiry") -> Child 3
```

Limits:
- **Max nesting**: 2 levels deep (root=0, child=1, grandchild=2)
- **Max concurrent**: 20 sub-agents per parent

### Parent-Child Communication

Children communicate with parents via a durable message queue:

```
Child completes -> sends [CHILD_UPDATE from=<id> type=completed]
                   with result content to parent's "messages" queue

Parent receives -> updates subAgents[].status and .result
                -> can use result in next LLM turn
```

### Coordination Patterns

**Fan-out/fan-in**: Parent spawns N children, each handles one subsystem, parent waits for all:

```
Parent: spawn_agent("Check API servers")
Parent: spawn_agent("Check databases")
Parent: spawn_agent("Check message queues")
Parent: wait_for_agents()  // blocks until all 3 complete
Parent: Aggregate results and decide on action
```

**Supervisor pattern**: System agent spawns child monitors:

```
Supervisor (system: true, runs forever)
  |-- Sweeper child (system: true, runs forever)
  |-- ResourceManager child (system: true, runs forever)
  +-- On-demand children (spawned for investigations, auto-terminate)
```

This is exactly how the built-in `pilotswarm` system agent works — it spawns `sweeper` and `resourcemgr` as permanent children.

---

## 7. Applying PilotSwarm to Monitoring & Self-Healing

PilotSwarm already has two built-in monitoring agents that demonstrate the pattern:

### Existing: Resource Manager Agent

**File**: `packages/sdk/plugins/mgmt/agents/resourcemgr.agent.md`

- Runs every 5 minutes (`wait(300)`)
- Monitors: compute (K8s pods), storage (blobs), database (row counts), runtime (sessions)
- Detects anomalies (pod restarts > 5, orphan blobs > 10, stuck sessions, etc.)
- Auto-cleans: purges old events, orphaned blobs, vacuums database
- Writes markdown reports via artifact tools

### Existing: Sweeper Agent

**File**: `packages/sdk/plugins/mgmt/agents/sweeper.agent.md`

- Runs every 60 seconds (`wait(60)`)
- Scans for stale/completed sessions
- Cleans up sessions, prunes orchestration history
- Self-healing: prevents resource accumulation

### How This Maps to Your Systems

The same pattern — **monitor -> detect -> remediate -> wait -> repeat** — can be applied to any infrastructure:

| Your System | Monitoring Agent Would... |
|---|---|
| **API services** | Poll health endpoints, check latency P99, restart unhealthy pods |
| **Databases** | Check replication lag, connection pool usage, slow query logs, trigger failover |
| **Message queues** | Monitor queue depth, consumer lag, dead letter queues, scale consumers |
| **Kubernetes clusters** | Watch pod status, node pressure, resource quotas, eviction events |
| **CI/CD pipelines** | Monitor build failures, flaky tests, deployment rollbacks |
| **SSL/TLS certificates** | Track expiry dates, trigger renewal workflows |
| **Cloud costs** | Monitor spend anomalies, unused resources, right-sizing opportunities |
| **Log aggregation** | Pattern-match error spikes, correlate across services, trigger alerts |

### Why LLM-Powered Monitoring Is Different

Traditional monitoring (Datadog, Prometheus) works on **predefined rules**. PilotSwarm agents add:

1. **Reasoning about context** — An LLM can correlate signals across services ("API latency spiked right after the database migration — these are likely related")
2. **Adaptive remediation** — Instead of fixed runbooks, the agent can reason about which action to take based on the specific failure mode
3. **Natural language reporting** — Status reports are human-readable summaries, not dashboards you need to interpret
4. **Autonomous investigation** — When an anomaly is detected, the agent can spawn a child to investigate (read logs, check recent deployments, trace dependencies)
5. **Escalation with context** — When the agent can't fix something, it escalates with a full investigation summary, not just an alert

---

## 8. Architecture for a Monitoring/Self-Healing Deployment

### Proposed Agent Hierarchy

```
+-------------------------------------------------------------+
|  ops-supervisor (system agent, runs forever)                 |
|  - Top-level coordinator                                     |
|  - Spawns and manages all monitoring children                |
|  - Handles escalation and cross-system correlation           |
+-------------------------------------------------------------+
|                                                              |
|  +------------------+  +------------------+                  |
|  | service-monitor  |  | infra-monitor    |                  |
|  | (system, child)  |  | (system, child)  |                  |
|  |                  |  |                  |                  |
|  | - Health checks  |  | - K8s pod status |                  |
|  | - Latency track  |  | - Node health    |                  |
|  | - Auto-restart   |  | - Resource usage  |                  |
|  | - Circuit breaker|  | - Auto-scaling    |                  |
|  | - Every 60s      |  | - Every 5 min     |                  |
|  +------------------+  +------------------+                  |
|                                                              |
|  +------------------+  +------------------+                  |
|  | data-monitor     |  | security-monitor |                  |
|  | (system, child)  |  | (system, child)  |                  |
|  |                  |  |                  |                  |
|  | - DB replication |  | - Cert expiry    |                  |
|  | - Conn pools     |  | - Auth failures  |                  |
|  | - Slow queries   |  | - CVE scanning   |                  |
|  | - Failover       |  | - Compliance     |                  |
|  | - Every 2 min    |  | - Every 15 min   |                  |
|  +------------------+  +------------------+                  |
|                                                              |
|  On-demand children (spawned for investigations):            |
|  - incident-investigator -- root cause analysis              |
|  - log-analyzer -- deep log search for a specific issue      |
|  - deployment-checker -- verify a rollback completed         |
+-------------------------------------------------------------+
```

### Example: Service Health Monitor Agent

```markdown
---
name: service-monitor
description: Monitors service health endpoints and performs auto-remediation.
system: true
id: service-monitor
parent: ops-supervisor
title: Service Health Monitor
tools:
  - check_service_health
  - restart_service
  - scale_service
  - send_alert
  - query_logs
  - wait
  - bash
  - spawn_agent
initialPrompt: >
  You are a PERMANENT service health monitor. Run forever.
  Services to monitor: api-gateway, user-service, payment-service,
  notification-service, search-service.
  Step 1: Check all services.
  Step 2: If any unhealthy, attempt remediation per the rules below.
  Step 3: Call wait(60).
  Step 4: Repeat.
  CRITICAL: Always end every turn by calling wait.
---

# Service Health Monitor

You continuously monitor service health and take corrective action.

## Monitoring Loop
1. Call check_service_health for each registered service.
2. For healthy services: no output needed.
3. For unhealthy services, follow the Remediation Ladder.

## Remediation Ladder
For each unhealthy service, escalate through these steps:

### Level 1: Verify (immediate)
- Re-check after 10 seconds to rule out transient failure.
- If it recovers, log and continue.

### Level 2: Restart (after 2 consecutive failures)
- Call restart_service with reason.
- Wait 30s, re-check.
- If recovered, log and continue.

### Level 3: Scale (after restart fails)
- Call scale_service to add replicas.
- Wait 60s, re-check.

### Level 4: Investigate (after scale fails)
- Spawn a child agent: spawn_agent("Investigate why {service} is
  failing. Check recent deployments, error logs, and dependencies.")
- Wait for child to report back.

### Level 5: Escalate (after investigation)
- Call send_alert with full context from investigation.
- Include: what failed, what was tried, investigation findings.

## Rules
- Never restart the same service more than 3 times in 10 minutes.
- Never scale beyond 2x the normal replica count.
- Always use wait for delays. Never bash sleep.
- Track failure counts across iterations (mention them in your responses
  so they survive in conversation history).
- Be concise in normal operation. Verbose only during incidents.
```

### Example: Custom Tools for Your Systems

```typescript
// Tools that connect to YOUR infrastructure
const checkServiceHealth = defineTool("check_service_health", {
    description: "Check health of a named service via its /health endpoint",
    parameters: {
        type: "object",
        properties: {
            service: { type: "string", description: "Service name" },
        },
        required: ["service"],
    },
    handler: async ({ service }) => {
        const endpoints = {
            "api-gateway": "https://api.internal/health",
            "user-service": "https://users.internal/health",
            "payment-service": "https://payments.internal/health",
            // ... your services
        };
        const url = endpoints[service];
        if (!url) return JSON.stringify({ error: `Unknown service: ${service}` });

        try {
            const start = Date.now();
            const resp = await fetch(url, { signal: AbortSignal.timeout(5000) });
            const latency = Date.now() - start;
            const body = await resp.json().catch(() => ({}));
            return JSON.stringify({
                service, status: resp.ok ? "healthy" : "unhealthy",
                statusCode: resp.status, latencyMs: latency,
                details: body,
            });
        } catch (e) {
            return JSON.stringify({
                service, status: "unreachable", error: e.message,
            });
        }
    },
});

const restartService = defineTool("restart_service", {
    description: "Restart a service by triggering a rolling restart in Kubernetes",
    parameters: {
        type: "object",
        properties: {
            service: { type: "string" },
            reason: { type: "string" },
        },
        required: ["service", "reason"],
    },
    handler: async ({ service, reason }) => {
        // IMPORTANT: Use the Kubernetes Node.js client or execFile (not exec)
        // to avoid shell injection vulnerabilities.
        //
        // Option A — Kubernetes client library (@kubernetes/client-node):
        //   const k8s = require("@kubernetes/client-node");
        //   const kc = new k8s.KubeConfig(); kc.loadFromDefault();
        //   const appsApi = kc.makeApiClient(k8s.AppsV1Api);
        //   await appsApi.patchNamespacedDeployment(service, "production", ...);
        //
        // Option B — execFile (safe, no shell interpolation):
        //   const { execFileSync } = require("child_process");
        //   execFileSync("kubectl", ["rollout", "restart", `deployment/${service}`, "-n", "production"]);
        //
        return JSON.stringify({ success: true, service, action: "rolling-restart", reason });
    },
});

const sendAlert = defineTool("send_alert", {
    description: "Send an alert to the on-call team via PagerDuty/Slack",
    parameters: {
        type: "object",
        properties: {
            severity: { type: "string", enum: ["info", "warning", "critical"] },
            title: { type: "string" },
            summary: { type: "string" },
            service: { type: "string" },
        },
        required: ["severity", "title", "summary"],
    },
    handler: async ({ severity, title, summary, service }) => {
        // Hit your alerting API (PagerDuty, Slack, OpsGenie, etc.)
        // Use environment variables for webhook URLs — never hardcode secrets.
        const webhookUrl = process.env.SLACK_ALERT_WEBHOOK;
        await fetch(webhookUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                text: `[${severity.toUpperCase()}] ${title}\n${summary}\nService: ${service}`,
            }),
        });
        return JSON.stringify({ sent: true, severity, title });
    },
});
```

### Connecting to External Systems via MCP

For complex integrations (Datadog, PagerDuty, AWS, etc.), use MCP servers instead of custom tools:

```json
// my-monitoring-plugin/.mcp.json
{
    "datadog": {
        "type": "http",
        "url": "https://datadog-mcp.internal/mcp",
        "tools": ["query_metrics", "get_monitors", "create_monitor", "mute_monitor"]
    },
    "pagerduty": {
        "type": "http",
        "url": "https://pagerduty-mcp.internal/mcp",
        "tools": ["create_incident", "acknowledge_incident", "get_oncall"]
    },
    "aws": {
        "command": "node",
        "args": ["aws-mcp-server.js"],
        "tools": ["*"],
        "env": {
            "AWS_REGION": "${AWS_REGION}",
            "AWS_ACCESS_KEY_ID": "${AWS_ACCESS_KEY_ID}",
            "AWS_SECRET_ACCESS_KEY": "${AWS_SECRET_ACCESS_KEY}"
        }
    }
}
```

This gives agents access to your observability stack without writing custom tool code.

---

## 9. Gaps & Considerations

### What PilotSwarm Handles Well

- **Long-running monitoring loops** — durable timers survive restarts
- **Crash recovery** — agents resume automatically
- **Multi-agent coordination** — parent can manage specialized children
- **Flexible remediation** — LLM reasons about which action to take
- **Context-rich escalation** — investigation results travel with alerts
- **Worker migration** — sessions move between pods during deploys

### What to Watch Out For

| Concern | Details | Mitigation |
|---|---|---|
| **LLM latency** | Each monitoring "tick" requires an LLM call (~2-10s). Not suitable for sub-second alerting. | Use PilotSwarm for intelligent triage/remediation, keep Prometheus/Datadog for real-time alerting |
| **LLM cost** | Every monitoring cycle burns tokens. A 60s loop with 5 services = ~1,440 LLM calls/day per agent. | Use cheaper models (GPT-4o-mini) for routine checks, expensive models only for investigation |
| **Hallucination risk** | LLM might misinterpret metrics or take wrong remediation action. | Constrain tools with guardrails (e.g., max restart count, scale limits). Use confirmation for destructive actions. |
| **State in conversation** | Agent "memory" is its conversation history, which gets truncated over time. | Use `taskContext` field to preserve the core mission. Store counters externally if needed. |
| **Provider dependency** | Currently requires GitHub Copilot SDK. Supports GitHub Copilot, Azure OpenAI, OpenAI, and Anthropic providers. | Additional providers would require extending the model provider registry. |
| **Single-region blob** | Session state in Azure Blob Storage — single region. | Acceptable for monitoring agents. Use multi-region for critical self-healing. |
| **Tool failure modes** | If a remediation tool (restart, scale) fails, the agent retries the LLM turn, not the tool. | Build retry logic into tool handlers themselves. |

### Model Selection for Monitoring

| Use Case | Recommended Model | Reason |
|---|---|---|
| Routine health checks | GPT-4o-mini | Low cost, fast, sufficient for structured checks |
| Anomaly analysis | GPT-4o, Claude Sonnet | Better reasoning for correlation |
| Incident investigation | Claude Opus, GPT-4.1 | Deep reasoning for root cause analysis |
| Report generation | Claude Sonnet | Good structured output |

PilotSwarm supports per-agent model selection, so you can use cheap models for routine monitoring and escalate to expensive models for investigation children.

---

## 10. Recommendations

### Start Small

1. **Phase 1**: Deploy a single `service-monitor` agent for your most critical services. Give it `check_service_health` + `send_alert` (no auto-remediation yet). Run alongside existing monitoring.

2. **Phase 2**: Add remediation tools (`restart_service`, `scale_service`) with conservative limits. Let the agent handle Level 1-2 incidents automatically.

3. **Phase 3**: Add the supervisor pattern — `ops-supervisor` spawning specialized children for different subsystems. Add investigation agents that spawn on-demand.

4. **Phase 4**: Connect to your observability stack via MCP (Datadog, CloudWatch, etc.). Let agents correlate signals across systems.

### Key Design Principles

- **Tools are your guardrails** — The agent can only do what its tools allow. Limit blast radius by limiting tool capabilities.
- **System agents for steady-state monitoring**, user-invocable agents for ad-hoc investigation.
- **Use the remediation ladder** — Verify -> restart -> scale -> investigate -> escalate. Never jump to destructive actions.
- **Cheap models for checks, expensive models for thinking.** Use `model` override in `spawn_agent` to route investigation children to stronger models.
- **Conversation history is memory** — Design agent prompts so the LLM tracks state in its responses (failure counts, last actions taken). Use `taskContext` for the mission statement that must survive history truncation.

### What You'd Need to Build

| Component | Effort | Notes |
|---|---|---|
| Agent `.md` files | Low | Define agents per system you want to monitor |
| Custom tools | Medium | `check_*`, `restart_*`, `scale_*`, `alert_*` for your infra |
| MCP servers | Medium-High | Bridges to Datadog, PagerDuty, AWS, etc. |
| Plugin directory | Low | Just directory structure + `plugin.json` |
| Worker deployment | Already exists | PilotSwarm worker runs your agents |

---

## Appendix: LLM Provider Support

PilotSwarm currently supports four provider types via `.model_providers.json`:

| Provider | Type | Status |
|---|---|---|
| GitHub Copilot | `github` | Native support |
| Azure OpenAI | `azure` | Native support |
| OpenAI | `openai` | Native support |
| Anthropic | `anthropic` | Native support |
