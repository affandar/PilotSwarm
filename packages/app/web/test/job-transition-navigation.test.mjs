import assert from "node:assert/strict";
import test from "node:test";
import { activateJobTransitionSession } from "../../ui/react/src/job-transition-navigation.js";

test("transition navigation opens its session and restores activity panes", async () => {
    const calls = [];
    const controller = {
        dispatch(action) {
            calls.push({ kind: "dispatch", action });
        },
        async loadSession(sessionId) {
            calls.push({ kind: "loadSession", sessionId });
        },
    };

    assert.equal(
        await activateJobTransitionSession(controller, { sessionId: " session-123 " }),
        true,
    );
    assert.deepEqual(calls, [
        {
            kind: "dispatch",
            action: {
                type: "ui/rightPaneMode",
                mode: "panes",
                sessionId: "session-123",
                manual: true,
            },
        },
        { kind: "loadSession", sessionId: "session-123" },
    ]);
});

test("transition navigation ignores a state run without a session", async () => {
    const controller = {
        dispatch() {
            assert.fail("dispatch should not be called");
        },
        async loadSession() {
            assert.fail("loadSession should not be called");
        },
    };

    assert.equal(await activateJobTransitionSession(controller, { sessionId: null }), false);
});
