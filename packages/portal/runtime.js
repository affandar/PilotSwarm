import { NodeSdkTransport } from "../cli/src/node-sdk-transport.js";

function normalizeParams(params) {
    return params && typeof params === "object" ? params : {};
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
            case "getSession":
                return this.transport.getSession(safeParams.sessionId);
            case "getOrchestrationStats":
                return this.transport.getOrchestrationStats(safeParams.sessionId);
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
            case "exportExecutionHistory":
                return this.transport.exportExecutionHistory(safeParams.sessionId);
            case "getModelsByProvider":
                return this.transport.getModelsByProvider();
            case "getDefaultModel":
                return this.transport.getDefaultModel();
            case "getSessionEvents":
                return this.transport.getSessionEvents(safeParams.sessionId, safeParams.afterSeq, safeParams.limit);
            case "getSessionEventsBefore":
                return this.transport.getSessionEventsBefore(safeParams.sessionId, safeParams.beforeSeq, safeParams.limit);
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
