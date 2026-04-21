# Bug: `list_agents` collides with Copilot SDK 1.0.32 built-in tool

**Status:** Open
**Filed:** 2026-04-19
**Component:** `@pilotswarm/sdk` (worker tool registration)
**Affected versions:** PilotSwarm using `@github/copilot-sdk` ≥ 1.0.32 (introduced in PilotSwarm `36679ce` — *"feat(portal,sdk): mobile UX polish, terminate session, copilot SDK 1.0.32"*)
**Severity:** High — every turn that loads agent tools fails with a hard error; sessions cannot make progress.

## Symptom

Every turn against the live Copilot session fails immediately with:

```
Execution failed: External tool "list_agents" conflicts with a built-in tool of the same name.
Set overridesBuiltInTool: true to explicitly override it.
```

Observed in a downstream production deployment's worker logs (every active session, every turn):

```
2026-04-20T01:53:04 turn returned error (attempt 1/3): Execution failed: External tool "list_agents" conflicts with a built-in tool of the same name. Set overridesBuiltInTool: true to explicitly override it.
2026-04-20T01:51:32 turn returned error (attempt 1/3): ... [same error] ...
2026-04-20T01:51:54 turn returned error (attempt 1/3): ... [same error] ...
2026-04-20T01:52:20 turn returned error (attempt 1/3): ... [same error] ...
2026-04-20T01:52:42 turn returned error (attempt 1/3): ... [same error] ...
```

After the new SDK rolled, the previously-suppressed `Connection is closed` retry loop also surfaces because the dehydration path re-enters the broken registration on every retry.

## Root cause

Copilot SDK 1.0.32 ships a **new built-in tool** named `list_agents`. From [`@github/copilot/app.js`](../../packages/sdk/node_modules/@github/copilot/app.js) (verbatim):

> Lists all active and completed background agents.
> * Shows the status of running, idle, completed, failed, and cancelled background agents.
> * Idle agents are waiting for messages — use `write_agent` to send them follow-ups.
> * Use this to discover `agent_ids` for use with `read_agent` or `write_agent` tools.
> * Set `include_completed: false` to only show running and idle agents.
>
> Schema: `{ include_completed?: boolean }` (default `true`).
>
> Telemetry counts: `running_count`, `idle_count`, `completed_count`, `failed_count`, `cancelled_count`.

This is the Copilot CLI's notion of **runtime background-agent instances** (companion to `read_agent` / `write_agent` / `task`).

PilotSwarm registers a tool with the **same name but completely different semantics** in [`packages/sdk/src/worker.ts#L391`](../../packages/sdk/src/worker.ts):

```ts
const listAgentsTool = defineTool("list_agents", {
    description:
        "List all available agent BLUEPRINTS (definitions loaded from .agent.md files). " +
        "By default this returns only user-creatable named agents. " +
        "Worker-managed system agents are hidden ...",
    parameters: { /* systemOnly?, creatableOnly? */ },
    handler: async ({ systemOnly, creatableOnly }) => {
        // returns { agents: [...blueprints], total }
    },
});
this.registerTools([listAgentsTool]);
```

Two independent concepts in the same name, no coordination:

| Aspect | Copilot SDK `list_agents` | PilotSwarm `list_agents` |
|---|---|---|
| Lists | Live background-agent instances | Static blueprints from `.agent.md` |
| Items | Spawned task IDs | Names like `repo-watcher`, `r2d-watcher` |
| Lifecycle | Runtime | Registration-time |
| Companion tools | `read_agent`, `write_agent` | `spawn_agent`, `check_agents` |
| Schema | `{ include_completed }` | `{ systemOnly, creatableOnly }` |

Since SDK 1.0.32, registering an external tool whose name shadows a built-in is a hard error unless the registration sets `overridesBuiltInTool: true`. PilotSwarm's registration does not, so every worker that loads agents (i.e. every PilotSwarm worker in production) crashes its turns.

## Why "override" is the wrong fix

The two tools are not the same operation. An agent that calls `list_agents` expecting the Copilot built-in (to find background-agent IDs to `write_agent`) would get back PilotSwarm blueprints with no `agent_id` field, and vice versa. Either side of the override would silently break consumers of the other.

The cleaner answer is to **rename**.

## Proposed fix — rename to `list_ps_agents`

Rename the PilotSwarm tool from `list_agents` to `list_ps_agents`. Rationale:

1. **No semantic collision.** `list_ps_agents` clearly belongs to PilotSwarm and is unambiguous in agent prompts.
2. **No silent overrides.** Both tools coexist, both work, the model can choose either based on intent.
3. **Mirrors existing PilotSwarm naming.** PilotSwarm already namespaces other things this way (e.g. tool authoring uses `@pilotswarm/sdk`); a `ps_` prefix on the tool name is consistent.
4. **Doesn't lock us into the Copilot SDK's evolution.** If the SDK adds more built-ins later (`read_agent`, `write_agent`, etc.), the same prefix gives PilotSwarm space to add `read_ps_agent`, `write_ps_agent` without further collisions.

Concretely:

- **`packages/sdk/src/worker.ts`** — change `defineTool("list_agents", ...)` to `defineTool("list_ps_agents", ...)`. Leave the description unchanged; it already says "BLUEPRINTS" in caps to disambiguate from any "instances" interpretation.
- **`packages/sdk/plugins/mgmt/agents/pilotswarm.agent.md`** — replace the one prose reference (`use list_agents to see user-creatable named agents only.`).
- **`packages/sdk/plugins/system/...`** — search for any system-agent prompt or skill that mentions `list_agents` and update.
- **`packages/sdk/dist/worker.js`** — auto-rebuilt.
- **Examples / docs / READMEs** — search for `list_agents` and update where the intent is "PilotSwarm blueprints" (leave references that mean the Copilot built-in alone).
- **CHANGELOG / migration note** — call out the rename so downstream apps update any explicit `tools: - list_agents` declarations in their agent YAMLs.

### Backward-compatibility option (optional, recommended)

Register **both** names for one minor version, with `list_agents` marked deprecated and emitting a one-time warning, then drop `list_agents` next minor. This avoids a hard break for downstream agents that already declared `tools: - list_agents`.

```ts
const blueprint = defineTool("list_ps_agents", { /* ... */ });
const legacy = defineTool("list_agents", {
    overridesBuiltInTool: true,            // required by SDK 1.0.32+
    description: "DEPRECATED — use list_ps_agents instead. " + blueprint.description,
    parameters: blueprint.parameters,
    handler: blueprint.handler,
});
this.registerTools([blueprint, legacy]);
```

This is the only situation where `overridesBuiltInTool: true` is acceptable — temporary, advertised, with a removal date.

## Impact on downstream apps

Known callers in one downstream repo:

- Agent YAMLs that declare `tools: - list_agents` in their tool list.
- Agent prompts that mention `list_agents` in prose.

These will need a one-line search/replace once the rename ships.

## Verification

After the rename + dist rebuild + `npm publish`:

1. A fresh worker boot should register `list_ps_agents` without a conflict warning.
2. The Copilot SDK's built-in `list_agents` should still be callable from any agent and return the runtime background-agent list.
3. Existing PilotSwarm sessions that previously failed every turn with `External tool "list_agents" conflicts with...` should resume normal operation.
4. Spot-check the `pilotswarm` mgmt agent's "Agent discovery" flow ends up calling `list_ps_agents` after the prompt update.

## Related

- Companion bug: a custom **`web_fetch`** in Waldemort's `tools.js` collided with the same SDK's new built-in `web_fetch`. That one we resolved by deleting the custom tool — the SDK built-in is strictly better (markdown conversion, pagination). No similar shortcut exists for `list_agents` because the two implementations describe different things; deletion would lose the blueprint discovery.
- See also [`runTurn-session-not-found-infinite-retry.md`](./runTurn-session-not-found-infinite-retry.md) — `Connection is closed` errors observed concurrently are downstream of failed registrations, not a separate bug.
