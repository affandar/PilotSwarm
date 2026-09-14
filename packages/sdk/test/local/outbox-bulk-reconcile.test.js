import { describe, it } from "vitest";
import { PilotSwarmUiController } from "../../../app/ui/core/src/controller.js";
import { appReducer } from "../../../app/ui/core/src/reducer.js";
import { createInitialState } from "../../../app/ui/core/src/state.js";
import { createStore } from "../../../app/ui/core/src/store.js";
import { selectActivityPane } from "../../../app/ui/core/src/selectors.js";
import { assert, assertEqual } from "../helpers/assertions.js";

function createController(transportOverrides = {}) {
    const transport = {
        start: async () => {},
        stop: async () => {},
        listSessions: async () => [],
        getSessionEvents: async () => [],
        subscribeSession: () => () => {},
        ...transportOverrides,
    };
    const store = createStore(appReducer, createInitialState({ mode: "local" }));
    return {
        store,
        transport,
        controller: new PilotSwarmUiController({ store, transport }),
    };
}

function seedSession(store, sessionId = "session-12345678") {
    store.dispatch({
        type: "sessions/loaded",
        sessions: [{
            sessionId,
            title: "Outbox Reconcile Test",
            status: "completed",
            createdAt: Date.now(),
            updatedAt: Date.now(),
        }],
    });
    return sessionId;
}

function seedQueuedOutboxItem(store, controller, sessionId, clientMessageId, text) {
    const item = {
        id: clientMessageId,
        text,
        createdAt: Date.now(),
        phase: "queued",
        clientMessageIds: [clientMessageId],
    };
    controller.setSessionOutboxItems(sessionId, [item]);
    return item;
}

describe("outbox bulk reconciliation", () => {
    it.each(["live", "bulk"])("preserves runtime-rejected drafts through the %s event path", async (path) => {
        const sessionId = "rejection-session";
        const clientMessageId = "rejected-message";
        const event = {
            seq: 1,
            eventType: "session.message_rejected",
            createdAt: new Date().toISOString(),
            data: { code: "MESSAGE_TOO_LARGE", message: "Upload large content as an artifact.", clientMessageIds: [clientMessageId] },
        };
        const { controller, store } = createController({ getSessionEvents: async () => [event] });
        seedSession(store, sessionId);
        seedQueuedOutboxItem(store, controller, sessionId, clientMessageId, "preserve the original request");

        if (path === "live") controller.mergeSessionEvent(sessionId, event);
        else await controller.ensureSessionHistory(sessionId, { force: true });

        const rejected = controller.getSessionOutbox(sessionId);
        assertEqual(rejected.length, 1, "runtime rejection should retain the draft");
        assertEqual(rejected[0].phase, "rejected", "both event paths must mark the message rejected");
        assertEqual(rejected[0].error, event.data.message, "runtime rejection reason should be retained");
        assertEqual(rejected[0].text, "preserve the original request", "rejected content must remain recoverable");
        const activityText = JSON.stringify(selectActivityPane(store.getState()).lines);
        assert(activityText.includes("[message rejected]") && activityText.includes(event.data.message), "Activity should expose a readable rejection after history reload");
    });

    it("does not overwrite a durable rejection with a late enqueue acknowledgement", async () => {
        const sessionId = "rejection-before-ack";
        const { controller, store } = createController({
            sendMessage: async (_sessionId, _prompt, options) => {
                controller.reconcileOutboxAgainstEvent(sessionId, {
                    eventType: "session.message_rejected",
                    data: { message: "Message exceeds the FIFO limit.", clientMessageIds: options.clientMessageIds },
                });
            },
        });
        seedSession(store, sessionId);
        const item = controller.buildOutboxItem("rejected before acknowledgement");
        controller.setSessionOutboxItems(sessionId, [item]);

        await controller.dispatchPendingOutbox(sessionId);

        assertEqual(controller.getSessionOutbox(sessionId)[0].phase, "rejected", "runtime outcome must win over enqueue acknowledgement");
        assertEqual(controller.getPendingOutboxItems(sessionId).length, 0, "durably rejected messages must not retry");
    });

    it("ensureSessionHistory removes queued outbox items whose user.message is already in CMS", async () => {
        const sessionId = "11111111-2222-3333-4444-555555555555";
        const cmid = "msg:1777251609189:4h49ly6b";
        const cmsEvents = [
            {
                seq: 100,
                eventType: "user.message",
                createdAt: new Date().toISOString(),
                data: { content: "are you going to use the T3 repo cache?", clientMessageIds: [cmid] },
            },
        ];

        const { controller, store } = createController({
            getSessionEvents: async () => cmsEvents,
        });
        seedSession(store, sessionId);
        seedQueuedOutboxItem(store, controller, sessionId, cmid, "are you going to use the T3 repo cache?");

        // Sanity: outbox starts with one queued item.
        assertEqual(controller.getSessionOutbox(sessionId).length, 1, "outbox should start with one queued item");

        await controller.ensureSessionHistory(sessionId, { force: true });

        const remainingOutbox = controller.getSessionOutbox(sessionId);
        assertEqual(remainingOutbox.length, 0,
            "ensureSessionHistory should reconcile the queued outbox item against the bulk-loaded user.message event");
    });

    it("ensureSessionHistory removes cancelling outbox items whose pending_messages.cancelled is already in CMS", async () => {
        const sessionId = "22222222-3333-4444-5555-666666666666";
        const cmid = "msg:1777251609190:abcdefgh";
        const cmsEvents = [
            {
                seq: 200,
                eventType: "pending_messages.cancelled",
                createdAt: new Date().toISOString(),
                data: { clientMessageIds: [cmid], reason: "drain-stash" },
            },
        ];

        const { controller, store } = createController({
            getSessionEvents: async () => cmsEvents,
        });
        seedSession(store, sessionId);
        const item = {
            id: cmid,
            text: "this was cancelled",
            createdAt: Date.now(),
            phase: "cancelling",
            clientMessageIds: [cmid],
        };
        controller.setSessionOutboxItems(sessionId, [item]);

        assertEqual(controller.getSessionOutbox(sessionId).length, 1, "outbox should start with one cancelling item");

        await controller.ensureSessionHistory(sessionId, { force: true });

        const remainingOutbox = controller.getSessionOutbox(sessionId);
        assertEqual(remainingOutbox.length, 0,
            "ensureSessionHistory should reconcile the cancelling outbox item against the bulk-loaded pending_messages.cancelled event");
    });

    it("mergeSessionEvent still reconciles per-event (live subscription path)", async () => {
        const sessionId = "33333333-4444-5555-6666-777777777777";
        const cmid = "msg:1777251609191:zzzzzzzz";

        const { controller, store } = createController();
        seedSession(store, sessionId);
        seedQueuedOutboxItem(store, controller, sessionId, cmid, "live subscription test");

        controller.mergeSessionEvent(sessionId, {
            seq: 1,
            eventType: "user.message",
            createdAt: new Date().toISOString(),
            data: { content: "live subscription test", clientMessageIds: [cmid] },
        });

        assertEqual(controller.getSessionOutbox(sessionId).length, 0,
            "live mergeSessionEvent path should still ack queued outbox item");
    });

    it("ensureSessionHistory reconciliation is idempotent and harmless when no outbox item matches", async () => {
        const sessionId = "44444444-5555-6666-7777-888888888888";
        const cmsEvents = [
            {
                seq: 300,
                eventType: "user.message",
                createdAt: new Date().toISOString(),
                data: { content: "no matching outbox", clientMessageIds: ["msg:nonexistent:xxxx"] },
            },
        ];

        const { controller, store } = createController({
            getSessionEvents: async () => cmsEvents,
        });
        seedSession(store, sessionId);
        // Outbox has a different item that should NOT be touched.
        const otherCmid = "msg:1777251609192:other___";
        seedQueuedOutboxItem(store, controller, sessionId, otherCmid, "different message");

        await controller.ensureSessionHistory(sessionId, { force: true });

        const remaining = controller.getSessionOutbox(sessionId);
        assertEqual(remaining.length, 1, "non-matching outbox item should be preserved");
        assertEqual(remaining[0].id, otherCmid, "non-matching outbox item id preserved");
        assertEqual(remaining[0].phase, "queued", "non-matching outbox item phase preserved");
    });
});
