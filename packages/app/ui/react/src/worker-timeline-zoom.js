export const WORKER_TIMELINE_ZOOM_LEVELS = Object.freeze([
    0.5,
    0.75,
    1,
    1.5,
    2,
    3,
]);

export const DEFAULT_WORKER_TIMELINE_ZOOM = 1;

export function normalizeWorkerTimelineZoom(value) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return DEFAULT_WORKER_TIMELINE_ZOOM;
    return WORKER_TIMELINE_ZOOM_LEVELS.reduce((closest, candidate) => (
        Math.abs(candidate - numeric) < Math.abs(closest - numeric) ? candidate : closest
    ), DEFAULT_WORKER_TIMELINE_ZOOM);
}

export function stepWorkerTimelineZoom(value, direction) {
    const current = normalizeWorkerTimelineZoom(value);
    const index = WORKER_TIMELINE_ZOOM_LEVELS.indexOf(current);
    const delta = direction === "out" || Number(direction) < 0 ? -1 : 1;
    const nextIndex = Math.max(
        0,
        Math.min(WORKER_TIMELINE_ZOOM_LEVELS.length - 1, index + delta),
    );
    return WORKER_TIMELINE_ZOOM_LEVELS[nextIndex];
}

export function computeWorkerTimelineZoomLayout({
    durationMs,
    laneCount,
    zoom,
    minimumChartHeight = 360,
}) {
    const normalizedZoom = normalizeWorkerTimelineZoom(zoom);
    const durationMinutes = Math.max(1, (Number(durationMs) || 0) / 60_000);
    const naturalHeight = Math.max(
        minimumChartHeight,
        Math.min(1_800, Math.round(durationMinutes * 18)),
    );
    const laneWidthPx = 142;
    return {
        zoom: normalizedZoom,
        chartHeight: Math.round(naturalHeight * normalizedZoom),
        chartWidth: 104 + (Math.max(1, Math.trunc(Number(laneCount) || 0)) * laneWidthPx),
        laneWidthPx,
        pixelsPerMinute: (naturalHeight * normalizedZoom) / durationMinutes,
    };
}
