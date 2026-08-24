/**
 * The runTurn activity input is a WHITELIST, and a field that both ends
 * support still dies if the whitelist omits it.
 *
 * That is exactly what shipped on 1.0.70's first cut: the orchestration sent
 * `stashedPrompts` (turn.ts), the worker-side fold consumed it
 * (executeTurnBody), and this proxy dropped it on the wire — so the
 * gate-refused-prompt replay never executed, and "delivery" was whatever the
 * rebuilt history happened to make the model volunteer. Found by the live
 * verification agents reading ps_duroxide.history: the scheduled input had
 * no stashedPrompts key on any wake path.
 *
 * These tests pin the whole whitelist, so the NEXT field added at both ends
 * but not here fails a test instead of shipping as roulette.
 *
 * Run: node --test test/unit/session-proxy-turn-wire.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";

import { createSessionProxy } from "../../dist/session-proxy.js";

function capture() {
    const scheduled = [];
    const ctx = {
        scheduleActivityOnSession: (name, input, affinityKey) => {
            scheduled.push({ name, input, affinityKey });
            return { effect: "activity", name };
        },
    };
    const proxy = createSessionProxy(ctx, "wire-test", "affinity-1", { model: "azure-openai:gpt-5.4" });
    return { proxy, scheduled };
}

test("stashedPrompts crosses the wire when the orchestration sends it", () => {
    const { proxy, scheduled } = capture();
    proxy.runTurn("[SYSTEM: wake]", false, 3, {
        stashedPrompts: ["the refused prompt", "a second one"],
        clientMessageIds: ["cm-1"],
    });
    assert.equal(scheduled.length, 1);
    assert.deepEqual(scheduled[0].input.stashedPrompts, ["the refused prompt", "a second one"]);
    // And an empty stash is omitted, not sent as [].
    proxy.runTurn("plain", false, 4, { stashedPrompts: [] });
    assert.ok(!("stashedPrompts" in scheduled[1].input));
});

test("every turnMeta field the orchestration can send survives the whitelist", () => {
    const { proxy, scheduled } = capture();
    const meta = {
        parentSessionId: "parent-1",
        nestingLevel: 2,
        requiredTool: "report_back",
        cycleOrigin: "cron",
        retryCount: 1,
        clientMessageIds: ["cm-a"],
        sender: { provider: "dev", subject: "ada" },
        snapshot: { turnKey: "guid-1" },
        attachments: [{ filename: "a.png", contentType: "image/png", sizeBytes: 10 }],
        transcriptEpoch: 1,
        stashedPrompts: ["stash"],
    };
    proxy.runTurn("prompt", true, 7, meta);
    const input = scheduled[0].input;

    // The base trio.
    assert.equal(input.sessionId, "wire-test");
    assert.equal(input.prompt, "prompt");
    assert.equal(input.turnIndex, 7);
    assert.equal(input.bootstrap, true);

    // Every meta key, name for name. A key added to turnMeta but not to this
    // list is the wiring gap this file exists to catch.
    for (const key of Object.keys(meta)) {
        assert.ok(key in input, `turnMeta.${key} was dropped by the runTurn whitelist`);
    }
    assert.deepEqual(input.stashedPrompts, ["stash"]);
});

test("the epoch-start turn dispatches as runTurn2 and still carries the stash", () => {
    const { proxy, scheduled } = capture();
    proxy.runTurn("p", false, 0, { epochStart: true, stashedPrompts: ["carried"] });
    assert.equal(scheduled[0].name, "runTurn2");
    assert.deepEqual(scheduled[0].input.stashedPrompts, ["carried"]);
});
