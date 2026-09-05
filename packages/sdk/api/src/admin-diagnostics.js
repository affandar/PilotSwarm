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

export function projectWorker(row) {
    const health = {};
    for (const field of ["uptimeS", "rssBytes", "heapUsedBytes", "eventLoopDelayP99Ms", "activeSessions"]) {
        if (typeof row.health?.[field] === "number") health[field] = row.health[field];
    }
    for (const field of ["orchestrationSlots", "workerSlots"]) {
        if (typeof row.health?.[field]?.total === "number") health[field] = { total: row.health[field].total };
    }
    const packages = row.state?.["agent-packages"] || {};
    return { workerNodeId: row.workerNodeId, pool: row.pool, phase: row.phase,
        registeredAt: row.registeredAt, updatedAt: row.updatedAt,
        info: { sdkVersion: row.info?.sdkVersion, authz: row.info?.authz }, health,
        state: { "agent-packages": projectAgentWorkerState({ ...packages, workerNodeId: row.workerNodeId }) },
        contentRedacted: true };
}
