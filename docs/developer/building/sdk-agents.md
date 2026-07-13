# Building Agents For SDK Apps

This is the canonical guide for building agents on PilotSwarm when you are using the SDK directly.

For a complete worked example, see [examples/devops-command-center](../../../examples/devops-command-center). It includes root and child system agents, named agents, skills, a session policy, and worker-side mock tools.

If you only remember one thing, remember this:

- prompts live in plugin files
- tool handlers live in worker code
- sessions only reference tool names

## The Recommended Path

Author agents in a plugin directory and load that directory from your worker.

```text
plugin/
├── agents/
│   ├── default.agent.md
│   ├── planner.agent.md
│   └── researcher.agent.md
├── skills/
│   └── web-research/
│       ├── SKILL.md
│       └── tools.json
└── .mcp.json
```

## Step 1: Create `default.agent.md`

`default.agent.md` is your app-wide overlay for every session on the worker. PilotSwarm layers it underneath the embedded framework base prompt.

This does not change your plugin file structure. You still author `default.agent.md`, named `*.agent.md` files, and `skills/**/SKILL.md` the same way. The runtime now maps those layers into the Copilot SDK's structured system-prompt sections instead of concatenating one large prompt blob.

```md
---
name: default
description: Base instructions for all sessions.
---

# My App Default Agent

You are a helpful assistant running in PilotSwarm.

Always use `write_artifact` when you create a file the user should download, and include the returned `artifact://` link in your response. Upload existing files (builds, archives, binaries) with `fromFile` instead of inline content.
If you need to wait or poll, use the `wait` tool rather than bash sleep. For long waits, assume the next turn may resume on a different worker unless you intentionally pass `preserveWorkerAffinity: true` for worker-local work.
Use `store_fact`, `read_facts`, and `delete_fact` for durable structured state rather than hiding important facts only in chat history. Treat facts as the authoritative memory layer for anything important.
```

Important behavior:

- the markdown body becomes the app-wide default layer for your sessions
- it is not a selectable agent
- it still applies even when another agent prompt is used
- it extends the embedded PilotSwarm framework instructions rather than replacing them

## Step 2: Add named agents

Named agents are the personas users invoke with `@name` or that other agents spawn by name.

```md
---
name: researcher
description: Researches topics and writes concise markdown summaries.
tools:
  - web_fetch
  - write_artifact
  - read_artifact
  - list_artifacts
---

# Researcher Agent

You gather information, summarize it clearly, and save substantial outputs as artifacts.
Prefer tables when comparing several results.
```

How it works:

- YAML frontmatter becomes runtime metadata
- the markdown body becomes the agent prompt
- `tools` limits the tools this agent may use

PilotSwarm includes built-in facts tools on workers, and every agent session gets them automatically, including system agents. You may still list them in frontmatter if you want the dependency to be obvious in the agent file:

```md
---
name: benchmark-analyst
description: Stores and compares benchmark findings.
tools:
  - read_facts
  - store_fact
  - delete_fact
---
```

Use facts for short structured memory, coordination state, baselines, checkpoints, and other data that should survive dehydration. Facts are session-scoped by default and are cleaned up automatically when the session is deleted. Set `shared=true` only for durable cross-session memory that should remain until explicitly deleted.

## Step 3: Register the tools on the worker

The worker must register any tool the agent is allowed to call.

```ts
import { PilotSwarmWorker, defineTool } from "pilotswarm-sdk";

const webFetch = defineTool("web_fetch", { /* ... */ });
const writeArtifact = defineTool("write_artifact", { /* ... */ });
const readArtifact = defineTool("read_artifact", { /* ... */ });

const worker = new PilotSwarmWorker({
  store: process.env.DATABASE_URL!,
  githubToken: process.env.GITHUB_TOKEN!,
  pluginDirs: ["./plugin"],
});

worker.registerTools([webFetch, writeArtifact, exportArtifact]);
await worker.start();
```

If the tool is not registered on the worker, listing it in an agent file is not enough.

## Binary Artifacts

Use the same `write_artifact` surface for both text and binary outputs.

- For text the agent is authoring, the inline `content` flow is unchanged.
- For files that already exist on the worker (builds, archives, any binary), pass `fromFile: "<path>"` — bytes stream server-side and never transit the model. Small binaries can still be written inline with `contentType` plus `encoding: "base64"`.
- To adopt another session's artifact, pass `fromArtifact: { sessionId, filename, expectedSha256? }` for a server-side copy.
- Every write returns `sha256` and the `artifact://` link — include the link in the agent's response for user-facing handoff.
- Consumers use `read_artifact` with `toFile` for large/binary artifacts, `metaOnly: true` to verify provenance, or bounded inline content for text.
- In the browser portal, non-text artifacts are download-only; they do not render inline as markdown previews.

This keeps builder-facing artifact workflows consistent across SDK, TUI, and portal hosts.

## Step 4: Optional skills

Skills are shared domain knowledge bundles.

```md
---
name: web-research
description: Research workflow guidance for browsing and summarizing sources.
---

When researching:

1. Start from primary sources when possible.
2. Record exact URLs.
3. Save long outputs as markdown artifacts.
```

Optional `tools.json` can declare the tools that skill expects:

```json
{
  "tools": ["web_fetch", "write_artifact", "read_artifact"]
}
```

Use skills when several agents should share the same operating guidance.

## Step 5: Optional system agents

System agents are long-lived background agents started or spawned by the runtime.

Example:

```md
---
name: sweeper
description: Cleans up old sessions.
system: true
id: sweeper
parent: pilotswarm
title: Sweeper Agent
initialPrompt: >
  You are now online. Start your cleanup loop and report summary status.
---

# Sweeper Agent

You clean up stale sessions and report cluster hygiene.
```

Use system agents only when you want durable background behavior. Most apps only need named agents.

`initialPrompt` for a system agent is bootstrap startup content. It is sent automatically when the session is created, but it should not be treated as an ordinary user-authored chat line in the CLI/TUI.

## Step 6: Create sessions that can use the agents

```ts
const session = await client.createSession({
  model: "github:claude-opus-4.6",
  toolNames: ["web_fetch", "write_artifact", "read_artifact"],
});

await session.sendAndWait("@researcher Find the top 5 announcements from this week and save them as a report.");
```

The worker supplies the actual agent definitions and tool handlers. The client only needs the serializable session config.

## Agent Contract You Should Build Against

### `default.agent.md`

- body becomes the app-wide default prompt layer
- not selectable
- not a tool filter
- should contain app-wide rules you always want
- is wrapped beneath the embedded PilotSwarm framework base prompt
- is applied through SDK prompt sections rather than raw string concatenation

### `*.agent.md`

- frontmatter declares metadata
- frontmatter should include `schemaVersion: 1` and a `version` string; new agents should usually start at `version: 1.0.0`
- body is the agent prompt
- `tools` is a filter, not a tool implementation

### Tools

- must be registered on the worker
- should have accurate descriptions and schemas
- should not rely on prompt text alone for critical correctness

### System-agent spawning

For known named agents, use `spawn_agent(agent_name="...")`.

Use `task=` only for truly ad hoc custom sub-agents. Do not use `task="sweeper"` or `task="resourcemgr"` for named system agents.

### Sub-agent models

If an agent wants to choose a different model for a sub-agent:

1. call `list_available_models`
2. use only an exact returned `provider:model` value
3. never guess or shorten the name

### Durable timers

Use `cron(seconds=N, reason="...")` for fixed recurring intervals and `cron_at(minute=M, hour=H, tz="Area/City", reason="...")` for wall-clock schedules. Do not build wall-clock jobs as wake-and-check polling loops. When a cron wake-up resumes an agent, it should perform the scheduled work described by the reason before responding.

### Child contracts

Use the named `contract` argument on `spawn_agent`; there is no separate contract tool. Include it only when required outputs or wake policy matter:

```text
spawn_agent(
  task="Scan market data and store the durable finding",
  contract={
    "purpose": "Market scan",
    "successCriteria": ["source-backed summary", "durable result fact"],
    "expectedFacts": [{ "key": "result/market-scan", "required": true }],
    "expectedArtifacts": [],
    "validationMode": "warn",
    "wakeOn": "material_change"
  }
)
```

Use `contract.wakeOn` when spawning long-running children: `any` for high-signal short-lived work, `material_change` for watchers, and `completion` when only terminal/blocked/error updates should wake the parent. Use `message_agent(..., contract_patch={ wakeOn: "..." })` to adjust the policy later.

### Cross-session request/response

Use `send_session_message(..., expects_response=true)` to ask another session for help. The target session must call `reply_session_message(request_id=..., session_id=<sender>, body=...)`; answering only in its own transcript does not deliver a response back to the sender.

Shared UI surfaces render cross-session requests and replies as dedicated transcript cards so both sender and receiver can see the durable request/response context.

## Common Mistakes

- Putting tool names in an agent file but never registering the tool handler
- Treating `default.agent.md` like a selectable agent
- Assuming the client can execute tools
- Using `task=` instead of `agent_name=` for known named agents
- Letting prompts carry critical correctness without runtime validation
- Treating a system agent's `initialPrompt` as user chat instead of startup/bootstrap behavior

## What To Read Next

- [Building SDK Apps](./sdk-apps.md)
- [Agent Contracts](../reference/agent-contracts.md)
- [Plugin Architecture & Layering Guide](./plugins.md)
