# Paused at the user's request — 2026-09-08

## Resumed work (supersedes the pause and unfinished-verifier notes below)

The user resumed with: add the durable-child filesystem boundary test and design
feature flighting. That work is now implemented/documented:

- Prompt `1.21.0` clarifies that native sharing applies only to the immediate
  parent. Before this fix, both live Terra parent/sibling cases incorrectly used
  the producer's path. Afterward both passed twice (4/4).
- Added `native-durable-filesystem.test.js` with four credential-free real CLI
  tests and two opt-in model cases; byte transfer and actual native checksum are
  verified. Results are in `durable-filesystem-results-2026-09-08.json`.
- Full actual local spawn also passed: root
  `25bc9f77-e785-43b5-b26b-270b015880a8`, child
  `7f9404d6-ec2b-43dc-a2b6-90c0ada75b6f`, downloaded artifact then native checksum,
  child completed. Run `node scripts/smoke-durable-filesystem.mjs` to repeat.
- The pending native smoke-verifier hardening and tests are complete. Unified
  suite: 168 Node + 67 SDK checks passed; live model cases are opt-in. SDK build
  passed. Design/test adversarial review addressed the concrete findings.
- Fresh native sharing run `6a4edae7-973c-49a5-a53b-0b68d5bfda47` completed all
  four real file phases. Its first verdict rejected a harmless `read_agent`
  status lookup; after allowing read-only inspection, independently rechecking
  disk receipts and probe integrity passed. Original failure/cleanup is preserved
  beside `.tmp/native-filesystem-bOgKdZ/reviewed-result.json`; cleanup cancelled
  the root after the successful child execution.
- The durable-boundary root above later emitted empty-response retries on
  subsequent wakes, then recovered to `idle`. Similar behavior was recorded
  before this prompt change. The file proof passed; ongoing root coordination
  health is not claimed, and the retry issue remains unresolved.
- Local launcher now aligns portal and worker artifact stores with
  `ARTIFACT_DIR=.tmp/native-subagents/copilot/artifacts`. Server restarted with
  current prompt and left running on port 3017. It loads credentials privately as before.
- `docs/proposals/feature-flighting.md` is a design only, updated to the user's
  latest model: code-defined flags, cluster enabled + allowUserOverride, and user
  preferences. Admins manage cluster/any user; users manage themselves. Includes
  MCP/Web/mgmt parity, Resource Manager and admin Agent Smith tools, and a user
  Feature flags tab. CHK initially enables the requester; override-enabled users
  can also opt themselves in. Workers will cache flags via the existing package/
  heartbeat poll (20s default), reading per-feature catalog revisions.
  The latest schema is two tables: code-published `feature_flags` and unified
  cluster/user `feature_flag_settings`, reusing existing audit only. Feature
  changes increment `feature_flags.revision`; there is no feature directive row.
  Runtime `resolve(key, owner, options)` requires either `{ fallback: boolean }`
  or `{ required: true }`. Missing/unresolvable flags follow that explicit choice;
  missing settings inherit normally. Native admission chooses fallback false.
  The design includes exact proposed routes, code sketch, native rollout plan
  and an explicit in-flight ON/OFF round-trip test matrix. That matrix is planned,
  not existing coverage. No per-turn/task flag DB reads; no feature flags or CHK
  deployment applied.
- The old broad routing sweep remains partial; it was not resumed under the
  narrower current request. Historical details below describe the earlier pause.
- Companion Question-card fix (2026-09-09): normalize escaped newlines only for
  display, preserving code/path literals and stored question/answer identities.
  Covers pending, optimistic answered and durable answered cards in both renderers.
  All 695 UI tests and the new built-browser layout test passed. Localhost serves
  the rebuilt bundle; no Waldemort deployment. Feature flags remain design-only.
- Companion mixed-chat fix (2026-09-09): the released 0.5.62/0.5.63 chat-call
  renderer passed escaped-newline previews through generic line splitting,
  duplicating React call keys. A browser reproduction showed one `ask_user`
  becoming six rows, with five surviving above another session's splash.
  Preserve `chatCall` and `callPreview` records intact in `normalizeLines`.
  Release-based branch `codex/chat-call-session-isolation`, commit `6668bcdb`,
  contains the fix and two permanent browser regression tests. Those tests failed
  before the fix and pass afterward; all seven targeted browser tests passed,
  including live updates, reloads, MoA and mobile/theme layouts. Worktree:
  `/Users/affandar/workshop/drox/pilotswarm.worktrees/chat-call-session-isolation`.
  This older spike does not yet contain the upstream chat-call feature; it now
  carries the identical guard for integration. Its 695 UI tests and web build
  pass. Localhost 3017 serves the rebuilt spike; no Waldemort deployment.

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

## Additional work requested for when the user returns

Implementation remains paused. Do not start these items, deploy, or schedule
background work until the user resumes.

1. **Durable subagents understand their filesystem boundary while native tasks
   are enabled.** Add a companion live model test proving that durable children
   do not assume they share their parent's or sibling durable session's files.
   They should arrange source/artifact access, while recognizing that their own
   native tasks do share their local files. Exercise separate worker locations or
   isolated working directories so accidental colocation cannot hide a mistaken
   assumption. Assert actual transfer/access behavior as well as model choices;
   a correct explanatory sentence alone is insufficient. Keep deterministic
   regression coverage alongside the live Terra test.

2. **Admin-managed feature flighting.** Build a general facility to enable or
   disable a feature fleet-wide or for particular users. Admins manage it; the
   main root system session should be able to help set, clear, and unset flights
   through properly authorized tools. Portal and workers must resolve the same
   effective feature setting for that user's sessions, including durable children.
   Define enable/disable/unset inheritance and precedence explicitly, and cover
   authorization, persistence, propagation/caching, and session reconfiguration.
   These details need design against the existing system, not assumptions made
   while paused.

   First intended flight: enable native Copilot tasks **only for this user** to
   test in the **Waldemort CHK subscription**. Resolve the actual authenticated
   user and deployment before applying it; do not invent a user ID or conflate
   this target with localhost or another subscription. Other users should retain
   the disabled default. This records requested work; nothing has been deployed.

## Shutdown and restart details

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
