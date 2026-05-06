import { NodeSdkTransport } from "pilotswarm-cli/portal";

function normalizeParams(params) {
    return params && typeof params === "object" ? params : {};
}

function parseOptionalDate(value, fieldName) {
    if (!value) return undefined;
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) {
        if (fieldName) {
            throw new Error(`Invalid RPC parameter "${fieldName}": expected ISO date value`);
        }
        return undefined;
    }
    return parsed;
}

function parseRequiredDate(value, fieldName) {
    if (!value) {
        throw new Error(`Invalid RPC parameter "${fieldName}": required ISO date value`);
    }
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) {
        throw new Error(`Invalid RPC parameter "${fieldName}": expected ISO date value`);
    }
    return parsed;
}

export function clampInt(value, fallback, min, max) {
    const n = typeof value === "number" ? value : parseInt(value, 10);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, n));
}

export function clampLimit(value, fallback, max) {
    return clampInt(value, fallback, 1, max);
}

export function enforceMaxWindowDays(date, maxDays, fieldName) {
    if (date === undefined || date === null) return date;
    const cutoff = new Date(Date.now() - maxDays * 24 * 60 * 60 * 1000);
    if (date < cutoff) {
        throw new Error(`Invalid RPC parameter "${fieldName}": must be within the last ${maxDays} days`);
    }
    return date;
}

function defaultSinceDays(date, maxDays) {
    if (date !== undefined && date !== null) return date;
    return new Date(Date.now() - maxDays * 24 * 60 * 60 * 1000);
}

function parseSessionPageCursor(value) {
    if (value === undefined || value === null) return undefined;
    if (typeof value !== "object") {
        throw new Error('Invalid RPC parameter "cursor": expected object');
    }

    const updatedAt = value.updatedAt;
    const sessionId = value.sessionId;
    const hasUpdatedAt = updatedAt !== undefined && updatedAt !== null && String(updatedAt).trim() !== "";
    const hasSessionId = sessionId !== undefined && sessionId !== null && String(sessionId).trim() !== "";

    if (!hasUpdatedAt && !hasSessionId) {
        throw new Error('Invalid RPC parameter "cursor": must include both "updatedAt" and "sessionId"');
    }
    if (hasUpdatedAt !== hasSessionId) {
        throw new Error('Invalid RPC parameter "cursor": must include both "updatedAt" and "sessionId"');
    }

    const parsedUpdatedAt = parseRequiredDate(updatedAt, "cursor.updatedAt");
    const parsedSessionId = String(sessionId).trim();
    if (!parsedSessionId) {
        throw new Error('Invalid RPC parameter "cursor.sessionId": expected non-empty string');
    }

    return {
        updatedAt: parsedUpdatedAt.toISOString(),
        sessionId: parsedSessionId,
    };
}

export class PortalRuntime {
    constructor({ store, mode }) {
        this.transport = new NodeSdkTransport({ store, mode });
        this.mode = mode;
        this.started = false;
        this.startPromise = null;
    }

    async start() {
        if (this.started) return;
        if (!this.startPromise) {
            this.startPromise = this.transport.start()
                .then(() => {
                    this.started = true;
                })
                .finally(() => {
                    this.startPromise = null;
                });
        }
        await this.startPromise;
    }

    async stop() {
        if (!this.started && !this.startPromise) return;
        if (this.startPromise) {
            await this.startPromise.catch(() => {});
        }
        if (this.started) {
            await this.transport.stop();
            this.started = false;
        }
    }

    async getBootstrap() {
        await this.start();
        return {
            mode: this.mode,
            workerCount: typeof this.transport.getWorkerCount === "function"
                ? this.transport.getWorkerCount()
                : null,
            logConfig: typeof this.transport.getLogConfig === "function"
                ? this.transport.getLogConfig()
                : null,
            defaultModel: typeof this.transport.getDefaultModel === "function"
                ? this.transport.getDefaultModel()
                : null,
            modelsByProvider: typeof this.transport.getModelsByProvider === "function"
                ? this.transport.getModelsByProvider()
                : [],
            creatableAgents: typeof this.transport.listCreatableAgents === "function"
                ? await this.transport.listCreatableAgents()
                : [],
            sessionCreationPolicy: typeof this.transport.getSessionCreationPolicy === "function"
                ? this.transport.getSessionCreationPolicy()
                : null,
        };
    }

    async call(method, params = {}) {
        await this.start();
        const safeParams = normalizeParams(params);
        switch (method) {
            case "listSessions":
                return this.transport.listSessions();
            case "listSessionsPage":
                return this.transport.listSessionsPage({
                    limit: clampLimit(safeParams.limit, 50, 200),
                    includeDeleted: safeParams.includeDeleted,
                    cursor: parseSessionPageCursor(safeParams.cursor),
                });
            case "getSession":
                return this.transport.getSession(safeParams.sessionId);
            case "getOrchestrationStats":
                return this.transport.getOrchestrationStats(safeParams.sessionId);
            case "getSessionMetricSummary":
                return this.transport.getSessionMetricSummary(safeParams.sessionId);
            case "getSessionTreeStats":
                return this.transport.getSessionTreeStats(safeParams.sessionId);
            case "getFleetStats":
                return this.transport.getFleetStats({
                    includeDeleted: safeParams.includeDeleted,
                    since: parseOptionalDate(safeParams.since),
                });
            case "getSessionSkillUsage":
                return this.transport.getSessionSkillUsage(safeParams.sessionId, {
                    since: parseOptionalDate(safeParams.since),
                });
            case "getSessionTreeSkillUsage":
                return this.transport.getSessionTreeSkillUsage(safeParams.sessionId, {
                    since: parseOptionalDate(safeParams.since),
                });
            case "getFleetSkillUsage":
                return this.transport.getFleetSkillUsage({
                    includeDeleted: safeParams.includeDeleted,
                    since: parseOptionalDate(safeParams.since),
                });
            case "getSessionFactsStats":
                return this.transport.getSessionFactsStats(safeParams.sessionId);
            case "getSessionTreeFactsStats":
                return this.transport.getSessionTreeFactsStats(safeParams.sessionId);
            case "getSharedFactsStats":
                return this.transport.getSharedFactsStats();
            case "pruneDeletedSummaries":
                return this.transport.pruneDeletedSummaries(parseRequiredDate(safeParams.olderThan, "olderThan"));
            case "getFleetObservabilityStats":
                return this.transport.getFleetObservabilityStats({
                    includeDeleted: safeParams.includeDeleted,
                    since: parseOptionalDate(safeParams.since),
                });
            case "getDbCallMetrics":
                return this.transport.getDbCallMetrics();
            case "getSessionTurnMetrics":
                return this.transport.getSessionTurnMetrics(safeParams.sessionId, {
                    since: parseOptionalDate(safeParams.since),
                    limit: clampLimit(safeParams.limit, 100, 500),
                });
            case "getFleetTurnAnalytics":
                {
                    const since = defaultSinceDays(parseOptionalDate(safeParams.since, "since"), 30);
                    return this.transport.getFleetTurnAnalytics({
                        since: enforceMaxWindowDays(since, 30, "since"),
                        agentId: safeParams.agentId,
                        model: safeParams.model,
                    });
                }
            case "getHourlyTokenBuckets":
                return this.transport.getHourlyTokenBuckets(
                    enforceMaxWindowDays(parseRequiredDate(safeParams.since, "since"), 30, "since"),
                    {
                        agentId: safeParams.agentId,
                        model: safeParams.model,
                    },
                );
            case "getFleetDbCallMetrics":
                return this.transport.getFleetDbCallMetrics({
                    since: enforceMaxWindowDays(defaultSinceDays(parseOptionalDate(safeParams.since, "since"), 30), 30, "since"),
                });
            case "getTopEventEmitters":
                return this.transport.getTopEventEmitters({
                    since: enforceMaxWindowDays(parseRequiredDate(safeParams.since, "since"), 30, "since"),
                    limit: clampLimit(safeParams.limit, 20, 100),
                });
            case "pruneTurnMetrics":
                return this.transport.pruneTurnMetrics(parseRequiredDate(safeParams.olderThan, "olderThan"));
            case "getExecutionHistory":
                return this.transport.getExecutionHistory(safeParams.sessionId, safeParams.executionId);
            case "createSession":
                return this.transport.createSession({ model: safeParams.model });
            case "createSessionForAgent":
                return this.transport.createSessionForAgent(safeParams.agentName, {
                    model: safeParams.model,
                    title: safeParams.title,
                    splash: safeParams.splash,
                    initialPrompt: safeParams.initialPrompt,
                });
            case "listCreatableAgents":
                return this.transport.listCreatableAgents();
            case "getSessionCreationPolicy":
                return this.transport.getSessionCreationPolicy();
            case "sendMessage":
                return this.transport.sendMessage(safeParams.sessionId, safeParams.prompt, safeParams.options);
            case "sendAnswer":
                return this.transport.sendAnswer(safeParams.sessionId, safeParams.answer);
            case "renameSession":
                return this.transport.renameSession(safeParams.sessionId, safeParams.title);
            case "cancelSession":
                return this.transport.cancelSession(safeParams.sessionId);
            case "completeSession":
                return this.transport.completeSession(safeParams.sessionId, safeParams.reason);
            case "deleteSession":
                return this.transport.deleteSession(safeParams.sessionId);
            case "listModels":
                return this.transport.listModels();
            case "listArtifacts":
                return this.transport.listArtifacts(safeParams.sessionId);
            case "downloadArtifact":
                return this.transport.downloadArtifact(safeParams.sessionId, safeParams.filename);
            case "uploadArtifact":
                return this.transport.uploadArtifactContent(
                    safeParams.sessionId,
                    safeParams.filename,
                    safeParams.content,
                    safeParams.contentType,
                );
            case "exportExecutionHistory":
                return this.transport.exportExecutionHistory(safeParams.sessionId);
            case "getModelsByProvider":
                return this.transport.getModelsByProvider();
            case "getDefaultModel":
                return this.transport.getDefaultModel();
            case "getSessionEvents":
                return this.transport.getSessionEvents(
                    safeParams.sessionId,
                    safeParams.afterSeq,
                    clampLimit(safeParams.limit, 200, 500),
                );
            case "getSessionEventsBefore":
                return this.transport.getSessionEventsBefore(
                    safeParams.sessionId,
                    safeParams.beforeSeq,
                    clampLimit(safeParams.limit, 200, 500),
                );
            case "getLogConfig":
                return this.transport.getLogConfig();
            case "getWorkerCount":
                return this.transport.getWorkerCount();
            default:
                throw new Error(`Unsupported portal RPC method: ${method}`);
        }
    }

    async downloadArtifact(sessionId, filename) {
        await this.start();
        return this.transport.downloadArtifact(sessionId, filename);
    }

    subscribeSession(sessionId, handler) {
        return this.transport.subscribeSession(sessionId, handler);
    }

    startLogTail(handler) {
        return this.transport.startLogTail(handler);
    }
}
