import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
    DEFAULT_WORKER_TIMELINE_ZOOM,
    computeWorkerTimelineZoomLayout,
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

test("worker timeline zoom uses bounded, deterministic steps", () => {
    assert.equal(normalizeWorkerTimelineZoom("bad"), DEFAULT_WORKER_TIMELINE_ZOOM);
    assert.equal(normalizeWorkerTimelineZoom(1.4), 1.5);
    assert.equal(stepWorkerTimelineZoom(1, "in"), 1.5);
    assert.equal(stepWorkerTimelineZoom(1, "out"), 0.75);
    assert.equal(stepWorkerTimelineZoom(3, "in"), 3);
    assert.equal(stepWorkerTimelineZoom(0.5, "out"), 0.5);
});

test("worker timeline zoom changes only the time scale without changing lane geometry or data", () => {
    const base = computeWorkerTimelineZoomLayout({
        durationMs: 10 * 60_000,
        laneCount: 4,
        zoom: 1,
    });
    const zoomed = computeWorkerTimelineZoomLayout({
        durationMs: 10 * 60_000,
        laneCount: 4,
        zoom: 2,
    });

    assert.equal(zoomed.chartHeight, base.chartHeight * 2);
    assert.equal(zoomed.pixelsPerMinute, base.pixelsPerMinute * 2);
    assert.equal(zoomed.chartWidth, base.chartWidth);
    assert.equal(zoomed.laneWidthPx, base.laneWidthPx);
});

test("full-screen viewport height remains zoomable instead of becoming a fixed floor", () => {
    const zoomedOut = computeWorkerTimelineZoomLayout({
        durationMs: 10 * 60_000,
        laneCount: 4,
        zoom: 0.5,
        minimumChartHeight: 720,
    });
    const defaultZoom = computeWorkerTimelineZoomLayout({
        durationMs: 10 * 60_000,
        laneCount: 4,
        zoom: 1,
        minimumChartHeight: 720,
    });
    const zoomedIn = computeWorkerTimelineZoomLayout({
        durationMs: 10 * 60_000,
        laneCount: 4,
        zoom: 2,
        minimumChartHeight: 720,
    });

    assert.equal(zoomedOut.chartHeight, 360);
    assert.equal(defaultZoom.chartHeight, 720);
    assert.equal(zoomedIn.chartHeight, 1_440);
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
        zoom: 2,
        onZoomIn() {},
        onZoomOut() {},
    }));

    assert.match(html, /Worker utilization/);
    assert.match(html, /Repo Build Worker/);
    assert.match(html, /title="worker-node-1"/);
    assert.match(html, /aria-label="Zoom out worker timeline"/);
    assert.match(html, /aria-label="Zoom in worker timeline"/);
    assert.match(html, />200%<\/output>/);
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
