import { systemSessionSortOrder } from "./system-titles.js";

function systemSessionOrder(session) {
    if (!session?.isSystem) return Number.MAX_SAFE_INTEGER;
    return systemSessionSortOrder(session);
}

function buildPreviousOrderMap(previousFlat = []) {
    const order = new Map();
    for (let index = 0; index < previousFlat.length; index += 1) {
        const sessionId = previousFlat[index]?.sessionId;
        if (!sessionId || order.has(sessionId)) continue;
        order.set(sessionId, index);
    }
    return order;
}

function buildStableOrderMap(orderSource = []) {
    if (orderSource instanceof Map) {
        return new Map(orderSource);
    }
    if (Array.isArray(orderSource)) {
        return buildPreviousOrderMap(orderSource);
    }
    const order = new Map();
    for (const [sessionId, index] of Object.entries(orderSource || {})) {
        if (!sessionId || typeof index !== "number" || Number.isNaN(index)) continue;
        order.set(sessionId, index);
    }
    return order;
}

function isTreePinnableSession(session) {
    return Boolean(
        session
        && !session.isSystem
        && (session.isGroup || (!session.parentSessionId && !session.groupId)),
    );
}

function isPinnedSession(session, pinnedIds) {
    return Boolean(isTreePinnableSession(session) && pinnedIds && pinnedIds.has(session.sessionId));
}

function rankSessionBand(session, pinnedIds) {
    if (session.isSystem) return 0;
    if (session.isGroup && isPinnedSession(session, pinnedIds)) return 1;
    if (isPinnedSession(session, pinnedIds)) return 2;
    if (session.isGroup) return 3;
    return 4;
}

function summaryTimestamp(session) {
    const raw = session?.updatedAt
        ?? session?.summaryUpdatedAt
        ?? session?.latestSummaryUpdatedAt;
    const value = typeof raw === "number" ? raw : Date.parse(raw || "");
    return Number.isFinite(value) ? value : 0;
}

function sortSessions(a, b, stableOrderMap, pinnedIds) {
    const aRank = rankSessionBand(a, pinnedIds);
    const bRank = rankSessionBand(b, pinnedIds);
    if (aRank !== bRank) return aRank - bRank;

    const aSystemOrder = systemSessionOrder(a);
    const bSystemOrder = systemSessionOrder(b);
    if (aSystemOrder !== bSystemOrder) return aSystemOrder - bSystemOrder;

    const aPreviousOrder = stableOrderMap.get(a.sessionId);
    const bPreviousOrder = stableOrderMap.get(b.sessionId);
    if (
        typeof aPreviousOrder === "number"
        && typeof bPreviousOrder === "number"
        && aPreviousOrder !== bPreviousOrder
    ) {
        return aPreviousOrder - bPreviousOrder;
    }

    const aSummaryAt = summaryTimestamp(a);
    const bSummaryAt = summaryTimestamp(b);
    if (aSummaryAt > 0 && bSummaryAt > 0 && aSummaryAt !== bSummaryAt) {
        return bSummaryAt - aSummaryAt;
    }

    const createdDiff = (b.createdAt || 0) - (a.createdAt || 0);
    if (createdDiff !== 0) return createdDiff;

    const aTitle = String(a.title || "");
    const bTitle = String(b.title || "");
    const titleDiff = aTitle.localeCompare(bTitle);
    if (titleDiff !== 0) return titleDiff;

    return String(a.sessionId || "").localeCompare(String(b.sessionId || ""));
}

export function buildSessionTree(sessions = [], collapsedIds = new Set(), orderSource = [], pinnedIds = null) {
    const byId = new Map();
    const children = new Map();
    const stableOrderMap = buildStableOrderMap(orderSource);
    const pinSet = pinnedIds instanceof Set
        ? pinnedIds
        : new Set(Array.isArray(pinnedIds) ? pinnedIds : []);

    for (const session of sessions) {
        byId.set(session.sessionId, session);
    }

    for (const session of sessions) {
        const groupParentId = !session.isGroup && session.groupId && !session.parentSessionId && byId.has(`group:${session.groupId}`)
            ? `group:${session.groupId}`
            : null;
        const parentId = session.parentSessionId || groupParentId;
        if (!parentId || !byId.has(parentId)) continue;
        if (!children.has(parentId)) children.set(parentId, []);
        children.get(parentId).push(session);
    }

    for (const childList of children.values()) {
        // Pins are a top-level concept. If a previously pinned session moves
        // into a group, the reducer prunes the pin and the tree ignores any
        // stale pin while ordering children.
        childList.sort((a, b) => sortSessions(a, b, stableOrderMap, pinSet));
    }

    const roots = sessions
        .filter((session) => {
            if (session.parentSessionId && byId.has(session.parentSessionId)) return false;
            if (!session.isGroup && session.groupId && !session.parentSessionId && byId.has(`group:${session.groupId}`)) return false;
            return true;
        })
        .sort((a, b) => sortSessions(a, b, stableOrderMap, pinSet));

    const flat = [];

    function visit(session, depth) {
        const childList = children.get(session.sessionId) || [];
        flat.push({
            sessionId: session.sessionId,
            depth,
            hasChildren: childList.length > 0,
            collapsed: collapsedIds.has(session.sessionId),
        });
        if (collapsedIds.has(session.sessionId)) return;
        for (const child of childList) visit(child, depth + 1);
    }

    for (const root of roots) visit(root, 0);

    return flat;
}
