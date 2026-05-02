import { buildSessionTree } from "./session-tree.js";
import { FOCUS_REGIONS } from "./commands.js";
import { DEFAULT_HISTORY_EVENT_LIMIT, dedupeChatMessages } from "./history.js";
import { getPromptInputRows } from "./layout.js";
import { selectSessionRows } from "./selectors.js";
import {
    normalizeArtifactEntries,
    normalizeSessionOwnerFilter,
    normalizeStoredLayoutAdjustments,
    normalizeStoredPinnedSessionIds,
} from "./state.js";

function cloneHistoryMap(historyMap) {
    return new Map(historyMap);
}

function cloneCollapsedIds(collapsedIds) {
    return new Set(collapsedIds);
}

function clonePinnedIds(pinnedIds) {
    return Array.isArray(pinnedIds) ? [...pinnedIds] : [];
}

function cloneSelectedIds(selectedIds) {
    return Array.isArray(selectedIds) ? [...selectedIds] : [];
}

function pruneIdList(ids, byId) {
    const out = [];
    const seen = new Set();
    for (const id of ids || []) {
        if (!id || seen.has(id)) continue;
        if (!byId[id]) continue;
        seen.add(id);
        out.push(id);
    }
    return out;
}

function cloneOrderById(orderById) {
    return { ...(orderById || {}) };
}

function cloneFilesBySessionId(bySessionId) {
    return { ...(bySessionId || {}) };
}

function cloneOutboxBySessionId(bySessionId) {
    return { ...(bySessionId || {}) };
}

function cloneOrchestrationBySessionId(bySessionId) {
    return { ...(bySessionId || {}) };
}

function normalizeFilesFilter(filter) {
    return {
        scope: filter?.scope === "allSessions" ? "allSessions" : "selectedSession",
        query: typeof filter?.query === "string" ? filter.query : "",
    };
}

function normalizeLogEntries(entries) {
    const list = Array.isArray(entries) ? entries.filter(Boolean) : [];
    return list.slice(-1000);
}

function normalizeFullscreenPane(fullscreenPane) {
    return [
        FOCUS_REGIONS.SESSIONS,
        FOCUS_REGIONS.CHAT,
        FOCUS_REGIONS.INSPECTOR,
        FOCUS_REGIONS.ACTIVITY,
    ].includes(fullscreenPane)
        ? fullscreenPane
        : null;
}

function clampHistoryItems(items, maxItems) {
    const list = Array.isArray(items) ? items.filter(Boolean) : [];
    const safeMax = Math.max(DEFAULT_HISTORY_EVENT_LIMIT, Number(maxItems) || DEFAULT_HISTORY_EVENT_LIMIT);
    return list.length > safeMax ? list.slice(-safeMax) : list;
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

function mergeDefinedSessionFields(previousSession = {}, nextSession = {}) {
    let merged = previousSession || {};
    for (const [key, value] of Object.entries(nextSession || {})) {
        if (value === undefined) continue;
        if (key === "pendingQuestion" && isAnsweredPendingQuestion(previousSession, value)) {
            if (merged === previousSession) {
                merged = { ...(previousSession || {}) };
            }
            merged.pendingQuestion = null;
            continue;
        }
        if (areStructuredValuesEqual(previousSession?.[key], value)) continue;
        if (merged === previousSession) {
            merged = { ...(previousSession || {}) };
        }
        merged[key] = value;
    }
    return merged;
}

function normalizedPendingQuestionText(pendingQuestion) {
    return String(pendingQuestion?.question || "").trim();
}

function isAnsweredPendingQuestion(previousSession, pendingQuestion) {
    const answeredQuestion = normalizedPendingQuestionText(previousSession?.answeredPendingQuestion);
    const incomingQuestion = normalizedPendingQuestionText(pendingQuestion);
    return Boolean(answeredQuestion && incomingQuestion && answeredQuestion === incomingQuestion);
}

function pickDefaultActiveSessionId(sessions = []) {
    const firstNonSystem = (sessions || []).find((session) => session?.sessionId && !session.isSystem);
    return firstNonSystem?.sessionId || null;
}

function hasSessionVisibilityFilter(sessions = {}) {
    const query = String(sessions?.filterQuery || "").trim();
    const ownerFilter = normalizeSessionOwnerFilter(sessions?.ownerFilter);
    return Boolean(query) || ownerFilter.all !== true;
}

function resolveVisibleActiveSessionId(state, fallbackSessions = []) {
    const visibleRows = selectSessionRows(state);
    const currentSessionId = state.sessions?.activeSessionId || null;
    if (currentSessionId && visibleRows.some((row) => row.sessionId === currentSessionId)) {
        return currentSessionId;
    }
    if (hasSessionVisibilityFilter(state.sessions)) {
        return visibleRows[0]?.sessionId || null;
    }

    const visibleSessions = visibleRows.length > 0
        ? visibleRows
            .map((row) => state.sessions?.byId?.[row.sessionId] || null)
            .filter(Boolean)
        : fallbackSessions;

    return pickDefaultActiveSessionId(visibleSessions);
}

function updateUiForSessionSelection(state, nextActiveSessionId) {
    if (nextActiveSessionId === state.sessions.activeSessionId) {
        return state.ui;
    }
    return {
        ...state.ui,
        scroll: {
            ...state.ui.scroll,
            chat: 0,
            inspector: 0,
            activity: 0,
        },
        followBottom: {
            ...(state.ui.followBottom || {}),
            inspector: true,
            activity: true,
        },
    };
}

function applyVisibleSessionSelection(state, nextSessions) {
    const nextState = {
        ...state,
        sessions: nextSessions,
    };
    const nextActiveSessionId = resolveVisibleActiveSessionId(nextState, Object.values(nextSessions.byId || {}));
    return {
        sessions: {
            ...nextSessions,
            activeSessionId: nextActiveSessionId,
        },
        ui: updateUiForSessionSelection(state, nextActiveSessionId),
    };
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
                    statusText: action.statusText ?? state.ui.statusText ?? "Ready",
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

        case "auth/context":
            return {
                ...state,
                auth: {
                    principal: action.principal ?? null,
                    authorization: action.authorization ?? null,
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

        case "ui/theme":
            return {
                ...state,
                ui: {
                    ...state.ui,
                    themeId: action.themeId || state.ui.themeId,
                },
            };

        case "profileSettings/apply": {
            const settings = action.settings && typeof action.settings === "object" && !Array.isArray(action.settings)
                ? action.settings
                : {};
            const hasTheme = Object.prototype.hasOwnProperty.call(settings, "themeId")
                && typeof settings.themeId === "string"
                && settings.themeId.trim();
            const hasOwnerFilter = Object.prototype.hasOwnProperty.call(settings, "sessionOwnerFilter");
            const hasLayout = Object.prototype.hasOwnProperty.call(settings, "layoutAdjustments");
            const hasPins = Object.prototype.hasOwnProperty.call(settings, "pinnedSessionIds");
            const nextLayout = hasLayout
                ? {
                    ...(state.ui.layout || {}),
                    ...normalizeStoredLayoutAdjustments(settings.layoutAdjustments),
                }
                : state.ui.layout;
            const nextPinnedIds = hasPins
                ? normalizeStoredPinnedSessionIds(settings.pinnedSessionIds)
                : state.sessions.pinnedIds;
            const nextSessions = {
                ...state.sessions,
                ...(hasOwnerFilter
                    ? {
                        ownerFilter: normalizeSessionOwnerFilter(settings.sessionOwnerFilter),
                        ownerFilterExplicit: true,
                    }
                    : {}),
                pinnedIds: nextPinnedIds,
                flat: hasPins
                    ? buildSessionTree(Object.values(state.sessions.byId), state.sessions.collapsedIds, state.sessions.orderById, nextPinnedIds)
                    : state.sessions.flat,
            };
            const selection = hasOwnerFilter || hasPins
                ? applyVisibleSessionSelection(state, nextSessions)
                : { sessions: nextSessions, ui: state.ui };
            return {
                ...state,
                sessions: selection.sessions,
                ui: {
                    ...selection.ui,
                    themeId: hasTheme ? settings.themeId.trim() : selection.ui.themeId,
                    layout: nextLayout,
                },
            };
        }

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

        case "ui/sessionPaneAdjust":
            return {
                ...state,
                ui: {
                    ...state.ui,
                    layout: {
                        ...(state.ui.layout || {}),
                        sessionPaneAdjust: Number(action.sessionPaneAdjust) || 0,
                    },
                },
            };

        case "ui/activityPaneAdjust":
            return {
                ...state,
                ui: {
                    ...state.ui,
                    layout: {
                        ...(state.ui.layout || {}),
                        activityPaneAdjust: Number(action.activityPaneAdjust) || 0,
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

        case "sessions/filterQuery":
            {
                const nextSessions = {
                    ...state.sessions,
                    filterQuery: typeof action.query === "string" ? action.query : "",
                };
                const selection = applyVisibleSessionSelection(state, nextSessions);
                return {
                    ...state,
                    sessions: selection.sessions,
                    ui: selection.ui,
                };
            }

        case "sessions/ownerFilter":
            {
                const nextSessions = {
                    ...state.sessions,
                    ownerFilterExplicit: true,
                    ownerFilter: normalizeSessionOwnerFilter(action.filter),
                };
                const selection = applyVisibleSessionSelection(state, nextSessions);
                return {
                    ...state,
                    sessions: selection.sessions,
                    ui: selection.ui,
                };
            }

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

        case "ui/followBottom": {
            if (action.pane !== "inspector" && action.pane !== "activity") {
                return state;
            }
            const nextFollowBottom = Boolean(action.followBottom);
            if (state.ui.followBottom?.[action.pane] === nextFollowBottom) {
                return state;
            }
            return {
                ...state,
                ui: {
                    ...state.ui,
                    followBottom: {
                        ...(state.ui.followBottom || {}),
                        [action.pane]: nextFollowBottom,
                    },
                },
            };
        }

        case "ui/inspectorTab":
            return {
                ...state,
                ui: {
                    ...state.ui,
                    inspectorTab: action.inspectorTab,
                    fullscreenPane: action.inspectorTab === "files" && state.ui.fullscreenPane === FOCUS_REGIONS.INSPECTOR
                        ? null
                        : state.ui.fullscreenPane,
                    scroll: {
                        ...state.ui.scroll,
                        inspector: 0,
                    },
                    followBottom: {
                        ...(state.ui.followBottom || {}),
                        inspector: true,
                    },
                },
                files: action.inspectorTab === "files"
                    ? state.files
                    : {
                        ...state.files,
                        fullscreen: false,
                    },
            };

        case "ui/statsViewMode":
            return {
                ...state,
                ui: {
                    ...state.ui,
                    statsViewMode: ["session", "fleet", "users"].includes(action.statsViewMode)
                        ? action.statsViewMode
                        : "session",
                    scroll: {
                        ...state.ui.scroll,
                        inspector: 0,
                    },
                },
            };

        case "ui/prompt":
            return {
                ...state,
                ui: {
                    ...state.ui,
                    prompt: action.prompt,
                    promptCursor: clampPromptCursor(action.prompt, action.promptCursor, state.ui.promptCursor),
                    promptRows: getPromptInputRows(action.prompt),
                    promptAttachments: normalizePromptAttachments(action.prompt, state.ui.promptAttachments),
                },
            };

        case "ui/promptEdit":
            return {
                ...state,
                ui: {
                    ...state.ui,
                    promptEdit: action.promptEdit ?? null,
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
            let anyChanged = false;
            for (const session of action.sessions) {
                const previous = state.sessions.byId[session.sessionId];
                const merged = mergeDefinedSessionFields(previous, session);
                byId[session.sessionId] = merged;
                if (!anyChanged && merged !== previous) anyChanged = true;
            }
            if (
                state.sessions.activeSessionId
                && state.sessions.byId[state.sessions.activeSessionId]
                && !byId[state.sessions.activeSessionId]
            ) {
                byId[state.sessions.activeSessionId] = {
                    ...state.sessions.byId[state.sessions.activeSessionId],
                };
                anyChanged = true;
            }
            // Check if session set changed (added/removed)
            const prevIds = Object.keys(state.sessions.byId);
            const nextIds = Object.keys(byId);
            if (prevIds.length !== nextIds.length) anyChanged = true;
            if (!anyChanged) {
                for (const id of nextIds) {
                    if (!state.sessions.byId[id]) { anyChanged = true; break; }
                }
            }
            if (!anyChanged) return state;
            const mergedSessions = Object.values(byId);
            const {
                orderById,
                nextOrderOrdinal,
            } = assignStableSessionOrder(
                state.sessions.orderById,
                state.sessions.nextOrderOrdinal,
                mergedSessions,
            );
            const collapsedIds = cloneCollapsedIds(state.sessions.collapsedIds);
            const previousParentIds = new Set(
                Object.values(state.sessions.byId)
                    .map((session) => session.parentSessionId)
                    .filter((sessionId) => Boolean(sessionId)),
            );
            const parentIds = new Set(
                mergedSessions
                    .map((session) => session.parentSessionId)
                    .filter((sessionId) => Boolean(sessionId)),
            );
            for (const sessionId of parentIds) {
                if (!previousParentIds.has(sessionId)) {
                    collapsedIds.add(sessionId);
                }
            }
            // Drop pins/selection for sessions that no longer exist; only
            // keep pins on top-level rows (children cannot be pinned).
            const survivingPins = pruneIdList(state.sessions.pinnedIds, byId)
                .filter((sessionId) => !byId[sessionId]?.parentSessionId);
            const survivingSelected = pruneIdList(state.sessions.selectedIds, byId);
            const flat = buildSessionTree(mergedSessions, collapsedIds, orderById, survivingPins);
            const nextSessions = {
                ...state.sessions,
                byId,
                collapsedIds,
                pinnedIds: survivingPins,
                selectedIds: survivingSelected,
                selectMode: state.sessions.selectMode && survivingSelected.length > 0,
                flat,
                activeSessionId: state.sessions.activeSessionId,
                orderById,
                nextOrderOrdinal,
            };
            const selection = applyVisibleSessionSelection(state, nextSessions);
            return {
                ...state,
                sessions: selection.sessions,
                ui: selection.ui,
            };
        }

        case "sessions/merged": {
            if (!action.session?.sessionId) return state;
            const previousSession = state.sessions.byId[action.session.sessionId];
            const mergedSession = mergeDefinedSessionFields(previousSession, action.session);
            if (mergedSession === previousSession) return state;
            const byId = {
                ...state.sessions.byId,
                [action.session.sessionId]: mergedSession,
            };
            const {
                orderById,
                nextOrderOrdinal,
            } = assignStableSessionOrder(
                state.sessions.orderById,
                state.sessions.nextOrderOrdinal,
                Object.values(byId),
            );
            const nextSessions = {
                ...state.sessions,
                byId,
                flat: buildSessionTree(Object.values(byId), state.sessions.collapsedIds, orderById, state.sessions.pinnedIds),
                activeSessionId: state.sessions.activeSessionId,
                orderById,
                nextOrderOrdinal,
            };
            const selection = applyVisibleSessionSelection(state, nextSessions);
            return {
                ...state,
                sessions: selection.sessions,
                ui: selection.ui,
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
                    followBottom: {
                        ...(state.ui.followBottom || {}),
                        inspector: true,
                        activity: true,
                    },
                },
            };

        case "ui/fullscreenPane": {
            const fullscreenPane = normalizeFullscreenPane(action.fullscreenPane);
            return {
                ...state,
                files: fullscreenPane
                    ? {
                        ...state.files,
                        fullscreen: false,
                    }
                    : state.files,
                ui: {
                    ...state.ui,
                    fullscreenPane,
                    focusRegion: fullscreenPane || state.ui.focusRegion,
                },
            };
        }

        case "sessions/collapse": {
            const collapsedIds = cloneCollapsedIds(state.sessions.collapsedIds);
            collapsedIds.add(action.sessionId);
            return {
                ...state,
                sessions: {
                    ...state.sessions,
                    collapsedIds,
                    flat: buildSessionTree(Object.values(state.sessions.byId), collapsedIds, state.sessions.orderById, state.sessions.pinnedIds),
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
                    flat: buildSessionTree(Object.values(state.sessions.byId), collapsedIds, state.sessions.orderById, state.sessions.pinnedIds),
                },
            };
        }

        case "sessions/pinToggle": {
            const sessionId = String(action.sessionId || "").trim();
            if (!sessionId) return state;
            const session = state.sessions.byId[sessionId];
            // Pinning is a TOP-LEVEL-only concept. System sessions and child
            // sessions cannot be pinned.
            if (!session || session.isSystem || session.parentSessionId) return state;
            const current = clonePinnedIds(state.sessions.pinnedIds);
            const existingIndex = current.indexOf(sessionId);
            const nextPinned = existingIndex >= 0
                ? current.filter((id) => id !== sessionId)
                : [...current, sessionId];
            return {
                ...state,
                sessions: {
                    ...state.sessions,
                    pinnedIds: nextPinned,
                    flat: buildSessionTree(Object.values(state.sessions.byId), state.sessions.collapsedIds, state.sessions.orderById, nextPinned),
                },
            };
        }

        case "sessions/selectMode": {
            const enabled = Boolean(action.enabled);
            if (enabled === Boolean(state.sessions.selectMode)
                && (enabled || state.sessions.selectedIds.length === 0)) {
                return state;
            }
            return {
                ...state,
                sessions: {
                    ...state.sessions,
                    selectMode: enabled,
                    selectedIds: enabled ? state.sessions.selectedIds : [],
                },
            };
        }

        case "sessions/selectToggle": {
            const sessionId = String(action.sessionId || "").trim();
            const session = sessionId ? state.sessions.byId[sessionId] : null;
            if (!session) return state;
            // System sessions (PilotSwarm, Sweeper, Resource Manager, etc.)
            // are managed by the worker and cannot be bulk-terminated.
            if (session.isSystem) return state;
            const current = cloneSelectedIds(state.sessions.selectedIds);
            const existingIndex = current.indexOf(sessionId);
            const nextSelected = existingIndex >= 0
                ? current.filter((id) => id !== sessionId)
                : [...current, sessionId];
            return {
                ...state,
                sessions: {
                    ...state.sessions,
                    selectedIds: nextSelected,
                    selectMode: nextSelected.length > 0 ? true : state.sessions.selectMode,
                },
            };
        }

        case "sessions/selectSet": {
            const ids = Array.isArray(action.sessionIds) ? action.sessionIds : [];
            // System sessions are not selectable for bulk operations.
            const next = pruneIdList(ids, state.sessions.byId)
                .filter((id) => !state.sessions.byId[id]?.isSystem);
            return {
                ...state,
                sessions: {
                    ...state.sessions,
                    selectedIds: next,
                    selectMode: next.length > 0 ? true : state.sessions.selectMode,
                },
            };
        }

        case "sessions/selectClear": {
            if (state.sessions.selectedIds.length === 0 && !state.sessions.selectMode) return state;
            return {
                ...state,
                sessions: {
                    ...state.sessions,
                    selectedIds: [],
                    selectMode: false,
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

        case "history/evict": {
            const ids = Array.isArray(action.sessionIds) ? action.sessionIds : [];
            if (ids.length === 0) return state;
            const nextHistory = cloneHistoryMap(state.history.bySessionId);
            for (const id of ids) nextHistory.delete(id);
            const nextOutbox = cloneOutboxBySessionId(state.outbox?.bySessionId);
            for (const id of ids) delete nextOutbox[id];
            return {
                ...state,
                history: {
                    ...state.history,
                    bySessionId: nextHistory,
                },
                outbox: {
                    ...state.outbox,
                    bySessionId: nextOutbox,
                },
            };
        }

        case "outbox/setSessionItems": {
            const sessionId = action.sessionId;
            if (!sessionId) return state;
            const items = Array.isArray(action.items) ? action.items.filter(Boolean) : [];
            const nextOutbox = cloneOutboxBySessionId(state.outbox?.bySessionId);
            if (items.length === 0) {
                delete nextOutbox[sessionId];
            } else {
                nextOutbox[sessionId] = items;
            }
            return {
                ...state,
                outbox: {
                    ...state.outbox,
                    bySessionId: nextOutbox,
                },
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

        case "orchestration/evict": {
            const ids = Array.isArray(action.sessionIds) ? action.sessionIds : [];
            if (ids.length === 0) return state;
            const bySessionId = cloneOrchestrationBySessionId(state.orchestration.bySessionId);
            for (const id of ids) delete bySessionId[id];
            return {
                ...state,
                orchestration: {
                    ...state.orchestration,
                    bySessionId,
                },
            };
        }

        case "executionHistory/loading": {
            const bySessionId = { ...(state.executionHistory?.bySessionId || {}) };
            bySessionId[action.sessionId] = {
                ...(bySessionId[action.sessionId] || {}),
                loading: true,
                error: null,
            };
            return {
                ...state,
                executionHistory: { ...state.executionHistory, bySessionId },
            };
        }

        case "executionHistory/loaded": {
            const bySessionId = { ...(state.executionHistory?.bySessionId || {}) };
            const rawEvents = action.events || [];
            const MAX_EXECUTION_HISTORY_EVENTS = 1000;
            const clampedEvents = rawEvents.length > MAX_EXECUTION_HISTORY_EVENTS
                ? rawEvents.slice(-MAX_EXECUTION_HISTORY_EVENTS)
                : rawEvents;
            bySessionId[action.sessionId] = {
                loading: false,
                error: null,
                fetchedAt: action.fetchedAt || Date.now(),
                events: clampedEvents,
            };
            return {
                ...state,
                executionHistory: { ...state.executionHistory, bySessionId },
            };
        }

        case "executionHistory/evict": {
            const ids = Array.isArray(action.sessionIds) ? action.sessionIds : [];
            if (ids.length === 0) return state;
            const bySessionId = { ...(state.executionHistory?.bySessionId || {}) };
            for (const id of ids) delete bySessionId[id];
            return {
                ...state,
                executionHistory: { ...state.executionHistory, bySessionId },
            };
        }

        case "executionHistory/error": {
            const bySessionId = { ...(state.executionHistory?.bySessionId || {}) };
            bySessionId[action.sessionId] = {
                ...(bySessionId[action.sessionId] || {}),
                loading: false,
                error: action.error || "Failed to load execution history",
                fetchedAt: action.fetchedAt || Date.now(),
            };
            return {
                ...state,
                executionHistory: { ...state.executionHistory, bySessionId },
            };
        }

        case "executionHistory/format": {
            return {
                ...state,
                executionHistory: {
                    ...state.executionHistory,
                    format: action.format || "pretty",
                },
            };
        }

        // ── Session Stats ────────────────────────────────────

        case "sessionStats/loading": {
            const bySessionId = { ...(state.sessionStats?.bySessionId || {}) };
            bySessionId[action.sessionId] = {
                ...(bySessionId[action.sessionId] || {}),
                loading: true,
            };
            return {
                ...state,
                sessionStats: { ...state.sessionStats, bySessionId },
            };
        }

        case "sessionStats/loaded": {
            const bySessionId = { ...(state.sessionStats?.bySessionId || {}) };
            bySessionId[action.sessionId] = {
                loading: false,
                fetchedAt: Date.now(),
                summary: action.summary || null,
                treeStats: action.treeStats || null,
                skillUsage: action.skillUsage || null,
                treeSkillUsage: action.treeSkillUsage || null,
                factsStats: action.factsStats || null,
                treeFactsStats: action.treeFactsStats || null,
            };
            return {
                ...state,
                sessionStats: { ...state.sessionStats, bySessionId },
            };
        }

        case "fleetStats/loading": {
            return {
                ...state,
                fleetStats: {
                    ...state.fleetStats,
                    loading: true,
                },
            };
        }

        case "fleetStats/loaded": {
            return {
                ...state,
                fleetStats: {
                    loading: false,
                    data: action.data || null,
                    userStats: action.userStats || null,
                    skillUsage: action.skillUsage || null,
                    sharedFactsStats: action.sharedFactsStats || null,
                    fetchedAt: Date.now(),
                },
            };
        }

        case "admin/visibility": {
            const visible = Boolean(action.visible);
            if (state.admin.visible === visible) return state;
            return {
                ...state,
                admin: {
                    ...state.admin,
                    visible,
                    // Closing the console resets any in-progress edit so the
                    // next open starts on the read-only view, not on a stale
                    // draft.
                    ghcpKey: visible
                        ? state.admin.ghcpKey
                        : { editing: false, draft: "", saving: false, error: null, lastSavedAt: state.admin.ghcpKey.lastSavedAt },
                },
            };
        }
        case "admin/profile/loading": {
            return {
                ...state,
                admin: {
                    ...state.admin,
                    loading: true,
                    loadError: null,
                },
            };
        }
        case "admin/profile/loaded": {
            return {
                ...state,
                admin: {
                    ...state.admin,
                    loading: false,
                    loadError: null,
                    profile: action.profile || null,
                    ghcpKey: {
                        ...state.admin.ghcpKey,
                        // A successful load doesn't clobber an in-progress
                        // edit; the user may be in the middle of typing.
                        error: state.admin.ghcpKey.editing ? state.admin.ghcpKey.error : null,
                    },
                },
            };
        }
        case "admin/profile/loadFailed": {
            return {
                ...state,
                admin: {
                    ...state.admin,
                    loading: false,
                    loadError: action.error ? String(action.error) : "Failed to load profile",
                },
            };
        }
        case "admin/ghcpKey/beginEdit": {
            const draft = typeof action.draft === "string" ? action.draft : "";
            return {
                ...state,
                admin: {
                    ...state.admin,
                    ghcpKey: {
                        editing: true,
                        draft,
                        cursorIndex: draft.length,
                        saving: false,
                        error: null,
                        lastSavedAt: state.admin.ghcpKey.lastSavedAt,
                    },
                },
            };
        }
        case "admin/ghcpKey/setDraft": {
            if (!state.admin.ghcpKey.editing) return state;
            const draft = typeof action.draft === "string" ? action.draft : "";
            const cursorRaw = Number.isFinite(action.cursorIndex) ? Number(action.cursorIndex) : draft.length;
            const cursorIndex = Math.max(0, Math.min(cursorRaw, draft.length));
            if (draft === state.admin.ghcpKey.draft && cursorIndex === state.admin.ghcpKey.cursorIndex) return state;
            return {
                ...state,
                admin: {
                    ...state.admin,
                    ghcpKey: {
                        ...state.admin.ghcpKey,
                        draft,
                        cursorIndex,
                        error: null,
                    },
                },
            };
        }
        case "admin/ghcpKey/cancelEdit": {
            if (!state.admin.ghcpKey.editing && !state.admin.ghcpKey.draft) return state;
            return {
                ...state,
                admin: {
                    ...state.admin,
                    ghcpKey: {
                        editing: false,
                        draft: "",
                        cursorIndex: 0,
                        saving: false,
                        error: null,
                        lastSavedAt: state.admin.ghcpKey.lastSavedAt,
                    },
                },
            };
        }
        case "admin/ghcpKey/saving": {
            return {
                ...state,
                admin: {
                    ...state.admin,
                    ghcpKey: {
                        ...state.admin.ghcpKey,
                        saving: true,
                        error: null,
                    },
                },
            };
        }
        case "admin/ghcpKey/saveFailed": {
            return {
                ...state,
                admin: {
                    ...state.admin,
                    ghcpKey: {
                        ...state.admin.ghcpKey,
                        saving: false,
                        error: action.error ? String(action.error) : "Failed to save key",
                    },
                },
            };
        }
        case "admin/ghcpKey/saved": {
            return {
                ...state,
                admin: {
                    ...state.admin,
                    profile: action.profile || state.admin.profile,
                    ghcpKey: {
                        editing: false,
                        draft: "",
                        cursorIndex: 0,
                        saving: false,
                        error: null,
                        lastSavedAt: Date.now(),
                    },
                },
            };
        }

        case "files/evictPreviews": {
            const ids = Array.isArray(action.sessionIds) ? action.sessionIds : [];
            if (ids.length === 0) return state;
            const bySessionId = cloneFilesBySessionId(state.files.bySessionId);
            for (const id of ids) {
                if (bySessionId[id]) {
                    // Keep entries list (lightweight), drop heavy preview content
                    bySessionId[id] = {
                        ...bySessionId[id],
                        previews: {},
                    };
                }
            }
            return {
                ...state,
                files: {
                    ...state.files,
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
            const entries = normalizeArtifactEntries(action.entries);
            const hasFilename = (filename) => entries.some((entry) => entry.filename === filename);
            const selectedFilename = current.selectedFilename && hasFilename(current.selectedFilename)
                ? current.selectedFilename
                : (action.selectedFilename && hasFilename(action.selectedFilename)
                    ? action.selectedFilename
                    : (entries[0]?.filename || null));
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
                    selectedArtifactId: action.sessionId && action.filename
                        ? `${action.sessionId}/${action.filename}`
                        : state.files.selectedArtifactId,
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
                    isBinary: action.isBinary === true,
                    sizeBytes: Number.isFinite(action.sizeBytes) ? action.sizeBytes : null,
                    uploadedAt: action.uploadedAt || "",
                    source: action.source || "agent",
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

        case "files/deleted": {
            const bySessionId = cloneFilesBySessionId(state.files.bySessionId);
            const current = bySessionId[action.sessionId] || {
                entries: [],
                previews: {},
                downloads: {},
                selectedFilename: null,
            };
            const entries = normalizeArtifactEntries(current.entries).filter((entry) => entry.filename !== action.filename);
            const nextSelectedFilename = current.selectedFilename === action.filename
                ? (entries[0]?.filename || null)
                : current.selectedFilename;
            const { [action.filename]: _deletedPreview, ...previews } = current.previews || {};
            const { [action.filename]: _deletedDownload, ...downloads } = current.downloads || {};
            const deletedArtifactId = action.sessionId && action.filename
                ? `${action.sessionId}/${action.filename}`
                : null;

            bySessionId[action.sessionId] = {
                ...current,
                entries,
                previews,
                downloads,
                selectedFilename: nextSelectedFilename,
            };

            return {
                ...state,
                files: {
                    ...state.files,
                    bySessionId,
                    selectedArtifactId: state.files.selectedArtifactId === deletedArtifactId
                        ? (nextSelectedFilename ? `${action.sessionId}/${nextSelectedFilename}` : null)
                        : state.files.selectedArtifactId,
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
                        fullscreenPane: null,
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

        case "logs/append": {
            const newEntries = (Array.isArray(action.entries) ? action.entries : [action.entry]).filter(Boolean);
            if (newEntries.length === 0) return state;
            const combined = [...(state.logs.entries || []), ...newEntries];
            const capped = combined.length > 1000 ? combined.slice(-1000) : combined;
            return {
                ...state,
                logs: {
                    ...state.logs,
                    entries: capped,
                },
            };
        }

        default:
            return state;
    }
}
