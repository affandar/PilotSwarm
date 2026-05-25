import test from "node:test";
import assert from "node:assert/strict";
import {
    PilotSwarmUiController,
    buildSessionTree,
    createInitialState,
    createStore,
    appReducer,
    selectSessionRows,
    selectActiveChat,
} from "../src/index.js";

test("buildSessionTree groups top-level members under synthetic group rows", () => {
    const sessions = [
        { sessionId: "ungrouped", title: "Ungrouped", createdAt: 1 },
        { sessionId: "group:release", groupId: "release", isGroup: true, title: "Release", latestSummaryUpdatedAt: 30 },
        { sessionId: "parent", groupId: "release", title: "Parent", summaryUpdatedAt: 20, createdAt: 2 },
        { sessionId: "child", parentSessionId: "parent", groupId: "release", title: "Child", summaryUpdatedAt: 25, createdAt: 3 },
    ];

    const flat = buildSessionTree(sessions, new Set(), {}, []);
    assert.deepEqual(flat.map((entry) => [entry.sessionId, entry.depth]), [
        ["group:release", 0],
        ["parent", 1],
        ["child", 2],
        ["ungrouped", 0],
    ]);
});

test("session row selector renders group icon and summary-searchable rows", () => {
    let state = createInitialState();
    state = appReducer(state, {
        type: "sessions/loaded",
        sessions: [
            {
                sessionId: "group:release",
                groupId: "release",
                isGroup: true,
                title: "Release Validation",
                status: "group",
                shortSummary: "Canary smoke sessions",
                memberCount: 1,
                latestSummaryUpdatedAt: Date.parse("2026-05-16T01:00:00Z"),
            },
            {
                sessionId: "member-a",
                groupId: "release",
                title: "Member A",
                status: "idle",
                shortSummary: "Checkout API canary",
                summaryState: { intent: "Validate checkout", summary: "Smoke running" },
                summaryUpdatedAt: Date.parse("2026-05-16T01:01:00Z"),
            },
        ],
    });

    const rows = selectSessionRows(state);
    assert.equal(rows[0].sessionId, "group:release");
    assert.equal(rows[0].isGroup, true);
    assert.equal(rows[0].runs[1].text, "🗂  ");
    assert.match(rows[0].text, /Release Validation/);
    assert.match(rows[0].text, /1 member/);

    state = appReducer(state, { type: "sessions/expand", sessionId: "group:release" });
    state = appReducer(state, { type: "sessions/filterQuery", query: "checkout" });
    const filtered = selectSessionRows(state);
    assert.equal(filtered.some((row) => row.sessionId === "member-a"), true);
});

test("active group renders a group details card instead of transcript", () => {
    let state = createInitialState();
    state = appReducer(state, {
        type: "sessions/loaded",
        sessions: [
            {
                sessionId: "group:release",
                groupId: "release",
                isGroup: true,
                title: "Release Validation",
                status: "group",
                shortSummary: "Canary group",
                memberCount: 1,
                runningCount: 1,
            },
            {
                sessionId: "member-a",
                groupId: "release",
                title: "Member A",
                status: "running",
                shortSummary: "Smoke running",
            },
        ],
    });
    state = appReducer(state, { type: "sessions/selected", sessionId: "group:release" });

    const chat = selectActiveChat(state);
    assert.equal(chat.length, 1);
    assert.equal(chat[0].id, "group-details:group:release");
    assert.equal(chat[0].noChrome, true);
    assert.match(chat[0].text, /^# Release Validation/);
    assert.match(chat[0].text, /\| Member A \| running \| Smoke running \|/);
});

test("group rows are not bulk-selectable", () => {
    let state = createInitialState();
    state = appReducer(state, {
        type: "sessions/loaded",
        sessions: [
            { sessionId: "group:release", groupId: "release", isGroup: true, title: "Release", status: "group" },
            { sessionId: "member-a", groupId: "release", title: "Member A", status: "running" },
        ],
    });
    state = appReducer(state, { type: "sessions/selectSet", sessionIds: ["group:release", "member-a"] });

    assert.deepEqual(state.sessions.selectedIds, ["member-a"]);

    state = appReducer(state, { type: "sessions/selectToggle", sessionId: "group:release" });
    assert.deepEqual(state.sessions.selectedIds, ["member-a"]);
});

test("chat summary mode renders structured session summary", () => {
    let state = createInitialState();
    state = appReducer(state, {
        type: "sessions/loaded",
        sessions: [{
            sessionId: "member-a",
            title: "Member A",
            status: "waiting",
            summaryState: {
                intent: "Validate checkout",
                summary: "Checkout smoke is waiting on rollout.",
                state: { phase: "canary" },
                blockers: ["Rollout pending"],
                openQuestions: [],
                nextActions: ["Re-run smoke"],
            },
            summaryUpdatedAt: Date.parse("2026-05-16T01:01:00Z"),
        }],
    });
    state = appReducer(state, { type: "sessions/selected", sessionId: "member-a" });
    state = appReducer(state, { type: "ui/chatViewMode", mode: "summary" });

    const chat = selectActiveChat(state);
    assert.equal(chat.length, 1);
    assert.equal(chat[0].id, "summary:member-a");
    assert.equal(chat[0].noChrome, true);
    assert.match(chat[0].text, /^# Member A/);
    assert.match(chat[0].text, /\*\*Intent:\*\* Validate checkout/);
    assert.match(chat[0].text, /\*\*phase:\*\* canary/);
    assert.match(chat[0].text, /Rollout pending/);
});

test("new session creation inherits the active session group", async () => {
    const store = createStore(appReducer, createInitialState());
    const createdOptions = [];
    const controller = new PilotSwarmUiController({
        store,
        transport: {
            async createSession(options) {
                createdOptions.push(options);
                return { sessionId: "new-session" };
            },
            async listSessions() {
                return [];
            },
            async listSessionGroups() {
                return [];
            },
            async getSession() {
                return null;
            },
        },
    });

    store.dispatch({
        type: "sessions/loaded",
        sessions: [
            { sessionId: "group:release", groupId: "release", isGroup: true, title: "Release", status: "group" },
        ],
    });
    store.dispatch({ type: "sessions/selected", sessionId: "group:release" });

    await controller.createSession({ title: "Canary" });

    assert.equal(createdOptions.length, 1);
    assert.equal(createdOptions[0].groupId, "release");
});

test("select mode cancels the selected row even when one row is selected", async () => {
    const store = createStore(appReducer, createInitialState());
    const cancelled = [];
    const controller = new PilotSwarmUiController({
        store,
        transport: {
            async cancelSession(sessionId) {
                cancelled.push(sessionId);
            },
            async listSessions() {
                return [];
            },
            async listSessionGroups() {
                return [];
            },
            subscribeSession() {
                return () => {};
            },
        },
    });

    store.dispatch({
        type: "sessions/loaded",
        sessions: [
            { sessionId: "member-a", title: "Member A", status: "running" },
            { sessionId: "member-b", title: "Member B", status: "running" },
        ],
    });
    store.dispatch({ type: "sessions/selected", sessionId: "member-a" });
    store.dispatch({ type: "sessions/selectMode", enabled: true });
    store.dispatch({ type: "sessions/selectToggle", sessionId: "member-a" });
    store.dispatch({ type: "sessions/selected", sessionId: "member-b" });

    await controller.cancelActiveSession({ confirmed: true });

    assert.deepEqual(cancelled, ["member-a"]);
});
