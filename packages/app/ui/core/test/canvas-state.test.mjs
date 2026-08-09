// The canvas attention model, pinned — as corrected by the client-half
// adversarial review:
//
//   - content convergence is UNGATED (stale events still advance the revision;
//     freshness protects the user's focus, never the data)
//   - the agent-driven flip is `canvas/flip`: it ticks flipSeq even when the
//     mode is already "canvas" (a phone can be off its canvas tab while the
//     persisted mode says canvas — the tick is what brings the tab back)
//   - viewed-marking comes ONLY from the surface's `canvas/viewed` receipt.
//     Inferring it from mode transitions marked revs seen on phones whose
//     layout never showed the pane, and left session-switches-while-in-canvas
//     unviewed (the phantom badge).
//   - manual re-entry clears the opt-out; only a manual leave sets it
//   - the BULK history loader must survive canvas events — the original paste
//     from the append path threw ReferenceError and bricked cold loads.
import test from "node:test";
import assert from "node:assert/strict";
import {
    PilotSwarmUiController,
    appReducer,
    createInitialState,
    createStore,
    normalizeStoredCanvasPrefs,
} from "../src/index.js";
import { selectCanvasView } from "../src/selectors.js";
import { buildHistoryModel, dedupeChatMessages } from "../src/history.js";
import { validateCanvasAction } from "../src/canvas-actions.js";

function canvasEvent({ rev = 1, note = "", agoMs = 0, seq = 10, sessionId = "s1", sizeBytes = 1234 } = {}) {
    return {
        seq,
        sessionId,
        eventType: "session.canvas_updated",
        createdAt: new Date(Date.now() - agoMs).toISOString(),
        data: { rev, note, sizeBytes },
    };
}

function controllerWith({ active = "s1", transport = {} } = {}) {
    let state = createInitialState();
    state = appReducer(state, {
        type: "sessions/loaded",
        sessions: [
            { sessionId: "s1", title: "One", status: "running" },
            { sessionId: "s2", title: "Two", status: "running" },
        ],
    });
    if (active) state = appReducer(state, { type: "sessions/selected", sessionId: active });
    const store = createStore(appReducer, state);
    return new PilotSwarmUiController({
        store,
        transport: {
            listSessions: async () => [],
            subscribeSession: () => () => {},
            getCurrentUserProfile: async () => ({ provider: "t", subject: "u", profileSettings: {} }),
            ...transport,
        },
    });
}

// ── Flip guards ─────────────────────────────────────────────────────────────

test("a fresh draw on the active session flips the column; the SURFACE receipt marks it viewed", () => {
    const c = controllerWith({});
    c.applyCanvasUpdate("s1", canvasEvent({ rev: 1 }));
    let s = c.getState();
    assert.equal(s.ui.rightPaneMode, "canvas");
    assert.equal(s.canvas.bySessionId.s1.latestRev, 1);
    // The flip alone proves nothing rendered — viewed waits for the receipt.
    assert.equal(s.canvas.prefs.s1?.lastViewedRev || 0, 0);
    assert.equal(selectCanvasView(s).unseen, false, "but no badge while the canvas is the mode");
    c.dispatch({ type: "canvas/viewed", sessionId: "s1", rev: 1 });
    s = c.getState();
    assert.equal(s.canvas.prefs.s1.lastViewedRev, 1);
});

test("the flip ticks flipSeq even when the mode is already canvas (the phone's re-surface signal)", () => {
    const c = controllerWith({});
    c.applyCanvasUpdate("s1", canvasEvent({ rev: 1 }));
    const first = c.getState().canvas.flipSeq;
    assert.ok(first >= 1);
    c.applyCanvasUpdate("s1", canvasEvent({ rev: 2, seq: 11 }));
    assert.equal(c.getState().canvas.flipSeq, first + 1,
        "mode was already canvas — the tick must still fire or a phone on Main never comes back");
});

test("a background session's draw converges content but never steals the view", () => {
    const c = controllerWith({ active: "s1" });
    c.applyCanvasUpdate("s2", canvasEvent({ sessionId: "s2", rev: 3 }));
    const s = c.getState();
    assert.equal(s.ui.rightPaneMode, "panes", "s2 must not flip while s1 is active");
    assert.equal(s.canvas.bySessionId.s2.latestRev, 3, "but the revision still lands");
});

test("a STALE draw converges content without flipping — freshness gates focus, not data", () => {
    const c = controllerWith({});
    c.applyCanvasUpdate("s1", canvasEvent({ rev: 7, agoMs: 30 * 60_000 }));
    const s = c.getState();
    assert.equal(s.ui.rightPaneMode, "panes", "an hour-old replay must not yank the view");
    assert.equal(s.canvas.bySessionId.s1.latestRev, 7, "but latestRev MUST advance — this is the divergence from artifact_presented");
    assert.equal(selectCanvasView(s).unseen, true, "and it shows as unseen");
});

test("after a manual toggle away, draws badge instead of flipping; manual re-entry clears the opt-out", () => {
    const c = controllerWith({});
    c.applyCanvasUpdate("s1", canvasEvent({ rev: 1 }));
    c.dispatch({ type: "canvas/viewed", sessionId: "s1", rev: 1 });
    // The user leaves canvas mode by hand.
    c.dispatch({ type: "ui/rightPaneMode", mode: "panes", sessionId: "s1", manual: true });
    assert.equal(c.getState().canvas.prefs.s1.optedOut, true);
    c.applyCanvasUpdate("s1", canvasEvent({ rev: 2, seq: 11 }));
    let s = c.getState();
    assert.equal(s.ui.rightPaneMode, "panes", "opt-out wins over the flip");
    assert.equal(selectCanvasView(s).unseen, true, "the yellow badge carries the signal");
    // Coming back by hand un-opts-out — the canvas is welcome again.
    c.dispatch({ type: "ui/rightPaneMode", mode: "canvas", sessionId: "s1" });
    s = c.getState();
    assert.equal(s.canvas.prefs.s1.optedOut, false, "manual re-entry must clear the opt-out");
    assert.equal(selectCanvasView(s).unseen, false, "no badge while the canvas is on screen");
    c.dispatch({ type: "canvas/viewed", sessionId: "s1", rev: 2 });
    c.dispatch({ type: "ui/rightPaneMode", mode: "panes", sessionId: "s1", manual: true });
    assert.equal(selectCanvasView(c.getState()).unseen, false, "viewed rev badges nothing after leaving");
});

test("switching sessions while in canvas mode does NOT mark the new session viewed (no phantom badge)", () => {
    const c = controllerWith({ active: "s1" });
    c.applyCanvasUpdate("s1", canvasEvent({ rev: 1 }));
    // s2 has an old canvas at rev 4.
    c.dispatch({ type: "canvas/updated", sessionId: "s2", rev: 4, note: "old", sizeBytes: 10 });
    c.dispatch({ type: "sessions/selected", sessionId: "s2" });
    let view = selectCanvasView(c.getState());
    assert.equal(view.sessionId, "s2");
    assert.equal(view.lastViewedRev, 0, "selection alone renders nothing — only the surface receipt marks viewed");
    // The pane renders rev 4 and reports it.
    c.dispatch({ type: "canvas/viewed", sessionId: "s2", rev: 4 });
    c.dispatch({ type: "ui/rightPaneMode", mode: "panes", sessionId: "s2", manual: true });
    assert.equal(selectCanvasView(c.getState()).unseen, false,
        "leaving right after viewing must not light the badge for content the user just watched");
});

// ── Reducer invariants ──────────────────────────────────────────────────────

test("revisions are monotonic: replays and out-of-order merges never regress", () => {
    let state = createInitialState();
    state = appReducer(state, { type: "canvas/updated", sessionId: "s1", rev: 5, note: "five" });
    state = appReducer(state, { type: "canvas/updated", sessionId: "s1", rev: 3, note: "stale" });
    assert.equal(state.canvas.bySessionId.s1.latestRev, 5);
    assert.equal(state.canvas.bySessionId.s1.note, "five", "a stale replay must not clobber the caption either");
});

test("viewed receipts are monotonic too", () => {
    let state = createInitialState();
    state = appReducer(state, { type: "canvas/viewed", sessionId: "s1", rev: 5 });
    state = appReducer(state, { type: "canvas/viewed", sessionId: "s1", rev: 3 });
    assert.equal(state.canvas.prefs.s1.lastViewedRev, 5);
});

test("the snapshot never regresses a rev that events already beat", () => {
    let state = createInitialState();
    state = appReducer(state, { type: "canvas/updated", sessionId: "s1", rev: 9, note: "live" });
    state = appReducer(state, { type: "canvas/snapshot", sessionId: "s1", rev: 4, note: "old" });
    assert.equal(state.canvas.bySessionId.s1.latestRev, 9);
    assert.equal(state.canvas.bySessionId.s1.note, "live");
    assert.equal(state.canvas.bySessionId.s1.snapshotLoaded, true, "but the memo still records");
});

test("a cleared canvas (sizeBytes 0) stops existing: no tab, no badge", () => {
    let state = createInitialState();
    state = appReducer(state, { type: "sessions/loaded", sessions: [{ sessionId: "s1", title: "T" }] });
    state = appReducer(state, { type: "sessions/selected", sessionId: "s1" });
    state = appReducer(state, { type: "canvas/updated", sessionId: "s1", rev: 2, sizeBytes: 500 });
    assert.equal(selectCanvasView(state).exists, true);
    state = appReducer(state, { type: "canvas/updated", sessionId: "s1", rev: 3, sizeBytes: 0 });
    const view = selectCanvasView(state);
    assert.equal(view.exists, false, "draw_canvas(\"\") clears the affordances");
    assert.equal(view.unseen, false, "a cleared canvas must not badge");
});

test("prefs survive a profile round-trip, reject garbage, merge by max, and prune noise", () => {
    const prefs = normalizeStoredCanvasPrefs({
        s1: { optedOut: true, lastViewedRev: 7 },
        s2: { optedOut: "yes", lastViewedRev: "many" },
        "": { optedOut: true },
        s3: null,
    });
    assert.deepEqual(prefs, {
        s1: { optedOut: true, lastViewedRev: 7, lastViewedDataRev: 0 },
        s2: { optedOut: false, lastViewedRev: 0, lastViewedDataRev: 0 },
    });
    // The overnight case: apply a stored profile, then snapshot a newer rev.
    let state = createInitialState({ canvasPrefs: { s1: { optedOut: true, lastViewedRev: 5 } } });
    state = appReducer(state, { type: "sessions/loaded", sessions: [{ sessionId: "s1", title: "T" }, { sessionId: "kid", title: "K", parentSessionId: "s1" }] });
    state = appReducer(state, { type: "sessions/selected", sessionId: "s1" });
    state = appReducer(state, { type: "canvas/snapshot", sessionId: "s1", rev: 7 });
    assert.equal(selectCanvasView(state).unseen, true, "rev 7 against a stored lastViewedRev of 5 lights the badge");

    // A stale poll must not regress what this window has already seen, must
    // not drop a local-only entry, and prunes child-session/default entries.
    state = appReducer(state, { type: "canvas/viewed", sessionId: "s1", rev: 7 });
    state = appReducer(state, { type: "canvas/viewed", sessionId: "s9", rev: 2 }); // local-only
    state = appReducer(state, {
        type: "profileSettings/apply",
        settings: {
            canvasPrefs: {
                s1: { optedOut: true, lastViewedRev: 5 },       // stale rev
                kid: { optedOut: true, lastViewedRev: 1 },       // child — prune
                dead: { optedOut: false, lastViewedRev: 0 },     // default — prune
            },
        },
    });
    assert.equal(state.canvas.prefs.s1.lastViewedRev, 7, "max-merge: the poll's stale 5 must not un-view 7");
    assert.equal(state.canvas.prefs.s1.optedOut, true);
    assert.equal(state.canvas.prefs.s9.lastViewedRev, 2, "a local-only entry survives the apply");
    assert.equal(state.canvas.prefs.kid, undefined, "child sessions cannot have canvases");
    assert.equal(state.canvas.prefs.dead, undefined, "all-default entries store nothing");
});

// ── The cold-load snapshot ──────────────────────────────────────────────────

test("the snapshot query is definitive both ways, memoized, and selection re-arms it", async () => {
    let drawCalls = 0;
    let dataCalls = 0;
    const c = controllerWith({
        transport: {
            getSessionEventsBefore: async (sessionId, beforeSeq, limit, types) => {
                assert.equal(limit, 1);
                if (types[0] === "session.canvas_data") {
                    dataCalls += 1;
                    return [];
                }
                assert.deepEqual(types, ["session.canvas_updated"], "must be the filtered lookup, not a window scan");
                drawCalls += 1;
                return drawCalls === 1 ? [] : [canvasEvent({ rev: 4, note: "overnight" })];
            },
        },
    });
    await c.ensureCanvasSnapshot("s1");
    let view = { ...selectCanvasView(c.getState()) };
    assert.equal(view.exists, false, "empty result = no canvas has ever been drawn");
    assert.equal(view.snapshotLoaded, true);
    assert.equal(dataCalls, 0, "no canvas → no data lookup");

    await c.ensureCanvasSnapshot("s1");
    assert.equal(drawCalls, 1, "memoized — no re-query while the memo stands");

    // Re-selection invalidates and re-fetches (the continuity break).
    c.dispatch({ type: "canvas/snapshotInvalidate", sessionId: "s1" });
    await c.ensureCanvasSnapshot("s1");
    assert.equal(drawCalls, 2);
    assert.equal(dataCalls, 1, "a real canvas pulls its latest tick for cold-load replay");
    view = selectCanvasView(c.getState());
    assert.equal(view.latestRev, 4);
    assert.equal(view.note, "overnight");
});

test("a transport without the filtered query degrades to live-events-only, without spinning", async () => {
    const c = controllerWith({});
    await c.ensureCanvasSnapshot("s1");
    assert.equal(c.getState().canvas.bySessionId.s1.snapshotLoaded, true);
    assert.equal(selectCanvasView(c.getState()).exists, false);
});

// ── History: both pipelines must survive and agree ──────────────────────────

test("the BULK loader survives canvas events and builds the same chat item as the live path", () => {
    // The original branch was a paste from appendEventToHistory referencing
    // variables that do not exist in buildHistoryModel — a ReferenceError
    // that bricked every cold load of a canvas session. Never again.
    const events = [
        { seq: 1, sessionId: "s1", eventType: "user.message", createdAt: new Date().toISOString(), data: { content: "draw it" } },
        canvasEvent({ rev: 2, note: "MSFT refresh", seq: 5 }),
        { seq: 9, sessionId: "s1", eventType: "assistant.message", createdAt: new Date().toISOString(), data: { content: "done" } },
    ];
    const model = buildHistoryModel(events);
    const item = model.chat.find((m) => m?.kind === "canvas-update");
    assert.ok(item, "bulk load must produce the canvas chat item");
    assert.equal(item.rev, 2);
    assert.equal(item.note, "MSFT refresh");
    assert.equal(item.text, "artifact://s1/canvas.html", "the press-a picker reads links from text");
    assert.ok(model.chat.some((m) => m?.role === "assistant"), "and the events after it still load");
    assert.match(model.activity.map((a) => JSON.stringify(a)).join(""), /\[canvas\]/);
});

test("the chat line is flagged for the portal to skip and carries the TUI's affordances", async () => {
    const { selectChatLines } = await import("../src/selectors.js");
    const c = controllerWith({});
    c.mergeSessionEvent("s1", canvasEvent({ rev: 2, note: "MSFT refresh", seq: 41 }));
    const state = c.getState();

    const history = state.history.bySessionId.get("s1");
    const item = history.chat.find((m) => m?.kind === "canvas-update");
    assert.ok(item, "the canvas event must produce a chat item");
    assert.equal(item.rev, 2);
    assert.equal(item.text, "artifact://s1/canvas.html",
        "press-a extracts artifact:// URIs from message TEXT — the run href alone is invisible to it");
    assert.match(history.activity.map((a) => JSON.stringify(a)).join(""), /\[canvas\]/,
        "and the activity feed keeps its diagnostic line");

    const lines = selectChatLines(state, 100);
    const line = lines.find((l) => l?.canvasUpdate);
    assert.ok(line, "the rendered line must carry the canvasUpdate flag — it is the portal's skip signal");
    const runs = line.runs || [];
    const link = runs.find((r) => r?.href === "artifact://s1/canvas.html");
    assert.ok(link, "the rendered line links the artifact for the TUI display");
    assert.match(runs.map((r) => r.text).join(""), /rev 2 — MSFT refresh/);
});

test("canvas revision lines survive the redelivery dedupe; double-click actions stay two bubbles", () => {
    const revLine = (seq, rev) => ({
        id: `s:${seq}`, kind: "canvas-update", role: "system",
        text: "artifact://s/canvas.html", createdAt: 1000 + rev, rev,
    });
    const kept = dedupeChatMessages([revLine(1, 1), revLine(2, 2)]);
    assert.equal(kept.length, 2, "two revs drawn seconds apart must both survive a reload");

    const action = (seq, ids) => ({
        id: `s:${seq}`, kind: "canvas-action", role: "user",
        text: '[canvas-action] {"action":"go","data":{}}', createdAt: 2000,
        ...(ids ? { clientMessageIds: ids } : {}),
    });
    const clicks = dedupeChatMessages([action(3, ["c1"]), action(4, ["c2"])]);
    assert.equal(clicks.length, 2, "distinct client ids are two genuine submissions, not a redelivery");
});

test("validateCanvasAction refuses structured-clone-legal garbage instead of throwing", () => {
    const contract = { actions: { go: { blob: "json" } } };
    const cyclic = {}; cyclic.self = cyclic;
    const r1 = validateCanvasAction(contract, { type: "canvas-action", action: "go", data: { blob: cyclic } });
    assert.equal(r1.ok, false, "cyclic json field must be refused, not thrown");
    const r2 = validateCanvasAction(contract, { type: "canvas-action", action: "go", data: { blob: { n: 1n } } });
    assert.equal(r2.ok, false, "BigInt json field must be refused, not thrown");
});
