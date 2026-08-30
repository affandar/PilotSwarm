/**
 * check_agents as a DELTA report (P3 of the child-wake diet).
 *
 * Run: node --test test/unit/check-agents-report.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
    buildCheckAgentsReport,
    fingerprintChild,
    CHECK_AGENTS_OUTPUT_CAP,
} from "../../dist/check-agents-report.js";

const kids = () => [
    { orchId: "session-a", title: "A", status: "running", iterations: 3, result: "half way" },
    { orchId: "session-b", title: "B", status: "completed", iterations: 5, result: "B is done", verdict: "success" },
    { orchId: "session-c", title: "C", status: "waiting", iterations: 2, result: "polling" },
];

test("no memo → every child in full, header says so", () => {
    const r = buildCheckAgentsReport(kids(), null);
    assert.equal(r.changed, 3);
    assert.match(r.text, /^\[SYSTEM: Sub-agent status report \(3 agents\):/);
    assert.equal((r.text.match(/    Output: /g) ?? []).length, 3, "three full blocks");
    assert.deepEqual(Object.keys(r.perChild).sort(), ["session-a", "session-b", "session-c"]);
});

test("with a memo, only the changed child is full; the rest are roster lines", () => {
    const first = buildCheckAgentsReport(kids(), null);
    const memo = { at: "2026-08-30T20:00:00.000Z", perChild: first.perChild };
    const next = kids();
    next[0].result = "three quarters";            // changed result
    const r = buildCheckAgentsReport(next, memo);
    assert.equal(r.changed, 1);
    assert.match(r.text, /\(3 agents, 1 changed since 2026-08-30T20:00:00\.000Z; pass full=true for all\)/);
    assert.equal((r.text.match(/    Output: /g) ?? []).length, 1, "one full block");
    assert.match(r.text, /  - Agent session-b · completed · unchanged since 2026-08-30T20:00:00\.000Z/);
    assert.match(r.text, /  - Agent session-c · waiting · unchanged since/);
    assert.match(r.text, /Output: three quarters/);
});

test("a status change alone counts as changed, even with the same result text", () => {
    const first = buildCheckAgentsReport(kids(), null);
    const next = kids();
    next[2].status = "completed";
    const r = buildCheckAgentsReport(next, { at: "t0", perChild: first.perChild });
    assert.equal(r.changed, 1);
    assert.match(r.text, /Agent session-c\n    Title: C\n    Status: completed/);
});

test("full=true prints everything and the plain header, memo or not", () => {
    const first = buildCheckAgentsReport(kids(), null);
    const r = buildCheckAgentsReport(kids(), { at: "t0", perChild: first.perChild }, { full: true });
    assert.equal((r.text.match(/    Output: /g) ?? []).length, 3);
    assert.match(r.text, /^\[SYSTEM: Sub-agent status report \(3 agents\):/);
});

test("a child unknown to the memo (spawned since) is printed in full", () => {
    const first = buildCheckAgentsReport(kids().slice(0, 2), null);
    const r = buildCheckAgentsReport(kids(), { at: "t0", perChild: first.perChild });
    assert.equal(r.changed, 1);
    assert.match(r.text, /Agent session-c\n    Title: C/);
});

test("Output is capped and says where the rest is", () => {
    const long = "x".repeat(CHECK_AGENTS_OUTPUT_CAP + 500);
    const r = buildCheckAgentsReport([{ orchId: "session-z", status: "completed", result: long }], null);
    assert.ok(!r.text.includes(long), "the full text must not appear");
    assert.match(r.text, /… \[500 more chars; read_agent_events for the full result\]/);
});

test("the report keeps the prefix isInternalSystemPrompt matches on", () => {
    const r = buildCheckAgentsReport(kids(), null);
    assert.ok(r.text.startsWith("[SYSTEM: Sub-agent status report ("), "session-proxy classifies the report by this prefix");
});

test("fingerprint hashes result-or-error text and carries status", () => {
    const a = fingerprintChild({ orchId: "x", status: "failed", error: "boom" });
    const b = fingerprintChild({ orchId: "x", status: "failed", error: "boom" });
    const c = fingerprintChild({ orchId: "x", status: "failed", error: "bang" });
    assert.deepEqual(a, b);
    assert.notEqual(a.hash, c.hash);
    assert.equal(a.status, "failed");
});
