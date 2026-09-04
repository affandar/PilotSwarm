import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
    DEFAULT_WORKER_TIMELINE_ZOOM,
    WORKER_TIMELINE_SPAN_LEVELS_MS,
    computeWorkerTimelineZoomLayout,
    defaultWorkerTimelineZoom,
    formatWorkerTimelineSpan,
    normalizeWorkerTimelineZoom,
    stepWorkerTimelineZoom,
} from "../../ui/react/src/worker-timeline-zoom.js";

globalThis.window = globalThis.window || {
    innerWidth: 1440,
    innerHeight: 900,
    devicePixelRatio: 1,
    matchMedia: () => ({
        matches: false,
        addEventListener() {},
        removeEventListener() {},
        addListener() {},
        removeListener() {},
    }),
    addEventListener() {},
    removeEventListener() {},
    requestAnimationFrame: () => 0,
    cancelAnimationFrame() {},
    getComputedStyle: () => ({ font: "13px monospace", getPropertyValue: () => "" }),
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
};
globalThis.document = globalThis.document || {
    documentElement: { style: { setProperty() {} }, classList: { add() {}, remove() {}, toggle() {} } },
    body: { classList: { add() {}, remove() {}, toggle() {} }, appendChild() {}, removeChild() {} },
    createElement: () => ({ style: {}, classList: { add() {} }, appendChild() {}, remove() {} }),
    querySelector: () => null,
    addEventListener() {},
    removeEventListener() {},
};
const { WorkerTimelineSwimlane } = await import("../../ui/react/src/web-app.js");

test("worker timeline zoom snaps to and steps along the span ladder", () => {
    assert.equal(normalizeWorkerTimelineZoom("bad"), DEFAULT_WORKER_TIMELINE_ZOOM);
    // Snaps an arbitrary value to the nearest visible-span level.
    assert.equal(normalizeWorkerTimelineZoom(1_400), 1_000);
    assert.equal(normalizeWorkerTimelineZoom(40_000), 30_000);
    // Zoom IN shrinks the visible span; zoom OUT grows it.
    assert.equal(stepWorkerTimelineZoom(1_000, "in"), 500);
    assert.equal(stepWorkerTimelineZoom(1_000, "out"), 2_000);
    // Clamped at both ends of the ladder (250ms .. 8h).
    assert.equal(stepWorkerTimelineZoom(250, "in"), 250);
    assert.equal(stepWorkerTimelineZoom(28_800_000, "out"), 28_800_000);
});

test("worker timeline zoom reaches sub-second in and multi-hour out", () => {
    assert.equal(WORKER_TIMELINE_SPAN_LEVELS_MS[0], 250);
    assert.equal(
        WORKER_TIMELINE_SPAN_LEVELS_MS[WORKER_TIMELINE_SPAN_LEVELS_MS.length - 1],
        28_800_000,
    );
    // Repeated zoom-in bottoms out at a quarter-second visible span.
    let deep = 60_000;
    for (let i = 0; i < 20; i += 1) deep = stepWorkerTimelineZoom(deep, "in");
    assert.equal(deep, 250);
    // Repeated zoom-out tops out at eight hours.
    let wide = 60_000;
    for (let i = 0; i < 20; i += 1) wide = stepWorkerTimelineZoom(wide, "out");
    assert.equal(wide, 28_800_000);
});

test("default zoom fits the whole run in the viewport", () => {
    // Smallest span >= duration ("fit").
    assert.equal(defaultWorkerTimelineZoom(45_000), 60_000);
    assert.equal(defaultWorkerTimelineZoom(90_000), 120_000);
    assert.equal(defaultWorkerTimelineZoom(250), 250);
    // Runs longer than the ladder clamp to the widest level.
    assert.equal(defaultWorkerTimelineZoom(36 * 3_600_000), 28_800_000);
    // Unknown duration falls back to the neutral default.
    assert.equal(defaultWorkerTimelineZoom(0), DEFAULT_WORKER_TIMELINE_ZOOM);
    assert.equal(defaultWorkerTimelineZoom("nope"), DEFAULT_WORKER_TIMELINE_ZOOM);
});

test("visible-span labels read as time, not percentages", () => {
    assert.equal(formatWorkerTimelineSpan(250), "250ms");
    assert.equal(formatWorkerTimelineSpan(1_000), "1s");
    assert.equal(formatWorkerTimelineSpan(1_500), "1.5s");
    assert.equal(formatWorkerTimelineSpan(30_000), "30s");
    assert.equal(formatWorkerTimelineSpan(60_000), "1m");
    assert.equal(formatWorkerTimelineSpan(90_000), "1.5m");
    assert.equal(formatWorkerTimelineSpan(3_600_000), "1h");
});

test("visible span sets density so exactly that span fills the viewport", () => {
    // A 10-minute run, viewport 600px: a 1-minute visible span means the whole
    // run is 10x taller than the viewport (600px per visible minute).
    const oneMinuteView = computeWorkerTimelineZoomLayout({
        durationMs: 10 * 60_000,
        laneCount: 4,
        zoom: 60_000,
        minimumChartHeight: 600,
    });
    assert.equal(oneMinuteView.visibleSpanMs, 60_000);
    assert.equal(oneMinuteView.chartHeight, 6_000);
    assert.equal(oneMinuteView.pixelsPerMinute, 600);

    // Zooming in to a 30s visible span doubles the density and chart height.
    const halfMinuteView = computeWorkerTimelineZoomLayout({
        durationMs: 10 * 60_000,
        laneCount: 4,
        zoom: 30_000,
        minimumChartHeight: 600,
    });
    assert.equal(halfMinuteView.chartHeight, 12_000);
    assert.equal(halfMinuteView.pixelsPerMinute, 1_200);

    // Lane geometry is independent of the time scale.
    assert.equal(halfMinuteView.chartWidth, oneMinuteView.chartWidth);
    assert.equal(halfMinuteView.laneWidthPx, oneMinuteView.laneWidthPx);
});

test("zooming out past the run length clamps the chart to the viewport", () => {
    // A 10-minute run at a 30-minute visible span already fits — the chart is
    // never shorter than the viewport.
    const wide = computeWorkerTimelineZoomLayout({
        durationMs: 10 * 60_000,
        laneCount: 4,
        zoom: 1_800_000,
        minimumChartHeight: 720,
    });
    assert.equal(wide.chartHeight, 720);
});

test("worker timeline renders registry name and accessible zoom controls at the selected scale", () => {
    const timeline = {
        workerName: "Repo Build Worker",
        workerNodeId: "worker-node-1",
        startAt: "2026-08-29T12:00:00.000Z",
        endAt: "2026-08-29T12:01:00.000Z",
        durationMs: 60_000,
        busyMs: 30_000,
        overheadMs: 5_000,
        capacityWaitMs: 20_000,
        idleMs: 25_000,
        lanes: [
            { key: "overhead", kind: "overhead", color: "yellow" },
            { key: "idle", kind: "idle", color: "gray" },
            {
                key: "job:1",
                kind: "job",
                jobId: "job-1",
                jobKey: "42",
                color: "cyan",
                status: "done",
                statusLabel: "DONE",
                activeMs: 30_000,
                queuedMs: 20_000,
                overheadMs: 5_000,
                humanWaitMs: 7_000,
                systemWaitMs: 3_000,
                waitMs: 10_000,
                efficiencyPercent: 55,
            },
        ],
        segments: [{
            key: "capacity:1",
            laneKey: "job:1",
            kind: "capacity_wait",
            sessionId: "session-1",
            compute: false,
            color: "red",
            startMs: Date.parse("2026-08-29T12:00:10.000Z"),
            endMs: Date.parse("2026-08-29T12:00:30.000Z"),
            durationMs: 20_000,
            label: "Queued · waiting for worker",
            activity: "No compute is allocated to this Job",
        }],
        markers: [{
            key: "materialized:job-1",
            laneKey: "job:1",
            kind: "materialization",
            sessionId: null,
            at: "2026-08-29T12:00:05.000Z",
            atMs: Date.parse("2026-08-29T12:00:05.000Z"),
            label: "Job materialized",
            activity: "Job materialized",
            color: "cyan",
        }],
    };
    const before = structuredClone(timeline);

    const html = renderToStaticMarkup(React.createElement(WorkerTimelineSwimlane, {
        timeline,
        theme: {},
        controller: {},
        zoom: 30_000,
        onZoomIn() {},
        onZoomOut() {},
    }));

    assert.match(html, /Worker utilization/);
    assert.match(html, /Repo Build Worker/);
    assert.match(html, /title="worker-node-1"/);
    assert.match(html, /aria-label="Zoom out worker timeline"/);
    assert.match(html, /aria-label="Zoom in worker timeline"/);
    assert.match(html, />30s<\/output>/);
    assert.match(html, /Worker utilization = active Job work \/ active worker time/);
    assert.match(html, /30000 ms/);
    assert.match(html, /35000 ms/);
    assert.match(html, /Platform overhead = platform overhead \/ active worker time/);
    assert.match(html, /Utilization 86% \+ overhead 14% = 100%/);
    assert.match(html, />86% utilized<\/span>/);
    assert.match(html, />14% overhead<\/span>/);
    assert.match(html, /width:max\(100%, 530px\)/);
    assert.match(html, /Queued · waiting for worker/);
    assert.match(html, /is-materialization/);
    assert.match(html, /Job materialized/);
    assert.match(html, />DONE<\/span>/);
    assert.match(html, />Active 30s<\/span>/);
    assert.match(html, />Queued 20s<\/span>/);
    assert.match(html, />Waits 10s<\/span>/);
    assert.match(html, />Efficiency 55%<\/span>/);
    assert.match(html, /waits are excluded from efficiency/);
    assert.deepEqual(timeline, before, "rendering at a different zoom does not mutate timeline data");
});
