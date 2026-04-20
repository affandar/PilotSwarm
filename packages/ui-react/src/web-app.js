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
    selectConfirmModal,
} from "pilotswarm-ui-core";
import { useControllerSelector } from "./use-controller-state.js";

const MOBILE_BREAKPOINT = 920;
const GRID_CELL_WIDTH = 7;
const GRID_CELL_HEIGHT = 19;
const SCROLL_ROW_HEIGHT = 16;
const THEME_STORAGE_KEY = "pilotswarm.theme";
const THEME_COOKIE_NAME = "pilotswarm_theme";
const CHAT_FOCUS_MODE_STORAGE_KEY = "pilotswarm.chatFocus";
const INSPECTOR_TAB_LABELS = {
    sequence: "Sequence",
    logs: "Logs",
    nodes: "Node Map",
    history: "History",
    files: "Files",
    stats: "Stats",
};

function cycleTabs(tabs, current, delta) {
    const values = Array.isArray(tabs) ? tabs.filter(Boolean) : [];
    if (values.length === 0) return current;
    const index = values.indexOf(current);
    const safeIndex = index === -1 ? 0 : index;
    const nextIndex = (safeIndex + delta + values.length) % values.length;
    return values[nextIndex];
}

function supportsBrowserFileUploads(controller) {
    return typeof controller?.transport?.uploadArtifactFromFile === "function";
}

function supportsPathArtifactUploads(controller) {
    return typeof controller?.transport?.uploadArtifactFromPath === "function";
}

function supportsArtifactBrowser(controller) {
    return typeof controller?.transport?.listArtifacts === "function";
}

function supportsLocalFileOpen(controller) {
    return typeof controller?.transport?.openPathInDefaultApp === "function";
}

function readStoredChatFocusMode() {
    if (typeof window === "undefined") return false;
    try {
        return window.localStorage.getItem(CHAT_FOCUS_MODE_STORAGE_KEY) === "1";
    } catch {
        return false;
    }
}

function writeStoredChatFocusMode(enabled) {
    if (typeof window === "undefined") return;
    try {
        window.localStorage.setItem(CHAT_FOCUS_MODE_STORAGE_KEY, enabled ? "1" : "0");
    } catch {
        // Ignore localStorage failures in private or constrained environments.
    }
}

function getVisibleInspectorTabs(controller) {
    return supportsArtifactBrowser(controller)
        ? INSPECTOR_TABS
        : INSPECTOR_TABS.filter((tab) => tab !== "files");
}

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

function getStatePromptRows(state) {
    const promptRows = Number(state?.ui?.promptRows);
    return Number.isFinite(promptRows) && promptRows > 0
        ? promptRows
        : getPromptInputRows(state?.ui?.prompt || "");
}

function computeStateLayout(state) {
    return computeLegacyLayout({
        width: state.ui.layout?.viewportWidth ?? 120,
        height: state.ui.layout?.viewportHeight ?? 40,
    }, state.ui.layout?.paneAdjust ?? 0, getStatePromptRows(state), state.ui.layout?.sessionPaneAdjust ?? 0);
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
        const cookieMatch = document.cookie.match(new RegExp(`(?:^|; )${THEME_COOKIE_NAME}=([^;]+)`));
        if (cookieMatch?.[1]) {
            return decodeURIComponent(cookieMatch[1]);
        }
    } catch {}
    try {
        return window.localStorage.getItem(THEME_STORAGE_KEY);
    } catch {
        return null;
    }
}

function writeStoredThemeId(themeId) {
    try {
        document.cookie = `${THEME_COOKIE_NAME}=${encodeURIComponent(themeId)}; Path=/; Max-Age=31536000; SameSite=Lax`;
    } catch {}
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
    // Programmatic scrollTop assignments fire a 'scroll' event that would
    // otherwise call onScroll → dispatch ui/scroll → clobber the user's
    // offset (especially when content briefly shrinks during a refresh
    // and clamps nextScrollTop downward). The flag tells onScroll to
    // ignore the next scroll event after we set scrollTop ourselves.
    const programmaticScrollRef = React.useRef(false);

    React.useLayoutEffect(() => {
        const node = ref.current;
        if (!node) return;
        const maxScroll = Math.max(0, node.scrollHeight - node.clientHeight);
        const offsetPixels = Math.max(0, Number(scrollOffset) || 0) * SCROLL_ROW_HEIGHT;
        const nextScrollTop = scrollMode === "bottom"
            ? Math.max(0, maxScroll - offsetPixels)
            : Math.min(maxScroll, offsetPixels);
        if (Math.abs(node.scrollTop - nextScrollTop) > 2) {
            programmaticScrollRef.current = true;
            node.scrollTop = nextScrollTop;
            // Clear on the next frame — the scroll event from the assignment
            // above is queued synchronously and handled in the same task.
            window.requestAnimationFrame(() => {
                programmaticScrollRef.current = false;
            });
        }
    }, [normalizedLines, ref, scrollMode, scrollOffset]);

    const onScroll = React.useCallback(() => {
        if (programmaticScrollRef.current) return;
        const node = ref.current;
        if (!node || !paneKey) return;
        const maxScroll = Math.max(0, node.scrollHeight - node.clientHeight);
        // When the pane has no scrollable content (transient loading state
        // that briefly collapses the body to one line), the browser auto-
        // clamps scrollTop to 0 and fires a scroll event we did NOT trigger.
        // Writing that into state would clobber the user's saved offset.
        // Skip the dispatch — next render with real content will restore
        // the desired scroll position from preserved state.
        if (maxScroll <= 0) return;
        const pixels = scrollMode === "bottom"
            ? Math.max(0, maxScroll - node.scrollTop)
            : Math.max(0, node.scrollTop);
        controller.dispatch({
            type: "ui/scroll",
            pane: paneKey,
            offset: pixels / SCROLL_ROW_HEIGHT,
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

function SystemNoticeLine({ line, theme }) {
    const body = String(line?.body || "").trim();
    return React.createElement("details", { className: "ps-system-notice" },
        React.createElement("summary", {
            className: "ps-system-notice-summary",
            style: { color: resolveColor(theme, line?.color) || "var(--ps-muted)" },
        },
        React.createElement("span", { className: "ps-system-notice-summary-text" }, line?.text || "System notice")),
        body
            ? React.createElement("div", { className: "ps-system-notice-body" },
                React.createElement(MarkdownPreviewContent, { content: body, theme }))
            : null);
}

function Line({ line, theme, className = "" }) {
    const lineClassName = className ? `ps-line ${className}` : "ps-line";
    if (!line) {
        return React.createElement("div", { className: lineClassName }, " ");
    }
    if (line.kind === "systemNotice") {
        return React.createElement(SystemNoticeLine, { line, theme });
    }
    if (line.kind === "runs") {
        return React.createElement("div", { className: lineClassName },
            React.createElement(Runs, { runs: line.runs, theme }));
    }
    return React.createElement("div", {
        className: lineClassName,
        style: {
            color: resolveColor(theme, line.color),
            backgroundColor: resolveColor(theme, line.backgroundColor),
            fontWeight: line.bold ? 700 : 400,
            textDecoration: line.underline ? "underline" : "none",
        },
    }, line.text || " ");
}

function lineText(line) {
    if (!line) return "";
    if (line.kind === "runs") return runsToText(line.runs);
    return String(line.text || "");
}

function usePanePixelScroll(ref, scrollOffset, paneKey, controller) {
    // See useScrollSync for rationale on the programmatic-scroll guard.
    const programmaticScrollRef = React.useRef(false);

    React.useLayoutEffect(() => {
        const node = ref.current;
        if (!node) return;
        const maxScroll = Math.max(0, node.scrollHeight - node.clientHeight);
        const nextScrollTop = Math.min(maxScroll, Math.max(0, Number(scrollOffset) || 0) * SCROLL_ROW_HEIGHT);
        if (Math.abs(node.scrollTop - nextScrollTop) > 2) {
            programmaticScrollRef.current = true;
            node.scrollTop = nextScrollTop;
            window.requestAnimationFrame(() => {
                programmaticScrollRef.current = false;
            });
        }
    }, [ref, scrollOffset]);

    return React.useCallback(() => {
        if (programmaticScrollRef.current) return;
        const node = ref.current;
        if (!node || !paneKey) return;
        // See useScrollSync — ignore browser auto-clamp during a
        // transient empty/loading body.
        if (node.scrollHeight <= node.clientHeight) return;
        controller.dispatch({
            type: "ui/scroll",
            pane: paneKey,
            offset: Math.max(0, node.scrollTop) / SCROLL_ROW_HEIGHT,
        });
    }, [controller, paneKey, ref]);
}

function tokenizeInlineMarkdown(source = "") {
    const tokens = [];
    const text = String(source || "");
    const pattern = /(`[^`]+`)|(\[([^\]]+)\]\(([^)]+)\))|(\*\*([^*]+)\*\*)|(__(.+?)__)|(\*([^*]+)\*)|(_([^_]+)_)/g;
    let lastIndex = 0;
    let match;
    while ((match = pattern.exec(text)) !== null) {
        if (match.index > lastIndex) {
            tokens.push({ type: "text", text: text.slice(lastIndex, match.index) });
        }
        if (match[1]) {
            tokens.push({ type: "code", text: match[1].slice(1, -1) });
        } else if (match[2]) {
            tokens.push({ type: "link", text: match[3], href: match[4] });
        } else if (match[5]) {
            tokens.push({ type: "strong", text: match[6] });
        } else if (match[7]) {
            tokens.push({ type: "strong", text: match[8] });
        } else if (match[9]) {
            tokens.push({ type: "em", text: match[10] });
        } else if (match[11]) {
            tokens.push({ type: "em", text: match[12] });
        }
        lastIndex = pattern.lastIndex;
    }
    if (lastIndex < text.length) {
        tokens.push({ type: "text", text: text.slice(lastIndex) });
    }
    return tokens;
}

function renderInlineMarkdown(source, theme, keyPrefix = "md") {
    return tokenizeInlineMarkdown(source).map((token, index) => {
        const key = `${keyPrefix}:${index}`;
        if (token.type === "code") {
            return React.createElement("code", { key, className: "ps-md-inline-code" }, token.text);
        }
        if (token.type === "strong") {
            return React.createElement("strong", { key, className: "ps-md-strong" }, renderInlineMarkdown(token.text, theme, `${key}:strong`));
        }
        if (token.type === "em") {
            return React.createElement("em", { key, className: "ps-md-em" }, renderInlineMarkdown(token.text, theme, `${key}:em`));
        }
        if (token.type === "link") {
            return React.createElement("a", {
                key,
                className: "ps-md-link",
                href: token.href,
                target: "_blank",
                rel: "noreferrer",
                style: { color: resolveColor(theme, "cyan") },
            }, token.text);
        }
        return React.createElement(React.Fragment, { key }, token.text);
    });
}

function normalizeTableCellText(value = "") {
    return String(value || "")
        .replace(/\s+/g, " ")
        .trim();
}

function computeFitWidthColumnPercentages(rows = []) {
    const columnCount = Math.max(0, ...rows.map((row) => row.length));
    if (columnCount <= 0) return null;

    const maxLengths = Array.from({ length: columnCount }, () => 0);
    for (const row of rows) {
        for (let index = 0; index < columnCount; index += 1) {
            const cellText = normalizeTableCellText(row[index] || "");
            maxLengths[index] = Math.max(maxLengths[index], cellText.length);
        }
    }

    const weights = maxLengths.map((length) => {
        const normalizedLength = Math.max(6, Math.min(196, length || 0));
        return Math.sqrt(normalizedLength);
    });
    const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
    if (!(totalWeight > 0)) return null;

    return weights.map((weight) => `${((weight / totalWeight) * 100).toFixed(2)}%`);
}

function isMarkdownSpecialLine(line = "", nextLine = "") {
    const value = String(line || "");
    return /^\s*#{1,6}\s+/.test(value)
        || /^\s*>/.test(value)
        || /^\s*([-*]|\d+\.)\s+/.test(value)
        || /^\s*```/.test(value)
        || (value.includes("|") && /^\s*\|?[\s:-]+(?:\|[\s:-]+)+\|?\s*$/.test(String(nextLine || "")));
}

function splitMarkdownTableRow(line = "") {
    const trimmed = String(line || "").trim().replace(/^\|/, "").replace(/\|$/, "");
    return trimmed.split("|").map((cell) => cell.trim());
}

function parseMarkdownBlocks(source = "") {
    const text = String(source || "").replace(/\r\n?/g, "\n");
    const lines = text.split("\n");
    const blocks = [];

    for (let index = 0; index < lines.length;) {
        const line = lines[index];
        const trimmed = line.trim();

        if (!trimmed) {
            index += 1;
            continue;
        }

        const fenceMatch = /^```(\S*)\s*$/.exec(trimmed);
        if (fenceMatch) {
            const language = fenceMatch[1] || "";
            const codeLines = [];
            index += 1;
            while (index < lines.length && !/^```/.test(lines[index].trim())) {
                codeLines.push(lines[index]);
                index += 1;
            }
            if (index < lines.length) index += 1;
            blocks.push({ type: "code", language, content: codeLines.join("\n") });
            continue;
        }

        const headingMatch = /^(#{1,6})\s+(.*)$/.exec(line);
        if (headingMatch) {
            blocks.push({ type: "heading", level: headingMatch[1].length, text: headingMatch[2].trim() });
            index += 1;
            continue;
        }

        if (line.includes("|") && index + 1 < lines.length && /^\s*\|?[\s:-]+(?:\|[\s:-]+)+\|?\s*$/.test(lines[index + 1].trim())) {
            const header = splitMarkdownTableRow(line);
            index += 2;
            const rows = [];
            while (index < lines.length && lines[index].includes("|") && lines[index].trim()) {
                rows.push(splitMarkdownTableRow(lines[index]));
                index += 1;
            }
            blocks.push({ type: "table", header, rows });
            continue;
        }

        if (/^\s*>/.test(line)) {
            const quoteLines = [];
            while (index < lines.length && /^\s*>/.test(lines[index])) {
                quoteLines.push(lines[index].replace(/^\s*>\s?/, ""));
                index += 1;
            }
            blocks.push({ type: "blockquote", text: quoteLines.join("\n").trim() });
            continue;
        }

        const listMatch = /^(\s*)([-*]|\d+\.)\s+(.*)$/.exec(line);
        if (listMatch) {
            const ordered = /\d+\./.test(listMatch[2]);
            const items = [];
            while (index < lines.length) {
                const current = lines[index];
                const itemMatch = /^(\s*)([-*]|\d+\.)\s+(.*)$/.exec(current);
                if (!itemMatch || /\d+\./.test(itemMatch[2]) !== ordered) break;
                const itemLines = [itemMatch[3].trim()];
                index += 1;
                while (
                    index < lines.length
                    && lines[index].trim()
                    && !/^(\s*)([-*]|\d+\.)\s+/.test(lines[index])
                    && !isMarkdownSpecialLine(lines[index], lines[index + 1] || "")
                ) {
                    itemLines.push(lines[index].trim());
                    index += 1;
                }
                items.push(itemLines.join(" "));
                if (!lines[index]?.trim()) break;
            }
            blocks.push({ type: "list", ordered, items });
            continue;
        }

        const paragraphLines = [line.trim()];
        index += 1;
        while (
            index < lines.length
            && lines[index].trim()
            && !isMarkdownSpecialLine(lines[index], lines[index + 1] || "")
        ) {
            paragraphLines.push(lines[index].trim());
            index += 1;
        }
        blocks.push({ type: "paragraph", text: paragraphLines.join(" ") });
    }

    return blocks;
}

function MarkdownPreviewContent({ content, theme }) {
    const blocks = React.useMemo(() => parseMarkdownBlocks(content), [content]);
    if (blocks.length === 0) {
        return React.createElement("div", { className: "ps-empty-state" }, "No preview content.");
    }
    return React.createElement("div", { className: "ps-markdown-preview" },
        blocks.map((block, index) => {
            if (block.type === "heading") {
                return React.createElement("div", {
                    key: `block:${index}`,
                    className: `ps-md-heading is-h${block.level}`,
                }, renderInlineMarkdown(block.text, theme, `heading:${index}`));
            }
            if (block.type === "code") {
                return React.createElement("section", { key: `block:${index}`, className: "ps-md-code-block" },
                    React.createElement("div", { className: "ps-md-code-header" }, block.language || "text"),
                    React.createElement("pre", { className: "ps-md-code-pre" },
                        React.createElement("code", null, block.content)));
            }
            if (block.type === "blockquote") {
                return React.createElement("blockquote", { key: `block:${index}`, className: "ps-md-quote" },
                    renderInlineMarkdown(block.text, theme, `quote:${index}`));
            }
            if (block.type === "list") {
                const ListTag = block.ordered ? "ol" : "ul";
                return React.createElement(ListTag, {
                    key: `block:${index}`,
                    className: `ps-md-list${block.ordered ? " is-ordered" : ""}`,
                }, block.items.map((item, itemIndex) => React.createElement("li", {
                    key: `item:${itemIndex}`,
                    className: "ps-md-list-item",
                }, renderInlineMarkdown(item, theme, `list:${index}:${itemIndex}`))));
            }
            if (block.type === "table") {
                const columnCount = Math.max(block.header.length || 0, ...block.rows.map((row) => row.length));
                // Wrap cells by default. Only fall back to horizontal scroll
                // when there are so many columns that wrapping would crush
                // every cell (>6 columns is the practical readability cliff
                // on phones).
                const fitToWidth = columnCount > 0 && columnCount <= 6;
                const columnWidths = fitToWidth
                    ? computeFitWidthColumnPercentages([block.header, ...block.rows])
                    : null;
                return React.createElement("div", {
                    key: `block:${index}`,
                    className: `ps-md-table-wrap${fitToWidth ? " is-fit-width" : ""}`,
                },
                    React.createElement("table", {
                        className: `ps-md-table${fitToWidth ? " is-fit-width" : ""}`,
                    },
                        columnWidths
                            ? React.createElement("colgroup", null,
                                columnWidths.map((width, columnIndex) => React.createElement("col", {
                                    key: `col:${columnIndex}`,
                                    style: width ? { width } : undefined,
                                })))
                            : null,
                        React.createElement("thead", null,
                            React.createElement("tr", null,
                                block.header.map((cell, cellIndex) => React.createElement("th", { key: `head:${cellIndex}` },
                                    renderInlineMarkdown(cell, theme, `table:${index}:head:${cellIndex}`))))),
                        React.createElement("tbody", null,
                            block.rows.map((row, rowIndex) => React.createElement("tr", { key: `row:${rowIndex}` },
                                row.map((cell, cellIndex) => React.createElement("td", { key: `cell:${rowIndex}:${cellIndex}` },
                                    renderInlineMarkdown(cell, theme, `table:${index}:${rowIndex}:${cellIndex}`))))))));
            }
            return React.createElement("p", { key: `block:${index}`, className: "ps-md-paragraph" },
                renderInlineMarkdown(block.text, theme, `para:${index}`));
        }));
}

function MarkdownPreviewPanel({ controller, title, color, focused, scrollOffset = 0, paneKey, theme, content }) {
    const ref = React.useRef(null);
    const onScroll = usePanePixelScroll(ref, scrollOffset, paneKey, controller);

    return React.createElement(Panel, { title, color, focused, theme },
        React.createElement("div", {
            ref,
            className: "ps-scroll-panel ps-markdown-scroll",
            onScroll,
        }, React.createElement(MarkdownPreviewContent, { content, theme })));
}

function isBoxTopLine(text) {
    const value = String(text || "").trim();
    return value.startsWith("┌") && value.endsWith("┐");
}

function isBoxBottomLine(text) {
    const value = String(text || "").trim();
    return value.startsWith("└") && value.endsWith("┘");
}

function isBoxDividerLine(text) {
    const value = String(text || "").trim();
    return value.startsWith("├") && value.endsWith("┤");
}

function isBoxContentLine(text) {
    const value = String(text || "").trim();
    return value.startsWith("│") && value.endsWith("│");
}

function extractCodeFenceLanguage(line) {
    const value = String(lineText(line) || "").trim();
    if (!isBoxTopLine(value)) return "";
    return value
        .slice(1, -1)
        .replace(/^─+/u, "")
        .replace(/─+$/u, "")
        .trim();
}

function extractCodeFenceLine(line) {
    if (line?.kind === "runs" && Array.isArray(line.runs) && line.runs.length >= 3) {
        return String(line.runs[1]?.text || "").replace(/\s+$/u, "");
    }
    const value = lineText(line);
    if (!isBoxContentLine(value)) return String(value || "");
    return String(value)
        .slice(1, -1)
        .replace(/\s+$/u, "");
}

function trimRunsEdgeWhitespace(runs = []) {
    const nextRuns = (runs || []).map((run) => ({ ...run }));
    if (nextRuns.length === 0) return nextRuns;
    nextRuns[0].text = String(nextRuns[0].text || "").replace(/^\s+/, "");
    nextRuns[nextRuns.length - 1].text = String(nextRuns[nextRuns.length - 1].text || "").replace(/\s+$/, "");
    return nextRuns.filter((run, index) => String(run.text || "").length > 0 || nextRuns.length === 1 || index === 0);
}

function extractFramedRuns(line, { fallbackColor = null } = {}) {
    if (line?.kind === "runs" && Array.isArray(line.runs) && line.runs.length >= 3) {
        return trimRunsEdgeWhitespace(line.runs.slice(1, -1));
    }
    const text = lineText(line)
        .replace(/^\s*[┌│]\s?/, "")
        .replace(/\s?[┐│]\s*$/, "")
        .replace(/^─+/, "")
        .replace(/─+$/, "")
        .trim();
    return [{ text, color: fallbackColor }];
}

function splitBoxTableCells(text) {
    const value = String(text || "").trim();
    if (!isBoxContentLine(value)) return [];
    return value
        .slice(1, -1)
        .split("│")
        .map((cell) => cell.trim());
}

function mergeBoxTableRowGroup(rowGroup = []) {
    const columnCount = Math.max(0, ...rowGroup.map((row) => row.length));
    return Array.from({ length: columnCount }, (_, columnIndex) => rowGroup
        .map((row) => String(row[columnIndex] || "").trim())
        .filter(Boolean)
        .join(" "));
}

function parseStructuredChatBlocks(lines = []) {
    const blocks = [];

    for (let index = 0; index < lines.length;) {
        const currentLine = lines[index];
        const currentText = lineText(currentLine);

        if (isBoxTopLine(currentText) && currentText.includes("┬")) {
            const headerRows = [];
            const bodyRows = [];
            let currentRowGroup = [];
            let inHeader = true;
            index += 1;

            while (index < lines.length) {
                const nextLine = lines[index];
                const nextText = lineText(nextLine);
                if (isBoxBottomLine(nextText)) {
                    if (currentRowGroup.length > 0) {
                        const mergedRow = mergeBoxTableRowGroup(currentRowGroup);
                        if (mergedRow.length > 0) {
                            if (inHeader) headerRows.push(mergedRow);
                            else bodyRows.push(mergedRow);
                        }
                    }
                    index += 1;
                    break;
                }
                if (isBoxDividerLine(nextText)) {
                    if (currentRowGroup.length > 0) {
                        const mergedRow = mergeBoxTableRowGroup(currentRowGroup);
                        if (mergedRow.length > 0) {
                            if (inHeader) headerRows.push(mergedRow);
                            else bodyRows.push(mergedRow);
                        }
                    }
                    currentRowGroup = [];
                    inHeader = false;
                    index += 1;
                    continue;
                }
                if (isBoxContentLine(nextText)) {
                    const cells = splitBoxTableCells(nextText);
                    if (cells.length > 0) {
                        currentRowGroup.push(cells);
                    }
                }
                index += 1;
            }

            blocks.push({ type: "table", headerRows, bodyRows });
            continue;
        }

        if (
            currentLine?.kind === "runs"
            && Array.isArray(currentLine.runs)
            && currentLine.runs.length === 1
            && isBoxTopLine(currentText)
        ) {
            const language = extractCodeFenceLanguage(currentLine);
            const codeLines = [];
            index += 1;

            while (index < lines.length) {
                const nextLine = lines[index];
                const nextText = lineText(nextLine);
                if (isBoxBottomLine(nextText)) {
                    index += 1;
                    break;
                }
                if (isBoxContentLine(nextText)) {
                    codeLines.push(extractCodeFenceLine(nextLine));
                } else {
                    codeLines.push(lineText(nextLine));
                }
                index += 1;
            }

            if (index < lines.length && lineText(lines[index]).trim().length === 0) {
                index += 1;
            }

            blocks.push({
                type: "code",
                language: language || "text",
                content: codeLines.join("\n"),
            });
            continue;
        }

        if (
            currentLine?.kind === "runs"
            && Array.isArray(currentLine.runs)
            && currentLine.runs.length > 2
            && isBoxTopLine(currentText)
        ) {
            const headerRuns = extractFramedRuns(currentLine);
            const borderColor = currentLine.runs[0]?.color || "gray";
            const bodyLines = [];
            index += 1;

            while (index < lines.length) {
                const nextLine = lines[index];
                const nextText = lineText(nextLine);
                if (isBoxBottomLine(nextText)) {
                    index += 1;
                    break;
                }
                if (isBoxContentLine(nextText)) {
                    bodyLines.push(extractFramedRuns(nextLine));
                } else {
                    bodyLines.push(nextLine?.kind === "runs"
                        ? nextLine.runs
                        : [{ text: lineText(nextLine), color: nextLine?.color || null }]);
                }
                index += 1;
            }

            if (index < lines.length && lineText(lines[index]).trim().length === 0) {
                index += 1;
            }

            blocks.push({ type: "card", headerRuns, bodyLines, borderColor });
            continue;
        }

        blocks.push({ type: "line", line: currentLine });
        index += 1;
    }

    return blocks;
}

function StructuredChatBlocks({ lines, theme }) {
    const blocks = React.useMemo(() => parseStructuredChatBlocks(lines), [lines]);

    return React.createElement(React.Fragment, null,
        blocks.map((block, index) => {
            if (block.type === "code") {
                return React.createElement("section", { key: `code:${index}`, className: "ps-md-code-block ps-chat-code-block" },
                    React.createElement("div", { className: "ps-md-code-header" }, block.language || "text"),
                    React.createElement("pre", { className: "ps-md-code-pre" },
                        React.createElement("code", null, block.content || "")));
            }

            if (block.type === "card") {
                return React.createElement("section", {
                    key: `card:${index}`,
                    className: "ps-chat-card",
                    style: { "--ps-chat-card-accent": resolveColor(theme, block.borderColor) || "var(--ps-border)" },
                },
                React.createElement("header", { className: "ps-chat-card-header" },
                    React.createElement(Runs, { runs: block.headerRuns, theme })),
                React.createElement("div", { className: "ps-chat-card-body" },
                    (block.bodyLines || []).map((bodyRuns, bodyIndex) => React.createElement("div", {
                        key: `card:${index}:line:${bodyIndex}`,
                        className: "ps-chat-card-line",
                    }, React.createElement(Runs, { runs: bodyRuns, theme })) )));
            }

            if (block.type === "table") {
                const headerRows = block.headerRows || [];
                const bodyRows = block.bodyRows || [];
                const columnCount = Math.max(
                    1,
                    ...headerRows.map((row) => row.length),
                    ...bodyRows.map((row) => row.length),
                );
                const fitToWidth = columnCount <= 6;
                const columnWidths = fitToWidth
                    ? computeFitWidthColumnPercentages([...headerRows, ...bodyRows])
                    : null;
                return React.createElement("div", {
                    key: `table:${index}`,
                    className: `ps-chat-table-wrap${fitToWidth ? " is-fit-width" : ""}`,
                },
                    React.createElement("table", {
                        className: `ps-chat-table${fitToWidth ? " is-fit-width" : ""}`,
                    },
                        columnWidths
                            ? React.createElement("colgroup", null,
                                columnWidths.map((width, columnIndex) => React.createElement("col", {
                                    key: `col:${columnIndex}`,
                                    style: width ? { width } : undefined,
                                })))
                            : null,
                        headerRows.length > 0
                            ? React.createElement("thead", null,
                                headerRows.map((row, rowIndex) => React.createElement("tr", { key: `thead:${rowIndex}` },
                                    Array.from({ length: columnCount }, (_, cellIndex) => React.createElement("th", { key: `th:${rowIndex}:${cellIndex}` }, row[cellIndex] || "")))))
                            : null,
                        React.createElement("tbody", null,
                            bodyRows.map((row, rowIndex) => React.createElement("tr", { key: `tbody:${rowIndex}` },
                                Array.from({ length: columnCount }, (_, cellIndex) => React.createElement("td", { key: `td:${rowIndex}:${cellIndex}` }, row[cellIndex] || "")))))));
            }

            return React.createElement(Line, { key: `line:${index}`, line: block.line, theme });
        }));
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

function ScrollLinesPanel({ title, color, focused, actions, lines, stickyLines = [], scrollOffset = 0, scrollMode = "top", paneKey, controller, className = "", panelClassName = "", topContent = null, structuredBlocks = false }) {
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
            structuredBlocks
                ? React.createElement(StructuredChatBlocks, { lines: normalizedLines, theme })
                : normalizedLines.map((line, index) => React.createElement(Line, { key: `line:${index}`, line, theme })),
        ));
}

function SessionPane({ controller, actions = null, panelClassName = "" }) {
    const themeId = useControllerSelector(controller, (state) => state.ui.themeId);
    const theme = getTheme(themeId);
    const sessionButtonRefs = React.useRef(new Map());
    const viewState = useControllerSelector(controller, (state) => ({
        activeSessionId: state.sessions.activeSessionId,
        sessionsById: state.sessions.byId,
        sessionsFlat: state.sessions.flat,
        filterQuery: state.sessions.filterQuery || "",
        connectionMode: state.connection?.mode || "local",
        modalOpen: Boolean(state.ui.modal),
        focused: state.ui.focusRegion === "sessions",
    }), shallowEqualObject);
    const rows = React.useMemo(() => selectSessionRows({
        sessions: {
            activeSessionId: viewState.activeSessionId,
            byId: viewState.sessionsById,
            flat: viewState.sessionsFlat,
            filterQuery: viewState.filterQuery,
        },
        connection: {
            mode: viewState.connectionMode,
        },
    }), [viewState.activeSessionId, viewState.connectionMode, viewState.filterQuery, viewState.sessionsById, viewState.sessionsFlat]);
    const activeSession = viewState.activeSessionId
        ? viewState.sessionsById[viewState.activeSessionId] || null
        : null;
    const canRenameActiveSession = Boolean(activeSession && !activeSession.isSystem);
    const combinedPanelClassName = `ps-session-pane${panelClassName ? ` ${panelClassName}` : ""}`;
    const setSessionButtonRef = React.useCallback((sessionId, node) => {
        if (!sessionId) return;
        if (node) {
            sessionButtonRefs.current.set(sessionId, node);
        } else {
            sessionButtonRefs.current.delete(sessionId);
        }
    }, []);

    React.useEffect(() => {
        if (viewState.modalOpen || !viewState.focused || !viewState.activeSessionId) return;
        const activeButton = sessionButtonRefs.current.get(viewState.activeSessionId);
        if (!activeButton) return;

        if (document.activeElement !== activeButton) {
            activeButton.focus({ preventScroll: true });
        }
        activeButton.scrollIntoView({ block: "nearest" });
    }, [rows, viewState.activeSessionId, viewState.focused, viewState.modalOpen]);

    const panelActions = React.createElement(React.Fragment, null,
        React.createElement("button", {
            type: "button",
            className: "ps-mini-button",
            onClick: () => controller.handleCommand(UI_COMMANDS.OPEN_RENAME_SESSION).catch(() => {}),
            disabled: !canRenameActiveSession,
        }, "Rename"),
        React.createElement("button", {
            type: "button",
            className: "ps-mini-button",
            onClick: () => controller.handleCommand(UI_COMMANDS.OPEN_TERMINATE_PICKER).catch(() => {}),
            disabled: !canRenameActiveSession,
            title: "Mark Completed, Cancel, or Delete the active session",
        }, "Terminate"),
        actions);

    return React.createElement(Panel, {
        title: [{ text: "Sessions", color: "yellow", bold: true }],
        color: "yellow",
        focused: viewState.focused,
        theme,
        actions: panelActions,
        className: combinedPanelClassName,
    },
    React.createElement("div", { className: "ps-action-list ps-session-list" },
        rows.length === 0
            ? React.createElement("div", { className: "ps-empty-state" }, viewState.filterQuery
                ? `No sessions matched "@@${viewState.filterQuery}".`
                : "No sessions yet.")
            : rows.map((row) => React.createElement("button", {
                key: row.sessionId,
                type: "button",
                ref: (node) => setSessionButtonRef(row.sessionId, node),
                className: `ps-list-button ps-session-list-button${row.active ? " is-selected" : ""}`,
                tabIndex: row.active ? 0 : -1,
                "aria-selected": row.active ? "true" : "false",
                onClick: (event) => {
                    const shouldToggleChildren = row.hasChildren && row.active && !event.metaKey && !event.ctrlKey;
                    if (shouldToggleChildren) {
                        controller.dispatch({
                            type: row.collapsed ? "sessions/expand" : "sessions/collapse",
                            sessionId: row.sessionId,
                        });
                        controller.setFocus("sessions");
                        return;
                    }
                    controller.setFocus("sessions");
                    if (!row.active) {
                        controller.loadSession(row.sessionId).catch(() => {});
                    }
                },
            },
            React.createElement("div", {
                className: "ps-line ps-session-row-content",
                style: { paddingInlineStart: `${Math.max(0, row.depth) * 18}px` },
            },
                Array.isArray(row.runs)
                    ? React.createElement(Runs, { runs: row.runs, theme })
                    : row.text),
            )),
    ));
}

function ChatPane({ controller, mobile = false, fullWidth = false }) {
    const themeId = useControllerSelector(controller, (state) => state.ui.themeId);
    const theme = getTheme(themeId);
    const viewState = useControllerSelector(controller, (state) => {
        const activeSessionId = state.sessions.activeSessionId;
        const layout = computeStateLayout(state);
        const paneWidth = fullWidth || mobile
            ? layout.totalWidth
            : layout.leftWidth;
        const contentWidth = Math.max(20, paneWidth - 4);
        return {
            activeSessionId,
            activeHistory: activeSessionId ? state.history.bySessionId.get(activeSessionId) || null : null,
            branding: state.branding,
            connection: state.connection,
            sessionsById: state.sessions.byId,
            sessionsFlat: state.sessions.flat,
            inspectorTab: state.ui.inspectorTab,
            focused: state.ui.focusRegion === "chat",
            scroll: state.ui.scroll.chat,
            contentWidth,
        };
    }, shallowEqualObject);
    const selectorState = React.useMemo(() => ({
        branding: viewState.branding,
        connection: viewState.connection,
        sessions: {
            activeSessionId: viewState.activeSessionId,
            byId: viewState.sessionsById,
            flat: viewState.sessionsFlat,
        },
        history: {
            bySessionId: viewState.activeSessionId && viewState.activeHistory
                ? new Map([[viewState.activeSessionId, viewState.activeHistory]])
                : new Map(),
        },
        ui: {
            inspectorTab: viewState.inspectorTab,
        },
    }), [
        viewState.activeHistory,
        viewState.activeSessionId,
        viewState.branding,
        viewState.connection,
        viewState.inspectorTab,
        viewState.sessionsById,
        viewState.sessionsFlat,
    ]);
    const chrome = React.useMemo(() => selectChatPaneChrome(selectorState), [selectorState]);
    const lines = React.useMemo(
        () => selectChatLines(selectorState, viewState.contentWidth),
        [selectorState, viewState.contentWidth],
    );

    return React.createElement(ScrollLinesPanel, {
        controller,
        title: mobile ? compactTitleRuns(chrome.title, 28) : chrome.title,
        color: chrome.color,
        focused: viewState.focused,
        lines,
        scrollOffset: viewState.scroll,
        scrollMode: "bottom",
        paneKey: "chat",
        className: "is-wrapped",
        panelClassName: "ps-chat-panel",
        structuredBlocks: true,
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
            React.createElement(ChatPane, { controller, mobile: true, fullWidth: true })));
}

function InspectorTabs({ activeTab, controller }) {
    const visibleTabs = React.useMemo(() => getVisibleInspectorTabs(controller), [controller]);
    // Tab labels in mobile fall on a single row only when each label is
    // short. "Node Map" is the only multi-word label, so we shorten it
    // to "Map" below the mobile breakpoint to keep all six tabs on one
    // line.
    const isMobile = typeof window !== "undefined"
        && (window.innerWidth || 0) > 0
        && (window.innerWidth || 0) < MOBILE_BREAKPOINT;
    const labelFor = (tab) => {
        if (isMobile && tab === "nodes") return "Map";
        return INSPECTOR_TAB_LABELS[tab] || tab;
    };
    return React.createElement("div", { className: "ps-tab-row" },
        visibleTabs.map((tab) => React.createElement("button", {
            key: tab,
            type: "button",
            className: `ps-tab${activeTab === tab ? " is-active" : ""}`,
            title: `Switch to ${INSPECTOR_TAB_LABELS[tab] || tab}`,
            "aria-pressed": activeTab === tab,
            onClick: () => {
                controller.setFocus("inspector");
                controller.selectInspectorTab(tab).catch(() => {});
            },
        }, labelFor(tab))));
}

function FilesPane({ controller, focused, mobile = false }) {
    const themeId = useControllerSelector(controller, (state) => state.ui.themeId);
    const theme = getTheme(themeId);
    const fileInputRef = React.useRef(null);
    const viewState = useControllerSelector(controller, (state) => {
        const activeSessionId = state.sessions.activeSessionId;
        const layout = computeStateLayout(state);
        const paneWidth = (mobile || state.files.fullscreen)
            ? (state.ui.layout?.viewportWidth ?? 120)
            : layout.rightWidth;
        return {
            activeSessionId,
            sessionsById: state.sessions.byId,
            sessionsFlat: state.sessions.flat,
            filesBySessionId: state.files.bySessionId,
            filesFilter: state.files.filter,
            selectedArtifactId: state.files.selectedArtifactId,
            focused,
            previewScroll: state.ui.scroll.filePreview,
            fullscreen: Boolean(state.files.fullscreen),
            contentWidth: Math.max(20, paneWidth - 4),
            canBrowserUpload: supportsBrowserFileUploads(controller),
            canPathUpload: supportsPathArtifactUploads(controller),
            canOpenLocally: supportsLocalFileOpen(controller),
        };
    }, shallowEqualObject);
    const selectorState = React.useMemo(() => ({
        sessions: {
            activeSessionId: viewState.activeSessionId,
            byId: viewState.sessionsById,
            flat: viewState.sessionsFlat,
        },
        files: {
            bySessionId: viewState.filesBySessionId,
            selectedArtifactId: viewState.selectedArtifactId,
            filter: viewState.filesFilter,
            fullscreen: viewState.fullscreen,
        },
        ui: {
            scroll: {
                filePreview: viewState.previewScroll,
            },
        },
    }), [
        viewState.activeSessionId,
        viewState.filesBySessionId,
        viewState.filesFilter,
        viewState.fullscreen,
        viewState.previewScroll,
        viewState.selectedArtifactId,
        viewState.sessionsById,
        viewState.sessionsFlat,
    ]);
    const filesView = React.useMemo(() => selectFilesView(selectorState, {
        listWidth: Math.max(18, viewState.contentWidth - 4),
        previewWidth: Math.max(18, viewState.contentWidth - 4),
        showHints: false,
    }), [selectorState, viewState.contentWidth]);
    const items = React.useMemo(() => selectFileBrowserItems(selectorState), [selectorState]);
    const hasSelection = items.length > 0;

    const uploadFiles = React.useCallback((files) => {
        const nextFiles = Array.isArray(files) ? files.filter(Boolean) : [];
        if (nextFiles.length === 0) return;
        controller.uploadArtifactFiles(nextFiles).catch(() => {});
    }, [controller]);

    const openUploadPicker = React.useCallback(() => {
        if (viewState.canBrowserUpload && fileInputRef.current) {
            fileInputRef.current.click();
            return;
        }
        if (viewState.canPathUpload) {
            controller.handleCommand(UI_COMMANDS.OPEN_ARTIFACT_UPLOAD).catch(() => {});
        }
    }, [controller, viewState.canBrowserUpload, viewState.canPathUpload]);

    const panelActions = React.createElement(React.Fragment, null,
        React.createElement("input", {
            ref: fileInputRef,
            type: "file",
            className: "ps-hidden-file-input",
            multiple: true,
            tabIndex: -1,
            "aria-hidden": "true",
            onChange: (event) => {
                uploadFiles(Array.from(event.currentTarget.files || []));
                event.currentTarget.value = "";
            },
        }),
        React.createElement("button", {
            type: "button",
            className: "ps-mini-button",
            onClick: openUploadPicker,
            disabled: !viewState.canBrowserUpload && !viewState.canPathUpload,
        }, "Upload"),
        React.createElement("button", {
            type: "button",
            className: "ps-mini-button",
            onClick: () => controller.handleCommand(UI_COMMANDS.DOWNLOAD_SELECTED_FILE).catch(() => {}),
            disabled: !hasSelection,
        }, "Download"),
        viewState.canOpenLocally ? React.createElement("button", {
            type: "button",
            className: "ps-mini-button",
            onClick: () => controller.handleCommand(UI_COMMANDS.OPEN_SELECTED_FILE).catch(() => {}),
            disabled: !hasSelection,
        }, "Open") : null,
        React.createElement("button", {
            type: "button",
            className: "ps-mini-button",
            onClick: () => controller.handleCommand(UI_COMMANDS.OPEN_FILES_FILTER).catch(() => {}),
        }, "Filter"),
        React.createElement("button", {
            type: "button",
            className: "ps-mini-button",
            onClick: () => controller.handleCommand(UI_COMMANDS.TOGGLE_FILE_PREVIEW_FULLSCREEN).catch(() => {}),
        }, viewState.fullscreen ? "Close" : (mobile ? "Focus" : "Fullscreen")));

    const listContent = items.length === 0
        ? normalizeLines(filesView.listBodyLines || []).map((line, index) => React.createElement(Line, {
            key: `empty:${index}`,
            line,
            theme,
        }))
        : items.map((item, index) => React.createElement("button", {
            key: item.id,
            type: "button",
            className: `ps-list-button${index === filesView.selectedIndex ? " is-selected" : ""}`,
            onClick: () => {
                controller.setFocus("inspector");
                controller.selectFileBrowserItem(item).catch(() => {});
            },
        }, React.createElement(Line, {
            line: normalizeLines([filesView.listBodyLines?.[index]])[0],
            theme,
        })));

    const previewPane = filesView.previewRenderMode === "markdown"
        && !filesView.previewLoading
        && !filesView.previewError
        ? React.createElement(MarkdownPreviewPanel, {
            controller,
            title: filesView.previewTitle,
            color: "cyan",
            focused: false,
            scrollOffset: viewState.previewScroll,
            paneKey: "filePreview",
            theme,
            content: filesView.previewContent || "",
        })
        : React.createElement(ScrollLinesPanel, {
            controller,
            title: filesView.previewTitle,
            color: "cyan",
            focused: false,
            lines: filesView.previewLines,
            scrollOffset: viewState.previewScroll,
            scrollMode: "top",
            paneKey: "filePreview",
            className: "is-preview is-wrapped",
        });
    const view = viewState;

    return React.createElement(Panel, {
        title: view.fullscreen
            ? filesView.fullscreenTitle
            : (mobile && filesView.panelTitleMobile)
                ? filesView.panelTitleMobile
                : filesView.panelTitle,
        color: "magenta",
        focused: view.focused,
        actions: panelActions,
        theme,
    },
    React.createElement(InspectorTabs, { activeTab: "files", controller }),
    // Fullscreen files mode shows only the preview pane; the list stays hidden.
    view.fullscreen
        ? previewPane
        : React.createElement("div", { className: "ps-files-grid" },
            React.createElement(Panel, { title: filesView.listTitle, color: "cyan", theme },
                React.createElement("div", { className: "ps-action-list" }, listContent)),
            previewPane,
        ));
}

function InspectorPane({ controller, mobile = false, panelClassName = "", extraActions = null }) {
    const viewState = useControllerSelector(controller, (state) => {
        const layout = computeStateLayout(state);
        const paneWidth = mobile
            ? (state.ui.layout?.viewportWidth ?? 120)
            : layout.rightWidth;
        return {
            inspectorTab: state.ui.inspectorTab,
            statsViewMode: state.ui.statsViewMode,
            activeSessionId: state.sessions.activeSessionId,
            sessionsById: state.sessions.byId,
            sessionsFlat: state.sessions.flat,
            historyBySessionId: state.history.bySessionId,
            sessionStats: state.sessionStats,
            fleetStats: state.fleetStats,
            connection: state.connection,
            orchestrationBySessionId: state.orchestration.bySessionId,
            executionHistoryBySessionId: state.executionHistory?.bySessionId || {},
            executionHistoryFormat: state.executionHistory?.format || "pretty",
            logs: state.logs,
            files: state.files,
            focused: state.ui.focusRegion === "inspector",
            scroll: state.ui.scroll.inspector,
            logsTailing: state.logs.tailing,
            filesFullscreen: Boolean(state.files.fullscreen),
            contentWidth: Math.max(20, paneWidth - 4),
        };
    }, shallowEqualObject);
    const selectorState = React.useMemo(() => ({
        sessions: {
            activeSessionId: viewState.activeSessionId,
            byId: viewState.sessionsById,
            flat: viewState.sessionsFlat,
        },
        history: {
            bySessionId: viewState.historyBySessionId,
        },
        sessionStats: viewState.sessionStats,
        fleetStats: viewState.fleetStats,
        connection: viewState.connection,
        ui: {
            inspectorTab: viewState.inspectorTab,
            statsViewMode: viewState.statsViewMode,
            scroll: {
                inspector: viewState.scroll,
            },
        },
        logs: viewState.logs,
        files: viewState.files,
        orchestration: {
            bySessionId: viewState.orchestrationBySessionId,
        },
        executionHistory: {
            bySessionId: viewState.executionHistoryBySessionId,
            format: viewState.executionHistoryFormat,
        },
    }), [
        viewState.activeSessionId,
        viewState.connection,
        viewState.executionHistoryBySessionId,
        viewState.executionHistoryFormat,
        viewState.fleetStats,
        viewState.files,
        viewState.historyBySessionId,
        viewState.inspectorTab,
        viewState.sessionStats,
        viewState.statsViewMode,
        viewState.logs,
        viewState.orchestrationBySessionId,
        viewState.scroll,
        viewState.sessionsById,
        viewState.sessionsFlat,
    ]);
    const inspector = React.useMemo(() => selectInspector(selectorState, {
        width: viewState.contentWidth,
        allowWideColumns: mobile,
    }), [mobile, selectorState, viewState.contentWidth]);

    if (viewState.inspectorTab === "files") {
        return React.createElement(FilesPane, { controller, focused: viewState.focused, mobile });
    }

    const actions = [];
    if (viewState.inspectorTab === "logs") {
        actions.push(React.createElement("button", {
            key: "tail",
            type: "button",
            className: "ps-mini-button",
            onClick: () => controller.handleCommand(UI_COMMANDS.TOGGLE_LOG_TAIL).catch(() => {}),
        }, viewState.logsTailing ? "Stop Tail" : "Tail"));
        actions.push(React.createElement("button", {
            key: "filter",
            type: "button",
            className: "ps-mini-button",
            onClick: () => controller.handleCommand(UI_COMMANDS.OPEN_LOG_FILTER).catch(() => {}),
        }, "Filter"));
    } else if (viewState.inspectorTab === "history") {
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
    } else if (viewState.inspectorTab === "stats") {
        actions.push(React.createElement("button", {
            key: "toggle-stats-view",
            type: "button",
            className: "ps-mini-button",
            onClick: () => controller.handleCommand(UI_COMMANDS.TOGGLE_STATS_VIEW).catch(() => {}),
        }, viewState.statsViewMode === "fleet" ? "Session" : "Fleet"));
    }

    const panelActions = extraActions
        ? actions.concat(extraActions)
        : actions;

    return React.createElement(ScrollLinesPanel, {
        controller,
        title: inspector.title,
        color: "magenta",
        focused: viewState.focused,
        actions: panelActions,
        topContent: React.createElement(InspectorTabs, { activeTab: inspector.activeTab, controller }),
        stickyLines: inspector.stickyLines || [],
        lines: inspector.lines,
        scrollOffset: viewState.scroll,
        scrollMode: inspector.activeTab === "logs"
            || inspector.activeTab === "sequence"
            ? "bottom"
            : "top",
        paneKey: "inspector",
        className: inspector.activeTab === "history" ? "is-wrapped" : "is-preserve",
        panelClassName: `${inspector.activeTab === "sequence" ? "has-preserved-sticky" : ""}${panelClassName ? ` ${panelClassName}` : ""}`.trim(),
    });
}

function ActivityPane({ controller, panelClassName = "", extraActions = null }) {
    const viewState = useControllerSelector(controller, (state) => {
        const activeSessionId = state.sessions.activeSessionId;
        const layout = computeStateLayout(state);
        const maxLines = Math.max(3, layout.activityPaneHeight - 2);
        return {
            activeSessionId,
            activeSession: activeSessionId ? state.sessions.byId[activeSessionId] || null : null,
            activeHistory: activeSessionId ? state.history.bySessionId.get(activeSessionId) || null : null,
            focused: state.ui.focusRegion === "activity",
            scroll: state.ui.scroll.activity,
            maxLines,
        };
    }, shallowEqualObject);
    const selectorState = React.useMemo(() => ({
        sessions: {
            activeSessionId: viewState.activeSessionId,
            byId: viewState.activeSessionId && viewState.activeSession
                ? { [viewState.activeSessionId]: viewState.activeSession }
                : {},
        },
        history: {
            bySessionId: viewState.activeSessionId && viewState.activeHistory
                ? new Map([[viewState.activeSessionId, viewState.activeHistory]])
                : new Map(),
        },
    }), [viewState.activeHistory, viewState.activeSession, viewState.activeSessionId]);
    const activity = React.useMemo(
        () => selectActivityPane(selectorState, viewState.maxLines),
        [selectorState, viewState.maxLines],
    );

    return React.createElement(ScrollLinesPanel, {
        controller,
        title: activity.title,
        color: "gray",
        focused: viewState.focused,
        actions: extraActions,
        lines: activity.lines,
        scrollOffset: viewState.scroll,
        scrollMode: "bottom",
        paneKey: "activity",
        className: "is-preserve",
        panelClassName,
    });
}

const CHAT_FOCUS_PANES = [
    { id: "sessions", label: "Sessions", side: "left" },
    { id: "inspector", label: "Inspector", side: "right" },
    { id: "activity", label: "Activity", side: "right" },
];

function ChatFocusOverlay({ controller, pane, onClose }) {
    if (!pane) return null;

    let content = null;
    if (pane === "sessions") {
        content = React.createElement(SessionPane, {
            controller,
            panelClassName: "ps-chat-focus-pane",
            actions: React.createElement("button", {
                type: "button",
                className: "ps-mini-button",
                onClick: onClose,
            }, "Close"),
        });
    } else if (pane === "inspector") {
        content = React.createElement(InspectorPane, {
            controller,
            mobile: false,
            panelClassName: "ps-chat-focus-pane",
            extraActions: React.createElement("button", {
                type: "button",
                className: "ps-mini-button",
                onClick: onClose,
            }, "Close"),
        });
    } else if (pane === "activity") {
        content = React.createElement(ActivityPane, {
            controller,
            panelClassName: "ps-chat-focus-pane",
            extraActions: React.createElement("button", {
                type: "button",
                className: "ps-mini-button",
                onClick: onClose,
            }, "Close"),
        });
    }

    const paneMeta = CHAT_FOCUS_PANES.find((entry) => entry.id === pane);
    return React.createElement("div", {
        className: `ps-chat-focus-overlay${paneMeta?.side === "left" ? " is-left" : " is-right"}`,
    }, content);
}

function ChatFocusWorkspace({ controller, openPane, onTogglePane, onExitFocus, mobile = false }) {
    const focusRegion = useControllerSelector(controller, (state) => state.ui.focusRegion);

    const rail = mobile
        ? React.createElement("div", { className: "ps-chat-focus-rail" },
            React.createElement("button", {
                type: "button",
                className: "ps-mini-button ps-chat-focus-button",
                onClick: onExitFocus,
            }, "Exit Focus"),
            React.createElement("button", {
                type: "button",
                className: `ps-mini-button ps-chat-focus-button${openPane === "sessions" ? " is-active" : ""}`,
                onClick: () => onTogglePane("sessions"),
            }, "Sessions"))
        : React.createElement("div", { className: "ps-chat-focus-rail" },
            CHAT_FOCUS_PANES.map((pane) => React.createElement("button", {
                key: pane.id,
                type: "button",
                className: `ps-mini-button ps-chat-focus-button${openPane === pane.id ? " is-active" : ""}`,
                "aria-pressed": openPane === pane.id ? "true" : "false",
                onClick: () => onTogglePane(pane.id),
            }, pane.label)),
            React.createElement("div", { className: "ps-chat-focus-status" },
                openPane
                    ? `Focused: ${CHAT_FOCUS_PANES.find((pane) => pane.id === openPane)?.label || openPane}`
                    : `Focused: ${focusRegion === "prompt" ? "Prompt" : "Chat"}`));

    return React.createElement("div", { className: "ps-chat-focus-shell" },
        rail,
        React.createElement("div", { className: "ps-chat-focus-body" },
            React.createElement(ChatPane, { controller, mobile, fullWidth: true }),
            React.createElement(ChatFocusOverlay, {
                controller,
                pane: openPane,
                onClose: () => onTogglePane(openPane),
            })));
}

function PromptComposer({ controller, mobile, active = true, onAfterSend = null }) {
    const promptState = useControllerSelector(controller, (state) => {
        const activeSessionId = state.sessions.activeSessionId;
        const activeSession = activeSessionId ? state.sessions.byId[activeSessionId] || null : null;
        return {
            value: state.ui.prompt,
            cursor: state.ui.promptCursor,
            focused: state.ui.focusRegion === "prompt",
            modalOpen: Boolean(state.ui.modal),
            answerMode: Boolean(activeSession?.pendingQuestion?.question),
        };
    }, shallowEqualObject);
    const inputRef = React.useRef(null);

    React.useEffect(() => {
        const inputNode = inputRef.current;
        if (!active || promptState.modalOpen || !promptState.focused || !inputNode) return;
        if (document.activeElement !== inputNode) {
            try {
                inputNode.focus({ preventScroll: true });
            } catch {
                inputNode.focus();
            }
        }
        inputNode.setSelectionRange(promptState.cursor, promptState.cursor);
    }, [active, promptState.cursor, promptState.focused, promptState.modalOpen]);

    const sendPrompt = React.useCallback(() => {
        controller.handleCommand(UI_COMMANDS.SEND_PROMPT)
            .catch(() => {})
            .finally(() => {
                onAfterSend?.();
            });
    }, [controller, onAfterSend]);

    return React.createElement("div", {
        className: `ps-prompt-shell${mobile ? " is-mobile" : ""}`,
    },
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
            onSelect: (event) => controller.setPrompt(
                event.currentTarget.value,
                event.currentTarget.selectionStart || 0,
            ),
            onChange: (event) => controller.setPrompt(event.currentTarget.value, event.currentTarget.selectionStart || event.currentTarget.value.length),
            onKeyDown: (event) => {
                if (event.key === "Tab" && !event.shiftKey && controller.acceptPromptReferenceAutocomplete()) {
                    event.preventDefault();
                    return;
                }
                if (event.key === "Enter" && !event.shiftKey && !event.metaKey && !mobile) {
                    event.preventDefault();
                    sendPrompt();
                }
            },
        }),
        React.createElement("button", {
        type: "button",
        className: `ps-send-button${mobile ? " is-inline" : ""}`,
        title: "Send prompt",
        "aria-label": "Send prompt",
        onClick: sendPrompt,
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

function buildPortalKeybindingSections({ canUpload, canOpenLocally }) {
    return [
        {
            title: "Global",
            items: [
                ["n", "New session"],
                ["Shift+N", "New session with model"],
                ["T", "Theme picker"],
                ["Tab / Shift+Tab", "Cycle focus"],
                ["[ / ]", "Resize side panes"],
                ["{ / }", "Resize session list vertically"],
                ["?", "Toggle this legend"],
            ],
        },
        {
            title: "Navigation",
            items: [
                ["j / k", "Move or scroll the focused pane"],
                ["Ctrl+U / Ctrl+D", "Page up/down"],
                ["g / G", "Jump top/bottom"],
                ["m", "Cycle inspector tabs"],
                ["p", "Focus prompt"],
                ["Esc", "Focus sessions"],
            ],
        },
        {
            title: "Prompt",
            items: [
                ["Enter", "Send prompt"],
                ["Tab", "Accept @ / @@ autocomplete"],
                ["@", "Browse this session's artifacts and attach the selection"],
                ["@@", "Filter sessions and insert a durable session reference"],
            ],
        },
        {
            title: "Files",
            items: [
                [canUpload ? "u / Ctrl+A" : "u", "Upload artifact to the active session"],
                ["a", "Download selected artifact"],
                ...(canOpenLocally ? [["o", "Open downloaded file locally"]] : []),
                ["f", "Filter the artifact browser"],
                ["v", "Toggle fullscreen preview"],
            ],
        },
    ];
}

function KeybindingLegend({ open, onClose, canUpload, canOpenLocally }) {
    if (!open) return null;
    const sections = buildPortalKeybindingSections({ canUpload, canOpenLocally });
    return React.createElement("div", { className: "ps-modal-backdrop", onClick: onClose },
        React.createElement("div", {
            className: "ps-modal is-wide ps-keybinding-modal",
            role: "dialog",
            "aria-modal": "true",
            "aria-label": "Keyboard shortcuts",
            onClick: (event) => event.stopPropagation(),
        },
        React.createElement("div", { className: "ps-modal-header" },
            React.createElement("div", { className: "ps-modal-title" }, "Keyboard Shortcuts"),
            React.createElement("button", { type: "button", className: "ps-modal-close", onClick: onClose }, "Close")),
        React.createElement("div", { className: "ps-keybinding-grid" },
            sections.map((section) => React.createElement("section", { key: section.title, className: "ps-keybinding-section" },
                React.createElement("h3", { className: "ps-keybinding-title" }, section.title),
                React.createElement("div", { className: "ps-keybinding-list" },
                    section.items.map(([binding, description]) => React.createElement("div", { key: `${section.title}:${binding}`, className: "ps-keybinding-row" },
                        React.createElement("kbd", { className: "ps-keybinding-kbd" }, binding),
                        React.createElement("span", { className: "ps-keybinding-description" }, description)))))),
        ),
        React.createElement("div", { className: "ps-modal-footer" },
            React.createElement("button", { type: "button", className: "ps-modal-button is-primary", onClick: onClose }, "Done"))));
}

function PromptOverlay({ controller, open, onClose }) {
    if (!open) return null;
    return React.createElement("div", {
        className: "ps-modal-backdrop ps-compose-backdrop",
        onClick: onClose,
    },
    React.createElement("div", {
        className: "ps-compose-card",
        role: "dialog",
        "aria-modal": "true",
        "aria-label": "Compose prompt",
        onClick: (event) => event.stopPropagation(),
    },
    React.createElement("div", { className: "ps-compose-header" },
        React.createElement("div", { className: "ps-modal-title" }, "Prompt"),
        React.createElement("button", {
            type: "button",
            className: "ps-modal-close",
            onClick: onClose,
        }, "Close")),
    React.createElement(PromptComposer, {
        controller,
        mobile: false,
        active: open,
        onAfterSend: onClose,
    })));
}

function Toolbar({ controller, mobile, onToggleLegend, onOpenPrompt, chatFocusMode = false, onToggleChatFocus = null, chatFocusDisabled = false }) {
    const status = useControllerSelector(controller, (state) => selectStatusBar(state), shallowEqualObject);
    const canRename = useControllerSelector(
        controller,
        (state) => Boolean(state.sessions.activeSessionId && !state.sessions.byId[state.sessions.activeSessionId]?.isSystem),
    );

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
            onClick: () => controller.handleCommand(UI_COMMANDS.OPEN_MODEL_PICKER).catch(() => {}),
        }, mobile ? "Model" : "New + Model"),
            React.createElement("button", {
            type: "button",
            className: "ps-toolbar-button",
            onClick: onOpenPrompt,
        }, "Prompt"),
            React.createElement("button", {
            type: "button",
            className: "ps-toolbar-button",
            onClick: () => controller.handleCommand(UI_COMMANDS.OPEN_RENAME_SESSION).catch(() => {}),
            disabled: !canRename,
        }, mobile ? "Title" : "Rename"),
            React.createElement("button", {
            type: "button",
            className: "ps-toolbar-button",
            onClick: () => controller.handleCommand(UI_COMMANDS.REFRESH).catch(() => {}),
        }, "Refresh"),
            React.createElement("button", {
            type: "button",
            className: "ps-toolbar-button",
            onClick: () => controller.handleCommand(UI_COMMANDS.OPEN_THEME_PICKER).catch(() => {}),
        }, "Theme"),
            onToggleChatFocus ? React.createElement("button", {
            type: "button",
            className: `ps-toolbar-button${chatFocusMode ? " is-active" : ""}`,
            onClick: onToggleChatFocus,
            disabled: chatFocusDisabled,
        }, mobile
            ? (chatFocusMode ? "Exit Focus" : "Focus")
            : (chatFocusMode ? "Exit Focus" : "Chat Focus")) : null,
            React.createElement("button", {
            type: "button",
            className: "ps-toolbar-button",
            onClick: onToggleLegend,
        }, "Keys")),
        status.left
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
            document.body.classList.remove("is-resizing-pane-x");
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
            document.body.classList.remove("is-resizing-pane-x");
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
            document.body.classList.add("is-resizing-pane-x");
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

function RowResizeHandle({ controller, sessionPaneAdjust = 0 }) {
    const dragStateRef = React.useRef(null);
    const [dragging, setDragging] = React.useState(false);

    React.useEffect(() => {
        if (!dragging) return undefined;

        const stopDragging = () => {
            dragStateRef.current = null;
            setDragging(false);
            document.body.classList.remove("is-resizing-pane-y");
        };

        const onPointerMove = (event) => {
            const dragState = dragStateRef.current;
            if (!dragState) return;
            const deltaCells = Math.round((event.clientY - dragState.startY) / GRID_CELL_HEIGHT);
            const deltaIncrement = deltaCells - dragState.appliedCells;
            if (!deltaIncrement) return;
            controller.adjustSessionPaneSplit(deltaIncrement);
            dragState.appliedCells = deltaCells;
        };

        window.addEventListener("pointermove", onPointerMove);
        window.addEventListener("pointerup", stopDragging);
        window.addEventListener("pointercancel", stopDragging);

        return () => {
            window.removeEventListener("pointermove", onPointerMove);
            window.removeEventListener("pointerup", stopDragging);
            window.removeEventListener("pointercancel", stopDragging);
            document.body.classList.remove("is-resizing-pane-y");
        };
    }, [controller, dragging]);

    return React.createElement("button", {
        type: "button",
        className: `ps-row-resizer${dragging ? " is-dragging" : ""}`,
        title: "Drag to resize the session list. Double-click to reset.",
        "aria-label": "Resize session list",
        onPointerDown: (event) => {
            if (event.button !== 0) return;
            event.preventDefault();
            dragStateRef.current = {
                startY: event.clientY,
                appliedCells: 0,
            };
            setDragging(true);
            document.body.classList.add("is-resizing-pane-y");
        },
        onDoubleClick: () => {
            if (!sessionPaneAdjust) return;
            controller.adjustSessionPaneSplit(-sessionPaneAdjust);
        },
        onKeyDown: (event) => {
            if (event.key === "ArrowUp") {
                event.preventDefault();
                controller.adjustSessionPaneSplit(-1);
                return;
            }
            if (event.key === "ArrowDown") {
                event.preventDefault();
                controller.adjustSessionPaneSplit(1);
            }
        },
    },
    React.createElement("span", { className: "ps-row-resizer-handle", "aria-hidden": "true" },
        React.createElement("span", { className: "ps-row-resizer-dot" }),
        React.createElement("span", { className: "ps-row-resizer-dot" }),
        React.createElement("span", { className: "ps-row-resizer-dot" })));
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
        confirm: selectConfirmModal(state),
        logsFilter: state.logs.filter,
        filesFilterState: state.files.filter,
        historyFormatState: state.executionHistory?.format || "pretty",
    }), shallowEqualObject);
    const modal = modalState.rawModal;
    const renameInputRef = React.useRef(null);
    const listModalRef = React.useRef(null);

    React.useEffect(() => {
        if (modal?.type !== "renameSession" || !modalState.renameSession) return;
        const inputNode = renameInputRef.current;
        if (!inputNode) return;
        if (document.activeElement !== inputNode) {
            try {
                inputNode.focus({ preventScroll: true });
            } catch {
                inputNode.focus();
            }
        }
        inputNode.setSelectionRange(modalState.renameSession.cursorIndex, modalState.renameSession.cursorIndex);
    }, [modal?.type, modalState.renameSession?.cursorIndex, modalState.renameSession?.value]);

    React.useEffect(() => {
        if (!modal) return;
        if (![
            "themePicker",
            "modelPicker",
            "sessionAgentPicker",
            "artifactPicker",
            "logFilter",
            "filesFilter",
            "historyFormat",
        ].includes(modal.type)) {
            return;
        }

        const listNode = listModalRef.current;
        if (!listNode) return;
        const selected = listNode.querySelector(".ps-list-button.is-selected");
        if (selected && typeof selected.scrollIntoView === "function") {
            selected.scrollIntoView({ block: "nearest" });
        }
    }, [
        modal?.type,
        modal?.selectedIndex,
        modalState.themePicker?.selectedRowIndex,
        modalState.modelPicker?.selectedRowIndex,
        modalState.sessionAgentPicker?.selectedRowIndex,
        modalState.artifactPicker?.selectedRowIndex,
        modalState.logFilter?.selectedRowIndex,
        modalState.filesFilter?.selectedRowIndex,
        modalState.historyFormat?.selectedRowIndex,
    ]);

    if (!modal) return null;

    const close = () => controller.handleCommand(UI_COMMANDS.CLOSE_MODAL).catch(() => {});

    const renderListModal = (presentation, confirmLabel = "Apply") => {
        const rows = Array.isArray(presentation.rows) ? presentation.rows : [];
        const rowItemIndexes = Array.isArray(presentation.rowItemIndexes) ? presentation.rowItemIndexes : null;
        const usesHangingIndent = modal.type === "modelPicker" || modal.type === "sessionAgentPicker";
        const renderedList = rowItemIndexes && rowItemIndexes.length === rows.length
            ? rows.map((row, rowIndex) => {
                const itemIndex = rowItemIndexes[rowIndex];
                const runs = Array.isArray(row)
                    ? row
                    : normalizeLines([row])[0]?.runs || [{ text: row?.text || "", color: row?.color }];
                if (itemIndex == null || itemIndex < 0) {
                    return React.createElement("div", {
                        key: `row:${rowIndex}`,
                        className: "ps-line ps-modal-list-heading-line",
                    }, React.createElement(Runs, { runs, theme }));
                }
                const item = modal.items?.[itemIndex];
                return React.createElement("button", {
                    key: item?.id || `row:${rowIndex}`,
                    type: "button",
                    className: `ps-list-button ps-modal-list-button${itemIndex === modal.selectedIndex ? " is-selected" : ""}${usesHangingIndent ? " is-hanging" : ""}`,
                    onClick: () => controller.dispatch({ type: "ui/modalSelection", index: itemIndex }),
                },
                React.createElement("div", { className: "ps-line ps-modal-list-line" },
                    React.createElement(Runs, { runs, theme })));
            })
            : (modal.items || []).map((item, index) => React.createElement("button", {
                key: item.id || index,
                type: "button",
                className: `ps-list-button ps-modal-list-button${index === modal.selectedIndex ? " is-selected" : ""}${usesHangingIndent ? " is-hanging" : ""}`,
                onClick: () => controller.dispatch({ type: "ui/modalSelection", index }),
            },
            React.createElement("div", { className: "ps-line ps-modal-list-line" },
                React.createElement(Runs, {
                    runs: Array.isArray(rows?.[index])
                        ? rows[index]
                        : normalizeLines([rows?.[index]])[0]?.runs || [{ text: rows?.[index]?.text || "", color: rows?.[index]?.color }],
                    theme,
                }))));

        return React.createElement("div", { className: "ps-modal-backdrop", onClick: close },
        React.createElement("div", { className: "ps-modal", onClick: (event) => event.stopPropagation() },
            React.createElement("div", { className: "ps-modal-header" },
                React.createElement("div", { className: "ps-modal-title" }, presentation.title),
                React.createElement("button", { type: "button", className: "ps-modal-close", onClick: close }, "Close"),
            ),
            React.createElement("div", { className: "ps-modal-grid" },
                React.createElement("div", { ref: listModalRef, className: "ps-modal-list" },
                    renderedList,
                ),
                React.createElement("div", { className: "ps-modal-details" },
                    React.createElement("div", { className: "ps-modal-details-title" }, presentation.detailsTitle || "Details"),
                    normalizeLines(presentation.detailsLines || []).map((line, index) => React.createElement(Line, { key: `detail:${index}`, line, theme, className: "ps-modal-detail-line" })),
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
    };

    if (modal.type === "confirm" && modalState.confirm) {
        const isDestructive = modal.action === "deleteSession";
        return React.createElement("div", { className: "ps-modal-backdrop", onClick: close },
            React.createElement("div", { className: "ps-modal is-narrow", onClick: (event) => event.stopPropagation() },
                React.createElement("div", { className: "ps-modal-header" },
                    React.createElement("div", { className: "ps-modal-title" }, modalState.confirm.title),
                    React.createElement("button", { type: "button", className: "ps-modal-close", onClick: close }, "Close"),
                ),
                React.createElement("div", { className: "ps-modal-body", style: { padding: "16px 20px" } },
                    React.createElement("p", { style: { color: "#94a3b8", margin: 0 } }, modalState.confirm.message),
                ),
                React.createElement("div", { className: "ps-modal-footer" },
                    React.createElement("button", { type: "button", className: "ps-modal-button", onClick: close }, "Cancel"),
                    React.createElement("button", {
                        type: "button",
                        className: `ps-modal-button ${isDestructive ? "is-danger" : "is-primary"}`,
                        onClick: () => controller.handleCommand(UI_COMMANDS.MODAL_CONFIRM).catch(() => {}),
                    }, modalState.confirm.confirmLabel)),
            ));
    }
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
                    ref: renameInputRef,
                    className: "ps-modal-input",
                    value: modalState.renameSession.value,
                    placeholder: modalState.renameSession.placeholder,
                    onChange: (event) => controller.setRenameSessionValue(event.currentTarget.value, event.currentTarget.selectionStart ?? event.currentTarget.value.length),
                    onKeyDown: (event) => {
                        if (event.key === "Enter") {
                            event.preventDefault();
                            controller.handleCommand(UI_COMMANDS.MODAL_CONFIRM).catch(() => {});
                        }
                    },
                    autoFocus: true,
                }),
                React.createElement("div", { className: "ps-modal-details" },
                    normalizeLines(modalState.renameSession.helpLines || []).map((line, index) => React.createElement(Line, { key: `help:${index}`, line, theme, className: "ps-modal-detail-line" })),
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
    if (modal.type === "terminatePicker") {
        const sessionLabel = String(modal.sessionTitle || "").trim() || "this session";
        const pick = (action) => () => {
            controller.pickTerminateAction(action).catch(() => {});
        };
        return React.createElement("div", { className: "ps-modal-backdrop", onClick: close },
            React.createElement("div", { className: "ps-modal is-narrow", onClick: (event) => event.stopPropagation() },
                React.createElement("div", { className: "ps-modal-header" },
                    React.createElement("div", { className: "ps-modal-title" }, modal.title || "Terminate session"),
                    React.createElement("button", { type: "button", className: "ps-modal-close", onClick: close }, "Close"),
                ),
                React.createElement("div", { className: "ps-modal-body", style: { padding: "12px 16px 4px" } },
                    React.createElement("p", { style: { color: "#94a3b8", margin: 0 } },
                        `What should happen to "${sessionLabel}"? Choose an action; you'll be asked to confirm.`)),
                React.createElement("div", {
                    className: "ps-modal-body",
                    style: { padding: "10px 16px 16px", display: "flex", flexDirection: "column", gap: 8 },
                },
                    React.createElement("button", {
                        type: "button",
                        className: "ps-modal-button is-primary",
                        style: { width: "100%", justifyContent: "flex-start" },
                        onClick: pick("complete"),
                    }, "Mark Completed"),
                    React.createElement("button", {
                        type: "button",
                        className: "ps-modal-button",
                        style: { width: "100%", justifyContent: "flex-start" },
                        onClick: pick("cancel"),
                    }, "Cancel Session"),
                    React.createElement("button", {
                        type: "button",
                        className: "ps-modal-button is-danger",
                        style: { width: "100%", justifyContent: "flex-start" },
                        onClick: pick("delete"),
                    }, "Delete Session"),
                ),
                React.createElement("div", { className: "ps-modal-footer" },
                    React.createElement("button", { type: "button", className: "ps-modal-button", onClick: close }, "Close")),
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
                    normalizeLines(modalState.artifactUpload.helpLines || []).map((line, index) => React.createElement(Line, { key: `help:${index}`, line, theme, className: "ps-modal-detail-line" })),
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

function useKeyboardShortcuts(
    controller,
    mobile,
    {
        legendOpen = false,
        onToggleLegend = null,
        onCloseLegend = null,
        promptOverlayOpen = false,
        onOpenPromptOverlay = null,
        onClosePromptOverlay = null,
    } = {},
) {
    React.useEffect(() => {
        const handler = (event) => {
            const target = event.target;
            const editable = target instanceof HTMLElement
                && (target.tagName === "TEXTAREA" || target.tagName === "INPUT" || target.isContentEditable);
            const modal = controller.getState().ui.modal;
            const visibleInspectorTabs = getVisibleInspectorTabs(controller);
            const currentInspectorTab = controller.getState().ui.inspectorTab;
            const focusRegion = controller.getState().ui.focusRegion;
            const isPlainShortcut = !event.metaKey && !event.ctrlKey && !event.altKey;
            const isShiftTheme = !event.metaKey && !event.ctrlKey && !event.altKey && event.key === "T" && event.shiftKey;
            const isShiftModel = !event.metaKey && !event.ctrlKey && !event.altKey && event.key === "N" && event.shiftKey;
            const selectVisibleInspectorTab = (delta) => {
                const nextTab = cycleTabs(visibleInspectorTabs, currentInspectorTab, delta);
                controller.selectInspectorTab(nextTab).catch(() => {});
            };

            if (!editable && (event.key === "?" || (event.shiftKey && event.key === "/")) && !event.metaKey && !event.ctrlKey && !event.altKey) {
                event.preventDefault();
                if (legendOpen) {
                    onCloseLegend?.();
                } else {
                    onToggleLegend?.();
                }
                return;
            }

            if (legendOpen) {
                if (event.key === "Escape") {
                    event.preventDefault();
                    onCloseLegend?.();
                }
                return;
            }

            if (promptOverlayOpen && !modal && event.key === "Escape") {
                event.preventDefault();
                onClosePromptOverlay?.();
                return;
            }

            if (!editable && isShiftTheme) {
                event.preventDefault();
                controller.handleCommand(UI_COMMANDS.OPEN_THEME_PICKER).catch(() => {});
                return;
            }
            if (!editable && isShiftModel) {
                event.preventDefault();
                controller.handleCommand(UI_COMMANDS.OPEN_MODEL_PICKER).catch(() => {});
                return;
            }

            if (modal && !editable) {
                if (event.key === "Escape" || (modal.type === "confirm" && event.key === "n")) {
                    event.preventDefault();
                    controller.handleCommand(UI_COMMANDS.CLOSE_MODAL).catch(() => {});
                    return;
                }
                if (event.key === "Enter" || (modal.type === "confirm" && event.key === "y")) {
                    event.preventDefault();
                    controller.handleCommand(UI_COMMANDS.MODAL_CONFIRM).catch(() => {});
                    return;
                }
                if (event.key === "Tab" && event.shiftKey) {
                    event.preventDefault();
                    controller.handleCommand(UI_COMMANDS.MODAL_PANE_PREV).catch(() => {});
                    return;
                }
                if (event.key === "Tab") {
                    event.preventDefault();
                    controller.handleCommand(UI_COMMANDS.MODAL_PANE_NEXT).catch(() => {});
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

            if (editable) {
                if (promptOverlayOpen && event.key === "Escape") {
                    event.preventDefault();
                    onClosePromptOverlay?.();
                    return;
                }
                return;
            }

            if (event.key === "r" && isPlainShortcut && focusRegion !== "prompt") {
                event.preventDefault();
                controller.handleCommand(UI_COMMANDS.REFRESH).catch(() => {});
                return;
            }
            if (event.key === "n" && isPlainShortcut) {
                event.preventDefault();
                controller.handleCommand(UI_COMMANDS.NEW_SESSION).catch(() => {});
                return;
            }
            if (
                focusRegion === "inspector"
                && currentInspectorTab === "files"
                && (
                    (event.key === "u" && isPlainShortcut)
                    || ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "a")
                )
            ) {
                event.preventDefault();
                controller.handleCommand(UI_COMMANDS.OPEN_ARTIFACT_UPLOAD).catch(() => {});
                return;
            }
            if (focusRegion === "inspector" && currentInspectorTab === "files" && event.key === "a" && isPlainShortcut) {
                event.preventDefault();
                controller.handleCommand(UI_COMMANDS.DOWNLOAD_SELECTED_FILE).catch(() => {});
                return;
            }
            if (focusRegion === "inspector" && currentInspectorTab === "files" && event.key === "o" && isPlainShortcut) {
                event.preventDefault();
                controller.handleCommand(UI_COMMANDS.OPEN_SELECTED_FILE).catch(() => {});
                return;
            }
            if (focusRegion === "inspector" && currentInspectorTab === "files" && event.key === "f" && isPlainShortcut) {
                event.preventDefault();
                controller.handleCommand(UI_COMMANDS.OPEN_FILES_FILTER).catch(() => {});
                return;
            }
            if (focusRegion === "inspector" && currentInspectorTab === "stats" && event.key === "f" && isPlainShortcut) {
                event.preventDefault();
                controller.handleCommand(UI_COMMANDS.TOGGLE_STATS_VIEW).catch(() => {});
                return;
            }
            if (focusRegion === "inspector" && currentInspectorTab === "files" && event.key === "v" && isPlainShortcut) {
                event.preventDefault();
                controller.handleCommand(UI_COMMANDS.TOGGLE_FILE_PREVIEW_FULLSCREEN).catch(() => {});
                return;
            }
            if (focusRegion === "inspector" && currentInspectorTab === "logs" && event.key === "t" && isPlainShortcut) {
                event.preventDefault();
                controller.handleCommand(UI_COMMANDS.TOGGLE_LOG_TAIL).catch(() => {});
                return;
            }
            if (focusRegion === "inspector" && currentInspectorTab === "logs" && event.key === "f" && isPlainShortcut) {
                event.preventDefault();
                controller.handleCommand(UI_COMMANDS.OPEN_LOG_FILTER).catch(() => {});
                return;
            }
            if (focusRegion === "inspector" && currentInspectorTab === "history" && event.key === "f" && isPlainShortcut) {
                event.preventDefault();
                controller.handleCommand(UI_COMMANDS.OPEN_HISTORY_FORMAT).catch(() => {});
                return;
            }
            if (focusRegion === "inspector" && currentInspectorTab === "history" && event.key === "r" && isPlainShortcut) {
                event.preventDefault();
                controller.handleCommand(UI_COMMANDS.REFRESH_EXECUTION_HISTORY).catch(() => {});
                return;
            }
            if (focusRegion === "inspector" && currentInspectorTab === "history" && event.key === "a" && isPlainShortcut) {
                event.preventDefault();
                controller.handleCommand(UI_COMMANDS.EXPORT_EXECUTION_HISTORY).catch(() => {});
                return;
            }
            if (event.key === "a" && isPlainShortcut) {
                event.preventDefault();
                controller.handleCommand(UI_COMMANDS.OPEN_ARTIFACT_PICKER).catch(() => {});
                return;
            }
            if (event.key === "p" && isPlainShortcut) {
                event.preventDefault();
                if (onOpenPromptOverlay) {
                    onOpenPromptOverlay();
                } else {
                    controller.handleCommand(UI_COMMANDS.FOCUS_PROMPT).catch(() => {});
                }
                return;
            }
            if (event.key === "c" && isPlainShortcut) {
                event.preventDefault();
                controller.handleCommand(UI_COMMANDS.CANCEL_SESSION).catch(() => {});
                return;
            }
            if (event.key === "d" && isPlainShortcut) {
                event.preventDefault();
                controller.handleCommand(UI_COMMANDS.DONE_SESSION).catch(() => {});
                return;
            }
            if (event.key === "D" && event.shiftKey && !event.metaKey && !event.ctrlKey && !event.altKey) {
                event.preventDefault();
                controller.handleCommand(UI_COMMANDS.DELETE_SESSION).catch(() => {});
                return;
            }
            if (event.key === "m" && isPlainShortcut && focusRegion === "inspector") {
                event.preventDefault();
                selectVisibleInspectorTab(1);
                return;
            }
            if (event.key === "[" && isPlainShortcut) {
                event.preventDefault();
                controller.handleCommand(UI_COMMANDS.GROW_LEFT_PANE).catch(() => {});
                return;
            }
            if (event.key === "]" && isPlainShortcut) {
                event.preventDefault();
                controller.handleCommand(UI_COMMANDS.GROW_RIGHT_PANE).catch(() => {});
                return;
            }
            if (event.key === "{" && isPlainShortcut) {
                event.preventDefault();
                controller.handleCommand(UI_COMMANDS.SHRINK_SESSION_PANE).catch(() => {});
                return;
            }
            if (event.key === "}" && isPlainShortcut) {
                event.preventDefault();
                controller.handleCommand(UI_COMMANDS.GROW_SESSION_PANE).catch(() => {});
                return;
            }
            if (focusRegion === "inspector" && event.key === "ArrowLeft") {
                event.preventDefault();
                selectVisibleInspectorTab(-1);
                return;
            }
            if (focusRegion === "inspector" && event.key === "ArrowRight") {
                event.preventDefault();
                selectVisibleInspectorTab(1);
                return;
            }
            if (focusRegion === "sessions" && (event.key === "ArrowUp" || event.key === "k")) {
                event.preventDefault();
                controller.handleCommand(UI_COMMANDS.MOVE_SESSION_UP).catch(() => {});
                return;
            }
            if (focusRegion === "sessions" && (event.key === "ArrowDown" || event.key === "j")) {
                event.preventDefault();
                controller.handleCommand(UI_COMMANDS.MOVE_SESSION_DOWN).catch(() => {});
                return;
            }
            if (focusRegion === "sessions" && (event.key === "PageUp" || (event.ctrlKey && event.key.toLowerCase() === "u"))) {
                event.preventDefault();
                controller.handleCommand(UI_COMMANDS.PAGE_UP).catch(() => {});
                return;
            }
            if (focusRegion === "sessions" && (event.key === "PageDown" || (event.ctrlKey && event.key.toLowerCase() === "d"))) {
                event.preventDefault();
                controller.handleCommand(UI_COMMANDS.PAGE_DOWN).catch(() => {});
                return;
            }
            if (focusRegion === "sessions" && event.key === "t" && isPlainShortcut) {
                event.preventDefault();
                controller.handleCommand(UI_COMMANDS.OPEN_RENAME_SESSION).catch(() => {});
                return;
            }
            if (!mobile && (event.key === "PageUp" || (event.ctrlKey && event.key.toLowerCase() === "u"))) {
                event.preventDefault();
                controller.handleCommand(UI_COMMANDS.PAGE_UP).catch(() => {});
                return;
            }
            if (!mobile && (event.key === "PageDown" || (event.ctrlKey && event.key.toLowerCase() === "d"))) {
                event.preventDefault();
                controller.handleCommand(UI_COMMANDS.PAGE_DOWN).catch(() => {});
                return;
            }
            if (!mobile && event.key === "g" && isPlainShortcut) {
                event.preventDefault();
                controller.handleCommand(UI_COMMANDS.SCROLL_TOP).catch(() => {});
                return;
            }
            if (!mobile && event.key === "G" && event.shiftKey && !event.metaKey && !event.ctrlKey && !event.altKey) {
                event.preventDefault();
                controller.handleCommand(UI_COMMANDS.SCROLL_BOTTOM).catch(() => {});
                return;
            }
            if (focusRegion !== "prompt" && event.key === "h" && isPlainShortcut) {
                event.preventDefault();
                controller.handleCommand(UI_COMMANDS.FOCUS_LEFT).catch(() => {});
                return;
            }
            if (focusRegion !== "prompt" && event.key === "l" && isPlainShortcut) {
                event.preventDefault();
                controller.handleCommand(UI_COMMANDS.FOCUS_RIGHT).catch(() => {});
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
    }, [controller, legendOpen, mobile, onCloseLegend, onToggleLegend, onClosePromptOverlay, onOpenPromptOverlay, promptOverlayOpen]);
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
    const [showKeyLegend, setShowKeyLegend] = React.useState(false);
    const [showPromptOverlay, setShowPromptOverlay] = React.useState(false);
    const [chatFocusMode, setChatFocusMode] = React.useState(() => readStoredChatFocusMode());
    const [chatFocusPane, setChatFocusPane] = React.useState(null);
    const state = useControllerSelector(controller, (rootState) => ({
        themeId: rootState.ui.themeId,
        promptRows: getStatePromptRows(rootState),
        paneAdjust: rootState.ui.layout?.paneAdjust ?? 0,
        sessionPaneAdjust: rootState.ui.layout?.sessionPaneAdjust ?? 0,
        focusRegion: rootState.ui.focusRegion,
        inspectorTab: rootState.ui.inspectorTab,
        filesFullscreen: Boolean(rootState.files.fullscreen),
    }), shallowEqualObject);
    const [mobilePane, setMobilePane] = React.useState("workspace");
    const [mobileSessionsCollapsed, setMobileSessionsCollapsed] = React.useState(false);
    const mobile = (viewport.width || window.innerWidth || 0) < MOBILE_BREAKPOINT;
    const canUploadArtifacts = supportsBrowserFileUploads(controller) || supportsPathArtifactUploads(controller);
    const canOpenLocally = supportsLocalFileOpen(controller);
    const openPromptOverlay = React.useCallback(() => {
        controller.handleCommand(UI_COMMANDS.FOCUS_PROMPT).catch(() => {});
        setShowPromptOverlay(true);
    }, [controller]);
    const closePromptOverlay = React.useCallback(() => {
        setShowPromptOverlay(false);
    }, []);

    useKeyboardShortcuts(controller, mobile, {
        legendOpen: showKeyLegend,
        onToggleLegend: () => setShowKeyLegend((current) => !current),
        onCloseLegend: () => setShowKeyLegend(false),
        promptOverlayOpen: showPromptOverlay,
        onOpenPromptOverlay: openPromptOverlay,
        onClosePromptOverlay: closePromptOverlay,
    });

    React.useEffect(() => {
        controller.setViewport(gridViewport);
    }, [controller, gridViewport.height, gridViewport.width]);

    React.useEffect(() => {
        applyDocumentTheme(state.themeId);
        writeStoredThemeId(state.themeId);
    }, [state.themeId]);

    React.useEffect(() => {
        writeStoredChatFocusMode(chatFocusMode);
    }, [chatFocusMode]);

    React.useEffect(() => {
        if (mobile && state.focusRegion !== "prompt") {
            setMobilePane(state.focusRegion === "activity"
                ? "activity"
                : state.focusRegion === "inspector"
                    ? "inspector"
                    : "workspace");
        }
    }, [mobile, state.focusRegion]);

    React.useEffect(() => {
        const visibleTabs = getVisibleInspectorTabs(controller);
        if (!visibleTabs.includes(state.inspectorTab) && visibleTabs.length > 0) {
            controller.selectInspectorTab(visibleTabs[0]).catch(() => {});
        }
    }, [controller, state.inspectorTab]);

    const layout = React.useMemo(
        () => computeLegacyLayout(gridViewport, state.paneAdjust, state.promptRows, state.sessionPaneAdjust),
        [gridViewport, state.paneAdjust, state.promptRows, state.sessionPaneAdjust],
    );
    const filesFullscreenActive = state.filesFullscreen && state.inspectorTab === "files";

    React.useEffect(() => {
        if (!filesFullscreenActive || !chatFocusMode) return;
        setChatFocusMode(false);
        setChatFocusPane(null);
    }, [chatFocusMode, filesFullscreenActive]);

    const toggleChatFocusMode = React.useCallback(() => {
        setChatFocusMode((current) => {
            const next = !current;
            if (!next) {
                setChatFocusPane(null);
            } else {
                controller.setFocus("chat");
            }
            return next;
        });
    }, [controller]);

    const toggleChatFocusPane = React.useCallback((paneId) => {
        setChatFocusPane((current) => {
            const next = current === paneId ? null : paneId;
            controller.setFocus(next || "chat");
            return next;
        });
    }, [controller]);

    const desktopWorkspace = React.createElement("div", {
        className: "ps-workspace-grid",
        style: {
            gridTemplateColumns: `minmax(0, ${layout.leftWidth}fr) 16px minmax(0, ${layout.rightWidth}fr)`,
        },
    },
    React.createElement("div", {
        className: "ps-workspace-column",
        style: { gridTemplateRows: `${layout.sessionPaneHeight}fr 16px ${layout.chatPaneHeight}fr` },
    },
    React.createElement(SessionPane, { controller }),
    React.createElement(RowResizeHandle, { controller, sessionPaneAdjust: state.sessionPaneAdjust }),
    React.createElement(ChatPane, { controller })),
    React.createElement(ColumnResizeHandle, { controller, paneAdjust: state.paneAdjust }),
    React.createElement("div", {
        className: "ps-workspace-column",
        style: { gridTemplateRows: `${layout.inspectorPaneHeight}fr ${layout.activityPaneHeight}fr` },
    },
    React.createElement(InspectorPane, { controller, mobile: false }),
    React.createElement(ActivityPane, { controller })));
    const chatFocusWorkspace = React.createElement(ChatFocusWorkspace, {
        controller,
        openPane: chatFocusPane,
        onTogglePane: toggleChatFocusPane,
        onExitFocus: toggleChatFocusMode,
        mobile,
    });
    const fullscreenWorkspace = React.createElement("div", { className: "ps-workspace-full" },
        React.createElement(InspectorPane, { controller, mobile: false }));

    let mobileContent = null;
    if (filesFullscreenActive) mobileContent = React.createElement("div", { className: "ps-mobile-pane-fill" },
        React.createElement(InspectorPane, { controller, mobile: true }));
    else if (mobilePane === "inspector") mobileContent = React.createElement("div", { className: "ps-mobile-pane-fill" },
        React.createElement(InspectorPane, { controller, mobile: true }));
    else if (mobilePane === "activity") mobileContent = React.createElement("div", { className: "ps-mobile-pane-fill" },
        React.createElement(ActivityPane, { controller }));
    else mobileContent = React.createElement(MobileWorkspace, {
        controller,
        sessionsCollapsed: mobileSessionsCollapsed,
        setSessionsCollapsed: setMobileSessionsCollapsed,
    });

    return React.createElement("div", { ref: viewportRef, className: "ps-web-shell" },
        // Hide the top toolbar on mobile inspector/activity panes (and in
        // chat-focus mode). Those panes are pure read-only surfaces;
        // session/model/theme actions stay reachable from the Main pane,
        // and dropping the toolbar buys ~3 lines of vertical real estate
        // on a phone, which matters for the fleet-skills card and the
        // logs/sequence inspectors.
        (mobile && (chatFocusMode || mobilePane === "inspector" || mobilePane === "activity"))
            ? null
            : React.createElement(Toolbar, {
            controller,
            mobile,
            onToggleLegend: () => setShowKeyLegend((current) => !current),
            onOpenPrompt: openPromptOverlay,
            chatFocusMode,
            onToggleChatFocus: toggleChatFocusMode,
            chatFocusDisabled: filesFullscreenActive,
        }),
        React.createElement("div", { className: "ps-workspace" },
            filesFullscreenActive
                ? fullscreenWorkspace
                : (chatFocusMode
                    ? chatFocusWorkspace
                    : (mobile ? mobileContent : desktopWorkspace))),
        // Hide the prompt composer on mobile when on the inspector or
        // activity pane. Those panes are read-only inspection surfaces;
        // the prompt is only useful in the Main pane. Hiding it gives
        // the inspector roughly 5 more lines of vertical real estate on
        // a phone.
        (mobile && !chatFocusMode && (mobilePane === "inspector" || mobilePane === "activity"))
            ? null
            : React.createElement("div", { className: "ps-footer-shell" },
                React.createElement(PromptComposer, { controller, mobile, active: !showPromptOverlay })),
        mobile && !chatFocusMode ? React.createElement(MobileNav, { activePane: mobilePane, setActivePane: setMobilePane, controller }) : null,
        React.createElement(ModalLayer, { controller }),
        React.createElement(KeybindingLegend, {
            open: showKeyLegend,
            onClose: () => setShowKeyLegend(false),
            canUpload: canUploadArtifacts,
            canOpenLocally,
        }),
        React.createElement(PromptOverlay, {
            controller,
            open: showPromptOverlay,
            onClose: closePromptOverlay,
        }));
}
