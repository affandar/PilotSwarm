---
name: agent-versioning
description: Use when creating or editing PilotSwarm .agent.md files, prompt-layer manifests, or builder templates that generate agents. Covers schemaVersion/version frontmatter, SemVer bump guidance, and session.prompt_layers expectations.
---

# Agent Versioning

Use this skill whenever you create or update PilotSwarm agent definitions in `agents/*.agent.md`, embedded agents under `packages/sdk/plugins/**/agents/`, or builder templates that generate agent files.

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
- `version` is a string. PilotSwarm-authored agents use SemVer. App authors may use any non-empty string, but SemVer is recommended.

## When To Bump `version`

For PilotSwarm-authored agents and templates, bump `version` whenever you change prompt behavior, tool expectations, workflow guidance, frontmatter metadata, or output/contract expectations.

Use SemVer intent:

- Patch: wording clarifications or typo fixes that should not materially change behavior.
- Minor: new capabilities, tools, guidance, examples, or backwards-compatible workflow behavior.
- Major: changed role semantics, removed expectations, or incompatible output/contract changes.

If you only move a file without changing prompt behavior or metadata, a version bump is not required.

## Builder Templates

When a builder agent creates a new app agent, it should include `schemaVersion: 1` and `version: 1.0.0` by default.

When it edits an existing app `.agent.md`, it should update the `version` string according to the change. If the existing app uses non-SemVer labels, preserve the user's style unless they ask to migrate.

## Prompt Layers

PilotSwarm prompt-layer manifests have three authored layers:

```text
PilotSwarm base -> App base -> Agent
```

Runtime context is not an agent layer; runtime behavior is tracked through orchestration version and session/runtime metadata.

`session.prompt_layers` records the effective layer names, types, schema versions, and versions used by the worker that created or resumed the Copilot session. During rolling deploys, absence of the event means legacy/unreported, and old workers may report old loaded versions until restarted.
