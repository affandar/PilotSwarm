import { describe, it } from "vitest";
import { parseMarkdownLines } from "../../../ui-core/src/formatting.js";
import { assert, assertEqual } from "../helpers/assertions.js";

describe("parseMarkdownLines tableMode", () => {
    const tableSource = [
        "Some intro text.",
        "",
        "| ID | Link |",
        "| --- | --- |",
        "| 5168910 | [5168910](https://dev.azure.com/edit/5168910) |",
        "| 5175869 | [5175869](https://dev.azure.com/edit/5175869) |",
        "",
        "Trailing text.",
    ].join("\n");

    it("default boxArt mode renders tables as flat run lines (TUI)", () => {
        const lines = parseMarkdownLines(tableSource, { width: 80 });
        // Should NOT contain a sentinel line.
        const sentinel = lines.find((line) => line?.kind === "markdownTable");
        assert(!sentinel, "boxArt mode should not emit markdownTable sentinel");
        // Should contain box-drawing characters from the rendered table.
        const flat = lines.map((line) => Array.isArray(line)
            ? line.map((run) => run?.text || "").join("")
            : (line?.text || "")).join("\n");
        assert(flat.includes("┌") || flat.includes("│"),
            "boxArt mode should render box-drawing table characters");
    });

    it("default boxArt mode renders compact readable TUI tables", () => {
        const source = [
            "| # | Title | Points | Comments | Δ | Topic |",
            "|---|---|---:|---:|---:|---|",
            "| 1 | Mercedes-Benz commits to bringing back physical buttons | 518 | 397 | +2 | Tech/UX |",
            "| 9 | [I recreated the Apple Lisa inside an FPGA](https://www.youtube.com/watch?v=8jNQDcpHc68) | 50 | 5 | new | Hardware/Retro |",
            "| 10 | US-Indian space mission maps subsidence in Mexico City | 40 | 14 | +1 | Science |",
        ].join("\n");
        const lines = parseMarkdownLines(source, { width: 84 });
        const flat = lines.map((line) => Array.isArray(line)
            ? line.map((run) => run?.text || "").join("")
            : (line?.text || "")).join("\n");

        assert(flat.includes("I recreated the Apple Lisa"), "link cells should render the readable link label");
        assert(!flat.includes("https://www.youtube.com"), "link cells should not size or render from the raw URL");
        const dividerCount = (flat.match(/├/g) || []).length;
        assertEqual(dividerCount, 1, "TUI table should only draw the header divider, not one divider per body row");
        for (const line of flat.split("\n")) {
            assert(line.length <= 84, `rendered table line should fit width: ${line}`);
        }
    });

    it("sentinel mode emits a markdownTable line preserving cell markdown", () => {
        const lines = parseMarkdownLines(tableSource, { width: 80, tableMode: "sentinel" });
        const sentinel = lines.find((line) => line?.kind === "markdownTable");
        assert(sentinel, "sentinel mode should emit a markdownTable line");
        assertEqual(sentinel.header.length, 2, "header should have 2 columns");
        assertEqual(sentinel.header[0], "ID");
        assertEqual(sentinel.header[1], "Link");
        assertEqual(sentinel.rows.length, 2, "should have 2 body rows");
        // Critical: cell content preserves the [label](url) markdown so the
        // portal renderer can later re-tokenize it into a clickable link.
        assertEqual(sentinel.rows[0][0], "5168910");
        assertEqual(sentinel.rows[0][1], "[5168910](https://dev.azure.com/edit/5168910)",
            "markdown link inside cell must survive intact in sentinel mode");
        assertEqual(sentinel.rows[1][1], "[5175869](https://dev.azure.com/edit/5175869)");
    });

    it("sentinel mode does not break non-table content", () => {
        const lines = parseMarkdownLines("Hello **world**", { width: 80, tableMode: "sentinel" });
        assert(Array.isArray(lines[0]), "non-table lines stay as run arrays");
        const flat = lines.map((line) => Array.isArray(line)
            ? line.map((run) => run?.text || "").join("")
            : "").join("");
        assert(flat.includes("world"), "inline content rendered");
    });

    it("sentinel mode skips table detection inside code fences", () => {
        const source = [
            "```",
            "| not | a |",
            "| --- | --- |",
            "| real | table |",
            "```",
        ].join("\n");
        const lines = parseMarkdownLines(source, { width: 80, tableMode: "sentinel" });
        const sentinel = lines.find((line) => line?.kind === "markdownTable");
        assert(!sentinel, "code-fence content should not be parsed as a table");
    });
});
