/**
 * The FIFO keeps a person's messages in the order they were sent.
 *
 * decide() merges consecutive prompts into one turn by POPPING the next item
 * and peeking at it. When the popped item turns out not to be mergeable — a
 * person's message behind an agent's bootstrap kickoff, or a non-prompt item
 * — it has to go back. It used to go back by APPENDING, which put it behind
 * everything still queued:
 *
 *     [KICKOFF, "do X", "cancel X"]  →  dispatch KICKOFF  →  ["cancel X", "do X"]
 *
 * and the next turn read the person's two messages in the wrong order. This
 * is the first test of decide()'s queue handling in the repo; everything
 * before it tested turn.ts by regex.
 *
 * Drives the real generator one step against a fake durable context (a Map
 * for the KV store) — the merge is synchronous before the first yield — and
 * reads what the FIFO holds afterwards.
 *
 * Run: node --test test/unit/orchestration-fifo-order.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";

import { createInitialState } from "../../dist/orchestration/state.js";
import { decide, appendToFifo, prependToFifo } from "../../dist/orchestration/queue.js";

function makeRuntime() {
    const kv = new Map();
    // The durable context: a Map for the KV store, tagged objects for the
    // few operations the driver has to answer, and a no-op for anything
    // else decide() touches on the way to its first turn (status writes,
    // tracing). A Proxy, so a new ctx method in the orchestration does not
    // silently turn this into a test of nothing.
    const explicit = {
        getValue: (k) => kv.get(k),
        setValue: (k, v) => { kv.set(k, v); },
        clearValue: (k) => { kv.delete(k); },
        utcNow: () => ({ op: "utcNow" }),
        newGuid: () => ({ op: "newGuid" }),
        dequeueEvent: () => ({ op: "dequeue" }),
        scheduleTimer: () => ({ op: "timer" }),
        race: () => ({ op: "race" }),
    };
    const ctx = new Proxy(explicit, {
        get: (target, prop) => (prop in target ? target[prop] : () => undefined),
    });
    const input = { sessionId: "s1", config: {} };
    const options = {};
    const state = createInitialState(input, options);
    const runtime = {
        ctx, state, options, input,
        session: { runTurn: () => ({ op: "runTurn" }) },
        manager: { recordSessionEvent: () => ({ op: "record" }) },
    };
    return { runtime, kv };
}

function readFifo(kv) {
    const out = [];
    for (let i = 0; i < 64; i += 1) {
        const raw = kv.get(`fifo.${i}`);
        if (raw) out.push(...JSON.parse(raw));
    }
    return out.map((x) => x.prompt);
}

// decide() drains and merges the FIFO SYNCHRONOUSLY, before its first yield
// (the first yield is the race against the message queue). So one next() is
// the whole merge step, and what the FIFO holds afterwards is exactly what
// the next turn will read. Traced, not assumed.
function runMergeStep(runtime) {
    const gen = decide(runtime);
    const first = gen.next();
    assert.equal(first.done, false, "decide() should have yielded, not returned");
    return first.value;
}

const prompt = (text, extra = {}) => ({ kind: "prompt", prompt: text, bootstrap: false, ...extra });

test("three plain prompts merge into one turn, leaving nothing queued", () => {
    const { runtime, kv } = makeRuntime();
    // No clientMessageIds on the FIRST item: ids make decide() run a
    // cancellation sweep that yields before the merge, which the one-step
    // driver would read as "nothing merged". The peeked items may carry ids;
    // only the popped head triggers the sweep.
    appendToFifo(runtime, [
        prompt("A"),
        prompt("B", { clientMessageIds: ["b"] }),
        prompt("C", { clientMessageIds: ["c"] }),
    ]);
    runMergeStep(runtime);
    assert.deepEqual(readFifo(kv), []);
});

test("a kickoff runs alone, and the person's messages behind it keep their order", () => {
    const { runtime, kv } = makeRuntime();
    appendToFifo(runtime, [
        prompt("KICKOFF", { bootstrap: true, sender: { kind: "system", display: "kickoff" } }),
        prompt("B: do X", { clientMessageIds: ["b"] }),
        prompt("C: actually, cancel X", { clientMessageIds: ["c"] }),
    ]);
    runMergeStep(runtime);
    // The kickoff dispatched by itself. B was popped, found unmergeable, and
    // must have gone back to the HEAD — so the next turn reads "do X" and
    // THEN "cancel X", as they were sent.
    assert.deepEqual(readFifo(kv), ["B: do X", "C: actually, cancel X"]);
});

test("a non-prompt item behind a prompt also goes back to the head", () => {
    const { runtime, kv } = makeRuntime();
    appendToFifo(runtime, [
        prompt("A", { clientMessageIds: ["a"] }),
        { kind: "answer", answer: "yes" },
        prompt("B", { clientMessageIds: ["b"] }),
    ]);
    runMergeStep(runtime);
    // A ran alone; the answer stopped the merge and went back in front of B.
    const left = [];
    for (let i = 0; i < 64; i += 1) {
        const raw = kv.get(`fifo.${i}`);
        if (raw) left.push(...JSON.parse(raw));
    }
    assert.deepEqual(left.map((x) => x.kind), ["answer", "prompt"]);
});

test("prependToFifo puts an item in front of what is queued", () => {
    const { runtime, kv } = makeRuntime();
    appendToFifo(runtime, [prompt("B"), prompt("C")]);
    prependToFifo(runtime, prompt("A"));
    assert.deepEqual(readFifo(kv), ["A", "B", "C"]);
});
