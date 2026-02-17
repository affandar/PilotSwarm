#!/usr/bin/env node

/**
 * TUI chat client — Mode 2: Client-Only + AKS Workers.
 *
 * This TUI runs only a duroxide Client (no Runtime). It enqueues
 * orchestrations into PostgreSQL and polls for results. Actual execution
 * happens on AKS worker pods running examples/worker.js.
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
        width: 72,
        showSectionPrefix: false,
    })
);

function renderMarkdown(md) {
    try {
        // Unescape literal \n that may come from JSON-serialized responses
        const unescaped = md.replace(/\\n/g, "\n");
        return marked(unescaped).replace(/\n{3,}/g, "\n\n").trimEnd();
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

// Left pane: chat
const chatBox = blessed.log({
    parent: screen,
    label: " {bold}💬 Chat{/bold} ",
    tags: true,
    left: 0,
    top: 0,
    width: "65%",
    height: "100%-3",
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

// Right pane: info
const logBox = blessed.log({
    parent: screen,
    label: " {bold}📋 Status{/bold} ",
    tags: true,
    left: "65%",
    top: 0,
    width: "35%",
    height: "100%-3",
    border: { type: "line" },
    style: {
        border: { fg: "yellow" },
        label: { fg: "yellow" },
    },
    scrollable: true,
    alwaysScroll: true,
    scrollbar: { style: { bg: "yellow" } },
    keys: true,
    vi: true,
});

// Input bar
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

// Status line
const statusBar = blessed.box({
    parent: screen,
    bottom: 2,
    left: 1,
    width: "65%-2",
    height: 1,
    content: "",
    tags: true,
    style: { fg: "gray" },
});

screen.render();

// ─── Helpers ─────────────────────────────────────────────────────

let pendingUserInput = null;

function appendChat(text) {
    // blessed.log() treats each call as one line — split on newlines
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
    logBox.log(text);
    screen.render();
}

function showCopilotMessage(raw) {
    const rendered = renderMarkdown(raw);
    const prefix = `{gray-fg}[${ts()}]{/gray-fg} {cyan-fg}{bold}🤖 Copilot:{/bold}{/cyan-fg}`;
    if (rendered.includes("\n")) {
        appendChatRaw(prefix);
        appendChat(rendered);
    } else {
        appendChatRaw(`${prefix} ${rendered}`);
    }
}

// ─── Start the durable client (client-only — no local runtime) ───

const store = process.env.DATABASE_URL || "sqlite::memory:";
appendLog("{bold}Mode:{/bold} {magenta-fg}Scaled (AKS Workers){/magenta-fg}");
appendLog("{bold}Store:{/bold} {green-fg}Remote PostgreSQL{/green-fg}");
appendLog("{bold}Runtime:{/bold} {yellow-fg}AKS pods (remote){/yellow-fg}");
appendLog("");

const client = new DurableCopilotClient({
    store,
    // No githubToken needed — workers have it
});

setStatus("Connecting to remote DB...");
await client.startClientOnly();
setStatus("Ready — type a message");
appendLog("Client connected ✓ {gray-fg}(no local runtime){/gray-fg}");

// ─── Stream AKS worker logs into the right pane ─────────────────
// Spawns `kubectl logs -f` to tail all worker pods in real time.
let kubectlProc = null;
try {
    kubectlProc = spawn("kubectl", [
        "logs", "-f",
        "-n", "copilot-sdk",
        "-l", "app.kubernetes.io/component=worker",
        "--prefix",
        "--tail=20",
    ], { stdio: ["ignore", "pipe", "pipe"] });

    let logBuf = "";
    kubectlProc.stdout.on("data", (chunk) => {
        logBuf += chunk.toString();
        const lines = logBuf.split("\n");
        logBuf = lines.pop(); // keep incomplete line
        for (const line of lines) {
            // Only show logs for this TUI's session
            if (!line.trim() || !line.includes(thisSessionId)) continue;
            const formatted = line
                .replace(/\bWARN\b/g, "{yellow-fg}WARN{/yellow-fg}")
                .replace(/\bERROR\b/g, "{red-fg}ERROR{/red-fg}")
                .replace(/\bINFO\b/g, "{green-fg}INFO{/green-fg}");
            logBox.log(formatted);
        }
        screen.render();
    });

    kubectlProc.stderr.on("data", (chunk) => {
        const text = chunk.toString().trim();
        if (text) appendLog(`{gray-fg}${text}{/gray-fg}`);
    });

    kubectlProc.on("error", () => {
        appendLog("{yellow-fg}kubectl not available — logs not streamed{/yellow-fg}");
    });

    appendLog("{green-fg}Streaming AKS worker logs ↓{/green-fg}");
    appendLog("");
} catch {
    appendLog("{yellow-fg}Could not start log stream{/yellow-fg}");
}

const session = await client.createSession({
    systemMessage: "You are a helpful assistant. Be concise.",
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

const thisSessionId = session.sessionId;
appendLog(`Session created ✓ {gray-fg}(${thisSessionId.slice(0, 8)}…){/gray-fg}`);

// ─── Input handling ──────────────────────────────────────────────

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
        resolve({ answer: trimmed, wasFreeform: true });
        inputBar.clearValue();
        inputBar.focus();
        screen.render();
        return;
    }

    appendChatRaw(`{gray-fg}[${ts()}]{/gray-fg} {white-fg}{bold}You:{/bold} ${trimmed}{/white-fg}`);
    inputBar.clearValue();
    setStatus("Thinking... (waiting for AKS worker)");
    appendLog(`→ Enqueued turn: "${trimmed.slice(0, 40)}…"`);
    screen.render();

    try {
        // Fire-and-forget: enqueue the orchestration, then poll
        await session.send(trimmed);
        const orchId = session.lastOrchestrationId;
        const dc = client._getDuroxideClient();
        let lastSeenExecution = 0;

        // Poll until terminal state — no timeout, TUI exit cancels
        while (true) {
            await new Promise((r) => setTimeout(r, 500));
            const status = await dc.getStatus(orchId);

            if (status.status === "Completed") {
                const raw = status.output || "(no response)";
                showCopilotMessage(raw);
                appendLog(`← Response received`);
                setStatus("Ready — type a message");
                break;
            } else if (status.status === "Failed") {
                throw new Error(status.error ?? "Orchestration failed");
            }

            // Check for intermediate content from wait cycles.
            // Only read the LATEST execution each poll — once we see its
            // ActivityCompleted, advance the marker so we don't re-show it.
            try {
                const execs = await dc.listExecutions(orchId);
                if (execs.length > lastSeenExecution) {
                    const execId = execs[execs.length - 1];
                    const history = await dc.readExecutionHistory(orchId, execId);
                    for (const event of history) {
                        if (event.kind === "ActivityCompleted" && event.data) {
                            try {
                                const data = JSON.parse(event.data);
                                const result = typeof data.result === "string"
                                    ? JSON.parse(data.result) : data;
                                if (result.type === "wait" && result.content) {
                                    showCopilotMessage(result.content);
                                    setStatus(`⏳ Waiting ${result.seconds}s (${result.reason})`);
                                }
                            } catch {}
                            // Mark this execution as seen regardless of content
                            lastSeenExecution = execs.length;
                        }
                    }
                }
            } catch (pollErr) {
                appendLog(`{red-fg}Poll error: ${pollErr.message}{/red-fg}`);
            }
        }
    } catch (err) {
        appendChatRaw(`{red-fg}❌ ${err.message}{/red-fg}`);
        appendLog(`{red-fg}Error: ${err.message}{/red-fg}`);
        setStatus("Error — try again");
    }

    inputBar.focus();
    screen.render();
}

inputBar.on("submit", handleInput);
inputBar.key(["escape"], () => {
    inputBar.clearValue();
    screen.render();
});

// ─── Cleanup ─────────────────────────────────────────────────────

async function cleanup() {
    if (kubectlProc) { try { kubectlProc.kill(); } catch {} }
    // Cancel any in-flight orchestration
    if (session.lastOrchestrationId) {
        try {
            const dc = client._getDuroxideClient();
            await dc.cancelInstance(session.lastOrchestrationId);
            appendLog("Cancelled active orchestration");
        } catch {}
    }
    setStatus("Disconnecting...");
    await client.stop();
}

screen.key(["C-c"], async () => {
    await cleanup();
    process.exit(0);
});
screen.key(["tab"], () => {
    if (screen.focused === chatBox) logBox.focus();
    else if (screen.focused === logBox) inputBar.focus();
    else chatBox.focus();
    screen.render();
});

appendChatRaw(
    "{cyan-fg}{bold}🤖 Copilot:{/bold}{/cyan-fg} " +
    "Welcome to Durable Copilot Chat!"
);
appendChatRaw(
    "{gray-fg}Mode: Scaled — your messages are processed by AKS workers{/gray-fg}"
);
appendChatRaw(
    "{gray-fg}Ctrl+C to quit · Tab to switch panes · Scroll with mouse/arrows{/gray-fg}"
);
appendChatRaw("");

inputBar.focus();
screen.render();
