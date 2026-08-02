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

/**
 * The user's explicit ordering, as a rank map.
 *
 * Stored in the profile as an ARRAY of session ids in display order — a list
 * is what the user actually manipulates, and it survives round-tripping
 * through JSON without the gaps and collisions a rank object accumulates
 * after a few moves. Rank is just the index.
 */
export function buildManualOrderMap(manualOrder) {
    if (manualOrder instanceof Map) return manualOrder;
    const map = new Map();
    if (!Array.isArray(manualOrder)) return map;
    for (let index = 0; index < manualOrder.length; index += 1) {
        const sessionId = manualOrder[index];
        if (typeof sessionId !== "string" || !sessionId || map.has(sessionId)) continue;
        map.set(sessionId, index);
    }
    return map;
}

/**
 * Whether a row may be placed by hand.
 *
 * Movable: top-level sessions, folders (among themselves), pinned sessions
 * (among themselves), and the sessions inside a folder (among themselves).
 * Each of those is sorted as a sibling list, and the bands in
 * rankSessionBand keep the groups apart — system root, then pinned, then
 * folders, then loose sessions — so ordering never crosses a band.
 *
 * NOT movable: the system root (its position is the deployment's, not the
 * user's) and sub-agents. A sub-agent's place under its parent reflects the
 * shape of the run; letting a user shuffle it would misrepresent the tree.
 */
export function isManuallyOrderableSession(session) {
    return Boolean(session && !session.isSystem && !session.parentSessionId);
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

function sortSessions(a, b, stableOrderMap, pinnedIds, manualOrderMap) {
    const aRank = rankSessionBand(a, pinnedIds);
    const bRank = rankSessionBand(b, pinnedIds);
    if (aRank !== bRank) return aRank - bRank;

    const aSystemOrder = systemSessionOrder(a);
    const bSystemOrder = systemSessionOrder(b);
    if (aSystemOrder !== bSystemOrder) return aSystemOrder - bSystemOrder;

    // MANUAL ORDER — where the user put it, and the strongest signal there is
    // short of the structural bands above. One flat map covers every level:
    // top-level rows, folders, and sessions inside a folder are all sorted as
    // siblings within their parent's child list, so no per-level bookkeeping
    // is needed. A row with no manual rank sorts after every row that has one
    // (Infinity), which is what puts a brand-new session at the END.
    // Both rows must be movable for a placement to mean anything: a stray id
    // in the stored list must never reorder sub-agents or the system root.
    if (
        manualOrderMap && manualOrderMap.size > 0
        && isManuallyOrderableSession(a) && isManuallyOrderableSession(b)
    ) {
        const aManual = manualOrderMap.has(a.sessionId) ? manualOrderMap.get(a.sessionId) : Infinity;
        const bManual = manualOrderMap.has(b.sessionId) ? manualOrderMap.get(b.sessionId) : Infinity;
        if (aManual !== bManual) return aManual - bManual;
    }

    const aPreviousOrder = stableOrderMap.get(a.sessionId);
    const bPreviousOrder = stableOrderMap.get(b.sessionId);
    if (
        typeof aPreviousOrder === "number"
        && typeof bPreviousOrder === "number"
        && aPreviousOrder !== bPreviousOrder
    ) {
        return aPreviousOrder - bPreviousOrder;
    }

    // Least-recently-active first, matching the createdAt fallback below.
    // This ran newest-first before manual ordering, which is incompatible with
    // "a row stays where you put it": every incoming message would haul its
    // session back to the top past rows the user had deliberately placed.
    // Activity is still visible on the row; it no longer moves the row.
    const aSummaryAt = summaryTimestamp(a);
    const bSummaryAt = summaryTimestamp(b);
    if (aSummaryAt > 0 && bSummaryAt > 0 && aSummaryAt !== bSummaryAt) {
        return aSummaryAt - bSummaryAt;
    }

    // Oldest first, so an arriving session lands at the BOTTOM of its sibling
    // list and stays where the user last saw the list. (This is the inverse of
    // the newest-first order the list used before manual ordering existed —
    // "new things appear at the end" is only coherent if recency runs that
    // way too, otherwise a new row would jump to the top until it was dragged.)
    const createdDiff = (a.createdAt || 0) - (b.createdAt || 0);
    if (createdDiff !== 0) return createdDiff;

    const aTitle = String(a.title || "");
    const bTitle = String(b.title || "");
    const titleDiff = aTitle.localeCompare(bTitle);
    if (titleDiff !== 0) return titleDiff;

    return String(a.sessionId || "").localeCompare(String(b.sessionId || ""));
}

export function buildSessionTree(sessions = [], collapsedIds = new Set(), orderSource = [], pinnedIds = null, manualOrder = null) {
    const byId = new Map();
    const children = new Map();
    const stableOrderMap = buildStableOrderMap(orderSource);
    const manualOrderMap = buildManualOrderMap(manualOrder);
    const pinSet = pinnedIds instanceof Set
        ? pinnedIds
        : new Set(Array.isArray(pinnedIds) ? pinnedIds : []);

    for (const session of sessions) {
        byId.set(session.sessionId, session);
    }

    // A session that names a folder we have not loaded would be attached to
    // nothing and vanish from the list entirely — the containment invariant
    // must never cost visibility. Stand in a placeholder folder so its members
    // stay reachable under it; the real row replaces it on the next group
    // fetch (which also restores the real title and counts).
    const standIns = [];
    for (const session of sessions) {
        if (session.isGroup || !session.groupId || session.parentSessionId) continue;
        const key = `group:${session.groupId}`;
        if (byId.has(key)) continue;
        const standIn = {
            sessionId: key,
            groupId: session.groupId,
            isGroup: true,
            title: "Group",
            status: "group",
            shortSummary: "reconnecting…",
            createdAt: 0,
            updatedAt: 0,
        };
        byId.set(key, standIn);
        standIns.push(standIn);
    }
    const standInIds = new Set(standIns.map((row) => row.sessionId));
    if (standIns.length > 0) sessions = [...sessions, ...standIns];

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
        childList.sort((a, b) => sortSessions(a, b, stableOrderMap, pinSet, manualOrderMap));
    }

    const roots = sessions
        .filter((session) => {
            // INVARIANT: a session that belongs to something is never shown
            // outside it. These used to be conditioned on the container being
            // loaded, so a momentarily missing parent or folder promoted its
            // children to top level — sessions visibly jumping out of their
            // folder and back. Unattached children stay hidden until their
            // container arrives instead.
            if (session.parentSessionId) return false;
            if (!session.isGroup && session.groupId) return false;
            return true;
        })
        .sort((a, b) => sortSessions(a, b, stableOrderMap, pinSet, manualOrderMap));

    const flat = [];

    function visit(session, depth) {
        const childList = children.get(session.sessionId) || [];
        flat.push({
            sessionId: session.sessionId,
            depth,
            hasChildren: childList.length > 0,
            collapsed: collapsedIds.has(session.sessionId),
            // A stand-in is a view artifact of THIS tree, not state: it is not
            // in sessions.byId, so the row builder's lookup finds nothing and
            // renders an identity-less "[?]" line. Carry it on the entry.
            ...(standInIds.has(session.sessionId) ? { standIn: session } : {}),
        });
        if (collapsedIds.has(session.sessionId)) return;
        for (const child of childList) visit(child, depth + 1);
    }

    for (const root of roots) visit(root, 0);

    return flat;
}
