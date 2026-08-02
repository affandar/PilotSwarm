/**
 * Node Map redo — registry-first view-model + Activity scoping.
 *
 * Both hosts (portal clickable rows, TUI digit keys) render from
 * selectNodeMapView, and the Activity pane switches into node scope when a
 * node is selected — this file is the contract for that behavior: registry ∪
 * history union, liveness/phase, session→node mapping, selection toggling,
 * and the degraded (no-registry) mode.
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
    appReducer,
    createInitialState,
    createStore,
    selectNodeMapView,
    selectActivityPane,
    selectWorkerDetailsPane,
} from "../src/index.js";

function workerRow(id, overrides = {}) {
    return {
        workerNodeId: id,
        pool: "aks-default",
        phase: "ready",
        owner: null,
        registeredAt: new Date(Date.now() - 3_600_000),
        updatedAt: new Date(),
        info: { sdkVersion: "0.5.29" },
        health: { uptimeS: 7200, rssBytes: 180 * 1024 * 1024, activeSessions: 1 },
        state: {},
        ...overrides,
    };
}

function seedState(store, { workers, sessions = [], histories = {} }) {
    store.dispatch({ type: "admin/workers/loaded", list: workers });
    for (const session of sessions) {
        store.getState().sessions.byId[session.sessionId] = session;
        store.getState().sessions.order = [...(store.getState().sessions.order || []), session.sessionId];
    }
    for (const [sessionId, events] of Object.entries(histories)) {
        store.getState().history.bySessionId.set(sessionId, { events });
    }
}

const NOW = Date.now();
const podA = "copilot-runtime-worker-66f68f955c-z6dcb";   // short: z6dcb
const podB = "copilot-runtime-worker-66f68f955c-chl82";   // short: chl82

test("registry-first: registered nodes lead with specs; history-only nodes append", () => {
    const store = createStore(appReducer, createInitialState());
    seedState(store, {
        workers: [
            workerRow(podA),
            workerRow(podB, { phase: "draining" }),
            workerRow("copilot-runtime-worker-66f68f955c-old00", { updatedAt: new Date(NOW - 10 * 60_000) }),
        ],
        sessions: [
            { sessionId: "s1", title: "triage", state: "running" },
            { sessionId: "s2", title: "reporter", state: "waiting" },
        ],
        histories: {
            s1: [{ createdAt: new Date(NOW - 30_000), workerNodeId: podA }],
            // A node the registry has never seen (e.g. non-admin data gap).
            s2: [{ createdAt: new Date(NOW - 20_000), workerNodeId: "laptop/ghost" }],
        },
    });

    const view = selectNodeMapView(store.getState());
    assert.equal(view.degraded, false);
    assert.equal(view.registered, 3);
    assert.equal(view.liveCount, 2, "10-minute-silent worker is registered but not live");

    const labels = view.nodes.map((node) => node.label);
    assert.ok(labels.indexOf("z6dcb") < labels.indexOf("old00"), "live before stale");
    assert.ok(labels.includes("ghost"), "history-only node joins the union");

    const a = view.nodes.find((node) => node.label === "z6dcb");
    assert.equal(a.registered, true);
    assert.equal(a.live, true);
    assert.equal(a.pool, "aks-default");
    assert.equal(a.uptimeText, "2h 0m");
    assert.equal(a.executing.length, 1, "session s1 maps onto its last-known node");
    assert.equal(a.executing[0].text.includes("triage"), true);

    const drainer = view.nodes.find((node) => node.label === "chl82");
    assert.equal(drainer.phase, "draining");

    const ghost = view.nodes.find((node) => node.label === "ghost");
    assert.equal(ghost.registered, false);
    assert.equal(ghost.executing.length, 1);
});

test("a node is always selected: first by default, remembered, falls back when gone", () => {
    const store = createStore(appReducer, createInitialState());
    seedState(store, {
        workers: [workerRow(podA), workerRow(podB)],
        sessions: [{ sessionId: "s1", title: "triage", state: "running" }],
        histories: { s1: [{ createdAt: new Date(NOW - 10_000), workerNodeId: podA }] },
    });

    // Nothing clicked yet → the first row is selected, never "none".
    const first = selectNodeMapView(store.getState());
    assert.equal(first.selected, first.nodes[0].label);
    assert.equal(store.getState().ui.nodeMapSelectedNode, null, "the default costs no state");

    // An explicit pick sticks, and re-picking it does NOT clear it.
    store.dispatch({ type: "ui/nodeMapSelect", label: "z6dcb" });
    assert.equal(selectNodeMapView(store.getState()).selected, "z6dcb");
    store.dispatch({ type: "ui/nodeMapSelect", label: "z6dcb" });
    assert.equal(selectNodeMapView(store.getState()).selected, "z6dcb", "selection is set, never toggled off");

    // The remembered choice survives leaving and re-entering the tab.
    store.dispatch({ type: "ui/inspectorTab", inspectorTab: "logs" });
    store.dispatch({ type: "ui/inspectorTab", inspectorTab: "nodes" });
    assert.equal(selectNodeMapView(store.getState()).selected, "z6dcb", "remembered across tab switches");

    // Still listed as an activity-derived node ⇒ still a valid selection.
    store.dispatch({ type: "admin/workers/loaded", list: [workerRow(podB)] });
    assert.equal(selectNodeMapView(store.getState()).selected, "z6dcb",
        "a de-registered node that is still in the list stays selected");

    // Gone from BOTH the registry and recent activity → fall back to the first.
    store.getState().history.bySessionId.set("s1", { events: [{ createdAt: new Date(NOW - 10_000), workerNodeId: podB }] });
    const after = selectNodeMapView(store.getState());
    assert.equal(after.selected, after.nodes[0].label);
    assert.equal(after.selected, "chl82", "falls back instead of blanking");
});

test("worker details pane replaces Activity with the selected node's specs and sessions", () => {
    const store = createStore(appReducer, createInitialState());
    seedState(store, {
        workers: [workerRow(podA, {
            state: { "agent-packages": { epoch: 12, installed: { "demo-kit": { semver: "0.2.0", status: "ok" } } } },
        })],
        sessions: [{ sessionId: "s1", title: "triage", state: "running" }],
        histories: { s1: [{ createdAt: new Date(NOW - 10_000), workerNodeId: podA }] },
    });

    const pane = selectWorkerDetailsPane(store.getState());
    const titleText = pane.title.map((run) => run.text).join("");
    assert.match(titleText, /Worker z6dcb/, "the pane is titled for the worker, not 'Activity'");
    const text = pane.lines.map((line) => (Array.isArray(line) ? line : [line]).map((run) => run.text).join("")).join("\n");
    assert.match(text, new RegExp(podA), "full node id");
    assert.match(text, /Phase\s+ready/);
    assert.match(text, /Pool\s+aks-default/);
    assert.match(text, /Packages\s+epoch 12 · 1 ok/);
    assert.match(text, /demo-kit@0\.2\.0/);
    assert.match(text, /EXECUTING \(1\)/);
    assert.match(text, /triage/);

    // Activity itself is no longer node-aware: it stays session activity.
    const activityTitle = selectActivityPane(store.getState()).title.map((run) => run.text).join("");
    assert.match(activityTitle, /Activity/);
    assert.equal(/Worker/.test(activityTitle), false);
});

test("degraded mode: no registry data still yields activity-derived nodes", () => {
    const store = createStore(appReducer, createInitialState());
    seedState(store, {
        workers: [],
        sessions: [{ sessionId: "s1", title: "solo", state: "running" }],
        histories: { s1: [{ createdAt: new Date(NOW - 5_000), workerNodeId: podB }] },
    });
    const view = selectNodeMapView(store.getState());
    assert.equal(view.degraded, true);
    assert.equal(view.registered, 0);
    assert.deepEqual(view.nodes.map((node) => node.label), ["chl82"]);
    assert.equal(view.nodes[0].registered, false);
});
