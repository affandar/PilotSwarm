# Proposal: Agent Layer Versioning

> **Status:** Proposal
> **Date:** 2026-05-17
> **Goal:** Give every authored agent layer explicit name, version, and type metadata, and make each running agent aware of the authored layers it is composed from.

---

## Summary

PilotSwarm already has a layered prompt model:

1. PilotSwarm framework base
2. Application `default.agent.md`
3. Active named/system agent prompt

The layers are powerful, but they are not versioned as first-class objects. When behavior changes, operators and agents cannot easily answer:

- Which framework prompt version am I running under?
- Which app default version was layered in?
- Which active agent prompt version is in effect?
- Is the active agent a system agent or an app/user agent?
- Did a behavior change come from the PilotSwarm base, the app base, or the active agent?

This proposal adds version metadata to `.agent.md` frontmatter and injects a compact three-layer manifest into every composed agent prompt:

```text
PilotSwarm base -> App base -> Agent
```

Runtime context is not a separate versioned agent layer. Runtime behavior is already represented by the orchestration version and session/runtime metadata.

---

## Goals

- Make `.agent.md` files declare their schema version and agent content version.
- Version the three authored prompt layers: PilotSwarm base, app base, and active agent.
- Make the running LLM aware of each layer's name, version, and type.
- Preserve the existing prompt precedence model.
- Keep v1 frontmatter simple and compatible with the current agent loader style.
- Provide enough metadata for debugging, support, and future compatibility checks.
- Use orchestration version for generated runtime behavior instead of adding runtime context as a prompt layer version.

---

## Non-Goals

- Full package manager style dependency resolution for agents.
- Multiple active versions of the same named agent in one worker.
- Remote fetching or auto-upgrading agent definitions.
- Making prompts immutable artifacts in v1.
- Changing the precedence order of prompt layers.
- Versioning every runtime overlay as an agent layer.
- Replacing orchestration versioning for runtime behavior.

---

## Agent Frontmatter Schema

Add two required fields for authored `.agent.md` files:

```yaml
---
schemaVersion: 1
version: 1.0.0
name: analyst
description: Analyzes datasets and produces reports.
tools:
  - bash
  - write_artifact
---
```

### Field Reference

| Field | Type | Required | Description |
|---|---|---|---|
| `schemaVersion` | integer | yes | Version of the PilotSwarm `.agent.md` frontmatter schema. Starts at `1`. |
| `version` | string | yes | Version label for this agent definition's prompt and metadata. PilotSwarm/system agents use SemVer, but app authors may use any meaningful string. |
| `name` | string | yes | Existing agent identifier. |
| `description` | string | no | Existing human-readable description. |
| `tools` | string[] | no | Existing tool allow-list. |
| `system` | boolean | no | Existing system-agent flag. |
| `id` | string | no | Existing deterministic system-agent slug. |
| `title` | string | no | Existing display title. |
| `parent` | string | no | Existing parent system-agent slug. |
| `splash` | string | no | Existing UI splash text. |
| `initialPrompt` | string | no | Existing first prompt for system agents. |

`schemaVersion` and `version` should be added to all shipped agents and builder templates. During the migration window, missing fields may warn instead of failing, but new templates should include them immediately.

---

## Why Keep V1 Flat

The current loader uses a small frontmatter parser that handles simple keys, lists, and block scalars. A flat v1 schema avoids adding a YAML parser just to support versioning.

Do this first:

```yaml
schemaVersion: 1
version: 1.0.0
```

Do not start with nested compatibility maps such as:

```yaml
compatibility:
  framework: ">=1.0.0"
```

Those can come later if real compatibility failures appear. V1 should make versions visible and auditable before it tries to solve dependency negotiation.

`version` is intentionally a string, not a runtime-enforced SemVer field. It is in app authors' best interest to use SemVer-like values because they sort and communicate change intent well, but PilotSwarm should not reject values such as `foobar`, `mylatestversion`, or a date-based label. PilotSwarm-authored system agents should always use SemVer.

---

## Prompt Layer Descriptor

Every authored prompt layer should have a normalized descriptor.

```ts
export interface PromptLayerDescriptor {
  layerKind: "pilotswarm_base" | "app_base" | "agent";
  layerId: string;
  name: string;
  type: "system" | "app";
  schemaVersion: string;
  version: string;
  source?: string;
}
```

### Layer Version Sources

| Layer | Version Source |
|---|---|
| PilotSwarm base | `schemaVersion`, `version`, and `name` from embedded system `default.agent.md`; `type: "system"` |
| App base | `schemaVersion`, `version`, and `name` from app `default.agent.md`; `type: "app"` |
| Agent | `schemaVersion`, `version`, `name`, and `system` from active `.agent.md`; `type: "system"` for system agents, otherwise `"app"` |

For authored files, `schemaVersion: 1` becomes `pilotswarm.agent.v1` in the descriptor manifest. The raw integer stays in frontmatter for readability.

---

## Prompt Layer Manifest

When PilotSwarm composes a system prompt, it should include a compact manifest before the layer bodies.

Example:

```text
# PilotSwarm Prompt Layer Manifest
This session is composed from the following instruction layers. Higher-priority layers appear first. Use this manifest for debugging and compatibility awareness; follow the instruction precedence rules in the layer headers.

- pilotswarm_base: pilotswarm:default name=default type=system schema=pilotswarm.agent.v1 version=0.1.30
- app_base: acme-support:default name=default type=app schema=pilotswarm.agent.v1 version=2.4.1
- agent: acme-support:triage name=triage type=app schema=pilotswarm.agent.v1 version=1.8.0
```

Then the existing prompt sections continue as they do today:

```text
# PilotSwarm Framework Instructions
...

# Application Default Instructions
...

# Active Agent Instructions
...
```

The manifest is informational. It does not change precedence. Its job is to let the model and operators name the exact authored prompt stack being used.

---

## Agent Awareness

Each agent should be able to answer questions such as:

- "What agent version are you?"
- "Which app default layer are you using?"
- "Are you a system agent or an app agent?"
- "Did you inherit app instructions?"

The agent should answer from the prompt layer manifest, not by guessing.

This also helps agent-to-agent communication. A parent can ask a child for its layer manifest when diagnosing behavior drift, and the child can report its actual prompt stack.

---

## Behavior By Session Type

### Generic App Session

Manifest includes:

- PilotSwarm base
- app default, if present

There is no `agent` layer unless the session is bound to a named agent.

### Named App Agent Session

Manifest includes:

- PilotSwarm base
- app base
- active app agent

### PilotSwarm Management Agent

Manifest includes:

- PilotSwarm base
- active PilotSwarm management agent

It does not include app default unless the existing management-agent isolation rule changes.

### Spawned Sub-Agent

Manifest includes:

- PilotSwarm base
- app base, if applicable
- active agent, if the child was spawned as a named agent

Sub-agent task context and rehydration context are still present in the composed prompt, but they are runtime context, not authored agent layers. Their behavior is tracked by orchestration/runtime version.

---

## Loader Changes

Files likely touched:

- `packages/sdk/src/agent-loader.ts`
- `packages/sdk/src/prompt-layering.ts`
- worker plugin loading paths

Extend `AgentConfig`:

```ts
export interface AgentConfig {
  name: string;
  description?: string;
  prompt: string;
  tools?: string[] | null;
  schemaVersion?: number;
  version?: string;
  sourcePath?: string;
  // existing fields remain
}
```

The loader should:

1. parse `schemaVersion` and `version`;
2. warn for missing fields during migration;
3. reject unsupported future `schemaVersion` values;
4. attach `sourcePath` for diagnostics when loaded from disk.

---

## Composition Changes

Add a `PromptLayerDescriptor[]` beside the existing prompt text inputs.

```ts
composeSystemPrompt({
  frameworkBase,
  appDefault,
  activeAgentPrompt,
  runtimeContext,
  layerManifest,
})
```

The composer should support both current paths:

- plain string composition through `composeSystemPrompt`
- structured SDK system message composition through `composeStructuredSystemMessage`

For structured SDK system messages, the manifest should be placed in a high-priority section that is visible to the model but still framed as informational metadata. Runtime context continues to render as runtime context, but it is not listed as an agent layer.

---

## Persistence And Observability

The prompt layer manifest should be observable outside the LLM prompt.

V1 should record the manifest as a session event when a session starts or when the active prompt stack changes:

```ts
session.prompt_layers
```

Event data:

```json
{
  "layers": [
    {
      "layerKind": "pilotswarm_base",
      "layerId": "pilotswarm:default",
      "name": "default",
      "type": "system",
      "schemaVersion": "pilotswarm.agent.v1",
      "version": "0.1.30"
    }
  ]
}
```

A later implementation can promote this to first-class CMS columns or management API fields if operators need filtering/reporting by agent version. If promoted, the management client and inspect tools should expose it through the normal observability surface.

Runtime behavior remains observable through existing orchestration version and session status metadata. If a runtime-context template changes in a way that affects durable behavior, that change should follow the normal orchestration versioning workflow instead of inventing a fourth agent layer.

The Activity Monitor window should display `session.prompt_layers` events in a compact operator-friendly form, showing layer kind, name, type, and version. The event stream is the source of truth for v1; the UI should make the latest prompt-layer event easy to inspect without requiring raw event JSON.

### Mixed Worker Versions

Workers load agent files once at process startup. During a rolling rollout, some workers may still have old code or old agent files in memory while newer workers have newer versions.

`session.prompt_layers` must therefore describe the layers used by the worker that actually created or resumed the Copilot session for that turn. It is not a fleet-wide desired-state declaration.

Cases:

| Case | `session.prompt_layers` behavior |
|---|---|
| Old worker without this feature | No `session.prompt_layers` event is emitted. Treat absence as `legacy/unreported`, not as "no layers". |
| New worker with old agent files missing `schemaVersion`/`version` | Emit layers with `schemaVersion: "legacy"` and `version: "unversioned"`, and warn at load time. |
| New worker with old but versioned agent files | Emit the old versions it actually loaded. |
| New worker after restart with updated agent files | Emit the new versions it loaded after restart. |
| Same durable session resumes on a different worker | Emit a new `session.prompt_layers` event if the effective layer versions differ from the latest recorded manifest. |

This means a single durable session can legitimately have multiple `session.prompt_layers` events across its lifetime during a rolling deploy. The latest event tells operators what prompt stack shaped the current live Copilot session; earlier events explain historical turns.

To reduce surprise, the runtime should record `session.prompt_layers` whenever a Copilot session is created or resumed and the manifest differs from the last manifest recorded for that session.

### Inline `customAgents`

Inline custom agents are agents supplied directly in code through `PilotSwarmWorker({ customAgents: [...] })` instead of loaded from `agents/*.agent.md` files. They are useful for tests and programmatic embedding, but they do not naturally have `.agent.md` frontmatter.

For v1, inline custom agents should be represented as app agent layers with:

```json
{
  "layerKind": "agent",
  "layerId": "inline:<name>",
  "name": "<name>",
  "type": "app",
  "schemaVersion": "inline",
  "version": "inline"
}
```

If a future inline custom-agent config adds explicit `schemaVersion` and `version` fields, the manifest can report those values. Authored `.agent.md` files remain the preferred app-agent format.

---

## Compatibility Policy

V1 does not need dependency resolution, but it should establish rules:

- `schemaVersion: 1` is the only accepted authored agent schema at launch.
- Missing `schemaVersion` or `version` warns during migration, then becomes an error in a later release.
- Unsupported `schemaVersion` is an error.
- `version` is any non-empty string. PilotSwarm-authored agents use SemVer by policy; app authors are encouraged but not required to do the same.
- A version change means the agent prompt or metadata changed in a way worth surfacing to operators.

Future schema versions can add optional fields such as:

```yaml
requiresPilotSwarm: ">=0.2.0"
requiresFramework: ">=1.1.0"
```

Do not add these until there is a concrete compatibility check to enforce.

---

## Versioning Guidance For Authors

PilotSwarm-authored agents and templates should use SemVer intent:

- Patch: wording clarifications that should not change behavior materially.
- Minor: new capabilities, tools, guidance, or workflow behavior that is backward-compatible.
- Major: changed role semantics, incompatible output contracts, or removed expectations.

Examples:

- Fix typo in instructions: `1.0.1`
- Add `wakeOn` guidance to child contract examples: `1.1.0`
- Change an agent from chatty status reporting to quiet-by-default behavior: `2.0.0`

App authors may use other version labels, but SemVer is recommended because it makes change intent clear to operators and future agents.

---

## Migration Plan

1. Add `schemaVersion` and `version` to embedded system and management agents.
2. Add the fields to builder-agent templates.
3. Update `agent-loader.ts` to parse and warn on missing fields.
4. Add three-layer `PromptLayerDescriptor` construction in plugin loading / prompt composition code.
5. Inject the prompt layer manifest into composed prompts.
6. Record `session.prompt_layers` events.
7. Update docs for `.agent.md` field reference.
8. Add tests for loader parsing, prompt composition, and session event recording.
9. In a later release, convert missing `schemaVersion`/`version` from warning to error.

---

## Testing Plan

### Loader Tests

- Parses `schemaVersion` and `version` from `.agent.md` frontmatter.
- Warns when either field is missing during migration.
- Rejects unsupported future schema versions.
- Uses `legacy` / `unversioned` placeholders for missing metadata during migration.

### Prompt Composition Tests

- Generic session manifest includes PilotSwarm base and app base.
- Named app agent manifest includes PilotSwarm base, app base, and active agent.
- Management agent manifest excludes app default.
- Spawned sub-agent manifest includes an agent layer only when spawned as a named agent.
- Manifest appears before layer bodies and does not change precedence text.

### Runtime/Management Tests

- Session start records `session.prompt_layers`.
- Prompt layer manifest survives continue-as-new through normal session config propagation.
- Runtime context changes do not add fourth-layer agent descriptors; orchestration version remains the runtime behavior identifier.
- Activity Monitor displays `session.prompt_layers` events with layer kind, name, type, and version.

### Template/Docs Tests

- Embedded agents include `schemaVersion` and `version`.
- Builder templates include `schemaVersion` and `version`.
- Plugin docs list the new fields.

---

## Acceptance Criteria

- Every shipped `.agent.md` declares `schemaVersion` and `version`.
- Every builder template `.agent.md` declares `schemaVersion` and `version`.
- Loaded `AgentConfig` objects carry schema/version metadata.
- Every composed prompt includes a compact layer manifest visible to the LLM.
- The manifest covers PilotSwarm base, app base, and active agent layers as applicable.
- Each manifest layer includes layer kind, name, version, schema version, and `system`/`app` type.
- Agents can answer which layer versions they are composed from.
- Activity Monitor exposes `session.prompt_layers` events without requiring raw event inspection.
- Missing version metadata warns during migration.
- Unsupported future agent schema versions fail fast.
