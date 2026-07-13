/**
 * Regression: a zero-width "silent" assistant message must not reach the UI.
 *
 * Incident (2026-07-13): an IcM crawler ran a ~60s monitoring cron. The cron
 * prompt tells an agent with nothing to report to "end the turn silently" — but
 * every turn still emits a final answer, so the model complied by producing a
 * ZERO-WIDTH SPACE (U+200B) each cycle. The SDK already drops blank assistant
 * messages, but its check was `content.trim().length === 0`, and JS `trim()`
 * does not strip U+200B (it is a Unicode format char, not White_Space). So the
 * message was recorded and every UI rendered it as an empty "Agent:" line, once
 * a minute, indefinitely.
 *
 * Run: node --test test/unit/blank-assistant-content.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import { stripInvisibleContent } from "../../dist/managed-session.js";

test("zero-width space is blank — the exact character the incident produced", () => {
    assert.equal(stripInvisibleContent("​"), "");
    assert.equal(stripInvisibleContent("  ​ ​  "), "");
    // Proof the old check could not have caught it:
    assert.notEqual("​".trim().length, 0);
});

test("other invisible/format characters are blank too", () => {
    for (const ch of ["‌", "‍", "‎", "⁠", "﻿", " "]) {
        assert.equal(stripInvisibleContent(ch), "", `${JSON.stringify(ch)} should be blank`);
    }
});

test("real content survives, including content that merely contains a zero-width char", () => {
    assert.equal(stripInvisibleContent("Progress is steady."), "Progress is steady.");
    assert.equal(stripInvisibleContent("​w02 90/137 complete​"), "w02 90/137 complete");
    assert.equal(stripInvisibleContent("​ok​"), "ok");
});
