/**
 * Regression: a cron interval timer that fires after cron(action="cancel")
 * must be ignored, not crash the orchestration.
 *
 * Incident (2026-07-12, orchestration 1.0.59): cron cancel cleared
 * state.cronSchedule, but the already-scheduled durable timer for the next
 * tick cannot be retracted. When it fired, processTimer's "cron" branch
 * dereferenced state.cronSchedule! and threw
 *   TypeError: Cannot read properties of undefined (reading 'reason')
 * which surfaced as a non-retryable OrchestrationFailed, permanently killing
 * the session and orphaning its sub-agents. The sibling "cron_at" branch
 * already guarded this; "cron" did not.
 *
 * Run: node --test test/unit/orchestration-stale-cron-timer.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import { processTimer } from "../../dist/orchestration/turn.js";

function makeHarness({ cronSchedule } = {}) {
    const traces = [];
    const recorded = [];
    const runtime = {
        ctx: { traceInfo: (m) => traces.push(m) },
        input: { sessionId: "test-session" },
        options: {},
        state: { cronSchedule },
        manager: {
            recordSessionEvent: (sessionId, events) => {
                recorded.push({ sessionId, events });
                return { __cmd: "recordSessionEvent", sessionId, events };
            },
        },
    };
    return { runtime, traces, recorded };
}

const cronTimerItem = (reason) => ({
    kind: "timer",
    timer: { type: "cron", deadlineMs: 1000, originalDurationMs: 60_000, reason },
    firedAtMs: 1000,
});

test("stale cron fire after cancel is a no-op (no throw, no cron_fired event)", () => {
    const { runtime, traces, recorded } = makeHarness({ cronSchedule: undefined });
    const gen = processTimer(runtime, cronTimerItem("supervise"));
    const first = gen.next();
    assert.equal(first.done, true, "generator must return immediately");
    assert.equal(recorded.length, 0, "no session.cron_fired for a cancelled cron");
    assert.ok(
        traces.some((t) => t.includes("no active cronSchedule")),
        "stale fire is traced",
    );
});

test("active cron fire still records session.cron_fired first", () => {
    const { runtime, recorded } = makeHarness({
        cronSchedule: { intervalSeconds: 60, reason: "supervise the build" },
    });
    const gen = processTimer(runtime, cronTimerItem("supervise the build"));
    const first = gen.next();
    assert.equal(first.done, false, "healthy path proceeds");
    assert.equal(first.value?.__cmd, "recordSessionEvent");
    assert.equal(first.value?.events?.[0]?.eventType, "session.cron_fired");
    assert.equal(recorded.length, 1);
    gen.return(); // stop before processPrompt — its plumbing is out of scope here
});
