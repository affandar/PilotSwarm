import test from "node:test";
import assert from "node:assert/strict";
import {
    PilotSwarmUiController,
    appReducer,
    createInitialState,
    createStore,
    defaultOwnerFilterForPrincipal,
    selectNavigationError,
    selectNavigationIntent,
    selectSessionFilterExceptionNotice,
    selectSessionRows,
} from "../src/index.js";

const ME = { provider: "github", subject: "me", displayName: "Me", email: "me@example.com" };
const BOB = { provider: "github", subject: "bob", displayName: "Bob", email: "bob@example.com" };

function authedState(ownerFilter = defaultOwnerFilterForPrincipal(ME)) {
    let state = createInitialState();
    state = appReducer(state, { type: "auth/context", principal: ME, authorization: { role: "user" } });
    state = appReducer(state, { type: "sessions/ownerFilter", filter: ownerFilter });
    return state;
}

test("pending intent survives sessions/loaded without the target and blocks fallback selection", () => {
    let state = authedState();
    state = appReducer(state, { type: "sessions/navigationIntent", sessionId: "target" });
    assert.deepEqual(selectNavigationIntent(state), { sessionId: "target", status: "pending" });

    state = appReducer(state, {
        type: "sessions/loaded",
        sessions: [{ sessionId: "mine", title: "Mine", status: "idle", owner: ME }],
    });

    assert.deepEqual(selectNavigationIntent(state), { sessionId: "target", status: "pending" });
    assert.equal(state.sessions.activeSessionId, null);
});

test("resolving a delayed deep-link target restores its visible row highlight", () => {
    let state = authedState();
    state = appReducer(state, { type: "sessions/navigationIntent", sessionId: "target" });
    state = appReducer(state, { type: "sessions/listDeselect" });
    state = appReducer(state, {
        type: "sessions/loaded",
        sessions: [
            { sessionId: "mine", title: "Mine", status: "idle", owner: ME },
            { sessionId: "target", title: "Target", status: "idle", owner: ME },
        ],
    });

    assert.deepEqual(selectNavigationIntent(state), { sessionId: "target", status: "resolved" });
    assert.equal(state.sessions.activeSessionId, "target");
    assert.equal(state.sessions.listDeselected, false);
    assert.equal(selectSessionRows(state).find((row) => row.sessionId === "target")?.active, true);
});

test("pending intent survives profileSettings/apply first-apply and then resolves onto the target", () => {
    let state = authedState();
    state = appReducer(state, { type: "sessions/navigationIntent", sessionId: "target" });
    state = appReducer(state, {
        type: "profileSettings/apply",
        settings: { activeSessionId: "mine", themeId: "dark" },
    });

    assert.equal(state.sessions.activeSessionId, null);
    assert.deepEqual(selectNavigationIntent(state), { sessionId: "target", status: "pending" });
    assert.equal(state.ui.themeId, "dark");

    state = appReducer(state, {
        type: "sessions/loaded",
        sessions: [
            { sessionId: "mine", title: "Mine", status: "idle", owner: ME },
            { sessionId: "target", title: "Target", status: "idle", owner: ME },
        ],
    });

    assert.equal(state.sessions.activeSessionId, "target");
    assert.deepEqual(selectNavigationIntent(state), { sessionId: "target", status: "resolved" });

    state = appReducer(state, {
        type: "profileSettings/apply",
        settings: { activeSessionId: "mine" },
    });
    assert.equal(state.sessions.activeSessionId, "target");
    assert.deepEqual(selectNavigationIntent(state), { sessionId: "target", status: "resolved" });
});

test("expand-before-resolve keeps a link target inside a collapsed group selected under the default owner filter", () => {
    let state = authedState();
    state = appReducer(state, { type: "sessions/navigationIntent", sessionId: "member-x" });
    state = appReducer(state, {
        type: "sessions/loaded",
        sessions: [
            { sessionId: "group:g1", groupId: "g1", isGroup: true, title: "G1", status: "group", memberCount: 1 },
            { sessionId: "member-x", groupId: "g1", title: "Shared Work", status: "idle", owner: BOB },
            { sessionId: "mine", title: "Mine", status: "idle", owner: ME },
        ],
    });

    assert.equal(state.sessions.activeSessionId, "member-x");
    assert.deepEqual(selectNavigationIntent(state), { sessionId: "member-x", status: "resolved" });
    assert.equal(state.sessions.collapsedIds.has("group:g1"), false);
    assert.equal(state.sessions.flat.some((entry) => entry.sessionId === "member-x" && entry.depth === 1), true);
    // Foreign-owned target matches via includeShared — no exception needed.
    assert.equal(state.sessions.filterExceptionId, null);
    assert.equal(selectSessionRows(state).some((row) => row.sessionId === "member-x"), true);
});

// The exception path is now the FALLBACK: a target with a human owner gets
// that owner admitted to the filter instead (tests at the bottom). An unowned
// target under includeUnowned:false is what still takes the exception.
test("filter exception is set for a filtered-out link target and cleared on filter change", () => {
    let state = authedState({
        all: false,
        includeSystem: true,
        includeUnowned: false,
        includeMe: true,
        includeShared: false,
        ownerKeys: [],
    });
    state = appReducer(state, { type: "sessions/navigationIntent", sessionId: "foreign" });
    state = appReducer(state, {
        type: "sessions/loaded",
        sessions: [
            { sessionId: "mine", title: "Mine", status: "idle", owner: ME },
            { sessionId: "foreign", title: "Foreign", status: "idle", owner: null },
        ],
    });

    assert.equal(state.sessions.activeSessionId, "foreign");
    assert.equal(state.sessions.filterExceptionId, "foreign");
    assert.equal(selectSessionRows(state).some((row) => row.sessionId === "foreign"), true);
    assert.equal(
        selectSessionFilterExceptionNotice(state),
        "Showing linked session outside your current filters.",
    );

    state = appReducer(state, { type: "sessions/filterQuery", query: "mine" });
    assert.equal(state.sessions.filterExceptionId, null);
    assert.equal(selectNavigationIntent(state), null);
    assert.equal(selectSessionFilterExceptionNotice(state), null);
});

test("manual navigation releases the latch and the filter exception", () => {
    let state = authedState({
        all: false,
        includeSystem: true,
        includeUnowned: false,
        includeMe: true,
        includeShared: false,
        ownerKeys: [],
    });
    state = appReducer(state, { type: "sessions/navigationIntent", sessionId: "foreign" });
    state = appReducer(state, {
        type: "sessions/loaded",
        sessions: [
            { sessionId: "mine", title: "Mine", status: "idle", owner: ME },
            { sessionId: "foreign", title: "Foreign", status: "idle", owner: null },
        ],
    });
    assert.equal(state.sessions.filterExceptionId, "foreign");

    state = appReducer(state, { type: "sessions/selected", sessionId: "mine" });
    assert.equal(state.sessions.activeSessionId, "mine");
    assert.equal(selectNavigationIntent(state), null);
    assert.equal(state.sessions.filterExceptionId, null);
});

function makeDeepLinkController({ getSessionError }) {
    const sessions = [
        { sessionId: "s1", title: "S1", status: "idle", owner: ME },
        { sessionId: "s2", title: "S2", status: "idle", owner: BOB },
    ];
    const transport = {
        start: async () => {},
        stop: async () => {},
        getAuthContext: () => ({ principal: ME, authorization: { role: "user" } }),
        listSessions: async () => sessions.map((session) => ({ ...session })),
        listSessionGroups: async () => [],
        getSession: async (sessionId) => {
            if (sessionId === "missing") throw getSessionError;
            return sessions.find((session) => session.sessionId === sessionId) || null;
        },
        getSessionEvents: async () => [],
        subscribeSession: () => () => {},
    };
    const store = createStore(appReducer, createInitialState());
    const controller = new PilotSwarmUiController({ store, transport });
    return { controller, store };
}

test("deep-link target rejected by the server fails the intent as not_found with no fallback selection", async () => {
    const apiError = Object.assign(new Error("Session not found."), { code: "NOT_FOUND", status: 404 });
    const { controller, store } = makeDeepLinkController({ getSessionError: apiError });

    await controller.start({ initialSessionId: "missing" });
    await controller.stop();

    const state = store.getState();
    assert.deepEqual(state.sessions.navigationIntent, {
        sessionId: "missing",
        status: "failed",
        errorKind: "not_found",
    });
    assert.equal(state.sessions.activeSessionId, null);
    const navError = selectNavigationError(state);
    assert.equal(navError.errorKind, "not_found");
    assert.equal(navError.retryable, false);
    assert.equal(navError.message, "This session was not found or has not been shared with you.");
});

test("deep-link network failure keeps the retryable flavor", async () => {
    const { controller, store } = makeDeepLinkController({ getSessionError: new TypeError("fetch failed") });

    await controller.start({ initialSessionId: "missing" });
    await controller.stop();

    const state = store.getState();
    assert.deepEqual(state.sessions.navigationIntent, {
        sessionId: "missing",
        status: "failed",
        errorKind: "network",
    });
    assert.equal(state.sessions.activeSessionId, null);
    const navError = selectNavigationError(state);
    assert.equal(navError.errorKind, "network");
    assert.equal(navError.retryable, true);
});

test("setNavigationIntent latches onto an already-loaded session away from the default selection", async () => {
    const { controller, store } = makeDeepLinkController({ getSessionError: new Error("unused") });

    await controller.start({});
    assert.equal(store.getState().sessions.activeSessionId, "s1");

    store.dispatch({ type: "sessions/listDeselect" });
    assert.equal(store.getState().sessions.listDeselected, true);

    controller.setNavigationIntent("s2");
    await controller.stop();

    const state = store.getState();
    assert.equal(state.sessions.activeSessionId, "s2");
    assert.equal(state.sessions.listDeselected, false);
    assert.equal(selectSessionRows(state).find((row) => row.sessionId === "s2")?.active, true);
    assert.deepEqual(selectNavigationIntent(state), { sessionId: "s2", status: "resolved" });
});

function makeOffPageDeepLinkController({ offPageSession = null } = {}) {
    const pagedSessions = [
        { sessionId: "on-page", title: "On Page", status: "idle", owner: ME },
    ];
    const transport = {
        start: async () => {},
        stop: async () => {},
        getAuthContext: () => ({ principal: ME, authorization: { role: "user" } }),
        listSessions: async () => pagedSessions.map((session) => ({ ...session })),
        listSessionGroups: async () => [],
        getSession: async (sessionId) => (
            offPageSession && sessionId === offPageSession.sessionId ? { ...offPageSession } : null
        ),
        getSessionEvents: async () => [],
        subscribeSession: () => () => {},
    };
    const store = createStore(appReducer, createInitialState());
    const controller = new PilotSwarmUiController({ store, transport });
    return { controller, store };
}

test("off-page deep-link target absent from the paged window is fetched, merged, and resolved", async () => {
    const offPageSession = { sessionId: "off-page", title: "Off Page", status: "idle", owner: BOB };
    const { controller, store } = makeOffPageDeepLinkController({ offPageSession });

    await controller.start({ initialSessionId: "off-page" });
    await controller.stop();

    const state = store.getState();
    assert.equal(state.sessions.byId["off-page"]?.title, "Off Page");
    assert.equal(state.sessions.activeSessionId, "off-page");
    assert.deepEqual(selectNavigationIntent(state), { sessionId: "off-page", status: "resolved" });
    assert.equal(selectSessionRows(state).some((row) => row.sessionId === "off-page"), true);
});

test("off-page deep-link target that getSession resolves as null fails the intent as not_found", async () => {
    const { controller, store } = makeOffPageDeepLinkController({ offPageSession: null });

    await controller.start({ initialSessionId: "off-page" });
    await controller.stop();

    const state = store.getState();
    assert.deepEqual(state.sessions.navigationIntent, {
        sessionId: "off-page",
        status: "failed",
        errorKind: "not_found",
    });
    assert.equal(state.sessions.activeSessionId, null);
    const navError = selectNavigationError(state);
    assert.equal(navError.errorKind, "not_found");
    assert.equal(navError.retryable, false);
    assert.equal(navError.message, "This session was not found or has not been shared with you.");
});

// The list used to hide a linked session whose owner was outside the owner
// filter behind a transient exception; the chat opened, the row did not
// reliably show. Now the owner is ADDED to the filter, durably.
test("a linked session by someone outside the owner filter adds that owner to the filter", () => {
    let state = authedState({
        all: false,
        includeSystem: true,
        includeUnowned: false,
        includeMe: true,
        includeShared: false,
        ownerKeys: [],
    });
    state = appReducer(state, { type: "sessions/navigationIntent", sessionId: "foreign" });
    state = appReducer(state, {
        type: "sessions/loaded",
        sessions: [
            { sessionId: "mine", title: "Mine", status: "idle", owner: ME },
            { sessionId: "foreign", title: "Foreign", status: "idle", owner: BOB },
            { sessionId: "foreign-2", title: "Bob's other", status: "idle", owner: BOB },
        ],
    });

    assert.equal(state.sessions.activeSessionId, "foreign");
    assert.equal(state.sessions.filterExceptionId, null, "no transient exception when the owner can be admitted");
    assert.deepEqual(state.sessions.ownerFilter.ownerKeys, ["github\u0001bob"]);
    assert.equal(state.sessions.ownerFilterExplicit, true);
    const listed = selectSessionRows(state).map((row) => row.sessionId);
    assert.ok(listed.includes("foreign"), "the linked session is listed");
    assert.ok(listed.includes("foreign-2"), "the owner's other shared sessions are listed too");
    assert.equal(
        selectSessionFilterExceptionNotice(state),
        "Added Bob to your session filters so the linked session is listed.",
    );

    // The filter change is durable: a manual filter edit clears the notice
    // only, and re-loading keeps Bob's sessions listed.
    state = appReducer(state, { type: "sessions/filterQuery", query: "" });
    assert.equal(selectSessionFilterExceptionNotice(state), null);
    assert.deepEqual(state.sessions.ownerFilter.ownerKeys, ["github\u0001bob"]);
    assert.ok(selectSessionRows(state).some((row) => row.sessionId === "foreign-2"));
});

test("an unowned linked session still falls back to the transient exception", () => {
    let state = authedState({
        all: false,
        includeSystem: true,
        includeUnowned: false,
        includeMe: true,
        includeShared: false,
        ownerKeys: [],
    });
    state = appReducer(state, { type: "sessions/navigationIntent", sessionId: "nobody" });
    state = appReducer(state, {
        type: "sessions/loaded",
        sessions: [
            { sessionId: "mine", title: "Mine", status: "idle", owner: ME },
            { sessionId: "nobody", title: "Unowned", status: "idle", owner: null },
        ],
    });
    assert.equal(state.sessions.filterExceptionId, "nobody");
    assert.deepEqual(state.sessions.ownerFilter.ownerKeys, []);
    assert.equal(selectSessionFilterExceptionNotice(state), "Showing linked session outside your current filters.");
});

test("a stored owner filter arriving after the admit keeps the admitted owner, and the notice tracks the filter", () => {
    let state = authedState({ all: false, includeSystem: true, includeUnowned: false, includeMe: true, includeShared: false, ownerKeys: [] });
    state = appReducer(state, { type: "sessions/navigationIntent", sessionId: "foreign" });
    state = appReducer(state, { type: "sessions/loaded", sessions: [
        { sessionId: "mine", title: "Mine", status: "idle", owner: ME },
        { sessionId: "foreign", title: "Foreign", status: "idle", owner: BOB },
    ] });
    assert.deepEqual(state.sessions.ownerFilter.ownerKeys, ["github\u0001bob"]);
    // The first profile poll answers late with the filter saved BEFORE the link.
    state = appReducer(state, { type: "profileSettings/apply", settings: { sessionOwnerFilter: { all: false, includeSystem: true, includeMe: true, includeShared: false, ownerKeys: [] } } });
    assert.deepEqual(state.sessions.ownerFilter.ownerKeys, ["github\u0001bob"], "the poll must not drop the admitted owner");
    assert.ok(selectSessionRows(state).some((row) => row.sessionId === "foreign"));
    assert.match(selectSessionFilterExceptionNotice(state), /Added Bob/);
    // A manual filter change that removes Bob also retires the notice.
    state = appReducer(state, { type: "sessions/ownerFilter", filter: { all: false, includeSystem: true, includeMe: true, includeShared: false, ownerKeys: [] } });
    assert.equal(selectSessionFilterExceptionNotice(state), null);
});

