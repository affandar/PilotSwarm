/** Content-free operational projections. Use only for a restricted viewer. */
export function projectUserAccounting(stats) {
    return { ...stats, users: (stats.users || []).map((user) => ({
        ...user, sessionIds: [],
        byModel: (user.byModel || []).map((model) => ({ ...model, sessionIds: [] })),
    })) };
}

export function projectFleetAccounting(stats) {
    const groups = new Map();
    for (const row of stats.byAgent || []) {
        const key = row.model ?? null;
        const group = groups.get(key) || { agentId: null, model: key };
        for (const [field, value] of Object.entries(row)) {
            if (typeof value === "number" && field !== "cacheHitRatio") group[field] = (group[field] || 0) + value;
        }
        group.cacheHitRatio = group.totalTokensInput > 0 ? group.totalTokensCacheRead / group.totalTokensInput : null;
        groups.set(key, group);
    }
    return { ...stats, byAgent: [...groups.values()], contentRedacted: true };
}

export function projectAgentWorkerState(row) {
    const installed = Object.values(row.installed || {});
    return { workerNodeId: row.workerNodeId, epoch: row.epoch, updatedAt: row.updatedAt,
        installed: {}, installedCount: installed.length,
        errorCount: installed.filter((entry) => entry?.status === "error").length,
        contentRedacted: true };
}

// Keep the browser-safe API independent of the SDK runtime. The diagnostics
// contract test checks this allowlist against the code-owned feature registry.
const PUBLIC_FEATURE_KEYS = new Set(["copilot.native_tasks", "agents.base_v2"]);
const isRecord = value => value !== null && typeof value === "object" && !Array.isArray(value);
const isRevision = value => typeof value === "string" && /^[1-9]\d{0,18}$/.test(value)
    && BigInt(value) <= 9223372036854775807n;
const isTimestamp = value => typeof value === "string"
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
    && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;

/** Safe configuration delivery telemetry; absent or invalid fields stay unknown. */
export function projectFeatureWorkerState(state) {
    if (!isRecord(state)) return undefined;
    const result = {};
    if (Number.isSafeInteger(state.protocolVersion) && state.protocolVersion > 0) result.protocolVersion = state.protocolVersion;
    if (typeof state.initialized === "boolean") result.initialized = state.initialized;
    if (Array.isArray(state.supportedKeys) && state.supportedKeys.every(key => typeof key === "string")) {
        result.supportedKeys = [...new Set(state.supportedKeys.filter(key => PUBLIC_FEATURE_KEYS.has(key)))];
    }
    if (isRecord(state.appliedRevisions)) {
        result.appliedRevisions = Object.fromEntries(Object.entries(state.appliedRevisions)
            .filter(([key, revision]) => PUBLIC_FEATURE_KEYS.has(key) && isRevision(revision)));
    }
    for (const field of ["lastCheckedAt", "lastLoadedAt"]) {
        if (state[field] === null || isTimestamp(state[field])) result[field] = state[field];
    }
    if (state.nativeCapability === "sync" || state.nativeCapability === "off") result.nativeCapability = state.nativeCapability;
    if (state.lastError === null || typeof state.lastError === "string") {
        result.hasRefreshError = Boolean(state.lastError);
    } else if (typeof state.hasRefreshError === "boolean") {
        result.hasRefreshError = state.hasRefreshError;
    }
    return result;
}

export function projectWorker(row) {
    const health = {};
    for (const field of ["uptimeS", "rssBytes", "heapUsedBytes", "eventLoopDelayP99Ms", "activeSessions"]) {
        if (typeof row.health?.[field] === "number") health[field] = row.health[field];
    }
    for (const field of ["orchestrationSlots", "workerSlots"]) {
        if (typeof row.health?.[field]?.total === "number") health[field] = { total: row.health[field].total };
    }
    const packages = row.state?.["agent-packages"] || {};
    const features = projectFeatureWorkerState(row.state?.["feature-flags"]);
    return { workerNodeId: row.workerNodeId, pool: row.pool, phase: row.phase,
        registeredAt: row.registeredAt, updatedAt: row.updatedAt,
        info: { sdkVersion: row.info?.sdkVersion, authz: row.info?.authz }, health,
        state: { "agent-packages": projectAgentWorkerState({ ...packages, workerNodeId: row.workerNodeId }),
            ...(features ? { "feature-flags": features } : {}) },
        contentRedacted: true };
}
