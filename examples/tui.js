#!/usr/bin/env node

/**
 * TUI chat client for durable-copilot-sdk.
 *
 * Two-pane layout:
 *   Left  — chat with markdown rendering (syntax highlighting, bullets, etc.)
 *   Right — live duroxide runtime logs
 *
 * Usage: node --env-file=.env examples/tui.js
 */

import { DurableCopilotClient } from "../dist/index.js";
import { createRequire } from "node:module";
import { marked } from "marked";
import { markedTerminal } from "marked-terminal";
import fs from "node:fs";

const require = createRequire(import.meta.url);
const blessed = require("blessed");
const { initTracing } = require("duroxide");

// ─── Redirect Rust tracing to a log file ─────────────────────────
// Call initTracing() BEFORE runtime.start() — first-writer-wins via try_init().
const tracingLogPath = `/tmp/duroxide-tui-${process.pid}.log`;
fs.writeFileSync(tracingLogPath, "");
initTracing({ logFile: tracingLogPath, logLevel: "info", logFormat: "compact" });

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

// ─── Create blessed screen ───────────────────────────────────────

const screen = blessed.screen({
    smartCSR: true,
    title: "Durable Copilot Chat",
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
    scrollbar: {
        style: { bg: "cyan" },
    },
    mouse: true,
    keys: true,
    vi: true,
});

// Right pane: logs
const logBox = blessed.log({
    parent: screen,
    label: " {bold}📋 Runtime Logs{/bold} ",
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
    scrollbar: {
        style: { bg: "yellow" },
    },
    mouse: true,
    keys: true,
    vi: true,
});

// Input bar at bottom
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

// Status line (overlays bottom of chat area)
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
    // Color log levels for blessed tags
    const formatted = text
        .replace(/\x1b\[(\d+;)*\d*m/g, "")  // strip ANSI
        .replace(/\bWARN\b/g, "{yellow-fg}WARN{/yellow-fg}")
        .replace(/\bERROR\b/g, "{red-fg}ERROR{/red-fg}")
        .replace(/\bINFO\b/g, "{green-fg}INFO{/green-fg}")
        .replace(/\bDEBUG\b/g, "{gray-fg}DEBUG{/gray-fg}")
        .replace(/\bTRACE\b/g, "{gray-fg}TRACE{/gray-fg}");
    logBox.log(formatted);
    screen.render();
}

// ─── JS-side log capture ─────────────────────────────────────────

// Intercept Node-level stderr (catches eprintln! from Rust, e.g. "logging already initialized")
const _origStderrWrite = process.stderr.write.bind(process.stderr);
process.stderr.write = (chunk, encoding, callback) => {
    const text = typeof chunk === "string" ? chunk : chunk.toString();
    for (const line of text.split("\n")) {
        if (line.trim()) appendLog(line);
    }
    if (typeof callback === "function") callback();
    return true;
};

// Intercept console.error / console.log so JS-side messages show in log pane
console.error = (...args) => appendLog(args.join(" "));
console.log = (...args) => appendLog(args.join(" "));

// Tail the tracing log file periodically (captures Rust tracing output)
let lastLogPos = 0;
const logTailer = setInterval(() => {
    try {
        const stat = fs.statSync(tracingLogPath);
        if (stat.size > lastLogPos) {
            const buf = Buffer.alloc(stat.size - lastLogPos);
            const fd = fs.openSync(tracingLogPath, "r");
            fs.readSync(fd, buf, 0, buf.length, lastLogPos);
            fs.closeSync(fd);
            lastLogPos = stat.size;
            const text = buf.toString("utf8");
            for (const line of text.split("\n")) {
                if (line.trim()) appendLog(line);
            }
        }
    } catch {
        // ignore read errors
    }
}, 250);

// ─── Start the durable client ────────────────────────────────────

const store = process.env.DATABASE_URL || "sqlite::memory:";
appendLog(`Store: ${store.startsWith("postgres") ? "PostgreSQL" : store}`);

const client = new DurableCopilotClient({
    store,
    githubToken: process.env.GITHUB_TOKEN,
    logLevel: "info",
});

setStatus("Starting runtime...");
await client.start();
setStatus("Ready — type a message");
appendLog("Runtime started ✓");

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

appendLog("Session created ✓");

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
        cleanup();
        process.exit(0);
    }

    // If there's a pending user input question, resolve it
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

    // Regular chat message
    appendChatRaw(`{white-fg}{bold}You:{/bold} ${trimmed}{/white-fg}`);
    inputBar.clearValue();
    setStatus("Thinking...");
    screen.render();

    try {
        const response = await session.sendAndWait(trimmed, 120_000);
        const raw = response || "(no response)";
        appendChatRaw("{cyan-fg}{bold}🤖 Copilot:{/bold}{/cyan-fg}");
        // Render markdown and display line-by-line
        const rendered = renderMarkdown(raw);
        appendChat(rendered);
        setStatus("Ready — type a message");
    } catch (err) {
        appendChatRaw(`{red-fg}❌ ${err.message}{/red-fg}`);
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
    clearInterval(logTailer);
    try { fs.unlinkSync(tracingLogPath); } catch {}
    setStatus("Shutting down...");
    await client.stop();
}

// Global keys
screen.key(["C-c"], async () => {
    await cleanup();
    process.exit(0);
});
screen.key(["tab"], () => {
    if (screen.focused === chatBox) {
        logBox.focus();
    } else if (screen.focused === logBox) {
        inputBar.focus();
    } else {
        chatBox.focus();
    }
    screen.render();
});

// Welcome message
appendChatRaw(
    "{cyan-fg}{bold}🤖 Copilot:{/bold}{/cyan-fg} " +
    "Welcome to Durable Copilot Chat!"
);
appendChatRaw(
    "{gray-fg}Ctrl+C to quit · Tab to switch panes · Scroll with mouse/arrows{/gray-fg}"
);
appendChatRaw("");

inputBar.focus();
screen.render();
