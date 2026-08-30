import assert from "node:assert/strict";
import test from "node:test";
import { persistedStateRunLabel } from "../../ui/react/src/job-generator-state-run-label.js";

test("terminal state runs are labeled as completion instead of a self-transition", () => {
    assert.equal(
        persistedStateRunLabel({
            stateName: "Published",
            fromState: "Published",
            toState: "Published",
            terminal: true,
        }, " · current"),
        "Published completed",
    );
});

test("nonterminal state runs retain transition and current-state labels", () => {
    assert.equal(
        persistedStateRunLabel({
            stateName: "Diagnosed",
            fromState: "Diagnosed",
            toState: "FixProposed",
            terminal: false,
        }),
        "Diagnosed → FixProposed",
    );
    assert.equal(
        persistedStateRunLabel({
            stateName: "Diagnosed",
            terminal: false,
        }, " · current"),
        "Diagnosed · current",
    );
});
