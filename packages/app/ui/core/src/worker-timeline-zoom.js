export const WORKER_TIMELINE_SPAN_LEVELS_MS = Object.freeze([
    250,
    500,
    1_000,
    2_000,
    5_000,
    10_000,
    30_000,
    60_000,
    120_000,
    300_000,
    600_000,
    1_800_000,
    3_600_000,
    7_200_000,
    14_400_000,
    28_800_000,
]);

export const DEFAULT_WORKER_TIMELINE_ZOOM = 60_000;

const MAX_CHART_HEIGHT_PX = 6_000_000;
const MIN_SPAN_MS = WORKER_TIMELINE_SPAN_LEVELS_MS[0];
const MAX_SPAN_MS = WORKER_TIMELINE_SPAN_LEVELS_MS.at(-1);

export function normalizeWorkerTimelineZoom(value) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric) || numeric <= 0) return DEFAULT_WORKER_TIMELINE_ZOOM;
    // A midpoint tie consistently selects the smaller span (the earlier level).
    return WORKER_TIMELINE_SPAN_LEVELS_MS.reduce((closest, candidate) => (
        Math.abs(candidate - numeric) < Math.abs(closest - numeric) ? candidate : closest
    ), MIN_SPAN_MS);
}

export function defaultWorkerTimelineZoom(durationMs) {
    const duration = Number(durationMs);
    if (!Number.isFinite(duration) || duration <= 0) return DEFAULT_WORKER_TIMELINE_ZOOM;
    return WORKER_TIMELINE_SPAN_LEVELS_MS.find((span) => span >= duration) || MAX_SPAN_MS;
}

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

export function computeWorkerTimelineZoomLayout({
    durationMs,
    laneCount,
    zoom,
    minimumChartHeight = 360,
}) {
    const visibleSpanMs = normalizeWorkerTimelineZoom(zoom);
    const numericDuration = Number(durationMs);
    const totalDurationMs = Number.isFinite(numericDuration) && numericDuration > 0
        ? numericDuration
        : 1;
    const numericMinimumHeight = Number(minimumChartHeight);
    const viewportHeight = Number.isFinite(numericMinimumHeight) && numericMinimumHeight > 0
        ? Math.min(MAX_CHART_HEIGHT_PX, numericMinimumHeight)
        : 360;
    const requestedDensity = viewportHeight / visibleSpanMs;
    const scaledHeight = totalDurationMs * requestedDensity;
    const chartHeight = Math.min(
        MAX_CHART_HEIGHT_PX,
        Math.max(viewportHeight, Math.round(scaledHeight)),
    );
    const density = scaledHeight > MAX_CHART_HEIGHT_PX
        ? MAX_CHART_HEIGHT_PX / totalDurationMs
        : requestedDensity;
    const numericLaneCount = Number(laneCount);
    const normalizedLaneCount = Number.isFinite(numericLaneCount) && numericLaneCount > 0
        ? Math.trunc(numericLaneCount)
        : 1;
    const laneWidthPx = 142;
    return {
        zoom: visibleSpanMs,
        visibleSpanMs,
        chartHeight,
        chartWidth: 104 + (normalizedLaneCount * laneWidthPx),
        laneWidthPx,
        pixelsPerMinute: density * 60_000,
    };
}
