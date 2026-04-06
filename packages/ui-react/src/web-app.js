import React from "react";
import {
    UI_COMMANDS,
    INSPECTOR_TABS,
    appReducer,
    computeLegacyLayout,
    createInitialState,
    createStore,
    getPromptInputRows,
    getTheme,
    parseTerminalMarkupRuns,
    PilotSwarmUiController,
    selectActivityPane,
    selectArtifactPickerModal,
    selectArtifactUploadModal,
    selectChatLines,
    selectChatPaneChrome,
    selectFileBrowserItems,
    selectFilesFilterModal,
    selectFilesScope,
    selectFilesView,
    selectHistoryFormatModal,
    selectInspector,
    selectLogFilterModal,
    selectModelPickerModal,
    selectRenameSessionModal,
    selectSessionAgentPickerModal,
    selectSessionRows,
    selectStatusBar,
    selectThemePickerModal,
} from "pilotswarm-ui-core";
import { useControllerSelector } from "./use-controller-state.js";

const MOBILE_BREAKPOINT = 920;
const GRID_CELL_WIDTH = 7;
const GRID_CELL_HEIGHT = 19;
const SCROLL_ROW_HEIGHT = 16;
const THEME_STORAGE_KEY = "pilotswarm.theme";
const INSPECTOR_TAB_LABELS = {
    sequence: "Sequence",
    logs: "Logs",
    nodes: "Node Map",
    history: "History",
    files: "Files",
};

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

function normalizeLines(lines) {
    const normalized = [];
    for (const line of lines || []) {
        if (line?.kind === "markup") {
            for (const parsedLine of parseTerminalMarkupRuns(line.value || "")) {
                normalized.push({ kind: "runs", runs: parsedLine });
            }
            continue;
        }
        if (Array.isArray(line)) {
            normalized.push({ kind: "runs", runs: line });
            continue;
        }
        normalized.push({ kind: "text", ...line });
    }
    return normalized;
}

function resolveColor(theme, token) {
    if (!token) return undefined;
    return theme?.tui?.[token] || theme?.terminal?.[token] || theme?.page?.[token] || token;
}

function runsToText(runs = []) {
    return runs.map((run) => String(run?.text || "")).join("");
}

function flattenTitleText(title) {
    if (Array.isArray(title)) return runsToText(title);
    return String(title || "");
}

function compactTitleRuns(title, maxWidth = 40) {
    if (!Array.isArray(title)) {
        const text = String(title || "");
        return [{ text: text.length > maxWidth ? `${text.slice(0, maxWidth - 1)}…` : text, color: "white", bold: true }];
    }
    const compactRuns = [];
    let remaining = Math.max(8, maxWidth);
    for (const run of title) {
        if (remaining <= 0) break;
        const color = run?.color;
        if (color === "gray" && compactRuns.length > 0) continue;
        const text = String(run?.text || "");
        if (!text) continue;
        const chunk = text.length > remaining && remaining > 1
            ? `${text.slice(0, remaining - 1)}…`
            : text.slice(0, remaining);
        if (!chunk) continue;
        compactRuns.push({ ...run, text: chunk });
        remaining -= chunk.length;
    }
    return compactRuns.length > 0 ? compactRuns : title;
}

function applyDocumentTheme(themeId) {
    const theme = getTheme(themeId);
    if (!theme || typeof document === "undefined") return;
    const root = document.documentElement;
    root.style.setProperty("--ps-page-background", theme.page.background);
    root.style.setProperty("--ps-page-foreground", theme.page.foreground);
    root.style.setProperty("--ps-surface", theme.tui.surface);
    root.style.setProperty("--ps-background", theme.tui.background);
    root.style.setProperty("--ps-foreground", theme.tui.foreground);
    root.style.setProperty("--ps-muted", theme.tui.gray);
    root.style.setProperty("--ps-border", theme.tui.gray);
    root.style.setProperty("--ps-selection-background", theme.tui.selectionBackground);
    root.style.setProperty("--ps-selection-foreground", theme.tui.selectionForeground);
    root.style.setProperty("--ps-highlight-background", theme.tui.activeHighlightBackground);
    root.style.setProperty("--ps-highlight-foreground", theme.tui.activeHighlightForeground);
    root.style.setProperty("--ps-modal-backdrop", theme.page.modalBackdrop);
    root.style.setProperty("--ps-modal-background", theme.page.modalBackground);
    root.style.setProperty("--ps-modal-border", theme.page.modalBorder);
    root.style.setProperty("--ps-modal-foreground", theme.page.modalForeground);
    root.style.setProperty("--ps-modal-muted", theme.page.modalMuted);
    root.style.setProperty("--ps-modal-selected-background", theme.page.modalSelectedBackground);
    root.style.setProperty("--ps-modal-selected-border", theme.page.modalSelectedBorder);
    root.style.setProperty("--ps-modal-selected-foreground", theme.page.modalSelectedForeground);
}

function readStoredThemeId() {
    try {
        return window.localStorage.getItem(THEME_STORAGE_KEY);
    } catch {
        return null;
    }
}

function writeStoredThemeId(themeId) {
    try {
        window.localStorage.setItem(THEME_STORAGE_KEY, themeId);
    } catch {}
}

function useMeasuredViewport(ref) {
    const [viewport, setViewport] = React.useState({ width: 0, height: 0 });

    React.useLayoutEffect(() => {
        const element = ref.current;
        if (!element) return undefined;

        const update = () => {
            setViewport({
                width: element.clientWidth,
                height: element.clientHeight,
            });
        };

        update();
        const observer = new ResizeObserver(update);
        observer.observe(element);
        window.addEventListener("resize", update);
        return () => {
            observer.disconnect();
            window.removeEventListener("resize", update);
        };
    }, [ref]);

    return viewport;
}

function computeGridViewport(viewport) {
    const width = Math.max(320, viewport.width || window.innerWidth || 1280);
    const height = Math.max(320, viewport.height || window.innerHeight || 800);
    return {
        width: Math.max(40, Math.floor(width / GRID_CELL_WIDTH)),
        height: Math.max(18, Math.floor(height / GRID_CELL_HEIGHT)),
    };
}

function useScrollSync(ref, lines, scrollOffset, scrollMode, paneKey, controller) {
    const normalizedLines = React.useMemo(() => normalizeLines(lines), [lines]);

    React.useLayoutEffect(() => {
        const node = ref.current;
        if (!node) return;
        const maxScroll = Math.max(0, node.scrollHeight - node.clientHeight);
        const offsetPixels = Math.max(0, Number(scrollOffset) || 0) * SCROLL_ROW_HEIGHT;
        const nextScrollTop = scrollMode === "bottom"
            ? Math.max(0, maxScroll - offsetPixels)
            : Math.min(maxScroll, offsetPixels);
        if (Math.abs(node.scrollTop - nextScrollTop) > 2) {
            node.scrollTop = nextScrollTop;
        }
    }, [normalizedLines, ref, scrollMode, scrollOffset]);

    const onScroll = React.useCallback(() => {
        const node = ref.current;
        if (!node || !paneKey) return;
        const maxScroll = Math.max(0, node.scrollHeight - node.clientHeight);
        const pixels = scrollMode === "bottom"
            ? Math.max(0, maxScroll - node.scrollTop)
            : Math.max(0, node.scrollTop);
        controller.dispatch({
            type: "ui/scroll",
            pane: paneKey,
            offset: Math.round(pixels / SCROLL_ROW_HEIGHT),
        });
    }, [controller, paneKey, ref, scrollMode]);

    return { normalizedLines, onScroll };
}

function Runs({ runs, theme }) {
    return React.createElement(React.Fragment, null,
        (runs || []).map((run, index) => React.createElement("span", {
            key: `${index}:${run.text || ""}`,
            style: {
                color: resolveColor(theme, run.color),
                backgroundColor: resolveColor(theme, run.backgroundColor),
                fontWeight: run.bold ? 700 : 400,
                textDecoration: run.underline ? "underline" : "none",
            },
        }, run.text || "")),
    );
}

function Line({ line, theme }) {
    if (!line) {
        return React.createElement("div", { className: "ps-line" }, " ");
    }
    if (line.kind === "runs") {
        return React.createElement("div", { className: "ps-line" },
            React.createElement(Runs, { runs: line.runs, theme }));
    }
    return React.createElement("div", {
        className: "ps-line",
        style: {
            color: resolveColor(theme, line.color),
            backgroundColor: resolveColor(theme, line.backgroundColor),
            fontWeight: line.bold ? 700 : 400,
            textDecoration: line.underline ? "underline" : "none",
        },
    }, line.text || " ");
}

function Panel({ title, color = "gray", focused = false, actions = null, children, theme, className = "" }) {
    const accent = resolveColor(theme, color);
    return React.createElement("section", {
        className: `ps-panel${focused ? " is-focused" : ""}${className ? ` ${className}` : ""}`,
        style: { "--ps-panel-accent": accent || "var(--ps-border)" },
    },
    React.createElement("header", { className: "ps-panel-header" },
        React.createElement("div", { className: "ps-panel-title" },
            Array.isArray(title)
                ? React.createElement(Runs, { runs: title, theme })
                : flattenTitleText(title)),
        actions ? React.createElement("div", { className: "ps-panel-actions" }, actions) : null,
    ),
    React.createElement("div", { className: "ps-panel-body" }, children));
}

function ScrollLinesPanel({ title, color, focused, actions, lines, stickyLines = [], scrollOffset = 0, scrollMode = "top", paneKey, controller, className = "", panelClassName = "", topContent = null }) {
    const themeId = useControllerSelector(controller, (state) => state.ui.themeId);
    const theme = getTheme(themeId);
    const ref = React.useRef(null);
    const stickyRef = React.useRef(null);
    const syncingHorizontalRef = React.useRef(false);
    const { normalizedLines, onScroll } = useScrollSync(ref, lines, scrollOffset, scrollMode, paneKey, controller);
    const normalizedSticky = React.useMemo(() => normalizeLines(stickyLines), [stickyLines]);
    const preserveHorizontalScroll = className.includes("is-preserve") && panelClassName.includes("has-preserved-sticky");

    const syncScrollLeft = React.useCallback((source, target) => {
        if (!source || !target) return;
        if (Math.abs((target.scrollLeft || 0) - (source.scrollLeft || 0)) <= 1) return;
        syncingHorizontalRef.current = true;
        target.scrollLeft = source.scrollLeft;
        window.requestAnimationFrame(() => {
            syncingHorizontalRef.current = false;
        });
    }, []);

    const handleBodyScroll = React.useCallback((event) => {
        onScroll();
        if (!preserveHorizontalScroll || syncingHorizontalRef.current) return;
        syncScrollLeft(event.currentTarget, stickyRef.current);
    }, [onScroll, preserveHorizontalScroll, syncScrollLeft]);

    const handleStickyScroll = React.useCallback((event) => {
        if (!preserveHorizontalScroll || syncingHorizontalRef.current) return;
        syncScrollLeft(event.currentTarget, ref.current);
    }, [preserveHorizontalScroll, syncScrollLeft]);

    return React.createElement(Panel, { title, color, focused, actions, theme, className: panelClassName },
        topContent,
        normalizedSticky.length > 0
            ? React.createElement("div", {
                ref: stickyRef,
                className: `ps-panel-sticky${preserveHorizontalScroll ? " is-scroll-sync" : ""}`,
                onScroll: handleStickyScroll,
            },
                normalizedSticky.map((line, index) => React.createElement(Line, { key: `sticky:${index}`, line, theme })),
            )
            : null,
        React.createElement("div", { ref, className: `ps-scroll-panel ${className}`.trim(), onScroll: handleBodyScroll },
            normalizedLines.map((line, index) => React.createElement(Line, { key: `line:${index}`, line, theme })),
        ));
}

function SessionPane({ controller, actions = null, panelClassName = "" }) {
    const themeId = useControllerSelector(controller, (state) => state.ui.themeId);
    const theme = getTheme(themeId);
    const view = useControllerSelector(controller, (state) => ({
        rows: selectSessionRows(state),
        focused: state.ui.focusRegion === "sessions",
    }), shallowEqualObject);

    return React.createElement(Panel, {
        title: [{ text: "Sessions", color: "yellow", bold: true }],
        color: "yellow",
        focused: view.focused,
        theme,
        actions,
        className: panelClassName,
    },
    React.createElement("div", { className: "ps-action-list" },
        view.rows.length === 0
            ? React.createElement("div", { className: "ps-empty-state" }, "No sessions yet.")
            : view.rows.map((row) => React.createElement("button", {
                key: row.sessionId,
                type: "button",
                className: `ps-list-button${row.active ? " is-selected" : ""}`,
                onClick: () => {
                    controller.setFocus("sessions");
                    controller.loadSession(row.sessionId).catch(() => {});
                },
            },
            React.createElement("div", { className: "ps-line" },
                Array.isArray(row.runs)
                    ? React.createElement(Runs, { runs: row.runs, theme })
                    : row.text),
            )),
    ));
}

function ChatPane({ controller, mobile = false }) {
    const themeId = useControllerSelector(controller, (state) => state.ui.themeId);
    const theme = getTheme(themeId);
    const view = useControllerSelector(controller, (state) => {
        const activeSessionId = state.sessions.activeSessionId;
        const activeHistory = activeSessionId ? state.history.bySessionId.get(activeSessionId) || null : null;
        const selectorState = {
            branding: state.branding,
            connection: state.connection,
            sessions: {
                activeSessionId,
                byId: state.sessions.byId,
                flat: state.sessions.flat,
            },
            history: {
                bySessionId: activeSessionId && activeHistory ? new Map([[activeSessionId, activeHistory]]) : new Map(),
            },
            ui: {
                inspectorTab: state.ui.inspectorTab,
            },
        };
        const layout = computeLegacyLayout({
            width: state.ui.layout?.viewportWidth ?? 120,
            height: state.ui.layout?.viewportHeight ?? 40,
        }, state.ui.layout?.paneAdjust ?? 0, getPromptInputRows(state.ui.prompt));
        const contentWidth = Math.max(20, layout.leftWidth - 4);
        return {
            chrome: selectChatPaneChrome(selectorState),
            lines: selectChatLines(selectorState, contentWidth),
            focused: state.ui.focusRegion === "chat",
            scroll: state.ui.scroll.chat,
        };
    }, shallowEqualObject);

    return React.createElement(ScrollLinesPanel, {
        controller,
        title: mobile ? compactTitleRuns(view.chrome.title, 28) : view.chrome.title,
        color: view.chrome.color,
        focused: view.focused,
        lines: view.lines,
        scrollOffset: view.scroll,
        scrollMode: "bottom",
        paneKey: "chat",
        className: "is-wrapped",
    });
}

function MobileWorkspace({ controller, sessionsCollapsed, setSessionsCollapsed }) {
    const themeId = useControllerSelector(controller, (state) => state.ui.themeId);
    const theme = getTheme(themeId);
    const sessionToggle = React.createElement("button", {
        type: "button",
        className: "ps-mini-button",
        onClick: () => setSessionsCollapsed((current) => !current),
    }, sessionsCollapsed ? "Show" : "Hide");

    return React.createElement("div", { className: "ps-mobile-workspace" },
        sessionsCollapsed
            ? React.createElement(Panel, {
                title: [{ text: "Sessions", color: "yellow", bold: true }],
                color: "yellow",
                focused: false,
                theme,
                actions: sessionToggle,
                className: "ps-mobile-session-collapsed",
            },
            React.createElement("div", { className: "ps-mobile-session-summary" }, "Session list collapsed."))
            : React.createElement(SessionPane, {
                controller,
                actions: sessionToggle,
                panelClassName: "ps-mobile-session-pane",
            }),
        React.createElement("div", { className: "ps-mobile-chat-pane" },
            React.createElement(ChatPane, { controller, mobile: true })));
}

function InspectorTabs({ activeTab, controller }) {
    return React.createElement("div", { className: "ps-tab-row" },
        INSPECTOR_TABS.map((tab) => React.createElement("button", {
            key: tab,
            type: "button",
            className: `ps-tab${activeTab === tab ? " is-active" : ""}`,
            title: `Switch to ${INSPECTOR_TAB_LABELS[tab] || tab}`,
            "aria-pressed": activeTab === tab,
            onClick: () => {
                controller.setFocus("inspector");
                controller.selectInspectorTab(tab).catch(() => {});
            },
        }, INSPECTOR_TAB_LABELS[tab] || tab)));
}

function FilesPane({ controller, focused, mobile = false }) {
    const themeId = useControllerSelector(controller, (state) => state.ui.themeId);
    const theme = getTheme(themeId);
    const view = useControllerSelector(controller, (state) => {
        const activeSessionId = state.sessions.activeSessionId;
        const layout = computeLegacyLayout({
            width: state.ui.layout?.viewportWidth ?? 120,
            height: state.ui.layout?.viewportHeight ?? 40,
        }, state.ui.layout?.paneAdjust ?? 0, getPromptInputRows(state.ui.prompt));
        const paneWidth = mobile
            ? (state.ui.layout?.viewportWidth ?? 120)
            : layout.rightWidth;
        const contentWidth = Math.max(20, paneWidth - 4);
        return {
            filesView: selectFilesView(state, {
                listWidth: Math.max(18, contentWidth - 4),
                previewWidth: Math.max(18, contentWidth - 4),
            }),
            items: selectFileBrowserItems(state),
            focused,
            previewScroll: state.ui.scroll.filePreview,
            fullscreen: Boolean(state.files.fullscreen),
            activeSessionId,
        };
    }, shallowEqualObject);

    const previewActions = React.createElement(React.Fragment, null,
        React.createElement("button", {
            type: "button",
            className: "ps-mini-button",
            onClick: () => controller.handleCommand(UI_COMMANDS.OPEN_FILES_FILTER).catch(() => {}),
        }, "Filter"),
        React.createElement("button", {
            type: "button",
            className: "ps-mini-button",
            onClick: () => controller.handleCommand(UI_COMMANDS.TOGGLE_FILE_PREVIEW_FULLSCREEN).catch(() => {}),
        }, view.fullscreen ? "Close" : "Fullscreen"));

    return React.createElement(Panel, {
        title: view.filesView.fullscreen ? view.filesView.fullscreenTitle : view.filesView.panelTitle,
        color: "magenta",
        focused: view.focused,
        theme,
    },
    React.createElement(InspectorTabs, { activeTab: "files", controller }),
    React.createElement("div", { className: "ps-files-grid" },
        React.createElement(Panel, { title: view.filesView.listTitle, color: "cyan", theme },
            React.createElement("div", { className: "ps-action-list" },
                view.items.length === 0
                    ? normalizeLines(view.filesView.listBodyLines || []).map((line, index) => React.createElement(Line, { key: `empty:${index}`, line, theme }))
                    : view.items.map((item, index) => React.createElement("button", {
                        key: item.id,
                        type: "button",
                        className: `ps-list-button${index === view.filesView.selectedIndex ? " is-selected" : ""}`,
                        onClick: () => {
                            controller.setFocus("inspector");
                            controller.selectFileBrowserItem(item).catch(() => {});
                        },
                    },
                    React.createElement("div", { className: "ps-line" },
                        React.createElement(Runs, { runs: Array.isArray(view.filesView.listBodyLines?.[index]) ? view.filesView.listBodyLines[index] : normalizeLines([view.filesView.listBodyLines?.[index]])[0]?.runs || [], theme })),
                    )),
            )),
        React.createElement(ScrollLinesPanel, {
            controller,
            title: view.filesView.previewTitle,
            color: "cyan",
            focused: false,
            actions: previewActions,
            lines: view.filesView.previewLines,
            scrollOffset: view.previewScroll,
            scrollMode: "top",
            paneKey: "filePreview",
            className: "is-preview is-wrapped",
        }),
    ));
}

function InspectorPane({ controller, mobile = false }) {
    const view = useControllerSelector(controller, (state) => {
        const layout = computeLegacyLayout({
            width: state.ui.layout?.viewportWidth ?? 120,
            height: state.ui.layout?.viewportHeight ?? 40,
        }, state.ui.layout?.paneAdjust ?? 0, getPromptInputRows(state.ui.prompt));
        const paneWidth = mobile
            ? (state.ui.layout?.viewportWidth ?? 120)
            : layout.rightWidth;
        const contentWidth = Math.max(20, paneWidth - 4);
        return {
            inspectorTab: state.ui.inspectorTab,
            inspector: selectInspector(state, {
                width: contentWidth,
                allowWideColumns: mobile,
            }),
            focused: state.ui.focusRegion === "inspector",
            scroll: state.ui.scroll.inspector,
            logsTailing: state.logs.tailing,
            filesFullscreen: Boolean(state.files.fullscreen),
        };
    }, shallowEqualObject);

    if (view.inspectorTab === "files") {
        return React.createElement(FilesPane, { controller, focused: view.focused, mobile });
    }

    const actions = [];
    if (view.inspectorTab === "logs") {
        actions.push(React.createElement("button", {
            key: "tail",
            type: "button",
            className: "ps-mini-button",
            onClick: () => controller.handleCommand(UI_COMMANDS.TOGGLE_LOG_TAIL).catch(() => {}),
        }, view.logsTailing ? "Stop Tail" : "Tail"));
        actions.push(React.createElement("button", {
            key: "filter",
            type: "button",
            className: "ps-mini-button",
            onClick: () => controller.handleCommand(UI_COMMANDS.OPEN_LOG_FILTER).catch(() => {}),
        }, "Filter"));
    } else if (view.inspectorTab === "history") {
        actions.push(React.createElement("button", {
            key: "refresh",
            type: "button",
            className: "ps-mini-button",
            onClick: () => controller.handleCommand(UI_COMMANDS.REFRESH_EXECUTION_HISTORY).catch(() => {}),
        }, "Refresh"));
        actions.push(React.createElement("button", {
            key: "save",
            type: "button",
            className: "ps-mini-button",
            onClick: () => controller.handleCommand(UI_COMMANDS.EXPORT_EXECUTION_HISTORY).catch(() => {}),
        }, "Artifact"));
    }

    return React.createElement(ScrollLinesPanel, {
        controller,
        title: view.inspector.title,
        color: "magenta",
        focused: view.focused,
        actions: actions,
        topContent: React.createElement(InspectorTabs, { activeTab: view.inspector.activeTab, controller }),
        stickyLines: view.inspector.stickyLines || [],
        lines: view.inspector.lines,
        scrollOffset: view.scroll,
        scrollMode: view.inspector.activeTab === "logs"
            || view.inspector.activeTab === "sequence"
            || view.inspector.activeTab === "history"
            ? "bottom"
            : "top",
        paneKey: "inspector",
        className: view.inspector.activeTab === "history" ? "is-wrapped" : "is-preserve",
        panelClassName: view.inspector.activeTab === "sequence" ? "has-preserved-sticky" : "",
    });
}

function ActivityPane({ controller }) {
    const view = useControllerSelector(controller, (state) => {
        const layout = computeLegacyLayout({
            width: state.ui.layout?.viewportWidth ?? 120,
            height: state.ui.layout?.viewportHeight ?? 40,
        }, state.ui.layout?.paneAdjust ?? 0, getPromptInputRows(state.ui.prompt));
        const maxLines = Math.max(3, layout.activityPaneHeight - 2);
        return {
            activity: selectActivityPane(state, maxLines),
            focused: state.ui.focusRegion === "activity",
            scroll: state.ui.scroll.activity,
        };
    }, shallowEqualObject);

    return React.createElement(ScrollLinesPanel, {
        controller,
        title: view.activity.title,
        color: "gray",
        focused: view.focused,
        lines: view.activity.lines,
        scrollOffset: view.scroll,
        scrollMode: "bottom",
        paneKey: "activity",
        className: "is-preserve",
    });
}

function PromptComposer({ controller, mobile }) {
    const promptState = useControllerSelector(controller, (state) => {
        const activeSessionId = state.sessions.activeSessionId;
        const activeSession = activeSessionId ? state.sessions.byId[activeSessionId] || null : null;
        return {
            value: state.ui.prompt,
            cursor: state.ui.promptCursor,
            focused: state.ui.focusRegion === "prompt",
            answerMode: Boolean(activeSession?.pendingQuestion?.question),
        };
    }, shallowEqualObject);
    const inputRef = React.useRef(null);

    React.useEffect(() => {
        const inputNode = inputRef.current;
        if (!promptState.focused || !inputNode) return;
        if (document.activeElement !== inputNode) {
            try {
                inputNode.focus({ preventScroll: true });
            } catch {
                inputNode.focus();
            }
        }
        inputNode.setSelectionRange(promptState.cursor, promptState.cursor);
    }, [promptState.cursor, promptState.focused]);

    return React.createElement("div", { className: `ps-prompt-shell${mobile ? " is-mobile" : ""}` },
        React.createElement("label", { className: "ps-prompt-label" }, promptState.answerMode ? "answer" : "you"),
        React.createElement("textarea", {
            ref: inputRef,
            className: "ps-prompt-input",
            rows: mobile ? 2 : Math.max(2, getPromptInputRows(promptState.value)),
            value: promptState.value,
            placeholder: promptState.answerMode
                ? "Type an answer and press Enter"
                : "Type a message and press Enter",
            enterKeyHint: "send",
            onFocus: () => controller.setFocus("prompt"),
            onSelect: (event) => controller.setPrompt(promptState.value, event.currentTarget.selectionStart || 0),
            onChange: (event) => controller.setPrompt(event.currentTarget.value, event.currentTarget.selectionStart || event.currentTarget.value.length),
            onKeyDown: (event) => {
                if (event.key === "Enter" && !event.shiftKey && !event.metaKey && !mobile) {
                    event.preventDefault();
                    controller.handleCommand(UI_COMMANDS.SEND_PROMPT).catch(() => {});
                }
            },
        }),
        React.createElement("button", {
        type: "button",
        className: `ps-send-button${mobile ? " is-inline" : ""}`,
        title: "Send prompt",
        "aria-label": "Send prompt",
        onClick: () => controller.handleCommand(UI_COMMANDS.SEND_PROMPT).catch(() => {}),
        }, mobile ? "↩" : "Send"),
    );
}

function StatusStrip({ controller }) {
    const status = useControllerSelector(controller, (state) => selectStatusBar(state), shallowEqualObject);
    return React.createElement("div", { className: "ps-status-strip" },
        React.createElement("div", { className: "ps-status-left" }, status.left),
        React.createElement("div", { className: "ps-status-right" }, status.right),
    );
}

function Toolbar({ controller, mobile }) {
    const status = useControllerSelector(controller, (state) => selectStatusBar(state), shallowEqualObject);

    return React.createElement("div", { className: `ps-toolbar${mobile ? " is-mobile" : ""}` },
        React.createElement("div", { className: "ps-toolbar-actions" },
            React.createElement("button", {
            type: "button",
            className: "ps-toolbar-button",
            onClick: () => controller.handleCommand(UI_COMMANDS.NEW_SESSION).catch(() => {}),
        }, "New"),
            React.createElement("button", {
            type: "button",
            className: "ps-toolbar-button",
            onClick: () => controller.handleCommand(UI_COMMANDS.REFRESH).catch(() => {}),
        }, "Refresh"),
            React.createElement("button", {
            type: "button",
            className: "ps-toolbar-button",
            onClick: () => controller.handleCommand(UI_COMMANDS.OPEN_THEME_PICKER).catch(() => {}),
        }, "Theme")),
        mobile && status.left
            ? React.createElement("div", { className: "ps-toolbar-status" }, status.left)
            : null,
    );
}

function ColumnResizeHandle({ controller, paneAdjust = 0 }) {
    const dragStateRef = React.useRef(null);
    const [dragging, setDragging] = React.useState(false);

    React.useEffect(() => {
        if (!dragging) return undefined;

        const stopDragging = () => {
            dragStateRef.current = null;
            setDragging(false);
            document.body.classList.remove("is-resizing-pane");
        };

        const onPointerMove = (event) => {
            const dragState = dragStateRef.current;
            if (!dragState) return;
            const deltaCells = Math.round((event.clientX - dragState.startX) / GRID_CELL_WIDTH);
            const deltaIncrement = deltaCells - dragState.appliedCells;
            if (!deltaIncrement) return;
            controller.adjustPaneSplit(deltaIncrement);
            dragState.appliedCells = deltaCells;
        };

        window.addEventListener("pointermove", onPointerMove);
        window.addEventListener("pointerup", stopDragging);
        window.addEventListener("pointercancel", stopDragging);

        return () => {
            window.removeEventListener("pointermove", onPointerMove);
            window.removeEventListener("pointerup", stopDragging);
            window.removeEventListener("pointercancel", stopDragging);
            document.body.classList.remove("is-resizing-pane");
        };
    }, [controller, dragging]);

    return React.createElement("button", {
        type: "button",
        className: `ps-column-resizer${dragging ? " is-dragging" : ""}`,
        title: "Drag to resize the inspector column. Double-click to reset.",
        "aria-label": "Resize inspector column",
        onPointerDown: (event) => {
            if (event.button !== 0) return;
            event.preventDefault();
            dragStateRef.current = {
                startX: event.clientX,
                appliedCells: 0,
            };
            setDragging(true);
            document.body.classList.add("is-resizing-pane");
        },
        onDoubleClick: () => {
            if (!paneAdjust) return;
            controller.adjustPaneSplit(-paneAdjust);
        },
        onKeyDown: (event) => {
            if (event.key === "ArrowLeft") {
                event.preventDefault();
                controller.handleCommand(UI_COMMANDS.GROW_RIGHT_PANE).catch(() => {});
                return;
            }
            if (event.key === "ArrowRight") {
                event.preventDefault();
                controller.handleCommand(UI_COMMANDS.GROW_LEFT_PANE).catch(() => {});
            }
        },
    },
    React.createElement("span", { className: "ps-column-resizer-handle", "aria-hidden": "true" },
        React.createElement("span", { className: "ps-column-resizer-dot" }),
        React.createElement("span", { className: "ps-column-resizer-dot" }),
        React.createElement("span", { className: "ps-column-resizer-dot" })));
}

function MobileNav({ activePane, setActivePane, controller }) {
    const tabs = [
        { id: "workspace", label: "Main", focus: "chat" },
        { id: "inspector", label: "Inspector", focus: "inspector" },
        { id: "activity", label: "Activity", focus: "activity" },
    ];
    return React.createElement("div", { className: "ps-mobile-nav" },
        tabs.map((tab) => React.createElement("button", {
            key: tab.id,
            type: "button",
            className: `ps-mobile-nav-button${activePane === tab.id ? " is-active" : ""}`,
            onClick: () => {
                setActivePane(tab.id);
                controller.setFocus(tab.focus);
            },
        }, tab.label)));
}

function ModalLayer({ controller }) {
    const themeId = useControllerSelector(controller, (state) => state.ui.themeId);
    const theme = getTheme(themeId);
    const modalState = useControllerSelector(controller, (state) => ({
        rawModal: state.ui.modal,
        themePicker: selectThemePickerModal(state),
        modelPicker: selectModelPickerModal(state),
        sessionAgentPicker: selectSessionAgentPickerModal(state),
        artifactPicker: selectArtifactPickerModal(state),
        logFilter: selectLogFilterModal(state),
        filesFilter: selectFilesFilterModal(state),
        historyFormat: selectHistoryFormatModal(state),
        renameSession: selectRenameSessionModal(state),
        artifactUpload: selectArtifactUploadModal(state),
        logsFilter: state.logs.filter,
        filesFilterState: state.files.filter,
        historyFormatState: state.executionHistory?.format || "pretty",
    }), shallowEqualObject);
    const modal = modalState.rawModal;
    if (!modal) return null;

    const close = () => controller.handleCommand(UI_COMMANDS.CLOSE_MODAL).catch(() => {});

    const renderListModal = (presentation, confirmLabel = "Apply") => React.createElement("div", { className: "ps-modal-backdrop", onClick: close },
        React.createElement("div", { className: "ps-modal", onClick: (event) => event.stopPropagation() },
            React.createElement("div", { className: "ps-modal-header" },
                React.createElement("div", { className: "ps-modal-title" }, presentation.title),
                React.createElement("button", { type: "button", className: "ps-modal-close", onClick: close }, "Close"),
            ),
            React.createElement("div", { className: "ps-modal-grid" },
                React.createElement("div", { className: "ps-modal-list" },
                    (modal.items || []).map((item, index) => React.createElement("button", {
                        key: item.id || index,
                        type: "button",
                        className: `ps-list-button${index === modal.selectedIndex ? " is-selected" : ""}`,
                        onClick: () => controller.dispatch({ type: "ui/modalSelection", index }),
                    },
                    React.createElement("div", { className: "ps-line" },
                        React.createElement(Runs, {
                            runs: Array.isArray(presentation.rows?.[index])
                                ? presentation.rows[index]
                                : normalizeLines([presentation.rows?.[index]])[0]?.runs || [{ text: presentation.rows?.[index]?.text || "", color: presentation.rows?.[index]?.color }],
                            theme,
                        })),
                    )),
                ),
                React.createElement("div", { className: "ps-modal-details" },
                    React.createElement("div", { className: "ps-modal-details-title" }, presentation.detailsTitle || "Details"),
                    normalizeLines(presentation.detailsLines || []).map((line, index) => React.createElement(Line, { key: `detail:${index}`, line, theme })),
                ),
            ),
            React.createElement("div", { className: "ps-modal-footer" },
                React.createElement("button", { type: "button", className: "ps-modal-button", onClick: close }, "Cancel"),
                React.createElement("button", {
                    type: "button",
                    className: "ps-modal-button is-primary",
                    onClick: () => controller.handleCommand(UI_COMMANDS.MODAL_CONFIRM).catch(() => {}),
                }, confirmLabel)),
        ));

    if (modal.type === "themePicker" && modalState.themePicker) {
        return renderListModal(modalState.themePicker, "Apply Theme");
    }
    if (modal.type === "modelPicker" && modalState.modelPicker) {
        return renderListModal(modalState.modelPicker, "Create Session");
    }
    if (modal.type === "sessionAgentPicker" && modalState.sessionAgentPicker) {
        return renderListModal(modalState.sessionAgentPicker, "Create Session");
    }
    if (modal.type === "artifactPicker" && modalState.artifactPicker) {
        return renderListModal(modalState.artifactPicker, "Download");
    }
    if (modal.type === "renameSession" && modalState.renameSession) {
        return React.createElement("div", { className: "ps-modal-backdrop", onClick: close },
            React.createElement("div", { className: "ps-modal is-narrow", onClick: (event) => event.stopPropagation() },
                React.createElement("div", { className: "ps-modal-header" },
                    React.createElement("div", { className: "ps-modal-title" }, modalState.renameSession.title),
                    React.createElement("button", { type: "button", className: "ps-modal-close", onClick: close }, "Close"),
                ),
                React.createElement("input", {
                    className: "ps-modal-input",
                    value: modalState.renameSession.value,
                    placeholder: modalState.renameSession.placeholder,
                    onChange: (event) => controller.setRenameSessionValue(event.currentTarget.value, event.currentTarget.selectionStart || event.currentTarget.value.length),
                    onKeyDown: (event) => {
                        if (event.key === "Enter") {
                            event.preventDefault();
                            controller.handleCommand(UI_COMMANDS.MODAL_CONFIRM).catch(() => {});
                        }
                    },
                    autoFocus: true,
                }),
                React.createElement("div", { className: "ps-modal-details" },
                    normalizeLines(modalState.renameSession.helpLines || []).map((line, index) => React.createElement(Line, { key: `help:${index}`, line, theme })),
                ),
                React.createElement("div", { className: "ps-modal-footer" },
                    React.createElement("button", { type: "button", className: "ps-modal-button", onClick: close }, "Cancel"),
                    React.createElement("button", {
                        type: "button",
                        className: "ps-modal-button is-primary",
                        onClick: () => controller.handleCommand(UI_COMMANDS.MODAL_CONFIRM).catch(() => {}),
                    }, "Save")),
            ));
    }
    if (modal.type === "artifactUpload" && modalState.artifactUpload) {
        return React.createElement("div", { className: "ps-modal-backdrop", onClick: close },
            React.createElement("div", { className: "ps-modal is-narrow", onClick: (event) => event.stopPropagation() },
                React.createElement("div", { className: "ps-modal-header" },
                    React.createElement("div", { className: "ps-modal-title" }, modalState.artifactUpload.title),
                    React.createElement("button", { type: "button", className: "ps-modal-close", onClick: close }, "Close"),
                ),
                React.createElement("input", {
                    className: "ps-modal-input",
                    value: modalState.artifactUpload.value,
                    placeholder: modalState.artifactUpload.placeholder,
                    onChange: (event) => controller.setArtifactUploadValue(event.currentTarget.value, event.currentTarget.selectionStart || event.currentTarget.value.length),
                    autoFocus: true,
                }),
                React.createElement("div", { className: "ps-modal-details" },
                    normalizeLines(modalState.artifactUpload.helpLines || []).map((line, index) => React.createElement(Line, { key: `help:${index}`, line, theme })),
                ),
                React.createElement("div", { className: "ps-modal-footer" },
                    React.createElement("button", { type: "button", className: "ps-modal-button", onClick: close }, "Cancel"),
                    React.createElement("button", {
                        type: "button",
                        className: "ps-modal-button is-primary",
                        onClick: () => controller.handleCommand(UI_COMMANDS.MODAL_CONFIRM).catch(() => {}),
                    }, "Attach")),
            ));
    }

    const filterPresentation = modal.type === "logFilter"
        ? modalState.logFilter
        : modal.type === "filesFilter"
            ? modalState.filesFilter
            : modal.type === "historyFormat"
                ? modalState.historyFormat
                : null;
    if (filterPresentation) {
        return React.createElement("div", { className: "ps-modal-backdrop", onClick: close },
            React.createElement("div", { className: "ps-modal is-wide", onClick: (event) => event.stopPropagation() },
                React.createElement("div", { className: "ps-modal-header" },
                    React.createElement("div", { className: "ps-modal-title" }, filterPresentation.title),
                    React.createElement("button", { type: "button", className: "ps-modal-close", onClick: close }, "Close"),
                ),
                React.createElement("div", { className: "ps-filter-grid" },
                    (modal.items || []).map((item, itemIndex) => {
                        const currentValue = modal.type === "filesFilter"
                            ? modalState.filesFilterState?.[item.id] || item.options?.[0]?.id
                            : modal.type === "historyFormat"
                                ? modalState.historyFormatState
                                : modalState.logsFilter?.[item.id] || item.options?.[0]?.id;
                        return React.createElement("div", { key: item.id || itemIndex, className: "ps-filter-column" },
                            React.createElement("div", { className: "ps-filter-title" }, item.label),
                            (item.options || []).map((option) => React.createElement("button", {
                                key: option.id,
                                type: "button",
                                className: `ps-filter-option${option.id === currentValue ? " is-selected" : ""}`,
                                onClick: () => {
                                    controller.dispatch({ type: "ui/modalSelection", index: itemIndex });
                                    if (modal.type === "historyFormat") {
                                        controller.dispatch({ type: "executionHistory/format", format: option.id });
                                    } else if (modal.type === "filesFilter") {
                                        controller.dispatch({ type: "files/filter", filter: { [item.id]: option.id } });
                                        controller.ensureFilesForScope(option.id).catch(() => {});
                                    } else {
                                        controller.dispatch({ type: "logs/filter", filter: { [item.id]: option.id } });
                                    }
                                },
                            }, option.label)),
                        );
                    }),
                ),
                React.createElement("div", { className: "ps-modal-footer" },
                    React.createElement("button", { type: "button", className: "ps-modal-button is-primary", onClick: close }, "Done")),
            ));
    }

    return null;
}

function useKeyboardShortcuts(controller, mobile) {
    React.useEffect(() => {
        const handler = (event) => {
            const target = event.target;
            const editable = target instanceof HTMLElement
                && (target.tagName === "TEXTAREA" || target.tagName === "INPUT" || target.isContentEditable);
            const modal = controller.getState().ui.modal;

            if (!editable && event.key === "T" && event.shiftKey) {
                event.preventDefault();
                controller.handleCommand(UI_COMMANDS.OPEN_THEME_PICKER).catch(() => {});
                return;
            }

            if (modal && !editable) {
                if (event.key === "Escape") {
                    event.preventDefault();
                    controller.handleCommand(UI_COMMANDS.CLOSE_MODAL).catch(() => {});
                    return;
                }
                if (event.key === "Enter") {
                    event.preventDefault();
                    controller.handleCommand(UI_COMMANDS.MODAL_CONFIRM).catch(() => {});
                    return;
                }
                if (event.key === "ArrowUp" || event.key === "k") {
                    event.preventDefault();
                    controller.handleCommand(UI_COMMANDS.MODAL_PREV).catch(() => {});
                    return;
                }
                if (event.key === "ArrowDown" || event.key === "j") {
                    event.preventDefault();
                    controller.handleCommand(UI_COMMANDS.MODAL_NEXT).catch(() => {});
                }
                return;
            }

            if (editable) return;

            if (event.key === "r" && !event.metaKey && !event.ctrlKey && controller.getState().ui.focusRegion !== "prompt") {
                event.preventDefault();
                controller.handleCommand(UI_COMMANDS.REFRESH).catch(() => {});
                return;
            }
            if (event.key === "n" && !event.metaKey && !event.ctrlKey) {
                event.preventDefault();
                controller.handleCommand(UI_COMMANDS.NEW_SESSION).catch(() => {});
                return;
            }
            if (event.key === "p" && !event.metaKey && !event.ctrlKey) {
                event.preventDefault();
                controller.handleCommand(UI_COMMANDS.FOCUS_PROMPT).catch(() => {});
                return;
            }
            if (event.key === "m" && !event.metaKey && !event.ctrlKey && controller.getState().ui.focusRegion === "inspector") {
                event.preventDefault();
                controller.handleCommand(UI_COMMANDS.CYCLE_INSPECTOR_TAB).catch(() => {});
                return;
            }
            if ((event.key === "[" || event.key === "{") && !event.metaKey && !event.ctrlKey) {
                event.preventDefault();
                controller.handleCommand(UI_COMMANDS.GROW_LEFT_PANE).catch(() => {});
                return;
            }
            if ((event.key === "]" || event.key === "}") && !event.metaKey && !event.ctrlKey) {
                event.preventDefault();
                controller.handleCommand(UI_COMMANDS.GROW_RIGHT_PANE).catch(() => {});
                return;
            }
            if (controller.getState().ui.focusRegion === "inspector" && event.key === "ArrowLeft") {
                event.preventDefault();
                controller.handleCommand(UI_COMMANDS.PREV_INSPECTOR_TAB).catch(() => {});
                return;
            }
            if (controller.getState().ui.focusRegion === "inspector" && event.key === "ArrowRight") {
                event.preventDefault();
                controller.handleCommand(UI_COMMANDS.NEXT_INSPECTOR_TAB).catch(() => {});
                return;
            }
            if (!mobile && (event.key === "ArrowUp" || event.key === "k")) {
                event.preventDefault();
                controller.handleCommand(UI_COMMANDS.SCROLL_UP).catch(() => {});
                return;
            }
            if (!mobile && (event.key === "ArrowDown" || event.key === "j")) {
                event.preventDefault();
                controller.handleCommand(UI_COMMANDS.SCROLL_DOWN).catch(() => {});
                return;
            }
            if (!mobile && event.key === "Escape") {
                event.preventDefault();
                controller.handleCommand(UI_COMMANDS.FOCUS_SESSIONS).catch(() => {});
            }
        };

        window.addEventListener("keydown", handler);
        return () => window.removeEventListener("keydown", handler);
    }, [controller, mobile]);
}

export function createWebPilotSwarmController({ transport, mode = "remote", branding = null } = {}) {
    const themeId = readStoredThemeId();
    const store = createStore(appReducer, createInitialState({ mode, branding, themeId }));
    return new PilotSwarmUiController({ store, transport });
}

export function PilotSwarmWebApp({ controller }) {
    const viewportRef = React.useRef(null);
    const viewport = useMeasuredViewport(viewportRef);
    const gridViewport = computeGridViewport(viewport);
    const state = useControllerSelector(controller, (rootState) => ({
        themeId: rootState.ui.themeId,
        promptRows: getPromptInputRows(rootState.ui.prompt),
        paneAdjust: rootState.ui.layout?.paneAdjust ?? 0,
        focusRegion: rootState.ui.focusRegion,
        inspectorTab: rootState.ui.inspectorTab,
        filesFullscreen: Boolean(rootState.files.fullscreen),
    }), shallowEqualObject);
    const [mobilePane, setMobilePane] = React.useState("workspace");
    const [mobileSessionsCollapsed, setMobileSessionsCollapsed] = React.useState(false);
    const mobile = (viewport.width || window.innerWidth || 0) < MOBILE_BREAKPOINT;

    useKeyboardShortcuts(controller, mobile);

    React.useEffect(() => {
        controller.setViewport(gridViewport);
    }, [controller, gridViewport.height, gridViewport.width]);

    React.useEffect(() => {
        applyDocumentTheme(state.themeId);
        writeStoredThemeId(state.themeId);
    }, [state.themeId]);

    React.useEffect(() => {
        if (mobile && state.focusRegion !== "prompt") {
            setMobilePane(state.focusRegion === "activity"
                ? "activity"
                : state.focusRegion === "inspector"
                    ? "inspector"
                    : "workspace");
        }
    }, [mobile, state.focusRegion]);

    const layout = React.useMemo(
        () => computeLegacyLayout(gridViewport, state.paneAdjust, state.promptRows),
        [gridViewport, state.paneAdjust, state.promptRows],
    );
    const desktopWorkspace = React.createElement("div", {
        className: "ps-workspace-grid",
        style: {
            gridTemplateColumns: `minmax(0, ${layout.leftWidth}fr) 16px minmax(0, ${layout.rightWidth}fr)`,
        },
    },
    React.createElement("div", {
        className: "ps-workspace-column",
        style: { gridTemplateRows: `${layout.sessionPaneHeight}fr ${layout.chatPaneHeight}fr` },
    },
    React.createElement(SessionPane, { controller }),
    React.createElement(ChatPane, { controller })),
    React.createElement(ColumnResizeHandle, { controller, paneAdjust: state.paneAdjust }),
    React.createElement("div", {
        className: "ps-workspace-column",
        style: { gridTemplateRows: `${layout.inspectorPaneHeight}fr ${layout.activityPaneHeight}fr` },
    },
    React.createElement(InspectorPane, { controller, mobile: false }),
    React.createElement(ActivityPane, { controller })));

    let mobileContent = null;
    if (mobilePane === "inspector") mobileContent = React.createElement("div", { className: "ps-mobile-pane-fill" },
        React.createElement(InspectorPane, { controller, mobile: true }));
    else if (mobilePane === "activity") mobileContent = React.createElement("div", { className: "ps-mobile-pane-fill" },
        React.createElement(ActivityPane, { controller }));
    else mobileContent = React.createElement(MobileWorkspace, {
        controller,
        sessionsCollapsed: mobileSessionsCollapsed,
        setSessionsCollapsed: setMobileSessionsCollapsed,
    });

    return React.createElement("div", { ref: viewportRef, className: "ps-web-shell" },
        React.createElement(Toolbar, { controller, mobile }),
        React.createElement("div", { className: "ps-workspace" },
            mobile ? mobileContent : desktopWorkspace),
        React.createElement("div", { className: "ps-footer-shell" },
            mobile ? null : React.createElement(StatusStrip, { controller }),
            React.createElement(PromptComposer, { controller, mobile })),
        mobile ? React.createElement(MobileNav, { activePane: mobilePane, setActivePane: setMobilePane, controller }) : null,
        React.createElement(ModalLayer, { controller }));
}
