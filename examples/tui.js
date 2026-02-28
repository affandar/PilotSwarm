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
 *   node --env-file=.env.remote examples/tui.js         # 4 embedded workers
 *   WORKERS=0 node --env-file=.env.remote examples/tui.js # client-only (AKS)
 */

import { DurableCopilotClient, DurableCopilotWorker } from "../dist/index.js";
import { createRequire } from "node:module";
import { marked } from "marked";
import { markedTerminal } from "marked-terminal";
import fs from "node:fs";
import { spawn } from "node:child_process";

const require = createRequire(import.meta.url);
const blessed = require("neo-blessed");

// ─── Markdown renderer ──────────────────────────────────────────

// Configure marked once; we override width dynamically in renderMarkdown()
marked.use(
    markedTerminal({
        reflowText: true,
        width: 120,
        showSectionPrefix: false,
        tab: 2,
    })
);

function renderMarkdown(md) {
    try {
        // Dynamically set width to match chat pane (minus borders/padding)
        const mdWidth = Math.max(40, leftW() - 4);
        marked.use(markedTerminal({ reflowText: true, width: mdWidth, showSectionPrefix: false, tab: 2 }));
        const unescaped = md.replace(/\\n/g, "\n");
        let rendered = marked(unescaped).replace(/\n{3,}/g, "\n\n").trimEnd();
        // marked-terminal uses ANSI codes for styling, not blessed tags.
        // Strip curly braces so blessed doesn't misinterpret them as tags.
        rendered = rendered.replace(/\{/g, "(").replace(/\}/g, ")");
        // Strip emoji — blessed miscounts their display width (treats 2-cell
        // glyphs as 1), which shifts all subsequent characters on the line and
        // cascades into the right pane layout.
        // eslint-disable-next-line no-control-regex
        rendered = rendered.replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE00}-\u{FE0F}\u{200D}\u{20E3}\u{E0020}-\u{E007F}]/gu, "");
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
    title: "Durable Copilot Chat",
    fullUnicode: true,
    mouse: true,
});

// ─── Layout calculations ─────────────────────────────────────────
// Left column: sessions (top) + chat (bottom). Right column: full-height logs.

let rightPaneAdjust = Math.floor(screen.width * 0.55 * 0.25); // start right pane at 3/4 of default
function leftW() { return Math.floor(screen.width * 0.45) + rightPaneAdjust; }
function rightW() { return screen.width - leftW(); }
function bodyH() { return screen.height - 3; } // total body (minus input bar)
function sessH() { return Math.max(5, Math.floor(bodyH() * 0.25)); }
function chatH() { return bodyH() - sessH(); }

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
    keys: true,
    vi: true,
    mouse: true,
    interactive: true,
});

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

// ─── Right side: per-worker log panes, created dynamically ───────

const workerPanes = new Map(); // podName → blessed.log
const workerPaneOrder = []; // ordered pod names
const workerLogBuffers = new Map(); // podName → [{orchId, text}] — raw entries for recoloring
const paneColors = ["yellow", "magenta", "green", "blue"];
let nextColorIdx = 0;

// Log viewing mode: "workers" | "orchestration" | "sequence"
let logViewMode = "workers";

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

/**
 * Refresh the node map pane — vertical columns, one per worker node,
 * with sessions stacked underneath, color-coded by live status.
 */
function refreshNodeMap() {
    nodeMapPane.setContent("");

    // Gather all known nodes from seqNodes (worker pane names)
    // Filter out synthetic nodes like "cms" that aren't real workers.
    const SYNTHETIC_NODES = new Set(["cms"]);
    const nodes = (seqNodes.length > 0 ? [...seqNodes] : [...workerPaneOrder])
        .filter(n => !SYNTHETIC_NODES.has(n));
    if (nodes.length === 0) {
        nodeMapPane.log("{gray-fg}No worker nodes discovered yet{/gray-fg}");
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
        const uuid4 = orchId.startsWith("session-") ? orchId.slice(8, 12) : orchId.slice(0, 4);
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
    const SEP = "{gray-fg}│{/gray-fg}";

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
        nodeMapPane.log("{gray-fg}(no sessions assigned to any node){/gray-fg}");
    }

    // Legend
    nodeMapPane.log("");
    nodeMapPane.log(
        "{green-fg}* running{/green-fg}  " +
        "{yellow-fg}~ waiting{/yellow-fg}  " +
        "{gray-fg}. idle{/gray-fg}  " +
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
    let line = `{gray-fg}${timeStr}{/gray-fg}`;

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
            line += " ".repeat(mid) + "{gray-fg}|{/gray-fg}" + " ".repeat(w - mid - 1);
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
    const wMatch = plain.match(/worker_id=work-\d+-(\S+)-rt-\d+/);
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
    const shortId = activeOrchId.startsWith("session-")
        ? activeOrchId.slice(8, 16) : activeOrchId.slice(0, 8);
    seqPane.setLabel(` Sequence: ${shortId} `);

    // Update sticky header
    updateSeqHeader();

    // Reset tracking state for this render pass
    seqLastActivityNode.delete(activeOrchId);

    const events = seqEventBuffers.get(activeOrchId);
    if (events && events.length > 0) {
        for (const event of events) {
            renderSeqEventLine(event, activeOrchId);
        }
    } else {
        seqPane.log("{gray-fg}No events yet — interact with this session to populate{/gray-fg}");
        seqPane.log("{gray-fg}the sequence diagram.{/gray-fg}");
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
    }
    relayoutAll();
}

function refreshOrchLogPane() {
    orchLogPane.setContent("");
    const shortId = activeOrchId.startsWith("session-") ? activeOrchId.slice(8, 16) : activeOrchId.slice(0, 8);
    orchLogPane.setLabel(` Logs: ${shortId} `);
    const buf = orchLogBuffers.get(activeOrchId);
    if (buf && buf.length > 0) {
        for (const line of buf) orchLogPane.log(line);
    } else {
        orchLogPane.log("{gray-fg}Loading logs...{/gray-fg}");
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
        const proc = spawn("kubectl", [
            "logs",
            "-n", "copilot-sdk",
            "-l", "app.kubernetes.io/component=worker",
            "--prefix",
            "--tail=200",
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
                const buf = orchLogBuffers.get(orchId);
                if (buf && buf.length > 0) {
                    for (const ln of buf) orchLogPane.log(ln);
                } else {
                    orchLogPane.log("{gray-fg}No logs found for this session{/gray-fg}");
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

    // Left column: sessions on top, chat below
    orchList.left = 0; orchList.top = 0; orchList.width = lW; orchList.height = sH;
    chatBox.left = 0; chatBox.top = sH; chatBox.width = lW; chatBox.height = cH;
    statusBar.left = 1; statusBar.width = lW - 2;

    // Right column: full-height log panes
    if (logViewMode === "orchestration") {
        orchLogPane.left = lW;
        orchLogPane.width = rW;
        orchLogPane.top = 0;
        orchLogPane.height = bH;
    } else if (logViewMode === "sequence") {
        const headerH = 3; // 2 lines + 1 border-like spacer
        seqHeaderBox.left = lW + 1;
        seqHeaderBox.width = rW - 2;
        seqHeaderBox.top = 0;
        seqHeaderBox.height = headerH;
        seqPane.left = lW;
        seqPane.width = rW;
        seqPane.top = headerH;
        seqPane.height = bH - headerH;
    } else if (logViewMode === "nodemap") {
        nodeMapPane.left = lW;
        nodeMapPane.width = rW;
        nodeMapPane.top = 0;
        nodeMapPane.height = bH;
    } else {
        const panes = workerPaneOrder.map(n => workerPanes.get(n)).filter(Boolean);
        if (panes.length > 0) {
            const pH = Math.max(5, Math.floor(bH / panes.length));
            for (let i = 0; i < panes.length; i++) {
                panes[i].left = lW;
                panes[i].width = rW;
                panes[i].top = i * pH;
                panes[i].height = i === panes.length - 1 ? bH - i * pH : pH;
            }
        }
    }
    screen.render();
}

function redrawActiveViews() {
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

// Alt+Backspace: delete word backwards in input bar
inputBar.on("keypress", (ch, key) => {
    if (!key) return;
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

screen.render();

// ─── Helpers ─────────────────────────────────────────────────────

let pendingUserInput = null;

function appendChat(text, orchId) {
    for (const line of text.split("\n")) {
        appendChatRaw(line, orchId);
    }
}

function appendChatRaw(text, orchId) {
    // Buffer the line for this session
    const targetOrch = orchId || activeOrchId;
    if (!sessionChatBuffers.has(targetOrch)) sessionChatBuffers.set(targetOrch, []);
    sessionChatBuffers.get(targetOrch).push(text);

    // Only render to screen if this is the active session
    if (targetOrch === activeOrchId) {
        chatBox.log(text);
        screen.render();
    }
}

function setStatus(text) {
    statusBar.setContent(`{gray-fg}${text}{/gray-fg}`);
    screen.render();
}

function appendLog(text) {
    chatBox.log(`{gray-fg}${text}{/gray-fg}`);
    screen.render();
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
        pane.log(`{gray-fg}${text}{/gray-fg}`);
    } else {
        pane.log(text);
    }
    screen.render();
}

/**
 * Re-render all worker panes to highlight the current activeOrchId.
 * Called when switching sessions.
 */
function recolorWorkerPanes() {
    for (const [podName, pane] of workerPanes) {
        const buf = workerLogBuffers.get(podName);
        if (!buf || buf.length === 0) continue;
        pane.setContent("");
        for (const entry of buf) {
            if (entry.orchId && entry.orchId === activeOrchId) {
                pane.log(`{bold}${entry.text}{/bold}`);
            } else if (entry.orchId) {
                pane.log(`{gray-fg}${entry.text}{/gray-fg}`);
            } else {
                pane.log(entry.text);
            }
        }
    }
    screen.render();
}

function showCopilotMessage(raw, orchId) {
    const rendered = renderMarkdown(raw);
    const prefix = `{gray-fg}[${ts()}]{/gray-fg} {cyan-fg}{bold}Copilot:{/bold}{/cyan-fg}`;
    appendChatRaw(prefix, orchId);
    // Always show on separate lines for readability
    for (const line of rendered.split("\n")) {
        appendChatRaw(line, orchId);
    }
    appendChatRaw("", orchId); // blank line after each message
}

// Track whether sequence view has been seeded from CMS for a session.
const seqCmsSeededSessions = new Set();

/**
 * Load conversation history from CMS and rebuild chat buffer for the session.
 * Includes ALL persisted events (not truncated) so switching sessions is deterministic.
 */
async function loadCmsHistory(orchId) {
    const sid = orchId.startsWith("session-") ? orchId.slice(8) : orchId;

    // Ensure we have a DurableSession handle (may not exist for sessions from previous TUI runs)
    let sess = sessions.get(sid);
    if (!sess) {
        try {
            sess = await client.resumeSession(sid);
            sessions.set(sid, sess);
        } catch (err) {
            appendLog(`{yellow-fg}Could not resume session ${sid.slice(0, 8)}: ${err.message}{/yellow-fg}`);
            return;
        }
    }

    try {
        const events = await sess.getMessages();
        if (!events || events.length === 0) {
            sessionChatBuffers.set(orchId, []);
            if (orchId === activeOrchId) chatBox.setContent("");
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

        // Build display lines from all persisted events
        for (const evt of events) {
            const type = evt.eventType;
            const timeStr = fmtTime(evt.createdAt);
            if (type === "user.message") {
                const content = stripHostPrefix(evt.data?.content);
                if (content && !content.startsWith("[SYSTEM:") && !isTimerPrompt(content)) {
                    lines.push(`{gray-fg}[${timeStr}]{/gray-fg} {bold}You:{/bold} ${content}`);
                }
            } else if (type === "assistant.message") {
                const content = evt.data?.content;
                if (content) {
                    lines.push(`{gray-fg}[${timeStr}]{/gray-fg} {cyan-fg}{bold}Copilot:{/bold}{/cyan-fg}`);
                    const rendered = renderMarkdown(content);
                    for (const line of rendered.split("\n")) {
                        lines.push(line);
                    }
                    lines.push("");
                }
            } else if (type === "tool.execution_start") {
                const toolName = evt.data?.toolName || "tool";
                lines.push(`{gray-fg}[${timeStr}]{/gray-fg} {yellow-fg}[tool] start{/yellow-fg} ${toolName}`);
            } else if (type === "tool.execution_complete") {
                const toolName = evt.data?.toolName || "tool";
                lines.push(`{gray-fg}[${timeStr}]{/gray-fg} {green-fg}[tool] done{/green-fg} ${toolName}`);
            } else {
                lines.push(`{gray-fg}[${timeStr}] [${type}]{/gray-fg}`);
            }
        }

        lines.push("{gray-fg}── full history loaded from database ──{/gray-fg}");
        lines.push("");

        sessionChatBuffers.set(orchId, lines);

        if (orchId === activeOrchId) {
            // Build content as a single string to avoid incremental log() corruption
            chatBox.setContent(lines.join("\n"));
            chatBox.setScrollPerc(100);
            screen.render();
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
        appendLog(`{yellow-fg}CMS history load failed: ${err.message}{/yellow-fg}`);
    }
}

// ─── Start the durable client (embedded workers + client) ────────

const store = process.env.DATABASE_URL || "sqlite::memory:";
const numWorkers = parseInt(process.env.WORKERS ?? "4", 10);
const isRemote = numWorkers === 0;

if (isRemote) {
    screen.title = "Durable Copilot Chat (Scaled — Remote Workers)";
    appendLog("{bold}Mode:{/bold} {magenta-fg}Scaled (AKS Workers){/magenta-fg}");
    appendLog(`{bold}Store:{/bold} {green-fg}Remote PostgreSQL{/green-fg}`);
    appendLog("{bold}Runtime:{/bold} {yellow-fg}AKS pods (remote){/yellow-fg}");
} else {
    screen.title = `Durable Copilot Chat (${numWorkers} Embedded Workers)`;
    appendLog("{bold}Mode:{/bold} {magenta-fg}Scaled (Embedded Workers){/magenta-fg}");
    appendLog(`{bold}Store:{/bold} {green-fg}${store.includes("postgres") ? "Remote PostgreSQL" : store}{/green-fg}`);
    appendLog(`{bold}Workers:{/bold} {yellow-fg}${numWorkers} local runtimes{/yellow-fg}`);
}
appendLog("");

// 1. Start N worker runtimes (skip if WORKERS=0 for AKS mode)
const workers = [];
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

    setStatus(`Starting ${numWorkers} workers...`);
    for (let i = 0; i < numWorkers; i++) {
        const w = new DurableCopilotWorker({
            store,
            githubToken: process.env.GITHUB_TOKEN,
            logLevel: process.env.LOG_LEVEL || "error",
            blobConnectionString: process.env.AZURE_STORAGE_CONNECTION_STRING,
            blobContainer: process.env.AZURE_STORAGE_CONTAINER || "copilot-sessions",
            workerNodeId: `local-rt-${i}`,
        });
        await w.start();
        workers.push(w);
        appendLog(`Worker local-rt-${i} started ✓`);
    }

    // Restore stdout/stderr after all workers initialized
    process.stdout.write = origStdoutWrite;
    process.stderr.write = origStderrWrite;

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
                const isOrch = plain.includes("duroxide::orchestration");
                const isActivity = plain.includes("duroxide::activity");
                if (isOrch) {
                    formatted = plain
                        .replace(/\bWARN\b/g, "{yellow-fg}WARN{/yellow-fg}")
                        .replace(/\bERROR\b/g, "{red-fg}ERROR{/red-fg}")
                        .replace(/\bINFO\b/g, "{magenta-fg}INFO{/magenta-fg}");
                    formatted = `{magenta-fg}\u25c6{/magenta-fg} ${formatted}`;
                } else if (isActivity) {
                    formatted = plain
                        .replace(/\bWARN\b/g, "{yellow-fg}WARN{/yellow-fg}")
                        .replace(/\bERROR\b/g, "{red-fg}ERROR{/red-fg}")
                        .replace(/\bINFO\b/g, "{blue-fg}INFO{/blue-fg}");
                    formatted = `{blue-fg}\u25cf{/blue-fg} ${formatted}`;
                } else {
                    formatted = plain
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

// 2. Start the thin client (for creating orchestrations / reading status)
const client = new DurableCopilotClient({
    store,
    blobEnabled: true,
});

setStatus(isRemote ? "Connecting to remote DB..." : "Connecting client...");
await client.start();
setStatus("Ready — type a message");
appendLog(isRemote
    ? "Client connected ✓ {gray-fg}(no local runtime){/gray-fg}"
    : `Client connected ✓ {gray-fg}(${numWorkers} embedded workers){/gray-fg}`);

// ─── Orchestrations tracking ─────────────────────────────────────

const knownOrchestrationIds = new Set();
let orchStatusCache = new Map(); // id → { status, createdAt }
let orchIdOrder = []; // IDs in display order (matches orchList items)
const orchLastSeenVersion = new Map(); // id → customStatusVersion last seen by user
const orchHasChanges = new Set(); // IDs with unseen changes
const sessionHeadings = new Map(); // orchId → short heading from LLM
const sessionSummaryBuffer = new Map(); // orchId → buffered summary text to show on switch
const sessionSummarized = new Set(); // orchIds already summarized (avoid re-asking)

// Per-session chat buffers — every observer writes here so content is preserved on switch
const sessionChatBuffers = new Map(); // orchId → string[]
const sessionObservers = new Map(); // orchId → AbortController
const sessionLiveStatus = new Map(); // orchId → "idle"|"running"|"waiting"|"input_required"

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

    // Sort by createdAt descending (stable — no status-based reordering)
    entries.sort((a, b) => b.createdAt - a.createdAt);

    // Pull session titles from CMS
    try {
        const cmsSessions = await client.listSessions();
        for (const s of cmsSessions) {
            if (s.title) {
                sessionHeadings.set(`session-${s.sessionId}`, s.title);
            }
        }
    } catch {}

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
                statusIcon = "{gray-fg}z{/gray-fg}";
            }

            const heading = sessionHeadings.get(id);
            const label = heading
                ? `${heading} (${uuid4}) ${timeStr}`
                : `(${uuid4}) ${timeStr}`;
            orchList.addItem(`${marker}${changeDot}${statusIcon ? statusIcon + " " : ""}{${color}-fg}${label}{/${color}-fg}`);
        }
    }
    // Restore cursor position — keep the user's selection stable.
    // Only jump to activeOrchId when it was *just* changed (e.g. Enter / n).
    if (orchSelectFollowActive) {
        const activeIdx = orchIdOrder.indexOf(activeOrchId);
        if (activeIdx >= 0) {
            orchList.select(activeIdx);
        } else {
            orchList.select(Math.min(prevSelected, orchIdOrder.length - 1));
        }
        orchSelectFollowActive = false;
    } else {
        orchList.select(Math.min(prevSelected, orchIdOrder.length - 1));
    }
    screen.render();

    // Start observers for any sessions that don't have one yet
    for (const { id, status } of entries) {
        if (!sessionObservers.has(id) && status !== "Completed" && status !== "Failed" && status !== "Terminated") {
            startObserver(id);
        }
    }
}

// Poll orchestrations every 3 seconds
let orchPollTimer = setInterval(() => {
    refreshOrchestrations();
    if (logViewMode === "nodemap") refreshNodeMap();
}, 3000);

// Orchestrations panel key handlers
orchList.key(["q"], () => {
    cleanup().then(() => process.exit(0));
});

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
        appendLog(`{green-fg}New session: ${sess.sessionId.slice(0, 8)}…{/green-fg}`);
        await switchToOrchestration(orchId);
        await refreshOrchestrations();
        // Focus prompt so user can type immediately
        inputBar.focus();
        screen.render();
    } catch (err) {
        appendLog(`{red-fg}Create failed: ${err.message}{/red-fg}`);
    }
});

// ── Title rename ─────────────────────────────────────────────────
// Shows a choice: type a custom title or ask the LLM to summarize.
orchList.key(["t"], async () => {
    const idx = orchList.selected;
    if (idx < 0 || idx >= orchIdOrder.length) return;
    const orchId = orchIdOrder[idx];
    const sessionId = orchId.startsWith("session-") ? orchId.slice(8) : orchId;
    const uuid4 = sessionId.slice(0, 4);

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
                const catalog = client._getCatalog();
                await catalog.updateSession(sessionId, { title: newTitle.trim().slice(0, 60) });
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
        kubectlProc = spawn("kubectl", [
            "logs", "-f",
            "-n", "copilot-sdk",
            "-l", "app.kubernetes.io/component=worker",
            "--prefix",
            "--tail=50",
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
            if (text && !text.includes("proxy error") && !text.includes("Gateway Timeout") && !text.includes("NotFound") && !text.includes("not found")) {
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

if (isRemote) {
    startLogStream();
    appendLog("{green-fg}Streaming AKS worker logs ↓{/green-fg}");

    // Periodically prune stale worker panes (every 30s)
    setInterval(async () => {
        try {
            const result = await new Promise((resolve, reject) => {
                const proc = spawn("kubectl", [
                    "get", "pods", "-n", "copilot-sdk",
                    "-l", "app.kubernetes.io/component=worker",
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

const SYSTEM_MESSAGE = "You are a helpful assistant running in a durable execution environment. Be concise.\n\nCRITICAL RULES:\n1. You have a 'wait' tool. You MUST use it whenever you need to wait, pause, sleep, delay, poll, check back later, schedule a future action, or implement any recurring/periodic task.\n2. NEVER say you cannot wait or set timers. You CAN — use the 'wait' tool.\n3. NEVER use bash sleep, setTimeout, setInterval, cron, or any other timing mechanism.\n4. The 'wait' tool enables durable timers that survive process restarts and node migrations.\n5. For recurring tasks: use the 'wait' tool in a loop — complete the action, then call wait(seconds), then repeat.";

// Map sessionId → DurableSession object
const sessions = new Map();

// ─── Model selection ─────────────────────────────────────────────
let currentModel = process.env.COPILOT_MODEL || "claude-opus-4.5";

// Pending command responses — keyed by correlation ID
// Observer matches cmdResponse.id and displays results
const pendingCommands = new Map(); // id → { cmd, resolve, timer }

// Auto-timeout pending commands after 15 seconds
function addPendingCommand(cmdId, cmd) {
    const timer = setTimeout(() => {
        if (pendingCommands.has(cmdId)) {
            pendingCommands.delete(cmdId);
            appendChatRaw(`{yellow-fg}⏱ Command timed out: ${cmd} — the orchestration may be restarting. Try again.{/yellow-fg}`);
            screen.render();
        }
    }, 15_000);
    pendingCommands.set(cmdId, { cmd, resolve: null, timer });
}

async function createNewSession() {
    const sess = await client.createSession({
        model: currentModel,
        systemMessage: SYSTEM_MESSAGE,
        onUserInputRequest: async (request) => {
            return new Promise((resolve) => {
                const q = request.question || "?";
                appendChatRaw(`{magenta-fg}[?] ${q}{/magenta-fg}`);
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
let orchSelectFollowActive = true; // when true, next refresh snaps selection to activeOrchId

function updateChatLabel() {
    chatBox.setLabel(` {bold}Chat{/bold} {gray-fg}[${activeSessionShort}]{/gray-fg} `);
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
        refreshOrchestrations();
    }

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
                    appendChatRaw(`{red-fg}❌ Orchestration failed: ${reason}{/red-fg}`, orchId);
                    updateLiveStatus("error");
                } else {
                    appendChatRaw(`{gray-fg}Orchestration ${currentStatus.status}{/gray-fg}`, orchId);
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
                        appendChatRaw(`{red-fg}⚠ ${errText}{/red-fg}`, orchId);
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
                const statusResult = await dc.waitForStatusChange(
                    orchId, lastVersion, 200, 30_000
                );
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
                    // Show intermediate content
                    if (cs.intermediateContent) {
                        showCopilotMessage(cs.intermediateContent, orchId);
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
                                            const marker = m.id === active ? " {green-fg}← active{/green-fg}" : "";
                                            appendChatRaw(`  {cyan-fg}${m.id}{/cyan-fg}${marker}`, orchId);
                                        }
                                        appendChatRaw("{gray-fg}Use /model <name> to switch{/gray-fg}", orchId);
                                        break;
                                    }
                                    case "set_model": {
                                        const r = resp.result;
                                        currentModel = r.newModel;
                                        appendChatRaw(`{green-fg}✓ Model changed: {bold}${r.oldModel}{/bold} → {bold}${r.newModel}{/bold}{/green-fg}`, orchId);
                                        appendChatRaw("{gray-fg}Takes effect on the next turn.{/gray-fg}", orchId);
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
                            const hMatch = displayContent.match(/^HEADING:\s*(.+)/m);
                            if (hMatch) {
                                sessionHeadings.set(orchId, hMatch[1].trim().slice(0, 40));
                                displayContent = displayContent.replace(/^HEADING:.*\n?/m, "").trim();
                                refreshOrchestrations();
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
                        appendChatRaw(`{red-fg}⚠ ${errText}{/red-fg}`, orchId);
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
                        refreshOrchestrations();
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
                            appendChatRaw(`{red-fg}❌ Session failed: ${reason}{/red-fg}`, orchId);
                        }
                        appendChatRaw(`{gray-fg}Orchestration ${info.status}{/gray-fg}`, orchId);
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

/**
 * Switch the chat context to a different orchestration.
 * Sends an interrupt asking for a summary + last message, then asks it to resume.
 */
async function switchToOrchestration(orchId) {
    const isSameSession = orchId === activeOrchId;

    activeOrchId = orchId;
    orchSelectFollowActive = true; // snap list selection to newly activated session
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

    // Clear chat and show switch indicator (only when switching to a different session)
    if (!isSameSession) {
        chatBox.setContent("");
        chatBox.setScrollPerc(0);
        updateChatLabel();

        // Always rebuild from DB so switching sessions shows full persisted history.
        await loadCmsHistory(orchId);

        // Force blessed to recalculate its internal buffer after content change
        screen.realloc();
        screen.render();

        // Ensure an observer is running for this session
        startObserver(orchId);

        // Refresh list to update ▸ marker
        refreshOrchestrations();

        redrawActiveViews();
    } else {
        redrawActiveViews();
    }
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
        inputBar.focus();
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
            inputBar.focus();

            const dc = getDc();
            if (!dc) {
                appendChatRaw("{red-fg}Not connected{/red-fg}");
                screen.render();
                return;
            }

            if (!arg) {
                // List models — send command through duroxide
                const cmdId = crypto.randomUUID().slice(0, 8);
                appendChatRaw("{yellow-fg}Fetching models...{/yellow-fg}");
                screen.render();
                addPendingCommand(cmdId, "list_models");
                try {
                    // Ensure orchestration exists before sending command
                    await ensureOrchestrationStarted();
                    await dc.enqueueEvent(activeOrchId, "messages", JSON.stringify({
                        type: "cmd", cmd: "list_models", id: cmdId,
                    }));
                } catch (err) {
                    pendingCommands.delete(cmdId);
                    appendChatRaw(`{red-fg}Failed to send command: ${err.message}{/red-fg}`);
                }
            } else {
                // Set model — send command through duroxide
                const cmdId = crypto.randomUUID().slice(0, 8);
                currentModel = arg;
                appendChatRaw(`{yellow-fg}Switching model to ${arg}...{/yellow-fg}`);
                screen.render();
                addPendingCommand(cmdId, "set_model");
                try {
                    await ensureOrchestrationStarted();
                    await dc.enqueueEvent(activeOrchId, "messages", JSON.stringify({
                        type: "cmd", cmd: "set_model", args: { model: arg }, id: cmdId,
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
            inputBar.focus();
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
            inputBar.focus();
            appendChatRaw("{bold}Commands:{/bold}");
            appendChatRaw("  {cyan-fg}/models{/cyan-fg}         — List available models (via worker)");
            appendChatRaw("  {cyan-fg}/model <name>{/cyan-fg}  — Switch model for this session");
            appendChatRaw("  {cyan-fg}/info{/cyan-fg}           — Show session info (model, iteration, etc.)");
            appendChatRaw("  {cyan-fg}/new{/cyan-fg}            — Create a new session");
            appendChatRaw("  {cyan-fg}/help{/cyan-fg}           — Show this help");
            screen.render();
            return;
        }

        if (cmd === "/new") {
            inputBar.clearValue();
            inputBar.focus();
            appendChatRaw("{yellow-fg}Creating new session...{/yellow-fg}");
            screen.render();
            try {
                const newSess = await createNewSession();
                const newOrchId = `session-${newSess.sessionId}`;
                knownOrchestrationIds.add(newOrchId);
                await refreshOrchestrations();
                await switchToOrchestration(newOrchId);
                appendChatRaw(`{green-fg}New session created ✓ {gray-fg}(${newSess.sessionId.slice(0, 8)}…) model=${currentModel}{/gray-fg}{/green-fg}`);
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
        inputBar.focus();
        screen.render();
        return;
    }

    if (turnInProgress) {
        appendChatRaw(`{gray-fg}[${ts()}]{/gray-fg} {white-fg}{bold}You:{/bold} ${trimmed}{/white-fg}`);
        inputBar.clearValue();
        setStatus("Interrupting...");
        injectSeqUserEvent(activeOrchId, trimmed);
        try {
            const dc = getDc();
            if (dc) await dc.enqueueEvent(activeOrchId, "messages", JSON.stringify({ prompt: trimmed }));
        } catch (err) {
            appendChatRaw(`{red-fg}Interrupt failed: ${err.message}{/red-fg}`);
        }
        inputBar.focus();
        screen.render();
        return;
    }

    appendChatRaw(`{gray-fg}[${ts()}]{/gray-fg} {white-fg}{bold}You:{/bold} ${trimmed}{/white-fg}`);
    inputBar.clearValue();
    inputBar.focus();
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
                    appendChatRaw(`{gray-fg}Create a new session with 'n' to continue.{/gray-fg}`);
                    turnInProgress = false;
                    setStatus(`${orchStatus.status} — session is dead`);
                    screen.render();
                    return;
                }
            } catch {}
        }

        // Use the DurableSession to send — it handles starting the orchestration
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
    clearInterval(orchPollTimer);
    // Stop all session observers
    for (const [, ac] of sessionObservers) { ac.abort(); }
    sessionObservers.clear();
    if (kubectlProc) { try { kubectlProc.kill(); } catch {} }
    setStatus("Shutting down workers...");
    await Promise.allSettled(workers.map(w => w.stop()));
    setStatus("Disconnecting client...");
    await client.stop();
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
// Tab: cycle through panes
// h/l: left/right between sessions, chat, worker panes (when not in prompt)

screen.on("keypress", (ch, key) => {
    if (!key) return;

    // m: toggle log viewing mode (only from non-input panes)
    if (ch === "m" && screen.focused !== inputBar) {
        switchLogMode();
        const modeNames = { workers: "Per-Worker", orchestration: "Per-Orchestration", sequence: "Sequence Diagram", nodemap: "Node Map" };
        appendLog(`{cyan-fg}Log mode: ${modeNames[logViewMode]}{/cyan-fg}`);
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
    if (key.name === "escape" && screen.focused !== inputBar) {
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
        inputBar.focus();
        setStatus("Ready — type a message");
        screen.render();
        return;
    }

    // h/l navigation only when NOT in the input bar
    if (screen.focused !== inputBar) {
        const panes = workerPaneOrder.map(n => workerPanes.get(n)).filter(Boolean);
        const rightPane = logViewMode === "orchestration" ? orchLogPane
            : logViewMode === "nodemap" ? nodeMapPane
            : logViewMode === "sequence" ? seqPane
            : (panes.length > 0 ? panes[0] : null);

        if (key.name === "h" || ch === "h") {
            // Left
            if (screen.focused === orchLogPane || screen.focused === nodeMapPane || screen.focused === seqPane || [...workerPanes.values()].includes(screen.focused)) {
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

// Tab: cycle sessions → chat → worker/orch panes → sessions
screen.key(["tab"], () => {
    const rightPanes = logViewMode === "orchestration"
        ? [orchLogPane]
        : logViewMode === "nodemap"
        ? [nodeMapPane]
        : logViewMode === "sequence"
        ? [seqPane]
        : workerPaneOrder.map(n => workerPanes.get(n)).filter(Boolean);
    const allFocusable = [orchList, chatBox, ...rightPanes];
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

screen.on("resize", () => {
    relayoutAll();
    if (logViewMode === "sequence") refreshSeqPane();
    if (logViewMode === "nodemap") refreshNodeMap();
});

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
                if (headingMatch) {
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
                const uuid4 = orchId.startsWith("session-") ? orchId.slice(8, 12) : orchId.slice(0, 4);
                appendLog(`{green-fg}✓ Summarized ${uuid4}: ${sessionHeadings.get(orchId) || "done"}{/green-fg}`);
                return;
            }
        } catch {
            await new Promise(r => setTimeout(r, 1000));
        }
    }
    // Timed out — log and move on
    const uuid4 = orchId.startsWith("session-") ? orchId.slice(8, 12) : orchId.slice(0, 4);
    appendLog(`{yellow-fg}⏳ Summarize ${uuid4} timed out (old session?){/yellow-fg}`);
}

// Kick off summarization for all known sessions (in parallel, max 3 at a time)
// Disabled — no longer sending summary interrupts on startup.
// Headings are populated organically from HEADING: lines in turn results.

orchList.focus();
screen.render();
