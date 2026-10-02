import assert from "node:assert/strict";
import test from "node:test";
import {
    DEFAULT_WORKER_TIMELINE_ZOOM,
    WORKER_TIMELINE_SPAN_LEVELS_MS,
    computeWorkerTimelineZoomLayout,
    defaultWorkerTimelineZoom,
    formatWorkerTimelineSpan,
    normalizeWorkerTimelineZoom,
    stepWorkerTimelineZoom,
} from "../src/worker-timeline-zoom.js";
import {
    reconcileWorkerTimelineLaneOrder,
    reorderWorkerTimelineLane,
} from "../src/worker-timeline-lane-order.js";

test("worker timeline zoom snaps deterministically at level boundaries", () => {
    assert.equal(normalizeWorkerTimelineZoom("bad"), DEFAULT_WORKER_TIMELINE_ZOOM);
    assert.equal(normalizeWorkerTimelineZoom(1_400), 1_000);
    assert.equal(normalizeWorkerTimelineZoom(1_500), 1_000);
    assert.equal(normalizeWorkerTimelineZoom(1_500.001), 2_000);
    assert.equal(stepWorkerTimelineZoom(1_000, "in"), 500);
    assert.equal(stepWorkerTimelineZoom(1_000, "out"), 2_000);
    assert.equal(stepWorkerTimelineZoom(WORKER_TIMELINE_SPAN_LEVELS_MS[0], "in"), 250);
    assert.equal(
        stepWorkerTimelineZoom(WORKER_TIMELINE_SPAN_LEVELS_MS.at(-1), "out"),
        28_800_000,
    );
});

test("worker timeline defaults fit known durations and format as time", () => {
    assert.equal(defaultWorkerTimelineZoom(45_000), 60_000);
    assert.equal(defaultWorkerTimelineZoom(60_000), 60_000);
    assert.equal(defaultWorkerTimelineZoom(60_001), 120_000);
    assert.equal(defaultWorkerTimelineZoom(36 * 3_600_000), 28_800_000);
    assert.equal(defaultWorkerTimelineZoom(0), DEFAULT_WORKER_TIMELINE_ZOOM);
    assert.equal(formatWorkerTimelineSpan(250), "250ms");
    assert.equal(formatWorkerTimelineSpan(90_000), "1.5m");
    assert.equal(formatWorkerTimelineSpan(3_600_000), "1h");
});

test("visible span deterministically controls timeline geometry", () => {
    const layout = computeWorkerTimelineZoomLayout({
        durationMs: 10 * 60_000,
        laneCount: 4,
        zoom: 60_000,
        minimumChartHeight: 600,
    });
    assert.deepEqual(layout, {
        zoom: 60_000,
        visibleSpanMs: 60_000,
        chartHeight: 6_000,
        chartWidth: 672,
        laneWidthPx: 142,
        pixelsPerMinute: 600,
    });

    const fit = computeWorkerTimelineZoomLayout({
        durationMs: 10 * 60_000,
        laneCount: 4,
        zoom: 1_800_000,
        minimumChartHeight: 720,
    });
    assert.equal(fit.chartHeight, 720);

    const capped = computeWorkerTimelineZoomLayout({
        durationMs: 1_000_000_000_000,
        laneCount: Number.POSITIVE_INFINITY,
        zoom: WORKER_TIMELINE_SPAN_LEVELS_MS[0],
        minimumChartHeight: Number.POSITIVE_INFINITY,
    });
    assert.equal(capped.chartHeight, 6_000_000);
    assert.equal(capped.chartWidth, 246);
    assert.equal(capped.pixelsPerMinute, 0.36);
});

test("lane order preserves known choices and appends new lanes deterministically", () => {
    const lanes = [
        { key: "overhead" },
        { key: "idle" },
        { key: "job:1" },
        { key: "job:2" },
        { key: "job:1" },
    ];
    assert.deepEqual(
        reconcileWorkerTimelineLaneOrder(lanes, ["job:2", "idle", "removed", "job:2"]),
        ["job:2", "idle", "overhead", "job:1"],
    );
});

test("lane reorder returns a new order without mutating its input", () => {
    const order = ["overhead", "idle", "job:1", "job:2"];
    assert.deepEqual(
        reorderWorkerTimelineLane(order, "job:2", "idle", "before"),
        ["overhead", "job:2", "idle", "job:1"],
    );
    assert.deepEqual(order, ["overhead", "idle", "job:1", "job:2"]);
    assert.deepEqual(
        reorderWorkerTimelineLane(order, "overhead", "job:2", "after"),
        ["idle", "job:1", "job:2", "overhead"],
    );
});
