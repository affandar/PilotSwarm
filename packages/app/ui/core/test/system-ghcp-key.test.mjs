// System GitHub Copilot key — Admin Console "Store as System key" toggle.
//
// Admins can store a Copilot key on the first-class SYSTEM user; ownerless
// system sessions resolve it like a per-user key. The console reuses the
// existing key editor with a target switch, so these tests pin: the toggle
// routes Save/Clear to the system transport methods, the selector goes
// target-aware (labels + status), non-admins never see or use the toggle,
// and the target survives the begin/cancel edit rebuilds.
import test from "node:test";
import assert from "node:assert/strict";
import {
    PilotSwarmUiController,
    appReducer,
    createInitialState,
    createStore,
    selectAdminConsole,
} from "../src/index.js";

function makeController({ isAdmin = true, transportOverrides = {} } = {}) {
    const calls = { setUser: [], setSystem: [], statusReads: 0 };
    let systemConfigured = false;
    const transport = {
        listSessions: async () => [],
        subscribeSession: () => () => {},
        getCurrentUserProfile: async () => ({
            provider: "entra",
            subject: "admin-1",
            email: "admin@example.com",
            displayName: "Admin",
            githubCopilotKeySet: false,
            isAdmin,
        }),
        setCurrentUserGitHubCopilotKey: async ({ key }) => {
            calls.setUser.push(key);
            return { githubCopilotKeySet: key != null, isAdmin };
        },
        setSystemGitHubCopilotKey: async ({ key }) => {
            calls.setSystem.push(key);
            systemConfigured = key != null;
            return { configured: systemConfigured, changedBy: "admin@example.com", changedAt: "2026-07-08T00:00:00Z" };
        },
        getSystemGitHubCopilotKeyStatus: async () => {
            calls.statusReads += 1;
            return { configured: systemConfigured, changedBy: systemConfigured ? "admin@example.com" : null, changedAt: null };
        },
        ...transportOverrides,
    };
    const store = createStore(appReducer, createInitialState({ mode: "remote" }));
    const controller = new PilotSwarmUiController({ store, transport });
    return { controller, store, calls };
}

test("admin profile load also loads System key status and marks it supported", async () => {
    const { controller, store, calls } = makeController();
    await controller.refreshAdminProfile();
    const view = selectAdminConsole(store.getState());
    assert.equal(view.isAdmin, true);
    assert.equal(view.systemGhcpKey.supported, true);
    assert.equal(calls.statusReads, 1);
});

test("non-admin profile load never touches the System key surface", async () => {
    const { controller, store, calls } = makeController({ isAdmin: false });
    await controller.refreshAdminProfile();
    const view = selectAdminConsole(store.getState());
    assert.equal(view.isAdmin, false);
    assert.equal(view.systemGhcpKey.supported, false);
    assert.equal(calls.statusReads, 0);
    // The toggle is also inert for non-admins.
    controller.setAdminGhcpKeyStoreAsSystem(true);
    assert.equal(selectAdminConsole(store.getState()).ghcpKey.storeAsSystem, false);
});

test("with the toggle on, Save and Clear route to the System key and update its status", async () => {
    const { controller, store, calls } = makeController();
    await controller.refreshAdminProfile();
    controller.setAdminGhcpKeyStoreAsSystem(true);

    controller.beginAdminEditGhcpKey();
    controller.setAdminGhcpKeyDraft("ghu_system_123");
    await controller.saveAdminGhcpKey();

    assert.deepEqual(calls.setSystem, ["ghu_system_123"]);
    assert.deepEqual(calls.setUser, []);
    let view = selectAdminConsole(store.getState());
    assert.equal(view.systemGhcpKey.configured, true);
    assert.equal(view.ghcpKey.targetConfigured, true);
    assert.equal(view.ghcpKey.editing, false);
    assert.match(view.ghcpKey.statusText, /System key configured/);
    assert.match(view.ghcpKey.statusText, /admin@example\.com/);

    await controller.clearAdminGhcpKey();
    assert.deepEqual(calls.setSystem, ["ghu_system_123", null]);
    view = selectAdminConsole(store.getState());
    assert.equal(view.systemGhcpKey.configured, false);
    assert.match(view.ghcpKey.statusText, /System key not configured/);
});

test("with the toggle off, Save still targets the caller's own key", async () => {
    const { controller, calls } = makeController();
    await controller.refreshAdminProfile();
    controller.beginAdminEditGhcpKey();
    controller.setAdminGhcpKeyDraft("ghu_mine");
    await controller.saveAdminGhcpKey();
    assert.deepEqual(calls.setUser, ["ghu_mine"]);
    assert.deepEqual(calls.setSystem, []);
});

test("the target switch survives begin/cancel edit and flips the action labels", async () => {
    const { controller, store } = makeController();
    await controller.refreshAdminProfile();
    controller.setAdminGhcpKeyStoreAsSystem(true);

    controller.beginAdminEditGhcpKey();
    assert.equal(selectAdminConsole(store.getState()).ghcpKey.storeAsSystem, true, "beginEdit keeps the target");
    controller.cancelAdminEditGhcpKey();
    const view = selectAdminConsole(store.getState());
    assert.equal(view.ghcpKey.storeAsSystem, true, "cancelEdit keeps the target");
    const edit = view.actions.find((a) => a.id === "edit");
    assert.equal(edit.label, "Set System key", "action label names the System key target");
});

test("legacy transports without the System methods degrade to a clear error", async () => {
    const { controller, store } = makeController({
        transportOverrides: { setSystemGitHubCopilotKey: undefined },
    });
    await controller.refreshAdminProfile();
    controller.setAdminGhcpKeyStoreAsSystem(true);
    controller.beginAdminEditGhcpKey();
    controller.setAdminGhcpKeyDraft("ghu_x");
    await controller.saveAdminGhcpKey();
    const view = selectAdminConsole(store.getState());
    assert.match(view.ghcpKey.error, /does not support System keys/);
});
