import { FOCUS_REGIONS } from "./commands.js";

export const DEFAULT_LEFT_PANE_RATIO = 0.7;
export const MIN_LEFT_WIDTH = 30;
export const MIN_RIGHT_WIDTH = 36;
export const COLLAPSE_LEFT_THRESHOLD = 18;
export const COLLAPSE_RIGHT_THRESHOLD = 18;
export const PANE_GAP_X = 0;
export const PANE_GAP_Y = 0;
export const MAX_PROMPT_INPUT_ROWS = 3;
export const MIN_SESSION_PANE_HEIGHT = 6;
export const MIN_CHAT_PANE_HEIGHT = 10;
export const DEFAULT_SESSION_PANE_RATIO = 0.25;

function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
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

export function normalizeViewport(viewport = {}) {
    return {
        width: Math.max(40, Number(viewport.width) || 120),
        height: Math.max(18, Number(viewport.height) || 40),
    };
}

export function getPromptInputRows(prompt = "") {
    const explicitLines = String(prompt || "").split("\n").length;
    return clamp(explicitLines, 1, MAX_PROMPT_INPUT_ROWS);
}

export function computeLegacyLayout(viewport, paneAdjust = 0, promptRows = 1, sessionPaneAdjust = 0, fullscreenPane = null) {
    const safeViewport = normalizeViewport(viewport);
    const totalWidth = safeViewport.width;
    const totalHeight = safeViewport.height;
    const safePromptRows = clamp(Number(promptRows) || 1, 1, MAX_PROMPT_INPUT_ROWS);
    const safeFullscreenPane = normalizeFullscreenPane(fullscreenPane);
    const reservedRows = 5 + safePromptRows;
    const bodyHeight = Math.max(18, totalHeight - reservedRows);
    const baseLeftWidth = Math.floor(totalWidth * DEFAULT_LEFT_PANE_RATIO);
    const desiredLeftWidth = baseLeftWidth + (Number(paneAdjust) || 0);
    const desiredRightWidth = totalWidth - desiredLeftWidth - PANE_GAP_X;

    let leftHidden = false;
    let rightHidden = false;

    if (desiredLeftWidth <= COLLAPSE_LEFT_THRESHOLD && desiredRightWidth > COLLAPSE_RIGHT_THRESHOLD) {
        leftHidden = true;
    } else if (desiredRightWidth <= COLLAPSE_RIGHT_THRESHOLD && desiredLeftWidth > COLLAPSE_LEFT_THRESHOLD) {
        rightHidden = true;
    } else if (desiredLeftWidth <= COLLAPSE_LEFT_THRESHOLD && desiredRightWidth <= COLLAPSE_RIGHT_THRESHOLD) {
        rightHidden = paneAdjust >= 0;
        leftHidden = !rightHidden;
    }

    let leftWidth;
    let rightWidth;

    if (leftHidden) {
        leftWidth = 0;
        rightWidth = totalWidth;
    } else if (rightHidden) {
        leftWidth = totalWidth;
        rightWidth = 0;
    } else {
        leftWidth = clamp(desiredLeftWidth, MIN_LEFT_WIDTH, totalWidth - MIN_RIGHT_WIDTH - PANE_GAP_X);
        rightWidth = Math.max(MIN_RIGHT_WIDTH, totalWidth - leftWidth - PANE_GAP_X);
    }

    const baseSessionPaneHeight = Math.max(MIN_SESSION_PANE_HEIGHT, Math.floor(bodyHeight * DEFAULT_SESSION_PANE_RATIO));
    const sessionPaneHeight = clamp(
        baseSessionPaneHeight + (Number(sessionPaneAdjust) || 0),
        MIN_SESSION_PANE_HEIGHT,
        Math.max(MIN_SESSION_PANE_HEIGHT, bodyHeight - MIN_CHAT_PANE_HEIGHT),
    );
    const activityPaneHeight = Math.max(6, Math.floor(bodyHeight * 0.28));

    return {
        viewport: safeViewport,
        totalWidth,
        totalHeight,
        reservedRows,
        bodyHeight,
        promptRows: safePromptRows,
        fullscreenPane: safeFullscreenPane,
        paneAdjust: Number(paneAdjust) || 0,
        sessionPaneAdjust: Number(sessionPaneAdjust) || 0,
        leftHidden,
        rightHidden,
        leftWidth,
        rightWidth,
        sessionPaneHeight,
        chatPaneHeight: Math.max(MIN_CHAT_PANE_HEIGHT, bodyHeight - sessionPaneHeight),
        activityPaneHeight,
        inspectorPaneHeight: Math.max(10, bodyHeight - activityPaneHeight),
    };
}

export function getFocusOrderForLayout(layout) {
    if (layout?.fullscreenPane) {
        return [layout.fullscreenPane, FOCUS_REGIONS.PROMPT];
    }
    if (layout?.leftHidden) {
        return [FOCUS_REGIONS.INSPECTOR, FOCUS_REGIONS.ACTIVITY, FOCUS_REGIONS.PROMPT];
    }
    if (layout?.rightHidden) {
        return [FOCUS_REGIONS.SESSIONS, FOCUS_REGIONS.CHAT, FOCUS_REGIONS.PROMPT];
    }
    return [
        FOCUS_REGIONS.SESSIONS,
        FOCUS_REGIONS.CHAT,
        FOCUS_REGIONS.INSPECTOR,
        FOCUS_REGIONS.ACTIVITY,
        FOCUS_REGIONS.PROMPT,
    ];
}

export function normalizeFocusRegion(focusRegion, layout) {
    const order = getFocusOrderForLayout(layout);
    if (order.includes(focusRegion)) return focusRegion;
    return order[0] || FOCUS_REGIONS.PROMPT;
}

export function getFocusLeftTarget(focusRegion, layout) {
    if (layout?.fullscreenPane) {
        return layout.fullscreenPane;
    }
    if (layout?.leftHidden) {
        const map = {
            [FOCUS_REGIONS.PROMPT]: FOCUS_REGIONS.PROMPT,
            [FOCUS_REGIONS.ACTIVITY]: FOCUS_REGIONS.INSPECTOR,
            [FOCUS_REGIONS.INSPECTOR]: FOCUS_REGIONS.INSPECTOR,
        };
        return map[focusRegion] || FOCUS_REGIONS.INSPECTOR;
    }

    if (layout?.rightHidden) {
        const map = {
            [FOCUS_REGIONS.PROMPT]: FOCUS_REGIONS.PROMPT,
            [FOCUS_REGIONS.CHAT]: FOCUS_REGIONS.SESSIONS,
            [FOCUS_REGIONS.SESSIONS]: FOCUS_REGIONS.SESSIONS,
        };
        return map[focusRegion] || FOCUS_REGIONS.SESSIONS;
    }

    const map = {
        [FOCUS_REGIONS.PROMPT]: FOCUS_REGIONS.SESSIONS,
        [FOCUS_REGIONS.ACTIVITY]: FOCUS_REGIONS.CHAT,
        [FOCUS_REGIONS.INSPECTOR]: FOCUS_REGIONS.CHAT,
        [FOCUS_REGIONS.CHAT]: FOCUS_REGIONS.SESSIONS,
        [FOCUS_REGIONS.SESSIONS]: FOCUS_REGIONS.SESSIONS,
    };
    return map[focusRegion] || FOCUS_REGIONS.SESSIONS;
}

export function getFocusRightTarget(focusRegion, layout) {
    if (layout?.fullscreenPane) {
        return layout.fullscreenPane;
    }
    if (layout?.leftHidden) {
        const map = {
            [FOCUS_REGIONS.PROMPT]: FOCUS_REGIONS.PROMPT,
            [FOCUS_REGIONS.INSPECTOR]: FOCUS_REGIONS.ACTIVITY,
            [FOCUS_REGIONS.ACTIVITY]: FOCUS_REGIONS.ACTIVITY,
        };
        return map[focusRegion] || FOCUS_REGIONS.INSPECTOR;
    }

    if (layout?.rightHidden) {
        const map = {
            [FOCUS_REGIONS.PROMPT]: FOCUS_REGIONS.PROMPT,
            [FOCUS_REGIONS.SESSIONS]: FOCUS_REGIONS.CHAT,
            [FOCUS_REGIONS.CHAT]: FOCUS_REGIONS.CHAT,
        };
        return map[focusRegion] || FOCUS_REGIONS.CHAT;
    }

    const map = {
        [FOCUS_REGIONS.PROMPT]: FOCUS_REGIONS.PROMPT,
        [FOCUS_REGIONS.SESSIONS]: FOCUS_REGIONS.CHAT,
        [FOCUS_REGIONS.CHAT]: FOCUS_REGIONS.INSPECTOR,
        [FOCUS_REGIONS.INSPECTOR]: FOCUS_REGIONS.ACTIVITY,
        [FOCUS_REGIONS.ACTIVITY]: FOCUS_REGIONS.ACTIVITY,
    };
    return map[focusRegion] || FOCUS_REGIONS.CHAT;
}
