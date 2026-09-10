import test from "node:test";
import assert from "node:assert/strict";
import {
    appReducer,
    buildSessionSearchDocument,
    buildSessionTree,
    createInitialState,
    parseSessionSearchQuery,
    scoreSessionSearchDocument,
    selectSessionRows,
} from "../src/index.js";

const owner = (displayName, email) => ({ provider: "entra", subject: email, displayName, email });

function loadedState(sessions) {
    let state = createInitialState();
    state = appReducer(state, { type: "sessions/loaded", sessions });
    return state;
}

function search(state, query) {
    const next = appReducer(state, { type: "sessions/filterQuery", query });
    return { state: next, rows: selectSessionRows(next) };
}

test("session search combines topic, summary, author, agent and structured fields", () => {
    const ada = owner("Ada Lovelace", "ada@example.com");
    const document = buildSessionSearchDocument({
        sessionId: "session-42",
        title: "PostgreSQL failover review",
        shortSummary: "Investigating replica promotion latency",
        summaryState: { intent: "Prepare the incident report" },
        agentId: "database-reviewer",
        status: "running",
        model: "github-copilot:gpt-5.6-terra",
    }, { owner: ada, groupTitle: "R2D Sessions" });

    for (const query of [
        "replica promotion",
        "author:ada",
        "agent:database-reviewer status:running",
        'group:"R2D Sessions" model:terra',
        "id:session-42",
        "topic:failover",
        "summary:incident",
    ]) {
        assert.ok(scoreSessionSearchDocument(document, parseSessionSearchQuery(query)) > 0, query);
    }
    assert.equal(scoreSessionSearchDocument(document, parseSessionSearchQuery("author:grace")), 0);
});

test("free text tolerates bounded typos while requiring every term", () => {
    const document = buildSessionSearchDocument({
        sessionId: "s1",
        title: "Postgres migration readiness",
        shortSummary: "Validates extension compatibility",
    });
    assert.ok(scoreSessionSearchDocument(document, "postgress migratoin") > 0);
    assert.equal(scoreSessionSearchDocument(document, "postgress billing"), 0);
});

test("exact title results rank ahead of summary-only and fuzzy results", () => {
    const state = loadedState([
        { sessionId: "summary", title: "Database work", shortSummary: "Postgres migration", status: "idle", createdAt: 1 },
        { sessionId: "fuzzy", title: "Postgress migratoin", status: "idle", createdAt: 2 },
        { sessionId: "title", title: "Postgres migration", status: "idle", createdAt: 3 },
    ]);
    const { rows } = search(state, "postgres migration");
    assert.deepEqual(rows.map((row) => row.sessionId), ["title", "summary", "fuzzy"]);
    assert.ok(rows[0].searchScore > rows[1].searchScore);
    assert.ok(rows[1].searchScore > rows[2].searchScore);
});

test("search reveals matching descendants without changing stored collapse state", () => {
    const sessions = [
        { sessionId: "group:g", groupId: "g", isGroup: true, title: "Incidents", status: "group", createdAt: 1 },
        { sessionId: "parent", groupId: "g", title: "Primary investigation", status: "idle", createdAt: 2 },
        { sessionId: "child", parentSessionId: "parent", title: "Replica promotion latency", status: "idle", createdAt: 3 },
        { sessionId: "other", title: "Unrelated", status: "idle", createdAt: 4 },
    ];
    let state = createInitialState();
    state = {
        ...state,
        sessions: {
            ...state.sessions,
            byId: Object.fromEntries(sessions.map((session) => [session.sessionId, session])),
            flat: buildSessionTree(sessions, new Set(["group:g", "parent"])),
            collapsedIds: new Set(["group:g", "parent"]),
            activeSessionId: "other",
        },
    };

    const result = search(state, "promotion latency");
    assert.deepEqual(result.rows.map((row) => [row.sessionId, row.depth]), [
        ["group:g", 0],
        ["parent", 1],
        ["child", 2],
    ]);
    assert.equal(result.rows.find((row) => row.sessionId === "child")?.searchMatch, true);
    assert.deepEqual([...result.state.sessions.collapsedIds].sort(), ["group:g", "parent"]);
    assert.equal(result.state.sessions.activeSessionId, "other", "filtering does not replace the attached chat");

    const cleared = search(result.state, "");
    assert.deepEqual(cleared.rows.map((row) => row.sessionId), ["group:g", "other"]);
});

test("selector searches effective parent ownership and live summaries", () => {
    const affan = owner("Affan Dar", "daraffan@microsoft.com");
    const state = loadedState([
        { sessionId: "parent", title: "Coordinator", owner: affan, status: "idle", createdAt: 1 },
        {
            sessionId: "child",
            parentSessionId: "parent",
            title: "Worker",
            shortSummary: "Auditing native task filesystem sharing",
            status: "idle",
            createdAt: 2,
        },
    ]);
    assert.deepEqual(search(state, "author:affan filesystem").rows.map((row) => row.sessionId), ["parent", "child"]);
});
