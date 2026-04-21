# Bug: named-agent config changes do not refresh for live sessions

**Status:** Open  
**Filed:** 2026-04-21  
**Component:** `@pilotswarm/sdk` durable session orchestration + named-agent config binding  
**Severity:** Medium for correctness, High for operator ergonomics in long-lived agent workflows

## Symptom

When a named agent's definition changes after a session has already been created, the live durable session continues using the old bound config.

Observed stale config surfaces include at least:

- `toolNames`
- agent prompt behavior implied by the old binding
- any runtime behavior that depends on the original agent definition captured at session creation

In practice, adding new tools to an existing named agent does **not** make them available to already-running sessions after ordinary resume paths such as:

- continue-as-new
- dehydration / rehydration
- timer wake-up
- fresh worker replay against the existing durable session

The downstream workaround is to delete and recreate the agent session.

## Concrete downstream reproduction

Observed in a downstream app vendoring PilotSwarm locally.

Named agent: `r2d-watcher`

The agent definition was updated to declare new tools:

- `collect_r2d_work_item_evidence`
- `analyze_pr_repo_context`

Those tools existed in the worker tool registry and were present in the agent markdown, but an already-existing long-lived `r2d-watcher` session kept the old bound `toolNames` set and did not receive the newly declared tools.

The session only picked up the change after dropping and recreating the session.

## Why this is a bug

PilotSwarm already has durable orchestration versioning, but named-agent configuration appears to behave as if it were immutable session bootstrap state with no explicit config-version contract.

That is a poor fit for long-lived named agents because:

1. Operators expect agent-definition changes to either apply explicitly on resume or be rejected as stale.
2. Silent staleness is hard to diagnose. The session looks healthy, but its capabilities do not match the current agent definition.
3. It pushes downstream apps toward ad hoc workarounds such as merging current tool names into old session config at runtime, which hides the real lifecycle problem instead of solving it.

## Current behavior

At top-level named session creation time, the orchestration resolves the agent definition and merges the agent's declared `tools` into the session config.

But that merge happens only for the initial top-level creation path, not as a deliberate agent-config refresh mechanism across later orchestration resumes.

As a result, old sessions continue running with whatever named-agent config snapshot they started with.

## Expected behavior

PilotSwarm should have an explicit named-agent versioning / refresh mechanism.

Reasonable options include:

1. Persist an `agentConfigVersion` or content digest alongside the session's bound agent metadata.
2. On resume, compare the persisted version/digest with the current resolved agent definition.
3. If the definition changed, apply a deliberate refresh policy rather than silently reusing stale config.

Possible refresh policies:

- automatically rebind safe fields such as `toolNames`
- recreate the Copilot session with the new agent config
- emit a system event that the session's bound agent definition changed and was refreshed
- mark the session as requiring recreation if the change is not safely reloadable

The important point is that the behavior should be **intentional and versioned**, not an implicit side effect or a downstream patch that re-merges current tools into old config on every orchestration start.

## Non-goal

This report is **not** asking for a quick downstream workaround in an app repo.

Specifically, blindly refreshing `toolNames` on every orchestration start is not the right long-term fix because it:

- changes behavior without a declared agent-config lifecycle
- solves only one field (`toolNames`) rather than the broader named-agent binding problem
- makes it harder to reason about what parts of a live session are durable snapshot state versus current agent definition

## Minimal reproduction

1. Create a named-agent session for an agent with tools `[A, B]`.
2. Let the session survive long enough to resume through continue-as-new or dehydrate/rehydrate.
3. Update the agent definition to `[A, B, C]`.
4. Resume the existing session.
5. Observe that tool `C` is still unavailable in the existing session.
6. Drop and recreate the session.
7. Observe that tool `C` is now present.

## Workaround

For now, downstream apps can drop and recreate the named-agent session to pick up the changed definition.

That workaround is acceptable operationally, but the stale-config behavior should still be fixed in PilotSwarm itself.

## Suggested follow-up

1. Define which parts of named-agent config are immutable session bootstrap state versus refreshable state.
2. Add an explicit agent-definition version/digest to durable session metadata.
3. Decide whether refresh should happen automatically, conditionally, or only via explicit orchestration event.
4. Add regression coverage for resumed named-agent sessions after agent-definition changes.