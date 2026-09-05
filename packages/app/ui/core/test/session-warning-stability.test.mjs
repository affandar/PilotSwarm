import test from "node:test";
import assert from "node:assert/strict";
import { appReducer, createInitialState, createStore, PilotSwarmUiController, selectActiveChat, selectChatLines } from "../src/index.js";

const T = 1_780_000_000_000;
const ERROR = "Execution failed: 400 Unknown parameter: 'snippy'. (retry 1/3 in 15s)";
function setup(error = ERROR) {
    const store = createStore(appReducer, createInitialState());
    store.dispatch({ type: "sessions/loaded", sessions: [{ sessionId: "s1", title: "Recurring", status: "error", orchestrationStatus: "Running", error, updatedAt: T, statusVersion: 10 }] });
    store.dispatch({ type: "sessions/selected", sessionId: "s1" });
    let detail;
    const controller = new PilotSwarmUiController({ store, transport: { getSession: async () => detail } });
    return { store, controller, sync: async (fields) => {
        detail = { sessionId: "s1", orchestrationStatus: "Running", updatedAt: T, ...fields };
        await controller.syncSessionDetail("s1");
    } };
}
const warning = store => selectActiveChat(store.getState()).find(m => m.cardTitle === "Warning");
const card = store => selectChatLines(store.getState(), 120, { tableMode: "sentinel" }).find(l => l.kind === "cardStart");

test("catalog/detail churn and changing retry text keep one stable warning card", async () => {
    const { store, sync } = setup();
    const id = warning(store).id;
    const key = card(store).cardKey;
    assert.equal(key, id);
    for (const status of ["idle", "waiting", "running"]) {
        store.dispatch({ type: "sessions/loaded", sessions: [{ sessionId: "s1", title: "Recurring", status, updatedAt: T }] });
        assert.equal(warning(store)?.id, id, `catalog ${status}`);
        await sync({ status, statusVersion: 10 });
        assert.equal(warning(store)?.id, id, `detail ${status}`);
        assert.equal(card(store)?.cardKey, key);
    }
    await sync({ status: "error", error: ERROR.replace("1/3 in 15s", "2/3 in 30s"), statusVersion: 11 });
    assert.equal(warning(store)?.id, id);
    assert.equal(card(store)?.cardKey, key);
    assert.match(warning(store).text, /2\/3 in 30s/);
});

test("newer recovered states and explicit clears remove the warning", async () => {
    for (const fields of [
        { status: "idle", statusVersion: 11 },
        { status: "waiting", statusVersion: 11 },
        { status: "idle", updatedAt: T + 100 },
        { status: "running", error: null },
        { status: "running", error: "" },
        { status: "input_required", statusVersion: 11 },
        { status: "completed", orchestrationStatus: "Completed" },
        { status: "cancelled", orchestrationStatus: "Terminated" },
        { status: "error", orchestrationStatus: "Completed" },
        { status: "error", orchestrationStatus: "Terminated" },
    ]) {
        const { store, sync } = setup();
        await sync(fields);
        assert.equal(warning(store), undefined, JSON.stringify(fields));
    }
});

test("terminal failures stay errors, and retry retention is not tied to provider wording", async () => {
    for (const text of [ERROR, "Connection is closed", "Rate limited", "Execution failed: 400 Unknown parameter: 'snippy'."]) {
        const { store, sync } = setup(text);
        await sync({ status: "running", statusVersion: 11 });
        assert.ok(warning(store)?.text.startsWith(text));
        await sync({ status: "failed", orchestrationStatus: "Failed", error: text });
        assert.equal(warning(store), undefined);
        assert.ok(selectActiveChat(store.getState()).some(m => m.cardTitle === "Error"));
    }
});
