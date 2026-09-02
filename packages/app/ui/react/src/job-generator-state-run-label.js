export function isCurrentStateRun(run) {
    if (run?.terminal) return false;
    if (run?.toState && run.toState !== run.fromState) return false;
    return true;
}

export function persistedStateRunLabel(run, options = "") {
    const { currentSuffix = "", pendingArrow = false } = typeof options === "string"
        ? { currentSuffix: options }
        : (options || {});
    if (run?.terminal) return `${run.stateName} completed`;
    if (run?.toState && run.toState !== run.fromState) {
        return `${run.fromState} → ${run.toState}`;
    }
    if (pendingArrow) return `${run?.stateName || "State"} → …`;
    return `${run?.stateName || "State"}${currentSuffix}`;
}
