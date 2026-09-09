# Paused at the user's request — 2026-09-08

Worktree: `/Users/affandar/workshop/drox/pilotswarm.worktrees/native-copilot-subagents-spike`
Branch: `codex/native-copilot-subagents-spike`
Previous implementation HEAD: `0664a35b` (inline native tasks and warning positioning).
The original `/Users/affandar/workshop/drox/pilotswarm` checkout has user changes;
do not edit or reset it.

## Objective and decisions

Tune Terra's choice of durable `spawn_agent` versus native `task`. Matching
user-creatable named roles take priority, by exact `agent_name`; discover missing
catalogs, preserve role prompts, and let intake specialists collect their inputs.
Long-lived work and broad scale-out favor durable children. “subagent”, “spawn”,
and “spin off” are strong durable hints, interpreted in context. Explicit native
requests and a requirement to use this exact uncommitted checkout can favor native.
Preserve nested topology: durable child sessions that themselves run native tasks.
The user also explicitly requested filesystem-sharing tests and OFF-mode tests.

No orchestration or data-model changes. Base prompt bumped 1.19.0 → 1.20.0.
Native overlay and base prompt changed; production tool descriptions unchanged.
An old statement that all subagents never share files was corrected: separate
durable sessions cannot assume sharing, but synchronous native tasks share their
immediate parent's cwd and files, including when that parent is a durable child.

## Validated before the last verifier tightening

- SDK build passed.
- `npm run test:native-delegation`: **107 Node tests + 63 SDK tests passed**.
  Log: `.tmp/native-subagents/delegation-suite.log`.
- Four new real SDK/CLI scripted-inference runtime tests passed: bidirectional
  parent/native/native/parent writes with random data; concurrent session cwd
  isolation and warm reuse; OFF across new/warm/cold sessions while durable spawn
  bridge still runs; saved sync→OFF revocation with a fabricated `task` rejected.
- New scorer has 72 adversarial unit tests. Checks named role/discovery/overrides,
  all calls, native policies, OFF, affirmative nested task/contract instructions,
  quotes/negations/title-only false positives. Prose scoring remains heuristic.
- Live real Terra filesystem smoke passed: parent
  `94275b52-7292-419d-86d7-e4e69aab5ae3`, durable child
  `32cddf7c-d26b-42ef-8bac-3d7fdb731ecc` (completed). Native IDs
  `42bd9944-2a22-41c4-9911-18eaec0bbe3f` and
  `ca81fe80-4cea-42be-a8b1-d9d27f7bbf61`.
  Evidence `.tmp/native-filesystem-6jNBMZ/result.json`: prepare seq10595,
  native-one10659, native-two10724, verify10769. All actual commands exited0,
  same cwd, one durable turn, parent closed child. Final disk hash
  `fab156b13a704d64502da961c90c8e43036532c7416bee08ac8641294ba651cb`.
  **At shutdown this parent later showed status `error`; investigate why before
  claiming its whole lifecycle stayed healthy.** Child/file proof already exists.
- Earlier topology smoke `58ace7e9-de60-4784-ad20-318355896ba0` created two
  durable children, each used one native view, correct results, children closed.
- Visible tuning session `77d07e33-0949-4506-8591-6f76b4d0d362` remains available.

## Final live routing comparison was interrupted for shutdown

Files in `.tmp/native-subagents/`:

- `delegation-baseline-v3.json`: completed **20/22**, prompts from0664a35b,
  same current runtime/tool schemas. Failures: long-local-boundary chose native;
  generic-short-fanout chose native/background despite durable hint.
- `delegation-off-v3.json`: completed **8/8**, native mode OFF. Cases: original
  nested request, overnight, explicit native, follow-up separate, tiny direct,
  named DeepWiki, spin-off-short, specialist discovery.
- `delegation-tuned-v3.json`: **partial**, last observed **27/28** of planned44
  (22cases×2). Stopped during repeat2 after explicit-separate. Inspect the file
  for the exact final persisted count. One failure so far: generic-short-fanout
  chose native for a short local request phrased as “subagents”. Do not report
  44 completed or claim perfect routing. The guidance is not a keyword router.

Exploratory runs with earlier scorer/harness/fixtures remain in `.tmp`; do not
mix their scores with v3. Two fixtures were made concrete after they asked for
unspecified documentation/services. A short generic “couple of agents” case
allows either route. Cases labeled holdout have been inspected during tuning;
this is a regression matrix, not an independent blind holdout or benchmark.

## Unfinished work — current WIP is intentionally not declared green

An adversarial review found smoke-verifier false positives. Immediately before
the user asked to pause, these source changes were applied but **not tested**:

- `scripts/lib/native-filesystem-evidence.mjs`: require sync swarm-task, exactly
  two native starts, successful noncancelled native lifecycle, successful durable
  turn, root executes no shell, phase JSON/cwd matches, independent proof flags.
- `scripts/fixtures/native-filesystem-probe.mjs`: added `verifyDiskProof`, which
  independently re-reads receipt chain and recomputes final hash.
- `scripts/smoke-native-filesystem.mjs`: hashes fixture before/after and calls
  independent disk verification, records proof failures.

**Tests still use the old verifier fixture and need updating.** In particular,
add phase/cwd to shell outputs, proper lifecycle seq/profile/mode/resultType,
and proofVerified/probeUnchanged=true to positive fixtures. Add negative tests
for cancellation, failed durable end, wrong profile/background, extra native
agents/root shell, changed probe, tampered disk receipts and forged final hash.

Review findings still requiring implementation:

1. Require the runner's parent/child settled condition before the five-minute
   deadline. Its loop currently falls through and might pass while root runs.
   Explicit timeout failure should cancel only this test tree.
2. `complete_agent` outer `success:true` can contain a structured inner failure;
   reject that. Child must be completed too (already checked).
3. Reject unexpected child/native shell commands that could manufacture proof,
   correlate exactly the intended successful task lifecycles. Decide conservative
   scope and cover it with mutation tests. Do not claim malicious-code sandboxing.
4. Rerun Node verifier/probe tests, full unified suite if needed, and live smoke
   after fixture changes. Existing smoke evidence predates integrity hashing.
5. Finish/repeat remaining Terra cases; preserve honest stochastic failure data.
6. Write final report + update `docs/agent-tuning-log.md` with actual counts.
   Test guide exists at `docs/models/native-delegation-testing.md`.
7. Final diff/checks, final commit, localhost availability for user testing.

The first smoke failed only because the harness equated SDK `turnId` across
tool rounds. SDK turnId advances per inference; durable activity boundaries are
`session.turn_started` / `session.turn_completed`. This was corrected, tested,
and the next smoke passed. Do not reintroduce the erroneous turnId comparison.

## Shutdown and restart

On pause, SIGTERM sent only to tuning node68392, its CLI68400, and local server
67602 (server CLI67638 is managed by graceful shutdown). Other VS Code/pocketswarm
processes untouched. No running Codex subagent work remains.

Local server launcher: `.tmp/native-subagents/serve.mjs`; starts one worker and
portal3017, native sync, management disabled, named DeepWiki/generic-crawler loaded.
Isolated DB: `pilotswarm_native_subagents_spike`, localhost PostgreSQL55432.
Local secrets are loaded privately from original checkout `.env`; do not print,
copy to git, or expose them. DB/server config and logs live under `.tmp/native-subagents`.

After laptop restart, ensure PostgreSQL55432 is running, then:

```sh
npm run build --workspace=packages/sdk
node .tmp/native-subagents/serve.mjs > .tmp/native-subagents/server.log 2>&1
```

Keep the server command in a persistent exec session. Readiness in server.log.
Use local REST API at `http://127.0.0.1:3017/api/v1`, not remote PilotSwarm MCP
(that targets AKS). Deep links use `/?session=<UUID>`.
Live routing runner uses real model credentials via environment:

```sh
node --env-file=/Users/affandar/workshop/drox/pilotswarm/.env scripts/eval-native-delegation.mjs --cases=long-local-boundary,shared-workspace-build --out=.tmp/native-subagents/resumed-routing.json
node scripts/smoke-native-filesystem.mjs
```

No new Codex task needed. Existing review helpers: named_agents_fix (scorer),
native_task_observer (runtime tests), timeout_investigation (smoke adversarial
review). All finished. Resume in this worktree and preserve this WIP context.
