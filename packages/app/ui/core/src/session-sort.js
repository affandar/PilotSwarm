import { buildSessionTree } from "./session-tree.js";

export const normalizeSessionSortMode = mode => ["used", "updated"].includes(mode) ? mode : "saved";
export function normalizeSessionUsage(value) {
    return Object.fromEntries(Object.entries(value || {}).filter(([id, at]) => id && Number.isFinite(at) && at > 0));
}
export function snapshotSessionOrder(sessions, mode) {
    const saved = buildSessionTree(Object.values(sessions.byId), new Set(), sessions.orderById, sessions.pinnedIds, sessions.manualOrder);
    const rank = new Map(saved.map((row, index) => [row.sessionId, index]));
    const timestamp = session => {
        if (mode === "used") return sessions.usedAt?.[session.sessionId] || 0;
        const raw = session.updatedAt ?? session.summaryUpdatedAt ?? session.latestSummaryUpdatedAt;
        const value = typeof raw === "number" ? raw : Date.parse(raw || "");
        return Number.isFinite(value) ? value : 0;
    };
    return Object.values(sessions.byId).sort((a, b) => timestamp(b) - timestamp(a)
        || (rank.get(a.sessionId) ?? Infinity) - (rank.get(b.sessionId) ?? Infinity))
        .map(session => session.sessionId);
}

// Live catalog and usage changes update row contents, never existing positions.
// A mode change or explicit refresh captures the next order. New rows append.
export function reconcileSessionSort(previous, next, action) {
    const sessions = next.sessions;
    if (!sessions) return next;
    const mode = normalizeSessionSortMode(sessions.sortMode);
    const modeChanged = mode !== normalizeSessionSortMode(previous.sessions?.sortMode);
    const refresh = action.type === "sessions/refreshSort";
    const rebuild = sessions.flat !== previous.sessions?.flat || sessions.byId !== previous.sessions?.byId || modeChanged || refresh;
    if (!rebuild) return next;
    let sortSnapshot = sessions.sortSnapshot;
    if (mode !== "saved") {
        if (!sessions.listingSeen) sortSnapshot = [];
        else if (modeChanged || refresh || !sortSnapshot?.length) sortSnapshot = snapshotSessionOrder(sessions, mode);
        else {
            const known = new Set(sortSnapshot);
            const added = Object.keys(sessions.byId).filter(id => !known.has(id));
            if (added.length) sortSnapshot = [...sortSnapshot, ...added];
        }
    }
    const flat = mode === "saved" && !modeChanged ? sessions.flat : buildSessionTree(
        Object.values(sessions.byId), sessions.collapsedIds, sessions.orderById,
        sessions.pinnedIds, mode === "saved" ? sessions.manualOrder : sortSnapshot);
    return { ...next, sessions: { ...sessions, sortSnapshot, flat } };
}
