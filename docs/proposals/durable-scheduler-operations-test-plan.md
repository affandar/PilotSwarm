# Durable scheduler operations: test and release plan

Status: proposed tests, not results of an implemented scheduler. Companion: [implementation proposal](durable-scheduler-operations.md).

## 1. Test strategy and oracles

Use three levels: real orchestration generators with a strict deterministic driver; actual Duroxide/PostgreSQL persistence with scripted activities and worker death; SDK/API/UI contract tests. Live Astra/Copilot availability is not a correctness oracle.

Add `packages/sdk/test/helpers/scheduler-driver.js`. Consolidate useful parts of the current cancellation/retry drivers, but do not use a proxy that silently accepts unknown effects. The driver must throw on an unsupported effect, allocate distinct recorded IDs, provide a controllable clock, name inbox positions, script race winners and activity failures, and distinguish staged effects from a committed activation. Restart discards uncommitted memory. CAN loads only its committed input and KV snapshot/history. A timer task object is not proof of a registered timer.

Drive the real new-version reducers/generators. The expected-state oracle must be independent of production transition/projection helpers. Inspect every committed boundary:

| Invariant | Assertion |
|---|---|
| Ownership | No retired schedule/question/lease/attempt changes a current owner |
| Admission | At most one logical admission per occurrence; retries retain occurrence ID |
| Work preservation | Every input/payload transfer has exactly one durable owner; no silent drop on capacity failure |
| Request durability | Every acknowledged request has a durable acceptance record and eventually a documented settlement or explicit blocker |
| Truth | KV transition, scheduled effects, and custom status agree for the same committed transition |
| Time | Read/replay/restart/CAN cannot move an absolute due time |
| Ordering | All input before the recorded cutoff is considered before autonomous work; later arrivals do not extend that cutoff |
| Gates | Runnable work makes bounded progress; all-gated work waits rather than spinning |
| Retirement | Pruned receipts or delayed duplicates cannot become fresh operations |

The generator harness does not establish provider transaction atomicity. Those claims require the real persistence tests below.

## 2. Deterministic suites

All following file names are proposed under `packages/sdk/test/local/` unless marked existing.

| Suite | Required cases and observable outcomes |
|---|---|
| `orchestration-scheduler-races.test.js` | Recreate the builder trace: old grace, old cron, new cron, answer, 60-second delivery, history-size CAN. Only the owned new occurrence may be admitted; no 30-minute housekeeping block. Exercise answer-before/after-grace, ordinary prompt during grace, Q1→identical Q2, lease invalidation when a question stays open across another turn, old idle release beside new cron, A→B→identical A, duplicate cron/wall-clock ticks and `max_fires=1`. |
| `orchestration-scheduler-cutoff.test.js` | 0/1/50/51/150 queued items; correction immediately before/after marker; already-buffered inputs; duplicate marker; CAN/restart mid-prefix; sustained later input; failed old work + additive/corrective messages; explicit cancel versus harmless status question. Assert input IDs, authority, attachment references and per-work constraints survive. Superseded work must not force its required tool. |
| `orchestration-scheduler-gates.test.js` | Distinguish runnable FIFO/local stash/ready digest from explicit waits, child gates, pending questions, provider budget, shutdown and receipt-store recovery. No busy-spin; no direct uninterruptible retry sleeps. Budget refusal consumes neither occurrence nor successful tool obligation. |
| `orchestration-scheduler-migration.test.js` | Frozen 1.0.72 incident fixture; actual pre-N deployed version; all armed/ready/paused/retry/input phases; absolute deadlines and intentional pause duration; conflicting legacy fields with canonical KV; unknown schema; missing/corrupt canonical state; ambiguous legacy FIFO quarantined and visible without guessed dispatch. |
| `scheduler-request-receipts.test.js` | Pending vs applied; accepted tool→empty/error/timeout; duplicate acknowledgement; ID/hash conflict; ordered A→B chain; rejected predecessor; A→external cancel→late B; attempt submit versus seal; request after seal; stopped attempt; old receipt after retirement; archive acknowledgement lost; capacity unavailable. |
| `scheduler-attempt-recovery.test.js` | First worker opens attempt, emits requests, dies; replacement activity sees same attempt and refuses blind model rerun; orchestration seals prefix and reconciles before new attempt. Exact duplicate same slot succeeds idempotently; divergent payload fails explicitly. Delayed old worker submission after seal cannot mutate state. |
| `scheduler-stop-scope.test.js` | Stop without admitted attempt; stop after admission before worker check; stop during model; completion beats stop; old stop after retry; stop of unapplied requests; applied schedule survives stop; stop-one-attempt preserves recurrence while schedule cancellation invalidates it. Do not assert that current legacy `no_active_turn` suppresses future work. |
| `scheduler-status-projection.test.js` | Projection after every transition/blocking yield; pending-arm vs armed; due/ready vs housekeeping wake; admitted vs model dispatched; retry exhausted/configuration retained; get_info/list_models do not alter phase; monotonic transition through CAN; native timer re-registration preserves logical identity and deadline. |
| `scheduler-capacity-retention.test.js` | UTF-8 encoded size including multi-byte strings; baseline key pressure; max state/ready/receipt buckets; no unbounded historical keys; accepted requests survive backpressure; payload hash mismatch; referenced payloads cannot be pruned; receipt archive lag cannot evict unsettled work; retirement watermark survives CAN. |

Add seeded short-trace exploration over set/cancel/timer/input/child-update/failure/stop/seal/CAN. Save seeds and minimal counterexamples. A practical PR gate is 500 fixed-seed traces up to 100 transitions plus explicit edge cases; a longer nightly run is supplementary. Cover every named transition and both orders of each race, without depending on wall-clock sleeps.

## 3. Real ingress, tool, and worker failure tests

Add `scheduler-durability.integration.test.js` with actual Node Duroxide runtime and isolated local PostgreSQL schemas. Script `runTurnSchedulerV1` for most tests. For the full SDK tool path, extend `test/helpers/copilot-provider-server.mjs` to produce cron→final, cron→null final, cron→connection loss, cron→timeout/watchdog, and two ordered scheduling calls followed by process exit. Assert durable receipts/state, not merely that the agent eventually says something.

Reuse `test/helpers/kill-harness.js`; it launches real worker processes. Add named test-only fault points, disabled in ordinary builds:

| Fault point | Recovery assertion |
|---|---|
| Before acceptance transaction commit | No successful receipt; no durable action |
| After acceptance/outbox commit, before tool acknowledgement | Retry same key returns the same receipt; one accepted record |
| After model request, before final result/snapshot | Request survives; replacement attempt requires reconciliation |
| Submit holds attempt row while seal runs, and inverse order | Submit is in the sealed prefix or rejected; never an unaccounted late request |
| After inbox enqueue, before delivered update | Redelivery may duplicate transport; only one KV settlement |
| Delivery lease expires while old pump is paused | A/B causal order and fencing remain correct despite delayed duplicates |
| After work payload insert, before FIFO ownership transfer | FIFO retained; payload orphan can be collected later without losing input |
| After FIFO transfer/admission commit, before worker model start | Stable work reference; correct attempt/stop behavior after restart |
| After application commit, before receipt archive/caller response | Applied state persists; repeat reads/retries do not reapply |
| During CAN between old commit and new worker resume | Identity/deadline/receipt/cutoff preserved |
| Target session terminalizes before delivery/application | Receipt exposes terminal target outcome, not endless misleading pending |
| Ingress database unavailable while old attempt gate is uncertain | Visible blocker; no volatile fallback or unsealed fresh attempt |

Real kill tests may take tens of seconds to reclaim locks. Use explicit fault barriers and bounded state polling; never infer a successful crash injection from elapsed time alone. Verify the fault was hit, the original worker died, and a new worker performed recovery.

## 4. Provider atomicity and inbox-order tests

Use the provider/runtime revisions actually compiled into the application's native Duroxide package. A pass against an unrelated checkout is not sufficient.

Relevant existing locations:

- `duroxide/tests/common/fault_injection.rs`
- `duroxide/tests/provider_atomic_tests.rs`
- `duroxide/src/provider_validation/atomicity.rs`
- `duroxide/tests/kv_store_tests.rs`, `custom_status_tests.rs`, `queue_event_tests.rs`
- `providers/duroxide-pg/tests/postgres_provider_test.rs`

Add one acknowledgement batch containing a scheduler KV transition, occurrence/receipt mutation, custom status, history, and either a timer enqueue or model activity enqueue. Test success, failure before execution, failure after intermediate SQL writes but before transaction commit, and commit-then-return-transient-error. Assert all-or-none state and idempotent recovery.

The current `set_ack_then_fail()` test hook affects worker acknowledgement, not orchestration acknowledgement. Extend the test-only wrapper to call the inner `ack_orchestration_item`, then return a transient error. A wrapper that fails before calling the provider cannot prove rollback after partially executed SQL. The existing duplicate-history rollback test also needs KV/status/work mutations to establish this proposal's claims.

Read history, merged KV, custom status and queue rows in one repeatable-read transaction, or match all observations to the same committed transition. Sequential ordinary reads can straddle two valid commits and falsely report inconsistency. Account for ready timers already consumed into application KV; absence from the native timer queue does not mean a lost wake.

Before adopting the cutoff contract, test concurrent producers: hold A's insert transaction, commit marker B, release A; test inverse order and multiple fetched batches. Distinguish inbox delivery order from request/receipt timestamps. If the adapter cannot support the specified fixed-prefix semantics, the implementation must narrow the documented boundary or add a verified ingress-order primitive; passing sequential FIFO tests is insufficient.

## 5. SDK, API, UI, and message receipts

Extend existing `session-refresh-ui.test.js` and UI core reducer/controller tests:

1. New active B then old active A: all scheduling fields stay B.
2. Cancellation then stale active response: no resurrection.
3. Due/blocked snapshot then late CMS turn writeback: scheduler does not become idle.
4. Failed runtime read, omitted scheduler object, explicit null schedule: three distinct outcomes.
5. Pending ingress receipt during an outstanding model turn: receipt visible without pretending runtime has observed it.
6. Repeated reads at different fake times: deadline unchanged.
7. CAN/worker change: projection revision remains monotonic.
8. Summary/detail endpoints: same revision or explicit differing freshness.
9. Historical receipt A applied at revision 4 with current revision 5 cancelled: both facts remain visible.

Add coverage for the newly reported child-update/input merge: user `status?` is batched with a child update; the model consumes it, but a single-check pending row remains. Trace and preserve `clientMessageIds` through every event classification, prompt merge, retries, and snapshot refresh. Consumption acknowledgement must follow explicit message IDs rather than text matching or the displayed event kind. Keep child provenance separate from the user's text. An old or unrelated system event must not mark other pending messages consumed. This narrow defect can be repaired independently if no orchestration replay change is required; it is still a required regression for the scheduler integration.

## 6. Replay, compatibility, activation and rollback

Freeze and replay sanitized actual pre-N histories, including the incident's timer/FIFO/CAN metadata and relevant scheduling activity results. Exclude private model content from checked-in fixtures. A fixture transformed for redaction must preserve the operation sequence required for deterministic replay; do not call a handcrafted generator test a genuine historical replay.

Keep existing fingerprint/freeze guards, and add golden serialized inputs proving old call sites omit new fields. Exercise old handlers on the compatibility worker, N handlers on capable workers, epoch-start turns, missing ingress support, activation target changes, and rollback with existing N instances still running. Verify every eligible worker supports the new activity before N activation; naming an activity differently is not proof of routing isolation.

Run a local mixed-version rehearsal and then explicit CHK canaries. A canary must demonstrate one interval occurrence, replacement/cancellation, a scripted model error plus queued correction, a child-update/input merge, and worker restart while checking receipts/projection. Do not alter the reported user's sessions merely to run tests. Pause wider activation on orphaned accepted requests, duplicate logical admission, unexplained overdue eligible work, or mixed-version execution errors.

Rollback test: disable new N starts/upgrades; keep N registrations, tables and handlers. Existing N instances must continue or enter a visible operational pause without losing accepted work. Verify downgrade to legacy state is refused.

## 7. Commands and gates

These commands are for the implementation after the named files exist. They have not been run as scheduler validation. Test database configuration must target a dedicated local test server and generated disposable schemas. Add a harness guard that rejects live CHK/prod hosts and non-test schema names. Do not reuse a general deployment `.env` blindly.

From `packages/sdk`:

```sh
npm run build
npm run lint
node --test test/unit/orchestration-*.test.mjs
node ../../node_modules/vitest/vitest.mjs run test/local/orchestration-scheduler-*.test.js test/local/scheduler-request-receipts.test.js test/local/scheduler-attempt-recovery.test.js test/local/scheduler-stop-scope.test.js test/local/scheduler-status-projection.test.js test/local/scheduler-capacity-retention.test.js test/local/orchestration-schedule-fingerprint.test.js test/local/orchestration-version-upgrade.test.js test/local/session-refresh-ui.test.js test/local/stop-turn.test.js
node --env-file=../../.env.scheduler-test ../../node_modules/vitest/vitest.mjs run test/local/scheduler-durability.integration.test.js
```

`.env.scheduler-test` is a proposed dedicated local test configuration, not an existing required file. The scripted suites must not use real provider credentials. Run the relevant UI tests with that package's existing runner after locating the final regression file.

From the exact matching runtime/provider checkouts, with isolated test database configuration:

```sh
cargo test --test provider_atomic_tests --test kv_store_tests --test custom_status_tests --test queue_event_tests
cargo test --manifest-path ../providers/duroxide-pg/Cargo.toml --test postgres_provider_test
```

Release requires: deterministic and seeded suites passing; actual provider rollback and uncertain-commit tests passing; scripted tool/crash tests passing; old-history replay and serialization unchanged; UI/API receipt tests passing; no silent capacity loss; mixed-worker activation and rollback rehearsal passing. Record test versions, commands, seeds, fault points hit, and canary transition/occurrence IDs with the implementation PR.

## 8. Why existing tests are insufficient

- `orchestration-stale-cron-timer.test.mjs` checks only absence of a schedule and stops the healthy path after its first event.
- `cron-tool.test.js` checks volatile buffering on successful completion/wait.
- `orchestration-fifo-order.test.mjs` uses a permissive context and one-step merge inspection.
- `orchestration-history-size-can.test.js` includes source-text contracts rather than actual restore behavior.
- `orchestration-version-upgrade.test.js` covers old command paths, not the incident's timer and receipt histories.
- Fake KV writes are often immediately visible; these cannot prove a persistence boundary.
- Existing fault tests focus on snapshot CAS rather than scheduler ingress, ownership, or status.

Retain useful existing cases, but make the new release depend on semantic recovery assertions rather than source matching or an eventual answer.
