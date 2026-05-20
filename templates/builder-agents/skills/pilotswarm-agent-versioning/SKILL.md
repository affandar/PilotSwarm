---
name: pilotswarm-agent-versioning
description: Use when creating or editing PilotSwarm app agents in agents/*.agent.md. Covers schemaVersion/version frontmatter, version bump guidance, and prompt layer version visibility.
---

# PilotSwarm Agent Versioning

Use this skill when scaffolding or editing app agent definitions for a PilotSwarm-based application.

## Required Frontmatter

Every authored `.agent.md` should include:

```yaml
---
schemaVersion: 1
version: 1.0.0
name: example-agent
description: Example agent.
---
```

- `schemaVersion` is the PilotSwarm agent schema version. Use `1` until the schema changes.
- `version` is a string. SemVer is recommended because it is easy for operators and agents to compare, but app authors may use another non-empty label.

## Creating Agents

When creating a new app agent, start with:

```yaml
schemaVersion: 1
version: 1.0.0
```

## Editing Agents

When modifying an existing `.agent.md`, update the `version` string when the change affects prompt behavior, tool expectations, workflow guidance, frontmatter metadata, output shape, or child-contract expectations.

Use SemVer intent when the app uses SemVer:

- Patch: wording clarifications or typo fixes that should not materially change behavior.
- Minor: new capabilities, tools, guidance, examples, or backwards-compatible workflow behavior.
- Major: changed role semantics, removed expectations, or incompatible output/contract changes.

If the existing app uses non-SemVer version labels, preserve that style unless the user asks to migrate.

## Prompt Layer Visibility

PilotSwarm reports authored prompt layers as:

```text
PilotSwarm base -> App base -> Agent
```

The Activity Monitor can display `session.prompt_layers` so operators can see the layer kind, name, type, schema version, and version used by the worker that created or resumed a session.
