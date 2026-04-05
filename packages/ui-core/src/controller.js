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
    selectActivityPane,
    selectChatLines,
    selectFileBrowserItems,
    selectFilesScope,
    selectFilesView,
    selectInspector,
    selectSelectedFileBrowserItem,
    selectVisibleSessionRows,
} from "./selectors.js";
import { getTheme, listThemes } from "./themes/index.js";

const ORCHESTRATION_STATS_REFRESH_MS = 20_000;

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

function buildSessionMergePatch(previousSession, nextSession) {
    if (!nextSession?.sessionId) return null;

    const patch = { sessionId: nextSession.sessionId };
    for (const [key, value] of Object.entries(nextSession)) {
        if (key === "sessionId" || value === undefined) continue;
        patch[key] = value;
    }

    if (nextSession.pendingQuestion === undefined && previousSession?.pendingQuestion && nextSession.status !== "input_required") {
        patch.pendingQuestion = null;
    }
    if (nextSession.waitReason === undefined && previousSession?.waitReason && nextSession.status !== "waiting" && nextSession.status !== "input_required") {
        patch.waitReason = null;
    }
    if (nextSession.error === undefined && previousSession?.error && nextSession.status !== "failed" && nextSession.status !== "error") {
        patch.error = null;
    }
    if (nextSession.result === undefined && previousSession?.result && nextSession.status !== "completed") {
        patch.result = null;
    }
    if (nextSession.cronActive !== true) {
        if (previousSession?.cronReason) patch.cronReason = null;
        if (previousSession?.cronInterval != null && nextSession.cronInterval === undefined) {
            patch.cronInterval = null;
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
    }

    return patch;
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

function normalizePreviewPayload(filename, rawContent, contentType = "") {
    const normalizedType = String(contentType || "").toLowerCase();
    const ext = fileExtension(filename);

    if (isBinaryPreview(filename, contentType)) {
        return {
            content: `Preview is not available in the terminal UI for ${filename}.\n\nThis artifact looks binary or non-text, so use the downloadable artifact instead.`,
            contentType: contentType || "application/octet-stream",
            renderMode: "note",
        };
    }

    const truncatedText = truncateFilePreview(rawContent);
    if (MARKDOWN_FILE_EXTENSIONS.has(ext) || normalizedType.includes("markdown")) {
        return {
            content: truncatedText,
            contentType: contentType || "text/markdown",
            renderMode: "markdown",
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

    async start() {
        await this.transport.start();
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
                    statusText: "Session refresh failed",
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
            getPromptInputRows(state.ui.prompt),
        );
        const maxRows = Math.max(3, layout.sessionPaneHeight - 2);
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
        if (targetTab === "nodes" || targetTab === "sequence") {
            const sessionIds = Object.keys(this.getState().sessions.byId);
            if (sessionIds.length === 0) return;
            await Promise.allSettled(sessionIds.map((sessionId) => this.ensureSessionHistory(sessionId)));
            if (targetTab === "sequence") {
                const activeSessionId = this.getState().sessions.activeSessionId;
                if (activeSessionId) {
                    await this.ensureOrchestrationStats(activeSessionId).catch(() => {});
                }
            }
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
        if (scope === "allSessions") {
            const sessionIds = [...new Set([
                ...(Array.isArray(this.getState().sessions.flat) ? this.getState().sessions.flat : []),
                ...Object.keys(this.getState().files.bySessionId || {}),
            ])].filter(Boolean);
            if (sessionIds.length === 0) return [];
            return Promise.allSettled(sessionIds.map((sessionId) => this.ensureFilesForSession(sessionId, { force })));
        }
        const sessionId = this.getState().sessions.activeSessionId;
        if (!sessionId) return null;
        return this.ensureFilesForSession(sessionId, { force });
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
        if (!force && preview?.loading) return preview;
        if (!force && preview && (preview.content !== undefined || preview.error)) {
            return preview;
        }

        this.dispatch({ type: "files/previewLoading", sessionId, filename });
        try {
            const previewPayload = isBinaryPreview(filename)
                ? normalizePreviewPayload(filename, "", "")
                : normalizePreviewPayload(
                    filename,
                    await this.transport.downloadArtifact(sessionId, filename),
                    "",
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

    buildArtifactPickerItems(artifactLinks = []) {
        const items = (artifactLinks || []).map((link) => ({
            id: `${link.sessionId}/${link.filename}`,
            kind: "artifact",
            sessionId: link.sessionId,
            filename: link.filename,
        }));

        if (items.length > 1) {
            items.push({
                id: "__downloadAll__",
                kind: "downloadAll",
            });
        }

        return items;
    }

    buildArtifactPickerModal({ artifactLinks, previousFocus, selectedId } = {}) {
        const items = this.buildArtifactPickerItems(artifactLinks);
        if (items.length === 0) return null;
        const selectedIndex = items.findIndex((item) => item.id === selectedId);

        return {
            type: "artifactPicker",
            title: "Artifact Downloads",
            previousFocus,
            artifactLinks,
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
            previousFocus: modal.previousFocus,
            selectedId: selectedId || this.getArtifactPickerSelectionId(),
        });

        if (!nextModal) {
            this.dispatch({ type: "ui/modal", modal: null });
            this.dispatch({ type: "ui/status", text: "No artifact links in the current chat view" });
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

    async openArtifactPicker() {
        const state = this.getState();
        const activeSessionId = state.sessions.activeSessionId;
        if (!activeSessionId) {
            this.dispatch({ type: "ui/status", text: "No session selected" });
            return;
        }

        const artifactLinks = selectActiveArtifactLinks(state);
        if (artifactLinks.length === 0) {
            this.dispatch({ type: "ui/status", text: "No artifact links in the current chat view" });
            return;
        }

        const preferredSelectedFilename = this.getState().files.bySessionId[activeSessionId]?.selectedFilename || null;
        const preferredSelectedId = preferredSelectedFilename
            ? `${activeSessionId}/${preferredSelectedFilename}`
            : null;
        const nextModal = this.buildArtifactPickerModal({
            artifactLinks,
            previousFocus: state.ui.focusRegion,
            selectedId: preferredSelectedId,
        });

        if (!nextModal) {
            this.dispatch({ type: "ui/status", text: "No artifact links in the current chat view" });
            return;
        }

        this.dispatch({ type: "ui/modal", modal: nextModal });
        this.dispatch({ type: "ui/status", text: "Select a linked artifact and press Enter to download" });
    }

    async downloadArtifactModalSelection() {
        const modal = this.getState().ui.modal;
        if (!modal || modal.type !== "artifactPicker") return;

        const selectedItem = modal.items?.[modal.selectedIndex || 0];
        if (!selectedItem) return;

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

    toggleFilePreviewFullscreen() {
        const state = this.getState();
        const sessionId = state.sessions.activeSessionId;
        if (!sessionId) return;
        const fileState = state.files.bySessionId[sessionId];
        if (!fileState?.selectedFilename) return;
        const nextFullscreen = !Boolean(state.files.fullscreen);
        this.dispatch({
            type: "files/fullscreen",
            fullscreen: nextFullscreen,
        });
        this.dispatch({
            type: "ui/status",
            text: nextFullscreen
                ? `Fullscreen files browser: ${fileState.selectedFilename}`
                : `Closed fullscreen files browser`,
        });
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
                        description: "Choose whether the files browser shows only the selected session or aggregates exported files across all sessions.",
                        options: [
                            { id: "selectedSession", label: "Selected session" },
                            { id: "allSessions", label: "All sessions" },
                        ],
                    },
                ],
            },
        });
        this.dispatch({
            type: "ui/status",
            text: `Editing files filter: Scope = ${scope === "allSessions" ? "All sessions" : "Selected session"}`,
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

    attachActiveSession(sessionId) {
        if (this.activeSessionSubscriptionId === sessionId && this.activeSessionUnsub) {
            return;
        }
        this.detachActiveSession();
        this.activeSessionSubscriptionId = sessionId;
        this.activeSessionUnsub = this.transport.subscribeSession(sessionId, (event) => {
            const state = this.getState();
            const existing = state.history.bySessionId.get(sessionId) || { chat: [], activity: [], lastSeq: 0 };
            if (event.seq <= (existing.lastSeq || 0)) return;
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
        });
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
        this.dispatch({ type: "ui/focus", focusRegion: FOCUS_REGIONS.PROMPT });
        this.dispatch({ type: "ui/status", text: `Created session ${created.sessionId.slice(0, 8)}` });
    }

    async createSessionForAgent(agentName, options = {}) {
        if (typeof this.transport.createSessionForAgent !== "function") {
            throw new Error("Named-agent session creation is not supported by this transport");
        }
        const created = await this.transport.createSessionForAgent(agentName, options);
        await this.refreshSessions();
        await this.loadSession(created.sessionId);
        this.dispatch({ type: "ui/focus", focusRegion: FOCUS_REGIONS.PROMPT });
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
                    ? `Attach File (${shortSessionIdValue(sessionId)})`
                    : "Attach File",
                sessionId,
                previousFocus: state.ui.focusRegion,
                value: "",
                cursorIndex: 0,
            },
        });
        this.dispatch({
            type: "ui/status",
            text: sessionId
                ? "Paste a local file path and press Enter to attach it to this session prompt"
                : "Paste a local file path and press Enter to attach it; a new session will be created if needed",
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
        this.dispatch({ type: "ui/focus", focusRegion: FOCUS_REGIONS.PROMPT });
        return created.sessionId;
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
            text: "Uploading attachment...",
        });

        try {
            const sessionId = modal.sessionId || await this.ensurePromptAttachmentSessionId();
            const upload = await this.transport.uploadArtifactFromPath(sessionId, filePath);
            const token = buildPromptAttachmentToken(upload.filename);
            const currentPrompt = this.getState().ui.prompt;
            const currentCursor = this.getState().ui.promptCursor;
            const previousAttachments = this.getPromptAttachments();
            const existingAttachmentIndex = previousAttachments.findIndex((attachment) => (
                attachment?.sessionId === sessionId
                && attachment?.filename === upload.filename
            ));

            if (this.getState().sessions.activeSessionId !== sessionId) {
                await this.loadSession(sessionId);
            }

            if (existingAttachmentIndex === -1 || !currentPrompt.includes(previousAttachments[existingAttachmentIndex]?.token || token)) {
                const insertion = insertPromptTextAtCursor(currentPrompt, currentCursor, `${token} `);
                this.setPrompt(insertion.prompt, insertion.cursor);
            }

            const nextAttachments = existingAttachmentIndex >= 0
                ? previousAttachments.map((attachment, index) => (index === existingAttachmentIndex
                    ? {
                        ...attachment,
                        sessionId,
                        filename: upload.filename,
                        resolvedPath: upload.resolvedPath,
                        sizeBytes: upload.sizeBytes,
                        token,
                    }
                    : attachment))
                : [
                    ...previousAttachments,
                    {
                        id: `${sessionId}/${upload.filename}`,
                        sessionId,
                        filename: upload.filename,
                        resolvedPath: upload.resolvedPath,
                        sizeBytes: upload.sizeBytes,
                        token,
                    },
                ];
            this.setPromptAttachments(nextAttachments);

            await this.ensureFilesForSession(sessionId, { force: true }).catch(() => null);
            this.dispatch({
                type: "files/select",
                sessionId,
                filename: upload.filename,
            });
            if (this.getState().ui.inspectorTab === "files") {
                await this.ensureFilePreview(sessionId, upload.filename, { force: true }).catch(() => null);
            }

            this.dispatch({ type: "ui/modal", modal: null });
            this.dispatch({ type: "ui/focus", focusRegion: FOCUS_REGIONS.PROMPT });
            this.dispatch({
                type: "ui/status",
                text: existingAttachmentIndex >= 0
                    ? `Re-attached ${upload.filename}`
                    : `Attached ${upload.filename}`,
            });
        } catch (error) {
            this.dispatch({
                type: "ui/status",
                text: `Attach failed: ${error?.message || String(error)}`,
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
            this.dispatch({ type: "ui/focus", focusRegion: previousFocus });
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
            this.dispatch({ type: "ui/focus", focusRegion: modal.previousFocus });
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
        if (modal.type === "artifactUpload") {
            await this.confirmArtifactUploadModal();
            return;
        }
        if (modal.type === "renameSession") {
            await this.confirmRenameSessionModal();
            return;
        }
        if (modal.type === "filesFilter") {
            const previousFocus = modal.previousFocus;
            this.dispatch({ type: "ui/modal", modal: null });
            if (previousFocus) this.dispatch({ type: "ui/focus", focusRegion: previousFocus });
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
                this.dispatch({ type: "ui/focus", focusRegion: previousFocus });
            }
            this.dispatch({ type: "ui/status", text: `Applied theme: ${nextTheme.label}` });
            return;
        }
        if (modal.type === "modelPicker") {
            const item = modal.items?.[modal.selectedIndex || 0];
            const previousFocus = modal.previousFocus;
            this.dispatch({ type: "ui/modal", modal: null });
            if (previousFocus) {
                this.dispatch({ type: "ui/focus", focusRegion: previousFocus });
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
                this.dispatch({ type: "ui/focus", focusRegion: previousFocus });
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

        this.logUnsubscribe = this.transport.startLogTail((entry) => {
            this.dispatch({ type: "logs/append", entry });
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

        this.dispatch({ type: "ui/prompt", prompt: "", promptCursor: 0 });
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
                this.dispatch({ type: "ui/status", text: "Answer sent" });
                return;
            }

            await this.transport.sendMessage(sessionId, prompt, {
                enqueueOnly: Boolean(activeSession?.isSystem || activeSession?.status === "running"),
            });
            this.dispatch({ type: "ui/status", text: "Prompt sent" });
        } catch (error) {
            this.dispatch({ type: "ui/prompt", prompt: rawPrompt, promptCursor });
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
        this.dispatch({ type: "ui/prompt", prompt, promptCursor });
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
        const prompt = overrides.prompt ?? this.getState().ui.prompt;
        return computeLegacyLayout({
            width: overrides.width ?? layoutState.viewportWidth ?? 120,
            height: overrides.height ?? layoutState.viewportHeight ?? 40,
        }, overrides.paneAdjust ?? layoutState.paneAdjust ?? 0, overrides.promptRows ?? getPromptInputRows(prompt));
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
        this.dispatch({ type: "ui/focus", focusRegion });
    }

    focusNext() {
        const current = this.getState().ui.focusRegion;
        const order = getFocusOrderForLayout(this.getCurrentLayout());
        this.dispatch({ type: "ui/focus", focusRegion: cycleValue(order, current, 1) });
    }

    focusPrev() {
        const current = this.getState().ui.focusRegion;
        const order = getFocusOrderForLayout(this.getCurrentLayout());
        this.dispatch({ type: "ui/focus", focusRegion: cycleValue(order, current, -1) });
    }

    focusLeft() {
        const current = this.getState().ui.focusRegion;
        this.setFocus(getFocusLeftTarget(current, this.getCurrentLayout()));
    }

    focusRight() {
        const current = this.getState().ui.focusRegion;
        this.setFocus(getFocusRightTarget(current, this.getCurrentLayout()));
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

    nextInspectorTab() {
        const inspectorTab = cycleValue(INSPECTOR_TABS, this.getState().ui.inspectorTab, 1);
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

    async moveSession(delta) {
        const state = this.getState();
        const flat = state.sessions.flat;
        if (flat.length === 0) return;
        const currentId = state.sessions.activeSessionId || flat[0].sessionId;
        const currentIndex = Math.max(0, flat.findIndex((entry) => entry.sessionId === currentId));
        const nextIndex = Math.max(0, Math.min(flat.length - 1, currentIndex + delta));
        const nextId = flat[nextIndex].sessionId;
        await this.loadSession(nextId);
    }

    getSessionPageSize() {
        return Math.max(1, this.getCurrentLayout().sessionPaneHeight - 3);
    }

    async moveSessionPage(deltaPages) {
        const pageSize = this.getSessionPageSize();
        await this.moveSession(pageSize * deltaPages);
    }

    inspectorUsesBottomScroll() {
        return INSPECTOR_BOTTOM_ANCHORED_TABS.has(this.getState().ui.inspectorTab);
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
        const current = Math.max(0, Math.min(Number(state.ui.scroll?.[pane]) || 0, maxOffset));
        const nextOffset = Math.max(0, Math.min(current + delta, maxOffset));
        this.dispatch({ type: "ui/scroll", pane, offset: nextOffset });
        if (pane === "chat" && delta > 0) {
            this.maybeAutoExpandActiveHistory(nextOffset).catch(() => {});
        }
    }

    scrollPaneTo(pane, offset) {
        const maxOffset = this.getPaneMaxScrollOffset(pane, this.getState());
        const nextOffset = Math.max(0, Math.min(Number(offset) || 0, maxOffset));
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
        const inspectorUsesBottomScroll = pane === "inspector" && this.inspectorUsesBottomScroll();
        const usesTopScroll = pane === "inspector" || pane === "filePreview";
        this.scrollPane(pane, usesTopScroll && !inspectorUsesBottomScroll ? -delta : delta);
    }

    scrollCurrentPaneToTop() {
        const pane = this.getScrollablePaneForFocus();
        if (!pane) return;
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
            ui: {
                inspectorTab: state.ui.inspectorTab,
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

    async cancelActiveSession() {
        const sessionId = this.getState().sessions.activeSessionId;
        if (!sessionId) return;
        await this.transport.cancelSession(sessionId);
        this.dispatch({ type: "ui/status", text: `Cancelled ${sessionId.slice(0, 8)}` });
        await this.refreshSessions();
    }

    async completeActiveSession(reason = "Completed by user") {
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

    async deleteActiveSession() {
        const sessionId = this.getState().sessions.activeSessionId;
        if (!sessionId) return;
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
            case UI_COMMANDS.OPEN_ARTIFACT_PICKER:
                await this.openArtifactPicker();
                return;
            case UI_COMMANDS.TOGGLE_LOG_TAIL:
                this.toggleLogTail();
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
            case UI_COMMANDS.OPEN_SELECTED_FILE:
                await this.openSelectedFileInDefaultApp();
                return;
            case UI_COMMANDS.TOGGLE_FILE_PREVIEW_FULLSCREEN:
                this.toggleFilePreviewFullscreen();
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
