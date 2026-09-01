import assert from "node:assert/strict";
import test from "node:test";
import {
    buildVisibleJobGeneratorTreeRows,
    jobGeneratorTreeSelectionKey,
    navigateJobGeneratorTree,
} from "../../ui/react/src/job-generator-tree-navigation.js";

const generators = [
    {
        id: "generator-1",
        jobs: [
            {
                id: "job-1",
                transitions: [
                    { id: "transition-1" },
                    { id: "transition-2" },
                ],
            },
            {
                id: "job-2",
                transitions: [],
            },
        ],
    },
    {
        id: "generator-2",
        jobs: [],
    },
];

test("visible rows follow expanded generator and Job state", () => {
    assert.deepEqual(
        buildVisibleJobGeneratorTreeRows(generators, new Set(), new Set())
            .map((row) => row.key),
        ["generator:generator-1", "generator:generator-2"],
    );

    assert.deepEqual(
        buildVisibleJobGeneratorTreeRows(
            generators,
            new Set(["generator-1"]),
            new Set(["job-1"]),
        ).map((row) => row.key),
        [
            "generator:generator-1",
            "job:generator-1:job-1",
            "transition:generator-1:job-1:transition-1",
            "transition:generator-1:job-1:transition-2",
            "job:generator-1:job-2",
            "generator:generator-2",
        ],
    );
});

test("up and down move through visible rows", () => {
    const rows = buildVisibleJobGeneratorTreeRows(
        generators,
        new Set(["generator-1"]),
        new Set(["job-1"]),
    );
    assert.equal(
        navigateJobGeneratorTree(rows, "job:generator-1:job-1", "ArrowDown").row.key,
        "transition:generator-1:job-1:transition-1",
    );
    assert.equal(
        navigateJobGeneratorTree(
            rows,
            "transition:generator-1:job-1:transition-1",
            "ArrowUp",
        ).row.key,
        "job:generator-1:job-1",
    );
});

test("right expands or enters children and left collapses or returns to parent", () => {
    const collapsedRows = buildVisibleJobGeneratorTreeRows(
        generators,
        new Set(),
        new Set(),
    );
    assert.equal(
        navigateJobGeneratorTree(
            collapsedRows,
            "generator:generator-1",
            "ArrowRight",
        ).type,
        "expand",
    );

    const expandedRows = buildVisibleJobGeneratorTreeRows(
        generators,
        new Set(["generator-1"]),
        new Set(["job-1"]),
    );
    assert.equal(
        navigateJobGeneratorTree(
            expandedRows,
            "generator:generator-1",
            "ArrowRight",
        ).row.key,
        "job:generator-1:job-1",
    );
    assert.equal(
        navigateJobGeneratorTree(
            expandedRows,
            "job:generator-1:job-1",
            "ArrowLeft",
        ).type,
        "collapse",
    );
    assert.equal(
        navigateJobGeneratorTree(
            expandedRows,
            "transition:generator-1:job-1:transition-1",
            "ArrowLeft",
        ).row.key,
        "job:generator-1:job-1",
    );
});

test("right expands containers with no children so their empty state is reachable", () => {
    const collapsedRows = buildVisibleJobGeneratorTreeRows(
        generators,
        new Set(),
        new Set(),
    );
    // Generator with zero materialized jobs still expands (reveals the
    // "No materialized jobs" empty state) instead of being a dead leaf.
    assert.equal(
        navigateJobGeneratorTree(
            collapsedRows,
            "generator:generator-2",
            "ArrowRight",
        ).type,
        "expand",
    );

    // Once expanded, an empty generator has no child to descend into.
    const expandedEmptyGenerator = buildVisibleJobGeneratorTreeRows(
        generators,
        new Set(["generator-2"]),
        new Set(),
    );
    assert.equal(
        navigateJobGeneratorTree(
            expandedEmptyGenerator,
            "generator:generator-2",
            "ArrowRight",
        ),
        null,
    );
    assert.equal(
        navigateJobGeneratorTree(
            expandedEmptyGenerator,
            "generator:generator-2",
            "ArrowLeft",
        ).type,
        "collapse",
    );

    // A job with zero lifecycle state runs is likewise expandable.
    const expandedGenerator = buildVisibleJobGeneratorTreeRows(
        generators,
        new Set(["generator-1"]),
        new Set(),
    );
    assert.equal(
        navigateJobGeneratorTree(
            expandedGenerator,
            "job:generator-1:job-2",
            "ArrowRight",
        ).type,
        "expand",
    );
});

test("selection keys match each tree level", () => {
    assert.equal(
        jobGeneratorTreeSelectionKey({ kind: "generator", generatorId: "g1" }),
        "generator:g1",
    );
    assert.equal(
        jobGeneratorTreeSelectionKey({ kind: "job", generatorId: "g1", jobId: "j1" }),
        "job:g1:j1",
    );
    assert.equal(
        jobGeneratorTreeSelectionKey({
            kind: "transition",
            generatorId: "g1",
            jobId: "j1",
            transitionId: "t1",
        }),
        "transition:g1:j1:t1",
    );
});
