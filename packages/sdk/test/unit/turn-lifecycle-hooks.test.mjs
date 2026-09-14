import assert from "node:assert/strict";
import test from "node:test";
import { runWithTurnLifecycleHooks } from "../../dist/index.js";

const context = {
    sessionId: "session-1",
    turnIndex: 4,
    config: { model: "fixture:test" },
    trace() {},
};

test("orders hooks around a successful turn exactly once", async () => {
    const calls = [];
    const result = await runWithTurnLifecycleHooks({
        context,
        beforeTurn: async (value) => calls.push(["before", value.sessionId]),
        run: async () => {
            calls.push(["turn"]);
            return { type: "completed", content: "done" };
        },
        afterTurn: async (value) => calls.push(["after", value.status, value.result]),
    });

    assert.deepEqual(result, { type: "completed", content: "done" });
    assert.deepEqual(calls, [
        ["before", "session-1"],
        ["turn"],
        ["after", "completed", result],
    ]);
});

test("reports cancelled and stopped turn results as cancellation", async () => {
    for (const result of [
        { type: "cancelled", message: "cancelled" },
        { type: "stopped", reason: "stopped" },
    ]) {
        const seen = [];
        assert.equal(await runWithTurnLifecycleHooks({
            context,
            run: () => result,
            afterTurn: (value) => seen.push(value),
        }), result);

        assert.equal(seen.length, 1);
        assert.equal(seen[0].status, "cancelled");
        assert.equal(seen[0].result, result);
        assert.equal(seen[0].error, undefined);
    }
});

test("before-hook failure prevents the turn and after-hook", async () => {
    const beforeError = new Error("before failed");
    let bodyCalls = 0;
    let afterCalls = 0;
    await assert.rejects(
        runWithTurnLifecycleHooks({
            context,
            beforeTurn: () => { throw beforeError; },
            run: () => { bodyCalls++; },
            afterTurn: () => { afterCalls++; },
        }),
        (error) => error === beforeError,
    );
    assert.equal(bodyCalls, 0);
    assert.equal(afterCalls, 0);
});

test("turn failure reaches after-hook from finally and remains primary", async () => {
    const turnError = new Error("turn failed");
    let seen;
    await assert.rejects(
        runWithTurnLifecycleHooks({
            context,
            run: () => { throw turnError; },
            afterTurn: (value) => { seen = value; },
        }),
        (error) => error === turnError,
    );
    assert.equal(seen.status, "failed");
    assert.equal(seen.error, turnError);
    assert.equal(seen.result, undefined);
});

test("after-hook failure rejects an otherwise successful turn", async () => {
    const afterError = new Error("after failed");
    await assert.rejects(
        runWithTurnLifecycleHooks({
            context,
            run: () => ({ type: "completed" }),
            afterTurn: () => { throw afterError; },
        }),
        (error) => error === afterError,
    );
});

test("concurrent turn and after-hook failures preserve both in precedence order", async () => {
    const turnError = new Error("turn failed");
    const afterError = new Error("after failed");
    await assert.rejects(
        runWithTurnLifecycleHooks({
            context,
            run: () => { throw turnError; },
            afterTurn: () => { throw afterError; },
        }),
        (error) => {
            assert.ok(error instanceof AggregateError);
            assert.deepEqual(error.errors, [turnError, afterError]);
            return true;
        },
    );
});
