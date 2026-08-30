export function persistedStateRunLabel(run, currentSuffix = "") {
    if (run?.terminal) return `${run.stateName} completed`;
    if (run?.toState && run.toState !== run.fromState) {
        return `${run.fromState} → ${run.toState}`;
    }
    return `${run?.stateName || "State"}${currentSuffix}`;
}
