import React from "react";

const DOT_FRAMES = [".\u00a0\u00a0", "..\u00a0", "..."];

const SPINNER_FRAMES = ["\u280b", "\u2819", "\u2839", "\u2838", "\u283c", "\u2834", "\u2826", "\u2827", "\u2807", "\u280f"];

// Braille spinner frame that advances while `active`, for the live activity
// line's leading marker. Returns "" when inactive so callers can fall back to a
// static glyph.
export function useSpinnerFrame(active, intervalMs = 120) {
    const [frameIndex, setFrameIndex] = React.useState(0);

    React.useEffect(() => {
        if (!active) {
            setFrameIndex(0);
            return undefined;
        }
        const timer = setInterval(() => {
            setFrameIndex((current) => (current + 1) % SPINNER_FRAMES.length);
        }, intervalMs);
        return () => clearInterval(timer);
    }, [active, intervalMs]);

    return active ? SPINNER_FRAMES[frameIndex] : "";
}

export function useAnimatedDots(active, intervalMs = 360) {
    const [frameIndex, setFrameIndex] = React.useState(0);

    React.useEffect(() => {
        if (!active) {
            setFrameIndex(0);
            return undefined;
        }

        const timer = setInterval(() => {
            setFrameIndex((current) => (current + 1) % DOT_FRAMES.length);
        }, intervalMs);

        return () => clearInterval(timer);
    }, [active, intervalMs]);

    return active ? DOT_FRAMES[frameIndex] : "";
}

export function appendAnimatedDotsToRuns(runs, dots = "") {
    if (!Array.isArray(runs) || runs.length === 0) return null;
    if (!dots) return runs;

    const lastRun = runs[runs.length - 1] || {};
    return [
        ...runs,
        {
            text: dots,
            color: lastRun.color || "gray",
            bold: Boolean(lastRun.bold),
            underline: Boolean(lastRun.underline),
            backgroundColor: lastRun.backgroundColor,
        },
    ];
}