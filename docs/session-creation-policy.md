# Session Creation Policy

This document describes the session creation policy system for PilotSwarm.

## Summary of Decisions

- **No `sessionKind`** — keep `isSystem` as the only classification. Any named agent can be a parent or sub-agent.
- **No separate allowlist** — the allowed top-level agents ARE the non-system agents loaded from plugin dirs. The `.agent.md` frontmatter provides name, title, description, splash.
- **System agents are omitted** from the user-creatable agent list. They are auto-started, not user-created.
- **Agent namespacing** — every agent is qualified by source plugin (e.g. `pilotswarm:sweeper`, `smelter:supervisor`). Derived from `plugin.json` name or directory basename.
- **Dual enforcement** — policy is enforced at both the client (SDK) layer AND the orchestration (worker) layer.
- **Orchestration is the trust boundary** — the client is user-controlled, so client-side validation is UX convenience. The orchestration is the final guardrail.
- **Apps can add system agents** — app plugins can define `system: true` agents in `.agent.md` files.
- **Testing at all levels** — tests cover client rejection, orchestration rejection, and end-to-end flows.

## Policy File

Optional `session-policy.json` in any plugin root:

```text
plugin/
├── agents/
├── skills/
├── plugin.json
└── session-policy.json
```

### Shape

```json
{
  "version": 1,
  "creation": {
    "mode": "allowlist",
    "allowGeneric": false,
    "defaultAgent": "supervisor"
  },
  "deletion": {
    "protectSystem": true
  }
}
```

- `mode: "allowlist"` — only loaded non-system agents are creatable as top-level sessions.
- `mode: "open"` — any session can be created (current behavior).
- `allowGeneric` — whether blank sessions (no agent binding) are allowed.
- `defaultAgent` — the default agent for `n` in TUI when only one is needed.
- `protectSystem` — whether system sessions are deletion-protected (default `true`).

### No agent enumeration in policy

The policy does NOT list agents. The allowed agents are derived from the loaded plugin agents at startup. If a plugin defines `supervisor.agent.md`, then `supervisor` is creatable. If it defines `sweeper.agent.md` with `system: true`, then `sweeper` is NOT user-creatable.

## Agent Namespacing

Every loaded agent gets a namespace qualifier derived from its source:

| Source | Namespace | Example |
|--------|-----------|---------|
| SDK system plugins (`plugins/system`) | `pilotswarm` | `pilotswarm:default` |
| SDK management plugins (`plugins/mgmt`) | `pilotswarm` | `pilotswarm:sweeper` |
| App plugins with `plugin.json` | `plugin.json` `name` field | `smelter:supervisor` |
| App plugins without `plugin.json` | directory basename | `my-app:builder` |
| Inline `customAgents` config | `custom` | `custom:helper` |

### Qualified agent names

- `resolveAgentConfig` accepts both `supervisor` and `smelter:supervisor`.
- `list_agents` returns qualified names: `{ name: "supervisor", namespace: "smelter", qualifiedName: "smelter:supervisor" }`.
- CMS `agent_id` stores the unqualified name for backward compatibility.
- The namespace is metadata — it does not affect agent behavior.

## Session Titles for Named Agents

Named-agent sessions use a prefixed title format: `"Agent Title: <suffix>"`.

### Title Lifecycle

| Stage | Generic session | Named agent session | System agent session |
|-------|----------------|--------------------|--------------------|
| Creation | No title (TUI shows shortId) | `"Alpha Agent: a1b2c3d4"` | `"Sweeper Agent"` (fixed) |
| After summarization | `"Database Migration Plan"` | `"Alpha Agent: Database Migration Plan"` | Never summarized |
| User override | `"My Custom Title"` | `"My Custom Title"` (prefix lost, user's choice) | Not allowed |

### Implementation

- **`spawnChildSession`**: When spawning a named (non-system) agent, sets initial title to `"${agentTitle}: ${shortId}"`.
- **`summarizeSession`**: Detects the agent prefix (by checking `agentId` and `": "` in existing title). After LLM generates a summary, writes `"${prefix}: ${summary}"` instead of just the summary.
- **System agents**: Title is set once at startup (e.g. "Sweeper Agent") and never overwritten by summarization.
- **`createSessionForAgent`** (new): Same prefix behavior — sets `"${agentTitle}: ${shortId}"` at creation.

## Enforcement Layers

### 1. Client (SDK) — UX enforcement

`PilotSwarmClient.createSession()`:
- If policy is loaded and `mode=allowlist`:
  - Reject if no `agentName` provided and `allowGeneric=false`
  - Reject if `agentName` is not in the loaded non-system agent list
- This is a convenience for early error messages in the TUI and CLI.

`PilotSwarmClient.createSessionForAgent(agentName, opts?)`:
- New convenience method that resolves agent config, sets title/splash/agentId.
- Validates against policy if present.

### 2. Orchestration (Worker) — trust boundary

At orchestration start (iteration 0, before first `runTurn()`):
- If policy exists and `mode=allowlist`:
  - If session has no `agentId` and `allowGeneric=false`: mark session `"rejected"` in CMS, return error.
  - If session has `agentId` and it's not in the loaded agent list: mark session `"rejected"`, return error.
- This runs on the trusted worker — a modified client cannot bypass it.
- Sub-agent spawns via `spawn_agent` are NOT subject to top-level policy (they're internal orchestration).

### 3. CMS — deletion guard

`softDeleteSession()` checks `isSystem` at the DB level. No change needed.

## Top-Level Agent List

The list of user-creatable top-level agents is:

```
all loaded agents WHERE system != true
```

System agents are omitted because they are auto-started by workers, not user-created.

For each creatable agent, the following metadata comes from `.agent.md` frontmatter:
- `name` — agent identifier
- `namespace` — source plugin qualifier
- `title` — display name (fallback: capitalized name)
- `description` — one-line summary
- `splash` — optional TUI banner

## Implementation Plan

### Phase 1: Agent namespacing

1. Add `namespace` field to `AgentConfig` in `agent-loader.ts`.
2. In `_loadPluginDir()`, detect namespace from `plugin.json` name or dir basename.
3. Tag each loaded agent with its namespace.
4. Update `list_agents` tool to include `namespace` and `qualifiedName`.
5. Update `resolveAgentConfig` to accept qualified names (`smelter:supervisor`).

### Phase 2: Policy loading + enforcement

1. Add `SessionPolicy` interface to `types.ts`.
2. In `_loadPluginDir()`, look for `session-policy.json` and store as `_sessionPolicy`.
3. Pass policy + allowed agent names to orchestration input.
4. Client enforcement: validate in `createSession()` if policy present.
5. Orchestration enforcement: validate at iteration 0 if policy present.
6. Add `createSessionForAgent()` to client.

### Phase 3: Tests

New test file: `test/local/session-policy.test.js`

| Test | Layer | What it validates |
|------|-------|-------------------|
| Client rejects generic when disallowed | Client | `createSession()` throws when `allowGeneric=false` |
| Client allows named agent | Client | `createSessionForAgent("supervisor")` succeeds |
| Client rejects unknown agent | Client | `createSessionForAgent("fake")` throws |
| Orch rejects generic when disallowed | Orch | Session created without agent → orchestration marks `"rejected"` |
| Orch allows named agent | Orch | Session with valid agentId → orchestration runs normally |
| Orch allows sub-agent spawn | Orch | `spawn_agent` inside session → not blocked by policy |
| No policy = open behavior | Both | No `session-policy.json` → all creation paths work |
| System agents omitted from creatable list | Worker | `list_agents` with `creatableOnly=true` omits system agents |
| Agent namespacing | Worker | Agents have correct namespace from plugin source |
| Deletion still protects system | CMS | `deleteSession()` on system session → rejected |

### Phase 4: TUI integration

1. `n` key: show agent selector when policy present.
2. Agent selector shows namespace-qualified agents with title + description.
3. Delete key: check `isSystem`.

## Backward Compatibility

- No policy file → current behavior unchanged.
- `isSystem` remains the sole classification. No `sessionKind`.
- `agent_id` in CMS stays unqualified for backward compat.
- Existing `createSession()` API unchanged (policy check is additive).
- `createSessionForAgent()` is a new method, not a replacement.

## Local Integration Test Plan

New test file: `test/local/session-policy.test.js` (Level 10).

Tests use `withClient()` from `test/helpers/local-workers.js`, which provides an isolated worker + client pair. Policy is injected via a test plugin dir containing a `session-policy.json` and `.agent.md` files.

### Test Fixture: Policy Plugin

Create a temporary plugin directory for tests with:

```text
test/fixtures/policy-plugin/
├── plugin.json              ← { "name": "testapp" }
├── session-policy.json      ← { "version": 1, "creation": { "mode": "allowlist", "allowGeneric": false } }
└── agents/
    ├── alpha.agent.md       ← name: alpha, title: "Alpha Agent", description: "Test agent alpha."
    └── beta.agent.md        ← name: beta, title: "Beta Agent", description: "Test agent beta.", system: true
```

`alpha` is a non-system agent (user-creatable). `beta` is a system agent (not user-creatable, auto-started).

### Test Fixture: Open Policy Plugin

```text
test/fixtures/open-policy-plugin/
├── plugin.json              ← { "name": "openapp" }
├── session-policy.json      ← { "version": 1, "creation": { "mode": "open", "allowGeneric": true } }
└── agents/
    └── gamma.agent.md       ← name: gamma, title: "Gamma Agent"
```

---

### L10-1: Agent Namespacing

**Purpose:** Verify agents loaded from plugin dirs get correct namespace qualifiers.

```
Setup:
  - withClient(env, { worker: { pluginDirs: ["test/fixtures/policy-plugin"] } })

Steps:
  1. Call worker.getLoadedAgents() (or equivalent)
  2. Assert alpha has namespace "testapp", qualifiedName "testapp:alpha"
  3. Assert beta has namespace "testapp", qualifiedName "testapp:beta"
  4. Assert built-in agents have namespace "pilotswarm"

Assertions:
  - assertEqual(alpha.namespace, "testapp")
  - assertEqual(alpha.qualifiedName, "testapp:alpha")
  - assertEqual(beta.namespace, "testapp")
  - assert(built-in sweeper has namespace "pilotswarm") [only if mgmt agents loaded]
```

### L10-2: list_agents Omits System Agents from Creatable List

**Purpose:** Verify system agents are not in the user-creatable list.

```
Setup:
  - withClient(env, { worker: { pluginDirs: ["test/fixtures/policy-plugin"] } })

Steps:
  1. Create session, send "Call list_agents and tell me the agent names"
  2. Parse response

Assertions:
  - Response includes "alpha"
  - Response includes namespace info (e.g. "testapp")
  - beta does NOT appear as a creatable agent (it's system)
  - If mgmt agents loaded: sweeper/resourcemgr also excluded from creatable list
```

### L10-3: Client Rejects Generic Session When Disallowed

**Purpose:** Client-layer enforcement — `createSession()` throws when policy says `allowGeneric=false`.

```
Setup:
  - withClient(env, {
      worker: { pluginDirs: ["test/fixtures/policy-plugin"] },
      client: { /* policy propagated from worker */ }
    })

Steps:
  1. Call client.createSession({ systemMessage: { mode: "replace", content: "Hello" } })
     (no agentName — this is a generic session)

Assertions:
  - Throws an error containing "policy" or "not allowed"
  - No session created in CMS
```

### L10-4: Client Allows Named Agent Session

**Purpose:** Client-layer enforcement — `createSessionForAgent("alpha")` succeeds.

```
Setup:
  - Same as L10-3

Steps:
  1. Call client.createSessionForAgent("alpha")
  2. Check CMS record

Assertions:
  - Session created successfully
  - CMS row has agentId = "alpha"
  - CMS row has title = "Alpha Agent"
  - CMS row has splash (if defined in alpha.agent.md)
```

### L10-5: Client Rejects Unknown Agent

**Purpose:** Client-layer enforcement — `createSessionForAgent("nonexistent")` throws.

```
Setup:
  - Same as L10-3

Steps:
  1. Call client.createSessionForAgent("nonexistent")

Assertions:
  - Throws an error containing "not found" or "unknown agent"
  - No session created in CMS
```

### L10-6: Client Rejects System Agent as Top-Level

**Purpose:** Client-layer enforcement — `createSessionForAgent("beta")` fails because beta is a system agent (not user-creatable).

```
Setup:
  - Same as L10-3

Steps:
  1. Call client.createSessionForAgent("beta")

Assertions:
  - Throws an error containing "system" or "not creatable"
  - No session created in CMS
```

### L10-7: Orchestration Rejects Generic Session When Disallowed

**Purpose:** Worker-layer enforcement — even if a client bypasses SDK checks and creates a generic session directly, the orchestration catches it at startup and marks it rejected.

```
Setup:
  - withClient(env, { worker: { pluginDirs: ["test/fixtures/policy-plugin"] } })
  - Bypass client policy check: directly create session in CMS + start orchestration
    (use raw createSession without policy enforcement, or inject session manually)

Steps:
  1. Create a session without agentId (bypass client policy)
  2. Send a prompt to trigger orchestration start
  3. Wait for orchestration to complete/reject

Assertions:
  - CMS state = "rejected" or "failed"
  - Session response includes "policy" error message
  - No LLM turn was executed (no runTurn activity)
```

### L10-8: Orchestration Allows Valid Named Agent

**Purpose:** Worker-layer enforcement — orchestration runs normally when session has a valid agentId.

```
Setup:
  - Same as L10-7

Steps:
  1. Create session with agentId = "alpha" (pass policy checks)
  2. Send a prompt
  3. Wait for response

Assertions:
  - CMS state = "idle" or "running" (not rejected)
  - Response is a valid LLM response
  - Orchestration ran runTurn successfully
```

### L10-9: Orchestration Does Not Block Sub-Agent Spawns

**Purpose:** Sub-agents spawned via `spawn_agent` are internal orchestration — top-level policy does NOT apply to them.

```
Setup:
  - withClient(env, { worker: { pluginDirs: ["test/fixtures/policy-plugin"] } })

Steps:
  1. Create session with agentId = "alpha" (valid)
  2. Send: "Spawn a sub-agent with task 'say hello'"
  3. Wait for response

Assertions:
  - Sub-agent created successfully (child session in CMS)
  - Child session has parentSessionId = parent sessionId
  - No policy rejection on child
```

### L10-10: No Policy File = Open Behavior

**Purpose:** When no `session-policy.json` is present, all creation paths work as before.

```
Setup:
  - withClient(env) (no policy plugin, default behavior)

Steps:
  1. Call client.createSession({ systemMessage: { mode: "replace", content: "Hi" } })
  2. Send a prompt and get a response

Assertions:
  - Session created successfully
  - Orchestration runs normally
  - No policy rejection
```

### L10-11: Open Policy Allows Generic Sessions

**Purpose:** When policy has `mode: "open"` and `allowGeneric: true`, generic sessions are allowed.

```
Setup:
  - withClient(env, { worker: { pluginDirs: ["test/fixtures/open-policy-plugin"] } })

Steps:
  1. Call client.createSession({ systemMessage: { mode: "replace", content: "Hi" } })
  2. Send a prompt

Assertions:
  - Session created successfully
  - Orchestration runs normally
```

### L10-12: Qualified Name Resolution

**Purpose:** `resolveAgentConfig` accepts both unqualified name and qualified name.

```
Setup:
  - withClient(env, { worker: { pluginDirs: ["test/fixtures/policy-plugin"] } })

Steps:
  1. Create session, ask the LLM to spawn agent by agent_name="alpha"
  2. Create another session, ask to spawn by agent_name="testapp:alpha"

Assertions:
  - Both resolve to the same agent definition
  - Both child sessions have agentId = "alpha"
  - Both child sessions have correct title
```

### L10-13: Deletion Still Protects System Sessions

**Purpose:** Confirm that `deleteSession()` on a system session is rejected regardless of policy.

```
Setup:
  - withClient(env, { worker: { pluginDirs: ["test/fixtures/policy-plugin"] } })

Steps:
  1. Wait for beta (system agent) to be created by auto-start
  2. Call client.deleteSession(betaSessionId)

Assertions:
  - Throws "Cannot delete system session"
  - Beta session still exists in CMS with deleted_at = null
```

### L10-14: App System Agents Coexist with Built-In

**Purpose:** App-defined system agents (beta) are loaded alongside PilotSwarm's built-in system agents.

```
Setup:
  - withClient(env, {
      worker: { pluginDirs: ["test/fixtures/policy-plugin"] },
      disableManagementAgents: false
    })

Steps:
  1. Wait for system agents to start
  2. List all sessions, filter isSystem=true

Assertions:
  - pilotswarm system agent exists (built-in)
  - beta system agent exists (from app plugin)
  - Both have isSystem = true
  - Both have correct titles and agentIds
```

### L10-15: Multiple Plugin Dirs Merge Correctly

**Purpose:** When multiple plugin dirs are provided, agents from all dirs are loaded and namespaced independently.

```
Setup:
  - withClient(env, {
      worker: { pluginDirs: ["test/fixtures/policy-plugin", "test/fixtures/open-policy-plugin"] }
    })

Steps:
  1. Get loaded agents list from worker

Assertions:
  - alpha has namespace "testapp"
  - gamma has namespace "openapp"
  - No namespace collision
  - Both agents are creatable (neither is system, in case of gamma)
```

### L10-16: Last Policy Wins

**Purpose:** When multiple plugins provide `session-policy.json`, the last one loaded takes precedence (consistent with MCP merge behavior).

```
Setup:
  - withClient(env, {
      worker: { pluginDirs: ["test/fixtures/policy-plugin", "test/fixtures/open-policy-plugin"] }
    })
  - policy-plugin has mode=allowlist, allowGeneric=false
  - open-policy-plugin has mode=open, allowGeneric=true

Steps:
  1. Create a generic session (no agentName)

Assertions:
  - Session created successfully (open-policy-plugin's policy wins)
  - No rejection
```

### L10-17: Named Agent Title Prefix on Spawn

**Purpose:** When a named agent is spawned, the initial title is `"Agent Title: <shortId>"`.

```
Setup:
  - withClient(env, { worker: { pluginDirs: ["test/fixtures/policy-plugin"] } })

Steps:
  1. Create a parent session
  2. Send: "Spawn agent alpha"
  3. Wait for child to appear in CMS
  4. Read child session row from CMS

Assertions:
  - Child title matches /^Alpha Agent: [a-f0-9]{8}$/
  - Child agentId = "alpha"
  - Child title starts with "Alpha Agent:"
  - The suffix after ": " is the first 8 chars of the child sessionId
```

### L10-18: Named Agent Title Prefix Preserved After Summarization

**Purpose:** After the LLM generates a summary title, the agent prefix is preserved.

```
Setup:
  - withClient(env, { worker: { pluginDirs: ["test/fixtures/policy-plugin"] } })

Steps:
  1. Create a parent session
  2. Send: "Spawn agent alpha with task 'Research database migration strategies'"
  3. Wait for child to complete at least one turn
  4. Wait for summarization to run (or trigger it manually if possible)
  5. Read child session row from CMS

Assertions:
  - Child title starts with "Alpha Agent: "
  - The part after "Alpha Agent: " is NOT a UUID prefix (it's the LLM summary)
  - Title length <= 60 + len("Alpha Agent: ")
```

### L10-19: System Agent Title Not Prefixed

**Purpose:** System agents keep their fixed title — no shortId suffix, no ": " prefix pattern.

```
Setup:
  - withClient(env, {
      worker: { pluginDirs: ["test/fixtures/policy-plugin"] },
      disableManagementAgents: false
    })

Steps:
  1. Wait for system agents to auto-start
  2. Read beta session row from CMS (beta is system in the test plugin)

Assertions:
  - Title = "Beta Agent" (exact, not "Beta Agent: <shortId>")
  - isSystem = true
  - Summarization is skipped (title unchanged after turns)
```

### L10-20: Generic Session Title Has No Prefix

**Purpose:** Sessions created without a named agent have no agent prefix in their title.

```
Setup:
  - withClient(env) (no policy, default behavior)

Steps:
  1. Create a generic session
  2. Send a prompt, wait for response
  3. Wait for summarization
  4. Read session row from CMS

Assertions:
  - Title does NOT contain ": " prefix pattern from a named agent
  - agentId is null
  - Title is the raw LLM summary (e.g. "Database Migration Plan")
```

---

### Test Runner Entry

Tests use **vitest** and are split across two files auto-discovered by the vitest config:

- `test/local/session-policy-guards.test.js` — 8 tests: namespacing, list agents, client/orch rejection, deletion protection
- `test/local/session-policy-behavior.test.js` — 12 tests: open policy, merge, title prefixing, summarization, sub-agent spawns

Run:

```bash
cd packages/sdk
npx vitest run test/local/session-policy-guards.test.js test/local/session-policy-behavior.test.js
npx vitest run test/local/session-policy-behavior.test.js -t "Summarization"  # single test
```

### Implementation Status

All 20 tests (L10-1 through L10-20) are implemented and passing.

| Test | File | Status |
|------|------|--------|
| L10-1: Agent Namespacing | guards | ✓ |
| L10-2: List Agents Omits System | guards | ✓ |
| L10-3: Client Rejects Generic | guards | ✓ |
| L10-4: Client Allows Named Agent | guards | ✓ |
| L10-5: Client Rejects Unknown | guards | ✓ |
| L10-6: Client Rejects System Agent | guards | ✓ |
| L10-7: Orch Rejects Generic | guards | ✓ |
| L10-8: Orch Allows Valid Named Agent | behavior | ✓ |
| L10-9: Orch Does Not Block Sub-Agent Spawns | behavior | ✓ |
| L10-10: No Policy = Open | behavior | ✓ |
| L10-11: Open Policy Allows Generic | behavior | ✓ |
| L10-12: Qualified Name Resolution | behavior | ✓ |
| L10-13: Deletion Protects System | guards | ✓ |
| L10-14: App System Agents Coexist | behavior | ✓ |
| L10-15: Multiple Plugin Dirs Merge | behavior | ✓ |
| L10-16: Last Policy Wins | behavior | ✓ |
| L10-17: Named Agent Title Prefix | behavior | ✓ |
| L10-18: Title Preserved After Summarization | behavior | ✓ |
| L10-19: System Agent Title Not Prefixed | behavior | ✓ |
| L10-20: Generic Session Title No Prefix | behavior | ✓ |

### Impact on Existing Tests

| Suite | Impact |
|-------|--------|
| L1 smoke | None — no policy loaded, behavior unchanged |
| L2 durability | None |
| L3 multi-worker | None |
| L4 commands | None |
| L5 sub-agents | Verify `testSpawnNamedAgents` still passes — namespace is metadata-only, doesn't change spawn behavior |
| L6 kv-transport | None |
| L7 cms-consistency | None |
| L8 contracts | Add assertion: `list_agents` response includes `namespace` and `qualifiedName` fields |
| L9 chaos | None |
| System agents | Verify system agents have `namespace: "pilotswarm"` |

### Test Helpers Used

| Helper | Location | Status |
|--------|----------|--------|
| `assertThrows(fn, pattern)` | `test/helpers/assertions.js` | ✓ Implemented |
| `createCatalog(env)` | `test/helpers/cms-helpers.js` | ✓ Implemented |
| `withClient(env, opts, fn)` | `test/helpers/local-workers.js` | ✓ Implemented — forwards `pluginDirs`, `disableManagementAgents` |

Test fixtures are static (not generated):
- `test/fixtures/policy-plugin/` — allowlist policy with alpha (non-system) + beta (system)
- `test/fixtures/open-policy-plugin/` — open policy with gamma agent
