/**
 * Worker-registry UI core — the Admin → Workers view-model.
 *
 * Both hosts (web table, TUI lines-builder) render from selectAdminConsole's
 * `workers` view, so this is the parity floor for both surfaces: section
 * gating (admin-only tree row), liveness windowing, phase counts, sorting,
 * and the controller fetch path over transport.listWorkers.
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
    PilotSwarmUiController,
    appReducer,
    createInitialState,
    createStore,
    selectAdminConsole,
} from "../src/index.js";

const ADMIN = { provider: "test", subject: "root", email: "root@test", isAdmin: true };

function makeController(transportOverrides = {}, profile = ADMIN) {
    const transport = {
        listSessions: async () => [],
        subscribeSession: () => () => {},
        getCurrentUserProfile: async () => ({ ...profile, githubCopilotKeySet: false, profileSettings: {} }),
        listCreatableAgents: async () => [],
        getSessionCreationPolicy: () => ({ creation: { allowGeneric: true } }),
        ...transportOverrides,
    };
    const store = createStore(appReducer, createInitialState());
    const controller = new PilotSwarmUiController({ store, transport });
    return { controller, transport, store };
}

function workerRow(id, overrides = {}) {
    return {
        workerNodeId: id,
        pool: "aks-default",
        phase: "ready",
        owner: null,
        registeredAt: new Date(Date.now() - 3_600_000),
        updatedAt: new Date(),
        info: { sdkVersion: "0.5.29", consumes: ["agent-packages"], runtime: { substrate: "kubernetes" } },
        health: { uptimeS: 7500, rssBytes: 210 * 1024 * 1024, heapUsedBytes: 90e6, eventLoopDelayP99Ms: 4.2, activeSessions: 3 },
        state: { "agent-packages": { epoch: 7, installed: { "incident-kit": { semver: "1.4.0", status: "ok" }, "broken-kit": { semver: "1.0.0", status: "error" } } } },
        ...overrides,
    };
}

test("workers view: liveness window, phase counts, pool sort, health text", async () => {
    const { controller, store } = makeController({
        listWorkers: async () => [
            workerRow("pod-b"),
            workerRow("pod-a", { pool: "aks-default", phase: "draining" }),
            workerRow("laptop-1", {
                pool: "affan-laptop",
                owner: { provider: "test", subject: "affan" },
                info: { sdkVersion: "0.5.29", consumes: [], runtime: { substrate: "process" } },
                state: {},
            }),
            workerRow("pod-dead", { updatedAt: new Date(Date.now() - 10 * 60_000), phase: "ready" }),
        ],
    });
    store.dispatch({ type: "admin/visibility", visible: true });
    store.dispatch({ type: "admin/profile/loaded", profile: { ...ADMIN, githubCopilotKeySet: false, profileSettings: {} } });

    controller.setAdminSection("workers");
    await controller.refreshAdminWorkers();

    const view = selectAdminConsole(store.getState());
    assert.equal(view.section, "workers");

    // Admin-only tree row, selected.
    const treeRow = view.settingsTree.find((row) => row.id === "workers");
    assert.ok(treeRow, "admins get a Workers section in the settings tree");
    assert.equal(treeRow.selected, true);

    const workers = view.workers;
    assert.equal(workers.error, null);
    assert.equal(workers.rows.length, 4);
    // Pool-major sort: affan-laptop < aks-default; ids ascend within a pool.
    assert.deepEqual(workers.rows.map((row) => row.id), ["laptop-1", "pod-a", "pod-b", "pod-dead"]);

    // 90s liveness window: the 10-minute-silent pod is registered, not live.
    const dead = workers.rows.find((row) => row.id === "pod-dead");
    assert.equal(dead.live, false);
    assert.equal(workers.counts.registered, 4);
    assert.equal(workers.counts.live, 3);
    assert.equal(workers.counts.ready, 2);
    assert.equal(workers.counts.draining, 1);
    assert.equal(workers.counts.pools, 2);
    assert.equal(workers.summaryText, "3 live / 4 registered");

    // Health/state formatting the hosts print verbatim.
    const podB = workers.rows.find((row) => row.id === "pod-b");
    assert.equal(podB.phase, "ready");
    assert.equal(podB.sessions, 3);
    assert.equal(podB.uptimeText, "2h 5m");
    assert.equal(podB.eventLoopText, "4.2ms");
    assert.equal(podB.pkgEpoch, 7);
    assert.equal(podB.pkgText, "1 ok · 1 error");
    assert.equal(podB.substrate, "kubernetes");

    const laptop = workers.rows.find((row) => row.id === "laptop-1");
    assert.equal(laptop.owner, "affan");
    assert.equal(laptop.substrate, "process");
    assert.equal(laptop.pkgText, null, "worker without agent-packages state shows no pkg column");
});

test("workers section is hidden from non-admins; unknown sections fall back to ghcp", async () => {
    const { store } = makeController({}, { ...ADMIN, subject: "alice", isAdmin: false });
    store.dispatch({ type: "admin/visibility", visible: true });
    store.dispatch({
        type: "admin/profile/loaded",
        profile: { provider: "test", subject: "alice", email: "a@test", isAdmin: false, githubCopilotKeySet: false, profileSettings: {} },
    });

    const view = selectAdminConsole(store.getState());
    assert.equal(view.settingsTree.some((row) => row.id === "workers"), false,
        "non-admins never see the Workers section");

    store.dispatch({ type: "admin/section", section: "bogus" });
    assert.equal(selectAdminConsole(store.getState()).section, "ghcp");
});

test("transport without listWorkers degrades to a visible error, not a crash", async () => {
    const { controller, store } = makeController();
    store.dispatch({ type: "admin/visibility", visible: true });
    store.dispatch({ type: "admin/profile/loaded", profile: { ...ADMIN, githubCopilotKeySet: false, profileSettings: {} } });

    controller.setAdminSection("workers");
    await controller.refreshAdminWorkers();

    const view = selectAdminConsole(store.getState());
    assert.equal(view.section, "workers");
    assert.match(view.workers.error, /not available/);
    assert.equal(view.workers.rows.length, 0);
});
