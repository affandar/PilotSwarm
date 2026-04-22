import { UI_COMMANDS, FOCUS_REGIONS, INSPECTOR_TABS, cycleValue } from "./commands.js";
import {
    appendEventToHistory,
    buildHistoryModel,
    DEFAULT_HISTORY_EVENT_LIMIT,
    dedupeChatMessages,
    getNextHistoryEventLimit,
} from "./history.js";
import { applySessionUsageEvent, cloneContextUsageSnapshot } from "./context-usage.js";
import {
    computeLegacyLayout,
    getFocusLeftTarget,
    getFocusOrderForLayout,
    getFocusRightTarget,
    getPromptInputRows,
    normalizeFocusRegion,
} from "./layout.js";
import { parseTerminalMarkupRuns } from "./formatting.js";
import {
    selectActiveArtifactLinks,
    selectActiveHttpLinks,
    selectActivityPane,
    selectChatLines,
    selectFileBrowserItems,
    selectFileSessionIdsForScope,
    selectFilesScope,
    selectFilesView,
    selectInspector,
    selectSessionRows,
    selectSelectedFileBrowserItem,
    selectVisibleSessionRows,
} from "./selectors.js";
import { findArtifactEntry } from "./state.js";
import { getTheme, listThemes } from "./themes/index.js";

const ORCHESTRATION_STATS_REFRESH_MS = 20_000;
const SESSION_STATS_REFRESH_MS = 20_000;
const FLEET_STATS_REFRESH_MS = 30_000;
const FLEET_STATS_DEFAULT_WINDOW_DAYS = 30;
const SESSION_REFRESH_FAILED_STATUS = "Session refresh failed";
const FULLSCREENABLE_PANES = new Set([
    FOCUS_REGIONS.SESSIONS,
    FOCUS_REGIONS.CHAT,
    FOCUS_REGIONS.INSPECTOR,
    FOCUS_REGIONS.ACTIVITY,
]);

function groupModelsByProvider(models = []) {
    const groups = [];
    const byProvider = new Map();

    for (const model of models) {
        const providerId = model?.providerId || "models";
        let group = byProvider.get(providerId);
        if (!group) {
            group = {
                providerId,
                providerType: model?.providerType || "provider",
                models: [],
            };
            byProvider.set(providerId, group);
            groups.push(group);
        }
        group.models.push(model);
    }

    return groups;
}

function extractSessionModelFromEvents(events = []) {
    for (let index = events.length - 1; index >= 0; index -= 1) {
        const data = events[index]?.data;
        if (data && typeof data === "object") {
            if (typeof data.model === "string" && data.model) return data.model;
            if (typeof data.currentModel === "string" && data.currentModel) return data.currentModel;
            if (typeof data.newModel === "string" && data.newModel) return data.newModel;
        }
    }
    return undefined;
}

function extractSessionModelFromEvent(event) {
    return extractSessionModelFromEvents([event]);
}

function extractSessionContextUsageFromEvents(initialContextUsage, events = []) {
    let current = cloneContextUsageSnapshot(initialContextUsage);
    for (const event of events) {
        const next = applySessionUsageEvent(current, event?.eventType, event?.data, {
            timestamp: event?.createdAt,
        });
        if (next) current = next;
    }
    return current;
}

function areStructuredValuesEqual(left, right) {
    if (Object.is(left, right)) return true;
    if (Array.isArray(left) || Array.isArray(right)) {
        if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
        for (let index = 0; index < left.length; index += 1) {
            if (!areStructuredValuesEqual(left[index], right[index])) return false;
        }
        return true;
    }
    if (!left || !right || typeof left !== "object" || typeof right !== "object") {
        return false;
    }
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);
    if (leftKeys.length !== rightKeys.length) return false;
    for (const key of leftKeys) {
        if (!Object.prototype.hasOwnProperty.call(right, key)) return false;
        if (!areStructuredValuesEqual(left[key], right[key])) return false;
    }
    return true;
}

function buildSessionMergePatch(previousSession, nextSession) {
    if (!nextSession?.sessionId) return null;

    const patch = { sessionId: nextSession.sessionId };
    let changed = false;
    for (const [key, value] of Object.entries(nextSession)) {
        if (key === "sessionId" || value === undefined) continue;
        if (areStructuredValuesEqual(previousSession?.[key], value)) continue;
        patch[key] = value;
        changed = true;
    }

    if (nextSession.pendingQuestion === undefined && previousSession?.pendingQuestion && nextSession.status !== "input_required") {
        patch.pendingQuestion = null;
        changed = true;
    }
    if (nextSession.waitReason === undefined && previousSession?.waitReason && nextSession.status !== "waiting" && nextSession.status !== "input_required") {
        patch.waitReason = null;
        changed = true;
    }
    if (nextSession.error === undefined && previousSession?.error && nextSession.status !== "failed" && nextSession.status !== "error") {
        patch.error = null;
        changed = true;
    }
    if (nextSession.result === undefined && previousSession?.result && nextSession.status !== "completed") {
        patch.result = null;
        changed = true;
    }
    if (nextSession.cronActive !== true) {
        if (previousSession?.cronReason) {
            patch.cronReason = null;
            changed = true;
        }
        if (previousSession?.cronInterval != null && nextSession.cronInterval === undefined) {
            patch.cronInterval = null;
            changed = true;
        }
    }

    const terminalSession = isTerminalSessionStatus(nextSession.status) || isTerminalOrchestrationStatus(nextSession.orchestrationStatus);
    if (
        terminalSession
        && previousSession?.contextUsage?.compaction?.state === "running"
        && nextSession.contextUsage === undefined
    ) {
        const nextContextUsage = { ...previousSession.contextUsage };
        delete nextContextUsage.compaction;
        patch.contextUsage = Object.keys(nextContextUsage).length > 0 ? nextContextUsage : null;
        changed = true;
    }

    return changed ? patch : null;
}

function isTerminalOrchestrationStatus(status) {
    return status === "Completed" || status === "Failed" || status === "Terminated";
}

function isTerminalSessionStatus(status) {
    return status === "completed" || status === "failed" || status === "cancelled";
}

function isTerminalSendError(error) {
    const message = String(error?.message || error || "");
    return /instance is terminal|terminal orchestration|cannot accept new messages/i.test(message);
}

function appendSyntheticChatMessage(history, message) {
    return {
        ...(history || {}),
        chat: [
            ...((history && Array.isArray(history.chat)) ? history.chat : []),
            message,
        ],
    };
}

function formatTerminalReferenceLine(label, value) {
    return `- ${label}: ${value}`;
}

function buildTerminalSendRejectedMessage(session, error) {
    const shortSessionId = String(session?.sessionId || "unknown").slice(0, 8);
    const orchestrationStatus = String(session?.orchestrationStatus || "Unknown");
    const sessionStatus = String(session?.status || "unknown");
    const parentSessionId = session?.parentSessionId ? String(session.parentSessionId).slice(0, 8) : "root";
    const cronSummary = session?.cronActive === true || typeof session?.cronInterval === "number"
        ? `active${typeof session?.cronInterval === "number" ? ` (${session.cronInterval}s)` : ""}`
        : "inactive";
    const body = [
        `Cannot send a new message because session ${shortSessionId} is attached to a terminal orchestration instance.`,
        "",
        "Reference:",
        formatTerminalReferenceLine("Session status", sessionStatus),
        formatTerminalReferenceLine("Orchestration status", orchestrationStatus),
        formatTerminalReferenceLine("Parent session", parentSessionId),
        formatTerminalReferenceLine("Cron", cronSummary),
    ];

    if (typeof session?.waitReason === "string" && session.waitReason.trim()) {
        body.push(formatTerminalReferenceLine("Wait reason", session.waitReason.trim()));
    }
    if (typeof session?.error === "string" && session.error.trim()) {
        body.push(formatTerminalReferenceLine("Error", session.error.trim().split("\n")[0]));
    } else if (error?.message) {
        body.push(formatTerminalReferenceLine("Reject reason", String(error.message).trim()));
    }
    if (typeof session?.result === "string" && session.result.trim()) {
        body.push(formatTerminalReferenceLine("Result", "completed response available"));
    }

    body.push("", "Create a new session to continue.");

    return {
        id: `send-error:${session?.sessionId || "unknown"}:${Date.now()}`,
        role: "system",
        text: body.join("\n"),
        time: "",
        createdAt: Date.now(),
        cardTitle: "Error",
        cardTitleColor: "red",
        cardBorderColor: "red",
    };
}

function shortSessionIdValue(sessionId) {
    return String(sessionId || "").slice(0, 8);
}

function ownerKeyForPrincipal(principal) {
    const provider = String(principal?.provider || "").trim();
    const subject = String(principal?.subject || "").trim();
    return provider && subject ? `${provider}\u0001${subject}` : null;
}

function ownerDisplayName(owner, fallback = "unknown user") {
    return String(owner?.displayName || owner?.email || "").trim() || fallback;
}

function buildSessionOwnerFilterItems(state) {
    const principal = state.auth?.principal || null;
    const principalKey = ownerKeyForPrincipal(principal);
    const items = [
        {
            id: "all",
            kind: "all",
            label: "All",
            description: "Show every session, including system and unowned sessions.",
        },
        {
            id: "system",
            kind: "system",
            label: "System",
            description: "Show sessions created by system agents.",
        },
        {
            id: "unowned",
            kind: "unowned",
            label: "Unowned",
            description: "Show non-system sessions that do not have an owner link.",
        },
    ];

    if (principalKey) {
        const label = ownerDisplayName(principal, "current user");
        items.push({
            id: "me",
            kind: "me",
            label: `Me (${label})`,
            ownerKey: principalKey,
            description: "Show sessions owned by the authenticated user currently signed in.",
        });
    }

    const ownersByKey = new Map();
    for (const session of Object.values(state.sessions?.byId || {})) {
        const owner = session?.owner;
        const key = ownerKeyForPrincipal(owner);
        if (!key || key === principalKey || ownersByKey.has(key)) continue;
        ownersByKey.set(key, owner);
    }

    for (const [ownerKey, owner] of [...ownersByKey.entries()].sort((a, b) => (
        ownerDisplayName(a[1]).localeCompare(ownerDisplayName(b[1]))
    ))) {
        const label = ownerDisplayName(owner);
        const email = String(owner?.email || "").trim();
        items.push({
            id: `owner:${ownerKey}`,
            kind: "owner",
            ownerKey,
            label: email && email !== label ? `${label} <${email}>` : label,
            description: "Show sessions owned by this user.",
        });
    }

    return items;
}

function defaultOwnerFilterForPrincipal(principal) {
    return ownerKeyForPrincipal(principal)
        ? {
            all: false,
            includeSystem: true,
            includeUnowned: false,
            includeMe: true,
            ownerKeys: [],
        }
        : {
            all: true,
            includeSystem: false,
            includeUnowned: false,
            includeMe: false,
            ownerKeys: [],
        };
}

function ownerFilterHasSelections(filter) {
    return Boolean(
        filter?.includeSystem
        || filter?.includeUnowned
        || filter?.includeMe
        || (Array.isArray(filter?.ownerKeys) && filter.ownerKeys.length > 0),
    );
}

function toggleOwnerFilterItem(currentFilter, item, principal) {
    const current = currentFilter || defaultOwnerFilterForPrincipal(principal);
    if (!item) return current;
    if (item.kind === "all") {
        return current.all ? defaultOwnerFilterForPrincipal(principal) : {
            all: true,
            includeSystem: false,
            includeUnowned: false,
            includeMe: false,
            ownerKeys: [],
        };
    }

    const next = {
        ...current,
        all: false,
        ownerKeys: Array.isArray(current.ownerKeys) ? [...current.ownerKeys] : [],
    };
    if (item.kind === "system") next.includeSystem = !next.includeSystem;
    if (item.kind === "unowned") next.includeUnowned = !next.includeUnowned;
    if (item.kind === "me") next.includeMe = !next.includeMe;
    if (item.kind === "owner" && item.ownerKey) {
        const existingIndex = next.ownerKeys.indexOf(item.ownerKey);
        if (existingIndex >= 0) {
            next.ownerKeys.splice(existingIndex, 1);
        } else {
            next.ownerKeys.push(item.ownerKey);
        }
    }

    return ownerFilterHasSelections(next)
        ? next
        : { all: true, includeSystem: false, includeUnowned: false, includeMe: false, ownerKeys: [] };
}

function getRenameSessionPrefix(session) {
    if (!session?.agentId || session?.isSystem) return null;
    const currentTitle = String(session?.title || "").trim();
    if (!currentTitle) return null;
    const separatorIndex = currentTitle.indexOf(": ");
    if (separatorIndex > 0) {
        return currentTitle.slice(0, separatorIndex).trim() || null;
    }
    return currentTitle || null;
}

function getRenameSessionMaxLength(session) {
    const prefix = getRenameSessionPrefix(session);
    if (!prefix) return 60;
    return Math.max(1, 60 - `${prefix}: `.length);
}

function getRenameSessionEditableTitle(session) {
    const currentTitle = String(session?.title || "").trim();
    if (!currentTitle) return "";

    const prefix = getRenameSessionPrefix(session);
    if (prefix && currentTitle.startsWith(`${prefix}: `)) {
        const suffix = currentTitle.slice(`${prefix}: `.length).trim();
        if (!suffix || suffix === shortSessionIdValue(session?.sessionId)) return "";
        return suffix;
    }

    if (currentTitle === shortSessionIdValue(session?.sessionId)) return "";
    return currentTitle;
}

function formatAgentDisplayTitle(agentName, title) {
    const normalizedTitle = String(title || "").trim();
    if (normalizedTitle) return normalizedTitle;
    const normalizedName = String(agentName || "").trim();
    return normalizedName
        ? normalizedName.charAt(0).toUpperCase() + normalizedName.slice(1)
        : "Agent";
}

function buildPromptAttachmentToken(filename) {
    return `📎 ${String(filename || "").trim()}`;
}

function extractPromptReferenceContext(prompt, cursorIndex) {
    const text = String(prompt || "");
    const safeCursor = clampPromptCursor(text, cursorIndex, text.length);
    const left = text.slice(0, safeCursor);
    const match = left.match(/(^|\s)(@@?)([^\s]*)$/u);
    if (!match) return null;

    const trigger = match[2];
    const query = String(match[3] || "");
    return {
        kind: trigger === "@@" ? "sessions" : "artifacts",
        query,
        signature: `${trigger}${query}`,
        tokenStart: (match.index || 0) + String(match[1] || "").length,
        tokenEnd: safeCursor,
    };
}

function replacePromptTextRange(prompt, start, end, replacement) {
    const safePrompt = String(prompt || "");
    const rangeStart = clampPromptCursor(safePrompt, start, 0);
    const rangeEnd = clampPromptCursor(safePrompt, end, rangeStart);
    const nextText = String(replacement || "");
    return {
        prompt: `${safePrompt.slice(0, rangeStart)}${nextText}${safePrompt.slice(rangeEnd)}`,
        cursor: rangeStart + nextText.length,
    };
}

function normalizePromptReferenceLabel(value, fallback = "session") {
    const text = String(value || "").replace(/\s+/gu, " ").trim();
    return text || fallback;
}

function buildPromptSessionReferenceText(session) {
    const sessionId = String(session?.sessionId || "").trim();
    const fallbackLabel = shortSessionIdValue(sessionId) || "session";
    const label = normalizePromptReferenceLabel(session?.title, fallbackLabel);
    return `Referenced session: ${label} — session://${sessionId}`;
}

function replacePromptReferenceContext(prompt, context, replacement) {
    if (!context) {
        return insertPromptTextAtCursor(prompt, String(prompt || "").length, replacement);
    }
    const safePrompt = String(prompt || "");
    const nextChar = safePrompt.slice(context.tokenEnd, context.tokenEnd + 1);
    const needsTrailingSpace = !nextChar || /\s/u.test(nextChar);
    return replacePromptTextRange(
        safePrompt,
        context.tokenStart,
        context.tokenEnd,
        `${String(replacement || "")}${needsTrailingSpace ? " " : ""}`,
    );
}

function stripPromptAttachmentTokens(prompt, attachments = []) {
    let cleaned = String(prompt || "");
    for (const attachment of attachments || []) {
        const token = String(attachment?.token || "").trim();
        if (!token) continue;
        cleaned = cleaned.split(token).join(" ");
    }
    return cleaned
        .replace(/[ \t]+\n/g, "\n")
        .replace(/\n[ \t]+/g, "\n")
        .replace(/[ \t]{2,}/g, " ")
        .trim();
}

function expandPromptAttachments(prompt, attachments = []) {
    const validAttachments = Array.isArray(attachments)
        ? attachments.filter((attachment) => attachment?.sessionId && attachment?.filename)
        : [];
    if (validAttachments.length === 0) return String(prompt || "");

    const attachmentRefs = validAttachments.map((attachment) => (
        `[Attached file: ${attachment.filename} — artifact://${attachment.sessionId}/${attachment.filename}]`
    ));
    const cleanedPrompt = stripPromptAttachmentTokens(prompt, validAttachments);
    return attachmentRefs.join("\n") + (cleanedPrompt ? `\n\n${cleanedPrompt}` : "");
}

function clampRenameSessionValue(value, maxLength) {
    return String(value || "").replace(/\r?\n/g, " ").slice(0, Math.max(0, Number(maxLength) || 0));
}

function displayWidth(value) {
    return Array.from(String(value || "")).length;
}

function normalizeRenderableLines(lines) {
    const normalized = [];
    for (const line of lines || []) {
        if (line?.kind === "markup") {
            const parsed = parseTerminalMarkupRuns(line.value || "");
            for (const parsedLine of parsed) {
                normalized.push(parsedLine);
            }
            continue;
        }
        if (Array.isArray(line)) {
            normalized.push(line);
            continue;
        }
        normalized.push(line);
    }
    return normalized;
}

function countWrappedTextLines(text, width) {
    const safeWidth = Math.max(1, Number(width) || 1);
    const renderedWidth = displayWidth(text);
    return Math.max(1, Math.ceil(renderedWidth / safeWidth));
}

function countWrappedRenderableLines(lines, width) {
    const safeWidth = Math.max(1, Number(width) || 1);
    return normalizeRenderableLines(lines).reduce((sum, line) => {
        if (!line) return sum + 1;
        if (Array.isArray(line)) {
            const lineWidth = line.reduce((acc, run) => acc + displayWidth(run?.text || ""), 0);
            return sum + Math.max(1, Math.ceil(lineWidth / safeWidth));
        }
        return sum + countWrappedTextLines(line.text || "", safeWidth);
    }, 0);
}

function clampPromptCursor(prompt, cursor) {
    const text = String(prompt || "");
    return Math.max(0, Math.min(Number(cursor) || 0, text.length));
}

function splitPromptLines(prompt) {
    return String(prompt || "").split("\n");
}

function getPromptCursorPosition(prompt, cursor) {
    const prefix = String(prompt || "").slice(0, clampPromptCursor(prompt, cursor));
    const lines = prefix.split("\n");
    const currentLine = lines[lines.length - 1] || "";
    return {
        line: Math.max(0, lines.length - 1),
        column: currentLine.length,
    };
}

function getPromptCursorIndex(prompt, line, column) {
    const lines = splitPromptLines(prompt);
    const safeLine = Math.max(0, Math.min(Number(line) || 0, Math.max(0, lines.length - 1)));
    const safeColumn = Math.max(0, Math.min(Number(column) || 0, lines[safeLine]?.length || 0));
    let index = 0;
    for (let currentLine = 0; currentLine < safeLine; currentLine += 1) {
        index += (lines[currentLine]?.length || 0) + 1;
    }
    return clampPromptCursor(prompt, index + safeColumn);
}

function insertPromptTextAtCursor(prompt, cursor, text) {
    const safePrompt = String(prompt || "");
    const safeCursor = clampPromptCursor(safePrompt, cursor);
    const insertion = String(text || "");
    return {
        prompt: `${safePrompt.slice(0, safeCursor)}${insertion}${safePrompt.slice(safeCursor)}`,
        cursor: safeCursor + insertion.length,
    };
}

function deletePromptCharBackward(prompt, cursor) {
    const safePrompt = String(prompt || "");
    const safeCursor = clampPromptCursor(safePrompt, cursor);
    if (safeCursor <= 0) {
        return { prompt: safePrompt, cursor: safeCursor };
    }
    return {
        prompt: `${safePrompt.slice(0, safeCursor - 1)}${safePrompt.slice(safeCursor)}`,
        cursor: safeCursor - 1,
    };
}

function isWordBoundaryWhitespace(value) {
    return /\s/u.test(value || "");
}

function movePromptCursorByWord(prompt, cursor, direction) {
    const safePrompt = String(prompt || "");
    let index = clampPromptCursor(safePrompt, cursor);
    if (direction < 0) {
        while (index > 0 && isWordBoundaryWhitespace(safePrompt[index - 1])) index -= 1;
        while (index > 0 && !isWordBoundaryWhitespace(safePrompt[index - 1])) index -= 1;
        return index;
    }
    while (index < safePrompt.length && isWordBoundaryWhitespace(safePrompt[index])) index += 1;
    while (index < safePrompt.length && !isWordBoundaryWhitespace(safePrompt[index])) index += 1;
    return index;
}

function deletePromptWordBackward(prompt, cursor) {
    const safePrompt = String(prompt || "");
    const safeCursor = clampPromptCursor(safePrompt, cursor);
    const nextCursor = movePromptCursorByWord(safePrompt, safeCursor, -1);
    if (nextCursor === safeCursor) {
        return { prompt: safePrompt, cursor: safeCursor };
    }
    return {
        prompt: `${safePrompt.slice(0, nextCursor)}${safePrompt.slice(safeCursor)}`,
        cursor: nextCursor,
    };
}

function movePromptCursorVertically(prompt, cursor, direction) {
    const lines = splitPromptLines(prompt);
    if (lines.length <= 1) return clampPromptCursor(prompt, cursor);
    const position = getPromptCursorPosition(prompt, cursor);
    const targetLine = Math.max(0, Math.min(position.line + direction, lines.length - 1));
    if (targetLine === position.line) return clampPromptCursor(prompt, cursor);
    return getPromptCursorIndex(prompt, targetLine, position.column);
}

const AUTO_HISTORY_EVENT_SOFT_CAP = 3_000;
const INSPECTOR_BOTTOM_ANCHORED_TABS = new Set(["logs", "sequence"]);
const FILE_PREVIEW_CHAR_LIMIT = 200_000;
const MARKDOWN_FILE_EXTENSIONS = new Set([
    ".md",
    ".markdown",
    ".mdown",
    ".mkd",
    ".mdx",
]);
const JSON_FILE_EXTENSIONS = new Set([
    ".json",
    ".jsonl",
]);
const BINARY_PREVIEW_EXTENSIONS = new Set([
    ".png",
    ".jpg",
    ".jpeg",
    ".gif",
    ".webp",
    ".svg",
    ".ico",
    ".pdf",
    ".zip",
    ".gz",
    ".tgz",
    ".tar",
    ".wasm",
    ".sqlite",
    ".db",
]);

function fileExtension(filename) {
    const value = String(filename || "");
    const lastDot = value.lastIndexOf(".");
    return lastDot >= 0 ? value.slice(lastDot).toLowerCase() : "";
}

function isBinaryPreview(filename, contentType = "") {
    const ext = fileExtension(filename);
    const normalizedType = String(contentType || "").toLowerCase();
    if (BINARY_PREVIEW_EXTENSIONS.has(ext)) return true;
    return normalizedType.startsWith("image/")
        || normalizedType === "application/pdf"
        || normalizedType.startsWith("application/zip")
        || normalizedType === "application/wasm";
}

function truncateFilePreview(content, limit = FILE_PREVIEW_CHAR_LIMIT) {
    const text = String(content ?? "");
    if (text.length <= limit) return text;
    return `${text.slice(0, limit)}\n\n[Preview truncated at ${limit.toLocaleString()} characters. Open the artifact directly if you need the full file.]`;
}

function formatPreviewBytes(value) {
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

function buildBinaryPreviewNote(filename, contentType = "", sizeBytes = null) {
    const lines = [
        `Preview is not available here for ${filename}.`,
        "",
    ];
    if (contentType) {
        lines.push(`Type: ${contentType}`);
    }
    if (sizeBytes != null) {
        lines.push(`Size: ${formatPreviewBytes(sizeBytes)}`);
    }
    lines.push("Download the artifact to open it in the default app.");
    return lines.join("\n");
}

function normalizePreviewPayload(filename, rawContent, contentType = "", metadata = null) {
    const normalizedType = String(contentType || "").toLowerCase();
    const ext = fileExtension(filename);

    if (metadata?.isBinary === true || isBinaryPreview(filename, contentType)) {
        return {
            content: buildBinaryPreviewNote(filename, metadata?.contentType || contentType, metadata?.sizeBytes ?? null),
            contentType: metadata?.contentType || contentType || "application/octet-stream",
            renderMode: "note",
            isBinary: true,
            sizeBytes: metadata?.sizeBytes ?? null,
            uploadedAt: metadata?.uploadedAt || "",
            source: metadata?.source || "agent",
        };
    }

    const truncatedText = truncateFilePreview(rawContent);
    if (MARKDOWN_FILE_EXTENSIONS.has(ext) || normalizedType.includes("markdown")) {
        return {
            content: truncatedText,
            contentType: contentType || "text/markdown",
            renderMode: "markdown",
            isBinary: false,
            sizeBytes: metadata?.sizeBytes ?? null,
            uploadedAt: metadata?.uploadedAt || "",
            source: metadata?.source || "agent",
        };
    }

    if (JSON_FILE_EXTENSIONS.has(ext) || normalizedType.includes("json")) {
        try {
            return {
                content: truncateFilePreview(JSON.stringify(JSON.parse(String(rawContent ?? "")), null, 2)),
                contentType: contentType || "application/json",
                renderMode: "text",
            };
        } catch {
            return {
                content: truncatedText,
                contentType: contentType || "application/json",
                renderMode: "text",
            };
        }
    }

    return {
        content: truncatedText,
        contentType: contentType || "text/plain",
        renderMode: "text",
    };
}

export class PilotSwarmUiController {
    constructor({ store, transport }) {
        this.store = store;
        this.transport = transport;
        this.catalogTimer = null;
        this.activeSessionUnsub = null;
        this.activeSessionSubscriptionId = null;
        this.activeSessionDetailTimer = null;
        this.activeSessionDetailSessionId = null;
        this.sessionRefreshTimer = null;
        this.sessionHistoryLoads = new Map();
        this.sessionHistoryExpansionLoads = new Map();
        this.sessionOrchestrationStatsLoads = new Map();
        this.logUnsubscribe = null;
        this.promptReferenceSignature = null;
        this.promptReferenceSyncVersion = 0;
    }

    getState() {
        return this.store.getState();
    }

    subscribe(listener) {
        return this.store.subscribe(listener);
    }

    dispatch(action) {
        return this.store.dispatch(action);
    }

    setStatus(text) {
        this.dispatch({ type: "ui/status", text });
    }

    getPromptAttachments() {
        const attachments = this.getState().ui.promptAttachments;
        return Array.isArray(attachments) ? attachments.filter(Boolean) : [];
    }

    setPromptAttachments(attachments) {
        this.dispatch({
            type: "ui/promptAttachments",
            attachments: Array.isArray(attachments) ? attachments : [],
        });
    }

    getPromptReferenceContext() {
        const state = this.getState();
        return extractPromptReferenceContext(state.ui.prompt, state.ui.promptCursor);
    }

    acceptPromptReferenceAutocomplete() {
        const context = this.getPromptReferenceContext();
        if (!context) return false;
        if (context.kind === "sessions") {
            return this.acceptSessionPromptReference(context);
        }
        return this.acceptArtifactPromptReference(context);
    }

    acceptArtifactPromptReference(context = this.getPromptReferenceContext()) {
        if (!context || context.kind !== "artifacts") return false;

        const state = this.getState();
        const selectedItem = selectSelectedFileBrowserItem(state);
        const sessionId = selectedItem?.sessionId || state.sessions.activeSessionId || null;
        const filename = selectedItem?.filename || null;
        if (!sessionId || !filename) return false;

        const token = buildPromptAttachmentToken(filename);
        const insertion = replacePromptReferenceContext(state.ui.prompt, context, token);
        const previousAttachments = this.getPromptAttachments();
        const existingAttachmentIndex = previousAttachments.findIndex((attachment) => (
            attachment?.sessionId === sessionId
            && attachment?.filename === filename
        ));
        const nextAttachment = {
            ...(existingAttachmentIndex >= 0 ? previousAttachments[existingAttachmentIndex] : {}),
            id: `${sessionId}/${filename}`,
            sessionId,
            filename,
            resolvedPath: filename,
            token,
        };
        const nextAttachments = existingAttachmentIndex >= 0
            ? previousAttachments.map((attachment, index) => (index === existingAttachmentIndex ? nextAttachment : attachment))
            : [...previousAttachments, nextAttachment];

        this.setPrompt(insertion.prompt, insertion.cursor);
        this.setPromptAttachments(nextAttachments);
        this.setFocus(FOCUS_REGIONS.PROMPT);
        this.dispatch({ type: "ui/status", text: `Attached ${filename}` });
        return true;
    }

    acceptSessionPromptReference(context = this.getPromptReferenceContext()) {
        if (!context || context.kind !== "sessions") return false;

        const state = this.getState();
        const sessionRows = selectSessionRows(state);
        const targetRow = sessionRows[0] || null;
        const targetSession = targetRow?.sessionId
            ? state.sessions.byId[targetRow.sessionId] || null
            : null;
        if (!targetSession?.sessionId) return false;

        const referenceText = buildPromptSessionReferenceText(targetSession);
        const insertion = replacePromptReferenceContext(state.ui.prompt, context, referenceText);
        this.setPrompt(insertion.prompt, insertion.cursor);
        this.setFocus(FOCUS_REGIONS.PROMPT);
        this.dispatch({
            type: "ui/status",
            text: `Referenced session ${shortSessionIdValue(targetSession.sessionId)}`,
        });
        return true;
    }

    setSessionFilterQuery(query = "") {
        this.dispatch({
            type: "sessions/filterQuery",
            query: String(query || ""),
        });
    }

    openSessionOwnerFilter() {
        const state = this.getState();
        const items = buildSessionOwnerFilterItems(state);
        this.dispatch({
            type: "ui/modal",
            modal: {
                type: "sessionOwnerFilter",
                title: "Session Filter",
                previousFocus: state.ui.focusRegion,
                selectedIndex: 0,
                items,
            },
        });
        this.dispatch({
            type: "ui/status",
            text: "Up/Down choose entry · Space toggle · Esc close",
        });
    }

    toggleSessionOwnerFilter(index = null) {
        const state = this.getState();
        const modal = state.ui.modal;
        if (!modal || modal.type !== "sessionOwnerFilter") return;
        const selectedIndex = index == null
            ? Math.max(0, Number(modal.selectedIndex) || 0)
            : Math.max(0, Number(index) || 0);
        const item = modal.items?.[selectedIndex];
        if (!item) return;
        const nextFilter = toggleOwnerFilterItem(state.sessions.ownerFilter, item, state.auth?.principal);
        this.dispatch({
            type: "sessions/ownerFilter",
            filter: nextFilter,
        });
        this.dispatch({
            type: "ui/modalSelection",
            index: selectedIndex,
        });
        this.dispatch({
            type: "ui/status",
            text: `Session filter updated: ${item.label || item.id || "selection"}`,
        });
    }

    setFilesFilter(patch = {}) {
        this.dispatch({
            type: "files/filter",
            filter: patch,
        });
    }

    clearPromptReferenceBrowser() {
        this.promptReferenceSignature = null;
        this.promptReferenceSyncVersion += 1;
        if (this.getState().sessions.filterQuery) {
            this.setSessionFilterQuery("");
        }
        if (this.getState().files.filter?.query) {
            this.setFilesFilter({ query: "" });
        }
    }

    syncPromptReferenceBrowser() {
        const state = this.getState();
        const context = extractPromptReferenceContext(state.ui.prompt, state.ui.promptCursor);

        if (!context) {
            this.clearPromptReferenceBrowser();
            return;
        }

        if (this.promptReferenceSignature === context.signature) {
            return;
        }
        this.promptReferenceSignature = context.signature;

        if (context.kind === "sessions") {
            this.promptReferenceSyncVersion += 1;
            this.setFilesFilter({ query: "" });
            this.setSessionFilterQuery(context.query);
            return;
        }

        const sessionId = state.sessions.activeSessionId;
        this.setSessionFilterQuery("");
        this.setFilesFilter({
            scope: "selectedSession",
            query: context.query,
        });
        if (!sessionId) return;

        this.selectInspectorTab("files").catch(() => {});
        const syncVersion = ++this.promptReferenceSyncVersion;
        this.ensureFilesForScope("selectedSession").then(async () => {
            if (this.promptReferenceSyncVersion !== syncVersion) return;
            const scopedSessionIds = new Set(selectFileSessionIdsForScope(this.getState(), "selectedSession"));
            const items = selectFileBrowserItems(this.getState()).filter((item) => scopedSessionIds.has(item.sessionId));
            const nextItem = items[0] || null;
            if (!nextItem?.filename) return;
            this.dispatch({
                type: "files/select",
                sessionId: nextItem.sessionId,
                filename: nextItem.filename,
            });
            await this.ensureFilePreview(nextItem.sessionId, nextItem.filename).catch(() => {});
        }).catch(() => {});
    }

    async start() {
        await this.transport.start();
        const authContext = typeof this.transport.getAuthContext === "function"
            ? this.transport.getAuthContext()
            : null;
        this.dispatch({
            type: "auth/context",
            principal: authContext?.principal ?? null,
            authorization: authContext?.authorization ?? null,
        });
        if (!this.getState().sessions.ownerFilterExplicit) {
            this.dispatch({
                type: "sessions/ownerFilter",
                filter: defaultOwnerFilterForPrincipal(authContext?.principal ?? null),
            });
        }
        const logConfig = typeof this.transport.getLogConfig === "function"
            ? this.transport.getLogConfig()
            : null;
        if (logConfig) {
            this.dispatch({
                type: "logs/config",
                available: logConfig.available,
                availabilityReason: logConfig.availabilityReason,
            });
        }
        this.dispatch({
            type: "connection/ready",
            workersOnline: typeof this.transport.getWorkerCount === "function" ? this.transport.getWorkerCount() : null,
            statusText: "Connected",
        });
        await this.refreshSessions();
        this.catalogTimer = setInterval(() => {
            this.refreshSessions().catch((error) => {
                this.dispatch({
                    type: "connection/error",
                    error: error?.message || String(error),
                    statusText: SESSION_REFRESH_FAILED_STATUS,
                });
            });
        }, 4000);
    }

    async stop() {
        if (this.catalogTimer) clearInterval(this.catalogTimer);
        this.catalogTimer = null;
        if (this.activeSessionDetailTimer) clearTimeout(this.activeSessionDetailTimer);
        this.activeSessionDetailTimer = null;
        this.activeSessionDetailSessionId = null;
        if (this.sessionRefreshTimer) clearTimeout(this.sessionRefreshTimer);
        this.sessionRefreshTimer = null;
        this.sessionHistoryExpansionLoads.clear();
        this.sessionOrchestrationStatsLoads.clear();
        this.detachActiveSession();
        this.detachLogStream();
        await this.transport.stop();
    }

    detachActiveSession() {
        if (this.activeSessionUnsub) {
            this.activeSessionUnsub();
            this.activeSessionUnsub = null;
        }
        this.activeSessionSubscriptionId = null;
    }

    detachLogStream() {
        if (this.logUnsubscribe) {
            this.logUnsubscribe();
            this.logUnsubscribe = null;
        }
    }

    async refreshSessions() {
        const preRefreshState = this.getState();
        const recoveringConnection = !preRefreshState.connection.connected || Boolean(preRefreshState.connection.error);
        const shouldClearRefreshFailureBanner = preRefreshState.ui.statusText === SESSION_REFRESH_FAILED_STATUS;
        const previousActive = this.getState().sessions.activeSessionId;
        let sessions = await this.transport.listSessions();
        const active = previousActive;
        if (
            active
            && !sessions.some((session) => session?.sessionId === active)
            && typeof this.transport.getSession === "function"
        ) {
            const activeSession = await this.transport.getSession(active).catch(() => null);
            if (activeSession?.sessionId) {
                sessions = [...sessions, activeSession];
            }
        }
        if (recoveringConnection) {
            this.dispatch({
                type: "connection/ready",
                workersOnline: typeof this.transport.getWorkerCount === "function" ? this.transport.getWorkerCount() : null,
                ...(shouldClearRefreshFailureBanner ? { statusText: "Connected" } : {}),
            });
        }
        this.dispatch({ type: "sessions/loaded", sessions });
        const selected = this.getState().sessions.activeSessionId;
        const syncedIds = new Set();
        if (selected) {
            if (selected !== previousActive) {
                await this.loadSession(selected);
                return;
            }
            const existingHistory = this.getState().history.bySessionId.get(selected);
            if (!existingHistory?.events?.length) {
                await this.ensureSessionHistory(selected, { force: true }).catch(() => {});
            }
            if (this.activeSessionSubscriptionId !== selected) {
                this.attachActiveSession(selected);
            }
            await this.syncSessionDetail(selected).catch(() => {});
            await this.syncSessionEvents(selected).catch(() => {});
            syncedIds.add(selected);
            const state = this.getState();
            const activeSession = state.sessions.byId[selected] || null;
            if (activeSession?.parentSessionId && typeof this.transport.getSession === "function") {
                const siblingIds = Object.values(state.sessions.byId)
                    .filter((session) => session?.parentSessionId === activeSession.parentSessionId)
                    .map((session) => session.sessionId)
                    .filter((sessionId) => sessionId && sessionId !== selected)
                    .slice(0, 6);
                await Promise.all(siblingIds.map((sessionId) => this.syncSessionDetail(sessionId).catch(() => {})));
                for (const sessionId of siblingIds) syncedIds.add(sessionId);
            }
        }
        await this.syncVisibleSessionDetails(syncedIds).catch(() => {});
        this.ensureInspectorData().catch(() => {});
        this.evictStaleSessionState();
    }

    /**
     * Evict cached orchestration, executionHistory, and file-preview state for sessions
     * that are not the active session and haven't been fetched recently.
     * Keeps memory bounded when hundreds of sessions accumulate.
     */
    evictStaleSessionState() {
        const state = this.getState();
        const activeSessionId = state.sessions.activeSessionId;
        const now = Date.now();
        const STALE_MS = 60_000; // 1 minute
        const MAX_CACHED = 20;

        // Evict stale orchestration stats
        const orchEntries = Object.entries(state.orchestration.bySessionId || {});
        if (orchEntries.length > MAX_CACHED) {
            const toEvict = orchEntries
                .filter(([id, entry]) => id !== activeSessionId && !entry?.loading)
                .sort((a, b) => (a[1]?.fetchedAt || 0) - (b[1]?.fetchedAt || 0))
                .slice(0, orchEntries.length - MAX_CACHED)
                .filter(([, entry]) => (now - (entry?.fetchedAt || 0)) > STALE_MS);
            if (toEvict.length > 0) {
                this.dispatch({ type: "orchestration/evict", sessionIds: toEvict.map(([id]) => id) });
            }
        }

        // Evict stale executionHistory
        const execEntries = Object.entries(state.executionHistory?.bySessionId || {});
        if (execEntries.length > MAX_CACHED) {
            const toEvict = execEntries
                .filter(([id, entry]) => id !== activeSessionId && !entry?.loading)
                .sort((a, b) => (a[1]?.fetchedAt || 0) - (b[1]?.fetchedAt || 0))
                .slice(0, execEntries.length - MAX_CACHED)
                .filter(([, entry]) => (now - (entry?.fetchedAt || 0)) > STALE_MS);
            if (toEvict.length > 0) {
                this.dispatch({ type: "executionHistory/evict", sessionIds: toEvict.map(([id]) => id) });
            }
        }

        // Evict stale file previews (keep entries list, drop preview content)
        const fileEntries = Object.entries(state.files.bySessionId || {});
        if (fileEntries.length > MAX_CACHED) {
            const toEvict = fileEntries
                .filter(([id]) => id !== activeSessionId)
                .slice(0, fileEntries.length - MAX_CACHED);
            if (toEvict.length > 0) {
                this.dispatch({ type: "files/evictPreviews", sessionIds: toEvict.map(([id]) => id) });
            }
        }

        // Evict stale history for non-visible sessions when count is very high
        const historyEntries = [...state.history.bySessionId.entries()];
        if (historyEntries.length > MAX_CACHED * 2) {
            const toEvict = historyEntries
                .filter(([id]) => id !== activeSessionId)
                .slice(0, historyEntries.length - MAX_CACHED * 2)
                .map(([id]) => id);
            if (toEvict.length > 0) {
                this.dispatch({ type: "history/evict", sessionIds: toEvict });
            }
        }
    }

    async syncVisibleSessionDetails(excludedIds = new Set()) {
        if (typeof this.transport.getSession !== "function") return;

        const state = this.getState();
        const layout = computeLegacyLayout(
            {
                width: state.ui.layout.viewportWidth,
                height: state.ui.layout.viewportHeight,
            },
            state.ui.layout.paneAdjust,
            state.ui.promptRows ?? getPromptInputRows(state.ui.prompt),
            state.ui.layout.sessionPaneAdjust,
            state.ui.fullscreenPane,
        );
        const maxRows = this.getSessionListMaxRows(layout);
        const visibleRows = selectVisibleSessionRows(state, maxRows);
        const sessionIds = [...new Set(
            visibleRows
                .map((row) => row.sessionId)
                .filter((sessionId) => sessionId && !excludedIds.has(sessionId)),
        )];
        if (sessionIds.length === 0) return;

        await Promise.all(sessionIds.map((sessionId) => this.syncSessionDetail(sessionId).catch(() => {})));
    }

    async ensureSessionHistory(sessionId, { force = false } = {}) {
        if (!sessionId) return null;
        const existingHistory = this.getState().history.bySessionId.get(sessionId);
        const requestedLimit = Math.max(
            DEFAULT_HISTORY_EVENT_LIMIT,
            Number(existingHistory?.loadedEventLimit ?? DEFAULT_HISTORY_EVENT_LIMIT) || DEFAULT_HISTORY_EVENT_LIMIT,
        );
        if (!force && existingHistory?.events) {
            return existingHistory;
        }
        if (!force && this.sessionHistoryLoads.has(sessionId)) {
            return this.sessionHistoryLoads.get(sessionId);
        }

        const loadPromise = (async () => {
            const events = await this.transport.getSessionEvents(sessionId, undefined, requestedLimit);
            const history = {
                ...buildHistoryModel(events, { requestedLimit }),
                lastSeq: events[events.length - 1]?.seq || 0,
            };
            this.dispatch({
                type: "history/set",
                sessionId,
                history,
            });
            const derivedModel = extractSessionModelFromEvents(events);
            const currentSession = this.getState().sessions.byId[sessionId] || { sessionId };
            const derivedContextUsage = extractSessionContextUsageFromEvents(currentSession.contextUsage, events);
            if (derivedModel || derivedContextUsage) {
                this.dispatch({
                    type: "sessions/merged",
                    session: {
                        sessionId,
                        ...(derivedModel ? { model: derivedModel } : {}),
                        ...(derivedContextUsage ? { contextUsage: derivedContextUsage } : {}),
                    },
                });
            }
            return history;
        })()
            .finally(() => {
                this.sessionHistoryLoads.delete(sessionId);
            });

        this.sessionHistoryLoads.set(sessionId, loadPromise);
        return loadPromise;
    }

    async ensureInspectorData(targetTab = this.getState().ui.inspectorTab) {
        if (targetTab === "sequence") {
            const activeSessionId = this.getState().sessions.activeSessionId;
            if (!activeSessionId) return;
            await this.ensureSessionHistory(activeSessionId).catch(() => {});
            await this.ensureOrchestrationStats(activeSessionId).catch(() => {});
            return;
        }
        if (targetTab === "nodes") {
            // Only fetch history for visible session rows — not the entire catalog.
            // With hundreds of sessions, fetching all of them every 4s causes unbounded memory growth.
            const state = this.getState();
            const layout = computeLegacyLayout(
                {
                    width: state.ui.layout.viewportWidth,
                    height: state.ui.layout.viewportHeight,
                },
                state.ui.layout.paneAdjust,
                state.ui.promptRows ?? getPromptInputRows(state.ui.prompt),
                state.ui.layout.sessionPaneAdjust,
                state.ui.fullscreenPane,
            );
            const maxRows = this.getSessionListMaxRows(layout);
            const visibleRows = selectVisibleSessionRows(state, maxRows);
            const sessionIds = [...new Set(
                visibleRows
                    .map((row) => row.sessionId)
                    .filter(Boolean),
            )];
            if (sessionIds.length === 0) return;
            await Promise.allSettled(sessionIds.map((sessionId) => this.ensureSessionHistory(sessionId)));
            return;
        }
        if (targetTab === "files") {
            await this.ensureFilesForScope(selectFilesScope(this.getState()));
        }
        if (targetTab === "history") {
            const activeSessionId = this.getState().sessions.activeSessionId;
            const current = activeSessionId
                ? this.getState().executionHistory?.bySessionId?.[activeSessionId] || null
                : null;
            if (activeSessionId && !current) {
                await this.ensureExecutionHistory(activeSessionId);
            }
        }
        if (targetTab === "stats") {
            await this.ensureSessionStats().catch(() => {});
            await this.ensureFleetStats().catch(() => {});
        }
    }

    async ensureOrchestrationStats(sessionId, { force = false } = {}) {
        if (!sessionId || typeof this.transport.getOrchestrationStats !== "function") return null;

        const current = this.getState().orchestration.bySessionId?.[sessionId] || null;
        const now = Date.now();
        if (!force && current?.loading) return current;
        if (
            !force
            && current
            && Number.isFinite(current.fetchedAt)
            && (now - current.fetchedAt) < ORCHESTRATION_STATS_REFRESH_MS
        ) {
            return current;
        }
        if (!force && this.sessionOrchestrationStatsLoads.has(sessionId)) {
            return this.sessionOrchestrationStatsLoads.get(sessionId);
        }

        this.dispatch({ type: "orchestration/statsLoading", sessionId });
        const loadPromise = (async () => {
            try {
                const stats = await this.transport.getOrchestrationStats(sessionId);
                this.dispatch({
                    type: "orchestration/statsLoaded",
                    sessionId,
                    stats,
                    fetchedAt: Date.now(),
                });
                return this.getState().orchestration.bySessionId?.[sessionId] || null;
            } catch (error) {
                this.dispatch({
                    type: "orchestration/statsError",
                    sessionId,
                    error: error?.message || String(error),
                    fetchedAt: Date.now(),
                });
                return null;
            }
        })().finally(() => {
            this.sessionOrchestrationStatsLoads.delete(sessionId);
        });
        this.sessionOrchestrationStatsLoads.set(sessionId, loadPromise);
        return loadPromise;
    }

    async ensureSessionStats({ force = false } = {}) {
        const sessionId = this.getState().sessions.activeSessionId;
        if (!sessionId || typeof this.transport.getSessionMetricSummary !== "function") return;

        const current = this.getState().sessionStats?.bySessionId?.[sessionId] || null;
        const now = Date.now();
        if (!force && current?.loading) return;
        if (!force && current && Number.isFinite(current.fetchedAt) && (now - current.fetchedAt) < SESSION_STATS_REFRESH_MS) return;

        this.dispatch({ type: "sessionStats/loading", sessionId });
        try {
            const [summary, treeStats, skillUsage, treeSkillUsage, factsStats, treeFactsStats] = await Promise.all([
                this.transport.getSessionMetricSummary(sessionId),
                typeof this.transport.getSessionTreeStats === "function"
                    ? this.transport.getSessionTreeStats(sessionId)
                    : null,
                typeof this.transport.getSessionSkillUsage === "function"
                    ? this.transport.getSessionSkillUsage(sessionId).catch(() => null)
                    : null,
                typeof this.transport.getSessionTreeSkillUsage === "function"
                    ? this.transport.getSessionTreeSkillUsage(sessionId).catch(() => null)
                    : null,
                typeof this.transport.getSessionFactsStats === "function"
                    ? this.transport.getSessionFactsStats(sessionId).catch(() => null)
                    : null,
                typeof this.transport.getSessionTreeFactsStats === "function"
                    ? this.transport.getSessionTreeFactsStats(sessionId).catch(() => null)
                    : null,
            ]);
            this.dispatch({ type: "sessionStats/loaded", sessionId, summary, treeStats, skillUsage, treeSkillUsage, factsStats, treeFactsStats });
        } catch {
            this.dispatch({ type: "sessionStats/loaded", sessionId, summary: null, treeStats: null, skillUsage: null, treeSkillUsage: null, factsStats: null, treeFactsStats: null });
        }
    }

    async ensureFleetStats({ force = false } = {}) {
        if (typeof this.transport.getFleetStats !== "function") return;

        const current = this.getState().fleetStats;
        const now = Date.now();
        if (!force && current?.loading) return;
        if (!force && current?.data && Number.isFinite(current.fetchedAt) && (now - current.fetchedAt) < FLEET_STATS_REFRESH_MS) return;

        this.dispatch({ type: "fleetStats/loading" });
        try {
            const since = new Date(Date.now() - FLEET_STATS_DEFAULT_WINDOW_DAYS * 86400_000);
            // Include soft-deleted sessions in the rolling window so the
            // aggregates reflect work that *happened* in the last 30 days,
            // not just sessions that still exist. Deleted-but-recent
            // sessions are still part of the operator's reality (cost,
            // tokens, skill usage) until the underlying rows are pruned.
            const fleetOpts = { since, includeDeleted: true };
            const [data, userStats, skillUsage, sharedFactsStats] = await Promise.all([
                this.transport.getFleetStats(fleetOpts),
                typeof this.transport.getUserStats === "function"
                    ? this.transport.getUserStats(fleetOpts).catch(() => null)
                    : null,
                typeof this.transport.getFleetSkillUsage === "function"
                    ? this.transport.getFleetSkillUsage(fleetOpts).catch(() => null)
                    : null,
                typeof this.transport.getSharedFactsStats === "function"
                    ? this.transport.getSharedFactsStats().catch(() => null)
                    : null,
            ]);
            this.dispatch({ type: "fleetStats/loaded", data, userStats, skillUsage, sharedFactsStats });
        } catch {
            this.dispatch({ type: "fleetStats/loaded", data: null, userStats: null, skillUsage: null, sharedFactsStats: null });
        }
    }

    async ensureExecutionHistory(sessionId, { force = false } = {}) {
        if (!sessionId || typeof this.transport.getExecutionHistory !== "function") return null;
        const current = this.getState().executionHistory?.bySessionId?.[sessionId] || null;
        const now = Date.now();
        if (!force && current?.loading) return current;
        if (!force && current && Number.isFinite(current.fetchedAt) && (now - current.fetchedAt) < 15_000) {
            return current;
        }
        this.dispatch({ type: "executionHistory/loading", sessionId });
        try {
            const events = await this.transport.getExecutionHistory(sessionId);
            this.dispatch({
                type: "executionHistory/loaded",
                sessionId,
                events: events || [],
                fetchedAt: Date.now(),
            });
        } catch (error) {
            console.error("[executionHistory] fetch error:", error?.message || error);
            this.dispatch({
                type: "executionHistory/error",
                sessionId,
                error: error?.message || String(error),
                fetchedAt: Date.now(),
            });
        }
        return this.getState().executionHistory?.bySessionId?.[sessionId] || null;
    }

    async ensureFilesForScope(scope = selectFilesScope(this.getState()), { force = false } = {}) {
        const sessionIds = selectFileSessionIdsForScope(this.getState(), scope);
        if (sessionIds.length === 0) {
            return scope === "allSessions" ? [] : null;
        }
        if (scope === "allSessions" || sessionIds.length > 1) {
            return Promise.allSettled(sessionIds.map((sessionId) => this.ensureFilesForSession(sessionId, { force })));
        }
        return this.ensureFilesForSession(sessionIds[0], { force });
    }

    async ensureSelectedFilePreview() {
        const selectedItem = selectSelectedFileBrowserItem(this.getState());
        if (!selectedItem?.sessionId || !selectedItem?.filename) return null;
        return this.ensureFilePreview(selectedItem.sessionId, selectedItem.filename).catch(() => null);
    }

    async ensureFilesForSession(sessionId, { force = false } = {}) {
        if (!sessionId || typeof this.transport.listArtifacts !== "function") return null;

        const current = this.getState().files.bySessionId[sessionId];
        if (!force && current?.loading) return current;
        if (!force && current?.loaded) {
            if (current.selectedFilename) {
                await this.ensureFilePreview(sessionId, current.selectedFilename).catch(() => {});
            }
            return current;
        }

        this.dispatch({ type: "files/sessionLoading", sessionId });
        try {
            const entries = await this.transport.listArtifacts(sessionId);
            this.dispatch({
                type: "files/sessionLoaded",
                sessionId,
                entries,
            });
            const nextState = this.getState().files.bySessionId[sessionId];
            if (nextState?.selectedFilename) {
                await this.ensureFilePreview(sessionId, nextState.selectedFilename).catch(() => {});
            }
            return nextState;
        } catch (error) {
            this.dispatch({
                type: "files/sessionError",
                sessionId,
                error: error?.message || String(error),
            });
            return null;
        }
    }

    async ensureFilePreview(sessionId, filename, { force = false } = {}) {
        if (!sessionId || !filename || typeof this.transport.downloadArtifact !== "function") return null;

        const current = this.getState().files.bySessionId[sessionId];
        const preview = current?.previews?.[filename];
        let entry = findArtifactEntry(current?.entries, filename);
        if (!force && preview?.loading) return preview;
        if (!force && preview && (preview.content !== undefined || preview.error)) {
            return preview;
        }

        if (!entry && typeof this.transport.getArtifactMetadata === "function") {
            try {
                entry = await this.transport.getArtifactMetadata(sessionId, filename);
            } catch {
                entry = null;
            }
        }

        this.dispatch({ type: "files/previewLoading", sessionId, filename });
        try {
            const previewPayload = entry?.isBinary === true
                ? normalizePreviewPayload(filename, "", entry.contentType || "", entry)
                : normalizePreviewPayload(
                    filename,
                    await this.transport.downloadArtifact(sessionId, filename),
                    entry?.contentType || "",
                    entry,
                );
            this.dispatch({
                type: "files/previewLoaded",
                sessionId,
                filename,
                ...previewPayload,
            });
            return previewPayload;
        } catch (error) {
            this.dispatch({
                type: "files/previewError",
                sessionId,
                filename,
                error: error?.message || String(error),
            });
            return null;
        }
    }

    buildArtifactPickerItems(artifactLinks = [], httpLinks = []) {
        const items = (artifactLinks || []).map((link) => ({
            id: `${link.sessionId}/${link.filename}`,
            kind: "artifact",
            sessionId: link.sessionId,
            filename: link.filename,
        }));

        for (const link of httpLinks || []) {
            const href = String(link?.href || "").trim();
            if (!href) continue;
            items.push({
                id: `url:${href}`,
                kind: "url",
                href,
                text: String(link?.text || href).trim() || href,
            });
        }

        if ((artifactLinks || []).length > 1) {
            items.push({
                id: "__downloadAll__",
                kind: "downloadAll",
            });
        }

        return items;
    }

    buildArtifactPickerModal({ artifactLinks, httpLinks, previousFocus, selectedId } = {}) {
        const items = this.buildArtifactPickerItems(artifactLinks, httpLinks);
        if (items.length === 0) return null;
        const selectedIndex = items.findIndex((item) => item.id === selectedId);

        return {
            type: "artifactPicker",
            title: "Linked Items",
            previousFocus,
            artifactLinks,
            httpLinks,
            items,
            selectedIndex: selectedIndex >= 0 ? selectedIndex : 0,
            exportDirectory: typeof this.transport.getArtifactExportDirectory === "function"
                ? this.transport.getArtifactExportDirectory()
                : null,
        };
    }

    getArtifactPickerSelectionId() {
        const modal = this.getState().ui.modal;
        if (!modal || modal.type !== "artifactPicker") return null;
        return modal.items?.[modal.selectedIndex || 0]?.id || null;
    }

    replaceArtifactPickerModal(selectedId = null) {
        const modal = this.getState().ui.modal;
        if (!modal || modal.type !== "artifactPicker") return;

        const nextModal = this.buildArtifactPickerModal({
            artifactLinks: modal.artifactLinks || [],
            httpLinks: modal.httpLinks || [],
            previousFocus: modal.previousFocus,
            selectedId: selectedId || this.getArtifactPickerSelectionId(),
        });

        if (!nextModal) {
            this.dispatch({ type: "ui/modal", modal: null });
            this.dispatch({ type: "ui/status", text: "No linked artifacts or URLs in the current chat view" });
            return;
        }

        this.dispatch({ type: "ui/modal", modal: nextModal });
    }

    async saveArtifactDownload(sessionId, filename) {
        if (typeof this.transport.saveArtifactDownload !== "function") {
            this.dispatch({ type: "ui/status", text: "Artifact download is not supported by this transport" });
            return null;
        }

        try {
            const download = await this.transport.saveArtifactDownload(sessionId, filename);
            this.dispatch({
                type: "files/downloaded",
                sessionId,
                filename,
                localPath: download?.localPath || "",
                downloadedAt: Date.now(),
            });
            const activeSessionId = this.getState().sessions.activeSessionId;
            const shouldRefreshFiles = sessionId === activeSessionId || this.getState().ui.inspectorTab === "files";
            if (shouldRefreshFiles) {
                await this.ensureFilesForSession(sessionId, { force: true }).catch(() => null);
                if (sessionId === activeSessionId) {
                    this.dispatch({
                        type: "files/select",
                        sessionId,
                        filename,
                    });
                    if (this.getState().ui.inspectorTab === "files") {
                        await this.ensureFilePreview(sessionId, filename, { force: true }).catch(() => null);
                    }
                }
            }
            return download;
        } catch (error) {
            this.dispatch({
                type: "ui/status",
                text: `Download failed: ${error?.message || String(error)}`,
            });
            return null;
        }
    }

    async openSelectedFileInDefaultApp() {
        const state = this.getState();
        const selectedItem = selectSelectedFileBrowserItem(state);
        if (!selectedItem?.sessionId || !selectedItem?.filename) {
            this.dispatch({
                type: "ui/status",
                text: state.sessions.activeSessionId || selectFilesScope(state) === "allSessions"
                    ? "No file selected"
                    : "No session selected",
            });
            return;
        }
        const { sessionId, filename: selectedFilename } = selectedItem;
        const scope = selectFilesScope(state);
        if (typeof this.transport.openPathInDefaultApp !== "function") {
            this.dispatch({ type: "ui/status", text: "Opening files in the default app is not supported by this transport" });
            return;
        }

        let localPath = state.files.bySessionId[sessionId]?.downloads?.[selectedFilename]?.localPath || null;
        if (!localPath) {
            this.dispatch({
                type: "ui/status",
                text: `Downloading ${selectedFilename} to open it...`,
            });
            const download = await this.saveArtifactDownload(sessionId, selectedFilename);
            localPath = download?.localPath || null;
        }

        if (!localPath) {
            this.dispatch({
                type: "ui/status",
                text: `Open failed: could not save ${selectedFilename} locally`,
            });
            return;
        }

        try {
            await this.transport.openPathInDefaultApp(localPath);
            this.dispatch({
                type: "ui/status",
                text: scope === "allSessions"
                    ? `Opened ${shortSessionIdValue(sessionId)} ${selectedFilename} in the default app`
                    : `Opened ${selectedFilename} in the default app`,
            });
        } catch (error) {
            this.dispatch({
                type: "ui/status",
                text: `Open failed: ${error?.message || String(error)}`,
            });
        }
    }

    async downloadSelectedArtifact() {
        const selectedItem = selectSelectedFileBrowserItem(this.getState());
        if (!selectedItem?.sessionId || !selectedItem?.filename) {
            this.dispatch({ type: "ui/status", text: "No artifact selected" });
            return null;
        }
        this.dispatch({
            type: "ui/status",
            text: `Downloading ${selectedItem.filename}...`,
        });
        const download = await this.saveArtifactDownload(selectedItem.sessionId, selectedItem.filename);
        if (!download?.localPath) return null;
        this.dispatch({
            type: "ui/status",
            text: `Downloaded ${selectedItem.filename}`,
        });
        return download;
    }

    async deleteSelectedArtifact({ confirmed = false } = {}) {
        const state = this.getState();
        const selectedItem = selectSelectedFileBrowserItem(state);
        if (!selectedItem?.sessionId || !selectedItem?.filename) {
            this.dispatch({ type: "ui/status", text: "No artifact selected" });
            return false;
        }

        const scope = selectFilesScope(state);
        const artifactLabel = scope === "allSessions"
            ? `${shortSessionIdValue(selectedItem.sessionId)} ${selectedItem.filename}`
            : selectedItem.filename;

        if (!confirmed) {
            this.dispatch({
                type: "ui/modal",
                modal: {
                    type: "confirm",
                    title: "Delete Artifact",
                    message: `Delete artifact "${artifactLabel}"? This action cannot be undone.`,
                    confirmLabel: "Delete",
                    action: "deleteArtifact",
                    sessionId: selectedItem.sessionId,
                    filename: selectedItem.filename,
                    previousFocus: state.ui.focusRegion,
                },
            });
            return false;
        }

        if (typeof this.transport.deleteArtifact !== "function") {
            this.dispatch({ type: "ui/status", text: "Artifact deletion is not supported by this transport" });
            return false;
        }

        try {
            await this.transport.deleteArtifact(selectedItem.sessionId, selectedItem.filename);
            this.dispatch({
                type: "files/deleted",
                sessionId: selectedItem.sessionId,
                filename: selectedItem.filename,
            });
            await this.ensureFilesForSession(selectedItem.sessionId, { force: true }).catch(() => null);
            const nextSelectedItem = selectSelectedFileBrowserItem(this.getState());
            if (nextSelectedItem?.sessionId && nextSelectedItem?.filename) {
                await this.ensureFilePreview(nextSelectedItem.sessionId, nextSelectedItem.filename).catch(() => null);
            }
            this.dispatch({
                type: "ui/status",
                text: scope === "allSessions"
                    ? `Deleted ${shortSessionIdValue(selectedItem.sessionId)} ${selectedItem.filename}`
                    : `Deleted ${selectedItem.filename}`,
            });
            return true;
        } catch (error) {
            this.dispatch({
                type: "ui/status",
                text: `Delete failed: ${error?.message || String(error)}`,
            });
            return false;
        }
    }

    async openArtifactPicker() {
        const state = this.getState();
        const activeSessionId = state.sessions.activeSessionId;
        if (!activeSessionId) {
            this.dispatch({ type: "ui/status", text: "No session selected" });
            return;
        }

        const artifactLinks = selectActiveArtifactLinks(state);
        const httpLinks = selectActiveHttpLinks(state);
        if (artifactLinks.length === 0 && httpLinks.length === 0) {
            this.dispatch({ type: "ui/status", text: "No linked artifacts or URLs in the current chat view" });
            return;
        }

        const preferredSelectedFilename = this.getState().files.bySessionId[activeSessionId]?.selectedFilename || null;
        const preferredSelectedId = preferredSelectedFilename
            ? `${activeSessionId}/${preferredSelectedFilename}`
            : null;
        const nextModal = this.buildArtifactPickerModal({
            artifactLinks,
            httpLinks,
            previousFocus: state.ui.focusRegion,
            selectedId: preferredSelectedId,
        });

        if (!nextModal) {
            this.dispatch({ type: "ui/status", text: "No linked artifacts or URLs in the current chat view" });
            return;
        }

        this.dispatch({ type: "ui/modal", modal: nextModal });
        this.dispatch({ type: "ui/status", text: "Select a linked item and press Enter to open or download it" });
    }

    async downloadArtifactModalSelection() {
        const modal = this.getState().ui.modal;
        if (!modal || modal.type !== "artifactPicker") return;

        const selectedItem = modal.items?.[modal.selectedIndex || 0];
        if (!selectedItem) return;

        if (selectedItem.kind === "url") {
            if (typeof this.transport.openUrlInDefaultBrowser !== "function") {
                this.dispatch({ type: "ui/status", text: "Opening URLs is not supported by this transport" });
                return;
            }

            this.dispatch({
                type: "ui/status",
                text: `Opening ${selectedItem.href}...`,
            });
            await this.transport.openUrlInDefaultBrowser(selectedItem.href);
            this.replaceArtifactPickerModal(selectedItem.id);
            this.dispatch({
                type: "ui/status",
                text: `Opened ${selectedItem.href}`,
            });
            return;
        }

        if (selectedItem.kind === "downloadAll") {
            const pending = (modal.items || []).filter((item) => {
                if (item.kind !== "artifact") return false;
                const download = this.getState().files.bySessionId[item.sessionId]?.downloads?.[item.filename];
                return !download?.localPath;
            });

            if (pending.length === 0) {
                this.dispatch({ type: "ui/status", text: "All artifacts already downloaded" });
                return;
            }

            this.dispatch({
                type: "ui/status",
                text: `Downloading ${pending.length} artifacts...`,
            });

            let downloadedCount = 0;
            for (const item of pending) {
                const download = await this.saveArtifactDownload(item.sessionId, item.filename);
                if (download?.localPath) downloadedCount += 1;
            }

            this.replaceArtifactPickerModal(selectedItem.id);
            this.dispatch({
                type: "ui/status",
                text: `Downloaded ${downloadedCount}/${pending.length} artifacts`,
            });
            return;
        }

        this.dispatch({
            type: "ui/status",
            text: `Downloading ${selectedItem.filename}...`,
        });
        const download = await this.saveArtifactDownload(selectedItem.sessionId, selectedItem.filename);
        if (!download?.localPath) return;

        this.replaceArtifactPickerModal(selectedItem.id);
        this.dispatch({
            type: "ui/status",
            text: `Downloaded ${selectedItem.filename}`,
        });
    }

    async moveFileSelection(delta) {
        const scope = selectFilesScope(this.getState());
        await this.ensureFilesForScope(scope);
        const items = selectFileBrowserItems(this.getState());
        if (items.length === 0) return;

        const currentItem = selectSelectedFileBrowserItem(this.getState()) || items[0];
        const currentIndex = Math.max(0, items.findIndex((item) => item.id === currentItem?.id));
        const nextIndex = Math.max(0, Math.min(items.length - 1, currentIndex + delta));
        const nextItem = items[nextIndex];
        if (!nextItem?.sessionId || !nextItem?.filename) return;

        if (scope === "allSessions") {
            this.dispatch({
                type: "files/selectGlobal",
                artifactId: nextItem.id,
            });
        } else {
            this.dispatch({
                type: "files/select",
                sessionId: nextItem.sessionId,
                filename: nextItem.filename,
            });
        }
        await this.ensureFilePreview(nextItem.sessionId, nextItem.filename).catch(() => {});
        this.dispatch({
            type: "ui/status",
            text: scope === "allSessions"
                ? `Previewing ${shortSessionIdValue(nextItem.sessionId)} ${nextItem.filename}`
                : `Previewing ${nextItem.filename}`,
        });
    }

    async selectFileBrowserItem(item) {
        if (!item?.sessionId || !item?.filename) return;
        const scope = selectFilesScope(this.getState());
        if (scope === "allSessions") {
            this.dispatch({
                type: "files/selectGlobal",
                artifactId: item.id,
            });
        } else {
            this.dispatch({
                type: "files/select",
                sessionId: item.sessionId,
                filename: item.filename,
            });
        }
        await this.ensureFilePreview(item.sessionId, item.filename).catch(() => {});
        this.dispatch({
            type: "ui/status",
            text: scope === "allSessions"
                ? `Previewing ${shortSessionIdValue(item.sessionId)} ${item.filename}`
                : `Previewing ${item.filename}`,
        });
    }

    toggleFilePreviewFullscreen() {
        const state = this.getState();
        const sessionId = state.sessions.activeSessionId;
        if (!sessionId) {
            this.dispatch({ type: "ui/status", text: "No session selected" });
            return;
        }
        const fileState = state.files.bySessionId[sessionId];
        const isCurrentlyFullscreen = Boolean(state.files.fullscreen);
        // Allow exiting fullscreen unconditionally. Block entering it
        // when no file is selected — but tell the user *why* the button
        // appeared to do nothing instead of failing silently.
        if (!isCurrentlyFullscreen && !fileState?.selectedFilename) {
            this.dispatch({
                type: "ui/status",
                text: "Select a file before entering fullscreen",
            });
            return;
        }
        const nextFullscreen = !isCurrentlyFullscreen;
        this.dispatch({
            type: "files/fullscreen",
            fullscreen: nextFullscreen,
        });
        this.dispatch({
            type: "ui/status",
            text: nextFullscreen
                ? `Fullscreen files browser: ${fileState?.selectedFilename || ""}`
                : `Closed fullscreen files browser`,
        });
    }

    toggleFocusedPaneFullscreen() {
        const state = this.getState();
        const focusRegion = state.ui.focusRegion;
        const currentFullscreenPane = state.ui.fullscreenPane || null;
        const targetPane = focusRegion === FOCUS_REGIONS.PROMPT
            ? currentFullscreenPane
            : focusRegion;
        if (!FULLSCREENABLE_PANES.has(targetPane)) return;
        if (targetPane === FOCUS_REGIONS.INSPECTOR && state.ui.inspectorTab === "files") return;

        const nextFullscreenPane = currentFullscreenPane === targetPane ? null : targetPane;
        this.dispatch({
            type: "ui/fullscreenPane",
            fullscreenPane: nextFullscreenPane,
        });
        this.dispatch({
            type: "ui/status",
            text: nextFullscreenPane
                ? `Fullscreen ${targetPane} pane`
                : `Closed fullscreen ${targetPane} pane`,
        });
        if (!nextFullscreenPane && focusRegion === FOCUS_REGIONS.PROMPT) {
            this.setFocus(targetPane);
        }
    }

    openFilesFilter() {
        const scope = selectFilesScope(this.getState());
        this.dispatch({
            type: "ui/modal",
            modal: {
                type: "filesFilter",
                title: "Files Filter",
                previousFocus: this.getState().ui.focusRegion,
                selectedIndex: 0,
                items: [
                    {
                        id: "scope",
                        label: "Scope",
                        description: "Choose whether the files browser shows the selected session tree or aggregates exported files across all sessions.",
                        options: [
                            { id: "selectedSession", label: "Selected session tree" },
                            { id: "allSessions", label: "All sessions" },
                        ],
                    },
                ],
            },
        });
        this.dispatch({
            type: "ui/status",
            text: `Editing files filter: Scope = ${scope === "allSessions" ? "All sessions" : "Selected session tree"}`,
        });
    }

    async loadSession(sessionId) {
        if (!sessionId) return;
        const active = this.getState().sessions.activeSessionId;
        if (active !== sessionId) {
            this.dispatch({ type: "sessions/selected", sessionId });
        }
        await this.ensureSessionHistory(sessionId, { force: true });
        await this.syncSessionDetail(sessionId).catch(() => {});
        this.attachActiveSession(sessionId);
        this.ensureInspectorData().catch(() => {});
    }

    mergeSessionEvent(sessionId, event) {
        if (!sessionId || !event) return false;
        const state = this.getState();
        const existing = state.history.bySessionId.get(sessionId) || { chat: [], activity: [], lastSeq: 0 };
        if (event.seq <= (existing.lastSeq || 0)) return false;
        this.dispatch({
            type: "history/set",
            sessionId,
            history: appendEventToHistory(existing, event),
        });
        const derivedModel = extractSessionModelFromEvent(event);
        const currentSession = this.getState().sessions.byId[sessionId] || { sessionId };
        const derivedContextUsage = applySessionUsageEvent(currentSession.contextUsage, event.eventType, event.data, {
            timestamp: event.createdAt,
        });
        if (derivedModel || derivedContextUsage) {
            this.dispatch({
                type: "sessions/merged",
                session: {
                    sessionId,
                    ...(derivedModel ? { model: derivedModel } : {}),
                    ...(derivedContextUsage ? { contextUsage: derivedContextUsage } : {}),
                },
            });
        }
        this.scheduleSessionDetailSync(sessionId);
        return true;
    }

    async syncSessionEvents(sessionId) {
        if (!sessionId || typeof this.transport.getSessionEvents !== "function") return;
        const existing = this.getState().history.bySessionId.get(sessionId);
        if (!existing?.events) {
            await this.ensureSessionHistory(sessionId, { force: true });
            return;
        }
        const afterSeq = Number(existing.lastSeq || 0);
        const events = await this.transport.getSessionEvents(sessionId, afterSeq, 200);
        if (!Array.isArray(events) || events.length === 0) return;
        for (const event of events) {
            this.mergeSessionEvent(sessionId, event);
        }
    }

    attachActiveSession(sessionId) {
        if (this.activeSessionSubscriptionId === sessionId && this.activeSessionUnsub) {
            return;
        }
        this.detachActiveSession();
        this.activeSessionSubscriptionId = sessionId;
        this.activeSessionUnsub = this.transport.subscribeSession(sessionId, (event) => {
            this.mergeSessionEvent(sessionId, event);
        });
        this.syncSessionEvents(sessionId).catch(() => {});
    }

    scheduleSessionDetailSync(sessionId, delayMs = 250) {
        if (typeof this.transport.getSession !== "function" || !sessionId) return;
        if (this.activeSessionDetailTimer) clearTimeout(this.activeSessionDetailTimer);
        this.activeSessionDetailSessionId = sessionId;
        this.activeSessionDetailTimer = setTimeout(() => {
            const targetSessionId = this.activeSessionDetailSessionId;
            this.activeSessionDetailTimer = null;
            this.activeSessionDetailSessionId = null;
            this.syncSessionDetail(targetSessionId).catch(() => {});
        }, delayMs);
    }

    scheduleSessionsRefresh(delayMs = 0) {
        if (this.sessionRefreshTimer) clearTimeout(this.sessionRefreshTimer);
        this.sessionRefreshTimer = setTimeout(() => {
            this.sessionRefreshTimer = null;
            this.refreshSessions().catch(() => {});
        }, Math.max(0, delayMs));
    }

    async syncSessionDetail(sessionId) {
        if (typeof this.transport.getSession !== "function" || !sessionId) return;
        const session = await this.transport.getSession(sessionId);
        if (!session) return;
        const previousSession = this.getState().sessions.byId[sessionId] || null;
        const patch = buildSessionMergePatch(previousSession, session);
        if (!patch) return;
        this.dispatch({ type: "sessions/merged", session: patch });
    }

    async createSession(options = {}) {
        const created = await this.transport.createSession(options);
        await this.refreshSessions();
        await this.loadSession(created.sessionId);
        this.setFocus(FOCUS_REGIONS.PROMPT);
        this.dispatch({ type: "ui/status", text: `Created session ${created.sessionId.slice(0, 8)}` });
    }

    async createSessionForAgent(agentName, options = {}) {
        if (typeof this.transport.createSessionForAgent !== "function") {
            throw new Error("Named-agent session creation is not supported by this transport");
        }
        const created = await this.transport.createSessionForAgent(agentName, options);
        await this.refreshSessions();
        await this.loadSession(created.sessionId);
        this.setFocus(FOCUS_REGIONS.PROMPT);
        this.dispatch({
            type: "ui/status",
            text: `Created ${formatAgentDisplayTitle(agentName, options.title)} session ${created.sessionId.slice(0, 8)}`,
        });
    }

    async openSessionAgentPicker(options = {}) {
        const agents = typeof this.transport.listCreatableAgents === "function"
            ? await this.transport.listCreatableAgents()
            : [];
        const sessionPolicy = typeof this.transport.getSessionCreationPolicy === "function"
            ? this.transport.getSessionCreationPolicy()
            : null;
        const allowGeneric = sessionPolicy?.creation?.allowGeneric ?? true;

        if (!Array.isArray(agents) || agents.length === 0) {
            if (!allowGeneric) {
                this.dispatch({
                    type: "ui/status",
                    text: "No user-creatable agents are available for this app",
                });
                return;
            }
            await this.createSession(options);
            return;
        }

        const items = [];
        if (allowGeneric) {
            items.push({
                id: "__generic__",
                kind: "generic",
                title: "Generic Session",
                description: "Open-ended session with no specialized agent boundary.",
                tools: [],
                splash: null,
                initialPrompt: null,
            });
        }

        for (const agent of agents) {
            const agentName = String(agent?.name || "").trim();
            if (!agentName) continue;
            items.push({
                id: agentName,
                kind: "agent",
                agentName,
                title: formatAgentDisplayTitle(agentName, agent?.title),
                description: String(agent?.description || "").trim(),
                tools: Array.isArray(agent?.tools) ? agent.tools.filter(Boolean) : [],
                splash: typeof agent?.splash === "string" && agent.splash.trim() ? agent.splash : null,
                initialPrompt: typeof agent?.initialPrompt === "string" && agent.initialPrompt.trim() ? agent.initialPrompt : null,
            });
        }

        this.dispatch({
            type: "ui/modal",
            modal: {
                type: "sessionAgentPicker",
                title: "Select agent for new session",
                items,
                selectedIndex: 0,
                previousFocus: this.getState().ui.focusRegion,
                sessionOptions: options,
            },
        });
        this.dispatch({ type: "ui/status", text: "Select an agent and press Enter" });
    }

    async openNewSessionFlow(options = {}) {
        await this.openSessionAgentPicker(options);
    }

    async openModelPicker() {
        if (typeof this.transport.listModels !== "function") {
            await this.openNewSessionFlow();
            return;
        }

        const models = await this.transport.listModels();
        if (!Array.isArray(models) || models.length === 0) {
            this.dispatch({ type: "ui/status", text: "No models available" });
            return;
        }

        const defaultModel = typeof this.transport.getDefaultModel === "function"
            ? this.transport.getDefaultModel()
            : undefined;
        const groupedModels = typeof this.transport.getModelsByProvider === "function"
            ? this.transport.getModelsByProvider()
            : groupModelsByProvider(models);
        const items = [];
        const groups = groupedModels
            .map((group) => ({
                providerId: group.providerId,
                providerType: group.type || group.providerType,
                models: (group.models || []).map((model) => {
                    const item = {
                        id: model.qualifiedName,
                        qualifiedName: model.qualifiedName,
                        modelName: model.modelName || model.qualifiedName,
                        providerId: model.providerId || group.providerId,
                        providerType: model.providerType || group.type || group.providerType,
                        description: model.description || "",
                        cost: model.cost || null,
                        isDefault: defaultModel === model.qualifiedName,
                    };
                    items.push(item);
                    return item;
                }),
            }))
            .filter((group) => group.models.length > 0);

        const selectedIndex = Math.max(0, items.findIndex((model) => model.qualifiedName === defaultModel));
        this.dispatch({
            type: "ui/modal",
            modal: {
                type: "modelPicker",
                title: "Select model for new session",
                items,
                groups,
                selectedIndex,
                previousFocus: this.getState().ui.focusRegion,
            },
        });
        this.dispatch({ type: "ui/status", text: "Select a model and press Enter" });
    }

    openThemePicker() {
        const themes = listThemes().map((theme) => ({
            id: theme.id,
            label: theme.label,
            description: theme.description,
            page: theme.page,
            terminal: theme.terminal,
            tui: theme.tui,
        }));
        if (themes.length === 0) {
            this.dispatch({ type: "ui/status", text: "No themes available" });
            return;
        }

        const currentThemeId = this.getState().ui.themeId;
        const selectedIndex = Math.max(0, themes.findIndex((theme) => theme.id === currentThemeId));
        this.dispatch({
            type: "ui/modal",
            modal: {
                type: "themePicker",
                title: "Theme Picker",
                items: themes,
                selectedIndex,
                previousFocus: this.getState().ui.focusRegion,
                currentThemeId,
            },
        });
        this.dispatch({ type: "ui/status", text: "Select a theme and press Enter" });
    }

    getPromptDraftSessionId() {
        const promptAttachmentSessionId = this.getPromptAttachments()[0]?.sessionId || null;
        return promptAttachmentSessionId || this.getState().sessions.activeSessionId || null;
    }

    openArtifactUploadModal() {
        if (typeof this.transport.uploadArtifactFromPath !== "function") {
            this.dispatch({ type: "ui/status", text: "Artifact upload is not supported by this transport" });
            return;
        }

        const state = this.getState();
        const sessionId = this.getPromptDraftSessionId();
        this.dispatch({
            type: "ui/modal",
            modal: {
                type: "artifactUpload",
                title: sessionId
                    ? `Upload Artifact (${shortSessionIdValue(sessionId)})`
                    : "Upload Artifact",
                sessionId,
                previousFocus: state.ui.focusRegion,
                value: "",
                cursorIndex: 0,
            },
        });
        this.dispatch({
            type: "ui/status",
            text: sessionId
                ? "Paste a local file path and press Enter to upload it into this session's artifacts"
                : "Paste a local file path and press Enter to upload it; a new session will be created if needed",
        });
    }

    updateArtifactUploadModal(updater) {
        const modal = this.getState().ui.modal;
        if (!modal || modal.type !== "artifactUpload") return null;
        const nextModal = typeof updater === "function" ? updater(modal) : updater;
        if (!nextModal) return null;
        this.dispatch({
            type: "ui/modal",
            modal: {
                ...modal,
                ...nextModal,
            },
        });
        return this.getState().ui.modal;
    }

    setArtifactUploadValue(value, cursorIndex = String(value || "").length) {
        const modal = this.getState().ui.modal;
        if (!modal || modal.type !== "artifactUpload") return;
        const safeValue = String(value || "").replace(/\r?\n/g, "");
        const safeCursor = clampPromptCursor(safeValue, cursorIndex);
        this.updateArtifactUploadModal({
            value: safeValue,
            cursorIndex: safeCursor,
        });
    }

    insertArtifactUploadText(text) {
        const modal = this.getState().ui.modal;
        if (!modal || modal.type !== "artifactUpload") return;
        const next = insertPromptTextAtCursor(modal.value || "", modal.cursorIndex || 0, String(text || "").replace(/\r?\n/g, ""));
        this.setArtifactUploadValue(next.prompt, next.cursor);
    }

    deleteArtifactUploadChar() {
        const modal = this.getState().ui.modal;
        if (!modal || modal.type !== "artifactUpload") return;
        const next = deletePromptCharBackward(modal.value || "", modal.cursorIndex || 0);
        this.setArtifactUploadValue(next.prompt, next.cursor);
    }

    moveArtifactUploadCursor(delta) {
        const modal = this.getState().ui.modal;
        if (!modal || modal.type !== "artifactUpload") return;
        this.setArtifactUploadValue(modal.value || "", clampPromptCursor(modal.value || "", (modal.cursorIndex || 0) + delta));
    }

    moveArtifactUploadCursorToBoundary(kind) {
        const modal = this.getState().ui.modal;
        if (!modal || modal.type !== "artifactUpload") return;
        this.setArtifactUploadValue(modal.value || "", kind === "start" ? 0 : String(modal.value || "").length);
    }

    async ensurePromptAttachmentSessionId() {
        const existingAttachmentSessionId = this.getPromptAttachments()[0]?.sessionId || null;
        if (existingAttachmentSessionId) {
            if (this.getState().sessions.activeSessionId !== existingAttachmentSessionId) {
                await this.loadSession(existingAttachmentSessionId);
            }
            return existingAttachmentSessionId;
        }

        const activeSessionId = this.getState().sessions.activeSessionId;
        if (activeSessionId) return activeSessionId;

        const created = await this.transport.createSession({});
        await this.refreshSessions();
        await this.loadSession(created.sessionId);
        this.setFocus(FOCUS_REGIONS.PROMPT);
        return created.sessionId;
    }

    async finalizeArtifactUpload(upload, { sessionId = null, suppressStatus = false } = {}) {
        const resolvedSessionId = sessionId || upload?.sessionId || await this.ensurePromptAttachmentSessionId();
        if (!resolvedSessionId || !upload?.filename) {
            throw new Error("Upload did not return a session id and filename");
        }

        if (this.getState().sessions.activeSessionId !== resolvedSessionId) {
            await this.loadSession(resolvedSessionId);
        }

        await this.ensureFilesForSession(resolvedSessionId, { force: true }).catch(() => null);
        this.dispatch({
            type: "files/select",
            sessionId: resolvedSessionId,
            filename: upload.filename,
        });
        await this.ensureFilePreview(resolvedSessionId, upload.filename, { force: true }).catch(() => null);

        if (!suppressStatus) {
            this.dispatch({
                type: "ui/status",
                text: `Uploaded ${upload.filename}`,
            });
        }

        return {
            sessionId: resolvedSessionId,
            filename: upload.filename,
        };
    }

    async applyUploadedPromptAttachment(upload, { sessionId = null, suppressStatus = false } = {}) {
        const resolvedSessionId = sessionId || upload?.sessionId || await this.ensurePromptAttachmentSessionId();
        if (!resolvedSessionId || !upload?.filename) {
            throw new Error("Upload did not return a session id and filename");
        }

        const token = buildPromptAttachmentToken(upload.filename);
        const currentPrompt = this.getState().ui.prompt;
        const currentCursor = this.getState().ui.promptCursor;
        const previousAttachments = this.getPromptAttachments();
        const existingAttachmentIndex = previousAttachments.findIndex((attachment) => (
            attachment?.sessionId === resolvedSessionId
            && attachment?.filename === upload.filename
        ));

        if (this.getState().sessions.activeSessionId !== resolvedSessionId) {
            await this.loadSession(resolvedSessionId);
        }

        if (existingAttachmentIndex === -1 || !currentPrompt.includes(previousAttachments[existingAttachmentIndex]?.token || token)) {
            const insertion = insertPromptTextAtCursor(currentPrompt, currentCursor, `${token} `);
            this.setPrompt(insertion.prompt, insertion.cursor);
        }

        const nextAttachments = existingAttachmentIndex >= 0
            ? previousAttachments.map((attachment, index) => (index === existingAttachmentIndex
                ? {
                    ...attachment,
                    sessionId: resolvedSessionId,
                    filename: upload.filename,
                    resolvedPath: upload.resolvedPath || upload.localPath || upload.filename,
                    sizeBytes: upload.sizeBytes,
                    token,
                }
                : attachment))
            : [
                ...previousAttachments,
                {
                    id: `${resolvedSessionId}/${upload.filename}`,
                    sessionId: resolvedSessionId,
                    filename: upload.filename,
                    resolvedPath: upload.resolvedPath || upload.localPath || upload.filename,
                    sizeBytes: upload.sizeBytes,
                    token,
                },
            ];
        this.setPromptAttachments(nextAttachments);

        await this.ensureFilesForSession(resolvedSessionId, { force: true }).catch(() => null);
        this.dispatch({
            type: "files/select",
            sessionId: resolvedSessionId,
            filename: upload.filename,
        });
        if (this.getState().ui.inspectorTab === "files") {
            await this.ensureFilePreview(resolvedSessionId, upload.filename, { force: true }).catch(() => null);
        }

        this.setFocus(FOCUS_REGIONS.PROMPT);
        if (!suppressStatus) {
            this.dispatch({
                type: "ui/status",
                text: existingAttachmentIndex >= 0
                    ? `Re-attached ${upload.filename}`
                    : `Attached ${upload.filename}`,
            });
        }

        return {
            sessionId: resolvedSessionId,
            existingAttachmentIndex,
            token,
        };
    }

    async uploadArtifactFiles(files = [], { sessionId = null } = {}) {
        const fileList = Array.isArray(files)
            ? files.filter((file) => file && typeof file.name === "string")
            : [];
        if (fileList.length === 0) {
            this.dispatch({ type: "ui/status", text: "No files selected" });
            return [];
        }
        if (typeof this.transport.uploadArtifactFromFile !== "function") {
            this.dispatch({ type: "ui/status", text: "Browser file uploads are not supported by this transport" });
            return [];
        }

        this.dispatch({
            type: "ui/status",
            text: fileList.length === 1
                ? `Uploading ${fileList[0].name}...`
                : `Uploading ${fileList.length} artifact files...`,
        });

        const resolvedSessionId = sessionId || await this.ensurePromptAttachmentSessionId();
        const uploads = [];
        let failures = 0;
        let lastError = null;

        for (const file of fileList) {
            try {
                const upload = await this.transport.uploadArtifactFromFile(resolvedSessionId, file);
                uploads.push(upload);
                await this.finalizeArtifactUpload(upload, { sessionId: resolvedSessionId, suppressStatus: true });
            } catch (error) {
                failures += 1;
                lastError = error;
            }
        }

        if (uploads.length > 0) {
            this.dispatch({
                type: "ui/status",
                text: failures > 0
                    ? `Uploaded ${uploads.length}/${fileList.length} file(s); last error: ${lastError?.message || String(lastError)}`
                    : uploads.length === 1
                        ? `Uploaded ${uploads[0].filename}`
                        : `Uploaded ${uploads.length} files`,
            });
        } else if (lastError) {
            this.dispatch({
                type: "ui/status",
                text: `Upload failed: ${lastError?.message || String(lastError)}`,
            });
        }

        return uploads;
    }

    async uploadPromptAttachmentFiles(files = []) {
        return this.uploadArtifactFiles(files);
    }

    async confirmArtifactUploadModal() {
        const modal = this.getState().ui.modal;
        if (!modal || modal.type !== "artifactUpload") return;
        const filePath = String(modal.value || "").trim();
        if (!filePath) {
            this.dispatch({ type: "ui/status", text: "File path cannot be empty" });
            return;
        }
        if (typeof this.transport.uploadArtifactFromPath !== "function") {
            this.dispatch({ type: "ui/status", text: "Artifact upload is not supported by this transport" });
            return;
        }

        this.dispatch({
            type: "ui/status",
            text: "Uploading artifact...",
        });

        try {
            const sessionId = modal.sessionId || await this.ensurePromptAttachmentSessionId();
            const upload = await this.transport.uploadArtifactFromPath(sessionId, filePath);
            const result = await this.finalizeArtifactUpload(upload, { sessionId, suppressStatus: true });
            this.dispatch({ type: "ui/modal", modal: null });
            this.dispatch({
                type: "ui/status",
                text: `Uploaded ${result.filename}`,
            });
        } catch (error) {
            this.dispatch({
                type: "ui/status",
                text: `Upload failed: ${error?.message || String(error)}`,
            });
        }
    }

    openRenameSessionModal() {
        const state = this.getState();
        const sessionId = state.sessions.activeSessionId;
        if (!sessionId) {
            this.dispatch({ type: "ui/status", text: "No session selected" });
            return;
        }

        const session = state.sessions.byId[sessionId];
        if (!session) {
            this.dispatch({ type: "ui/status", text: "No session selected" });
            return;
        }
        if (session.isSystem) {
            this.dispatch({ type: "ui/status", text: "System session titles are fixed" });
            return;
        }

        const value = getRenameSessionEditableTitle(session);
        const agentTitlePrefix = getRenameSessionPrefix(session);
        const maxLength = getRenameSessionMaxLength(session);
        this.dispatch({
            type: "ui/modal",
            modal: {
                type: "renameSession",
                title: `Rename (${shortSessionIdValue(sessionId)})`,
                sessionId,
                previousFocus: state.ui.focusRegion,
                value,
                cursorIndex: value.length,
                agentTitlePrefix,
                currentTitle: String(session.title || "").trim(),
                maxLength,
            },
        });
        this.dispatch({
            type: "ui/status",
            text: agentTitlePrefix
                ? `Rename title for ${agentTitlePrefix}; the agent-name prefix stays fixed`
                : "Type a new session title and press Enter to save",
        });
    }

    /**
     * Open the Terminate picker for the active session. The picker is a
     * tiny three-button modal: Mark Completed / Cancel / Delete. Each
     * choice closes the picker and dispatches the corresponding action
     * command, which itself opens the existing per-action confirm modal.
     * Provides a mobile-friendly entry point to terminal actions that
     * are otherwise only reachable via keyboard shortcuts.
     */
    openTerminatePickerModal() {
        const state = this.getState();
        const sessionId = state.sessions.activeSessionId;
        if (!sessionId) {
            this.dispatch({ type: "ui/status", text: "No session selected" });
            return;
        }
        const session = state.sessions.byId[sessionId];
        if (!session) {
            this.dispatch({ type: "ui/status", text: "No session selected" });
            return;
        }
        if (session.isSystem) {
            this.dispatch({ type: "ui/status", text: "System sessions cannot be terminated from the UI" });
            return;
        }
        this.dispatch({
            type: "ui/modal",
            modal: {
                type: "terminatePicker",
                title: `Terminate (${shortSessionIdValue(sessionId)})`,
                sessionId,
                previousFocus: state.ui.focusRegion,
                sessionTitle: String(session.title || "").trim(),
                state: String(session.state || "").trim(),
            },
        });
    }

    /**
     * Pick one of the three terminate actions. Closes the picker and
     * dispatches the corresponding action command, which will then
     * open the existing per-action confirm modal.
     */
    async pickTerminateAction(action) {
        const modal = this.getState().ui.modal;
        if (!modal || modal.type !== "terminatePicker") return;
        const previousFocus = modal.previousFocus;
        this.dispatch({ type: "ui/modal", modal: null });
        if (previousFocus) this.setFocus(previousFocus);
        if (action === "complete") {
            await this.completeActiveSession();
        } else if (action === "cancel") {
            await this.cancelActiveSession();
        } else if (action === "delete") {
            await this.deleteActiveSession();
        }
    }

    updateRenameSessionModal(updater) {
        const modal = this.getState().ui.modal;
        if (!modal || modal.type !== "renameSession") return null;
        const nextModal = typeof updater === "function" ? updater(modal) : updater;
        if (!nextModal) return null;
        this.dispatch({
            type: "ui/modal",
            modal: {
                ...modal,
                ...nextModal,
            },
        });
        return this.getState().ui.modal;
    }

    setRenameSessionValue(value, cursorIndex = String(value || "").length) {
        const modal = this.getState().ui.modal;
        if (!modal || modal.type !== "renameSession") return;
        const safeValue = clampRenameSessionValue(value, modal.maxLength);
        const safeCursor = clampPromptCursor(safeValue, cursorIndex);
        this.updateRenameSessionModal({
            value: safeValue,
            cursorIndex: safeCursor,
        });
    }

    insertRenameSessionText(text) {
        const modal = this.getState().ui.modal;
        if (!modal || modal.type !== "renameSession") return;
        const next = insertPromptTextAtCursor(modal.value || "", modal.cursorIndex || 0, clampRenameSessionValue(text, modal.maxLength));
        this.setRenameSessionValue(next.prompt, next.cursor);
    }

    deleteRenameSessionChar() {
        const modal = this.getState().ui.modal;
        if (!modal || modal.type !== "renameSession") return;
        const next = deletePromptCharBackward(modal.value || "", modal.cursorIndex || 0);
        this.setRenameSessionValue(next.prompt, next.cursor);
    }

    moveRenameSessionCursor(delta) {
        const modal = this.getState().ui.modal;
        if (!modal || modal.type !== "renameSession") return;
        this.setRenameSessionValue(modal.value || "", clampPromptCursor(modal.value || "", (modal.cursorIndex || 0) + delta));
    }

    moveRenameSessionCursorToBoundary(kind) {
        const modal = this.getState().ui.modal;
        if (!modal || modal.type !== "renameSession") return;
        this.setRenameSessionValue(modal.value || "", kind === "start" ? 0 : String(modal.value || "").length);
    }

    async confirmRenameSessionModal() {
        const modal = this.getState().ui.modal;
        if (!modal || modal.type !== "renameSession") return;
        const sessionId = modal.sessionId;
        if (!sessionId) return;

        const requestedTitle = String(modal.value || "").trim();
        if (!requestedTitle) {
            this.dispatch({ type: "ui/status", text: "Title cannot be empty" });
            return;
        }
        if (typeof this.transport.renameSession !== "function") {
            this.dispatch({ type: "ui/status", text: "Session renaming is not supported by this transport" });
            return;
        }

        const previousFocus = modal.previousFocus;
        this.dispatch({ type: "ui/modal", modal: null });
        if (previousFocus) {
            this.setFocus(previousFocus);
        }

        this.dispatch({
            type: "ui/status",
            text: `Renaming ${shortSessionIdValue(sessionId)}...`,
        });

        try {
            await this.transport.renameSession(sessionId, requestedTitle);
            await this.refreshSessions();
            this.scheduleSessionDetailSync(sessionId, 100);
            this.dispatch({
                type: "ui/status",
                text: `Renamed ${shortSessionIdValue(sessionId)}`,
            });
        } catch (error) {
            this.dispatch({
                type: "ui/status",
                text: `Rename failed: ${error?.message || String(error)}`,
            });
        }
    }

    closeModal() {
        const modal = this.getState().ui.modal;
        if (!modal) return;
        this.dispatch({ type: "ui/modal", modal: null });
        if (modal.previousFocus) {
            this.setFocus(modal.previousFocus);
        }
        this.dispatch({ type: "ui/status", text: "Connected" });
    }

    moveModalSelection(delta) {
        const modal = this.getState().ui.modal;
        if (!modal || !Array.isArray(modal.items) || modal.items.length === 0) return;
        if (modal.type === "logFilter" || modal.type === "filesFilter" || modal.type === "historyFormat") {
            const currentPaneIndex = Math.max(0, Math.min(Number(modal.selectedIndex) || 0, modal.items.length - 1));
            const selected = modal.items[currentPaneIndex];
            if (!selected || !Array.isArray(selected.options) || selected.options.length === 0) return;
            const optionIds = selected.options.map((option) => option.id).filter(Boolean);
            if (optionIds.length === 0) return;
            const currentValue = modal.type === "filesFilter"
                ? this.getState().files.filter?.[selected.id] || optionIds[0]
                : modal.type === "historyFormat"
                    ? this.getState().executionHistory?.format || optionIds[0]
                    : this.getState().logs.filter?.[selected.id] || optionIds[0];
            const nextValue = cycleValue(optionIds, currentValue, delta);
            const nextOption = selected.options.find((option) => option.id === nextValue) || selected.options[0];
            this.dispatch({
                type: modal.type === "filesFilter" ? "files/filter" : modal.type === "historyFormat" ? "executionHistory/format" : "logs/filter",
                filter: modal.type === "historyFormat" ? undefined : { [selected.id]: nextValue },
                ...(modal.type === "historyFormat" ? { format: nextValue } : {}),
            });
            if (modal.type === "filesFilter") {
                this.ensureFilesForScope(nextValue).catch(() => {});
                this.ensureSelectedFilePreview().catch(() => {});
            }
            this.dispatch({
                type: "ui/status",
                text: `${modal.type === "filesFilter" ? "Files" : modal.type === "historyFormat" ? "History" : "Log"} filter updated: ${selected.label} = ${nextOption?.label || nextValue}`,
            });
            return;
        }
        const current = Math.max(0, Number(modal.selectedIndex) || 0);
        const next = Math.max(0, Math.min(current + delta, modal.items.length - 1));
        this.dispatch({ type: "ui/modalSelection", index: next });
    }

    moveModalPane(delta) {
        const modal = this.getState().ui.modal;
        if (!modal || (modal.type !== "logFilter" && modal.type !== "filesFilter" && modal.type !== "historyFormat") || !Array.isArray(modal.items) || modal.items.length === 0) return;
        const current = Math.max(0, Number(modal.selectedIndex) || 0);
        const next = (current + delta + modal.items.length) % modal.items.length;
        const selected = modal.items[next];
        const currentValue = modal.type === "filesFilter"
            ? this.getState().files.filter?.[selected.id] || selected.options?.[0]?.id
            : modal.type === "historyFormat"
                ? this.getState().executionHistory?.format || selected.options?.[0]?.id
                : this.getState().logs.filter?.[selected.id] || selected.options?.[0]?.id;
        const currentOption = selected.options?.find((option) => option.id === currentValue) || selected.options?.[0];
        this.dispatch({ type: "ui/modalSelection", index: next });
        this.dispatch({
            type: "ui/status",
            text: `Editing ${selected.label}: ${currentOption?.label || currentValue || ""}`,
        });
    }

    async confirmModal() {
        const modal = this.getState().ui.modal;
        if (!modal) return;
        if (modal.type === "confirm") {
            const previousFocus = modal.previousFocus;
            this.dispatch({ type: "ui/modal", modal: null });
            if (previousFocus) this.setFocus(previousFocus);
            if (modal.action === "cancelSession") {
                await this.cancelActiveSession({ confirmed: true });
            } else if (modal.action === "completeSession") {
                await this.completeActiveSession("Completed by user", { confirmed: true });
            } else if (modal.action === "deleteSession") {
                await this.deleteActiveSession({ confirmed: true });
            } else if (modal.action === "deleteArtifact") {
                await this.deleteSelectedArtifact({ confirmed: true });
            }
            return;
        }
        if (modal.type === "artifactUpload") {
            await this.confirmArtifactUploadModal();
            return;
        }
        if (modal.type === "renameSession") {
            await this.confirmRenameSessionModal();
            return;
        }
        if (modal.type === "sessionOwnerFilter") {
            this.toggleSessionOwnerFilter();
            return;
        }
        if (modal.type === "filesFilter") {
            const previousFocus = modal.previousFocus;
            this.dispatch({ type: "ui/modal", modal: null });
            if (previousFocus) this.setFocus(previousFocus);
            return;
        }
        if (modal.type === "themePicker") {
            const item = modal.items?.[modal.selectedIndex || 0];
            const nextTheme = getTheme(item?.id);
            if (!nextTheme) {
                this.dispatch({ type: "ui/status", text: "Unable to apply that theme" });
                return;
            }
            const previousFocus = modal.previousFocus;
            this.dispatch({ type: "ui/modal", modal: null });
            this.dispatch({ type: "ui/theme", themeId: nextTheme.id });
            if (previousFocus) {
                this.setFocus(previousFocus);
            }
            this.dispatch({ type: "ui/status", text: `Applied theme: ${nextTheme.label}` });
            return;
        }
        if (modal.type === "modelPicker") {
            const item = modal.items?.[modal.selectedIndex || 0];
            const previousFocus = modal.previousFocus;
            this.dispatch({ type: "ui/modal", modal: null });
            if (previousFocus) {
                this.setFocus(previousFocus);
            }
            await this.openNewSessionFlow(item?.id ? { model: item.id } : {});
            return;
        }
        if (modal.type === "sessionAgentPicker") {
            const item = modal.items?.[modal.selectedIndex || 0];
            const previousFocus = modal.previousFocus;
            const sessionOptions = modal.sessionOptions || {};
            this.dispatch({ type: "ui/modal", modal: null });
            if (previousFocus) {
                this.setFocus(previousFocus);
            }
            if (!item || item.kind === "generic") {
                await this.createSession(sessionOptions);
                return;
            }
            await this.createSessionForAgent(item.agentName, {
                ...sessionOptions,
                ...(item.title ? { title: item.title } : {}),
                ...(item.splash ? { splash: item.splash } : {}),
                ...(item.initialPrompt ? { initialPrompt: item.initialPrompt } : {}),
            });
            return;
        }
        if (modal.type === "logFilter") {
            this.closeModal();
            return;
        }
        if (modal.type === "historyFormat") {
            this.closeModal();
            return;
        }
        if (modal.type === "artifactPicker") {
            await this.downloadArtifactModalSelection();
        }
    }

    openLogFilter() {
        const previousFocus = this.getState().ui.focusRegion;
        this.dispatch({
            type: "ui/modal",
            modal: {
                type: "logFilter",
                title: "Log Filters",
                previousFocus,
                selectedIndex: 0,
                items: [
                    {
                        id: "source",
                        label: "Source nodes",
                        description: "Choose whether the log pane shows logs from all nodes or only the current orchestration.",
                        options: [
                            { id: "allNodes", label: "All nodes" },
                            { id: "currentOrchestration", label: "Current orchestration" },
                        ],
                    },
                    {
                        id: "level",
                        label: "Levels",
                        description: "Filter logs by severity/verbosity level.",
                        options: [
                            { id: "all", label: "All" },
                            { id: "info", label: "Info" },
                            { id: "warn", label: "Warn" },
                            { id: "error", label: "Error" },
                            { id: "debug", label: "Debug" },
                            { id: "trace", label: "Trace" },
                        ],
                    },
                    {
                        id: "format",
                        label: "Format",
                        description: "Raw shows the structured time/node/level summary. Pretty shows the cleaned message text, colored by orchestration vs activity.",
                        options: [
                            { id: "pretty", label: "Pretty text" },
                            { id: "raw", label: "Raw summary" },
                        ],
                    },
                ],
            },
        });
        this.dispatch({ type: "ui/status", text: "Tab/Shift-Tab switch filters · Up/Down change values · Enter close · Esc cancel" });
    }

    openHistoryFormat() {
        const previousFocus = this.getState().ui.focusRegion;
        this.dispatch({
            type: "ui/modal",
            modal: {
                type: "historyFormat",
                title: "Execution History Format",
                previousFocus,
                selectedIndex: 0,
                items: [
                    {
                        id: "format",
                        label: "Format",
                        description: "Pretty prints a human-readable view with colored event kinds. Raw JSON shows the full event objects.",
                        options: [
                            { id: "pretty", label: "Pretty text" },
                            { id: "raw", label: "Raw JSON" },
                        ],
                    },
                ],
            },
        });
        this.dispatch({ type: "ui/status", text: "Up/Down change format · Enter close · Esc cancel" });
    }

    toggleLogTail() {
        const logs = this.getState().logs;
        if (!logs.available) {
            this.dispatch({
                type: "ui/status",
                text: logs.availabilityReason || "Log tailing is not available in this environment",
            });
            return;
        }

        if (logs.tailing) {
            this.detachLogStream();
            if (typeof this.transport.stopLogTail === "function") {
                this.transport.stopLogTail().catch(() => {});
            }
            this.dispatch({ type: "logs/tailing", tailing: false });
            this.dispatch({ type: "ui/status", text: "Log tailing stopped" });
            return;
        }

        if (typeof this.transport.startLogTail !== "function") {
            this.dispatch({ type: "ui/status", text: "Log tailing is not supported by this transport" });
            return;
        }

        this.logUnsubscribe = this.transport.startLogTail((entryOrBatch) => {
            const entries = Array.isArray(entryOrBatch) ? entryOrBatch : [entryOrBatch];
            if (entries.length > 0) {
                this.dispatch({ type: "logs/append", entries });
            }
        });
        this.dispatch({ type: "logs/tailing", tailing: true });
        this.dispatch({ type: "ui/status", text: "Log tailing started" });
    }

    async sendPrompt() {
        const state = this.getState();
        const rawPrompt = state.ui.prompt;
        const promptCursor = state.ui.promptCursor;
        const promptAttachments = this.getPromptAttachments();
        const attachmentSessionId = promptAttachments[0]?.sessionId || null;
        const prompt = expandPromptAttachments(rawPrompt, promptAttachments);
        if (!prompt.trim()) return;

        let sessionId = state.sessions.activeSessionId;
        if (attachmentSessionId) {
            sessionId = attachmentSessionId;
            if (state.sessions.activeSessionId !== attachmentSessionId) {
                await this.loadSession(attachmentSessionId);
            }
        }
        let activeSession = sessionId ? state.sessions.byId[sessionId] || null : null;
        if (sessionId && !activeSession) {
            activeSession = this.getState().sessions.byId[sessionId] || null;
        }
        if (!sessionId) {
            const created = await this.transport.createSession({});
            sessionId = created.sessionId;
            await this.refreshSessions();
            await this.loadSession(sessionId);
            activeSession = this.getState().sessions.byId[sessionId] || null;
        }

        const answeringPendingQuestion = Boolean(activeSession?.pendingQuestion?.question);

        const existing = this.getState().history.bySessionId.get(sessionId) || { chat: [], activity: [], lastSeq: 0 };
        this.dispatch({
            type: "history/set",
            sessionId,
            history: {
                ...existing,
                chat: [
                    ...existing.chat,
                    {
                        id: `optimistic:${Date.now()}`,
                        role: "user",
                        text: prompt,
                        time: "",
                        createdAt: Date.now(),
                        optimistic: true,
                    },
                ],
            },
        });

        this.setPrompt("", 0);
        this.dispatch({ type: "ui/status", text: "Sending..." });
        try {
            if (answeringPendingQuestion && typeof this.transport.sendAnswer === "function") {
                await this.transport.sendAnswer(sessionId, prompt);
                this.dispatch({
                    type: "sessions/merged",
                    session: {
                        sessionId,
                        pendingQuestion: null,
                    },
                });
                this.scheduleSessionDetailSync(sessionId, 100);
                this.syncSessionEvents(sessionId).catch(() => {});
                this.scheduleSessionsRefresh(1000);
                this.dispatch({ type: "ui/status", text: "Answer sent" });
                return;
            }

            await this.transport.sendMessage(sessionId, prompt, {
                enqueueOnly: Boolean(activeSession?.isSystem || activeSession?.status === "running"),
            });
            this.syncSessionEvents(sessionId).catch(() => {});
            this.scheduleSessionsRefresh(1000);
            this.dispatch({ type: "ui/status", text: "Prompt sent" });
        } catch (error) {
            this.setPrompt(rawPrompt, promptCursor);
            this.setPromptAttachments(promptAttachments);
            await this.ensureSessionHistory(sessionId, { force: true }).catch(() => {});
            let latestSession = null;
            if (typeof this.transport.getSession === "function") {
                latestSession = await this.transport.getSession(sessionId).catch(() => null);
                const patch = buildSessionMergePatch(
                    this.getState().sessions.byId[sessionId] || null,
                    latestSession,
                );
                if (patch) {
                    this.dispatch({ type: "sessions/merged", session: patch });
                }
            }
            const resolvedSession = latestSession || this.getState().sessions.byId[sessionId] || activeSession || { sessionId };
            if (isTerminalOrchestrationStatus(resolvedSession?.orchestrationStatus) || isTerminalSendError(error)) {
                const currentHistory = this.getState().history.bySessionId.get(sessionId) || { chat: [], activity: [], lastSeq: 0 };
                this.dispatch({
                    type: "history/set",
                    sessionId,
                    history: appendSyntheticChatMessage(
                        currentHistory,
                        buildTerminalSendRejectedMessage(resolvedSession, error),
                    ),
                });
            }
            this.dispatch({
                type: "ui/status",
                text: error?.message || String(error),
            });
        }
    }

    setPrompt(prompt, promptCursor = String(prompt || "").length) {
        const nextPrompt = String(prompt || "");
        const nextCursor = Math.max(0, Math.min(
            Number.isFinite(promptCursor) ? promptCursor : nextPrompt.length,
            nextPrompt.length,
        ));
        const currentUi = this.getState().ui;
        if (currentUi.prompt === nextPrompt && currentUi.promptCursor === nextCursor) {
            return;
        }
        this.dispatch({ type: "ui/prompt", prompt: nextPrompt, promptCursor: nextCursor });
        this.syncPromptReferenceBrowser();
    }

    insertPromptText(text) {
        const state = this.getState().ui;
        const next = insertPromptTextAtCursor(state.prompt, state.promptCursor, text);
        this.setPrompt(next.prompt, next.cursor);
    }

    appendPromptChar(ch) {
        this.insertPromptText(ch);
    }

    deletePromptChar() {
        const state = this.getState().ui;
        const next = deletePromptCharBackward(state.prompt, state.promptCursor);
        this.setPrompt(next.prompt, next.cursor);
    }

    deletePromptWordBackward() {
        const state = this.getState().ui;
        const next = deletePromptWordBackward(state.prompt, state.promptCursor);
        this.setPrompt(next.prompt, next.cursor);
    }

    movePromptCursor(delta) {
        const state = this.getState().ui;
        this.setPrompt(state.prompt, clampPromptCursor(state.prompt, state.promptCursor + delta));
    }

    movePromptCursorWord(direction) {
        const state = this.getState().ui;
        this.setPrompt(state.prompt, movePromptCursorByWord(state.prompt, state.promptCursor, direction));
    }

    movePromptCursorVertical(direction) {
        const state = this.getState().ui;
        this.setPrompt(state.prompt, movePromptCursorVertically(state.prompt, state.promptCursor, direction));
    }

    getCurrentLayout(overrides = {}) {
        const layoutState = this.getState().ui.layout || {};
        const uiState = this.getState().ui;
        const prompt = overrides.prompt ?? uiState.prompt;
        return computeLegacyLayout({
            width: overrides.width ?? layoutState.viewportWidth ?? 120,
            height: overrides.height ?? layoutState.viewportHeight ?? 40,
        },
        overrides.paneAdjust ?? layoutState.paneAdjust ?? 0,
        overrides.promptRows ?? uiState.promptRows ?? getPromptInputRows(prompt),
        overrides.sessionPaneAdjust ?? layoutState.sessionPaneAdjust ?? 0,
        overrides.fullscreenPane ?? uiState.fullscreenPane ?? null);
    }

    getSessionListMaxRows(layout = this.getCurrentLayout()) {
        const paneHeight = layout.fullscreenPane === FOCUS_REGIONS.SESSIONS
            ? layout.bodyHeight
            : layout.sessionPaneHeight;
        return Math.max(3, paneHeight - 2);
    }

    setViewport(viewport = {}) {
        const nextWidth = Math.max(40, Number(viewport.width) || 120);
        const nextHeight = Math.max(18, Number(viewport.height) || 40);
        const currentLayout = this.getState().ui.layout || {};
        if (currentLayout.viewportWidth !== nextWidth || currentLayout.viewportHeight !== nextHeight) {
            this.dispatch({
                type: "ui/viewport",
                width: nextWidth,
                height: nextHeight,
            });
        }
        const nextLayout = this.getCurrentLayout({ width: nextWidth, height: nextHeight });
        const currentFocus = this.getState().ui.focusRegion;
        const safeFocus = normalizeFocusRegion(currentFocus, nextLayout);
        if (safeFocus !== currentFocus) {
            this.setFocus(safeFocus);
        }
    }

    setFocus(focusRegion) {
        this.dispatch({ type: "ui/focus", focusRegion: normalizeFocusRegion(focusRegion, this.getCurrentLayout()) });
    }

    focusNext() {
        const layout = this.getCurrentLayout();
        const current = normalizeFocusRegion(this.getState().ui.focusRegion, layout);
        const order = getFocusOrderForLayout(layout);
        this.setFocus(cycleValue(order, current, 1));
    }

    focusPrev() {
        const layout = this.getCurrentLayout();
        const current = normalizeFocusRegion(this.getState().ui.focusRegion, layout);
        const order = getFocusOrderForLayout(layout);
        this.setFocus(cycleValue(order, current, -1));
    }

    focusLeft() {
        const layout = this.getCurrentLayout();
        const current = normalizeFocusRegion(this.getState().ui.focusRegion, layout);
        this.setFocus(getFocusLeftTarget(current, layout));
    }

    focusRight() {
        const layout = this.getCurrentLayout();
        const current = normalizeFocusRegion(this.getState().ui.focusRegion, layout);
        this.setFocus(getFocusRightTarget(current, layout));
    }

    adjustPaneSplit(delta) {
        const layoutState = this.getState().ui.layout || {};
        const viewportWidth = layoutState.viewportWidth ?? 120;
        const nextAdjust = Math.max(-viewportWidth, Math.min(viewportWidth, (layoutState.paneAdjust || 0) + delta));
        this.dispatch({
            type: "ui/paneAdjust",
            paneAdjust: nextAdjust,
        });
        const nextLayout = this.getCurrentLayout({ paneAdjust: nextAdjust });
        const currentFocus = this.getState().ui.focusRegion;
        const safeFocus = normalizeFocusRegion(currentFocus, nextLayout);
        if (safeFocus !== currentFocus) {
            this.setFocus(safeFocus);
        }
    }

    adjustSessionPaneSplit(delta) {
        const layoutState = this.getState().ui.layout || {};
        const currentLayout = this.getCurrentLayout();
        const bodyHeight = currentLayout.bodyHeight ?? (layoutState.viewportHeight ?? 40);
        const nextAdjust = Math.max(-bodyHeight, Math.min(bodyHeight, (layoutState.sessionPaneAdjust || 0) + delta));
        this.dispatch({
            type: "ui/sessionPaneAdjust",
            sessionPaneAdjust: nextAdjust,
        });
    }

    nextInspectorTab() {
        const current = this.getState().ui.inspectorTab;
        const inspectorTab = cycleValue(INSPECTOR_TABS, current, 1);
        this.dispatch({
            type: "ui/inspectorTab",
            inspectorTab,
        });
        this.ensureInspectorData(inspectorTab).catch(() => {});
    }

    prevInspectorTab() {
        const inspectorTab = cycleValue(INSPECTOR_TABS, this.getState().ui.inspectorTab, -1);
        this.dispatch({
            type: "ui/inspectorTab",
            inspectorTab,
        });
        this.ensureInspectorData(inspectorTab).catch(() => {});
    }

    cycleInspectorTab() {
        this.nextInspectorTab();
    }

    toggleStatsView() {
        const modes = ["session", "fleet", "users"];
        const current = this.getState().ui.statsViewMode;
        const currentIndex = modes.includes(current) ? modes.indexOf(current) : 0;
        const statsViewMode = modes[(currentIndex + 1) % modes.length];
        this.setStatsViewMode(statsViewMode);
    }

    setStatsViewMode(statsViewMode) {
        this.dispatch({
            type: "ui/statsViewMode",
            statsViewMode,
        });
        if (this.getState().ui.inspectorTab === "stats") {
            this.ensureInspectorData("stats").catch(() => {});
        }
    }

    async selectInspectorTab(inspectorTab) {
        if (!INSPECTOR_TABS.includes(inspectorTab)) return;
        this.dispatch({
            type: "ui/inspectorTab",
            inspectorTab,
        });
        await this.ensureInspectorData(inspectorTab).catch(() => {});
    }

    async moveSession(delta) {
        const state = this.getState();
        const rows = selectSessionRows(state);
        if (rows.length === 0) return;
        const currentId = state.sessions.activeSessionId || rows[0].sessionId;
        const currentIndex = Math.max(0, rows.findIndex((row) => row.sessionId === currentId));
        const nextIndex = Math.max(0, Math.min(rows.length - 1, currentIndex + delta));
        const nextId = rows[nextIndex].sessionId;
        await this.loadSession(nextId);
    }

    getSessionPageSize() {
        const layout = this.getCurrentLayout();
        const paneHeight = layout.fullscreenPane === FOCUS_REGIONS.SESSIONS
            ? layout.bodyHeight
            : layout.sessionPaneHeight;
        return Math.max(1, paneHeight - 3);
    }

    async moveSessionPage(deltaPages) {
        const pageSize = this.getSessionPageSize();
        await this.moveSession(pageSize * deltaPages);
    }

    inspectorUsesBottomScroll() {
        return INSPECTOR_BOTTOM_ANCHORED_TABS.has(this.getState().ui.inspectorTab);
    }

    paneUsesStickyBottomFollow(pane, state = this.getState()) {
        if (pane === "activity") return true;
        if (pane === "inspector") return state.ui.inspectorTab === "logs";
        return false;
    }

    isPaneFollowingBottom(pane, state = this.getState()) {
        if (!this.paneUsesStickyBottomFollow(pane, state)) return false;
        return state.ui.followBottom?.[pane] !== false;
    }

    getPaneVisualScrollOffset(pane, state = this.getState()) {
        const maxOffset = this.getPaneMaxScrollOffset(pane, state);
        const storedOffset = Math.max(0, Math.min(Number(state.ui.scroll?.[pane]) || 0, maxOffset));
        if (this.isPaneFollowingBottom(pane, state)) {
            return Math.max(0, maxOffset - storedOffset);
        }
        return storedOffset;
    }

    applyPaneVisualScrollOffset(pane, offset, options = {}, state = this.getState()) {
        const maxOffset = this.getPaneMaxScrollOffset(pane, state);
        const nextOffset = Math.max(0, Math.min(Number(offset) || 0, maxOffset));
        if (this.paneUsesStickyBottomFollow(pane, state)) {
            const followBottom = options.followBottom !== undefined
                ? Boolean(options.followBottom)
                : options.atBottom !== undefined
                    ? Boolean(options.atBottom)
                    : nextOffset >= maxOffset;
            this.dispatch({ type: "ui/followBottom", pane, followBottom });
            this.dispatch({ type: "ui/scroll", pane, offset: followBottom ? 0 : nextOffset });
            return nextOffset;
        }

        this.dispatch({ type: "ui/scroll", pane, offset: nextOffset });
        return nextOffset;
    }

    updatePaneScrollFromViewport(pane, offset, options = {}) {
        const state = this.getState();
        if (this.paneUsesStickyBottomFollow(pane, state)) {
            this.applyPaneVisualScrollOffset(pane, offset, options, state);
            return;
        }
        this.scrollPaneTo(pane, offset);
    }

    expandActiveSession() {
        const sessionId = this.getState().sessions.activeSessionId;
        if (!sessionId) return;
        this.dispatch({ type: "sessions/expand", sessionId });
    }

    collapseActiveSession() {
        const sessionId = this.getState().sessions.activeSessionId;
        if (!sessionId) return;
        this.dispatch({ type: "sessions/collapse", sessionId });
    }

    scrollPane(pane, delta) {
        const state = this.getState();
        const maxOffset = this.getPaneMaxScrollOffset(pane, state);
        if (this.paneUsesStickyBottomFollow(pane, state)) {
            const current = this.getPaneVisualScrollOffset(pane, state);
            const nextOffset = Math.max(0, Math.min(current - delta, maxOffset));
            this.applyPaneVisualScrollOffset(pane, nextOffset, { followBottom: nextOffset >= maxOffset }, state);
            return;
        }
        const current = Math.max(0, Math.min(Number(state.ui.scroll?.[pane]) || 0, maxOffset));
        const nextOffset = Math.max(0, Math.min(current + delta, maxOffset));
        this.dispatch({ type: "ui/scroll", pane, offset: nextOffset });
        if (pane === "chat" && delta > 0) {
            this.maybeAutoExpandActiveHistory(nextOffset).catch(() => {});
        }
    }

    scrollPaneTo(pane, offset) {
        const state = this.getState();
        const maxOffset = this.getPaneMaxScrollOffset(pane, state);
        const nextOffset = Math.max(0, Math.min(Number(offset) || 0, maxOffset));
        if (this.paneUsesStickyBottomFollow(pane, state)) {
            this.applyPaneVisualScrollOffset(pane, nextOffset, { followBottom: nextOffset >= maxOffset }, state);
            return;
        }
        this.dispatch({ type: "ui/scroll", pane, offset: nextOffset });
        if (pane === "chat" && nextOffset > 0) {
            this.maybeAutoExpandActiveHistory(nextOffset).catch(() => {});
        }
    }

    getScrollablePaneForFocus() {
        const focus = this.getState().ui.focusRegion;
        if (focus === FOCUS_REGIONS.CHAT) return "chat";
        if (focus === FOCUS_REGIONS.ACTIVITY) return "activity";
        if (focus === FOCUS_REGIONS.INSPECTOR) {
            if (this.getState().ui.inspectorTab === "files") return "filePreview";
            return "inspector";
        }
        return null;
    }

    scrollCurrentPane(delta) {
        const pane = this.getScrollablePaneForFocus();
        if (!pane) return;
        if (this.paneUsesStickyBottomFollow(pane)) {
            this.scrollPane(pane, delta);
            return;
        }
        const inspectorUsesBottomScroll = pane === "inspector" && this.inspectorUsesBottomScroll();
        const usesTopScroll = pane === "inspector" || pane === "filePreview";
        this.scrollPane(pane, usesTopScroll && !inspectorUsesBottomScroll ? -delta : delta);
    }

    scrollCurrentPaneToTop() {
        const pane = this.getScrollablePaneForFocus();
        if (!pane) return;
        if (this.paneUsesStickyBottomFollow(pane)) {
            this.applyPaneVisualScrollOffset(pane, 0, { followBottom: false });
            return;
        }
        const inspectorUsesBottomScroll = pane === "inspector" && this.inspectorUsesBottomScroll();
        if (pane === "chat" || pane === "activity" || inspectorUsesBottomScroll) {
            this.scrollPaneTo(pane, Number.MAX_SAFE_INTEGER);
            return;
        }
        this.scrollPaneTo(pane, 0);
    }

    scrollCurrentPaneToBottom() {
        const pane = this.getScrollablePaneForFocus();
        if (!pane) return;
        if (this.paneUsesStickyBottomFollow(pane)) {
            this.applyPaneVisualScrollOffset(pane, Number.MAX_SAFE_INTEGER, { followBottom: true });
            return;
        }
        const inspectorUsesBottomScroll = pane === "inspector" && this.inspectorUsesBottomScroll();
        if (pane === "chat" || pane === "activity" || inspectorUsesBottomScroll) {
            this.scrollPaneTo(pane, 0);
            return;
        }
        this.scrollPaneTo(pane, Number.MAX_SAFE_INTEGER);
    }

    async expandActiveHistory() {
        const sessionId = this.getState().sessions.activeSessionId;
        if (!sessionId) return;
        await this.expandSessionHistory(sessionId);
    }

    getActiveChatRenderMetrics(state = this.getState()) {
        const layout = this.getCurrentLayout();
        if (layout.leftHidden) {
            return {
                contentWidth: 20,
                contentHeight: 1,
                totalLines: 0,
            };
        }

        const contentWidth = Math.max(20, layout.leftWidth - 4);
        const contentHeight = Math.max(1, layout.chatPaneHeight - 2);
        const lines = selectChatLines(state, contentWidth);
        const totalLines = countWrappedRenderableLines(lines, contentWidth);
        return {
            contentWidth,
            contentHeight,
            totalLines,
        };
    }

    getActivityRenderMetrics(state = this.getState()) {
        const layout = this.getCurrentLayout();
        if (layout.rightHidden) {
            return {
                contentWidth: 20,
                contentHeight: 1,
                totalLines: 0,
            };
        }

        const contentWidth = Math.max(20, layout.rightWidth - 4);
        const contentHeight = Math.max(1, layout.activityPaneHeight - 2);
        const activeSessionId = state.sessions.activeSessionId;
        const selectorState = {
            sessions: {
                activeSessionId,
                byId: activeSessionId
                    ? { [activeSessionId]: state.sessions.byId[activeSessionId] || null }
                    : {},
            },
            history: {
                bySessionId: activeSessionId
                    ? new Map([[activeSessionId, state.history.bySessionId.get(activeSessionId) || null]])
                    : new Map(),
            },
        };
        const activity = selectActivityPane(selectorState);
        return {
            contentWidth,
            contentHeight,
            totalLines: countWrappedRenderableLines(activity.lines, contentWidth),
        };
    }

    getInspectorRenderMetrics(state = this.getState()) {
        const layout = this.getCurrentLayout();
        if (layout.rightHidden) {
            return {
                contentWidth: 20,
                contentHeight: 1,
                stickyLineCount: 0,
                totalLines: 0,
            };
        }

        const contentWidth = Math.max(20, layout.rightWidth - 4);
        const activeSessionId = state.sessions.activeSessionId;
        const activeOrchestration = activeSessionId
            ? state.orchestration.bySessionId?.[activeSessionId] || null
            : null;
        const selectorState = {
            branding: state.branding,
            sessions: {
                activeSessionId,
                byId: state.sessions.byId,
                flat: state.sessions.flat,
            },
            history: {
                bySessionId: state.history.bySessionId,
            },
            orchestration: {
                bySessionId: activeSessionId && activeOrchestration
                    ? { [activeSessionId]: activeOrchestration }
                    : {},
            },
            logs: state.logs,
            sessionStats: state.sessionStats,
            fleetStats: state.fleetStats,
            ui: {
                inspectorTab: state.ui.inspectorTab,
                statsViewMode: state.ui.statsViewMode,
            },
            executionHistory: state.executionHistory,
        };
        const inspector = selectInspector(selectorState, { width: contentWidth });
        const tabLine = inspector.tabs.map((tab) => ({
            text: tab === inspector.activeTab ? `[${tab}] ` : `${tab} `,
            color: tab === inspector.activeTab ? "magenta" : "gray",
            bold: tab === inspector.activeTab,
        }));
        const normalizedLines = (inspector.lines || []).map((line) => (typeof line === "string"
            ? { text: line, color: "white" }
            : line));
        const stickyLines = inspector.activeTab === "sequence"
            ? [
                tabLine,
                ...((inspector.stickyLines || []).map((line) => (typeof line === "string"
                    ? { text: line, color: "white" }
                    : line))),
            ]
            : [];
        const bodyLines = inspector.activeTab === "sequence"
            ? normalizedLines
            : [tabLine, ...normalizedLines];
        return {
            contentWidth,
            contentHeight: Math.max(1, layout.inspectorPaneHeight - 2),
            stickyLineCount: countWrappedRenderableLines(stickyLines, contentWidth),
            totalLines: countWrappedRenderableLines(bodyLines, contentWidth),
        };
    }

    getFilePreviewRenderMetrics(state = this.getState()) {
        const layout = this.getCurrentLayout();
        if (layout.rightHidden && !state.files?.fullscreen) {
            return {
                contentWidth: 20,
                contentHeight: 1,
                totalLines: 0,
            };
        }

        const fullscreen = state.ui.inspectorTab === "files" && Boolean(state.files?.fullscreen);
        const width = fullscreen ? layout.totalWidth : layout.rightWidth;
        const height = fullscreen ? Math.max(10, layout.bodyHeight) : layout.inspectorPaneHeight;
        const outerContentWidth = Math.max(20, width - 4);
        const previewWidth = Math.max(8, outerContentWidth - 4);

        const activeSessionId = state.sessions.activeSessionId;
        const activeSession = activeSessionId ? state.sessions.byId[activeSessionId] || null : null;
        const selectorState = {
            sessions: {
                activeSessionId,
                byId: activeSessionId && activeSession
                    ? { [activeSessionId]: activeSession }
                    : {},
                flat: state.sessions.flat,
            },
            files: {
                bySessionId: state.files.bySessionId,
                fullscreen: Boolean(state.files.fullscreen),
                selectedArtifactId: state.files.selectedArtifactId,
                filter: state.files.filter,
            },
            ui: {
                scroll: {
                    filePreview: state.ui.scroll.filePreview,
                },
            },
        };
        const filesView = selectFilesView(selectorState, {
            listWidth: previewWidth,
            previewWidth,
        });
        const availablePanelsHeight = Math.max(9, height - 4);
        const maxListPanelHeight = Math.max(5, Math.min(10, Math.floor(availablePanelsHeight * 0.35)));
        let listPanelHeight = Math.max(5, Math.min(maxListPanelHeight, (filesView.listBodyLines || []).length + 2));
        let previewPanelHeight = Math.max(5, availablePanelsHeight - listPanelHeight - 1);
        const minPreviewPanelHeight = 8;
        if (previewPanelHeight < minPreviewPanelHeight) {
            const deficit = minPreviewPanelHeight - previewPanelHeight;
            listPanelHeight = Math.max(5, listPanelHeight - deficit);
            previewPanelHeight = Math.max(5, availablePanelsHeight - listPanelHeight - 1);
        }
        return {
            contentWidth: previewWidth,
            contentHeight: Math.max(1, previewPanelHeight - 2),
            totalLines: countWrappedRenderableLines(filesView.previewLines, previewWidth),
        };
    }

    getPaneMaxScrollOffset(pane, state = this.getState()) {
        if (!pane) return 0;
        if (pane === "chat") {
            const metrics = this.getActiveChatRenderMetrics(state);
            return Math.max(0, metrics.totalLines - metrics.contentHeight);
        }
        if (pane === "activity") {
            const metrics = this.getActivityRenderMetrics(state);
            return Math.max(0, metrics.totalLines - metrics.contentHeight);
        }
        if (pane === "inspector") {
            const metrics = this.getInspectorRenderMetrics(state);
            const stickyLineCount = Math.min(metrics.contentHeight, metrics.stickyLineCount || 0);
            const scrollableHeight = Math.max(0, metrics.contentHeight - stickyLineCount);
            return Math.max(0, metrics.totalLines - scrollableHeight);
        }
        if (pane === "filePreview") {
            const metrics = this.getFilePreviewRenderMetrics(state);
            return Math.max(0, metrics.totalLines - metrics.contentHeight);
        }
        return 0;
    }

    async maybeAutoExpandActiveHistory(targetOffset) {
        const state = this.getState();
        const sessionId = state.sessions.activeSessionId;
        if (!sessionId) return;
        const currentHistory = state.history.bySessionId.get(sessionId);
        if (!currentHistory?.hasOlderEvents) return;
        if (this.sessionHistoryExpansionLoads.has(sessionId)) return;
        if (Number(currentHistory.loadedEventCount || 0) >= AUTO_HISTORY_EVENT_SOFT_CAP) {
            this.dispatch({
                type: "ui/status",
                text: "Reached automatic history limit. Press e to load more older CMS events.",
            });
            return;
        }

        const { contentHeight, totalLines } = this.getActiveChatRenderMetrics(state);
        const maxOffset = Math.max(0, totalLines - contentHeight);
        if (targetOffset < maxOffset) return;

        await this.expandSessionHistory(sessionId, {
            requestedScrollOffset: targetOffset,
            autoTriggered: true,
        });
    }

    async expandSessionHistory(sessionId, options = {}) {
        if (!sessionId) return;
        if (this.sessionHistoryExpansionLoads.has(sessionId)) {
            return this.sessionHistoryExpansionLoads.get(sessionId);
        }

        const stateBefore = this.getState();
        const currentHistory = stateBefore.history.bySessionId.get(sessionId);
        const currentLimit = Math.max(
            DEFAULT_HISTORY_EVENT_LIMIT,
            Number(currentHistory?.loadedEventLimit ?? DEFAULT_HISTORY_EVENT_LIMIT) || DEFAULT_HISTORY_EVENT_LIMIT,
        );
        const pageLimit = DEFAULT_HISTORY_EVENT_LIMIT;
        const oldestSeq = Array.isArray(currentHistory?.events) && currentHistory.events.length > 0
            ? Number(currentHistory.events[0]?.seq || 0)
            : 0;

        if (!currentHistory?.hasOlderEvents || oldestSeq <= 1) {
            this.dispatch({
                type: "ui/status",
                text: "Already showing the oldest loaded history",
            });
            return;
        }

        const preserveChatView = sessionId === stateBefore.sessions.activeSessionId;
        const previousScrollOffset = Number(options.requestedScrollOffset ?? stateBefore.ui.scroll?.chat ?? 0);
        const previousRenderedLines = preserveChatView
            ? this.getActiveChatRenderMetrics(stateBefore).totalLines
            : 0;

        const loadPromise = (async () => {
            let history;
            if (typeof this.transport.getSessionEventsBefore === "function" && oldestSeq > 0) {
                const olderEvents = await this.transport.getSessionEventsBefore(sessionId, oldestSeq, pageLimit);
                if (!Array.isArray(olderEvents) || olderEvents.length === 0) {
                    history = {
                        ...(currentHistory || buildHistoryModel([], { requestedLimit: currentLimit })),
                        hasOlderEvents: false,
                    };
                } else {
                    const olderHistory = buildHistoryModel(olderEvents, { requestedLimit: pageLimit });
                    const combinedEvents = [
                        ...(olderHistory.events || []),
                        ...(currentHistory?.events || []),
                    ];
                    history = {
                        chat: dedupeChatMessages([
                            ...(olderHistory.chat || []),
                            ...(currentHistory?.chat || []),
                        ]),
                        activity: [
                            ...(olderHistory.activity || []),
                            ...(currentHistory?.activity || []),
                        ],
                        events: combinedEvents,
                        lastSeq: currentHistory?.lastSeq || currentHistory?.events?.[currentHistory?.events?.length - 1]?.seq || olderEvents[olderEvents.length - 1]?.seq || 0,
                        loadedEventLimit: combinedEvents.length,
                        loadedEventCount: combinedEvents.length,
                        hasOlderEvents: olderEvents.length >= pageLimit && Number(olderEvents[0]?.seq || 0) > 1,
                    };
                }
            } else {
                const nextLimit = getNextHistoryEventLimit(currentLimit);
                if (nextLimit <= currentLimit) {
                    this.dispatch({
                        type: "ui/status",
                        text: currentHistory?.hasOlderEvents
                            ? `Already showing a large recent history window (${currentLimit} events)`
                            : "Already showing the oldest loaded history",
                    });
                    return;
                }
                const events = await this.transport.getSessionEvents(sessionId, undefined, nextLimit);
                history = {
                    ...buildHistoryModel(events, { requestedLimit: nextLimit }),
                    lastSeq: events[events.length - 1]?.seq || 0,
                };
            }
            this.dispatch({
                type: "history/set",
                sessionId,
                history,
            });

            if (preserveChatView && previousScrollOffset > 0) {
                const nextState = this.getState();
                const nextRenderedLines = this.getActiveChatRenderMetrics(nextState).totalLines;
                const addedLines = Math.max(0, nextRenderedLines - previousRenderedLines);
                if (addedLines > 0) {
                    this.dispatch({
                        type: "ui/scroll",
                        pane: "chat",
                        offset: previousScrollOffset + addedLines,
                    });
                }
            }

            const stateLabel = history.hasOlderEvents
                ? options.autoTriggered
                    ? `Loaded older history page from CMS (${history.loadedEventCount} events loaded)`
                    : `Loaded older history page (${history.loadedEventCount} events loaded)`
                : `Loaded full available history (${history.loadedEventCount} events)`;
            this.dispatch({
                type: "ui/status",
                text: stateLabel,
            });
        })().finally(() => {
            this.sessionHistoryExpansionLoads.delete(sessionId);
        });

        this.sessionHistoryExpansionLoads.set(sessionId, loadPromise);
        return loadPromise;
    }

    async cancelActiveSession({ confirmed = false } = {}) {
        const sessionId = this.getState().sessions.activeSessionId;
        if (!sessionId) return;
        if (!confirmed) {
            const session = this.getState().sessions.byId[sessionId];
            const label = session?.title || sessionId.slice(0, 8);
            this.dispatch({
                type: "ui/modal",
                modal: {
                    type: "confirm",
                    title: "Cancel Session",
                    message: `Cancel session "${label}"? The session will stop processing.`,
                    confirmLabel: "Cancel Session",
                    action: "cancelSession",
                    sessionId,
                    previousFocus: this.getState().ui.focusRegion,
                },
            });
            return;
        }
        await this.transport.cancelSession(sessionId);
        this.dispatch({ type: "ui/status", text: `Cancelled ${sessionId.slice(0, 8)}` });
        await this.refreshSessions();
    }

    async completeActiveSession(reason = "Completed by user", { confirmed = false } = {}) {
        const sessionId = this.getState().sessions.activeSessionId;
        if (!sessionId) return;
        if (typeof this.transport.completeSession !== "function") {
            this.dispatch({ type: "ui/status", text: "Session completion is not supported by this transport" });
            return;
        }

        const activeSession = this.getState().sessions.byId[sessionId];
        if (activeSession?.status === "completed" && !activeSession?.cronActive && !activeSession?.cronInterval) {
            this.dispatch({ type: "ui/status", text: `${sessionId.slice(0, 8)} is already completed` });
            return;
        }

        if (!confirmed) {
            const label = activeSession?.title || sessionId.slice(0, 8);
            this.dispatch({
                type: "ui/modal",
                modal: {
                    type: "confirm",
                    title: "Complete Session",
                    message: `Complete session "${label}"? This will cascade to all sub-agents.`,
                    confirmLabel: "Complete",
                    action: "completeSession",
                    sessionId,
                    previousFocus: this.getState().ui.focusRegion,
                },
            });
            return;
        }

        this.dispatch({
            type: "ui/status",
            text: `Completing ${sessionId.slice(0, 8)} (cascading to sub-agents)...`,
        });

        try {
            await this.transport.completeSession(sessionId, reason);
            await this.refreshSessions();
            this.scheduleSessionDetailSync(sessionId, 100);
            this.scheduleSessionsRefresh(900);
        } catch (error) {
            await this.loadSession(sessionId).catch(() => {});
            this.dispatch({
                type: "ui/status",
                text: `Failed to send /done: ${error?.message || String(error)}`,
            });
        }
    }

    async deleteActiveSession({ confirmed = false } = {}) {
        const sessionId = this.getState().sessions.activeSessionId;
        if (!sessionId) return;
        if (!confirmed) {
            const session = this.getState().sessions.byId[sessionId];
            const label = session?.title || sessionId.slice(0, 8);
            this.dispatch({
                type: "ui/modal",
                modal: {
                    type: "confirm",
                    title: "Delete Session",
                    message: `Delete session "${label}"? This action cannot be undone.`,
                    confirmLabel: "Delete",
                    action: "deleteSession",
                    sessionId,
                    previousFocus: this.getState().ui.focusRegion,
                },
            });
            return;
        }
        await this.transport.deleteSession(sessionId);
        this.dispatch({ type: "ui/status", text: `Deleted ${sessionId.slice(0, 8)}` });
        await this.refreshSessions();
    }

    async handleCommand(command) {
        switch (command) {
            case UI_COMMANDS.REFRESH:
                await this.refreshSessions();
                return;
            case UI_COMMANDS.NEW_SESSION:
                await this.openNewSessionFlow();
                return;
            case UI_COMMANDS.OPEN_MODEL_PICKER:
                await this.openModelPicker();
                return;
            case UI_COMMANDS.OPEN_THEME_PICKER:
                this.openThemePicker();
                return;
            case UI_COMMANDS.OPEN_RENAME_SESSION:
                this.openRenameSessionModal();
                return;
            case UI_COMMANDS.OPEN_SESSION_FILTER:
                this.openSessionOwnerFilter();
                return;
            case UI_COMMANDS.OPEN_TERMINATE_PICKER:
                this.openTerminatePickerModal();
                return;
            case UI_COMMANDS.OPEN_ARTIFACT_UPLOAD:
                this.openArtifactUploadModal();
                return;
            case UI_COMMANDS.CLOSE_MODAL:
                this.closeModal();
                return;
            case UI_COMMANDS.MODAL_PREV:
                this.moveModalSelection(-1);
                return;
            case UI_COMMANDS.MODAL_NEXT:
                this.moveModalSelection(1);
                return;
            case UI_COMMANDS.MODAL_PANE_PREV:
                this.moveModalPane(-1);
                return;
            case UI_COMMANDS.MODAL_PANE_NEXT:
                this.moveModalPane(1);
                return;
            case UI_COMMANDS.MODAL_CONFIRM:
                await this.confirmModal();
                return;
            case UI_COMMANDS.SEND_PROMPT:
                await this.sendPrompt();
                return;
            case UI_COMMANDS.FOCUS_NEXT:
                this.focusNext();
                return;
            case UI_COMMANDS.FOCUS_PREV:
                this.focusPrev();
                return;
            case UI_COMMANDS.FOCUS_LEFT:
                this.focusLeft();
                return;
            case UI_COMMANDS.FOCUS_RIGHT:
                this.focusRight();
                return;
            case UI_COMMANDS.FOCUS_PROMPT:
                this.setFocus(FOCUS_REGIONS.PROMPT);
                return;
            case UI_COMMANDS.FOCUS_SESSIONS:
                this.setFocus(FOCUS_REGIONS.SESSIONS);
                return;
            case UI_COMMANDS.MOVE_SESSION_UP:
                await this.moveSession(-1);
                return;
            case UI_COMMANDS.MOVE_SESSION_DOWN:
                await this.moveSession(1);
                return;
            case UI_COMMANDS.EXPAND_SESSION:
                this.expandActiveSession();
                return;
            case UI_COMMANDS.COLLAPSE_SESSION:
                this.collapseActiveSession();
                return;
            case UI_COMMANDS.NEXT_INSPECTOR_TAB:
                this.nextInspectorTab();
                return;
            case UI_COMMANDS.PREV_INSPECTOR_TAB:
                this.prevInspectorTab();
                return;
            case UI_COMMANDS.CYCLE_INSPECTOR_TAB:
                this.cycleInspectorTab();
                return;
            case UI_COMMANDS.GROW_LEFT_PANE:
                this.adjustPaneSplit(8);
                return;
            case UI_COMMANDS.GROW_RIGHT_PANE:
                this.adjustPaneSplit(-8);
                return;
            case UI_COMMANDS.GROW_SESSION_PANE:
                this.adjustSessionPaneSplit(2);
                return;
            case UI_COMMANDS.SHRINK_SESSION_PANE:
                this.adjustSessionPaneSplit(-2);
                return;
            case UI_COMMANDS.OPEN_ARTIFACT_PICKER:
                await this.openArtifactPicker();
                return;
            case UI_COMMANDS.TOGGLE_LOG_TAIL:
                this.toggleLogTail();
                return;
            case UI_COMMANDS.TOGGLE_STATS_VIEW:
                this.toggleStatsView();
                return;
            case UI_COMMANDS.OPEN_LOG_FILTER:
                this.openLogFilter();
                return;
            case UI_COMMANDS.OPEN_FILES_FILTER:
                this.openFilesFilter();
                return;
            case UI_COMMANDS.MOVE_FILE_UP:
                await this.moveFileSelection(-1);
                return;
            case UI_COMMANDS.MOVE_FILE_DOWN:
                await this.moveFileSelection(1);
                return;
            case UI_COMMANDS.DOWNLOAD_SELECTED_FILE:
                await this.downloadSelectedArtifact();
                return;
            case UI_COMMANDS.DELETE_SELECTED_FILE:
                await this.deleteSelectedArtifact();
                return;
            case UI_COMMANDS.OPEN_SELECTED_FILE:
                await this.openSelectedFileInDefaultApp();
                return;
            case UI_COMMANDS.TOGGLE_FILE_PREVIEW_FULLSCREEN:
                this.toggleFilePreviewFullscreen();
                return;
            case UI_COMMANDS.TOGGLE_PANE_FULLSCREEN:
                this.toggleFocusedPaneFullscreen();
                return;
            case UI_COMMANDS.SCROLL_UP:
                this.scrollCurrentPane(1);
                return;
            case UI_COMMANDS.SCROLL_DOWN:
                this.scrollCurrentPane(-1);
                return;
            case UI_COMMANDS.PAGE_UP:
                if (this.getState().ui.focusRegion === FOCUS_REGIONS.SESSIONS) {
                    await this.moveSessionPage(-1);
                    return;
                }
                this.scrollCurrentPane(10);
                return;
            case UI_COMMANDS.PAGE_DOWN:
                if (this.getState().ui.focusRegion === FOCUS_REGIONS.SESSIONS) {
                    await this.moveSessionPage(1);
                    return;
                }
                this.scrollCurrentPane(-10);
                return;
            case UI_COMMANDS.EXPAND_HISTORY:
                await this.expandActiveHistory();
                return;
            case UI_COMMANDS.SCROLL_TOP:
                this.scrollCurrentPaneToTop();
                return;
            case UI_COMMANDS.SCROLL_BOTTOM:
                this.scrollCurrentPaneToBottom();
                return;
            case UI_COMMANDS.CANCEL_SESSION:
                await this.cancelActiveSession();
                return;
            case UI_COMMANDS.DONE_SESSION:
                await this.completeActiveSession();
                return;
            case UI_COMMANDS.DELETE_SESSION:
                await this.deleteActiveSession();
                return;
            case UI_COMMANDS.OPEN_HISTORY_FORMAT:
                this.openHistoryFormat();
                return;
            case UI_COMMANDS.REFRESH_EXECUTION_HISTORY: {
                const sessionId = this.getState().sessions.activeSessionId;
                if (sessionId) {
                    await this.ensureExecutionHistory(sessionId, { force: true });
                }
                return;
            }
            case UI_COMMANDS.EXPORT_EXECUTION_HISTORY: {
                await this.exportExecutionHistory();
                return;
            }
            default:
                return;
        }
    }

    async exportExecutionHistory() {
        const sessionId = this.getState().sessions.activeSessionId;
        if (!sessionId) {
            this.dispatch({ type: "ui/status", text: "No session selected." });
            return;
        }
        if (typeof this.transport.exportExecutionHistory !== "function") {
            this.dispatch({ type: "ui/status", text: "History export is not supported by this transport." });
            return;
        }
        this.dispatch({ type: "ui/status", text: "Exporting execution history..." });
        try {
            const result = await this.transport.exportExecutionHistory(sessionId);
            if (result?.filename) {
                await this.ensureFilesForSession(sessionId, { force: true }).catch(() => null);
                this.dispatch({
                    type: "files/select",
                    sessionId,
                    filename: result.filename,
                });
                this.dispatch({
                    type: "files/selectGlobal",
                    artifactId: `${sessionId}/${result.filename}`,
                });
                await this.ensureFilePreview(sessionId, result.filename, { force: true }).catch(() => null);
            }
            this.dispatch({
                type: "ui/status",
                text: result?.filename
                    ? `History saved as artifact ${result.filename}`
                    : `History exported → ${result?.artifactLink || "artifact created"}`,
            });
        } catch (error) {
            this.dispatch({
                type: "ui/status",
                text: `Export failed: ${error?.message || String(error)}`,
            });
        }
    }
}
