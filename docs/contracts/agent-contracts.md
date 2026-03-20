# Agent Contracts

These are the behavior contracts that should stay aligned across prompts, tool descriptions, runtime validation, tests, and docs.

When any of these change, update all five layers together.

## 1. `default.agent.md` Is The Base Prompt

Contract:

- `default.agent.md` is not a selectable agent
- its markdown body becomes the always-on base system prompt for all sessions on the worker
- it still applies when a session or agent provides a prompt overlay

Why it matters:

- app-wide rules like `wait`, artifact handling, or sub-agent behavior belong here
- users should not have to rediscover those rules in each agent file

## 2. Named Agents And `agent_name`

Contract:

- if an agent is already known by name, spawn it with `spawn_agent(agent_name="...")`
- use `task=` only for ad hoc custom agents
- known system agents like `sweeper` and `resourcemgr` should not be created via `task="..."`

Why it matters:

- named agents carry canonical metadata
- system-agent titles and IDs depend on that named-agent path
- generic `task=` spawns can lose `agentId`, `title`, and expected behavior

## 3. Tools Live On The Worker

Contract:

- agent files and sessions reference tool names
- worker code registers the actual tool handlers
- clients never own the real tool handlers

Why it matters:

- this is the core client/worker serialization boundary
- remote mode only works if workers own the executable tool code

## 4. Agent `tools` Are Filters, Not Implementations

Contract:

- `tools` in `.agent.md` or inline agent config only limit what the agent may use
- they do not automatically create or register the tool

Why it matters:

- listing a tool name in a prompt file without registering it on the worker should not be treated as sufficient

## 5. Sub-Agent Model Selection Must Be Exact

Contract:

- `list_available_models` is the source of truth
- if a sub-agent should use a different model, the caller must use an exact returned `provider:model` value
- prompts and runtime validation should reject guessed or shortened names

Why it matters:

- available models can differ across environments and deployments
- prompt-only model recall is not reliable enough

## 6. Prompt-Only Rules Need Runtime Backstops

Contract:

- if a rule must always hold, do not rely only on prompt text
- add runtime validation or normalization for critical cases

Examples:

- normalize mistaken named-agent spawns where safe

## 7. Long Waits May Migrate Unless Affinity Is Preserved

Contract:

- long durable waits may resume on a different worker
- if an agent is waiting on worker-local state, it must call `wait(..., preserveWorkerAffinity: true)`
- prompts, tool descriptions, and tests should all describe this consistently

Why it matters:

- node-local work is the main exception to the usual "durable waits can resume anywhere" model
- the LLM needs an explicit, reliable way to opt into preserving worker affinity
- reject invalid sub-agent model overrides
- preserve orchestration behavior even if prompt wording drifts

## 7. Artifact Rules Should Be Visible And Durable

Contract:

- if an agent creates a file users should retrieve, it should write the artifact and export it
- prompts can instruct this, but runtime and UI paths should also assume artifact links are part of the product surface

Why it matters:

- artifact links are how durable outputs move back to the user
- losing the export step produces confusing “the file exists somewhere” behavior

## 8. Change Procedure

If you change one of these contracts, update:

1. prompt or agent/skill file
2. tool descriptions or schemas
3. runtime behavior
4. tests
5. docs

Good companion docs:

- [Working On PilotSwarm](../contributors/working-on-pilotswarm.md)
- [Building Agents For SDK Apps](../sdk/building-agents.md)
- [Building Agents For CLI Apps](../cli/building-agents.md)
