import assert from "node:assert/strict";
import test from "node:test";
import {
    normalizeDurableStartTurn,
    normalizeStartClientMessageIds,
    prepareDurableStartInput,
} from "../../dist/index.js";

test("old start inputs normalize without inventing a first turn", () => {
    assert.equal(normalizeDurableStartTurn({
        sessionId: "session-1",
        config: {},
        iteration: 0,
        unknownFutureField: true,
    }), null);
});

test("carried start turns preserve bootstrap and required-tool semantics", () => {
    assert.deepEqual(normalizeDurableStartTurn({
        prompt: "Run the check",
        bootstrapPrompt: true,
        requiredTool: " run_check ",
        recentClientMessageIds: ["message-1", "message-1", "", 17, "message-2"],
    }), {
        prompt: "Run the check",
        bootstrap: true,
        requiredTool: "run_check",
        clientMessageIds: ["message-1", "message-2"],
    });
});

test("client message ids are stable, unique, and bounded", () => {
    const ids = Array.from({ length: 22 }, (_, index) => `message-${index + 1}`);
    assert.deepEqual(normalizeStartClientMessageIds([
        "message-1",
        ...ids,
        "message-22",
    ]), ids.slice(-20));
});

test("bootstrap plans carry the turn in start input with no message event", () => {
    const base = { sessionId: "session-1", config: {}, iteration: 0 };
    const plan = prepareDurableStartInput(base, {
        prompt: "Initialize the workspace",
        bootstrap: true,
        requiredTool: "initialize",
        clientMessageIds: ["message-1", "message-1"],
    });

    assert.equal(plan.delivery, "start-input");
    assert.equal(plan.message, null);
    assert.deepEqual(plan.startInput, {
        ...base,
        prompt: "Initialize the workspace",
        bootstrapPrompt: true,
        requiredTool: "initialize",
        recentClientMessageIds: ["message-1"],
    });
    assert.deepEqual(base, { sessionId: "session-1", config: {}, iteration: 0 });
});

test("non-bootstrap plans retain the existing separate message-event path", () => {
    const base = { sessionId: "session-1", config: {}, iteration: 0 };
    const plan = prepareDurableStartInput(base, {
        prompt: "Hello",
        requiredTool: "respond",
        clientMessageIds: ["message-1"],
    });

    assert.equal(plan.delivery, "message-event");
    assert.equal(plan.startInput, base);
    assert.deepEqual(plan.message, {
        prompt: "Hello",
        requiredTool: "respond",
        clientMessageIds: ["message-1"],
    });
    assert.equal(normalizeDurableStartTurn(plan.startInput), null);
});

test("the helper refuses to overwrite an already-carried turn", () => {
    assert.throws(() => prepareDurableStartInput(
        { sessionId: "session-1", prompt: "existing" },
        { prompt: "replacement", bootstrap: true },
    ), /already carries a prompt/);
});
