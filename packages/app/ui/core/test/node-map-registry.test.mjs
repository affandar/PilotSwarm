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

test("selection toggles and scopes the Activity pane to the node's sessions", () => {
    const store = createStore(appReducer, createInitialState());
    seedState(store, {
        workers: [workerRow(podA)],
        sessions: [{ sessionId: "s1", title: "triage", state: "running" }],
        histories: { s1: [{ createdAt: new Date(NOW - 10_000), workerNodeId: podA }] },
    });

    store.dispatch({ type: "ui/nodeMapSelect", label: "z6dcb" });
    assert.equal(selectNodeMapView(store.getState()).selected, "z6dcb");

    // The pane becomes a WORKER DETAILS panel: registry specs, then the
    // sessions executing on the node.
    const scoped = selectActivityPane(store.getState());
    const titleText = scoped.title.map((run) => run.text).join("");
    assert.match(titleText, /Worker z6dcb/);
    const lineText = scoped.lines.map((line) => (Array.isArray(line) ? line : [line]).map((run) => run.text).join("")).join("\n");
    assert.match(lineText, new RegExp(podA), "full worker node id shown");
    assert.match(lineText, /Phase\s+ready/);
    assert.match(lineText, /Pool\s+aks-default/);
    assert.match(lineText, /rss 180\.0 MB/);
    assert.equal(/heap/.test(lineText), false, "absent heap metric renders nothing, not 0 B");
    assert.match(lineText, /EXECUTING \(1\)/);
    assert.match(lineText, /triage/);

    // Toggle off: same label clears; Activity returns to session scope.
    store.dispatch({ type: "ui/nodeMapSelect", label: "z6dcb" });
    assert.equal(store.getState().ui.nodeMapSelectedNode, null);
    const unscoped = selectActivityPane(store.getState());
    assert.equal(unscoped.title.map((run) => run.text).join("").includes("node"), false);

    // A selection for a node that no longer exists resolves to none.
    store.dispatch({ type: "ui/nodeMapSelect", label: "gone9" });
    assert.equal(selectNodeMapView(store.getState()).selected, null);
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
