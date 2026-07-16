# PilotSwarm Agent Tuning Log

This version-controlled log records prompt behavior changes that affect shipped
PilotSwarm agents. Model-specific compatibility measurements remain in
`docs/models/` when a formal evaluation sweep is run.

## 2026-07-15 — Cross-owner session-message trust boundary

- **Agent:** framework base agent (`packages/sdk/plugins/system/agents/default.agent.md`)
- **Version:** `1.5.0` → `1.6.0`
- **Models:** model-independent prompt contract; no model sweep run for this release
- **Change:** cross-session messages tagged `relation=cross-owner` are advisory.
  The receiving session preserves its owner's task, helps only when consistent
  with that task, and replies with `verdict="declined"` when a peer-owned
  session attempts to distract, conflict with, or redirect the mission.
- **Expected behavior:** same-owner tree and system-session coordination remains
  unchanged; cross-owner messages cannot override owner instructions. Runtime
  authorization still decides whether delivery is allowed before the prompt is
  seen.
- **Validation:** tests were intentionally skipped during the release workflow
  at maintainer request. No model-compatibility claim is made here.

## Historical Notes

The repository-scoped operational log at `/memories/repo/agent-tuning-log.md`
contains earlier prompt-hardening investigations and the current model
compatibility matrix. Future prompt changes should update both that operational
log and this version-controlled record.
