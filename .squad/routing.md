# Work Routing

How to decide who handles what.

## Routing Table

| Work Type | Route To | Examples |
|-----------|----------|----------|
| Architecture, scope, trade-offs | Ripley | Design decisions, API shape, feature prioritization |
| Code review | Ripley | Review PRs, approve/reject, suggest improvements |
| Runtime features, orchestration, activities | Parker | New TurnResult types, activity implementations, session lifecycle |
| Client/worker API changes | Parker | PilotSwarmClient, PilotSwarmWorker, management client |
| CMS, blob store, model providers | Parker | Schema changes, dehydration logic, provider configs |
| TUI bugs, rendering, layout | Lambert | cli/tui.js fixes, neo-blessed issues, keyboard navigation |
| TUI features, new views, UX | Lambert | New display modes, session tree, markdown rendering |
| CLI arguments, entry point | Lambert | bin/tui.js, argument parsing, env resolution |
| Duroxide integration, determinism | Ash | Nondeterminism errors, yield sequence changes, replay bugs |
| Orchestration versioning | Ash | Version migrations, continueAsNew patterns, duroxide API changes |
| Duroxide SDK updates | Ash | Bumping duroxide version, new duroxide features |
| Integration tests, test infra | Kane | test/sdk.test.js, new test cases, test helpers |
| Stress testing, hardening | Kane | Edge cases, crash recovery tests, concurrent session tests |
| Bug verification | Kane | Reproduce reported bugs, confirm fixes |
| Session logging | Scribe | Automatic — never needs routing |

## Issue Routing

| Label | Action | Who |
|-------|--------|-----|
| `squad` | Triage: analyze issue, assign `squad:{member}` label | Ripley |
| `squad:{name}` | Pick up issue and complete the work | Named member |

## Rules

1. **Eager by default** — spawn all agents who could usefully start work, including anticipatory downstream work.
2. **Scribe always runs** after substantial work, always as `mode: "background"`. Never blocks.
3. **Quick facts → coordinator answers directly.** Don't spawn an agent for "what port does the server run on?"
4. **When two agents could handle it**, pick the one whose domain is the primary concern.
5. **"Team, ..." → fan-out.** Spawn all relevant agents in parallel as `mode: "background"`.
6. **Anticipate downstream work.** If a feature is being built, spawn Kane to write test cases from requirements simultaneously.
7. **Issue-labeled work** — when a `squad:{member}` label is applied to an issue, route to that member. Ripley handles all `squad` (base label) triage.
8. **Duroxide bugs** — if Ash identifies a bug in duroxide itself, do NOT work around it. Report it and fix in duroxide.
