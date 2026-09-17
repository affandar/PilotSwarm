/** CMS timestamps are epoch milliseconds; tolerate ISO timestamps from older adapters. */
export function sessionTimestampMillis(value: unknown): number {
    const millis = typeof value === "number"
        ? value
        // Require an explicit timezone: durable replay must not depend on the worker's TZ.
        : typeof value === "string" && /^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value)
            ? Date.parse(value)
            : NaN;
    return Number.isFinite(millis) ? new Date(millis).getTime() : NaN;
}

/** Never invent a creation/update time for incomplete catalog rows. */
export function formatSessionTimestamp(value: unknown): string {
    const millis = sessionTimestampMillis(value);
    return Number.isFinite(millis) ? new Date(millis).toISOString() : "unknown";
}
