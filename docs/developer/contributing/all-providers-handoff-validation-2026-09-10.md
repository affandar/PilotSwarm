# Parent/child handoff: all-provider validation, 2026-09-10

Status: the verified Duroxide 0.1.29 run was stopped at the user's request to fix
the separately investigated child-cleanup wakeup issue first. PostgreSQL finished
with one failure; HorizonDB was interrupted before its SDK pass. The initial
two full runs used an unexpectedly linked Duroxide 0.1.27 installation and do
**not** validate the declared 0.1.29 runtime.

## Source and environment

- Worktree: `pilotswarm.worktrees/agent-handoff-hardening`, branch
  `codex/agent-handoff-hardening`, based on `37e9ec99`, with the uncommitted
  named-agent discovery/selection and parent/child handoff changes.
- Node 24.20.0; Copilot SDK 1.0.13; Copilot CLI 1.0.83.
- `packages/sdk/package.json` and the lockfile require Duroxide 0.1.29. Runtime
  resolution from the SDK instead reached the other checkout's 0.1.27 package
  and Darwin ARM64 binary. These were the only installed-package version
  mismatches found against this worktree's lockfile.
- After the second run and owned cleanup finished, the worktree's dependency
  links were preserved under `.tmp/node_modules-before-runtime029`. A fresh
  `npm ci --ignore-scripts --no-audit --no-fund` installed independent dependencies;
  all 657 installed package versions match the lockfile. No manifest or lockfile
  change was necessary, and the other checkout's dependencies were not changed.
- Duroxide 0.1.29 and its native binary match the lockfile integrity hashes and
  load successfully. The actual SDK runtime reports version 1.0.83, protocol 3.
  Runtime checks are recorded before and after installation.
- Runtime/CMS PostgreSQL is the local Docker test database. HorizonDB uses the
  configured test connection and isolated per-test schemas. No production
  deployment or production session changes are part of this validation.

`--all-providers` means the repository's PostgreSQL and HorizonDB **storage
provider** gate. Live SDK cases use the configured GitHub Copilot credential,
including GPT/Claude model calls. Protocol fixtures also cover provider shapes;
this does not claim a live test through every external LLM vendor credential.

## Runner changes made during validation

`PS_TEST_SKIP_STALE_CLEANUP=1` disables only the global pre/post stale-schema
sweep. It is necessary on a shared test provider because that sweep could act
on pre-existing runs. Individual test cleanup remains enabled. A functional
shell test verifies the default two sweeps, opted-out zero sweeps, and that the
flag guards only the cleanup function. The default runner behavior is unchanged.

Two stale assertions were corrected after the first run:

1. The default LLM-visible tool catalog now includes the intentionally admitted
   `ps_list_agents` discovery tool. Low-level always-on-tool expectations were
   kept separate; default, named, and system-session admission is asserted.
2. A base-prompt version-string assertion was replaced with checks for the
   actual static/published discovery and exact-name-plus-assignment guidance.

The focused catalog check passed 3/3. The cron-contract and system lifecycle
diagnostic passed 13/13; that diagnostic overlapped the original full runner and
is not an additional full gate. No runtime recovery behavior or test timeouts
were changed to make failures pass.

## Earlier-runtime runs: retained evidence

Both commands used a private `HORIZONDB_ENV_FILE` and
`PS_TEST_SKIP_STALE_CLEANUP=1`.

| Run | SDK phase | Passed | Failed | Skipped |
| --- | --- | ---: | ---: | ---: |
| Initial `--all-providers`, 8 files in parallel | PostgreSQL | 1,880 | 3 | 17 |
| Initial `--all-providers`, 8 files in parallel | HorizonDB | 1,889 | 7 | 4 |
| Fresh `--all-providers`, 4 files in parallel | PostgreSQL | 1,882 | 1 | 17 |
| Fresh `--all-providers`, 4 files in parallel | HorizonDB | 1,895 | 1 | 4 |

The initial PostgreSQL failures were the two stale assertions above and a
system-agent descendant-link teardown timeout. The seven HorizonDB failures
were timeouts in concurrent model sessions, missing-state replay, graceful
restart, deleted-local-state recovery, double crash, title preservation after
summarization, and child metadata/teardown. Some teardown failures occurred
after the functional assertions had succeeded; that still counts as failure.

All eight timeout cases then passed in one sequential diagnostic, without
reported retries or longer timeouts: 8 passed, 60 deliberately filtered out,
7 files, 732.93 seconds. Those 60 exclusions belong only to the diagnostic.
Neither full gate has a test-name filter or newly introduced skips.

The fresh PostgreSQL run still failed
`session-failures.test.js > recovers missing resumable-state sessions via lossy replay`:
the resumed message exceeded its 60-second response deadline at
`test/local/session-failures.test.js:88`. Standalone success did not resolve this
failure. HorizonDB failed `system-agents.test.js > Child Agent CMS Metadata`
at its 180-second outer deadline. The second combined gate returned FAIL, with
one failure in each provider. Reducing cross-file concurrency was a diagnostic
choice, not proof of the cause. The later dependency mismatch also prevents
treating these runs as validation of the intended runtime.

## Gate scope and exclusions

Each full provider phase also runs the builds, 250 deployment tests, 896 SDK
unit tests, app node suites of 22 + 141 + 781 tests, and six MCP unit scripts.
These stages passed in both earlier-runtime runs. Do not add their repeated
executions into a misleading unique-test total.

The dedicated HorizonDB storage suite passed 149/149 tests across 18 files with
zero skips in both earlier-runtime runs. The 116-case SDK/CLI parent/child
handoff matrix passed under both providers in the initial run and in the fresh
run's completed phases. The final pinned-runtime result will be recorded below.

The normal full SDK matrix contains 1,900 tests per provider:

- PostgreSQL skips 13 conditional Horizon-only cases (composition and fact
  provider selection), plus the four environment-dependent cases below.
- Both phases skip one opt-in dehydration case (`PS_ENABLE_LIVE_DEHYDRATE_TESTS`),
  two opt-in Terra filesystem-boundary choices (`PILOTSWARM_LIVE_MODEL_TESTS`),
  and one Azure blob conformance case without its remote storage credentials.
- Some cross-provider model cases also log an early return when no secondary
  provider target is configured. Those are not included in Vitest's skipped
  count and must not be treated as live cross-provider validation.
- No exclusions were added in response to failures. Earlier named-selection
  model evaluations are documented separately in `docs/models/native-delegation-testing.md`.

## Pinned-runtime result

Running with the lockfile-matching Duroxide 0.1.29 package and native binary,
four cross-file workers, and unchanged test assertions/timeouts/internal
concurrency cases:

```sh
PS_TEST_MAX_WORKERS=4 PS_TEST_SKIP_STALE_CLEANUP=1 \
HORIZONDB_ENV_FILE=/tmp/pilotswarm-all-providers-handoff-1446e372/horizondb-runtime029.env \
./scripts/run-tests.sh --all-providers
```

There are no test-name filters. This additional run is required by the newly
discovered dependency mismatch, rather than another attempt to dismiss a
failing result. Its runtime and data namespaces are separated from the earlier
attempts. Do not infer that the runtime version caused the previous timeouts.

The PostgreSQL SDK phase finished with 1,882 passed, one failed, and 17 skipped
(206 files passed, one failed, three skipped). The failure remains the missing
resumable-state recovery response deadline in `session-failures.test.js`. The
correct dependency install did not resolve it. HorizonDB was interrupted at the
start of its storage integration suite on September 10 at 23:26 PDT; no HorizonDB
SDK result was produced. Treat this run as incomplete, not as a passing gate or
an observed HorizonDB regression.

## Isolation and evidence

Global cleanup is opted out. Tests own their randomized schemas. The first
runner additionally owns exactly these fallback namespaces:
`ps_test_allprov_7b3e7c2d_facts`, `ps_test_allprov_7b3e7c2d_graph`, and
`ps_test_allprov_7b3e7c2d_registry`. Cleanup matches those literal names and their
literal embedding-job labels, verifies no active owned jobs, then removes only
those namespaces. Original-run and sequential-diagnostic cleanup both verified
zero remaining owned namespaces and zero active owned jobs. Cleanup after the
second full run verified the same. No wildcard cleanup of other users' or
earlier runs' schemas was performed.

The pinned-runtime run owns `ps_test_allprov_029_822fd931_facts`,
`ps_test_allprov_029_822fd931_graph`, and
`ps_test_allprov_029_822fd931_registry`, with the same exact-name cleanup rule.
Cleanup after interruption verified zero remaining owned namespaces and zero
active owned jobs. The full provider pass remains stopped until the cleanup
wakeup fix is ready for validation.

Local evidence is in `/tmp/pilotswarm-all-providers-handoff-1446e372/`:

- `all-providers.log`, `original-base.sdk.json`, `original-horizondb.sdk.json`:
  original full failure.
- `isolated-failures.log`, `isolated-failures.sdk.json`: eight-case diagnostic.
- `final-all-providers.log`: second full run, subsequently identified as using
  the older linked runtime.
- `second-base.sdk.json`, `second-horizondb.sdk.json`: its complete SDK results.
- `runtime029-all-providers.log`: correctly pinned full run.
- `runtime029-base.sdk.json`: completed PostgreSQL phase before interruption.
- `runtime-audit-before.json`, `runtime-audit-after.json`, `sdk-runtime-audit.json`:
  installed-package and actual SDK runtime checks.
- `owned-cleanup-after-original.log`, `owned-cleanup-after-isolated.log`,
  `owned-cleanup-after-second.log`, `owned-cleanup-after-runtime029.log`:
  exact-namespace cleanup verification.

The temporary provider overlay contains credentials and must not be committed
or reproduced in this report. Remove it after the final run and owned cleanup.
