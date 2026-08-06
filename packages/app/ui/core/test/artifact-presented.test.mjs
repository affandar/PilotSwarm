// The agent's show_artifact tool moves the user's workspace on its own. That is
// only defensible under tight guards, so the guards are the test: it fires for
// a live presentation on the session you are looking at, and for nothing else.
//
// The event rides the ordinary durable session-event stream, so this same code
// path also sees the catch-up burst after a reconnect. Replaying an old
// presentation as if it just happened would reorganize the workspace around
// something the agent said an hour ago.
import test from "node:test";
import assert from "node:assert/strict";
import {
    PilotSwarmUiController,
    appReducer,
    createInitialState,
    createStore,
} from "../src/index.js";

function presentedEvent({ filename = "dash.html", fullscreen = false, agoMs = 0, seq = 10 } = {}) {
    return {
        seq,
        eventType: "session.artifact_presented",
        createdAt: new Date(Date.now() - agoMs).toISOString(),
        data: { filename, fullscreen },
    };
}

// A controller whose revealArtifact is replaced by a spy: these tests are about
// whether the decision is made, not about the reveal machinery underneath.
function controllerWithSessions(activeSessionId) {
    let state = createInitialState();
    state = appReducer(state, {
        type: "sessions/loaded",
        sessions: [
            { sessionId: "s1", title: "One", status: "running" },
            { sessionId: "s2", title: "Two", status: "running" },
        ],
    });
    if (activeSessionId) {
        state = appReducer(state, { type: "sessions/selected", sessionId: activeSessionId });
    }
    const store = createStore(appReducer, state);
    const controller = new PilotSwarmUiController({
        store,
        transport: {
            listSessions: async () => [],
            subscribeSession: () => () => {},
            getCurrentUserProfile: async () => ({ provider: "t", subject: "u", profileSettings: {} }),
        },
    });
    const calls = [];
    controller.revealArtifact = async (sessionId, filename, options) => {
        calls.push({ sessionId, filename, options });
        return true;
    };
    return { controller, calls };
}

test("a fresh presentation on the ACTIVE session opens the artifact reader", () => {
    // The reader pane, not fullscreen: an agent showing you something mid-turn
    // must not cover the conversation that explains it.
    const { controller, calls } = controllerWithSessions("s1");
    const revealed = controller.maybeRevealPresentedArtifact("s1", presentedEvent());

    assert.equal(revealed, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].sessionId, "s1");
    assert.equal(calls[0].filename, "dash.html");
    assert.equal(calls[0].options.pane, true);
    assert.notEqual(calls[0].options.fullscreen, true);
});

test("fullscreen=true from the tool takes the whole window instead", () => {
    const { controller, calls } = controllerWithSessions("s1");
    controller.maybeRevealPresentedArtifact("s1", presentedEvent({ fullscreen: true }));
    assert.equal(calls[0].options.fullscreen, true);
    assert.notEqual(calls[0].options.pane, true);
});

test("a BACKGROUND session cannot yank the pane away from the one being read", () => {
    const { controller, calls } = controllerWithSessions("s1");
    const revealed = controller.maybeRevealPresentedArtifact("s2", presentedEvent());

    assert.equal(revealed, false);
    assert.deepEqual(calls, [], "s2 finishing a dashboard must not steal the view from s1");
});

test("a STALE presentation from a reconnect burst is ignored", () => {
    const { controller, calls } = controllerWithSessions("s1");
    const revealed = controller.maybeRevealPresentedArtifact("s1", presentedEvent({ agoMs: 30 * 60_000 }));

    assert.equal(revealed, false);
    assert.deepEqual(calls, [], "catching up on old events must not replay presentations");
});

test("an event with no filename is dropped rather than revealing nothing", () => {
    const { controller, calls } = controllerWithSessions("s1");
    assert.equal(controller.maybeRevealPresentedArtifact("s1", presentedEvent({ filename: "" })), false);
    assert.equal(controller.maybeRevealPresentedArtifact("s1", { seq: 1, eventType: "session.artifact_presented" }), false);
    assert.deepEqual(calls, []);
});

test("an event with no timestamp still reveals — absent is not stale", () => {
    // Not every transport stamps createdAt. Failing closed here would make the
    // feature silently dead on those, which is worse than the narrow risk of
    // honouring an undated event.
    const { controller, calls } = controllerWithSessions("s1");
    const revealed = controller.maybeRevealPresentedArtifact("s1", {
        seq: 3,
        eventType: "session.artifact_presented",
        data: { filename: "x.html" },
    });
    assert.equal(revealed, true);
    assert.equal(calls.length, 1);
});

test("the live merge path routes the event; a bulk history load does not", () => {
    // mergeSessionEvent is the LIVE path. ensureSessionHistory bulk-loads
    // bypass it entirely, which is what keeps merely OPENING a session from
    // auto-opening whatever it last presented.
    const { controller, calls } = controllerWithSessions("s1");
    controller.mergeSessionEvent("s1", presentedEvent({ seq: 42 }));
    assert.equal(calls.length, 1, "the live path reveals");

    // Replaying the same seq is a no-op: merge rejects it before the reveal.
    controller.mergeSessionEvent("s1", presentedEvent({ seq: 42 }));
    assert.equal(calls.length, 1, "an already-seen seq must not reveal twice");
});
