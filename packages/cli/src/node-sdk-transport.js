import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
    FilesystemArtifactStore,
    loadAgentFiles,
    PilotSwarmClient,
    PilotSwarmManagementClient,
    SessionBlobStore,
} from "pilotswarm-sdk";
import { startEmbeddedWorkers, stopEmbeddedWorkers } from "./embedded-workers.js";

const EXPORTS_DIR = path.join(os.homedir(), "pilotswarm-exports");
fs.mkdirSync(EXPORTS_DIR, { recursive: true });

function stripAnsi(value) {
    return String(value || "").replace(/\x1b\[[0-9;]*m/g, "");
}

function trimLogText(value, maxLength = 2_000) {
    const text = String(value || "");
    return text.length > maxLength
        ? `${text.slice(0, maxLength - 1)}…`
        : text;
}

function extractPrettyLogMessage(rawLine) {
    const source = trimLogText(stripAnsi(rawLine)).trim();
    if (!source) return "";

    let message = source
        .replace(/^\d{4}-\d{2}-\d{2}T\S+\s+(TRACE|DEBUG|INFO|WARN|ERROR)\s+\S+:\s*/i, "")
        .replace(/^(TRACE|DEBUG|INFO|WARN|ERROR)\s+/i, "")
        .replace(/^\[v[^\]]+\]\s*/i, "")
        .trim();

    const metadataMarkers = [
        " instance_id=",
        " orchestration_id=",
        " execution_id=",
        " orchestration_name=",
        " orchestration_version=",
        " activity_name=",
        " activity_id=",
        " worker_id=",
        " filter=",
        " options=",
        " instances_deleted=",
        " executions_deleted=",
        " events_deleted=",
        " queue_messages_deleted=",
        " instances_processed=",
        " instance=",
    ];

    let cutIndex = -1;
    for (const marker of metadataMarkers) {
        const nextIndex = message.indexOf(marker);
        if (nextIndex <= 0) continue;
        if (cutIndex === -1 || nextIndex < cutIndex) {
            cutIndex = nextIndex;
        }
    }

    if (cutIndex > 0) {
        message = message.slice(0, cutIndex).trim();
    }

    return message || source;
}

function normalizeLogLevel(line) {
    const match = stripAnsi(line).match(/\b(ERROR|WARN|INFO|DEBUG|TRACE)\b/i);
    return match ? match[1].toLowerCase() : "info";
}

function extractLogTime(line) {
    const plain = stripAnsi(line);
    const hhmmss = plain.match(/\b(\d{2}:\d{2}:\d{2})(?:\.\d+)?\b/);
    if (hhmmss) return hhmmss[1];

    const iso = plain.match(/\b(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?)\b/);
    if (iso) {
        const parsed = new Date(iso[1]);
        if (!Number.isNaN(parsed.getTime())) {
            return parsed.toLocaleTimeString("en-US", {
                hour12: false,
                hour: "2-digit",
                minute: "2-digit",
                second: "2-digit",
            });
        }
    }

    return new Date().toLocaleTimeString("en-US", {
        hour12: false,
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
    });
}

function buildLogEntry(line, counter) {
    const prefixMatch = line.match(/^\[pod\/([^/\]]+)/);
    const podName = prefixMatch ? prefixMatch[1] : "unknown";
    const rawLine = trimLogText(stripAnsi(line.replace(/^\[pod\/[^\]]+\]\s*/, "")).trim());
    const orchMatch = rawLine.match(/\b(instance_id|orchestration_id)=(session-[^\s,]+)/i)
        || rawLine.match(/\b(session-[0-9a-f-]{8,})\b/i);
    const orchId = orchMatch ? orchMatch[2] || orchMatch[1] : null;
    const category = rawLine.includes("duroxide::activity")
            ? "activity"
            : rawLine.includes("duroxide::orchestration") || rawLine.includes("::orchestration")
                ? "orchestration"
            : "log";

    return {
        id: `log:${Date.now()}:${counter}`,
        time: extractLogTime(rawLine),
        podName,
        level: normalizeLogLevel(rawLine),
        orchId,
        category,
        rawLine,
        message: extractPrettyLogMessage(rawLine),
        prettyMessage: extractPrettyLogMessage(rawLine),
    };
}

function sanitizeArtifactFilename(filename) {
    return String(filename || "").replace(/[/\\]/g, "_");
}

function expandUserPath(filePath) {
    const value = String(filePath || "").trim();
    if (!value) return "";
    return value.startsWith("~")
        ? path.join(os.homedir(), value.slice(1))
        : value;
}

function guessArtifactContentType(filename) {
    const ext = path.extname(String(filename || "")).toLowerCase();
    if (ext === ".md" || ext === ".markdown" || ext === ".mdx") return "text/markdown";
    if (ext === ".json" || ext === ".jsonl") return "application/json";
    if (ext === ".html" || ext === ".htm") return "text/html";
    if (ext === ".csv") return "text/csv";
    if (ext === ".yaml" || ext === ".yml") return "application/yaml";
    return "text/plain";
}

function spawnDetached(command, args) {
    return new Promise((resolve, reject) => {
        let settled = false;
        const child = spawn(command, args, {
            detached: true,
            stdio: "ignore",
        });
        child.once("error", (error) => {
            if (settled) return;
            settled = true;
            reject(error);
        });
        child.once("spawn", () => {
            if (settled) return;
            settled = true;
            child.unref();
            resolve();
        });
    });
}

function isTerminalOrchestrationStatus(status) {
    return status === "Completed" || status === "Failed" || status === "Terminated";
}

function isTerminalSendError(error) {
    const message = String(error?.message || error || "");
    return /instance is terminal|terminal orchestration|cannot accept new messages/i.test(message);
}

function getPluginDirsFromEnv() {
    return String(process.env.PLUGIN_DIRS || "")
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean);
}

function normalizeCreatableAgent(agent) {
    const name = String(agent?.name || "").trim();
    if (!name) return null;
    return {
        name,
        title: String(agent?.title || "").trim() || (name.charAt(0).toUpperCase() + name.slice(1)),
        description: String(agent?.description || "").trim(),
        splash: typeof agent?.splash === "string" && agent.splash.trim() ? agent.splash : null,
        initialPrompt: typeof agent?.initialPrompt === "string" && agent.initialPrompt.trim() ? agent.initialPrompt : null,
        tools: Array.isArray(agent?.tools) ? agent.tools.filter(Boolean) : [],
    };
}

function loadSessionCreationMetadataFromPluginDirs(pluginDirs = []) {
    let sessionPolicy = null;
    const agentsByName = new Map();

    for (const pluginDir of pluginDirs) {
        const absDir = path.resolve(pluginDir);
        if (!fs.existsSync(absDir)) continue;

        const policyPath = path.join(absDir, "session-policy.json");
        if (fs.existsSync(policyPath)) {
            try {
                sessionPolicy = JSON.parse(fs.readFileSync(policyPath, "utf-8"));
            } catch {}
        }

        const agentsDir = path.join(absDir, "agents");
        if (!fs.existsSync(agentsDir)) continue;
        try {
            for (const agent of loadAgentFiles(agentsDir)) {
                if (!agent || agent.system || agent.name === "default") continue;
                const normalized = normalizeCreatableAgent(agent);
                if (!normalized) continue;
                agentsByName.set(normalized.name, normalized);
            }
        } catch {}
    }

    const creatableAgents = [...agentsByName.values()];
    return {
        sessionPolicy,
        allowedAgentNames: creatableAgents.map((agent) => agent.name),
        creatableAgents,
    };
}

function buildTerminalSendError(sessionId, session) {
    if (session?.status === "failed" || session?.orchestrationStatus === "Failed") {
        return `Session ${sessionId.slice(0, 8)} is a failed terminal orchestration and cannot accept new messages.`;
    }

    const statusLabel = String(session?.orchestrationStatus || session?.status || "Unknown");
    return `Session ${sessionId.slice(0, 8)} is a terminal orchestration instance (${statusLabel}) and cannot accept new messages.`;
}

export class NodeSdkTransport {
    constructor({ store, mode }) {
        this.store = store;
        this.mode = mode;
        this.client = null;
        this.mgmt = new PilotSwarmManagementClient({ store });
        this.artifactStore = createArtifactStore();
        this.sessionHandles = new Map();
        this.workers = [];
        this.sessionPolicy = null;
        this.allowedAgentNames = [];
        this.creatableAgents = [];
        this.logProc = null;
        this.logBuffer = "";
        this.logRestartTimer = null;
        this.logSubscribers = new Set();
        this.logEntryCounter = 0;
    }

    async start() {
        const workerCount = this.mode === "remote" ? 0 : parseInt(process.env.WORKERS || "4", 10);
        if (workerCount > 0) {
            this.workers = await startEmbeddedWorkers({
                count: workerCount,
                store: this.store,
            });
        }
        const sessionCreationMetadata = this.resolveSessionCreationMetadata();
        this.sessionPolicy = sessionCreationMetadata.sessionPolicy;
        this.allowedAgentNames = sessionCreationMetadata.allowedAgentNames;
        this.creatableAgents = sessionCreationMetadata.creatableAgents;
        this.client = new PilotSwarmClient({
            store: this.store,
            ...(this.sessionPolicy ? { sessionPolicy: this.sessionPolicy } : {}),
            ...(this.allowedAgentNames.length > 0 ? { allowedAgentNames: this.allowedAgentNames } : {}),
        });
        await this.client.start();
        await this.mgmt.start();
    }

    async stop() {
        this.sessionHandles.clear();
        await this.stopLogTail();
        await Promise.allSettled([
            this.client ? this.client.stop() : Promise.resolve(),
            this.mgmt.stop(),
            stopEmbeddedWorkers(this.workers),
        ]);
        this.client = null;
    }

    resolveSessionCreationMetadata() {
        if (this.workers.length > 0) {
            const firstWorker = this.workers[0];
            const creatableAgents = Array.isArray(firstWorker?.loadedAgents)
                ? firstWorker.loadedAgents.map((agent) => normalizeCreatableAgent(agent)).filter(Boolean)
                : [];
            return {
                sessionPolicy: firstWorker?.sessionPolicy || null,
                allowedAgentNames: Array.isArray(firstWorker?.allowedAgentNames) ? firstWorker.allowedAgentNames.filter(Boolean) : creatableAgents.map((agent) => agent.name),
                creatableAgents,
            };
        }
        return loadSessionCreationMetadataFromPluginDirs(getPluginDirsFromEnv());
    }

    getWorkerCount() {
        return this.workers.length || (this.mode === "remote" ? 0 : parseInt(process.env.WORKERS || "4", 10));
    }

    getLogConfig() {
        const hasK8sConfig = Boolean((process.env.K8S_CONTEXT || "").trim() || (process.env.KUBECONFIG || "").trim());
        return {
            available: hasK8sConfig,
            availabilityReason: hasK8sConfig
                ? ""
                : "Log tailing disabled: no K8S_CONTEXT configured in the env file.",
        };
    }

    async listSessions() {
        return this.mgmt.listSessions();
    }

    async getSession(sessionId) {
        return this.mgmt.getSession(sessionId);
    }

    async getOrchestrationStats(sessionId) {
        return this.mgmt.getOrchestrationStats(sessionId);
    }

    async createSession({ model } = {}) {
        const effectiveModel = model || this.mgmt.getDefaultModel();
        const session = await this.client.createSession(effectiveModel ? { model: effectiveModel } : undefined);
        this.sessionHandles.set(session.sessionId, session);
        return { sessionId: session.sessionId, model: effectiveModel };
    }

    async createSessionForAgent(agentName, { model, title, splash, initialPrompt } = {}) {
        const effectiveModel = model || this.mgmt.getDefaultModel();
        const session = await this.client.createSessionForAgent(agentName, {
            ...(effectiveModel ? { model: effectiveModel } : {}),
            ...(title ? { title } : {}),
            ...(splash ? { splash } : {}),
            ...(initialPrompt ? { initialPrompt } : {}),
        });
        this.sessionHandles.set(session.sessionId, session);
        return {
            sessionId: session.sessionId,
            model: effectiveModel,
            agentName,
        };
    }

    listCreatableAgents() {
        return [...this.creatableAgents];
    }

    getSessionCreationPolicy() {
        return this.sessionPolicy;
    }

    async sendMessage(sessionId, prompt, options = {}) {
        const session = await this.mgmt.getSession(sessionId);
        if (!session) {
            throw new Error(`Session ${sessionId.slice(0, 8)} was not found.`);
        }
        if (session.status === "failed" || session.orchestrationStatus === "Failed") {
            throw new Error(buildTerminalSendError(sessionId, session));
        }
        if (
            session.status === "completed"
            && session.parentSessionId
            && !session.isSystem
            && !session.cronActive
            && !session.cronInterval
        ) {
            throw new Error(buildTerminalSendError(sessionId, session));
        }
        if (this.mode === "remote" && isTerminalOrchestrationStatus(session.orchestrationStatus)) {
            throw new Error(buildTerminalSendError(sessionId, session));
        }

        if (options?.enqueueOnly) {
            await this.mgmt.sendMessage(sessionId, prompt);
            return;
        }

        try {
            const sessionHandle = await this.getSessionHandle(sessionId);
            await sessionHandle.send(prompt);
        } catch (error) {
            if (isTerminalSendError(error)) {
                throw error;
            }
            await this.mgmt.sendMessage(sessionId, prompt);
        }
    }

    async sendAnswer(sessionId, answer) {
        await this.mgmt.sendAnswer(sessionId, answer);
    }

    async renameSession(sessionId, title) {
        await this.mgmt.renameSession(sessionId, title);
    }

    async cancelSession(sessionId) {
        await this.mgmt.cancelSession(sessionId);
    }

    async completeSession(sessionId, reason = "Completed by user") {
        await this.mgmt.sendCommand(sessionId, {
            cmd: "done",
            id: `done-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            args: { reason },
        });
    }

    async deleteSession(sessionId) {
        await this.mgmt.deleteSession(sessionId);
        this.sessionHandles.delete(sessionId);
    }

    async listModels() {
        return this.mgmt.listModels();
    }

    async listArtifacts(sessionId) {
        if (!this.artifactStore || !sessionId) return [];
        const artifacts = await this.artifactStore.listArtifacts(sessionId);
        return Array.isArray(artifacts) ? [...artifacts].sort((left, right) => left.localeCompare(right)) : [];
    }

    async downloadArtifact(sessionId, filename) {
        if (!this.artifactStore) {
            throw new Error("Artifact store is not available for this transport.");
        }
        return this.artifactStore.downloadArtifact(sessionId, filename);
    }

    async uploadArtifactFromPath(sessionId, filePath) {
        if (!this.artifactStore) {
            throw new Error("Artifact store is not available for this transport.");
        }
        const resolvedPath = path.resolve(expandUserPath(filePath));
        if (!resolvedPath) {
            throw new Error("File path cannot be empty.");
        }

        const stat = await fs.promises.stat(resolvedPath).catch(() => null);
        if (!stat) {
            throw new Error(`File not found: ${filePath}`);
        }
        if (!stat.isFile()) {
            throw new Error(`Not a file: ${filePath}`);
        }

        const filename = path.basename(resolvedPath);
        const content = await fs.promises.readFile(resolvedPath, "utf8");
        const contentType = guessArtifactContentType(filename);
        await this.artifactStore.uploadArtifact(sessionId, filename, content, contentType);

        return {
            sessionId,
            filename,
            resolvedPath,
            sizeBytes: Buffer.byteLength(content, "utf8"),
            contentType,
        };
    }

    getArtifactExportDirectory() {
        return EXPORTS_DIR;
    }

    async saveArtifactDownload(sessionId, filename) {
        if (!this.artifactStore) {
            throw new Error("Artifact store is not available for this transport.");
        }

        const content = await this.artifactStore.downloadArtifact(sessionId, filename);
        const sessionDir = path.join(EXPORTS_DIR, String(sessionId || "").slice(0, 8));
        const localPath = path.join(sessionDir, sanitizeArtifactFilename(filename));
        await fs.promises.mkdir(sessionDir, { recursive: true });
        await fs.promises.writeFile(localPath, content, "utf8");
        return {
            localPath,
        };
    }

    async openPathInDefaultApp(targetPath) {
        const resolvedPath = path.resolve(expandUserPath(targetPath));
        if (!resolvedPath) {
            throw new Error("File path cannot be empty.");
        }
        const stat = await fs.promises.stat(resolvedPath).catch(() => null);
        if (!stat || !stat.isFile()) {
            throw new Error(`File not found: ${targetPath}`);
        }

        if (process.platform === "darwin") {
            await spawnDetached("open", [resolvedPath]);
        } else if (process.platform === "win32") {
            await spawnDetached("cmd", ["/c", "start", "", resolvedPath]);
        } else {
            await spawnDetached("xdg-open", [resolvedPath]);
        }

        return { localPath: resolvedPath };
    }

    getModelsByProvider() {
        return this.mgmt.getModelsByProvider();
    }

    getDefaultModel() {
        return this.mgmt.getDefaultModel();
    }

    async getSessionEvents(sessionId, afterSeq, limit) {
        return this.mgmt.getSessionEvents(sessionId, afterSeq, limit);
    }

    async getSessionEventsBefore(sessionId, beforeSeq, limit) {
        if (typeof this.mgmt.getSessionEventsBefore !== "function") return [];
        return this.mgmt.getSessionEventsBefore(sessionId, beforeSeq, limit);
    }

    emitLogEntry(entry) {
        for (const handler of this.logSubscribers) {
            try {
                handler(entry);
            } catch {}
        }
    }

    scheduleLogRestart() {
        if (this.logRestartTimer || this.logSubscribers.size === 0) return;
        this.logRestartTimer = setTimeout(() => {
            this.logRestartTimer = null;
            if (this.logSubscribers.size > 0) {
                this.startLogProcess();
            }
        }, 5000);
    }

    startLogProcess() {
        const config = this.getLogConfig();
        if (!config.available || this.logProc) return;

        const k8sContext = process.env.K8S_CONTEXT || "";
        const k8sNamespace = process.env.K8S_NAMESPACE || "copilot-runtime";
        const k8sPodLabel = process.env.K8S_POD_LABEL || "app.kubernetes.io/component=worker";
        const k8sCtxArgs = k8sContext ? ["--context", k8sContext] : [];
        this.logBuffer = "";
        this.logProc = spawn("kubectl", [
            ...k8sCtxArgs,
            "logs",
            "--follow=true",
            "-n", k8sNamespace,
            "-l", k8sPodLabel,
            "--prefix",
            "--tail=500",
            "--max-log-requests=20",
        ], { stdio: ["ignore", "pipe", "pipe"] });

        this.logProc.stdout.on("data", (chunk) => {
            this.logBuffer += chunk.toString();
            const lines = this.logBuffer.split("\n");
            this.logBuffer = lines.pop() || "";
            for (const line of lines) {
                if (!line.trim()) continue;
                this.logEntryCounter += 1;
                this.emitLogEntry(buildLogEntry(line, this.logEntryCounter));
            }
        });

        this.logProc.stderr.on("data", (chunk) => {
            const text = stripAnsi(chunk.toString()).trim();
            if (!text) return;
            this.logEntryCounter += 1;
            this.emitLogEntry({
                id: `log:${Date.now()}:${this.logEntryCounter}`,
                time: extractLogTime(text),
                podName: "kubectl",
                level: "warn",
                orchId: null,
                category: "log",
                rawLine: trimLogText(text),
                message: trimLogText(text),
                prettyMessage: trimLogText(text),
            });
        });

        this.logProc.on("error", (error) => {
            this.logEntryCounter += 1;
            this.emitLogEntry({
                id: `log:${Date.now()}:${this.logEntryCounter}`,
                time: extractLogTime(""),
                podName: "kubectl",
                level: "error",
                orchId: null,
                category: "log",
                rawLine: trimLogText(`kubectl error: ${error.message}`),
                message: trimLogText(`kubectl error: ${error.message}`),
                prettyMessage: trimLogText(`kubectl error: ${error.message}`),
            });
        });

        this.logProc.on("exit", (code, signal) => {
            this.logProc = null;
            this.logEntryCounter += 1;
            this.emitLogEntry({
                id: `log:${Date.now()}:${this.logEntryCounter}`,
                time: extractLogTime(""),
                podName: "kubectl",
                level: "warn",
                orchId: null,
                category: "log",
                rawLine: trimLogText(`kubectl exited (code=${code} signal=${signal})`),
                message: trimLogText(`kubectl exited (code=${code} signal=${signal})`),
                prettyMessage: trimLogText(`kubectl exited (code=${code} signal=${signal})`),
            });
            this.scheduleLogRestart();
        });
    }

    startLogTail(handler) {
        if (typeof handler === "function") {
            this.logSubscribers.add(handler);
        }
        this.startLogProcess();

        return () => {
            if (typeof handler === "function") {
                this.logSubscribers.delete(handler);
            }
            if (this.logSubscribers.size === 0) {
                this.stopLogTail().catch(() => {});
            }
        };
    }

    async stopLogTail() {
        if (this.logRestartTimer) {
            clearTimeout(this.logRestartTimer);
            this.logRestartTimer = null;
        }
        if (this.logProc) {
            try {
                this.logProc.kill("SIGKILL");
            } catch {}
            this.logProc = null;
        }
        this.logBuffer = "";
    }

    subscribeSession(sessionId, handler) {
        let unsubscribe = () => {};
        let active = true;
        this.getSessionHandle(sessionId)
            .then((session) => {
                if (!active) return;
                unsubscribe = session.on((event) => handler(event));
            })
            .catch(() => {});

        return () => {
            active = false;
            unsubscribe();
        };
    }

    async getSessionHandle(sessionId) {
        if (this.sessionHandles.has(sessionId)) {
            return this.sessionHandles.get(sessionId);
        }
        const session = await this.client.resumeSession(sessionId);
        this.sessionHandles.set(sessionId, session);
        return session;
    }
}

function createArtifactStore() {
    const blobConnectionString = (process.env.AZURE_STORAGE_CONNECTION_STRING || "").trim();
    const blobContainer = (process.env.AZURE_STORAGE_CONTAINER || "copilot-sessions").trim() || "copilot-sessions";
    const sessionStateDir = (process.env.SESSION_STATE_DIR || "").trim() || undefined;
    const artifactDir = (process.env.ARTIFACT_DIR || "").trim() || undefined;

    if (blobConnectionString) {
        return new SessionBlobStore(blobConnectionString, blobContainer, sessionStateDir);
    }

    return new FilesystemArtifactStore(artifactDir);
}
