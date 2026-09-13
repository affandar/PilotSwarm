import test from "node:test";
import assert from "node:assert/strict";
import {
    normalizeMoa, normalizeMoaLayout, replaceMoaNode, moaLeaves, activeMoaDashboard, updateMoaDashboard, moveMoaDashboard,
    emptyMoaPanel,
} from "../src/moa.js";
import { PilotSwarmUiController, appReducer, createInitialState, createStore } from "../src/index.js";

const chat = (id = "p1", sessionId = "session-1") => ({ id, type: "chat", sessionId });
const canvas = (id = "p2", slot = 2) => ({ id, type: "canvas", sessionId: "session-1", slot });
const split = (first = chat(), second = canvas()) => ({ id: "split", type: "split", direction: "row", ratio: 37, first, second });
const layout = (tree = split()) => ({ name: "Operations", tree });
const profile = (tree, name = "MoA 1") => ({ version: 3, composerMode: "per-chat", activeDashboardId: "moa-1", dashboards: [{id: "moa-1", name, tree, focusedPanelId: moaLeaves(tree)[0]?.id || null}] });
test("malformed profiles recover one empty personal workspace", () => {
    for (const bad of [null, undefined, [], false, "garbage", { version: 2, tree: { type: "chat" } }]) {
        assert.deepEqual(normalizeMoa(bad), profile(null));
    }
});

test("legacy migration keeps the selected populated layout or the first valid populated layout", () => {
    const slots = [layout(), layout({ type: "unknown" }), layout(chat("p3")), layout(null)];
    assert.deepEqual(normalizeMoa({ slots, activeSlot: 2 }), profile(chat("p3"), "Operations"));
    for (const activeSlot of [1, 3, 99, -1]) assert.deepEqual(normalizeMoa({ slots, activeSlot }), profile(split(), "Operations"));
    assert.deepEqual(activeMoaDashboard(normalizeMoa({ slots: [null, null, layout(canvas())], activeSlot: 0 })).tree, canvas());
    const cleared = normalizeMoa({ version: 2, tree: null, slots });
    assert.deepEqual(cleared, profile(null));
    assert.deepEqual(normalizeMoa(cleared), cleared);
});

test("profile hydration preserves desktop layouts when an older or mobile payload omits MoA", () => {
    const moa = normalizeMoa({ activeSlot: 2, slots: [layout(), layout(canvas()), layout(chat("p3"))] });
    let state = appReducer(createInitialState(), { type: "profileSettings/apply", settings: { moa } });
    assert.deepEqual(state.ui.moa, moa);
    assert.equal(state.ui.moaLoaded, true);
    state = appReducer(state, { type: "profileSettings/apply", settings: { themeId: "terminal-green" } });
    assert.deepEqual(state.ui.moa, moa);
    assert.equal(state.ui.themeId, "terminal-green");
});

test("saving a layout cannot change the default app's active session or prompt", () => {
    let state = appReducer(createInitialState(), { type: "sessions/loaded", sessions: [{ sessionId: "default-session" }] });
    state = appReducer(state, { type: "sessions/selected", sessionId: "default-session" });
    state = { ...state, ui: { ...state.ui, prompt: "default draft" } };
    const next = appReducer(state, { type: "ui/moa", value: { slots: [layout()] } });
    assert.equal(next.sessions.activeSessionId, "default-session");
    assert.equal(next.ui.prompt, "default draft");
    assert.equal(next.sessions, state.sessions);
});

test("personal profiles serialize only panel references and geometry", () => {
    const source = { version: 2, name: "discard", slots: [layout()], tree: { ...split(), first: { ...chat(), transcript: "SECRET", token: "SECRET" } }, grants: ["SECRET"] };
    const normalized = normalizeMoa(source);
    assert.deepEqual(normalized, profile(split(), "discard"));
    assert.ok(!JSON.stringify(normalized).includes("SECRET"));
    activeMoaDashboard(normalized).tree.first.sessionId = "other";
    assert.equal(source.tree.first.sessionId, "session-1");
});

test("duplicate panel or split identities are rejected before rendering", () => {
    assert.throws(() => normalizeMoaLayout(layout(split(chat("same"), canvas("same")))));
    assert.throws(() => normalizeMoaLayout(layout(split(chat("split"), canvas()))));
});

test("session references and canvas slots cannot escape their domains", () => {
    for (const sessionId of ["", "../secret", "group:abc", "a/b", "<script>", "a".repeat(101), 2]) {
        assert.throws(() => normalizeMoaLayout(layout(chat("p", sessionId))));
    }
    for (const slot of [0, 6, -1, 1.5, "2", null, NaN]) {
        assert.throws(() => normalizeMoaLayout(layout(canvas("p", slot))));
    }
    for (const slot of [1, 2, 3, 4, 5]) {
        assert.equal(normalizeMoaLayout(layout(canvas("p", slot))).tree.slot, slot);
    }
});

test("nonfinite split ratios and unknown directions are rejected; finite extremes stay usable", () => {
    for (const ratio of [NaN, Infinity, -Infinity, "50"]) {
        assert.throws(() => normalizeMoaLayout(layout({ ...split(), ratio })));
    }
    assert.equal(normalizeMoaLayout(layout({ ...split(), ratio: -1e10 })).tree.ratio, 10);
    assert.equal(normalizeMoaLayout(layout({ ...split(), ratio: 1e10 })).tree.ratio, 90);
    assert.throws(() => normalizeMoaLayout(layout({ ...split(), direction: "diagonal" })));
});

test("hostile oversized and cyclic trees cannot exhaust recursive rendering", () => {
    let tree = chat("leaf-0");
    for (let i = 1; i <= 15; i++) tree = { ...split(tree, chat(`leaf-${i}`)), id: `split-${i}` };
    assert.equal(moaLeaves(normalizeMoaLayout(layout(tree)).tree).length, 16);
    assert.throws(() => normalizeMoaLayout(layout({ ...split(tree, chat("leaf-16")), id: "split-16" })));
    const cyclic = split();
    cyclic.first = cyclic;
    assert.throws(() => normalizeMoaLayout(layout(cyclic)));
});

test("splitting preserves original content and inserts an unbound empty panel", () => {
    const original = split();
    const blank = emptyMoaPanel();
    const next = replaceMoaNode(original, "p1", { ...split(original.first, blank), id: "new-split", direction: "column" });
    assert.deepEqual(original, split(), "original saved layout must not mutate");
    assert.deepEqual(moaLeaves(next), [chat(), blank, canvas()]);
    assert.deepEqual(Object.keys(blank).sort(), ["id", "type"]);
    assert.notEqual(emptyMoaPanel().id, blank.id);
});

test("removing a panel collapses its parent and does not disturb surviving references", () => {
    const original = split();
    assert.equal(replaceMoaNode(original, "missing", null), original);
    assert.equal(replaceMoaNode(original, "p1", null), original.second);
    assert.equal(replaceMoaNode(original, "p2", null), original.first);
    assert.equal(replaceMoaNode(original, "split", null), null);
    assert.deepEqual(original, split());
});

test("canvas actions validate the frame's pinned slot, independent of another slot's contract", async () => {
    const sent = [];
    let state = createInitialState();
    state = appReducer(state, { type: "sessions/loaded", sessions: [{ sessionId: "s1", status: "running" }] });
    state = appReducer(state, { type: "sessions/selected", sessionId: "s1" });
    state = appReducer(state, { type: "canvas/updated", sessionId: "s1", slot: 1, rev: 1, responseContract: { actions: { first: {} } } });
    state = appReducer(state, { type: "canvas/updated", sessionId: "s1", slot: 2, rev: 1, responseContract: { actions: { second: {} } } });
    const controller = new PilotSwarmUiController({ store: createStore(appReducer, state), transport: {
        sendMessage: async (sessionId, prompt) => sent.push({ sessionId, prompt }),
        getSessionEvents: async () => [],
    } });
    const action = (name) => ({ type: "canvas-action", action: name, data: {} });
    assert.equal((await controller.submitCanvasAction("s1", action("second"), 2)).ok, true);
    assert.equal((await controller.submitCanvasAction("s1", action("first"), 2)).ok, false);
    assert.equal((await controller.submitCanvasAction("s1", action("second"), 1)).ok, false);
    assert.equal((await controller.submitCanvasAction("s1", action("first"))).ok, true, "legacy slot1 remains supported");
    assert.equal((await controller.submitCanvasAction("s1", action("first"), 3)).ok, false, "missing slot cannot borrow slot1 contract");
    assert.equal((await controller.submitCanvasAction("s1", action("first"), 0)).ok, false);
    assert.deepEqual(sent.map((s) => s.sessionId), ["s1", "s1"]);
    assert.match(sent[0].prompt, /"second"/);
});


test("multiple dashboards preserve identity, active selection, geometry and per-dashboard focus", () => {
    const first = { id: "operations", name: "Operations", tree: split(), aspectRatio: 2.2, focusedPanelId: "p2" };
    const second = { id: "research", name: "Research", tree: chat("p3"), focusedPanelId: "p3" };
    const value = normalizeMoa({ version: 3, activeDashboardId: "research", dashboards: [first, second] });
    assert.deepEqual(value.dashboards, [first, second]);
    const updated = updateMoaDashboard(value, "research", { tree: null });
    assert.deepEqual(updated.dashboards[0], first);
    assert.equal(activeMoaDashboard(updated).tree, null);
    assert.equal(activeMoaDashboard(updated).focusedPanelId, null);
    assert.deepEqual(value.dashboards[1], second, "updates must not mutate another saved snapshot");
    assert.deepEqual(normalizeMoa(value), value);
});

test("dashboard reordering preserves active identity, layout data and profile array order", () => {
    const first = { id: "operations", name: "Operations", tree: split(), focusedPanelId: "p2" };
    const second = { id: "research", name: "Research", tree: chat("p3"), focusedPanelId: "p3" };
    const third = { id: "review", name: "Review", tree: canvas("p4"), focusedPanelId: "p4" };
    const value = normalizeMoa({ version: 3, activeDashboardId: "research", dashboards: [first, second, third] });
    const moved = moveMoaDashboard(value, "operations", 2);
    assert.deepEqual(moved.dashboards.map(d => d.id), ["research", "review", "operations"]);
    assert.equal(moved.activeDashboardId, "research");
    assert.deepEqual(moved.dashboards[2], first);
    assert.deepEqual(value.dashboards.map(d => d.id), ["operations", "research", "review"], "reordering must not mutate saved state");
    assert.deepEqual(moveMoaDashboard(value, "missing", 0), value);
    assert.deepEqual(moveMoaDashboard(value, "review", -20).dashboards.map(d => d.id), ["review", "operations", "research"]);
});

test("dashboard validation caps five, repairs duplicate identities and invalid active/focus references", () => {
    const value = normalizeMoa({ version: 3, activeDashboardId: "missing", dashboards: Array.from({length: 20}, () => ({ id: "duplicate", name: "x".repeat(100), tree: chat(), focusedPanelId: "missing", token: "SECRET" })) });
    assert.equal(value.dashboards.length, 5);
    assert.equal(new Set(value.dashboards.map(d => d.id)).size, 5);
    assert.equal(value.activeDashboardId, value.dashboards[0].id);
    assert.ok(value.dashboards.every(d => d.name.length === 64 && d.focusedPanelId === "p1"));
    assert.ok(!JSON.stringify(value).includes("SECRET"));
    assert.deepEqual(normalizeMoa(value), value);
    assert.deepEqual(normalizeMoa({ version: 3, dashboards: [] }), profile(null));
});

test("single-dashboard migration preserves a cleared view and saved desktop aspect ratio", () => {
    const migrated = normalizeMoa({ version: 2, tree: split(), aspectRatio: 2.13 });
    assert.equal(activeMoaDashboard(migrated).aspectRatio, 2.13);
    assert.deepEqual(activeMoaDashboard(migrated).tree, split());
    assert.equal(activeMoaDashboard(normalizeMoa({ version: 2, tree: null, slots: [layout()] })).tree, null);
});


test("per-chat composers are the default and shared mode survives dashboard edits", () => {
    assert.equal(normalizeMoa(null).composerMode, "per-chat");
    assert.equal(normalizeMoa({ composerMode: "invalid" }).composerMode, "per-chat");
    const value = normalizeMoa({ ...profile(split()), composerMode: "shared" });
    assert.equal(updateMoaDashboard(value, "moa-1", { name: "Renamed" }).composerMode, "shared");
    assert.equal(normalizeMoa(JSON.parse(JSON.stringify(value))).composerMode, "shared");
});
