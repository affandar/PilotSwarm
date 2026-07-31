/**
 * Agent-packages UI core — picker grouping + the Admin → Agents view-models.
 *
 * Guards the both-hosts contract: everything the web workspace and the TUI
 * lines-builder render comes from selectAdminConsole / the picker selector,
 * so these tests are the parity floor for BOTH surfaces.
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
    PilotSwarmUiController,
    appReducer,
    createInitialState,
    createStore,
    selectAdminConsole,
    selectSessionAgentPickerModal,
} from "../src/index.js";

const ALICE = { provider: "test", subject: "alice", email: "alice@test", isAdmin: false };

function makeController(transportOverrides = {}) {
    const transport = {
        listSessions: async () => [],
        subscribeSession: () => () => {},
        getCurrentUserProfile: async () => ({ ...ALICE, githubCopilotKeySet: false, profileSettings: {} }),
        listCreatableAgents: async () => [],
        getSessionCreationPolicy: () => ({ creation: { allowGeneric: true } }),
        ...transportOverrides,
    };
    const store = createStore(appReducer, createInitialState());
    const controller = new PilotSwarmUiController({ store, transport });
    return { controller, transport, store };
}

const CATALOG = [
    { name: "builtin-bot", title: "Builtin Bot", description: "Baked in", source: "builtin" },
    { name: "shared-triager", title: "Shared Triager", source: "package", scope: "shared", packageName: "incident-kit", packageSemver: "1.4.0" },
    { name: "my-scraper", title: "My Scraper", source: "package", scope: "user", packageName: "hn-scraper", packageSemver: "0.2.1" },
];

test("picker groups Shared → My agents → Generic with heading rows", async () => {
    const { controller, store } = makeController({
        listCreatableAgents: async () => CATALOG,
    });
    await controller.openSessionAgentPicker();

    const modal = store.getState().ui.modal;
    assert.equal(modal.type, "sessionAgentPicker");
    assert.deepEqual(
        modal.items.map((item) => item.kind === "generic" ? "generic" : item.agentName),
        ["builtin-bot", "shared-triager", "my-scraper", "generic"],
        "items pre-sorted: shared (builtin + shared packages), then mine, then generic",
    );

    const view = selectSessionAgentPickerModal(store.getState());
    assert.ok(Array.isArray(view.rowItemIndexes), "grouped picker emits rowItemIndexes");
    const headings = view.rowItemIndexes
        .map((itemIndex, rowIndex) => (itemIndex === null ? rowIndex : null))
        .filter((rowIndex) => rowIndex !== null);
    assert.equal(headings.length, 3, "Shared, My agents, and the generic separator");
    const headingTexts = headings.map((rowIndex) => view.rows[rowIndex].map((run) => run.text).join(""));
    assert.match(headingTexts[0], /Shared/);
    assert.match(headingTexts[1], /My agents/);

    // Every non-heading row maps back to a real item.
    for (const itemIndex of view.rowItemIndexes) {
        if (itemIndex !== null) assert.ok(modal.items[itemIndex], "row maps to an item");
    }

    // Detail pane names the package for package agents.
    store.dispatch({ type: "ui/modal", modal: { ...modal, selectedIndex: 1 } });
    const detail = selectSessionAgentPickerModal(store.getState());
    const detailText = detail.detailsLines.map((line) => line.map((run) => run.text).join("")).join("\n");
    assert.match(detailText, /incident-kit@1\.4\.0 · shared/);
});

function loadedPackagesState(store) {
    store.dispatch({ type: "admin/visibility", visible: true });
    store.dispatch({
        type: "admin/profile/loaded",
        profile: { ...ALICE, githubCopilotKeySet: false, profileSettings: {} },
    });
    store.dispatch({
        type: "admin/packages/loaded",
        list: [
            {
                packageId: "p1", sourceId: "src-1", name: "incident-kit", scope: "shared",
                owner: { provider: "test", subject: "alice" }, enabled: true,
                createdBy: "alice@test", createdAt: "2026-07-12T00:00:00Z",
                active: {
                    versionId: "v2", semver: "1.4.0", sha256: "a1b2c3d4e5f60718", sizeBytes: 4096,
                    artifactFilename: "incident-kit@1.4.0.a1b2c3d4e5f6.tar.gz", commitSha: null,
                    manifest: { description: "Incident agents", agents: [{ name: "shared-triager", tools: ["t1"] }] },
                    createdAt: "2026-07-27T00:00:00Z", createdBy: "alice@test",
                },
            },
            {
                packageId: "p2", sourceId: null, name: "other-kit", scope: "user",
                owner: { provider: "test", subject: "bob" }, enabled: false,
                createdBy: "bob@test", createdAt: "2026-07-10T00:00:00Z",
                active: null,
            },
        ],
        workerState: [
            { workerNodeId: "w1", epoch: 4, installed: { "incident-kit": { semver: "1.4.0", status: "ok" } }, updatedAt: new Date().toISOString() },
            { workerNodeId: "w2", epoch: 4, installed: { "incident-kit": { semver: "1.3.2", status: "ok" } }, updatedAt: new Date().toISOString() },
            // Retired pod from a previous rollout — outside the liveness
            // window, must NOT count toward fleet totals.
            { workerNodeId: "w-old", epoch: 3, installed: { "incident-kit": { semver: "1.4.0", status: "ok" } }, updatedAt: "2026-07-27T03:00:00Z" },
        ],
    });
}

test("admin settings tree groups packages by scope with badges and counts", () => {
    const store = createStore(appReducer, createInitialState());
    loadedPackagesState(store);

    const view = selectAdminConsole(store.getState());
    const tree = view.settingsTree;
    assert.deepEqual(tree.filter((r) => r.kind === "section").map((r) => r.label), ["GitHub Keys", "Agents"]);
    const shared = tree.find((r) => r.id === "group:shared");
    const user = tree.find((r) => r.id === "group:user");
    const others = tree.find((r) => r.id === "group:others");
    assert.equal(shared.count, 1);
    // "User" is the VIEWER's own private packages. Someone else's private
    // package (bob's) is not part of alice's workspace — it is listed under
    // "Other users" instead of cluttering her own section.
    assert.equal(user.count, 0, "alice owns no user-scope packages");
    assert.equal(others.count, 1, "bob's private package is grouped separately");
    const pkgRow = tree.find((r) => r.id === "pkg:incident-kit");
    assert.equal(pkgRow.scope, "shared");
    assert.equal(pkgRow.semver, "1.4.0");
    assert.equal(pkgRow.canManage, true, "owner manages their package");
    const foreign = tree.find((r) => r.id === "pkg:other-kit");
    assert.equal(foreign.canManage, false, "non-owner non-admin cannot manage");
    assert.equal(foreign.enabled, false);
});

test("package detail VM: versions and fleet adoption", () => {
    const store = createStore(appReducer, createInitialState());
    loadedPackagesState(store);
    store.dispatch({ type: "admin/packages/select", name: "incident-kit" });
    store.dispatch({
        type: "admin/packages/detail/loaded",
        name: "incident-kit",
        detail: {
            packageId: "p1", sourceId: "src-1", name: "incident-kit", scope: "shared",
            owner: { provider: "test", subject: "alice" }, enabled: true,
            createdBy: "alice@test", createdAt: "2026-07-12T00:00:00Z", activeVersionId: "v2",
            versions: [
                { versionId: "v2", semver: "1.4.0", sha256: "a1b2c3d4e5f60718", sizeBytes: 4096, artifactFilename: "f2", commitSha: null, manifest: { description: "Incident agents", agents: [{ name: "shared-triager" }] }, createdAt: "2026-07-27T00:00:00Z", createdBy: "alice@test" },
                { versionId: "v1", semver: "1.3.2", sha256: "ffff0000ffff0000", sizeBytes: 2048, artifactFilename: "f1", commitSha: null, manifest: {}, createdAt: "2026-07-19T00:00:00Z", createdBy: "alice@test" },
            ],
        },
    });

    const view = selectAdminConsole(store.getState());
    assert.equal(view.section, "packages", "selecting a package switches the section");
    const detail = view.packages.detail;
    assert.equal(detail.activeSemver, "1.4.0");
    assert.equal(detail.activeSha12, "a1b2c3d4e5f6");
    assert.equal(detail.versions.length, 2);
    assert.equal(detail.versions[0].active, true);
    assert.equal(detail.versions[1].active, false);
    assert.equal(detail.fleet.text, "1/2 workers current",
        "fleet counts only LIVE workers (fresh heartbeat) that are current+ok — the retired pod row is excluded");
    // Packages are imported client-side and published as artifacts — there
    // is no server-side source row to display any more.
    assert.equal(detail.source, undefined);
    assert.equal(detail.canManage, true);
});

test("workspace VM honors expandedDirs and file preview state", () => {
    const store = createStore(appReducer, createInitialState());
    loadedPackagesState(store);
    store.dispatch({ type: "admin/packages/select", name: "incident-kit" });
    store.dispatch({
        type: "admin/packages/tree/loaded",
        name: "incident-kit",
        tree: {
            name: "incident-kit", semver: "1.4.0", sha256: "a1b2c3d4e5f60718",
            dirs: ["agents", "skills", "skills/ops"],
            files: [
                { path: "plugin.json", size: 100 },
                { path: "agents/triager.agent.md", size: 2100 },
                { path: "skills/ops/SKILL.md", size: 3400 },
            ],
        },
    });

    let view = selectAdminConsole(store.getState());
    let paths = view.packages.workspace.treeRows.map((r) => r.path);
    assert.ok(paths.includes("agents/triager.agent.md"), "top-level dirs start expanded");
    assert.ok(!paths.includes("skills/ops/SKILL.md"), "deeper levels start collapsed");

    store.dispatch({ type: "admin/packages/toggleDir", dir: "skills/ops" });
    view = selectAdminConsole(store.getState());
    paths = view.packages.workspace.treeRows.map((r) => r.path);
    assert.ok(paths.includes("skills/ops/SKILL.md"), "expanding a dir reveals its files");

    store.dispatch({ type: "admin/packages/file/loading", path: "plugin.json" });
    store.dispatch({
        type: "admin/packages/file/loaded",
        file: { path: "plugin.json", size: 100, truncated: false, encoding: "utf8", content: '{"name":"incident-kit"}' },
    });
    view = selectAdminConsole(store.getState());
    assert.equal(view.packages.workspace.file.language, "json");
    assert.match(view.packages.workspace.file.text, /incident-kit/);

    // A stale file load (path no longer selected) must be ignored.
    store.dispatch({ type: "admin/packages/file/loading", path: "agents/triager.agent.md" });
    store.dispatch({
        type: "admin/packages/file/loaded",
        file: { path: "plugin.json", size: 100, truncated: false, encoding: "utf8", content: "stale" },
    });
    view = selectAdminConsole(store.getState());
    assert.equal(view.packages.workspace.file, null, "stale load is dropped while the new file loads");
});
