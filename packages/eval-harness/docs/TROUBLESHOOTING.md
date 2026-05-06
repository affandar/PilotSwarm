# Troubleshooting

Real failure modes seen running this harness, and the fix that makes them go away. Sorted by what you'll hit first.

## "sorry, too many clients already" — Postgres saturation

**Symptom:**

```
error: sorry, too many clients already
  at /…/node_modules/pg-pool/index.js:45:11
```

**Cause:** each LIVE test file opens its own SDK pg pools. With vitest's default `fileParallelism: true`, multiple `*-live.test.ts` files run concurrently and exhaust `max_connections`.

**Fix:** `vitest.config.ts` already forces `fileParallelism: false` when `LIVE=1` is set. If you still hit it:

1. Verify you're not bypassing with `--parallel-files` / `PS_EVAL_FILE_PARALLELISM=1`.
2. Bump Postgres: `ALTER SYSTEM SET max_connections = 500; ALTER SYSTEM SET shared_buffers = '512MB';` then restart the cluster.
3. Kill leaked idle conns from prior crashed runs:

```bash
psql "$DATABASE_URL" -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity \
  WHERE state='idle' AND application_name='' AND pid<>pg_backend_pid();"
```

**Why leaks happen:** when vitest crashes / SIGKILLs mid-run, Node exits without `await pool.end()`. TCP sockets linger in CLOSE_WAIT and Postgres holds the conns until `tcp_keepalives_idle` (default 2h) finally notices.

**Permanent fix:** set server-side reaping (already applied, see `postgresql.auto.conf`):

```sql
ALTER SYSTEM SET idle_session_timeout = '600s';            -- PG 14+
ALTER SYSTEM SET idle_in_transaction_session_timeout = '60s';
ALTER SYSTEM SET tcp_keepalives_idle = 60;
ALTER SYSTEM SET tcp_keepalives_interval = 10;
ALTER SYSTEM SET tcp_keepalives_count = 6;
SELECT pg_reload_conf();
```

## `.env` not loading — vitest doesn't auto-load

**Symptom:** LIVE tests skip because `process.env.GITHUB_TOKEN` is undefined despite being in `.env`.

**Fix:** `vitest.config.ts` now parses the monorepo-root `.env` at config time and merges into `test.env`. Existing process env always wins. If you still see undefined:

- Check `.env` lives at repo root, not at `packages/eval-harness/.env`.
- Quoted values are stripped (`KEY="value"` → `value`). Comments (`# …`) skipped. Lines without `=` skipped.
- Re-export with shell if config-time loading isn't enough for your case (e.g. when a tool runs vitest as a child).

Reference: `packages/eval-harness/.env.example` lists every var the LIVE suites read.

## Judge fails with "PilotSwarmJudgeClient session.error"

**Symptom 1 — telemetry crash:**

```
{"errorType":"query","message":"Execution failed: TypeError: Cannot read properties of undefined (reading 'trim')",
 "stack":"... at TPn ... at t.emitUserMessageSentimentTelemetry ..."}
```

**Cause:** upstream bug in `node_modules/@github/copilot/app.js`. Sentiment telemetry calls `userMessage.trim()` where userMessage is undefined under PilotSwarm's session routing.

**Fix:** `test/setup/patch-copilot-telemetry.ts` patches `n.trim()` → `(n??"").trim()` on disk before any test imports. Idempotent. Re-applies after `npm ci` because node_modules is regenerated.

If you upgrade `@github/copilot` and the patch can't find the marker, the setup logs a warning and continues. Re-grep `app.js` for the new bundle's crash site and update the `BAD` constant in the patch file.

**Symptom 2 — empty response:**

```
PilotSwarmJudgeClient: empty response content
```

**Cause:** judge model didn't follow rubric — returned nothing parseable, or the SDK build emits text via a different event field than the legacy `evt.content`.

**Fix:** judge client already captures from `assistant.message_delta` (multiple shapes) plus terminal `assistant.message`. If you still see this:

- The model genuinely returned nothing (e.g. refused). This is now classified as `JudgeOutputFormatError` → quality fail, not infra.
- Verify `LIVE_JUDGE_MODEL_A` / `LIVE_JUDGE_MODEL_B` resolve in `model-providers.json`.

## "judge response was not valid JSON" — model didn't follow rubric

**Symptom:** `JudgeOutputFormatError: judge response was not valid JSON`.

**Not a bug.** The judge model spent tokens but its output is unparseable. That's quality signal about the *judge* model. Recorded as failing Score with `infraError: false` so quality aggregates count it.

**If you want it to retry:** wrap the client in a retry layer at the call site, OR pick a stronger judge model. Currently the harness fails closed (no silent passes on garbage).

## DB-budget tests fail wildly over budget

**Symptom:**

```
dbQueries.perTurn: observed 47141 > budget 5000
dbQueries.perSpawn: observed 111220 > budget 10000
```

**Two causes — diagnose by re-running serial:**

1. **Parallel pollution:** `pg_stat_statements` is database-global. With `--parallel-files`, every concurrent test file's queries get attributed to the cell under measure. Fixed: budget tests now skip when `PS_EVAL_FILE_PARALLELISM=1` is set.
2. **Real SDK chattiness:** if the test runs serial and still blows budget, the SDK genuinely fires that many queries. That's a PilotSwarm performance signal — report it. Don't silently raise the budget.

`DbTracker.snapshot()` is now scoped to `current_database()` (commit `86bbf1a`), so cross-database pollution from sibling apps on the same Postgres is no longer an issue.

## Peak connections > budget

Same root cause as DB budgets — the test asserts max concurrent conns ≤ budget. Skipped under `PS_EVAL_FILE_PARALLELISM=1`. If it fails serial, the SDK is opening more pools than the budget allows; investigate `cms.ts` / `facts-store.ts` / runtime wiring for unexpected pool fan-out.

## Tests skip silently

**Symptom:** `Tests 0 passed | 8 skipped (8)`.

**Cause:** every LIVE test gates on env vars. Without them set, `it.skip` is used:

| gate combo | needed for |
|---|---|
| `LIVE=1` | every `*-live.test.ts` |
| `LIVE=1 LIVE_JUDGE=1` | judge tests + safety judge cases |
| `LIVE=1 PERF_HEAVY=1` | concurrency profiler |
| `LIVE=1 PERF_DURABILITY=1` | durability perf |
| `LIVE=1 PG_STAT_STATEMENTS_ENABLED=1` | DB-call budget assertions (else they skip) |
| `LIVE=1 PROMPT_TESTING=1` | prompt-testing-live |
| `LIVE=1 + OPENAI_API_KEY` *or* `GITHUB_TOKEN+PS_MODEL_PROVIDERS_PATH` | judge client construction |

Use `bin/run-live.sh --all --prompt-testing` to flip every gate at once.

## `EVAL_REPORTS_DIR` set but no files written

**Cause:** `EvalRunner` only auto-wires `JsonlReporter` when `EVAL_REPORTS_DIR` is non-empty. If you pass an empty string, it's treated as unset.

**Fix:** pass an actual path. Run-live.sh defaults to `.eval-results/<YYYYMMDD-HHMMSS>/` if you don't set one.

## "No test files found, exiting with code 1"

**Cause:** vitest 4 treats unmatched glob args as literal filters. Bash without `nullglob` expands `test/*-live.test.ts` only if at least one match exists, otherwise passes the literal glob string to vitest, which then can't find a file named that.

**Fix:** `bin/run-live.sh` enables `nullglob` when expanding the default glob (commit `23ac780`). If you call vitest directly with a glob, use `shopt -s nullglob` first or pass concrete paths.

## "No test files found" with explicit file path

**Cause:** vitest treats positional args after `--` as forwarded to test runner, not as file filters. If you write `npx vitest run -- test/foo.test.ts` the `test/foo.test.ts` becomes a vitest CLI arg, not a file path.

**Fix:** drop the `--` for file filters. Use `--` only for actual vitest flags like `--reporter=verbose`.

## Stale `dist/`

**Symptom:** source change isn't reflected in test output.

**Cause:** package's `.` export resolves to `dist/index.js`. `npx vitest run` skips the npm `pretest` hook so `dist/` won't auto-rebuild.

**Fix:** `bin/run-live.sh` runs `npm run --silent build` before invoking vitest. Skip with `EVAL_SKIP_BUILD=1` if you've just built. If running vitest directly, prefix with `npm run build &&`.

## `Cannot find module 'pilotswarm-sdk'` from a workspace consumer

**Cause:** package-root smoke test runs against `dist/index.js` which imports `pilotswarm-sdk`. If the workspace symlink is broken (e.g. after `npm install` reorder), the import fails.

**Fix:** `npm install` at repo root. Confirm `node_modules/pilotswarm-sdk` resolves to `packages/sdk`.

## Pointers

- `.env.example` — every gate / knob / override
- `bin/run-live.sh --help` — flag-by-flag map to env vars
- `vitest.config.ts` — auto-loaded `.env`, file-parallelism gating, setup files
- `docs/PROMPT-ITERATION.md` — prompt-iteration workflow
- `docs/JUDGE-CLIENTS.md` — judge selection
- `docs/SUITES.md` — suite gating matrix
