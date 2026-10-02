export function reconcileWorkerTimelineLaneOrder(lanes, preferredOrder = []) {
    const laneKeys = [];
    const available = new Set();
    for (const lane of Array.isArray(lanes) ? lanes : []) {
        const key = lane?.key;
        if (!key || available.has(key)) continue;
        available.add(key);
        laneKeys.push(key);
    }

    const ordered = [];
    const included = new Set();
    for (const key of Array.isArray(preferredOrder) ? preferredOrder : []) {
        if (!available.has(key) || included.has(key)) continue;
        included.add(key);
        ordered.push(key);
    }
    for (const key of laneKeys) {
        if (included.has(key)) continue;
        included.add(key);
        ordered.push(key);
    }
    return ordered;
}

export function reorderWorkerTimelineLane(order, sourceKey, targetKey, position = "before") {
    const current = Array.isArray(order) ? [...order] : [];
    if (
        !sourceKey
        || !targetKey
        || sourceKey === targetKey
        || !current.includes(sourceKey)
        || !current.includes(targetKey)
    ) {
        return current;
    }
    const withoutSource = current.filter((key) => key !== sourceKey);
    let targetIndex = withoutSource.indexOf(targetKey);
    if (position === "after") targetIndex += 1;
    withoutSource.splice(targetIndex, 0, sourceKey);
    return withoutSource;
}
