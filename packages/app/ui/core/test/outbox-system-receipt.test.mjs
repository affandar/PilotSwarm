import test from "node:test";
import assert from "node:assert/strict";
import { PilotSwarmUiController } from "../src/controller.js";
import { appReducer } from "../src/reducer.js";
import { createInitialState } from "../src/state.js";
import { createStore } from "../src/store.js";

function harness(events = []) {
    const store = createStore(appReducer, createInitialState({ mode: "local" }));
    const controller = new PilotSwarmUiController({
        store,
        transport: { getSessionEvents: async () => events, subscribeSession: () => () => {} },
    });
    store.dispatch({ type: "sessions/loaded", sessions: [{ sessionId: "s1", title: "Test", status: "idle" }] });
    store.dispatch({ type: "sessions/selected", sessionId: "s1" });
    const queued = controller.buildOutboxItem("status?", "queued");
    controller.setSessionOutboxItems("s1", [queued]);
    return { controller, queued, outbox: () => store.getState().outbox.bySessionId.s1 || [] };
}

function receipt(ids, content = "[SESSION_MESSAGE request_id=r from=child subject=Update]\nBuild complete.\n\nstatus?") {
    return { seq: 1, sessionId: "s1", eventType: "system.message", createdAt: "2026-09-07T17:43:47.254Z",
        data: { content, ...(ids ? { clientMessageIds: ids } : {}) } };
}

test("a live legacy merged system event acknowledges the exact contributing outbox item", () => {
    const { controller, queued, outbox } = harness();
    const unrelated = controller.buildOutboxItem("status?", "queued");
    controller.setSessionOutboxItems("s1", [queued, unrelated]);
    const event = receipt(queued.clientMessageIds);
    controller.mergeSessionEvent("s1", event);
    controller.mergeSessionEvent("s1", event);
    assert.deepEqual(outbox().map(item => item.id), [unrelated.id]);
});

test("bulk history recovery acknowledges a system receipt missed by the live stream", async () => {
    const events = [];
    const { controller, queued, outbox } = harness(events);
    events.push(receipt(queued.clientMessageIds));
    await controller.ensureSessionHistory("s1", { force: true });
    assert.equal(outbox().length, 0);
});

test("system messages never acknowledge by quoted text or an unmatched identity", () => {
    const { controller, outbox } = harness();
    for (const event of [receipt(undefined, "status?"), receipt(["another-message"], "status?")]) {
        controller.reconcileOutboxAgainstEvent("s1", event);
        assert.equal(outbox().length, 1);
    }
});

test("a legacy singular identity acknowledges only within its target session", () => {
    const { controller, queued, outbox } = harness();
    const event = receipt();
    event.data.clientMessageId = queued.clientMessageIds[0];
    controller.reconcileOutboxAgainstEvent("other-session", event);
    assert.equal(outbox().length, 1);
    controller.reconcileOutboxAgainstEvent("s1", event);
    assert.equal(outbox().length, 0);
});

test("legacy user messages retain their text-match acknowledgement", () => {
    const { controller, outbox } = harness();
    controller.reconcileOutboxAgainstEvent("s1", { ...receipt(undefined, "status?"), eventType: "user.message" });
    assert.equal(outbox().length, 0);
});
