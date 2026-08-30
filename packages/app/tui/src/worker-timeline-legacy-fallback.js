function timestampMs(value) {
    const numeric = typeof value === "number" ? value : new Date(value).getTime();
    return Number.isFinite(numeric) ? numeric : Number.NaN;
}

function parseJsonObject(value) {
    if (value && typeof value === "object" && !Array.isArray(value)) return value;
    if (typeof value !== "string") return null;
    try {
        const parsed = JSON.parse(value);
        return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
    } catch {
        return null;
    }
}

export function legacyAnswerDeliveryBoundaries(history = []) {
    const boundaries = [];
    for (const event of Array.isArray(history) ? history : []) {
        if (event?.kind !== "QueueEventDelivered") continue;
        const envelope = parseJsonObject(event.data);
        if (envelope?.name !== "messages") continue;
        const payload = parseJsonObject(envelope.data);
        if (!payload || !Object.prototype.hasOwnProperty.call(payload, "answer")) continue;
        const atMs = Number(event.timestampMs);
        if (!Number.isFinite(atMs)) continue;
        boundaries.push({
            key: `${event.executionId ?? "execution"}:${event.eventId ?? boundaries.length}`,
            atMs,
        });
    }
    return boundaries.sort((a, b) => a.atMs - b.atMs || a.key.localeCompare(b.key));
}

function acquisitionCandidate(entries, answerAtMs, beforeMs) {
    const inWindow = (candidateMs) => (
        Number.isFinite(candidateMs)
        && candidateMs > answerAtMs
        && candidateMs < beforeMs
    );
    const byStartedAt = entries
        .filter((entry) => entry?.eventType === "session.turn_completed")
        .map((entry) => ({
            entry,
            atMs: timestampMs(entry?.details?.startedAt),
            source: "session.turn_completed details.startedAt",
        }))
        .filter((candidate) => inWindow(candidate.atMs))
        .sort((a, b) => a.atMs - b.atMs)[0];
    if (byStartedAt) return byStartedAt;

    for (const [eventTypes, source] of [
        [["session.worker_capacity_acquired"], "session.worker_capacity_acquired"],
        [["session.lossy_handoff", "session.hydrated"], "session preparation"],
        [["session.turn_started"], "session.turn_started"],
    ]) {
        const candidate = entries
            .filter((entry) => eventTypes.includes(entry?.eventType))
            .map((entry) => ({
                entry,
                atMs: entry?.eventType === "session.worker_capacity_acquired"
                    ? timestampMs(entry?.details?.acquiredAt || entry?.at)
                    : timestampMs(entry?.at),
                source,
            }))
            .filter((entry) => inWindow(entry.atMs))
            .sort((a, b) => a.atMs - b.atMs)[0];
        if (candidate) return candidate;
    }
    return null;
}

export function deriveLegacyHumanInputCapacityWaits({
    timeline,
    historiesBySessionId,
    workerNodeId,
}) {
    const entries = Array.isArray(timeline)
        ? [...timeline].sort((a, b) => timestampMs(a?.at) - timestampMs(b?.at))
        : [];
    const bySession = new Map();
    for (const entry of entries) {
        if (!entry?.sessionId) continue;
        const sessionEntries = bySession.get(entry.sessionId) || [];
        sessionEntries.push(entry);
        bySession.set(entry.sessionId, sessionEntries);
    }

    const synthetic = [];
    for (const [sessionId, sessionEntries] of bySession) {
        const waits = sessionEntries.filter(
            (entry) => entry?.eventType === "session.input_required_started",
        );
        if (waits.length === 0) continue;
        const answers = legacyAnswerDeliveryBoundaries(
            historiesBySessionId?.get?.(sessionId) || historiesBySessionId?.[sessionId] || [],
        );
        if (answers.length === 0) continue;
        const existing = sessionEntries
            .filter((entry) => (
                entry?.eventType === "job.worker_capacity_wait"
                && entry?.details?.waitSource === "human_input"
            ))
            .map((entry) => timestampMs(entry?.details?.runnableAt))
            .filter(Number.isFinite);
        let answerIndex = 0;
        for (let waitIndex = 0; waitIndex < waits.length; waitIndex += 1) {
            const wait = waits[waitIndex];
            const waitAtMs = timestampMs(wait.at);
            const nextWaitAtMs = waitIndex + 1 < waits.length
                ? timestampMs(waits[waitIndex + 1].at)
                : Number.POSITIVE_INFINITY;
            while (answerIndex < answers.length && answers[answerIndex].atMs < waitAtMs) {
                answerIndex += 1;
            }
            const answer = answers[answerIndex];
            if (!answer || answer.atMs >= nextWaitAtMs) continue;
            answerIndex += 1;
            if (existing.some((atMs) => atMs >= waitAtMs && atMs < nextWaitAtMs)) continue;
            const acquisition = acquisitionCandidate(sessionEntries, answer.atMs, nextWaitAtMs);
            if (!acquisition) continue;
            const metadata = acquisition.entry || wait;
            synthetic.push({
                timelineId: `capacity-wait:legacy-answer:${sessionId}:${answer.key}`,
                at: new Date(acquisition.atMs).toISOString(),
                kind: "worker_capacity_wait",
                eventType: "job.worker_capacity_wait",
                workerNodeId,
                generatorId: metadata.generatorId || wait.generatorId || null,
                generatorName: metadata.generatorName || wait.generatorName || null,
                jobId: metadata.jobId || wait.jobId || null,
                jobKey: metadata.jobKey || wait.jobKey || null,
                stateRunId: metadata.stateRunId || wait.stateRunId || null,
                stateName: metadata.stateName || wait.stateName || null,
                stateRevision: metadata.stateRevision ?? wait.stateRevision ?? null,
                sessionId,
                summary: null,
                details: {
                    runnableAt: new Date(answer.atMs).toISOString(),
                    workerAcquiredAt: new Date(acquisition.atMs).toISOString(),
                    waitDurationMs: acquisition.atMs - answer.atMs,
                    waitSource: "human_input",
                    legacySource: "duroxide.QueueEventDelivered",
                    acquisitionSource: acquisition.source,
                },
            });
        }
    }
    return synthetic.sort((a, b) => timestampMs(a.at) - timestampMs(b.at));
}
