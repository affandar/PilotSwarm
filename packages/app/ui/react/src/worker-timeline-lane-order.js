export function reconcileWorkerTimelineLaneOrder(lanes, preferredOrder = []) {
    const laneKeys = Array.isArray(lanes)
        ? lanes.map((lane) => lane?.key).filter(Boolean)
        : [];
    const available = new Set(laneKeys);
    const ordered = [];
    for (const key of Array.isArray(preferredOrder) ? preferredOrder : []) {
        if (!available.has(key) || ordered.includes(key)) continue;
        ordered.push(key);
    }
    for (const key of laneKeys) {
        if (!ordered.includes(key)) ordered.push(key);
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
