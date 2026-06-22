---
schemaVersion: 1
version: 1.0.0
name: default
description: OBO live-smoke default overlay — declares the smoke tools as app-tier defaults so they are inherited by every chat session of a `--variant smoke` worker build.
tools:
  - obo_smoke_whoami
  - obo_smoke_force_reauth
---

# OBO Smoke Default Overlay

This overlay ships only with the `--variant smoke` worker image, where the OBO
smoke plugin is mounted via `PLUGIN_DIRS=/app/packages/obo-smoke-plugin`.

It exists for one reason: to **declare the names of the smoke tools** so the
worker can inherit them into every chat session via the canonical
`appDefaultToolNames` path
(`SessionManager#runTurn` → `frameworkBaseToolNames ∪ appDefaultToolNames ∪ session.toolNames`).

Without this overlay, `worker.registerTools(buildOboSmokeTools(...))` would
register the **handlers** but no overlay would **claim the names**, so the
LLM would never see `obo_smoke_whoami` or `obo_smoke_force_reauth` in its
toolset. Plugin authors shipping in-process tools must always pair their
`plugin.json.tools` handler module with an overlay (this file, an
`*.agent.md`, or a skill `tools.json`) that names those tools.

## Visibility scope

- Chat sessions on a `--variant smoke` worker inherit both tools.
- Management/system agents (`pilotswarm`, `sweeper`, `resourcemgr`, …) are
  unaffected — they curate their own tool surface via their own
  `.agent.md` frontmatter and do not inherit the app overlay.
- Default-build workers do not load this plugin and therefore never see
  the overlay.

## Collision caveat

If a stamp loads both this plugin and another app-tier plugin that also
ships an `agents/default.agent.md`, the agent loader's "later tier wins"
rule will collapse them to a single overlay. Smoke builds intentionally
ship without any other app-tier overlay, so this is acceptable for the
release-gate use case but would be a constraint to revisit if smoke ever
needs to co-exist with a real app overlay.
