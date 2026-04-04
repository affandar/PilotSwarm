function systemSessionOrder(session) {
    if (!session?.isSystem) return Number.MAX_SAFE_INTEGER;
    const agentId = String(session.agentId || "");
    if (agentId === "pilotswarm") return 0;
    if (agentId === "sweeper") return 1;
    if (agentId === "resourcemgr") return 2;
    if (agentId === "facts-manager") return 3;
    return 10;
}

function rankSystemSession(session) {
    if (!session.isSystem) return 1;
    return 0;
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

function sortSessions(a, b, stableOrderMap) {
    const aRank = rankSystemSession(a);
    const bRank = rankSystemSession(b);
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

    const createdDiff = (b.createdAt || 0) - (a.createdAt || 0);
    if (createdDiff !== 0) return createdDiff;

    const aTitle = String(a.title || "");
    const bTitle = String(b.title || "");
    const titleDiff = aTitle.localeCompare(bTitle);
    if (titleDiff !== 0) return titleDiff;

    return String(a.sessionId || "").localeCompare(String(b.sessionId || ""));
}

export function buildSessionTree(sessions = [], collapsedIds = new Set(), orderSource = []) {
    const byId = new Map();
    const children = new Map();
    const stableOrderMap = buildStableOrderMap(orderSource);

    for (const session of sessions) {
        byId.set(session.sessionId, session);
    }

    for (const session of sessions) {
        const parentId = session.parentSessionId;
        if (!parentId || !byId.has(parentId)) continue;
        if (!children.has(parentId)) children.set(parentId, []);
        children.get(parentId).push(session);
    }

    for (const childList of children.values()) {
        childList.sort((a, b) => sortSessions(a, b, stableOrderMap));
    }

    const roots = sessions
        .filter((session) => !session.parentSessionId || !byId.has(session.parentSessionId))
        .sort((a, b) => sortSessions(a, b, stableOrderMap));

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
