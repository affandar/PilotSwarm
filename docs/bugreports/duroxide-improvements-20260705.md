# Duroxide / duroxide-pg improvements identified by the PilotSwarm session lifecycle work

Status: proposal (2026-07-05)
Origin: implementing and adversarially reviewing PilotSwarm's session
lifecycle protocol (docs/proposals/session-lifecycle-protocol.md) — atomic
per-turn snapshot commits, warm affinity holds, and a literal fault-injection
harness that kills real worker processes at protocol boundaries and lets
duroxide's retry machinery recover them (packages/sdk/test/local/
fault-injection-live.test.js).

Everything below was verified against duroxide core 0.1.29 and duroxide-pg
0.1.34 sources during that work. Ranked by value-per-effort.

---

## 1. `Runtime::shutdown` should return on quiescence, not sleep the full budget

**Where:** `duroxide/src/runtime/mod.rs` (`shutdown`, ~line 1011).

`shutdown(timeout_ms)` sets the shutdown flag, then does an unconditional
`tokio::time::sleep(timeout_ms)`, then aborts leftover `JoinHandle`s. The
dispatchers themselves quiesce early — the flag is checked at the top of
every slot iteration and `enforce_min_poll_interval` skips its sleep once
the flag is set (`dispatchers/worker.rs` ~lines 210, 256) — so all join
handles typically complete within milliseconds of the last in-flight item
finishing. The call still blocks for the full budget.

**Impact on PilotSwarm:** the graceful drain gives in-flight turns a 60 s
budget on SIGTERM. Because `shutdown` never returns early, every worker pod
pays the full 60 s of termination wall-clock on every rollout even when all
turns finish in the first seconds.

**Fix shape (few lines, backward compatible):** replace the fixed sleep
with `tokio::time::timeout(budget, join_all(joins))`, then abort whatever
remains. Alternative: a two-phase API — `begin_drain()` (set the flag,
return immediately) + `await_quiescence(timeout)` — with the existing
`shutdown(0)` as the abort.

## 2. Expose the session lock timeout as a runtime option

**Where:** duroxide-pg session support (sessions table `locked_until`
renewal; the ~30 s constant is provider-internal). The Node binding exposes
`sessionIdleTimeoutMs` and `maxSessionsPerRuntime` but not the session
LOCK timeout; `workerLockTimeoutMs` (work items) is already exposed.

**Impact on PilotSwarm:** the session lock is the reclaim floor for
session-pinned work after a worker crash. Two costs:

- Production: failover of a warm session after a pod dies waits ~30 s
  before another worker can claim its pinned activities — regardless of
  how small `workerLockTimeoutMs` is tuned.
- Tests: PilotSwarm's literal fault-injection suite kills real workers at
  protocol boundaries and waits for re-dispatch. With work-item locks at
  2 s, each kill/recovery cycle still takes ~45–90 s, of which ~30 s is
  this constant. Across the crash matrix that dominates suite runtime.

**Fix shape:** thread a `sessionLockTimeoutMs` runtime option through
duroxide-pg and the Node binding, mirroring `workerLockTimeoutMs`.
Operators get a heartbeat-traffic vs failover-latency dial; test suites
get seconds-fast kill cycles.

## 3. Aborting an activity does not cancel its JS execution

**Where:** duroxide core `JoinHandle::abort()` on shutdown/cancel;
duroxide-node invokes JS activities via `ThreadsafeFunction::call_async`.

Aborting the Rust future orphans, not cancels, the JS promise — the
activity body keeps executing on the Node event loop. During PilotSwarm's
drain review this surfaced as: after `shutdown()` returns and the host
begins tearing down, an over-budget turn can still be running its body and
mutating its session directory. PilotSwarm defends app-side (the release
sweep skips sessions whose per-session lock is still held), but every
duroxide-node application inherits this gap.

**Fix shape:** propagate cancellation to JS — e.g. hand activity handlers
an `AbortSignal` that fires when the work item is aborted/cancelled — or at
minimum document the orphaning behavior and provide an API to await
in-flight JS activity settlement.

## 4. Quiescence observability in the Node binding

**Where:** `duroxide-node` `JsMetricsSnapshot` — cumulative counters only
(`workerDispatcherItemsFetched`, `activitySuccess`, error counters).

There is no in-flight gauge, and the shutdown flag cannot be set without
committing to the fused blocking `shutdown()` call (which must not be
invoked concurrently). Hosts cannot implement their own drain policies
("stop fetching, then decide"). An `inFlightActivities` gauge — or the
two-phase drain from item 1 — closes this.

## 5. Document (and test) the retry-with-same-input contract

PilotSwarm's crash recovery depends on a specific property: when a work
item's lock expires and the item is re-dispatched, the retry delivers
**byte-identical activity input**. The whole idempotent-commit scheme (a
per-turn key rides in the input; a crashed-after-commit retry recognizes
its own committed state and restores instead of re-running) hangs off it.

The property holds today — verified by reading the dispatch/retry path —
but it is load-bearing for application-level exactly-once schemes and
deserves to be a documented, contract-tested guarantee. Related nicety:
expose the delivery attempt number in the activity context so handlers can
distinguish first delivery from retry without side channels.

## 6. Surface session lease lifecycle events

A session lease being claimed, renewed, idle-expired, or reclaimed is
invisible to the host application. PilotSwarm shipped a wait-on-worker
affinity feature that was silently ineffective for any wait longer than
the session idle timeout — the preserved affinity key outlived its lease
and nothing said so. Emitting lease transitions (even as host-visible
trace events, or counters in the metrics snapshot) makes affinity loss
observable instead of silent.

## 7. (Design discussion) Optional session epochs

Duroxide has no session-level fencing: stale *completions* are blocked by
work-item lock tokens and `execution_id` dedup, but nothing prevents a
worker holding stale process-local state from serving a *newly scheduled*
activity when the session key routes back to it. PilotSwarm built the
fence application-side — a monotonic snapshot version with CAS commits,
per-turn keys, and a dirty-sentinel protocol — and that layering is
defensible (duroxide deliberately doesn't know about application state).

But the zombie-duplicate class (a lock-expiry retry racing a still-live
prior attempt) is generic to any stateful-session application. An epoch
counter bumped on session lease transfer, stamped into dispatched work
items, and checked at completion would give every duroxide application
that fence for free. Proposing it as a design conversation rather than a
patch — it interacts with the implicit-session model.

---

## Suggested order

Items 1–2 are small, isolated, and immediately valuable (deploy wall-clock;
failover latency; test suite speed). Item 3 is the only one with
correctness texture. Items 4–6 are observability/documentation. Item 7 is
a design discussion.
