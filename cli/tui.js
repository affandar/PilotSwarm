#!/usr/bin/env node

/**
 * TUI chat client — Scaled mode with embedded or remote workers.
 *
 * Two-column layout:
 *   Left column: Sessions panel (top, ~25% height) + Chat pane (bottom)
 *   Right column: Per-worker or per-orchestration log panes (full height)
 *   Bottom: Input bar
 *
 * Usage:
 *   npx pilotswarm-tui --env .env.remote             # 4 embedded workers
 *   npx pilotswarm-tui remote --env .env.remote       # client-only (AKS)
 */

import { PilotSwarmClient, PilotSwarmWorker, PilotSwarmManagementClient } from "../dist/index.js";
import { createRequire } from "node:module";
import { marked } from "marked";
import { markedTerminal } from "marked-terminal";
import chalk from "chalk";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import os from "node:os";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ─── Artifact exports directory ──────────────────────────────────
const EXPORTS_DIR = path.join(os.homedir(), "pilotswarm-exports");
fs.mkdirSync(EXPORTS_DIR, { recursive: true });
// ─── Global error handlers ──────────────────────────────────────
// Prevent the TUI from crashing on transient network errors
// (e.g. EADDRNOTAVAIL from stale PostgreSQL connections).
process.on('uncaughtException', (err) => {
    // Write to perf trace if available, otherwise stderr
    const msg = `[uncaughtException] ${err.message}`;
    try { _perfStream?.write(JSON.stringify({ ts: Date.now(), op: 'uncaughtException', err: err.message }) + '\n'); } catch {}
    process.stderr.write(msg + '\n');
});
process.on('unhandledRejection', (reason) => {
    const msg = reason instanceof Error ? reason.message : String(reason);
    try { _perfStream?.write(JSON.stringify({ ts: Date.now(), op: 'unhandledRejection', err: msg }) + '\n'); } catch {}
});

// ─── Performance tracing (temporary) ────────────────────────────
// Writes to dumps/perf-trace.jsonl as newline-delimited JSON.
// Each entry: { ts, op, dur?, meta? }
const _perfTracePath = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "dumps", "perf-trace.jsonl");
fs.mkdirSync(path.dirname(_perfTracePath), { recursive: true });
const _perfStream = fs.createWriteStream(_perfTracePath, { flags: "a" });
_perfStream.write(`\n--- TUI start ${new Date().toISOString()} ---\n`);

let _perfRenderCount = 0;
let _perfRenderTotalMs = 0;

function perfTrace(op, meta) {
    const entry = { ts: Date.now(), op, ...(meta || {}) };
    _perfStream.write(JSON.stringify(entry) + "\n");
}

function perfStart(op) {
    return { op, t0: performance.now() };
}

function perfEnd(handle, meta) {
    const dur = +(performance.now() - handle.t0).toFixed(2);
    const entry = { ts: Date.now(), op: handle.op, dur, ...(meta || {}) };
    _perfStream.write(JSON.stringify(entry) + "\n");
    return dur;
}

// Track screen.render() calls — this is often the hidden cost
const _origScreenRender = null; // patched after screen is created below

const require = createRequire(import.meta.url);

// Suppress stderr during neo-blessed load — it dumps xterm-256color
// terminfo compilation errors (SetUlc) that are harmless but ugly.
const _origStderr = process.stderr.write.bind(process.stderr);
process.stderr.write = () => true;
const blessed = require("neo-blessed");
process.stderr.write = _origStderr;

// ─── Monkey-patch neo-blessed emoji width ────────────────────────
// neo-blessed's unicode.charWidth() doesn't know emoji are 2 cells wide.
// Its East Asian Width tables only cover CJK — emoji codepoints (U+1F300+)
// return 1 instead of 2, which misaligns every character after an emoji.
// Patch charWidth to add the missing ranges.
{
    const unicode = require("neo-blessed/lib/unicode");
    const origCharWidth = unicode.charWidth;
    unicode.charWidth = function (str, i) {
        const point = typeof str !== "number"
            ? unicode.codePointAt(str, i || 0)
            : str;
        // Emoji blocks that render as 2 cells in modern terminals
        if (
            (point >= 0x1F100 && point <= 0x1F1FF) || // Enclosed Alphanumeric Supplement (🆕 etc.)
            (point >= 0x1F200 && point <= 0x1F2FF) || // Enclosed Ideographic Supplement
            (point >= 0x1F300 && point <= 0x1F9FF) || // Misc Symbols, Emoticons, Transport, etc.
            (point >= 0x1FA00 && point <= 0x1FAFF) || // Symbols & Pictographs Extended-A
            (point >= 0x2600 && point <= 0x27BF)   || // Misc Symbols + Dingbats (☀⚡✅ etc.)
            (point >= 0x2300 && point <= 0x23FF)   || // Misc Technical (⌚ etc.)
            (point >= 0x2B05 && point <= 0x2B55)   || // Arrows, stars, circles
            point === 0x2705 || point === 0x2714   || // Check marks
            point === 0x274C || point === 0x274E       // Cross marks
        ) {
            return 2;
        }
        return origCharWidth(str, i);
    };
}

// ─── Markdown renderer ──────────────────────────────────────────

// Bright theme for cli-highlight — standard ANSI blue/grey/red are invisible on dark backgrounds
const cliHighlightTheme = {
    keyword: chalk.blueBright,
    built_in: chalk.cyanBright,
    type: chalk.cyan,
    literal: chalk.blueBright,
    number: chalk.greenBright,
    regexp: chalk.redBright,
    string: chalk.redBright,
    class: chalk.blueBright,
    function: chalk.yellowBright,
    comment: chalk.green,
    doctag: chalk.green,
    meta: chalk.white,
    tag: chalk.white,
    name: chalk.blueBright,
    attr: chalk.cyanBright,
    attribute: chalk.cyanBright,
    symbol: chalk.yellowBright,
    params: chalk.white,
};

// Configure marked once; we override width dynamically in renderMarkdown()
marked.use(
    markedTerminal({
        reflowText: true,
        width: 120,
        showSectionPrefix: false,
        tab: 2,
        // Override dim defaults that are invisible on dark backgrounds
        blockquote: chalk.whiteBright.italic,
        html: chalk.white,
        codespan: chalk.yellowBright,
    }, { theme: cliHighlightTheme })
);

function renderMarkdown(md) {
    const _ph = perfStart("renderMarkdown");
    try {
        // Dynamically set width to match chat pane (minus borders/padding)
        const mdWidth = Math.max(40, leftW() - 4);
        marked.use(markedTerminal({ reflowText: true, width: mdWidth, showSectionPrefix: false, tab: 2, blockquote: chalk.whiteBright.italic, html: chalk.white, codespan: chalk.yellowBright }, { theme: cliHighlightTheme }));
        const unescaped = md.replace(/\\n/g, "\n");
        let rendered = marked(unescaped).replace(/\n{3,}/g, "\n\n").trimEnd();
        // marked-terminal uses ANSI codes for styling, not blessed tags.
        // Strip curly braces so blessed doesn't misinterpret them as tags.
        rendered = rendered.replace(/\{/g, "(").replace(/\}/g, ")");
        // Strip OSC 8 hyperlink sequences — blessed can't render them.
        // Format: \x1b]8;;URL\x07LABEL\x1b]8;;\x07  (or \x1b\\ as terminator)
        // Replace with: 🔗URL so the link is visible and clickable via the chatBox handler.
        rendered = rendered.replace(/\x1b\]8;;([^\x07\x1b]*)\x07([^\x1b]*)\x1b\]8;;\x07/g, (_m, url, _label) => `🔗{underline}{cyan-fg}${url}{/cyan-fg}{/underline}`);
        rendered = rendered.replace(/\x1b\]8;;([^\x1b]*)\x1b\\([^\x1b]*)\x1b\]8;;\x1b\\/g, (_m, url, _label) => `🔗{underline}{cyan-fg}${url}{/cyan-fg}{/underline}`);
        // Catch any remaining OSC 8 fragments
        rendered = rendered.replace(/\x1b\]8;;[^\x07]*\x07/g, "");
        rendered = rendered.replace(/\x1b\]8;;[^\x1b]*\x1b\\/g, "");
        perfEnd(_ph, { len: md.length });
        return rendered;
    } catch {
        perfEnd(_ph, { len: md.length, err: true });
        return md;
    }
}

// ─── Artifact download ──────────────────────────────────────────
// Detect SAS URLs from export_artifact tool and auto-download files.
// Pattern: https://<account>.blob.core.windows.net/<container>/artifacts/<sessionId>/<filename>?<sas>
const ARTIFACT_SAS_RE = /https:\/\/[^/]+\.blob\.core\.windows\.net\/[^/]+\/artifacts\/([^/]+)\/([^?]+)\?[^\s"']+/g;

/** Downloaded artifact files for the markdown viewer. */
const artifactFiles = []; // [{ filename, localPath, sessionId, downloadedAt }]

/**
 * Scan text for artifact SAS URLs and download them to EXPORTS_DIR.
 * Called from showCopilotMessage / observer when new content arrives.
 */
async function downloadArtifactUrls(text) {
    const matches = [...text.matchAll(ARTIFACT_SAS_RE)];
    for (const m of matches) {
        const [url, sessionId, filename] = m;
        const sessionDir = path.join(EXPORTS_DIR, sessionId.slice(0, 8));
        fs.mkdirSync(sessionDir, { recursive: true });
        const localPath = path.join(sessionDir, filename);

        try {
            const resp = await fetch(url);
            if (!resp.ok) {
                appendLog(`{red-fg}📥 Failed to download ${filename}: HTTP ${resp.status}{/red-fg}`);
                continue;
            }
            const content = await resp.text();
            fs.writeFileSync(localPath, content, "utf-8");
            artifactFiles.push({
                filename,
                localPath,
                sessionId: sessionId.slice(0, 8),
                downloadedAt: new Date().toISOString(),
            });
            appendLog(`{green-fg}📥 Saved: ~/${path.relative(os.homedir(), localPath)} (${(content.length / 1024).toFixed(1)}KB){/green-fg}`);
            // Refresh markdown viewer file list if it's currently showing
            if (logViewMode === "markdown") refreshMarkdownViewer();
        } catch (err) {
            appendLog(`{red-fg}📥 Download error for ${filename}: ${err.message}{/red-fg}`);
        }
    }
}

function ts() {
    return new Date().toLocaleTimeString("en-GB", { hour12: false });
}

/** Extract short display ID (last 8 chars of session UUID) from an orchId or sessionId. */
function shortId(id) {
    const sid = id.startsWith("session-") ? id.slice(8) : id;
    return sid.slice(-8);
}

// ─── Create blessed screen ───────────────────────────────────────

// Suppress stderr during screen creation — same SetUlc issue.
process.stderr.write = () => true;
const screen = blessed.screen({
    smartCSR: true,
    title: "PilotSwarm",
    fullUnicode: true,
    forceUnicode: true,
    mouse: true,
});
process.stderr.write = _origStderr;

// ─── Coalescing render loop (Option B) ───────────────────────────
// Instead of rendering on every screen.render() call (80+ sites),
// screen.render() just sets a dirty flag. A 100ms frame loop does
// the actual render — hard cap at 10fps.
const _origRender = screen.render.bind(screen);
let _screenDirty = false;
let _chatDirty = false;
let _activityDirty = false;

screen.render = function coalescedRender() {
    _screenDirty = true;
};

// Patch screen.realloc() — after a realloc (full buffer wipe), force an
// immediate render so the screen doesn't stay blank until the next frame.
const _origRealloc = screen.realloc.bind(screen);
screen.realloc = function patchedRealloc() {
    _origRealloc();
    _origRender(); // immediate render, bypass frame loop
};

// Frame loop — 10fps max
setInterval(() => {
    // Sync chat buffer → chatBox before rendering (Option C)
    if (_chatDirty) {
        let currentActive;
        try { currentActive = activeOrchId; } catch { currentActive = undefined; }
        const lines = currentActive && sessionChatBuffers?.get(currentActive);
        if (lines) {
            // Save scroll state before setContent (which resets scroll to top)
            const wasAtBottom = chatBox.getScrollPerc() >= 95;
            const prevScrollTop = chatBox.childBase || 0;
            chatBox.setContent(lines.map(styleUrls).join("\n"));
            if (wasAtBottom) {
                chatBox.setScrollPerc(100);
            } else {
                // Restore previous scroll position
                chatBox.scrollTo(prevScrollTop);
            }
        }
        _chatDirty = false;
        _screenDirty = true;
    }
    // Sync activity buffer → activityPane
    if (_activityDirty) {
        let currentActive;
        try { currentActive = activeOrchId; } catch { currentActive = undefined; }
        const aLines = currentActive && sessionActivityBuffers?.get(currentActive);
        if (aLines) {
            const wasAtBottom = activityPane.getScrollPerc() >= 95;
            const prevScrollTop = activityPane.childBase || 0;
            activityPane.setContent(aLines.join("\n"));
            if (wasAtBottom) {
                activityPane.setScrollPerc(100);
            } else {
                activityPane.scrollTo(prevScrollTop);
            }
        }
        _activityDirty = false;
        _screenDirty = true;
    }
    if (_screenDirty) {
        _screenDirty = false;
        const t0 = performance.now();
        _origRender();
        const dur = performance.now() - t0;
        _perfRenderCount++;
        _perfRenderTotalMs += dur;
        if (dur > 5 || _perfRenderCount % 50 === 0) {
            _perfStream.write(JSON.stringify({
                ts: Date.now(), op: "screen.render", dur: +dur.toFixed(2),
                count: _perfRenderCount, avgMs: +(_perfRenderTotalMs / _perfRenderCount).toFixed(2)
            }) + "\n");
        }
    }
}, 100);

// ─── Layout calculations ─────────────────────────────────────────
// Left column: sessions (top) + chat (bottom). Right column: full-height logs.

let rightPaneAdjust = Math.floor(screen.width * 0.55 * 0.25); // start right pane at 3/4 of default
function leftW() { return Math.floor(screen.width * 0.45) + rightPaneAdjust; }
function rightW() { return screen.width - leftW(); }
function bodyH() { return screen.height - 3; } // total body (minus input bar)
function sessH() { return Math.max(5, Math.floor(bodyH() * 0.25)); }
function chatH() { return bodyH() - sessH(); }
function activityH() { return Math.max(6, Math.floor(bodyH() * 0.28)); } // sticky Activity pane height
function rightMainH() { return bodyH() - activityH(); } // remaining height for log panes

// ─── Focus ring: highlight the active pane with a bright border ──
// When a pane gains focus, its border turns bright green.
// When it loses focus, it reverts to its default border color.
const FOCUS_BORDER_FG = "#ff0000";  // bright red border when focused
const paneDefaultBorderFg = new Map(); // pane → original border fg color

function registerFocusRing(pane, defaultFg) {
    paneDefaultBorderFg.set(pane, defaultFg);
    pane.on("focus", () => {
        pane.style.border.fg = FOCUS_BORDER_FG;
        pane.style.border.bold = true;
        if (pane.style.label) {
            pane.style.label.fg = FOCUS_BORDER_FG;
            pane.style.label.bold = true;
        }
        scheduleRender();
    });
    pane.on("blur", () => {
        pane.style.border.fg = paneDefaultBorderFg.get(pane) || defaultFg;
        pane.style.border.bold = false;
        if (pane.style.label) {
            pane.style.label.fg = paneDefaultBorderFg.get(pane) || defaultFg;
            pane.style.label.bold = false;
        }
        scheduleRender();
    });
}

// ─── Left pane: Orchestrations ───────────────────────────────────

const orchList = blessed.list({
    parent: screen,
    label: " {bold}Sessions{/bold} ",
    tags: true,
    left: 0,
    top: 0,
    width: leftW(),
    height: sessH(),
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
    keys: false,
    vi: false,
    mouse: true,
    interactive: true,
});

// ─── Vim-like scrolloff navigation for session list ──────────────
// Cursor stays centered; the view scrolls around it. At the edges
// (top/bottom of the list), the cursor moves without scrolling.
{
    const SCROLLOFF = 999; // large = always center (like vim scrolloff=999)
    function orchListMove(delta) {
        const total = orchList.items.length;
        if (total === 0) return;
        const cur = orchList.selected ?? 0;
        const next = Math.max(0, Math.min(total - 1, cur + delta));
        if (next === cur) return;
        orchList.select(next);
        // Compute visible height (subtract 2 for border)
        const visH = (orchList.height ?? 10) - 2;
        const half = Math.floor(visH / 2);
        const off = Math.min(SCROLLOFF, half);
        // Target scroll: keep `next` at least `off` rows from top/bottom edge
        const scrollTop = orchList.childBase ?? 0;
        const posInView = next - scrollTop;
        if (posInView < off) {
            // Too close to top — scroll up
            orchList.scrollTo(Math.max(0, next - off));
        } else if (posInView >= visH - off) {
            // Too close to bottom — scroll down
            orchList.scrollTo(next - visH + off + 1);
        }
        screen.render();
    }
    orchList.key(["j", "down"], () => orchListMove(1));
    orchList.key(["k", "up"], () => orchListMove(-1));
}

// Show contextual help when the orch list gains focus
orchList.on("focus", () => {
    setStatus("{yellow-fg}j/k navigate · Enter switch · n new · t title · c cancel · d delete · r refresh · q quit{/yellow-fg}");
});
orchList.on("blur", () => {
    setStatus("Ready — type a message");
});

// ─── Center pane: Chat ───────────────────────────────────────────

const chatBox = blessed.log({
    parent: screen,
    label: " {bold}Chat{/bold} ",
    tags: true,
    left: 0,
    top: sessH(),
    width: leftW(),
    height: chatH(),
    border: { type: "line" },
    style: {
        fg: "white",
        border: { fg: "cyan" },
        label: { fg: "cyan" },
        focus: { border: { fg: "white" } },
    },
    scrollable: true,
    alwaysScroll: true,
    scrollbar: { style: { bg: "cyan" } },
    keys: true,
    vi: true,
    mouse: true,
});

// ─── Clickable URLs in chat ──────────────────────────────────────
// Style bare URLs in blessed-tagged text so they look clickable,
// and open them in the browser on mouse click.
const URL_RE = /https?:\/\/[^\s<>()"',;]+/g;

/**
 * Wrap bare URLs in blessed underline+cyan tags so they stand out as links.
 * Handles lines that already contain blessed tags ({…-fg} etc.) safely.
 */
function styleUrls(line) {
    // Don't re-style if the line already has our link marker
    if (line.includes("🔗")) return line;
    return line.replace(URL_RE, (url) => `🔗{underline}{cyan-fg}${url}{/cyan-fg}{/underline}`);
}

/**
 * Extract the first URL from a blessed-tagged line (strips tags first).
 */
function extractUrlFromLine(line) {
    if (!line) return null;
    // Strip blessed tags for matching
    const plain = line.replace(/\{[^}]*\}/g, "");
    const m = plain.match(URL_RE);
    return m ? m[0] : null;
}

// Mouse click → open URL in browser
chatBox.on("click", function (_mouse) {
    // Calculate which content line was clicked
    // _mouse.y is absolute screen coordinate
    const absTop = this.atop != null ? this.atop : this.top;
    const borderTop = this.border ? 1 : 0;
    const scrollOffset = this.childBase || 0;
    const relY = _mouse.y - absTop - borderTop;
    const lineIdx = scrollOffset + relY;
    const content = this.getContent();
    const lines = content.split("\n");
    if (lineIdx < 0 || lineIdx >= lines.length) return;
    const url = extractUrlFromLine(lines[lineIdx]);
    if (url) {
        // Open in default browser (macOS: open, Linux: xdg-open)
        const cmd = process.platform === "darwin" ? "open" : "xdg-open";
        spawn(cmd, [url], { detached: true, stdio: "ignore" }).unref();
    }
});

// ─── Right side: per-worker log panes, created dynamically ───────

const workerPanes = new Map(); // podName → blessed.log
const workerPaneOrder = []; // ordered pod names
const workerLogBuffers = new Map(); // podName → [{orchId, text}] — raw entries for recoloring
const paneColors = ["yellow", "magenta", "green", "blue"];
let nextColorIdx = 0;

// Log viewing mode: "workers" | "orchestration" | "sequence" | "nodemap"
let logViewMode = "workers";
// Markdown viewer overlay — toggled independently via 'v' key.
// When active, replaces the entire right side (log panes + activity pane).
let mdViewActive = false;

// Per-orchestration log buffer — every log line tagged with an instance_id is stored here
const orchLogBuffers = new Map(); // orchId → { lines: string[], podColors: Map<podName, color> }
const podColorMap = new Map(); // global: podName → color
const nodeColors = ["yellow", "magenta", "green", "blue", "cyan", "white"];
let nextNodeColorIdx = 0;

function getPodColor(podName) {
    if (!podColorMap.has(podName)) {
        podColorMap.set(podName, nodeColors[nextNodeColorIdx++ % nodeColors.length]);
    }
    return podColorMap.get(podName);
}

// Single orchestration log pane (created once, shown/hidden based on mode)
const orchLogPane = blessed.log({
    parent: screen,
    label: " Orchestration Logs ",
    tags: true,
    left: 0,
    top: 0,
    width: 10,
    height: 10,
    border: { type: "line" },
    style: {
        fg: "white",
        border: { fg: "cyan" },
        label: { fg: "cyan" },
        focus: { border: { fg: "white" } },
    },
    scrollable: true,
    alwaysScroll: true,
    scrollbar: { style: { bg: "cyan" } },
    keys: true,
    vi: true,
    mouse: true,
    hidden: true,
});

// ─── Sequence Diagram Mode (swimlane) ────────────────────────────
// Vertical scrolling swimlane: one column per worker node.
// Activity boxes stay in the same column (session affinity).
// Migration arrows show when affinity resets after dehydrate.

const TIME_W = 10; // "HH:MM:SS  " — time + trailing space

const seqEventBuffers = new Map(); // orchId → [event]
const seqNodes = [];               // ordered short node names
const seqNodeSet = new Set();
const MAX_SEQ_RENDER_EVENTS = 120;

// Track per-session state for rendering
const seqLastActivityNode = new Map(); // orchId → last node that ran activity

const seqHeaderBox = blessed.box({
    parent: screen,
    tags: true,
    left: 0,
    top: 0,
    width: 10,
    height: 3,
    style: {
        fg: "white",
        bg: "black",
    },
    hidden: true,
});

// ─── Node Map view ───────────────────────────────────────────────

const nodeMapPane = blessed.log({
    parent: screen,
    label: " Node Map ",
    tags: true,
    left: 0,
    top: 0,
    width: 10,
    height: 10,
    border: { type: "line" },
    style: {
        fg: "white",
        border: { fg: "yellow" },
        label: { fg: "yellow" },
        focus: { border: { fg: "white" } },
    },
    wrap: false,
    scrollable: true,
    alwaysScroll: true,
    scrollbar: { style: { bg: "yellow" } },
    keys: true,
    vi: true,
    mouse: true,
    hidden: true,
});

// ─── Markdown Viewer pane ────────────────────────────────────────
// Two sub-panes: file list (left, narrow) + preview (right, wide).
// Shown when logViewMode === "markdown", cycled via 'm' key.

/** Currently selected file index in the file list. */
let mdViewerSelectedIdx = 0;
/** Search state for '/' in preview. */
let mdViewerSearch = "";

const mdFileListPane = blessed.list({
    parent: screen,
    label: " Files ",
    tags: true,
    left: 0,
    top: 0,
    width: 24,
    height: 10,
    border: { type: "line" },
    style: {
        fg: "white",
        border: { fg: "green" },
        label: { fg: "green" },
        selected: { bg: "blue", fg: "white" },
        focus: { border: { fg: "white" } },
    },
    keys: false,
    vi: false,
    mouse: true,
    interactive: true,
    hidden: true,
});

const mdPreviewPane = blessed.box({
    parent: screen,
    label: " Preview ",
    tags: true,
    left: 24,
    top: 0,
    width: 10,
    height: 10,
    border: { type: "line" },
    style: {
        fg: "white",
        border: { fg: "green" },
        label: { fg: "green" },
        focus: { border: { fg: "white" } },
    },
    scrollable: true,
    alwaysScroll: true,
    scrollbar: { style: { bg: "green" } },
    keys: true,
    vi: true,
    mouse: true,
    hidden: true,
});

/**
 * Scan EXPORTS_DIR for .md files and merge with artifactFiles.
 * Returns a deduplicated list sorted by modification time (newest first).
 */
function scanExportFiles() {
    const files = [];
    const seen = new Set();

    // Scan EXPORTS_DIR recursively for .md files
    function walk(dir) {
        try {
            for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
                const full = path.join(dir, entry.name);
                if (entry.isDirectory()) {
                    walk(full);
                } else if (entry.name.endsWith(".md")) {
                    if (!seen.has(full)) {
                        seen.add(full);
                        const stat = fs.statSync(full);
                        files.push({
                            filename: entry.name,
                            localPath: full,
                            displayPath: path.relative(EXPORTS_DIR, full),
                            mtime: stat.mtimeMs,
                        });
                    }
                }
            }
        } catch { /* ignore permission errors etc */ }
    }
    walk(EXPORTS_DIR);

    // Also include dumps/ directory
    const dumpsDir = path.join(process.cwd(), "dumps");
    if (fs.existsSync(dumpsDir)) walk(dumpsDir);

    // Sort by mtime descending (newest first)
    files.sort((a, b) => b.mtime - a.mtime);
    return files;
}

function refreshMarkdownViewer() {
    const files = scanExportFiles();

    // Update file list
    const items = files.map((f, i) => {
        const icon = f.localPath.includes("dumps") ? "📄" : "📥";
        return `${icon} ${f.displayPath || f.filename}`;
    });
    mdFileListPane.setItems(items.length ? items : ["(no files)"]);
    if (mdViewerSelectedIdx >= files.length) mdViewerSelectedIdx = Math.max(0, files.length - 1);
    mdFileListPane.select(mdViewerSelectedIdx);

    // Render preview for selected file
    if (files.length > 0 && files[mdViewerSelectedIdx]) {
        const f = files[mdViewerSelectedIdx];
        try {
            const raw = fs.readFileSync(f.localPath, "utf-8");
            const rendered = renderMarkdown(raw);
            mdPreviewPane.setLabel(` ${f.filename} `);
            mdPreviewPane.setContent(rendered);
            mdPreviewPane.scrollTo(0);
        } catch (err) {
            mdPreviewPane.setContent(`{red-fg}Error reading file: ${err.message}{/red-fg}`);
        }
    } else {
        mdPreviewPane.setLabel(" Preview ");
        mdPreviewPane.setContent("{gray-fg}No markdown files found.\n\nFiles appear here when:\n  • An agent exports an artifact\n  • You press 'D' to dump a session{/gray-fg}");
    }
    scheduleRender();
}

// File list navigation — select file and render preview
// Guard against re-entrancy: refreshMarkdownViewer() calls .select() which
// can fire "select item" again → infinite recursion.
let _mdRefreshing = false;
mdFileListPane.on("select item", (_el, idx) => {
    if (_mdRefreshing) return;
    mdViewerSelectedIdx = idx;
    _mdRefreshing = true;
    refreshMarkdownViewer();
    _mdRefreshing = false;
});

// j/k/enter/v for md file list are handled in the main screen.on("keypress")
// handler to avoid double-firing. Do NOT add pane-level .key() handlers here.

// v key on md preview pane → toggle back to normal view
function toggleMdViewOff() {
    mdViewActive = false;
    orchList.focus();
    screen.realloc();
    relayoutAll();
    setStatus(`Log mode: ${({ workers: "Per-Worker", orchestration: "Per-Orchestration", sequence: "Sequence Diagram", nodemap: "Node Map" })[logViewMode]}`);
}

// ─── Vim keybindings for markdown preview ────────────────────────
// g = top, G = bottom, Ctrl-d = page down, Ctrl-u = page up
// o = open in $EDITOR, y = copy path
mdPreviewPane.key(["g"], () => { mdPreviewPane.scrollTo(0); scheduleRender(); });
mdPreviewPane.key(["S-g"], () => { mdPreviewPane.setScrollPerc(100); scheduleRender(); });
mdPreviewPane.key(["C-d"], () => {
    const h = mdPreviewPane.height - 2; // inner height
    mdPreviewPane.scroll(Math.floor(h / 2));
    scheduleRender();
});
mdPreviewPane.key(["C-u"], () => {
    const h = mdPreviewPane.height - 2;
    mdPreviewPane.scroll(-Math.floor(h / 2));
    scheduleRender();
});
mdPreviewPane.key(["o"], () => {
    const files = scanExportFiles();
    const f = files[mdViewerSelectedIdx];
    if (!f) return;
    const editor = process.env.EDITOR || (process.platform === "darwin" ? "open" : "xdg-open");
    spawn(editor, [f.localPath], { detached: true, stdio: "ignore" }).unref();
});
mdPreviewPane.key(["y"], () => {
    const files = scanExportFiles();
    const f = files[mdViewerSelectedIdx];
    if (!f) return;
    // Copy path to clipboard (macOS pbcopy, Linux xclip)
    const cmd = process.platform === "darwin" ? "pbcopy" : "xclip -selection clipboard";
    const proc = spawn(process.platform === "darwin" ? "pbcopy" : "xclip", process.platform === "darwin" ? [] : ["-selection", "clipboard"], { stdio: ["pipe", "ignore", "ignore"] });
    proc.stdin.write(f.localPath);
    proc.stdin.end();
    setStatus(`{green-fg}Copied: ${f.localPath}{/green-fg}`);
});

// ─── Activity pane (sticky, bottom-right) ────────────────────────
// Shows intermediate messages: tool calls, reasoning, status changes.
// Visible in all log view modes — persists through "m" cycling.
const activityPane = blessed.log({
    parent: screen,
    label: " {bold}Activity{/bold} ",
    tags: true,
    left: 0,
    top: 0,
    width: 10,
    height: 10,
    border: { type: "line" },
    style: {
        fg: "white",
        border: { fg: "gray" },
        label: { fg: "gray" },
        focus: { border: { fg: "white" } },
    },
    scrollable: true,
    alwaysScroll: true,
    scrollbar: { style: { bg: "gray" } },
    keys: true,
    vi: true,
    mouse: true,
});

// Per-session activity buffers
const sessionActivityBuffers = new Map(); // orchId → string[]
const MAX_ACTIVITY_BUFFER_LINES = 300;

function appendActivity(text, orchId) {
    let buffers, currentActive;
    try { buffers = sessionActivityBuffers; } catch { return; }
    try { currentActive = activeOrchId; } catch { currentActive = undefined; }
    const targetOrch = orchId || currentActive || "_init";
    if (!buffers.has(targetOrch)) buffers.set(targetOrch, []);
    const buf = buffers.get(targetOrch);
    buf.push(text);

    // Cap buffer size
    if (buf.length > MAX_ACTIVITY_BUFFER_LINES * 1.2) {
        const dropped = buf.length - MAX_ACTIVITY_BUFFER_LINES;
        buf.splice(0, dropped);
        buf[0] = `{gray-fg}── ${dropped} older lines trimmed ──{/gray-fg}`;
    }

    // Mark dirty so the frame loop syncs buffer → activityPane
    if (currentActive && targetOrch === currentActive) {
        _activityDirty = true;
    }
}

/**
 * Refresh the node map pane — vertical columns, one per worker node,
 * with sessions stacked underneath, color-coded by live status.
 */
function refreshNodeMap() {
    nodeMapPane.setContent("");
    screen.realloc();

    // Gather all known nodes from seqNodes (worker pane names)
    // Filter out synthetic nodes like "cms" that aren't real workers.
    const SYNTHETIC_NODES = new Set(["cms"]);
    const nodes = (seqNodes.length > 0 ? [...seqNodes] : [...workerPaneOrder])
        .filter(n => !SYNTHETIC_NODES.has(n));
    if (nodes.length === 0) {
        nodeMapPane.log("{white-fg}No worker nodes discovered yet{/white-fg}");
        screen.render();
        return;
    }

    // Build node → [{ orchId, status, title }] mapping
    const nodeSessionMap = new Map(); // nodeName → array
    for (const node of nodes) nodeSessionMap.set(node, []);

    // Add a virtual "(none)" column for sessions with no known node
    const UNASSIGNED = "(unknown)";
    nodeSessionMap.set(UNASSIGNED, []);

    // Walk all known orchestrations and assign to their last-known node
    for (const orchId of knownOrchestrationIds) {
        const node = seqLastActivityNode.get(orchId);
        const status = sessionLiveStatus.get(orchId) || "unknown";
        const uuid4 = shortId(orchId);
        const title = sessionHeadings.get(orchId);
        const entry = { orchId, uuid4, status, title };
        if (node && nodeSessionMap.has(node)) {
            nodeSessionMap.get(node).push(entry);
        } else {
            nodeSessionMap.get(UNASSIGNED).push(entry);
        }
    }

    // Build final column list — only include (none) if it has sessions
    const columns = [...nodes];
    if (nodeSessionMap.get(UNASSIGNED).length > 0) columns.push(UNASSIGNED);

    // Compute column widths (account for │ dividers between columns)
    const innerW = (nodeMapPane.width || 60) - 4; // borders + scrollbar + margin
    const ncols = columns.length;
    const dividers = ncols > 1 ? ncols - 1 : 0;
    const colW = Math.max(10, Math.floor((innerW - dividers) / ncols));
    const SEP = "{white-fg}│{/white-fg}";

    // State → color mapping
    const stateColor = (status) => {
        switch (status) {
            case "running": return "green";
            case "waiting": return "yellow";
            case "idle": return "gray";
            case "input_required": return "cyan";
            case "error": return "red";
            default: return "white";
        }
    };

    // Pad/clip text to column width (plain text, no tags)
    const fitCol = (text, w) => {
        if (text.length > w) return text.slice(0, w);
        return text + " ".repeat(w - text.length);
    };

    // Render header row: node names
    let headerLine = "";
    for (let i = 0; i < columns.length; i++) {
        if (i > 0) headerLine += SEP;
        headerLine += "{bold}" + fitCol(columns[i], colW) + "{/bold}";
    }
    nodeMapPane.log(headerLine);

    // Divider
    let divLine = "";
    for (let i = 0; i < columns.length; i++) {
        if (i > 0) divLine += "┼";
        divLine += "─".repeat(colW);
    }
    nodeMapPane.log(divLine);

    // Find max sessions on any node to know how many rows we need
    let maxSessions = 0;
    for (const arr of nodeSessionMap.values()) {
        if (arr.length > maxSessions) maxSessions = arr.length;
    }

    // Render session rows — 2 lines per slot (uuid + title) + 1 blank spacer
    for (let row = 0; row < maxSessions; row++) {
        let idLine = "";
        let titleLine = "";
        for (let ci = 0; ci < columns.length; ci++) {
            const node = columns[ci];
            if (ci > 0) { idLine += SEP; titleLine += SEP; }
            const sessions = nodeSessionMap.get(node);
            if (row < sessions.length) {
                const s = sessions[row];
                const isActive = s.orchId === activeOrchId;
                const color = stateColor(s.status);
                const idText = fitCol(s.uuid4, colW);
                const tText = fitCol((s.title || "").slice(0, colW - 1), colW);
                if (isActive) {
                    const idBracketed = "[" + s.uuid4 + "]";
                    idLine += `{${color}-fg}{bold}{blink}${fitCol(idBracketed, colW)}{/blink}{/bold}{/${color}-fg}`;
                    titleLine += `{${color}-fg}{bold}${tText}{/bold}{/${color}-fg}`;
                } else {
                    idLine += `{${color}-fg}${idText}{/${color}-fg}`;
                    titleLine += `{${color}-fg}${tText}{/${color}-fg}`;
                }
            } else {
                idLine += " ".repeat(colW);
                titleLine += " ".repeat(colW);
            }
        }
        nodeMapPane.log(idLine);
        nodeMapPane.log(titleLine);
        if (row < maxSessions - 1) nodeMapPane.log(""); // spacer between sessions
    }

    if (maxSessions === 0) {
        nodeMapPane.log("");
        nodeMapPane.log("{white-fg}(no sessions assigned to any node){/white-fg}");
    }

    // Legend
    nodeMapPane.log("");
    nodeMapPane.log(
        "{green-fg}* running{/green-fg}  " +
        "{yellow-fg}~ waiting{/yellow-fg}  " +
        "{white-fg}. idle{/white-fg}  " +
        "{cyan-fg}? input{/cyan-fg}  " +
        "{red-fg}! error{/red-fg}"
    );

    screen.render();
}

const seqPane = blessed.log({
    parent: screen,
    label: " Sequence ",
    tags: true,
    left: 0,
    top: 0,
    width: 10,
    height: 10,
    border: { type: "line" },
    style: {
        fg: "white",
        border: { fg: "magenta" },
        label: { fg: "magenta" },
        focus: { border: { fg: "white" } },
    },
    wrap: false,
    scrollable: true,
    alwaysScroll: true,
    scrollbar: { style: { bg: "magenta" } },
    keys: true,
    vi: true,
    mouse: true,
    hidden: true,
});

// ─── Register focus ring on all panes ────────────────────────────
registerFocusRing(orchList, "yellow");
registerFocusRing(chatBox, "cyan");
registerFocusRing(orchLogPane, "cyan");
registerFocusRing(nodeMapPane, "yellow");
registerFocusRing(mdFileListPane, "green");
registerFocusRing(mdPreviewPane, "green");
registerFocusRing(activityPane, "gray");
registerFocusRing(seqPane, "magenta");
// Worker panes are created dynamically — registered in getOrCreateWorkerPane()

function addSeqNode(podName) {
    const short = podName.slice(-5);
    if (seqNodeSet.has(short)) return short;
    seqNodeSet.add(short);
    seqNodes.push(short);
    // Update sticky header when a new node is discovered
    if (logViewMode === "sequence") {
        updateSeqHeader();
    }
    return short;
}

// Compute column width dynamically from pane inner width
// Returns an array of per-column widths so remaining pixels are distributed
// across the first N columns instead of leaving a gap at the right.
function seqColWidths() {
    const innerW = (seqPane.width || 60) - 4; // borders (2) + scrollbar (1) + safety margin (1)
    const ncols = seqNodes.length || 1;
    const available = innerW - TIME_W;
    const base = Math.max(8, Math.floor(available / ncols));
    const remainder = Math.max(0, available - base * ncols);
    const widths = [];
    for (let i = 0; i < ncols; i++) {
        widths.push(base + (i < remainder ? 1 : 0));
    }
    return widths;
}

// Legacy helper — returns the base column width (used in separator/header)
function seqColW() {
    const innerW = (seqPane.width || 60) - 4;
    const ncols = seqNodes.length || 1;
    return Math.max(8, Math.floor((innerW - TIME_W) / ncols));
}

// Measure display width of a string (emoji = 2 cells)
// eslint-disable-next-line no-control-regex
const EMOJI_RE = /[\u{1F300}-\u{1FAD6}\u{2600}-\u{27BF}\u{FE00}-\u{FE0F}\u{200D}\u{20E3}\u{E0020}-\u{E007F}]/gu;

function displayWidth(str) {
    // Strip blessed tags
    const noTags = str.replace(/\{[^}]*\}/g, "");
    let w = 0;
    for (const ch of noTags) {
        const cp = ch.codePointAt(0);
        // Zero-width characters (joiners, variation selectors)
        if ((cp >= 0xFE00 && cp <= 0xFE0F) || cp === 0x200D || cp === 0x200B ||
            (cp >= 0xE0020 && cp <= 0xE007F) || cp === 0x20E3) {
            continue;
        }
        // Emoji: surrogate pairs / high codepoints
        if (cp >= 0x1F000) { w += 2; continue; }
        // Misc symbols & dingbats (often 2 cells)
        if (cp >= 0x2600 && cp <= 0x27BF) { w += 2; continue; }
        // CJK / Fullwidth characters (2 cells)
        if ((cp >= 0x3000 && cp <= 0x9FFF) ||
            (cp >= 0xF900 && cp <= 0xFAFF) ||
            (cp >= 0xFF01 && cp <= 0xFF60) ||
            (cp >= 0xFFE0 && cp <= 0xFFE6)) { w += 2; continue; }
        // Box drawing, block elements, geometric shapes (1 cell)
        // Everything else: 1 cell
        w += 1;
    }
    return w;
}

// Pad string to target display width
function padToWidth(str, targetW) {
    const w = displayWidth(str);
    const need = Math.max(0, targetW - w);
    return str + " ".repeat(need);
}

// Build one swimlane line: place content in a specific column
function seqLine(time, colIdx, content, color) {
    const ncols = seqNodes.length || 1;
    const widths = seqColWidths();
    const timeStr = (time || "").padEnd(TIME_W);
    let line = `{white-fg}${timeStr}{/white-fg}`;

    for (let i = 0; i < ncols; i++) {
        const w = widths[i];
        if (i === colIdx) {
            // Content cell — clip to fit
            const maxContent = w - 2; // 1 space padding each side
            const clipped = content.length > maxContent ? content.slice(0, maxContent) : content;
            // Pad the clipped text to maxContent BEFORE applying color tags
            const padded = padToWidth(clipped, maxContent);
            const colored = color ? `{${color}-fg}${padded}{/${color}-fg}` : padded;
            line += ` ${colored} `;
        } else {
            // Empty cell — vertical bar for the swimlane (ASCII | avoids
            // ambiguous-width issues with Unicode box-drawing characters)
            const mid = Math.floor(w / 2);
            line += " ".repeat(mid) + "{white-fg}|{/white-fg}" + " ".repeat(w - mid - 1);
        }
    }
    return line;
}

// Full-width separator line for CAN / migration events
function seqSeparator(label, color) {
    const widths = seqColWidths();
    const totalW = TIME_W + widths.reduce((a, b) => a + b, 0);
    const labelStr = ` ${label} `;
    const dashCount = Math.max(0, totalW - labelStr.length);
    const left = Math.floor(dashCount / 2);
    const right = dashCount - left;
    return `{${color}-fg}${"-".repeat(left)}${labelStr}${"-".repeat(right)}{/${color}-fg}`;
}

function seqHeader() {
    const widths = seqColWidths();
    let header = "{bold}" + "TIME".padEnd(TIME_W);
    for (let i = 0; i < seqNodes.length; i++) {
        const w = widths[i];
        const padded = seqNodes[i].padEnd(w);
        header += padded.slice(0, w);
    }
    header += "{/bold}";

    let divider = "-".repeat(TIME_W);
    for (let i = 0; i < seqNodes.length; i++) {
        divider += "-".repeat(widths[i]);
    }
    return [header, divider];
}

/**
 * Parse a raw log line into a sequence event.
 * Returns null if the line isn't relevant for the sequence diagram.
 */
function parseSeqEvent(plain, podName) {
    const iMatch = plain.match(/instance_id=(\S+)/);
    if (!iMatch) return null;
    const orchId = iMatch[1].replace(/,.*$/, "");
    if (!orchId.startsWith("session-")) return null;

    const tMatch = plain.match(/\d{4}-\d{2}-\d{2}T(\d{2}:\d{2}:\d{2})/);
    const time = tMatch ? tMatch[1] : "";

    const orchNode = addSeqNode(podName);

    // Extract worker node from activity logs
    // Try local-mode pattern first (local-rt-N), then remote pod pattern
    const wMatch = plain.match(/worker_id=\S*?(local-rt-\d+)/)
              || plain.match(/worker_id=work-\d+-(\S+)-rt-\d+/);
    const actNode = wMatch ? addSeqNode(wMatch[1]) : orchNode;

    // ─── Orchestration events (dots) ──────────
    if (plain.includes("[turn ")) {
        const turnMatch = plain.match(/\[turn (\d+)\]/);
        const promptMatch = plain.match(/prompt="([^"]{0,30})/);
        return { orchId, time, type: "turn", orchNode, actNode,
            turn: turnMatch?.[1] || "?",
            prompt: promptMatch?.[1] || "" };
    }
    if (plain.includes("execution start") || plain.includes("[orch] start:")) {
        const iterMatch = plain.match(/iteration=(\d+)/) || plain.match(/iter=(\d+)/);
        const hydrate = plain.includes("needsHydration=true") || plain.includes("hydrate=true");
        return { orchId, time, type: "exec_start", orchNode, actNode,
            iteration: parseInt(iterMatch?.[1] || "0", 10),
            hydrate };
    }
    if (plain.includes("timer completed")) {
        const sMatch = plain.match(/seconds=(\d+)/);
        return { orchId, time, type: "timer_fired", orchNode, actNode,
            seconds: sMatch?.[1] || "?" };
    }
    if (plain.includes("idle timeout")) {
        return { orchId, time, type: "dehydrate", orchNode, actNode };
    }
    if (plain.includes("user responded within idle")) {
        return { orchId, time, type: "user_idle", orchNode, actNode };
    }
    if (plain.includes("wait interrupted")) {
        return { orchId, time, type: "interrupt", orchNode, actNode };
    }

    // ─── Activity events (boxes) ──────────
    if (plain.includes("[activity]") && (plain.includes("activity_name=runAgentTurn") || plain.includes("activity_name=runTurn"))) {
        if (plain.includes("resuming session")) {
            return { orchId, time, type: "resume", orchNode, actNode };
        }
        if (plain.includes("re-hydrating")) {
            return { orchId, time, type: "resume", orchNode, actNode };
        }
        return { orchId, time, type: "activity_start", orchNode, actNode };
    }
    if (plain.includes("activity_name=dehydrateSession")) {
        return { orchId, time, type: "dehydrate_act", orchNode, actNode };
    }
    if (plain.includes("activity_name=hydrateSession")) {
        return { orchId, time, type: "hydrate_act", orchNode, actNode };
    }
    if (plain.includes("activity_name=listModels")) {
        return { orchId, time, type: "listmodels_act", orchNode, actNode };
    }

    // ─── Command dispatch events ──────────
    if (plain.includes("[orch-cmd]")) {
        const cmdMatch = plain.match(/received command: (\S+)/);
        if (cmdMatch) {
            return { orchId, time, type: "cmd_recv", orchNode, actNode,
                cmd: cmdMatch[1] };
        }
        const modelMatch = plain.match(/model changed: (.+)/);
        if (modelMatch) {
            return { orchId, time, type: "cmd_done", orchNode, actNode,
                detail: modelMatch[1] };
        }
    }

    // ─── Grace period dehydration ──────────
    if (plain.includes("Grace period elapsed, dehydrating")) {
        return { orchId, time, type: "dehydrate", orchNode, actNode };
    }
    // explicit dehydrate log from orchestration
    if (plain.includes("[orch] dehydrating session")) {
        return { orchId, time, type: "dehydrate", orchNode, actNode };
    }

    // ─── Agent output events ──────────
    if (plain.includes("[durable-agent] Durable timer") || plain.includes("[orch] durable timer:")) {
        const sMatch = plain.match(/(?:Durable timer|durable timer):\s*(\d+)s/);
        return { orchId, time, type: "wait", orchNode, actNode,
            seconds: sMatch?.[1] || "?" };
    }
    if (plain.includes("[durable-agent] Intermediate content") || plain.includes("[orch] intermediate:")) {
        const cMatch = plain.match(/(?:Intermediate content|intermediate):\s*(.{0,25})/);
        return { orchId, time, type: "content", orchNode, actNode,
            snippet: cMatch?.[1] || "…" };
    }
    if (plain.includes("[response]")) {
        const rMatch = plain.match(/\[response\] (.{0,25})/);
        return { orchId, time, type: "response", orchNode, actNode,
            snippet: rMatch?.[1] || "" };
    }
    // [runTurn] activity log
    if (plain.includes("[runTurn]")) {
        return { orchId, time, type: "activity_start", orchNode, actNode };
    }

    return null;
}

/**
 * Inject a synthetic "user sent a message" marker into the sequence diagram.
 * Called from handleInput so the interaction is visible immediately,
 * without waiting for kubectl logs to stream back.
 */
function injectSeqUserEvent(orchId, label) {
    const now = new Date().toLocaleTimeString("en-GB", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
    // Find the last node that ran an activity for this session, or fall back to first node
    const lastAct = seqLastActivityNode.get(orchId) || seqNodes[0];
    if (!lastAct) return; // no nodes yet
    const col = seqNodes.indexOf(lastAct);
    if (col < 0) return;

    const synth = { orchId, time: now, type: "user_msg_synth", orchNode: lastAct, actNode: lastAct, label };
    appendSeqEvent(orchId, synth);
}

/**
 * Append a parsed event and render it if sequence mode is active.
 */
function appendSeqEvent(orchId, event) {
    if (!seqEventBuffers.has(orchId)) seqEventBuffers.set(orchId, []);
    const buf = seqEventBuffers.get(orchId);
    buf.push(event);
    if (buf.length > 300) buf.splice(0, buf.length - 300);

    // Always track which node each session is on (for node map view),
    // not just when the sequence pane is rendering.
    if (event.type === "activity_start" || event.type === "resume" || event.type === "hydrate_act") {
        seqLastActivityNode.set(orchId, event.actNode);
    } else if (event.actNode && !seqLastActivityNode.has(orchId)) {
        // First event for this session — use whatever node we see
        seqLastActivityNode.set(orchId, event.actNode);
    }

    if (logViewMode === "sequence" && orchId === activeOrchId) {
        renderSeqEventLine(event, orchId);
        screen.render();
    }
}

/**
 * Render a single event into the sequence pane.
 */
function renderSeqEventLine(event, orchId) {
    const lastAct = seqLastActivityNode.get(orchId);

    switch (event.type) {
        case "exec_start":
            // Suppress standalone exec_start — the turn event that always
            // follows provides enough context. This halves the vertical
            // density of the diagram.
            break;

        case "turn": {
            const orchCol = seqNodes.indexOf(event.orchNode);
            seqPane.log(seqLine(event.time, orchCol, `turn ${event.turn}`, "gray"));
            break;
        }

        case "activity_start": {
            const col = seqNodes.indexOf(event.actNode);
            if (lastAct !== undefined && lastAct !== event.actNode) {
                seqPane.log(seqLine(event.time, col, `> ${lastAct}->${event.actNode}`, "yellow"));
            }
            seqLastActivityNode.set(orchId, event.actNode);
            seqPane.log(seqLine(event.time, col, "> agent", "cyan"));
            break;
        }

        case "resume": {
            const col = seqNodes.indexOf(event.actNode);
            if (lastAct !== undefined && lastAct !== event.actNode) {
                seqPane.log(seqLine(event.time, col, `> ${lastAct}->${event.actNode}`, "yellow"));
            }
            seqLastActivityNode.set(orchId, event.actNode);
            seqPane.log(seqLine(event.time, col, "^ resume", "green"));
            break;
        }

        case "content": {
            // Skip verbose streaming-content rows in sequence mode to keep
            // vertical density high; full content remains in chat pane.
            break;
        }

        case "response": {
            const col = seqNodes.indexOf(lastAct || event.orchNode);
            const colW = seqColW();
            const maxSnip = Math.max(3, colW - 8);
            const snip = (event.snippet || "ok").slice(0, maxSnip);
            seqPane.log(seqLine(event.time, col, `< ${snip}`, "green"));
            break;
        }

        case "wait": {
            const col = seqNodes.indexOf(lastAct || event.orchNode);
            seqPane.log(seqLine(event.time, col, `wait ${event.seconds}s`, "yellow"));
            break;
        }

        case "timer_fired": {
            const col = seqNodes.indexOf(lastAct || event.orchNode);
            seqPane.log(seqLine(event.time, col, `${event.seconds}s up`, "yellow"));
            break;
        }

        case "dehydrate": {
            const col = seqNodes.indexOf(lastAct || event.orchNode);
            seqPane.log(seqLine(event.time, col, "ZZ dehydrate", "red"));
            break;
        }

        case "dehydrate_act": {
            const col = seqNodes.indexOf(event.actNode);
            seqPane.log(seqLine(event.time, col, "ZZ > blob", "red"));
            break;
        }

        case "hydrate_act": {
            const col = seqNodes.indexOf(event.actNode);
            seqPane.log(seqLine(event.time, col, "^^ < blob", "green"));
            break;
        }

        case "user_idle": {
            const col = seqNodes.indexOf(lastAct || event.orchNode);
            seqPane.log(seqLine(event.time, col, ">> user msg", "cyan"));
            break;
        }

        case "interrupt": {
            const col = seqNodes.indexOf(lastAct || event.orchNode);
            seqPane.log(seqLine(event.time, col, ">> interrupt", "cyan"));
            break;
        }

        case "user_msg_synth": {
            const col = seqNodes.indexOf(event.orchNode);
            const snip = event.label && event.label.length > 12 ? event.label.slice(0, 12) + "…" : (event.label || "msg");
            seqPane.log(seqLine(event.time, col, `>> ${snip}`, "white"));
            break;
        }

        case "cmd_recv": {
            const col = seqNodes.indexOf(event.orchNode);
            seqPane.log(seqLine(event.time, col, `>> /${event.cmd}`, "magenta"));
            break;
        }

        case "cmd_done": {
            const col = seqNodes.indexOf(event.orchNode);
            seqPane.log(seqLine(event.time, col, `<< ${(event.detail || "ok").slice(0, 15)}`, "magenta"));
            break;
        }

        case "listmodels_act": {
            const col = seqNodes.indexOf(event.actNode);
            seqPane.log(seqLine(event.time, col, "[= listModels]", "magenta"));
            break;
        }
    }
    // Don't render here — callers batch renders
}

/**
 * Update the sticky header box with current node columns.
 */
function updateSeqHeader() {
    if (seqNodes.length > 0) {
        const [header, divider] = seqHeader();
        seqHeaderBox.setContent(`${header}\n${divider}`);
    } else {
        seqHeaderBox.setContent("{bold}TIME      (waiting for events){/bold}");
    }
}

/**
 * Full re-render of the sequence pane for the active session.
 */
function refreshSeqPane() {
    seqPane.setContent("");
    const seqShortId = shortId(activeOrchId);
    seqPane.setLabel(` Sequence: ${seqShortId} `);

    // Update sticky header
    updateSeqHeader();

    // Reset tracking state for this render pass
    seqLastActivityNode.delete(activeOrchId);

    const events = seqEventBuffers.get(activeOrchId);
    if (events && events.length > 0) {
        const renderEvents = events.length > MAX_SEQ_RENDER_EVENTS
            ? events.slice(-MAX_SEQ_RENDER_EVENTS)
            : events;
        if (events.length > MAX_SEQ_RENDER_EVENTS) {
            seqPane.log(`{gray-fg}… showing last ${MAX_SEQ_RENDER_EVENTS} of ${events.length} events …{/gray-fg}`);
        }
        for (const event of renderEvents) {
            renderSeqEventLine(event, activeOrchId);
        }
    } else {
        seqPane.log("{white-fg}No events yet — interact with this session to populate{/white-fg}");
        seqPane.log("{white-fg}the sequence diagram.{/white-fg}");
    }
    screen.render();
}

// ─── End Sequence Diagram Mode ───────────────────────────────────

function appendOrchLog(orchId, podName, text) {
    if (!orchLogBuffers.has(orchId)) orchLogBuffers.set(orchId, []);
    const color = getPodColor(podName);
    const shortPod = podName.slice(-5);
    const coloredLine = `{${color}-fg}[${shortPod}]{/${color}-fg} ${text}`;
    orchLogBuffers.get(orchId).push(coloredLine);
    // Cap buffer at 500 lines
    const buf = orchLogBuffers.get(orchId);
    if (buf.length > 500) buf.splice(0, buf.length - 500);
    // If mode 2 is active and this is the active session, render immediately
    if (logViewMode === "orchestration" && orchId === activeOrchId) {
        orchLogPane.log(coloredLine);
        screen.render();
    }
}

function switchLogMode() {
    // If markdown view is active, 'm' has no effect
    if (mdViewActive) return;

    // Hide all right-pane views first
    for (const pane of workerPanes.values()) pane.hide();
    orchLogPane.hide();
    seqPane.hide();
    seqHeaderBox.hide();
    nodeMapPane.hide();

    if (logViewMode === "workers") {
        logViewMode = "orchestration";
        orchLogPane.show();
        refreshOrchLogPane();
    } else if (logViewMode === "orchestration") {
        logViewMode = "sequence";
        seqPane.show();
        seqHeaderBox.show();
        refreshSeqPane();
    } else if (logViewMode === "sequence") {
        logViewMode = "nodemap";
        nodeMapPane.show();
        refreshNodeMap();
    } else {
        logViewMode = "workers";
        for (const pane of workerPanes.values()) pane.show();
        recolorWorkerPanes();
    }
    relayoutAll();
    // Reset focus to sessions list when panes change
    orchList.focus();
    // Force full repaint on next tick (same as pressing 'r')
    setTimeout(() => { screen.realloc(); screen.render(); }, 0);
}

function refreshOrchLogPane() {
    orchLogPane.setContent("");
    orchLogPane.scrollTo(0);
    const shortIdVal = shortId(activeOrchId);
    orchLogPane.setLabel(` Logs: ${shortIdVal} `);
    const buf = orchLogBuffers.get(activeOrchId);
    if (buf && buf.length > 0) {
        const renderLines = buf.length > 150 ? buf.slice(-150) : buf;
        if (buf.length > 150) {
            orchLogPane.log(`{gray-fg}… showing last 150 of ${buf.length} log lines …{/gray-fg}`);
        }
        for (const line of renderLines) orchLogPane.log(line);
        orchLogPane.setScrollPerc(100);
    } else {
        orchLogPane.log("{white-fg}Loading logs...{/white-fg}");
        orchLogPane.scrollTo(0);
        // Backfill: one-shot kubectl logs fetch filtered for this orchestration
        backfillOrchLogs(activeOrchId);
    }
    screen.render();
}

const backfillInProgress = new Set();
function backfillOrchLogs(orchId) {
    if (backfillInProgress.has(orchId)) return;
    backfillInProgress.add(orchId);

    try {
        const k8sCtxArgs = process.env.K8S_CONTEXT ? ["--context", process.env.K8S_CONTEXT] : [];
        const proc = spawn("kubectl", [
            ...k8sCtxArgs,
            "logs",
            "-n", process.env.K8S_NAMESPACE || "copilot-runtime",
            "-l", process.env.K8S_POD_LABEL || "app.kubernetes.io/component=worker",
            "--prefix",
            "--tail=2000",
            "--since=48h",
            "--max-log-requests=20",
        ], { stdio: ["ignore", "pipe", "pipe"] });

        let out = "";
        proc.stdout.on("data", d => out += d.toString());
        proc.on("close", () => {
            backfillInProgress.delete(orchId);
            const lines = out.split("\n");
            let added = 0;
            for (const line of lines) {
                if (!line.includes(orchId)) continue;
                const prefixMatch = line.match(/^\[pod\/([^/]+)\//);
                const podName = prefixMatch ? prefixMatch[1] : "unknown";
                const content = line.replace(/^\[pod\/[^\]]+\]\s*/, "");
                const formatted = content
                    .replace(/\bWARN\b/g, "{yellow-fg}WARN{/yellow-fg}")
                    .replace(/\bERROR\b/g, "{red-fg}ERROR{/red-fg}")
                    .replace(/\bINFO\b/g, "{green-fg}INFO{/green-fg}");
                appendOrchLog(orchId, podName, formatted);
                added++;
            }
            // If this is still the active session and we're in orch mode, refresh
            if (orchId === activeOrchId && logViewMode === "orchestration") {
                orchLogPane.setContent("");
                orchLogPane.scrollTo(0);
                const buf = orchLogBuffers.get(orchId);
                if (buf && buf.length > 0) {
                    const renderLines = buf.length > 150 ? buf.slice(-150) : buf;
                    if (buf.length > 150) {
                        orchLogPane.log(`{gray-fg}… showing last 150 of ${buf.length} log lines …{/gray-fg}`);
                    }
                    for (const ln of renderLines) orchLogPane.log(ln);
                    orchLogPane.setScrollPerc(100);
                } else {
                    orchLogPane.log("{white-fg}No logs found for this session{/white-fg}");
                    orchLogPane.scrollTo(0);
                }
                screen.render();
            }
        });
        proc.on("error", () => { backfillInProgress.delete(orchId); });
    } catch {
        backfillInProgress.delete(orchId);
    }
}

function getOrCreateWorkerPane(podName) {
    if (workerPanes.has(podName)) return workerPanes.get(podName);

    const color = paneColors[nextColorIdx++ % paneColors.length];
    // Short name: last 5 chars of pod name
    const shortName = podName.slice(-5);

    const pane = blessed.log({
        parent: screen,
        label: ` ${shortName} `,
        tags: true,
        left: leftW(),
        top: 0,
        width: rightW(),
        height: 10,
        border: { type: "line" },
        style: {
            fg: "white",
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
    registerFocusRing(pane, color);

    // Register this pod as a sequence diagram column so all nodes
    // appear regardless of whether the active session has used them.
    addSeqNode(podName);

    relayoutAll();
    return pane;
}

/**
 * Remove worker panes that don't match any currently-running pod.
 * Keeps only panes whose podName is in the activePods set.
 */
function pruneWorkerPanes(activePods) {
    const stale = workerPaneOrder.filter(name => !activePods.has(name));
    if (stale.length === 0) return;
    for (const name of stale) {
        const pane = workerPanes.get(name);
        if (pane) {
            pane.detach();
            screen.remove(pane);
        }
        workerPanes.delete(name);
    }
    // Rebuild order array in place
    stale.forEach(name => {
        const idx = workerPaneOrder.indexOf(name);
        if (idx !== -1) workerPaneOrder.splice(idx, 1);
    });
    relayoutAll();
}

function relayoutAll() {
    const lW = leftW(), rW = rightW(), bH = bodyH(), sH = sessH(), cH = chatH();
    const aH = activityH(), rmH = rightMainH();

    // Left column: sessions on top, chat below
    orchList.left = 0; orchList.top = 0; orchList.width = lW; orchList.height = sH;
    chatBox.left = 0; chatBox.top = sH; chatBox.width = lW; chatBox.height = cH;
    statusBar.left = 1; statusBar.width = lW - 2;

    // Activity pane: sticky bottom-right (always visible)
    activityPane.left = lW;
    activityPane.width = rW;
    activityPane.top = rmH;
    activityPane.height = aH;

    // ── Markdown viewer overlay: replaces entire right side ──
    if (mdViewActive) {
        // Hide normal right-side panes
        for (const pane of workerPanes.values()) pane.hide();
        orchLogPane.hide();
        seqPane.hide();
        seqHeaderBox.hide();
        nodeMapPane.hide();
        activityPane.hide();

        // File list on top (~25%), preview on bottom (~75%)
        const mdListH = Math.max(5, Math.floor(bH * 0.25));
        const mdPreviewH = bH - mdListH;
        mdFileListPane.left = lW;
        mdFileListPane.width = rW;
        mdFileListPane.top = 0;
        mdFileListPane.height = mdListH;
        mdFileListPane.show();
        mdPreviewPane.left = lW;
        mdPreviewPane.width = rW;
        mdPreviewPane.top = mdListH;
        mdPreviewPane.height = mdPreviewH;
        mdPreviewPane.show();
        screen.render();
        return;
    }

    // Normal mode: activity pane visible
    activityPane.show();
    mdFileListPane.hide();
    mdPreviewPane.hide();

    // Right column: upper portion for log panes (reduced by activityH)
    if (logViewMode === "orchestration") {
        orchLogPane.show();
        orchLogPane.left = lW;
        orchLogPane.width = rW;
        orchLogPane.top = 0;
        orchLogPane.height = rmH;
    } else if (logViewMode === "sequence") {
        seqPane.show();
        seqHeaderBox.show();
        const headerH = 3; // 2 lines + 1 border-like spacer
        seqHeaderBox.left = lW + 1;
        seqHeaderBox.width = rW - 2;
        seqHeaderBox.top = 0;
        seqHeaderBox.height = headerH;
        seqPane.left = lW;
        seqPane.width = rW;
        seqPane.top = headerH;
        seqPane.height = rmH - headerH;
    } else if (logViewMode === "nodemap") {
        nodeMapPane.show();
        nodeMapPane.left = lW;
        nodeMapPane.width = rW;
        nodeMapPane.top = 0;
        nodeMapPane.height = rmH;
    } else {
        const panes = workerPaneOrder.map(n => workerPanes.get(n)).filter(Boolean);
        if (panes.length > 0) {
            const pH = Math.max(5, Math.floor(rmH / panes.length));
            for (let i = 0; i < panes.length; i++) {
                panes[i].show();
                panes[i].left = lW;
                panes[i].width = rW;
                panes[i].top = i * pH;
                panes[i].height = i === panes.length - 1 ? rmH - i * pH : pH;
            }
        }
    }
    screen.render();
}

function redrawActiveViews() {
    const _ph = perfStart("redrawActiveViews");
    if (logViewMode === "orchestration") {
        refreshOrchLogPane();
    } else if (logViewMode === "sequence") {
        refreshSeqPane();
    } else if (logViewMode === "nodemap") {
        refreshNodeMap();
    } else {
        recolorWorkerPanes();
    }
    relayoutAll();
    // No realloc here — it's expensive (full buffer wipe + re-render)
    // and causes a visible blank flash. Only use realloc on layout changes
    // (e.g. resize, view mode switch), not on session switches.
    screen.render();
    perfEnd(_ph);
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
registerFocusRing(inputBar, "green");

// Guard against double readInput — neo-blessed starts a new readInput on each
// focus() call when inputOnFocus=true. If the textbox is already focused and
// reading, calling focus() again starts a second reader that captures the same
// keystrokes, causing double characters. Wrap all inputBar.focus() calls.
function focusInput() {
    if (screen.focused === inputBar) return; // already focused & reading
    inputBar.focus();
}

// ─── Slash command picker ────────────────────────────────────────
const slashCommands = [
    { name: "/models",    desc: "List available models" },
    { name: "/model",     desc: "Switch model (e.g. /model gpt-4o)" },
    { name: "/info",      desc: "Show session info" },
    { name: "/done",      desc: "Complete and close this session" },
    { name: "/new",       desc: "Create a new session" },
    { name: "/help",      desc: "Show all commands" },
];

let slashPicker = null;

function showSlashPicker() {
    if (slashPicker) { slashPicker.detach(); slashPicker = null; }

    let selectedIdx = 0;

    const renderItems = () => slashCommands.map((c, i) => {
        const prefix = i === selectedIdx ? "{blue-bg}{white-fg}" : "";
        const suffix = i === selectedIdx ? "{/white-fg}{/blue-bg}" : "";
        return `${prefix}  {cyan-fg}${c.name}{/cyan-fg}  ${c.desc}  ${suffix}`;
    });

    slashPicker = blessed.box({
        parent: screen,
        bottom: 3,
        left: 1,
        width: 50,
        height: slashCommands.length + 2,
        border: { type: "line" },
        label: " {bold}commands{/bold} ",
        tags: true,
        content: renderItems().join("\n"),
        style: {
            border: { fg: "cyan" },
            fg: "white",
        },
    });

    const updatePicker = () => {
        slashPicker.setContent(renderItems().join("\n"));
        screen.render();
    };

    // Intercept keys on the screen while the picker is visible
    const pickerKeyHandler = (ch, key) => {
        if (!key) return;
        if (key.name === "up") {
            selectedIdx = Math.max(0, selectedIdx - 1);
            updatePicker();
        } else if (key.name === "down") {
            selectedIdx = Math.min(slashCommands.length - 1, selectedIdx + 1);
            updatePicker();
        } else if (key.name === "return" || key.name === "enter") {
            const cmd = slashCommands[selectedIdx];
            dismissSlashPicker();
            inputBar.setValue(cmd.name + (cmd.name === "/model" ? " " : ""));
            focusInput();
            screen.render();
            if (cmd.name !== "/model") {
                handleInput(cmd.name);
            }
        } else if (key.name === "escape") {
            dismissSlashPicker();
            focusInput();
            screen.render();
        } else {
            // Any other key dismisses the picker
            dismissSlashPicker();
            screen.render();
        }
    };

    slashPicker._pickerKeyHandler = pickerKeyHandler;
    screen.on("keypress", pickerKeyHandler);
    screen.render();
}

function dismissSlashPicker() {
    if (slashPicker) {
        if (slashPicker._pickerKeyHandler) {
            screen.removeListener("keypress", slashPicker._pickerKeyHandler);
        }
        slashPicker.detach();
        slashPicker = null;
        screen.render();
    }
}

// Alt+Backspace: delete word backwards in input bar
inputBar.on("keypress", (ch, key) => {
    if (!key) return;

    // Show slash command picker when "/" is typed into an empty input bar
    if (ch === "/" && inputBar.getValue() === "") {
        // Let the "/" stay in the input bar — don't clear it
        setImmediate(() => {
            showSlashPicker();
        });
        return;
    }

    // Alt+Backspace shows up as meta+backspace or as \x1B (escape char) + backspace
    const isAltBackspace = (key.meta && key.name === "backspace") ||
        (key.name === "backspace" && key.sequence === "\x1b\x7f");
    if (!isAltBackspace) return;

    const val = inputBar.getValue();
    // Find cursor position — neo-blessed textbox doesn't expose cursor,
    // so we assume cursor is at end (most common case)
    const before = val;
    // Delete backwards: strip trailing spaces, then strip non-space chars
    const trimmed = before.replace(/\s+$/, "");
    const wordRemoved = trimmed.replace(/\S+$/, "");
    inputBar.setValue(wordRemoved);
    screen.render();
});

// ─── Status bar (bottom of chat column, above input) ─────────────

const statusBar = blessed.box({
    parent: screen,
    bottom: 2,
    left: 1,
    width: leftW() - 2,
    height: 1,
    content: "",
    tags: true,
    style: { fg: "gray" },
});

relayoutAll();
screen.render();

// ─── Helpers ─────────────────────────────────────────────────────

let pendingUserInput = null;

function appendChat(text, orchId) {
    for (const line of text.split("\n")) {
        appendChatRaw(line, orchId);
    }
}

// ─── Coalesced screen rendering ──────────────────────────────────
// screen.render() is already coalesced by the frame loop (100ms interval).
// scheduleRender() is kept as a convenience alias.
function scheduleRender() {
    _screenDirty = true;
}

const MAX_CHAT_BUFFER_LINES = 500;

function appendChatRaw(text, orchId) {
    // Guard: during startup, sessionChatBuffers and activeOrchId may not be initialized yet
    let buffers, currentActive;
    try { buffers = sessionChatBuffers; } catch { return; }
    try { currentActive = activeOrchId; } catch { currentActive = undefined; }
    const targetOrch = orchId || currentActive || "_init";
    if (!buffers.has(targetOrch)) buffers.set(targetOrch, []);
    const buf = buffers.get(targetOrch);
    buf.push(text);

    // Cap buffer size — drop oldest lines when it grows too large
    if (buf.length > MAX_CHAT_BUFFER_LINES * 1.2) {
        const dropped = buf.length - MAX_CHAT_BUFFER_LINES;
        buf.splice(0, dropped);
        buf[0] = `{gray-fg}── ${dropped} older lines trimmed ──{/gray-fg}`;
    }

    // Mark chat dirty so the frame loop syncs buffer → chatBox
    if (currentActive && targetOrch === currentActive) {
        _chatDirty = true;
    }
}

function setStatus(text) {
    statusBar.setContent(`{white-fg}${text}{/white-fg}`);
    scheduleRender();
}

function appendLog(text) {
    // Route through appendChatRaw so it goes into the session buffer
    // and gets rendered by the frame loop (no direct chatBox.log)
    appendChatRaw(`{white-fg}${text}{/white-fg}`);
}

function appendWorkerLog(podName, text, orchId) {
    const pane = getOrCreateWorkerPane(podName);
    // Buffer raw entry for recoloring on session switch
    if (!workerLogBuffers.has(podName)) workerLogBuffers.set(podName, []);
    const buf = workerLogBuffers.get(podName);
    buf.push({ orchId, text });
    // Cap at 500 entries
    if (buf.length > 500) buf.splice(0, buf.length - 500);

    // In worker mode, highlight lines belonging to the active orchestration
    if (orchId && orchId === activeOrchId) {
        pane.log(`{bold}${text}{/bold}`);
    } else if (orchId) {
        pane.log(`{white-fg}${text}{/white-fg}`);
    } else {
        pane.log(text);
    }
    scheduleRender();
}

/**
 * Re-render all worker panes to highlight the current activeOrchId.
 * Called when switching sessions.
 */
function recolorWorkerPanes() {
    const _ph = perfStart("recolorWorkerPanes");
    const MAX_WORKER_RENDER_LINES = 120;
    let paneCount = 0;
    let totalLines = 0;
    for (const [podName, pane] of workerPanes) {
        const buf = workerLogBuffers.get(podName);
        pane.setContent("");
        pane.scrollTo(0);
        if (!buf || buf.length === 0) continue;
    }
    for (const [podName, pane] of workerPanes) {
        const buf = workerLogBuffers.get(podName);
        if (!buf || buf.length === 0) continue;
        paneCount++;
        const renderEntries = buf.length > MAX_WORKER_RENDER_LINES
            ? buf.slice(-MAX_WORKER_RENDER_LINES)
            : buf;
        totalLines += renderEntries.length;
        if (buf.length > MAX_WORKER_RENDER_LINES) {
            pane.log(`{gray-fg}… showing last ${MAX_WORKER_RENDER_LINES} of ${buf.length} lines …{/gray-fg}`);
        }
        for (const entry of renderEntries) {
            if (entry.orchId && entry.orchId === activeOrchId) {
                pane.log(`{bold}${entry.text}{/bold}`);
            } else if (entry.orchId) {
                pane.log(`{white-fg}${entry.text}{/white-fg}`);
            } else {
                pane.log(entry.text);
            }
        }
        pane.setScrollPerc(100);
    }
    screen.render();
    perfEnd(_ph, { panes: paneCount, lines: totalLines });
}

function showCopilotMessage(raw, orchId) {
    const _ph = perfStart("showCopilotMessage");
    const rendered = renderMarkdown(raw);
    const prefix = `{white-fg}[${ts()}]{/white-fg} {cyan-fg}{bold}Copilot:{/bold}{/cyan-fg}`;
    appendChatRaw(prefix, orchId);
    // Always show on separate lines for readability
    for (const line of rendered.split("\n")) {
        appendChatRaw(line, orchId);
    }
    appendChatRaw("", orchId); // blank line after each message

    // Auto-download any artifact SAS URLs in the message
    if (raw && ARTIFACT_SAS_RE.test(raw)) {
        ARTIFACT_SAS_RE.lastIndex = 0; // reset regex state
        downloadArtifactUrls(raw).catch(() => {});
    }
    perfEnd(_ph, { len: raw?.length || 0 });
}

// Track whether sequence view has been seeded from CMS for a session.
const seqCmsSeededSessions = new Set();

/**
 * Load conversation history from CMS and rebuild chat buffer for the session.
 * Includes ALL persisted events (not truncated) so switching sessions is deterministic.
 */
async function loadCmsHistory(orchId) {
    const _ph = perfStart("loadCmsHistory");
    const sid = orchId.startsWith("session-") ? orchId.slice(8) : orchId;
    let eventCount = 0;
    let loadFailed = false;

    // Skip if we already have a recent cached buffer.
    // The CMS poller handles incremental updates for the active session,
    // so reloading on every session switch just adds latency.
    const cached = sessionChatBuffers.get(orchId);
    const loadedAt = sessionHistoryLoadedAt.get(orchId) ?? 0;
    if (cached && cached.length > 1 && (Date.now() - loadedAt) < 30_000) {
        return;
    }

    // Ensure we have a PilotSwarmSession handle (may not exist for sessions from previous TUI runs)
    let sess = sessions.get(sid);
    if (!sess) {
        try {
            sess = await client.resumeSession(sid);
            sessions.set(sid, sess);
        } catch (err) {
            appendLog(`{yellow-fg}Could not resume session ${shortId(sid)}: ${err.message}{/yellow-fg}`);
            return;
        }
    }

    try {
        const CMS_HISTORY_FETCH_LIMIT = 250;
        const MAX_RENDERED_EVENTS = 120;
        const MAX_TOTAL_RENDER_CHARS = 50_000;
        const MAX_ASSISTANT_MESSAGE_CHARS = 4_000;
        const dc = getDc();

        // Fetch events, session info, and live status in parallel.
        // The live custom status may contain the latest `turnResult` even when
        // the CMS history does not yet have a persisted `assistant.message`.
        const [events, info, liveStatus] = await Promise.all([
            sess.getMessages(CMS_HISTORY_FETCH_LIMIT),
            (!sessionModels.has(orchId)) ? sess.getInfo().catch(() => null) : Promise.resolve(null),
            dc ? dc.getStatus(orchId).catch(() => null) : Promise.resolve(null),
        ]);
        eventCount = events?.length || 0;

        let liveCustomStatus = null;
        if (liveStatus?.customStatus) {
            try {
                liveCustomStatus = typeof liveStatus.customStatus === "string"
                    ? JSON.parse(liveStatus.customStatus)
                    : liveStatus.customStatus;
            } catch {}
        }

        const liveTurnContent = liveCustomStatus?.turnResult?.type === "completed"
            ? liveCustomStatus.turnResult.content
            : "";

        // Populate session model if not already known
        if (info?.model) {
            sessionModels.set(orchId, info.model);
            if (orchId === activeOrchId) updateChatLabel();
        }

        if ((!events || events.length === 0) && !liveTurnContent) {
            // Only blank the buffer if the observer hasn't already written
            // content into it. Otherwise we'd nuke live turn output that
            // arrived while we were fetching from CMS (race condition that
            // causes empty chat on first switch to a session).
            const existing = sessionChatBuffers.get(orchId);
            if (!existing || existing.length === 0) {
                sessionChatBuffers.set(orchId, []);
                if (orchId === activeOrchId) chatBox.setContent("");
            }
            return;
        }

        // Strip the [SYSTEM: Running on host ...] prefix from user prompts
        const stripHostPrefix = (text) => text?.replace(/^\[SYSTEM: Running on host "[^"]*"\.\]\n\n/, "") || text;

        // Filter out internal timer continuation prompts — these aren't real user messages
        const isTimerPrompt = (text) => /^The \d+ second wait is now complete\./i.test(text);

        const lines = [];
        const fmtTime = (value) => {
            if (!value) return "--:--:--";
            return new Date(value).toLocaleTimeString("en-GB", {
                hour12: false,
                hour: "2-digit",
                minute: "2-digit",
                second: "2-digit",
            });
        };
        const normalizeContent = (text) => (text || "").replace(/\r\n/g, "\n").trim();

        // Cap rendered events to the most recent N to keep switching fast.
        const renderEvents = (events || []).length > MAX_RENDERED_EVENTS
            ? events.slice(-MAX_RENDERED_EVENTS)
            : (events || []);
        const truncated = (events || []).length > MAX_RENDERED_EVENTS;

        // Build display lines from persisted events
        // Chat lines = user messages + assistant responses
        // Activity lines = tool calls, reasoning, status changes
        const activityLines = [];
        let renderedChars = 0;
        let lastAssistantContent = "";
        if (truncated) {
            lines.push(`{gray-fg}── ${events.length - MAX_RENDERED_EVENTS} older events omitted (${events.length} total) ──{/gray-fg}`);
            lines.push("");
        }
        for (const evt of renderEvents) {
            const type = evt.eventType;
            const timeStr = fmtTime(evt.createdAt);
            if (type === "user.message") {
                const content = stripHostPrefix(evt.data?.content);
                if (content && !content.startsWith("[SYSTEM:") && !isTimerPrompt(content)) {
                    lines.push(`{white-fg}[${timeStr}]{/white-fg} {bold}You:{/bold} ${content}`);
                }
            } else if (type === "assistant.message") {
                const content = evt.data?.content;
                if (content) {
                    lastAssistantContent = content;
                    if (renderedChars >= MAX_TOTAL_RENDER_CHARS) {
                        lines.push(`{gray-fg}── additional assistant output omitted to keep session switching fast ──{/gray-fg}`);
                        lines.push("");
                        break;
                    }
                    const clipped = content.length > MAX_ASSISTANT_MESSAGE_CHARS
                        ? content.slice(0, MAX_ASSISTANT_MESSAGE_CHARS) + "\n\n[output truncated in TUI history view]"
                        : content;
                    lines.push(`{white-fg}[${timeStr}]{/white-fg} {cyan-fg}{bold}Copilot:{/bold}{/cyan-fg}`);
                    const rendered = renderMarkdown(clipped);
                    renderedChars += clipped.length;
                    for (const line of rendered.split("\n")) {
                        lines.push(line);
                    }
                    lines.push("");
                }
            } else if (type === "tool.execution_start") {
                const toolName = evt.data?.toolName || "tool";
                const dsid = evt.data?.durableSessionId ? ` {gray-fg}[${shortId(evt.data.durableSessionId)}]{/gray-fg}` : "";
                activityLines.push(`{white-fg}[${timeStr}]{/white-fg} {yellow-fg}▶ ${toolName}{/yellow-fg}${dsid}`);
            } else if (type === "tool.execution_complete") {
                const toolName = evt.data?.toolName || "tool";
                activityLines.push(`{white-fg}[${timeStr}]{/white-fg} {green-fg}✓ ${toolName}{/green-fg}`);
            } else if (type === "abort" || type === "session.info" || type === "session.idle"
                || type === "session.usage_info" || type === "pending_messages.modified"
                || type === "assistant.usage") {
                // skip internal/noisy events
            } else {
                activityLines.push(`{white-fg}[${timeStr}] [${type}]{/white-fg}`);
            }
        }

        const normalizedLiveTurn = normalizeContent(liveTurnContent);
        const normalizedLastAssistant = normalizeContent(lastAssistantContent);
        const liveTurnMissingFromHistory = normalizedLiveTurn
            && normalizedLiveTurn !== normalizedLastAssistant;

        if (liveTurnMissingFromHistory) {
            if (lines.length > 0 && lines[lines.length - 1] !== "") {
                lines.push("");
            }
            lines.push("{gray-fg}── latest turn result recovered from live status ──{/gray-fg}");
            lines.push("");

            const clippedLiveTurn = liveTurnContent.length > MAX_ASSISTANT_MESSAGE_CHARS
                ? liveTurnContent.slice(0, MAX_ASSISTANT_MESSAGE_CHARS) + "\n\n[output truncated in TUI history view]"
                : liveTurnContent;
            lines.push(`{white-fg}[${fmtTime(Date.now())}]{/white-fg} {cyan-fg}{bold}Copilot:{/bold}{/cyan-fg}`);
            const renderedLiveTurn = renderMarkdown(clippedLiveTurn);
            renderedChars += clippedLiveTurn.length;
            for (const line of renderedLiveTurn.split("\n")) {
                lines.push(line);
            }
            lines.push("");
        }

        if (eventCount > 0) {
            lines.push(`{white-fg}── recent history loaded from database (${eventCount} events fetched) ──{/white-fg}`);
            lines.push("");
        }

        // For system sessions, preserve the splash banner at the top
        if (systemSessionIds.has(orchId)) {
            const existing = sessionChatBuffers.get(orchId);
            if (existing && existing.length > 0) {
                // Find the splash separator (the ━━━ line) — everything up to
                // and including the line after it is the splash
                const splashEndIdx = existing.findIndex(l => l.includes("━━━━━━━━━"));
                if (splashEndIdx >= 0) {
                    const splashLines = existing.slice(0, splashEndIdx + 2); // +2 to include separator + blank
                    lines.unshift(...splashLines);
                }
            }
        }

        sessionChatBuffers.set(orchId, lines);
        sessionActivityBuffers.set(orchId, activityLines);
        sessionHistoryLoadedAt.set(orchId, Date.now());

        if (orchId === activeOrchId) {
            // Let the frame loop sync this buffer to chatBox
            _chatDirty = true;
            _activityDirty = true;
        }

        // Seed sequence view from CMS when no live worker-log sequence exists yet.
        if (!seqCmsSeededSessions.has(orchId)) {
            const existingSeq = seqEventBuffers.get(orchId) ?? [];
            if (existingSeq.length === 0) {
                const cmsNode = addSeqNode("cms");
                const seeded = [];
                for (const evt of events) {
                    const t = fmtTime(evt.createdAt);
                    if (evt.eventType === "user.message") {
                        const txt = stripHostPrefix(evt.data?.content || "");
                        if (txt && !isTimerPrompt(txt)) {
                            seeded.push({ type: "user_msg_synth", time: t, orchNode: cmsNode, actNode: cmsNode, label: txt });
                        }
                    } else if (evt.eventType === "assistant.message") {
                        const txt = evt.data?.content || "";
                        if (txt) {
                            seeded.push({ type: "response", time: t, orchNode: cmsNode, actNode: cmsNode, snippet: txt.slice(0, 40) });
                        }
                    } else if (evt.eventType === "tool.execution_start") {
                        seeded.push({ type: "activity_start", time: t, orchNode: cmsNode, actNode: cmsNode });
                    }
                }
                if (seeded.length > 0) {
                    seqEventBuffers.set(orchId, seeded);
                }
            }
            seqCmsSeededSessions.add(orchId);
        }
    } catch (err) {
        loadFailed = true;
        appendLog(`{yellow-fg}CMS history load failed: ${err.message}{/yellow-fg}`);
    }
    perfEnd(_ph, { orchId: orchId.slice(0, 12), events: eventCount, err: loadFailed || undefined });
}

// ─── Start the PilotSwarm client (embedded workers + client) ────────

const store = process.env.DATABASE_URL || "sqlite::memory:";
const numWorkers = parseInt(process.env.WORKERS ?? "4", 10);
const isRemote = numWorkers === 0;

// Sweeper Agent settings (all configurable via env vars)
const SWEEPER_SCAN_INTERVAL = parseInt(process.env.SWEEPER_SCAN_INTERVAL ?? "60", 10);         // seconds between scans
const SWEEPER_GRACE_MINUTES = parseInt(process.env.SWEEPER_GRACE_MINUTES ?? "5", 10);          // minutes before cleanup
const SWEEPER_PRUNE_TERMINAL_MINUTES = parseInt(process.env.SWEEPER_PRUNE_TERMINAL_MINUTES ?? "5", 10); // delete terminal instances older than N minutes
const SWEEPER_KEEP_EXECUTIONS = parseInt(process.env.SWEEPER_KEEP_EXECUTIONS ?? "3", 10);      // keep last N executions per instance
const SWEEPER_PRUNE_INTERVAL = parseInt(process.env.SWEEPER_PRUNE_INTERVAL ?? "10", 10);       // prune every N scan iterations

if (isRemote) {
    screen.title = "PilotSwarm (Scaled — Remote Workers)";
    appendLog("{bold}Mode:{/bold} {magenta-fg}Scaled (AKS Workers){/magenta-fg}");
    appendLog(`{bold}Store:{/bold} {green-fg}Remote PostgreSQL{/green-fg}`);
    appendLog("{bold}Runtime:{/bold} {yellow-fg}AKS pods (remote){/yellow-fg}");
} else {
    screen.title = `PilotSwarm (${numWorkers} Embedded Workers)`;
    appendLog("{bold}Mode:{/bold} {magenta-fg}Scaled (Embedded Workers){/magenta-fg}");
    appendLog(`{bold}Store:{/bold} {green-fg}${store.includes("postgres") ? "Remote PostgreSQL" : store}{/green-fg}`);
    appendLog(`{bold}Workers:{/bold} {yellow-fg}${numWorkers} local runtimes{/yellow-fg}`);
}
appendLog("");

// 1. Start N worker runtimes (skip if WORKERS=0 for AKS mode)
const workers = [];
let modelProviders = null;
if (!isRemote) {
    // Redirect Rust tracing to a log file so it doesn't corrupt the TUI
    const logFile = "/tmp/duroxide-tui.log";
    try { fs.writeFileSync(logFile, ""); } catch {} // truncate
    try {
        const { initTracing } = createRequire(import.meta.url)("duroxide");
        initTracing({
            logFile,
            logLevel: process.env.LOG_LEVEL || "info",
            logFormat: "compact",
        });
    } catch {}

    // Suppress stdout/stderr noise from Rust runtime init ("ready initialized" etc.)
    const origStdoutWrite = process.stdout.write.bind(process.stdout);
    const origStderrWrite = process.stderr.write.bind(process.stderr);
    process.stdout.write = () => true;
    process.stderr.write = () => true;

    const WORKER_SYSTEM_MESSAGE = process.env._TUI_SYSTEM_MESSAGE || "You are a helpful assistant running in a durable execution environment. Be concise.\n\nCRITICAL RULES:\n1. You have a 'wait' tool. You MUST use it whenever you need to wait, pause, sleep, delay, poll, check back later, schedule a future action, or implement any recurring/periodic task.\n2. NEVER say you cannot wait or set timers. You CAN — use the 'wait' tool.\n3. NEVER use bash sleep, setTimeout, setInterval, cron, or any other timing mechanism.\n4. The 'wait' tool enables durable timers that survive process restarts and node migrations.\n5. For recurring tasks: use the 'wait' tool in a loop — complete the action, then call wait(seconds), then repeat.\n6. When the user asks you to produce a document, report, summary, or any content as a file:\n   a. Write it using write_artifact(filename, content) — this saves it to shared storage.\n   b. Then call export_artifact(filename) to generate a download URL for the user.\n   c. Share the download URL in your response so the TUI can auto-download it.\n   d. Other agents can read your artifacts using read_artifact(sessionId, filename).\n7. Prefer .md (Markdown) format for documents unless the user specifies otherwise.";

    // Plugin directories: env override or default to bundled plugin/
    const defaultPluginDir = path.resolve(__dirname, "..", "plugin");
    const pluginDirs = process.env.PLUGIN_DIRS
        ? process.env.PLUGIN_DIRS.split(",").map(d => d.trim()).filter(Boolean)
        : (fs.existsSync(defaultPluginDir) ? [defaultPluginDir] : []);

    // Load custom worker module (tools, config overrides)
    let workerModuleConfig = {};
    if (process.env._TUI_WORKER_MODULE) {
        try {
            const mod = await import(process.env._TUI_WORKER_MODULE);
            workerModuleConfig = mod.default || mod;
            if (workerModuleConfig.systemMessage) {
                // Worker module system message overrides default
            }
            appendLog(`Custom worker module loaded ✓`);
        } catch (err) {
            appendLog(`{red-fg}Failed to load worker module: ${err.message}{/red-fg}`);
        }
    }

    // Build custom LLM provider config from env vars
    const llmProvider = process.env.LLM_ENDPOINT ? {
        type: process.env.LLM_PROVIDER_TYPE || "openai",
        baseUrl: process.env.LLM_ENDPOINT,
        ...(process.env.LLM_API_KEY && { apiKey: process.env.LLM_API_KEY }),
        ...(process.env.LLM_PROVIDER_TYPE === "azure" && {
            azure: { apiVersion: process.env.LLM_API_VERSION || "2024-10-21" },
        }),
    } : undefined;

    setStatus(`Starting ${numWorkers} workers...`);
    for (let i = 0; i < numWorkers; i++) {
        const w = new PilotSwarmWorker({
            store,
            githubToken: process.env.GITHUB_TOKEN,
            logLevel: process.env.LOG_LEVEL || "error",
            blobConnectionString: workerModuleConfig.blobConnectionString || process.env.AZURE_STORAGE_CONNECTION_STRING,
            blobContainer: process.env.AZURE_STORAGE_CONTAINER || "copilot-sessions",
            workerNodeId: `local-rt-${i}`,
            systemMessage: workerModuleConfig.systemMessage || WORKER_SYSTEM_MESSAGE,
            pluginDirs,
            ...(llmProvider && { provider: llmProvider }),
            ...(workerModuleConfig.skillDirectories && { skillDirectories: workerModuleConfig.skillDirectories }),
            ...(workerModuleConfig.customAgents && { customAgents: workerModuleConfig.customAgents }),
            ...(workerModuleConfig.mcpServers && { mcpServers: workerModuleConfig.mcpServers }),
        });
        // Register custom tools from worker module
        if (workerModuleConfig.tools?.length) {
            w.registerTools(workerModuleConfig.tools);
        }
        await w.start();
        workers.push(w);
        appendLog(`Worker local-rt-${i} started ✓`);
    }

    // Capture model provider registry from the first worker
    modelProviders = workers[0]?.modelProviders || null;
    if (modelProviders) {
        const byProvider = modelProviders.getModelsByProvider();
        for (const g of byProvider) {
            const names = g.models.map(m => m.qualifiedName).join(", ");
            appendLog(`{bold}${g.providerId}{/bold} (${g.type}): ${names}`);
        }
        // Use default model from registry if no explicit override
        if (modelProviders.defaultModel && !currentModel) {
            currentModel = modelProviders.defaultModel;
        }
    }

    // Restore stdout/stderr after all workers initialized
    process.stdout.write = origStdoutWrite;
    // Keep stderr intercepted — MCP subprocesses (filesystem server, etc.) write
    // warnings (ExperimentalWarning: SQLite, etc.) that corrupt the TUI.
    // Route them to the log file instead of the terminal.
    const logFd = fs.openSync(logFile, "a");
    process.stderr.write = (chunk, encoding, cb) => {
        try { fs.appendFileSync(logFd, chunk); } catch {}
        if (typeof cb === "function") cb();
        return true;
    };

    // Rust native code writes directly to fd 1/2 during init, bypassing Node
    // and corrupting blessed's alt-screen buffer. Wipe the terminal and force
    // blessed to fully repaint from scratch.
    process.stdout.write("\x1b[2J\x1b[H");
    screen.realloc();
    screen.render();

    // Tail the log file into per-worker panes
    let tailPos = 0;
    const instanceToWorker = new Map(); // instance_id → last known worker pane name
    let tailReads = 0;
    setInterval(() => {
        try {
            const stat = fs.statSync(logFile);
            if (stat.size <= tailPos) return;
            const fd = fs.openSync(logFile, "r");
            const buf = Buffer.alloc(stat.size - tailPos);
            fs.readSync(fd, buf, 0, buf.length, tailPos);
            fs.closeSync(fd);
            tailPos = stat.size;
            const chunk = buf.toString("utf8");
            // Split on timestamp boundaries — compact tracing format may not
            // always emit trailing newlines between entries.
            const entries = chunk.split(/(?=(?:\x1b\[[0-9;]*m)*\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z)/);
            let routed = 0;
            // eslint-disable-next-line no-control-regex
            const ansiRe = /\x1b\[[0-9;]*m/g;
            for (const line of entries) {
                const trimmed = line.replace(/\n/g, " ").trim();
                if (!trimmed) continue;
                // Strip ANSI color codes before matching (compact format adds colors)
                const plain = trimmed.replace(ansiRe, "");
                // Extract worker_id from activity logs (e.g., worker_id=work-1-local-rt-0)
                const wMatch = plain.match(/worker_id=\S*?(local-rt-\d+)/);
                let paneName = wMatch ? wMatch[1] : null;

                // Extract instance_id to correlate orchestration logs with their worker
                const iMatch = plain.match(/instance_id=(\S+)/);
                const instanceId = iMatch ? iMatch[1] : null;

                if (paneName && instanceId) {
                    // Activity log — remember which worker handles this instance
                    instanceToWorker.set(instanceId, paneName);
                } else if (!paneName && instanceId) {
                    // Orchestration log — route to the worker that last ran an activity for this instance
                    paneName = instanceToWorker.get(instanceId) || null;
                }

                if (!paneName) continue; // skip unroutable lines

                const orchId = instanceId ? instanceId.replace(/,.*$/, "") : null;

                // Color orchestration vs activity differently
                let formatted;
                // Escape curly braces so blessed doesn't misinterpret them as tags
                const escaped = plain.replace(/\{/g, "(").replace(/\}/g, ")");
                const isOrch = plain.includes("duroxide::orchestration");
                const isActivity = plain.includes("duroxide::activity");
                if (isOrch) {
                    formatted = escaped
                        .replace(/\bWARN\b/g, "{yellow-fg}WARN{/yellow-fg}")
                        .replace(/\bERROR\b/g, "{red-fg}ERROR{/red-fg}")
                        .replace(/\bINFO\b/g, "{magenta-fg}INFO{/magenta-fg}");
                    formatted = `{magenta-fg}\u25c6{/magenta-fg} ${formatted}`;
                } else if (isActivity) {
                    formatted = escaped
                        .replace(/\bWARN\b/g, "{yellow-fg}WARN{/yellow-fg}")
                        .replace(/\bERROR\b/g, "{red-fg}ERROR{/red-fg}")
                        .replace(/\bINFO\b/g, "{blue-fg}INFO{/blue-fg}");
                    formatted = `{blue-fg}\u25cf{/blue-fg} ${formatted}`;
                } else {
                    formatted = escaped
                        .replace(/\bWARN\b/g, "{yellow-fg}WARN{/yellow-fg}")
                        .replace(/\bERROR\b/g, "{red-fg}ERROR{/red-fg}")
                        .replace(/\bINFO\b/g, "{green-fg}INFO{/green-fg}");
                }

                appendWorkerLog(paneName, formatted, orchId);

                // Also buffer per-orchestration
                if (orchId && orchId.startsWith("session-")) {
                    appendOrchLog(orchId, paneName, formatted);
                }

                // Feed sequence diagram
                const seqEvtLocal = parseSeqEvent(plain, paneName);
                if (seqEvtLocal) {
                    appendSeqEvent(seqEvtLocal.orchId, seqEvtLocal);
                }
                routed++;
            }
            tailReads++;
            screen.render();
        } catch (e) {
            appendLog(`{red-fg}Log tail error: ${e.message}{/red-fg}`);
        }
    }, 500);
}

// ─── Model selection ─────────────────────────────────────────────
// Default model — prefer registry defaultModel, env override, then empty (worker picks default).
let currentModel = process.env.COPILOT_MODEL || "";

// In remote mode (no local workers), load model_providers.json directly
// so the TUI can show model lists and the Shift+N picker.
// In remote mode (no local workers), load model info from mgmt client after start.
// modelProviders variable is kept for backward compat with existing rendering code,
// but now backed by the management client instead of direct implementation import.
if (!modelProviders) {
    // Will be populated from mgmt.getModelsByProvider() after mgmt.start()
}

// 2. Start the thin client (for creating orchestrations / reading status)
const client = new PilotSwarmClient({
    store,
    blobEnabled: true,
});

// 3. Start the management client (for session listing, admin, models)
const mgmt = new PilotSwarmManagementClient({
    store,
});

setStatus(isRemote ? "Connecting to remote DB..." : "Connecting client...");

// Show splash immediately so the user sees something during DB connection
chatBox.setContent([
    "{bold}{cyan-fg}",
    "    ____  _ __      __  _____                              ",
    "   / __ \\(_) /___  / /_/ ___/      ______ __________ ___  ",
    "{/cyan-fg}{magenta-fg}  / /_/ / / / __ \\/ __/\\__ \\ | /| / / __ `/ ___/ __ `__ \\",
    " / ____/ / / /_/ / /_ ___/ / |/ |/ / /_/ / /  / / / / / /{/magenta-fg}",
    "{yellow-fg}/_/   /_/_/\\____/\\__//____/|__/|__/\\__,_/_/  /_/ /_/ /_/ {/yellow-fg}",
    "{/bold}",
    "",
    "  {bold}{white-fg}Durable AI Agent Orchestration{/white-fg}{/bold}",
    "  {cyan-fg}Crash recovery{/cyan-fg} · {magenta-fg}Durable timers{/magenta-fg} · {yellow-fg}Sub-agents{/yellow-fg} · {green-fg}Multi-node scaling{/green-fg}",
    "  {gray-fg}Powered by duroxide + GitHub Copilot SDK{/gray-fg}",
    "",
    "  {white-fg}Connecting...{/white-fg}",
].join("\n"));
_origRender();

// Start both clients in parallel — they each open their own PG pool
const _startPh = perfStart("startup.clientConnect");
await Promise.all([client.start(), mgmt.start()]);
perfEnd(_startPh);

// Populate model info from management client
if (!modelProviders) {
    const mgmtModels = mgmt.getModelsByProvider();
    if (mgmtModels.length > 0) {
        // Create a lightweight modelProviders-compatible object for existing TUI code
        modelProviders = {
            getModelsByProvider: () => mgmtModels,
            get allModels() { return mgmt.listModels(); },
            get defaultModel() { return mgmt.getDefaultModel(); },
            normalize: (ref) => mgmt.normalizeModel(ref),
        };
        for (const g of mgmtModels) {
            const names = g.models.map(m => m.qualifiedName).join(", ");
            appendLog(`{bold}${g.providerId}{/bold} (${g.type}): ${names}`);
        }
        if (modelProviders.defaultModel && !currentModel) {
            currentModel = modelProviders.defaultModel;
        }
    }
}

setStatus("Ready — type a message");
appendLog(isRemote
    ? "Client connected ✓ {white-fg}(no local runtime){/white-fg}"
    : `Client connected ✓ {white-fg}(${numWorkers} embedded workers){/white-fg}`);

// ─── Orchestrations tracking ─────────────────────────────────────

// Declare activeOrchId early so functions referenced during startup
// (appendWorkerLog, recolorWorkerPanes, frame loop) can access it
// without a temporal dead zone error. Assigned properly after session setup.
let activeOrchId = "";
let activeSessionShort = "";

const knownOrchestrationIds = new Set();
let orchStatusCache = new Map(); // id → { status, createdAt }
let orchIdOrder = []; // IDs in display order (matches orchList items)
const orchLastSeenVersion = new Map(); // id → customStatusVersion last seen by user
const orchHasChanges = new Set(); // IDs with unseen changes
const sessionHeadings = new Map(); // orchId → short heading from LLM
const sessionSummaryBuffer = new Map(); // orchId → buffered summary text to show on switch
const sessionSummarized = new Set(); // orchIds already summarized (avoid re-asking)
const systemSessionIds = new Set(); // orchIds of system sessions (e.g. Sweeper Agent)

// Per-session chat buffers — every observer writes here so content is preserved on switch
const sessionChatBuffers = new Map(); // orchId → string[]
const sessionHistoryLoadedAt = new Map(); // orchId → epoch ms of last CMS history load
const sessionObservers = new Map(); // orchId → AbortController
const sessionLiveStatus = new Map(); // orchId → "idle"|"running"|"waiting"|"input_required"

// Facade: adapts PilotSwarmManagementClient to the dc-like interface
// that the observer and legacy code paths expect. This eliminates
// direct private client access while keeping existing call sites working.
let _dcFacade = null;
function getDc() {
    if (_dcFacade) return _dcFacade;
    _dcFacade = {
        async getStatus(orchId) {
            const sid = orchId.startsWith("session-") ? orchId.slice(8) : orchId;
            const result = await mgmt.getSessionStatus(sid);
            return {
                status: result.orchestrationStatus,
                customStatus: result.customStatus ? JSON.stringify(result.customStatus) : null,
                customStatusVersion: result.customStatusVersion,
            };
        },
        async getInstanceInfo(orchId) {
            const sid = orchId.startsWith("session-") ? orchId.slice(8) : orchId;
            const result = await mgmt.getSessionStatus(sid);
            return {
                status: result.orchestrationStatus || "Unknown",
                createdAt: 0,
            };
        },
        async waitForStatusChange(orchId, afterVersion, pollMs, timeoutMs) {
            const sid = orchId.startsWith("session-") ? orchId.slice(8) : orchId;
            const result = await mgmt.waitForStatusChange(sid, afterVersion, pollMs, timeoutMs);
            return {
                status: result.orchestrationStatus,
                customStatus: result.customStatus ? JSON.stringify(result.customStatus) : null,
                customStatusVersion: result.customStatusVersion,
            };
        },
        async enqueueEvent(orchId, eventName, data) {
            const sid = orchId.startsWith("session-") ? orchId.slice(8) : orchId;
            const parsed = JSON.parse(data);
            if (parsed.type === "cmd") {
                await mgmt.sendCommand(sid, { cmd: parsed.cmd, id: parsed.id, args: parsed.args });
            } else if (parsed.answer != null) {
                await mgmt.sendAnswer(sid, parsed.answer);
            } else if (parsed.prompt != null) {
                await mgmt.sendMessage(sid, parsed.prompt);
            }
        },
        async cancelInstance(orchId, reason) {
            const sid = orchId.startsWith("session-") ? orchId.slice(8) : orchId;
            await mgmt.cancelSession(sid, reason);
        },
        async deleteInstance(orchId) {
            const sid = orchId.startsWith("session-") ? orchId.slice(8) : orchId;
            await mgmt.deleteSession(sid);
        },
        async listAllInstances() {
            const views = await mgmt.listSessions();
            return views.map(v => `session-${v.sessionId}`);
        },
    };
    return _dcFacade;
}

// ─── Debounced refresh ───────────────────────────────────────────
// Multiple observers fire updateLiveStatus rapidly — coalesce into one
// refreshOrchestrations() call per 500ms window.
let _refreshPending = false;
let _refreshRunning = false;
function scheduleRefreshOrchestrations() {
    if (_refreshPending) return;
    _refreshPending = true;
    setTimeout(async () => {
        _refreshPending = false;
        if (_refreshRunning) return; // skip if previous call still in-flight
        _refreshRunning = true;
        try {
            await refreshOrchestrations();
        } finally {
            _refreshRunning = false;
        }
    }, 500);
}

// Lightweight status update — just updates the icon in the list without
// hitting the database. Full refresh happens on the debounced schedule.
function updateSessionListIcons() {
    const _ph = perfStart("updateSessionListIcons");
    if (orchIdOrder.length === 0) { perfEnd(_ph, { n: 0 }); return; }
    for (let i = 0; i < orchIdOrder.length; i++) {
        const id = orchIdOrder[i];
        const liveStatus = sessionLiveStatus.get(id);
        const cached = orchStatusCache.get(id);
        const status = cached?.status || "Unknown";
        let statusIcon = "";
        if (status === "Completed" || status === "Failed" || status === "Terminated") {
            statusIcon = "";
        } else if (liveStatus === "running") {
            statusIcon = "{green-fg}*{/green-fg}";
        } else if (liveStatus === "error") {
            statusIcon = "{red-fg}!{/red-fg}";
        } else if (liveStatus === "waiting") {
            statusIcon = "{blue-fg}~{/blue-fg}";
        } else if (liveStatus === "input_required") {
            statusIcon = "{magenta-fg}?{/magenta-fg}";
        } else if (liveStatus === "idle") {
            statusIcon = "{white-fg}z{/white-fg}";
        }

        // Rebuild just this item's label
        const uuid4 = shortId(id);
        const createdAt = cached?.createdAt || 0;
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

        const hasChanges = orchHasChanges.has(id);
        const isActive = id === activeOrchId;
        const marker = isActive ? "{bold}▸{/bold}" : " ";
        const changeDot = hasChanges ? "{cyan-fg}{bold}●{/bold}{/cyan-fg} " : "";
        const heading = sessionHeadings.get(id);
        // Use cached depth from last full refresh
        const depth = orchDepthMap?.get(id) ?? 0;
        const indent = depth > 0 ? "  ".repeat(depth - 1) + "└ " : "";

        // System sessions get special rendering: yellow, ≋ icon
        if (systemSessionIds.has(id)) {
            const sysLabel = heading
                ? `${heading} (${uuid4}) ${timeStr}`
                : `Sweeper Agent (${uuid4}) ${timeStr}`;
            orchList.setItem(i, `${marker}${changeDot}{bold}{yellow-fg}≋ ${sysLabel}{/yellow-fg}{/bold}`);
        } else {
            const label = heading
                ? `${heading} (${uuid4}) ${timeStr}`
                : `(${uuid4}) ${timeStr}`;
            orchList.setItem(i, `${indent}${marker}${changeDot}${statusIcon ? statusIcon + " " : ""}{${color}-fg}${label}{/${color}-fg}`);
        }
    }
    perfEnd(_ph, { n: orchIdOrder.length });
    scheduleRender();
}

// Cache depth per orchId from last full refresh so lightweight update can use them
let orchDepthMap = new Map();

async function refreshOrchestrations() {
    const _ph = perfStart("refreshOrchestrations");

    // Fetch merged session views from the management client
    let sessionViews;
    try {
        sessionViews = await mgmt.listSessions();
    } catch (err) {
        appendLog(`{red-fg}listSessions failed: ${err.message}{/red-fg}`);
        perfEnd(_ph, { sessions: 0, err: true });
        return;
    }

    const entries = [];
    const childToParent = new Map(); // orchId → parentOrchId

    for (const sv of sessionViews) {
        const id = `session-${sv.sessionId}`;
        const createdAt = sv.createdAt || 0;
        const csvVersion = sv.statusVersion || 0;

        // Map CMS live status → display status for color coding.
        // With the CMS-only listSessions() path, sv.orchestrationStatus
        // is undefined. Use sv.status (the CMS-mirrored live state) instead.
        const liveState = sv.status || "pending";
        let status = "Unknown";
        if (liveState === "running") status = "Running";
        else if (liveState === "completed") status = "Completed";
        else if (liveState === "failed") status = "Failed";
        else if (liveState === "error") status = "Failed";
        else if (liveState === "idle") status = "Running"; // idle = alive orchestration
        else if (liveState === "waiting") status = "Running";
        else if (liveState === "input_required") status = "Running";
        else if (liveState === "pending") status = "Running";

        orchStatusCache.set(id, { status, createdAt });
        knownOrchestrationIds.add(id);

        // Detect changes: if version advanced since last time user viewed this session
        const lastSeen = orchLastSeenVersion.get(id) ?? 0;
        if (csvVersion > lastSeen && id !== activeOrchId) {
            orchHasChanges.add(id);
        }
        if (id === activeOrchId) {
            orchLastSeenVersion.set(id, csvVersion);
            orchHasChanges.delete(id);
        }

        // Track titles, parents, system sessions
        if (sv.title) {
            sessionHeadings.set(id, sv.title);
        }
        if (sv.parentSessionId) {
            childToParent.set(id, `session-${sv.parentSessionId}`);
        }
        if (sv.isSystem) {
            systemSessionIds.add(id);
            if (sv.title) sessionHeadings.set(id, sv.title);
        }

        // Seed sessionLiveStatus from CMS if no observer has set it yet.
        // This ensures status icons show correctly on initial load.
        if (!sessionLiveStatus.has(id) && liveState && liveState !== "pending") {
            sessionLiveStatus.set(id, liveState);
        }

        entries.push({ id, status, createdAt });
    }

    // Sort by createdAt descending (stable — no status-based reordering)
    entries.sort((a, b) => b.createdAt - a.createdAt);

    // Build tree: compute depth for each entry via parent chain
    // depth 0 = root, 1 = child, 2 = grandchild, etc.
    function computeDepth(id) {
        let depth = 0;
        let cur = id;
        while (childToParent.has(cur)) {
            cur = childToParent.get(cur);
            depth++;
            if (depth > 10) break; // safety: avoid infinite loops
        }
        return depth;
    }

    // Recursive tree builder: insert node then its children (depth-first)
    const childrenOf = new Map(); // parentId → [childEntries]
    for (const e of entries) {
        const parentId = childToParent.get(e.id);
        if (parentId) {
            if (!childrenOf.has(parentId)) childrenOf.set(parentId, []);
            childrenOf.get(parentId).push(e);
        }
    }
    const rootEntries = entries.filter(e => !childToParent.has(e.id));
    const orderedEntries = [];
    // System sessions go first (sorted among themselves by createdAt)
    const systemRoots = rootEntries.filter(e => systemSessionIds.has(e.id));
    const normalRoots = rootEntries.filter(e => !systemSessionIds.has(e.id));
    function insertTree(entry, depth) {
        orderedEntries.push({ ...entry, depth });
        const children = childrenOf.get(entry.id) || [];
        for (const child of children) {
            insertTree(child, depth + 1);
        }
    }
    for (const root of systemRoots) {
        insertTree(root, 0);
    }
    for (const root of normalRoots) {
        insertTree(root, 0);
    }
    // Orphan entries whose parent is not in the list
    const orderedIds = new Set(orderedEntries.map(e => e.id));
    for (const e of entries) {
        if (!orderedIds.has(e.id)) {
            orderedEntries.push({ ...e, depth: computeDepth(e.id) });
        }
    }

    // Rebuild ordered ID list to match display order
    orchIdOrder = orderedEntries.map(e => e.id);
    // Cache depth per orchId for lightweight icon updates
    orchDepthMap = new Map(orderedEntries.map(e => [e.id, e.depth]));

    // Update the blessed list — clear and re-add items
    const prevSelected = orchList.selected || 0;
    const prevSelectedId = orchIdOrder[prevSelected] || activeOrchId;
    const prevScrollTop = orchList.childBase || 0;
    orchList.clearItems();
    if (entries.length === 0) {
        orchList.addItem("{white-fg}  Press {yellow-fg}n{/yellow-fg} to start a new session{/white-fg}");
    } else {
        for (const { id, status, createdAt, depth } of orderedEntries) {
            // 4-char UUID fragment + time started
            const uuid4 = shortId(id);
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

            // Live status indicator
            const liveStatus = sessionLiveStatus.get(id);
            let statusIcon = "";
            if (status === "Completed" || status === "Failed" || status === "Terminated") {
                statusIcon = ""; // no icon for terminal states
            } else if (liveStatus === "running") {
                statusIcon = "{green-fg}*{/green-fg}";
            } else if (liveStatus === "error") {
                statusIcon = "{red-fg}!{/red-fg}";
            } else if (liveStatus === "waiting") {
                statusIcon = "{blue-fg}~{/blue-fg}";
            } else if (liveStatus === "input_required") {
                statusIcon = "{magenta-fg}?{/magenta-fg}";
            } else if (liveStatus === "idle") {
                statusIcon = "{white-fg}z{/white-fg}";
            }

            const heading = sessionHeadings.get(id);
            const indent = depth > 0 ? "  ".repeat(depth - 1) + "└ " : "";

            // System sessions get special rendering: yellow, ≋ icon
            if (systemSessionIds.has(id)) {
                const sysLabel = heading
                    ? `${heading} (${uuid4}) ${timeStr}`
                    : `Sweeper Agent (${uuid4}) ${timeStr}`;
                orchList.addItem(`${marker}${changeDot}{bold}{yellow-fg}≋ ${sysLabel}{/yellow-fg}{/bold}`);
            } else {
                const label = heading
                    ? `${heading} (${uuid4}) ${timeStr}`
                    : `(${uuid4}) ${timeStr}`;
                orchList.addItem(`${indent}${marker}${changeDot}${statusIcon ? statusIcon + " " : ""}{${color}-fg}${label}{/${color}-fg}`);
            }
        }
        // Show hint if there are only system sessions (no user sessions)
        const hasUserSessions = orderedEntries.some(e => !systemSessionIds.has(e.id));
        if (!hasUserSessions) {
            orchList.addItem("");
            orchList.addItem("{white-fg}  Press {yellow-fg}n{/yellow-fg} to start a new session{/white-fg}");
        }
    }
    // Restore cursor position — keep the user's selection stable.
    // Only jump to activeOrchId when it was *just* changed (e.g. Enter / n).
    if (orchSelectFollowActive) {
        const activeIdx = orchIdOrder.indexOf(activeOrchId);
        if (activeIdx >= 0) {
            orchList.select(activeIdx);
            // Scroll so the active item is visible but not forced to top.
            // Only scroll if the item is out of the visible range.
            const visibleHeight = orchList.height - 2; // minus borders
            if (activeIdx < prevScrollTop || activeIdx >= prevScrollTop + visibleHeight) {
                // Center it in the viewport
                orchList.scrollTo(Math.max(0, activeIdx - Math.floor(visibleHeight / 2)));
            } else {
                orchList.scrollTo(prevScrollTop);
            }
        } else {
            orchList.select(Math.min(prevSelected, orchIdOrder.length - 1));
            orchList.scrollTo(prevScrollTop);
        }
        orchSelectFollowActive = false;
    } else {
        const restoreIdx = orchIdOrder.indexOf(prevSelectedId);
        if (restoreIdx >= 0) {
            orchList.select(restoreIdx);
        } else {
            orchList.select(Math.min(prevSelected, orchIdOrder.length - 1));
        }
        // Restore scroll offset so the list doesn't jump
        orchList.scrollTo(prevScrollTop);
    }
    screen.render();

    // Start observers for any sessions that don't have one yet
    for (const { id, status } of entries) {
        if (!sessionObservers.has(id) && status !== "Completed" && status !== "Failed" && status !== "Terminated") {
            startObserver(id);
        }
    }
    perfEnd(_ph, { sessions: entries.length });
}

// Poll orchestrations every 10 seconds (observers handle live status updates, so
// this only needs to catch new sessions and structural changes like title/parent).
let orchPollTimer = setInterval(() => {
    scheduleRefreshOrchestrations();
    if (logViewMode === "nodemap") refreshNodeMap();
}, 10_000);

// Periodic perf summary — every 30s log memory + buffer sizes
setInterval(() => {
    const mem = process.memoryUsage();
    let totalBufferLines = 0;
    let totalBufferBytes = 0;
    for (const [, lines] of sessionChatBuffers) {
        totalBufferLines += lines.length;
        for (const l of lines) totalBufferBytes += l.length;
    }
    let totalSeqEvents = 0;
    for (const [, evts] of seqEventBuffers) totalSeqEvents += evts.length;
    perfTrace("periodic_summary", {
        heapUsedMB: +(mem.heapUsed / 1024 / 1024).toFixed(1),
        heapTotalMB: +(mem.heapTotal / 1024 / 1024).toFixed(1),
        rssMB: +(mem.rss / 1024 / 1024).toFixed(1),
        chatBuffers: sessionChatBuffers.size,
        chatBufferLines: totalBufferLines,
        chatBufferKB: +(totalBufferBytes / 1024).toFixed(1),
        seqBuffers: seqEventBuffers.size,
        seqEvents: totalSeqEvents,
        observers: sessionObservers.size,
        renders: _perfRenderCount,
        renderAvgMs: +(_perfRenderTotalMs / Math.max(1, _perfRenderCount)).toFixed(2),
    });
}, 30_000);

// Orchestrations panel key handlers
orchList.key(["q"], () => {
    cleanup().then(() => process.exit(0));
});

orchList.key(["c"], async () => {
    const idx = orchList.selected;
    if (idx >= 0 && idx < orchIdOrder.length) {
        const id = orchIdOrder[idx];
        if (systemSessionIds.has(id)) {
            appendLog("{yellow-fg}Cannot cancel system session{/yellow-fg}");
            return;
        }
        const sessionId = id.startsWith("session-") ? id.slice(8) : id;
        try {
            await mgmt.cancelSession(sessionId);
            appendLog(`{yellow-fg}Cancelled ${shortId(id)}{/yellow-fg}`);
            await refreshOrchestrations();
        } catch (err) {
            appendLog(`{red-fg}Cancel failed: ${err.message}{/red-fg}`);
        }
    }
});

orchList.key(["d"], async () => {
    const idx = orchList.selected;
    if (idx >= 0 && idx < orchIdOrder.length) {
        const id = orchIdOrder[idx];
        if (systemSessionIds.has(id)) {
            appendLog("{yellow-fg}Cannot delete system session{/yellow-fg}");
            return;
        }
        const sessionId = id.startsWith("session-") ? id.slice(8) : id;
        try {
            await mgmt.deleteSession(sessionId);
            knownOrchestrationIds.delete(id);
            orchStatusCache.delete(id);
            appendLog(`{yellow-fg}Deleted ${shortId(id)}{/yellow-fg}`);
            await refreshOrchestrations();
        } catch (err) {
            appendLog(`{red-fg}Delete failed: ${err.message}{/red-fg}`);
        }
    }
});

orchList.key(["r"], async () => {
    appendLog("{white-fg}Refreshing…{/white-fg}");
    await refreshOrchestrations();
});

orchList.key(["enter"], async () => {
    const idx = orchList.selected;
    if (idx >= 0 && idx < orchIdOrder.length) {
        await switchToOrchestration(orchIdOrder[idx]);
        screen.render();
    }
});

orchList.key(["n"], async () => {
    try {
        const sess = await createNewSession();
        const orchId = `session-${sess.sessionId}`;
        knownOrchestrationIds.add(orchId);
        appendLog(`{green-fg}New session: ${shortId(sess.sessionId)}…{/green-fg}`);
        await switchToOrchestration(orchId);
        await refreshOrchestrations();
        // Focus prompt so user can type immediately
        focusInput();
        screen.render();
    } catch (err) {
        appendLog(`{red-fg}Create failed: ${err.message}{/red-fg}`);
    }
});

// ── New session with model picker (Shift+N) ──────────────────────
orchList.key(["S-n"], async () => {
    if (!modelProviders) {
        appendLog("{yellow-fg}No model providers configured — using default.{/yellow-fg}");
        orchList.emit("keypress", "n", { name: "n" });
        return;
    }

    // Build items grouped by provider
    const items = [];
    const modelMap = new Map(); // index → qualifiedName
    const byProvider = modelProviders.getModelsByProvider();
    for (const group of byProvider) {
        items.push(`{bold}{white-fg}── ${group.providerId} (${group.type}) ──{/white-fg}{/bold}`);
        modelMap.set(items.length - 1, null); // header row
        for (const m of group.models) {
            const costTag = m.cost ? ` [${m.cost}]` : "";
            const marker = m.qualifiedName === currentModel ? " ← default" : "";
            items.push(`  ${m.modelName}${costTag}${marker}`);
            modelMap.set(items.length - 1, m.qualifiedName);
        }
    }

    const picker = blessed.list({
        parent: screen,
        label: " {bold}Select model for new session{/bold} ",
        tags: true,
        top: "center",
        left: "center",
        width: "60%",
        height: Math.min(items.length + 4, 20),
        border: { type: "line" },
        style: {
            border: { fg: "cyan" },
            selected: { bg: "cyan", fg: "black", bold: true },
            item: { fg: "white" },
        },
        items,
        keys: true,
        vi: true,
        mouse: true,
        scrollable: true,
    });
    picker.focus();
    screen.render();

    picker.on("select", async (item, index) => {
        const qualified = modelMap.get(index);
        picker.detach();
        screen.render();
        if (!qualified) return; // header row selected

        try {
            // Temporarily override currentModel for this session
            const prevModel = currentModel;
            currentModel = qualified;
            const sess = await createNewSession();
            currentModel = prevModel; // restore default
            const orchId = `session-${sess.sessionId}`;
            knownOrchestrationIds.add(orchId);
            appendLog(`{green-fg}New session (${qualified}): ${shortId(sess.sessionId)}…{/green-fg}`);
            await switchToOrchestration(orchId);
            await refreshOrchestrations();
            focusInput();
            screen.render();
        } catch (err) {
            appendLog(`{red-fg}Create failed: ${err.message}{/red-fg}`);
        }
    });

    picker.key(["escape", "q"], () => {
        picker.detach();
        orchList.focus();
        screen.render();
    });
});

// ── Title rename ─────────────────────────────────────────────────
// Shows a choice: type a custom title or ask the LLM to summarize.
orchList.key(["t"], async () => {
    const idx = orchList.selected;
    if (idx < 0 || idx >= orchIdOrder.length) return;
    const orchId = orchIdOrder[idx];
    const sessionId = orchId.startsWith("session-") ? orchId.slice(8) : orchId;
    const uuid4 = shortId(sessionId);

    // Show a choice list
    const choiceList = blessed.list({
        parent: screen,
        label: ` {bold}Rename (${uuid4}){/bold} `,
        tags: true,
        top: "center",
        left: "center",
        width: 40,
        height: 8,
        border: { type: "line" },
        style: {
            border: { fg: "cyan" },
            label: { fg: "cyan" },
            selected: { bg: "blue", fg: "white", bold: true },
            item: { fg: "white" },
        },
        keys: true,
        vi: true,
        mouse: true,
        items: [
            "  Type a custom title",
            "  Ask LLM to summarize",
            "  Cancel",
        ],
    });
    choiceList.focus();
    screen.render();

    const cleanup = () => {
        choiceList.detach();
        orchList.focus();
        screen.render();
    };

    choiceList.key(["escape", "q"], cleanup);

    choiceList.on("select", async (_item, choiceIdx) => {
        cleanup();

        if (choiceIdx === 2) return; // Cancel

        if (choiceIdx === 1) {
            // Ask LLM to summarize
            appendLog(`{cyan-fg}Asking LLM to summarize (${uuid4})…{/cyan-fg}`);
            try {
                await summarizeSession(orchId);
                await refreshOrchestrations();
            } catch (err) {
                appendLog(`{red-fg}Summarize failed: ${err.message}{/red-fg}`);
            }
            return;
        }

        // choiceIdx === 0: Type a custom title
        const titleInput = blessed.textbox({
            parent: screen,
            label: ` {bold}New title (${uuid4}):{/bold} `,
            tags: true,
            top: "center",
            left: "center",
            width: 50,
            height: 3,
            border: { type: "line" },
            style: {
                border: { fg: "cyan" },
                label: { fg: "cyan" },
                focus: { border: { fg: "white" } },
            },
            inputOnFocus: true,
            keys: true,
        });
        titleInput.focus();
        screen.render();

        titleInput.on("submit", async (newTitle) => {
            titleInput.detach();
            screen.render();
            if (!newTitle || !newTitle.trim()) {
                orchList.focus();
                return;
            }
            try {
                await mgmt.renameSession(sessionId, newTitle.trim().slice(0, 60));
                sessionHeadings.set(orchId, newTitle.trim().slice(0, 40));
                appendLog(`{green-fg}✓ Renamed (${uuid4}): ${newTitle.trim()}{/green-fg}`);
                await refreshOrchestrations();
            } catch (err) {
                appendLog(`{red-fg}Rename failed: ${err.message}{/red-fg}`);
            }
            orchList.focus();
        });

        titleInput.on("cancel", () => {
            titleInput.detach();
            orchList.focus();
            screen.render();
        });
    });
});

// ─── Stream AKS worker logs into per-worker panes ───────────────

let kubectlProc = null;

function startLogStream() {
    if (kubectlProc) {
        try { kubectlProc.kill(); } catch {}
        kubectlProc = null;
    }

    try {
        const k8sContext = process.env.K8S_CONTEXT || "";
        const k8sNamespace = process.env.K8S_NAMESPACE || "copilot-runtime";
        const k8sPodLabel = process.env.K8S_POD_LABEL || "app.kubernetes.io/component=worker";
        const k8sCtxArgs = k8sContext ? ["--context", k8sContext] : [];
        kubectlProc = spawn("kubectl", [
            ...k8sCtxArgs,
            "logs",
            "--follow=true",
            "-n", k8sNamespace,
            "-l", k8sPodLabel,
            "--prefix",
            "--tail=500",
            "--max-log-requests=20",
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

                // Strip ANSI codes before matching — duroxide compact format embeds
                // ANSI escapes inside key=value pairs (e.g. instance_id\x1b[0m\x1b[2m=)
                // eslint-disable-next-line no-control-regex
                const plain = content.replace(/\x1b\[[0-9;]*m/g, "");
                const instanceMatch = plain.match(/instance_id=(\S+)/);
                const orchId = instanceMatch
                    ? instanceMatch[1].replace(/,.*$/, "")
                    : null;

                // Color orchestration vs activity differently
                let formatted;
                const isOrch = plain.includes("duroxide::orchestration");
                const isActivity = plain.includes("duroxide::activity");
                if (isOrch) {
                    formatted = plain
                        .replace(/\bWARN\b/g, "{yellow-fg}WARN{/yellow-fg}")
                        .replace(/\bERROR\b/g, "{red-fg}ERROR{/red-fg}")
                        .replace(/\bINFO\b/g, "{magenta-fg}INFO{/magenta-fg}");
                    // Prefix with orch marker
                    formatted = `{magenta-fg}◆{/magenta-fg} ${formatted}`;
                } else if (isActivity) {
                    formatted = plain
                        .replace(/\bWARN\b/g, "{yellow-fg}WARN{/yellow-fg}")
                        .replace(/\bERROR\b/g, "{red-fg}ERROR{/red-fg}")
                        .replace(/\bINFO\b/g, "{blue-fg}INFO{/blue-fg}");
                    formatted = `{blue-fg}●{/blue-fg} ${formatted}`;
                } else {
                    formatted = plain
                        .replace(/\bWARN\b/g, "{yellow-fg}WARN{/yellow-fg}")
                        .replace(/\bERROR\b/g, "{red-fg}ERROR{/red-fg}")
                        .replace(/\bINFO\b/g, "{green-fg}INFO{/green-fg}");
                }

                appendWorkerLog(podName, formatted, orchId);

                // Also buffer per-orchestration
                if (orchId && orchId.startsWith("session-")) {
                    appendOrchLog(orchId, podName, formatted);
                }

                // Feed sequence diagram
                const seqEvt = parseSeqEvent(plain, podName);
                if (seqEvt) {
                    appendSeqEvent(seqEvt.orchId, seqEvt);
                }
            }
            screen.render();
        });

        kubectlProc.stderr.on("data", (chunk) => {
            const text = chunk.toString().trim();
            if (text && !text.includes("proxy error") && !text.includes("Gateway Timeout") && !text.includes("NotFound") && !text.includes("not found") && !text.includes("No resources found")) {
                appendLog(`{white-fg}${text}{/white-fg}`);
            }
        });

        kubectlProc.on("error", (err) => {
            appendLog(`{yellow-fg}kubectl error: ${err.message}{/yellow-fg}`);
        });

        // Auto-restart on exit (e.g., pods terminated during rollout)
        kubectlProc.on("exit", (code, signal) => {
            appendLog(`{white-fg}kubectl exited (code=${code} signal=${signal}) — restarting in 5s{/white-fg}`);
            kubectlProc = null;
            setTimeout(() => { startLogStream(); }, 5000);
        });
    } catch {
        appendLog("{yellow-fg}Could not start log stream{/yellow-fg}");
    }
}

if (isRemote) {
    startLogStream();
    appendLog("{green-fg}Streaming AKS worker logs ↓{/green-fg}");

    // Periodically prune stale worker panes (every 30s)
    setInterval(async () => {
        try {
            const result = await new Promise((resolve, reject) => {
                const k8sCtxArgs = process.env.K8S_CONTEXT ? ["--context", process.env.K8S_CONTEXT] : [];
                const proc = spawn("kubectl", [
                    ...k8sCtxArgs,
                    "get", "pods", "-n", process.env.K8S_NAMESPACE || "copilot-runtime",
                    "-l", process.env.K8S_POD_LABEL || "app.kubernetes.io/component=worker",
                    "--field-selector=status.phase=Running",
                    "-o", "jsonpath={.items[*].metadata.name}",
                ], { stdio: ["ignore", "pipe", "pipe"] });
                let out = "";
                proc.stdout.on("data", d => out += d.toString());
                proc.on("close", code => code === 0 ? resolve(out.trim()) : reject());
                proc.on("error", reject);
            });
            if (result) {
                const activePods = new Set(result.split(/\s+/));
                pruneWorkerPanes(activePods);
            }
        } catch {}
    }, 30_000);
} else {
    // In local mode, create panes for the embedded workers
    for (let i = 0; i < numWorkers; i++) {
        getOrCreateWorkerPane(`local-rt-${i}`);
    }
}

// Map sessionId → PilotSwarmSession object
const sessions = new Map();
const sessionModels = new Map(); // orchId → model name used for that session

// currentModel is declared earlier (before model providers loading)

// Pending command responses — keyed by correlation ID
// Observer matches cmdResponse.id and displays results
const pendingCommands = new Map(); // id → { cmd, resolve, timer }

// Auto-timeout pending commands (default 15s, overridable)
function addPendingCommand(cmdId, cmd, timeoutMs = 15_000) {
    const timer = setTimeout(() => {
        if (pendingCommands.has(cmdId)) {
            pendingCommands.delete(cmdId);
            appendChatRaw(`{yellow-fg}⏱ Command timed out: ${cmd} — the orchestration may be restarting. Try again.{/yellow-fg}`);
            screen.render();
        }
    }, timeoutMs);
    pendingCommands.set(cmdId, { cmd, resolve: null, timer });
}

async function createNewSession() {
    const sess = await client.createSession({
        ...(currentModel ? { model: currentModel } : {}),
        toolNames: ["write_artifact", "export_artifact", "read_artifact"],
        onUserInputRequest: async (request) => {
            return new Promise((resolve) => {
                const q = request.question || "?";
                appendChatRaw(`{magenta-fg}[?] ${q}{/magenta-fg}`);
                setStatus("Waiting for your answer...");
                pendingUserInput = { resolve };
                inputBar.setLabel(" {bold}answer:{/bold} ");
                screen.render();
                focusInput();
            });
        },
    });
    sessions.set(sess.sessionId, sess);
    sessionModels.set(`session-${sess.sessionId}`, currentModel || "default");
    return sess;
}

// Check for existing non-system sessions to resume, or start with sweeper
let thisSessionId = null;
try {
    const _resumePh = perfStart("startup.resumeSession");
    const existingSessions = await mgmt.listSessions();
    const userSessions = existingSessions.filter(s => !s.isSystem);
    if (userSessions.length > 0) {
        // Resume the most recent user session
        const mostRecent = userSessions[0]; // already sorted by updatedAt desc
        thisSessionId = mostRecent.sessionId;
        const sess = await client.resumeSession(thisSessionId);
        sessions.set(thisSessionId, sess);
        appendLog(`Resumed session ✓ {white-fg}(${shortId(thisSessionId)}…){/white-fg}`);
    }
    perfEnd(_resumePh);
} catch {}

// ─── Sweeper Agent (system session) ─────────────────────────────
// Auto-create the system maintenance session. Idempotent — resumes if one exists.
let sweeperSessionId = null;
try {
    const _sweeperPh = perfStart("startup.sweeperInit");
    const sweeperSession = await client.createSystemSession({
        systemMessage: {
            mode: "replace",
            content: [
                "You are the Sweeper Agent — a system maintenance agent for PilotSwarm.",
                "",
                "## IMPORTANT: User Messages Take Priority",
                "When you receive a message from the user (anything that is NOT a system timer",
                "or continuation prompt), you MUST stop your maintenance loop and respond to",
                "the user's message directly and helpfully FIRST. Use get_system_stats if they",
                "ask about system status. Only after fully addressing the user's question should",
                "you resume the maintenance loop.",
                "",
                "## Maintenance Loop (Background Behavior)",
                `1. Every ${SWEEPER_SCAN_INTERVAL} seconds, use scan_completed_sessions (graceMinutes=${SWEEPER_GRACE_MINUTES}) to find stale sessions.`,
                "2. For each stale session found, use cleanup_session to delete it.",
                "3. Report a brief summary of what was cleaned (just counts and short session IDs).",
                `4. Every ~${SWEEPER_PRUNE_INTERVAL} iterations, call prune_orchestrations(deleteTerminalOlderThanMinutes=${SWEEPER_PRUNE_TERMINAL_MINUTES}, keepExecutions=${SWEEPER_KEEP_EXECUTIONS}) to bulk-clean duroxide state.`,
                `5. Use the wait tool to sleep for ${SWEEPER_SCAN_INTERVAL} seconds, then repeat.`,
                "",
                "## Rules",
                "- Never delete system sessions.",
                "- Never delete sessions that are actively running with recent activity.",
                "- Be concise — counts and 8-char IDs only for periodic logs.",
                "- When nothing is found to clean, silently continue the loop (don't spam).",
                "- For ANY waiting/sleeping, you MUST use the wait tool.",
            ].join("\n"),
        },
        toolNames: ["scan_completed_sessions", "cleanup_session", "prune_orchestrations", "get_system_stats"],
        title: "Sweeper Agent",
    });
    sweeperSessionId = sweeperSession.sessionId;
    systemSessionIds.add(`session-${sweeperSessionId}`);
    sessions.set(sweeperSessionId, sweeperSession);

    // Pre-populate the sweeper's chat buffer with its ASCII banner
    const sweeperOrchId = `session-${sweeperSessionId}`;
    if (!sessionChatBuffers.has(sweeperOrchId)) {
        sessionChatBuffers.set(sweeperOrchId, []);
    }
    const swBuf = sessionChatBuffers.get(sweeperOrchId);
    swBuf.push("{bold}{yellow-fg}");
    swBuf.push("   ____                                      ");
    swBuf.push("  / ___/      _____  ___  ____  ___  _____   ");
    swBuf.push("  \\__ \\ | /| / / _ \\/ _ \\/ __ \\/ _ \\/ ___/   ");
    swBuf.push(" ___/ / |/ |/ /  __/  __/ /_/ /  __/ /       ");
    swBuf.push("/____/|__/|__/\\___/\\___/ .___/\\___/_/        ");
    swBuf.push("                       /_/            {/yellow-fg}{white-fg}Agent{/white-fg}");
    swBuf.push("{/bold}");
    swBuf.push("");
    swBuf.push("  {bold}{white-fg}System Maintenance Agent{/white-fg}{/bold}");
    swBuf.push("  {yellow-fg}Cleanup{/yellow-fg} · {green-fg}Monitoring{/green-fg} · {cyan-fg}Session lifecycle{/cyan-fg}");
    swBuf.push("");
    swBuf.push("  {yellow-fg}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━{/yellow-fg}");
    swBuf.push("");

    // Kick off the cleanup loop
    sweeperSession.send(`Begin your maintenance loop now. Scan every ${SWEEPER_SCAN_INTERVAL} seconds, clean up sessions completed more than ${SWEEPER_GRACE_MINUTES} minutes ago. Prune terminal orchestrations older than ${SWEEPER_PRUNE_TERMINAL_MINUTES} minutes every ${SWEEPER_PRUNE_INTERVAL} iterations.`);
    appendLog(`Sweeper Agent created ✓ {yellow-fg}(${shortId(sweeperSessionId)}…){/yellow-fg}`);
    perfEnd(_sweeperPh);
} catch (err) {
    appendLog(`{yellow-fg}Sweeper Agent init: ${err.message}{/yellow-fg}`);
}

// ─── Active orchestration tracking ───────────────────────────────
// The chat pane shows live output from the "active" orchestration.
// Selecting a different orchestration in the left pane switches context.

activeOrchId = thisSessionId
    ? `session-${thisSessionId}`
    : (sweeperSessionId ? `session-${sweeperSessionId}` : "");
activeSessionShort = thisSessionId
    ? shortId(thisSessionId)
    : (sweeperSessionId ? shortId(sweeperSessionId) : "");
let orchSelectFollowActive = true; // when true, next refresh snaps selection to activeOrchId

function updateChatLabel() {
    const model = sessionModels.get(activeOrchId) || "";
    const shortModel = model.includes(":") ? model.split(":")[1] : model;
    const modelTag = shortModel ? ` {cyan-fg}${shortModel}{/cyan-fg}` : "";
    const isSweeper = systemSessionIds.has(activeOrchId);
    if (isSweeper) {
        chatBox.setLabel(` {bold}{yellow-fg}≋ Sweeper Agent{/yellow-fg}{/bold} {white-fg}[${activeSessionShort}]{/white-fg}${modelTag} `);
        chatBox.style.border.fg = "yellow";
    } else {
        chatBox.setLabel(` {bold}Chat{/bold} {white-fg}[${activeSessionShort}]{/white-fg}${modelTag} `);
        chatBox.style.border.fg = "cyan";
    }
    screen.render();
}

/**
 * Start observing an orchestration's custom status and pipe turn results
 * into the chat buffer. Runs until aborted or the orchestration completes.
 * Multiple observers can run concurrently (one per session).
 */
function startObserver(orchId) {
    // Don't start a duplicate observer for the same session
    if (sessionObservers.has(orchId)) return;

    const dc = getDc();
    if (!dc) return;
    const sessionId = orchId.startsWith("session-") ? orchId.slice(8) : orchId;

    const ac = new AbortController();
    sessionObservers.set(orchId, ac);
    let lastVersion = 0;
    let lastIteration = -1;

    // Helper: update status bar only if this is the active session
    function setStatusIfActive(text) {
        if (orchId === activeOrchId) setStatus(text);
    }
    function setTurnInProgressIfActive(val) {
        if (orchId === activeOrchId) turnInProgress = val;
    }
    function updateLiveStatus(status) {
        sessionLiveStatus.set(orchId, status);
        // Lightweight: just update icons in the list without DB queries.
        // Full refresh happens on the debounced 500ms schedule.
        updateSessionListIcons();
    }

    // ── Real-time CMS event subscription ────────────────────
    // CMS event polling is managed centrally via activeCmsPoller — only
    // the active session polls CMS. This avoids N concurrent pollers
    // hammering the database. See startCmsPoller() / stopCmsPoller().

    // First, show the current state immediately
    (async () => {
        try {
            const currentStatus = await dc.getStatus(orchId);
            if (ac.signal.aborted) return;

            // Check for terminal states FIRST — before inspecting customStatus
            if (currentStatus.status === "Failed" || currentStatus.status === "Completed" || currentStatus.status === "Terminated") {
                if (currentStatus.status === "Failed") {
                    const reason = currentStatus.failureDetails?.errorMessage?.split("\n")[0]
                        || currentStatus.output?.split("\n")[0]
                        || "Unknown error";
                    appendActivity(`{red-fg}❌ Orchestration failed: ${reason}{/red-fg}`, orchId);
                    updateLiveStatus("error");
                } else {
                    appendActivity(`{gray-fg}Orchestration ${currentStatus.status}{/gray-fg}`, orchId);
                }
                setTurnInProgressIfActive(false);
                setStatusIfActive(`${currentStatus.status} — session is dead`);
                sessionObservers.delete(orchId);
                return; // Don't enter the polling loop
            }

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
                        showCopilotMessage(cs.turnResult.content, orchId);
                    }
                    if (cs.status === "idle") {
                        setStatusIfActive("Idle — type a message");
                        setTurnInProgressIfActive(false);
                        updateLiveStatus("idle");
                    } else if (cs.status === "running") {
                        setStatusIfActive("Running…");
                        setTurnInProgressIfActive(true);
                        updateLiveStatus("running");
                    } else if (cs.status === "waiting") {
                        setStatusIfActive(`Waiting (${cs.waitReason || "timer"})…`);
                        updateLiveStatus("waiting");
                    } else if (cs.status === "input_required") {
                        appendChatRaw(`{magenta-fg}[?] ${cs.pendingQuestion || "?"}{/magenta-fg}`, orchId);
                        setStatusIfActive("Waiting for your answer...");
                        updateLiveStatus("input_required");
                    } else if (cs.status === "error") {
                        const errText = cs.error || "Unknown error";
                        appendActivity(`{red-fg}⚠ ${errText}{/red-fg}`, orchId);
                        if (cs.retriesExhausted) {
                            setStatusIfActive("Error — retries exhausted. Send a message to retry.");
                            setTurnInProgressIfActive(false);
                        } else {
                            setStatusIfActive("Error — retrying…");
                        }
                        updateLiveStatus("error");
                    }
                }
            } else {
                // No custom status yet — orchestration hasn't started or is fresh
                setStatusIfActive("Ready — type a message");
            }
        } catch {
            // Orchestration may not exist yet (new session)
            setStatusIfActive("Ready — type a message");
        }
        while (!ac.signal.aborted) {
            try {
                const _obsPh = perfStart("observer.waitForStatusChange");
                const statusResult = await dc.waitForStatusChange(
                    orchId, lastVersion, 200, 30_000
                );
                perfEnd(_obsPh, { orchId: orchId.slice(0, 12), ver: statusResult.customStatusVersion });
                if (ac.signal.aborted) break;

                if (statusResult.customStatusVersion > lastVersion) {
                    lastVersion = statusResult.customStatusVersion;
                } else if (statusResult.customStatusVersion < lastVersion) {
                    // continueAsNew happened — version reset. Reset watermarks.
                    lastVersion = statusResult.customStatusVersion;
                    lastIteration = -1;
                }

                let cs = null;
                if (statusResult.customStatus) {
                    try {
                        cs = typeof statusResult.customStatus === "string"
                            ? JSON.parse(statusResult.customStatus) : statusResult.customStatus;
                    } catch {}
                }

                if (cs) {
                    // Show intermediate content in the activity pane
                    if (cs.intermediateContent) {
                        const prefix = `{white-fg}[${ts()}]{/white-fg} {gray-fg}[intermediate]{/gray-fg}`;
                        appendActivity(prefix, orchId);
                        const rendered = renderMarkdown(cs.intermediateContent);
                        for (const line of rendered.split("\n")) {
                            appendActivity(line, orchId);
                        }
                    }

                    // Track live status
                    if (cs.status) {
                        updateLiveStatus(cs.status);
                    }

                    // ─── Command response handling ───────────────
                    if (cs.cmdResponse && orchId === activeOrchId) {
                        const resp = cs.cmdResponse;
                        const pending = pendingCommands.get(resp.id);
                        if (pending) {
                            if (pending.timer) clearTimeout(pending.timer);
                            pendingCommands.delete(resp.id);
                            if (resp.error) {
                                appendChatRaw(`{red-fg}❌ Command failed: ${resp.error}{/red-fg}`, orchId);
                            } else {
                                switch (resp.cmd) {
                                    case "list_models": {
                                        const models = resp.result?.models || [];
                                        const active = resp.result?.currentModel || currentModel;
                                        appendChatRaw("{bold}Available models:{/bold}", orchId);
                                        for (const m of models) {
                                            const marker = m.id === active ? " {green-fg}← default{/green-fg}" : "";
                                            appendChatRaw(`  {cyan-fg}${m.id}{/cyan-fg}${marker}`, orchId);
                                        }
                                        appendChatRaw("{white-fg}Use /model <name> to switch{/white-fg}", orchId);
                                        break;
                                    }
                                    case "set_model": {
                                        const r = resp.result;
                                        currentModel = r.newModel;
                                        sessionModels.set(orchId, r.newModel);
                                        appendChatRaw(`{green-fg}✓ Model changed: {bold}${r.oldModel}{/bold} → {bold}${r.newModel}{/bold}{/green-fg}`, orchId);
                                        appendChatRaw("{white-fg}Takes effect on the next turn.{/white-fg}", orchId);
                                        if (orchId === activeOrchId) updateChatLabel();
                                        break;
                                    }
                                    case "get_info": {
                                        const r = resp.result;
                                        appendChatRaw("{bold}Session info:{/bold}", orchId);
                                        appendChatRaw(`  Model:       {cyan-fg}${r.model}{/cyan-fg}`, orchId);
                                        appendChatRaw(`  Iteration:   ${r.iteration}`, orchId);
                                        appendChatRaw(`  Session:     ${r.sessionId?.slice(0, 12)}…`, orchId);
                                        appendChatRaw(`  Affinity:    ${r.affinityKey}`, orchId);
                                        appendChatRaw(`  Hydrated:    ${r.needsHydration ? "no (dehydrated)" : "yes"}`, orchId);
                                        appendChatRaw(`  Blob:        ${r.blobEnabled ? "enabled" : "disabled"}`, orchId);
                                        break;
                                    }
                                    case "done": {
                                        appendChatRaw("{green-fg}✓ Session completed.{/green-fg}", orchId);
                                        setStatusIfActive("Session completed");
                                        setTurnInProgressIfActive(false);
                                        scheduleRefreshOrchestrations();
                                        break;
                                    }
                                    default:
                                        appendChatRaw(`{green-fg}✓ ${resp.cmd}: ${JSON.stringify(resp.result)}{/green-fg}`, orchId);
                                }
                            }
                            screen.render();
                        }
                    }

                    // Show turn results
                    if (cs.turnResult && cs.iteration > lastIteration) {
                        lastIteration = cs.iteration;
                        if (cs.turnResult.type === "completed") {
                            let displayContent = cs.turnResult.content;
                            // Extract HEADING if present (from summary requests)
                            // Skip for system sessions — they have a fixed title
                            const hMatch = displayContent.match(/^HEADING:\s*(.+)/m);
                            if (hMatch && !systemSessionIds.has(orchId)) {
                                sessionHeadings.set(orchId, hMatch[1].trim().slice(0, 40));
                                displayContent = displayContent.replace(/^HEADING:.*\n?/m, "").trim();
                                scheduleRefreshOrchestrations();
                            } else if (hMatch) {
                                displayContent = displayContent.replace(/^HEADING:.*\n?/m, "").trim();
                            }
                            if (!cs.intermediateContent || cs.intermediateContent !== cs.turnResult.content) {
                                showCopilotMessage(displayContent, orchId);
                            }
                            if (cs.status === "idle") {
                                setStatusIfActive("Ready — type a message");
                                setTurnInProgressIfActive(false);
                            } else {
                                setStatusIfActive(`Running (${cs.status})…`);
                            }
                        } else if (cs.turnResult.type === "input_required") {
                            appendChatRaw(`{magenta-fg}[?] ${cs.turnResult.question}{/magenta-fg}`, orchId);
                            setStatusIfActive("Waiting for your answer...");
                        }
                    } else if (cs.status === "error") {
                        const errText = cs.error || "Unknown error";
                        appendActivity(`{red-fg}⚠ ${errText}{/red-fg}`, orchId);
                        if (cs.retriesExhausted) {
                            setStatusIfActive(`Error — retries exhausted. Send a message to retry.`);
                            setTurnInProgressIfActive(false);
                        } else {
                            setStatusIfActive(`Error — retrying…`);
                        }
                    } else if (cs.status === "running") {
                        setStatusIfActive("Running…");
                        setTurnInProgressIfActive(true);
                    } else if (cs.status === "waiting") {
                        setStatusIfActive(`Waiting (${cs.waitReason || "timer"})…`);
                    }

                    // Mark session as having unseen changes if not active
                    if (orchId !== activeOrchId) {
                        orchHasChanges.add(orchId);
                        updateSessionListIcons();
                    }
                }
            } catch {
                // waitForStatusChange timed out — check terminal state or continueAsNew
                if (ac.signal.aborted) break;
                try {
                    const info = await dc.getStatus(orchId);
                    if (info.status === "Completed" || info.status === "Failed" || info.status === "Terminated") {
                        if (info.status === "Failed") {
                            const reason = info.failureDetails?.errorMessage?.split("\n")[0]
                                || info.output?.split("\n")[0]
                                || "Unknown error";
                            appendActivity(`{red-fg}❌ Session failed: ${reason}{/red-fg}`, orchId);
                        }
                        appendActivity(`{gray-fg}Orchestration ${info.status}{/gray-fg}`, orchId);
                        setTurnInProgressIfActive(false);
                        setStatusIfActive(`${info.status} — type a message`);
                        sessionObservers.delete(orchId);
                        break;
                    }
                    // Detect continueAsNew: customStatusVersion went backwards
                    const currentVersion = info.customStatusVersion || 0;
                    if (currentVersion < lastVersion) {
                        lastVersion = 0;
                        lastIteration = -1;
                    }
                } catch {}
                await new Promise(r => setTimeout(r, 500));
            }
        }
    })();
}

// ─── Central CMS event poller ────────────────────────────────────
// Only ONE poller runs at a time — for the active session only.
// This avoids N concurrent pollers hammering the database.
let _activeCmsUnsub = null;
let _activeCmsOrchId = null;
const _cmsRenderedSeqs = new Set(); // per-session dedup across switches

function startCmsPoller(orchId) {
    // Already polling this session
    if (_activeCmsOrchId === orchId && _activeCmsUnsub) return;
    stopCmsPoller(); // stop any previous poller

    const sid = orchId.startsWith("session-") ? orchId.slice(8) : orchId;
    _activeCmsOrchId = orchId;

    (async () => {
        let sess = sessions.get(sid);
        if (!sess) {
            try {
                sess = await client.resumeSession(sid);
                sessions.set(sid, sess);
            } catch { return; }
        }

        const unsub = sess.on((evt) => {
            // Poller was stopped while callback pending
            if (_activeCmsOrchId !== orchId) { unsub(); return; }
            // Skip if already rendered (from loadCmsHistory on switch)
            if (evt.seq && _cmsRenderedSeqs.has(evt.seq)) return;
            if (evt.seq) _cmsRenderedSeqs.add(evt.seq);

            const t = new Date().toLocaleTimeString("en-GB", { hour12: false });
            const type = evt.eventType;

            // Don't render events that the customStatus observer already handles
            if (type === "assistant.message") return;
            if (type === "user.message") return;

            if (type === "tool.execution_start") {
                const toolName = evt.data?.toolName || "tool";
                const dsid = evt.data?.durableSessionId ? ` {gray-fg}[${shortId(evt.data.durableSessionId)}]{/gray-fg}` : "";
                // Track last tool name so we can show it on completion too
                sess._lastToolName = toolName;
                appendActivity(`{white-fg}[${t}]{/white-fg} {yellow-fg}▶ ${toolName}{/yellow-fg}${dsid}`, orchId);
            } else if (type === "tool.execution_complete") {
                const toolName = evt.data?.toolName || sess._lastToolName || "tool";
                appendActivity(`{white-fg}[${t}]{/white-fg} {green-fg}✓${toolName}{/green-fg}`, orchId);
            } else if (type === "assistant.reasoning") {
                appendActivity(`{white-fg}[${t}]{/white-fg} {gray-fg}[reasoning]{/gray-fg}`, orchId);
            } else if (type === "assistant.turn_start") {
                appendActivity(`{white-fg}[${t}]{/white-fg} {gray-fg}[turn start]{/gray-fg}`, orchId);
            } else if (type === "assistant.usage" || type === "session.info" || type === "session.idle"
                || type === "session.usage_info" || type === "pending_messages.modified" || type === "abort") {
                // skip internal/noisy events
            } else {
                appendActivity(`{white-fg}[${t}] [${type}]{/white-fg}`, orchId);
            }
        });

        _activeCmsUnsub = unsub;
    })();
}

function stopCmsPoller() {
    if (_activeCmsUnsub) {
        _activeCmsUnsub();
        _activeCmsUnsub = null;
    }
    _activeCmsOrchId = null;
}

/**
 * Switch the chat context to a different orchestration.
 * Sends an interrupt asking for a summary + last message, then asks it to resume.
 */
async function switchToOrchestration(orchId) {
    const _ph = perfStart("switchToOrchestration");
    perfTrace("switchTo.begin", { orchId: orchId.slice(0, 12) });
    const isSameSession = orchId === activeOrchId;

    activeOrchId = orchId;
    orchSelectFollowActive = true; // snap list selection to newly activated session
    // Clear unseen-changes flag and snapshot the current version
    orchHasChanges.delete(orchId);
    // Mark as seen — will be updated to latest on next refresh (fire-and-forget)
    const dc = getDc();
    if (dc) {
        dc.getStatus(orchId).then(info => {
            if (info?.customStatusVersion) {
                orchLastSeenVersion.set(orchId, info.customStatusVersion);
            }
            // Extract model from customStatus if not already known
            if (!sessionModels.has(orchId) && info?.customStatus) {
                try {
                    const cs = typeof info.customStatus === "string" ? JSON.parse(info.customStatus) : info.customStatus;
                    const turnResult = cs.turnResult || cs.lastTurnResult;
                    if (turnResult?.model) {
                        sessionModels.set(orchId, turnResult.model);
                        if (orchId === activeOrchId) updateChatLabel();
                    }
                } catch {}
            }
        }).catch(() => {});
    }
    // Use 4-char UUID + time for display
    const uuid4 = shortId(orchId);
    const cached = orchStatusCache.get(orchId);
    const timeStr = cached?.createdAt > 0
        ? new Date(cached.createdAt).toLocaleTimeString("en-GB", { hour12: false, hour: "2-digit", minute: "2-digit" })
        : "";
    activeSessionShort = `${uuid4}${timeStr ? " " + timeStr : ""}`;
    turnInProgress = false;

    // Switch CMS event poller to new session
    startCmsPoller(orchId);

    // Clear chat and show switch indicator (only when switching to a different session)
    if (!isSameSession) {
        updateChatLabel();

        // Show cached chat buffer instantly if available (no DB wait)
        const _cachePh = perfStart("switch.cachedRestore");
        const cachedLines = sessionChatBuffers.get(orchId);
        if (cachedLines && cachedLines.length > 0) {
            chatBox.setContent(cachedLines.map(styleUrls).join("\n"));
            chatBox.setScrollPerc(100);
        } else {
            chatBox.setContent("{white-fg}Loading…{/white-fg}");
        }

        // Switch activity buffer
        const cachedActivity = sessionActivityBuffers.get(orchId);
        if (cachedActivity && cachedActivity.length > 0) {
            activityPane.setContent(cachedActivity.join("\n"));
            activityPane.setScrollPerc(100);
        } else {
            activityPane.setContent("");
        }
        perfEnd(_cachePh, {
            chatLines: cachedLines?.length || 0,
            activityLines: cachedActivity?.length || 0,
        });

        // Ensure an observer is running for this session
        startObserver(orchId);

        // Update session list icons immediately
        updateSessionListIcons();
        screen.render();

        // Defer heavier right-pane redraw to the next tick so session switching
        // feels instant even when sequence/log panes have a lot of content.
        setTimeout(() => {
            if (orchId === activeOrchId) {
                redrawActiveViews();
            }
        }, 0);

        // Load full history from DB in background (non-blocking)
        loadCmsHistory(orchId).then(() => {
            // Only refresh if still the active session when the load completes
            if (orchId === activeOrchId) {
                _chatDirty = true;
                _activityDirty = true;
            }
        }).catch(() => {});

        // Schedule list refresh in background too
        scheduleRefreshOrchestrations();
    } else {
        redrawActiveViews();
    }
    perfEnd(_ph, { orchId: orchId.slice(0, 12), same: isSameSession });
}

updateChatLabel();
// Start observing the initial session
startObserver(activeOrchId);
startCmsPoller(activeOrchId);

// Initial right-pane paint. In workers mode, kubectl log streaming may not
// have created worker panes yet. Schedule repaints at increasing intervals
// to catch late-arriving panes without a tight poll loop.
for (const delay of [500, 2000, 5000]) {
    setTimeout(() => {
        if (activeOrchId && logViewMode === "workers") {
            recolorWorkerPanes();
            relayoutAll();
        }
    }, delay);
}

// Helper: get the sessionId from an orchestration ID
function sessionIdFromOrchId(orchId) {
    return orchId.startsWith("session-") ? orchId.slice(8) : orchId;
}

// Helper: get or create a PilotSwarmSession for the active orchestration
function getActiveSession() {
    const sid = sessionIdFromOrchId(activeOrchId);
    return sessions.get(sid) || null;
}

// Helper: ensure the orchestration for the active session is started.
// Slash commands need a running orchestration to enqueue events into.
// If no session/orchestration exists yet, create one via send("") which
// starts the orchestration and enters the idle dequeue loop.
async function ensureOrchestrationStarted() {
    const sess = getActiveSession();
    if (!sess) return; // shouldn't happen
    // Check if orchestration exists
    const dc = getDc();
    if (!dc) return;
    try {
        const info = await dc.getStatus(activeOrchId);
        if (info && info.status !== "NotFound") return; // already running
    } catch {
        // Not found — need to start it
    }
    // Start the orchestration by sending an empty prompt
    await sess.send("");
    knownOrchestrationIds.add(activeOrchId);
    startObserver(activeOrchId);
    // Small delay to let the orchestration enter the idle dequeue loop
    await new Promise(r => setTimeout(r, 1000));
}

// ─── Input handling ──────────────────────────────────────────────

let turnInProgress = false;

async function handleInput(text) {
    const trimmed = (text || "").trim();
    if (!trimmed) {
        inputBar.clearValue();
        focusInput();
        screen.render();
        return;
    }

    if (trimmed.toLowerCase() === "exit") {
        await cleanup();
        process.exit(0);
    }

    // ─── Slash commands ──────────────────────────────────────────
    if (trimmed.startsWith("/")) {
        const parts = trimmed.split(/\s+/);
        const cmd = parts[0].toLowerCase();
        const arg = parts.slice(1).join(" ").trim();

        if (cmd === "/models" || cmd === "/model") {
            inputBar.clearValue();
            focusInput();

            const dc = getDc();
            if (!dc) {
                appendChatRaw("{red-fg}Not connected{/red-fg}");
                screen.render();
                return;
            }

            if (!arg) {
                // List models
                if (modelProviders) {
                    // Use local registry — no need to go through duroxide
                    appendChatRaw("{bold}Available models:{/bold}");
                    const byProvider = modelProviders.getModelsByProvider();
                    for (const group of byProvider) {
                        appendChatRaw(`  {white-fg}${group.providerId}{/white-fg} {gray-fg}(${group.type}){/gray-fg}`);
                        for (const m of group.models) {
                            const marker = m.qualifiedName === currentModel ? " {green-fg}← default{/green-fg}" : "";
                            const costTag = m.cost ? ` {gray-fg}[${m.cost}]{/gray-fg}` : "";
                            appendChatRaw(`    {cyan-fg}${m.qualifiedName}{/cyan-fg}${costTag}${marker}`);
                            if (m.description) {
                                appendChatRaw(`      {gray-fg}${m.description}{/gray-fg}`);
                            }
                        }
                    }
                    appendChatRaw("{white-fg}Use /model <provider:model> to switch{/white-fg}");
                } else {
                    // Fall back to duroxide command (GitHub Copilot API)
                    const cmdId = crypto.randomUUID().slice(0, 8);
                    appendChatRaw("{yellow-fg}Fetching models...{/yellow-fg}");
                    screen.render();
                    addPendingCommand(cmdId, "list_models");
                    try {
                        await ensureOrchestrationStarted();
                        await dc.enqueueEvent(activeOrchId, "messages", JSON.stringify({
                            type: "cmd", cmd: "list_models", id: cmdId,
                        }));
                    } catch (err) {
                        pendingCommands.delete(cmdId);
                        appendChatRaw(`{red-fg}Failed to send command: ${err.message}{/red-fg}`);
                    }
                }
            } else {
                // Set model — normalize the reference
                let normalizedModel = arg;
                if (modelProviders) {
                    const normalized = modelProviders.normalize(arg);
                    if (!normalized) {
                        appendChatRaw(`{red-fg}Unknown model: ${arg}{/red-fg}`);
                        const all = modelProviders.allModels.map(m => m.qualifiedName).join(", ");
                        appendChatRaw(`{white-fg}Available: ${all}{/white-fg}`);
                        screen.render();
                        return;
                    }
                    normalizedModel = normalized;
                }
                // Send command through duroxide
                const cmdId = crypto.randomUUID().slice(0, 8);
                currentModel = normalizedModel;
                appendChatRaw(`{yellow-fg}Switching model to ${normalizedModel}...{/yellow-fg}`);
                screen.render();
                addPendingCommand(cmdId, "set_model");
                try {
                    await ensureOrchestrationStarted();
                    await dc.enqueueEvent(activeOrchId, "messages", JSON.stringify({
                        type: "cmd", cmd: "set_model", args: { model: normalizedModel }, id: cmdId,
                    }));
                } catch (err) {
                    pendingCommands.delete(cmdId);
                    appendChatRaw(`{red-fg}Failed to send command: ${err.message}{/red-fg}`);
                }
            }
            screen.render();
            return;
        }

        if (cmd === "/info") {
            inputBar.clearValue();
            focusInput();
            const dc = getDc();
            if (!dc) {
                appendChatRaw("{red-fg}Not connected{/red-fg}");
                screen.render();
                return;
            }
            const cmdId = crypto.randomUUID().slice(0, 8);
            appendChatRaw("{yellow-fg}Fetching session info...{/yellow-fg}");
            screen.render();
            addPendingCommand(cmdId, "get_info");
            try {
                await ensureOrchestrationStarted();
                await dc.enqueueEvent(activeOrchId, "messages", JSON.stringify({
                    type: "cmd", cmd: "get_info", id: cmdId,
                }));
            } catch (err) {
                pendingCommands.delete(cmdId);
                appendChatRaw(`{red-fg}Failed to send command: ${err.message}{/red-fg}`);
            }
            screen.render();
            return;
        }

        if (cmd === "/help") {
            inputBar.clearValue();
            focusInput();
            appendChatRaw("{bold}Commands:{/bold}");
            appendChatRaw("  {cyan-fg}/models{/cyan-fg}         — List available models (via worker)");
            appendChatRaw("  {cyan-fg}/model <name>{/cyan-fg}  — Switch model for this session");
            appendChatRaw("  {cyan-fg}/info{/cyan-fg}           — Show session info (model, iteration, etc.)");
            appendChatRaw("  {cyan-fg}/done{/cyan-fg}           — Complete and close this session");
            appendChatRaw("  {cyan-fg}/new{/cyan-fg}            — Create a new session");
            appendChatRaw("  {cyan-fg}/help{/cyan-fg}           — Show this help");
            screen.render();
            return;
        }

        if (cmd === "/done") {
            inputBar.clearValue();
            focusInput();
            const dc = getDc();
            if (!dc) {
                appendChatRaw("{red-fg}Not connected{/red-fg}");
                screen.render();
                return;
            }
            const cmdId = crypto.randomUUID().slice(0, 8);
            appendChatRaw("{yellow-fg}Completing session (cascading to sub-agents)...{/yellow-fg}");
            screen.render();
            addPendingCommand(cmdId, "done", 120_000); // 2 min — cascading /done to children can be slow
            try {
                await ensureOrchestrationStarted();
                await dc.enqueueEvent(activeOrchId, "messages", JSON.stringify({
                    type: "cmd", cmd: "done", id: cmdId, args: { reason: arg || "Completed by user" },
                }));
            } catch (err) {
                pendingCommands.delete(cmdId);
                appendChatRaw(`{red-fg}Failed to send /done: ${err.message}{/red-fg}`);
            }
            screen.render();
            return;
        }

        if (cmd === "/new") {
            inputBar.clearValue();
            focusInput();
            appendChatRaw("{yellow-fg}Creating new session...{/yellow-fg}");
            screen.render();
            try {
                const newSess = await createNewSession();
                const newOrchId = `session-${newSess.sessionId}`;
                knownOrchestrationIds.add(newOrchId);
                await refreshOrchestrations();
                await switchToOrchestration(newOrchId);
                appendChatRaw(`{green-fg}New session created ✓ {white-fg}(${shortId(newSess.sessionId)}…) model=${currentModel}{/white-fg}{/green-fg}`);
            } catch (err) {
                appendChatRaw(`{red-fg}Failed to create session: ${err.message}{/red-fg}`);
            }
            screen.render();
            return;
        }
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
                await dc.enqueueEvent(activeOrchId, "messages", JSON.stringify({ answer: trimmed, wasFreeform: true }));
            } catch {}
        }
        resolve({ answer: trimmed, wasFreeform: true });
        inputBar.clearValue();
        focusInput();
        screen.render();
        return;
    }

    if (turnInProgress) {
        appendChatRaw(`{white-fg}[${ts()}]{/white-fg} {white-fg}{bold}You:{/bold} ${trimmed}{/white-fg}`);
        inputBar.clearValue();
        setStatus("Interrupting...");
        injectSeqUserEvent(activeOrchId, trimmed);
        try {
            const dc = getDc();
            if (dc) await dc.enqueueEvent(activeOrchId, "messages", JSON.stringify({ prompt: trimmed }));
        } catch (err) {
            appendChatRaw(`{red-fg}Interrupt failed: ${err.message}{/red-fg}`);
        }
        focusInput();
        screen.render();
        return;
    }

    appendChatRaw(`{white-fg}[${ts()}]{/white-fg} {white-fg}{bold}You:{/bold} ${trimmed}{/white-fg}`);
    inputBar.clearValue();
    focusInput();
    turnInProgress = true;
    setStatus("Thinking... (waiting for AKS worker)");
    injectSeqUserEvent(activeOrchId, trimmed);
    screen.render();

    try {
        // Check if the orchestration is in a terminal state before sending
        const dc = getDc();
        if (dc && activeOrchId) {
            try {
                const orchStatus = await dc.getStatus(activeOrchId);
                if (orchStatus.status === "Failed" || orchStatus.status === "Completed" || orchStatus.status === "Terminated") {
                    const reason = orchStatus.status === "Failed"
                        ? (orchStatus.failureDetails?.errorMessage?.split("\n")[0]
                            || orchStatus.output?.split("\n")[0]
                            || "Unknown error")
                        : orchStatus.status;
                    appendChatRaw(`{red-fg}❌ Cannot send — orchestration ${orchStatus.status}: ${reason}{/red-fg}`);
                    appendChatRaw(`{white-fg}Create a new session with 'n' to continue.{/white-fg}`);
                    turnInProgress = false;
                    setStatus(`${orchStatus.status} — session is dead`);
                    screen.render();
                    return;
                }
            } catch {}
        }

        // Use the PilotSwarmSession to send — it handles starting the orchestration
        // on first message. The observer picks up results via waitForStatusChange.
        const sess = getActiveSession();
        if (sess) {
            // Fire-and-forget: just send the message, don't wait for result.
            // The observer is what updates the chat.
            sess.send(trimmed).then(() => {
                knownOrchestrationIds.add(activeOrchId);
                startObserver(activeOrchId);
                refreshOrchestrations();
            }).catch(err => {
                const msg = (err.message || String(err)).split("\n")[0];
                appendChatRaw(`{red-fg}❌ ${msg}{/red-fg}`);
                turnInProgress = false;
                setStatus("Error — try again");
                screen.render();
            });
        } else {
            // No session object — send via enqueueEvent (existing orchestration)
            const dc = getDc();
            if (dc) {
                await dc.enqueueEvent(activeOrchId, "messages", JSON.stringify({ prompt: trimmed }));
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
    // Force-exit after 3s — don't let hanging long-polls block shutdown
    const forceExitTimer = setTimeout(() => {
        const buf = Buffer.from("\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?1049l\x1b[?25h");
        try { fs.writeSync(1, buf); } catch {}
        process.exit(0);
    }, 3000);
    forceExitTimer.unref();

    clearInterval(orchPollTimer);
    // Stop CMS poller
    stopCmsPoller();
    // Stop all session observers — abort first so long-polls break
    for (const [, ac] of sessionObservers) { ac.abort(); }
    sessionObservers.clear();
    if (kubectlProc) { try { kubectlProc.kill("SIGKILL"); } catch {} kubectlProc = null; }
    // Suppress ALL output before destroying — neo-blessed dumps terminfo
    // compilation junk (SetUlc) synchronously during destroy().
    process.stdout.write = () => true;
    process.stderr.write = () => true;
    try { screen.destroy(); } catch {}
    // Write terminal reset directly to fd to bypass our suppression
    // Disable mouse tracking modes + exit alt-screen + show cursor
    const buf = Buffer.from("\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?1049l\x1b[?25h");
    try { fs.writeSync(1, buf); } catch {}
    await Promise.allSettled([
        ...workers.map(w => w.stop()),
        client.stop(),
    ]);
}

screen.key(["C-c"], async () => {
    await cleanup();
    process.exit(0);
});

// ESC + q quit sequence: press Escape, then q within 1s to quit
let escPressedAt = 0;

// ─── Pane navigation ─────────────────────────────────────────────
// Esc: exit prompt, enter navigation mode (sessions pane focused)
// p:   from anywhere, jump back into the prompt
// m:   cycle log mode (workers → orchestration → sequence → node map)
// Tab / Shift+Tab: cycle through panes
// h/l: left/right between sessions, chat, worker panes (when not in prompt)

screen.on("keypress", (ch, key) => {
    if (!key) return;

    // When the slash picker is open, its own keypress handler manages everything
    if (slashPicker) {
        return;
    }

    // v: toggle markdown viewer overlay (replaces entire right side)
    if (ch === "v" && screen.focused !== inputBar) {
        mdViewActive = !mdViewActive;
        if (mdViewActive) refreshMarkdownViewer();
        orchList.focus();
        screen.realloc();
        relayoutAll();
        setStatus(mdViewActive ? "Markdown Viewer (v to exit)" : `Log mode: ${({ workers: "Per-Worker", orchestration: "Per-Orchestration", sequence: "Sequence Diagram", nodemap: "Node Map" })[logViewMode]}`);
        return;
    }

    // ── Markdown file list: j/k navigation (screen-level for reliability) ──
    if (mdViewActive && screen.focused === mdFileListPane) {
        if (key.name === "j" || key.name === "down") {
            const total = mdFileListPane.items.length;
            if (total > 0) {
                const next = Math.min(total - 1, mdViewerSelectedIdx + 1);
                if (next !== mdViewerSelectedIdx) {
                    mdViewerSelectedIdx = next;
                    mdFileListPane.select(next);
                    refreshMarkdownViewer();
                }
            }
            return;
        }
        if (key.name === "k" || key.name === "up") {
            if (mdViewerSelectedIdx > 0) {
                mdViewerSelectedIdx--;
                mdFileListPane.select(mdViewerSelectedIdx);
                refreshMarkdownViewer();
            }
            return;
        }
        if (key.name === "enter") {
            mdPreviewPane.focus();
            screen.render();
            return;
        }
    }

    // m: cycle log viewing mode (only from non-input panes, disabled during md view)
    if (ch === "m" && screen.focused !== inputBar) {
        switchLogMode();
        // Force the same full repaint that 'r' does
        screen.realloc();
        relayoutAll();
        if (logViewMode === "sequence") refreshSeqPane();
        if (logViewMode === "nodemap") refreshNodeMap();
        const modeNames = { workers: "Per-Worker", orchestration: "Per-Orchestration", sequence: "Sequence Diagram", nodemap: "Node Map" };
        setStatus(`Log mode: ${modeNames[logViewMode]}`);
        return;
    }

    // r: force full redraw (same as resize)
    if (ch === "r" && screen.focused !== inputBar) {
        screen.realloc();
        relayoutAll();
        if (logViewMode === "sequence") refreshSeqPane();
        if (logViewMode === "nodemap") refreshNodeMap();

    // [ / ]: resize right pane by 8 chars
    } else if ((ch === "[" || ch === "]") && screen.focused !== inputBar) {
        if (ch === "[") rightPaneAdjust += 8;  // shrink right (grow left)
        else rightPaneAdjust = Math.max(0, rightPaneAdjust - 8); // grow right (shrink left)
        // Clamp: right pane min 20 chars, left pane min 30 chars
        const maxAdj = screen.width - 20 - Math.floor(screen.width * 0.45);
        rightPaneAdjust = Math.max(-(Math.floor(screen.width * 0.45) - 30), Math.min(rightPaneAdjust, maxAdj));
        relayoutAll();
        redrawActiveViews();
        return;
    }

    // Esc from any pane (except input, handled above) → sessions pane + start quit sequence
    // If the slash picker is open, dismiss it instead of starting the quit sequence
    if (key.name === "escape" && screen.focused !== inputBar) {
        if (slashPicker) {
            dismissSlashPicker();
            focusInput();
            screen.render();
            return;
        }
        escPressedAt = Date.now();
        orchList.focus();
        setStatus("{yellow-fg}Press q to quit, or continue navigating{/yellow-fg}");
        screen.render();
        return;
    }

    // q after Esc within 1s → quit
    if (ch === "q" && screen.focused !== inputBar && (Date.now() - escPressedAt) < 1000) {
        cleanup().then(() => process.exit(0));
        return;
    }
    // Any other key resets the quit sequence
    if (key.name !== "escape") escPressedAt = 0;

    // p from any non-input pane → jump to prompt
    if (ch === "p" && screen.focused !== inputBar) {
        focusInput();
        setStatus("Ready — type a message");
        screen.render();
        return;
    }

    // u from any non-input pane → dump active session to Markdown file
    if (ch === "u" && screen.focused !== inputBar) {
        (async () => {
            const sessionId = activeOrchId?.startsWith("session-")
                ? activeOrchId.slice(8) : activeOrchId;
            if (!sessionId || !client) {
                setStatus("{red-fg}No active session to dump{/red-fg}");
                screen.render();
                return;
            }
            try {
                setStatus(`{yellow-fg}Dumping session ${shortId(sessionId)}...{/yellow-fg}`);
                screen.render();
                const md = await mgmt.dumpSession(sessionId);

                // Write to ./dumps/<shortId>_<timestamp>.md
                const dumpsDir = path.join(process.cwd(), "dumps");
                if (!fs.existsSync(dumpsDir)) fs.mkdirSync(dumpsDir, { recursive: true });
                const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
                const filename = `${shortId(sessionId)}_${ts}.md`;
                const filePath = path.join(dumpsDir, filename);
                fs.writeFileSync(filePath, md);

                setStatus(`{green-fg}Dumped to dumps/${filename}{/green-fg}`);
                appendLog(`{green-fg}Session dump saved: dumps/${filename} (${(md.length / 1024).toFixed(1)}KB){/green-fg}`);
            } catch (err) {
                setStatus(`{red-fg}Dump failed: ${err.message}{/red-fg}`);
                appendLog(`{red-fg}Dump error: ${err.message}{/red-fg}`);
            }
            screen.render();
        })();
        return;
    }

    // Tab / Shift+Tab: cycle through panes (handled here for reliability)
    if (key.name === "tab" && screen.focused !== inputBar) {
        const allFocusable = buildFocusableList();
        if (key.shift) {
            // Shift+Tab: backward
            const currentIdx = allFocusable.indexOf(screen.focused);
            const prevIdx = (currentIdx - 1 + allFocusable.length) % allFocusable.length;
            allFocusable[prevIdx].focus();
        } else {
            // Tab: forward
            const currentIdx = allFocusable.indexOf(screen.focused);
            const nextIdx = (currentIdx + 1) % allFocusable.length;
            allFocusable[nextIdx].focus();
        }
        screen.render();
        return;
    }

    // h/l navigation only when NOT in the input bar
    if (screen.focused !== inputBar) {
        const panes = workerPaneOrder.map(n => workerPanes.get(n)).filter(Boolean);
        const rightPane = mdViewActive ? mdFileListPane
            : logViewMode === "orchestration" ? orchLogPane
            : logViewMode === "nodemap" ? nodeMapPane
            : logViewMode === "sequence" ? seqPane
            : (panes.length > 0 ? panes[0] : null);

        if (key.name === "h" || ch === "h") {
            // Left
            if (screen.focused === mdFileListPane || screen.focused === mdPreviewPane || screen.focused === orchLogPane || screen.focused === nodeMapPane || screen.focused === seqPane || screen.focused === activityPane || [...workerPanes.values()].includes(screen.focused)) {
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
            } else if (screen.focused === chatBox && rightPane) {
                rightPane.focus();
            }
            screen.render();
            return;
        }
    }
});

// Tab/Shift+Tab pane cycling is handled in the main keypress handler above.
// buildFocusableList() used by that handler:
function buildFocusableList() {
    let rightPanes;
    if (mdViewActive) {
        rightPanes = [mdFileListPane, mdPreviewPane];
    } else {
        rightPanes = logViewMode === "orchestration"
            ? [orchLogPane]
            : logViewMode === "nodemap"
            ? [nodeMapPane]
            : logViewMode === "sequence"
            ? [seqPane]
            : workerPaneOrder.map(n => workerPanes.get(n)).filter(Boolean);
        rightPanes.push(activityPane);
    }
    return [orchList, chatBox, ...rightPanes];
}

screen.on("resize", () => {
    relayoutAll();
    if (logViewMode === "sequence") refreshSeqPane();
    if (logViewMode === "nodemap") refreshNodeMap();
});

// ─── Welcome content (already shown as splash during startup) ────
// Populate the chat buffer so it persists across session switches
appendChatRaw("{bold}{cyan-fg}");
appendChatRaw("    ____  _ __      __  _____                              ");
appendChatRaw("   / __ \\(_) /___  / /_/ ___/      ______ __________ ___  ");
appendChatRaw("{/cyan-fg}{magenta-fg}  / /_/ / / / __ \\/ __/\\__ \\ | /| / / __ `/ ___/ __ `__ \\");
appendChatRaw(" / ____/ / / /_/ / /_ ___/ / |/ |/ / /_/ / /  / / / / / /{/magenta-fg}");
appendChatRaw("{yellow-fg}/_/   /_/_/\\____/\\__//____/|__/|__/\\__,_/_/  /_/ /_/ /_/ {/yellow-fg}");
appendChatRaw("{/bold}");
appendChatRaw("");
appendChatRaw("  {bold}{white-fg}Durable AI Agent Orchestration{/white-fg}{/bold}");
appendChatRaw("  {cyan-fg}Crash recovery{/cyan-fg} · {magenta-fg}Durable timers{/magenta-fg} · {yellow-fg}Sub-agents{/yellow-fg} · {green-fg}Multi-node scaling{/green-fg}");
appendChatRaw("  {gray-fg}Powered by duroxide + GitHub Copilot SDK{/gray-fg}");
appendChatRaw("");
appendChatRaw("  {cyan-fg}─────────────────────────────────────────────────────────{/cyan-fg}");
appendChatRaw("");
appendChatRaw("{bold}Controls:{/bold}");
appendChatRaw("  {yellow-fg}Esc{/yellow-fg}    exit prompt → navigate TUI");
appendChatRaw("  {yellow-fg}p{/yellow-fg}      back to prompt from anywhere");
appendChatRaw("  {yellow-fg}Tab{/yellow-fg}    cycle panes forward");
appendChatRaw("  {yellow-fg}S-Tab{/yellow-fg}  cycle panes backward");
appendChatRaw("  {yellow-fg}v{/yellow-fg}      toggle markdown viewer (full right side)");
appendChatRaw("  {yellow-fg}m{/yellow-fg}      cycle log mode (workers → orch logs → sequence → node map)");
appendChatRaw("");
appendChatRaw("{bold}Scrolling (when chat/log pane focused):{/bold}");
appendChatRaw("  {yellow-fg}j/k{/yellow-fg} or {yellow-fg}↑/↓{/yellow-fg}   scroll line by line");
appendChatRaw("  {yellow-fg}Ctrl-d/u{/yellow-fg}      page down/up");
appendChatRaw("  {yellow-fg}g/G{/yellow-fg}          top / bottom");
appendChatRaw("  {yellow-fg}mouse wheel{/yellow-fg}    scroll any pane");
appendChatRaw("");
appendChatRaw("{bold}Sessions (left pane):{/bold}");
appendChatRaw("  {yellow-fg}j/k{/yellow-fg}    navigate list");
appendChatRaw("  {yellow-fg}Enter{/yellow-fg}  switch to session");
appendChatRaw("  {yellow-fg}n{/yellow-fg}      new session");
appendChatRaw("  {yellow-fg}c{/yellow-fg}      cancel · {yellow-fg}d{/yellow-fg} delete · {yellow-fg}r{/yellow-fg} refresh");
appendChatRaw("");

// Initial orchestration refresh
await refreshOrchestrations();

// ─── Auto-summarize all existing sessions on startup ─────────────
async function summarizeSession(orchId) {
    if (sessionSummarized.has(orchId)) return;
    sessionSummarized.add(orchId);

    const dc = getDc();
    if (!dc) return;

    // Skip terminal orchestrations — no worker is processing them
    try {
        const info = await dc.getStatus(orchId);
        if (info.status === "Completed" || info.status === "Failed" || info.status === "Terminated") {
            return;
        }
    } catch { return; }

    const resumePrompt =
        'First line of your response MUST be: HEADING: <3-5 word summary of this session>\n' +
        'Then give me a brief summary of what you\'ve been doing and what the last message you sent me was.\n' +
        'After that, resume exactly what you were doing before. If you were in the middle of a task, continue it.';

    // Get current version before sending
    let baseVersion = 0;
    try {
        const info = await dc.getStatus(orchId);
        baseVersion = info?.customStatusVersion || 0;
    } catch { return; }

    // Send message to the unified queue (one enqueue is enough — FIFO)
    try {
        await dc.enqueueEvent(orchId, "messages", JSON.stringify({ prompt: resumePrompt }));
    } catch { return; }

    // Wait for the status to go through "running" → "idle" with turnResult.
    // We need to see a "running" status first to confirm our message was picked up,
    // then wait for the subsequent "idle" with a completed turnResult.
    // Short timeout — if the session doesn't respond quickly, skip it.
    const deadline = Date.now() + 20_000;
    let version = baseVersion;
    let sawRunning = false;
    while (Date.now() < deadline) {
        try {
            const result = await dc.waitForStatusChange(orchId, version, 200, 15_000);
            if (result.customStatusVersion > version) {
                version = result.customStatusVersion;
            }
            let cs = null;
            if (result.customStatus) {
                try {
                    cs = typeof result.customStatus === "string"
                        ? JSON.parse(result.customStatus) : result.customStatus;
                } catch {}
            }
            if (cs?.status === "running") {
                sawRunning = true;
                continue; // wait for the completed result
            }
            // Only accept a turnResult if we've seen "running" (i.e., our message was processed)
            if (sawRunning && cs?.turnResult?.type === "completed" && cs.turnResult.content) {
                const content = cs.turnResult.content;
                // Extract heading from first line
                const headingMatch = content.match(/^HEADING:\s*(.+)/m);
                if (headingMatch && !systemSessionIds.has(orchId)) {
                    const heading = headingMatch[1].trim().slice(0, 40);
                    sessionHeadings.set(orchId, heading);
                    // Remove the HEADING line from the buffered content
                    const rest = content.replace(/^HEADING:.*\n?/m, "").trim();
                    sessionSummaryBuffer.set(orchId, rest);
                } else {
                    sessionSummaryBuffer.set(orchId, content);
                }
                // Refresh list to show new heading
                refreshOrchestrations();
                const uuid4 = shortId(orchId);
                appendLog(`{green-fg}✓ Summarized ${uuid4}: ${sessionHeadings.get(orchId) || "done"}{/green-fg}`);
                return;
            }
        } catch {
            await new Promise(r => setTimeout(r, 1000));
        }
    }
    // Timed out — log and move on
    const uuid4 = shortId(orchId);
    appendLog(`{yellow-fg}⏳ Summarize ${uuid4} timed out (old session?){/yellow-fg}`);
}

// Kick off summarization for all known sessions (in parallel, max 3 at a time)
// Disabled — no longer sending summary interrupts on startup.
// Headings are populated organically from HEADING: lines in turn results.

orchList.focus();
screen.render();
