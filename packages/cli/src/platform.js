import React from "react";
import { spawnSync } from "node:child_process";
import { Box, Text } from "ink";
import { DEFAULT_THEME_ID, getTheme, parseTerminalMarkupRuns } from "pilotswarm-ui-core";

const MAX_PROMPT_INPUT_ROWS = 3;
const SELECTION_BACKGROUND = "selectionBackground";
const SELECTION_FOREGROUND = "selectionForeground";

function clampValue(value, min, max) {
    return Math.max(min, Math.min(max, value));
}

function createEmptySelection() {
    return {
        paneId: null,
        anchor: null,
        head: null,
        dragging: false,
        moved: false,
    };
}

const tuiPlatformRuntime = {
    paneRegistry: new Map(),
    selection: createEmptySelection(),
    renderInvalidator: null,
    themeId: DEFAULT_THEME_ID,
};

function getCurrentTheme() {
    return getTheme(tuiPlatformRuntime.themeId) || getTheme(DEFAULT_THEME_ID);
}

function resolveColorToken(color) {
    if (!color) return undefined;
    const theme = getCurrentTheme();
    return theme?.tui?.[color] || color;
}

function isDimColorToken(color) {
    return color === "gray";
}

function trimText(value, width) {
    if (width <= 0) return "";
    const text = String(value || "");
    return text.length > width ? text.slice(0, width) : text;
}

function trimRuns(runs, width) {
    if (width <= 0) return [];
    const output = [];
    let remaining = width;

    for (const run of runs || []) {
        if (remaining <= 0) break;
        const text = String(run?.text || "");
        if (!text) continue;
        const chunk = text.slice(0, remaining);
        if (!chunk) continue;
        output.push({
            ...run,
            text: chunk,
        });
        remaining -= chunk.length;
    }

    return output;
}

function normalizeLines(lines) {
    const normalized = [];
    for (const line of lines || []) {
        if (line?.kind === "markup") {
            const parsed = parseTerminalMarkupRuns(line.value || "");
            for (const parsedLine of parsed) {
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

function wrapTextLine(line, width) {
    const text = String(line?.text || "");
    if (!text) {
        return [{
            kind: "text",
            ...line,
            text: "",
        }];
    }

    const slices = computeWrappedSlices(text, width);
    const wrapped = [];
    for (const slice of slices) {
        wrapped.push({
            kind: "text",
            ...line,
            text: text.slice(slice.start, slice.end),
        });
    }
    return wrapped;
}

function findWhitespaceWrapPoint(text, start, maxEnd) {
    if (maxEnd >= text.length && maxEnd > start) return maxEnd;
    if (
        maxEnd < text.length
        && /\s/u.test(text[maxEnd] || "")
        && maxEnd > start
        && /\S/u.test(text[maxEnd - 1] || "")
    ) {
        return maxEnd;
    }

    for (let index = Math.min(maxEnd - 1, text.length - 1); index > start; index -= 1) {
        if (!/\s/u.test(text[index] || "")) continue;
        if (!/\S/u.test(text[index - 1] || "")) continue;
        return index;
    }

    return -1;
}

function computeWrappedSlices(text, width) {
    const safeText = String(text || "");
    const safeWidth = Math.max(1, Number(width) || 1);
    if (!safeText) return [{ start: 0, end: 0 }];

    const slices = [];
    let start = 0;
    while (start < safeText.length) {
        const maxEnd = Math.min(start + safeWidth, safeText.length);
        let end = maxEnd;

        if (maxEnd < safeText.length) {
            const wrapPoint = findWhitespaceWrapPoint(safeText, start, maxEnd);
            if (wrapPoint > start) {
                end = wrapPoint;
            }
        }

        if (end <= start) {
            end = maxEnd;
        }

        slices.push({ start, end });
        start = end;
        while (start < safeText.length && /\s/u.test(safeText[start] || "")) {
            start += 1;
        }
    }

    return slices.length > 0 ? slices : [{ start: 0, end: 0 }];
}

function sliceRunsByRange(runs, start, end) {
    const output = [];
    let cursor = 0;

    for (const run of runs || []) {
        const text = String(run?.text || "");
        if (!text) continue;
        const runStart = cursor;
        const runEnd = cursor + text.length;
        const overlapStart = Math.max(start, runStart);
        const overlapEnd = Math.min(end, runEnd);
        if (overlapStart < overlapEnd) {
            output.push({
                ...run,
                text: text.slice(overlapStart - runStart, overlapEnd - runStart),
            });
        }
        cursor = runEnd;
    }

    return output;
}

function wrapRunsLine(runs, width) {
    const text = (runs || []).map((run) => String(run?.text || "")).join("");
    if (!text) return [{ kind: "text", text: "" }];

    return computeWrappedSlices(text, width).map((slice) => ({
        kind: "runs",
        runs: sliceRunsByRange(runs, slice.start, slice.end),
    }));
}

function wrapNormalizedLines(lines, width) {
    const safeWidth = Math.max(1, Number(width) || 1);
    const wrapped = [];

    for (const line of lines || []) {
        if (!line) {
            wrapped.push(null);
            continue;
        }
        if (line.kind === "runs") {
            wrapped.push(...wrapRunsLine(line.runs, safeWidth));
            continue;
        }
        wrapped.push(...wrapTextLine(line, safeWidth));
    }

    return wrapped;
}

function normalizeTitleRuns(title, fallbackColor) {
    if (Array.isArray(title)) {
        return title.map((run) => ({
            text: String(run?.text || ""),
            color: run?.color || fallbackColor,
            backgroundColor: run?.backgroundColor || undefined,
            bold: Boolean(run?.bold),
            underline: Boolean(run?.underline),
        }));
    }
    return [{
        text: String(title || ""),
        color: fallbackColor,
        bold: true,
    }];
}

function titleRunLength(runs) {
    return (runs || []).reduce((sum, run) => sum + String(run?.text || "").length, 0);
}

function flattenTitleText(title) {
    if (Array.isArray(title)) {
        return title.map((run) => String(run?.text || "")).join("").trim();
    }
    return String(title || "").trim();
}

function renderInlineRuns(runs, keyPrefix = "run") {
    return runs.map((run, index) => React.createElement(Text, {
        key: `${keyPrefix}:${index}`,
        color: resolveColorToken(run.color),
        backgroundColor: resolveColorToken(run.backgroundColor),
        bold: Boolean(run.bold),
        underline: Boolean(run.underline),
        dimColor: isDimColorToken(run.color),
    }, run.text || ""));
}

function lineToRuns(line, contentWidth) {
    if (!line) return [];
    if (line.kind === "runs") {
        return trimRuns(line.runs, contentWidth);
    }
    const text = trimText(line.text || "", contentWidth);
    if (!text) return [];
    return [{
        text,
        color: line.color || undefined,
        backgroundColor: line.backgroundColor || undefined,
        bold: Boolean(line.bold),
        underline: Boolean(line.underline),
    }];
}

function flattenLineText(line, contentWidth) {
    if (!line) return "";
    if (line.kind === "runs") {
        return trimRuns(line.runs, contentWidth).map((run) => run?.text || "").join("");
    }
    return trimText(line.text || "", contentWidth);
}

function normalizeRowSelection(selectionRange, lineLength) {
    if (!selectionRange) return null;
    const safeLength = Math.max(0, Number(lineLength) || 0);
    const start = clampValue(selectionRange.start ?? 0, 0, safeLength);
    const end = Number.isFinite(selectionRange.end)
        ? clampValue(selectionRange.end, 0, safeLength)
        : safeLength;
    if (end <= start) return null;
    return { start, end };
}

function applySelectionToRuns(runs, selectionRange) {
    if (!selectionRange) return runs;
    const selectedRuns = [];
    let cursor = 0;

    for (const run of runs || []) {
        const text = String(run?.text || "");
        if (!text) continue;
        const runStart = cursor;
        const runEnd = cursor + text.length;
        const overlapStart = Math.max(runStart, selectionRange.start);
        const overlapEnd = Math.min(runEnd, selectionRange.end);

        if (overlapStart <= runStart && overlapEnd >= runEnd) {
            selectedRuns.push({
                ...run,
                color: SELECTION_FOREGROUND,
                backgroundColor: SELECTION_BACKGROUND,
            });
        } else if (overlapStart < overlapEnd) {
            const before = text.slice(0, overlapStart - runStart);
            const inside = text.slice(overlapStart - runStart, overlapEnd - runStart);
            const after = text.slice(overlapEnd - runStart);
            if (before) selectedRuns.push({ ...run, text: before });
            if (inside) {
                selectedRuns.push({
                    ...run,
                    text: inside,
                    color: SELECTION_FOREGROUND,
                    backgroundColor: SELECTION_BACKGROUND,
                });
            }
            if (after) selectedRuns.push({ ...run, text: after });
        } else {
            selectedRuns.push(run);
        }

        cursor = runEnd;
    }

    return selectedRuns;
}

function buildScrollIndicator(totalLines, contentHeight, startIndex) {
    if (totalLines <= contentHeight) return null;
    const thumbSize = Math.max(1, Math.round((contentHeight / Math.max(1, totalLines)) * contentHeight));
    const thumbTravel = Math.max(0, contentHeight - thumbSize);
    const contentTravel = Math.max(1, totalLines - contentHeight);
    const thumbStart = thumbTravel === 0
        ? 0
        : Math.round((Math.max(0, startIndex) / contentTravel) * thumbTravel);
    return {
        thumbStart,
        thumbEnd: thumbStart + thumbSize - 1,
    };
}

function renderPanelRow(line, rowKey, contentWidth, borderColor, scrollIndicator, fillColor, selectionRange, scrollRowIndex = rowKey) {
    const scrollChar = scrollIndicator
        ? (scrollRowIndex >= scrollIndicator.thumbStart && scrollRowIndex <= scrollIndicator.thumbEnd ? "█" : "░")
        : " ";
    const lineText = flattenLineText(line, contentWidth);
    const normalizedSelection = normalizeRowSelection(selectionRange, lineText.length);
    const selectedRuns = applySelectionToRuns(lineToRuns(line, contentWidth), normalizedSelection);

    return React.createElement(Box, { key: `row:${rowKey}`, flexDirection: "row" },
        React.createElement(Text, { color: resolveColorToken(borderColor) }, "│ "),
        React.createElement(Box, { width: contentWidth, backgroundColor: resolveColorToken(fillColor) },
            !line
                ? React.createElement(Text, null, " ".repeat(contentWidth))
                : selectedRuns.length > 0
                    ? renderInlineRuns(selectedRuns, `inline:${rowKey}`)
                    : React.createElement(Text, null, "")),
        React.createElement(Text, { color: scrollIndicator ? resolveColorToken("gray") : undefined, dimColor: Boolean(scrollIndicator) }, scrollChar),
        React.createElement(Text, { color: resolveColorToken(borderColor) }, "│"));
}

function renderBorderTop(title, color, width) {
    const safeWidth = Math.max(8, Number(width) || 40);
    const safeTitleRuns = trimRuns(normalizeTitleRuns(title, color), Math.max(1, safeWidth - 6));
    const fill = Math.max(0, safeWidth - titleRunLength(safeTitleRuns) - 5);

    return React.createElement(Box, null,
        React.createElement(Text, { color: resolveColorToken(color) }, "╭─ "),
        renderInlineRuns(safeTitleRuns, "title"),
        React.createElement(Text, { color: resolveColorToken(color) }, ` ${"─".repeat(fill)}╮`));
}

function renderBorderBottom(color, width) {
    const safeWidth = Math.max(8, Number(width) || 40);
    return React.createElement(Text, { color: resolveColorToken(color) }, `╰${"─".repeat(Math.max(0, safeWidth - 2))}╯`);
}

function compareSelectionPoints(left, right) {
    if ((left?.row ?? 0) !== (right?.row ?? 0)) {
        return (left?.row ?? 0) - (right?.row ?? 0);
    }
    return (left?.col ?? 0) - (right?.col ?? 0);
}

function normalizeSelectionEndpoints(anchor, head) {
    if (!anchor || !head) return null;
    return compareSelectionPoints(anchor, head) <= 0
        ? { start: anchor, end: head }
        : { start: head, end: anchor };
}

function getSelectionRangeForPaneRow(paneId, rowIndex) {
    const selection = tuiPlatformRuntime.selection;
    if (!selection?.moved || selection.paneId !== paneId) return null;
    const ordered = normalizeSelectionEndpoints(selection.anchor, selection.head);
    if (!ordered) return null;
    if (rowIndex < ordered.start.row || rowIndex > ordered.end.row) return null;
    if (ordered.start.row === ordered.end.row) {
        return {
            start: Math.min(ordered.start.col, ordered.end.col),
            end: Math.max(ordered.start.col, ordered.end.col) + 1,
        };
    }
    if (rowIndex === ordered.start.row) {
        return { start: ordered.start.col, end: Number.POSITIVE_INFINITY };
    }
    if (rowIndex === ordered.end.row) {
        return { start: 0, end: ordered.end.col + 1 };
    }
    return { start: 0, end: Number.POSITIVE_INFINITY };
}

function normalizePaneFrame(frame, width, height) {
    if (!frame) return null;
    return {
        x: Math.max(0, Number(frame.x) || 0),
        y: Math.max(0, Number(frame.y) || 0),
        width: Math.max(8, Number(frame.width) || width || 8),
        height: Math.max(4, Number(frame.height) || height || 4),
    };
}

function getPaneInnerBounds(pane) {
    const frame = pane?.frame;
    if (!frame) return null;
    const width = Math.max(1, Number(pane?.contentWidth) || Math.max(1, frame.width - 4));
    const height = Math.max(1, Number(pane?.contentHeight) || Math.max(1, frame.height - 2));
    return {
        left: frame.x + 2,
        right: frame.x + 1 + width,
        top: frame.y + 1,
        bottom: frame.y + height,
        width,
        height,
    };
}

function registerSelectablePaneSnapshot(snapshot) {
    if (!snapshot?.paneId) return;
    tuiPlatformRuntime.paneRegistry.set(snapshot.paneId, snapshot);
}

function requestTuiRender() {
    try {
        tuiPlatformRuntime.renderInvalidator?.();
    } catch {}
}

function findPaneHit(x, y) {
    const panes = Array.from(tuiPlatformRuntime.paneRegistry.values()).reverse();
    for (const pane of panes) {
        const bounds = getPaneInnerBounds(pane);
        if (!bounds) continue;
        if (x < bounds.left || x > bounds.right || y < bounds.top || y > bounds.bottom) continue;
        return {
            pane,
            point: {
                row: clampValue(y - bounds.top, 0, Math.max(0, bounds.height - 1)),
                col: clampValue(x - bounds.left, 0, Math.max(0, bounds.width - 1)),
            },
        };
    }
    return null;
}

function projectPointIntoPane(pane, x, y) {
    const bounds = getPaneInnerBounds(pane);
    if (!bounds) return null;
    return {
        row: clampValue(y - bounds.top, 0, Math.max(0, bounds.height - 1)),
        col: clampValue(x - bounds.left, 0, Math.max(0, bounds.width - 1)),
    };
}

function normalizeExtractedSelectionText(lines) {
    const normalized = [...(lines || [])];
    while (normalized.length > 0 && !normalized[normalized.length - 1]) {
        normalized.pop();
    }
    return normalized.join("\n");
}

function extractSelectionTextFromPane(pane, anchor, head) {
    const ordered = normalizeSelectionEndpoints(anchor, head);
    if (!ordered) return "";
    const visibleLines = Array.isArray(pane?.visibleLines) ? pane.visibleLines : [];
    const contentWidth = Math.max(1, Number(pane?.contentWidth) || 1);
    const output = [];

    for (let rowIndex = ordered.start.row; rowIndex <= ordered.end.row; rowIndex += 1) {
        const lineText = flattenLineText(visibleLines[rowIndex], contentWidth);
        let start = 0;
        let end = lineText.length;
        if (rowIndex === ordered.start.row) start = clampValue(ordered.start.col, 0, lineText.length);
        if (rowIndex === ordered.end.row) end = clampValue(ordered.end.col + 1, 0, lineText.length);
        output.push(lineText.slice(start, end).replace(/\s+$/u, ""));
    }

    return normalizeExtractedSelectionText(output);
}

function copyTextToClipboard(text) {
    if (!text) {
        return { ok: false, error: "Selection is empty." };
    }
    const commands = process.platform === "darwin"
        ? [["pbcopy", []]]
        : process.platform === "win32"
            ? [["clip", []]]
            : process.env.WAYLAND_DISPLAY
                ? [["wl-copy", []], ["xclip", ["-selection", "clipboard"]], ["xsel", ["--clipboard", "--input"]]]
                : [["xclip", ["-selection", "clipboard"]], ["xsel", ["--clipboard", "--input"]], ["wl-copy", []]];

    let lastError = null;
    for (const [command, args] of commands) {
        try {
            const result = spawnSync(command, args, {
                input: text,
                encoding: "utf8",
                stdio: ["pipe", "ignore", "pipe"],
            });
            if (result.status === 0) return { ok: true };
            lastError = result.stderr?.trim?.() || `${command} exited with status ${result.status}`;
        } catch (error) {
            lastError = error?.message || String(error);
        }
    }

    return { ok: false, error: lastError || "No clipboard command succeeded." };
}

function linesToElements(lines) {
    return normalizeLines(lines).map((line, index) => {
        if (line.kind === "runs") {
            return React.createElement(Box, { key: `line:${index}` }, renderInlineRuns(line.runs, `inline:${index}`));
        }
        return React.createElement(Text, {
            key: `text:${index}`,
            color: resolveColorToken(line.color),
            backgroundColor: resolveColorToken(line.backgroundColor),
            bold: Boolean(line.bold),
            dimColor: isDimColorToken(line.color),
        }, line.text || "");
    });
}

function Root({ children }) {
    return React.createElement(Box, {
        flexDirection: "column",
        height: process.stdout.rows || 40,
        width: process.stdout.columns || 120,
        backgroundColor: resolveColorToken("background"),
    }, children);
}

function Row({ children, ...props }) {
    return React.createElement(Box, { flexDirection: "row", ...props }, children);
}

function Column({ children, ...props }) {
    return React.createElement(Box, { flexDirection: "column", ...props }, children);
}

function Header({ title, subtitle }) {
    return React.createElement(Box, {
        borderStyle: "round",
        borderColor: resolveColorToken("cyan"),
        paddingX: 1,
        marginBottom: 1,
        justifyContent: "space-between",
    },
    React.createElement(Text, { bold: true, color: resolveColorToken("cyan") }, title),
    React.createElement(Text, { color: resolveColorToken("gray"), dimColor: true }, subtitle || ""));
}

function Panel({
    title,
    color = "white",
    focused = false,
    width,
    height,
    minHeight,
    flexGrow = 0,
    flexBasis,
    marginRight = 0,
    marginBottom = 0,
    children,
    lines,
    stickyLines,
    scrollOffset = 0,
    scrollMode = "top",
    fillColor,
    paneId,
    paneLabel,
    frame,
}) {
    const safeWidth = Math.max(8, Number(width) || 40);
    const safeHeight = Math.max(4, Number(height) || 8);
    const borderColor = focused ? "red" : color;
    const contentWidth = Math.max(1, safeWidth - 4);
    const contentHeight = Math.max(1, safeHeight - 2);
    const wrappedStickyLines = wrapNormalizedLines(normalizeLines(stickyLines), contentWidth);
    const visibleStickyLines = wrappedStickyLines.slice(0, contentHeight);
    const scrollableHeight = Math.max(0, contentHeight - visibleStickyLines.length);
    const wrappedLines = wrapNormalizedLines(normalizeLines(lines), contentWidth);
    const maxOffset = Math.max(0, wrappedLines.length - scrollableHeight);
    const clampedOffset = Math.max(0, Math.min(scrollOffset, maxOffset));
    const startIndex = scrollableHeight <= 0
        ? 0
        : scrollMode === "bottom"
            ? Math.max(0, wrappedLines.length - scrollableHeight - clampedOffset)
            : clampedOffset;
    const normalizedLines = scrollableHeight > 0
        ? wrappedLines.slice(startIndex, startIndex + scrollableHeight)
        : [];
    const scrollIndicator = scrollableHeight > 0
        ? buildScrollIndicator(wrappedLines.length, scrollableHeight, startIndex)
        : null;

    while (normalizedLines.length + visibleStickyLines.length < contentHeight) {
        normalizedLines.push(null);
    }

    const visibleLines = [...visibleStickyLines, ...normalizedLines];
    if (paneId && lines) {
        registerSelectablePaneSnapshot({
            paneId,
            paneLabel: paneLabel || flattenTitleText(title) || paneId,
            frame: normalizePaneFrame(frame, safeWidth, safeHeight),
            contentWidth,
            contentHeight,
            visibleLines,
        });
    }

    return React.createElement(Box, {
        flexDirection: "column",
        marginRight,
        marginBottom,
        width: safeWidth,
        height: safeHeight,
        minHeight,
        flexGrow,
        flexBasis,
    },
    renderBorderTop(title, borderColor, safeWidth),
    lines
        ? React.createElement(Box, { flexDirection: "column", flexGrow: 1, backgroundColor: fillColor || undefined },
            [
                ...visibleStickyLines.map((line, index) => renderPanelRow(
                    line,
                    `sticky:${index}`,
                    contentWidth,
                    borderColor,
                    null,
                    fillColor,
                    getSelectionRangeForPaneRow(paneId, index),
                )),
                ...normalizedLines.map((line, index) => renderPanelRow(
                    line,
                    `body:${index}`,
                    contentWidth,
                    borderColor,
                    scrollIndicator,
                    fillColor,
                    getSelectionRangeForPaneRow(paneId, visibleStickyLines.length + index),
                    index,
                )),
            ])
        : React.createElement(Box, {
            flexDirection: "column",
            borderStyle: "round",
            borderColor: resolveColorToken(borderColor),
            paddingX: 1,
            flexGrow: 1,
            backgroundColor: resolveColorToken(fillColor),
        }, children),
    renderBorderBottom(borderColor, safeWidth));
}

function Lines({ lines }) {
    return React.createElement(Box, { flexDirection: "column" }, linesToElements(lines));
}

function clampPromptCursorIndex(value, cursorIndex) {
    return clampValue(Number(cursorIndex) || 0, 0, String(value || "").length);
}

function getPromptCursorPosition(value, cursorIndex) {
    const safeValue = String(value || "");
    const prefix = safeValue.slice(0, clampPromptCursorIndex(safeValue, cursorIndex));
    const lines = prefix.split("\n");
    return {
        line: Math.max(0, lines.length - 1),
        column: (lines[lines.length - 1] || "").length,
    };
}

function getPromptVisibleWindow(lines, rows, cursorLine, focused) {
    const safeLines = Array.isArray(lines) ? lines : [""];
    const safeRows = clampValue(Number(rows) || 1, 1, MAX_PROMPT_INPUT_ROWS);
    const anchorLine = focused
        ? clampValue(Number(cursorLine) || 0, 0, Math.max(0, safeLines.length - 1))
        : Math.max(0, safeLines.length - 1);
    const maxStart = Math.max(0, safeLines.length - safeRows);
    const start = clampValue(anchorLine - safeRows + 1, 0, maxStart);
    return {
        start,
        lines: safeLines.slice(start, start + safeRows),
    };
}

function renderPromptRow(lineText, cursorColumn, { color, showCursor, keyPrefix, prefix = null, dimColor = false }) {
    const safeText = String(lineText || "");
    const safeCursorColumn = Math.max(0, Math.min(Number(cursorColumn) || 0, safeText.length));
    const before = safeText.slice(0, safeCursorColumn);
    const cursorChar = showCursor && safeCursorColumn < safeText.length
        ? safeText[safeCursorColumn]
        : "";
    const after = showCursor && safeCursorColumn < safeText.length
        ? safeText.slice(safeCursorColumn + 1)
        : safeText.slice(safeCursorColumn);

    return React.createElement(Box, { key: keyPrefix, flexDirection: "row" },
        prefix,
        before ? React.createElement(Text, { color, dimColor }, before) : null,
        showCursor
            ? cursorChar
                ? React.createElement(Text, {
                    color: resolveColorToken("promptCursorForeground"),
                    backgroundColor: resolveColorToken("promptCursorBackground"),
                    dimColor,
                }, cursorChar)
                : React.createElement(Text, { color: resolveColorToken("promptCursorBackground") }, "█")
            : null,
        after ? React.createElement(Text, { color, dimColor }, after) : null,
    );
}

function Input({ label, value, focused, placeholder, rows = 1, cursorIndex = 0 }) {
    const safeValue = String(value || "");
    const isEmpty = safeValue.length === 0;
    const safeRows = clampValue(Number(rows) || 1, 1, MAX_PROMPT_INPUT_ROWS);
    const labelPrefix = React.createElement(Text, {
        color: resolveColorToken(focused ? "red" : "green"),
        bold: true,
    }, `${label}: `);
    const cursorPosition = getPromptCursorPosition(safeValue, cursorIndex);
    const promptLines = safeValue.split("\n");
    const visibleWindow = getPromptVisibleWindow(promptLines, safeRows, cursorPosition.line, focused);
    const displayLines = visibleWindow.lines;
    const visibleCursorLine = cursorPosition.line - visibleWindow.start;

    while (displayLines.length < safeRows) {
        displayLines.push("");
    }

    return React.createElement(Box, {
        borderStyle: "round",
        borderColor: focused ? "red" : "green",
        paddingX: 1,
        marginTop: 0,
        height: safeRows + 2,
    },
    React.createElement(Box, { flexDirection: "column" },
        isEmpty
            ? [
                renderPromptRow(placeholder || "Type a message and press Enter", focused ? 0 : null, {
                    color: resolveColorToken("gray"),
                    dimColor: true,
                    showCursor: Boolean(focused),
                    keyPrefix: "prompt-line:0",
                    prefix: labelPrefix,
                }),
                ...Array.from({ length: Math.max(0, safeRows - 1) }, (_, index) => React.createElement(Box, {
                    key: `prompt-empty:${index}`,
                    flexDirection: "row",
                }, React.createElement(Text, null, ""))),
            ]
            : displayLines.map((line, index) => renderPromptRow(line, focused && visibleCursorLine === index ? cursorPosition.column : null, {
                color: resolveColorToken("white"),
                showCursor: Boolean(focused && visibleCursorLine === index),
                keyPrefix: `prompt-line:${index}`,
                prefix: index === 0 ? labelPrefix : null,
            })),
    ));
}

function StatusLine({ left, right }) {
    return React.createElement(Box, {
        borderStyle: "round",
        borderColor: resolveColorToken("gray"),
        paddingX: 1,
        justifyContent: "space-between",
    },
    React.createElement(Text, { color: resolveColorToken("white") }, left || ""),
    React.createElement(Text, { color: resolveColorToken("gray"), dimColor: true }, right || ""));
}

function Overlay({ children }) {
    const viewportWidth = process.stdout.columns || 120;
    const viewportHeight = process.stdout.rows || 40;

    return React.createElement(Box, {
        position: "absolute",
        top: 1,
        left: 0,
        width: viewportWidth,
        height: viewportHeight,
        alignItems: "center",
        justifyContent: "center",
        flexDirection: "column",
    }, children);
}

export function createTuiPlatform() {
    tuiPlatformRuntime.paneRegistry.clear();
    tuiPlatformRuntime.selection = createEmptySelection();
    tuiPlatformRuntime.renderInvalidator = null;
    tuiPlatformRuntime.themeId = DEFAULT_THEME_ID;

    return {
        Root,
        Row,
        Column,
        Header,
        Panel,
        Overlay,
        Lines,
        Input,
        StatusLine,
        setTheme(themeId) {
            const nextTheme = getTheme(themeId) || getTheme(DEFAULT_THEME_ID);
            if (!nextTheme || nextTheme.id === tuiPlatformRuntime.themeId) return;
            tuiPlatformRuntime.themeId = nextTheme.id;
            requestTuiRender();
        },
        setRenderInvalidator(fn) {
            tuiPlatformRuntime.renderInvalidator = typeof fn === "function" ? fn : null;
        },
        clearSelectablePanes() {
            tuiPlatformRuntime.paneRegistry.clear();
        },
        beginPointerSelection(x, y) {
            const hit = findPaneHit(x, y);
            if (!hit) {
                tuiPlatformRuntime.selection = createEmptySelection();
                requestTuiRender();
                return false;
            }
            tuiPlatformRuntime.selection = {
                paneId: hit.pane.paneId,
                anchor: hit.point,
                head: hit.point,
                dragging: true,
                moved: false,
            };
            requestTuiRender();
            return true;
        },
        updatePointerSelection(x, y) {
            const current = tuiPlatformRuntime.selection;
            if (!current?.dragging || !current.paneId) return false;
            const pane = tuiPlatformRuntime.paneRegistry.get(current.paneId);
            if (!pane) return false;
            const head = projectPointIntoPane(pane, x, y);
            if (!head) return false;
            tuiPlatformRuntime.selection = {
                ...current,
                head,
                moved: Boolean(head.row !== current.anchor?.row || head.col !== current.anchor?.col),
            };
            requestTuiRender();
            return true;
        },
        clearPointerSelection() {
            if (!tuiPlatformRuntime.selection?.paneId && !tuiPlatformRuntime.selection?.dragging) return;
            tuiPlatformRuntime.selection = createEmptySelection();
            requestTuiRender();
        },
        finalizePointerSelection({ copy = true } = {}) {
            const current = tuiPlatformRuntime.selection;
            const pane = current?.paneId ? tuiPlatformRuntime.paneRegistry.get(current.paneId) : null;
            tuiPlatformRuntime.selection = createEmptySelection();
            requestTuiRender();
            if (!current?.dragging || !current?.moved || !pane) {
                return { attempted: false, copied: false };
            }
            const text = extractSelectionTextFromPane(pane, current.anchor, current.head);
            if (!text) {
                return { attempted: false, copied: false, paneLabel: pane.paneLabel || pane.paneId || "pane" };
            }
            if (!copy) {
                return { attempted: true, copied: false, text, paneLabel: pane.paneLabel || pane.paneId || "pane" };
            }
            const result = copyTextToClipboard(text);
            return {
                attempted: true,
                copied: result.ok,
                text,
                paneLabel: pane.paneLabel || pane.paneId || "pane",
                error: result.ok ? null : result.error,
            };
        },
        getViewport: () => ({
            width: process.stdout.columns || 120,
            height: process.stdout.rows || 40,
        }),
    };
}

export const __testing = {
    computeWrappedSlices,
    wrapTextLine,
    wrapRunsLine,
};
