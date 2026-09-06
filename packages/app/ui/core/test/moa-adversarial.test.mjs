import test from "node:test";
import assert from "node:assert/strict";
import {
    normalizeMoa, normalizeMoaLayout, replaceMoaNode, moaLeaves,
    emptyMoaPanel, encodeMoaShare, decodeMoaShare, MOA_SHARE_LIMIT,
} from "../src/moa.js";
import { PilotSwarmUiController, appReducer, createInitialState, createStore } from "../src/index.js";

const chat = (id = "p1", sessionId = "session-1") => ({ id, type: "chat", sessionId });
const canvas = (id = "p2", slot = 2) => ({ id, type: "canvas", sessionId: "session-1", slot });
const split = (first = chat(), second = canvas()) => ({ id: "split", type: "split", direction: "row", ratio: 37, first, second });
const layout = (tree = split()) => ({ name: "Operations", tree });
const encodeRaw = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");

test("malformed saved profiles recover five independent empty slots", () => {
    for (const bad of [null, undefined, [], false, "garbage", { slots: [layout({ type: "chat" })] }]) {
        const normalized = normalizeMoa(bad);
        assert.equal(normalized.slots.length, 5);
        assert.equal(normalized.activeSlot, 0);
        assert.ok(normalized.slots.every((s) => s.tree === null));
        assert.notEqual(normalized.slots[0], normalized.slots[1]);
    }
    const value = normalizeMoa({ activeSlot: 90, slots: Array.from({ length: 8 }, () => layout()) });
    assert.equal(value.activeSlot, 4);
    assert.equal(value.slots.length, 5);
    assert.equal(normalizeMoa({ activeSlot: -2 }).activeSlot, 0);
});

test("one corrupt slot cannot destroy the other saved layouts", () => {
    const value = normalizeMoa({ activeSlot: 1, slots: [layout(), layout({ type: "unknown" }), layout(chat("p3"))] });
    assert.deepEqual(value.slots[0], layout());
    assert.equal(value.slots[1].tree, null);
    assert.deepEqual(value.slots[2], layout(chat("p3")));
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

test("shared layouts contain only normalized references, geometry, and the workspace name", () => {
    const secret = "PRIVATE-CONTENT";
    const source = { ...layout(), accessToken: secret, grants: [secret], transcript: secret };
    source.tree.first = { ...source.tree.first, title: secret, prompt: secret, owner: secret, html: secret, url: "javascript:alert(1)" };
    source.tree.second = { ...source.tree.second, canvasShareToken: secret, access: "public" };
    const wire = encodeMoaShare(source);
    const decoded = decodeMoaShare(wire);
    assert.deepEqual(decoded, layout());
    assert.ok(!Buffer.from(wire, "base64url").toString().includes(secret));
    decoded.tree.first.sessionId = "someone-else";
    assert.equal(source.tree.first.sessionId, "session-1", "copied layout owns its references");
});

test("Unicode workspace names survive a share round trip", () => {
    const value = { ...layout(), name: "🧭 故障対応 · équipe" };
    assert.deepEqual(decodeMoaShare(encodeMoaShare(value)), value);
    assert.equal(normalizeMoaLayout({ ...value, name: "  " }).name, "Untitled MoA");
    assert.equal(normalizeMoaLayout({ ...value, name: "a".repeat(1000) }).name.length, 64);
});

test("malformed, oversize, unsupported, and invalid UTF-8 links fail closed", () => {
    for (const bad of [null, "", "%%%", "abc=", "a".repeat(MOA_SHARE_LIMIT + 1), "_w", encodeRaw(null), encodeRaw({ version: 2, ...layout() }), encodeRaw({ version: 1, tree: chat("p", "../secret") })]) {
        assert.throws(() => decodeMoaShare(bad));
    }
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
