/**
 * The <system_context> block: what orchestration 1.0.71 appends to the user
 * turn, and what session-proxy splits off again before persisting.
 *
 * Run: node --test test/unit/prompt-system-context.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
    appendSystemContextBlock,
    splitSystemContextBlock,
    SYSTEM_CONTEXT_OPEN,
    SYSTEM_CONTEXT_CLOSE,
} from "../../dist/prompt-system-context.js";

test("append then split is a round trip", () => {
    const out = appendSystemContextBlock("Continue with your task.", 'Wait reason: "poll the child". Resume now.');
    assert.equal(out, `Continue with your task.\n\n${SYSTEM_CONTEXT_OPEN}\nWait reason: "poll the child". Resume now.\n${SYSTEM_CONTEXT_CLOSE}`);
    assert.deepEqual(splitSystemContextBlock(out), {
        prompt: "Continue with your task.",
        note: 'Wait reason: "poll the child". Resume now.',
    });
});

test("an empty note appends nothing", () => {
    assert.equal(appendSystemContextBlock("hello", undefined), "hello");
    assert.equal(appendSystemContextBlock("hello", "   "), "hello");
});

test("a note with no user text is a bare block", () => {
    const out = appendSystemContextBlock("", "only a note");
    assert.equal(out, `${SYSTEM_CONTEXT_OPEN}\nonly a note\n${SYSTEM_CONTEXT_CLOSE}`);
    assert.deepEqual(splitSystemContextBlock(out), { prompt: "", note: "only a note" });
});

test("a prompt with no block is returned unchanged, note absent", () => {
    assert.deepEqual(splitSystemContextBlock("just a user message"), { prompt: "just a user message" });
    assert.deepEqual(splitSystemContextBlock(undefined), { prompt: "" });
});

test("only a block that CLOSES the prompt counts — a tag quoted mid-text is user content", () => {
    const text = `The model said ${SYSTEM_CONTEXT_OPEN} earlier, which was odd.\n\nAnyway, continue.`;
    assert.deepEqual(splitSystemContextBlock(text), { prompt: text });
});

test("the LAST block wins when the prompt carries two — the trailing one is the orchestration's", () => {
    const inner = appendSystemContextBlock("user text", "first");
    const out = appendSystemContextBlock(inner, "second");
    const split = splitSystemContextBlock(out);
    assert.equal(split.note, "second");
    assert.ok(split.prompt.endsWith(SYSTEM_CONTEXT_CLOSE), "the earlier block stays in the prompt");
});

test("multi-line notes survive intact", () => {
    const note = "Buffered child updates arrived:\n  - Agent a\n    Status: completed\n  - Agent b\n    Status: waiting";
    const split = splitSystemContextBlock(appendSystemContextBlock("Continue.", note));
    assert.equal(split.note, note);
});
