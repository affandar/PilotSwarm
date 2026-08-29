import assert from "node:assert/strict";
import test from "node:test";
import {
    LifecycleStateTransitionError,
    parseLifecycleStateTransitions,
} from "../../dist/lifecycle-state-transitions.js";

test("parses only outgoing links from Possible next states", () => {
    const contract = parseLifecycleStateTransitions([
        "# Diagnose",
        "",
        "[Ignore](./Example.NotAState.md)",
        "",
        "## Possible next states",
        "",
        "- [Fixed](./Example.Fixed.md)",
        "2. [NeedsInfo](../states/Example.NeedsInfo.md?view=1)",
        "- [Diagnosed](state:Diagnosed)",
        "- `FixProposed` - cross-source handoff",
        "",
        "### Notes",
        "- [Ignored](./Example.Ignored.md)",
    ].join("\n"));

    assert.deepEqual(contract, {
        terminal: false,
        outcomes: [
            { outcome: "Fixed", toState: "Fixed" },
            { outcome: "NeedsInfo", toState: "NeedsInfo" },
            { outcome: "Diagnosed", toState: "Diagnosed" },
            { outcome: "FixProposed", toState: "FixProposed" },
        ],
    });
});

test("missing or empty Possible next states is terminal", () => {
    assert.deepEqual(parseLifecycleStateTransitions("# Done\n"), {
        terminal: true,
        outcomes: [],
    });
    assert.deepEqual(parseLifecycleStateTransitions([
        "# Done",
        "## Possible next states",
        "No transitions remain.",
    ].join("\n")), {
        terminal: true,
        outcomes: [],
    });
});

test("rejects malformed, mismatched, and duplicate next states", () => {
    assert.throws(() => parseLifecycleStateTransitions([
        "## Possible next states",
        "- [Fixed](./fixed.md)",
    ].join("\n")), LifecycleStateTransitionError);
    assert.throws(() => parseLifecycleStateTransitions([
        "## Possible next states",
        "- [Fixed](./Example.Other.md)",
    ].join("\n")), /does not match/);
    assert.throws(() => parseLifecycleStateTransitions([
        "## Possible next states",
        "- [Fixed](./Example.Fixed.md)",
        "- [Fixed](./Other.Fixed.md)",
    ].join("\n")), /Duplicate/);
    assert.throws(() => parseLifecycleStateTransitions([
        "## Possible next states",
        "- Fixed",
    ].join("\n")), /must be a Markdown link/);
});

test("ignores list examples inside fenced blocks", () => {
    assert.deepEqual(parseLifecycleStateTransitions([
        "## Possible next states",
        "```markdown",
        "- Not a real transition",
        "```",
    ].join("\n")), {
        terminal: true,
        outcomes: [],
    });
});
