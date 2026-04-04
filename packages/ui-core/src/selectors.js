import { INSPECTOR_TABS, FOCUS_REGIONS } from "./commands.js";
import { createSplashCard, parseAskedAndAnsweredExchange } from "./history.js";
import {
    buildMessageCardLines,
    decorateArtifactLinksForChat,
    extractArtifactLinks,
    formatDisplayDateTime,
    formatHumanDurationSeconds,
    formatTimestamp,
    parseMarkdownLines,
    shortModelName,
    shortSessionId,
} from "./formatting.js";
import {
    getContextCompactionBadge,
    getContextHeaderBadge,
    getContextListBadge,
} from "./context-usage.js";

export const ACTIVE_HIGHLIGHT_BACKGROUND = "#20364f";
export const ACTIVE_HIGHLIGHT_FOREGROUND = "#f8fbff";

const totalDescendantCountsCache = new WeakMap();
const visibleDescendantCountsCache = new WeakMap();

const ACTIVE_HIGHLIGHT_COLOR_MAP = {
    white: "#f8fbff",
    gray: "#d6deea",
    yellow: "#ffd86b",
    magenta: "#f4afff",
    cyan: "#8fe8ff",
    green: "#98f2b4",
    red: "#ff9f9f",
    blue: "#a7cfff",
};

export function resolveActiveHighlightColor(color) {
    if (!color) return ACTIVE_HIGHLIGHT_FOREGROUND;
    return ACTIVE_HIGHLIGHT_COLOR_MAP[color] || color;
}

export function applyActiveHighlightRuns(runs, { preserveColors = false } = {}) {
    return (runs || []).map((run) => ({
        ...run,
        color: preserveColors ? resolveActiveHighlightColor(run?.color) : ACTIVE_HIGHLIGHT_FOREGROUND,
        backgroundColor: ACTIVE_HIGHLIGHT_BACKGROUND,
        bold: run?.bold ?? true,
    }));
}

export function buildActiveHighlightLine(text, { color = ACTIVE_HIGHLIGHT_FOREGROUND, bold = true } = {}) {
    return {
        text,
        color,
        backgroundColor: ACTIVE_HIGHLIGHT_BACKGROUND,
        bold,
    };
}

function getSessionVisualStatus(session) {
    if (!session) return "unknown";
    const status = session.status || "unknown";
    if (
        session.cronActive === true
        && (status === "waiting" || status === "idle" || status === "unknown")
    ) {
        return "cron_waiting";
    }
    return status;
}

function isTerminalOrchestrationStatus(status) {
    return status === "Completed" || status === "Failed" || status === "Terminated";
}

function getSessionErrorVisualKind(session) {
    const status = getSessionVisualStatus(session);
    if (session?.orchestrationStatus === "Failed" || status === "failed") return "failed";
    if (status === "error") return "warning";
    return null;
}

function getSessionVisualKind(session, mode = "local") {
    const errorKind = getSessionErrorVisualKind(session);
    if (errorKind) return errorKind;

    const status = getSessionVisualStatus(session);
    if (
        mode === "remote"
        && isTerminalOrchestrationStatus(session?.orchestrationStatus)
        && status !== "cron_waiting"
        && status !== "waiting"
        && status !== "input_required"
    ) {
        if (session?.orchestrationStatus === "Completed") return "completed";
        if (session?.orchestrationStatus === "Terminated") return "terminated";
    }
    if (status === "terminated") return "terminated";
    return status;
}

function sessionStatusColor(session, mode = "local") {
    switch (getSessionVisualKind(session, mode)) {
        case "running": return "green";
        case "cron_waiting": return "yellow";
        case "waiting": return "yellow";
        case "input_required": return "cyan";
        case "cancelled": return "gray";
        case "warning": return "yellow";
        case "failed": return "red";
        case "terminated": return "gray";
        case "completed": return "gray";
        case "idle": return "white";
        default: return "white";
    }
}

function sessionStatusIcon(session, mode = "local") {
    switch (getSessionVisualKind(session, mode)) {
        case "running": return "*";
        case "cron_waiting": return "~";
        case "waiting": return "~";
        case "input_required": return "?";
        case "cancelled": return "x";
        case "warning": return "!";
        case "failed":
        case "terminated": return "x";
        case "idle": return ".";
        default: return "";
    }
}

function canonicalSystemTitle(session, brandingTitle = "PilotSwarm") {
    const agentId = String(session?.agentId || "");
    if (agentId === "pilotswarm") return brandingTitle || "PilotSwarm";
    if (agentId === "sweeper") return "Sweeper Agent";
    if (agentId === "resourcemgr") return "Resource Manager Agent";

    const rawTitle = String(session?.title || "");
    if (/^pilotswarm agent$/i.test(rawTitle)) return brandingTitle || "PilotSwarm";
    if (/^sweeper agent$/i.test(rawTitle) || /^sweeper$/i.test(rawTitle)) return "Sweeper Agent";
    if (/^resource manager agent$/i.test(rawTitle) || /^resourcemgr$/i.test(rawTitle)) return "Resource Manager Agent";
    return rawTitle || "System Agent";
}

function buildSessionTitle(session, brandingTitle) {
    const shortId = shortSessionId(session?.sessionId);

    if (session?.isSystem) {
        return `${canonicalSystemTitle(session, brandingTitle)} (${shortId})`;
    }

    const title = String(session?.title || "");
    if (!title) return `(${shortId})`;
    return title.includes(shortId) ? title : `${title} (${shortId})`;
}

function flattenRunsText(runs) {
    return (runs || []).map((run) => run?.text || "").join("");
}

function buildChildMaps(byId) {
    const childMap = new Map();
    const parentMap = new Map();

    for (const session of Object.values(byId || {})) {
        const parentId = session?.parentSessionId;
        if (!parentId) continue;
        parentMap.set(session.sessionId, parentId);
        if (!childMap.has(parentId)) childMap.set(parentId, []);
        childMap.get(parentId).push(session.sessionId);
    }

    return { childMap, parentMap };
}

function buildTotalDescendantCounts(byId) {
    const { childMap } = buildChildMaps(byId);
    const counts = new Map();

    function countFor(sessionId) {
        if (counts.has(sessionId)) return counts.get(sessionId);
        const children = childMap.get(sessionId) || [];
        const total = children.reduce((sum, childId) => sum + 1 + countFor(childId), 0);
        counts.set(sessionId, total);
        return total;
    }

    for (const sessionId of Object.keys(byId || {})) {
        countFor(sessionId);
    }

    return counts;
}

function buildVisibleDescendantCounts(flat = [], byId = {}) {
    const { parentMap } = buildChildMaps(byId);
    const counts = new Map();

    for (const entry of flat) {
        let currentParentId = parentMap.get(entry.sessionId);
        while (currentParentId) {
            counts.set(currentParentId, (counts.get(currentParentId) || 0) + 1);
            currentParentId = parentMap.get(currentParentId);
        }
    }

    return counts;
}

function getTotalDescendantCounts(byId = {}) {
    if (!byId || typeof byId !== "object") {
        return buildTotalDescendantCounts(byId);
    }
    const cached = totalDescendantCountsCache.get(byId);
    if (cached) return cached;
    const counts = buildTotalDescendantCounts(byId);
    totalDescendantCountsCache.set(byId, counts);
    return counts;
}

function getVisibleDescendantCounts(flat = [], byId = {}) {
    if (!Array.isArray(flat)) {
        return buildVisibleDescendantCounts(flat, byId);
    }
    const cached = visibleDescendantCountsCache.get(flat);
    if (cached) return cached;
    const counts = buildVisibleDescendantCounts(flat, byId);
    visibleDescendantCountsCache.set(flat, counts);
    return counts;
}

function getCollapseBadge(sessionId, entry, totalDescendantCounts, visibleDescendantCounts) {
    const totalDescendants = totalDescendantCounts.get(sessionId) || 0;
    const visibleDescendants = visibleDescendantCounts.get(sessionId) || 0;
    const hiddenDescendants = Math.max(0, totalDescendants - visibleDescendants);
    const badgeCount = entry?.collapsed ? totalDescendants : hiddenDescendants;
    if (!badgeCount) return null;
    return { text: `[+${badgeCount}]`, color: "cyan" };
}

function getCronBadge(session) {
    if (!(session?.cronActive === true && typeof session?.cronInterval === "number")) {
        return null;
    }
    return {
        text: `[cron ${formatHumanDurationSeconds(session.cronInterval)}]`,
        color: "magenta",
    };
}

function buildSessionRowRuns(entry, session, state, totalDescendantCounts, visibleDescendantCounts) {
    const runs = [];
    const mode = state.connection?.mode || "local";
    const depthPrefix = entry.depth > 0
        ? `${"  ".repeat(Math.max(0, entry.depth - 1))}└ `
        : "";

    if (depthPrefix) {
        runs.push({ text: depthPrefix, color: "gray" });
    }

    if (session?.isSystem) {
        runs.push({ text: "≈ ", color: "yellow", bold: true });
    } else {
        const icon = sessionStatusIcon(session, mode);
        runs.push({
            text: icon ? `${icon} ` : "  ",
            color: sessionStatusColor(session, mode),
        });
    }

    const mainColor = session?.isSystem ? "yellow" : sessionStatusColor(session, mode);
    const titleText = buildSessionTitle(session, state.branding?.title || "PilotSwarm");
    const createdAtText = session?.createdAt ? ` ${formatDisplayDateTime(session.createdAt)}` : "";
    runs.push({
        text: `${titleText}${createdAtText}`,
        color: mainColor,
        bold: Boolean(session?.isSystem),
    });

    for (const badge of [
        getCronBadge(session),
        getContextListBadge(session?.contextUsage),
        getCollapseBadge(session?.sessionId, entry, totalDescendantCounts, visibleDescendantCounts),
    ]) {
        if (!badge) continue;
        runs.push({ text: ` ${badge.text}`, color: badge.color, bold: badge.bold });
    }

    return runs;
}

export function selectSessionRows(state) {
    const totalDescendantCounts = getTotalDescendantCounts(state.sessions.byId);
    const visibleDescendantCounts = getVisibleDescendantCounts(state.sessions.flat, state.sessions.byId);

    return state.sessions.flat.map((entry) => {
        const session = state.sessions.byId[entry.sessionId];
        const runs = buildSessionRowRuns(entry, session, state, totalDescendantCounts, visibleDescendantCounts);
        return {
            sessionId: entry.sessionId,
            text: flattenRunsText(runs),
            runs,
            depth: entry.depth,
            status: session?.status,
            statusColor: sessionStatusColor(session, state.connection?.mode || "local"),
            active: entry.sessionId === state.sessions.activeSessionId,
            isSystem: Boolean(session?.isSystem),
            hasChildren: entry.hasChildren,
            collapsed: entry.collapsed,
        };
    });
}

export function selectVisibleSessionRows(state, maxRows = 8) {
    const flat = Array.isArray(state.sessions?.flat) ? state.sessions.flat : [];
    if (flat.length === 0) return [];

    const activeIndexRaw = flat.findIndex((entry) => entry.sessionId === state.sessions.activeSessionId);
    const activeIndex = Math.max(0, activeIndexRaw);
    if (flat.length <= maxRows) {
        return selectSessionRows(state);
    }

    const half = Math.floor(maxRows / 2);
    let start = Math.max(0, activeIndex - half);
    let end = Math.min(flat.length, start + maxRows);

    if (end > flat.length) {
        end = flat.length;
        start = Math.max(0, end - maxRows);
    }

    const visibleEntries = flat.slice(start, end);
    const totalDescendantCounts = getTotalDescendantCounts(state.sessions.byId);
    const visibleDescendantCounts = getVisibleDescendantCounts(flat, state.sessions.byId);

    return visibleEntries.map((entry) => {
        const session = state.sessions.byId[entry.sessionId];
        const runs = buildSessionRowRuns(entry, session, state, totalDescendantCounts, visibleDescendantCounts);
        return {
            sessionId: entry.sessionId,
            text: flattenRunsText(runs),
            runs,
            depth: entry.depth,
            status: session?.status,
            statusColor: sessionStatusColor(session, state.connection?.mode || "local"),
            active: entry.sessionId === state.sessions.activeSessionId,
            isSystem: Boolean(session?.isSystem),
            hasChildren: entry.hasChildren,
            collapsed: entry.collapsed,
        };
    });
}

export function selectActiveSession(state) {
    const sessionId = state.sessions.activeSessionId;
    return sessionId ? state.sessions.byId[sessionId] || null : null;
}

function buildPendingQuestionMessage(session) {
    const pendingQuestion = session?.pendingQuestion;
    if (!pendingQuestion?.question) return null;

    const body = [String(pendingQuestion.question).trim()];
    const choices = Array.isArray(pendingQuestion.choices)
        ? pendingQuestion.choices.filter((choice) => typeof choice === "string" && choice.trim())
        : [];

    if (choices.length > 0) {
        body.push("", "Choices:");
        for (const choice of choices) {
            body.push(`- ${choice}`);
        }
    }

    if (choices.length > 0 && pendingQuestion.allowFreeform === false) {
        body.push("", "Reply with one of the choices above in the prompt below.");
    } else if (choices.length > 0) {
        body.push("", "Reply with one of the choices above, or type a free-form answer below.");
    } else {
        body.push("", "Type your answer in the prompt below and press Enter.");
    }

    return {
        id: `pending-question:${session.sessionId}:${pendingQuestion.question}`,
        role: "system",
        text: body.join("\n"),
        time: "",
        createdAt: session.updatedAt || Date.now(),
        cardTitle: "Question",
        cardTitleColor: "cyan",
        cardBorderColor: "cyan",
    };
}

function chatAlreadyContainsPendingQuestion(chat, question) {
    const normalizedQuestion = String(question || "").trim();
    if (!normalizedQuestion) return false;

    return (chat || []).some((message) => {
        const parsedExchange = parseAskedAndAnsweredExchange(message?.text || "");
        if (parsedExchange?.question?.trim() === normalizedQuestion) return true;
        return false;
    });
}

function buildSessionErrorMessage(session) {
    const errorText = String(session?.error || "").trim();
    if (!errorText) return null;

    const errorKind = getSessionErrorVisualKind(session);
    if (!errorKind) return null;

    const isFailed = errorKind === "failed";
    const body = isFailed
        ? errorText
        : `${errorText}\n\nThe orchestration is still running, so this may be transient.`;

    return {
        id: `session-error:${session.sessionId}:${session.updatedAt || ""}:${errorText}`,
        role: "system",
        text: body,
        time: "",
        createdAt: session.updatedAt || Date.now(),
        cardTitle: isFailed ? "Error" : "Warning",
        cardTitleColor: isFailed ? "red" : "yellow",
        cardBorderColor: isFailed ? "red" : "yellow",
    };
}

export function selectActiveChat(state) {
    const sessionId = state.sessions.activeSessionId;
    const session = sessionId ? state.sessions.byId[sessionId] || null : null;
    if (!sessionId) return createSplashCard(state.branding);
    const history = state.history.bySessionId.get(sessionId);
    const chat = history?.chat || [];
    const pendingQuestionMessage = session?.pendingQuestion?.question
        && !chatAlreadyContainsPendingQuestion(chat, session.pendingQuestion.question)
        ? buildPendingQuestionMessage(session)
        : null;
    const sessionErrorMessage = buildSessionErrorMessage(session);

    if ((!history || chat.length === 0) && !pendingQuestionMessage && !sessionErrorMessage) {
        return createSplashCard(state.branding);
    }

    const messages = chat.length > 0 ? [...chat] : createSplashCard(state.branding);
    if (pendingQuestionMessage) {
        messages.push(pendingQuestionMessage);
    }
    if (sessionErrorMessage) {
        messages.push(sessionErrorMessage);
    }
    return messages;
}

function prefixRuns(text, color = "gray", options = {}) {
    return [{
        text,
        color,
        bold: Boolean(options.bold),
        underline: Boolean(options.underline),
    }];
}

function buildChatMessagePrefix(message) {
    const time = formatTimestamp(message?.createdAt || message?.time);
    const roleLabel = message?.role === "user"
        ? "You"
        : message?.role === "assistant"
            ? "Agent"
            : message?.role === "system"
                ? "System"
                : "PilotSwarm";
    const roleColor = message?.role === "user"
        ? "blue"
        : message?.role === "assistant"
            ? "green"
            : message?.role === "system"
                ? "yellow"
                : "white";
    const prefix = time ? `[${time}] ` : "";
    return [
        ...prefixRuns(prefix, "gray"),
        ...prefixRuns(`${roleLabel}: `, roleColor, { bold: true }),
    ];
}

function flattenLineText(lineRuns) {
    if (!Array.isArray(lineRuns)) return String(lineRuns?.text || "");
    return (lineRuns || []).map((run) => run?.text || "").join("");
}

function startsWithStructuredBlock(lines) {
    const firstVisibleLine = (lines || []).find((line) => flattenLineText(line).trim().length > 0);
    const text = flattenLineText(firstVisibleLine).trimStart();
    return /^[┌│└]/.test(text);
}

function trimLeadingBlankLines(lines) {
    const source = Array.isArray(lines) ? [...lines] : [];
    while (source.length > 0) {
        const firstLine = source[0];
        if (flattenLineText(firstLine).trim().length > 0) break;
        source.shift();
    }
    return source;
}

function splitSystemNoticeSegments(text) {
    const lines = String(text || "").replace(/\r\n/g, "\n").split("\n");
    const segments = [];
    let textLines = [];

    function flushText() {
        if (textLines.length === 0) return;
        segments.push({
            kind: "text",
            text: textLines.join("\n"),
        });
        textLines = [];
    }

    for (let index = 0; index < lines.length;) {
        const line = lines[index];
        if (!/^\s*\[SYSTEM:/i.test(line)) {
            textLines.push(line);
            index += 1;
            continue;
        }

        const singleLineMatch = /^\s*\[SYSTEM:\s*(.*?)\]\s*$/i.exec(line);
        if (singleLineMatch) {
            flushText();
            segments.push({
                kind: "system",
                text: singleLineMatch[1].trim(),
            });
            index += 1;
            continue;
        }

        const noticeLines = [line.replace(/^\s*\[SYSTEM:\s*/i, "")];
        let closingIndex = -1;
        for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
            const closingLine = lines[cursor];
            if (closingLine.trim() === "]") {
                closingIndex = cursor;
                break;
            }
            noticeLines.push(closingLine);
        }

        if (closingIndex === -1) {
            textLines.push(line);
            index += 1;
            continue;
        }

        flushText();
        segments.push({
            kind: "system",
            text: noticeLines.join("\n").trim(),
        });
        index = closingIndex + 1;
    }

    flushText();
    return segments;
}

function startsWithCardBlock(lines) {
    const firstVisibleLine = (lines || []).find((line) => flattenLineText(line).trim().length > 0);
    if (!firstVisibleLine) return false;
    return flattenLineText(firstVisibleLine).trimStart().startsWith("┌");
}

function appendChatBlockLines(targetLines, nextLines) {
    if (!Array.isArray(nextLines) || nextLines.length === 0) return;
    if (
        targetLines.length > 0
        && startsWithCardBlock(nextLines)
        && flattenLineText(targetLines[targetLines.length - 1]).trim().length > 0
    ) {
        targetLines.push([{ text: "", color: null }]);
    }
    targetLines.push(...nextLines);
}

function isDialogRole(role) {
    return role === "user" || role === "assistant";
}

function shouldInsertChatSpacer(currentMessage, nextMessage) {
    if (!isDialogRole(currentMessage?.role) || !isDialogRole(nextMessage?.role)) {
        return false;
    }
    return currentMessage.role !== nextMessage.role;
}

function buildChatMessageLines(message, maxWidth, options = {}) {
    if (message?.splash) {
        return [{ kind: "markup", value: message.text }];
    }

    if (message?.role === "user") {
        const askedAndAnswered = parseAskedAndAnsweredExchange(message?.text || "");
        if (askedAndAnswered) {
            return [
                ...buildMessageCardLines({
                    title: "Question",
                    timestamp: formatTimestamp(message?.createdAt || message?.time),
                    body: askedAndAnswered.question,
                    width: Math.max(20, maxWidth),
                    titleColor: "cyan",
                    borderColor: "cyan",
                }),
                ...buildChatMessageLines({
                    ...message,
                    text: askedAndAnswered.answer,
                }, maxWidth),
            ];
        }
    }

    if (options.allowLeadingSystemNotices !== false && (message?.role === "user" || message?.role === "assistant")) {
        const segments = splitSystemNoticeSegments(message?.text || "");
        if (segments.some((segment) => segment.kind === "system")) {
            const rendered = [];
            let renderedSpeakerText = false;

            for (const segment of segments) {
                if (segment.kind === "system") {
                    appendChatBlockLines(rendered, buildMessageCardLines({
                        title: "System",
                        timestamp: formatTimestamp(message?.createdAt || message?.time),
                        body: decorateArtifactLinksForChat(segment.text),
                        width: Math.max(20, maxWidth),
                        titleColor: "yellow",
                        borderColor: "gray",
                        bodyColor: "gray",
                        fitToContent: true,
                    }));
                    continue;
                }

                if (!segment.text.trim()) continue;
                appendChatBlockLines(rendered, buildChatMessageLines({
                    ...message,
                    text: segment.text,
                }, maxWidth, {
                    allowLeadingSystemNotices: false,
                    skipPrefix: renderedSpeakerText,
                }));
                renderedSpeakerText = true;
            }

            if (rendered.length > 0) {
                return rendered;
            }
        }
    }

    if (message?.role !== "user" && message?.role !== "assistant") {
        const isSystemCard = message?.role === "system"
            && (!message?.cardTitle || String(message.cardTitle).toLowerCase() === "system");
        return buildMessageCardLines({
            title: message?.cardTitle || (message?.role === "system" ? "System" : "PilotSwarm"),
            timestamp: formatTimestamp(message?.createdAt || message?.time),
            body: decorateArtifactLinksForChat(message?.text || ""),
            width: Math.max(20, maxWidth),
            titleColor: message?.cardTitleColor || (message?.role === "system" ? "yellow" : "cyan"),
            borderColor: message?.cardBorderColor || "gray",
            ...(isSystemCard ? { bodyColor: "gray", fitToContent: true } : {}),
        });
    }

    const markdownLines = trimLeadingBlankLines(parseMarkdownLines(
        decorateArtifactLinksForChat(message?.text || ""),
        { width: maxWidth },
    ));
    const prefix = options.skipPrefix ? [] : buildChatMessagePrefix(message);

    if (markdownLines.length === 0) {
        return prefix.length > 0 ? [prefix] : [];
    }

    if (startsWithStructuredBlock(markdownLines)) {
        return prefix.length > 0 ? [prefix, ...markdownLines] : markdownLines;
    }

    return markdownLines.map((lineRuns, index) => {
        if (index === 0 && prefix.length > 0) {
            return [...prefix, ...lineRuns];
        }
        return lineRuns;
    });
}

export function selectChatLines(state, maxWidth = 80) {
    const messages = selectActiveChat(state);
    if (!messages || messages.length === 0) {
        return [{ text: "No messages yet.", color: "gray" }];
    }

    const lines = [];
    for (const [index, message] of messages.entries()) {
        const messageLines = buildChatMessageLines(message, maxWidth);
        appendChatBlockLines(lines, messageLines);
        const nextMessage = messages[index + 1];
        if (nextMessage && shouldInsertChatSpacer(message, nextMessage)) {
            lines.push([{ text: "", color: null }]);
        }
    }
    return lines.length > 0 ? lines : [{ text: "No messages yet.", color: "gray" }];
}

export function selectActiveArtifactLinks(state) {
    const messages = selectActiveChat(state);
    const links = [];
    const seen = new Set();

    for (const message of messages || []) {
        for (const link of extractArtifactLinks(message?.text || "")) {
            const key = `${link.sessionId}/${link.filename}`;
            if (seen.has(key)) continue;
            seen.add(key);
            links.push(link);
        }
    }

    return links;
}

export function selectChatPaneChrome(state) {
    const session = selectActiveSession(state);
    const totalDescendantCounts = getTotalDescendantCounts(state.sessions.byId);
    const visibleDescendantCounts = getVisibleDescendantCounts(state.sessions.flat, state.sessions.byId);
    const inspectorWindow = getRecentActivityWindow(state);

    if (!session) {
        return {
            color: "cyan",
            title: [{ text: "Chat", color: "cyan", bold: true }],
        };
    }

    const shortId = shortSessionId(session.sessionId);
    const mainColor = session.isSystem ? "yellow" : "cyan";
    const title = [{
        text: session.isSystem
            ? `≈ ${canonicalSystemTitle(session, state.branding?.title || "PilotSwarm")}`
            : (session.title || "Chat"),
        color: mainColor,
        bold: true,
    }];

    const activeEntry = state.sessions.flat.find((entry) => entry.sessionId === session.sessionId);
    const collapseBadge = getCollapseBadge(session.sessionId, activeEntry, totalDescendantCounts, visibleDescendantCounts);
    if (collapseBadge) {
        title.push({ text: ` ${collapseBadge.text}`, color: collapseBadge.color });
    }

    title.push({ text: ` [${shortId}]`, color: "gray" });

    const modelName = shortModelName(session.model);
    if (modelName) {
        title.push({ text: ` ${modelName}`, color: "cyan" });
    }

    const contextBadge = getContextHeaderBadge(session.contextUsage);
    if (contextBadge) {
        title.push({ text: ` ${contextBadge.text}`, color: "gray" });
    }

    const compactionBadge = getContextCompactionBadge(session.contextUsage);
    if (compactionBadge) {
        title.push({ text: ` ${compactionBadge.text}`, color: "gray" });
    }

    if (state.ui.inspectorTab === "sequence" || state.ui.inspectorTab === "nodes") {
        title.push({ text: ` [${inspectorWindow.label} window]`, color: "gray" });
    }

    return {
        color: session.isSystem ? "yellow" : "cyan",
        title,
    };
}

export function selectActiveActivity(state) {
    const sessionId = state.sessions.activeSessionId;
    if (!sessionId) return [];
    const history = state.history.bySessionId.get(sessionId);
    return history?.activity || [];
}

export function selectActivityPane(state, maxLines = 12) {
    const activity = selectActiveActivity(state);
    const session = selectActiveSession(state);
    const title = [{ text: "Activity", color: "gray", bold: true }];

    if (session?.statusVersion != null) {
        title.push({
            text: ` [current session v${session.statusVersion}]`,
            color: "gray",
        });
    }

    return {
        title,
        lines: activity.length > 0
            ? activity.map((item) => item.line || [{ text: item.text, color: "white" }])
            : [{ text: "No activity yet", color: "gray" }],
    };
}

function logLevelColor(level) {
    switch (String(level || "").toLowerCase()) {
        case "error": return "red";
        case "warn": return "yellow";
        case "debug": return "blue";
        case "trace": return "magenta";
        case "info":
        default:
            return "green";
    }
}

function logCategoryColor(category, level) {
    if (category === "orchestration") return "magenta";
    if (category === "activity") return "cyan";
    return logLevelColor(level);
}

function formatLogFormatLabel(format) {
    return format === "raw" ? "raw summary" : "pretty text";
}

function currentOrchestrationIdForSession(session) {
    if (!session?.sessionId) return null;
    return `session-${session.sessionId}`;
}

function filterLogEntries(state, session) {
    const entries = Array.isArray(state.logs?.entries) ? state.logs.entries : [];
    const filter = state.logs?.filter || {};
    const activeOrchestrationId = currentOrchestrationIdForSession(session);

    return entries.filter((entry) => {
        if (!entry) return false;
        if (filter.source === "currentOrchestration" && activeOrchestrationId) {
            if (entry.orchId !== activeOrchestrationId) return false;
        }
        if (filter.level && filter.level !== "all") {
            if (String(entry.level || "").toLowerCase() !== filter.level) return false;
        }
        return true;
    });
}

function buildRawLogLine(entry) {
    const podLabel = shortNodeLabel(entry?.podName) || entry?.podName || "node";
    const level = String(entry?.level || "info").toUpperCase();
    const categoryMarker = entry?.category === "orchestration"
        ? "◆"
        : entry?.category === "activity"
            ? "●"
            : "•";
    return [
        { text: `[${entry?.time || "--:--:--"}] `, color: "gray" },
        { text: `${categoryMarker} `, color: logCategoryColor(entry?.category, entry?.level) },
        { text: `${podLabel} `, color: "white", bold: true },
        { text: `${level} `, color: logLevelColor(entry?.level), bold: true },
        { text: entry?.rawLine || entry?.message || "", color: "white" },
    ];
}

function buildPrettyLogLine(entry) {
    return [{
        text: entry?.prettyMessage || entry?.message || entry?.rawLine || "",
        color: logCategoryColor(entry?.category, entry?.level),
        bold: String(entry?.level || "").toLowerCase() === "warn" || String(entry?.level || "").toLowerCase() === "error",
    }];
}

function selectLogPane(state, session) {
    const logs = state.logs || {};
    const filter = logs.filter || {};
    const summaryRuns = [
        { text: "Scope: ", color: "gray" },
        { text: filter.source === "currentOrchestration" ? "current orchestration" : "all nodes", color: "white" },
        { text: "  Level: ", color: "gray" },
        { text: filter.level || "all", color: "white" },
        { text: "  Format: ", color: "gray" },
        { text: formatLogFormatLabel(filter.format), color: "white" },
    ];

    if (!logs.available) {
        return [
            { text: logs.availabilityReason || "Log tailing disabled: no K8S_CONTEXT configured in the env file.", color: "yellow" },
            { text: "", color: "gray" },
            summaryRuns,
        ];
    }

    if (!logs.tailing) {
        return [
            { text: "Press t to start log tailing.", color: "cyan", bold: true },
            { text: "Press f to open log filters.", color: "gray" },
            { text: "", color: "gray" },
            summaryRuns,
        ];
    }

    const entries = filterLogEntries(state, session);
    if (entries.length === 0) {
        return [
            { text: "Tailing logs…", color: "cyan" },
            { text: "No logs match the current filter yet.", color: "gray" },
            { text: "", color: "gray" },
            summaryRuns,
        ];
    }

    return [
        summaryRuns,
        { text: "", color: "gray" },
        ...entries.map((entry) => filter.format === "raw" ? buildRawLogLine(entry) : buildPrettyLogLine(entry)),
    ];
}

function isMarkdownFilename(filename) {
    return /\.(md|markdown|mdown|mkd|mdx)$/i.test(String(filename || ""));
}

function isJsonFilename(filename) {
    return /\.(json|jsonl)$/i.test(String(filename || ""));
}

function buildFileTabRuns(activeTab) {
    return INSPECTOR_TABS.map((tab) => ({
        text: tab === activeTab ? `[${tab}] ` : `${tab} `,
        color: tab === activeTab ? "magenta" : "gray",
        bold: tab === activeTab,
    }));
}

function buildPlainFilePreviewLines(content = "") {
    const lines = String(content || "").split("\n");
    return lines.length > 0
        ? lines.map((line) => ({ text: line, color: "white" }))
        : [{ text: "", color: "white" }];
}

function buildFileListEntry(filename, { selected = false, width = 24, label = null } = {}) {
    const safeWidth = Math.max(8, width);
    const prefix = isMarkdownFilename(filename)
        ? "# "
        : isJsonFilename(filename)
            ? "{ "
            : "• ";
    const text = fitDisplayText(`${prefix}${label || filename}`, safeWidth).padEnd(safeWidth, " ");
    if (selected) {
        return buildActiveHighlightLine(text);
    }
    return {
        text,
        color: isMarkdownFilename(filename) ? "cyan" : "white",
        bold: false,
    };
}

export function selectFilesScope(state) {
    return state.files?.filter?.scope === "allSessions" ? "allSessions" : "selectedSession";
}

export function selectFileBrowserItems(state) {
    const scope = selectFilesScope(state);
    const activeSession = selectActiveSession(state);
    const activeSessionId = activeSession?.sessionId || null;
    if (scope !== "allSessions") {
        const entries = Array.isArray(state.files?.bySessionId?.[activeSessionId]?.entries)
            ? state.files.bySessionId[activeSessionId].entries
            : [];
        return entries.map((filename) => ({
            id: `${activeSessionId || "none"}/${filename}`,
            sessionId: activeSessionId,
            filename,
            label: filename,
        }));
    }

    const orderedSessionIds = [
        ...new Set([
            ...(Array.isArray(state.sessions?.flat) ? state.sessions.flat : []),
            ...Object.keys(state.files?.bySessionId || {}),
        ]),
    ].filter(Boolean);

    const items = [];
    for (const sessionId of orderedSessionIds) {
        const entries = Array.isArray(state.files?.bySessionId?.[sessionId]?.entries)
            ? state.files.bySessionId[sessionId].entries
            : [];
        for (const filename of entries) {
            items.push({
                id: `${sessionId}/${filename}`,
                sessionId,
                filename,
                label: `[${shortSessionId(sessionId)}] ${filename}`,
            });
        }
    }
    return items;
}

export function selectSelectedFileBrowserItem(state) {
    const items = selectFileBrowserItems(state);
    if (items.length === 0) return null;

    const scope = selectFilesScope(state);
    if (scope === "allSessions") {
        const preferredId = state.files?.selectedArtifactId || null;
        if (preferredId) {
            const selected = items.find((item) => item.id === preferredId);
            if (selected) return selected;
        }
        const activeSessionId = selectActiveSession(state)?.sessionId || null;
        const activeFilename = activeSessionId
            ? state.files?.bySessionId?.[activeSessionId]?.selectedFilename || null
            : null;
        if (activeSessionId && activeFilename) {
            const activeSelected = items.find((item) => item.sessionId === activeSessionId && item.filename === activeFilename);
            if (activeSelected) return activeSelected;
        }
        return items[0];
    }

    const activeSessionId = selectActiveSession(state)?.sessionId || null;
    const selectedFilename = activeSessionId
        ? state.files?.bySessionId?.[activeSessionId]?.selectedFilename || null
        : null;
    return items.find((item) => item.filename === selectedFilename) || items[0];
}

export function selectFilesView(state, options = {}) {
    const session = selectActiveSession(state);
    const listWidth = Math.max(12, Number(options?.listWidth) || Number(options?.width) || 24);
    const previewWidth = Math.max(18, Number(options?.previewWidth) || Number(options?.width) || 36);
    const sessionId = session?.sessionId || null;
    const scope = selectFilesScope(state);
    const fileItems = selectFileBrowserItems(state);
    const selectedItem = selectSelectedFileBrowserItem(state);
    const selectedFilename = selectedItem?.filename || null;
    const selectedIndex = Math.max(0, fileItems.findIndex((item) => item.id === selectedItem?.id));
    const previewState = selectedItem?.sessionId && selectedFilename
        ? state.files?.bySessionId?.[selectedItem.sessionId]?.previews?.[selectedFilename] || null
        : null;
    const shortId = session ? shortSessionId(session.sessionId) : "";
    const allSessionIds = [...new Set([
        ...(Array.isArray(state.sessions?.flat) ? state.sessions.flat : []),
        ...Object.keys(state.files?.bySessionId || {}),
    ])].filter(Boolean);
    const allSessionsLoading = scope === "allSessions" && allSessionIds.some((id) => !state.files?.bySessionId?.[id]?.loaded || state.files?.bySessionId?.[id]?.loading);
    const allSessionsError = scope === "allSessions"
        ? allSessionIds.map((id) => state.files?.bySessionId?.[id]?.error).find(Boolean) || null
        : null;

    const listLines = [
        buildFileTabRuns("files"),
        ...((session || scope === "allSessions")
            ? []
            : [{ text: "No session selected.", color: "gray" }]),
    ];

    if (scope === "allSessions") {
        if (allSessionsLoading && fileItems.length === 0) {
            listLines.push({ text: "Loading exported files across all sessions…", color: "gray" });
        } else if (allSessionsError && fileItems.length === 0) {
            listLines.push({ text: allSessionsError, color: "red" });
        } else if (fileItems.length === 0) {
            listLines.push({ text: "No exported files across any session yet.", color: "gray" });
            listLines.push({ text: "Switch the filter back to the selected session or wait for agents to export artifacts.", color: "gray" });
        } else {
            listLines.push(...fileItems.map((item, index) => buildFileListEntry(item.filename, {
                selected: index === selectedIndex,
                width: listWidth,
                label: item.label,
            })));
        }
    } else if (session) {
        const fileState = sessionId ? state.files?.bySessionId?.[sessionId] : null;
        const entries = Array.isArray(fileState?.entries) ? fileState.entries : [];
        if (fileState?.loading) {
            listLines.push({ text: "Loading exported files…", color: "gray" });
        } else if (fileState?.error) {
            listLines.push({ text: fileState.error, color: "red" });
        } else if (entries.length === 0) {
            listLines.push({ text: "No exported files for this session yet.", color: "gray" });
            listLines.push({ text: "Agents must write/export artifacts before they appear here.", color: "gray" });
        } else {
            listLines.push(...entries.map((filename, index) => buildFileListEntry(filename, {
                selected: index === selectedIndex,
                width: listWidth,
            })));
        }
    }

    let previewLines;
    let previewTitle;
    if (!session && scope !== "allSessions") {
        previewTitle = [{ text: "Preview", color: "cyan", bold: true }];
        previewLines = [{ text: "No session selected.", color: "gray" }];
    } else if (!selectedFilename) {
        previewTitle = [{ text: "Preview", color: "cyan", bold: true }];
        previewLines = [{ text: "Select a file to preview it here.", color: "gray" }];
    } else if (previewState?.loading) {
        previewTitle = [
            { text: `Preview: ${selectedFilename}`, color: "cyan", bold: true },
            ...(scope === "allSessions" && selectedItem?.sessionId
                ? [{ text: ` · ${shortSessionId(selectedItem.sessionId)}`, color: "gray" }]
                : []),
        ];
        previewLines = [{ text: "Loading file preview…", color: "gray" }];
    } else if (previewState?.error) {
        previewTitle = [
            { text: `Preview: ${selectedFilename}`, color: "cyan", bold: true },
            ...(scope === "allSessions" && selectedItem?.sessionId
                ? [{ text: ` · ${shortSessionId(selectedItem.sessionId)}`, color: "gray" }]
                : []),
        ];
        previewLines = [{ text: previewState.error, color: "red" }];
    } else {
        previewTitle = [
            { text: `Preview: ${selectedFilename}`, color: "cyan", bold: true },
            ...(scope === "allSessions" && selectedItem?.sessionId
                ? [{ text: ` · ${shortSessionId(selectedItem.sessionId)}`, color: "gray" }]
                : []),
            ...(previewState?.renderMode === "markdown"
                ? [{ text: " [md]", color: "gray" }]
                : previewState?.renderMode === "note"
                    ? [{ text: " [note]", color: "gray" }]
                    : []),
        ];
        previewLines = previewState?.renderMode === "markdown"
            ? trimLeadingBlankLines(parseMarkdownLines(previewState?.content || "", { width: previewWidth }))
            : buildPlainFilePreviewLines(previewState?.content || "");
    }

    const fileCountLabel = scope === "allSessions"
        ? `Files: all sessions${fileItems.length > 0 ? ` [${fileItems.length}]` : ""}`
        : session
            ? `Files: ${shortId}${fileItems.length > 0 ? ` [${fileItems.length}]` : ""}`
            : "Files";

    return {
        listTitle: [{ text: fileCountLabel, color: "magenta", bold: true }],
        listLines,
        listBodyLines: listLines.slice(1),
        selectedIndex,
        selectedFilename,
        selectedSessionId: selectedItem?.sessionId || null,
        scope,
        previewTitle,
        previewLines,
        previewScrollOffset: state.ui.scroll.filePreview || 0,
        fullscreen: Boolean(state.files?.fullscreen),
        fullscreenTitle: [
            { text: fileCountLabel, color: "magenta", bold: true },
            ...(selectedFilename
                ? [
                    { text: " · ", color: "gray" },
                    { text: selectedFilename, color: "cyan", bold: true },
                ]
                : []),
            { text: "  [f filter] [o open] [v/esc close fullscreen]", color: "gray" },
        ],
    };
}

export function selectStatusBar(state) {
    const focus = state.ui.focusRegion;
    const hasPendingQuestion = Boolean(selectActiveSession(state)?.pendingQuestion?.question);
    if (state.ui.modal?.type === "artifactUpload") {
        return {
            left: "Attach a local file to the current prompt",
            right: "type path · left/right move · enter attach · esc cancel",
        };
    }
    if (state.ui.modal?.type === "renameSession") {
        return {
            left: "Rename the selected session title",
            right: "type title · left/right move · enter save · esc cancel",
        };
    }
    if (state.ui.modal?.type === "artifactPicker") {
        return {
            left: "Select a linked artifact to download",
            right: "up/down move · enter download · a/esc close",
        };
    }
    if (state.ui.modal?.type === "modelPicker") {
        return {
            left: "Select a model for the new session",
            right: "up/down move · enter create · esc cancel",
        };
    }
    if (state.ui.modal?.type === "sessionAgentPicker") {
        return {
            left: "Select an agent for the new session",
            right: "up/down move · enter create · esc cancel",
        };
    }
    if (state.ui.modal?.type === "logFilter") {
        return {
            left: "Adjust log filters",
            right: "tab/shift-tab filter · up/down change · enter close · esc close",
        };
    }
    if (state.ui.modal?.type === "filesFilter") {
        return {
            left: "Adjust files browser filters",
            right: "tab/shift-tab filter · up/down change · enter close · esc close",
        };
    }
    const hints = {
        [FOCUS_REGIONS.SESSIONS]: "up/down switch · ctrl-u/ctrl-d page · d done · D delete · r refresh · t title · a linked artifacts · drag copy · tab next pane · p prompt",
        [FOCUS_REGIONS.CHAT]: "j/k scroll · ctrl-u/ctrl-d page · e older history · g/G top/bottom · d done · a linked artifacts · drag copy · tab next pane · p prompt",
        [FOCUS_REGIONS.INSPECTOR]: state.ui.inspectorTab === "logs"
            ? "j/k scroll · ctrl-u/ctrl-d page · g/G top/bottom · d done · t tail · f filter · a linked artifacts · drag copy · left/right tab · tab next pane"
            : state.ui.inspectorTab === "files"
                ? state.files?.fullscreen
                    ? "j/k scroll · ctrl-u/ctrl-d page · g/G top/bottom · f filter · o open · d done · v close fullscreen · a linked artifacts · drag copy · left/right tab · tab next pane"
                    : "j/k files · ctrl-u/ctrl-d page preview · g/G preview top/bottom · f filter · o open · d done · v fullscreen · a linked artifacts · drag copy · left/right tab · tab next pane"
                : "j/k scroll · ctrl-u/ctrl-d page · g/G top/bottom · d done · h/l focus · left/right tab · a linked artifacts · drag copy · m next tab · tab next pane",
        [FOCUS_REGIONS.ACTIVITY]: "j/k scroll · ctrl-u/ctrl-d page · g/G top/bottom · d done · a linked artifacts · drag copy · h left · tab next pane",
        [FOCUS_REGIONS.PROMPT]: hasPendingQuestion
            ? "type answer · enter reply · alt-enter newline · ctrl-a attach file · arrows move · alt-left/right word · alt-delete word · esc sessions"
            : "type message · enter send · alt-enter newline · ctrl-a attach file · arrows move · alt-left/right word · alt-delete word · esc sessions",
    };

    return {
        left: state.ui.statusText,
        right: hints[focus] || hints[FOCUS_REGIONS.SESSIONS],
    };
}

function flattenRunsLength(runs) {
    return (runs || []).reduce((sum, run) => sum + String(run?.text || "").length, 0);
}

function fitRuns(runs, maxWidth) {
    if (maxWidth <= 0) return [];
    const output = [];
    let remaining = maxWidth;

    for (const run of runs || []) {
        if (remaining <= 0) break;
        const text = String(run?.text || "");
        if (!text) continue;
        const chunk = text.length > remaining && remaining > 1
            ? `${text.slice(0, remaining - 1)}…`
            : text.slice(0, remaining);
        if (!chunk) continue;
        output.push({ ...run, text: chunk });
        remaining -= chunk.length;
    }

    return output;
}

function displayLength(value) {
    return Array.from(String(value || "")).length;
}

function fitDisplayText(value, maxWidth) {
    const text = String(value || "");
    if (maxWidth <= 0) return "";
    if (displayLength(text) <= maxWidth) return text;
    if (maxWidth === 1) return Array.from(text)[0] || "";
    return `${Array.from(text).slice(0, maxWidth - 1).join("")}…`;
}

function padDisplayText(value, width) {
    const text = fitDisplayText(value, width);
    const padding = Math.max(0, width - displayLength(text));
    return text + " ".repeat(padding);
}

function plainInspectorLine(text, color = "white", extra = {}) {
    return {
        text: String(text || ""),
        color,
        ...extra,
    };
}

function formatCompactBytes(value) {
    const bytes = Number(value);
    if (!Number.isFinite(bytes) || bytes < 0) return "?";
    if (bytes < 1024) return `${Math.round(bytes)} B`;
    if (bytes < 1024 * 1024) {
        const kb = bytes / 1024;
        return `${kb >= 10 ? Math.round(kb) : kb.toFixed(1)} KB`;
    }
    const mb = bytes / (1024 * 1024);
    return `${mb >= 10 ? Math.round(mb) : mb.toFixed(1)} MB`;
}

function summarizeEventPreview(text, maxLength = 18) {
    const normalized = String(text || "")
        .replace(/\s+/g, " ")
        .trim();
    if (!normalized) return "";
    return displayLength(normalized) > maxLength
        ? `${Array.from(normalized).slice(0, Math.max(1, maxLength - 1)).join("")}…`
        : normalized;
}

function eventMessageText(event) {
    const data = event?.data;
    if (typeof data === "string") return data;
    if (data && typeof data === "object") {
        if (typeof data.content === "string") return data.content;
        if (typeof data.text === "string") return data.text;
        if (typeof data.message === "string") return data.message;
        if (typeof data.question === "string") return data.question;
    }
    return "";
}

function shortNodeLabel(nodeId) {
    const raw = String(nodeId || "").trim();
    if (!raw || raw === "(unknown)") return null;
    const tail = raw.split(/[/:]/).pop() || raw;
    const short = tail.length <= 5 ? tail : tail.slice(-5);
    return short.replace(/^[^a-zA-Z0-9]+/, "") || short;
}

const RECENT_ACTIVITY_WINDOW_MS = 5 * 60 * 1000;

function getRecentActivityWindow(state) {
    let endMs = 0;

    for (const history of state.history.bySessionId.values()) {
        for (const event of history?.events || []) {
            const createdAtMs = event?.createdAt instanceof Date
                ? event.createdAt.getTime()
                : new Date(event?.createdAt || 0).getTime();
            if (Number.isFinite(createdAtMs)) {
                endMs = Math.max(endMs, createdAtMs);
            }
        }
    }

    if (!Number.isFinite(endMs) || endMs <= 0) {
        endMs = Date.now();
    }

    return {
        startMs: endMs - RECENT_ACTIVITY_WINDOW_MS,
        endMs,
        label: "last 5m",
    };
}

function entryFallsWithinWindow(entry, window) {
    if (!entry || !window) return false;
    const createdAtMs = Number(entry.createdAtMs || 0);
    if (!Number.isFinite(createdAtMs)) return false;
    return createdAtMs >= window.startMs && createdAtMs <= window.endMs;
}

function eventFallsWithinWindow(event, window) {
    if (!event || !window) return false;
    const createdAtMs = event?.createdAt instanceof Date
        ? event.createdAt.getTime()
        : new Date(event?.createdAt || 0).getTime();
    if (!Number.isFinite(createdAtMs)) return false;
    return createdAtMs >= window.startMs && createdAtMs <= window.endMs;
}

const SEQUENCE_ORCHESTRATOR_TYPES = new Set([
    "wait",
    "timer",
    "cron_start",
    "cron_fire",
    "cron_cancel",
    "spawn",
    "cmd_recv",
    "cmd_done",
]);

function isSequenceOrchestratorType(type) {
    return SEQUENCE_ORCHESTRATOR_TYPES.has(type);
}

function mapEventToSequenceEntry(event) {
    const time = formatTimestamp(event?.createdAt);
    const nodeLabel = shortNodeLabel(event?.workerNodeId);
    const detailText = eventMessageText(event);
    const preview = summarizeEventPreview(detailText, 20);
    const createdAtMs = event?.createdAt instanceof Date
        ? event.createdAt.getTime()
        : new Date(event?.createdAt || 0).getTime();
    const base = {
        time,
        createdAtMs: Number.isFinite(createdAtMs) ? createdAtMs : 0,
        nodeLabel,
        color: "white",
        detail: "",
        type: "other",
    };

    switch (event?.eventType) {
        case "session.turn_started":
            return { ...base, type: "turn_start", color: "gray", detail: `turn ${event?.data?.iteration ?? "?"}` };
        case "session.turn_completed":
            return { ...base, type: "turn_end", color: "gray", detail: `turn ${event?.data?.iteration ?? "?"} done` };
        case "user.message":
            return { ...base, type: "user_msg", color: "white", detail: preview ? `>> ${preview}` : ">> user" };
        case "assistant.message":
            return { ...base, type: "response", color: "green", detail: preview ? `< ${preview}` : "< response" };
        case "system.message":
            return { ...base, type: "system", color: "yellow", detail: preview || "system" };
        case "session.wait_started":
            return {
                ...base,
                type: "wait",
                color: "yellow",
                detail: `wait ${formatHumanDurationSeconds(event?.data?.seconds ?? 0)}`,
            };
        case "session.wait_completed":
            return {
                ...base,
                type: "timer",
                color: "yellow",
                detail: `${formatHumanDurationSeconds(event?.data?.seconds ?? 0)} up`,
            };
        case "session.dehydrated":
            return { ...base, type: "dehydrate", color: "red", detail: `ZZ ${event?.data?.reason || ""}`.trim() };
        case "session.rehydrated":
        case "session.hydrated":
            return { ...base, type: "hydrate", color: "green", detail: "rehydrated" };
        case "session.agent_spawned":
            return {
                ...base,
                type: "spawn",
                color: "cyan",
                detail: `spawn ${event?.data?.agentId || shortSessionId(event?.data?.childSessionId) || "agent"}`,
            };
        case "session.cron_started":
            return {
                ...base,
                type: "cron_start",
                color: "magenta",
                detail: `cron ${formatHumanDurationSeconds(event?.data?.intervalSeconds ?? 0)}`,
            };
        case "session.cron_fired":
            return { ...base, type: "cron_fire", color: "magenta", detail: "cron fired" };
        case "session.cron_cancelled":
            return { ...base, type: "cron_cancel", color: "magenta", detail: "cron off" };
        case "session.command_received":
            return {
                ...base,
                type: "cmd_recv",
                color: "magenta",
                detail: `/${event?.data?.cmd || "?"}`,
            };
        case "session.command_completed":
            return {
                ...base,
                type: "cmd_done",
                color: "magenta",
                detail: `/${event?.data?.cmd || "?"} ok`,
            };
        case "session.compaction_start":
            return { ...base, type: "compaction", color: "gray", detail: "compaction…" };
        case "session.compaction_complete":
            return { ...base, type: "compaction", color: "gray", detail: "compacted" };
        case "session.error":
            return { ...base, type: "error", color: "red", detail: preview || "error" };
        default:
            return null;
    }
}

function buildSequenceEntries(events = []) {
    const entries = [];

    for (const event of events || []) {
        const entry = mapEventToSequenceEntry(event);
        if (!entry) continue;

        entries.push({
            ...entry,
            nodeLabel: isSequenceOrchestratorType(entry.type)
                ? "orch"
                : (entry.nodeLabel || "orch"),
        });
    }

    return entries;
}

function collapseContiguousSpawnEntries(entries = []) {
    const collapsed = [];

    for (let index = 0; index < entries.length; index += 1) {
        const entry = entries[index];
        if (entry?.type !== "spawn" || entry?.nodeLabel !== "orch") {
            collapsed.push(entry);
            continue;
        }

        let runLength = 1;
        while (index + runLength < entries.length) {
            const nextEntry = entries[index + runLength];
            if (nextEntry?.type !== "spawn" || nextEntry?.nodeLabel !== "orch") break;
            if (nextEntry?.time !== entry.time) break;
            runLength += 1;
        }

        if (runLength === 1) {
            collapsed.push(entry);
            continue;
        }

        collapsed.push({
            ...entry,
            detail: `spawn x${runLength}`,
        });
        index += runLength - 1;
    }

    return collapsed;
}

function buildSessionStatusSequenceEntry(session) {
    const errorText = String(session?.error || "").trim();
    if (!errorText) return null;

    const errorKind = getSessionErrorVisualKind(session);
    if (!errorKind) return null;

    const createdAtMs = session?.updatedAt ? Number(session.updatedAt) : Date.now();
    const safeCreatedAtMs = Number.isFinite(createdAtMs) ? createdAtMs : Date.now();

    return {
        time: formatTimestamp(safeCreatedAtMs),
        createdAtMs: safeCreatedAtMs,
        nodeLabel: "orch",
        color: errorKind === "failed" ? "red" : "yellow",
        detail: `${errorKind === "failed" ? "ERR" : "WARN"} ${summarizeEventPreview(errorText, 20) || (errorKind === "failed" ? "error" : "warning")}`,
        type: errorKind === "failed" ? "error" : "warning",
    };
}

function appendCurrentSessionStatusEntry(entries, session) {
    const statusEntry = buildSessionStatusSequenceEntry(session);
    if (!statusEntry) return entries;

    const hasEquivalentEntry = (entries || []).some((entry) => {
        if (!entry || entry.nodeLabel !== "orch") return false;
        if (entry.detail !== statusEntry.detail) return false;
        return Math.abs(Number(entry.createdAtMs || 0) - statusEntry.createdAtMs) <= 60_000;
    });
    if (hasEquivalentEntry) return entries;

    return [...(entries || []), statusEntry];
}

function buildSequenceNodeUnionForWindow(state, startMs, endMs) {
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) {
        return [];
    }

    const labels = new Set();

    for (const history of state.history.bySessionId.values()) {
        const entries = buildSequenceEntries(history?.events || []);
        for (const entry of entries) {
            if (!entry?.nodeLabel || entry.nodeLabel === "orch") continue;
            const createdAtMs = Number(entry.createdAtMs || 0);
            if (!Number.isFinite(createdAtMs)) continue;
            if (createdAtMs < startMs || createdAtMs > endMs) continue;
            labels.add(entry.nodeLabel);
        }
    }

    return Array.from(labels).sort((left, right) => left.localeCompare(right));
}

function buildNodeMapNodeUnionForWindow(state, window) {
    const labels = new Set();

    for (const history of state.history.bySessionId.values()) {
        for (const event of history?.events || []) {
            if (!eventFallsWithinWindow(event, window)) continue;
            const nodeLabel = shortNodeLabel(event?.workerNodeId);
            if (!nodeLabel) continue;
            labels.add(nodeLabel);
        }
    }

    return Array.from(labels).sort((left, right) => left.localeCompare(right));
}

function buildSequenceHeaderLine(nodeLabels, timeWidth, colWidth) {
    const runs = [
        { text: padDisplayText("TIME", timeWidth), color: "white", bold: true },
        { text: " ", color: null },
    ];
    nodeLabels.forEach((nodeLabel, index) => {
        if (index > 0) runs.push({ text: " ", color: null });
        runs.push({ text: padDisplayText(nodeLabel, colWidth), color: "white", bold: true });
    });
    return runs;
}

function buildSequenceDividerLine(nodeLabels, timeWidth, colWidth) {
    return plainInspectorLine(
        `${"-".repeat(timeWidth)} ${nodeLabels.map(() => "─".repeat(colWidth)).join(" ")}`,
        "gray",
    );
}

function buildSequenceStatsLines(state, session, maxWidth) {
    const statsEntry = state?.orchestration?.bySessionId?.[session?.sessionId] || null;
    let body = "loading orchestration stats...";
    if (!statsEntry) {
    } else if (statsEntry.loading && !statsEntry.stats) {
        body = "loading orchestration stats...";
    } else if (!statsEntry.stats) {
        body = statsEntry.error ? "orchestration stats unavailable" : "loading orchestration stats...";
    } else {
        const stats = statsEntry.stats;
        body = [
            `hist ${Number(stats.historyEventCount) || 0} ev`,
            formatCompactBytes(stats.historySizeBytes),
            `q ${Number(stats.queuePendingCount) || 0}`,
            `kv ${Number(stats.kvUserKeyCount) || 0} keys`,
            formatCompactBytes(stats.kvTotalValueBytes),
        ].join(" | ");
    }

    return buildMessageCardLines({
        title: "Stats",
        body,
        width: Math.max(24, maxWidth),
        titleColor: "cyan",
        borderColor: "gray",
        fitToContent: true,
    }).slice(0, -1);
}

function buildSequenceEventLine(entry, nodeLabels, timeWidth, colWidth) {
    const targetNode = nodeLabels.includes(entry.nodeLabel)
        ? entry.nodeLabel
        : (nodeLabels.includes("…") ? "…" : nodeLabels[nodeLabels.length - 1]);
    const runs = [
        { text: padDisplayText(entry.time || "", timeWidth), color: "white" },
        { text: " ", color: null },
    ];

    nodeLabels.forEach((nodeLabel, index) => {
        if (index > 0) runs.push({ text: " ", color: null });
        if (nodeLabel === targetNode) {
            runs.push({
                text: padDisplayText(entry.detail || "", colWidth),
                color: entry.color || "white",
                bold: Boolean(entry.bold),
                underline: Boolean(entry.underline),
            });
        } else {
            runs.push({
                text: padDisplayText("│", colWidth),
                color: "gray",
            });
        }
    });

    return runs;
}

function buildNodeMapHeaderLine(nodeLabels, colWidth) {
    const runs = [];
    nodeLabels.forEach((nodeLabel, index) => {
        if (index > 0) runs.push({ text: " ", color: null });
        runs.push({ text: padDisplayText(nodeLabel, colWidth), color: "white", bold: true });
    });
    return runs;
}

function buildSequenceViewForSession(state, session, maxWidth) {
    const statsLines = buildSequenceStatsLines(state, session, maxWidth);
    const history = state.history.bySessionId.get(session.sessionId);
    const entries = appendCurrentSessionStatusEntry(
        collapseContiguousSpawnEntries(buildSequenceEntries(history?.events || [])),
        session,
    );
    if (entries.length === 0) {
        return {
            stickyLines: statsLines,
            lines: [plainInspectorLine("No events yet - interact with this session to populate the sequence diagram.")],
        };
    }

    const recentWindow = getRecentActivityWindow(state);
    const windowedEntries = entries.filter((entry) => entryFallsWithinWindow(entry, recentWindow));
    const visibleEntries = (windowedEntries.length > 0 ? windowedEntries : entries).slice(-48);
    const unionNodes = buildSequenceNodeUnionForWindow(state, recentWindow.startMs, recentWindow.endMs);
    const activeSessionNodes = Array.from(new Set(visibleEntries
        .map((entry) => entry.nodeLabel)
        .filter((nodeLabel) => nodeLabel && nodeLabel !== "orch"))).sort((left, right) => left.localeCompare(right));
    const uniqueNodes = unionNodes.length > 0 ? unionNodes : activeSessionNodes;
    const timeWidth = 8;
    const availableWidth = Math.max(18, maxWidth);
    const maxNodes = Math.max(1, Math.floor((availableWidth - timeWidth - 1) / 6));
    let nodeLabels = ["orch", ...uniqueNodes];
    if (nodeLabels.length > maxNodes) {
        const visibleCount = Math.max(1, maxNodes - 1);
        nodeLabels = [
            ...nodeLabels.slice(0, visibleCount),
            "…",
        ];
    }

    const gapWidth = Math.max(0, nodeLabels.length - 1);
    const colWidth = Math.max(
        4,
        Math.floor((availableWidth - timeWidth - 1 - gapWidth) / Math.max(1, nodeLabels.length)),
    );

    return {
        stickyLines: [
            ...statsLines,
            plainInspectorLine(`Window: ${recentWindow.label}`, "gray"),
            buildSequenceHeaderLine(nodeLabels, timeWidth, colWidth),
            buildSequenceDividerLine(nodeLabels, timeWidth, colWidth),
        ],
        lines: visibleEntries.map((entry) => buildSequenceEventLine(entry, nodeLabels, timeWidth, colWidth)),
    };
}

function buildOrderedSessionIds(state) {
    const orderedIds = [];
    const seen = new Set();

    for (const entry of state.sessions.flat || []) {
        if (!entry?.sessionId || seen.has(entry.sessionId)) continue;
        seen.add(entry.sessionId);
        orderedIds.push(entry.sessionId);
    }

    for (const sessionId of Object.keys(state.sessions.byId || {})) {
        if (seen.has(sessionId)) continue;
        seen.add(sessionId);
        orderedIds.push(sessionId);
    }

    return orderedIds;
}

function getLastKnownSessionNode(history, window = null) {
    const events = history?.events || [];
    for (let index = events.length - 1; index >= 0; index -= 1) {
        if (window && !eventFallsWithinWindow(events[index], window)) continue;
        const nodeLabel = shortNodeLabel(events[index]?.workerNodeId);
        if (nodeLabel) return nodeLabel;
    }
    return null;
}

function buildNodeMapCell(session, brandingTitle, width, active) {
    const label = width >= 16
        ? (session?.isSystem
            ? canonicalSystemTitle(session, brandingTitle)
            : (session?.title || shortSessionId(session?.sessionId)))
        : shortSessionId(session?.sessionId);
    const prefix = session?.isSystem ? "≈ " : `${sessionStatusIcon(session) || "."} `;
    const text = padDisplayText(`${prefix}${label}`, width);

    if (active) {
        return buildActiveHighlightLine(text);
    }

    return {
        text,
        color: session?.isSystem ? "yellow" : sessionStatusColor(session),
        bold: Boolean(session?.isSystem),
    };
}

function buildNodeMapLines(state, maxWidth) {
    const orderedSessionIds = buildOrderedSessionIds(state);
    if (orderedSessionIds.length === 0) {
        return [plainInspectorLine("No sessions available for the node map.", "gray")];
    }

    const recentWindow = getRecentActivityWindow(state);
    const nodeSessionMap = new Map();
    const knownNodes = buildNodeMapNodeUnionForWindow(state, recentWindow);
    let missingHistoryCount = 0;
    let inWindowSessionCount = 0;

    for (const sessionId of orderedSessionIds) {
        const session = state.sessions.byId[sessionId];
        if (!session) continue;
        const history = state.history.bySessionId.get(sessionId);
        if (!history?.events) missingHistoryCount += 1;
        const nodeLabel = getLastKnownSessionNode(history, recentWindow);
        if (!nodeLabel || !knownNodes.includes(nodeLabel)) continue;
        inWindowSessionCount += 1;
        if (!nodeSessionMap.has(nodeLabel)) {
            nodeSessionMap.set(nodeLabel, []);
        }
        nodeSessionMap.get(nodeLabel).push(session);
    }

    if (knownNodes.length === 0) {
        return [plainInspectorLine(`No worker activity in the ${recentWindow.label} window.`, "gray")];
    }

    const availableWidth = Math.max(18, maxWidth);
    const maxColumns = Math.max(1, Math.floor((availableWidth + 1) / 10));
    let nodeLabels = knownNodes;
    if (knownNodes.length > maxColumns) {
        const visibleCount = Math.max(0, maxColumns - 1);
        const overflowSessions = [];
        const visibleLabels = knownNodes.slice(0, visibleCount);
        for (const hiddenLabel of knownNodes.slice(visibleCount)) {
            overflowSessions.push(...(nodeSessionMap.get(hiddenLabel) || []));
        }
        nodeSessionMap.set("…", overflowSessions);
        nodeLabels = [...visibleLabels, "…"];
    }

    const gapWidth = Math.max(0, nodeLabels.length - 1);
    const colWidth = Math.max(8, Math.floor((availableWidth - gapWidth) / Math.max(1, nodeLabels.length)));
    const maxRows = nodeLabels.reduce(
        (max, nodeLabel) => Math.max(max, (nodeSessionMap.get(nodeLabel) || []).length),
        0,
    );

    const lines = [
        plainInspectorLine(`Window: ${recentWindow.label}`, "gray"),
        buildNodeMapHeaderLine(nodeLabels, colWidth),
        plainInspectorLine(nodeLabels.map(() => "─".repeat(colWidth)).join(" "), "gray"),
    ];

    for (let rowIndex = 0; rowIndex < maxRows; rowIndex += 1) {
        const rowRuns = [];
        nodeLabels.forEach((nodeLabel, columnIndex) => {
            if (columnIndex > 0) rowRuns.push({ text: " ", color: null });
            const session = (nodeSessionMap.get(nodeLabel) || [])[rowIndex];
            if (!session) {
                rowRuns.push({ text: " ".repeat(colWidth), color: null });
                return;
            }
            rowRuns.push(buildNodeMapCell(
                session,
                state.branding?.title || "PilotSwarm",
                colWidth,
                session.sessionId === state.sessions.activeSessionId,
            ));
        });
        lines.push(rowRuns);
    }

    if (missingHistoryCount > 0) {
        lines.push(plainInspectorLine("", "gray"));
        lines.push(plainInspectorLine(`Loading worker history for ${missingHistoryCount} session(s)…`, "gray"));
    }
    if (inWindowSessionCount === 0) {
        lines.push(plainInspectorLine("", "gray"));
        lines.push(plainInspectorLine(`No sessions mapped onto worker nodes in the ${recentWindow.label} window.`, "gray"));
    }

    return lines;
}

export function selectModelPickerModal(state, maxWidth = 72) {
    const modal = state.ui.modal;
    if (!modal || modal.type !== "modelPicker") return null;

    const groups = Array.isArray(modal.groups) ? modal.groups : [];
    const selectedIndex = Math.max(0, Number(modal.selectedIndex) || 0);
    const contentWidth = Math.max(24, maxWidth - 4);
    const rows = [];
    let selectedRowIndex = 0;

    for (const group of groups) {
        const headerRuns = fitRuns([
            { text: `${group.providerId}`, color: "cyan", bold: true },
            { text: ` (${group.providerType || "provider"})`, color: "gray" },
        ], contentWidth);
        rows.push(headerRuns);

        for (const model of group.models || []) {
            const itemIndex = Array.isArray(modal.items)
                ? modal.items.findIndex((item) => item.id === model.id)
                : -1;
            const isSelected = itemIndex === selectedIndex;
            const labelRuns = fitRuns([
                { text: "   · ", color: "gray" },
                { text: model.modelName || model.qualifiedName || model.id, color: "white", bold: Boolean(model.isDefault) },
                ...(model.cost ? [{ text: ` [${model.cost}]`, color: "gray" }] : []),
                ...(model.isDefault ? [{ text: " ← current default", color: "gray" }] : []),
            ], contentWidth);

            const line = isSelected
                ? buildActiveHighlightLine(labelRuns.map((run) => run.text).join("").padEnd(contentWidth, " "))
                : labelRuns;

            if (isSelected) selectedRowIndex = rows.length;
            rows.push(line);
        }
    }

    const selectedItem = Array.isArray(modal.items) ? modal.items[selectedIndex] || null : null;
    const detailsLines = selectedItem
        ? [
            [{
                text: selectedItem.modelName || selectedItem.qualifiedName || selectedItem.id,
                color: "white",
                bold: true,
            }],
            [{
                text: `${selectedItem.providerId} (${selectedItem.providerType || "provider"})`,
                color: "gray",
            }],
            ...(selectedItem.cost ? [[{ text: `Cost: ${selectedItem.cost}`, color: "gray" }]] : []),
            [{ text: "", color: "gray" }],
            [{
                text: selectedItem.description || "No description available for this model.",
                color: selectedItem.description ? "white" : "gray",
            }],
        ]
        : [[{ text: "No model selected.", color: "gray" }]];

    return {
        title: modal.title || "Select model for new session",
        rows,
        selectedRowIndex,
        detailsTitle: "Model Details",
        detailsLines,
        idealWidth: Math.min(
            Math.max(
                46,
                rows.reduce((max, row) => {
                    if (Array.isArray(row)) return Math.max(max, flattenRunsLength(row));
                    return Math.max(max, String(row?.text || "").length);
                }, 0) + 4,
            ),
            maxWidth,
        ),
    };
}

export function selectSessionAgentPickerModal(state, maxWidth = 76) {
    const modal = state.ui.modal;
    if (!modal || modal.type !== "sessionAgentPicker") return null;

    const items = Array.isArray(modal.items) ? modal.items : [];
    const selectedIndex = Math.max(0, Number(modal.selectedIndex) || 0);
    const contentWidth = Math.max(24, maxWidth - 4);
    const rows = items.map((item, index) => {
        const isSelected = index === selectedIndex;
        const labelRuns = fitRuns([
            { text: item?.kind === "generic" ? "   ○ " : "   · ", color: "gray" },
            { text: item?.title || item?.agentName || item?.id || "Agent", color: "white", bold: true },
            ...(item?.kind === "generic"
                ? [{ text: " [generic]", color: "gray" }]
                : [{ text: ` (${item?.agentName || item?.id || "agent"})`, color: "gray" }]),
        ], contentWidth);
        return isSelected
            ? buildActiveHighlightLine(labelRuns.map((run) => run.text).join("").padEnd(contentWidth, " "))
            : labelRuns;
    });

    const selectedItem = items[selectedIndex] || null;
    const selectedModel = modal.sessionOptions?.model || null;
    const detailsLines = selectedItem
        ? [
            [{
                text: selectedItem.title || selectedItem.agentName || selectedItem.id || "Agent",
                color: "white",
                bold: true,
            }],
            ...(selectedItem.kind === "generic"
                ? [[{ text: "Open-ended session", color: "gray" }]]
                : [[{ text: selectedItem.agentName || selectedItem.id || "agent", color: "gray" }]]),
            ...(selectedModel ? [[{ text: `Model: ${selectedModel}`, color: "gray" }]] : []),
            [{ text: "", color: "gray" }],
            [{
                text: selectedItem.description || (
                    selectedItem.kind === "generic"
                        ? "Create a general-purpose session without a specialized named agent."
                        : "No description available for this agent."
                ),
                color: selectedItem.description ? "white" : "gray",
            }],
            [{ text: "", color: "gray" }],
            [{
                text: selectedItem.tools?.length
                    ? `Tools: ${selectedItem.tools.join(", ")}`
                    : "Tools: system defaults only",
                color: "gray",
            }],
        ]
        : [[{ text: "No agent selected.", color: "gray" }]];

    return {
        title: modal.title || "Select agent for new session",
        rows,
        selectedRowIndex: selectedIndex,
        detailsTitle: "Agent Details",
        detailsLines,
        idealWidth: Math.min(
            Math.max(
                52,
                rows.reduce((max, row) => {
                    if (Array.isArray(row)) return Math.max(max, flattenRunsLength(row));
                    return Math.max(max, String(row?.text || "").length);
                }, 0) + 4,
            ),
            maxWidth,
        ),
    };
}

export function selectRenameSessionModal(state, maxWidth = 76) {
    const modal = state.ui.modal;
    if (!modal || modal.type !== "renameSession") return null;

    const value = String(modal.value || "");
    const agentTitlePrefix = typeof modal.agentTitlePrefix === "string" && modal.agentTitlePrefix.trim()
        ? modal.agentTitlePrefix.trim()
        : null;
    const currentTitle = String(modal.currentTitle || "").trim();
    const previewTitle = value.trim()
        ? (agentTitlePrefix ? `${agentTitlePrefix}: ${value.trim()}` : value.trim())
        : (agentTitlePrefix ? `${agentTitlePrefix}: …` : "…");

    const detailsLines = [
        [{
            text: "Current: ",
            color: "gray",
        }, {
            text: currentTitle || "(untitled session)",
            color: currentTitle ? "white" : "gray",
        }],
        [{
            text: "Saved as: ",
            color: "gray",
        }, {
            text: previewTitle,
            color: "white",
            bold: true,
        }],
        ...(agentTitlePrefix
            ? [[{
                text: "Named-agent prefix stays fixed.",
                color: "gray",
            }]]
            : []),
    ];

    return {
        title: modal.title || "Rename Session",
        value,
        cursorIndex: Math.max(0, Math.min(Number(modal.cursorIndex) || 0, value.length)),
        placeholder: agentTitlePrefix
            ? "Type the title after the fixed agent name"
            : "Type a session title",
        helpTitle: "Rename Rules",
        helpLines: [
            [{
                text: "Enter",
                color: "cyan",
                bold: true,
            }, {
                text: " save  ",
                color: "gray",
            }, {
                text: "Esc",
                color: "cyan",
                bold: true,
            }, {
                text: " cancel",
                color: "gray",
            }],
            [{ text: "", color: "gray" }],
            [{
                text: "Manual titles stop future automatic LLM title changes for this session.",
                color: "gray",
            }],
        ],
        detailsLines,
        idealWidth: Math.min(
            Math.max(
                56,
                displayLength(currentTitle || "(untitled session)") + 18,
                displayLength(previewTitle) + 18,
            ),
            maxWidth,
        ),
    };
}

export function selectArtifactUploadModal(state, maxWidth = 82) {
    const modal = state.ui.modal;
    if (!modal || modal.type !== "artifactUpload") return null;

    const value = String(modal.value || "");
    const sessionId = modal.sessionId || state.ui.promptAttachments?.[0]?.sessionId || state.sessions?.activeSessionId || null;
    const targetSession = sessionId ? state.sessions?.byId?.[sessionId] || null : null;
    const targetLabel = sessionId
        ? (targetSession ? buildSessionTitle(targetSession, state.branding?.title) : shortSessionId(sessionId))
        : "A new session will be created on attach";
    const pendingAttachments = Array.isArray(state.ui.promptAttachments) ? state.ui.promptAttachments : [];

    const detailsLines = [
        [{
            text: "Target: ",
            color: "gray",
        }, {
            text: targetLabel,
            color: sessionId ? "white" : "gray",
            bold: Boolean(sessionId),
        }],
        [{
            text: "Draft attachments: ",
            color: "gray",
        }, {
            text: String(pendingAttachments.length),
            color: pendingAttachments.length > 0 ? "white" : "gray",
        }],
        ...(pendingAttachments.length > 0
            ? [[{
                text: pendingAttachments.map((attachment) => attachment.filename).join(", "),
                color: "gray",
            }]]
            : []),
    ];

    return {
        title: modal.title || "Attach File",
        value,
        cursorIndex: Math.max(0, Math.min(Number(modal.cursorIndex) || 0, value.length)),
        placeholder: "~/path/to/file.md",
        helpTitle: "Attach Rules",
        helpLines: [
            [{
                text: "Enter",
                color: "cyan",
                bold: true,
            }, {
                text: " attach  ",
                color: "gray",
            }, {
                text: "Esc",
                color: "cyan",
                bold: true,
            }, {
                text: " cancel",
                color: "gray",
            }],
            [{ text: "", color: "gray" }],
            [{
                text: "The file is uploaded immediately, then inserted into the prompt as a paperclip token.",
                color: "gray",
            }],
            [{
                text: "When the prompt is sent, the token expands into an artifact:// reference for the selected session.",
                color: "gray",
            }],
        ],
        detailsLines,
        idealWidth: Math.min(
            Math.max(
                60,
                displayLength(value || "~/path/to/file.md") + 20,
                displayLength(targetLabel) + 20,
            ),
            maxWidth,
        ),
    };
}

function buildFilterModalPresentation(modal, currentValues = {}, maxWidth = 96, fallbackTitle = "Filters", fallbackDescription = "Choose how this pane is filtered and rendered.") {
    const items = Array.isArray(modal.items) ? modal.items : [];
    const selectedIndex = Math.max(0, Number(modal.selectedIndex) || 0);
    const selectedItem = items[selectedIndex] || null;
    const panes = items.map((item, index) => {
        const currentValue = currentValues?.[item.id] || item.options?.[0]?.id;
        const lines = (item.options || []).map((option) => (option.id === currentValue
            ? buildActiveHighlightLine(option.label)
            : {
                text: option.label,
                color: "white",
            }));

        return {
            id: item.id,
            title: item.label,
            focused: index === selectedIndex,
            description: item.description || "",
            lines: lines.length > 0
                ? lines
                : [{ text: "No options available.", color: "gray" }],
            idealWidth: Math.max(
                20,
                String(item.label || "").length + 4,
                ...(item.options || []).map((option) => String(option?.label || "").length + 4),
            ),
        };
    });

    return {
        title: modal.title || fallbackTitle,
        panes,
        helpTitle: selectedItem?.label || fallbackTitle,
        helpLines: [
            [{
                text: selectedItem?.description || fallbackDescription,
                color: "white",
            }],
            [{ text: "", color: "gray" }],
            [{
                text: "Tab/Shift-Tab",
                color: "cyan",
                bold: true,
            }, {
                text: " switch filter  ",
                color: "gray",
            }, {
                text: "Up/Down",
                color: "cyan",
                bold: true,
            }, {
                text: " change value  ",
                color: "gray",
            }, {
                text: "Enter",
                color: "cyan",
                bold: true,
            }, {
                text: " close  ",
                color: "gray",
            }, {
                text: "Esc",
                color: "cyan",
                bold: true,
            }, {
                text: " cancel",
                color: "gray",
            }],
        ],
        footerRuns: [
            { text: "Tab/Shift-Tab", color: "cyan", bold: true },
            { text: " switch filter · ", color: "gray" },
            { text: "Up/Down", color: "cyan", bold: true },
            { text: " change value · ", color: "gray" },
            { text: "Enter", color: "cyan", bold: true },
            { text: " close · ", color: "gray" },
            { text: "Esc", color: "cyan", bold: true },
            { text: " cancel", color: "gray" },
        ],
        idealWidth: Math.min(
            Math.max(
                72,
                panes.reduce((sum, pane) => sum + pane.idealWidth, 0) + Math.max(0, panes.length - 1) * 2 + 4,
            ),
            maxWidth,
        ),
    };
}

export function selectLogFilterModal(state, maxWidth = 96) {
    const modal = state.ui.modal;
    if (!modal || modal.type !== "logFilter") return null;
    return buildFilterModalPresentation(
        modal,
        state.logs?.filter || {},
        maxWidth,
        "Log Filters",
        "Choose how the log pane is filtered and rendered.",
    );
}

export function selectFilesFilterModal(state, maxWidth = 88) {
    const modal = state.ui.modal;
    if (!modal || modal.type !== "filesFilter") return null;
    return buildFilterModalPresentation(
        modal,
        state.files?.filter || {},
        maxWidth,
        "Files Filter",
        "Choose whether the files browser shows only the selected session or aggregates artifacts across all sessions.",
    );
}

export function selectArtifactPickerModal(state, maxWidth = 88) {
    const modal = state.ui.modal;
    if (!modal || modal.type !== "artifactPicker") return null;

    const items = Array.isArray(modal.items) ? modal.items : [];
    const selectedIndex = Math.max(0, Number(modal.selectedIndex) || 0);
    const contentWidth = Math.max(28, maxWidth - 4);
    const artifactItems = items.filter((item) => item.kind === "artifact");
    const downloadedCount = artifactItems.reduce((count, item) => {
        const download = state.files?.bySessionId?.[item.sessionId]?.downloads?.[item.filename];
        return count + (download?.localPath ? 1 : 0);
    }, 0);
    const pendingCount = Math.max(0, artifactItems.length - downloadedCount);

    const rows = items.map((item, index) => {
        let runs;
        if (item.kind === "downloadAll") {
            runs = fitRuns([
                { text: "dl ", color: "cyan", bold: true },
                { text: "Download All", color: "white", bold: true },
                { text: ` [${pendingCount} pending]`, color: "gray" },
            ], contentWidth);
        } else {
            const download = state.files?.bySessionId?.[item.sessionId]?.downloads?.[item.filename];
            runs = fitRuns([
                {
                    text: download?.localPath ? "ok " : "dl ",
                    color: download?.localPath ? "green" : "cyan",
                    bold: true,
                },
                { text: `${shortSessionId(item.sessionId)}/`, color: "gray" },
                { text: item.filename, color: "white" },
            ], contentWidth);
        }

        if (index !== selectedIndex) return runs;
        return buildActiveHighlightLine(runs.map((run) => run.text).join("").padEnd(contentWidth, " "));
    });

    const selectedItem = items[selectedIndex] || null;
    let detailsLines = [[{ text: "No artifact selected.", color: "gray" }]];
    if (selectedItem?.kind === "downloadAll") {
        detailsLines = [
            [{ text: `${artifactItems.length} artifacts available`, color: "white", bold: true }],
            [{ text: `${downloadedCount} already downloaded`, color: "gray" }],
            [{ text: `${pendingCount} pending download`, color: "gray" }],
            ...(modal.exportDirectory ? [[{ text: `Save location: ${modal.exportDirectory}`, color: "white" }]] : []),
            [{ text: "", color: "gray" }],
            [{ text: "Press Enter to download all pending artifacts.", color: "white" }],
            [{ text: "Press a or Esc to close the picker.", color: "gray" }],
        ];
    } else if (selectedItem?.kind === "artifact") {
        const session = state.sessions?.byId?.[selectedItem.sessionId] || null;
        const download = state.files?.bySessionId?.[selectedItem.sessionId]?.downloads?.[selectedItem.filename] || null;
        detailsLines = [
            [{ text: selectedItem.filename, color: "white", bold: true }],
            [{ text: session ? buildSessionTitle(session, state.branding?.title) : shortSessionId(selectedItem.sessionId), color: "gray" }],
            ...(download?.localPath
                ? [[{ text: `Saved to: ${download.localPath}`, color: "white" }]]
                : modal.exportDirectory
                    ? [[{ text: `Save location: ${modal.exportDirectory}`, color: "white" }]]
                    : []),
            [{ text: "", color: "gray" }],
            [{
                text: download?.localPath
                    ? "Press Enter to download this artifact again."
                    : "Press Enter to download this artifact.",
                color: "white",
            }],
            [{ text: "Press a or Esc to close the picker.", color: "gray" }],
        ];
    }

    return {
        title: modal.title || "Artifact Downloads",
        rows: rows.length > 0 ? rows : [{ text: "No artifacts available.", color: "gray" }],
        selectedRowIndex: selectedIndex,
        detailsTitle: "Artifact Details",
        detailsLines,
        idealWidth: Math.min(
            Math.max(
                54,
                rows.reduce((max, row) => {
                    if (Array.isArray(row)) return Math.max(max, flattenRunsLength(row));
                    return Math.max(max, String(row?.text || "").length);
                }, 0) + 4,
            ),
            maxWidth,
        ),
    };
}

export function selectInspector(state, options = {}) {
    const session = selectActiveSession(state);
    const activeTab = state.ui.inspectorTab;
    const maxWidth = Math.max(18, Number(options?.width) || 36);
    const shortId = session ? shortSessionId(session.sessionId) : "";
    const recentWindow = getRecentActivityWindow(state);
    const title = activeTab === "nodes"
        ? [
            { text: "Node Map", color: "magenta", bold: true },
            { text: ` [${recentWindow.label}]`, color: "gray" },
        ]
        : !session
            ? "No session selected"
            : activeTab === "sequence"
            ? [
                { text: `Sequence: ${shortId}`, color: "magenta", bold: true },
                { text: ` [${recentWindow.label}]`, color: "gray" },
            ]
            : activeTab === "logs"
                ? `Logs: ${shortId}`
                : `Files: ${shortId}`;

    let lines;
    let stickyLines = [];
    switch (activeTab) {
        case "sequence": {
            const sequenceView = session
                ? buildSequenceViewForSession(state, session, maxWidth)
                : { stickyLines: [], lines: ["No session selected."] };
            stickyLines = sequenceView.stickyLines || [];
            lines = sequenceView.lines;
            break;
        }
        case "logs":
            lines = session
                ? selectLogPane(state, session)
                : ["No session selected."];
            break;
        case "nodes":
            lines = buildNodeMapLines(state, maxWidth);
            break;
        case "files":
            lines = session
                ? ["Files view is rendered in the shared host layout."]
                : ["No session selected."];
            break;
        default:
            lines = ["Inspector view is scaffolded in the new architecture."];
            break;
    }

    return {
        title,
        activeTab,
        tabs: INSPECTOR_TABS,
        stickyLines,
        lines,
    };
}
