# Per-Agent MCP Servers and Session Capability Selection

**Status:** Draft / RFC
**Date:** 2026-07-16
**Scope:** agent-definition capability declarations (MCP servers, skills, tools),
a deployment capability catalog, per-session capability overrides at create and
at turn boundaries, and the API / MCP / portal / TUI surfaces for all of it

## Summary

Today an agent's *capabilities* — which MCP servers it can reach, which skills
load, which tools it can call — are almost entirely **cluster-wide**. Every
Copilot session receives the same merged MCP server map, the same skill
directories, and an additively-unioned tool list, regardless of which agent it
runs or who created it. There is no way for an agent definition to scope its own
MCP servers, no way to restrict which skills an agent loads, and no way for a
user to turn capabilities on or off for a session — at create time or later.

This proposal introduces one coherent model across three capability axes —
**MCP servers, skills, and tools** — with three layers of control:

1. **Agent profile** — a `.agent.md` declares the MCP servers, skills, and tools
   it wants, and whether it inherits deployment defaults. The pilotswarm base
   agent inherits *no* MCP servers; other base agents may opt in.
2. **Deployment catalog** — what is available cluster-wide (all configured MCP
   servers, all loaded skills, all registered tool groups), surfaced so clients
   can present choices.
3. **Session override** — at session create (the New+Model flow) and later at
   turn boundaries (a "Configure session" flow modeled on switch-model), the
   user adds or removes skills, tools, and MCP servers for that session. The
   override is durable, replay-safe, and applies on the next turn.

The load-bearing enabler: the underlying `@github/copilot-sdk` **already
supports** per-agent `mcpServers`, per-session `availableTools` / `excludedTools`
(pattern allow/deny), and `disabledSkills`. PilotSwarm's agent-loading and
session-assembly pipeline currently strips these fields. Most of this work is
plumbing existing primitives through — not building new capability machinery.

## Current state (verified against code)

**Agents are file-based, no DB registry.** Agents are `.agent.md` files with
YAML frontmatter loaded from tiered plugin dirs at worker boot
(`packages/sdk/src/agent-loader.ts` `AgentConfig`, lines 69-117; `loadAgentFiles`
254-320). CMS sessions carry only an `agent_id` column — there is no
`registered_agents` table. Frontmatter already parses `tools:` and `skills:`
lists, plus `system:`, `parent:`, `crawler:`. The "pilotswarm base agent" is
`packages/sdk/plugins/system/agents/default.agent.md` (name `default`), a prompt
overlay + base tool list unioned into every session; it is not creatable as a
session agent.

**MCP servers are worker-global.** Each plugin dir's `.mcp.json` is merged by
server name into one worker-global `_loadedMcpServers` map
(`worker.ts` `_loadPluginDir` ~1040) and spread into **every** Copilot session's
config unconditionally (`session-manager.ts:1049-1051`). The flagship
deployment's `.mcp.json` is literally `{}` — zero MCP servers configured in
production today. PilotSwarm never opens an MCP connection itself; it hands the
map to the GitHub Copilot CLI runtime, which spawns/connects the servers inside
each Copilot session subprocess and auto-approves their tool calls.

**Skills are cluster-wide, in two systems.** (1) Static `SKILL.md` directories
loaded at boot and passed identically to every session as the CLI's
`skillDirectories`; plus an eager path where an agent's `skills:` frontmatter
splices skill bodies into its prompt at load time (this is *injection, not a
restriction*). (2) Learned/shared skills stored as `skills/%` facts. The
skill-materialization-to-filesystem proposal is **not shipped**.

**Tool assembly is purely additive.** The LLM tool array is a union
(`frameworkBaseToolNames ∪ appDefaultToolNames ∪ session toolNames ∪ agent
frontmatter tools`) built in `SessionManager._getOrCreateUnlocked` and rebuilt
per turn in `ManagedSession.registerTools`. There is **no deny mechanism** except
hardcoded identity gates (agent-tuner read-only, facts-manager, crawler role) and
a single `excludedTools: ["task"]`.

**Session options are an explicit field whitelist.** `createSession` /
`createSessionForAgent` accept only `model / reasoningEffort / contextTier /
title / groupId / visibility` (`protocol.js`); the web client explicitly
**rejects** `toolNames` (`WEB_MODE_UNSUPPORTED`). Options flow protocol →
`runtime.call` → transport → `PilotSwarmClient.createSession` → the 10-arg
`cms_create_session` (columns only) → `OrchestrationInput.config`
(`SerializableSessionConfig`, the durable runtime carrier, re-emitted wholesale
on every continue-as-new) → `runTurn` → `SessionManager.getOrCreate`
(session-manager.ts:1049-1051, the assembly join point).

**The turn-boundary precedent is `setSessionModel`.** `mgmt.setSessionModel`
validates against the model registry, enqueues a durable
`{type:"cmd", cmd:"set_model"}` on the orchestration's `messages` queue, which is
drained only *between* turns. `handleCommand` mutates `state.config`, writes the
CMS model columns via an activity, records a `session.model_changed` event,
answers the KV command-response channel with `appliesOn: "next_turn"`, and
continues-as-new. The next `runTurn` ships the new config, and
`requiresModelRebind()` destroys the warm `CopilotSession` to rebind. MCP servers
and skills are established at session build and live for the session's warm
lifetime (re-established on resume, killed by the 35-min idle sweep), so a
capability change **also** needs a rebind — but `requiresModelRebind()` today
triggers only on model / reasoningEffort / contextTier.

**The CLI already supports the primitives we need.** The Copilot SDK's
`CustomAgentConfig` supports per-agent `mcpServers` and `model`; `SessionConfig`
supports per-session `availableTools` / `excludedTools` (pattern allow/deny),
`disabledSkills`, and `defaultAgent.excludedTools`. PilotSwarm strips these. The
natural extension is to carry them on the loaded agent shape / session config
through the existing `customAgents` spread and the session-assembly join point.

## Design principles

1. **One model, three axes.** MCP servers, skills, and tools share the same
   catalog → agent-profile → session-override resolution. Do not build three
   bespoke systems.
2. **Additive today, subtractive by policy.** The default stays permissive
   (everything unioned). Restriction is opt-in: an agent narrows its own set; a
   user narrows a session. Absence of a restriction means "inherit."
3. **The agent definition is the source of an agent's defaults.** Capability
   declarations live in `.agent.md` frontmatter, resolved worker-side at the same
   chokepoints that resolve the prompt — never in the durable session row.
4. **The session override is durable and replay-safe.** It enters the
   orchestration only via input (at create) or a replayed durable command (at a
   turn boundary), never by reading mutable external state mid-turn.
5. **Users choose from the catalog, not from the wild.** A session override can
   only enable/disable capabilities the deployment already offers. Enabling an
   MCP server uses the deployment's configured server (and its credentials); v1
   adds no per-user MCP credentials.
6. **Capabilities are not an access boundary.** They shape what an agent can *do*
   in a session; they are not authorization. Session read/write/manage
   permissions (the security model) still gate who may configure a session.

## Capability model

Three axes, resolved identically:

```text
catalog        = deployment-wide available capabilities (per axis)
agentProfile(A)= what agent A declares (a subset of / addition to catalog)
sessionOverride= the user's per-session enable/disable deltas
effective(S)   = applyOverride(sessionOverride, resolveAgent(agentProfile, catalog))
```

`effective(S)` is computed at the session-assembly join point and mapped onto the
Copilot session config:

| Axis | Catalog source | Agent declares | Copilot config target |
|---|---|---|---|
| MCP servers | merged `.mcp.json` (`_loadedMcpServers`) | `mcpServers` + `inheritDefaultMcpServers` | per-agent `CustomAgentConfig.mcpServers` |
| Skills | loaded `SKILL.md` dirs | `allowedSkills` (restriction) | session `skillDirectories` + `disabledSkills` |
| Tools | registered tool names / groups | `tools` (add) + `toolPolicy` (restriction) | session `availableTools` / `excludedTools` |

The session override is a normalized delta over the resolved agent profile:

```ts
interface SessionCapabilityOverride {
  mcpServers?: { enable?: string[]; disable?: string[] };
  skills?:     { enable?: string[]; disable?: string[] };
  tools?:      { enable?: string[]; disable?: string[] };
}
```

`enable`/`disable` name catalog entries. `disable` wins over `enable`. An empty
override means "use the agent profile as-is." Unknown names are ignored and
reported (not an error), so a catalog that shrinks between deployments does not
break a stored override.

## Part 1 — Per-agent MCP servers

### Agent frontmatter

Add to `.agent.md` (schemaVersion bump, `agent-loader.ts` parser + `AgentConfig`):

```yaml
# reference deployment-configured servers by name, and/or inline agent-owned defs
mcpServers:
  - github            # a named entry from the merged .mcp.json catalog
  - name: jira        # an inline server this agent owns
    type: http
    url: https://mcp.example.com/jira
    tools: ["*"]
inheritDefaultMcpServers: false   # opt into the cluster default set; default false
```

- **`mcpServers`** — named references resolve against the deployment catalog;
  inline entries follow the existing `.mcp.json` server shape (`mcp-loader.ts`).
  A named reference to a server not in the catalog is dropped and logged.
- **`inheritDefaultMcpServers`** — when true, the agent also receives the
  deployment's "default MCP set" (a new, explicitly-tagged subset of the merged
  map — see catalog below). Defaults **false**. The pilotswarm base agent
  (`default.agent.md`) sets it false and declares no `mcpServers`, so it pulls
  none — exactly today's zero-server behavior for that agent, now by intent.

### Resolution and pass-through

Stop stripping MCP fields in the agent-loading pipeline. Carry the resolved
per-agent server map on the loaded agent shape (`worker.ts` `_loadedAgents`,
`agent-loader` `AgentConfig`), and pass it through the existing `customAgents`
spread as `CustomAgentConfig.mcpServers` (which the CLI already honors). This
moves MCP resolution from **session-global** (`session-manager.ts:1051`, applied
to every session identically) to **per-agent** (each `customAgent` entry carries
its own servers; the bound top-level agent and each spawned sub-agent get their
own). Sub-agents inherit their own agent's MCP profile — the tree resolves
naturally because each agent is a distinct `customAgent`.

### Deployment default MCP set

The merged `.mcp.json` becomes the **catalog**. Introduce an explicit "default
set" tag (e.g. a `default: true` flag per server in `.mcp.json`, or a
`defaultMcpServers: [...]` list in `session-policy.json`, which is already a raw
JSON pass-through). Only agents with `inheritDefaultMcpServers: true` receive it.
This preserves the "base agents may pull in some default MCP servers" requirement
while letting the pilotswarm base agent stay empty.

## Part 2 — Per-agent skill and tool restrictions

### Skills

`skills:` frontmatter keeps its current meaning (eager prompt preload). Add
`allowedSkills:` as a **restriction**: when present, the agent's sessions may load
only those skills from the catalog. Map to the CLI by computing
`disabledSkills = catalog.skills − allowedSkills` for that agent's sessions (and,
where cheaper, passing a filtered `skillDirectories`). Absent `allowedSkills`
means "all catalog skills" — today's behavior. Also fix `normalizeCreatableAgent`
(`node-sdk-transport.js:352`), which currently forwards `tools` but silently
drops `skills`, so skills never reach the UI/catalog.

### Tools

`tools:` frontmatter keeps its additive meaning. Add `toolPolicy:` for
restriction, mapping onto the CLI's `availableTools` / `excludedTools`
pattern allow/deny:

```yaml
toolPolicy:
  deny: ["shell", "task"]     # never available to this agent
  # or allow: [...]           # allow-list mode (everything else denied)
```

The identity-gated exclusions that exist today (agent-tuner read-only, crawler
role, `excludedTools: ["task"]`) become the built-in floor that `toolPolicy`
composes with; a policy can further restrict but never widen past the floor.

## Part 3 — Deployment capability catalog

Clients cannot present toggles without knowing what exists. Expose a catalog,
carried on `getBootstrap` (`runtime.js:480-511`) alongside the existing
`modelsByProvider` / `creatableAgents` / `sessionCreationPolicy`:

```ts
interface CapabilityCatalog {
  mcpServers: { name: string; description?: string; isDefault: boolean }[];
  skills:     { name: string; description?: string }[];
  tools:      { name: string; group?: string; description?: string }[];
  // per-agent defaults so the UI can pre-check an agent's profile
  agentDefaults: Record<string /*agentName*/, {
    mcpServers: string[]; skills: string[]; tools: string[];
  }>;
}
```

There is no Web API op that lists deployment skills today (only skill-usage
metrics), so this is net-new. `session-policy.json`'s raw pass-through can carry
catalog descriptions with zero protocol change; the live sets come from the
worker's loaded plugins reported through the bootstrap.

## Part 4 — Session overrides (create + turn boundary)

### At create

`createSession` / `createSessionForAgent` gain an optional `capabilities`
parameter (`SessionCapabilityOverride`). Server behavior:

1. resolve the bound agent's profile;
2. validate every enable/disable name against the catalog (drop+report unknowns);
3. persist the normalized override (see Data model);
4. `SerializableSessionConfig` carries `capabilities` into the orchestration
   input so the first turn assembles the effective set.

The plain "New" fast path (`allowGeneric`) and the auto-create paths (prompt
without a session, artifact upload) pass **no** override — the agent profile is
the default, so those paths keep working unchanged.

### At a turn boundary — "Configure session"

Mirror `setSessionModel` exactly. New op `configureSession` (see API) validates
the override against the catalog, then enqueues a durable
`{type:"cmd", cmd:"set_capabilities", override}` on the orchestration `messages`
queue. Drained between turns, `handleCommand`:

1. merges the override into `state.config.capabilities`;
2. writes the CMS capability column via an activity;
3. records a `session.capabilities_changed` event;
4. answers the KV channel with `appliesOn: "next_turn"`;
5. continues-as-new with a bootstrap prompt.

Extend `requiresModelRebind()` → `requiresSessionRebind()` so a capability change
destroys the warm `CopilotSession` and rebinds with the new MCP/skill/tool set on
the next turn (MCP servers and skills are fixed at session build, so a rebind is
mandatory — same cost as a model switch). Because this changes orchestration
handler behavior, it ships under a **new frozen orchestration version** (registry
is at 1.0.61); replay stays safe because the override enters only via input or the
replayed durable command.

## Data model

`sessions` has typed columns and no free JSONB on the create path. Add one
nullable JSONB column via an additive migration (the 0029/0034 steps-migration
shape if it needs backfill; here it does not — a plain `ADD COLUMN`):

```sql
ALTER TABLE ${s}.sessions
  ADD COLUMN capability_override JSONB;   -- normalized SessionCapabilityOverride, null = none
```

Thread it through a new `cms_create_session` overload (the rolling-deploy
overload-probe pattern the codebase already uses) and a `cms_update_session`
path for the turn-boundary write. The **agent profile is never stored** — it is
re-resolved worker-side each turn from the loaded `.agent.md`, exactly like the
prompt, so an agent redefinition takes effect on the next rebind without touching
session rows.

## API and MCP surface

### Web API (protocol.js)

- **`configureSession`** — `POST /management/sessions/:sessionId/capabilities`,
  access **`session:manage`** (beside `setSessionModel` at `protocol.js:96`),
  body `{ capabilities: SessionCapabilityOverride }`. Gets its Express route,
  `ApiClient` method, and authz enforcement from the generated router for free.
- **`createSession` / `createSessionForAgent`** — add `capabilities` body param.
- **`getSession` / `getSessionAccess`** — expose the session's `capabilityOverride`
  and its resolved `effectiveCapabilities` so a client can render current state.
- **`getBootstrap`** — carries the `CapabilityCatalog`.

### MCP (packages/app/mcp)

- **`create_session`** (`tools/sessions.ts`) — add `capabilities` input.
- **`configure_session`** — new dual-mode tool copying `switch_model`
  (`tools/models.ts:96-206`): web mode calls `mgmt.configureSession`; direct mode
  enqueues the durable `set_capabilities` command.
- **`get_capabilities`** (`buildCapabilities`) + `get_system_status` include enum +
  the `pilotswarm://capabilities` resource — surface the catalog and per-agent
  defaults so an agent driving MCP can explain and choose capabilities.

Update `docs/api/reference.md` and the MCP tool descriptions accordingly.

## Portal / TUI UX

The multi-select checkbox precedent already exists — the session owner-filter
modal (`[x]` rows, space-to-toggle, modal stays open;
`controller.js:1599-1670`, `selectors.js:4720`, `web-app.js:4212`, TUI
`app.js:428`). Reuse it for capability toggles.

- **New+Model flow** — the create chain is a controller-owned sequence of list
  modals (`openModelPicker → openReasoningEffortPicker → openContextTierPicker →
  openSessionAgentPicker → create`, threaded by `sessionOptions`). Add an optional
  **Capabilities** step after the agent picker: three grouped checkbox sections
  (MCP servers, skills, tools) pre-checked to the chosen agent's profile from the
  catalog; toggling produces the override on `sessionOptions.capabilities`.
  Skippable — Enter-through keeps the agent defaults.
- **Manage session modal** (`SessionModifyModal`, tabbed General/Access with the
  staged-draft + Apply pattern) — add a **Capabilities** tab: the same three
  checkbox sections showing effective state, staged locally, committed by **Apply**
  → `configureSession` (applies next turn, with a "takes effect on the next turn"
  note mirroring the model-switch status).
- **Switch-model parity** — "Configure session" is offered next to "Switch model"
  in the same surface; both are turn-boundary reconfigurations.
- **TUI** — glyph/keybinding parity for the create step and a configure action,
  reusing the shared controller flow.

## Security and privacy

- `configureSession` and create-time `capabilities` are **`session:manage`**
  (owner/admin), consistent with `setSessionModel`.
- A session override may only reference catalog entries; it cannot introduce MCP
  servers, tools, or skills the deployment does not offer.
- Enabling an MCP server uses the deployment's configured server and its
  credentials. **No per-user MCP credentials in v1** — a shared server is shared
  infrastructure, like the Copilot key. (Per-user MCP auth is a future item,
  aligned with the multitenant proposal.)
- Capabilities are behavioral scoping, not authorization: they never widen who can
  read/write/manage a session, and the security model's predicates are unchanged.
- Sub-agents resolve their own agent profile; a session override applies to the
  bound session. Whether overrides cascade to spawned children is an open question
  (below); v1 keeps them non-cascading for a predictable blast radius.

## Phased rollout

Each phase is independently shippable; order minimizes durable-contract churn.

1. **Per-agent MCP (Part 1).** Frontmatter `mcpServers` + `inheritDefaultMcpServers`,
   schemaVersion bump, stop stripping the field, pass through `customAgents`, tag
   the deployment default set. No user selection, no new op, no migration —
   highest value, smallest surface, and it un-blocks real MCP use per agent.
2. **Per-agent skill/tool restrictions (Part 2) + catalog (Part 3).** `allowedSkills`,
   `toolPolicy`, fix the dropped `skills` forwarding, expose `CapabilityCatalog`
   on bootstrap. Still no per-session override.
3. **Create-time overrides (Part 4a).** `capability_override` column + overload,
   `capabilities` param on create, the New+Model Capabilities step, MCP
   `create_session` param.
4. **Turn-boundary reconfigure (Part 4b).** `configureSession` op, the durable
   `set_capabilities` command + `requiresSessionRebind`, a new frozen
   orchestration version, the Manage-session Capabilities tab, MCP
   `configure_session`.

## Testing

- **Agent resolution:** an agent's declared/ inherited MCP set, `allowedSkills`,
  and `toolPolicy` produce the expected effective sets; the pilotswarm base agent
  resolves to zero MCP servers; a sub-agent resolves its own profile independent
  of its parent.
- **Catalog:** bootstrap reports live MCP/skill/tool sets and per-agent defaults;
  unknown override names are dropped and reported, not fatal.
- **Create override:** create with `capabilities` yields the effective set on turn
  one; fast paths (generic New, prompt auto-create, upload) keep the agent default.
- **Turn boundary:** `configureSession` enqueues the durable command, mutates
  `state.config`, records the event, answers `appliesOn: next_turn`, rebinds the
  session, and is replay-stable across continue-as-new; the change is scoped to a
  new frozen orchestration version.
- **Authz:** non-manage callers are refused; a session override cannot reference
  off-catalog capabilities.
- **UX:** the New+Model Capabilities step pre-checks the agent profile and is
  skippable; the Manage-session Capabilities tab stages and Applies; TUI parity.

## Open questions

1. **Override cascade to sub-agents.** v1 applies overrides to the bound session
   only. Should a session-tree override cascade to spawned children (matching how
   sharing/visibility resolve at the tree root), or stay non-cascading? Cascading
   is more powerful but widens the blast radius of a single toggle.
2. **Tool granularity.** Toggle individual tools, or tool *groups* (facts, graph,
   artifacts, sub-agents)? Groups are a friendlier UX and a smaller catalog;
   individual tools are more precise. Likely groups in the UI, individual names in
   the API.
3. **Per-user MCP credentials.** Deferred. When it lands it becomes an
   authorization surface (a user enabling a server with *their* creds), which
   changes the security posture — align with multitenant §3.
4. **Rebind cost visibility.** A capability change destroys the warm session
   (like a model switch). Should the UI warn when a reconfigure will interrupt an
   in-flight/warm session, or is the model-switch precedent's silent next-turn
   application enough?
5. **Learned-skill axis.** This proposal governs static `SKILL.md` skills. Should
   the facts-backed learned/curated skills (`skills/%`) be a fourth toggle, or
   stay always-on as deployment memory?
