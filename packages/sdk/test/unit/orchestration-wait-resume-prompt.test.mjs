import assert from "node:assert/strict";
import test from "node:test";
import {
    buildWaitResumePrompt,
    callerReauthBackoffSeconds,
} from "../../dist/orchestration/turn.js";
import { extractPromptSystemContext } from "../../dist/orchestration/utils.js";

test("replays a prompt that was parked before reaching the model", () => {
    const original = "Investigate the failing deployment.";
    const prompt = buildWaitResumePrompt({
        reason: "needs re-auth",
        resumePrompt: original,
    }, 60);

    assert.ok(prompt.startsWith(original), "the original user prompt is replayed");
    assert.match(prompt, /not previously delivered to the model/i);
});

test("repeated re-auth retries do not accumulate system context", () => {
    const original = "Investigate the failing deployment.";
    const first = buildWaitResumePrompt({
        reason: "needs re-auth",
        resumePrompt: original,
    }, 60);
    const replay = extractPromptSystemContext(first).prompt;
    const second = buildWaitResumePrompt({
        reason: "needs re-auth",
        resumePrompt: replay,
    }, 120);

    assert.equal(replay, original);
    assert.equal(second.length, first.length);
});

test("caller re-auth retries back off to fifteen minutes", () => {
    assert.deepEqual(
        [1, 2, 3, 4, 5, 6].map(callerReauthBackoffSeconds),
        [60, 120, 240, 480, 900, 900],
    );
});

test("ordinary waits retain the generic continuation prompt", () => {
    const prompt = buildWaitResumePrompt({
        reason: "waiting for deployment",
    }, 30, "Deploy the service.");

    assert.ok(
        prompt.startsWith("The 30 second wait is now complete. Continue with your task."),
    );
    assert.match(prompt, /Original user request: "Deploy the service\."/);
});
