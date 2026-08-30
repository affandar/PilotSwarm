import assert from "node:assert/strict";
import test from "node:test";
import { createJobLifecycleTools } from "../../dist/job-lifecycle-tools.js";

test("complete_state binds completion to the durable session", async () => {
    const calls = [];
    const [tool] = createJobLifecycleTools({
        async completeJobState(input) {
            calls.push(input);
            return {
                jobId: "job-1",
                fromState: "Diagnosed",
                toState: "Fixed",
                outcome: "Fixed",
                sequence: 2,
            };
        },
    });
    assert.equal(tool.pilotswarmTerminalTurnBoundary, true);
    const result = JSON.parse(await tool.handler(
        { outcome: "Fixed", summary: "Applied and verified the fix." },
        { durableSessionId: "session-1" },
    ));

    assert.deepEqual(calls, [{
        sessionId: "session-1",
        outcome: "Fixed",
        summary: "Applied and verified the fix.",
    }]);
    assert.deepEqual(result, {
        completed: true,
        jobId: "job-1",
        fromState: "Diagnosed",
        toState: "Fixed",
        outcome: "Fixed",
        journalSequence: 2,
    });
});

test("complete_state refuses calls without durable session identity", async () => {
    const [tool] = createJobLifecycleTools({
        async completeJobState() {
            throw new Error("must not be called");
        },
    });
    await assert.rejects(
        tool.handler({ summary: "Done." }, {}),
        /durable session context/,
    );
});
