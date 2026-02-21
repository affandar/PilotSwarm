#!/usr/bin/env node

/**
 * Unified TUI chat client for durable-copilot-sdk.
 *
 * Modes (set via CLI arg or MODE env var):
 *   local   — Local runtime + local/remote DB (default)
 *   scaled  — Client-only, AKS workers execute turns
 *
 * Usage:
 *   node --env-file=.env examples/tui.js              # local mode
 *   node --env-file=.env.remote examples/tui.js        # local runtime, remote DB
 *   node --env-file=.env.remote examples/tui.js scaled  # client-only, AKS workers
 */

import { DurableCopilotClient } from "../dist/index.js";
import { createRequire } from "node:module";
import { marked } from "marked";
import { markedTerminal } from "marked-terminal";
import fs from "node:fs";
import { spawn } from "node:child_process";

const require = createRequire(import.meta.url);
const blessed = require("blessed");

const MODE = (() => {
    const idx = process.argv.indexOf("--mode");
    if (idx !== -1 && process.argv[idx + 1]) return process.argv[idx + 1];
    return process.env.MODE || "local";
})();
const isScaled = MODE === "scaled" || MODE === "remote";

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
        const unescaped = md.replace(/\\n/g, "\n");
        return marked(unescaped).replace(/\n{3,}/g, "\n\n").trimEnd();
    } catch {
        return md;
    }
}

function ts() {
    return new Date().toLocaleTimeString("en-GB", { hour12: false });
}

// ─── Tracing (local mode only) ───────────────────────────────────

let tracingLogPath = null;
if (!isScaled) {
    const { initTracing } = require("duroxide");
    tracingLogPath = `/tmp/duroxide-tui-${process.pid}.log`;
    fs.writeFileSync(tracingLogPath, "");
    initTracing({ logFile: tracingLogPath, logLevel: "info", logFormat: "compact" });
}

// ─── Create blessed screen ───────────────────────────────────────

const modeLabel = MODE === "scaled" ? "Scaled — AKS Workers"
    : MODE === "remote" ? "Remote Runtime"
    : "Local Runtime";

const screen = blessed.screen({
    smartCSR: true,
    title: `Durable Copilot Chat (${modeLabel})`,
    fullUnicode: true,
});

const chatBox = blessed.log({
    parent: screen,
    label: " {bold}💬 Chat{/bold} ",
    tags: true,
    left: 0,
    top: 0,
    width: "65%",
    height: "100%-3",
    border: { type: "line" },
    style: { border: { fg: "cyan" }, label: { fg: "cyan" } },
    scrollable: true,
    alwaysScroll: true,
    scrollbar: { style: { bg: "cyan" } },
    mouse: true,
    keys: true,
    vi: true,
});

const logLabel = isScaled ? "📋 Status" : "📋 Runtime Logs";
const logBox = blessed.log({
    parent: screen,
    label: ` {bold}${logLabel}{/bold} `,
    tags: true,
    left: "65%",
    top: 0,
    width: "35%",
    height: "100%-3",
    border: { type: "line" },
    style: { border: { fg: "yellow" }, label: { fg: "yellow" } },
    scrollable: true,
    alwaysScroll: true,
    scrollbar: { style: { bg: "yellow" } },
    mouse: true,
    keys: true,
    vi: true,
});

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
    const formatted = text
        .replace(/\x1b\[(\d+;)*\d*m/g, "")
        .replace(/\bWARN\b/g, "{yellow-fg}WARN{/yellow-fg}")
        .replace(/\bERROR\b/g, "{red-fg}ERROR{/red-fg}")
        .replace(/\bINFO\b/g, "{green-fg}INFO{/green-fg}")
        .replace(/\bDEBUG\b/g, "{gray-fg}DEBUG{/gray-fg}")
        .replace(/\bTRACE\b/g, "{gray-fg}TRACE{/gray-fg}");
    logBox.log(formatted);
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

// ─── Log streaming (mode-specific) ──────────────────────────────

let logTailer = null;
let kubectlProc = null;

if (!isScaled && tracingLogPath) {
    // Local mode: redirect stdout/stderr to the log pane so they don't
    // corrupt the blessed UI, and tail the duroxide tracing log file.
    // Override console.log/error only — leave process.stderr.write alone
    // so blessed's own drawing is not intercepted.
    console.error = (...args) => appendLog(args.join(" "));
    console.log = (...args) => appendLog(args.join(" "));

    let lastLogPos = 0;
    logTailer = setInterval(() => {
        try {
            const stat = fs.statSync(tracingLogPath);
            if (stat.size > lastLogPos) {
                const buf = Buffer.alloc(stat.size - lastLogPos);
                const fd = fs.openSync(tracingLogPath, "r");
                fs.readSync(fd, buf, 0, buf.length, lastLogPos);
                fs.closeSync(fd);
                lastLogPos = stat.size;
                for (const line of buf.toString("utf8").split("\n")) {
                    if (line.trim()) appendLog(line);
                }
            }
        } catch {}
    }, 200);
}

// ─── Start client ────────────────────────────────────────────────

const store = process.env.DATABASE_URL || "sqlite::memory:";

const client = new DurableCopilotClient({
    store,
    githubToken: isScaled ? undefined : process.env.GITHUB_TOKEN,
    logLevel: "info",
    blobConnectionString: process.env.AZURE_STORAGE_CONNECTION_STRING,
    blobContainer: process.env.AZURE_STORAGE_CONTAINER || "copilot-sessions",
});

if (isScaled) {
    appendLog("{bold}Mode:{/bold} {magenta-fg}Scaled (AKS Workers){/magenta-fg}");
    appendLog("{bold}Store:{/bold} {green-fg}Remote PostgreSQL{/green-fg}");
    appendLog("{bold}Runtime:{/bold} {yellow-fg}AKS pods (remote){/yellow-fg}");
    appendLog("");
    setStatus("Connecting to remote DB...");
    await client.startClientOnly();
    appendLog("Client connected ✓ {gray-fg}(no local runtime){/gray-fg}");

    // Stream AKS worker logs (auto-reconnect on pod rollout)
    function startLogStream() {
        if (kubectlProc) { try { kubectlProc.kill(); } catch {} kubectlProc = null; }
        try {
            kubectlProc = spawn("kubectl", [
                "logs", "-f", "-n", "copilot-sdk",
                "-l", "app.kubernetes.io/component=worker",
                "--prefix", "--tail=20",
                "--max-log-requests=10",
            ], { stdio: ["ignore", "pipe", "pipe"] });

            let logBuf = "";
            kubectlProc.stdout.on("data", (chunk) => {
                logBuf += chunk.toString();
                const lines = logBuf.split("\n");
                logBuf = lines.pop();
                for (const line of lines) {
                    if (line.trim()) appendLog(line);
                }
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
    appendLog("");
} else {
    appendLog("{bold}Mode:{/bold} {green-fg}Local Runtime{/green-fg}");
    appendLog(`{bold}Store:{/bold} ${store.startsWith("postgres") ? "PostgreSQL" : store}`);
    appendLog("");
    setStatus("Starting runtime...");
    await client.start();
    appendLog("Runtime started ✓");
}

setStatus("Ready — type a message");

// ─── Create session ──────────────────────────────────────────────

const session = await client.createSession({
    systemMessage: "You are a helpful assistant running in a durable execution environment. Be concise. CRITICAL RULE: When you need to wait, pause, sleep, delay, or do anything periodically/recurring, you MUST use the 'wait' tool. NEVER use bash sleep, setTimeout, setInterval, detached processes, or any other timing mechanism. The 'wait' tool is the only way to wait — it enables durable timers that survive process restarts and node migrations.",
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

const sessionId = session.sessionId;
appendLog(`Session created ✓ {gray-fg}(${sessionId.slice(0, 8)}…){/gray-fg}`);

// ─── Send message (mode-specific) ────────────────────────────────

let turnInProgress = false;

async function sendMessage(trimmed) {
    if (turnInProgress) {
        // Interrupt: enqueue message to cancel the running turn and start this one
        setStatus("⚡ Interrupting current turn...");
        if (isScaled) appendLog(`⚡ Interrupt: "${trimmed.slice(0, 40)}…"`);
        try {
            await session.sendEvent("messages", { prompt: trimmed });
        } catch (err) {
            appendLog(`{red-fg}Interrupt failed: ${err.message}{/red-fg}`);
        }
        return;
    }

    turnInProgress = true;

    if (isScaled) {
        setStatus("Thinking... (waiting for AKS worker)");
        appendLog(`→ Enqueued turn: "${trimmed.slice(0, 40)}…"`);
    } else {
        setStatus("Thinking...");
    }

    try {
        let firstResult = true;
        const response = await session.sendAndWait(trimmed, 0, (intermediate) => {
            if (firstResult) {
                showCopilotMessage(intermediate);
                firstResult = false;
                setStatus("Running (type to interrupt)");
            } else {
                showCopilotMessage(`🔄 ${intermediate}`);
            }
        });
        // Only show response if the intermediate callback never fired
        // (avoids duplicate display — sendAndWait returns the same content
        // it already passed to onIntermediateContent).
        if (response && firstResult) showCopilotMessage(response);
        if (isScaled) appendLog("← Response received");
    } catch (err) {
        appendChatRaw(`{red-fg}Error: ${err.message}{/red-fg}`);
    }

    turnInProgress = false;
    setStatus("Ready — type a message");
}

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
    screen.render();

    try {
        await sendMessage(trimmed);
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
    if (logTailer) clearInterval(logTailer);
    if (tracingLogPath) { try { fs.unlinkSync(tracingLogPath); } catch {} }
    if (kubectlProc) { try { kubectlProc.kill(); } catch {} }
    if (isScaled && session.lastOrchestrationId) {
        try {
            const dc = client._getDuroxideClient();
            await dc.cancelInstance(session.lastOrchestrationId);
            appendLog("Cancelled active orchestration");
        } catch {}
    }
    setStatus("Shutting down...");
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

// ─── Welcome ─────────────────────────────────────────────────────

appendChatRaw(
    "{cyan-fg}{bold}🤖 Copilot:{/bold}{/cyan-fg} " +
    "Welcome to Durable Copilot Chat!"
);
appendChatRaw(
    `{gray-fg}Mode: ${modeLabel} · Ctrl+C to quit · Tab to switch panes{/gray-fg}`
);
appendChatRaw("");

inputBar.focus();
screen.render();
