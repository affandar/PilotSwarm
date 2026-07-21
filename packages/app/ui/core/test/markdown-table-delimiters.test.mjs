// GFM delimiter rows are `:?-+:?` per cell — one dash is enough, and the
// alignment colon counts toward neither minimum. The detector used to demand
// three dashes, so a model emitting the common right-aligned short form
// (`|---|--:|`) had its whole table demoted to raw pipe text in the chat.
// Shared selectors, so this covers both the portal (sentinel tables) and the
// TUI (box-art tables).
import test from "node:test";
import assert from "node:assert/strict";
import { parseMarkdownLines } from "../src/index.js";

function tableWithDelimiter(delimiterRow) {
    return [
        "| Server | Role | Conns |",
        delimiterRow,
        "| harvey-prod-germanywestcentral | Primary | 457 |",
        "| harvey-staging-germanywestcentral | Primary | 194 |",
    ].join("\n");
}

function sentinelTable(markdown) {
    return parseMarkdownLines(markdown, { width: 200, tableMode: "sentinel" })
        .find((line) => line && line.kind === "markdownTable");
}

const ACCEPTED_DELIMITERS = [
    ["plain three-dash", "|---|---|---|"],
    ["right-aligned short form", "|---|---|--:|"],
    ["right-aligned long form", "|---|---|---:|"],
    ["left-aligned", "|:---|:---|:---|"],
    ["centered", "|:---:|:---:|:---:|"],
    ["single dash per cell", "|-|-|-|"],
    ["mixed lengths and alignment", "|-|:----------|--:|"],
    ["padded cells", "| --- | --- | --: |"],
];

for (const [label, delimiter] of ACCEPTED_DELIMITERS) {
    test(`renders a real table for the ${label} delimiter row`, () => {
        const table = sentinelTable(tableWithDelimiter(delimiter));
        assert.ok(table, `${delimiter} should be recognised as a delimiter row`);
        assert.equal(table.header.length, 3);
        assert.equal(table.rows.length, 2);
        assert.equal(table.header[0], "Server");
        assert.equal(table.rows[0][2], "457");
    });
}

test("a body row of prose is not mistaken for a delimiter row", () => {
    const notATable = [
        "| Server | Role | Conns |",
        "| harvey-prod | Primary | 457 |",
    ].join("\n");
    assert.equal(sentinelTable(notATable), undefined);
});

test("a delimiter row whose column count disagrees with the header is not a table", () => {
    assert.equal(sentinelTable(tableWithDelimiter("|---|---|")), undefined);
});
