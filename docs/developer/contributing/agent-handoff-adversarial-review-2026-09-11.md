# Agent handoff branch: adversarial review, 2026-09-11

Scope: all changes on `codex/agent-handoff-hardening` after main
`f0b36a27ff4785c108ceb4120aa029be309c7424`, including the named-agent repair,
discovery and prompt changes, reserved tool names, cleanup wakeup fix, and
before/after reproduction tests. Two independent reviewers covered runtime
handoff and orchestration/cleanup. The primary reviewer covered discovery,
evaluation, test wiring, documentation and the resulting repairs.

## Findings and repairs

| Finding | Counterexample | Repair and validation |
| --- | --- | --- |
| Child answers mistaken for exit markers | A completed child really answers `failed`; polling discards it and retains an older answer. | V2 status activities identify response, child-outcome or orchestration provenance. Only orchestration output is discarded. Tests pass all four literal status words through real status assembly and activity serialization. |
| Root application-tool additions lost or stale | A published named root loses its explicitly supplied ordinary tool; a static root can retain tools removed from its definition. | Persist caller additions separately, compose them with the current definition, and exclude package-owned extras. Tests exercise real client projection, top-level resolution and SessionManager refresh/hydration. Named children strip this metadata. |
| Explicit logical depth lost between clients | A child created at logical depth 1 under a physical depth-2 system subtree starts at depth 2 when another client sends its first message. | Persist bootstrap depth in existing creation configuration. Validate it and retain the full ancestry checks. Tests cover same/split-client starts, invalid metadata, cycles and missing ancestors. |
| Named identity lost on a fresh sender | A fresh client omits the saved agent ID from initial orchestration input, bypassing named startup resolution and its required initial tool. | Restore the durable identity at first start and test the complete serialization/startup path. |
| Evaluation could pass before a routing choice | `ps_list_agents` alone was counted as direct work in an explicit no-delegation scenario. | Share the decision boundary between evaluator hooks; catalog/fact preparation cannot count as a direct decision or passing result. The same counterexample passes the old scorer and fails the repaired scorer. |

Simplicity cleanup removes the no-op `creatableOnly` discovery option and redundant
child-contract assignments. The focused handoff command now includes the cleanup
and batching suites. Recovery-test failures capture bounded progress diagnostics
before test teardown; response deadlines are unchanged.

## Compatibility and limits

- The bulk of the branch's added lines are frozen orchestration trees, required
  for replay. All frozen files are checked against their original checkpoints.
- Active orchestration 1.0.78 preserves historical activity descriptors and uses
  separate status activities for the new result metadata. Legacy capability
  selector handlers remain because frozen histories can reference them.
- No database migration is required for these review repairs. Bootstrap depth
  and tool additions use the existing creation-configuration JSON.
- `wait_for_agents` retains its existing task-settled semantics; it is not a
  strict acknowledgement barrier for a separately queued cleanup command.
- Existing frozen children and already queued legacy cleanup acknowledgements
  are not rewritten. See the [upgrade procedure](../building/agent-handoff-upgrade.md).
- The separate, pre-existing `createSystemSession` path does not persist its
  full creator-supplied configuration. This repair covers ordinary named and
  delegated creation; it does not extend that management-only creation path.

## Validation

The earlier missing-resumable-state timeout passed an isolated live recovery
probe with its original 60-second response deadline. That does not establish
concurrent reliability; the new full provider pass is recorded below separately.

Provider validation uses Node 24.20.0, Duroxide/native 0.1.29, Copilot SDK 1.0.13
and CLI 1.0.83. Runtime PostgreSQL is Docker localhost. HorizonDB uses unique
test schemas; the global stale-schema sweep is disabled and individual test
cleanup remains enabled. No deployment is part of this review.

The first full provider pass at `963312a9` completed with these SDK results:

| Provider | Passed | Failed | Skipped |
| --- | ---: | ---: | ---: |
| PostgreSQL | 1,958 | 1 | 17 |
| HorizonDB | 1,971 | 1 | 4 |

The same assertion failed in both passes: an unstarted legacy row expected one
worker-backfill event. Startup now restores its saved agent identity before the
worker runs, so zero events is correct. Both named-agent replies passed. The
test now distinguishes this normal startup from an already-started historical
input that still needs worker backfill. It verifies actual durable activity
inputs, two replies, and exactly one backfill announcement for that latter case.

All 149 live HorizonDB store tests passed. Both providers also passed the
concurrent missing-state recovery test, all 118 parent-child handoff cases and
the 15 native-task runtime cases. The standard skips include the opt-in live
Terra filesystem-choice probes and unavailable Blob fixtures; the PostgreSQL
pass additionally skips HorizonDB-only cases.

The corrected six-case legacy fixture passes on both PostgreSQL and HorizonDB
(six passed, zero failed or skipped per provider). The new history assertions
select the exact activity name before decoding Duroxide's diagnostic input and
verify the namespace-qualified deployment binding. They preserve the two-turn,
exactly-one-announcement assertion for already-started legacy input.

The next full gate at `a066220e` passed 1,959 PostgreSQL SDK tests but timed out
one system-agent coexistence case during teardown (17 standard skips). Its
149 live HorizonDB store tests passed; the remaining HorizonDB SDK phase was
stopped after the timeout was independently reproduced. It is not a passing gate.

Four isolated reruns of that case passed. A four-way concurrent reproduction
produced three passes and the same 180-second timeout. Instrumented source
showed durable-runtime shutdown finishing in five seconds, followed by an
unresolved Copilot `session.detach` inside final manager cleanup. The repaired
four-way rerun passed all four, including one actual detach stall that hit the
new ten-second deadline and recovered through the SDK's public `forceStop()`.

Final manager cleanup now stops each unique pooled client concurrently;
`CopilotClient.stop()` already detaches its sessions. It handles both thrown
errors and returned error arrays, and force-stops a stalled client after ten
seconds. Eight deterministic tests cover the installed SDK detach path,
duplicate client aliases, concurrent clients, errors, late completion/rejection,
untouched storage, preserved locks and ordinary eviction. The first six
regression assertions all failed before the repair. These tests and existing
lock/dehydration cases pass (15 total). An independent reviewer approved the
patch. The deadline bounds this final cleanup, not all preceding dehydration
or OS process exit; deployment still verifies that old pods/processes are gone.

The reproduction also exposed a pre-existing provider-poller leak: it ran from
construction and continued during shutdown. Polling is now owned by start/stop,
coalesces refresh and bootstrap into one task, stops admitting work at drain,
and settles admitted startup before closing storage. Nine deterministic
lifecycle tests pass (eight failed before repair), and 24 related lifecycle,
model-reload, system-bootstrap and feature-worker tests pass. Both shutdown
repairs preserve durable state and require no orchestration-version change.

The clean full release gate at `50414e30` passed on 2026-09-11 with
`./scripts/run-tests.sh --all-providers` and four SDK test workers:

| Provider | Passed | Failed | Skipped | Total |
| --- | ---: | ---: | ---: | ---: |
| PostgreSQL SDK | 1,977 | 0 | 17 | 1,994 |
| HorizonDB SDK | 1,990 | 0 | 4 | 1,994 |
| Live HorizonDB store | 149 | 0 | 0 | 149 |

Both provider phases exited zero. Each passed the deploy-script suite (250),
SDK unit suite (936), app suites (22 TUI, 141 web, 781 UI), and MCP checks.
The full workspace build and the combined shutdown-focused pass (39 tests)
also passed. The 118 handoff cases, 15 native-task runtime cases, and six
legacy-startup cases passed on both providers. Standard optional skips remain
as described above; no failing test was skipped or weakened for this gate.

The run used isolated test schemas with the global stale-schema sweep disabled.
No production data or deployment configuration was changed by these tests.
