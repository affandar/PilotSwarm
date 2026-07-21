````skill
---
name: sub-agents
description: Expert knowledge on spawning and managing autonomous sub-agents for parallel task delegation.
---

# Sub-Agent Delegation

You can spawn autonomous sub-agents to work on tasks in parallel. Each sub-agent is a full Copilot session with its own conversation, tools, and context — running as an independent durable orchestration.

## When to Spawn Sub-Agents

- **Parallel research**: Gather information from multiple sources simultaneously
- **Divide and conquer**: Break complex tasks into independent subtasks
- **Background processing**: Start a long-running task while you continue helping the user
- **Specialized work**: Delegate domain-specific subtasks with custom system messages

## Tools

### `spawn_agent(task, [model], [system_message], [tool_names], [contract])`
Start a new sub-agent with a task description. Returns an agent ID. `contract` is a named argument on `spawn_agent`; there is no separate contract tool or separate signature.
- **task** (required): Clear description of what the agent should do — this becomes its first prompt
- **model** (optional): Exact `provider:model` override from `list_available_models()`
- **system_message** (optional): Custom system message for specialization
- **tool_names** (optional): Specific tools to give the agent; defaults to your tools
- **contract** (optional): Structured contract for expected outputs and parent wake policy. Use `wakeOn: "any"`, `"material_change"`, or `"completion"` to control autonomous parent wake-ups. Every finite delegation whose result the parent needs uses `"material_change"`; `"completion"` is only for actual terminal lifecycle outcomes. A compact shape is `{ "purpose": "...", "successCriteria": ["..."], "expectedFacts": [{ "key": "result/...", "required": true }], "expectedArtifacts": [], "validationMode": "warn", "wakeOn": "material_change" }`.

### `message_agent(agent_id, message, [contract_patch])`
Send additional instructions or context to a running sub-agent.
- Use this whenever you need to ask a sub-agent a follow-up question, refine its scope, correct it, or request a status update.
- Use `contract_patch: { wakeOn: "..." }` to make a child temporarily chattier (`any`) or quieter (`material_change` / `completion`).
- Do not claim you cannot ask your sub-agents questions. That is exactly what `message_agent` is for.

### `check_agents()`
Get the current status of ALL sub-agents — running, completed, or failed — with their latest output.
This is an on-demand snapshot, not a scheduling primitive. Qualifying child updates wake the parent according to `contract.wakeOn`.

### `wait_for_agents([agent_ids])`
Block until sub-agents finish. Returns their final results.
- If **agent_ids** is omitted, waits for ALL running agents.
- If specified, waits only for those specific agents.

## Patterns

### Fan-Out / Fan-In
```
1. spawn_agent("Research topic A")    → agentA
2. spawn_agent("Research topic B")    → agentB
3. spawn_agent("Research topic C")    → agentC
4. wait_for_agents()                  → collect all results
5. Synthesize the combined findings
```

### Background Worker
```
1. spawn_agent("Monitor X every 60 seconds", contract={ "wakeOn": "material_change" }) → agent
2. Continue handling user requests normally
3. React when the child reports a material change; check status on demand
```

### Durable Recurring Worker
```
1. spawn_agent("Monitor X every 30 seconds forever using durable waits until cancelled") → agent
2. Tell the user the recurring worker is active now
3. Optionally use message_agent(agent, "Also track Y") later to refine the task
4. Use check_agents() or wait_for_agents() only when you need status or results
```

### Specialized Delegation
```
1. spawn_agent("Analyze the data", system_message="You are a data analyst")
2. spawn_agent("Write the report", system_message="You are a technical writer")
3. wait_for_agents() → combine results
```

### Delegation With A Contract
```
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

## Rules

- **Maximum 20 concurrent sub-agents** — wait for some to complete before spawning more
- Sub-agents inherit your tools and model by default
- If you want a different model, call `list_available_models()` first and use only an exact `provider:model` value from that list
- Never invent, guess, shorten, or reuse stale model names
- Sub-agents are fully durable — they survive crashes and restarts
- A sub-agent can run an indefinite recurring loop by doing work, then calling `wait`, then repeating on its own
- Do not say a recurring sub-agent needs another user prompt, a cron job, or a manual nudge for the next cycle
- Parent coordination is reactive. Qualifying child updates wake you automatically according to `contract.wakeOn`.
- Every finite delegation whose result the parent needs MUST use `contract.wakeOn: "material_change"`. A child's ordinary final reply leaves it alive and idle, so it is a material update rather than terminal completion. Validate its outputs, then close it explicitly with `complete_agent`.
- Do not schedule `wait` or `cron` solely to poll `check_agents`; use a parent timer only for an independent deadline, retry, or external check.
- You can send a running sub-agent new instructions with `message_agent` at any time
- Sub-agents can use `wait` for durable timers but cannot spawn their own sub-agents (single level)
- Use `check_agents` after autonomous child wake-ups or explicit status requests; use `wait_for_agents` only for an explicit synchronization barrier
- Keep task descriptions clear and self-contained — the agent has no access to your conversation history
- Sub-agents run on potentially different worker nodes — they cannot share in-memory state
- If the user explicitly asks you to use sub-agents, delegation, fan-out, or parallel processing, do it within runtime limits instead of silently collapsing the task into a single-agent answer
- If the user did not explicitly ask for delegation, you may decide whether sub-agents are actually useful
- For chatty work where every update matters, set `contract.wakeOn` to `"any"`
- For finite delegated work, set `contract.wakeOn` to `"material_change"`, consume and validate the result, then call `complete_agent`
- For long-running watcher children, use `contract.wakeOn: "material_change"` so no-op heartbeats do not spend parent LLM turns
- Use `contract.wakeOn: "completion"` only when another actor or lifecycle path will explicitly complete, cancel, fail, or block the child; an ordinary final reply does not qualify

````
