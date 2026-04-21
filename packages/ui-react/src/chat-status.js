import React from "react";

const DOT_FRAMES = [".\u00a0\u00a0", "..\u00a0", "..."];

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