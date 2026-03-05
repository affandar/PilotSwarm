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

### `spawn_agent(task, [system_message], [tool_names])`
Start a new sub-agent with a task description. Returns an agent ID.
- **task** (required): Clear description of what the agent should do — this becomes its first prompt
- **system_message** (optional): Custom system message for specialization
- **tool_names** (optional): Specific tools to give the agent; defaults to your tools

### `message_agent(agent_id, message)`
Send additional instructions or context to a running sub-agent.

### `check_agents()`
Get the current status of ALL sub-agents — running, completed, or failed — with their latest output.

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
1. spawn_agent("Monitor X every 60 seconds")  → agent
2. Continue handling user requests normally
3. Periodically check_agents() to see updates
```

### Specialized Delegation
```
1. spawn_agent("Analyze the data", system_message="You are a data analyst")
2. spawn_agent("Write the report", system_message="You are a technical writer")
3. wait_for_agents() → combine results
```

## Rules

- **Maximum 20 concurrent sub-agents** — wait for some to complete before spawning more
- Sub-agents inherit your tools and model by default
- Sub-agents are fully durable — they survive crashes and restarts
- Sub-agents can use `wait` for durable timers but cannot spawn their own sub-agents (single level)
- Always call `check_agents` or `wait_for_agents` to collect results — don't ignore your agents
- Keep task descriptions clear and self-contained — the agent has no access to your conversation history
- Sub-agents run on potentially different worker nodes — they cannot share in-memory state

````
