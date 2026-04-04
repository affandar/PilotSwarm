const STYLE_TAG_RE = /\{(\/?)([a-z-]+)\}/g;

const DEFAULT_STYLE = {
    color: null,
    bold: false,
    underline: false,
};

const ARTIFACT_URI_RE = /artifact:\/\/([a-f0-9-]+)\/([^\s"'{}]+)/g;

const COLOR_NAME_MAP = {
    black: "black",
    red: "red",
    green: "green",
    yellow: "yellow",
    blue: "blue",
    magenta: "magenta",
    cyan: "cyan",
    white: "white",
    gray: "gray",
    grey: "gray",
};

function cloneStyle(style) {
    return {
        color: style.color,
        bold: style.bold,
        underline: style.underline,
    };
}

function applyStyleTag(style, tagName, closing) {
    const next = cloneStyle(style);
    if (tagName === "bold") {
        next.bold = !closing;
        return next;
    }
    if (tagName === "underline") {
        next.underline = !closing;
        return next;
    }
    if (tagName.endsWith("-fg")) {
        const colorName = tagName.slice(0, -3);
        next.color = closing ? null : (COLOR_NAME_MAP[colorName] || null);
        return next;
    }
    return next;
}

export function stripTerminalMarkupTags(input) {
    return String(input || "").replace(STYLE_TAG_RE, "");
}

export function parseTerminalMarkupRuns(input) {
    const lines = [];
    const source = String(input || "");
    const rawLines = source.split("\n");

    for (const rawLine of rawLines) {
        const lineRuns = [];
        let style = cloneStyle(DEFAULT_STYLE);
        let cursor = 0;
        let match;

        while ((match = STYLE_TAG_RE.exec(rawLine)) !== null) {
            const [fullMatch, slash, tagName] = match;
            if (match.index > cursor) {
                lineRuns.push({
                    text: rawLine.slice(cursor, match.index),
                    ...cloneStyle(style),
                });
            }
            style = applyStyleTag(style, tagName, slash === "/");
            cursor = match.index + fullMatch.length;
        }

        if (cursor < rawLine.length || lineRuns.length === 0) {
            lineRuns.push({
                text: rawLine.slice(cursor),
                ...cloneStyle(style),
            });
        }

        lines.push(lineRuns);
        STYLE_TAG_RE.lastIndex = 0;
    }

    return lines;
}

export function shortSessionId(sessionId) {
    const value = String(sessionId || "");
    return value.slice(0, 8);
}

export function shortModelName(model) {
    const value = String(model || "");
    if (!value) return "";
    return value.includes(":") ? value.split(":").slice(1).join(":") : value;
}

export function formatTimestamp(value) {
    if (!value) return "";
    try {
        const date = value instanceof Date ? value : new Date(value);
        return date.toLocaleTimeString(undefined, {
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
            hour12: false,
        });
    } catch {
        return "";
    }
}

export function formatDisplayDateTime(value, opts = {}) {
    if (!value) return "";
    try {
        const date = value instanceof Date ? value : new Date(value);
        return date.toLocaleString("en-GB", {
            month: "short",
            day: "numeric",
            hour: "2-digit",
            minute: "2-digit",
            hour12: false,
            ...opts,
        });
    } catch {
        return "";
    }
}

export function formatHumanDurationSeconds(value) {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return "?";
    const totalSeconds = Math.round(value);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;

    if (hours > 0) return `${hours}h ${minutes}m`;
    if (minutes > 0) return `${minutes}m ${seconds}s`;
    return `${seconds}s`;
}

export function summarizeJson(value) {
    if (value == null) return "";
    if (typeof value === "string") return value;
    try {
        return JSON.stringify(value);
    } catch {
        return String(value);
    }
}

function findClosingDelimiter(source, delimiter, startIndex) {
    const nextIndex = source.indexOf(delimiter, startIndex);
    return nextIndex >= 0 ? nextIndex : -1;
}

function countRepeatedDelimiter(source, delimiter, startIndex) {
    let count = 0;
    while (source.slice(startIndex + count, startIndex + count + delimiter.length) === delimiter) {
        count += delimiter.length;
    }
    return count;
}

function pushTextRun(runs, text, style = {}) {
    if (!text) return;
    const lastRun = runs[runs.length - 1];
    if (lastRun
        && lastRun.color === (style.color || null)
        && Boolean(lastRun.bold) === Boolean(style.bold)
        && Boolean(lastRun.underline) === Boolean(style.underline)
        && lastRun.backgroundColor === style.backgroundColor) {
        lastRun.text += text;
        return;
    }
    runs.push({
        text,
        color: style.color || null,
        bold: Boolean(style.bold),
        underline: Boolean(style.underline),
        backgroundColor: style.backgroundColor || undefined,
    });
}

function flattenRunsText(runs) {
    return (runs || []).map((run) => run?.text || "").join("");
}

function measureRunsWidth(runs) {
    return displayWidth(flattenRunsText(runs));
}

function fitRunsToDisplayWidth(runs, maxWidth) {
    const safeWidth = Math.max(0, Number(maxWidth) || 0);
    if (safeWidth <= 0) return [];

    const output = [];
    let remaining = safeWidth;

    for (const run of runs || []) {
        if (remaining <= 0) break;
        const text = String(run?.text || "");
        if (!text) continue;
        const chunk = sliceTextToDisplayWidth(text, remaining);
        if (!chunk) continue;
        output.push({
            ...run,
            text: chunk,
        });
        remaining -= displayWidth(chunk);
    }

    return output;
}

function padRunsToDisplayWidth(runs, width) {
    const safeWidth = Math.max(0, Number(width) || 0);
    const fitted = fitRunsToDisplayWidth(runs, safeWidth);
    const used = measureRunsWidth(fitted);
    const padding = Math.max(0, safeWidth - used);
    if (padding > 0) {
        fitted.push({ text: " ".repeat(padding), color: null, bold: false, underline: false });
    }
    return fitted;
}

function wrapRunsToDisplayWidth(runs, width) {
    const safeWidth = Math.max(1, Number(width) || 1);
    const wrapped = [];
    let currentRuns = [];
    let currentWidth = 0;

    function flushCurrentLine() {
        if (currentRuns.length === 0) {
            wrapped.push([{ text: "", color: null, bold: false, underline: false }]);
            return;
        }
        wrapped.push(currentRuns);
        currentRuns = [];
        currentWidth = 0;
    }

    for (const run of runs || []) {
        let remainingText = String(run?.text || "");
        if (!remainingText) continue;

        while (remainingText.length > 0) {
            const spaceLeft = Math.max(1, safeWidth - currentWidth);
            const hardChunk = sliceTextToDisplayWidth(remainingText, spaceLeft);
            if (!hardChunk) break;

            // If the hard slice fits the entire remaining text, or it ends
            // at a natural break, just use it as-is.
            if (hardChunk.length === remainingText.length || displayWidth(hardChunk) < spaceLeft) {
                currentRuns.push({ ...run, text: hardChunk });
                currentWidth += displayWidth(hardChunk);
                remainingText = remainingText.slice(hardChunk.length);
                if (currentWidth >= safeWidth) flushCurrentLine();
                continue;
            }

            // The chunk fills the line — try to find a word boundary to break at.
            const lastSpace = hardChunk.lastIndexOf(" ");
            if (lastSpace > 0 && (currentWidth > 0 || lastSpace > 0)) {
                // Break at the last space: include the space on this line, then wrap.
                const softChunk = hardChunk.slice(0, lastSpace + 1);
                currentRuns.push({ ...run, text: softChunk });
                currentWidth += displayWidth(softChunk);
                remainingText = remainingText.slice(softChunk.length);
                flushCurrentLine();
            } else {
                // No space found (single long word) — fall back to hard break.
                currentRuns.push({ ...run, text: hardChunk });
                currentWidth += displayWidth(hardChunk);
                remainingText = remainingText.slice(hardChunk.length);
                if (currentWidth >= safeWidth) flushCurrentLine();
            }
        }
    }

    if (currentRuns.length > 0 || wrapped.length === 0) {
        flushCurrentLine();
    }

    return wrapped;
}

function recolorRuns(runs, color) {
    if (!color) return runs;
    return (runs || []).map((run) => {
        const text = String(run?.text || "");
        if (!text.trim()) return { ...run };
        return {
            ...run,
            color,
        };
    });
}

export function normalizeArtifactFilename(filename) {
    if (!filename) return filename;

    let normalized = String(filename);
    while (true) {
        const next = normalized
            .replace(/[*_`]+$/g, "")
            .replace(/[)\]}>!,;:?]+$/g, "")
            .replace(/(\.[A-Za-z0-9]{1,16})\.+$/g, "$1");
        if (next === normalized) return normalized;
        normalized = next;
    }
}

export function extractArtifactLinks(text) {
    const source = String(text || "");
    ARTIFACT_URI_RE.lastIndex = 0;
    return [...source.matchAll(ARTIFACT_URI_RE)]
        .map((match) => {
            const sessionId = match[1];
            const filename = normalizeArtifactFilename(match[2]);
            if (!sessionId || !filename) return null;
            return {
                sessionId,
                filename,
                uri: `artifact://${sessionId}/${filename}`,
            };
        })
        .filter(Boolean);
}

export function decorateArtifactLinksForChat(text) {
    const source = String(text || "");
    if (!source) return source;
    ARTIFACT_URI_RE.lastIndex = 0;
    return source.replace(ARTIFACT_URI_RE, (_match, sessionId, rawFilename) => {
        const filename = normalizeArtifactFilename(rawFilename);
        if (!sessionId || !filename) return _match;
        return `[artifact: ${filename}](artifact://${sessionId}/${filename}) (press a to download)`;
    });
}

function parseInlineMarkdownRuns(source) {
    const text = String(source || "");
    const runs = [];
    let index = 0;

    while (index < text.length) {
        if (text[index] === "`") {
            const tickCount = countRepeatedDelimiter(text, "`", index);
            const delimiter = "`".repeat(tickCount);
            const closeIndex = findClosingDelimiter(text, delimiter, index + tickCount);
            if (closeIndex > index + tickCount - 1) {
                pushTextRun(runs, text.slice(index + tickCount, closeIndex), { color: "cyan" });
                index = closeIndex + tickCount;
                continue;
            }
        }

        if (text.startsWith("**", index) || text.startsWith("__", index)) {
            const delimiter = text.slice(index, index + 2);
            const closeIndex = findClosingDelimiter(text, delimiter, index + 2);
            if (closeIndex > index + 2) {
                pushTextRun(runs, text.slice(index + 2, closeIndex), { bold: true });
                index = closeIndex + 2;
                continue;
            }
        }

        if (text[index] === "[") {
            const match = /^\[([^\]]+)\]\(([^)]+)\)/.exec(text.slice(index));
            if (match) {
                pushTextRun(runs, match[1], { color: "cyan", underline: true });
                index += match[0].length;
                continue;
            }
        }

        if ((text[index] === "*" || text[index] === "_")
            && text[index + 1] !== " "
            && text[index - 1] !== text[index]) {
            const delimiter = text[index];
            const closeIndex = findClosingDelimiter(text, delimiter, index + 1);
            if (closeIndex > index + 1) {
                pushTextRun(runs, text.slice(index + 1, closeIndex), { underline: true });
                index = closeIndex + 1;
                continue;
            }
        }

        let nextIndex = text.length;
        for (const marker of ["**", "__", "`", "[", "*", "_"]) {
            const candidate = text.indexOf(marker, index + 1);
            if (candidate !== -1 && candidate < nextIndex) {
                nextIndex = candidate;
            }
        }
        pushTextRun(runs, text.slice(index, nextIndex));
        index = nextIndex;
    }

    return runs.length > 0 ? runs : [{ text: "", color: null, bold: false, underline: false }];
}

function isMarkdownTableLine(line) {
    return /^\s*\|.*\|\s*$/.test(line)
        || /^\s*\|?[:\- ]+\|[:\-| ]+\|?\s*$/.test(line);
}

function splitMarkdownTableCells(line) {
    const trimmed = String(line || "").trim().replace(/^\|/, "").replace(/\|$/, "");
    const cells = [];
    let current = "";
    let escaping = false;

    for (const ch of trimmed) {
        if (escaping) {
            current += ch;
            escaping = false;
            continue;
        }
        if (ch === "\\") {
            escaping = true;
            continue;
        }
        if (ch === "|") {
            cells.push(current.trim());
            current = "";
            continue;
        }
        current += ch;
    }

    cells.push(current.trim());
    return cells;
}

function isMarkdownTableSeparatorRow(cells) {
    return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(String(cell || "").replace(/\s+/g, "")));
}

function displayWidth(value) {
    return Array.from(String(value || "")).length;
}

function sliceTextToDisplayWidth(text, maxWidth) {
    if (maxWidth <= 0) return "";
    let output = "";
    let used = 0;

    for (const ch of Array.from(String(text || ""))) {
        if (used + 1 > maxWidth) break;
        output += ch;
        used += 1;
    }

    return output;
}

function padToDisplayWidth(text, width) {
    const rendered = String(text || "");
    const padding = Math.max(0, width - displayWidth(rendered));
    return rendered + " ".repeat(padding);
}

function flattenInlineMarkdownText(source) {
    return flattenRunsText(parseInlineMarkdownRuns(source));
}

function wrapTableCellText(text, width) {
    const normalized = flattenInlineMarkdownText(text).replace(/\s+/g, " ").trim();
    if (!normalized) return [""];

    const words = normalized.split(" ");
    const lines = [];
    let current = "";

    const appendWord = (word) => {
        let remaining = word;
        while (displayWidth(remaining) > width) {
            const chunk = sliceTextToDisplayWidth(remaining, width);
            if (!chunk) break;
            if (current) {
                lines.push(current);
                current = "";
            }
            lines.push(chunk);
            remaining = remaining.slice(chunk.length);
        }
        return remaining;
    };

    for (const word of words) {
        const fittedWord = appendWord(word);
        if (!fittedWord) continue;
        if (!current) {
            current = fittedWord;
            continue;
        }

        const candidate = `${current} ${fittedWord}`;
        if (displayWidth(candidate) <= width) {
            current = candidate;
        } else {
            lines.push(current);
            current = fittedWord;
        }
    }

    if (current) lines.push(current);
    return lines.length > 0 ? lines : [""];
}

function computeMarkdownTableColumnWidths(rows, maxWidth) {
    const columnCount = Math.max(1, ...rows.map((row) => row.length));
    const availableWidth = Math.max(columnCount * 3, maxWidth - (columnCount * 3 + 1));
    const preferred = Array.from({ length: columnCount }, (_, index) => Math.max(
        3,
        ...rows.map((row) => displayWidth(row[index] || "")),
    ));
    const minimum = Array.from({ length: columnCount }, (_, index) => Math.max(
        3,
        Math.min(displayWidth(rows[0]?.[index] || "") || 3, 18),
    ));

    const totalPreferred = preferred.reduce((sum, width) => sum + width, 0);
    if (totalPreferred <= availableWidth) {
        return preferred;
    }

    const widths = minimum.slice();
    let remaining = availableWidth - widths.reduce((sum, width) => sum + width, 0);

    if (remaining < 0) {
        const evenWidth = Math.max(3, Math.floor(availableWidth / columnCount));
        return widths.map((_, index) => index === columnCount - 1
            ? Math.max(3, availableWidth - evenWidth * (columnCount - 1))
            : evenWidth);
    }

    while (remaining > 0) {
        let bestIndex = 0;
        let bestNeed = -Infinity;
        for (let index = 0; index < columnCount; index++) {
            const need = preferred[index] - widths[index];
            if (need > bestNeed) {
                bestNeed = need;
                bestIndex = index;
            }
        }
        if (bestNeed <= 0) {
            widths[columnCount - 1] += remaining;
            break;
        }
        widths[bestIndex] += 1;
        remaining -= 1;
    }

    return widths;
}

function renderPlainMarkdownTable(rows, maxWidth) {
    if (!rows || rows.length === 0) return "";
    const columnCount = Math.max(1, ...rows.map((row) => row.length));
    const normalizedRows = rows.map((row) => Array.from({ length: columnCount }, (_, index) => row[index] || ""));
    const widths = computeMarkdownTableColumnWidths(normalizedRows, maxWidth);
    const rendered = [];

    const topBorder = `┌${widths.map((width) => "─".repeat(width + 2)).join("┬")}┐`;
    const middleBorder = `├${widths.map((width) => "─".repeat(width + 2)).join("┼")}┤`;
    const bottomBorder = `└${widths.map((width) => "─".repeat(width + 2)).join("┴")}┘`;

    const renderRow = (cells) => {
        const wrappedCells = cells.map((cell, index) => wrapTableCellText(cell, widths[index]));
        const rowHeight = Math.max(...wrappedCells.map((cellLines) => cellLines.length));

        for (let lineIndex = 0; lineIndex < rowHeight; lineIndex++) {
            const parts = wrappedCells.map((cellLines, index) => padToDisplayWidth(cellLines[lineIndex] || "", widths[index]));
            rendered.push(`│ ${parts.join(" │ ")} │`);
        }
    };

    rendered.push(topBorder);
    renderRow(normalizedRows[0]);
    rendered.push(middleBorder);
    for (const row of normalizedRows.slice(1)) {
        renderRow(row);
    }
    rendered.push(bottomBorder);

    return rendered.join("\n");
}

function formatMarkdownTables(input, maxWidth) {
    const lines = String(input || "").split("\n");
    const output = [];
    let inCodeFence = false;

    for (let index = 0; index < lines.length; index++) {
        const line = lines[index];
        const trimmed = line.trim();

        if (trimmed.startsWith("```")) {
            inCodeFence = !inCodeFence;
            output.push(line);
            continue;
        }

        if (inCodeFence) {
            output.push(line);
            continue;
        }

        const nextLine = lines[index + 1];
        if (!isMarkdownTableLine(line) || !isMarkdownTableLine(nextLine)) {
            output.push(line);
            continue;
        }

        const headerCells = splitMarkdownTableCells(line);
        const separatorCells = splitMarkdownTableCells(nextLine);
        if (!isMarkdownTableSeparatorRow(separatorCells) || headerCells.length !== separatorCells.length) {
            output.push(line);
            continue;
        }

        const rows = [headerCells];
        index += 1;
        while (index + 1 < lines.length && isMarkdownTableLine(lines[index + 1])) {
            index += 1;
            const rowCells = splitMarkdownTableCells(lines[index]);
            if (isMarkdownTableSeparatorRow(rowCells)) continue;
            rows.push(rowCells);
        }

        output.push(renderPlainMarkdownTable(rows, maxWidth));
    }

    return output.join("\n");
}

function wrapPlainText(text, width) {
    const source = String(text || "");
    if (!source) return [""];

    const lines = [];
    let remaining = source;
    while (remaining.length > 0) {
        const chunk = sliceTextToDisplayWidth(remaining, width);
        if (!chunk) break;
        lines.push(chunk);
        remaining = remaining.slice(chunk.length);
    }

    return lines.length > 0 ? lines : [""];
}

function buildCodeFenceHeader(language, width) {
    const safeWidth = Math.max(12, width);
    const label = language ? ` ${String(language).trim()} ` : " code ";
    const trimmedLabel = sliceTextToDisplayWidth(label, Math.max(1, safeWidth - 4));
    const fill = Math.max(0, safeWidth - trimmedLabel.length - 2);

    return [{
        text: `┌${trimmedLabel}${"─".repeat(fill)}┐`,
        color: "gray",
    }];
}

function buildCodeFenceFooter(width) {
    return [{
        text: `└${"─".repeat(Math.max(1, width - 2))}┘`,
        color: "gray",
    }];
}

function buildCodeFenceBodyLines(codeLines, width) {
    const safeWidth = Math.max(8, width);
    const bodyWidth = Math.max(1, safeWidth - 2);
    const rendered = [];

    for (const rawLine of codeLines) {
        const wrappedLines = wrapPlainText(rawLine, bodyWidth);
        for (const wrappedLine of wrappedLines) {
            rendered.push([
                { text: "│", color: "gray" },
                { text: padToDisplayWidth(wrappedLine, bodyWidth), color: "cyan" },
                { text: "│", color: "gray" },
            ]);
        }
        if (wrappedLines.length === 0) {
            rendered.push([
                { text: "│", color: "gray" },
                { text: " ".repeat(bodyWidth), color: "cyan" },
                { text: "│", color: "gray" },
            ]);
        }
    }

    if (rendered.length === 0) {
        rendered.push([
            { text: "│", color: "gray" },
            { text: " ".repeat(bodyWidth), color: "cyan" },
            { text: "│", color: "gray" },
        ]);
    }

    return rendered;
}

export function parseMarkdownLines(input, options = {}) {
    const lines = [];
    const maxWidth = Math.max(20, Number(options?.width) || 80);
    const source = formatMarkdownTables(
        String(input || ""),
        maxWidth,
    );
    const rawLines = source.split("\n");
    let inCodeFence = false;
    let codeFenceLanguage = "";
    let codeFenceLines = [];

    for (const rawLine of rawLines) {
        const trimmed = rawLine.trim();
        if (trimmed.startsWith("```")) {
            if (inCodeFence) {
                lines.push(buildCodeFenceHeader(codeFenceLanguage, Math.max(8, maxWidth)));
                lines.push(...buildCodeFenceBodyLines(codeFenceLines, Math.max(8, maxWidth)));
                lines.push(buildCodeFenceFooter(Math.max(8, maxWidth)));
                inCodeFence = false;
                codeFenceLanguage = "";
                codeFenceLines = [];
            } else {
                inCodeFence = true;
                codeFenceLanguage = trimmed.slice(3).trim();
                codeFenceLines = [];
            }
            continue;
        }

        if (inCodeFence) {
            codeFenceLines.push(rawLine);
            continue;
        }

        if (!rawLine) {
            lines.push([{ text: "", color: null }]);
            continue;
        }

        const headingMatch = /^(#{1,6})\s+(.*)$/.exec(rawLine);
        if (headingMatch) {
            lines.push([{ text: headingMatch[2], color: "white", bold: true }]);
            continue;
        }

        const quoteMatch = /^>\s?(.*)$/.exec(rawLine);
        if (quoteMatch) {
            lines.push([
                { text: "> ", color: "gray" },
                ...parseInlineMarkdownRuns(quoteMatch[1]).map((run) => ({
                    ...run,
                    color: run.color || "gray",
                })),
            ]);
            continue;
        }

        const bulletMatch = /^\s*[-*]\s+(.*)$/.exec(rawLine);
        if (bulletMatch) {
            lines.push([
                { text: "• ", color: "gray" },
                ...parseInlineMarkdownRuns(bulletMatch[1]),
            ]);
            continue;
        }

        const numberedListMatch = /^\s*(\d+)\.\s+(.*)$/.exec(rawLine);
        if (numberedListMatch) {
            lines.push([
                { text: `${numberedListMatch[1]}. `, color: "gray" },
                ...parseInlineMarkdownRuns(numberedListMatch[2]),
            ]);
            continue;
        }

        lines.push(parseInlineMarkdownRuns(rawLine));
    }

    if (inCodeFence) {
        lines.push(buildCodeFenceHeader(codeFenceLanguage, Math.max(8, maxWidth)));
        lines.push(...buildCodeFenceBodyLines(codeFenceLines, Math.max(8, maxWidth)));
        lines.push(buildCodeFenceFooter(Math.max(8, maxWidth)));
    }

    return lines;
}

export function buildMessageCardLines({
    title = "SYSTEM",
    timestamp = "",
    body = "",
    width = 80,
    titleColor = "yellow",
    borderColor = "gray",
    bodyColor = null,
    fitToContent = false,
} = {}) {
    const maxWidth = Math.max(fitToContent ? 12 : 20, Number(width) || (fitToContent ? 12 : 20));
    const maxContentWidth = Math.max(1, maxWidth - 4);
    const titleRuns = [
        { text: ` ${String(title || "SYSTEM").toUpperCase()} `, color: titleColor, bold: true },
        ...(timestamp ? [{ text: ` ${String(timestamp)} `, color: "gray" }] : []),
    ];
    const bodyLines = parseMarkdownLines(String(body || ""), { width: maxContentWidth });
    const normalizedBodyLines = bodyLines.length > 0
        ? bodyLines.flatMap((lineRuns) => wrapRunsToDisplayWidth(lineRuns, maxContentWidth))
        : [[{ text: "", color: null }]];
    const tintedBodyLines = bodyColor
        ? normalizedBodyLines.map((lineRuns) => recolorRuns(lineRuns, bodyColor))
        : normalizedBodyLines;
    const widestBodyLine = tintedBodyLines.reduce(
        (max, lineRuns) => Math.max(max, measureRunsWidth(lineRuns)),
        0,
    );
    const safeWidth = fitToContent
        ? Math.min(
            maxWidth,
            Math.max(12, measureRunsWidth(titleRuns) + 3, widestBodyLine + 4),
        )
        : maxWidth;
    const contentWidth = Math.max(1, safeWidth - 4);
    const topFill = Math.max(0, safeWidth - measureRunsWidth(titleRuns) - 3);

    return [
        [
            { text: "┌─", color: borderColor },
            ...titleRuns,
            { text: `${"─".repeat(topFill)}┐`, color: borderColor },
        ],
        ...tintedBodyLines.map((lineRuns) => ([
            { text: "│ ", color: borderColor },
            ...padRunsToDisplayWidth(lineRuns, contentWidth),
            { text: " │", color: borderColor },
        ])),
        [{ text: `└${"─".repeat(Math.max(1, safeWidth - 2))}┘`, color: borderColor }],
        [{ text: "", color: null }],
    ];
}
