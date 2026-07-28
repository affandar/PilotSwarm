// The transcript window a session RE-OPENS with is bounded.
//
// WHY: `loadedEventLimit` is sticky by design — paging back through a session
// keeps the expanded window while you are in it. But ensureSessionHistory then
// re-requested that same expanded size on every switch-in, forever, so one trip
// through a busy session's history made it permanently expensive to open: 10k
// events re-fetched, re-derived and re-laid-out each time you selected it.
import test from "node:test";
import assert from "node:assert/strict";
import {
    PilotSwarmUiController,
    appReducer,
    createInitialState,
    createStore,
    buildHistoryModel,
} from "../src/index.js";

const REENTRY_CAP = 1_500;

function makeController({ onGetSessionEvents }) {
    const transport = {
        async getSessionEvents(sessionId, afterSeq, limit) {
            onGetSessionEvents(limit);
            return [];
        },
        async getSessionDetail() { return null; },
    };
    const store = createStore(appReducer, createInitialState());
    return { controller: new PilotSwarmUiController({ store, transport }), store };
}

test("re-opening a session that was paged far back requests a bounded window", async () => {
    const limits = [];
    const { controller, store } = makeController({ onGetSessionEvents: (l) => limits.push(l) });

    // Simulate a session the user scrolled back through: the window escalated
    // to the top step (10k events).
    store.dispatch({
        type: "history/set",
        sessionId: "s1",
        history: { ...buildHistoryModel([], { requestedLimit: 10_000 }), lastSeq: 0 },
    });
    assert.equal(store.getState().history.bySessionId.get("s1").loadedEventLimit, 10_000);

    await controller.ensureSessionHistory("s1", { force: true });

    assert.equal(limits.length, 1, "expected exactly one history fetch");
    assert.ok(
        limits[0] <= REENTRY_CAP,
        `re-entry requested ${limits[0]} events; the cap is ${REENTRY_CAP}. Without it, a session `
        + "paged back to 10k re-fetches 10k on every switch-in for the life of the tab.",
    );
});

test("a session with no history still gets the normal first page", async () => {
    const limits = [];
    const { controller } = makeController({ onGetSessionEvents: (l) => limits.push(l) });

    await controller.ensureSessionHistory("fresh", { force: true });

    assert.equal(limits.length, 1);
    // The cap must not shrink the default window.
    assert.ok(limits[0] >= 300, `first load asked for ${limits[0]} events, expected at least 300`);
    assert.ok(limits[0] <= REENTRY_CAP);
});
