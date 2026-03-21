# Perf Agent Memory

This file is maintained by the canonical spawn perf runner and the repo-local `pilotswarm-perf` agent in [.github/agents/pilotswarm-perf.agent.md](/Users/affandar/workshop/drox/pilotswarm/.github/agents/pilotswarm-perf.agent.md).

The runner rewrites this file after every canonical spawn perf run so the latest numbers, findings, and next steps stay in-repo.

## Current Scope

- Canonical perf surface: SDK sub-agent spawn performance.
- Canonical runner: `npm run perf:spawn`
- Canonical generated outputs:
  - `perf/reports/spawn/latest.json`
  - `perf/reports/spawn/latest.md`
  - `perf/reports/spawn/history/index.json`

## Latest Confirmed Run

- Status: Passed
- Command: `npm run perf:spawn`
- Timestamp: 2026-03-21T17:27:49.153Z
- Git commit: 884a139d3a074a689ccfcaae068cec23309501db
- Git branch: main
- Dirty worktree: yes
- Suite duration: 61720 ms
- Latest report: `perf/reports/spawn/history/2026-03-21T17-27-49-153Z.md`
- Latest metrics: `perf/reports/spawn/latest.json`

## Recent Run History

- 2026-03-21T17:27:49.153Z | 884a139 | single: 9447 ms | sequential total: 21226 ms | same-turn fanout: 13404 ms
- 2026-03-21T17:26:08.508Z | 884a139 | single: 10475 ms | sequential total: 23195 ms | same-turn fanout: 13013 ms

## Confirmed Findings

- Single spawn baseline: parent turn 9447 ms; first child visible at 6070 ms and started at 6070 ms.
- Three children in one parent turn completed 7822 ms faster than three sequential parent turns (36.9% improvement in total parent time).
- Sequential turn 1 was 3928 ms slower than the average of turns 2 and 3, which suggests a meaningful first-spawn cold-start penalty.
- In same-turn fanout, children became visible within 102 ms and started within 102 ms once creation began.

## Active Hypotheses

- The current activity-mediated child creation path is still likely adding overhead before the child orchestration begins useful work.
- Same-turn multi-spawn requests are likely leaving time on the table because child creation is still replayed sequentially instead of being batched or fanned out in parallel.

## Next Steps

- Instrument the spawn path more finely to separate parent orchestration replay time, activity dispatch time, child bootstrap time, and child orchestration start time.
- Prototype direct fire-and-forget child orchestration starts from the parent orchestration and rerun `npm run perf:spawn`.
- Prototype batched or parallel handling for same-turn multiple `spawn_agent` calls and compare the new same-turn fanout numbers against the current baseline.

## Open Questions

- How much of the first-spawn penalty is in orchestration replay and activity dispatch versus child-side bootstrap work?
- How much same-turn fanout improvement is available once child creation is actually parallelized?
