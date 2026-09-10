import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PilotSwarmUiController, appReducer, createInitialState, createStore, selectAdminConsole } from "../src/index.js";
import { FeatureFlagsPanel, featureWorkerStatus } from "../../react/src/feature-flags-panel.js";
import { projectWorker } from "../../../../sdk/api/src/admin-diagnostics.js";

const KEY = "copilot.native_tasks";
const ADMIN = { provider: "test", subject: "admin", isAdmin: true };
const flag = (revision = "1", extra = {}) => ({ featureKey: KEY, revision, displayName: "Native tasks", description: "Local delegation",
    defaultEnabled: false, defaultAllowUserOverride: false, cluster: null, user: null,
    effective: false, source: "default", supported: true, ...extra });
const data = (revision = "1", extra = {}) => ({ flags: [flag(revision, extra)] });
function deferred() { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
const tick = () => new Promise(resolve => setImmediate(resolve));
function setup(overrides = {}, profile = ADMIN) {
    const store = createStore(appReducer, createInitialState({ mode: "remote" }));
    store.dispatch({ type: "admin/profile/loaded", profile });
    const transport = { listSessions: async () => [], subscribeSession: () => () => {}, getCurrentUserProfile: async () => profile,
        getMyFeatureFlags: async () => data(), getClusterFeatureFlags: async () => data(), getUserFeatureFlags: async () => data(),
        listFeatureFlagUsers: async () => [], listWorkers: async () => [], ...overrides };
    const controller = new PilotSwarmUiController({ store, transport });
    return { store, controller, transport, features: () => store.getState().admin.features };
}
function render(controller, store, extra = {}) {
    const state = store.getState();
    return renderToStaticMarkup(React.createElement(FeatureFlagsPanel, { controller, features: state.admin.features,
        isAdmin: state.admin.profile?.isAdmin === true, workers: state.admin.workers.list, workersError: state.admin.workers.error, ...extra }));
}

test("feature policy renders while optional user/worker diagnostics are still pending", async () => {
    const directory = deferred(), workers = deferred();
    const { controller, features } = setup({ listFeatureFlagUsers: () => directory.promise, listWorkers: () => workers.promise });
    await controller.refreshFeatureFlags();
    assert.equal(features().loading, false);
    assert.equal(features().data.flags[0].featureKey, KEY);
    assert.equal(features().usersLoading, true);
    directory.reject(new Error("directory unavailable")); workers.resolve([]); await tick();
    assert.match(features().metadataError, /directory unavailable/);
    assert.equal(features().data.flags[0].featureKey, KEY);
});

test("slow old user reads and search replies cannot replace the selected user", async () => {
    const old = deferred(), search = deferred();
    const { controller, features } = setup({ getUserFeatureFlags: userId => userId === 1 ? old.promise : Promise.resolve({ userId, flags: [flag("2")] }),
        listFeatureFlagUsers: query => query === "old" ? search.promise : Promise.resolve([{ userId: 2, subject: "current" }]) });
    const first = controller.selectFeatureScope("users", 1);
    await controller.selectFeatureScope("users", 2);
    old.resolve({ userId: 1, flags: [flag("1")] }); await first;
    assert.equal(features().userId, 2); assert.equal(features().data.userId, 2);
    const pendingSearch = controller.searchFeatureUsers("old");
    await controller.searchFeatureUsers("new");
    search.resolve([{ userId: 1, subject: "stale" }]); await pendingSearch;
    assert.deepEqual(features().users, [{ userId: 2, subject: "current" }]);
});

test("role/identity changes clear private state and reject pending responses and stale writes", async () => {
    const old = deferred(); let writes = 0;
    const { controller, store, features } = setup({ getUserFeatureFlags: () => old.promise, setUserFeatureFlag: async () => { writes++; } });
    store.dispatch({ type: "auth/context", principal: ADMIN, authorization: { role: "admin" } });
    const reading = controller.selectFeatureScope("users", 42);
    store.dispatch({ type: "admin/profile/loaded", profile: { ...ADMIN, isAdmin: false } });
    old.resolve({ userId: 42, flags: [flag()] }); await reading;
    assert.equal(features().mode, "mine"); assert.equal(features().data, null); assert.deepEqual(features().users, []);
    await controller.selectFeatureScope("cluster"); assert.equal(features().mode, "mine");
    await controller.saveFeatureFlag(KEY, { enabled: true }); assert.equal(writes, 0);
    assert.doesNotMatch(render(controller, store), />Cluster settings<|>User settings<|data-feature-key=/);
    // Authentication changes may precede the profile refresh.
    store.dispatch({ type: "admin/profile/loaded", profile: ADMIN });
    store.dispatch({ type: "admin/features", patch: { mode: "cluster", data: data(), users: [{ userId: 42 }] } });
    store.dispatch({ type: "auth/context", principal: { provider: "test", subject: "new-user" }, authorization: { role: "user" } });
    assert.equal(features().mode, "mine"); assert.equal(features().data, null);
    await controller.selectFeatureScope("cluster"); assert.equal(features().mode, "mine");
});

test("uncertain mutation retries reuse identity; conflicts remain visible until addressed", async () => {
    const calls = []; let revision = "1";
    const { controller, features } = setup({ getMyFeatureFlags: async () => data(revision),
        setMyFeatureFlag: async input => { calls.push(input); if (calls.length === 1) throw new Error("connection dropped"); revision = "2"; } }, { ...ADMIN, isAdmin: false });
    await controller.refreshFeatureFlags();
    await controller.saveFeatureFlag(KEY, { enabled: true }); assert.match(features().error, /connection dropped/);
    await controller.saveFeatureFlag(KEY, { enabled: true });
    assert.equal(calls[0].requestId, calls[1].requestId); assert.equal(calls[1].expectedRevision, "1");
    assert.equal(features().data.flags[0].revision, "2"); assert.equal(features().notice, "Setting saved.");
    assert.equal(features().saving, false);
    const other = setup({ setMyFeatureFlag: async () => { throw Object.assign(new Error("Feature changed; reload before saving"), { status: 409 }); } }, { ...ADMIN, isAdmin: false });
    await other.controller.refreshFeatureFlags(); await other.controller.saveFeatureFlag(KEY, { enabled: true });
    assert.match(other.features().error, /reload before saving/); assert.equal(other.features().data.flags[0].revision, "1");
});

test("request timeouts release controls and preserve mutation retry identity", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const read = deferred(), write = deferred(); const calls = [];
    const { controller, transport, features } = setup({ getMyFeatureFlags: () => read.promise,
        setMyFeatureFlag: input => { calls.push(input); return calls.length === 1 ? write.promise : Promise.resolve(); } }, { ...ADMIN, isAdmin: false });
    const loading = controller.refreshFeatureFlags(); await tick(); t.mock.timers.tick(10_000); await loading;
    assert.equal(features().loading, false); assert.match(features().error, /timed out/);
    transport.getMyFeatureFlags = async () => data(); await controller.refreshFeatureFlags();
    const saving = controller.saveFeatureFlag(KEY, { enabled: true }); await tick(); t.mock.timers.tick(10_000); await saving;
    assert.equal(features().saving, false); assert.match(features().error, /timed out/);
    await controller.saveFeatureFlag(KEY, { enabled: true }); assert.equal(calls[0].requestId, calls[1].requestId);
    read.resolve(data("99")); write.resolve(); await tick();
    assert.equal(features().data.flags[0].revision, "1", "late completion cannot publish an obsolete read");
});

test("a previous identity's completed save cannot clear the new identity's uncertain retry", async () => {
    const oldWrite = deferred(); const calls = [];
    const { controller, store, features } = setup({ setMyFeatureFlag: input => {
        calls.push(input); if (calls.length === 1) return oldWrite.promise;
        if (calls.length === 2) return Promise.reject(new Error("uncertain new-user response"));
        return Promise.resolve();
    } }, { ...ADMIN, isAdmin: false });
    await controller.refreshFeatureFlags(); const pending = controller.saveFeatureFlag(KEY, { enabled: true }); await tick();
    store.dispatch({ type: "admin/profile/loaded", profile: { ...ADMIN, subject: "new-user", isAdmin: false } });
    await controller.refreshFeatureFlags(); await controller.saveFeatureFlag(KEY, { enabled: true });
    oldWrite.resolve(); await pending;
    assert.match(features().error, /uncertain new-user response/);
    await controller.saveFeatureFlag(KEY, { enabled: true });
    assert.notEqual(calls[0].requestId, calls[1].requestId); assert.equal(calls[1].requestId, calls[2].requestId);
});

test("scope-specific mutations carry selected numeric user and revision; inheritance uses unset", async () => {
    const calls = [];
    const { controller } = setup({ setClusterFeatureFlag: async input => calls.push(["cluster", input]),
        resetClusterFeatureFlag: async input => calls.push(["reset", input]),
        setUserFeatureFlag: async (userId, input) => calls.push(["user", userId, input]),
        unsetUserFeatureFlag: async (userId, input) => calls.push(["unset", userId, input]) });
    await controller.selectFeatureScope("cluster"); await controller.saveFeatureFlag(KEY, { enabled: true, allowUserOverride: false });
    await controller.saveFeatureFlag(KEY, null);
    await controller.selectFeatureScope("users", 7); await controller.saveFeatureFlag(KEY, { enabled: false }); await controller.saveFeatureFlag(KEY, null);
    assert.deepEqual(calls.map(call => call[0]), ["cluster", "reset", "user", "unset"]);
    assert.equal(calls[0][1].allowUserOverride, false); assert.equal(calls[2][1], 7); assert.equal(calls[3][1], 7);
    assert.equal(calls[3][2].expectedRevision, "1"); assert.equal("enabled" in calls[3][2], false);
});

test("visible feature settings refresh on the existing cadence and on reopen, without discarding dirty drafts", async () => {
    let reads = 0;
    const { controller, store, features } = setup({ getMyFeatureFlags: async () => data(String(++reads)) });
    store.dispatch({ type: "admin/section", section: "features" });
    await controller.openAdminConsole(); await tick(); assert.equal(reads, 1);
    store.dispatch({ type: "admin/features", patch: { fetchedAt: Date.now() - 21_000 } });
    controller.setFeatureDraft(KEY, { enabled: true });
    await controller.refreshFeatureFlagsIfStale(); assert.equal(reads, 2);
    assert.deepEqual(controller.getFeatureDraft(KEY).values, { enabled: true });
    assert.equal(controller.getFeatureDraft(KEY).expectedRevision, "1", "background reads preserve the edit's conflict baseline");
    await controller.refreshFeatureFlagsIfStale(); assert.equal(reads, 2);
    controller.closeAdminConsole(); await controller.openAdminConsole(); await tick();
    assert.equal(reads, 3); assert.equal(features().data.flags[0].revision, "3");
    assert.deepEqual(controller.getFeatureDraft(KEY).values, { enabled: true }, "reopening retains unsaved choices");
    assert.match(render(controller, store), /Settings changed since this edit began/);
});

test("adoption follows shared worker refresh and exposes errors/capability without claiming application on save", async () => {
    const { controller, store } = setup();
    store.dispatch({ type: "admin/features", patch: { data: data("5") } });
    const worker = revision => ({ workerNodeId: "worker-1", phase: "ready", updatedAt: new Date().toISOString(), state: { "feature-flags": {
        protocolVersion: 1, initialized: true, supportedKeys: [KEY], appliedRevisions: { [KEY]: revision },
        nativeCapability: "off", lastError: "PRIVATE database hostname and credentials" } } });
    store.dispatch({ type: "admin/workers/loaded", list: [worker("4")] });
    assert.match(render(controller, store), /Settings delivery: 0 of 1 reporting workers updated/);
    store.dispatch({ type: "admin/workers/loaded", list: [worker("5")] });
    const html = render(controller, store);
    assert.match(html, /Settings delivery: 1 of 1 reporting workers updated/);
    assert.match(html, /Native task support: 0 of 1 reporting workers configured; 1 configured Off; 0 unknown/);
    assert.match(html, /1 reported a refresh problem/); assert.match(html, /settings refresh problem/);
    assert.doesNotMatch(html, /PRIVATE database hostname and credentials|allow native execution/);
    assert.match(html, /Settings delivery does not confirm that each session has refreshed its tools/);
    assert.match(html, /Off for you/, "received settings must not imply the feature is On");
});

test("React controls show self/admin scopes, locked preference, empty catalog, search and unsupported rows", () => {
    const { controller, store } = setup();
    store.dispatch({ type: "admin/features", patch: { data: data("2", { user: { enabled: true }, userOverrideIgnored: true }) } });
    let html = render(controller, store);
    assert.match(html, />My settings</); assert.match(html, />Cluster settings</); assert.match(html, />User settings</);
    assert.match(html, /Off for you/); assert.match(html, /Required by the cluster/);
    assert.match(html, /Saved future preference: On/); assert.match(html, /Preference for when personal settings are allowed/);
    const onChoice = [...html.matchAll(/<input\b[^>]*>/g)].map(match => match[0]).find(input => input.includes('value="true"'));
    assert.match(onChoice, /checked=""/, "the retained On choice stays selected even while cluster Off applies");
    store.dispatch({ type: "admin/features", patch: { mode: "users", userId: 900, users: Array.from({ length: 500 }, (_, i) => ({ userId: i + 1, subject: `user-${i}` })) } });
    html = render(controller, store); assert.match(html, /Find feature settings user/); assert.match(html, /first 500 users/); assert.match(html, /Selected user ID: 900/);
    // Even stale caller state cannot render another user's controls after demotion.
    assert.doesNotMatch(render(controller, store, { isAdmin: false }), /data-feature-key=|On for this user|Off for this user|>User settings</);
    store.dispatch({ type: "admin/features", patch: { mode: "mine", data: { flags: [] } } });
    assert.match(render(controller, store), /No feature definitions are published/);
    store.dispatch({ type: "admin/features", patch: { data: data("1", { supported: false }) } });
    assert.match(render(controller, store), /does not support changing/);
    const tree = selectAdminConsole(store.getState()).settingsTree;
    assert.ok(tree.findIndex(row => row.id === "features") > tree.findIndex(row => row.id === "myProviders"));
});

const NOW = Date.parse("2026-09-09T18:00:00.000Z");
const telemetryWorker = (id, state = {}, row = {}) => ({ workerNodeId: id, phase: "ready", updatedAt: new Date(NOW).toISOString(),
    state: { "feature-flags": { protocolVersion: 1, initialized: true, supportedKeys: [KEY],
        appliedRevisions: { [KEY]: "5" }, nativeCapability: "sync", lastError: null, ...state } }, ...row });

test("delivery accepts only lossless positive BIGINT revisions and separates older from newer settings", () => {
    const current = flag("5");
    const status = revision => featureWorkerStatus(current, [telemetryWorker("worker", { appliedRevisions: { [KEY]: revision } })], NOW);
    for (const revision of ["5", "6", "9223372036854775807"]) {
        assert.equal(status(revision).updated, 1, `${revision} is at least the saved revision`);
    }
    assert.equal(status("4").reports[0].delivery, "pending");
    for (const revision of [undefined, null, 5, "0", "-1", "05", "5.0", "5e2", "9223372036854775808", "9".repeat(10_000), {}, []]) {
        const result = status(revision);
        assert.equal(result.updated, 0); assert.equal(result.unknown, 1, "malformed revisions must stay unknown");
        assert.equal(result.capable, 1, "configuration capability is separate from revision validity");
    }
});

test("delivery counts recent ready workers and separates unknown, stale, draining, and unsupported reports", () => {
    const rows = [telemetryWorker("current"), telemetryWorker("older", { appliedRevisions: { [KEY]: "4" } }),
        telemetryWorker("missing", {}, { state: {} }), telemetryWorker("unsupported", { supportedKeys: [] }),
        telemetryWorker("loading", { initialized: false, appliedRevisions: {} }),
        telemetryWorker("stale", {}, { updatedAt: new Date(NOW - 90_000).toISOString() }),
        telemetryWorker("undated", {}, { updatedAt: "invalid" }), telemetryWorker("draining", {}, { phase: "draining" }),
        telemetryWorker("starting", {}, { phase: "starting" }), telemetryWorker("future", {}, { updatedAt: new Date(NOW + 60_000).toISOString() })];
    const result = featureWorkerStatus(flag("5"), rows, NOW);
    assert.equal(result.eligible, 5); assert.equal(result.updated, 1); assert.equal(result.unknown, 1);
    assert.equal(result.unsupported, 1); assert.equal(result.stale, 3); assert.equal(result.draining, 1); assert.equal(result.other, 1);
    assert.equal(result.reports.find(report => report.workerNodeId === "loading").delivery, "loading");
    assert.ok(result.reports.filter(report => !report.eligible).every(report => report.delivery === "unknown" && report.capability === "unknown"));
});

test("restricted worker diagnostics render current delivery without raw state or false zero counts", () => {
    const { controller, store } = setup();
    store.dispatch({ type: "admin/features", patch: { data: data("5") } });
    const source = telemetryWorker("restricted", { lastError: "PRIVATE-CANARY", secret: "PRIVATE-CANARY" }, { updatedAt: new Date().toISOString() });
    const projected = projectWorker(source);
    store.dispatch({ type: "admin/workers/loaded", list: [projected] });
    const html = render(controller, store);
    assert.match(html, /Settings delivery: 1 of 1 reporting workers updated/);
    assert.match(html, /Native task support: 1 of 1 reporting workers configured/);
    assert.match(html, /settings refresh problem/); assert.doesNotMatch(html, /PRIVATE-CANARY/);
    for (const supportedKeys of [[7, null], [KEY, 7], [null]]) {
        const projectedMalformed = projectWorker(telemetryWorker("malformed", { supportedKeys }));
        const result = featureWorkerStatus(flag("5"), [projectedMalformed], NOW);
        assert.equal(result.unknown, 1, "projection must not turn malformed support claims into confirmed unsupported status");
        assert.equal(result.unsupported, 0);
    }
});
