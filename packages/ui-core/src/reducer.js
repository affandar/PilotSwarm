import { buildSessionTree } from "./session-tree.js";
import { DEFAULT_HISTORY_EVENT_LIMIT, dedupeChatMessages } from "./history.js";

function cloneHistoryMap(historyMap) {
    return new Map(historyMap);
}

function cloneCollapsedIds(collapsedIds) {
    return new Set(collapsedIds);
}

function cloneOrderById(orderById) {
    return { ...(orderById || {}) };
}

function cloneFilesBySessionId(bySessionId) {
    return { ...(bySessionId || {}) };
}

function cloneOrchestrationBySessionId(bySessionId) {
    return { ...(bySessionId || {}) };
}

function normalizeFilesFilter(filter) {
    return {
        scope: filter?.scope === "allSessions" ? "allSessions" : "selectedSession",
    };
}

function normalizeLogEntries(entries) {
    const list = Array.isArray(entries) ? entries.filter(Boolean) : [];
    return list.slice(-1000);
}

function clampHistoryItems(items, maxItems) {
    const list = Array.isArray(items) ? items.filter(Boolean) : [];
    const safeMax = Math.max(DEFAULT_HISTORY_EVENT_LIMIT, Number(maxItems) || DEFAULT_HISTORY_EVENT_LIMIT);
    return list.length > safeMax ? list.slice(-safeMax) : list;
}

function mergeDefinedSessionFields(previousSession = {}, nextSession = {}) {
    const merged = { ...previousSession };
    for (const [key, value] of Object.entries(nextSession || {})) {
        if (value === undefined) continue;
        merged[key] = value;
    }
    return merged;
}

function assignStableSessionOrder(previousOrderById = {}, nextOrderOrdinal = 0, sessions = []) {
    const orderById = cloneOrderById(previousOrderById);
    let orderOrdinal = Number.isFinite(nextOrderOrdinal) ? nextOrderOrdinal : 0;

    for (const session of sessions || []) {
        const sessionId = session?.sessionId;
        if (!sessionId) continue;
        if (typeof orderById[sessionId] === "number") continue;
        orderById[sessionId] = orderOrdinal;
        orderOrdinal += 1;
    }

    return {
        orderById,
        nextOrderOrdinal: orderOrdinal,
    };
}

function clampPromptCursor(prompt, cursor, fallback = null) {
    const text = String(prompt || "");
    const preferred = Number.isFinite(cursor)
        ? cursor
        : (Number.isFinite(fallback) ? fallback : text.length);
    return Math.max(0, Math.min(preferred, text.length));
}

function normalizePromptAttachments(prompt, attachments) {
    const safePrompt = String(prompt || "");
    const list = Array.isArray(attachments) ? attachments.filter(Boolean) : [];
    return list.filter((attachment) => {
        const token = String(attachment?.token || "").trim();
        return token && safePrompt.includes(token);
    });
}

export function appReducer(state, action) {
    switch (action.type) {
        case "connection/ready":
            return {
                ...state,
                connection: {
                    ...state.connection,
                    connected: true,
                    workersOnline: action.workersOnline ?? state.connection.workersOnline,
                    error: null,
                },
                ui: {
                    ...state.ui,
                    statusText: action.statusText || "Ready",
                },
            };

        case "connection/error":
            return {
                ...state,
                connection: {
                    ...state.connection,
                    connected: false,
                    error: action.error,
                },
                ui: {
                    ...state.ui,
                    statusText: action.statusText || action.error || "Connection error",
                },
            };

        case "ui/status":
            return {
                ...state,
                ui: {
                    ...state.ui,
                    statusText: action.text,
                },
            };

        case "ui/modal":
            return {
                ...state,
                ui: {
                    ...state.ui,
                    modal: action.modal ?? null,
                },
            };

        case "ui/viewport": {
            const currentWidth = state.ui.layout?.viewportWidth ?? 120;
            const currentHeight = state.ui.layout?.viewportHeight ?? 40;
            const nextWidth = Math.max(40, action.width ?? currentWidth);
            const nextHeight = Math.max(18, action.height ?? currentHeight);
            if (nextWidth === currentWidth && nextHeight === currentHeight) {
                return state;
            }
            return {
                ...state,
                ui: {
                    ...state.ui,
                    layout: {
                        ...(state.ui.layout || {}),
                        viewportWidth: nextWidth,
                        viewportHeight: nextHeight,
                    },
                },
            };
        }

        case "ui/paneAdjust":
            return {
                ...state,
                ui: {
                    ...state.ui,
                    layout: {
                        ...(state.ui.layout || {}),
                        paneAdjust: Number(action.paneAdjust) || 0,
                    },
                },
            };

        case "ui/focus":
            return {
                ...state,
                ui: {
                    ...state.ui,
                    focusRegion: action.focusRegion,
                },
            };

        case "ui/modalSelection": {
            const modal = state.ui.modal;
            if (!modal || !Array.isArray(modal.items) || modal.items.length === 0) {
                return state;
            }
            const nextIndex = Math.max(0, Math.min(action.index ?? 0, modal.items.length - 1));
            return {
                ...state,
                ui: {
                    ...state.ui,
                    modal: {
                        ...modal,
                        selectedIndex: nextIndex,
                    },
                },
            };
        }

        case "ui/scroll":
            return {
                ...state,
                ui: {
                    ...state.ui,
                    scroll: {
                        ...state.ui.scroll,
                        [action.pane]: Math.max(0, action.offset ?? 0),
                    },
                },
            };

        case "ui/inspectorTab":
            return {
                ...state,
                ui: {
                    ...state.ui,
                    inspectorTab: action.inspectorTab,
                    scroll: {
                        ...state.ui.scroll,
                        inspector: 0,
                    },
                },
                files: action.inspectorTab === "files"
                    ? state.files
                    : {
                        ...state.files,
                        fullscreen: false,
                    },
            };

        case "ui/prompt":
            return {
                ...state,
                ui: {
                    ...state.ui,
                    prompt: action.prompt,
                    promptCursor: clampPromptCursor(action.prompt, action.promptCursor, state.ui.promptCursor),
                    promptAttachments: normalizePromptAttachments(action.prompt, state.ui.promptAttachments),
                },
            };

        case "ui/promptAttachments":
            return {
                ...state,
                ui: {
                    ...state.ui,
                    promptAttachments: normalizePromptAttachments(
                        state.ui.prompt,
                        action.attachments,
                    ),
                },
            };

        case "sessions/loaded": {
            const byId = {};
            for (const session of action.sessions) {
                byId[session.sessionId] = mergeDefinedSessionFields(
                    state.sessions.byId[session.sessionId] || {},
                    session,
                );
            }
            if (
                state.sessions.activeSessionId
                && state.sessions.byId[state.sessions.activeSessionId]
                && !byId[state.sessions.activeSessionId]
            ) {
                byId[state.sessions.activeSessionId] = {
                    ...state.sessions.byId[state.sessions.activeSessionId],
                };
            }
            const mergedSessions = Object.values(byId);
            const {
                orderById,
                nextOrderOrdinal,
            } = assignStableSessionOrder(
                state.sessions.orderById,
                state.sessions.nextOrderOrdinal,
                mergedSessions,
            );
            const activeSessionId = state.sessions.activeSessionId && byId[state.sessions.activeSessionId]
                ? state.sessions.activeSessionId
                : (mergedSessions[0]?.sessionId || null);
            return {
                ...state,
                sessions: {
                    ...state.sessions,
                    byId,
                    flat: buildSessionTree(mergedSessions, state.sessions.collapsedIds, orderById),
                    activeSessionId,
                    orderById,
                    nextOrderOrdinal,
                },
            };
        }

        case "sessions/merged": {
            if (!action.session?.sessionId) return state;
            const byId = {
                ...state.sessions.byId,
                [action.session.sessionId]: {
                    ...(state.sessions.byId[action.session.sessionId] || {}),
                    ...action.session,
                },
            };
            const {
                orderById,
                nextOrderOrdinal,
            } = assignStableSessionOrder(
                state.sessions.orderById,
                state.sessions.nextOrderOrdinal,
                Object.values(byId),
            );
            return {
                ...state,
                sessions: {
                    ...state.sessions,
                    byId,
                    flat: buildSessionTree(Object.values(byId), state.sessions.collapsedIds, orderById),
                    orderById,
                    nextOrderOrdinal,
                },
            };
        }

        case "sessions/selected":
            return {
                ...state,
                sessions: {
                    ...state.sessions,
                    activeSessionId: action.sessionId,
                },
                ui: {
                    ...state.ui,
                    scroll: {
                        ...state.ui.scroll,
                        chat: 0,
                        inspector: 0,
                        activity: 0,
                    },
                },
            };

        case "sessions/collapse": {
            const collapsedIds = cloneCollapsedIds(state.sessions.collapsedIds);
            collapsedIds.add(action.sessionId);
            return {
                ...state,
                sessions: {
                    ...state.sessions,
                    collapsedIds,
                    flat: buildSessionTree(Object.values(state.sessions.byId), collapsedIds, state.sessions.orderById),
                },
            };
        }

        case "sessions/expand": {
            const collapsedIds = cloneCollapsedIds(state.sessions.collapsedIds);
            collapsedIds.delete(action.sessionId);
            return {
                ...state,
                sessions: {
                    ...state.sessions,
                    collapsedIds,
                    flat: buildSessionTree(Object.values(state.sessions.byId), collapsedIds, state.sessions.orderById),
                },
            };
        }

        case "history/set": {
            const previousHistory = state.history.bySessionId.get(action.sessionId) || null;
            const previousChat = previousHistory?.chat || [];
            const loadedEventLimit = Math.max(
                DEFAULT_HISTORY_EVENT_LIMIT,
                Number(action.history?.loadedEventLimit ?? previousHistory?.loadedEventLimit ?? DEFAULT_HISTORY_EVENT_LIMIT) || DEFAULT_HISTORY_EVENT_LIMIT,
            );
            const nextChat = clampHistoryItems(dedupeChatMessages(action.history?.chat || []), loadedEventLimit);
            const previousLastChatId = previousChat[previousChat.length - 1]?.id || null;
            const nextLastChatId = nextChat[nextChat.length - 1]?.id || null;
            const activeChatUpdated = action.sessionId === state.sessions.activeSessionId
                && nextLastChatId !== previousLastChatId;
            const nextHistory = cloneHistoryMap(state.history.bySessionId);
            nextHistory.set(action.sessionId, {
                ...(action.history || {}),
                chat: nextChat,
                activity: clampHistoryItems(action.history?.activity || [], loadedEventLimit),
                events: clampHistoryItems(action.history?.events || [], loadedEventLimit),
                loadedEventLimit,
            });
            return {
                ...state,
                history: {
                    ...state.history,
                    bySessionId: nextHistory,
                },
                ui: activeChatUpdated
                    ? {
                        ...state.ui,
                        scroll: {
                            ...state.ui.scroll,
                            chat: 0,
                        },
                    }
                    : state.ui,
            };
        }

        case "orchestration/statsLoading": {
            const bySessionId = cloneOrchestrationBySessionId(state.orchestration.bySessionId);
            bySessionId[action.sessionId] = {
                ...(bySessionId[action.sessionId] || {}),
                loading: true,
                error: null,
            };
            return {
                ...state,
                orchestration: {
                    ...state.orchestration,
                    bySessionId,
                },
            };
        }

        case "orchestration/statsLoaded": {
            const bySessionId = cloneOrchestrationBySessionId(state.orchestration.bySessionId);
            bySessionId[action.sessionId] = {
                loading: false,
                error: null,
                fetchedAt: action.fetchedAt || Date.now(),
                stats: action.stats || null,
            };
            return {
                ...state,
                orchestration: {
                    ...state.orchestration,
                    bySessionId,
                },
            };
        }

        case "orchestration/statsError": {
            const bySessionId = cloneOrchestrationBySessionId(state.orchestration.bySessionId);
            bySessionId[action.sessionId] = {
                ...(bySessionId[action.sessionId] || {}),
                loading: false,
                error: action.error || "Failed to load orchestration stats",
                fetchedAt: action.fetchedAt || Date.now(),
            };
            return {
                ...state,
                orchestration: {
                    ...state.orchestration,
                    bySessionId,
                },
            };
        }

        case "files/sessionLoading": {
            const bySessionId = cloneFilesBySessionId(state.files.bySessionId);
            const current = bySessionId[action.sessionId] || {
                entries: [],
                previews: {},
                downloads: {},
                selectedFilename: null,
            };
            bySessionId[action.sessionId] = {
                ...current,
                loading: true,
                error: null,
            };
            return {
                ...state,
                files: {
                    ...state.files,
                    bySessionId,
                },
            };
        }

        case "files/sessionLoaded": {
            const bySessionId = cloneFilesBySessionId(state.files.bySessionId);
            const current = bySessionId[action.sessionId] || {
                previews: {},
                downloads: {},
            };
            const entries = Array.isArray(action.entries) ? [...action.entries] : [];
            const selectedFilename = current.selectedFilename && entries.includes(current.selectedFilename)
                ? current.selectedFilename
                : (action.selectedFilename && entries.includes(action.selectedFilename)
                    ? action.selectedFilename
                    : (entries[0] || null));
            bySessionId[action.sessionId] = {
                ...current,
                entries,
                selectedFilename,
                loading: false,
                loaded: true,
                error: null,
            };
            return {
                ...state,
                files: {
                    ...state.files,
                    bySessionId,
                },
            };
        }

        case "files/sessionError": {
            const bySessionId = cloneFilesBySessionId(state.files.bySessionId);
            const current = bySessionId[action.sessionId] || {
                entries: [],
                previews: {},
                downloads: {},
                selectedFilename: null,
            };
            bySessionId[action.sessionId] = {
                ...current,
                loading: false,
                loaded: true,
                error: action.error || "Failed to load files",
            };
            return {
                ...state,
                files: {
                    ...state.files,
                    bySessionId,
                },
            };
        }

        case "files/select": {
            const bySessionId = cloneFilesBySessionId(state.files.bySessionId);
            const current = bySessionId[action.sessionId] || {
                entries: [],
                previews: {},
                downloads: {},
                selectedFilename: null,
            };
            bySessionId[action.sessionId] = {
                ...current,
                selectedFilename: action.filename || null,
            };
            return {
                ...state,
                files: {
                    ...state.files,
                    bySessionId,
                },
                ui: {
                    ...state.ui,
                    scroll: {
                        ...state.ui.scroll,
                        filePreview: 0,
                    },
                },
            };
        }

        case "files/selectGlobal":
            return {
                ...state,
                files: {
                    ...state.files,
                    selectedArtifactId: action.artifactId || null,
                },
                ui: {
                    ...state.ui,
                    scroll: {
                        ...state.ui.scroll,
                        filePreview: 0,
                    },
                },
            };

        case "files/previewLoading": {
            const bySessionId = cloneFilesBySessionId(state.files.bySessionId);
            const current = bySessionId[action.sessionId] || {
                entries: [],
                previews: {},
                downloads: {},
                selectedFilename: action.filename || null,
            };
            const previews = {
                ...(current.previews || {}),
                [action.filename]: {
                    ...(current.previews?.[action.filename] || {}),
                    loading: true,
                    error: null,
                },
            };
            bySessionId[action.sessionId] = {
                ...current,
                previews,
            };
            return {
                ...state,
                files: {
                    ...state.files,
                    bySessionId,
                },
            };
        }

        case "files/previewLoaded": {
            const bySessionId = cloneFilesBySessionId(state.files.bySessionId);
            const current = bySessionId[action.sessionId] || {
                entries: [],
                previews: {},
                downloads: {},
                selectedFilename: action.filename || null,
            };
            const previews = {
                ...(current.previews || {}),
                [action.filename]: {
                    loading: false,
                    error: null,
                    content: action.content || "",
                    contentType: action.contentType || "text/plain",
                    renderMode: action.renderMode || "text",
                },
            };
            bySessionId[action.sessionId] = {
                ...current,
                previews,
            };
            return {
                ...state,
                files: {
                    ...state.files,
                    bySessionId,
                },
            };
        }

        case "files/previewError": {
            const bySessionId = cloneFilesBySessionId(state.files.bySessionId);
            const current = bySessionId[action.sessionId] || {
                entries: [],
                previews: {},
                downloads: {},
                selectedFilename: action.filename || null,
            };
            const previews = {
                ...(current.previews || {}),
                [action.filename]: {
                    ...(current.previews?.[action.filename] || {}),
                    loading: false,
                    error: action.error || "Failed to load file preview",
                },
            };
            bySessionId[action.sessionId] = {
                ...current,
                previews,
            };
            return {
                ...state,
                files: {
                    ...state.files,
                    bySessionId,
                },
            };
        }

        case "files/downloaded": {
            const bySessionId = cloneFilesBySessionId(state.files.bySessionId);
            const current = bySessionId[action.sessionId] || {
                entries: [],
                previews: {},
                downloads: {},
                selectedFilename: action.filename || null,
            };
            const downloads = {
                ...(current.downloads || {}),
                [action.filename]: {
                    localPath: action.localPath || null,
                    downloadedAt: action.downloadedAt || Date.now(),
                },
            };
            bySessionId[action.sessionId] = {
                ...current,
                downloads,
            };
            return {
                ...state,
                files: {
                    ...state.files,
                    bySessionId,
                },
            };
        }

        case "files/fullscreen":
            return {
                ...state,
                files: {
                    ...state.files,
                    fullscreen: Boolean(action.fullscreen),
                },
                ui: Boolean(action.fullscreen)
                    ? {
                        ...state.ui,
                        focusRegion: "inspector",
                    }
                    : state.ui,
            };

        case "files/filter":
            return {
                ...state,
                files: {
                    ...state.files,
                    filter: {
                        ...normalizeFilesFilter(state.files.filter),
                        ...normalizeFilesFilter(action.filter),
                    },
                    ...(normalizeFilesFilter(action.filter).scope === "selectedSession"
                        ? {}
                        : {
                            selectedArtifactId: state.files.selectedArtifactId || null,
                        }),
                },
                ui: {
                    ...state.ui,
                    scroll: {
                        ...state.ui.scroll,
                        filePreview: 0,
                    },
                },
            };

        case "logs/config":
            return {
                ...state,
                logs: {
                    ...state.logs,
                    available: Boolean(action.available),
                    availabilityReason: action.availabilityReason || state.logs.availabilityReason,
                },
            };

        case "logs/tailing":
            return {
                ...state,
                logs: {
                    ...state.logs,
                    tailing: Boolean(action.tailing),
                },
            };

        case "logs/filter":
            return {
                ...state,
                logs: {
                    ...state.logs,
                    filter: {
                        ...state.logs.filter,
                        ...(action.filter || {}),
                    },
                },
            };

        case "logs/set":
            return {
                ...state,
                logs: {
                    ...state.logs,
                    entries: normalizeLogEntries(action.entries),
                },
            };

        case "logs/append":
            return {
                ...state,
                logs: {
                    ...state.logs,
                    entries: normalizeLogEntries([
                        ...(state.logs.entries || []),
                        ...(Array.isArray(action.entries) ? action.entries : [action.entry]).filter(Boolean),
                    ]),
                },
            };

        default:
            return state;
    }
}
