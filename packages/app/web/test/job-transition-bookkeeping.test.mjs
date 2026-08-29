import assert from "node:assert/strict";
import test from "node:test";
import { describeJobTransitionBookkeepingEvent } from "../../ui/react/src/job-transition-bookkeeping.js";

test("transition bookkeeping keeps lifecycle durability events", () => {
    assert.deepEqual(
        describeJobTransitionBookkeepingEvent("session.system_wait_started"),
        { label: "System wait frozen", kind: "wait" },
    );
    assert.deepEqual(
        describeJobTransitionBookkeepingEvent("session.dehydrated"),
        { label: "Session dehydrated", kind: "session" },
    );
    assert.deepEqual(
        describeJobTransitionBookkeepingEvent("session.error"),
        { label: "Session error", kind: "error" },
    );
});

test("transition bookkeeping excludes model, tool, hook, and message activity", () => {
    for (const eventType of [
        "assistant.message",
        "assistant.reasoning",
        "model.call_start",
        "tool.execution_start",
        "tool.execution_complete",
        "external_tool.requested",
        "external_tool.completed",
        "hook.start",
        "hook.end",
    ]) {
        assert.equal(describeJobTransitionBookkeepingEvent(eventType), null, eventType);
    }
});
