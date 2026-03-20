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
 *   npx pilotswarm --env .env.remote             # 4 embedded workers
 *   npx pilotswarm remote --env .env.remote       # client-only (AKS)
 */

import { PilotSwarmClient, PilotSwarmWorker, PilotSwarmManagementClient, SessionBlobStore, FilesystemArtifactStore, systemAgentUUID, loadAgentFiles } from "pilotswarm-sdk";
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
const DISPLAY_TIME_ZONE = "America/Los_Angeles";

function formatDisplayTime(value = Date.now(), opts = {}) {
    return new Date(value).toLocaleTimeString("en-GB", {
        timeZone: DISPLAY_TIME_ZONE,
        hour12: false,
        ...opts,
    });
}

function formatDisplayDateTime(value, opts = {}) {
    return new Date(value).toLocaleString("en-GB", {
        timeZone: DISPLAY_TIME_ZONE,
        ...opts,
    });
}

const DEFAULT_TUI_SPLASH_PATH = path.join(__dirname, "tui-splash.txt");
const STARTUP_SPLASH_CONTENT = fs.existsSync(DEFAULT_TUI_SPLASH_PATH)
    ? fs.readFileSync(DEFAULT_TUI_SPLASH_PATH, "utf-8").trimEnd()
    : "{bold}{white-fg}PilotSwarm{/white-fg}{/bold}";

const BASE_TUI_TITLE = (process.env._TUI_TITLE || "PilotSwarm").trim() || "PilotSwarm";
const CUSTOM_TUI_SPLASH = process.env._TUI_SPLASH?.trim() || "";
const ACTIVE_STARTUP_SPLASH_CONTENT = CUSTOM_TUI_SPLASH || STARTUP_SPLASH_CONTENT;
const HAS_CUSTOM_TUI_BRANDING = BASE_TUI_TITLE !== "PilotSwarm" || Boolean(CUSTOM_TUI_SPLASH);

function formatWindowTitle(detail) {
    return detail ? `${BASE_TUI_TITLE} (${detail})` : BASE_TUI_TITLE;
}

function applyProcessTitle(title) {
    try {
        process.title = title;
    } catch {}
}

function applyTerminalTitle(title) {
    try {
        process.stdout.write(`\u001b]0;${title}\u0007`);
        process.stdout.write(`\u001b]2;${title}\u0007`);
    } catch {}
}

function applyWindowTitle(title) {
    applyProcessTitle(title);
    applyTerminalTitle(title);
}

function hideTerminalCursor() {
    try { screen?.program?.hideCursor(); } catch {}
}

function showTerminalCursor() {
    try { screen?.program?.showCursor(); } catch {}
}
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

function isMarkdownTableLine(line) {
    return /^\s*\|.*\|\s*$/.test(line)
        || /^\s*\|?[:\- ]+\|[:\-| ]+\|?\s*$/.test(line);
}

function isAsciiArtCandidateLine(line) {
    if (!line || !line.trim()) return false;
    if (isMarkdownTableLine(line)) return false;
    if (/^\s*[-*+]\s+[A-Za-z0-9]/.test(line)) return false;
    if (/^\s*\d+\.\s+[A-Za-z0-9]/.test(line)) return false;

    const trimmed = line.trim();
    const leadingSpaces = line.length - line.trimStart().length;
    const words = trimmed.match(/[A-Za-z0-9]+/g) || [];
    const symbolCount = (trimmed.match(/[|\\/_[\]{}()<>\-=`"'*+~^:;.]/g) || []).length;
    const hasMultiSpace = / {2,}/.test(line);
    const hasDiagramToken = /(->|<-|=>|<=|<<|>>|~~|==|\|\|)/.test(line);
    const hasBoxChars = /[┌┐└┘├┤┬┴┼─│]/.test(line);

    if (hasBoxChars) return true;
    if (leadingSpaces >= 2 && (hasMultiSpace || symbolCount >= 2)) return true;
    if (hasDiagramToken && words.length <= 10) return true;
    if (symbolCount >= 6 && words.length <= 8) return true;
    return false;
}

function isAsciiArtLabelLine(line) {
    if (!line || !line.trim()) return false;
    if (isMarkdownTableLine(line)) return false;

    const trimmed = line.trim();
    const words = trimmed.match(/[A-Za-z0-9]+/g) || [];
    const symbolCount = (trimmed.match(/[|\\/_[\]{}()<>\-=`"'*+~^:;.]/g) || []).length;

    return words.length > 0
        && words.length <= 6
        && trimmed.length <= 36
        && symbolCount <= 6;
}

function preserveAsciiArtBlocks(md) {
    const lines = md.split("\n");
    const out = [];
    let inFence = false;
    let pending = [];
    let candidateCount = 0;

    const flushPending = () => {
        if (pending.length === 0) return;
        if (candidateCount >= 3) {
            out.push("```text", ...pending, "```");
        } else {
            out.push(...pending);
        }
        pending = [];
        candidateCount = 0;
    };

    for (const line of lines) {
        if (/^\s*```/.test(line)) {
            flushPending();
            out.push(line);
            inFence = !inFence;
            continue;
        }

        if (inFence) {
            out.push(line);
            continue;
        }

        const isCandidate = isAsciiArtCandidateLine(line);
        const isBlank = !line.trim();
        const isLabel = pending.length > 0 && isAsciiArtLabelLine(line);

        if (isCandidate || (pending.length > 0 && (isBlank || isLabel))) {
            pending.push(line);
            if (isCandidate) candidateCount++;
            continue;
        }

        flushPending();
        out.push(line);
    }

    flushPending();
    return out.join("\n");
}

function renderMarkdown(md) {
    const _ph = perfStart("renderMarkdown");
    try {
        // Dynamically set width to match chat pane (minus borders/padding)
        const mdWidth = Math.max(40, leftW() - 4);
            marked.use(markedTerminal({ reflowText: true, width: mdWidth, showSectionPrefix: false, tab: 2, blockquote: chalk.whiteBright.italic, html: chalk.white, codespan: chalk.yellowBright }, { theme: cliHighlightTheme }));
        const unescaped = md.replace(/\\n/g, "\n");
        const preprocessed = preserveAsciiArtBlocks(unescaped);
        let rendered = marked(preprocessed).replace(/\n{3,}/g, "\n\n").trimEnd();
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
        // Fallback formatting for markdown-ish text that marked-terminal leaves untouched.
        rendered = rendered.replace(/\*\*([^*\n][\s\S]*?)\*\*/g, "{bold}$1{/bold}");
        rendered = rendered.replace(/__([^_\n][\s\S]*?)__/g, "{bold}$1{/bold}");
        rendered = rendered.replace(/`([^`\n]+)`/g, "{yellow-fg}$1{/yellow-fg}");
        perfEnd(_ph, { len: md.length });
        return rendered;
    } catch {
        perfEnd(_ph, { len: md.length, err: true });
        return md;
    }
}

// ─── Artifact link detection & on-demand download ────────────────
// Detect artifact:// URIs in assistant messages. Download on-demand from blob.
// Format: artifact://sessionId/filename.md
const ARTIFACT_URI_RE = /artifact:\/\/([a-f0-9-]+)\/([^\s"'{}]+)/g;

/** Per-session artifact link registry. orchId → [{ sessionId, filename }] */
const sessionArtifacts = new Map();

/** Track already-registered artifacts to avoid duplicates. */
const _registeredArtifacts = new Set();
const MAX_ARTIFACT_REGISTRY = 500;

/** TUI-level artifact store for on-demand downloads. Created lazily.
 *  Uses Azure Blob when configured, otherwise falls back to local filesystem. */
let _tuiArtifactStore = null;
function getTuiArtifactStore() {
    if (_tuiArtifactStore) return _tuiArtifactStore;
    const connStr = process.env.AZURE_STORAGE_CONNECTION_STRING;
    if (connStr) {
        const container = process.env.AZURE_STORAGE_CONTAINER || "copilot-sessions";
        _tuiArtifactStore = new SessionBlobStore(connStr, container);
    } else {
        _tuiArtifactStore = new FilesystemArtifactStore();
    }
    return _tuiArtifactStore;
}

/**
 * Scan text for artifact:// URIs and register them for the given session.
 * Does NOT download — download happens on user request via 'a' key.
 */
function detectArtifactLinks(text, orchId) {
    if (!text) return;
    ARTIFACT_URI_RE.lastIndex = 0;
    const matches = [...text.matchAll(ARTIFACT_URI_RE)];
    for (const m of matches) {
        const [, sessionId, filename] = m;
        const key = `${sessionId}/${filename}`;
        if (_registeredArtifacts.has(key)) continue;
        _registeredArtifacts.add(key);

        // Evict oldest entries when registry grows too large
        if (_registeredArtifacts.size > MAX_ARTIFACT_REGISTRY) {
            const it = _registeredArtifacts.values();
            _registeredArtifacts.delete(it.next().value);
        }

        if (!sessionArtifacts.has(orchId)) sessionArtifacts.set(orchId, []);
        sessionArtifacts.get(orchId).push({ sessionId, filename, downloaded: false, localPath: null });
    }
}

/**
 * Download an artifact from blob storage to EXPORTS_DIR.
 * Returns the local path on success, null on failure.
 */
async function downloadArtifact(sessionId, filename) {
    const store = getTuiArtifactStore();
    const sessionDir = path.join(EXPORTS_DIR, sessionId.slice(0, 8));
    fs.mkdirSync(sessionDir, { recursive: true });
    const localPath = path.join(sessionDir, filename);

    try {
        const content = await store.downloadArtifact(sessionId, filename);
        fs.writeFileSync(localPath, content, "utf-8");
        appendLog(`{green-fg}📥 Downloaded: ~/${path.relative(os.homedir(), localPath)} (${(content.length / 1024).toFixed(1)}KB){/green-fg}`);
        return localPath;
    } catch (err) {
        appendLog(`{red-fg}📥 Download error for ${filename}: ${err.message}{/red-fg}`);
        return null;
    }
}

function ts() {
    return formatDisplayTime(Date.now());
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
    // Full-screen redraws are more reliable than neo-blessed's diff-based
    // smartCSR path here; partial repaints were leaving stale glyphs behind
    // after session switches and pane relayouts.
    smartCSR: false,
    title: BASE_TUI_TITLE,
    fullUnicode: true,
    forceUnicode: true,
    mouse: true,
});
process.stderr.write = _origStderr;
applyWindowTitle(BASE_TUI_TITLE);

// ─── Coalescing render loop (Option B) ───────────────────────────
// Instead of rendering on every screen.render() call (80+ sites),
// screen.render() just sets a dirty flag. A short frame loop does
// the actual render — capped high enough to keep typing/navigation responsive.
const _origRender = screen.render.bind(screen);
let _screenDirty = false;
let _chatDirty = false;
let _activityDirty = false;
let _chatScrollIntent = null;
let _activityScrollIntent = null;
let startupLandingVisible = false;

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

function refreshRightPaneForMode() {
    if (logViewMode === "orchestration") {
        refreshOrchLogPane();
    } else if (logViewMode === "sequence") {
        refreshSeqPane();
    } else if (logViewMode === "nodemap") {
        refreshNodeMap();
    } else {
        recolorWorkerPanes();
    }
}

let _lightRefreshTimer = null;
function scheduleLightRefresh(reason, targetOrchId = activeOrchId, delayMs = 0) {
    if (_lightRefreshTimer) clearTimeout(_lightRefreshTimer);
    _lightRefreshTimer = setTimeout(() => {
        _lightRefreshTimer = null;
        if (targetOrchId && targetOrchId !== activeOrchId) return;
        perfTrace("screen.lightRefresh", {
            reason,
            mode: logViewMode,
            active: activeOrchId ? shortId(activeOrchId) : null,
        });
        screen.realloc();
        relayoutAll();
        if (logViewMode === "sequence") refreshSeqPane();
        if (logViewMode === "nodemap") refreshNodeMap();
    }, delayMs);
}

// Frame loop — ~30fps max
setInterval(() => {
    // Sync chat buffer → chatBox before rendering (Option C)
    if (_chatDirty) {
        if (!startupLandingVisible) {
            let currentActive;
            try { currentActive = activeOrchId; } catch { currentActive = undefined; }
            const lines = currentActive && sessionChatBuffers?.get(currentActive);
            if (lines) {
                // Save scroll state before setContent (which resets scroll to top)
                const wasAtBottom = chatBox.getScrollPerc() >= 95;
                const prevScrollTop = chatBox.childBase || 0;
                chatBox.setContent(lines.map(styleUrls).join("\n"));
                if (_chatScrollIntent === "bottom") {
                    chatBox.setScrollPerc(100);
                } else if (_chatScrollIntent === "top") {
                    chatBox.scrollTo(0);
                } else if (wasAtBottom) {
                    chatBox.setScrollPerc(100);
                } else {
                    // Restore previous scroll position
                    chatBox.scrollTo(prevScrollTop);
                }
            }
        }
        _chatScrollIntent = null;
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
            if (_activityScrollIntent === "bottom") {
                activityPane.setScrollPerc(100);
            } else if (_activityScrollIntent === "top") {
                activityPane.scrollTo(0);
            } else if (wasAtBottom) {
                activityPane.setScrollPerc(100);
            } else {
                activityPane.scrollTo(prevScrollTop);
            }
        }
        _activityScrollIntent = null;
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
}, 33);

// ─── Layout calculations ─────────────────────────────────────────
// Left column: sessions (top) + chat (bottom). Right column: full-height logs.

let rightPaneAdjust = Math.floor(screen.width * 0.55 * 0.25); // start right pane at 3/4 of default
function leftW() { return Math.floor(screen.width * 0.45) + rightPaneAdjust; }
function rightW() { return screen.width - leftW(); }
const MIN_PROMPT_EDITOR_ROWS = 1;
const MAX_PROMPT_EDITOR_ROWS = 8;
let promptValueCache = "";

function promptLineCount(text) {
    return Math.max(1, String(text || "").split("\n").length);
}

function promptEditorRows() {
    return Math.min(MAX_PROMPT_EDITOR_ROWS, Math.max(MIN_PROMPT_EDITOR_ROWS, promptLineCount(promptValueCache)));
}

function inputBarHeight() {
    return promptEditorRows() + 2; // border + content rows
}

function bodyH() { return screen.height - inputBarHeight(); } // total body (minus input bar)
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
        if (pane !== inputBar) hideTerminalCursor();
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
        // Clamp to real orchestration entries — hint/decoration rows beyond orchIdOrder are not selectable
        const total = Math.min(orchList.items.length, orchIdOrder.length);
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

// Clamp mouse-driven selections so hint/decoration rows can't be selected
orchList.on("select item", () => {
    if (orchIdOrder.length > 0 && orchList.selected >= orchIdOrder.length) {
        orchList.select(orchIdOrder.length - 1);
    }
});

// Show contextual help when the orch list gains focus
orchList.on("focus", () => {
    setNavigationStatusForPane("sessions");
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
let logViewMode = "orchestration";
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

const nodeMapPane = blessed.box({
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
 * Scan EXPORTS_DIR for .md files.
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
        mdPreviewPane.setContent("{gray-fg}No markdown files found.\n\nFiles appear here when:\n  • An agent exports an artifact\n  • You press 'u' to dump a session{/gray-fg}");
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
    let buffers;
    try { buffers = sessionActivityBuffers; } catch { return; }
    // Snapshot activeOrchId once to avoid race during session switch
    const currentActive = activeOrchId || undefined;
    const targetOrch = orchId || currentActive || "_init";
    if (!buffers.has(targetOrch)) buffers.set(targetOrch, []);
    const buf = buffers.get(targetOrch);
    buf.push(text);

    // Cap buffer size
    if (buf.length > MAX_ACTIVITY_BUFFER_LINES) {
        const dropped = buf.length - MAX_ACTIVITY_BUFFER_LINES + 1;
        buf.splice(0, dropped);
        buf[0] = `{gray-fg}── ${dropped} older lines trimmed ──{/gray-fg}`;
    }

    // Mark dirty so the frame loop syncs buffer → activityPane
    if (targetOrch === currentActive) {
        invalidateActivity();
    }
}

function formatToolArgValue(value) {
    if (typeof value === "string") return JSON.stringify(value);
    if (typeof value === "number" || typeof value === "boolean") return String(value);
    if (value === null) return "null";
    if (Array.isArray(value)) return `[${value.map(formatToolArgValue).join(", ")}]`;
    try {
        return JSON.stringify(value);
    } catch {
        return String(value);
    }
}

function formatToolArgsSummary(toolName, args) {
    if (!args || typeof args !== "object") return "";
    if (toolName === "wait") {
        const seconds = args.seconds != null ? `${args.seconds}s` : "?";
        const preserve = args.preserveWorkerAffinity === true ? " preserve=true" : "";
        const reason = typeof args.reason === "string" && args.reason
            ? ` reason=${JSON.stringify(args.reason)}`
            : "";
        return ` ${seconds}${preserve}${reason}`;
    }

    const entries = Object.entries(args)
        .slice(0, 4)
        .map(([key, value]) => `${key}=${formatToolArgValue(value)}`);
    if (entries.length === 0) return "";
    const suffix = Object.keys(args).length > entries.length ? ", ..." : "";
    return ` ${entries.join(", ")}${suffix}`;
}

function formatToolActivityLine(timeStr, evt, phase = "start") {
    const toolName = evt.data?.toolName || evt.data?.name || "tool";
    const args = evt.data?.arguments || evt.data?.args;
    const dsid = evt.data?.durableSessionId ? ` {gray-fg}[${shortId(evt.data.durableSessionId)}]{/gray-fg}` : "";
    const summary = formatToolArgsSummary(toolName, args);
    if (phase === "start") {
        return `{white-fg}[${timeStr}]{/white-fg} {yellow-fg}▶ ${toolName}${summary}{/yellow-fg}${dsid}`;
    }
    return `{white-fg}[${timeStr}]{/white-fg} {green-fg}✓ ${toolName}{/green-fg}${dsid}`;
}

function summarizeActivityPreview(text, maxLen = 100) {
    const compact = String(text || "")
        .replace(/\s+/g, " ")
        .trim();
    if (!compact) return "(no content)";
    return compact.length > maxLen
        ? `${compact.slice(0, maxLen - 1)}...`
        : compact;
}

function ensureSessionSplashBuffer(orchId) {
    const existing = sessionChatBuffers.get(orchId) || [];
    const splashText = systemSplashText.get(orchId);
    if (!splashText) return existing.length > 0 ? existing : null;

    const splashLines = splashText.split("\n");
    const hasSplashPrefix = existing.length >= splashLines.length
        && splashLines.every((line, idx) => existing[idx] === line);
    const merged = hasSplashPrefix ? existing : [...splashLines, "", ...existing];
    sessionSplashApplied.add(orchId);
    sessionChatBuffers.set(orchId, merged);
    return merged;
}

/**
 * Refresh the node map pane — vertical columns, one per worker node,
 * with sessions stacked underneath, color-coded by live status.
 */
function refreshNodeMap() {
    const lines = [];
    nodeMapPane.setContent("");

    // Gather all known nodes from seqNodes (worker pane names)
    // Filter out synthetic nodes like "cms" that aren't real workers.
    const SYNTHETIC_NODES = new Set(["cms"]);
    const nodes = (seqNodes.length > 0 ? [...seqNodes] : [...workerPaneOrder])
        .filter(n => !SYNTHETIC_NODES.has(n));
    if (nodes.length === 0) {
        nodeMapPane.setContent("{white-fg}No worker nodes discovered yet{/white-fg}");
        nodeMapPane.scrollTo(0);
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
        const status = getSessionVisualState(orchId);
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
    lines.push(headerLine);

    // Divider
    let divLine = "";
    for (let i = 0; i < columns.length; i++) {
        if (i > 0) divLine += "┼";
        divLine += "─".repeat(colW);
    }
    lines.push(divLine);

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
                const color = getSessionStateColor(s.status);
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
        lines.push(idLine);
        lines.push(titleLine);
        if (row < maxSessions - 1) lines.push(""); // spacer between sessions
    }

    if (maxSessions === 0) {
        lines.push("");
        lines.push("{white-fg}(no sessions assigned to any node){/white-fg}");
    }

    // Legend
    lines.push("");
    lines.push(
        "{green-fg}* running{/green-fg}  " +
        "{yellow-fg}~ waiting{/yellow-fg}  " +
        "{white-fg}. idle{/white-fg}  " +
        "{cyan-fg}? input{/cyan-fg}  " +
        "{red-fg}! error{/red-fg}"
    );

    nodeMapPane.setContent(lines.join("\n"));
    nodeMapPane.scrollTo(0);

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
chatBox.on("focus", () => setNavigationStatusForPane("chat"));
orchLogPane.on("focus", () => setNavigationStatusForPane("orchestration"));
nodeMapPane.on("focus", () => setNavigationStatusForPane("nodemap"));
mdFileListPane.on("focus", () => setNavigationStatusForPane("markdownList"));
mdPreviewPane.on("focus", () => setNavigationStatusForPane("markdownPreview"));
activityPane.on("focus", () => setNavigationStatusForPane("activity"));
seqPane.on("focus", () => setNavigationStatusForPane("sequence"));
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
    const now = formatDisplayTime(Date.now(), { hour: "2-digit", minute: "2-digit", second: "2-digit" });
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

/**
 * Render the last `maxLines` of a buffer into a blessed pane with truncation message.
 * @param {Array} buffer - Array of items (strings or objects)
 * @param {object} pane - blessed log/box element
 * @param {number} maxLines - Maximum lines to render
 * @param {function} [formatter] - Optional (item) => string transformer. If omitted, items are logged as-is.
 */
function renderBufferToPane(buffer, pane, maxLines, formatter) {
    const renderItems = buffer.length > maxLines ? buffer.slice(-maxLines) : buffer;
    if (buffer.length > maxLines) {
        pane.log(`{gray-fg}… showing last ${maxLines} of ${buffer.length} lines …{/gray-fg}`);
    }
    for (const item of renderItems) {
        pane.log(formatter ? formatter(item) : item);
    }
    pane.setScrollPerc(100);
}

function refreshOrchLogPane() {
    orchLogPane.setContent("");
    orchLogPane.scrollTo(0);
    const shortIdVal = shortId(activeOrchId);
    orchLogPane.setLabel(` Logs: ${shortIdVal} `);
    const buf = orchLogBuffers.get(activeOrchId);
    if (buf && buf.length > 0) {
        renderBufferToPane(buf, orchLogPane, 150);
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
                if (shouldSuppressWorkerLogLine(content)) continue;
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
    pane.on("focus", () => setNavigationStatusForPane("workers"));

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
    const iH = inputBarHeight();

    // Left column: sessions on top, chat below
    orchList.left = 0; orchList.top = 0; orchList.width = lW; orchList.height = sH;
    chatBox.left = 0; chatBox.top = sH; chatBox.width = lW; chatBox.height = cH;
    if (typeof statusBar !== "undefined" && statusBar) {
        statusBar.left = 1;
        statusBar.width = lW - 2;
        statusBar.bottom = iH - 1;
    }
    if (typeof inputBar !== "undefined" && inputBar) {
        inputBar.left = 0;
        inputBar.width = "100%";
        inputBar.height = iH;
        inputBar.bottom = 0;
    }

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

    // Hide right-side panes that are NOT the active log mode.
    // Worker panes use blessed.log — hide()/show() clears their visual content,
    // so we only hide them when switching AWAY from workers mode.
    if (logViewMode !== "workers") {
        for (const pane of workerPanes.values()) pane.hide();
    }
    if (logViewMode !== "orchestration") orchLogPane.hide();
    if (logViewMode !== "sequence") { seqPane.hide(); seqHeaderBox.hide(); }
    if (logViewMode !== "nodemap") nodeMapPane.hide();

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
    refreshRightPaneForMode();
    relayoutAll();
    // No realloc here — it's expensive (full buffer wipe + re-render)
    // and causes a visible blank flash. Only use realloc on layout changes
    // (e.g. resize, view mode switch), not on session switches.
    screen.render();
    perfEnd(_ph);
}

// ─── Input bar ───────────────────────────────────────────────────

const inputBar = blessed.textarea({
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
inputBar.on("focus", () => {
    showTerminalCursor();
    setNavigationStatusForPane(activeOrchId && sessionPendingQuestions.has(activeOrchId) ? "answer" : "prompt");
});
inputBar.on("blur", () => { hideTerminalCursor(); });

// Guard against double readInput — neo-blessed starts a new readInput on each
// focus() call when inputOnFocus=true. If the textbox is already focused and
// reading, calling focus() again starts a second reader that captures the same
// keystrokes, causing double characters. Wrap all inputBar.focus() calls.
function focusInput() {
    if (screen.focused === inputBar) return; // already focused & reading
    inputBar.focus();
}

let inputCursorIndex = 0;

function clampInputCursor(index, value = inputBar.getValue()) {
    return Math.max(0, Math.min(index, String(value || "").length));
}

function getInputInnerWidth() {
    const numericWidth = typeof inputBar.width === "number" ? inputBar.width : screen.width;
    return Math.max(1, numericWidth - (inputBar.iwidth || 2));
}

function getCursorVisualPosition(value, cursorIndex) {
    const text = String(value || "");
    const width = getInputInnerWidth();
    let row = 0;
    let col = 0;

    for (let i = 0; i < clampInputCursor(cursorIndex, text); i++) {
        const ch = text[i];
        if (ch === "\n") {
            row += 1;
            col = 0;
            continue;
        }
        col += 1;
        if (col >= width) {
            row += 1;
            col = 0;
        }
    }

    return { row, col };
}

function syncInputLayout() {
    promptValueCache = String(inputBar.getValue() || "");
    const desiredHeight = inputBarHeight();
    if (inputBar.height !== desiredHeight || statusBar.bottom !== desiredHeight - 1) {
        relayoutAll();
    } else if (slashPicker) {
        slashPicker.bottom = inputBarHeight();
    }
}

function setInputValue(value, cursorIndex = String(value || "").length) {
    promptValueCache = String(value || "");
    inputBar.setValue(promptValueCache);
    inputCursorIndex = clampInputCursor(cursorIndex, promptValueCache);
    syncInputLayout();
    inputBar._updateCursor();
}

function insertInputText(text) {
    const value = String(inputBar.getValue() || "");
    const nextValue = value.slice(0, inputCursorIndex) + text + value.slice(inputCursorIndex);
    setInputValue(nextValue, inputCursorIndex + text.length);
}

function deleteInputBackward() {
    const value = String(inputBar.getValue() || "");
    if (inputCursorIndex <= 0) return;
    setInputValue(value.slice(0, inputCursorIndex - 1) + value.slice(inputCursorIndex), inputCursorIndex - 1);
}

function deleteInputForward() {
    const value = String(inputBar.getValue() || "");
    if (inputCursorIndex >= value.length) return;
    setInputValue(value.slice(0, inputCursorIndex) + value.slice(inputCursorIndex + 1), inputCursorIndex);
}

function moveCursorLeft() {
    inputCursorIndex = clampInputCursor(inputCursorIndex - 1);
    inputBar._updateCursor();
    screen.render();
}

function moveCursorRight() {
    inputCursorIndex = clampInputCursor(inputCursorIndex + 1);
    inputBar._updateCursor();
    screen.render();
}

function getPreviousWordBoundary(value, fromIndex) {
    let index = clampInputCursor(fromIndex, value);
    while (index > 0 && /\s/.test(value[index - 1])) index -= 1;
    while (index > 0 && !/\s/.test(value[index - 1])) index -= 1;
    return index;
}

function getNextWordBoundary(value, fromIndex) {
    let index = clampInputCursor(fromIndex, value);
    while (index < value.length && /\s/.test(value[index])) index += 1;
    while (index < value.length && !/\s/.test(value[index])) index += 1;
    return index;
}

function moveCursorWordLeft() {
    const value = String(inputBar.getValue() || "");
    inputCursorIndex = getPreviousWordBoundary(value, inputCursorIndex);
    inputBar._updateCursor();
    screen.render();
}

function moveCursorWordRight() {
    const value = String(inputBar.getValue() || "");
    inputCursorIndex = getNextWordBoundary(value, inputCursorIndex);
    inputBar._updateCursor();
    screen.render();
}

function deleteInputWordBackward() {
    const value = String(inputBar.getValue() || "");
    const boundary = getPreviousWordBoundary(value, inputCursorIndex);
    if (boundary === inputCursorIndex) return;
    setInputValue(value.slice(0, boundary) + value.slice(inputCursorIndex), boundary);
}

inputBar.clearValue = function clearPromptValue() {
    setInputValue("", 0);
};

inputBar._updateCursor = function updatePromptCursor(get) {
    if (screen.focused !== inputBar) return;

    const lpos = get ? inputBar.lpos : inputBar._getCoords();
    if (!lpos) return;

    const program = screen.program;
    const value = String(inputBar.getValue() || "");
    const { row, col } = getCursorVisualPosition(value, inputCursorIndex);
    const visibleRows = Math.max(1, inputBar.height - inputBar.iheight);

    if (row < (inputBar.childBase || 0)) {
        inputBar.scrollTo(row);
    } else if (row >= (inputBar.childBase || 0) + visibleRows) {
        inputBar.scrollTo(row - visibleRows + 1);
    }

    const visibleRow = row - (inputBar.childBase || 0);
    const cy = lpos.yi + inputBar.itop + Math.max(0, visibleRow);
    const cx = lpos.xi + inputBar.ileft + col;
    program.cup(cy, cx);
};

inputBar._listener = function promptInputListener(ch, key) {
    if (!key) return;
    const value = String(inputBar.getValue() || "");
    const isMetaEnter = (key.meta && (key.name === "enter" || key.name === "return"))
        || key.sequence === "\x1b\r"
        || key.sequence === "\x1b\n";
    const isMetaBackspace = (key.meta && key.name === "backspace")
        || key.sequence === "\x1b\x7f";
    const isWordLeft = (key.meta && (key.name === "left" || key.name === "b"))
        || key.sequence === "\x1bb";
    const isWordRight = (key.meta && (key.name === "right" || key.name === "f"))
        || key.sequence === "\x1bf";

    if (key.name === "escape") {
        inputBar._done(null, null);
        return;
    }
    if (key.name === "enter" || key.name === "return") {
        if (isMetaEnter) {
            insertInputText("\n");
            screen.render();
            return;
        }
        inputBar._done(null, value);
        return;
    }
    if (isWordLeft) {
        moveCursorWordLeft();
        return;
    }
    if (isWordRight) {
        moveCursorWordRight();
        return;
    }
    if (key.name === "left") {
        moveCursorLeft();
        return;
    }
    if (key.name === "right") {
        moveCursorRight();
        return;
    }
    if (isMetaBackspace) {
        deleteInputWordBackward();
        screen.render();
        return;
    }
    if (key.name === "backspace") {
        deleteInputBackward();
        screen.render();
        return;
    }
    if (key.name === "delete") {
        deleteInputForward();
        screen.render();
        return;
    }
    if (ch === "/" && value === "") {
        insertInputText(ch);
        setImmediate(() => {
            if (!slashPicker) showSlashPicker();
        });
        screen.render();
        return;
    }
    if (ch && !/^[\x00-\x08\x0b-\x0c\x0e-\x1f\x7f]$/.test(ch)) {
        insertInputText(ch);
        screen.render();
    }
};

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
        bottom: inputBarHeight(),
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
            setInputValue(cmd.name + (cmd.name === "/model" ? " " : ""));
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

syncInputLayout();
relayoutAll();
screen.render();
hideTerminalCursor();

// ─── Helpers ─────────────────────────────────────────────────────

const pendingUserInputs = new Map(); // orchId -> { resolve, reject }

function syncInputBarMode() {
    if (!inputBar) return;
    const needsAnswer = Boolean(activeOrchId && sessionPendingQuestions.has(activeOrchId));
    inputBar.setLabel(needsAnswer ? " {bold}answer:{/bold} " : " {bold}you:{/bold} ");
}

function setPendingUserInputRequest(orchId, handlers) {
    if (!orchId || !handlers) return;
    const existing = pendingUserInputs.get(orchId);
    if (existing?.reject) {
        try { existing.reject(new Error("Superseded by a newer user input request")); } catch {}
    }
    pendingUserInputs.set(orchId, handlers);
}

function takePendingUserInputRequest(orchId) {
    if (!orchId) return null;
    const handlers = pendingUserInputs.get(orchId) || null;
    if (handlers) pendingUserInputs.delete(orchId);
    return handlers;
}

function clearPendingUserInputRequest(orchId, reason) {
    if (!orchId) return;
    const existing = pendingUserInputs.get(orchId);
    if (!existing) return;
    pendingUserInputs.delete(orchId);
    if (reason && existing.reject) {
        try { existing.reject(new Error(reason)); } catch {}
    }
}

function clearSessionPendingQuestion(orchId) {
    if (!orchId) return;
    sessionPendingQuestions.delete(orchId);
    clearPendingUserInputRequest(orchId, "Question no longer pending");
    if (orchId === activeOrchId) syncInputBarMode();
}

function setSessionPendingQuestion(orchId, question) {
    if (!orchId) return false;
    const normalized = typeof question === "string" ? question.trim() : "";
    if (!normalized) {
        sessionPendingQuestions.delete(orchId);
        clearPendingUserInputRequest(orchId, "Question no longer pending");
        if (orchId === activeOrchId) syncInputBarMode();
        return false;
    }
    const previous = sessionPendingQuestions.get(orchId);
    sessionPendingQuestions.set(orchId, normalized);
    if (orchId === activeOrchId) syncInputBarMode();
    return previous !== normalized;
}

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

function invalidateChat(scrollIntent) {
    if (scrollIntent) _chatScrollIntent = scrollIntent;
    _chatDirty = true;
    _screenDirty = true;
}

function invalidateActivity(scrollIntent) {
    if (scrollIntent) _activityScrollIntent = scrollIntent;
    _activityDirty = true;
    _screenDirty = true;
}

const MAX_CHAT_BUFFER_LINES = 500;

function appendChatRaw(text, orchId) {
    // Guard: during startup, sessionChatBuffers and activeOrchId may not be initialized yet
    let buffers;
    try { buffers = sessionChatBuffers; } catch { return; }
    const currentActive = activeOrchId || undefined;
    const targetOrch = orchId || currentActive || "_init";
    if (!buffers.has(targetOrch)) buffers.set(targetOrch, []);
    const buf = buffers.get(targetOrch);
    buf.push(text);

    // Cap buffer size — drop oldest lines when it grows too large
    if (buf.length > MAX_CHAT_BUFFER_LINES) {
        const dropped = buf.length - MAX_CHAT_BUFFER_LINES + 1;
        buf.splice(0, dropped);
        buf[0] = `{gray-fg}── ${dropped} older lines trimmed ──{/gray-fg}`;
    }

    // Mark chat dirty so the frame loop syncs buffer → chatBox
    if (targetOrch === currentActive) {
        invalidateChat();
    }
}

function setStatus(text) {
    statusBar.setContent(`{white-fg}${text}{/white-fg}`);
    scheduleRender();
}

function setNavigationStatusForPane(kind) {
    const hints = {
        sessions: "{yellow-fg}j/k navigate · Enter switch · +/- expand/collapse · n new · t title · c cancel · d delete · r refresh · ? help · Esc then q quit{/yellow-fg}",
        chat: "{yellow-fg}j/k scroll · g/G top/bottom · e expand history · p prompt · ? help · Esc then q quit{/yellow-fg}",
        activity: "{yellow-fg}j/k scroll activity · g/G top/bottom · p prompt · ? help · Esc then q quit{/yellow-fg}",
        orchestration: "{yellow-fg}j/k scroll logs · g/G top/bottom · m cycle log mode · p prompt · ? help · Esc then q quit{/yellow-fg}",
        workers: "{yellow-fg}j/k scroll worker logs · g/G top/bottom · m cycle log mode · p prompt · ? help · Esc then q quit{/yellow-fg}",
        sequence: "{yellow-fg}j/k scroll sequence · g/G top/bottom · m cycle log mode · p prompt · ? help · Esc then q quit{/yellow-fg}",
        nodemap: "{yellow-fg}j/k scroll node map · g/G top/bottom · m cycle log mode · p prompt · ? help · Esc then q quit{/yellow-fg}",
        markdownList: "{yellow-fg}j/k choose file · Enter preview · d delete file · v exit viewer · ? help · Esc then q quit{/yellow-fg}",
        markdownPreview: "{yellow-fg}j/k scroll preview · g/G top/bottom · Ctrl+D/U page · o open · y copy path · v exit viewer · ? help{/yellow-fg}",
        prompt: "{yellow-fg}Type a message · Opt+Enter newline · Opt+←/→ word move · Opt+Backspace word delete · Esc for navigation mode{/yellow-fg}",
        answer: "{yellow-fg}Type your answer · Opt+Enter newline · Opt+←/→ word move · Opt+Backspace word delete · Esc for navigation mode{/yellow-fg}",
    };
    setStatus(hints[kind] || hints.chat);
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
        renderBufferToPane(buf, pane, MAX_WORKER_RENDER_LINES, (entry) => {
            if (entry.orchId && entry.orchId === activeOrchId) {
                return `{bold}${entry.text}{/bold}`;
            } else if (entry.orchId) {
                return `{white-fg}${entry.text}{/white-fg}`;
            }
            return entry.text;
        });
        totalLines += Math.min(buf.length, MAX_WORKER_RENDER_LINES);
    }
    screen.render();
    perfEnd(_ph, { panes: paneCount, lines: totalLines });
}

function showCopilotMessage(raw, orchId) {
    const _ph = perfStart("showCopilotMessage");

    appendActivity(`{green-fg}[obs] showCopilotMessage called for ${orchId === activeOrchId ? "ACTIVE" : "background"} session, len=${raw?.length || 0}{/green-fg}`, orchId);

    // Detect and register artifact links before rendering
    detectArtifactLinks(raw, orchId);

    // Replace artifact:// URIs with highlighted display before markdown rendering
    let displayRaw = raw;
    if (displayRaw) {
        displayRaw = displayRaw.replace(
            /artifact:\/\/[a-f0-9-]+\/([^\s"'{}]+)/g,
            "📎 **$1** _(press 'a' to download)_",
        );
    }

    const rendered = renderMarkdown(displayRaw);
    const prefix = `{white-fg}[${ts()}]{/white-fg} {cyan-fg}{bold}Copilot:{/bold}{/cyan-fg}`;
    appendChatRaw(prefix, orchId);
    // Always show on separate lines for readability
    for (const line of rendered.split("\n")) {
        appendChatRaw(line, orchId);
    }
    appendChatRaw("", orchId); // blank line after each message
    perfEnd(_ph, { len: raw?.length || 0 });
}

function normalizeObserverChatText(text) {
    if (typeof text !== "string") return "";
    return text.replace(/\r\n/g, "\n").trim();
}

function promoteIntermediateContent(raw, orchId) {
    const normalized = normalizeObserverChatText(raw);
    if (!normalized) return;
    if (sessionPromotedIntermediate.get(orchId) === normalized) return;
    showCopilotMessage(raw, orchId);
    sessionPromotedIntermediate.set(orchId, normalized);
}

function shouldSkipCompletedTurnResult(raw, orchId) {
    const normalized = normalizeObserverChatText(raw);
    const promoted = sessionPromotedIntermediate.get(orchId);
    sessionPromotedIntermediate.delete(orchId);
    const recovered = sessionRecoveredTurnResult.get(orchId);
    sessionRecoveredTurnResult.delete(orchId);
    if (normalized && recovered && normalized === recovered) return true;
    return Boolean(normalized && promoted && normalized === promoted);
}

function isBootstrapPromptForSession(text, orchId) {
    const normalized = normalizeObserverChatText(text);
    if (!normalized) return false;
    const agentId = sessionAgentIds.get(orchId);
    if (agentId) {
        const agent = _workerLoadedAgents.find((candidate) => candidate.id === agentId || candidate.name === agentId);
        if (agent?.initialPrompt && normalizeObserverChatText(agent.initialPrompt) === normalized) {
            return true;
        }
    }
    return _workerLoadedAgents.some((candidate) => {
        if (!candidate?.initialPrompt) return false;
        return normalizeObserverChatText(candidate.initialPrompt) === normalized;
    });
}

// Track whether sequence view has been seeded from CMS for a session.
const seqCmsSeededSessions = new Set();

/**
 * Load conversation history from CMS and rebuild chat buffer for the session.
 * Includes ALL persisted events (not truncated) so switching sessions is deterministic.
 */
async function loadCmsHistory(orchId, options = {}) {
    const _ph = perfStart("loadCmsHistory");
    const sid = orchId.startsWith("session-") ? orchId.slice(8) : orchId;
    const force = options.force === true;
    let eventCount = 0;
    let loadFailed = false;

    // Skip if we already have a recent cached buffer.
    // The CMS poller handles incremental updates for the active session,
    // so reloading on every session switch just adds latency.
    const cached = sessionChatBuffers.get(orchId);
    const loadedAt = sessionHistoryLoadedAt.get(orchId) ?? 0;
    if (!force && cached && cached.length > 1 && (Date.now() - loadedAt) < 30_000 && !orchHasChanges.has(orchId)) {
        perfEnd(_ph, { orchId: orchId.slice(0, 12), cached: true });
        return;
    }

    const inFlight = sessionHistoryLoadPromises.get(orchId);
    if (inFlight && !force) {
        perfEnd(_ph, { orchId: orchId.slice(0, 12), deduped: true });
        return inFlight;
    }

    const generation = (sessionHistoryLoadGeneration.get(orchId) ?? 0) + 1;
    sessionHistoryLoadGeneration.set(orchId, generation);

    const loadPromise = (async () => {
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
            const expand = sessionExpandLevel.get(orchId) || 0;
            const CMS_HISTORY_FETCH_LIMIT = expand >= 2 ? 2000 : expand >= 1 ? 500 : 250;
            const MAX_RENDERED_EVENTS = expand >= 2 ? 2000 : expand >= 1 ? 500 : 120;
            const MAX_TOTAL_RENDER_CHARS = expand >= 2 ? 500_000 : expand >= 1 ? 200_000 : 50_000;
            const MAX_ASSISTANT_MESSAGE_CHARS = expand >= 1 ? 20_000 : 4_000;
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
            let liveResponsePayload = null;
            if (liveStatus?.customStatus) {
                try {
                    liveCustomStatus = typeof liveStatus.customStatus === "string"
                        ? JSON.parse(liveStatus.customStatus)
                        : liveStatus.customStatus;
                } catch {}
            }
            if (liveCustomStatus?.responseVersion) {
                liveResponsePayload = await fetchLatestResponsePayload(orchId, dc);
            }

            const liveTurnContent = liveCustomStatus?.turnResult?.type === "completed"
                ? liveCustomStatus.turnResult.content
                : liveResponsePayload?.type === "completed"
                    ? liveResponsePayload.content
                    : "";

            // Populate session model if not already known
            if (info?.model) {
                sessionModels.set(orchId, info.model);
                if (orchId === activeOrchId) updateChatLabel();
            }

            if ((!events || events.length === 0) && !liveTurnContent) {
                if (sessionHistoryLoadGeneration.get(orchId) !== generation) {
                    return;
                }
                // Only blank the buffer if the observer hasn't already written
                // content into it. Otherwise we'd nuke live turn output that
                // arrived while we were fetching from CMS (race condition that
                // causes empty chat on first switch to a session).
                const existing = sessionChatBuffers.get(orchId);
                const isLoadingPlaceholder = existing
                    && existing.length === 1
                    && /Loading/.test(existing[0]);
                if (!existing || existing.length === 0 || isLoadingPlaceholder) {
                    const splashLines = ensureSessionSplashBuffer(orchId);
                    if (!splashLines) {
                        sessionChatBuffers.set(orchId, ["{gray-fg}(no recent chat history yet){/gray-fg}"]);
                    }
                }
                const existingActivity = sessionActivityBuffers.get(orchId);
                if (!existingActivity || existingActivity.length === 0) {
                    sessionActivityBuffers.set(orchId, ["{gray-fg}(no recent activity yet){/gray-fg}"]);
                }
                sessionHistoryLoadedAt.set(orchId, Date.now());
                sessionRenderedCmsSeq.set(orchId, 0);
                sessionRecoveredTurnResult.delete(orchId);
                if (orchId === activeOrchId) {
                    invalidateChat();
                    invalidateActivity();
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
                return formatDisplayTime(value, {
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
                lines.push(`{gray-fg}── ${events.length - MAX_RENDERED_EVENTS} older events omitted (${events.length} total) · press {bold}e{/bold} to expand ──{/gray-fg}`);
                lines.push("");
            }
            for (const evt of renderEvents) {
                const type = evt.eventType;
                const timeStr = fmtTime(evt.createdAt);
                if (type === "user.message") {
                    const content = stripHostPrefix(evt.data?.content);
                    if (content && !content.startsWith("[SYSTEM:") && !isTimerPrompt(content) && !isBootstrapPromptForSession(content, orchId)) {
                        // Format CHILD_UPDATE messages as distinct cards
                        const childMatch = content.match(/^\[CHILD_UPDATE from=(\S+) type=(\S+)(?:\s+iter=(\d+))?\]\n?(.*)$/s);
                        if (childMatch) {
                            const childId = childMatch[1].slice(0, 8);
                            const updateType = childMatch[2];
                            const body = (childMatch[4] || "").trim();
                            const childTitle = sessionHeadings.get(`session-${childMatch[1]}`) || `Agent ${childId}`;
                            const typeColor = updateType === "completed" ? "green" : updateType === "error" ? "red" : "magenta";
                            lines.push(`{white-fg}[${timeStr}]{/white-fg}`);
                            lines.push(`{${typeColor}-fg}┌─ {bold}${childTitle}{/bold} · ${updateType} ─┐{/${typeColor}-fg}`);
                            if (body) {
                                const bodyLines = body.split("\n");
                                for (const bl of bodyLines.slice(0, 8)) {
                                    lines.push(`{${typeColor}-fg}│{/${typeColor}-fg}  ${bl}`);
                                }
                                if (bodyLines.length > 8) {
                                    lines.push(`{${typeColor}-fg}│{/${typeColor}-fg}  {gray-fg}… ${bodyLines.length - 8} more lines{/gray-fg}`);
                                }
                            }
                            lines.push(`{${typeColor}-fg}└${"─".repeat(30)}┘{/${typeColor}-fg}`);
                            lines.push("");
                        } else {
                            lines.push(`{white-fg}[${timeStr}]{/white-fg} {bold}You:{/bold} ${content}`);
                        }
                    }
                } else if (type === "assistant.message") {
                    const content = evt.data?.content;
                    if (content) {
                        lastAssistantContent = content;
                        detectArtifactLinks(content, orchId);
                        if (renderedChars >= MAX_TOTAL_RENDER_CHARS) {
                            lines.push(`{gray-fg}── additional assistant output omitted to keep session switching fast ──{/gray-fg}`);
                            lines.push("");
                            break;
                        }
                        const clipped = content.length > MAX_ASSISTANT_MESSAGE_CHARS
                            ? content.slice(0, MAX_ASSISTANT_MESSAGE_CHARS) + "\n\n[output truncated in TUI history view]"
                            : content;
                        const displayClipped = clipped.replace(
                            /artifact:\/\/[a-f0-9-]+\/([^\s"'{}]+)/g,
                            "📎 **$1** _(press 'a' to download)_",
                        );
                        lines.push(`{white-fg}[${timeStr}]{/white-fg} {cyan-fg}{bold}Copilot:{/bold}{/cyan-fg}`);
                        const rendered = renderMarkdown(displayClipped);
                        renderedChars += clipped.length;
                        for (const line of rendered.split("\n")) {
                            lines.push(line);
                        }
                        lines.push("");
                    }
                } else if (type === "tool.execution_start") {
                    activityLines.push(formatToolActivityLine(timeStr, evt, "start"));
                } else if (type === "tool.execution_complete") {
                    activityLines.push(formatToolActivityLine(timeStr, evt, "complete"));
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
                sessionRecoveredTurnResult.set(orchId, normalizedLiveTurn);
                noteSeenResponseVersion(orchId, liveResponsePayload?.version);
            } else {
                sessionRecoveredTurnResult.delete(orchId);
            }

            if (eventCount > 0) {
                lines.push(`{white-fg}── recent history loaded from database (${eventCount} events fetched) ──{/white-fg}`);
                lines.push("");
            }

            if (systemSplashText.has(orchId)) {
                const splashText = systemSplashText.get(orchId);
                const splashLines = splashText.split("\n");
                const hasSplashPrefix = lines.length >= splashLines.length
                    && splashLines.every((line, idx) => lines[idx] === line);
                if (!hasSplashPrefix) {
                    lines.unshift(...splashLines, "");
                }
                sessionSplashApplied.add(orchId);
            }

            if (sessionHistoryLoadGeneration.get(orchId) !== generation) {
                return;
            }

            const maxRenderedSeq = (events || []).reduce((max, evt) => Math.max(max, evt.seq || 0), 0);

            // Append pending question so it survives the history buffer swap.
            // The observer may have written it into the old buffer, but this
            // replacement would nuke it without this check.
            const pendingQ = sessionPendingQuestions.get(orchId);
            if (pendingQ) {
                lines.push(`{cyan-fg}{bold}Copilot:{/bold}{/cyan-fg}`);
                const renderedQ = renderMarkdown(pendingQ);
                for (const line of renderedQ.split("\n")) {
                    lines.push(line);
                }
                lines.push("");
            }

            // If CMS history produced no chat-visible lines (only the footer),
            // but the observer previously wrote real content into the buffer,
            // keep the existing buffer. This handles the case where assistant
            // response text comes via the observer (customStatus streaming) but
            // hasn't been persisted as CMS assistant.message events yet.
            const chatContentLines = lines.filter(l =>
                l && !/^{(?:white|gray)-fg}──/.test(l) && l.trim() !== "",
            );
            const existing = sessionChatBuffers.get(orchId);
            const existingHasContent = existing && existing.length > 1
                && existing.some(l => l && !/Loading/.test(l) && !/no recent/.test(l));

            if (chatContentLines.length === 0 && existingHasContent) {
                // CMS has no chat-worthy content but observer buffer does —
                // append the footer to the existing buffer instead of replacing.
                if (eventCount > 0) {
                    const footerIdx = lines.findIndex(l => /recent history loaded/.test(l));
                    if (footerIdx >= 0) {
                        existing.push(lines[footerIdx]);
                        existing.push("");
                    }
                }
            } else {
                sessionChatBuffers.set(orchId, lines);
            }
            sessionActivityBuffers.set(orchId, activityLines);
            sessionHistoryLoadedAt.set(orchId, Date.now());
            sessionRenderedCmsSeq.set(orchId, maxRenderedSeq);

            if (orchId === activeOrchId) {
                invalidateChat();
                invalidateActivity();
            }

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
        } finally {
            if (sessionHistoryLoadPromises.get(orchId) === loadPromise) {
                sessionHistoryLoadPromises.delete(orchId);
            }
        }
    })();

    sessionHistoryLoadPromises.set(orchId, loadPromise);
    try {
        return await loadPromise;
    } finally {
        perfEnd(_ph, {
            orchId: orchId.slice(0, 12),
            events: eventCount,
            err: loadFailed || undefined,
            force: force || undefined,
        });
    }
}

// ─── Start the PilotSwarm client (embedded workers + client) ────────

const store = process.env.DATABASE_URL || "sqlite::memory:";
const cmsSchema = process.env.CMS_SCHEMA || undefined;
const duroxideSchema = process.env.DUROXIDE_SCHEMA || undefined;
const numWorkers = parseInt(process.env.WORKERS ?? "4", 10);
const isRemote = numWorkers === 0;

if (isRemote) {
    const title = formatWindowTitle("Scaled — Remote Workers");
    screen.title = title;
    applyWindowTitle(title);
    appendLog("{bold}Mode:{/bold} {magenta-fg}Scaled (AKS Workers){/magenta-fg}");
    appendLog(`{bold}Store:{/bold} {green-fg}Remote PostgreSQL{/green-fg}`);
    appendLog("{bold}Runtime:{/bold} {yellow-fg}AKS pods (remote){/yellow-fg}");
} else {
    const title = formatWindowTitle(`${numWorkers} Embedded Workers`);
    screen.title = title;
    applyWindowTitle(title);
    appendLog("{bold}Mode:{/bold} {magenta-fg}Scaled (Embedded Workers){/magenta-fg}");
    appendLog(`{bold}Store:{/bold} {green-fg}${store.includes("postgres") ? "Remote PostgreSQL" : store}{/green-fg}`);
    appendLog(`{bold}Workers:{/bold} {yellow-fg}${numWorkers} local runtimes{/yellow-fg}`);
}
appendLog("");

// 1. Start N worker runtimes (skip if WORKERS=0 for AKS mode)
const workers = [];
let modelProviders = null;
let logTailInterval = null;
// Default model — prefer registry defaultModel, env override, then empty (worker picks default).
let currentModel = process.env.COPILOT_MODEL || "";
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

    // System message: env override > worker module > default agent (from plugin)
    const WORKER_SYSTEM_MESSAGE = process.env._TUI_SYSTEM_MESSAGE || undefined;

    // Plugin directories: env override or default to bundled plugins/\n    const defaultPluginDir = path.resolve(__dirname, "..", "plugins");
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
            ...(duroxideSchema ? { duroxideSchema } : {}),
            ...(cmsSchema ? { cmsSchema } : {}),
            githubToken: process.env.GITHUB_TOKEN,
            logLevel: process.env.LOG_LEVEL || "error",
            sessionStateDir: process.env.SESSION_STATE_DIR || path.join(os.homedir(), ".copilot", "session-state"),
            blobConnectionString: workerModuleConfig.blobConnectionString || process.env.AZURE_STORAGE_CONNECTION_STRING,
            blobContainer: process.env.AZURE_STORAGE_CONTAINER || "copilot-sessions",
            workerNodeId: `local-rt-${i}`,
            systemMessage: workerModuleConfig.systemMessage || WORKER_SYSTEM_MESSAGE || undefined,
            pluginDirs,
            ...(llmProvider && { provider: llmProvider }),
            ...(workerModuleConfig.skillDirectories && { skillDirectories: workerModuleConfig.skillDirectories }),
            ...(workerModuleConfig.customAgents && { customAgents: workerModuleConfig.customAgents }),
            ...(workerModuleConfig.mcpServers && { mcpServers: workerModuleConfig.mcpServers }),
        });
        // Register custom tools from worker module
        const workerTools = typeof workerModuleConfig.createTools === "function"
            ? await workerModuleConfig.createTools({ workerNodeId: `local-rt-${i}`, workerIndex: i })
            : workerModuleConfig.tools;
        if (workerTools?.length) {
            w.registerTools(workerTools);
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
    logTailInterval = setInterval(() => {
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

// In remote mode (no local workers), load model_providers.json directly
// so the TUI can show model lists and the Shift+N picker.
// In remote mode (no local workers), load model info from mgmt client after start.
// modelProviders variable is kept for backward compat with existing rendering code,
// but now backed by the management client instead of direct implementation import.
if (!modelProviders) {
    // Will be populated from mgmt.getModelsByProvider() after mgmt.start()
}

// Capture session policy + agent list from the first worker.
// In remote mode (no local workers), load directly from the plugin directory
// so the TUI enforces the same session creation restrictions as the backend.
let _workerSessionPolicy = workers[0]?.sessionPolicy || null;
let _workerAllowedAgentNames = workers[0]?.allowedAgentNames || [];
let _workerLoadedAgents = workers[0]?.loadedAgents || [];

if (workers.length === 0 && process.env.PLUGIN_DIRS) {
    const pluginDirsArr = process.env.PLUGIN_DIRS.split(",").map(d => d.trim()).filter(Boolean);
    for (const dir of pluginDirsArr) {
        const policyFile = path.join(dir, "session-policy.json");
        if (fs.existsSync(policyFile)) {
            try { _workerSessionPolicy = JSON.parse(fs.readFileSync(policyFile, "utf-8")); } catch {}
        }
        const agentsDir = path.join(dir, "agents");
        if (fs.existsSync(agentsDir)) {
            try {
                const agents = loadAgentFiles(agentsDir).filter(a => !a.system && a.name !== "default");
                _workerLoadedAgents = agents;
                _workerAllowedAgentNames = agents.map(a => a.name).filter(Boolean);
            } catch {}
        }
    }
}
if (_workerSessionPolicy) {
    appendLog(`Session policy: mode=${_workerSessionPolicy.creation?.mode || "open"}, allowGeneric=${_workerSessionPolicy.creation?.allowGeneric ?? true}`);
}
if (_workerAllowedAgentNames.length > 0) {
    appendLog(`Available agents: ${_workerAllowedAgentNames.join(", ")}`);
}

// 2. Start the thin client (for creating orchestrations / reading status)
const client = new PilotSwarmClient({
    store,
    blobEnabled: true,
    ...(duroxideSchema ? { duroxideSchema } : {}),
    ...(cmsSchema ? { cmsSchema } : {}),
    ...(_workerSessionPolicy ? { sessionPolicy: _workerSessionPolicy } : {}),
    ...(_workerAllowedAgentNames.length > 0 ? { allowedAgentNames: _workerAllowedAgentNames } : {}),
});

// 3. Start the management client (for session listing, admin, models)
const mgmt = new PilotSwarmManagementClient({
    store,
    ...(duroxideSchema ? { duroxideSchema } : {}),
    ...(cmsSchema ? { cmsSchema } : {}),
});

const STARTUP_DB_RETRY_MS = 30_000;
const STARTUP_DB_CONNECT_TIMEOUT_MS = 10_000;

function isStartupTransientDbError(err) {
    const msg = String(err?.message || err || "");
    return /ENOTFOUND|ETIMEDOUT|ECONNREFUSED|ECONNRESET|EHOSTUNREACH|socket hang up|getaddrinfo|timeout|network|pool timed out while waiting for an open connection/i.test(msg);
}

// Register quit handler BEFORE the connection loop so the user can always exit.
let _startupQuit = false;
let _startupPhase = true;
screen.key(["C-c"], () => {
    if (_startupPhase) { _startupQuit = true; process.exit(0); }
});
const _startupQHandler = () => {
    if (_startupPhase) { _startupQuit = true; process.exit(0); }
};
screen.key(["q"], _startupQHandler);

setStatus(isRemote ? "Connecting to remote DB..." : "Connecting client...");

// Show splash immediately so the user sees something during DB connection
chatBox.setContent(`${ACTIVE_STARTUP_SPLASH_CONTENT}\n\n  {white-fg}Connecting...{/white-fg}`);
_origRender();

// Start both clients with retry — they each open their own PG pool.
// During remote DB outages, keep the TUI alive and retry every 30s.
// The connection attempt has a hard timeout so bad hosts fail fast.
while (true) {
    const _startPh = perfStart("startup.clientConnect");

    // Race the connection against a timeout so unreachable hosts don't block for minutes
    const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error("Connection timed out (10s deadline)")), STARTUP_DB_CONNECT_TIMEOUT_MS)
    );
    const results = await Promise.allSettled([
        Promise.race([client.start(), timeoutPromise]),
        Promise.race([mgmt.start(), timeoutPromise]),
    ]);
    const failure = results.find(r => r.status === "rejected");

    if (!failure) {
        perfEnd(_startPh);
        break;
    }

    const err = failure.reason;
    perfEnd(_startPh, { err: true });

    try { await client.stop(); } catch {}
    try { await mgmt.stop(); } catch {}

    if (!isStartupTransientDbError(err)) {
        throw err;
    }

    const msg = String(err?.message || err || "Unknown database error");
    setStatus(`Database unavailable — retrying in 30s (${msg.slice(0, 80)})`);
    chatBox.setContent(`${ACTIVE_STARTUP_SPLASH_CONTENT}\n\n  {yellow-fg}Database unavailable.{/yellow-fg}\n  {white-fg}${msg}{/white-fg}\n\n  {gray-fg}Retrying connection in 30 seconds... (press q or Ctrl+C to quit){/gray-fg}`);
    _origRender();

    // Interruptible sleep — check every 500ms if the user pressed quit
    const retryEnd = Date.now() + STARTUP_DB_RETRY_MS;
    while (Date.now() < retryEnd) {
        if (_startupQuit) process.exit(0);
        await new Promise(r => setTimeout(r, 500));
    }
}

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
_startupPhase = false; // Disable startup quit handlers — normal key handling takes over
screen.unkey(["q"], _startupQHandler);
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
const sessionAgentIds = new Map(); // orchId → agentId string (e.g. "pilotswarm", "sweeper")

// Per-session chat buffers — every observer writes here so content is preserved on switch
const sessionChatBuffers = new Map(); // orchId → string[]
const sessionHistoryLoadedAt = new Map(); // orchId → epoch ms of last CMS history load
const sessionHistoryLoadGeneration = new Map(); // orchId → monotonically increasing async load token
const sessionHistoryLoadPromises = new Map(); // orchId → in-flight CMS history load promise
const sessionRenderedCmsSeq = new Map(); // orchId → highest CMS seq already incorporated into buffers
const sessionExpandLevel = new Map(); // orchId → 0 (default) | 1 | 2 (how many times user expanded history)
const sessionSplashApplied = new Set(); // orchIds that have had splash prepended (idempotency guard)
const sessionPromotedIntermediate = new Map(); // orchId → normalized intermediate content already promoted to Chat
const sessionRecoveredTurnResult = new Map(); // orchId → normalized completed turn recovered from live status during CMS load
const sessionObservers = new Map(); // orchId → AbortController
const sessionLiveStatus = new Map(); // orchId → "idle"|"running"|"waiting"|"input_required"
const sessionPendingTurns = new Set(); // orchIds with a locally-sent turn awaiting first live status
const sessionPendingQuestions = new Map(); // orchId → latest input-required question awaiting a user answer
const sessionLastSeenResponseVersion = new Map(); // orchId → latest KV-backed response version rendered
const sessionLastSeenCommandVersion = new Map(); // orchId → latest KV-backed command response version rendered
const sessionLoggedTerminalStatus = new Map(); // orchId → last terminal orchestration status already logged to Activity

function isTerminalOrchestrationStatus(status) {
    return status === "Completed" || status === "Failed" || status === "Terminated";
}

function isTerminalSessionState(state) {
    return state === "completed" || state === "failed" || state === "error" || state === "terminated";
}

function shouldObserveSession(orchId, cached = orchStatusCache.get(orchId)) {
    if (!orchId || sessionObservers.has(orchId)) return false;
    const visualState = getSessionVisualState(orchId, cached);
    return !isTerminalSessionState(visualState);
}

function getSessionVisualState(orchId, cached = orchStatusCache.get(orchId)) {
    const liveState = sessionLiveStatus.get(orchId) || cached?.liveState;
    if (liveState) return liveState;
    switch (cached?.status) {
        case "Completed": return "completed";
        case "Failed": return "failed";
        case "Terminated": return "terminated";
        case "Running": return "running";
        case "Pending": return "pending";
        default: return "unknown";
    }
}

function getSessionStateColor(state) {
    switch (state) {
        case "running": return "green";
        case "waiting": return "yellow";
        case "idle": return "white";
        case "input_required": return "cyan";
        case "completed": return "gray";
        case "failed":
        case "error": return "red";
        case "terminated": return "yellow";
        default: return "white";
    }
}

function getSessionStateIcon(state) {
    switch (state) {
        case "running": return "{green-fg}*{/green-fg}";
        case "waiting": return "{yellow-fg}~{/yellow-fg}";
        case "idle": return "{white-fg}.{/white-fg}";
        case "input_required": return "{cyan-fg}?{/cyan-fg}";
        case "failed":
        case "error": return "{red-fg}!{/red-fg}";
        default: return "";
    }
}

function setSessionPendingTurn(orchId, pending) {
    if (!orchId) return;
    if (pending) sessionPendingTurns.add(orchId);
    else sessionPendingTurns.delete(orchId);
}

function isTurnInProgressForSession(orchId) {
    if (!orchId) return false;
    const liveStatus = sessionLiveStatus.get(orchId);
    return sessionPendingTurns.has(orchId) || liveStatus === "running" || liveStatus === "waiting";
}

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
        async getLatestResponse(orchId) {
            const sid = orchId.startsWith("session-") ? orchId.slice(8) : orchId;
            return mgmt.getLatestResponse(sid);
        },
        async getCommandResponse(orchId, cmdId) {
            const sid = orchId.startsWith("session-") ? orchId.slice(8) : orchId;
            return mgmt.getCommandResponse(sid, cmdId);
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

function noteSeenResponseVersion(orchId, version) {
    if (!orchId || !version) return;
    const prev = sessionLastSeenResponseVersion.get(orchId) || 0;
    if (version > prev) sessionLastSeenResponseVersion.set(orchId, version);
}

function noteSeenCommandVersion(orchId, version) {
    if (!orchId || !version) return;
    const prev = sessionLastSeenCommandVersion.get(orchId) || 0;
    if (version > prev) sessionLastSeenCommandVersion.set(orchId, version);
}

async function fetchLatestResponsePayload(orchId, dc = getDc()) {
    if (!dc?.getLatestResponse) return null;
    try {
        return await dc.getLatestResponse(orchId);
    } catch {
        return null;
    }
}

async function consumeLatestResponsePayload(orchId, customStatus, dc = getDc()) {
    if (!customStatus?.responseVersion || !dc?.getLatestResponse) return null;
    const seen = sessionLastSeenResponseVersion.get(orchId) || 0;
    if (customStatus.responseVersion <= seen) return null;
    const payload = await fetchLatestResponsePayload(orchId, dc);
    noteSeenResponseVersion(orchId, payload?.version || customStatus.responseVersion);
    return payload;
}

async function consumeCommandResponsePayload(orchId, customStatus, dc = getDc()) {
    if (!customStatus?.commandVersion || !customStatus?.commandId || !dc?.getCommandResponse) return null;
    const seen = sessionLastSeenCommandVersion.get(orchId) || 0;
    if (customStatus.commandVersion <= seen) return null;
    let payload = null;
    try {
        payload = await dc.getCommandResponse(orchId, customStatus.commandId);
    } catch {}
    noteSeenCommandVersion(orchId, payload?.version || customStatus.commandVersion);
    return payload;
}

// ─── Debounced refresh ───────────────────────────────────────────
// Multiple observers fire updateLiveStatus rapidly — coalesce into one
// refreshOrchestrations() call per 500ms window.
let _refreshPending = false;
let _refreshRunning = false;
const DB_RETRY_INTERVAL_MS = 30_000;
let _dbOffline = false;
let _dbNextRetryAt = 0;
let _dbLastError = "";

function isTransientDbError(err) {
    const msg = String(err?.message || err || "");
    return /ENOTFOUND|ETIMEDOUT|ECONNREFUSED|ECONNRESET|EHOSTUNREACH|socket hang up|getaddrinfo|timeout|network/i.test(msg);
}

function handleDbUnavailable(err) {
    const msg = String(err?.message || err || "Unknown database error");
    const wasOffline = _dbOffline;
    const prevError = _dbLastError;
    _dbOffline = true;
    _dbNextRetryAt = Date.now() + DB_RETRY_INTERVAL_MS;
    _dbLastError = msg;

    if (!wasOffline || prevError !== msg) {
        appendLog(`{yellow-fg}Database unavailable — retrying in 30s.{/yellow-fg}`);
    }
    setStatus(`Database unavailable — retrying in 30s (${msg.slice(0, 80)})`);
}

function handleDbRecovered() {
    if (_dbOffline) {
        appendLog(`{green-fg}Database connection restored.{/green-fg}`);
        setStatus("Database connection restored.");
    }
    _dbOffline = false;
    _dbNextRetryAt = 0;
    _dbLastError = "";
}

function scheduleRefreshOrchestrations(force = false) {
    if (_refreshPending) return;
    _refreshPending = true;
    setTimeout(async () => {
        _refreshPending = false;
        if (_refreshRunning) return; // skip if previous call still in-flight
        _refreshRunning = true;
        try {
            await refreshOrchestrations(force);
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
        const cached = orchStatusCache.get(id);
        const visualState = getSessionVisualState(id, cached);
        const statusIcon = getSessionStateIcon(visualState);
        const color = getSessionStateColor(visualState);

        // Rebuild just this item's label
        const uuid4 = shortId(id);
        const createdAt = cached?.createdAt || 0;
        const timeStr = createdAt > 0
            ? formatDisplayDateTime(createdAt, {
                month: "short", day: "numeric",
                hour: "2-digit", minute: "2-digit",
                hour12: false,
            })
            : "";

        const hasChanges = orchHasChanges.has(id);
        const isActive = id === activeOrchId;
        const marker = isActive ? "{bold}▸{/bold}" : " ";
        const changeSuffix = hasChanges ? " {cyan-fg}{bold}●{/bold}{/cyan-fg}" : "";
        const statusIconSlot = statusIcon ? statusIcon + " " : "  ";
        const heading = sessionHeadings.get(id);
        // Use cached depth from last full refresh
        const depth = orchDepthMap?.get(id) ?? 0;
        const indent = depth > 0 ? "   ".repeat(depth - 1) + "  └ " : "";

        // System sessions get special rendering: yellow, ≋ icon
        if (systemSessionIds.has(id)) {
            const collapseBadge = getCollapseBadge(id);
            const sysLabel = heading
                ? `${heading} (${uuid4}) ${timeStr}${collapseBadge}${changeSuffix}`
                : `System Agent (${uuid4}) ${timeStr}${collapseBadge}${changeSuffix}`;
            orchList.setItem(i, `${indent}${marker}{bold}{yellow-fg}≋ ${sysLabel}{/yellow-fg}{/bold}`);
        } else {
            const collapseBadge = getCollapseBadge(id);
            const label = heading
                ? `${heading} (${uuid4}) ${timeStr}${collapseBadge}${changeSuffix}`
                : `(${uuid4}) ${timeStr}${collapseBadge}${changeSuffix}`;
            orchList.setItem(i, `${indent}${marker}${statusIconSlot}{${color}-fg}${label}{/${color}-fg}`);
        }
    }
    perfEnd(_ph, { n: orchIdOrder.length });
    scheduleRender();
}

// Cache depth per orchId from last full refresh so lightweight update can use them
let orchDepthMap = new Map();
// Track which parent sessions have their children collapsed
let collapsedParents = new Set();
// Track which parents we've already auto-collapsed (so we don't reset user toggles)
let collapsedInitialized = new Set();
// Module-level parent→children map rebuilt on each refresh
let orchChildrenOf = new Map();
// Module-level child→parent map rebuilt on each refresh
let orchChildToParent = new Map();
// Track how many descendants are hidden per collapsed parent
let orchCollapsedCount = new Map();
// Track total descendant count per parent regardless of collapsed state
let orchDescendantCount = new Map();

function getCollapseBadge(orchId) {
    const totalDescendants = orchDescendantCount.get(orchId) || 0;
    if (collapsedParents.has(orchId) && totalDescendants > 0) {
        return ` {cyan-fg}[+${totalDescendants}]{/cyan-fg}`;
    }
    const hidden = orchCollapsedCount.get(orchId);
    return hidden ? ` {cyan-fg}[+${hidden}]{/cyan-fg}` : "";
}

function canonicalSystemTitleFromSessionView(sv, orchId) {
    const agentId = sv?.agentId || sessionAgentIds.get(orchId) || "";
    if (agentId === "pilotswarm") return HAS_CUSTOM_TUI_BRANDING ? BASE_TUI_TITLE : "PilotSwarm Agent";
    if (agentId === "sweeper") return "Sweeper Agent";
    if (agentId === "resourcemgr") return "Resource Manager Agent";

    const rawTitle = sv?.title || sessionHeadings.get(orchId) || "";
    if (/^pilotswarm agent$/i.test(rawTitle)) return HAS_CUSTOM_TUI_BRANDING ? BASE_TUI_TITLE : "PilotSwarm Agent";
    if (/^sweeper agent$/i.test(rawTitle) || /^sweeper$/i.test(rawTitle)) return "Sweeper Agent";
    if (/^resource manager agent$/i.test(rawTitle) || /^resourcemgr$/i.test(rawTitle)) return "Resource Manager Agent";
    return rawTitle;
}

function brandedSplashForSessionView(sv, orchId) {
    const agentId = sv?.agentId || sessionAgentIds.get(orchId) || "";
    if (agentId === "pilotswarm" && HAS_CUSTOM_TUI_BRANDING) {
        return ACTIVE_STARTUP_SPLASH_CONTENT;
    }
    return sv?.splash || "";
}

async function refreshOrchestrations(force = false) {
    const _ph = perfStart("refreshOrchestrations");

    if (!force && _dbOffline && Date.now() < _dbNextRetryAt) {
        perfEnd(_ph, { sessions: 0, skipped: true, dbOffline: true });
        return;
    }

    // Fetch merged session views from the management client
    let sessionViews;
    try {
        sessionViews = await mgmt.listSessions();
        handleDbRecovered();
    } catch (err) {
        if (isTransientDbError(err)) {
            handleDbUnavailable(err);
        } else {
            appendLog(`{red-fg}listSessions failed: ${err.message}{/red-fg}`);
        }
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
        else if (liveState === "terminated") status = "Terminated";
        else if (liveState === "idle") status = "Running"; // idle = alive orchestration
        else if (liveState === "waiting") status = "Running";
        else if (liveState === "input_required") status = "Running";
        else if (liveState === "pending") status = "Pending";

        orchStatusCache.set(id, { status, createdAt, liveState });
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
            const canonicalTitle = canonicalSystemTitleFromSessionView(sv, id);
            if (canonicalTitle) sessionHeadings.set(id, canonicalTitle);
        }
        if (sv.agentId) {
            sessionAgentIds.set(id, sv.agentId);
        }

        // Splash from CMS — store and pre-populate chat buffer on first discovery
        const splashText = brandedSplashForSessionView(sv, id);
        if (splashText && !systemSplashText.has(id)) {
            systemSplashText.set(id, splashText);
            if (!sessionChatBuffers.has(id) || sessionChatBuffers.get(id).length === 0) {
                sessionChatBuffers.set(id, []);
                const buf = sessionChatBuffers.get(id);
                for (const line of splashText.split("\n")) {
                    buf.push(line);
                }
                buf.push("");
            }
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
    // Update module-level maps for collapse/expand
    orchChildrenOf = childrenOf;
    orchChildToParent = childToParent;

    // Count all descendants for a node (recursive)
    function countDescendants(id) {
        let count = 0;
        const kids = childrenOf.get(id) || [];
        for (const kid of kids) {
            count += 1 + countDescendants(kid.id);
        }
        return count;
    }

    // Auto-collapse: any parent with children starts collapsed
    // (only on first appearance — don't reset user's toggle)
    for (const e of entries) {
        const kids = childrenOf.get(e.id);
        if (kids && kids.length > 0 && !collapsedInitialized.has(e.id)) {
            collapsedParents.add(e.id);
            collapsedInitialized.add(e.id);
        }
    }

    const presentIds = new Set(entries.map(e => e.id));
    const rootEntries = entries.filter(e => {
        const parentId = childToParent.get(e.id);
        return !parentId || !presentIds.has(parentId);
    });
    const orderedEntries = [];
    // System sessions go first (sorted among themselves by createdAt)
    const baseSystemAgentIds = new Set(["pilotswarm", "sweeper", "resourcemgr"]);
    const systemRoots = rootEntries
        .filter(e => systemSessionIds.has(e.id))
        .sort((a, b) => {
            const aBase = baseSystemAgentIds.has(sessionAgentIds.get(a.id) || "") ? 0 : 1;
            const bBase = baseSystemAgentIds.has(sessionAgentIds.get(b.id) || "") ? 0 : 1;
            if (aBase !== bBase) return aBase - bBase;
            return b.createdAt - a.createdAt;
        });
    const normalRoots = rootEntries.filter(e => !systemSessionIds.has(e.id));
    orchCollapsedCount = new Map();
    orchDescendantCount = new Map();
    for (const e of entries) {
        orchDescendantCount.set(e.id, countDescendants(e.id));
    }
    const hiddenIds = new Set(); // IDs hidden by collapse
    function insertTree(entry, depth) {
        orderedEntries.push({ ...entry, depth });
        if (collapsedParents.has(entry.id)) {
            // Don't insert children — record hidden count and mark all descendants hidden
            const hidden = countDescendants(entry.id);
            if (hidden > 0) orchCollapsedCount.set(entry.id, hidden);
            markDescendantsHidden(entry.id);
            return;
        }
        const children = childrenOf.get(entry.id) || [];
        for (const child of children) {
            insertTree(child, depth + 1);
        }
    }
    function markDescendantsHidden(id) {
        const kids = childrenOf.get(id) || [];
        for (const kid of kids) {
            hiddenIds.add(kid.id);
            markDescendantsHidden(kid.id);
        }
    }
    for (const root of systemRoots) {
        insertTree(root, 0);
    }
    for (const root of normalRoots) {
        insertTree(root, 0);
    }
    // Orphan entries whose parent is not in the list (but skip collapsed/hidden ones)
    const orderedIds = new Set(orderedEntries.map(e => e.id));
    for (const e of entries) {
        if (!orderedIds.has(e.id) && !hiddenIds.has(e.id)) {
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
                ? formatDisplayDateTime(createdAt, {
                    month: "short", day: "numeric",
                    hour: "2-digit", minute: "2-digit",
                    hour12: false,
                })
                : "";
            const visualState = getSessionVisualState(id, orchStatusCache.get(id) || { status, createdAt });
            const color = getSessionStateColor(visualState);

            // Highlight sessions with unseen changes
            const hasChanges = orchHasChanges.has(id);
            const isActive = id === activeOrchId;
            const marker = isActive ? "{bold}▸{/bold}" : " ";
            const changeSuffix = hasChanges ? " {cyan-fg}{bold}●{/bold}{/cyan-fg}" : "";

            // Live status indicator
            const statusIcon = getSessionStateIcon(visualState);

            const statusIconSlot = statusIcon ? statusIcon + " " : "  ";
            const heading = sessionHeadings.get(id);
            const indent = depth > 0 ? "   ".repeat(depth - 1) + "  └ " : "";

            // System sessions get special rendering: yellow, ≋ icon
            if (systemSessionIds.has(id)) {
                const collapseBadge = getCollapseBadge(id);
                const sysLabel = heading
                    ? `${heading} (${uuid4}) ${timeStr}${collapseBadge}${changeSuffix}`
                    : `System Agent (${uuid4}) ${timeStr}${collapseBadge}${changeSuffix}`;
                orchList.addItem(`${indent}${marker}{bold}{yellow-fg}≋ ${sysLabel}{/yellow-fg}{/bold}`);
            } else {
                const collapseBadge = getCollapseBadge(id);
                const label = heading
                    ? `${heading} (${uuid4}) ${timeStr}${collapseBadge}${changeSuffix}`
                    : `(${uuid4}) ${timeStr}${collapseBadge}${changeSuffix}`;
                orchList.addItem(`${indent}${marker}${statusIconSlot}{${color}-fg}${label}{/${color}-fg}`);
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
        if (shouldObserveSession(id, orchStatusCache.get(id))
            && status !== "Completed" && status !== "Failed" && status !== "Terminated") {
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
const perfSummaryInterval = setInterval(() => {
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
async function requestQuit() {
    if (shutdownInProgress) return;
    shutdownInProgress = true;

    const message = isRemote
        ? "Shutting down client cleanly..."
        : "Waiting for embedded workers to shut down cleanly...";
    setStatus(`{yellow-fg}${message}{/yellow-fg}`);
    appendLog(`{yellow-fg}${message}{/yellow-fg}`);
    screen.render();

    try {
        await cleanup();
        process.exit(0);
    } catch {
        process.exit(1);
    }
}

orchList.key(["q"], () => {
    requestQuit();
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
    // If agents are available, show an agent picker
    const policy = _workerSessionPolicy;
    const agents = _workerLoadedAgents;
    const allowGeneric = policy?.creation?.allowGeneric ?? true;

    if (agents.length > 0) {
        const agentChoices = [];
        if (allowGeneric) {
            agentChoices.push({
                name: null,
                title: "Generic Session",
                description: "Open-ended PilotSwarm session with no specialized agent boundary.",
                splash: "{bold}{white-fg}Generic Session{/white-fg}{/bold}\n\nUse this only for open-ended work. Named agents are safer and more intentional.",
                tools: [],
            });
        }
        for (const agent of agents) {
            agentChoices.push({
                name: agent.name,
                title: agent.title || agent.name,
                description: agent.description || "",
                splash: agent.splash || null,
                initialPrompt: agent.initialPrompt || null,
                tools: Array.isArray(agent.tools) ? agent.tools : [],
            });
        }

        const modal = blessed.box({
            parent: screen,
            label: " {bold}Select agent for new session{/bold} ",
            tags: true,
            top: "center",
            left: "center",
            width: "84%",
            height: 22,
            border: { type: "line" },
            style: { border: { fg: "cyan" } },
        });

        const picker = blessed.list({
            parent: modal,
            tags: true,
            top: 0,
            left: 0,
            width: "38%",
            height: "100%-1",
            border: { type: "line" },
            style: {
                border: { fg: "cyan" },
                selected: { bg: "cyan", fg: "black", bold: true },
                item: { fg: "white" },
            },
            items: agentChoices.map(a => `  ${a.name || "(generic)"}${a.description ? ` — ${a.description}` : ""}`),
            keys: true,
            vi: true,
            mouse: true,
            scrollable: true,
        });

        const preview = blessed.box({
            parent: modal,
            label: " {bold}Preview{/bold} ",
            tags: true,
            top: 0,
            left: "38%",
            width: "62%",
            height: "72%",
            border: { type: "line" },
            scrollable: true,
            alwaysScroll: true,
            style: { border: { fg: "cyan" } },
        });

        const details = blessed.box({
            parent: modal,
            label: " {bold}Details{/bold} ",
            tags: true,
            top: "72%",
            left: "38%",
            width: "62%",
            height: "28%-1",
            border: { type: "line" },
            style: { border: { fg: "cyan" } },
        });

        const renderAgentChoice = (index) => {
            const choice = agentChoices[index] || agentChoices[0];
            const splash = buildAgentPickerSplash(choice);
            preview.setContent(splash);
            const toolLine = choice?.tools?.length ? choice.tools.join(", ") : "system defaults only";
            details.setContent(
                `{bold}${choice?.title || "Agent"}{/bold}\n\n` +
                `${choice?.description || "No description provided."}\n\n` +
                `{gray-fg}Tools:{/gray-fg} ${toolLine}`,
            );
            screen.render();
        };

        picker.focus();
        renderAgentChoice(0);
        screen.render();

        picker.on("select item", () => {
            renderAgentChoice(picker.selected);
        });

        picker.on("keypress", () => {
            setImmediate(() => renderAgentChoice(picker.selected));
        });

        picker.on("select", async (item, index) => {
            const choice = agentChoices[index];
            modal.detach();
            screen.render();

            try {
                let sess;
                if (choice?.name) {
                    sess = await createNewSessionForAgent(choice.name, choice.initialPrompt, buildAgentPickerSplash(choice), choice.title);
                    appendLog(`{green-fg}New ${choice.name} session: ${shortId(sess.sessionId)}…{/green-fg}`);
                } else {
                    sess = await createNewSession();
                    appendLog(`{green-fg}New session: ${shortId(sess.sessionId)}…{/green-fg}`);
                }
                const orchId = `session-${sess.sessionId}`;
                knownOrchestrationIds.add(orchId);
                await switchToOrchestration(orchId);
                await refreshOrchestrations();
                focusInput();
                screen.render();
            } catch (err) {
                appendLog(`{red-fg}Create failed: ${err.message}{/red-fg}`);
            }
        });

        picker.key(["escape", "q"], () => {
            modal.detach();
            orchList.focus();
            screen.render();
        });
        return;
    }

    // No agents loaded — create generic session directly
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

function shouldSuppressWorkerLogLine(plain) {
    if (!plain) return false;
    return (
        /^\[tool\]\s+.*copilotSessionId=/i.test(plain) ||
        /^\[runTurn\]\s+session=.*registering\s+\d+\s+tools:/i.test(plain)
    );
}

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
                if (shouldSuppressWorkerLogLine(plain)) continue;
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
                // Route to worker panes, not chat
                for (const [podName] of workerPanes) {
                    appendWorkerLog(podName, `{white-fg}${text}{/white-fg}`, null);
                }
            }
        });

        kubectlProc.on("error", (err) => {
            for (const [podName] of workerPanes) {
                appendWorkerLog(podName, `{yellow-fg}kubectl error: ${err.message}{/yellow-fg}`, null);
            }
        });

        // Auto-restart on exit (e.g., pods terminated during rollout)
        kubectlProc.on("exit", (code, signal) => {
            // Don't pollute chat — just log to worker panes
            for (const [podName] of workerPanes) {
                appendWorkerLog(podName, `{white-fg}kubectl exited (code=${code} signal=${signal}) — restarting in 5s{/white-fg}`, null);
            }
            kubectlProc = null;
            setTimeout(() => { startLogStream(); }, 5000);
        });
    } catch {
        appendLog("{yellow-fg}Could not start log stream{/yellow-fg}");
    }
}

let workerPruneInterval = null;

if (isRemote) {
    startLogStream();
    appendLog("{green-fg}Streaming AKS worker logs ↓{/green-fg}");

    // Periodically prune stale worker panes (every 30s)
    workerPruneInterval = setInterval(async () => {
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
let shutdownInProgress = false;

// currentModel is declared earlier (before model providers loading)

// Pending command responses — keyed by correlation ID
// Observer matches cmdResponse.id and displays results
const pendingCommands = new Map(); // id → { cmd, orchId, resolve, timer }

// Auto-timeout pending commands (default 15s, overridable)
function addPendingCommand(cmdId, cmd, timeoutMs = 15_000, orchId = activeOrchId) {
    const timer = setTimeout(() => {
        const pending = pendingCommands.get(cmdId);
        if (!pending) return;
        pendingCommands.delete(cmdId);
        appendChatRaw(`{yellow-fg}⏱ Command timed out: ${cmd} — the orchestration may be restarting. Try again.{/yellow-fg}`, orchId);
        if (orchId !== activeOrchId) {
            orchHasChanges.add(orchId);
            updateSessionListIcons();
        }
        screen.render();
    }, timeoutMs);
    pendingCommands.set(cmdId, { cmd, orchId, resolve: null, timer });
}

function resolvePendingDoneCommand(orchId, error) {
    for (const [pendingId, pending] of pendingCommands) {
        if (pending.cmd !== "done") continue;
        if (pending.orchId && pending.orchId !== orchId) continue;
        if (pending.timer) clearTimeout(pending.timer);
        pendingCommands.delete(pendingId);
        if (error) {
            appendChatRaw(`{red-fg}❌ Command failed: ${error}{/red-fg}`, orchId);
        } else {
            appendChatRaw("{green-fg}✓ Session completed.{/green-fg}", orchId);
        }
        if (orchId !== activeOrchId) {
            orchHasChanges.add(orchId);
            updateSessionListIcons();
        }
        screen.render();
        return true;
    }
    return false;
}

async function createNewSessionForAgent(agentName, initialPrompt, splash, title) {
    let sessionOrchId = null;
    const sess = await client.createSessionForAgent(agentName, {
        ...(currentModel ? { model: currentModel } : {}),
        toolNames: ["write_artifact", "export_artifact", "read_artifact"],
        ...(title ? { title } : {}),
        ...(splash ? { splash } : {}),
        ...(initialPrompt ? { initialPrompt } : {}),
        onUserInputRequest: async (request) => {
            return new Promise((resolve, reject) => {
                const q = request.question || "?";
                const targetOrchId = sessionOrchId || activeOrchId;
                appendChatRaw(`{magenta-fg}[?] ${q}{/magenta-fg}`, targetOrchId);
                setSessionPendingQuestion(targetOrchId, q);
                setPendingUserInputRequest(targetOrchId, { resolve, reject });
                sessionLiveStatus.set(targetOrchId, "input_required");
                if (targetOrchId !== activeOrchId) {
                    orchHasChanges.add(targetOrchId);
                } else {
                    setStatus("Waiting for your answer...");
                    focusInput();
                }
                updateSessionListIcons();
                syncInputBarMode();
                screen.render();
            });
        },
    });
    sessionOrchId = `session-${sess.sessionId}`;
    sessions.set(sess.sessionId, sess);
    sessionModels.set(sessionOrchId, currentModel || "default");
    if (splash) {
        systemSplashText.set(sessionOrchId, splash);
        if (!sessionChatBuffers.has(sessionOrchId) || sessionChatBuffers.get(sessionOrchId).length === 0) {
            sessionChatBuffers.set(sessionOrchId, [...splash.split("\n"), ""]);
        }
    }
    return sess;
}

function buildAgentPickerSplash(choice) {
    if (!choice) return "";
    if (choice.splash) return choice.splash;

    switch (choice.name) {
        case "investigator":
            return [
                "{bold}{red-fg}",
                "  ___                 _   _             _             _",
                " |_ _|_ ____   _____ | |_(_) __ _  __ _| |_ ___  _ __",
                "  | || '_ \\ \\ / / _ \\| __| |/ _` |/ _` | __/ _ \\| '__|",
                "  | || | | \\ V / (_) | |_| | (_| | (_| | || (_) | |",
                " |___|_| |_|\\_/ \\___/ \\__|_|\\__, |\\__,_|\\__\\___/|_|",
                "                               |___/",
                "{/red-fg}{white-fg}Incident Response + Root Cause Analysis{/white-fg}{/bold}",
                "",
                "{gray-fg}Guided flow:{/gray-fg} service, timeframe, symptoms, recent deploy, user impact.",
            ].join("\n");
        case "deployer":
            return [
                "{bold}{green-fg}",
                "  ____             _",
                " |  _ \\  ___ _ __ | | ___  _   _  ___ _ __",
                " | | | |/ _ \\ '_ \\| |/ _ \\| | | |/ _ \\ '__|",
                " | |_| |  __/ |_) | | (_) | |_| |  __/ |",
                " |____/ \\___| .__/|_|\\___/ \\__, |\\___|_|",
                "             |_|            |___/",
                "{/green-fg}{white-fg}Safe Rollouts + Rollbacks{/white-fg}{/bold}",
                "",
                "{gray-fg}Guided flow:{/gray-fg} service, version, environment, pre-flight, approval, monitor.",
            ].join("\n");
        case "reporter":
            return [
                "{bold}{cyan-fg}",
                "  ____                        _",
                " |  _ \\ ___ _ __   ___  _ __| |_ ___ _ __",
                " | |_) / _ \\ '_ \\ / _ \\| '__| __/ _ \\ '__|",
                " |  _ <  __/ |_) | (_) | |  | ||  __/ |",
                " |_| \\_\\___| .__/ \\___/|_|   \\__\\___|_|",
                "            |_|",
                "{/cyan-fg}{white-fg}Status Reports + Summaries{/white-fg}{/bold}",
                "",
                "{gray-fg}Guided flow:{/gray-fg} all services vs one service, deployments, concise vs detailed report.",
            ].join("\n");
        default:
            return (
                `{bold}{cyan-fg}${choice.title || "Agent"}{/cyan-fg}{/bold}\n\n` +
                `{white-fg}${choice.description || "No description provided."}{/white-fg}\n\n` +
                `{gray-fg}This session will start in a guided mode and keep the agent inside its domain.{/gray-fg}`
            );
    }
}

async function createNewSession() {
    let sessionOrchId = null;
    const sess = await client.createSession({
        ...(currentModel ? { model: currentModel } : {}),
        toolNames: ["write_artifact", "export_artifact", "read_artifact"],
        onUserInputRequest: async (request) => {
            return new Promise((resolve, reject) => {
                const q = request.question || "?";
                const targetOrchId = sessionOrchId || activeOrchId;
                appendChatRaw(`{magenta-fg}[?] ${q}{/magenta-fg}`, targetOrchId);
                setSessionPendingQuestion(targetOrchId, q);
                setPendingUserInputRequest(targetOrchId, { resolve, reject });
                sessionLiveStatus.set(targetOrchId, "input_required");
                if (targetOrchId !== activeOrchId) {
                    orchHasChanges.add(targetOrchId);
                } else {
                    setStatus("Waiting for your answer...");
                    focusInput();
                }
                updateSessionListIcons();
                syncInputBarMode();
                screen.render();
            });
        },
    });
    sessionOrchId = `session-${sess.sessionId}`;
    sessions.set(sess.sessionId, sess);
    sessionModels.set(sessionOrchId, currentModel || "default");
    return sess;
}

// Resume existing non-system sessions in the background so they remain
// available immediately in the session list, but do not make them active
// by default at startup.
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

// ─── System Agent Discovery ─────────────────────────────────────
// System agents are discovered from the CMS (is_system flag, splash, agent_id).
// The refresh loop populates systemSessionIds, systemSplashText, and chat buffers
// from CMS data. At startup, we just need to resume the root system agent session
// so the TUI can interact with it immediately.
const systemSplashText = new Map(); // orchId -> splash string
try {
    const _saPh = perfStart("startup.systemAgentDiscovery");
    // Discover system sessions from CMS
    const cmsSessions = await client.listSessions();
    for (const sv of cmsSessions) {
        if (!sv.isSystem) continue;
        const orchId = `session-${sv.sessionId}`;
        systemSessionIds.add(orchId);
        const startupTitle = sv.agentId === "pilotswarm" && HAS_CUSTOM_TUI_BRANDING
            ? BASE_TUI_TITLE
            : sv.title;
        if (startupTitle) sessionHeadings.set(orchId, startupTitle);
        if (sv.agentId) sessionAgentIds.set(orchId, sv.agentId);
        const startupSplash = sv.agentId === "pilotswarm" && HAS_CUSTOM_TUI_BRANDING
            ? ACTIVE_STARTUP_SPLASH_CONTENT
            : sv.splash;
        if (startupSplash) {
            systemSplashText.set(orchId, startupSplash);
        }

        // Resume the PilotSwarmSession handle so TUI can interact with it
        try {
            const sess = await client.resumeSession(sv.sessionId);
            sessions.set(sv.sessionId, sess);
            client.systemSessions.add(sv.sessionId);

            // Pre-populate the chat buffer with its splash banner
            if (startupSplash && !sessionChatBuffers.has(orchId)) {
                sessionChatBuffers.set(orchId, []);
                const buf = sessionChatBuffers.get(orchId);
                for (const line of startupSplash.split("\n")) {
                    buf.push(line);
                }
                buf.push("");
            }
            const label = startupTitle || sv.agentId || shortId(sv.sessionId);
            appendLog(`System agent discovered: ${label} ✓ {yellow-fg}(${shortId(sv.sessionId)}…){/yellow-fg}`);
        } catch (err) {
            appendLog(`{yellow-fg}System agent ${sv.agentId || shortId(sv.sessionId)} not yet available: ${err.message}{/yellow-fg}`);
        }
    }
    perfEnd(_saPh);
} catch (err) {
    appendLog(`{yellow-fg}System agent discovery: ${err.message}{/yellow-fg}`);
}

// ─── Active orchestration tracking ───────────────────────────────
// The chat pane shows live output from the "active" orchestration.
// Selecting a different orchestration in the left pane switches context.

// Determine preferred system session: PilotSwarm Agent if available, else first system session
// Check agentId from CMS, fall back to deterministic UUID
const pilotswarmOrchId = (() => {
    // Find session with agentId "pilotswarm" from CMS discovery
    for (const [orchId, agentId] of sessionAgentIds) {
        if (agentId === "pilotswarm") return orchId;
    }
    // Fallback: deterministic UUID (root pilotswarm agent uses stable ID)
    const psId = systemAgentUUID("pilotswarm");
    const orchId = `session-${psId}`;
    return systemSessionIds.has(orchId) ? orchId : null;
})();
const preferredSystemOrchId = pilotswarmOrchId ?? ([...systemSessionIds][0] ?? "");
const preferredSystemSessionId = preferredSystemOrchId ? preferredSystemOrchId.replace(/^session-/, "") : "";

activeOrchId = preferredSystemOrchId || (thisSessionId ? `session-${thisSessionId}` : "");
activeSessionShort = activeOrchId
    ? shortId(activeOrchId)
    : "";
let orchSelectFollowActive = true; // when true, next refresh snaps selection to activeOrchId

function updateChatLabel() {
    const model = sessionModels.get(activeOrchId) || "";
    const shortModel = model.includes(":") ? model.split(":")[1] : model;
    const modelTag = shortModel ? ` {cyan-fg}${shortModel}{/cyan-fg}` : "";
    const collapseBadge = getCollapseBadge(activeOrchId);
    const isSweeper = systemSessionIds.has(activeOrchId);
    if (isSweeper) {
        const sysTitle = sessionHeadings.get(activeOrchId) || "System Agent";
        chatBox.setLabel(` {bold}{yellow-fg}≋ ${sysTitle}${collapseBadge}{/yellow-fg}{/bold} {white-fg}[${activeSessionShort}]{/white-fg}${modelTag} `);
        chatBox.style.border.fg = "yellow";
    } else {
        const title = sessionHeadings.get(activeOrchId) || "Chat";
        chatBox.setLabel(` {bold}${title}${collapseBadge}{/bold} {white-fg}[${activeSessionShort}]{/white-fg}${modelTag} `);
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
    function setTurnInProgressIfActive(_val) {
        setSessionPendingTurn(orchId, false);
    }
    function updateLiveStatus(status) {
        if (status !== "input_required") {
            clearSessionPendingQuestion(orchId);
        }
        if (!isTerminalSessionState(status)) {
            sessionLoggedTerminalStatus.delete(orchId);
        }
        sessionLiveStatus.set(orchId, status);
        setSessionPendingTurn(orchId, false);
        // Lightweight: just update icons in the list without DB queries.
        // Full refresh happens on the debounced 500ms schedule.
        updateSessionListIcons();
    }

    function renderCompletedContent(content) {
        let displayContent = content || "";
        const hMatch = displayContent.match(/^HEADING:\s*(.+)/m);
        if (hMatch && !systemSessionIds.has(orchId)) {
            sessionHeadings.set(orchId, hMatch[1].trim().slice(0, 40));
            displayContent = displayContent.replace(/^HEADING:.*\n?/m, "").trim();
            scheduleRefreshOrchestrations();
        } else if (hMatch) {
            displayContent = displayContent.replace(/^HEADING:.*\n?/m, "").trim();
        }
        if (!shouldSkipCompletedTurnResult(displayContent, orchId)) {
            showCopilotMessage(displayContent, orchId);
        }
    }

    function renderCommandResponse(resp) {
        const pending = pendingCommands.get(resp.id);
        const pendingForThisSession = pending && (!pending.orchId || pending.orchId === orchId);
        if (pending && !pendingForThisSession) {
            appendActivity(`{yellow-fg}[obs] Ignoring command response for ${resp.cmd} routed to unexpected session{/yellow-fg}`, orchId);
            return;
        }
        if (!pendingForThisSession) return;

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
        if (orchId !== activeOrchId) {
            orchHasChanges.add(orchId);
            updateSessionListIcons();
        }
        screen.render();
    }

    function renderResponsePayload(response, cs, source) {
        if (!response) return;
        if (response.type === "completed" && response.content) {
            appendActivity(`{green-fg}[obs] ✓ SHOWING ${source}: version=${response.version} type=completed content=${response.content.slice(0, 80)}{/green-fg}`, orchId);
            renderCompletedContent(response.content);
            if (cs.status === "idle" || cs.status === "completed") {
                setStatusIfActive(cs.status === "completed" ? "Session completed" : "Ready — type a message");
                setTurnInProgressIfActive(false);
            } else {
                setStatusIfActive(`Running (${cs.status})…`);
            }
            return;
        }
        if (response.type === "wait" && response.content) {
            appendActivity(`{green-fg}[obs] ✓ SHOWING ${source}: version=${response.version} type=wait content=${response.content.slice(0, 80)}{/green-fg}`, orchId);
            const preview = summarizeActivityPreview(response.content);
            appendActivity(`{white-fg}[${ts()}]{/white-fg} {gray-fg}[intermediate]{/gray-fg} ${preview}`, orchId);
            promoteIntermediateContent(response.content, orchId);
            setStatusIfActive(`Waiting (${cs.waitReason || response.waitReason || "timer"})…`);
            return;
        }
        if (response.type === "input_required") {
            const question = response.question || "?";
            appendActivity(`{green-fg}[obs] ✓ SHOWING ${source}: version=${response.version} type=input_required{/green-fg}`, orchId);
            if (setSessionPendingQuestion(orchId, question)) {
                appendChatRaw(`{magenta-fg}[?] ${question}{/magenta-fg}`, orchId);
            }
            setStatusIfActive("Waiting for your answer...");
            updateLiveStatus("input_required");
        }
    }

    async function consumeTerminalArtifacts(statusSnapshot, source) {
        let cs = null;
        if (statusSnapshot?.customStatus) {
            try {
                cs = typeof statusSnapshot.customStatus === "string"
                    ? JSON.parse(statusSnapshot.customStatus)
                    : statusSnapshot.customStatus;
            } catch {}
        }
        if (!cs) return null;

        lastVersion = Math.max(lastVersion, statusSnapshot.customStatusVersion || 0);

        if (cs.cmdResponse) {
            renderCommandResponse(cs.cmdResponse);
        } else {
            const commandResponse = await consumeCommandResponsePayload(orchId, cs, dc);
            if (commandResponse) {
                renderCommandResponse(commandResponse);
            }
        }

        if (cs.turnResult && cs.iteration > lastIteration) {
            lastIteration = cs.iteration;
            if (cs.turnResult.type === "completed" && cs.turnResult.content) {
                renderCompletedContent(cs.turnResult.content);
            } else if (cs.turnResult.type === "input_required") {
                renderResponsePayload(cs.turnResult, cs, source);
            }
        } else if (!cs.turnResult) {
            const latestResponse = await consumeLatestResponsePayload(orchId, cs, dc);
            if (latestResponse) {
                renderResponsePayload(latestResponse, cs, source);
            }
        }

        if (cs.status) {
            updateLiveStatus(cs.status);
        }
        return cs;
    }

    async function stopObserverForTerminalStatus(statusSnapshot, source) {
        const terminalStatus = statusSnapshot?.status || statusSnapshot?.orchestrationStatus;
        if (!isTerminalOrchestrationStatus(terminalStatus)) {
            return false;
        }

        const terminalCs = await consumeTerminalArtifacts(statusSnapshot, source);
        clearSessionPendingQuestion(orchId);
        const alreadyLogged = sessionLoggedTerminalStatus.get(orchId) === terminalStatus;

        if (terminalStatus === "Failed") {
            const reason = statusSnapshot?.failureDetails?.errorMessage?.split("\n")[0]
                || statusSnapshot?.output?.split("\n")[0]
                || "Unknown error";
            if (!alreadyLogged) {
                appendActivity(`{red-fg}❌ Orchestration failed: ${reason}{/red-fg}`, orchId);
            }
            updateLiveStatus("error");
            resolvePendingDoneCommand(orchId, reason);
            setStatusIfActive("Failed — session is dead");
        } else {
            if (!alreadyLogged) {
                appendActivity(`{gray-fg}Orchestration ${terminalStatus}{/gray-fg}`, orchId);
            }
            updateLiveStatus(terminalStatus === "Completed" ? "completed" : "terminated");
            if (terminalStatus === "Completed" && !terminalCs?.commandId) {
                resolvePendingDoneCommand(orchId);
            }
            setStatusIfActive(terminalStatus === "Completed" ? "Session completed" : `${terminalStatus} — session is dead`);
        }

        sessionLoggedTerminalStatus.set(orchId, terminalStatus);
        setSessionPendingTurn(orchId, false);
        setTurnInProgressIfActive(false);
        sessionObservers.delete(orchId);
        return true;
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
            if (await stopObserverForTerminalStatus(currentStatus, "terminal")) {
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
                        if (!shouldSkipCompletedTurnResult(cs.turnResult.content, orchId)) {
                            showCopilotMessage(cs.turnResult.content, orchId);
                        }
                    }
                    if (cs.cmdResponse) {
                        renderCommandResponse(cs.cmdResponse);
                    } else {
                        const initialCommandResponse = await consumeCommandResponsePayload(orchId, cs, dc);
                        if (initialCommandResponse) {
                            renderCommandResponse(initialCommandResponse);
                        }
                    }
                    if (!cs.turnResult) {
                        const initialResponse = await consumeLatestResponsePayload(orchId, cs, dc);
                        if (initialResponse) {
                            renderResponsePayload(initialResponse, cs, "response");
                        }
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
                        if (cs.turnResult?.type === "input_required") {
                            const question = cs.pendingQuestion || cs.turnResult?.question || "?";
                            if (setSessionPendingQuestion(orchId, question)) {
                                appendChatRaw(`{magenta-fg}[?] ${question}{/magenta-fg}`, orchId);
                            }
                        }
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
                clearSessionPendingQuestion(orchId);
                setStatusIfActive("Ready — type a message");
            }
        } catch (err) {
            // Orchestration may not exist yet (new session)
            if (err?.message && !err.message.includes("not found")) {
                appendActivity(`{yellow-fg}⚠ Initial status fetch failed: ${err.message}{/yellow-fg}`, orchId);
            }
            clearSessionPendingQuestion(orchId);
            setStatusIfActive("Ready — type a message");
        }
        while (!ac.signal.aborted) {
            try {
                const _obsPh = perfStart("observer.waitForStatusChange");
                const _waitStart = Date.now();
                const statusResult = await dc.waitForStatusChange(
                    orchId, lastVersion, 200, 30_000
                );
                const _waitMs = Date.now() - _waitStart;
                perfEnd(_obsPh, { orchId: orchId.slice(0, 12), ver: statusResult.customStatusVersion });
                if (ac.signal.aborted) break;

                if (await stopObserverForTerminalStatus(statusResult, "terminal")) {
                    break;
                }

                const prevVersion = lastVersion;
                const prevIteration = lastIteration;
                if (statusResult.customStatusVersion > lastVersion) {
                    lastVersion = statusResult.customStatusVersion;
                } else if (statusResult.customStatusVersion < lastVersion) {
                    // continueAsNew happened — version reset. Reset watermarks.
                    appendActivity(`{yellow-fg}🔄 [obs] continueAsNew detected in try: v${lastVersion}→v${statusResult.customStatusVersion}, resetting lastIter=${lastIteration}→-1 (${_waitMs}ms){/yellow-fg}`, orchId);
                    lastVersion = statusResult.customStatusVersion;
                    lastIteration = -1;
                } else {
                    // Same version — poll returned without change (shouldn't happen normally)
                    appendActivity(`{gray-fg}[obs] poll returned same version v${lastVersion} (${_waitMs}ms){/gray-fg}`, orchId);
                }

                let cs = null;
                if (statusResult.customStatus) {
                    try {
                        cs = typeof statusResult.customStatus === "string"
                            ? JSON.parse(statusResult.customStatus) : statusResult.customStatus;
                    } catch {}
                }

                if (cs) {
                    // Log every status change with key fields
                    const responseInfo = cs.turnResult
                        ? `turnResult=${cs.turnResult.type}`
                        : (cs.responseVersion ? `responseVersion=${cs.responseVersion}` : "no-turnResult");
                    const iterInfo = `iter=${cs.iteration}`;
                    appendActivity(`{gray-fg}[obs] v${prevVersion}→v${statusResult.customStatusVersion} status=${cs.status} ${iterInfo} ${responseInfo} lastIter=${prevIteration}→${lastIteration} (${_waitMs}ms){/gray-fg}`, orchId);

                    // Track live status
                    if (cs.status) {
                        updateLiveStatus(cs.status);
                    }

                    // ─── Command response handling ───────────────
                    if (cs.cmdResponse) {
                        renderCommandResponse(cs.cmdResponse);
                    } else {
                        const commandResponse = await consumeCommandResponsePayload(orchId, cs, dc);
                        if (commandResponse) {
                            renderCommandResponse(commandResponse);
                        }
                    }

                    // Show turn results
                    if (cs.turnResult && cs.iteration > lastIteration) {
                        appendActivity(`{green-fg}[obs] ✓ SHOWING turnResult: iter=${cs.iteration} > lastIter=${lastIteration}, type=${cs.turnResult.type}, content=${(cs.turnResult.content || "").slice(0, 80)}{/green-fg}`, orchId);
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
                            if (!shouldSkipCompletedTurnResult(displayContent, orchId)) {
                                showCopilotMessage(displayContent, orchId);
                            }
                            if (cs.status === "idle") {
                                setStatusIfActive("Ready — type a message");
                                setTurnInProgressIfActive(false);
                            } else {
                                setStatusIfActive(`Running (${cs.status})…`);
                            }
                        } else if (cs.turnResult.type === "input_required") {
                            const question = cs.turnResult.question || cs.pendingQuestion || "?";
                            if (setSessionPendingQuestion(orchId, question)) {
                                appendChatRaw(`{magenta-fg}[?] ${question}{/magenta-fg}`, orchId);
                            }
                            setStatusIfActive("Waiting for your answer...");
                            updateLiveStatus("input_required");
                        }
                    } else if (cs.turnResult && cs.iteration <= lastIteration) {
                        appendActivity(`{yellow-fg}[obs] ⚠ SKIPPED turnResult: iter=${cs.iteration} <= lastIter=${lastIteration} (already shown){/yellow-fg}`, orchId);
                        if (cs.status === "waiting") {
                            setStatusIfActive(`Waiting (${cs.waitReason || "timer"})…`);
                        }
                    } else if (cs.responseVersion) {
                        const latestResponse = await consumeLatestResponsePayload(orchId, cs, dc);
                        if (latestResponse) {
                            renderResponsePayload(latestResponse, cs, "response");
                        }
                        if (cs.status === "error") {
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
                        } else if (cs.status === "input_required") {
                            setStatusIfActive("Waiting for your answer...");
                            updateLiveStatus("input_required");
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
            } catch (err) {
                // waitForStatusChange timed out or failed — check terminal state or continueAsNew
                if (ac.signal.aborted) break;
                appendActivity(`{yellow-fg}[obs] catch: ${err.message || "timeout"} lastVersion=${lastVersion} lastIteration=${lastIteration}{/yellow-fg}`, orchId);
                try {
                    const info = await dc.getStatus(orchId);
                    if (await stopObserverForTerminalStatus(info, "terminal")) {
                        break;
                    }
                    // Detect continueAsNew: customStatusVersion went backwards
                    const currentVersion = info.customStatusVersion || 0;
                    if (currentVersion < lastVersion) {
                        appendActivity(`{yellow-fg}🔄 [obs] continueAsNew in catch: v${lastVersion}→v${currentVersion}{/yellow-fg}`, orchId);
                        lastVersion = 0;
                        lastIteration = -1;
                    } else {
                        appendActivity(`{gray-fg}[obs] catch: no version reset (v${currentVersion} >= v${lastVersion}){/gray-fg}`, orchId);
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

        const maxRenderedSeq = sessionRenderedCmsSeq.get(orchId) ?? 0;
        if (maxRenderedSeq > 0 && (sess.lastSeenSeq || 0) < maxRenderedSeq) {
            sess.lastSeenSeq = maxRenderedSeq;
        }

        const unsub = sess.on((evt) => {
            // Poller was stopped while callback pending
            if (_activeCmsOrchId !== orchId) { unsub(); return; }
            // Skip if already rendered (from loadCmsHistory on switch)
            const currentMaxRenderedSeq = sessionRenderedCmsSeq.get(orchId) ?? 0;
            if (evt.seq && evt.seq <= currentMaxRenderedSeq) return;
            if (evt.seq) {
                sessionRenderedCmsSeq.set(orchId, evt.seq);
            }

            const t = formatDisplayTime(Date.now());
            const type = evt.eventType;

            // Don't render events that the customStatus observer already handles
            if (type === "assistant.message") return;
            if (type === "user.message") return;

            if (type === "tool.execution_start") {
                const toolName = evt.data?.toolName || "tool";
                // Track last tool name so we can show it on completion too
                sess._lastToolName = toolName;
                appendActivity(formatToolActivityLine(t, evt, "start"), orchId);
            } else if (type === "tool.execution_complete") {
                const toolName = evt.data?.toolName || sess._lastToolName || "tool";
                appendActivity(formatToolActivityLine(t, { ...evt, data: { ...(evt.data || {}), toolName } }, "complete"), orchId);
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
    syncInputBarMode();
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
                    if (!turnResult?.model && cs?.responseVersion) {
                        fetchLatestResponsePayload(orchId, dc).then((payload) => {
                            if (payload?.model) {
                                sessionModels.set(orchId, payload.model);
                                if (orchId === activeOrchId) updateChatLabel();
                            }
                        }).catch(() => {});
                    }
                } catch {}
            }
            if (info?.customStatus) {
                try {
                    const cs = typeof info.customStatus === "string" ? JSON.parse(info.customStatus) : info.customStatus;
                    if (cs?.status) {
                        sessionLiveStatus.set(orchId, cs.status);
                        updateSessionListIcons();
                    }
                } catch {}
            }
        }).catch(() => {});
    }
    // Use 4-char UUID + time for display
    const uuid4 = shortId(orchId);
    const cached = orchStatusCache.get(orchId);
    const timeStr = cached?.createdAt > 0
        ? formatDisplayTime(cached.createdAt, { hour: "2-digit", minute: "2-digit" })
        : "";
    activeSessionShort = `${uuid4}${timeStr ? " " + timeStr : ""}`;

    // Switch CMS event poller to new session
    stopCmsPoller();

    // Clear chat and show switch indicator (only when switching to a different session)
    if (!isSameSession) {
        updateChatLabel();

        // Show cached chat buffer instantly if available (no DB wait)
        const _cachePh = perfStart("switch.cachedRestore");
        const cachedLines = sessionChatBuffers.get(orchId) || ensureSessionSplashBuffer(orchId);
        if (cachedLines && cachedLines.length > 0) {
            sessionChatBuffers.set(orchId, cachedLines);
        } else {
            sessionChatBuffers.set(orchId, ["{white-fg}Loading…{/white-fg}"]);
        }

        // Switch activity buffer
        const cachedActivity = sessionActivityBuffers.get(orchId);
        if (cachedActivity && cachedActivity.length > 0) {
            sessionActivityBuffers.set(orchId, cachedActivity);
        } else {
            sessionActivityBuffers.set(orchId, ["{gray-fg}(no recent activity yet){/gray-fg}"]);
        }
        perfEnd(_cachePh, {
            chatLines: cachedLines?.length || 0,
            activityLines: cachedActivity?.length || 0,
        });

        // Ensure an observer is running for this session when it's still live
        if (shouldObserveSession(orchId)) {
            startObserver(orchId);
        }
        invalidateChat("bottom");
        invalidateActivity("bottom");

        // Update session list icons immediately
        updateSessionListIcons();
        screen.render();

        // Defer heavier right-pane redraw to the next tick so session switching
        // feels instant even when sequence/log panes have a lot of content.
        setTimeout(() => {
            if (orchId === activeOrchId) {
                redrawActiveViews();
                scheduleLightRefresh("sessionSwitch", orchId);
            }
        }, 0);

        // Load full history from DB in background (non-blocking)
        loadCmsHistory(orchId).then(() => {
            // Only refresh if still the active session when the load completes
            if (orchId === activeOrchId) {
                startCmsPoller(orchId);
                invalidateChat();
                invalidateActivity();
                scheduleLightRefresh("sessionHistoryLoaded", orchId);
            }
        }).catch(() => {
            if (orchId === activeOrchId) startCmsPoller(orchId);
        });

        // Schedule list refresh in background too
        scheduleRefreshOrchestrations();
    } else {
        if (!sessionHistoryLoadedAt.has(orchId)) {
            loadCmsHistory(orchId).then(() => {
                if (orchId === activeOrchId) {
                    startCmsPoller(orchId);
                    invalidateChat();
                    invalidateActivity();
                    scheduleLightRefresh("sessionHistoryLoaded", orchId);
                }
            }).catch(() => {
                if (orchId === activeOrchId) startCmsPoller(orchId);
            });
        } else {
            startCmsPoller(orchId);
        }
        redrawActiveViews();
    }
    perfEnd(_ph, { orchId: orchId.slice(0, 12), same: isSameSession });
}

updateChatLabel();
const initialChatLines = ensureSessionSplashBuffer(activeOrchId) || sessionChatBuffers.get(activeOrchId) || [];
if (initialChatLines.length > 0) {
    chatBox.setContent(initialChatLines.map(styleUrls).join("\n"));
    chatBox.setScrollPerc(0);
}
startupLandingVisible = !activeOrchId;
if (activeOrchId) {
    // Bootstrap the initial active session the same way a manual selection does.
    if (shouldObserveSession(activeOrchId)) {
        startObserver(activeOrchId);
    }
    loadCmsHistory(activeOrchId).then(() => {
        if (activeOrchId) {
            startCmsPoller(activeOrchId);
            invalidateChat();
            invalidateActivity();
            scheduleLightRefresh("initialSessionHistoryLoaded", activeOrchId);
        }
    }).catch(() => {
        if (activeOrchId) startCmsPoller(activeOrchId);
    });
}

// Start in navigation mode so j/k works immediately without pressing Esc first.
orchList.focus();

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

function getSessionForOrchId(orchId) {
    const sid = sessionIdFromOrchId(orchId);
    return sessions.get(sid) || null;
}

// Helper: get or create a PilotSwarmSession for the active orchestration
function getActiveSession() {
    return getSessionForOrchId(activeOrchId);
}

// Helper: ensure the orchestration for the active session is started.
// Slash commands need a running orchestration to enqueue events into.
// If no session/orchestration exists yet, create one via send("") which
// starts the orchestration and enters the idle dequeue loop.
async function ensureOrchestrationStarted(orchId = activeOrchId) {
    const sess = getSessionForOrchId(orchId);
    if (!sess) return; // shouldn't happen
    // Check if orchestration exists
    const dc = getDc();
    if (!dc) return;
    try {
        const info = await dc.getStatus(orchId);
        if (info && info.status !== "NotFound") return; // already running
    } catch {
        // Not found — need to start it
    }
    // Start the orchestration by sending an empty prompt
    await sess.send("");
    knownOrchestrationIds.add(orchId);
    startObserver(orchId);
    // Small delay to let the orchestration enter the idle dequeue loop
    await new Promise(r => setTimeout(r, 1000));
}

// ─── Input handling ──────────────────────────────────────────────

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

    const targetOrchId = activeOrchId;
    const pendingQuestion = sessionPendingQuestions.get(targetOrchId);
    const pendingUserInput = takePendingUserInputRequest(targetOrchId);

    if (pendingUserInput) {
        const { resolve } = pendingUserInput;
        appendChatRaw(`{green-fg}↳ ${trimmed}{/green-fg}`, targetOrchId);
        // Send user-input event to the originating orchestration
        try {
            const dc = getDc();
            if (!dc) throw new Error("Not connected");
            await dc.enqueueEvent(targetOrchId, "messages", JSON.stringify({ answer: trimmed, wasFreeform: true }));
        } catch (err) {
            setPendingUserInputRequest(targetOrchId, pendingUserInput);
            appendChatRaw(`{red-fg}Answer failed: ${err.message}{/red-fg}`, targetOrchId);
            syncInputBarMode();
            screen.render();
            return;
        }
        clearSessionPendingQuestion(targetOrchId);
        syncInputBarMode();
        resolve({ answer: trimmed, wasFreeform: true });
        inputBar.clearValue();
        focusInput();
        screen.render();
        return;
    }

    if (pendingQuestion) {
        appendChatRaw(`{green-fg}↳ ${trimmed}{/green-fg}`, targetOrchId);
        inputBar.clearValue();
        focusInput();
        screen.render();
        try {
            const dc = getDc();
            if (!dc) throw new Error("Not connected");
            await dc.enqueueEvent(targetOrchId, "messages", JSON.stringify({ answer: trimmed, wasFreeform: true }));
            clearSessionPendingQuestion(targetOrchId);
            syncInputBarMode();
        } catch (err) {
            appendChatRaw(`{red-fg}Answer failed: ${err.message}{/red-fg}`, targetOrchId);
        }
        screen.render();
        return;
    }

    if (isTurnInProgressForSession(targetOrchId)) {
        appendChatRaw(`{white-fg}[${ts()}]{/white-fg} {white-fg}{bold}You:{/bold} ${trimmed}{/white-fg}`, targetOrchId);
        appendActivity(`{cyan-fg}[send] interrupt: session busy, enqueuing to ${targetOrchId?.slice(0,20)}{/cyan-fg}`, targetOrchId);
        inputBar.clearValue();
        if (targetOrchId === activeOrchId) setStatus("Interrupting...");
        injectSeqUserEvent(targetOrchId, trimmed);
        try {
            const dc = getDc();
            if (dc) await dc.enqueueEvent(targetOrchId, "messages", JSON.stringify({ prompt: trimmed }));
            appendActivity(`{cyan-fg}[send] interrupt enqueued OK{/cyan-fg}`, targetOrchId);
        } catch (err) {
            appendChatRaw(`{red-fg}Interrupt failed: ${err.message}{/red-fg}`, targetOrchId);
        }
        focusInput();
        screen.render();
        return;
    }

    appendChatRaw(`{white-fg}[${ts()}]{/white-fg} {white-fg}{bold}You:{/bold} ${trimmed}{/white-fg}`, targetOrchId);
    inputBar.clearValue();
    focusInput();
    setSessionPendingTurn(targetOrchId, true);
    if (targetOrchId === activeOrchId) setStatus("Thinking... (waiting for AKS worker)");
    injectSeqUserEvent(targetOrchId, trimmed);
    screen.render();

    try {
        // Check if the orchestration is in a terminal state before sending
        const dc = getDc();
        if (dc && targetOrchId) {
            try {
                const orchStatus = await dc.getStatus(targetOrchId);
                if (orchStatus.status === "Failed" || orchStatus.status === "Completed" || orchStatus.status === "Terminated") {
                    const reason = orchStatus.status === "Failed"
                        ? (orchStatus.failureDetails?.errorMessage?.split("\n")[0]
                            || orchStatus.output?.split("\n")[0]
                            || "Unknown error")
                        : orchStatus.status;
                    appendChatRaw(`{red-fg}❌ Cannot send — orchestration ${orchStatus.status}: ${reason}{/red-fg}`, targetOrchId);
                    appendChatRaw(`{white-fg}Create a new session with 'n' to continue.{/white-fg}`, targetOrchId);
                    setSessionPendingTurn(targetOrchId, false);
                    if (targetOrchId === activeOrchId) setStatus(`${orchStatus.status} — session is dead`);
                    screen.render();
                    return;
                }
            } catch {}
        }

        // Use the PilotSwarmSession to send — it handles starting the orchestration
        // on first message. The observer picks up results via waitForStatusChange.
        const sess = getSessionForOrchId(targetOrchId);
        if (sess) {
            // Fire-and-forget: just send the message, don't wait for result.
            // The observer is what updates the chat.
            appendActivity(`{cyan-fg}[send] normal: sending via sess.send() to ${targetOrchId?.slice(0,20)}{/cyan-fg}`, targetOrchId);
            sess.send(trimmed).then(() => {
                appendActivity(`{cyan-fg}[send] normal send OK, observer started{/cyan-fg}`, targetOrchId);
                knownOrchestrationIds.add(targetOrchId);
                startObserver(targetOrchId);
                refreshOrchestrations();
            }).catch(err => {
                const msg = (err.message || String(err)).split("\n")[0];
                appendChatRaw(`{red-fg}❌ ${msg}{/red-fg}`, targetOrchId);
                setSessionPendingTurn(targetOrchId, false);
                if (targetOrchId === activeOrchId) setStatus("Error — try again");
                screen.render();
            });
        } else {
            // No session object — send via enqueueEvent (existing orchestration)
            const dc = getDc();
            if (dc) {
                await dc.enqueueEvent(targetOrchId, "messages", JSON.stringify({ prompt: trimmed }));
            }
        }
    } catch (err) {
        const msg = (err.message || String(err)).split("\n")[0];
        appendChatRaw(`{red-fg}❌ ${msg}{/red-fg}`, targetOrchId);
        if (targetOrchId === activeOrchId) setStatus("Error — try again");
        setSessionPendingTurn(targetOrchId, false);
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

// ─── Help Overlay ────────────────────────────────────────────────

function showHelpOverlay() {
    const prevFocused = screen.focused;
    const helpContent = [
        `{bold}{cyan-fg}${BASE_TUI_TITLE} — Keybindings{/cyan-fg}{/bold}`,
        "",
        "{bold}Global{/bold}",
        "  {yellow-fg}?{/yellow-fg}           Show this help",
        "  {yellow-fg}Esc → q{/yellow-fg}     Quit (press Esc then q within 1s)",
        "  {yellow-fg}Ctrl+C{/yellow-fg}      Quit immediately",
        "  {yellow-fg}p{/yellow-fg}           Jump to input/prompt bar",
        "  {yellow-fg}m{/yellow-fg}           Cycle log mode: Workers → Orch → Sequence → Node Map",
        "  {yellow-fg}v{/yellow-fg}           Toggle markdown viewer",
        "  {yellow-fg}Tab{/yellow-fg}         Cycle focus between panes",
        "  {yellow-fg}h / l{/yellow-fg}       Move focus left / right",
        "  {yellow-fg}[ / ]{/yellow-fg}       Resize right column",
        "  {yellow-fg}r{/yellow-fg}           Force full screen redraw",
        "  {yellow-fg}u{/yellow-fg}           Dump active session to Markdown file",
        "  {yellow-fg}a{/yellow-fg}           Show artifact picker (download files)",
        "",
        "{bold}Sessions Pane{/bold}",
        "  {yellow-fg}j / k{/yellow-fg}       Navigate up / down",
        "  {yellow-fg}Enter{/yellow-fg}       Switch to selected session",
        "  {yellow-fg}n{/yellow-fg}           New session (default model)",
        "  {yellow-fg}Shift+N{/yellow-fg}     New session (model picker)",
        "  {yellow-fg}t{/yellow-fg}           Rename session (custom title or LLM summary)",
        "  {yellow-fg}+ / ={/yellow-fg}       Expand sub-agent tree",
        "  {yellow-fg}-{/yellow-fg}           Collapse sub-agent tree",
        "  {yellow-fg}c{/yellow-fg}           Cancel session",
        "  {yellow-fg}d{/yellow-fg}           Delete session",
        "  {yellow-fg}r{/yellow-fg}           Refresh session list",
        "",
        "{bold}Chat / Activity / Log Panes{/bold}",
        "  {yellow-fg}j / k{/yellow-fg}       Scroll down / up",
        "  {yellow-fg}Ctrl+D/U{/yellow-fg}    Page down / up",
        "  {yellow-fg}g / G{/yellow-fg}       Scroll to top / bottom",
        "  {yellow-fg}e{/yellow-fg}           Expand history (load older messages, press again for full)",
        "  {yellow-fg}mouse wheel{/yellow-fg}  Scroll any pane",
        "",
        "{bold}Prompt Editor{/bold}",
        "  {yellow-fg}Enter{/yellow-fg}       Submit prompt",
        "  {yellow-fg}Opt+Enter{/yellow-fg}   Insert newline and expand prompt",
        "  {yellow-fg}← / →{/yellow-fg}       Move cursor by character",
        "  {yellow-fg}Opt+← / →{/yellow-fg}   Move cursor by word",
        "  {yellow-fg}Backspace{/yellow-fg}   Delete backward by character",
        "  {yellow-fg}Opt+Backspace{/yellow-fg} Delete backward by word",
        "  {yellow-fg}Esc{/yellow-fg}         Return to navigation mode",
        "",
        "{bold}Markdown Viewer{/bold}",
        "  {yellow-fg}j / k{/yellow-fg}       Move file selection",
        "  {yellow-fg}Enter{/yellow-fg}       Open selected file preview",
        "  {yellow-fg}d{/yellow-fg}           Delete selected exported file",
        "  {yellow-fg}g / G{/yellow-fg}       Preview top / bottom",
        "  {yellow-fg}Ctrl+D/U{/yellow-fg}    Preview page down / up",
        "  {yellow-fg}o{/yellow-fg}           Open selected file in $EDITOR",
        "  {yellow-fg}y{/yellow-fg}           Copy selected file path",
        "  {yellow-fg}v{/yellow-fg}           Exit markdown viewer",
        "",
        "{bold}Slash Commands{/bold} (type in input bar)",
        "  {cyan-fg}/models{/cyan-fg}         List available models",
        "  {cyan-fg}/model <name>{/cyan-fg}  Switch model for this session",
        "  {cyan-fg}/info{/cyan-fg}           Show session info",
        "  {cyan-fg}/done{/cyan-fg}           Complete and close session",
        "  {cyan-fg}/new{/cyan-fg}            Create new session",
        "  {cyan-fg}/help{/cyan-fg}           Show command list in chat",
        "",
        "",
        "{gray-fg}Scroll with j/k, arrows, Ctrl+D/U, or mouse wheel · Press Esc or ? to close{/gray-fg}",
    ].join("\n");

    const helpBox = blessed.box({
        parent: screen,
        tags: true,
        left: "center",
        top: "center",
        width: Math.min(92, screen.width - 2),
        height: Math.min(52, screen.height - 2),
        border: { type: "line" },
        style: {
            fg: "white",
            bg: "black",
            border: { fg: "cyan" },
        },
        scrollable: true,
        keys: true,
        vi: true,
        mouse: true,
        content: helpContent,
        label: " {bold}Help{/bold} ",
    });

    helpBox.focus();
    screen.render();

    const closeHelp = () => {
        helpBox.detach();
        if (prevFocused && typeof prevFocused.focus === "function") prevFocused.focus();
        else orchList.focus();
        screen.render();
    };

    helpBox.key(["escape", "q", "?"], closeHelp);
    helpBox.key(["j", "down"], () => {
        helpBox.scroll(1);
        screen.render();
    });
    helpBox.key(["k", "up"], () => {
        helpBox.scroll(-1);
        screen.render();
    });
    helpBox.key(["C-d"], () => {
        const innerHeight = Math.max(1, helpBox.height - 2);
        helpBox.scroll(Math.floor(innerHeight / 2));
        screen.render();
    });
    helpBox.key(["C-u"], () => {
        const innerHeight = Math.max(1, helpBox.height - 2);
        helpBox.scroll(-Math.floor(innerHeight / 2));
        screen.render();
    });
    helpBox.key(["g"], () => {
        helpBox.scrollTo(0);
        screen.render();
    });
    helpBox.key(["S-g"], () => {
        helpBox.setScrollPerc(100);
        screen.render();
    });
}

// ─── Cleanup ─────────────────────────────────────────────────────

async function cleanup() {
    // Force-exit after 15s — don't let a stuck shutdown hang forever
    const forceExitTimer = setTimeout(() => {
        const buf = Buffer.from("\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?1049l\x1b[?25h");
        try { fs.writeSync(1, buf); } catch {}
        process.exit(0);
    }, 15000);
    forceExitTimer.unref();

    clearInterval(orchPollTimer);
    if (logTailInterval) clearInterval(logTailInterval);
    if (typeof perfSummaryInterval !== "undefined") clearInterval(perfSummaryInterval);
    if (workerPruneInterval) clearInterval(workerPruneInterval);
    // Stop CMS poller
    stopCmsPoller();
    // Stop all session observers — abort first so long-polls break
    for (const [, ac] of sessionObservers) { ac.abort(); }
    sessionObservers.clear();
    if (kubectlProc) { try { kubectlProc.kill("SIGKILL"); } catch {} kubectlProc = null; }

    await Promise.allSettled([
        ...workers.map(w => w.stop()),
        client.stop(),
        mgmt.stop(),
    ]);

    // Suppress ALL output before destroying — neo-blessed dumps terminfo
    // compilation junk (SetUlc) synchronously during destroy().
    process.stdout.write = () => true;
    process.stderr.write = () => true;
    try { screen.destroy(); } catch {}
    // Write terminal reset directly to fd to bypass our suppression
    // Disable mouse tracking modes + exit alt-screen + show cursor
    const buf = Buffer.from("\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?1049l\x1b[?25h");
    try { fs.writeSync(1, buf); } catch {}
}

screen.key(["C-c"], async () => {
    await requestQuit();
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

    if (startupLandingVisible) {
        startupLandingVisible = false;
        orchList.focus();
        switchToOrchestration(activeOrchId).catch(() => {});
        scheduleRender();
        return;
    }

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

    // ?: show global help overlay
    if (ch === "?" && screen.focused !== inputBar) {
        showHelpOverlay();
        return;
    }

    // +/= : expand children, - : collapse children (session list)
    if ((ch === "+" || ch === "=" || ch === "-") && screen.focused === orchList) {
        const idx = orchList.selected;
        if (idx >= 0 && idx < orchIdOrder.length) {
            const id = orchIdOrder[idx];
            const hasChildren = (orchChildrenOf.get(id) || []).length > 0;
            if (ch === "+" || ch === "=") {
                if (hasChildren && collapsedParents.has(id)) {
                    collapsedParents.delete(id);
                    orchSelectFollowActive = false;
                    refreshOrchestrations();
                }
            } else {
                if (hasChildren && !collapsedParents.has(id)) {
                    collapsedParents.add(id);
                    orchSelectFollowActive = false;
                    refreshOrchestrations();
                }
            }
        }
        return;
    }

    // a: open artifact picker for current session — download on selection
    if (ch === "a" && screen.focused !== inputBar && !mdViewActive) {
        const artifacts = sessionArtifacts.get(activeOrchId) || [];
        if (artifacts.length === 0) {
            setStatus("No artifacts for this session");
            return;
        }

        const items = artifacts.map((a, i) => {
            const icon = a.downloaded ? "✓" : "↓";
            return ` ${icon} ${a.filename}`;
        });

        const picker = blessed.list({
            parent: screen,
            label: " 📎 Artifacts — Enter to download ",
            tags: true,
            left: "center",
            top: "center",
            width: Math.min(60, screen.width - 4),
            height: Math.min(items.length + 2, 16),
            border: { type: "line" },
            style: {
                fg: "white",
                bg: "black",
                border: { fg: "cyan" },
                label: { fg: "cyan" },
                selected: { bg: "blue", fg: "white" },
            },
            keys: true,
            vi: true,
            mouse: true,
            items,
        });

        picker.focus();
        screen.render();

        const closePicker = () => {
            picker.detach();
            orchList.focus();
            screen.render();
        };

        picker.key(["escape", "q", "a"], closePicker);

        picker.on("select", async (_el, idx) => {
            const art = artifacts[idx];
            if (!art) return;

            if (art.downloaded) {
                // Already downloaded — close picker and open viewer
                closePicker();
                mdViewActive = true;
                refreshMarkdownViewer();
                const files = scanExportFiles();
                const matchIdx = files.findIndex(f => f.localPath === art.localPath);
                if (matchIdx >= 0) {
                    mdViewerSelectedIdx = matchIdx;
                    mdFileListPane.select(matchIdx);
                    refreshMarkdownViewer();
                }
                screen.realloc();
                relayoutAll();
                setStatus("Markdown Viewer (v to exit)");
                screen.render();
                return;
            }

            setStatus(`Downloading ${art.filename}...`);
            screen.render();
            const localPath = await downloadArtifact(art.sessionId, art.filename);
            if (localPath) {
                art.downloaded = true;
                art.localPath = localPath;

                // Update picker item to show downloaded state
                const updatedItems = artifacts.map((a) => {
                    const icon = a.downloaded ? "✓" : "↓";
                    return ` ${icon} ${a.filename}`;
                });
                picker.setItems(updatedItems);
                picker.select(idx);
                setStatus(`Downloaded ${art.filename}`);
            } else {
                setStatus("Download failed — check logs");
            }
            screen.render();
        });

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
        // d: delete the selected file
        if (ch === "d") {
            const files = scanExportFiles();
            const f = files[mdViewerSelectedIdx];
            if (!f) return;
            try {
                fs.unlinkSync(f.localPath);
                appendLog(`{yellow-fg}🗑 Deleted: ${f.displayPath || f.filename}{/yellow-fg}`);
                // Adjust selection index if we deleted the last item
                if (mdViewerSelectedIdx >= files.length - 1) {
                    mdViewerSelectedIdx = Math.max(0, mdViewerSelectedIdx - 1);
                }
                refreshMarkdownViewer();
            } catch (err) {
                appendLog(`{red-fg}Delete failed: ${err.message}{/red-fg}`);
            }
            return;
        }
    }

    // m: cycle log viewing mode (only from non-input panes, disabled during md view)
    if (ch === "m" && screen.focused !== inputBar) {
        switchLogMode();
        const modeNames = { workers: "Per-Worker", orchestration: "Per-Orchestration", sequence: "Sequence Diagram", nodemap: "Node Map" };
        setStatus(`Log mode: ${modeNames[logViewMode]}`);
        return;
    }

    // r: force full redraw (same as resize)
    if (ch === "r" && screen.focused !== inputBar) {
        scheduleLightRefresh("manualKey");

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

    // e from any non-input pane → expand chat history (load more older messages)
    if (ch === "e" && screen.focused !== inputBar) {
        if (!activeOrchId) return;
        const targetOrchId = activeOrchId;
        const currentLevel = sessionExpandLevel.get(targetOrchId) || 0;
        if (currentLevel >= 2) {
            setStatus("Already at full history");
            screen.render();
            return;
        }
        sessionExpandLevel.set(targetOrchId, currentLevel + 1);
        // Force reload by clearing the cache TTL
        sessionHistoryLoadedAt.delete(targetOrchId);
        stopCmsPoller();
        const levelNames = ["", "expanded (500)", "full history"];
        setStatus(`Loading ${levelNames[currentLevel + 1]}...`);
        screen.render();
        loadCmsHistory(targetOrchId, { force: true }).then(() => {
            if (targetOrchId === activeOrchId) {
                startCmsPoller(targetOrchId);
                invalidateChat("top");
                setStatus(`History ${levelNames[currentLevel + 1]} · scroll up to see older messages`);
            }
        }).catch(() => {
            if (targetOrchId === activeOrchId) startCmsPoller(targetOrchId);
        });
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

    // Wait for the status to go through "running" → "idle" with a completed result.
    // We need to see a "running" status first to confirm our message was picked up,
    // then wait for the subsequent "idle" with either a legacy turnResult or a KV-backed response.
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
            let content = "";
            if (sawRunning && cs?.turnResult?.type === "completed" && cs.turnResult.content) {
                content = cs.turnResult.content;
            } else if (sawRunning && cs?.responseVersion) {
                const response = await fetchLatestResponsePayload(orchId, dc);
                if (response?.type === "completed" && response.content) {
                    content = response.content;
                    noteSeenResponseVersion(orchId, response.version);
                }
            }
            if (content) {
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
