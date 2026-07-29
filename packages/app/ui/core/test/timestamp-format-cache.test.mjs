// Timestamp formatting is on the hot render path: every session row, event and
// chat message re-derives its stamp on every render, and a pane resize
// re-renders every row. Profiling a splitter drag on the chk portal put 5,332ms
// of 5,800ms self time (91.8%) inside formatTimestampCompact — because
// toLocaleTimeString builds a fresh Intl.DateTimeFormat on EVERY call.
//
// These tests guard both halves of the fix: the output must not change, and the
// formatters must not be rebuilt. Only the second one would catch a regression
// that reintroduces the cost, since output stays correct either way.
import { test } from "node:test";
import assert from "node:assert/strict";

import { formatTimestamp, formatTimestampCompact } from "../src/formatting.js";

// The pre-fix implementations, kept verbatim as the oracle. If a future change
// alters displayed stamps, these fail and the change has to be deliberate.
function referenceCompact(value, now) {
    const date = value instanceof Date ? value : new Date(value);
    const hhmm = date.toLocaleTimeString(undefined, {
        hour: "2-digit", minute: "2-digit", hour12: false,
    });
    const sameLocalDay = date.getFullYear() === now.getFullYear()
        && date.getMonth() === now.getMonth()
        && date.getDate() === now.getDate();
    if (sameLocalDay) {
        return date.toLocaleTimeString(undefined, {
            hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
        });
    }
    const day = String(date.getDate());
    const month = date.toLocaleDateString("en-GB", { month: "short" });
    const year = date.getFullYear() === now.getFullYear() ? "" : String(date.getFullYear()).slice(-2);
    return `${day}${month}${year} ${hhmm}`;
}

function referenceFull(value, now) {
    const date = value instanceof Date ? value : new Date(value);
    const time = date.toLocaleTimeString(undefined, {
        hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
    });
    const sameLocalDay = date.getFullYear() === now.getFullYear()
        && date.getMonth() === now.getMonth()
        && date.getDate() === now.getDate();
    if (sameLocalDay) return time;
    const day = date.toLocaleDateString("en-GB", { month: "short", day: "numeric" });
    const year = date.getFullYear() === now.getFullYear() ? "" : ` ${date.getFullYear()}`;
    return `${day}${year} ${time}`;
}

// Constructed from local-time parts so the same-day branch is exercised
// regardless of the machine's timezone.
const now = new Date(2026, 6, 28, 14, 30, 0);
const cases = [
    ["same day", new Date(2026, 6, 28, 9, 5, 30)],
    ["same day, midnight", new Date(2026, 6, 28, 0, 0, 0)],
    ["earlier day, same year", new Date(2026, 2, 3, 22, 15, 0)],
    ["earlier year", new Date(2024, 10, 19, 6, 45, 12)],
];

test("compact stamps are unchanged by the formatter cache", () => {
    for (const [label, value] of cases) {
        assert.equal(formatTimestampCompact(value, now), referenceCompact(value, now), label);
    }
});

test("full stamps are unchanged by the formatter cache", () => {
    for (const [label, value] of cases) {
        assert.equal(formatTimestamp(value, now), referenceFull(value, now), label);
    }
});

test("empty and unparseable values still yield an empty string", () => {
    assert.equal(formatTimestampCompact(null, now), "");
    assert.equal(formatTimestampCompact("", now), "");
    assert.equal(formatTimestampCompact("not a date", now), "");
    assert.equal(formatTimestamp(null, now), "");
});

test("formatting many stamps builds only a handful of Intl formatters", async () => {
    const RealDateTimeFormat = Intl.DateTimeFormat;
    let constructed = 0;
    class CountingDateTimeFormat extends RealDateTimeFormat {
        constructor(...args) {
            super(...args);
            constructed += 1;
        }
    }
    Intl.DateTimeFormat = CountingDateTimeFormat;
    try {
        // Fresh module instance so the lazy formatters are built under the
        // counting constructor rather than already cached by the imports above.
        const formatting = await import("../src/formatting.js?formatter-count");
        for (let index = 0; index < 250; index += 1) {
            // Alternate branches so every formatter shape gets exercised.
            formatting.formatTimestampCompact(new Date(2026, 6, 28, 9, index % 60, 0), now);
            formatting.formatTimestampCompact(new Date(2025, 1, 14, 9, index % 60, 0), now);
            formatting.formatTimestamp(new Date(2026, 6, 28, 9, index % 60, 0), now);
            formatting.formatTimestamp(new Date(2024, 4, 2, 9, index % 60, 0), now);
        }
        // Four distinct formatter shapes exist; 1000 calls must not exceed them.
        assert.ok(
            constructed <= 4,
            `expected at most 4 Intl.DateTimeFormat constructions, saw ${constructed} — `
            + "the per-call toLocale* path is back and the resize cost with it",
        );
    } finally {
        Intl.DateTimeFormat = RealDateTimeFormat;
    }
});
