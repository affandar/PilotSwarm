import { NodeSdkTransport } from "pilotswarm/host";

function normalizeParams(params) {
    return params && typeof params === "object" ? params : {};
}

function clampInteger(value, defaultValue, min, max) {
    if (value == null) return defaultValue;
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return defaultValue;
    return Math.max(min, Math.min(Math.trunc(numeric), max));
}

function normalizeSessionPageOptions(params) {
    const limit = clampInteger(params.limit, 50, 1, 200);
    const includeDeleted = params.includeDeleted === true;
    if (params.cursor != null && typeof params.cursor !== "object") {
        throw new Error("listSessionsPage cursor must be an object when provided");
    }
    const rawCursor = params.cursor ?? null;
    let cursor = null;

    if (rawCursor) {
        const updatedAt = Number(rawCursor.updatedAt);
        const sessionId = String(rawCursor.sessionId || "").trim();
        if (!Number.isFinite(updatedAt)) {
            throw new Error("listSessionsPage cursor.updatedAt must be a finite number");
        }
        if (!sessionId) {
            throw new Error("listSessionsPage cursor.sessionId must be a non-empty string");
        }
        cursor = { updatedAt, sessionId };
    }

    return { limit, cursor, includeDeleted };
}

function normalizeTopEventEmitterOptions(params) {
    if (params.since == null) {
        throw new Error("getTopEventEmitters since is required");
    }
    const since = new Date(params.since);
    if (Number.isNaN(since.getTime())) {
        throw new Error("getTopEventEmitters since must be a valid date");
    }
    return {
        since,
        limit: clampInteger(params.limit, 20, 1, 100),
    };
}

function normalizeSessionOwner(authContext) {
    const principal = authContext?.principal;
    return normalizeOwnerPrincipal(principal);
}

function normalizeOwnerPrincipal(principal) {
    const provider = String(principal?.provider || "").trim();
    const subject = String(principal?.subject || "").trim();
    if (!provider || !subject) return null;
    return {
        provider,
        subject,
        email: String(principal?.email || "").trim() || null,
        displayName: String(principal?.displayName || "").trim() || null,
    };
}

function ownerKey(owner) {
    const provider = String(owner?.provider || "").trim();
    const subject = String(owner?.subject || "").trim();
    return provider && subject ? `${provider}\u0001${subject}` : null;
}

function requireUserPrincipal(authContext, methodName) {
    const principal = normalizeSessionOwner(authContext);
    if (!principal) {
        const err = new Error(`Portal RPC '${methodName}' requires an authenticated principal.`);
        err.code = "PORTAL_AUTH_REQUIRED";
        throw err;
    }
    return principal;
}

export class PortalRuntime {
    constructor({ store, mode, useManagedIdentity, cmsFactsDatabaseUrl, aadDbUser } = {}) {
        this.transport = new NodeSdkTransport({ store, mode, useManagedIdentity, cmsFactsDatabaseUrl, aadDbUser });
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

    async resolveSessionGroupOwner(input = {}, authOwner = null) {
        const inputOwner = normalizeOwnerPrincipal(input?.owner);
        if (inputOwner) return inputOwner;

        const sessionIds = Array.isArray(input?.sessionIds)
            ? Array.from(new Set(input.sessionIds.map((id) => String(id || "").trim()).filter(Boolean)))
            : [];
        if (sessionIds.length > 0 && typeof this.transport.getSession === "function") {
            const owners = [];
            for (const sessionId of sessionIds) {
                const session = await this.transport.getSession(sessionId).catch(() => null);
                if (!session || session.isSystem || session.isGroup || session.parentSessionId) continue;
                owners.push(normalizeOwnerPrincipal(session.owner));
            }
            const ownerKeys = new Set(owners.map((owner) => ownerKey(owner) || ""));
            if (owners.length > 0 && ownerKeys.size === 1) {
                return owners[0] ?? null;
            }
        }

        return authOwner;
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

    async call(method, params = {}, authContext = null) {
        await this.start();
        const safeParams = normalizeParams(params);
        const owner = normalizeSessionOwner(authContext);
        // Privileged when admin-role, or no-auth ("anonymous" = full access on a
        // trusted deployment). Non-admin facts reads are restricted to shared
        // visibility so a plain caller cannot read another session's private facts.
        const role = authContext?.authorization?.role;
        const isAdmin = role === "admin" || role === "anonymous";
        switch (method) {
            case "listSessions":
                return this.transport.listSessions();
            case "listSessionGroups":
                return this.transport.listSessionGroups();
            case "createSessionGroup":
                return this.transport.createSessionGroup({
                    ...(safeParams.input || {}),
                    owner: await this.resolveSessionGroupOwner(safeParams.input || {}, owner),
                });
            case "updateSessionGroup":
                return this.transport.updateSessionGroup(safeParams.groupId, safeParams.patch || {});
            case "assignSessionsToGroup":
                return this.transport.assignSessionsToGroup(safeParams.groupId, safeParams.sessionIds || []);
            case "moveSessionsToGroup":
                return this.transport.moveSessionsToGroup(safeParams.groupId ?? null, safeParams.sessionIds || []);
            case "getChildOutcome":
                return this.transport.getChildOutcome(safeParams.childSessionId);
            case "listChildOutcomes":
                return this.transport.listChildOutcomes(safeParams.parentSessionId);
            case "listSessionsPage":
                return this.transport.listSessionsPage(normalizeSessionPageOptions(safeParams));
            case "getSession":
                return this.transport.getSession(safeParams.sessionId);
            case "getOrchestrationStats":
                return this.transport.getOrchestrationStats(safeParams.sessionId);
            case "getSessionMetricSummary":
                return this.transport.getSessionMetricSummary(safeParams.sessionId);
            case "getSessionTokensByModel":
                return this.transport.getSessionTokensByModel(safeParams.sessionId);
            case "getSessionTreeStats":
                return this.transport.getSessionTreeStats(safeParams.sessionId);
            case "getFleetStats":
                return this.transport.getFleetStats({
                    includeDeleted: safeParams.includeDeleted,
                    since: safeParams.since ? new Date(safeParams.since) : undefined,
                });
            case "getUserStats":
                return this.transport.getUserStats({
                    includeDeleted: safeParams.includeDeleted,
                    since: safeParams.since ? new Date(safeParams.since) : undefined,
                });
            case "getCurrentUserProfile":
                return this.transport.getCurrentUserProfile({
                    principal: requireUserPrincipal(authContext, "getCurrentUserProfile"),
                });
            case "setCurrentUserProfileSettings":
                return this.transport.setCurrentUserProfileSettings({
                    principal: requireUserPrincipal(authContext, "setCurrentUserProfileSettings"),
                    settings: safeParams.settings,
                });
            case "setCurrentUserGitHubCopilotKey":
                return this.transport.setCurrentUserGitHubCopilotKey({
                    principal: requireUserPrincipal(authContext, "setCurrentUserGitHubCopilotKey"),
                    key: typeof safeParams.key === "string" ? safeParams.key : null,
                });
            case "getSessionSkillUsage":
                return this.transport.getSessionSkillUsage(safeParams.sessionId, {
                    since: safeParams.since ? new Date(safeParams.since) : undefined,
                });
            case "getSessionTreeSkillUsage":
                return this.transport.getSessionTreeSkillUsage(safeParams.sessionId, {
                    since: safeParams.since ? new Date(safeParams.since) : undefined,
                });
            case "getFleetSkillUsage":
                return this.transport.getFleetSkillUsage({
                    includeDeleted: safeParams.includeDeleted,
                    since: safeParams.since ? new Date(safeParams.since) : undefined,
                });
            case "getFleetRetrievalUsage":
                return this.transport.getFleetRetrievalUsage({
                    includeDeleted: safeParams.includeDeleted,
                    since: safeParams.since ? new Date(safeParams.since) : undefined,
                });
            case "getSessionFactsStats":
                return this.transport.getSessionFactsStats(safeParams.sessionId);
            case "getSessionTreeFactsStats":
                return this.transport.getSessionTreeFactsStats(safeParams.sessionId);
            case "getSharedFactsStats":
                return this.transport.getSharedFactsStats();
            case "getFactsTombstoneStats":
                return this.transport.getFactsTombstoneStats({ ttlSeconds: safeParams.ttlSeconds });

            // ── Facts data-plane ────────────────────────────────────────
            case "factsCapabilities":
                return this.transport.factsCapabilities();
            case "readFacts":
                return this.transport.readFacts(safeParams, { admin: isAdmin });
            case "storeFact":
                return this.transport.storeFact(safeParams.input);
            case "deleteFact":
                return this.transport.deleteFactRecord(safeParams.input);
            case "searchFacts":
                return this.transport.searchFacts(safeParams.query, safeParams.opts, { admin: isAdmin });
            case "similarFacts":
                return this.transport.similarFacts(safeParams.scopeKey, safeParams.opts, { admin: isAdmin });
            case "getEmbedderStatus":
                return this.transport.getFactsEmbedderStatus();
            case "startFactsEmbedder":
                return this.transport.startFactsEmbedder({ intervalSeconds: safeParams.intervalSeconds, batch: safeParams.batch });
            case "stopFactsEmbedder":
                return this.transport.stopFactsEmbedder(safeParams.reason);
            case "forcePurgeFacts":
                return this.transport.forcePurgeFacts(safeParams.input);

            // ── Graph data-plane ────────────────────────────────────────
            case "searchGraphNodes":
                return this.transport.searchGraphNodes(safeParams.query);
            case "searchGraphEdges":
                return this.transport.searchGraphEdges(safeParams.query);
            case "graphNeighbourhood":
                return this.transport.graphNeighbourhood(safeParams.nodeKey, safeParams.depth, { namespace: safeParams.namespace });
            case "upsertGraphNode":
                return this.transport.upsertGraphNode(safeParams.input);
            case "upsertGraphEdge":
                return this.transport.upsertGraphEdge(safeParams.input);
            case "deleteGraphNode":
                return this.transport.deleteGraphNode(safeParams.nodeKey, { namespace: safeParams.namespace });
            case "deleteGraphEdge":
                return this.transport.deleteGraphEdge(safeParams.fromKey, safeParams.toKey, safeParams.predicateKey, { namespace: safeParams.namespace });
            case "graphStats":
                return this.transport.graphStats({ namespace: safeParams.namespace });
            case "listGraphNamespaces":
                return this.transport.listGraphNamespaces({ prefix: safeParams.prefix, includeArchived: safeParams.includeArchived, includeDetails: safeParams.includeDetails });
            case "getGraphNamespace":
                return this.transport.getGraphNamespace(safeParams.namespace);
            case "upsertGraphNamespace":
                return this.transport.upsertGraphNamespace(safeParams.input);
            case "deleteGraphNamespace":
                return this.transport.deleteGraphNamespace(safeParams.namespace);
            case "pruneDeletedSummaries":
                return this.transport.pruneDeletedSummaries(new Date(safeParams.olderThan));
            case "getExecutionHistory":
                return this.transport.getExecutionHistory(safeParams.sessionId, safeParams.executionId);
            case "createSession":
                return this.transport.createSession({
                    model: safeParams.model,
                    reasoningEffort: safeParams.reasoningEffort,
                    groupId: safeParams.groupId,
                    owner,
                });
            case "createSessionForAgent":
                return this.transport.createSessionForAgent(safeParams.agentName, {
                    model: safeParams.model,
                    reasoningEffort: safeParams.reasoningEffort,
                    title: safeParams.title,
                    splash: safeParams.splash,
                    splashMobile: safeParams.splashMobile,
                    initialPrompt: safeParams.initialPrompt,
                    groupId: safeParams.groupId,
                    owner,
                });
            case "listCreatableAgents":
                return this.transport.listCreatableAgents();
            case "getSessionCreationPolicy":
                return this.transport.getSessionCreationPolicy();
            case "sendMessage":
                return this.transport.sendMessage(safeParams.sessionId, safeParams.prompt, safeParams.options);
            case "sendAnswer":
                return this.transport.sendAnswer(safeParams.sessionId, safeParams.answer);
            case "sendSessionEvent":
                return this.transport.sendSessionEvent(safeParams.sessionId, safeParams.eventName, safeParams.data);
            case "getSessionStatus":
                return this.transport.getSessionStatus(safeParams.sessionId);
            case "waitForStatusChange": {
                // Long-poll: the server holds the request open, capped well
                // below typical ingress idle timeouts. On timeout the
                // underlying wait throws; translate that into "no change"
                // by returning the current status, so the client sees a
                // clean unchanged snapshot and loops (instead of a 500).
                const sessionId = safeParams.sessionId;
                const afterVersion = Number(safeParams.afterVersion) || 0;
                const timeoutMs = clampInteger(safeParams.timeoutMs, 25_000, 1_000, 300_000);
                try {
                    return await this.transport.waitForStatusChange(sessionId, afterVersion, timeoutMs);
                } catch (error) {
                    if (/Timed out waiting/i.test(String(error?.message || ""))) {
                        return this.transport.getSessionStatus(sessionId);
                    }
                    throw error;
                }
            }
            case "getLatestResponse":
                return this.transport.getLatestResponse(safeParams.sessionId);
            case "cancelPendingMessage":
                return this.transport.cancelPendingMessage(safeParams.sessionId, safeParams.clientMessageIds);
            case "renameSession":
                return this.transport.renameSession(safeParams.sessionId, safeParams.title);
            case "cancelSession":
                return this.transport.cancelSession(safeParams.sessionId);
            case "cancelSessionGroup":
                return this.transport.cancelSessionGroup(safeParams.groupId, safeParams.reason);
            case "completeSession":
                return this.transport.completeSession(safeParams.sessionId, safeParams.reason);
            case "completeSessionGroup":
                return this.transport.completeSessionGroup(safeParams.groupId, safeParams.options || {});
            case "deleteSession":
                return this.transport.deleteSession(safeParams.sessionId);
            case "restartSystemSession":
                return this.transport.restartSystemSession(safeParams.agentIdOrSessionId, safeParams.options || {});
            case "setSessionModel":
                return this.transport.setSessionModel(safeParams.sessionId, safeParams.options || {});
            case "stopSessionTurn":
                return this.transport.stopSessionTurn(safeParams.sessionId, safeParams.options || {});
            case "deleteSessionGroup":
                return this.transport.deleteSessionGroup(safeParams.groupId);
            case "listModels":
                return this.transport.listModels();
            case "listArtifacts":
                return this.transport.listArtifacts(safeParams.sessionId);
            case "getArtifactMetadata":
                return this.transport.getArtifactMetadata(safeParams.sessionId, safeParams.filename);
            case "deleteArtifact":
                return this.transport.deleteArtifact(safeParams.sessionId, safeParams.filename);
            case "downloadArtifact":
                return this.transport.downloadArtifact(safeParams.sessionId, safeParams.filename);
            case "uploadArtifact":
                return this.transport.uploadArtifactContent(
                    safeParams.sessionId,
                    safeParams.filename,
                    safeParams.content,
                    safeParams.contentType,
                    safeParams.contentEncoding,
                );
            case "exportExecutionHistory":
                return this.transport.exportExecutionHistory(safeParams.sessionId);
            case "getModelsByProvider":
                return this.transport.getModelsByProvider();
            case "getDefaultModel":
                return this.transport.getDefaultModel();
            case "getSessionEvents":
                return this.transport.getSessionEvents(safeParams.sessionId, safeParams.afterSeq, safeParams.limit, safeParams.eventTypes);
            case "getSessionEventsBefore":
                return this.transport.getSessionEventsBefore(safeParams.sessionId, safeParams.beforeSeq, safeParams.limit, safeParams.eventTypes);
            case "getTopEventEmitters":
                return this.transport.getTopEventEmitters(normalizeTopEventEmitterOptions(safeParams));
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

    async getArtifactMetadata(sessionId, filename) {
        await this.start();
        if (typeof this.transport.getArtifactMetadata !== "function") return null;
        return this.transport.getArtifactMetadata(sessionId, filename);
    }

    async downloadArtifactBinary(sessionId, filename) {
        await this.start();
        if (typeof this.transport.downloadArtifactBinary === "function") {
            return this.transport.downloadArtifactBinary(sessionId, filename);
        }
        const content = await this.transport.downloadArtifact(sessionId, filename);
        return {
            filename,
            contentType: "text/plain",
            isBinary: false,
            sizeBytes: Buffer.byteLength(content, "utf8"),
            uploadedAt: new Date().toISOString(),
            source: "agent",
            body: Buffer.from(content, "utf8"),
        };
    }

    subscribeSession(sessionId, handler) {
        return this.transport.subscribeSession(sessionId, handler);
    }

    startLogTail(handler) {
        return this.transport.startLogTail(handler);
    }
}
