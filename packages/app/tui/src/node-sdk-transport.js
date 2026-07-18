import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import {
    FilesystemArtifactStore,
    loadAgentFiles,
    normalizeCapabilityOverride,
    PilotSwarmClient,
    PilotSwarmManagementClient,
    createSessionBlobStore,
    horizonConfigFromEnv,
    LOCAL_DEFAULT_USER_PRINCIPAL,
} from "pilotswarm-sdk";
import { startEmbeddedWorkers, stopEmbeddedWorkers } from "./embedded-workers.js";
import { getPluginDirsFromEnv } from "./plugin-config.js";

const EXPORTS_DIR = path.resolve(
    expandUserPath(process.env.PILOTSWARM_EXPORT_DIR || path.join(os.homedir(), "pilotswarm-exports")),
);
fs.mkdirSync(EXPORTS_DIR, { recursive: true });
const K8S_SERVICE_ACCOUNT_DIR = "/var/run/secrets/kubernetes.io/serviceaccount";
const CLI_SRC_DIR = path.dirname(fileURLToPath(import.meta.url));
const CLI_PACKAGE_ROOT = path.resolve(CLI_SRC_DIR, "..");
const PACKAGE_PARENT_DIR = path.resolve(CLI_PACKAGE_ROOT, "..");

function fileExists(filePath) {
    try {
        return fs.existsSync(filePath);
    } catch {
        return false;
    }
}

function getInClusterK8sPaths() {
    const baseDir = process.env.PILOTSWARM_K8S_SERVICE_ACCOUNT_DIR || K8S_SERVICE_ACCOUNT_DIR;
    return {
        tokenPath: process.env.PILOTSWARM_K8S_TOKEN_PATH || path.join(baseDir, "token"),
        caPath: process.env.PILOTSWARM_K8S_CA_PATH || path.join(baseDir, "ca.crt"),
        namespacePath: process.env.PILOTSWARM_K8S_NAMESPACE_PATH || path.join(baseDir, "namespace"),
    };
}

function readOptionalTextFile(filePath) {
    try {
        return fs.readFileSync(filePath, "utf8").trim();
    } catch {
        return "";
    }
}

function hasInClusterK8sAccess() {
    const { tokenPath, caPath } = getInClusterK8sPaths();
    return Boolean(process.env.KUBERNETES_SERVICE_HOST)
        && fileExists(tokenPath)
        && fileExists(caPath);
}

function getInClusterK8sConfig() {
    if (!hasInClusterK8sAccess()) return null;

    const { tokenPath, caPath, namespacePath } = getInClusterK8sPaths();
    return {
        host: String(process.env.KUBERNETES_SERVICE_HOST || "").trim(),
        port: Number(process.env.KUBERNETES_SERVICE_PORT || 443) || 443,
        token: readOptionalTextFile(tokenPath),
        ca: fs.readFileSync(caPath),
        namespace: String(process.env.K8S_NAMESPACE || "").trim() || readOptionalTextFile(namespacePath) || "default",
    };
}

function hasExplicitKubectlConfig() {
    return Boolean((process.env.K8S_CONTEXT || "").trim() || (process.env.KUBECONFIG || "").trim());
}

function isKubectlAvailable() {
    const result = spawnSync("kubectl", ["version", "--client=true"], { stdio: "ignore" });
    return !result.error;
}

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
    const orchMatch = rawLine.match(/\b(?:instance_id|orchestration_id|orch)=(session-[^\s,]+)/i)
        || rawLine.match(/\b(session-[0-9a-f-]{8,})\b/i);
    const parsedOrchId = orchMatch ? orchMatch[1] : null;
    const sessionIdMatch = rawLine.match(/\b(?:sessionId|session|durableSessionId)=([0-9a-f-]{8,})\b/i);
    const sessionId = sessionIdMatch
        ? sessionIdMatch[1]
        : (parsedOrchId && parsedOrchId.startsWith("session-") ? parsedOrchId.slice("session-".length) : null);
    const orchId = parsedOrchId || (sessionId ? `session-${sessionId}` : null);
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
        sessionId,
        category,
        rawLine,
        message: extractPrettyLogMessage(rawLine),
        prettyMessage: extractPrettyLogMessage(rawLine),
    };
}

function buildSyntheticLogEntry({ message, level = "info", podName = "k8s", counter = 0 }) {
    const safeMessage = trimLogText(String(message || "").trim());
    return {
        id: `log:${Date.now()}:${counter}`,
        time: extractLogTime(safeMessage),
        podName,
        level,
        orchId: null,
        sessionId: null,
        category: "log",
        rawLine: safeMessage,
        message: safeMessage,
        prettyMessage: safeMessage,
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

function getLocalLogDir() {
    const configured = expandUserPath(process.env.PILOTSWARM_LOG_DIR || "");
    return configured ? path.resolve(configured) : "";
}

function listLocalLogFiles(logDir) {
    if (!logDir || !fileExists(logDir)) return [];
    try {
        return fs.readdirSync(logDir, { withFileTypes: true })
            .filter((entry) => entry.isFile() && entry.name.endsWith(".log"))
            .map((entry) => path.join(logDir, entry.name))
            .sort();
    } catch {
        return [];
    }
}

function readRecentLogLines(filePath, maxBytes = 128 * 1024, maxLines = 200) {
    try {
        const stats = fs.statSync(filePath);
        if (!stats.isFile() || stats.size <= 0) return [];
        const fd = fs.openSync(filePath, "r");
        try {
            const bytesToRead = Math.min(stats.size, maxBytes);
            const buffer = Buffer.alloc(bytesToRead);
            fs.readSync(fd, buffer, 0, bytesToRead, stats.size - bytesToRead);
            let text = buffer.toString("utf8");
            if (bytesToRead < stats.size) {
                const newlineIndex = text.indexOf("\n");
                text = newlineIndex >= 0 ? text.slice(newlineIndex + 1) : "";
            }
            return text
                .split(/\r?\n/u)
                .map((line) => line.trimEnd())
                .filter(Boolean)
                .slice(-maxLines);
        } finally {
            fs.closeSync(fd);
        }
    } catch {
        return [];
    }
}

function readLogChunk(filePath, start, end) {
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return "";
    try {
        const fd = fs.openSync(filePath, "r");
        try {
            const length = end - start;
            const buffer = Buffer.alloc(length);
            const bytesRead = fs.readSync(fd, buffer, 0, length, start);
            return buffer.toString("utf8", 0, bytesRead);
        } finally {
            fs.closeSync(fd);
        }
    } catch {
        return "";
    }
}

function getLocalLogPollIntervalMs() {
    const value = Number.parseInt(process.env.PILOTSWARM_LOG_POLL_INTERVAL_MS || "", 10);
    if (Number.isFinite(value) && value >= 50) return value;
    return 500;
}

function guessArtifactContentType(filename) {
    const ext = path.extname(String(filename || "")).toLowerCase();
    if (ext === ".md" || ext === ".markdown" || ext === ".mdx") return "text/markdown";
    if (ext === ".json" || ext === ".jsonl") return "application/json";
    if (ext === ".html" || ext === ".htm") return "text/html";
    if (ext === ".csv") return "text/csv";
    if (ext === ".yaml" || ext === ".yml") return "text/yaml";
    if (ext === ".xml") return "application/xml";
    if (ext === ".js" || ext === ".mjs" || ext === ".cjs") return "application/javascript";
    if (ext === ".pdf") return "application/pdf";
    if (ext === ".zip") return "application/zip";
    if (ext === ".tar") return "application/x-tar";
    if (ext === ".tgz" || ext === ".gz") return "application/gzip";
    if (ext === ".png") return "image/png";
    if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
    if (ext === ".gif") return "image/gif";
    if (ext === ".webp") return "image/webp";
    if (ext === ".svg") return "image/svg+xml";
    if (ext === ".xlsx") return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    if (ext === ".docx") return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    if (ext === ".pptx") return "application/vnd.openxmlformats-officedocument.presentationml.presentation";
    if (ext === ".bin") return "application/octet-stream";
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

function normalizeCreatableAgent(agent) {
    const name = String(agent?.name || "").trim();
    if (!name) return null;
    return {
        name,
        title: String(agent?.title || "").trim() || (name.charAt(0).toUpperCase() + name.slice(1)),
        description: String(agent?.description || "").trim(),
        splash: typeof agent?.splash === "string" && agent.splash.trim() ? agent.splash : null,
        // Narrow-viewport splash variant. Must be carried alongside `splash`:
        // the session-agent picker (controller.openSessionAgentPicker) forwards
        // both to createSessionForAgent, which persists them to the session's
        // splash / splash_mobile columns. Dropping it here (while keeping
        // `splash`) is why agent sessions stored only the desktop art and the
        // mobile portal had nothing to swap to on narrow screens.
        splashMobile: typeof agent?.splashMobile === "string" && agent.splashMobile.trim() ? agent.splashMobile : null,
        initialPrompt: typeof agent?.initialPrompt === "string" && agent.initialPrompt.trim() ? agent.initialPrompt : null,
        tools: Array.isArray(agent?.tools) ? agent.tools.filter(Boolean) : [],
        skills: Array.isArray(agent?.skills) ? agent.skills.filter(Boolean) : [],
        // MCP servers as NAMES ONLY. Embedded-mode agents carry the RESOLVED
        // server map (Record<name, config> — configs can hold expanded
        // credentials and must never reach clients); file-loaded agents
        // carry the frontmatter's name list. Normalize both to names.
        mcpServers: Array.isArray(agent?.mcpServers)
            ? agent.mcpServers.filter((entry) => typeof entry === "string" && entry)
            : (agent?.mcpServers && typeof agent.mcpServers === "object" ? Object.keys(agent.mcpServers) : []),
        allowedSkills: Array.isArray(agent?.allowedSkills) ? agent.allowedSkills.filter(Boolean) : null,
        toolPolicy: agent?.toolPolicy && typeof agent.toolPolicy === "object"
            ? {
                ...(Array.isArray(agent.toolPolicy.allow) && agent.toolPolicy.allow.length ? { allow: agent.toolPolicy.allow.filter(Boolean) } : {}),
                ...(Array.isArray(agent.toolPolicy.deny) && agent.toolPolicy.deny.length ? { deny: agent.toolPolicy.deny.filter(Boolean) } : {}),
            }
            : null,
    };
}

function normalizeAgentIdentity(value) {
    return String(value || "").trim().toLowerCase();
}

function loadBundledDefaultAgents() {
    const agentsByKey = new Map();
    // Resolve the SDK package root through module resolution so the lookup
    // works identically in the monorepo (workspace symlink) and in published
    // installs, regardless of where this file lives inside the app package.
    const candidates = [];
    try {
        const sdkRoot = path.dirname(createRequire(import.meta.url).resolve("pilotswarm-sdk/package.json"));
        candidates.push(path.join(sdkRoot, "plugins", "default-agents", "agents"));
    } catch {
        // pilotswarm-sdk not resolvable — fall through to path heuristics.
    }
    candidates.push(
        path.join(PACKAGE_PARENT_DIR, "..", "sdk", "plugins", "default-agents", "agents"),
        path.join(PACKAGE_PARENT_DIR, "..", "pilotswarm-sdk", "plugins", "default-agents", "agents"),
        path.join(CLI_PACKAGE_ROOT, "node_modules", "pilotswarm-sdk", "plugins", "default-agents", "agents"),
    );

    for (const agentsDir of candidates) {
        if (!fs.existsSync(agentsDir)) continue;
        try {
            for (const agent of loadAgentFiles(agentsDir)) {
                if (!agent || agent.system || agent.name === "default") continue;
                const normalized = normalizeCreatableAgent(agent);
                if (!normalized) continue;
                agentsByKey.set(normalizeAgentIdentity(normalized.name), normalized);
            }
        } catch {}
    }
    return agentsByKey;
}

export function loadSessionCreationMetadataFromPluginDirs(pluginDirs = []) {
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

    const bundledAgents = loadBundledDefaultAgents();
    const requestedBundledAgents = Array.isArray(sessionPolicy?.creation?.bundledAgents)
        ? sessionPolicy.creation.bundledAgents
        : [];
    const appAgentKeys = new Set([...agentsByName.keys()].map((name) => normalizeAgentIdentity(name)));
    const defaultAgentKey = normalizeAgentIdentity(sessionPolicy?.creation?.defaultAgent);

    if (requestedBundledAgents.length === 0) {
        if (defaultAgentKey && bundledAgents.has(defaultAgentKey) && !appAgentKeys.has(defaultAgentKey)) {
            throw new Error(`[PilotSwarm] session-policy.json creation.defaultAgent=${JSON.stringify(sessionPolicy.creation.defaultAgent)} references a bundled default agent but creation.bundledAgents does not opt it in.`);
        }
    } else {
        const requestedKeys = new Set();
        for (const name of requestedBundledAgents) {
            const key = normalizeAgentIdentity(name);
            if (!key || !bundledAgents.has(key)) {
                throw new Error(`[PilotSwarm] session-policy.json creation.bundledAgents contains unknown bundled agent ${JSON.stringify(name)}.`);
            }
            requestedKeys.add(key);
        }
        if (defaultAgentKey && bundledAgents.has(defaultAgentKey) && !requestedKeys.has(defaultAgentKey) && !appAgentKeys.has(defaultAgentKey)) {
            throw new Error(`[PilotSwarm] session-policy.json creation.defaultAgent=${JSON.stringify(sessionPolicy.creation.defaultAgent)} references a bundled default agent but creation.bundledAgents does not opt it in.`);
        }
        for (const key of requestedKeys) {
            if (appAgentKeys.has(key)) continue;
            const agent = bundledAgents.get(key);
            agentsByName.set(agent.name, agent);
            appAgentKeys.add(key);
        }
    }

    const creatableAgents = [...agentsByName.values()];
    return {
        sessionPolicy,
        allowedAgentNames: creatableAgents.map((agent) => agent.name),
        creatableAgents,
    };
}

function buildTerminalSendError(sessionId, session) {
    if (session?.status === "failed" || session?.status === "cancelled" || session?.orchestrationStatus === "Failed") {
        return `Session ${sessionId.slice(0, 8)} is a terminal orchestration and cannot accept new messages.`;
    }

    const statusLabel = String(session?.orchestrationStatus || session?.status || "Unknown");
    return `Session ${sessionId.slice(0, 8)} is a terminal orchestration instance (${statusLabel}) and cannot accept new messages.`;
}

function normalizeUserPrincipal(principal) {
    const provider = String(principal?.provider || "").trim();
    const subject = String(principal?.subject || "").trim();
    if (!provider || !subject) return { ...LOCAL_DEFAULT_USER_PRINCIPAL };
    const email = String(principal?.email || "").trim();
    const displayName = String(principal?.displayName || "").trim();
    return {
        provider,
        subject,
        email: email || null,
        displayName: displayName || null,
    };
}

function resolveUserPrincipalFor(transport, principal) {
    if (principal && principal.provider && principal.subject) {
        return normalizeUserPrincipal(principal);
    }
    return normalizeUserPrincipal(transport.currentUser);
}

export class NodeSdkTransport {
    constructor({ store, mode, currentUser, useManagedIdentity, cmsFactsDatabaseUrl, aadDbUser } = {}) {
        this.store = store;
        this.mode = mode;
        this.useManagedIdentity = useManagedIdentity;
        this.cmsFactsDatabaseUrl = cmsFactsDatabaseUrl;
        this.aadDbUser = aadDbUser;
        this.pluginDirs = getPluginDirsFromEnv();
        // Optional EnhancedFactStore (HorizonDB) target. The client and
        // management client each build their own fact store, so they MUST
        // resolve the SAME facts DB as the embedded worker or session
        // cleanup / facts reads would hit the wrong database. Empty unless
        // HORIZON_DATABASE_URL is set. Graph/embedder fields are worker-only
        // and intentionally not forwarded here.
        const horizon = horizonConfigFromEnv();
        this.enhancedFacts = horizon.enhancedFactsDatabaseUrl
            ? {
                enhancedFactsDatabaseUrl: horizon.enhancedFactsDatabaseUrl,
                ...(horizon.enhancedFactsSchema ? { enhancedFactsSchema: horizon.enhancedFactsSchema } : {}),
            }
            : {};
        this.client = null;
        this.mgmt = new PilotSwarmManagementClient({
            store,
            ...(useManagedIdentity !== undefined ? { useManagedIdentity } : {}),
            ...(cmsFactsDatabaseUrl ? { cmsFactsDatabaseUrl } : {}),
            ...(aadDbUser ? { aadDbUser } : {}),
            ...this.enhancedFacts,
            pluginDirs: this.pluginDirs,
            blobEnabled: Boolean(process.env.AZURE_STORAGE_ACCOUNT_URL || process.env.AZURE_STORAGE_CONNECTION_STRING),
        });
        this.artifactStore = createArtifactStore();
        this.sessionHandles = new Map();
        this.workers = [];
        this.sessionPolicy = null;
        this.allowedAgentNames = [];
        this.creatableAgents = [];
        this.logProc = null;
        this.logTailHandle = null;
        this.logBuffer = "";
        this.logRestartTimer = null;
        this.logSubscribers = new Set();
        this.logEntryCounter = 0;
        this.kubectlAvailable = null;
        // The native TUI runs as the local user. Portal deployments override
        // this per-RPC from the auth context inside PortalRuntime.call().
        this.currentUser = currentUser ? normalizeUserPrincipal(currentUser) : { ...LOCAL_DEFAULT_USER_PRINCIPAL };
    }

    /**
     * Replace the principal that user-scoped RPCs (Admin Console,
     * profile settings, GitHub Copilot key) attach to. Local TUI hosts
     * may set this once at startup; portal hosts pass principals per
     * RPC instead and never call this method.
     */
    setCurrentUser(principal) {
        if (!principal || !principal.provider || !principal.subject) {
            this.currentUser = { ...LOCAL_DEFAULT_USER_PRINCIPAL };
            return;
        }
        this.currentUser = normalizeUserPrincipal(principal);
    }

    getCurrentUserPrincipal() {
        return { ...this.currentUser };
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
            ...(this.useManagedIdentity !== undefined ? { useManagedIdentity: this.useManagedIdentity } : {}),
            ...(this.cmsFactsDatabaseUrl ? { cmsFactsDatabaseUrl: this.cmsFactsDatabaseUrl } : {}),
            ...(this.aadDbUser ? { aadDbUser: this.aadDbUser } : {}),
            ...this.enhancedFacts,
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
                ? firstWorker.loadedAgents.map((agent) => normalizeCreatableAgent({
                    ...agent,
                    // Restriction fields are stripped from the composed
                    // customAgents surface — re-attach them from the
                    // worker's resolution maps so embedded mode reports the
                    // same capability metadata as the file-loading path.
                    allowedSkills: firstWorker.agentAllowedSkills?.[agent.name],
                    toolPolicy: firstWorker.agentToolPolicy?.[agent.name],
                })).filter(Boolean)
                : [];
            return {
                sessionPolicy: firstWorker?.sessionPolicy || null,
                allowedAgentNames: Array.isArray(firstWorker?.allowedAgentNames) ? firstWorker.allowedAgentNames.filter(Boolean) : creatableAgents.map((agent) => agent.name),
                creatableAgents,
            };
        }
        return loadSessionCreationMetadataFromPluginDirs(getPluginDirsFromEnv());
    }

    /**
     * Normalize an untrusted capabilities payload against the deployment
     * catalog when one is available (unknown names dropped with a warning);
     * without a catalog the sanitized override passes through — assembly
     * ignores unknown names harmlessly.
     */
    async _normalizeCapabilitiesInput(capabilities) {
        if (!capabilities || typeof capabilities !== "object") return null;
        const catalog = await this.getCapabilityCatalog().catch(() => null);
        const validators = catalog
            ? {
                mcpServers: (name) => (catalog.mcpServers ?? []).some((s) => s?.name === name),
                skills: (name) => (catalog.skills ?? []).some((s) => s?.name === name),
                tools: (name) => (catalog.tools ?? []).some((t) => t?.name === name || t?.group === name),
            }
            : undefined;
        const { override, dropped } = normalizeCapabilityOverride(capabilities, validators);
        for (const [axis, names] of Object.entries(dropped)) {
            console.warn(`[NodeSdkTransport] capability override: dropped unknown ${axis} entries: ${names.join(", ")}`);
        }
        return override;
    }

    /**
     * Reconfigure a session TREE's capability override (applies next turn).
     * Passing `null` explicitly CLEARS the override. Passing a non-null
     * object whose entries all fail catalog validation is a caller error
     * (likely a typo) — reject it rather than silently clearing an existing
     * restriction, which would fail open.
     */
    async configureSession(sessionId, capabilities) {
        if (capabilities === null) {
            return this.mgmt.configureSessionCapabilities(sessionId, null);
        }
        const override = await this._normalizeCapabilitiesInput(capabilities);
        if (capabilities && typeof capabilities === "object" && override === null) {
            throw new Error(
                "configureSession: none of the requested capability names are in the deployment catalog. " +
                "To CLEAR the override, pass null explicitly.",
            );
        }
        return this.mgmt.configureSessionCapabilities(sessionId, override);
    }

    /** The tree-root capability override governing a session, or null. */
    async getSessionCapabilities(sessionId) {
        return this.mgmt.getSessionCapabilityOverride(sessionId);
    }

    /**
     * Deployment capability catalog. Embedded mode builds it from the live
     * worker; remote mode reads the worker-published CMS row (null when no
     * worker has published one or the schema predates migration 0035).
     */
    async getCapabilityCatalog() {
        if (this.workers.length > 0 && typeof this.workers[0]?.buildCapabilityCatalog === "function") {
            return this.workers[0].buildCapabilityCatalog();
        }
        if (this.mgmt && typeof this.mgmt.getCapabilityCatalog === "function") {
            try {
                return await this.mgmt.getCapabilityCatalog();
            } catch {
                return null;
            }
        }
        return null;
    }

    getWorkerCount() {
        return this.workers.length || (this.mode === "remote" ? 0 : parseInt(process.env.WORKERS || "4", 10));
    }

    getLogConfig() {
        const localLogDir = getLocalLogDir();
        if (localLogDir) {
            const exists = fileExists(localLogDir);
            return {
                available: exists,
                availabilityReason: exists
                    ? ""
                    : `Log tailing disabled: local log directory ${JSON.stringify(localLogDir)} does not exist.`,
            };
        }

        const hasInClusterConfig = hasInClusterK8sAccess();
        const hasKubectlConfig = hasExplicitKubectlConfig();
        if (hasInClusterConfig) {
            return {
                available: true,
                availabilityReason: "",
            };
        }

        if (hasKubectlConfig) {
            if (this.kubectlAvailable == null) {
                this.kubectlAvailable = isKubectlAvailable();
            }
            return {
                available: this.kubectlAvailable,
                availabilityReason: this.kubectlAvailable
                    ? ""
                    : "Log tailing disabled: kubectl is not installed in this environment.",
            };
        }

        return {
            available: false,
            availabilityReason: "Log tailing disabled: no K8S_CONTEXT/KUBECONFIG or in-cluster Kubernetes access detected.",
        };
    }

    getAuthContext() {
        return {
            principal: null,
            authorization: {
                allowed: true,
                role: null,
                reason: "Local transport",
                matchedGroups: [],
            },
        };
    }

    /**
     * Placements are viewer-private, so every read path must scope to the
     * same principal the write path (placeSessionsInGroup / createSessionGroup)
     * uses — otherwise the local TUI writes placements it can never read back
     * (grouping would appear to succeed but never render). Local hosts resolve
     * to the current/default user.
     */
    _placementViewer() {
        const resolved = resolveUserPrincipalFor(this, null);
        return { provider: resolved.provider, subject: resolved.subject };
    }

    async listSessions() {
        return this.mgmt.listSessions(this._placementViewer());
    }

    async listSessionGroups() {
        return this.mgmt.listSessionGroups(this._placementViewer());
    }

    async createSessionGroup(input) {
        const safeInput = input && typeof input === "object" ? input : {};
        // Groups are private per-user organization: an ownerless group can
        // never receive placements, so local TUI hosts that omit the owner
        // key entirely get the transport's current user stamped. The portal
        // runtime always sends an explicit owner key (resolved from the auth
        // context) and passes through untouched.
        if (Object.hasOwn(safeInput, "owner")) {
            return this.mgmt.createSessionGroup(safeInput);
        }
        return this.mgmt.createSessionGroup({
            ...safeInput,
            owner: resolveUserPrincipalFor(this, null),
        });
    }

    async updateSessionGroup(groupId, patch) {
        return this.mgmt.updateSessionGroup(groupId, patch || {});
    }

    async assignSessionsToGroup(groupId, sessionIds) {
        return this.mgmt.assignSessionsToGroup(groupId, sessionIds || []);
    }

    async moveSessionsToGroup(groupId, sessionIds) {
        return this.mgmt.moveSessionsToGroup(groupId ?? null, sessionIds || []);
    }

    /**
     * Viewer-private placement (groupId null = ungroup). The placing viewer
     * defaults to the transport's current user (local TUI hosts); the portal
     * runtime dispatches through `transport.mgmt` with the authenticated
     * principal instead. Direct mode has no ownership enforcement, so the
     * viewer is passed with isAdmin (every live session is readable).
     */
    async placeSessionsInGroup(sessionIds, groupId, viewer) {
        const resolved = resolveUserPrincipalFor(this, viewer);
        return this.mgmt.placeSessionsInGroup(
            { provider: resolved.provider, subject: resolved.subject, isAdmin: true },
            sessionIds || [],
            groupId ?? null,
        );
    }

    async getChildOutcome(childSessionId) {
        return this.mgmt.getChildOutcome(childSessionId);
    }

    async listChildOutcomes(parentSessionId) {
        return this.mgmt.listChildOutcomes(parentSessionId);
    }

    async listSessionsPage(opts) {
        const safeOpts = opts && typeof opts === "object" ? opts : {};
        return this.mgmt.listSessionsPage({ ...safeOpts, placement: safeOpts.placement ?? this._placementViewer() });
    }

    async listSessionsVisible(viewer) {
        return this.mgmt.listSessionsVisible(viewer, this._placementViewer());
    }

    async listKnownUsers(opts) {
        return this.mgmt.listKnownUsers(opts);
    }

    async getSession(sessionId) {
        return this.mgmt.getSession(sessionId, this._placementViewer());
    }

    // ── Session sharing / access (security model) ────────────────

    async getSessionAccess(sessionId, viewer) {
        return this.mgmt.getSessionAccess(sessionId, viewer);
    }

    async setSessionVisibility(sessionId, visibility) {
        return this.mgmt.setSessionVisibility(sessionId, visibility);
    }

    async grantSessionShare(sessionId, grantee, access, grantedBy) {
        return this.mgmt.grantSessionShare(sessionId, grantee, access, grantedBy);
    }

    async revokeSessionShare(sessionId, grantee) {
        return this.mgmt.revokeSessionShare(sessionId, grantee);
    }

    async listSessionShares(sessionId) {
        return this.mgmt.listSessionShares(sessionId);
    }

    async recordAuthzAudit(entry) {
        return this.mgmt.recordAuthzAudit(entry);
    }

    async listAuthzAudit(opts) {
        return this.mgmt.listAuthzAudit(opts);
    }

    async getOrchestrationStats(sessionId) {
        return this.mgmt.getOrchestrationStats(sessionId);
    }

    async getSessionMetricSummary(sessionId) {
        return this.mgmt.getSessionMetricSummary(sessionId);
    }

    async getSessionTokensByModel(sessionId) {
        return this.mgmt.getSessionTokensByModel(sessionId);
    }

    async getSessionTreeStats(sessionId) {
        return this.mgmt.getSessionTreeStats(sessionId);
    }

    async getFleetStats(opts) {
        return this.mgmt.getFleetStats(opts);
    }

    async getUserStats(opts) {
        return this.mgmt.getUserStats(opts);
    }

    async getTopEventEmitters(opts) {
        return this.mgmt.getTopEventEmitters(opts);
    }

    /**
     * Read the current user's profile (settings + ghcp key-set flag).
     * The portal supplies `principal` from the auth context per-request;
     * the native TUI omits it and falls back to the transport's
     * `currentUser` (defaults to LOCAL_DEFAULT_USER_PRINCIPAL).
     */
    async getCurrentUserProfile({ principal } = {}) {
        const resolved = resolveUserPrincipalFor(this, principal);
        return this.mgmt.getUserProfile(resolved);
    }

    /**
     * Replace the current user's profile_settings JSON document.
     */
    async setCurrentUserProfileSettings({ principal, settings } = {}) {
        const resolved = resolveUserPrincipalFor(this, principal);
        const safeSettings = settings && typeof settings === "object" && !Array.isArray(settings) ? settings : {};
        return this.mgmt.setUserProfileSettings(resolved, safeSettings);
    }

    /**
     * Set or clear the per-user GitHub Copilot key. Pass `null` (or an
     * all-whitespace string) to clear the override and revert to the
     * worker's env-supplied default.
     */
    async setCurrentUserGitHubCopilotKey({ principal, key } = {}) {
        const resolved = resolveUserPrincipalFor(this, principal);
        const normalized = typeof key === "string" && key.trim().length > 0 ? key : null;
        return this.mgmt.setUserGitHubCopilotKey(resolved, normalized);
    }

    /**
     * Admin: set or clear the SYSTEM user's GitHub Copilot key (used by
     * ownerless system sessions). The web runtime enforces the admin role
     * before dispatching here; `actor` is recorded for audit.
     */
    async setSystemGitHubCopilotKey({ actor, key } = {}) {
        const resolvedActor = actor && actor.provider && actor.subject
            ? normalizeUserPrincipal(actor)
            : normalizeUserPrincipal(this.currentUser);
        const normalized = typeof key === "string" && key.trim().length > 0 ? key : null;
        return this.mgmt.setSystemGitHubCopilotKey(resolvedActor, normalized);
    }

    async getSystemGitHubCopilotKeyStatus() {
        return this.mgmt.getSystemGitHubCopilotKeyStatus();
    }

    async getSessionSkillUsage(sessionId, opts) {
        return this.mgmt.getSessionSkillUsage(sessionId, opts);
    }

    async getSessionTreeSkillUsage(sessionId, opts) {
        return this.mgmt.getSessionTreeSkillUsage(sessionId, opts);
    }

    async getFleetSkillUsage(opts) {
        return this.mgmt.getFleetSkillUsage(opts);
    }

    async getFleetRetrievalUsage(opts) {
        return this.mgmt.getFleetRetrievalUsage(opts);
    }

    async getSessionRetrievalUsage(sessionId, opts) {
        return this.mgmt.getSessionRetrievalUsage(sessionId, opts);
    }

    async getSessionTreeRetrievalUsage(sessionId, opts) {
        return this.mgmt.getSessionTreeRetrievalUsage(sessionId, opts);
    }

    async getSessionGraphNodeUsage(sessionId, opts) {
        return this.mgmt.getSessionGraphNodeUsage(sessionId, opts);
    }

    async getSessionGraphEdgeSearchUsage(sessionId, opts) {
        return this.mgmt.getSessionGraphEdgeSearchUsage(sessionId, opts);
    }

    async getSessionGraphSearches(sessionId, limit) {
        return this.mgmt.getSessionGraphSearches(sessionId, limit);
    }

    async getFleetGraphNodeUsage(opts) {
        return this.mgmt.getFleetGraphNodeUsage(opts);
    }

    async getSessionFactsStats(sessionId) {
        return this.mgmt.getSessionFactsStats(sessionId);
    }

    async getSessionTreeFactsStats(sessionId) {
        return this.mgmt.getSessionTreeFactsStats(sessionId);
    }

    async getSharedFactsStats() {
        return this.mgmt.getSharedFactsStats();
    }

    async getFactsTombstoneStats(opts) {
        return this.mgmt.getFactsTombstoneStats(opts);
    }

    // ─── Facts data-plane ────────────────────────────────────────────
    async factsCapabilities() {
        return this.mgmt.factsCapabilities();
    }

    async readFacts(query, roleOpts) {
        return this.mgmt.readFacts(query || {}, roleOpts);
    }

    async storeFact(input) {
        return this.mgmt.storeFact(input);
    }

    async deleteFactRecord(input) {
        return this.mgmt.deleteFact(input || {});
    }

    async searchFacts(query, opts, roleOpts) {
        return this.mgmt.searchFacts(query, opts, roleOpts);
    }

    async similarFacts(scopeKey, opts, roleOpts) {
        return this.mgmt.similarFacts(scopeKey, opts, roleOpts);
    }

    async getFactsEmbedderStatus() {
        return this.mgmt.getEmbedderStatus();
    }

    async startFactsEmbedder(opts) {
        return this.mgmt.startEmbedder(opts);
    }

    async stopFactsEmbedder(reason) {
        return this.mgmt.stopEmbedder(reason);
    }

    async forcePurgeFacts(input) {
        return this.mgmt.forcePurgeFacts(input || {});
    }

    // ─── Graph data-plane ────────────────────────────────────────────
    async searchGraphNodes(query) {
        return this.mgmt.searchGraphNodes(query || {});
    }

    async searchGraphEdges(query) {
        return this.mgmt.searchGraphEdges(query || {});
    }

    async graphNeighbourhood(nodeKey, depth, opts) {
        return this.mgmt.graphNeighbourhood(nodeKey, depth, opts);
    }

    async upsertGraphNode(input) {
        return this.mgmt.upsertGraphNode(input);
    }

    async upsertGraphEdge(input) {
        return this.mgmt.upsertGraphEdge(input);
    }

    async deleteGraphNode(nodeKey, opts) {
        return this.mgmt.deleteGraphNode(nodeKey, opts);
    }

    async deleteGraphEdge(fromKey, toKey, predicateKey, opts) {
        return this.mgmt.deleteGraphEdge(fromKey, toKey, predicateKey, opts);
    }

    async graphStats(opts) {
        return this.mgmt.graphStats(opts);
    }

    async listGraphNamespaces(query) {
        return this.mgmt.listGraphNamespaces(query);
    }

    async getGraphNamespace(namespace) {
        return this.mgmt.getGraphNamespace(namespace);
    }

    async upsertGraphNamespace(input) {
        return this.mgmt.upsertGraphNamespace(input);
    }

    async deleteGraphNamespace(namespace) {
        return this.mgmt.deleteGraphNamespace(namespace);
    }

    async pruneDeletedSummaries(olderThan) {
        return this.mgmt.pruneDeletedSummaries(olderThan);
    }

    async getExecutionHistory(sessionId, executionId) {
        return this.mgmt.getExecutionHistory(sessionId, executionId);
    }

    async assertSessionModelCreatable({ model, owner } = {}) {
        const effectiveModel = model || this.mgmt.getDefaultModel();
        if (!effectiveModel || typeof this.mgmt.getModelCredentialStatus !== "function") return effectiveModel;

        const credentialStatus = this.mgmt.getModelCredentialStatus(effectiveModel);
        if (credentialStatus.providerType !== "github") return effectiveModel;
        if (credentialStatus.credentialAvailable) return effectiveModel;

        const principal = owner ? normalizeUserPrincipal(owner) : resolveUserPrincipalFor(this, null);
        const profile = principal
            ? await this.mgmt.getUserProfile(principal).catch(() => null)
            : null;
        if (profile?.githubCopilotKeySet === true) return effectiveModel;

        // The caller never picked this Copilot model — it came from the
        // catalog default. Fall back to the first non-Copilot model instead
        // of failing a session the user has no key for.
        if (!model && typeof this.mgmt.listModels === "function") {
            const fallback = (this.mgmt.listModels() || [])
                .find((entry) => entry?.providerType !== "github" && entry?.qualifiedName);
            if (fallback) return fallback.qualifiedName;
        }

        throw Object.assign(
            new Error(
                "GitHub Copilot key missing or invalid. Set GITHUB_TOKEN on the worker or configure your per-user GitHub Copilot key in Admin before using GitHub Copilot models.",
            ),
            { code: "GHCP_KEY_MISSING", status: 400 },
        );
    }

    async createSession({ model, reasoningEffort, contextTier, owner, groupId, visibility, capabilities } = {}) {
        const effectiveModel = await this.assertSessionModelCreatable({ model, owner });
        const normalizedCapabilities = await this._normalizeCapabilitiesInput(capabilities);
        const session = await this.client.createSession({
            ...(effectiveModel ? { model: effectiveModel } : {}),
            ...(reasoningEffort ? { reasoningEffort } : {}),
            ...(contextTier ? { contextTier } : {}),
            ...(owner ? { owner } : {}),
            ...(groupId ? { groupId } : {}),
            ...(visibility ? { visibility } : {}),
            ...(normalizedCapabilities ? { capabilities: normalizedCapabilities } : {}),
        });
        this.sessionHandles.set(session.sessionId, session);
        return { sessionId: session.sessionId, model: effectiveModel, reasoningEffort: reasoningEffort || undefined, contextTier: contextTier || undefined };
    }

    async createSessionForAgent(agentName, { model, reasoningEffort, contextTier, title, splash, splashMobile, initialPrompt, owner, groupId, visibility, capabilities } = {}) {
        const effectiveModel = await this.assertSessionModelCreatable({ model, owner });
        const normalizedCapabilities = await this._normalizeCapabilitiesInput(capabilities);
        const session = await this.client.createSessionForAgent(agentName, {
            ...(effectiveModel ? { model: effectiveModel } : {}),
            ...(reasoningEffort ? { reasoningEffort } : {}),
            ...(contextTier ? { contextTier } : {}),
            ...(title ? { title } : {}),
            ...(splash ? { splash } : {}),
            ...(splashMobile ? { splashMobile } : {}),
            ...(initialPrompt ? { initialPrompt } : {}),
            ...(owner ? { owner } : {}),
            ...(groupId ? { groupId } : {}),
            ...(visibility ? { visibility } : {}),
            ...(normalizedCapabilities ? { capabilities: normalizedCapabilities } : {}),
        });
        this.sessionHandles.set(session.sessionId, session);
        return {
            sessionId: session.sessionId,
            model: effectiveModel,
            reasoningEffort: reasoningEffort || undefined,
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
        if (session.status === "failed" || session.status === "cancelled" || session.orchestrationStatus === "Failed") {
            throw new Error(buildTerminalSendError(sessionId, session));
        }
        if (
            (session.status === "completed" || session.status === "cancelled")
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

        const sendOptions = {
            ...(options?.clientMessageIds && Array.isArray(options.clientMessageIds) && options.clientMessageIds.length > 0
                ? { clientMessageIds: options.clientMessageIds }
                : {}),
            // Server-stamped sender identity (security model) — set by the
            // portal runtime from the validated auth context.
            ...(options?.sender && typeof options.sender === "object" ? { sender: options.sender } : {}),
        };

        if (options?.enqueueOnly) {
            // enqueueOnly originally routed through mgmt.sendMessage to skip
            // the wait-for-result polling, but PilotSwarmSession.send is
            // already fire-and-forget. Routing through the session handle
            // ensures _ensureOrchestrationAndSend starts the orchestration
            // on the very first message — mgmt.sendMessage only enqueues
            // and would silently produce orphan queue messages for fresh
            // sessions.
            const sessionHandleEnqueue = await this.getSessionHandle(sessionId);
            await sessionHandleEnqueue.send(prompt, sendOptions);
            return;
        }

        // IMPORTANT: do NOT silently fall back to mgmt.sendMessage on transient
        // errors. mgmt.sendMessage only enqueues onto the durable messages
        // queue — it never starts the orchestration. If sessionHandle.send
        // fails (for example startOrchestrationVersioned threw transiently),
        // falling back to a pure enqueue produces an "orphan queue message"
        // that duroxide-pg eventually drops, leaving the CMS row in `running`
        // state with `orchestration_id = NULL` and the UI stuck on
        // "Working…" forever. Propagate the error so the caller can retry
        // through the full sessionHandle.send path that owns the start.
        const sessionHandle = await this.getSessionHandle(sessionId);
        await sessionHandle.send(prompt, sendOptions);
    }

    async sendAnswer(sessionId, answer, options = {}) {
        await this.mgmt.sendAnswer(sessionId, answer, options?.sender ? { sender: options.sender } : undefined);
    }

    async sendSessionEvent(sessionId, eventName, data) {
        const sessionHandle = await this.getSessionHandle(sessionId);
        await sessionHandle.sendEvent(eventName, data);
    }

    async getSessionStatus(sessionId) {
        return this.mgmt.getSessionStatus(sessionId);
    }

    async waitForStatusChange(sessionId, afterVersion, timeoutMs) {
        return this.mgmt.waitForStatusChange(sessionId, afterVersion, undefined, timeoutMs);
    }

    async getLatestResponse(sessionId) {
        return this.mgmt.getLatestResponse(sessionId);
    }

    async cancelPendingMessage(sessionId, clientMessageIds) {
        const ids = Array.isArray(clientMessageIds)
            ? clientMessageIds.filter((id) => typeof id === "string" && id)
            : [];
        if (ids.length === 0) return;
        await this.mgmt.cancelPendingMessage(sessionId, ids);
    }

    async renameSession(sessionId, title) {
        await this.mgmt.renameSession(sessionId, title);
    }

    async cancelSession(sessionId) {
        await this.mgmt.cancelSession(sessionId);
    }

    async cancelSessionGroup(groupId, reason) {
        await this.mgmt.cancelSessionGroup(groupId, reason);
    }

    async completeSession(sessionId, reason = "Completed by user") {
        await this.mgmt.sendCommand(sessionId, {
            cmd: "done",
            id: `done-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            args: { reason },
        });
    }

    async completeSessionGroup(groupId, options = {}) {
        await this.mgmt.completeSessionGroup(groupId, options);
    }

    async deleteSession(sessionId) {
        await this.mgmt.deleteSession(sessionId);
        this.sessionHandles.delete(sessionId);
    }

    async restartSystemSession(agentIdOrSessionId, options) {
        return this.mgmt.restartSystemSession(agentIdOrSessionId, options || {});
    }

    async setSessionModel(sessionId, options = {}) {
        return this.mgmt.setSessionModel(sessionId, options.model, {
            ...("reasoningEffort" in options ? { reasoningEffort: options.reasoningEffort ?? null } : {}),
            ...("contextTier" in options ? { contextTier: options.contextTier ?? null } : {}),
            source: options.source || "ui",
        });
    }

    async stopSessionTurn(sessionId, options = {}) {
        return this.mgmt.stopSessionTurn(sessionId, {
            reason: options.reason || "Stopped by user",
            ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
        });
    }

    async deleteSessionGroup(groupId) {
        await this.mgmt.deleteSessionGroup(groupId);
    }

    async listModels() {
        return this.mgmt.listModels();
    }

    async listArtifacts(sessionId) {
        if (!this.artifactStore || !sessionId) return [];
        const artifacts = await this.artifactStore.listArtifacts(sessionId);
        return Array.isArray(artifacts)
            ? [...artifacts].sort((left, right) => String(left?.filename || "").localeCompare(String(right?.filename || "")))
            : [];
    }

    async getArtifactMetadata(sessionId, filename) {
        if (!this.artifactStore || !sessionId || !filename) return null;
        if (typeof this.artifactStore.statArtifact === "function") {
            return this.artifactStore.statArtifact(sessionId, filename);
        }
        const artifacts = await this.artifactStore.listArtifacts(sessionId);
        return (artifacts || []).find((artifact) => artifact?.filename === filename) || null;
    }

    async copyArtifact(fromSessionId, fromFilename, toSessionId, toFilename) {
        if (!this.artifactStore) {
            throw new Error("Artifact store is not available for this transport.");
        }
        return this.artifactStore.copyArtifact(fromSessionId, fromFilename, toSessionId, toFilename);
    }

    async setArtifactPinned(sessionId, filename, pinned) {
        if (!this.artifactStore) {
            throw new Error("Artifact store is not available for this transport.");
        }
        return this.artifactStore.setArtifactPinned(sessionId, filename, pinned === true);
    }

    /** Base64 inline read for the MCP surface — JSON-safe, size-guarded. */
    async readArtifactBase64(sessionId, filename, maxBytes) {
        if (!this.artifactStore) {
            throw new Error("Artifact store is not available for this transport.");
        }
        const cap = Math.min(Math.max(1, Math.floor(maxBytes || 262144)), 1048576);
        const result = await this.artifactStore.downloadArtifact(sessionId, filename);
        const slice = result.body.subarray(0, cap);
        const { body: _body, ...meta } = result;
        return {
            ...meta,
            base64: slice.toString("base64"),
            truncated: slice.length < result.body.length,
        };
    }

    async deleteArtifact(sessionId, filename) {
        if (!this.artifactStore) {
            throw new Error("Artifact store is not available for this transport.");
        }
        return this.artifactStore.deleteArtifact(sessionId, filename);
    }

    async downloadArtifact(sessionId, filename) {
        if (!this.artifactStore) {
            throw new Error("Artifact store is not available for this transport.");
        }
        return this.artifactStore.downloadArtifactText(sessionId, filename);
    }

    async downloadArtifactBinary(sessionId, filename) {
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
        const contentType = guessArtifactContentType(filename);
        let meta;
        if (typeof this.artifactStore.uploadArtifactFromFile === "function") {
            meta = await this.artifactStore.uploadArtifactFromFile(sessionId, filename, resolvedPath, contentType, { source: "user" });
        } else {
            const content = await fs.promises.readFile(resolvedPath);
            meta = await this.artifactStore.uploadArtifact(sessionId, filename, content, contentType);
        }

        return {
            sessionId,
            filename,
            resolvedPath,
            sizeBytes: meta?.sizeBytes ?? stat.size,
            contentType,
            ...(meta?.sha256 ? { sha256: meta.sha256 } : {}),
        };
    }

    async uploadArtifactContent(sessionId, filename, content, contentType = guessArtifactContentType(filename), contentEncoding = null) {
        if (!this.artifactStore) {
            throw new Error("Artifact store is not available for this transport.");
        }
        const safeSessionId = String(sessionId || "").trim();
        const safeFilename = path.basename(String(filename || "").trim());
        let safeContent;
        if (!safeSessionId) {
            throw new Error("Session id is required for artifact upload.");
        }
        if (!safeFilename) {
            throw new Error("Filename is required for artifact upload.");
        }

        if (contentEncoding === "base64") {
            safeContent = Buffer.from(String(content || ""), "base64");
        } else if (Buffer.isBuffer(content)) {
            safeContent = content;
        } else if (content instanceof Uint8Array) {
            safeContent = Buffer.from(content);
        } else {
            safeContent = typeof content === "string" ? content : String(content || "");
        }

        await this.artifactStore.uploadArtifact(
            safeSessionId,
            safeFilename,
            safeContent,
            contentType || guessArtifactContentType(safeFilename),
        );

        return {
            sessionId: safeSessionId,
            filename: safeFilename,
            resolvedPath: safeFilename,
            sizeBytes: Buffer.isBuffer(safeContent)
                ? safeContent.length
                : Buffer.byteLength(safeContent, "utf8"),
            contentType: contentType || guessArtifactContentType(safeFilename),
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
        await fs.promises.writeFile(localPath, content.body);
        return {
            localPath,
        };
    }

    async exportExecutionHistory(sessionId) {
        if (!this.artifactStore) {
            throw new Error("Artifact store is not available for this transport.");
        }
        const shortId = String(sessionId || "").slice(0, 8);
        const [history, stats] = await Promise.all([
            this.mgmt.getExecutionHistory(sessionId),
            this.mgmt.getOrchestrationStats(sessionId),
        ]);
        const sessionInfo = await this.mgmt.getSession(sessionId).catch(() => null);
        const exportData = {
            exportedAt: new Date().toISOString(),
            sessionId,
            title: sessionInfo?.title || null,
            agentId: sessionInfo?.agentId || null,
            model: sessionInfo?.model || null,
            orchestrationStats: stats || null,
            eventCount: history?.length || 0,
            events: (history || []).map((e) => {
                const evt = { ...e };
                if (evt.data) {
                    try { evt.data = JSON.parse(evt.data); } catch { /* keep raw */ }
                }
                return evt;
            }),
        };
        const filename = `execution-history-${shortId}-${Date.now()}.json`;
        const content = JSON.stringify(exportData, null, 2);
        await this.artifactStore.uploadArtifact(sessionId, filename, content, guessArtifactContentType(filename));
        return {
            sessionId,
            filename,
            artifactLink: `artifact://${sessionId}/${filename}`,
            sizeBytes: Buffer.byteLength(content, "utf8"),
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

    async openUrlInDefaultBrowser(targetUrl) {
        const href = String(targetUrl || "").trim();
        if (!href) {
            throw new Error("URL cannot be empty.");
        }

        let parsedUrl;
        try {
            parsedUrl = new URL(href);
        } catch {
            throw new Error(`Invalid URL: ${targetUrl}`);
        }

        if (!/^https?:$/i.test(parsedUrl.protocol)) {
            throw new Error(`Unsupported URL protocol: ${parsedUrl.protocol}`);
        }

        if (process.platform === "darwin") {
            await spawnDetached("open", [parsedUrl.toString()]);
        } else if (process.platform === "win32") {
            await spawnDetached("cmd", ["/c", "start", "", parsedUrl.toString()]);
        } else {
            await spawnDetached("xdg-open", [parsedUrl.toString()]);
        }

        return { url: parsedUrl.toString() };
    }

    getModelsByProvider() {
        return this.mgmt.getModelsByProvider();
    }

    getDefaultModel() {
        return this.mgmt.getDefaultModel();
    }

    async getSessionEvents(sessionId, afterSeq, limit, eventTypes) {
        return this.mgmt.getSessionEvents(sessionId, afterSeq, limit, eventTypes);
    }

    async getSessionEventsBefore(sessionId, beforeSeq, limit, eventTypes) {
        if (typeof this.mgmt.getSessionEventsBefore !== "function") return [];
        return this.mgmt.getSessionEventsBefore(sessionId, beforeSeq, limit, eventTypes);
    }

    emitLogEntry(entry) {
        if (!this._logBatch) this._logBatch = [];
        this._logBatch.push(entry);
        if (!this._logBatchTimer) {
            this._logBatchTimer = setTimeout(() => {
                const batch = this._logBatch;
                this._logBatch = [];
                this._logBatchTimer = null;
                for (const handler of this.logSubscribers) {
                    try {
                        handler(batch);
                    } catch {}
                }
            }, 250);
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

    emitSyntheticLogMessage(message, level = "info", podName = "k8s") {
        this.logEntryCounter += 1;
        this.emitLogEntry(buildSyntheticLogEntry({
            message,
            level,
            podName,
            counter: this.logEntryCounter,
        }));
    }

    async listPodsFromKubeApi(config, labelSelector) {
        const params = new URLSearchParams();
        if (labelSelector) params.set("labelSelector", labelSelector);
        const pathName = `/api/v1/namespaces/${encodeURIComponent(config.namespace)}/pods${params.size > 0 ? `?${params.toString()}` : ""}`;

        return await new Promise((resolve, reject) => {
            const req = https.request({
                method: "GET",
                hostname: config.host,
                port: config.port,
                path: pathName,
                ca: config.ca,
                headers: {
                    Authorization: `Bearer ${config.token}`,
                    Accept: "application/json",
                },
            }, (res) => {
                let body = "";
                res.setEncoding("utf8");
                res.on("data", (chunk) => {
                    body += chunk;
                });
                res.on("end", () => {
                    if ((res.statusCode || 0) >= 400) {
                        reject(new Error(
                            `Kubernetes API pod list failed (${res.statusCode}): ${trimLogText(body || res.statusMessage || "unknown error")}`,
                        ));
                        return;
                    }
                    try {
                        const payload = JSON.parse(body || "{}");
                        const items = Array.isArray(payload?.items) ? payload.items : [];
                        resolve(items
                            .map((item) => String(item?.metadata?.name || "").trim())
                            .filter(Boolean));
                    } catch (error) {
                        reject(error);
                    }
                });
            });

            req.on("error", reject);
            req.end();
        });
    }

    streamPodLogsFromKubeApi(config, podName, handle, options = {}) {
        const params = new URLSearchParams({
            follow: "true",
            timestamps: "true",
            tailLines: String(options.tailLines ?? 500),
        });
        const pathName = `/api/v1/namespaces/${encodeURIComponent(config.namespace)}/pods/${encodeURIComponent(podName)}/log?${params.toString()}`;

        return new Promise((resolve, reject) => {
            let buffer = "";
            let settled = false;
            let response = null;

            const finish = (error = null) => {
                if (settled) return;
                settled = true;

                if (buffer.trim()) {
                    this.logEntryCounter += 1;
                    this.emitLogEntry(buildLogEntry(`[pod/${podName}] ${buffer.trim()}`, this.logEntryCounter));
                    buffer = "";
                }

                if (response) {
                    handle.responses.delete(response);
                }
                handle.requests.delete(request);

                if (error) reject(error);
                else resolve();
            };

            const request = https.request({
                method: "GET",
                hostname: config.host,
                port: config.port,
                path: pathName,
                ca: config.ca,
                headers: {
                    Authorization: `Bearer ${config.token}`,
                    Accept: "*/*",
                },
            }, (res) => {
                response = res;
                handle.responses.add(res);

                if ((res.statusCode || 0) >= 400) {
                    let body = "";
                    res.setEncoding("utf8");
                    res.on("data", (chunk) => {
                        body += chunk;
                    });
                    res.on("end", () => {
                        finish(new Error(
                            `Kubernetes log stream failed for ${podName} (${res.statusCode}): ${trimLogText(body || res.statusMessage || "unknown error")}`,
                        ));
                    });
                    return;
                }

                res.setEncoding("utf8");
                res.on("data", (chunk) => {
                    buffer += chunk;
                    const lines = buffer.split("\n");
                    buffer = lines.pop() || "";
                    for (const line of lines) {
                        if (!line.trim()) continue;
                        this.logEntryCounter += 1;
                        this.emitLogEntry(buildLogEntry(`[pod/${podName}] ${line}`, this.logEntryCounter));
                    }
                });
                res.on("end", () => finish());
                res.on("close", () => finish());
                res.on("error", (error) => finish(error));
            });

            handle.requests.add(request);
            request.on("error", (error) => finish(error));
            request.end();
        });
    }

    startInClusterLogProcess() {
        const config = getInClusterK8sConfig();
        if (!config || this.logTailHandle) return;

        const labelSelector = process.env.K8S_POD_LABEL || "app.kubernetes.io/component=worker";
        const handle = {
            stopped: false,
            requests: new Set(),
            responses: new Set(),
            stop: () => {
                if (handle.stopped) return;
                handle.stopped = true;
                for (const response of handle.responses) {
                    try { response.destroy(); } catch {}
                }
                handle.responses.clear();
                for (const request of handle.requests) {
                    try { request.destroy(); } catch {}
                }
                handle.requests.clear();
            },
        };
        this.logTailHandle = handle;

        this.listPodsFromKubeApi(config, labelSelector)
            .then(async (podNames) => {
                if (handle.stopped || this.logTailHandle !== handle) return;
                if (podNames.length === 0) {
                    this.emitSyntheticLogMessage(
                        `No pods matched label selector ${JSON.stringify(labelSelector)} in namespace ${config.namespace}.`,
                        "warn",
                    );
                    return;
                }

                const results = await Promise.allSettled(
                    podNames.map((podName) => this.streamPodLogsFromKubeApi(config, podName, handle)),
                );

                if (handle.stopped || this.logTailHandle !== handle) return;
                for (const result of results) {
                    if (result.status === "fulfilled") continue;
                    this.emitSyntheticLogMessage(result.reason?.message || String(result.reason), "error");
                }
            })
            .catch((error) => {
                if (handle.stopped || this.logTailHandle !== handle) return;
                this.emitSyntheticLogMessage(error?.message || String(error), "error");
            })
            .finally(() => {
                if (this.logTailHandle === handle) {
                    this.logTailHandle = null;
                }
                if (!handle.stopped) {
                    this.scheduleLogRestart();
                }
            });
    }

    startKubectlLogProcess() {
        if (this.logProc) return;

        const config = this.getLogConfig();
        if (!config.available) return;

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
            this.emitSyntheticLogMessage(text, "warn", "kubectl");
        });

        this.logProc.on("error", (error) => {
            this.emitSyntheticLogMessage(`kubectl error: ${error.message}`, "error", "kubectl");
        });

        this.logProc.on("exit", (code, signal) => {
            this.logProc = null;
            this.emitSyntheticLogMessage(`kubectl exited (code=${code} signal=${signal})`, "warn", "kubectl");
            this.scheduleLogRestart();
        });
    }

    startLocalLogProcess() {
        const logDir = getLocalLogDir();
        if (!logDir || this.logTailHandle) return;

        const handle = {
            stopped: false,
            files: new Map(),
            interval: null,
            stop: () => {
                if (handle.stopped) return;
                handle.stopped = true;
                if (handle.interval) {
                    clearInterval(handle.interval);
                    handle.interval = null;
                }
                handle.files.clear();
            },
        };
        this.logTailHandle = handle;

        const emitLine = (filePath, line) => {
            const text = String(line || "").trim();
            if (!text) return;
            const pseudoPod = path.basename(filePath, path.extname(filePath));
            this.logEntryCounter += 1;
            this.emitLogEntry(buildLogEntry(`[pod/${pseudoPod}] ${text}`, this.logEntryCounter));
        };

        const refresh = () => {
            if (handle.stopped || this.logTailHandle !== handle) return;
            for (const filePath of listLocalLogFiles(logDir)) {
                let state = handle.files.get(filePath);
                let stats;
                try {
                    stats = fs.statSync(filePath);
                } catch {
                    continue;
                }
                if (!stats.isFile()) continue;

                if (!state) {
                    state = {
                        position: stats.size,
                        inode: stats.ino,
                        buffer: "",
                    };
                    handle.files.set(filePath, state);
                    for (const line of readRecentLogLines(filePath)) {
                        emitLine(filePath, line);
                    }
                    state.position = stats.size;
                    state.inode = stats.ino;
                    continue;
                }

                if (state.inode !== stats.ino || stats.size < state.position) {
                    state.position = 0;
                    state.buffer = "";
                    state.inode = stats.ino;
                }

                if (stats.size <= state.position) continue;

                const chunk = readLogChunk(filePath, state.position, stats.size);
                state.position = stats.size;
                if (!chunk) continue;
                const combined = state.buffer + chunk;
                const lines = combined.split(/\r?\n/u);
                state.buffer = lines.pop() || "";
                for (const line of lines) {
                    emitLine(filePath, line);
                }
            }
        };

        try {
            refresh();
            handle.interval = setInterval(refresh, getLocalLogPollIntervalMs());
            if (typeof handle.interval.unref === "function") {
                handle.interval.unref();
            }
        } catch (error) {
            this.logTailHandle = null;
            handle.stop();
            this.emitSyntheticLogMessage(error?.message || String(error), "error", "local-log");
        }
    }

    startLogProcess() {
        const config = this.getLogConfig();
        if (!config.available || this.logProc || this.logTailHandle) return;

        if (getLocalLogDir()) {
            this.startLocalLogProcess();
            return;
        }

        if (hasInClusterK8sAccess()) {
            this.startInClusterLogProcess();
            return;
        }

        this.startKubectlLogProcess();
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
        if (this._logBatchTimer) {
            clearTimeout(this._logBatchTimer);
            this._logBatchTimer = null;
            this._logBatch = [];
        }
        if (this.logRestartTimer) {
            clearTimeout(this.logRestartTimer);
            this.logRestartTimer = null;
        }
        if (this.logTailHandle) {
            try {
                this.logTailHandle.stop();
            } catch {}
            this.logTailHandle = null;
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
    const sessionStateDir = (process.env.SESSION_STATE_DIR || "").trim() || undefined;
    const artifactDir = (process.env.ARTIFACT_DIR || "").trim() || undefined;

    try {
        const blobStore = createSessionBlobStore(process.env, { sessionStateDir });
        if (blobStore) return blobStore;
    } catch (err) {
        // AZURE_STORAGE_CONNECTION_STRING is set but unparseable
        // (typically a truncated or placeholder value left over in the
        // shell — e.g. "DefaultEndpointsProtocol=https" with no
        // AccountName/AccountKey), or PILOTSWARM_USE_MANAGED_IDENTITY=1
        // is set without AZURE_STORAGE_ACCOUNT_URL. Halt with an
        // actionable error instead of silently falling back to disk:
        // silent fallback would mask blob-storage misconfiguration in
        // production.
        const reason = err?.message || String(err);
        throw new Error(
            `Azure Blob Storage is configured but cannot be initialized (reason: ${reason}). ` +
            `Either fix the configuration or unset AZURE_STORAGE_CONNECTION_STRING / PILOTSWARM_BLOB_USE_MANAGED_IDENTITY / PILOTSWARM_USE_MANAGED_IDENTITY / AZURE_STORAGE_ACCOUNT_URL to fall back to the local filesystem artifact store.`,
        );
    }

    return new FilesystemArtifactStore(artifactDir);
}
