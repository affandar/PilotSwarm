#!/usr/bin/env node

/**
 * TUI chat client — Mode 2: Client-Only + AKS Workers.
 *
 * Three-column layout:
 *   Left (20%): Orchestrations panel
 *   Center (40%): Chat pane
 *   Right (40%): Per-worker log panes (dynamic)
 *   Bottom: Input bar
 *
 * Usage: node --env-file=.env.remote examples/tui-scaled.js
 *
 * Prerequisites:
 *   - AKS worker pods running (kubectl get pods -n copilot-sdk)
 *   - copilot_sdk schema created on the remote PostgreSQL
 */

import { DurableCopilotClient } from "../dist/index.js";
import { createRequire } from "node:module";
import { marked } from "marked";
import { markedTerminal } from "marked-terminal";
import fs from "node:fs";
import { spawn } from "node:child_process";

const require = createRequire(import.meta.url);
const blessed = require("blessed");

// ─── Markdown renderer ──────────────────────────────────────────

marked.use(
    markedTerminal({
        reflowText: true,
        width: 60,
        showSectionPrefix: false,
        tab: 2,
    })
);

function renderMarkdown(md) {
    try {
        const unescaped = md.replace(/\\n/g, "\n");
        let rendered = marked(unescaped).replace(/\n{3,}/g, "\n\n").trimEnd();
        // Escape blessed tags in rendered markdown so they display as literal text
        rendered = rendered.replace(/\{\//g, "{\/");
        return rendered;
    } catch {
        return md;
    }
}

function ts() {
    return new Date().toLocaleTimeString("en-GB", { hour12: false });
}

// ─── Create blessed screen ───────────────────────────────────────

const screen = blessed.screen({
    smartCSR: true,
    title: "Durable Copilot Chat (Scaled — AKS Workers)",
    fullUnicode: true,
});

// ─── Layout calculations (pixel-based for alignment) ─────────────

function col1W() { return Math.floor(screen.width * 0.18); }
function col2W() { return Math.floor(screen.width * 0.40); }
function col3W() { return screen.width - col1W() - col2W(); }
function bodyH() { return screen.height - 3; } // input bar = 3

// ─── Left pane: Orchestrations ───────────────────────────────────

const orchList = blessed.list({
    parent: screen,
    label: " {bold}Sessions{/bold} ",
    tags: true,
    left: 0,
    top: 0,
    width: col1W(),
    height: bodyH(),
    border: { type: "line" },
    style: {
        border: { fg: "yellow" },
        label: { fg: "yellow" },
        selected: { bg: "blue", fg: "white", bold: true },
        item: { fg: "white" },
        focus: { border: { fg: "white" } },
    },
    scrollable: true,
    alwaysScroll: true,
    scrollbar: { style: { bg: "yellow" } },
    keys: true,
    vi: true,
    mouse: true,
    interactive: true,
});

// Show contextual help when the orch list gains focus
orchList.on("focus", () => {
    setStatus("{yellow-fg}j/k navigate · Enter switch · n new · c cancel · d delete · r refresh · p prompt{/yellow-fg}");
});
orchList.on("blur", () => {
    setStatus("Ready — type a message");
});

// ─── Center pane: Chat ───────────────────────────────────────────

const chatBox = blessed.log({
    parent: screen,
    label: " {bold}Chat{/bold} ",
    tags: true,
    left: col1W(),
    top: 0,
    width: col2W(),
    height: bodyH(),
    border: { type: "line" },
    style: {
        border: { fg: "cyan" },
        label: { fg: "cyan" },
    },
    scrollable: true,
    alwaysScroll: true,
    scrollbar: { style: { bg: "cyan" } },
    keys: true,
    vi: true,
});

// ─── Right side: per-worker log panes, created dynamically ───────

const workerPanes = new Map(); // podName → blessed.log
const workerPaneOrder = []; // ordered pod names
const paneColors = ["yellow", "magenta", "green", "blue"];
let nextColorIdx = 0;

function getOrCreateWorkerPane(podName) {
    if (workerPanes.has(podName)) return workerPanes.get(podName);

    const color = paneColors[nextColorIdx++ % paneColors.length];
    // Short name: last 5 chars of pod name
    const shortName = podName.slice(-5);

    const pane = blessed.log({
        parent: screen,
        label: ` ${shortName} `,
        tags: true,
        left: col1W() + col2W(),
        top: 0,
        width: col3W(),
        height: 10,
        border: { type: "line" },
        style: {
            border: { fg: color },
            label: { fg: color },
            focus: { border: { fg: "white" } },
        },
        scrollable: true,
        alwaysScroll: true,
        scrollbar: { style: { bg: color } },
        keys: true,
        vi: true,
        mouse: true,
    });

    workerPanes.set(podName, pane);
    workerPaneOrder.push(podName);
    relayoutAll();
    return pane;
}

function relayoutAll() {
    const h = bodyH();
    const c1 = col1W(), c2 = col2W(), c3 = col3W();

    orchList.left = 0; orchList.width = c1; orchList.height = h;
    chatBox.left = c1; chatBox.width = c2; chatBox.height = h;
    statusBar.left = c1 + 1; statusBar.width = c2 - 2;

    const panes = workerPaneOrder.map(n => workerPanes.get(n)).filter(Boolean);
    if (panes.length > 0) {
        const pH = Math.max(5, Math.floor(h / panes.length));
        for (let i = 0; i < panes.length; i++) {
            panes[i].left = c1 + c2;
            panes[i].width = c3;
            panes[i].top = i * pH;
            panes[i].height = i === panes.length - 1 ? h - i * pH : pH;
        }
    }
    screen.render();
}

// ─── Input bar ───────────────────────────────────────────────────

const inputBar = blessed.textbox({
    parent: screen,
    label: " {bold}you:{/bold} ",
    tags: true,
    bottom: 0,
    left: 0,
    width: "100%",
    height: 3,
    border: { type: "line" },
    style: {
        border: { fg: "green" },
        label: { fg: "green" },
        focus: { border: { fg: "white" } },
    },
    inputOnFocus: true,
    keys: true,
    mouse: true,
});

// ─── Status bar (bottom of chat column, above input) ─────────────

const statusBar = blessed.box({
    parent: screen,
    bottom: 2,
    left: col1W() + 1,
    width: col2W() - 2,
    height: 1,
    content: "",
    tags: true,
    style: { fg: "gray" },
});

screen.render();

// ─── Helpers ─────────────────────────────────────────────────────

let pendingUserInput = null;

function appendChat(text) {
    for (const line of text.split("\n")) {
        chatBox.log(line);
    }
    screen.render();
}

function appendChatRaw(text) {
    chatBox.log(text);
    screen.render();
}

function setStatus(text) {
    statusBar.setContent(`{gray-fg}${text}{/gray-fg}`);
    screen.render();
}

function appendLog(text) {
    chatBox.log(`{gray-fg}${text}{/gray-fg}`);
    screen.render();
}

function appendWorkerLog(podName, text) {
    const pane = getOrCreateWorkerPane(podName);
    pane.log(text);
    screen.render();
}

function showCopilotMessage(raw) {
    const rendered = renderMarkdown(raw);
    const prefix = `{gray-fg}[${ts()}]{/gray-fg} {cyan-fg}{bold}🤖 Copilot:{/bold}{/cyan-fg}`;
    appendChatRaw(prefix);
    // Always show on separate lines for readability
    for (const line of rendered.split("\n")) {
        chatBox.log(line);
    }
    appendChatRaw(""); // blank line after each message
    screen.render();
}

// ─── Start the durable client (client-only — no local runtime) ───

const store = process.env.DATABASE_URL || "sqlite::memory:";
appendLog("{bold}Mode:{/bold} {magenta-fg}Scaled (AKS Workers){/magenta-fg}");
appendLog("{bold}Store:{/bold} {green-fg}Remote PostgreSQL{/green-fg}");
appendLog("{bold}Runtime:{/bold} {yellow-fg}AKS pods (remote){/yellow-fg}");
appendLog("");

const client = new DurableCopilotClient({
    store,
    blobEnabled: true,
});

setStatus("Connecting to remote DB...");
await client.startClientOnly();
setStatus("Ready — type a message");
appendLog("Client connected ✓ {gray-fg}(no local runtime){/gray-fg}");

// ─── Orchestrations tracking ─────────────────────────────────────

const knownOrchestrationIds = new Set();
let orchStatusCache = new Map(); // id → { status, createdAt }
let orchIdOrder = []; // IDs in display order (matches orchList items)
const orchLastSeenVersion = new Map(); // id → customStatusVersion last seen by user
const orchHasChanges = new Set(); // IDs with unseen changes

function getDc() {
    try { return client._getDuroxideClient(); } catch { return null; }
}

async function refreshOrchestrations() {
    const dc = getDc();
    if (!dc) return;

    // listAllInstances returns string[] of instance IDs
    try {
        const instanceIds = await dc.listAllInstances();
        if (Array.isArray(instanceIds)) {
            for (const id of instanceIds) {
                if (typeof id === "string" && id.startsWith("session-")) {
                    knownOrchestrationIds.add(id);
                }
            }
        }
    } catch (err) {
        appendLog(`{red-fg}listAllInstances failed: ${err.message}{/red-fg}`);
    }

    // Fetch instance info + customStatusVersion in parallel
    const ids = [...knownOrchestrationIds];
    const results = await Promise.allSettled(
        ids.map(async (id) => {
            const [info, statusInfo] = await Promise.all([
                dc.getInstanceInfo(id),
                dc.getStatus(id),
            ]);
            return {
                id,
                status: info?.status || "Unknown",
                createdAt: info?.createdAt || 0,
                csvVersion: statusInfo?.customStatusVersion || 0,
            };
        })
    );

    const entries = [];
    for (const r of results) {
        if (r.status === "fulfilled") {
            const { id, status, createdAt, csvVersion } = r.value;
            orchStatusCache.set(id, { status, createdAt });

            // Detect changes: if version advanced since last time user viewed this session
            const lastSeen = orchLastSeenVersion.get(id) ?? 0;
            if (csvVersion > lastSeen && id !== activeOrchId) {
                orchHasChanges.add(id);
            }
            // For the active session, keep lastSeen up to date
            if (id === activeOrchId) {
                orchLastSeenVersion.set(id, csvVersion);
                orchHasChanges.delete(id);
            }

            entries.push({ id, status, createdAt });
        }
    }

    // Sort: Running first, then by createdAt descending
    entries.sort((a, b) => {
        const aRunning = a.status === "Running" ? 0 : 1;
        const bRunning = b.status === "Running" ? 0 : 1;
        if (aRunning !== bRunning) return aRunning - bRunning;
        return b.createdAt - a.createdAt;
    });

    // Rebuild ordered ID list to match display order
    orchIdOrder = entries.map(e => e.id);

    // Update the blessed list — clear and re-add items
    const prevSelected = orchList.selected || 0;
    orchList.clearItems();
    if (entries.length === 0) {
        orchList.addItem("{gray-fg}(none){/gray-fg}");
    } else {
        for (const { id, status, createdAt } of entries) {
            // 4-char UUID fragment + time started
            const uuid4 = id.startsWith("session-") ? id.slice(8, 12) : id.slice(0, 4);
            const timeStr = createdAt > 0
                ? new Date(createdAt).toLocaleString("en-GB", {
                    month: "short", day: "numeric",
                    hour: "2-digit", minute: "2-digit",
                    hour12: false,
                })
                : "";
            let color = "white";
            if (status === "Running") color = "green";
            else if (status === "Failed") color = "red";
            else if (status === "Completed") color = "gray";
            else if (status === "Terminated") color = "yellow";

            // Highlight sessions with unseen changes
            const hasChanges = orchHasChanges.has(id);
            const isActive = id === activeOrchId;
            const marker = isActive ? "{bold}▸{/bold}" : " ";
            const changeDot = hasChanges ? "{cyan-fg}{bold}●{/bold}{/cyan-fg} " : "";
            orchList.addItem(`${marker}${changeDot}{${color}-fg}${uuid4} ${timeStr}{/${color}-fg}`);
        }
    }
    // Restore cursor position
    orchList.select(Math.min(prevSelected, orchIdOrder.length - 1));
    screen.render();
}

// Poll orchestrations every 3 seconds
let orchPollTimer = setInterval(() => refreshOrchestrations(), 3000);

// Orchestrations panel key handlers
orchList.key(["c"], async () => {
    const dc = getDc();
    if (!dc) return;
    const idx = orchList.selected;
    if (idx >= 0 && idx < orchIdOrder.length) {
        const id = orchIdOrder[idx];
        try {
            await dc.cancelInstance(id);
            appendLog(`{yellow-fg}Cancelled ${id.slice(8, 12)}{/yellow-fg}`);
            await refreshOrchestrations();
        } catch (err) {
            appendLog(`{red-fg}Cancel failed: ${err.message}{/red-fg}`);
        }
    }
});

orchList.key(["d"], async () => {
    const dc = getDc();
    if (!dc) return;
    const idx = orchList.selected;
    if (idx >= 0 && idx < orchIdOrder.length) {
        const id = orchIdOrder[idx];
        if (typeof dc.deleteInstance === "function") {
            try {
                await dc.deleteInstance(id);
                knownOrchestrationIds.delete(id);
                orchStatusCache.delete(id);
                appendLog(`{yellow-fg}Deleted ${id.slice(8, 12)}{/yellow-fg}`);
                await refreshOrchestrations();
            } catch (err) {
                appendLog(`{red-fg}Delete failed: ${err.message}{/red-fg}`);
            }
        } else {
            appendLog("{gray-fg}deleteInstance not available{/gray-fg}");
        }
    }
});

orchList.key(["r"], async () => {
    appendLog("{gray-fg}Refreshing…{/gray-fg}");
    await refreshOrchestrations();
});

orchList.key(["enter"], () => {
    const idx = orchList.selected;
    if (idx >= 0 && idx < orchIdOrder.length) {
        switchToOrchestration(orchIdOrder[idx]);
        screen.render();
    }
});

orchList.key(["n"], async () => {
    try {
        const sess = await createNewSession();
        const orchId = `session-${sess.sessionId}`;
        knownOrchestrationIds.add(orchId);
        appendLog(`{green-fg}New session: ${sess.sessionId.slice(0, 8)}…{/green-fg}`);
        switchToOrchestration(orchId);
        await refreshOrchestrations();
        // Focus prompt so user can type immediately
        inputBar.focus();
        screen.render();
    } catch (err) {
        appendLog(`{red-fg}Create failed: ${err.message}{/red-fg}`);
    }
});

// ─── Stream AKS worker logs into per-worker panes ───────────────

let kubectlProc = null;

function startLogStream() {
    if (kubectlProc) {
        try { kubectlProc.kill(); } catch {}
        kubectlProc = null;
    }

    try {
        kubectlProc = spawn("kubectl", [
            "logs", "-f",
            "-n", "copilot-sdk",
            "-l", "app.kubernetes.io/component=worker",
            "--prefix",
            "--tail=5",
        ], { stdio: ["ignore", "pipe", "pipe"] });

        let logBuf = "";
        kubectlProc.stdout.on("data", (chunk) => {
            logBuf += chunk.toString();
            const lines = logBuf.split("\n");
            logBuf = lines.pop();
            for (const line of lines) {
                if (!line.trim()) continue;
                const prefixMatch = line.match(/^\[pod\/([^/]+)\//);
                const podName = prefixMatch ? prefixMatch[1] : "unknown";
                const content = line.replace(/^\[pod\/[^\]]+\]\s*/, "");
                const formatted = content
                    .replace(/\bWARN\b/g, "{yellow-fg}WARN{/yellow-fg}")
                    .replace(/\bERROR\b/g, "{red-fg}ERROR{/red-fg}")
                    .replace(/\bINFO\b/g, "{green-fg}INFO{/green-fg}");
                appendWorkerLog(podName, formatted);
            }
            screen.render();
        });

        kubectlProc.stderr.on("data", (chunk) => {
            const text = chunk.toString().trim();
            if (text && !text.includes("proxy error") && !text.includes("Gateway Timeout")) {
                appendLog(`{gray-fg}${text}{/gray-fg}`);
            }
        });

        kubectlProc.on("error", () => {
            appendLog("{yellow-fg}kubectl not available — logs not streamed{/yellow-fg}");
        });

        // Auto-restart on exit (e.g., pods terminated during rollout)
        kubectlProc.on("exit", (code) => {
            kubectlProc = null;
            if (code !== null) {
                setTimeout(() => { startLogStream(); }, 5000);
            }
        });
    } catch {
        appendLog("{yellow-fg}Could not start log stream{/yellow-fg}");
    }
}

startLogStream();
appendLog("{green-fg}Streaming AKS worker logs ↓{/green-fg}");

const SYSTEM_MESSAGE = "You are a helpful assistant running in a durable execution environment. Be concise. CRITICAL RULE: When you need to wait, pause, sleep, delay, or do anything periodically/recurring, you MUST use the 'wait' tool. NEVER use bash sleep, setTimeout, setInterval, detached processes, or any other timing mechanism. The 'wait' tool is the only way to wait — it enables durable timers that survive process restarts and node migrations.";

// Map sessionId → DurableSession object
const sessions = new Map();

async function createNewSession() {
    const sess = await client.createSession({
        systemMessage: SYSTEM_MESSAGE,
        onUserInputRequest: async (request) => {
            return new Promise((resolve) => {
                const q = request.question || "?";
                appendChatRaw(`{magenta-fg}🙋 ${q}{/magenta-fg}`);
                setStatus("Waiting for your answer...");
                pendingUserInput = { resolve };
                inputBar.setLabel(" {bold}answer:{/bold} ");
                screen.render();
                inputBar.focus();
            });
        },
    });
    sessions.set(sess.sessionId, sess);
    return sess;
}

const initialSession = await createNewSession();
const thisSessionId = initialSession.sessionId;
appendLog(`Session created ✓ {gray-fg}(${thisSessionId.slice(0, 8)}…){/gray-fg}`);

// ─── Active orchestration tracking ───────────────────────────────
// The chat pane shows live output from the "active" orchestration.
// Selecting a different orchestration in the left pane switches context.

let activeOrchId = `session-${thisSessionId}`;  // currently observed orchestration
let activeSessionShort = thisSessionId.slice(0, 8);
let observerAbort = null; // AbortController for the status observer loop

function updateChatLabel() {
    chatBox.setLabel(` {bold}Chat{/bold} {gray-fg}[${activeSessionShort}]{/gray-fg} `);
    screen.render();
}

/**
 * Start observing an orchestration's custom status and pipe turn results
 * into the chat pane. Runs until aborted or the orchestration completes.
 */
function startObserver(orchId) {
    // Stop any previous observer
    if (observerAbort) { observerAbort.abort(); observerAbort = null; }

    const dc = getDc();
    if (!dc) return;

    const ac = new AbortController();
    observerAbort = ac;
    let lastVersion = 0;
    let lastIteration = -1;

    // First, show the current state immediately
    (async () => {
        try {
            const currentStatus = await dc.getStatus(orchId);
            if (ac.signal.aborted) return;
            if (currentStatus?.customStatus) {
                let cs;
                try {
                    cs = typeof currentStatus.customStatus === "string"
                        ? JSON.parse(currentStatus.customStatus) : currentStatus.customStatus;
                } catch {}
                if (cs) {
                    lastVersion = currentStatus.customStatusVersion || 0;
                    if (cs.turnResult && cs.turnResult.type === "completed") {
                        lastIteration = cs.iteration || 0;
                        showCopilotMessage(cs.turnResult.content);
                    }
                    if (cs.status === "idle") {
                        setStatus("Idle — type a message");
                        turnInProgress = false;
                    } else if (cs.status === "running") {
                        setStatus("Running…");
                        turnInProgress = true;
                    } else if (cs.status === "waiting") {
                        setStatus(`Waiting (${cs.waitReason || "timer"})…`);
                    } else if (cs.status === "input_required") {
                        appendChatRaw(`{magenta-fg}🙋 ${cs.pendingQuestion || "?"}{/magenta-fg}`);
                        setStatus("Waiting for your answer...");
                    }
                }
            } else {
                // No custom status yet — orchestration hasn't started or is fresh
                setStatus("Ready — type a message");
            }
        } catch {
            // Orchestration may not exist yet (new session)
            setStatus("Ready — type a message");
        }
        while (!ac.signal.aborted) {
            try {
                const statusResult = await dc.waitForStatusChange(
                    orchId, lastVersion, 200, 30_000
                );
                if (ac.signal.aborted) break;

                if (statusResult.customStatusVersion > lastVersion) {
                    lastVersion = statusResult.customStatusVersion;
                }

                let cs = null;
                if (statusResult.customStatus) {
                    try {
                        cs = typeof statusResult.customStatus === "string"
                            ? JSON.parse(statusResult.customStatus) : statusResult.customStatus;
                    } catch {}
                }

                if (cs) {
                    // Show intermediate content
                    if (cs.intermediateContent) {
                        showCopilotMessage(cs.intermediateContent);
                    }

                    // Show turn results
                    if (cs.turnResult && cs.iteration > lastIteration) {
                        lastIteration = cs.iteration;
                        if (cs.turnResult.type === "completed") {
                            if (!cs.intermediateContent || cs.intermediateContent !== cs.turnResult.content) {
                                showCopilotMessage(cs.turnResult.content);
                            }
                            if (cs.status === "idle") {
                                setStatus("Ready — type a message");
                                turnInProgress = false;
                            } else {
                                setStatus(`Running (${cs.status})…`);
                            }
                        } else if (cs.turnResult.type === "input_required") {
                            appendChatRaw(`{magenta-fg}🙋 ${cs.turnResult.question}{/magenta-fg}`);
                            setStatus("Waiting for your answer...");
                        }
                    } else if (cs.status === "running") {
                        setStatus("Running…");
                        turnInProgress = true;
                    } else if (cs.status === "waiting") {
                        setStatus(`Waiting (${cs.waitReason || "timer"})…`);
                    }
                }
            } catch {
                // waitForStatusChange timed out — check terminal state
                if (ac.signal.aborted) break;
                try {
                    const info = await dc.getStatus(orchId);
                    if (info.status === "Completed" || info.status === "Failed" || info.status === "Terminated") {
                        if (info.status === "Failed") {
                            const reason = info.failureDetails?.errorMessage?.split("\n")[0]
                                || info.output?.split("\n")[0]
                                || "Unknown error";
                            appendChatRaw(`{red-fg}❌ Session failed: ${reason}{/red-fg}`);
                        }
                        appendLog(`{gray-fg}Orchestration ${info.status}{/gray-fg}`);
                        turnInProgress = false;
                        setStatus(`${info.status} — type a message`);
                        break;
                    }
                } catch {}
                await new Promise(r => setTimeout(r, 500));
            }
        }
    })();
}

/**
 * Switch the chat context to a different orchestration.
 */
function switchToOrchestration(orchId) {
    if (orchId === activeOrchId) return;

    activeOrchId = orchId;
    // Clear unseen-changes flag and snapshot the current version
    orchHasChanges.delete(orchId);
    // Mark as seen — will be updated to latest on next refresh
    const dc = getDc();
    if (dc) {
        dc.getStatus(orchId).then(info => {
            if (info?.customStatusVersion) {
                orchLastSeenVersion.set(orchId, info.customStatusVersion);
            }
        }).catch(() => {});
    }
    // Use 4-char UUID + time for display
    const uuid4 = orchId.startsWith("session-") ? orchId.slice(8, 12) : orchId.slice(0, 4);
    const cached = orchStatusCache.get(orchId);
    const timeStr = cached?.createdAt > 0
        ? new Date(cached.createdAt).toLocaleTimeString("en-GB", { hour12: false, hour: "2-digit", minute: "2-digit" })
        : "";
    activeSessionShort = `${uuid4}${timeStr ? " " + timeStr : ""}`;
    turnInProgress = false;

    // Clear chat and show switch indicator
    chatBox.setContent("");
    updateChatLabel();
    appendChatRaw(`{yellow-fg}── Switched to ${activeSessionShort} ──{/yellow-fg}`);
    appendChatRaw("");

    // Start observing the new orchestration
    startObserver(orchId);

    // Refresh list to update ▸ marker
    refreshOrchestrations();
}

updateChatLabel();
// Start observing the initial session
startObserver(activeOrchId);

// Helper: get the sessionId from an orchestration ID
function sessionIdFromOrchId(orchId) {
    return orchId.startsWith("session-") ? orchId.slice(8) : orchId;
}

// Helper: get or create a DurableSession for the active orchestration
function getActiveSession() {
    const sid = sessionIdFromOrchId(activeOrchId);
    return sessions.get(sid) || null;
}

// ─── Input handling ──────────────────────────────────────────────

let turnInProgress = false;

async function handleInput(text) {
    const trimmed = (text || "").trim();
    if (!trimmed) {
        inputBar.clearValue();
        inputBar.focus();
        screen.render();
        return;
    }

    if (trimmed.toLowerCase() === "exit" || trimmed.toLowerCase() === "quit") {
        await cleanup();
        process.exit(0);
    }

    if (pendingUserInput) {
        const { resolve } = pendingUserInput;
        pendingUserInput = null;
        inputBar.setLabel(" {bold}you:{/bold} ");
        appendChatRaw(`{green-fg}↳ ${trimmed}{/green-fg}`);
        // Send user-input event to the active orchestration
        const dc = getDc();
        if (dc) {
            try {
                await dc.raiseEvent(activeOrchId, "user-input", { answer: trimmed, wasFreeform: true });
            } catch {}
        }
        resolve({ answer: trimmed, wasFreeform: true });
        inputBar.clearValue();
        inputBar.focus();
        screen.render();
        return;
    }

    if (turnInProgress) {
        appendChatRaw(`{gray-fg}[${ts()}]{/gray-fg} {white-fg}{bold}You:{/bold} ${trimmed}{/white-fg}`);
        inputBar.clearValue();
        setStatus("Interrupting...");
        try {
            const dc = getDc();
            if (dc) await dc.raiseEvent(activeOrchId, "interrupt", { prompt: trimmed });
        } catch (err) {
            appendChatRaw(`{red-fg}Interrupt failed: ${err.message}{/red-fg}`);
        }
        inputBar.focus();
        screen.render();
        return;
    }

    appendChatRaw(`{gray-fg}[${ts()}]{/gray-fg} {white-fg}{bold}You:{/bold} ${trimmed}{/white-fg}`);
    inputBar.clearValue();
    turnInProgress = true;
    setStatus("Thinking... (waiting for AKS worker)");
    screen.render();

    try {
        // Use the DurableSession to send — it handles starting the orchestration
        // on first message. The observer will pick up results via waitForStatusChange.
        const sess = getActiveSession();
        if (sess) {
            // Fire-and-forget: sendAndWait starts the orchestration and returns result,
            // but the observer is what updates the chat. We just need to trigger the send.
            sess.sendAndWait(trimmed, 0).then(() => {
                // Add to known orchestrations after send
                knownOrchestrationIds.add(activeOrchId);
                refreshOrchestrations();
            }).catch(err => {
                const msg = (err.message || String(err)).split("\n")[0];
                appendChatRaw(`{red-fg}❌ ${msg}{/red-fg}`);
                turnInProgress = false;
                setStatus("Error — try again");
                screen.render();
            });
        } else {
            // No session object — send via raiseEvent (existing orchestration)
            const dc = getDc();
            if (dc) {
                await dc.raiseEvent(activeOrchId, "next-message", { prompt: trimmed });
            }
        }
    } catch (err) {
        const msg = (err.message || String(err)).split("\n")[0];
        appendChatRaw(`{red-fg}❌ ${msg}{/red-fg}`);
        setStatus("Error — try again");
        turnInProgress = false;
    }

    screen.render();
}

inputBar.on("submit", handleInput);
inputBar.key(["escape"], () => {
    inputBar.clearValue();
    // Exit prompt — focus the sessions pane for navigation
    orchList.focus();
    screen.render();
});

// ─── Cleanup ─────────────────────────────────────────────────────

async function cleanup() {
    clearInterval(orchPollTimer);
    if (observerAbort) { observerAbort.abort(); observerAbort = null; }
    if (kubectlProc) { try { kubectlProc.kill(); } catch {} }
    setStatus("Disconnecting...");
    await client.stop();
}

screen.key(["C-c"], async () => {
    await cleanup();
    process.exit(0);
});

// ─── Pane navigation ─────────────────────────────────────────────
// Esc: exit prompt, enter navigation mode (sessions pane focused)
// p:   from anywhere, jump back into the prompt
// Tab: cycle through panes
// h/l: left/right between sessions, chat, worker panes (when not in prompt)

screen.on("keypress", (ch, key) => {
    if (!key) return;

    // Esc from any pane (except input, handled above) → sessions pane
    if (key.name === "escape" && screen.focused !== inputBar) {
        orchList.focus();
        screen.render();
        return;
    }

    // p from any non-input pane → jump to prompt
    if (ch === "p" && screen.focused !== inputBar) {
        inputBar.focus();
        setStatus("Ready — type a message");
        screen.render();
        return;
    }

    // h/l navigation only when NOT in the input bar
    if (screen.focused !== inputBar) {
        const panes = workerPaneOrder.map(n => workerPanes.get(n)).filter(Boolean);

        if (key.name === "h" || ch === "h") {
            // Left
            if ([...workerPanes.values()].includes(screen.focused)) {
                chatBox.focus();
            } else if (screen.focused === chatBox) {
                orchList.focus();
            }
            screen.render();
            return;
        }
        if (key.name === "l" || ch === "l") {
            // Right
            if (screen.focused === orchList) {
                chatBox.focus();
            } else if (screen.focused === chatBox && panes.length > 0) {
                panes[0].focus();
            }
            screen.render();
            return;
        }
    }
});

// Tab: cycle sessions → chat → worker panes → sessions
screen.key(["tab"], () => {
    const panes = workerPaneOrder.map(n => workerPanes.get(n)).filter(Boolean);
    const allFocusable = [orchList, chatBox, ...panes];
    if (screen.focused === inputBar) {
        // From input, Tab goes to sessions
        orchList.focus();
    } else {
        const currentIdx = allFocusable.indexOf(screen.focused);
        const nextIdx = (currentIdx + 1) % allFocusable.length;
        allFocusable[nextIdx].focus();
    }
    screen.render();
});

screen.on("resize", () => relayoutAll());

// ─── Welcome message ─────────────────────────────────────────────

appendChatRaw(
    "{cyan-fg}{bold}Copilot:{/bold}{/cyan-fg} " +
    "Welcome to Durable Copilot Chat!"
);
appendChatRaw("");
appendChatRaw("{bold}Controls:{/bold}");
appendChatRaw("  {yellow-fg}Esc{/yellow-fg}    exit prompt → navigate TUI");
appendChatRaw("  {yellow-fg}p{/yellow-fg}      back to prompt from anywhere");
appendChatRaw("  {yellow-fg}Tab{/yellow-fg}    cycle panes");
appendChatRaw("  {yellow-fg}h/l{/yellow-fg}    move left/right between panes");
appendChatRaw("");
appendChatRaw("{bold}Sessions (left pane):{/bold}");
appendChatRaw("  {yellow-fg}j/k{/yellow-fg}    navigate list");
appendChatRaw("  {yellow-fg}Enter{/yellow-fg}  switch to session");
appendChatRaw("  {yellow-fg}n{/yellow-fg}      new session");
appendChatRaw("  {yellow-fg}c{/yellow-fg}      cancel · {yellow-fg}d{/yellow-fg} delete · {yellow-fg}r{/yellow-fg} refresh");
appendChatRaw("");

// Initial orchestration refresh
await refreshOrchestrations();

orchList.focus();
screen.render();
