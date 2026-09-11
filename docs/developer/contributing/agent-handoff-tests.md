# Parent-to-child handoff regression coverage

Run from the repository root after installing dependencies and configuring the
local integration-test `.env`:

```sh
npm run test:agent-handoff
```

The command builds the SDK and its local dependencies, runs all SDK unit tests,
then runs the focused handoff and provider suites. PostgreSQL must be local and
disposable. `PS_TEST_DATABASE_URL` should point to that local database. Tests use
randomized schemas and remove only those schemas. The live sub-agent and
cross-replica suites also require `GITHUB_TOKEN`; the scripted provider and
routing tests do not call an external model. Never point this command at a
production store.

## Contract under test

| Child request | Instructions and tools | First required call |
| --- | --- | --- |
| `agent_name` | Selected definition, framework/app defaults, assignment and child context; no inherited parent persona or specialist tools | Definition's `initialRequiredTool`, if any |
| `required_tool` | Unique visible creatable owning agent's complete definition | Definition's startup requirement, which may differ from `required_tool` |
| Both selectors | Named agent must declare the requested capability | Definition's startup requirement |
| Unnamed `task` | Ordinary inherited/default tools; inherited package handlers dropped | No invented startup requirement |
| Unnamed with `tool_names` | Requested ordinary tools plus defaults; explicitly detached package tools rejected | No invented startup requirement |

`task` may provide a bounded assignment for a named child. Named definitions with
omitted, null or empty `tools` add no specialist tools. Explicit `tool_names` or
`system_message` overrides on named spawns are rejected even when empty.

## Test layers

- **`parent-child-handoff.test.js`: 86 scenarios.** Runs both production spawn
  paths: the live orchestration generator and the inline control bridge. Starts
  the resulting child through the actual SessionManager, ManagedSession and
  Copilot SDK/CLI against a scripted localhost inference endpoint. Checks the
  actual provider prompt, tool declarations, handler results and startup gate.
  Only parent action selection and durable client persistence/enqueue are
  injected. Includes shared/private/deployment copies, aliases without IDs,
  ownerless and ancestor ownership, missing/ambiguous/forbidden agents, empty
  override rejection, defaults, model propagation, mobile metadata and parent
  persona isolation, and explicit/omitted child contracts. No language-model
  judgment is needed to select a case.
- **`session-agent-binding-lifecycle.test.mjs`: 32 scenarios.** Exercises warm
  reuse, hydration, copy pins, deletion/re-enable, role visibility, handler
  refresh, declarations and permission/schema changes, MCP replacement and
  cleanup. Tests use SDK handle doubles to observe lifecycle transitions.
- **`agent-binding-refresh-runtime.test.js`: 3 scenarios.** Real SDK/CLI requests
  and handler execution across republish, handle reuse/resume, removal and
  re-enable. A queued startup requirement remains the original contract. If
  its tool disappears, the child fails before inference; if retained, the child
  invokes it even when the new definition names another startup tool.
- **`agent-handoff-routing.test.js`: 4 scenarios.** Actual Duroxide/PostgreSQL
  queues verify capability routing under competing old workers, pending work
  when no capable worker exists, session-affinity takeover after lease expiry,
  and frozen replay without duplicate spawning. No model calls.
- **`bound-agent-backfill.test.js`: 5 scenarios.** Two independent clients share
  real PostgreSQL. Creation on A and first message on B must preserve named
  bindings, custom instructions and tool settings. The child case reads the
  durable first-turn history to verify the deployment pin, child contract,
  parent and nesting depth survived transport. Uses the live GitHub provider.
- **`client-lineage-restoration.test.mjs`: 15 scenarios.** First-start transport
  checks cover children, grandchildren, roots, explicit depth, missing ancestors,
  cycles and bounded traversal. Invalid lineage must fail before enqueue;
  already-active sessions do not repeat the traversal on each message.
- **Reserved-name tests.** Compare the reserved set with real platform tool
  factories and the actual CLI catalog. Load a conflicting package through the
  worker and verify both its prompt and handlers are quarantined while a
  neighboring valid package still executes.
- **Top-level and existing sub-agent suites.** Preserve top-level tool override
  compatibility, required-startup behavior, system ownership, nested and
  duplicate named spawns, parent/child messaging, keep-alive, model inheritance,
  and session metadata. Live sub-agent tests also exercise model-selected
  delegation and the complete durable worker path.
- **`copilot-provider-compatibility.test.js`.** Actual SDK/CLI with synthetic
  OpenAI, Azure, OpenAI proxy, Anthropic and Anthropic WIF endpoints, including
  streaming, tools and resume. This validates protocol handling, not current
  availability or credentials of those external providers.

The frozen-source and serialized-descriptor unit checks separately ensure that
the new 1.0.75 behavior does not rewrite older orchestration histories.

## Deployment boundary

Passing tests does not make an overlapping rollout with incompatible workers
safe. Follow the [drain-first upgrade sequence](../building/agent-handoff-upgrade.md).
No database migration is needed: `boundAgentSource: "deployment"` is an optional
field in existing serialized session configuration. An omitted field retains
legacy owner-based selection; a selected package continues to use its package ID.
