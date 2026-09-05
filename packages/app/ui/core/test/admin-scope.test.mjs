import test from "node:test";
import assert from "node:assert/strict";
import { appReducer, createInitialState, selectAdminConsole, createStore, PilotSwarmUiController } from "../src/index.js";

test("cluster admin keeps configuration UI but only owner/editor package mutations", () => {
    for (const adminScope of ["cluster", "unrestricted"]) {
        let state = createInitialState({ mode: "web" });
        state = { ...state, auth: { principal: { provider: "dev", subject: "admin" }, adminScope },
            admin: { ...state.admin, visible: true, section: "packages", profile: { provider: "dev", subject: "admin", isAdmin: true, adminScope },
                packages: { ...state.admin.packages, list: [
                    { name: "shared", scope: "shared", owner: { provider: "dev", subject: "alice" }, canEdit: false },
                    { name: "own", scope: "user", owner: { provider: "dev", subject: "admin" }, canEdit: true },
                    { name: "editable", scope: "shared", owner: { provider: "dev", subject: "alice" }, canEdit: true },
                ] } } };
        const view = selectAdminConsole(state);
        assert.equal(view.isAdmin, true);
        assert.equal(view.adminScope, adminScope);
        assert.ok(view.adminPolicyLabel.includes(adminScope === "cluster" ? "system-session access retained" : "Unrestricted"));
        const rows = view.settingsTree;
        assert.equal(rows.find((r) => r.name === "shared").canManage, adminScope === "unrestricted");
        assert.equal(rows.find((r) => r.name === "own").canManage, true);
        assert.equal(rows.find((r) => r.name === "editable").canManage, true, "row affordance includes explicit editor rights");
    }
});

test("revocation clears session content and blocks late responses until a fresh authorized listing", () => {
    let state = appReducer(createInitialState(), { type: "sessions/loaded", sessions: [{ sessionId: "private", title: "Private", status: "idle" }, { sessionId: "system", isSystem: true }] });
    state = { ...state, sessions: { ...state.sessions, activeSessionId: "private" },
        history: { bySessionId: new Map([["private", { chat: [{ text: "CANARY" }] }]]) },
        files: { ...state.files, bySessionId: { private: { preview: "CANARY" } } },
        canvas: { ...state.canvas, bySessionId: { private: { data: "CANARY" } } } };
    const store = createStore(appReducer, state);
    const controller = new PilotSwarmUiController({ store, transport: {} });
    controller.mergeSessionEvent("private", { eventType: "session.access_revoked" });
    const revoked = store.getState();
    assert.equal(revoked.sessions.activeSessionId, null);
    assert.equal(revoked.history.bySessionId.has("private"), false);
    assert.equal(revoked.files.bySessionId.private, undefined);
    assert.equal(revoked.canvas.bySessionId.private, undefined);
    assert.ok(revoked.sessions.byId.system, "authorized system view survives");
    assert.equal(appReducer(revoked, { type: "history/set", sessionId: "private", history: { chat: [{ text: "late CANARY" }] } }), revoked);
    assert.equal(appReducer(revoked, { type: "sessions/merged", session: { sessionId: "private", title: "late CANARY" } }), revoked);
    const restored = appReducer(revoked, { type: "sessions/loaded", sessions: [{ sessionId: "private", title: "Authorized again" }] });
    assert.equal(restored.sessions.goneIds.includes("private"), false);
});

test("a same-named accessible package cannot preserve a revoked private copy or late file response", () => {
    let state = appReducer(createInitialState(), { type: "admin/packages/select", name: "kit", selector: { scope: "user", owner: { provider: "dev", subject: "alice" } } });
    const seq = state.admin.packages.selectionSeq;
    state = appReducer(state, { type: "admin/packages/detail/loaded", name: "kit", seq, detail: { name: "kit", description: "CANARY" } });
    state = appReducer(state, { type: "admin/packages/changelog/loaded", name: "kit", seq, content: "CANARY" });
    const revoked = appReducer(state, { type: "admin/packages/loaded", list: [{ name: "kit", scope: "shared", owner: { provider: "dev", subject: "alice" } }] });
    assert.equal(revoked.admin.packages.selectedName, null);
    assert.equal(revoked.admin.packages.detail, null);
    assert.equal(revoked.admin.packages.changelog, null);
    assert.equal(appReducer(revoked, { type: "admin/packages/detail/loaded", name: "kit", seq, detail: { description: "late CANARY" } }), revoked);
});

test("revocation also evicts cached content whose session row is already absent", () => {
    let state = createInitialState();
    state = { ...state, history: { ...state.history, bySessionId: new Map([["gone", { chat: [{ text: "CANARY" }] }]]) } };
    const revoked = appReducer(state, { type: "sessions/gone", sessionId: "gone" });
    assert.equal(revoked.history.bySessionId.has("gone"), false);
    assert.ok(revoked.sessions.goneIds.includes("gone"));
});
