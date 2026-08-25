/**
 * Canvas helpers shared by the session bridge (session-proxy.ts) and the app
 * catalog (canvas-app-catalog.ts). Kept in their own module so the catalog
 * can be exercised without importing the whole bridge, and so the bridge and
 * the catalog can never disagree about slot names or revision derivation.
 *
 * The session canvas: one reserved artifact per session slot, drawn by the
 * agent with draw_canvas and rendered live in the portal. The revision is
 * derived from the durable session.canvas_updated event log, not a counter
 * column — see docs/proposals/session-canvas.md.
 */

export const CANVAS_ARTIFACT_FILENAME = "canvas.html";

/** Slot 1 keeps the historical name; 2-5 are canvas2.html .. canvas5.html. */
export function canvasArtifactFilename(slot: number): string {
    return slot <= 1 ? CANVAS_ARTIFACT_FILENAME : `canvas${slot}.html`;
}

/** 1-5, defaulting absent to 1. Returns null for anything else. */
export function normalizeCanvasSlot(value: unknown): number | null {
    if (value === undefined || value === null || value === "") return 1;
    const n = Number(value);
    if (!Number.isInteger(n) || n < 1 || n > 5) return null;
    return n;
}

/** Event rows predate slots; a missing slot means slot 1. */
export function eventSlot(row: any): number {
    const n = Number(row?.data?.slot);
    return Number.isInteger(n) && n >= 1 && n <= 5 ? n : 1;
}

/**
 * Latest canvas draw's full data (rev + armed contract) from the durable
 * event log — the single authority. Reads a bounded window rather than
 * exactly one row and takes the max of the VALID revs it finds, so one
 * garbage event (rev missing, NaN, negative — injectable via
 * send_session_event, which validates nothing) cannot reset the sequence.
 *
 * No empty-coerce on failure: a transient read error that reads as "no
 * canvas" would mint rev 1 over a live rev-12 canvas. Callers route the
 * throw to a structured { error }.
 *
 * Window 30, not 5: five interleaved slots can push one slot's latest draw
 * well past a five-event window. The session_canvases table is the fast
 * path; this scan is the durable fallback.
 */
export async function latestCanvasEventData(catalog: any, sessionId: string, slot = 1): Promise<{ rev: number; responseContract?: Record<string, any> }> {
    const rows = await catalog.getSessionEventsBefore(
        sessionId, Number.MAX_SAFE_INTEGER, 30, ["session.canvas_updated"],
    );
    let latest: { rev: number; responseContract?: Record<string, any> } = { rev: 0 };
    for (const row of rows || []) {
        if (eventSlot(row) !== slot) continue;
        const rev = Number((row?.data as any)?.rev);
        if (Number.isFinite(rev) && Number.isInteger(rev) && rev > latest.rev) {
            latest = { rev, responseContract: (row?.data as any)?.responseContract };
        }
    }
    return latest;
}

/** The current canvas revision: table first (migration 0045), event scan as the durable fallback. */
export async function latestCanvasRev(catalog: any, sessionId: string, slot = 1): Promise<number> {
    try {
        const rows = await catalog.getSessionCanvases?.(sessionId);
        const hit = (rows || []).find((r: any) => Number(r.slot) === slot);
        if (hit && Number(hit.latestRev) > 0) return Number(hit.latestRev);
    } catch { /* fall through to the event scan */ }
    const rows = await catalog.getSessionEventsBefore(
        sessionId, Number.MAX_SAFE_INTEGER, 30, ["session.canvas_updated"],
    );
    let latest = 0;
    for (const row of rows || []) {
        if (eventSlot(row) !== slot) continue;
        const rev = Number((row?.data as any)?.rev);
        if (Number.isFinite(rev) && rev > latest && Number.isInteger(rev)) latest = rev;
    }
    return latest;
}
