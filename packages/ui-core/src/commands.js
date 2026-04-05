export const FOCUS_REGIONS = {
    SESSIONS: "sessions",
    CHAT: "chat",
    INSPECTOR: "inspector",
    ACTIVITY: "activity",
    PROMPT: "prompt",
};

export const INSPECTOR_TABS = ["sequence", "logs", "nodes", "history", "files"];

export const UI_COMMANDS = {
    REFRESH: "refresh",
    NEW_SESSION: "newSession",
    OPEN_MODEL_PICKER: "openModelPicker",
    OPEN_THEME_PICKER: "openThemePicker",
    OPEN_RENAME_SESSION: "openRenameSession",
    OPEN_ARTIFACT_UPLOAD: "openArtifactUpload",
    CLOSE_MODAL: "closeModal",
    MODAL_PREV: "modalPrev",
    MODAL_NEXT: "modalNext",
    MODAL_PANE_PREV: "modalPanePrev",
    MODAL_PANE_NEXT: "modalPaneNext",
    MODAL_CONFIRM: "modalConfirm",
    SEND_PROMPT: "sendPrompt",
    FOCUS_NEXT: "focusNext",
    FOCUS_PREV: "focusPrev",
    FOCUS_LEFT: "focusLeft",
    FOCUS_RIGHT: "focusRight",
    FOCUS_PROMPT: "focusPrompt",
    FOCUS_SESSIONS: "focusSessions",
    MOVE_SESSION_UP: "moveSessionUp",
    MOVE_SESSION_DOWN: "moveSessionDown",
    EXPAND_SESSION: "expandSession",
    COLLAPSE_SESSION: "collapseSession",
    NEXT_INSPECTOR_TAB: "nextInspectorTab",
    PREV_INSPECTOR_TAB: "prevInspectorTab",
    CYCLE_INSPECTOR_TAB: "cycleInspectorTab",
    GROW_LEFT_PANE: "growLeftPane",
    GROW_RIGHT_PANE: "growRightPane",
    OPEN_ARTIFACT_PICKER: "openArtifactPicker",
    TOGGLE_LOG_TAIL: "toggleLogTail",
    OPEN_LOG_FILTER: "openLogFilter",
    OPEN_FILES_FILTER: "openFilesFilter",
    MOVE_FILE_UP: "moveFileUp",
    MOVE_FILE_DOWN: "moveFileDown",
    OPEN_SELECTED_FILE: "openSelectedFile",
    TOGGLE_FILE_PREVIEW_FULLSCREEN: "toggleFilePreviewFullscreen",
    SCROLL_UP: "scrollUp",
    SCROLL_DOWN: "scrollDown",
    PAGE_UP: "pageUp",
    PAGE_DOWN: "pageDown",
    EXPAND_HISTORY: "expandHistory",
    SCROLL_TOP: "scrollTop",
    SCROLL_BOTTOM: "scrollBottom",
    DONE_SESSION: "doneSession",
    CANCEL_SESSION: "cancelSession",
    DELETE_SESSION: "deleteSession",
    OPEN_HISTORY_FORMAT: "openHistoryFormat",
    REFRESH_EXECUTION_HISTORY: "refreshExecutionHistory",
    EXPORT_EXECUTION_HISTORY: "exportExecutionHistory",
};

export function cycleValue(values, current, delta) {
    const index = values.indexOf(current);
    const safeIndex = index === -1 ? 0 : index;
    const nextIndex = (safeIndex + delta + values.length) % values.length;
    return values[nextIndex];
}
