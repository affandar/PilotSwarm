// Column layout for fit-width markdown / chat tables. Lives in ui-core so
// the algorithm can be unit-tested without a DOM; web-app.js renders the
// result as a <colgroup> of percentages plus a min-width in ch.
//
// Terminology: the FLEX column is the one prose-like column that wraps to
// absorb overflow; every other column is RIGID and keeps its content width.

export function normalizeTableCellText(value = "") {
    return String(value || "")
        .replace(/\s+/g, " ")
        .trim();
}

const FIT_WIDTH_FLEX_HEADER_KEYWORDS = [
    "description",
    "mechanism",
    "details",
    "notes",
    "summary",
    "message",
    "comment",
    "reason",
    "body",
    "content",
    "explanation",
    "rationale",
    "one-liner",
];

const FIT_WIDTH_FLEX_MIN_MAX_LEN = 24;
const FIT_WIDTH_RIGID_CHAR_CAP = 32;
const FIT_WIDTH_MIN_RIGID_CHARS = 6;
const FIT_WIDTH_FLEX_MIN_CHARS = 30;
const FIT_WIDTH_FLEX_MAX_CHARS = 56;
const FIT_WIDTH_FLEX_MIN_FRACTION = 0.4;
const FIT_WIDTH_FLEX_TO_RIGID_RATIO = 1.4;
const FIT_WIDTH_MIN_EXTRA_CHARS = 2;

/**
 * Compute per-column layout for a fit-width markdown / chat table.
 *
 * Strategy:
 *   1. Measure max cell length and "wrappability" (cells with whitespace) per column.
 *   2. Identify a single "flex" column — long, prose-like, ideally with a
 *      header keyword like Description / Mechanism / Notes. This column
 *      absorbs overflow by wrapping aggressively.
 *   3. Give every other column a budget = clamp(maxLen + padding, MIN, RIGID_CAP),
 *      so rigid columns stay at their content-fit width even when one
 *      sibling column has hundreds of characters of prose.
 *   4. Give the flex column a bounded share of the rigid-column budget. A
 *      very long cell should wrap; it should not steal so much percentage
 *      width that compact columns like Count / Status collapse on phones.
 *   5. Return a minimum table width in ch so the wrapper can scroll
 *      horizontally rather than forcing all columns below readable size.
 *
 * Returns { widths: ["12.34%", ...], flexIndex: number, minWidth: "64ch" }
 * when a flex column is identified — the table renderer then forces
 * table-layout: fixed, adds an `is-flex-column` class to the chosen column,
 * and gives the table a readable minimum width. Returns null when no flex
 * column is found, in which case the renderer falls back to the browser's
 * auto-table-layout (which is already good for short / uniform tables).
 *
 * Background: the previous behavior used the browser's auto-table-layout
 * unconditionally. That works well when columns are uniform but is biased
 * toward wide columns when one column has prose hundreds of characters
 * long (e.g. a Mechanism / Description column) — auto-layout distributes
 * width proportional to (max-content − min-content), which lets the prose
 * column squeeze the rigid columns down to a few characters each.
 */
export function computeFitWidthColumnLayout(rows = []) {
    const columnCount = Math.max(0, ...rows.map((row) => row.length));
    if (columnCount <= 0) return null;

    const headerRow = rows[0] || [];
    const dataRowCount = Math.max(1, rows.length - 1);

    const stats = Array.from({ length: columnCount }, () => ({
        max: 0,
        // Longest run without whitespace. A rigid column wraps at spaces
        // only, so this is the narrowest it can be drawn without breaking
        // a word — a 60-char CamelCase test name, a URL, a hash.
        longestToken: 0,
        spaceCells: 0,
    }));
    for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
        const row = rows[rowIndex];
        for (let columnIndex = 0; columnIndex < columnCount; columnIndex += 1) {
            const text = normalizeTableCellText(row[columnIndex] || "");
            if (text.length > stats[columnIndex].max) stats[columnIndex].max = text.length;
            if (rowIndex > 0 && /\s/.test(text)) stats[columnIndex].spaceCells += 1;
            for (const token of text.split(/\s+/)) {
                if (token.length > stats[columnIndex].longestToken) stats[columnIndex].longestToken = token.length;
            }
        }
    }

    let flexIndex = -1;
    let flexScore = 0;
    for (let columnIndex = 0; columnIndex < columnCount; columnIndex += 1) {
        const stat = stats[columnIndex];
        if (stat.max < FIT_WIDTH_FLEX_MIN_MAX_LEN) continue;
        const spaceRatio = stat.spaceCells / dataRowCount;
        if (spaceRatio < 0.4) continue;
        const headerText = normalizeTableCellText(headerRow[columnIndex] || "").toLowerCase();
        const headerBonus = FIT_WIDTH_FLEX_HEADER_KEYWORDS.some((keyword) => headerText.includes(keyword)) ? 60 : 0;
        const score = stat.max + headerBonus;
        if (score > flexScore) {
            flexScore = score;
            flexIndex = columnIndex;
        }
    }

    if (flexIndex < 0) return null;

    const rigidBudgets = stats.map((stat, columnIndex) => {
        if (columnIndex === flexIndex) return 0;
        // The cap keeps a column of many short words from hogging width; it
        // must never cut a single word. Under the fixed layout a rigid cell
        // wraps at spaces only, so a budget below the longest token painted
        // that token across the next column. The floor makes the table's
        // min-width grow instead — past the pane, the wrapper scrolls.
        return Math.max(
            FIT_WIDTH_MIN_RIGID_CHARS,
            Math.min(stat.max + 2, FIT_WIDTH_RIGID_CHAR_CAP),
            stat.longestToken + 2,
        );
    });
    const sumRigid = rigidBudgets.reduce((sum, value) => sum + value, 0);
    const flexStat = stats[flexIndex];
    const flexBudget = Math.max(
        FIT_WIDTH_FLEX_MIN_CHARS,
        Math.min(
            flexStat.max * 0.45,
            FIT_WIDTH_FLEX_MAX_CHARS,
            Math.max(FIT_WIDTH_FLEX_MIN_CHARS, sumRigid * FIT_WIDTH_FLEX_TO_RIGID_RATIO),
        ),
    );
    const budgets = rigidBudgets.map((value, columnIndex) => (
        columnIndex === flexIndex ? flexBudget : value
    ));

    const totalBudget = budgets.reduce((sum, value) => sum + value, 0);
    if (totalBudget > 0 && budgets[flexIndex] / totalBudget < FIT_WIDTH_FLEX_MIN_FRACTION) {
        const sumRigid = totalBudget - budgets[flexIndex];
        budgets[flexIndex] = sumRigid * (FIT_WIDTH_FLEX_MIN_FRACTION / (1 - FIT_WIDTH_FLEX_MIN_FRACTION));
    }

    const finalTotal = budgets.reduce((sum, value) => sum + value, 0);
    if (!(finalTotal > 0)) return null;
    return {
        widths: budgets.map((value) => `${((value / finalTotal) * 100).toFixed(2)}%`),
        flexIndex,
        minWidth: `${Math.ceil(finalTotal + FIT_WIDTH_MIN_EXTRA_CHARS)}ch`,
    };
}
