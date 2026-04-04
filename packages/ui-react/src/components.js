import React from "react";
import {
    applyActiveHighlightRuns,
    computeLegacyLayout,
    getPromptInputRows,
    selectActiveSession,
    selectChatPaneChrome,
    selectChatLines,
    selectActivityPane,
    selectArtifactUploadModal,
    selectArtifactPickerModal,
    selectFilesFilterModal,
    selectFilesView,
    selectInspector,
    selectLogFilterModal,
    selectModelPickerModal,
    selectRenameSessionModal,
    selectSessionAgentPickerModal,
    selectStatusBar,
    selectVisibleSessionRows,
} from "pilotswarm-ui-core";
import { useUiPlatform } from "./platform.js";
import { useControllerSelector } from "./use-controller-state.js";

const PANE_GAP_X = 0;
const PANE_GAP_Y = 0;

function shallowEqualObject(left, right) {
    if (Object.is(left, right)) return true;
    if (!left || !right || typeof left !== "object" || typeof right !== "object") return false;
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);
    if (leftKeys.length !== rightKeys.length) return false;
    for (const key of leftKeys) {
        if (!Object.prototype.hasOwnProperty.call(right, key)) return false;
        if (!Object.is(left[key], right[key])) return false;
    }
    return true;
}

function fitText(value, maxWidth) {
    const text = String(value || "");
    if (maxWidth <= 0) return "";
    if (text.length <= maxWidth) return text;
    if (maxWidth === 1) return text.slice(0, 1);
    return `${text.slice(0, maxWidth - 1)}...`;
}

function buildWorkspacePaneFrames(layout) {
    const leftX = 0;
    const rightX = layout.leftHidden ? 0 : layout.leftWidth + (layout.rightHidden ? 0 : PANE_GAP_X);

    return {
        sessions: layout.leftHidden ? null : {
            x: leftX,
            y: 0,
            width: layout.leftWidth,
            height: layout.sessionPaneHeight,
        },
        chat: layout.leftHidden ? null : {
            x: leftX,
            y: layout.sessionPaneHeight + PANE_GAP_Y,
            width: layout.leftWidth,
            height: layout.chatPaneHeight,
        },
        inspector: layout.rightHidden ? null : {
            x: rightX,
            y: 0,
            width: layout.rightWidth,
            height: layout.inspectorPaneHeight,
        },
        activity: layout.rightHidden ? null : {
            x: rightX,
            y: layout.inspectorPaneHeight + PANE_GAP_Y,
            width: layout.rightWidth,
            height: layout.activityPaneHeight,
        },
        fullscreenFiles: {
            x: 0,
            y: 0,
            width: layout.totalWidth,
            height: layout.bodyHeight,
        },
    };
}

const SessionList = React.memo(function SessionList({ controller, maxRows, width, height, frame }) {
    const platform = useUiPlatform();
    const sessionView = useControllerSelector(controller, (state) => ({
        sessions: state.sessions,
        mode: state.connection?.mode || "local",
        brandingTitle: state.branding?.title || "PilotSwarm",
        focused: state.ui.focusRegion === "sessions",
    }), shallowEqualObject);
    const selectorState = React.useMemo(() => ({
        sessions: sessionView.sessions,
        connection: { mode: sessionView.mode },
        branding: { title: sessionView.brandingTitle },
    }), [sessionView.brandingTitle, sessionView.mode, sessionView.sessions]);
    const rows = React.useMemo(
        () => selectVisibleSessionRows(selectorState, maxRows),
        [selectorState, maxRows],
    );
    const lines = React.useMemo(() => (
        rows.length === 0
            ? [{ text: "No sessions yet. Press n to create one.", color: "gray" }]
            : rows.map((row) => (row.active
                ? applyActiveHighlightRuns(row.runs, { preserveColors: true })
                : row.runs))
    ), [rows]);

    return React.createElement(platform.Panel, {
        title: "Sessions",
        color: "yellow",
        focused: sessionView.focused,
        width,
        height,
        marginBottom: PANE_GAP_Y,
        lines,
        paneId: "sessions",
        paneLabel: "Sessions",
        frame,
    });
});

const ChatPane = React.memo(function ChatPane({ controller, width, height, frame }) {
    const platform = useUiPlatform();
    const chatView = useControllerSelector(controller, (state) => {
        const activeSessionId = state.sessions.activeSessionId;
        return {
            sessionsById: state.sessions.byId,
            sessionsFlat: state.sessions.flat,
            activeSessionId,
            activeSession: activeSessionId ? state.sessions.byId[activeSessionId] || null : null,
            activeHistory: activeSessionId ? state.history.bySessionId.get(activeSessionId) || null : null,
            branding: state.branding,
            connectionError: state.connection.error,
            connectionMode: state.connection.mode,
            inspectorTab: state.ui.inspectorTab,
            chatScroll: state.ui.scroll.chat,
            focused: state.ui.focusRegion === "chat",
        };
    }, shallowEqualObject);
    const contentWidth = Math.max(20, width - 4);
    const selectorState = React.useMemo(() => {
        const historyMap = new Map();
        if (chatView.activeSessionId && chatView.activeHistory) {
            historyMap.set(chatView.activeSessionId, chatView.activeHistory);
        }
        return {
            branding: chatView.branding,
            connection: {
                error: chatView.connectionError,
                mode: chatView.connectionMode,
            },
            sessions: {
                activeSessionId: chatView.activeSessionId,
                byId: chatView.sessionsById,
                flat: chatView.sessionsFlat,
            },
            history: {
                bySessionId: historyMap,
            },
            ui: {
                inspectorTab: chatView.inspectorTab,
            },
        };
    }, [
        chatView.activeHistory,
        chatView.activeSessionId,
        chatView.branding,
        chatView.connectionError,
        chatView.connectionMode,
        chatView.inspectorTab,
        chatView.sessionsById,
        chatView.sessionsFlat,
    ]);
    const startupError = !chatView.activeSessionId && chatView.connectionError;
    const chrome = React.useMemo(() => selectChatPaneChrome(selectorState), [selectorState]);
    const elements = React.useMemo(() => (startupError
        ? [
            { kind: "markup", value: chatView.branding.splash },
            { text: "", color: "gray" },
            { text: "Startup failed", color: "red", bold: true },
            { text: chatView.connectionError, color: "white" },
            { text: "", color: "gray" },
            { text: "Check env credentials and model provider config, then relaunch.", color: "yellow" },
        ]
        : selectChatLines(selectorState, contentWidth)), [chatView.branding.splash, chatView.connectionError, contentWidth, selectorState, startupError]);

    return React.createElement(platform.Panel, {
        title: chrome.title,
        color: chrome.color,
        focused: chatView.focused,
        width,
        height,
        lines: elements,
        scrollOffset: chatView.chatScroll,
        scrollMode: "bottom",
        paneId: "chat",
        paneLabel: "Chat",
        frame,
    });
});

const FilesBrowser = React.memo(function FilesBrowser({ controller, width, height, shellTitle, focused = false, frame, showFullscreenTitle = false }) {
    const platform = useUiPlatform();
    const filesState = useControllerSelector(controller, (state) => ({
        activeSessionId: state.sessions.activeSessionId,
        activeSession: state.sessions.activeSessionId ? state.sessions.byId[state.sessions.activeSessionId] || null : null,
        sessionsFlat: state.sessions.flat,
        filesBySessionId: state.files.bySessionId,
        filesFullscreen: Boolean(state.files.fullscreen),
        selectedArtifactId: state.files.selectedArtifactId,
        filesFilter: state.files.filter,
        filePreviewScroll: state.ui.scroll.filePreview,
    }), shallowEqualObject);
    const contentWidth = Math.max(20, width - 4);
    const selectorState = React.useMemo(() => ({
        sessions: {
            activeSessionId: filesState.activeSessionId,
            byId: filesState.activeSessionId && filesState.activeSession
                ? { [filesState.activeSessionId]: filesState.activeSession }
                : {},
            flat: filesState.sessionsFlat,
        },
        files: {
            bySessionId: filesState.filesBySessionId,
            fullscreen: filesState.filesFullscreen,
            selectedArtifactId: filesState.selectedArtifactId,
            filter: filesState.filesFilter,
        },
        ui: {
            scroll: {
                filePreview: filesState.filePreviewScroll,
            },
        },
    }), [filesState]);
    const filesView = React.useMemo(() => selectFilesView(selectorState, {
        listWidth: Math.max(8, contentWidth - 4),
        previewWidth: Math.max(8, contentWidth - 4),
    }), [contentWidth, selectorState]);
    const title = shellTitle
        || (showFullscreenTitle ? filesView.fullscreenTitle : filesView.listTitle)
        || [{ text: "Files", color: "magenta", bold: true }];
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
    const listContentRows = Math.max(1, listPanelHeight - 2);
    const listScrollOffset = Math.max(0, filesView.selectedIndex - Math.floor(listContentRows / 2));
    const listFrame = frame
        ? {
            x: frame.x + 2,
            y: frame.y + 2,
            width: contentWidth,
            height: listPanelHeight,
        }
        : null;
    const previewFrame = frame
        ? {
            x: frame.x + 2,
            y: frame.y + 2 + listPanelHeight + 1,
            width: contentWidth,
            height: previewPanelHeight,
        }
        : null;

    return React.createElement(platform.Panel, {
        title,
        color: "magenta",
        focused,
        width,
        height,
        fillColor: "black",
    },
    React.createElement(platform.Column, { width: contentWidth },
        React.createElement(platform.Lines, {
            lines: [[
                ..."sequence logs nodes files".split(" ").map((tab) => ({
                    text: tab === "files" ? `[${tab}] ` : `${tab} `,
                    color: tab === "files" ? "magenta" : "gray",
                    bold: tab === "files",
                })),
            ]],
        }),
        React.createElement(platform.Panel, {
            title: filesView.listTitle,
            color: "magenta",
            focused: false,
            width: contentWidth,
            height: listPanelHeight,
            lines: filesView.listBodyLines || filesView.listLines.slice(1),
            scrollOffset: listScrollOffset,
            scrollMode: "top",
            marginBottom: 1,
            fillColor: "black",
            paneId: "files:list",
            paneLabel: "Files list",
            frame: listFrame,
        }),
        React.createElement(platform.Panel, {
            title: filesView.previewTitle,
            color: "cyan",
            focused: false,
            width: contentWidth,
            height: previewPanelHeight,
            lines: filesView.previewLines,
            scrollOffset: filesView.previewScrollOffset,
            scrollMode: "top",
            fillColor: "black",
            paneId: "files:preview",
            paneLabel: "File preview",
            frame: previewFrame,
        }),
    ));
});

const InspectorPane = React.memo(function InspectorPane({ controller, width, height, frame }) {
    const platform = useUiPlatform();
    const inspectorMeta = useControllerSelector(controller, (state) => ({
        inspectorTab: state.ui.inspectorTab,
        inspectorScroll: state.ui.scroll.inspector,
        focused: state.ui.focusRegion === "inspector",
    }), shallowEqualObject);
    const contentWidth = Math.max(20, width - 4);
    const inspectorState = useControllerSelector(controller, (state) => ({
        branding: state.branding,
        activeSessionId: state.sessions.activeSessionId,
        activeSession: state.sessions.activeSessionId ? state.sessions.byId[state.sessions.activeSessionId] || null : null,
        activeOrchestration: state.sessions.activeSessionId
            ? state.orchestration.bySessionId?.[state.sessions.activeSessionId] || null
            : null,
        sessionsById: state.sessions.byId,
        sessionsFlat: state.sessions.flat,
        histories: state.history.bySessionId,
        logs: state.logs,
        inspectorTab: state.ui.inspectorTab,
    }), shallowEqualObject);
    const selectorState = React.useMemo(() => ({
        branding: inspectorState.branding,
        sessions: {
            activeSessionId: inspectorState.activeSessionId,
            byId: inspectorState.sessionsById,
            flat: inspectorState.sessionsFlat,
        },
        history: {
            bySessionId: inspectorState.histories,
        },
        orchestration: {
            bySessionId: inspectorState.activeSessionId && inspectorState.activeOrchestration
                ? { [inspectorState.activeSessionId]: inspectorState.activeOrchestration }
                : {},
        },
        logs: inspectorState.logs,
        ui: {
            inspectorTab: inspectorState.inspectorTab,
        },
    }), [inspectorState]);
    const inspector = React.useMemo(() => selectInspector(selectorState, { width: contentWidth }), [contentWidth, selectorState]);
    if (inspectorMeta.inspectorTab === "files") {
        return React.createElement(FilesBrowser, {
            controller,
            width,
            height,
            focused: inspectorMeta.focused,
            frame,
        });
    }
    const tabLine = inspector.tabs.map((tab) => ({
        text: tab === inspector.activeTab ? `[${tab}] ` : `${tab} `,
        color: tab === inspector.activeTab ? "magenta" : "gray",
        bold: tab === inspector.activeTab,
    }));
    const normalizedLines = inspector.lines.map((line) => (typeof line === "string"
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
    const lines = inspector.activeTab === "sequence"
        ? normalizedLines
        : [tabLine, ...normalizedLines];

    return React.createElement(platform.Panel, {
        title: inspector.title,
        color: "magenta",
        focused: inspectorMeta.focused,
        width,
        height,
        stickyLines,
        marginBottom: PANE_GAP_Y,
        lines,
        scrollOffset: inspectorMeta.inspectorScroll,
        scrollMode: inspector.activeTab === "logs" || inspector.activeTab === "sequence" ? "bottom" : "top",
        paneId: "inspector",
        paneLabel: inspector.activeTab === "sequence" ? "Sequence" : "Inspector",
        frame,
    });
});

const ActivityPane = React.memo(function ActivityPane({ controller, width, height, maxLines, frame }) {
    const platform = useUiPlatform();
    const activityState = useControllerSelector(controller, (state) => {
        const activeSessionId = state.sessions.activeSessionId;
        return {
            sessionsById: state.sessions.byId,
            activeSessionId,
            activeSession: activeSessionId ? state.sessions.byId[activeSessionId] || null : null,
            activeHistory: activeSessionId ? state.history.bySessionId.get(activeSessionId) || null : null,
            scroll: state.ui.scroll.activity,
            focused: state.ui.focusRegion === "activity",
        };
    }, shallowEqualObject);
    const selectorState = React.useMemo(() => {
        const historyMap = new Map();
        if (activityState.activeSessionId && activityState.activeHistory) {
            historyMap.set(activityState.activeSessionId, activityState.activeHistory);
        }
        return {
            sessions: {
                activeSessionId: activityState.activeSessionId,
                byId: activityState.sessionsById,
            },
            history: {
                bySessionId: historyMap,
            },
        };
    }, [activityState.activeHistory, activityState.activeSessionId, activityState.sessionsById]);
    const activity = React.useMemo(() => selectActivityPane(selectorState, maxLines), [maxLines, selectorState]);

    return React.createElement(platform.Panel, {
        title: activity.title,
        color: "gray",
        focused: activityState.focused,
        width,
        height,
        lines: activity.lines,
        scrollOffset: activityState.scroll,
        scrollMode: "bottom",
        paneId: "activity",
        paneLabel: "Activity",
        frame,
    });
});

const PromptBar = React.memo(function PromptBar({ controller, rows }) {
    const platform = useUiPlatform();
    const promptState = useControllerSelector(controller, (state) => {
        const activeSessionId = state.sessions.activeSessionId;
        const activeSession = activeSessionId ? state.sessions.byId[activeSessionId] || null : null;
        return {
            prompt: state.ui.prompt,
            promptCursor: state.ui.promptCursor,
            focused: state.ui.focusRegion === "prompt",
            answeringQuestion: Boolean(activeSession?.pendingQuestion?.question),
        };
    }, shallowEqualObject);
    return React.createElement(platform.Input, {
        label: promptState.answeringQuestion ? "answer" : "you",
        value: promptState.prompt,
        cursorIndex: promptState.promptCursor,
        focused: promptState.focused,
        placeholder: promptState.answeringQuestion
            ? "Type an answer and press Enter"
            : "Type a message and press Enter",
        rows,
    });
});

const StatusBar = React.memo(function StatusBar({ controller }) {
    const platform = useUiPlatform();
    const statusState = useControllerSelector(controller, (state) => ({
        connected: state.connection.connected,
        workersOnline: state.connection.workersOnline,
        focusRegion: state.ui.focusRegion,
        inspectorTab: state.ui.inspectorTab,
        logsAvailable: state.logs.available,
        logsTailing: state.logs.tailing,
        filesFullscreen: Boolean(state.files.fullscreen),
        mode: state.connection.mode,
        statusText: state.ui.statusText,
        activeSessionId: state.sessions.activeSessionId,
        activeSession: state.sessions.activeSessionId ? state.sessions.byId[state.sessions.activeSessionId] || null : null,
    }), shallowEqualObject);
    const selectorState = React.useMemo(() => ({
        connection: {
            connected: statusState.connected,
            workersOnline: statusState.workersOnline,
            mode: statusState.mode,
        },
        ui: {
            focusRegion: statusState.focusRegion,
            inspectorTab: statusState.inspectorTab,
            statusText: statusState.statusText,
        },
        logs: {
            available: statusState.logsAvailable,
            tailing: statusState.logsTailing,
        },
        files: {
            fullscreen: statusState.filesFullscreen,
        },
        sessions: {
            activeSessionId: statusState.activeSessionId,
            byId: statusState.activeSessionId && statusState.activeSession
                ? { [statusState.activeSessionId]: statusState.activeSession }
                : {},
        },
    }), [statusState]);
    const status = React.useMemo(() => selectStatusBar(selectorState), [selectorState]);
    const viewport = typeof platform.getViewport === "function"
        ? platform.getViewport()
        : { width: 120 };
    const innerWidth = Math.max(20, (viewport.width || 120) - 4);
    const rightMax = Math.min(Math.max(18, Math.floor(innerWidth * 0.45)), innerWidth - 8);
    const leftMax = Math.max(8, innerWidth - rightMax - 3);

    return React.createElement(platform.StatusLine, {
        left: fitText(status.left, leftMax),
        right: fitText(status.right, rightMax),
    });
});

function ModelPickerModal({ state }) {
    const platform = useUiPlatform();
    const modal = selectModelPickerModal(state);
    if (!modal) return null;

    const viewport = typeof platform.getViewport === "function"
        ? platform.getViewport()
        : { width: 120, height: 40 };
    const width = Math.max(46, Math.min(modal.idealWidth || 68, (viewport.width || 120) - 16));
    const listHeight = Math.max(8, Math.min(modal.rows.length + 2, 14, (viewport.height || 40) - 16));
    const detailsHeight = Math.max(6, Math.min(8, (viewport.height || 40) - listHeight - 10));
    const lines = modal.rows.length > 0
        ? modal.rows
        : [{ text: "No models available.", color: "gray" }];
    const contentRows = Math.max(1, listHeight - 2);
    const scrollOffset = Math.max(0, modal.selectedRowIndex - Math.floor(contentRows / 2));

    return React.createElement(platform.Overlay, null,
        React.createElement(platform.Column, { width },
            React.createElement(platform.Panel, {
                title: modal.title,
                color: "cyan",
                focused: false,
                width,
                height: listHeight,
                lines,
                scrollOffset,
                scrollMode: "top",
                marginBottom: 1,
                fillColor: "black",
            }),
            React.createElement(platform.Panel, {
                title: modal.detailsTitle || "Model Details",
                color: "cyan",
                focused: false,
                width,
                height: detailsHeight,
                lines: modal.detailsLines,
                scrollOffset: 0,
                scrollMode: "top",
                fillColor: "black",
            }),
        ));
}

function ModelPickerModalContainer({ controller }) {
    const state = useControllerSelector(controller, (rootState) => ({
        ui: {
            modal: rootState.ui.modal,
        },
    }), shallowEqualObject);
    return React.createElement(ModelPickerModal, { state });
}

function SessionAgentPickerModal({ state }) {
    const platform = useUiPlatform();
    const modal = selectSessionAgentPickerModal(state);
    if (!modal) return null;

    const viewport = typeof platform.getViewport === "function"
        ? platform.getViewport()
        : { width: 120, height: 40 };
    const width = Math.max(50, Math.min(modal.idealWidth || 72, (viewport.width || 120) - 16));
    const listHeight = Math.max(8, Math.min(modal.rows.length + 2, 14, (viewport.height || 40) - 16));
    const detailsHeight = Math.max(7, Math.min(9, (viewport.height || 40) - listHeight - 10));
    const lines = modal.rows.length > 0
        ? modal.rows
        : [{ text: "No agents available.", color: "gray" }];
    const contentRows = Math.max(1, listHeight - 2);
    const scrollOffset = Math.max(0, modal.selectedRowIndex - Math.floor(contentRows / 2));

    return React.createElement(platform.Overlay, null,
        React.createElement(platform.Column, { width },
            React.createElement(platform.Panel, {
                title: modal.title,
                color: "cyan",
                focused: false,
                width,
                height: listHeight,
                lines,
                scrollOffset,
                scrollMode: "top",
                marginBottom: 1,
                fillColor: "black",
            }),
            React.createElement(platform.Panel, {
                title: modal.detailsTitle || "Agent Details",
                color: "cyan",
                focused: false,
                width,
                height: detailsHeight,
                lines: modal.detailsLines,
                scrollOffset: 0,
                scrollMode: "top",
                fillColor: "black",
            }),
        ));
}

function SessionAgentPickerModalContainer({ controller }) {
    const state = useControllerSelector(controller, (rootState) => ({
        ui: {
            modal: rootState.ui.modal,
        },
    }), shallowEqualObject);
    return React.createElement(SessionAgentPickerModal, { state });
}

function RenameSessionModal({ state }) {
    const platform = useUiPlatform();
    const modal = selectRenameSessionModal(state);
    if (!modal) return null;

    const viewport = typeof platform.getViewport === "function"
        ? platform.getViewport()
        : { width: 120, height: 40 };
    const width = Math.max(56, Math.min(modal.idealWidth || 72, (viewport.width || 120) - 12));
    const detailsHeight = Math.max(6, Math.min(7, (modal.detailsLines?.length || 0) + 2, (viewport.height || 40) - 14));
    const helpHeight = Math.max(6, Math.min(7, (viewport.height || 40) - detailsHeight - 8));

    return React.createElement(platform.Overlay, null,
        React.createElement(platform.Column, { width },
            React.createElement(platform.Panel, {
                title: modal.title,
                color: "cyan",
                focused: false,
                width,
                height: detailsHeight,
                lines: modal.detailsLines,
                scrollOffset: 0,
                scrollMode: "top",
                marginBottom: 1,
                fillColor: "black",
            }),
            React.createElement(platform.Input, {
                label: "title",
                value: modal.value,
                cursorIndex: modal.cursorIndex,
                focused: true,
                placeholder: modal.placeholder,
                rows: 1,
            }),
            React.createElement(platform.Panel, {
                title: modal.helpTitle || "Rename Rules",
                color: "cyan",
                focused: false,
                width,
                height: helpHeight,
                lines: modal.helpLines,
                scrollOffset: 0,
                scrollMode: "top",
                fillColor: "black",
            }),
        ));
}

function RenameSessionModalContainer({ controller }) {
    const state = useControllerSelector(controller, (rootState) => ({
        ui: {
            modal: rootState.ui.modal,
        },
    }), shallowEqualObject);
    return React.createElement(RenameSessionModal, { state });
}

function ArtifactUploadModal({ state }) {
    const platform = useUiPlatform();
    const modal = selectArtifactUploadModal(state);
    if (!modal) return null;

    const viewport = typeof platform.getViewport === "function"
        ? platform.getViewport()
        : { width: 120, height: 40 };
    const width = Math.max(58, Math.min(modal.idealWidth || 74, (viewport.width || 120) - 12));
    const detailsHeight = Math.max(6, Math.min(7, (modal.detailsLines?.length || 0) + 2, (viewport.height || 40) - 14));
    const helpHeight = Math.max(7, Math.min(8, (viewport.height || 40) - detailsHeight - 8));

    return React.createElement(platform.Overlay, null,
        React.createElement(platform.Column, { width },
            React.createElement(platform.Panel, {
                title: modal.title,
                color: "cyan",
                focused: false,
                width,
                height: detailsHeight,
                lines: modal.detailsLines,
                scrollOffset: 0,
                scrollMode: "top",
                marginBottom: 1,
                fillColor: "black",
            }),
            React.createElement(platform.Input, {
                label: "path",
                value: modal.value,
                cursorIndex: modal.cursorIndex,
                focused: true,
                placeholder: modal.placeholder,
                rows: 1,
            }),
            React.createElement(platform.Panel, {
                title: modal.helpTitle || "Attach Rules",
                color: "cyan",
                focused: false,
                width,
                height: helpHeight,
                lines: modal.helpLines,
                scrollOffset: 0,
                scrollMode: "top",
                fillColor: "black",
            }),
        ));
}

function ArtifactUploadModalContainer({ controller }) {
    const state = useControllerSelector(controller, (rootState) => ({
        branding: rootState.branding,
        sessions: {
            activeSessionId: rootState.sessions.activeSessionId,
            byId: rootState.sessions.byId,
        },
        ui: {
            modal: rootState.ui.modal,
            promptAttachments: rootState.ui.promptAttachments,
        },
    }), shallowEqualObject);
    return React.createElement(ArtifactUploadModal, { state });
}

function ArtifactPickerModal({ state }) {
    const platform = useUiPlatform();
    const modal = selectArtifactPickerModal(state);
    if (!modal) return null;

    const viewport = typeof platform.getViewport === "function"
        ? platform.getViewport()
        : { width: 120, height: 40 };
    const width = Math.max(54, Math.min(modal.idealWidth || 72, (viewport.width || 120) - 16));
    const listHeight = Math.max(8, Math.min(modal.rows.length + 2, 14, (viewport.height || 40) - 16));
    const detailsHeight = Math.max(7, Math.min(9, (viewport.height || 40) - listHeight - 10));
    const lines = modal.rows.length > 0
        ? modal.rows
        : [{ text: "No artifacts available.", color: "gray" }];
    const contentRows = Math.max(1, listHeight - 2);
    const scrollOffset = Math.max(0, modal.selectedRowIndex - Math.floor(contentRows / 2));

    return React.createElement(platform.Overlay, null,
        React.createElement(platform.Column, { width },
            React.createElement(platform.Panel, {
                title: modal.title,
                color: "cyan",
                focused: false,
                width,
                height: listHeight,
                lines,
                scrollOffset,
                scrollMode: "top",
                marginBottom: 1,
                fillColor: "black",
            }),
            React.createElement(platform.Panel, {
                title: modal.detailsTitle || "Artifact Details",
                color: "cyan",
                focused: false,
                width,
                height: detailsHeight,
                lines: modal.detailsLines,
                scrollOffset: 0,
                scrollMode: "top",
                fillColor: "black",
            }),
        ));
}

function ArtifactPickerModalContainer({ controller }) {
    const state = useControllerSelector(controller, (rootState) => ({
        ui: {
            modal: rootState.ui.modal,
        },
        files: {
            bySessionId: rootState.files.bySessionId,
        },
    }), shallowEqualObject);
    return React.createElement(ArtifactPickerModal, { state });
}

function renderFilterModal(platform, modal) {
    if (!modal) return null;
    const viewport = typeof platform.getViewport === "function"
        ? platform.getViewport()
        : { width: 120, height: 40 };
    const paneGap = 1;
    const rawPaneWidths = modal.panes.map((pane) => Math.max(20, Math.min(pane.idealWidth || 24, 36)));
    const idealContentWidth = rawPaneWidths.reduce((sum, value) => sum + value, 0) + Math.max(0, rawPaneWidths.length - 1) * paneGap;
    const width = Math.max(76, Math.min(modal.idealWidth || (idealContentWidth + 4), (viewport.width || 120) - 6));
    const availablePaneWidth = Math.max(18, width - 4 - (Math.max(0, rawPaneWidths.length - 1) * paneGap));
    const paneWidths = [...rawPaneWidths];
    let totalPaneWidth = paneWidths.reduce((sum, value) => sum + value, 0);
    while (totalPaneWidth > availablePaneWidth) {
        let shrank = false;
        for (let index = 0; index < paneWidths.length && totalPaneWidth > availablePaneWidth; index += 1) {
            if (paneWidths[index] <= 18) continue;
            paneWidths[index] -= 1;
            totalPaneWidth -= 1;
            shrank = true;
        }
        if (!shrank) break;
    }
    const paneHeight = Math.max(8, Math.min(12, (viewport.height || 40) - 18));
    const helpHeight = Math.max(5, Math.min(7, (viewport.height || 40) - paneHeight - 10));
    const modalHeight = paneHeight + helpHeight + 5;
    const contentWidth = width - 4;

    return React.createElement(platform.Overlay, null,
        React.createElement(platform.Panel, {
            title: modal.title,
            color: "cyan",
            focused: false,
            width,
            height: modalHeight,
            fillColor: "black",
        },
        React.createElement(platform.Column, { width: contentWidth },
            React.createElement(platform.Row, { marginBottom: 1 },
                modal.panes.map((pane, index) => React.createElement(platform.Panel, {
                    key: pane.id || index,
                    title: pane.title,
                    color: "cyan",
                    focused: Boolean(pane.focused),
                    width: paneWidths[index],
                    height: paneHeight,
                    lines: pane.lines,
                    scrollOffset: 0,
                    scrollMode: "top",
                    marginRight: index === modal.panes.length - 1 ? 0 : paneGap,
                    fillColor: "black",
                })),
            ),
            React.createElement(platform.Panel, {
                title: modal.helpTitle || "Help",
                color: "cyan",
                focused: false,
                width: contentWidth,
                height: helpHeight,
                lines: modal.helpLines || [modal.footerRuns],
                scrollOffset: 0,
                scrollMode: "top",
                fillColor: "black",
            }),
        )));
}

function LogFilterModal({ state }) {
    const platform = useUiPlatform();
    const modal = selectLogFilterModal(state);
    return renderFilterModal(platform, modal);
}

function LogFilterModalContainer({ controller }) {
    const state = useControllerSelector(controller, (rootState) => ({
        ui: {
            modal: rootState.ui.modal,
        },
        logs: {
            filter: rootState.logs.filter,
        },
    }), shallowEqualObject);
    return React.createElement(LogFilterModal, { state });
}

function FilesFilterModal({ state }) {
    const platform = useUiPlatform();
    const modal = selectFilesFilterModal(state);
    return renderFilterModal(platform, modal);
}

function FilesFilterModalContainer({ controller }) {
    const state = useControllerSelector(controller, (rootState) => ({
        ui: {
            modal: rootState.ui.modal,
        },
        files: {
            filter: rootState.files.filter,
        },
    }), shallowEqualObject);
    return React.createElement(FilesFilterModal, { state });
}

export function SharedPilotSwarmApp({ controller }) {
    const platform = useUiPlatform();
    const layoutState = useControllerSelector(controller, (state) => ({
        paneAdjust: state.ui.layout?.paneAdjust ?? 0,
        promptRows: getPromptInputRows(state.ui.prompt),
        inspectorTab: state.ui.inspectorTab,
        filesFullscreen: Boolean(state.files?.fullscreen),
    }), shallowEqualObject);
    const viewport = typeof platform.getViewport === "function"
        ? platform.getViewport()
        : { width: 120, height: 40 };
    const viewportWidth = viewport.width || 120;
    const viewportHeight = viewport.height || 40;
    const layout = React.useMemo(
        () => computeLegacyLayout({ width: viewportWidth, height: viewportHeight }, layoutState.paneAdjust, layoutState.promptRows),
        [layoutState.paneAdjust, layoutState.promptRows, viewportHeight, viewportWidth],
    );
    const frames = buildWorkspacePaneFrames(layout);
    const sessionRows = Math.max(3, layout.sessionPaneHeight - 2);
    const activityRows = Math.max(3, layout.activityPaneHeight - 2);
    const filesFullscreenActive = layoutState.inspectorTab === "files" && layoutState.filesFullscreen;
    const workspaceHeight = Math.max(10, layout.bodyHeight);

    React.useEffect(() => {
        if (typeof controller.setViewport === "function") {
            controller.setViewport({ width: viewportWidth, height: viewportHeight });
        }
    }, [controller, viewportHeight, viewportWidth]);

    platform.clearSelectablePanes?.();

    return React.createElement(platform.Root, null,
        React.createElement(platform.Row, { flexGrow: 1 },
            filesFullscreenActive
                ? React.createElement(FilesBrowser, {
                    controller,
                    width: layout.totalWidth,
                    height: workspaceHeight,
                    frame: frames.fullscreenFiles,
                    showFullscreenTitle: true,
                })
                : [
                    !layout.leftHidden && React.createElement(platform.Column, { key: "left", width: layout.leftWidth, marginRight: layout.rightHidden ? 0 : PANE_GAP_X, flexGrow: 0 },
                        React.createElement(SessionList, {
                            controller,
                            width: layout.leftWidth,
                            height: layout.sessionPaneHeight,
                            maxRows: sessionRows,
                            frame: frames.sessions,
                        }),
                        React.createElement(ChatPane, {
                            controller,
                            width: layout.leftWidth,
                            height: layout.chatPaneHeight,
                            frame: frames.chat,
                        }),
                    ),
                    !layout.rightHidden && React.createElement(platform.Column, { key: "right", width: layout.rightWidth, flexGrow: 0 },
                        React.createElement(InspectorPane, {
                            controller,
                            width: layout.rightWidth,
                            height: layout.inspectorPaneHeight,
                            frame: frames.inspector,
                        }),
                        React.createElement(ActivityPane, {
                            controller,
                            width: layout.rightWidth,
                            height: layout.activityPaneHeight,
                            maxLines: activityRows,
                            frame: frames.activity,
                        }),
                    ),
                ],
        ),
        React.createElement(StatusBar, { controller }),
        React.createElement(PromptBar, { controller, rows: layoutState.promptRows }),
        React.createElement(RenameSessionModalContainer, { controller }),
        React.createElement(ArtifactUploadModalContainer, { controller }),
        React.createElement(ArtifactPickerModalContainer, { controller }),
        React.createElement(ModelPickerModalContainer, { controller }),
        React.createElement(SessionAgentPickerModalContainer, { controller }),
        React.createElement(LogFilterModalContainer, { controller }),
        React.createElement(FilesFilterModalContainer, { controller }),
    );
}
