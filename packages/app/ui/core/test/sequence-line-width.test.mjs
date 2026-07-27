// Sequence lines used to be padded to the pane's full nominal width on EVERY
// line, including the final column, whose trailing spaces align nothing. With
// `white-space: pre` those spaces occupy real width, so the content box always
// measured exactly the computed width and any rounding between "columns x char
// width" and the pane's actual pixel width produced a horizontal scrollbar that
// never went away — on content that visibly fit. (A 3-column "overflow guard"
// fudge in the portal existed solely to paper over this.)
import test from "node:test";
import assert from "node:assert/strict";
import { selectInspector } from "../src/selectors.js";

const WIDTH = 60;

function stateWithEvents(events) {
    const sessionId = "s1";
    return {
        // byId is a plain OBJECT here (selectActiveSession indexes it directly)
        // while history.bySessionId is a Map. Getting this wrong yields an
        // empty view and assertions that pass while proving nothing.
        sessions: { activeSessionId: sessionId, byId: { [sessionId]: { sessionId, title: "t" } }, flat: [{ sessionId }] },
        history: { bySessionId: new Map([[sessionId, { events }]]) },
        ui: { inspectorTab: "sequence", scroll: {}, followBottom: {} },
        orchestration: { bySessionId: {} },
        logs: {}, files: {},
    };
}

// Guard against the fixture silently going stale again.
function assertRealView(view) {
    assert.ok((view.stickyLines || []).length > 0, "fixture produced no sticky lines — selector never reached the sequence branch");
}

const lineWidth = (line) => {
    const runs = Array.isArray(line?.runs) ? line.runs : (Array.isArray(line) ? line : null);
    if (runs) return runs.reduce((n, r) => n + String(r.text ?? "").length, 0);
    return String(line?.text ?? "").length;
};

test("no sequence line is padded past the requested width", () => {
    const events = [];
    for (let i = 0; i < 6; i += 1) {
        events.push({ eventType: "session.turn_started", data: { iteration: i }, createdAt: new Date(Date.now() - (6 - i) * 1000).toISOString(), seq: i + 1 });
    }
    const view = selectInspector(stateWithEvents(events), { width: WIDTH });
    assertRealView(view);
    for (const line of [...(view.stickyLines || []), ...(view.lines || [])]) {
        assert.ok(lineWidth(line) <= WIDTH, `line exceeds ${WIDTH}: ${lineWidth(line)}`);
    }
});

test("short content produces short lines, not full-width padded ones", () => {
    // The regression that mattered: a couple of events on one node should not
    // fill a 60-column pane edge to edge.
    const events = [
        { eventType: "session.turn_started", data: { iteration: 1 }, createdAt: new Date(Date.now() - 2000).toISOString(), seq: 1 },
    ];
    const view = selectInspector(stateWithEvents(events), { width: WIDTH });
    assertRealView(view);
    const body = (view.lines || []).filter((l) => lineWidth(l) > 0);
    assert.ok(body.length > 0, "expected at least one event line");
    const widest = Math.max(...body.map(lineWidth));
    assert.ok(widest < WIDTH, `event lines should not fill the pane; widest was ${widest}/${WIDTH}`);
});

test("no line ends in trailing whitespace", () => {
    const events = [
        { eventType: "session.turn_started", data: { iteration: 1 }, createdAt: new Date(Date.now() - 2000).toISOString(), seq: 1 },
        { eventType: "session.turn_completed", data: { iteration: 1 }, createdAt: new Date(Date.now() - 1000).toISOString(), seq: 2 },
    ];
    const view = selectInspector(stateWithEvents(events), { width: WIDTH });
    assertRealView(view);
    for (const line of [...(view.stickyLines || []), ...(view.lines || [])]) {
        const runs = Array.isArray(line?.runs) ? line.runs : (Array.isArray(line) ? line : null);
        const text = runs ? runs.map((r) => String(r.text ?? "")).join("") : String(line?.text ?? "");
        if (text === "") continue;
        assert.equal(text, text.replace(/\s+$/, ""), `trailing pad survived: ${JSON.stringify(text)}`);
    }
});
