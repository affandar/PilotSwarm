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

// The picker opens FULLY COLLAPSED, so package rows are not on screen until
// their category is opened. Tests that reach for a package go through here.
const CATEGORY_KEYS = ["builtin", "installed:shared", "installed:mine"];
const openCategories = (controller) => {
    for (const key of CATEGORY_KEYS) controller.toggleAgentPickerSection(key);
};
const packageSection = (store, packageName) =>
    store.getState().ui.modal.items.find((item) => item.packageName === packageName);

// Owner keys join provider and subject with U+0001 (see ownerKeyForOwner).
const ownerKey = (subject) => `test${subject}`;

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
    { name: "shared-triager", title: "Shared Triager", source: "package", scope: "shared", packageName: "incident-kit", packageTitle: "Incident Kit", packageSemver: "1.4.0" },
    { name: "my-scraper", title: "My Scraper", source: "package", scope: "user", packageName: "hn-scraper", packageSemver: "0.2.1" },
];

// An ADMIN sees every user's user-scoped packages, so "scope is user" is not
// "mine". The transport knows the viewer and says so; grouping on scope alone
// filed other people's agents onto the caller's shelf.
test("another user's user-scoped agent is not badged as mine", async () => {
    const { controller, store } = makeController({
        listCreatableAgents: async () => [
            { name: "mine-bot", title: "Mine Bot", source: "package", scope: "user", mine: true, packageName: "my-kit", packageSemver: "1.0.0" },
            { name: "theirs-bot", title: "Theirs Bot", source: "package", scope: "user", mine: false, packageName: "their-kit", packageSemver: "1.0.0" },
        ],
    });
    await controller.openSessionAgentPicker();

    const catalog = store.getState().ui.modal.catalog;
    const groupOf = (agentName) => catalog.find((item) => item.agentName === agentName)?.group;
    assert.equal(groupOf("mine-bot"), "mine", "my own user-scoped package stays mine");
    assert.equal(groupOf("theirs-bot"), "shared", "another user's user-scoped package must not be mine");

    // Ownership picks the SHELF now, not a badge. Another user's user-scoped
    // package is not mine, so it files under Shared.
    openCategories(controller);
    assert.equal(packageSection(store, "my-kit").mine, true);
    assert.equal(packageSection(store, "their-kit").mine, false);
    const shelfOf = (packageName) => {
        const items = store.getState().ui.modal.items;
        const index = items.findIndex((item) => item.packageName === packageName);
        for (let i = index; i >= 0; i -= 1) {
            if (items[i].sectionKind === "installed") return items[i].sectionKey;
        }
        return null;
    };
    assert.equal(shelfOf("my-kit"), "installed:mine");
    assert.equal(shelfOf("their-kit"), "installed:shared");
});

test("the picker opens as a short menu of categories, everything closed", async () => {
    const { controller, store } = makeController({
        listCreatableAgents: async () => CATALOG,
    });
    await controller.openSessionAgentPicker();

    const modal = store.getState().ui.modal;
    assert.equal(modal.type, "sessionAgentPicker");
    assert.deepEqual(
        modal.items.map((item) => (item.kind === "section" ? `#${item.title}` : "generic")),
        // Generic leads OUTSIDE every section: it is not an agent, it is the
        // absence of one, and it must never be behind a twisty.
        ["generic", "#Built-in", "#Installed · Shared", "#Installed · Yours"],
    );
});

test("an empty category is omitted rather than shown reading zero", async () => {
    const { controller, store } = makeController({
        // Shared packages only — no user-scoped ones at all.
        listCreatableAgents: async () => CATALOG.filter((agent) => agent.scope !== "user"),
    });
    await controller.openSessionAgentPicker();

    const titles = store.getState().ui.modal.items.map((item) => item.title);
    assert.ok(titles.includes("Installed · Shared"));
    assert.ok(!titles.includes("Installed · Yours"), "a heading whose only content is its own emptiness is noise");
});

test("a package with no plugin.json title falls back to its DNS-label name", async () => {
    const { controller, store } = makeController({
        listCreatableAgents: async () => CATALOG,
    });
    await controller.openSessionAgentPicker();
    openCategories(controller);

    assert.equal(packageSection(store, "hn-scraper").title, "hn-scraper");
    assert.equal(packageSection(store, "incident-kit").title, "Incident Kit");
});

test("opening a package reveals its agents and closing hides them again", async () => {
    const { controller, store } = makeController({
        listCreatableAgents: async () => CATALOG,
    });
    await controller.openSessionAgentPicker();

    openCategories(controller);
    const key = packageSection(store, "incident-kit").sectionKey;
    controller.toggleAgentPickerSection(key);
    assert.ok(
        store.getState().ui.modal.items.some((item) => item.agentName === "shared-triager"),
        "opening the package shows its agents",
    );

    controller.toggleAgentPickerSection(key);
    assert.ok(
        !store.getState().ui.modal.items.some((item) => item.agentName === "shared-triager"),
        "closing it hides them again",
    );
});

test("closing a section moves the highlight to its header, not to another agent", async () => {
    // Selection is carried by item id: collapsing a section above the cursor
    // shifts every index below it, so re-using the number would silently point
    // the highlight at a different agent.
    const { controller, store } = makeController({
        listCreatableAgents: async () => CATALOG,
    });
    await controller.openSessionAgentPicker();

    openCategories(controller);
    const key = packageSection(store, "incident-kit").sectionKey;
    controller.toggleAgentPickerSection(key);
    const modal = store.getState().ui.modal;
    const triagerIndex = modal.items.findIndex((item) => item.agentName === "shared-triager");
    store.dispatch({ type: "ui/modal", modal: { ...modal, selectedIndex: triagerIndex } });

    controller.toggleAgentPickerSection(key);
    const after = store.getState().ui.modal;
    assert.equal(after.items[after.selectedIndex].sectionKey, key);
});

test("a called-only agent renders but refuses to start", async () => {
    const { controller, store } = makeController({
        listCreatableAgents: async () => [
            { name: "lead", title: "Lead", source: "package", scope: "shared", packageName: "desk", packageSemver: "1.0.0" },
            {
                name: "helper", title: "Helper", source: "package", scope: "shared",
                packageName: "desk", packageSemver: "1.0.0", startedBy: ["lead"],
            },
        ],
    });
    await controller.openSessionAgentPicker();
    openCategories(controller);
    const key = packageSection(store, "desk").sectionKey;
    controller.toggleAgentPickerSection(key);

    const modal = store.getState().ui.modal;
    const helper = modal.items.find((item) => item.agentName === "helper");
    assert.equal(helper.supportsDirectStart, false, "startedBy implies not directly startable");
    assert.ok(helper.depth > modal.items.find((item) => item.agentName === "lead").depth, "the sub-agent nests under its creator");

    // Confirming leaves the dialog UP — refusing here beats letting the create
    // fail after the dialog has already closed.
    store.dispatch({ type: "ui/modal", modal: { ...modal, selectedIndex: modal.items.indexOf(helper) } });
    await controller.confirmModal();
    assert.equal(store.getState().ui.modal?.type, "sessionAgentPicker");
    assert.match(store.getState().ui.statusText || "", /cannot be started on its own/);
});

test("an explicit supportsDirectStart publishes a sub-agent that is also startable", async () => {
    const { controller, store } = makeController({
        listCreatableAgents: async () => [
            { name: "lead", title: "Lead", source: "package", scope: "shared", packageName: "desk", packageSemver: "1.0.0" },
            {
                name: "helper", title: "Helper", source: "package", scope: "shared",
                packageName: "desk", packageSemver: "1.0.0", startedBy: ["lead"], supportsDirectStart: true,
            },
        ],
    });
    await controller.openSessionAgentPicker();
    openCategories(controller);
    const key = packageSection(store, "desk").sectionKey;
    controller.toggleAgentPickerSection(key);

    const helper = store.getState().ui.modal.items.find((item) => item.agentName === "helper");
    assert.equal(helper.supportsDirectStart, true);
});

// ── Adversarial-review regressions ──────────────────────────────────────

test("an agent whose startedBy names a DIFFERENT package's agent stays startable", async () => {
    // The default for supportsDirectStart cannot come from the mere presence
    // of startedBy: nesting resolves within one package, so a cross-package
    // (or misspelled) creator left the agent unstartable inside a section that
    // still counted it as an entry point — a package with zero usable agents.
    const { controller, store } = makeController({
        listCreatableAgents: async () => [
            { name: "lead", title: "Lead", source: "package", scope: "shared", packageName: "p1", packageSemver: "1.0.0" },
            {
                name: "worker", title: "Worker", source: "package", scope: "shared",
                packageName: "p2", packageSemver: "1.0.0", startedBy: ["lead"],
            },
        ],
    });
    await controller.openSessionAgentPicker();
    openCategories(controller);
    const key = packageSection(store, "p2").sectionKey;
    controller.toggleAgentPickerSection(key);

    const worker = store.getState().ui.modal.items.find((item) => item.agentName === "worker");
    assert.equal(worker.supportsDirectStart, true, "nothing in p2 starts it, so it is p2's entry point");
    assert.equal(worker.depth, 2, "and it renders at entry-point depth");
});

test("nesting matches names the way the resolver does", async () => {
    // The runtime matches case- and punctuation-insensitively, so nesting must
    // too — otherwise "Editor_In_Chief" fails to resolve and the sub-agent
    // becomes an unstartable orphan.
    const { controller, store } = makeController({
        listCreatableAgents: async () => [
            { name: "editor-in-chief", title: "Editor in Chief", source: "package", scope: "shared", packageName: "desk", packageSemver: "1.0.0" },
            {
                name: "line-editor", title: "Line Editor", source: "package", scope: "shared",
                packageName: "desk", packageSemver: "1.0.0", startedBy: ["Editor_In_Chief"],
            },
        ],
    });
    await controller.openSessionAgentPicker();
    openCategories(controller);
    const key = packageSection(store, "desk").sectionKey;
    controller.toggleAgentPickerSection(key);

    const items = store.getState().ui.modal.items;
    const child = items.find((item) => item.agentName === "line-editor");
    assert.equal(child.parentAgentName, "editor-in-chief");
    assert.equal(child.supportsDirectStart, false);
});

test("the opening cursor never lands somewhere Enter would collapse the list", async () => {
    // With generic disabled and no baked agents, every visible row is a
    // header. Landing on "Installed" meant the first keystroke closed
    // everything instead of creating anything.
    const { controller, store } = makeController({
        getSessionCreationPolicy: () => ({ creation: { allowGeneric: false } }),
        listCreatableAgents: async () => [
            { name: "solo", title: "Solo", source: "package", scope: "shared", packageName: "p1", packageSemver: "1.0.0" },
        ],
    });
    await controller.openSessionAgentPicker();

    const modal = store.getState().ui.modal;
    const landed = modal.items[modal.selectedIndex];
    assert.equal(landed.kind, "section", "with no generic and no built-ins, every visible row is a header");
    assert.equal(landed.collapsed, true, "and it is a CLOSED one, whose Enter opens rather than collapses");

    await controller.confirmModal();
    assert.ok(
        store.getState().ui.modal.items.length > modal.items.length,
        "the first Enter reveals rows rather than collapsing the list",
    );
});

test("a cycle promotes its own members, not whichever sub-agent was listed first", async () => {
    // c hangs off a; a and b are the cycle. Promoting in array order surfaced
    // c as an entry point purely because it came first in the listing.
    const { controller, store } = makeController({
        listCreatableAgents: async () => [
            { name: "c", title: "C", source: "package", scope: "shared", packageName: "p", packageSemver: "1.0.0", startedBy: ["a"] },
            { name: "a", title: "A", source: "package", scope: "shared", packageName: "p", packageSemver: "1.0.0", startedBy: ["b"] },
            { name: "b", title: "B", source: "package", scope: "shared", packageName: "p", packageSemver: "1.0.0", startedBy: ["a"] },
        ],
    });
    await controller.openSessionAgentPicker();
    openCategories(controller);
    const key = packageSection(store, "p").sectionKey;
    controller.toggleAgentPickerSection(key);

    const items = store.getState().ui.modal.items.filter((item) => item.agentName);
    assert.equal(items.length, 3, "a malformed package still shows every agent exactly once");
    const depth = Object.fromEntries(items.map((item) => [item.agentName, item.depth]));
    assert.ok(depth.c > depth.a, "c nests under a rather than posing as an entry point");
});

test("the picker renders section headers and the detail pane describes them", async () => {
    const { controller, store } = makeController({
        listCreatableAgents: async () => CATALOG,
    });
    await controller.openSessionAgentPicker();

    openCategories(controller);
    const view = selectSessionAgentPickerModal(store.getState());
    assert.ok(Array.isArray(view.rowItemIndexes), "picker emits rowItemIndexes");
    assert.equal(view.rowItemIndexes.length, view.rows.length, "rows and items stay 1:1");
    // The SELECTED row is a single highlight run rather than a run array.
    const rowText = (row) => (Array.isArray(row) ? row.map((run) => run.text).join("") : String(row?.text || ""));
    const text = view.rows.map(rowText).join("\n");
    assert.match(text, /▾ Built-in {2}· {2}1 agent\b/, "the count runs inline, not padded to a guessed column");
    assert.match(text, /▾ Installed · Shared {2}· {2}1 package\b/);
    assert.match(text, /▸ Incident Kit {2}·/, "a closed package shows a closed twisty");
    assert.doesNotMatch(text, /\[shared\]/, "the shelf says it; the row does not repeat it");
    assert.doesNotMatch(text, /called only/, "dimming and the detail pane carry that, the row does not repeat it");

    const modal = store.getState().ui.modal;
    const sectionIndex = modal.items.findIndex((item) => item.packageName === "incident-kit");
    store.dispatch({ type: "ui/modal", modal: { ...modal, selectedIndex: sectionIndex } });
    const detail = selectSessionAgentPickerModal(store.getState());
    const detailText = detail.detailsLines.map((line) => line.map((run) => run.text).join("")).join("\n");
    assert.match(detailText, /incident-kit@1\.4\.0/);
});

test("the detail pane still names the package for an agent", async () => {
    const { controller, store } = makeController({
        listCreatableAgents: async () => CATALOG,
    });
    await controller.openSessionAgentPicker();
    openCategories(controller);
    const key = packageSection(store, "incident-kit").sectionKey;
    controller.toggleAgentPickerSection(key);

    const modal = store.getState().ui.modal;
    store.dispatch({
        type: "ui/modal",
        modal: { ...modal, selectedIndex: modal.items.findIndex((item) => item.agentName === "shared-triager") },
    });
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
    assert.deepEqual(tree.filter((r) => r.kind === "section").map((r) => r.label), ["Model Providers", "Agents"]);
    assert.deepEqual(tree.filter((r) => r.kind === "subsection").map((r) => r.label), ["My Providers"]);
    const shared = tree.find((r) => r.id === "group:shared");
    const user = tree.find((r) => r.id === "group:user");
    const others = tree.find((r) => r.id === "group:others");
    assert.equal(shared.count, 1);
    // "User" is the VIEWER's own private packages. Someone else's private
    // package (bob's) is not part of alice's workspace — it is listed under
    // "Other users" instead of cluttering her own section.
    assert.equal(user.count, 0, "alice owns no user-scope packages");
    assert.equal(others.count, 1, "bob's private package is grouped separately");
    const pkgRow = tree.find((r) => r.kind === "package" && r.name === "incident-kit");
    assert.equal(pkgRow.scope, "shared");
    assert.equal(pkgRow.semver, "1.4.0");
    assert.equal(pkgRow.canManage, true, "owner manages their package");
    const foreign = tree.find((r) => r.kind === "package" && r.name === "other-kit");
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

test("the owner filter hides other people's private agents, never yours or shared", () => {
    const store = createStore(appReducer, createInitialState());
    loadedPackagesState(store);
    store.dispatch({ type: "auth/principal", principal: { provider: "test", subject: "alice", displayName: "Alice Anderson" } });

    const idsFor = () => selectAdminConsole(store.getState()).settingsTree.map((row) => row.id);
    // The reducer reads `filter`, not `ownerFilter`.
    const setFilter = (filter) => store.dispatch({ type: "sessions/ownerFilter", filter });

    // Narrowed to Alice: Bob's private package is not part of her workspace.
    // The deployment's SHARED package still is - it belongs to no one person.
    setFilter({ all: false, includeMe: true, includeShared: true, ownerKeys: [] });
    const namesFor = () => selectAdminConsole(store.getState()).settingsTree
        .filter((r) => r.kind === "package").map((r) => r.name);
    assert.ok(!namesFor().includes("other-kit"), "bob's private package is filtered out");
    assert.ok(namesFor().includes("incident-kit"), "a shared package is the deployment's, never filtered");
    assert.equal(idsFor().includes("group:others"), false, "the Other users group goes with it");

    // Asking for Bob brings his back - that is what the filter means.
    setFilter({ all: false, includeMe: true, includeShared: true, ownerKeys: [ownerKey("bob")] });
    assert.ok(namesFor().includes("other-kit"), "asking for bob shows bob's package");

    // `all` is the unfiltered view.
    setFilter({ all: true });
    assert.ok(namesFor().includes("other-kit"));
});

test("user-scope packages carry the owner's initials; shared ones keep the scope badge", () => {
    const store = createStore(appReducer, createInitialState());
    store.dispatch({
        type: "admin/packages/loaded",
        list: [
            {
                packageId: "p1", name: "incident-kit", scope: "shared", enabled: true,
                owner: { provider: "test", subject: "alice", displayName: "Alice Anderson" },
                active: { semver: "1.4.0", sha256: "a".repeat(64), manifest: { agents: [] } },
            },
            {
                // The shape the API actually returns: `owner` is the authz
                // principal — provider + an opaque directory subject, no name
                // and no address. `createdBy` is the only human identity on
                // the row, which is why it leads.
                packageId: "p2", name: "other-kit", scope: "user", enabled: true,
                owner: { provider: "entra", subject: "aee30e06-3c52-4faf-8c96-e681a7cbb32d" },
                createdBy: "bob@test", active: null,
            },
            {
                packageId: "p3", name: "third-kit", scope: "user", enabled: true,
                owner: { provider: "entra", subject: "e8677004-a702-46f8-a39e-ca3e64efe63d" },
                createdBy: "carol@test", active: null,
            },
        ],
    });
    store.dispatch({ type: "sessions/ownerFilter", filter: { all: true } });

    const tree = selectAdminConsole(store.getState()).settingsTree;
    const byName = (name) => tree.find((row) => row.kind === "package" && row.name === name);
    const shared = byName("incident-kit");
    const bobs = byName("other-kit");
    const carols = byName("third-kit");

    // Initials come from the createdBy email when no richer identity exists,
    // and are UPPERCASE — they render as a monogram avatar.
    assert.equal(bobs.ownerBadge.initials, "BO");
    assert.equal(bobs.ownerBadge.name, "bob@test");
    assert.notEqual(bobs.ownerBadge.initials, "?");

    // Colour is the part that actually distinguishes owners: two people must
    // not land on the same hue for the badge to mean anything.
    assert.equal(typeof bobs.ownerBadge.hue, "number");
    assert.notEqual(bobs.ownerBadge.hue, carols.ownerBadge.hue);

    // A shared package belongs to the deployment, not a person.
    assert.equal(shared.ownerBadge, null);
});

test("Update opens the add dialog bound to one package", () => {
    const { controller, store } = makeController();
    controller.openAdminUpdatePackage("incident-kit", "shared");

    const dialog = store.getState().admin.packages.addDialog;
    assert.equal(dialog.open, true);
    assert.equal(dialog.updateName, "incident-kit");
    assert.equal(dialog.scope, "shared", "an update never silently re-scopes the package");

    // Adding is still the unbound form.
    controller.openAdminAddPackage();
    assert.equal(store.getState().admin.packages.addDialog.updateName, null);
});

/**
 * The Admin Console REPLACES the workspace, so selecting the new session is
 * not enough: creating from the console left it selected behind a pane that
 * cannot show it, and the create looked like it had done nothing.
 */
for (const [label, run] of [
    ["createSession", (c) => c.createSession({})],
    ["createSessionForAgent", (c) => c.createSessionForAgent("greeter", {})],
]) {
    test(`${label} returns to the workspace when the Admin Console is open`, async () => {
        const { controller, store } = makeController({
            createSession: async () => ({ sessionId: "new-1" }),
            createSessionForAgent: async () => ({ sessionId: "new-1" }),
            getSession: async () => ({ sessionId: "new-1", title: "New", status: "idle" }),
            getSessionEvents: async () => [],
        });

        store.dispatch({ type: "admin/visibility", visible: true });
        assert.equal(store.getState().admin.visible, true, "console is open before the create");

        await run(controller);

        assert.equal(store.getState().admin.visible, false, "the console must step aside for the new session");
        assert.equal(store.getState().sessions.activeSessionId, "new-1", "and the new session is the active one");
    });
}

// ─── Editors: canEdit vs canManage ──────────────────────────────

test("package rows and detail split editor-level canEdit from owner-level canManage", () => {
    const store = createStore(appReducer, createInitialState());
    loadedPackagesState(store);
    // Two more shared packages owned by someone else: one where the server
    // says alice is a granted editor, one where it does not.
    const list = store.getState().admin.packages.list;
    store.dispatch({
        type: "admin/packages/loaded",
        list: [
            ...list,
            {
                packageId: "p3", sourceId: null, name: "team-kit", scope: "shared",
                owner: { provider: "test", subject: "bob" }, enabled: true, canEdit: true,
                createdBy: "bob@test", createdAt: "2026-07-01T00:00:00Z",
                active: { versionId: "v9", semver: "2.0.0", sha256: "0123456789abcdef", sizeBytes: 1, artifactFilename: "f9", commitSha: null, manifest: { agents: [] }, createdAt: "2026-07-01T00:00:00Z", createdBy: "bob@test" },
            },
            {
                packageId: "p4", sourceId: null, name: "locked-kit", scope: "shared",
                owner: { provider: "test", subject: "bob" }, enabled: true, canEdit: false,
                createdBy: "bob@test", createdAt: "2026-07-01T00:00:00Z",
                active: null,
            },
        ],
        workerState: store.getState().admin.packages.workerState,
    });

    let tree = selectAdminConsole(store.getState()).settingsTree;
    assert.equal(tree.find((r) => r.kind === "package" && r.name === "team-kit").canManage, true, "a granted editor manages the row");
    assert.equal(tree.find((r) => r.kind === "package" && r.name === "locked-kit").canManage, false, "a stranger does not");
    assert.equal(tree.find((r) => r.kind === "package" && r.name === "incident-kit").canManage, true, "the owner still does");

    store.dispatch({ type: "admin/packages/select", name: "team-kit", selector: { scope: "shared" } });
    store.dispatch({
        type: "admin/packages/detail/loaded",
        name: "team-kit",
        detail: {
            packageId: "p3", sourceId: null, name: "team-kit", scope: "shared",
            owner: { provider: "test", subject: "bob" }, enabled: true, canEdit: true,
            createdBy: "bob@test", createdAt: "2026-07-01T00:00:00Z", activeVersionId: "v9",
            versions: [],
            editors: [
                { provider: "test", subject: "alice", email: "alice@test", displayName: "Alice", grantedAt: "2026-07-02T00:00:00Z", grantedByDisplay: "Bob" },
                { provider: "test", subject: "carol", email: "carol@test", displayName: null, grantedAt: "2026-07-03T00:00:00Z", grantedByDisplay: null },
                { provider: "test", subject: "raw-id", email: null, displayName: null, grantedAt: "2026-07-04T00:00:00Z", grantedByDisplay: null },
            ],
        },
    });
    const detail = selectAdminConsole(store.getState()).packages.detail;
    assert.equal(detail.canEdit, true, "editor may publish/pin/enable");
    assert.equal(detail.canManage, false, "editor may NOT scope/delete/grant");
    assert.deepEqual(detail.editors.map((e) => e.label), ["Alice", "carol@test", "raw-id"], "label = displayName || email || subject");
    assert.equal(detail.editors[0].grantedByDisplay, "Bob");
});
