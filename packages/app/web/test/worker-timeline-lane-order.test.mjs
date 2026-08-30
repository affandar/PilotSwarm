import assert from "node:assert/strict";
import test from "node:test";
import {
    reconcileWorkerTimelineLaneOrder,
    reorderWorkerTimelineLane,
} from "../../ui/react/src/worker-timeline-lane-order.js";

const lanes = [
    { key: "overhead" },
    { key: "idle" },
    { key: "job:1" },
    { key: "job:2" },
];

test("worker timeline lane order preserves known choices and appends new lanes", () => {
    assert.deepEqual(
        reconcileWorkerTimelineLaneOrder(lanes, ["job:2", "idle", "removed", "job:2"]),
        ["job:2", "idle", "overhead", "job:1"],
    );
});

test("worker timeline lanes move before or after a drop target", () => {
    const order = lanes.map((lane) => lane.key);
    assert.deepEqual(
        reorderWorkerTimelineLane(order, "job:2", "idle", "before"),
        ["overhead", "job:2", "idle", "job:1"],
    );
    assert.deepEqual(
        reorderWorkerTimelineLane(order, "overhead", "job:2", "after"),
        ["idle", "job:1", "job:2", "overhead"],
    );
});
