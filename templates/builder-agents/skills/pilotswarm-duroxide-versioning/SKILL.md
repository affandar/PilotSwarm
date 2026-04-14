---
name: pilotswarm-duroxide-versioning
description: "Use when changing PilotSwarm durable orchestration behavior, continue-as-new state, or replay-sensitive control flow."
---

# PilotSwarm Duroxide Versioning

PilotSwarm durable orchestrations replay from history. Treat every orchestration change as a wire-compatibility problem, not just a code diff.

## Rules

1. Freeze old orchestration behavior in `packages/sdk/src/orchestration_<version>.ts`.
2. Keep the canonical latest target in the shared version constant, and use that constant for all new starts and all `continueAsNewVersioned(...)` calls.
3. Stamp the source orchestration version into the carried input so the target version can normalize or branch on legacy state if needed.
4. Treat the `OrchestrationInput` payload as a durable wire format. Every new latest version must accept and normalize input snapshots from the oldest orchestration version that is still registered in the codebase.
5. Backward compatibility is behavioral, not only syntactic:
   - Deserializing the old shape is not enough.
   - If version `N` can `continueAsNew` from state point `X`, version `N+1` must behave correctly when resumed from `X`.
   - If `N+1` only works when resumed from a new point `Y`, that is a versioning bug unless the older path stays on the old handler.
6. If replay behavior, yield order, timer semantics, KV usage, command routing, or `continueAsNew` state changes, treat it as a new orchestration version even when the diff is small.
7. Add tests for both:
   - the version target (`continueAsNew` upgrades to latest as intended)
   - the compatibility path (older carried input still resumes correctly)
8. When you add a new orchestration version, update the version-upgrade test suite too. In particular, keep `packages/sdk/test/local/orchestration-version-upgrade.test.js` aligned so it still exercises upgrade from the last three frozen versions into the latest version.

## Checklist

- Shared latest version constant updated
- New latest handler added and registry wired
- Frozen handlers still replay-safe
- Oldest registered input shape still normalized by latest
- Source orchestration version carried in input
- Local tests cover at least one frozen-to-latest handoff
- `packages/sdk/test/local/orchestration-version-upgrade.test.js` updated for the new latest version and the rolling last-three compatibility matrix
