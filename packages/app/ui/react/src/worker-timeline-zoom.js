// Span-based zoom ladder for the worker-utilization timeline.
//
// The control is NOT a percentage. Each level is a *visible span* — the amount
// of wall-clock time that fills the timeline viewport at that zoom. A smaller
// span means zoomed IN (a sub-second slice is spread across the whole pane;
// scroll to reach the rest); a larger span means zoomed OUT (hours are
// compressed into the pane). Framing zoom as "how much time fits on screen"
// lets an operator inspect sub-second scheduling detail or step back to a
// multi-hour overview with the same two buttons, instead of being boxed into a
// narrow 50%–300% multiplier range.
//
// Levels are a geometric ladder from a quarter-second to eight hours. They are
// deliberately coarse (roughly 2–3x between neighbours) so each click is a
// visible change rather than a nudge.
export const WORKER_TIMELINE_SPAN_LEVELS_MS = Object.freeze([
    250, // 0.25s
    500, // 0.5s
    1_000, // 1s
    2_000, // 2s
    5_000, // 5s
    10_000, // 10s
    30_000, // 30s
    60_000, // 1m
    120_000, // 2m
    300_000, // 5m
    600_000, // 10m
    1_800_000, // 30m
    3_600_000, // 1h
    7_200_000, // 2h
    14_400_000, // 4h
    28_800_000, // 8h
]);

// Neutral fallback (1 minute visible) used only when a duration-derived default
// cannot be computed yet. Real defaults come from defaultWorkerTimelineZoom().
export const DEFAULT_WORKER_TIMELINE_ZOOM = 60_000;

// Safety ceiling on the rendered chart height. Segments are percentage
// positioned and the axis tick count is bounded, so a tall chart is cheap DOM,
// but a runaway height (e.g. a 0.25s span across a multi-hour timeline) can
// exceed a browser's maximum element height. 6M px stays well under the
// Chrome/Firefox limits while still allowing very deep zoom on long timelines.
const MAX_CHART_HEIGHT_PX = 6_000_000;

const MIN_SPAN_MS = WORKER_TIMELINE_SPAN_LEVELS_MS[0];
const MAX_SPAN_MS = WORKER_TIMELINE_SPAN_LEVELS_MS[WORKER_TIMELINE_SPAN_LEVELS_MS.length - 1];

// Snap an arbitrary stored value to the nearest ladder level. Used so a
// persisted or hand-edited zoom always resolves to a real step.
export function normalizeWorkerTimelineZoom(value) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric) || numeric <= 0) return DEFAULT_WORKER_TIMELINE_ZOOM;
    return WORKER_TIMELINE_SPAN_LEVELS_MS.reduce((closest, candidate) => (
        Math.abs(candidate - numeric) < Math.abs(closest - numeric) ? candidate : closest
    ), MIN_SPAN_MS);
}

// The default zoom for a freshly opened timeline: the smallest span that still
// shows the whole run in the viewport (i.e. "fit"). Falls back to the widest
// level when the run is longer than the ladder's top, and to the neutral
// default when the duration is unknown.
export function defaultWorkerTimelineZoom(durationMs) {
    const duration = Number(durationMs);
    if (!Number.isFinite(duration) || duration <= 0) return DEFAULT_WORKER_TIMELINE_ZOOM;
    return WORKER_TIMELINE_SPAN_LEVELS_MS.find((span) => span >= duration) || MAX_SPAN_MS;
}

// Step one level along the ladder. Zoom IN shrinks the visible span (more
// detail, toward MIN_SPAN_MS); zoom OUT grows it (broader overview, toward
// MAX_SPAN_MS). Clamps at both ends.
export function stepWorkerTimelineZoom(value, direction) {
    const current = normalizeWorkerTimelineZoom(value);
    const index = WORKER_TIMELINE_SPAN_LEVELS_MS.indexOf(current);
    const zoomingOut = direction === "out" || Number(direction) < 0;
    const delta = zoomingOut ? 1 : -1;
    const nextIndex = Math.max(
        0,
        Math.min(WORKER_TIMELINE_SPAN_LEVELS_MS.length - 1, index + delta),
    );
    return WORKER_TIMELINE_SPAN_LEVELS_MS[nextIndex];
}

// Human label for the visible span shown on the control, e.g. "250ms", "1s",
// "30s", "2m", "1h". Sub-second is rendered in milliseconds so the sub-second
// zoom levels read naturally.
export function formatWorkerTimelineSpan(ms) {
    const value = Math.max(0, Number(ms) || 0);
    if (value < 1_000) return `${Math.round(value)}ms`;
    if (value < 60_000) {
        const seconds = value / 1_000;
        return `${Number.isInteger(seconds) ? seconds : seconds.toFixed(1)}s`;
    }
    if (value < 3_600_000) {
        const minutes = value / 60_000;
        return `${Number.isInteger(minutes) ? minutes : minutes.toFixed(1)}m`;
    }
    const hours = value / 3_600_000;
    return `${Number.isInteger(hours) ? hours : hours.toFixed(1)}h`;
}

// Translate the selected span into a concrete chart geometry.
//
//   density (px/ms) = viewportHeight / visibleSpanMs
//
// so exactly `visibleSpanMs` of wall-clock time fills the viewport, and the
// whole run occupies `durationMs * density` — taller than the viewport when
// zoomed in (the pane scrolls), clamped up to the viewport when zoomed out far
// enough that the whole run fits.
export function computeWorkerTimelineZoomLayout({
    durationMs,
    laneCount,
    zoom,
    minimumChartHeight = 360,
}) {
    const visibleSpanMs = normalizeWorkerTimelineZoom(zoom);
    const totalDurationMs = Math.max(1, Number(durationMs) || 0);
    const viewportHeight = Math.max(1, Number(minimumChartHeight) || 0);
    const density = viewportHeight / visibleSpanMs;
    const chartHeight = Math.min(
        MAX_CHART_HEIGHT_PX,
        Math.max(viewportHeight, Math.round(totalDurationMs * density)),
    );
    const laneWidthPx = 142;
    return {
        zoom: visibleSpanMs,
        visibleSpanMs,
        chartHeight,
        chartWidth: 104 + (Math.max(1, Math.trunc(Number(laneCount) || 0)) * laneWidthPx),
        laneWidthPx,
        pixelsPerMinute: density * 60_000,
    };
}
