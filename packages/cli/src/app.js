import React from "react";
import { useInput, useStdin } from "ink";
import { UiPlatformProvider, SharedPilotSwarmApp } from "pilotswarm-ui-react";
import { UI_COMMANDS } from "pilotswarm-ui-core";

const MOUSE_INPUT_PATTERN = /\u001b\[<(\d+);(\d+);(\d+)([mM])/gu;
const MOUSE_INPUT_FRAGMENT_PATTERN = /(?:\u001b)?\[<\d+;\d+;\d+[mM]/u;
const MOUSE_INPUT_CHUNK_PATTERN = /(?:\u001b?\[<|<)?\d+;\d+;\d+[mM]?/u;

export function isMouseInputSequence(input = "") {
    const value = String(input || "");
    return /^\u001b\[<\d+;\d+;\d+[mM]$/u.test(value)
        || MOUSE_INPUT_FRAGMENT_PATTERN.test(value);
}

function looksLikeMouseInputFragment(input = "") {
    const value = String(input || "");
    if (!value) return false;
    return value.includes("[<")
        || value.startsWith("<")
        || MOUSE_INPUT_CHUNK_PATTERN.test(value);
}

export function parseMouseInputSequences(input = "") {
    const events = [];
    MOUSE_INPUT_PATTERN.lastIndex = 0;
    for (const match of String(input || "").matchAll(MOUSE_INPUT_PATTERN)) {
        const code = Number(match[1]);
        if (!Number.isFinite(code) || code >= 64) continue;
        const buttonCode = code & 3;
        const isRelease = match[4] === "m";
        const isMotion = Boolean(code & 32);
        const button = buttonCode === 0
            ? "left"
            : buttonCode === 1
                ? "middle"
                : buttonCode === 2
                    ? "right"
                    : "none";
        events.push({
            button,
            type: isRelease ? "up" : (isMotion ? "drag" : "down"),
            x: Math.max(0, Number(match[2]) - 1),
            y: Math.max(0, Number(match[3]) - 1),
        });
    }
    return events;
}

function formatCopyStatus(result) {
    if (!result?.attempted) return null;
    return result.copied ? "Copied to the clipboard" : "Clipboard copy failed";
}

export function getQuitPendingStatus(mode) {
    return mode === "remote"
        ? "Still quitting... disconnecting remote client"
        : "Still quitting... stopping local workers";
}

export function isPlainShortcutKey(key = {}) {
    return !key.ctrl && !key.meta;
}

export function PilotSwarmTuiApp({ controller, platform, onRequestExit }) {
    const { stdin } = useStdin();
    const mouseInputRef = React.useRef({ ignoreUntil: 0 });
    const quitStateRef = React.useRef({
        armedUntil: 0,
        timer: null,
        previousStatus: "",
    });
    const transientStatusRef = React.useRef({
        timer: null,
        previousStatus: "",
    });
    const exitingRef = React.useRef(false);
    const [, forceRender] = React.useState(0);

    const clearTransientStatus = React.useCallback((restoreStatus = false) => {
        const transientStatus = transientStatusRef.current;
        if (transientStatus.timer) {
            clearTimeout(transientStatus.timer);
            transientStatus.timer = null;
        }
        if (restoreStatus) {
            controller.setStatus(transientStatus.previousStatus || "Connected");
        }
    }, [controller]);

    const flashTransientStatus = React.useCallback((text, durationMs = 2400) => {
        if (!text) return;
        const transientStatus = transientStatusRef.current;
        const hadActiveFlash = Boolean(transientStatus.timer);
        const previousStatus = hadActiveFlash
            ? transientStatus.previousStatus
            : controller.getState().ui.statusText;
        clearTransientStatus(false);
        transientStatus.previousStatus = previousStatus;
        controller.setStatus(text);
        transientStatus.timer = setTimeout(() => {
            transientStatus.timer = null;
            if (controller.getState().ui.statusText === text) {
                controller.setStatus(transientStatus.previousStatus || "Connected");
            }
        }, durationMs);
    }, [clearTransientStatus, controller]);

    const clearQuitArm = React.useCallback((restoreStatus = false) => {
        const quitState = quitStateRef.current;
        if (quitState.timer) {
            clearTimeout(quitState.timer);
            quitState.timer = null;
        }
        const wasArmed = quitState.armedUntil > Date.now();
        quitState.armedUntil = 0;
        if (restoreStatus && wasArmed) {
            const currentStatus = controller.getState().ui.statusText;
            if (currentStatus === "Press q to quit, or continue navigating") {
                controller.setStatus(quitState.previousStatus || "Connected");
            }
        }
    }, [controller]);

    const armQuit = React.useCallback(() => {
        clearQuitArm(false);
        const quitState = quitStateRef.current;
        quitState.previousStatus = controller.getState().ui.statusText;
        quitState.armedUntil = Date.now() + 1500;
        controller.setStatus("Press q to quit, or continue navigating");
        quitState.timer = setTimeout(() => {
            clearQuitArm(true);
        }, 1500);
    }, [clearQuitArm, controller]);

    const requestExit = React.useCallback(() => {
        if (exitingRef.current) return;
        exitingRef.current = true;
        clearQuitArm(false);
        controller.setStatus("Quitting...");

        const slowTimer = setTimeout(() => {
            controller.setStatus(getQuitPendingStatus(controller.getState().connection.mode));
        }, 300);

        Promise.resolve(onRequestExit?.())
            .catch(() => {})
            .finally(() => {
                clearTimeout(slowTimer);
            });
    }, [clearQuitArm, controller, onRequestExit]);

    React.useEffect(() => {
        let mounted = true;
        controller.start().catch((error) => {
            if (mounted) {
                const message = error?.message || String(error);
                controller.dispatch({
                    type: "connection/error",
                    error: message,
                    statusText: `Startup failed: ${message}`,
                });
            }
        });
        return () => {
            mounted = false;
            if (exitingRef.current) return;
            clearQuitArm(false);
            clearTransientStatus(false);
            controller.stop().catch(() => {});
        };
    }, [clearQuitArm, clearTransientStatus, controller]);

    React.useEffect(() => {
        if (typeof platform.setRenderInvalidator !== "function") return undefined;
        platform.setRenderInvalidator(() => {
            forceRender((value) => value + 1);
        });
        return () => {
            platform.setRenderInvalidator(null);
        };
    }, [platform]);

    React.useEffect(() => {
        if (!stdin || !process.stdout?.isTTY) return undefined;
        const enableMouse = "\u001b[?1000h\u001b[?1002h\u001b[?1006h";
        const disableMouse = "\u001b[?1000l\u001b[?1002l\u001b[?1006l";

        try {
            process.stdout.write(enableMouse);
        } catch {}

        const onData = (chunk) => {
            const events = parseMouseInputSequences(chunk?.toString?.("utf8") || "");
            if (events.length === 0) return;
            mouseInputRef.current.ignoreUntil = Date.now() + 120;
            if (controller.getState().ui.modal) {
                platform.clearPointerSelection?.();
                return;
            }
            for (const event of events) {
                if (event.type === "down" && event.button === "left") {
                    platform.beginPointerSelection?.(event.x, event.y);
                    continue;
                }
                if (event.type === "drag") {
                    platform.updatePointerSelection?.(event.x, event.y);
                    continue;
                }
                if (event.type === "up") {
                    const result = platform.finalizePointerSelection?.() || null;
                    const status = formatCopyStatus(result);
                    if (status) flashTransientStatus(status);
                }
            }
        };

        stdin.on("data", onData);
        return () => {
            try {
                stdin.off("data", onData);
            } catch {}
            platform.clearPointerSelection?.();
            try {
                process.stdout.write(disableMouse);
            } catch {}
        };
    }, [controller, flashTransientStatus, platform, stdin]);

    useInput((input, key) => {
        const focus = controller.getState().ui.focusRegion;
        const modal = controller.getState().ui.modal;
        const inspectorTab = controller.getState().ui.inspectorTab;
        const plainShortcut = isPlainShortcutKey(key);
        const matchesCtrlKey = (name, controlChar) => key.ctrl
            && (key.name === name || input === name || input === controlChar);
        const isCtrlU = matchesCtrlKey("u", "\u0015");
        const isCtrlD = matchesCtrlKey("d", "\u0004");
        const isCtrlE = matchesCtrlKey("e", "\u0005");
        const isCtrlJ = matchesCtrlKey("j", "\n");
        const isCtrlA = matchesCtrlKey("a", "\u0001");
        const isShiftN = input === "N" || (key.shift && key.name === "n");
        const isShiftD = input === "D" || (key.shift && key.name === "d");
        const isShiftT = !key.ctrl && !key.meta && !key.alt && (input === "T" || (key.shift && key.name === "t"));
        const isAltBackspace = key.meta && (key.backspace || key.delete || key.name === "backspace" || key.name === "delete");
        const isAltLeftWord = key.meta && (key.leftArrow || key.name === "left" || input === "b" || input === "B");
        const isAltRightWord = key.meta && (key.rightArrow || key.name === "right" || input === "f" || input === "F");

        if (
            isMouseInputSequence(input)
            || (
                mouseInputRef.current.ignoreUntil > Date.now()
                && looksLikeMouseInputFragment(input)
            )
        ) {
            return;
        }

        if (key.ctrl && input === "c") {
            requestExit();
            return;
        }
        if (focus !== "prompt" && input === "q" && quitStateRef.current.armedUntil > Date.now()) {
            clearQuitArm(false);
            requestExit();
            return;
        }
        if (focus !== "prompt" && input === "q") {
            clearQuitArm(false);
            requestExit();
            return;
        }

        if (key.name !== "escape") {
            clearQuitArm(true);
        }

        if (modal) {
            if (isShiftT && modal.type === "themePicker") {
                controller.handleCommand(UI_COMMANDS.CLOSE_MODAL).catch(() => {});
                return;
            }
            if (modal.type === "renameSession" || modal.type === "artifactUpload") {
                if (key.escape) {
                    controller.handleCommand(UI_COMMANDS.CLOSE_MODAL).catch(() => {});
                    return;
                }
                if (key.return) {
                    controller.handleCommand(UI_COMMANDS.MODAL_CONFIRM).catch(() => {});
                    return;
                }
                if (key.leftArrow) {
                    if (modal.type === "renameSession") controller.moveRenameSessionCursor(-1);
                    else controller.moveArtifactUploadCursor(-1);
                    return;
                }
                if (key.rightArrow) {
                    if (modal.type === "renameSession") controller.moveRenameSessionCursor(1);
                    else controller.moveArtifactUploadCursor(1);
                    return;
                }
                if (key.home) {
                    if (modal.type === "renameSession") controller.moveRenameSessionCursorToBoundary("start");
                    else controller.moveArtifactUploadCursorToBoundary("start");
                    return;
                }
                if (key.end) {
                    if (modal.type === "renameSession") controller.moveRenameSessionCursorToBoundary("end");
                    else controller.moveArtifactUploadCursorToBoundary("end");
                    return;
                }
                if (key.backspace || key.delete) {
                    if (modal.type === "renameSession") controller.deleteRenameSessionChar();
                    else controller.deleteArtifactUploadChar();
                    return;
                }
                if (!key.ctrl && !key.meta && input) {
                    if (modal.type === "renameSession") controller.insertRenameSessionText(input);
                    else controller.insertArtifactUploadText(input);
                }
                return;
            }
            if (key.escape || input === "q" || (modal.type === "artifactPicker" && input === "a")) {
                controller.handleCommand(UI_COMMANDS.CLOSE_MODAL).catch(() => {});
                return;
            }
            if (key.tab && key.shift) {
                controller.handleCommand(UI_COMMANDS.MODAL_PANE_PREV).catch(() => {});
                return;
            }
            if (key.tab) {
                controller.handleCommand(UI_COMMANDS.MODAL_PANE_NEXT).catch(() => {});
                return;
            }
            if (key.return) {
                controller.handleCommand(UI_COMMANDS.MODAL_CONFIRM).catch(() => {});
                return;
            }
            if (key.upArrow || input === "k") {
                controller.handleCommand(UI_COMMANDS.MODAL_PREV).catch(() => {});
                return;
            }
            if (key.downArrow || input === "j") {
                controller.handleCommand(UI_COMMANDS.MODAL_NEXT).catch(() => {});
                return;
            }
            return;
        }

        if (isShiftT) {
            controller.handleCommand(UI_COMMANDS.OPEN_THEME_PICKER).catch(() => {});
            return;
        }

        if (key.tab && key.shift) {
            controller.handleCommand(UI_COMMANDS.FOCUS_PREV).catch(() => {});
            return;
        }
        if (key.tab) {
            controller.handleCommand(UI_COMMANDS.FOCUS_NEXT).catch(() => {});
            return;
        }
        if (key.escape && focus === "inspector" && inspectorTab === "files" && controller.getState().files.fullscreen) {
            controller.handleCommand(UI_COMMANDS.TOGGLE_FILE_PREVIEW_FULLSCREEN).catch(() => {});
            return;
        }
        if (key.escape) {
            if (focus === "prompt") {
                controller.setPrompt("");
                controller.handleCommand(UI_COMMANDS.FOCUS_SESSIONS).catch(() => {});
                return;
            }
            controller.handleCommand(UI_COMMANDS.FOCUS_SESSIONS).catch(() => {});
            armQuit();
            return;
        }

        if (focus !== "prompt" && isShiftN) {
            controller.handleCommand(UI_COMMANDS.OPEN_MODEL_PICKER).catch(() => {});
            return;
        }

        if (focus === "chat" && (input === "e" || isCtrlE)) {
            controller.handleCommand(UI_COMMANDS.EXPAND_HISTORY).catch(() => {});
            return;
        }

        if (focus === "inspector" && inspectorTab === "logs" && input === "t") {
            controller.handleCommand(UI_COMMANDS.TOGGLE_LOG_TAIL).catch(() => {});
            return;
        }
        if (focus === "inspector" && inspectorTab === "logs" && input === "f") {
            controller.handleCommand(UI_COMMANDS.OPEN_LOG_FILTER).catch(() => {});
            return;
        }
        if (focus === "inspector" && inspectorTab === "files" && input === "f") {
            controller.handleCommand(UI_COMMANDS.OPEN_FILES_FILTER).catch(() => {});
            return;
        }
        if (focus === "inspector" && inspectorTab === "history" && input === "f") {
            controller.handleCommand(UI_COMMANDS.OPEN_HISTORY_FORMAT).catch(() => {});
            return;
        }
        if (focus === "inspector" && inspectorTab === "history" && input === "r") {
            controller.handleCommand(UI_COMMANDS.REFRESH_EXECUTION_HISTORY).catch(() => {});
            return;
        }
        if (focus === "inspector" && inspectorTab === "history" && input === "a") {
            controller.handleCommand(UI_COMMANDS.EXPORT_EXECUTION_HISTORY).catch(() => {});
            return;
        }
        if (focus === "inspector" && inspectorTab === "files" && input === "v") {
            controller.handleCommand(UI_COMMANDS.TOGGLE_FILE_PREVIEW_FULLSCREEN).catch(() => {});
            return;
        }
        if (focus === "inspector" && inspectorTab === "files" && plainShortcut && input === "o") {
            controller.handleCommand(UI_COMMANDS.OPEN_SELECTED_FILE).catch(() => {});
            return;
        }
        if (focus === "inspector" && inspectorTab === "files" && !controller.getState().files.fullscreen) {
            if (key.upArrow || input === "k") {
                controller.handleCommand(UI_COMMANDS.MOVE_FILE_UP).catch(() => {});
                return;
            }
            if (key.downArrow || input === "j") {
                controller.handleCommand(UI_COMMANDS.MOVE_FILE_DOWN).catch(() => {});
                return;
            }
        }

        if (focus !== "prompt" && input === "[") {
            controller.handleCommand(UI_COMMANDS.GROW_LEFT_PANE).catch(() => {});
            return;
        }
        if (focus !== "prompt" && input === "]") {
            controller.handleCommand(UI_COMMANDS.GROW_RIGHT_PANE).catch(() => {});
            return;
        }

        if (focus === "prompt") {
            if (isCtrlA) {
                controller.handleCommand(UI_COMMANDS.OPEN_ARTIFACT_UPLOAD).catch(() => {});
                return;
            }
            if (key.return && key.meta) {
                controller.insertPromptText("\n");
                return;
            }
            if (key.return) {
                controller.handleCommand(UI_COMMANDS.SEND_PROMPT).catch(() => {});
                return;
            }
            if (isAltLeftWord) {
                controller.movePromptCursorWord(-1);
                return;
            }
            if (isAltRightWord) {
                controller.movePromptCursorWord(1);
                return;
            }
            if (key.leftArrow) {
                controller.movePromptCursor(-1);
                return;
            }
            if (key.rightArrow) {
                controller.movePromptCursor(1);
                return;
            }
            if (key.upArrow) {
                controller.movePromptCursorVertical(-1);
                return;
            }
            if (key.downArrow) {
                controller.movePromptCursorVertical(1);
                return;
            }
            if (isAltBackspace) {
                controller.deletePromptWordBackward();
                return;
            }
            if (key.backspace || key.delete) {
                controller.deletePromptChar();
                return;
            }
            if (isCtrlJ) {
                controller.insertPromptText("\n");
                return;
            }
            if (!key.ctrl && !key.meta && input) {
                controller.insertPromptText(input);
            }
            return;
        }

        if (plainShortcut && input === "p") {
            controller.handleCommand(UI_COMMANDS.FOCUS_PROMPT).catch(() => {});
            return;
        }
        if (plainShortcut && input === "n") {
            controller.handleCommand(UI_COMMANDS.NEW_SESSION).catch(() => {});
            return;
        }
        if (plainShortcut && input === "r") {
            controller.handleCommand(UI_COMMANDS.REFRESH).catch(() => {});
            return;
        }
        if (plainShortcut && input === "a") {
            controller.handleCommand(UI_COMMANDS.OPEN_ARTIFACT_PICKER).catch(() => {});
            return;
        }
        if (plainShortcut && input === "m") {
            controller.handleCommand(UI_COMMANDS.CYCLE_INSPECTOR_TAB).catch(() => {});
            return;
        }
        if (plainShortcut && input === "c") {
            controller.handleCommand(UI_COMMANDS.CANCEL_SESSION).catch(() => {});
            return;
        }
        if (plainShortcut && input === "d") {
            controller.handleCommand(UI_COMMANDS.DONE_SESSION).catch(() => {});
            return;
        }
        if (plainShortcut && isShiftD) {
            controller.handleCommand(UI_COMMANDS.DELETE_SESSION).catch(() => {});
            return;
        }
        if (focus !== "prompt" && (input === "h" || key.leftArrow)) {
            if (focus === "inspector" && key.leftArrow) {
                controller.handleCommand(UI_COMMANDS.PREV_INSPECTOR_TAB).catch(() => {});
                return;
            }
            controller.handleCommand(UI_COMMANDS.FOCUS_LEFT).catch(() => {});
            return;
        }
        if (focus !== "prompt" && (input === "l" || key.rightArrow)) {
            if (focus === "inspector" && key.rightArrow) {
                controller.handleCommand(UI_COMMANDS.NEXT_INSPECTOR_TAB).catch(() => {});
                return;
            }
            controller.handleCommand(UI_COMMANDS.FOCUS_RIGHT).catch(() => {});
            return;
        }

        if (focus === "sessions") {
            if (key.upArrow || input === "k") {
                controller.handleCommand(UI_COMMANDS.MOVE_SESSION_UP).catch(() => {});
                return;
            }
            if (key.downArrow || input === "j") {
                controller.handleCommand(UI_COMMANDS.MOVE_SESSION_DOWN).catch(() => {});
                return;
            }
            if (isCtrlU || key.pageUp) {
                controller.handleCommand(UI_COMMANDS.PAGE_UP).catch(() => {});
                return;
            }
            if (isCtrlD || key.pageDown) {
                controller.handleCommand(UI_COMMANDS.PAGE_DOWN).catch(() => {});
                return;
            }
            if (input === "+" || input === "=") {
                controller.handleCommand(UI_COMMANDS.EXPAND_SESSION).catch(() => {});
                return;
            }
            if (input === "-") {
                controller.handleCommand(UI_COMMANDS.COLLAPSE_SESSION).catch(() => {});
                return;
            }
            if (plainShortcut && input === "t") {
                controller.handleCommand(UI_COMMANDS.OPEN_RENAME_SESSION).catch(() => {});
                return;
            }
        }

        if (focus === "chat" || focus === "inspector" || focus === "activity") {
            if (key.upArrow || input === "k") {
                controller.handleCommand(UI_COMMANDS.SCROLL_UP).catch(() => {});
                return;
            }
            if (key.downArrow || input === "j") {
                controller.handleCommand(UI_COMMANDS.SCROLL_DOWN).catch(() => {});
                return;
            }
            if (isCtrlU || key.pageUp) {
                controller.handleCommand(UI_COMMANDS.PAGE_UP).catch(() => {});
                return;
            }
            if (isCtrlD || key.pageDown) {
                controller.handleCommand(UI_COMMANDS.PAGE_DOWN).catch(() => {});
                return;
            }
            if (input === "g") {
                controller.handleCommand(UI_COMMANDS.SCROLL_TOP).catch(() => {});
                return;
            }
            if (input === "G" || (key.shift && input === "g")) {
                controller.handleCommand(UI_COMMANDS.SCROLL_BOTTOM).catch(() => {});
                return;
            }
        }

        if (focus === "inspector") {
            if (key.leftArrow) {
                controller.handleCommand(UI_COMMANDS.PREV_INSPECTOR_TAB).catch(() => {});
                return;
            }
            if (key.rightArrow) {
                controller.handleCommand(UI_COMMANDS.NEXT_INSPECTOR_TAB).catch(() => {});
                return;
            }
        }

    });

    return React.createElement(UiPlatformProvider, { platform },
        React.createElement(SharedPilotSwarmApp, { controller }));
}
