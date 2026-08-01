/**
 * Overlapping catalog refreshes must not let an OLD snapshot land on a new
 * one. The catalog loop ticks every 4s while a single refresh awaits several
 * sequential round-trips, and a dozen actions call refreshSessions() directly,
 * so two runs are routinely in flight at once.
 *
 * The visible bug: a run whose folder listing was taken BEFORE a folder
 * existed finishes AFTER the run that saw it. sessions/groupsLoaded is
 * authoritative — "folders it omits are gone" — so the folder was deleted, its
 * members reflowed to the top level (reading as if they had jumped into the
 * neighbouring folder), and the next tick put the folder back. Flicker.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
    PilotSwarmUiController,
    appReducer,
    createInitialState,
    createStore,
} from "../src/index.js";

const GROUP = { groupId: "g1", title: "Release Group", memberCount: 1, createdAt: 1, updatedAt: 2 };
const SESSION_BEFORE = { sessionId: "s1", title: "S1", status: "idle" };
const SESSION_AFTER = { sessionId: "s1", title: "S1", status: "idle", viewerGroupId: "g1" };

function deferred() {
    let resolve;
    const promise = new Promise((r) => { resolve = r; });
    return { promise, resolve };
}

function makeOverlapController() {
    // "before" = the folder does not exist yet; "after" = it does and s1 is in
    // it. Each transport call captures the snapshot AT CALL TIME, which is what
    // makes a gated call genuinely stale rather than merely slow.
    let scenario = "before";
    let gateNextGroupFetch = null;

    const transport = {
        listSessions: async () => (scenario === "before" ? [{ ...SESSION_BEFORE }] : [{ ...SESSION_AFTER }]),
        listSessionGroups: async () => {
            const payload = scenario === "before" ? [] : [{ ...GROUP }];
            if (gateNextGroupFetch) {
                const gate = gateNextGroupFetch;
                gateNextGroupFetch = null;
                await gate.promise;
            }
            return payload;
        },
        getSession: async () => null,
        getSessionEvents: async () => [],
        subscribeSession: () => () => {},
    };

    const store = createStore(appReducer, createInitialState());
    const controller = new PilotSwarmUiController({ store, transport });
    return {
        controller,
        store,
        setScenario: (next) => { scenario = next; },
        gateNextGroupFetch: () => {
            const gate = deferred();
            gateNextGroupFetch = gate;
            return gate;
        },
    };
}

test("a refresh overtaken by a newer one cannot delete the folder the newer one found", async () => {
    const { controller, store, setScenario, gateNextGroupFetch } = makeOverlapController();

    // Run A starts while the folder does not exist and stalls on its folder
    // listing, holding an empty (soon-to-be-stale) result.
    const gate = gateNextGroupFetch();
    const staleRun = controller.refreshSessions();

    // The user creates the folder and files s1 into it; run B sees both.
    setScenario("after");
    await controller.refreshSessions();
    assert.equal(Boolean(store.getState().sessions.byId["group:g1"]), true, "the newer run should have added the folder");

    // Run A finally lands, carrying the pre-folder world.
    gate.resolve();
    await staleRun;

    const state = store.getState();
    assert.equal(Boolean(state.sessions.byId["group:g1"]), true, "the stale run must not delete the folder");
    assert.equal(state.sessions.byId.s1?.groupId, "g1", "the stale run must not empty the folder");
    assert.equal(
        state.sessions.flat.some((entry) => entry.sessionId === "s1" && entry.depth === 0),
        false,
        "the member must not reflow to the top level",
    );
});

test("a refresh that is not overtaken still applies a folder deletion", async () => {
    const { controller, store, setScenario } = makeOverlapController();

    setScenario("after");
    await controller.refreshSessions();
    assert.equal(Boolean(store.getState().sessions.byId["group:g1"]), true);

    // A genuine deletion: the newest run is the one that omits the folder, and
    // its session snapshot no longer claims membership. It must still apply —
    // the guard drops STALE runs, it does not make folders undeletable.
    setScenario("before");
    await controller.refreshSessions();

    const state = store.getState();
    assert.equal(state.sessions.byId["group:g1"], undefined, "a current run must still remove a deleted folder");
    assert.equal(state.sessions.byId.s1?.groupId, null, "membership clears with the folder");
});

/**
 * A folder's row id ("group:<uuid>") is a CLIENT-SIDE row, not a session. The
 * per-row detail sync walks VISIBLE rows — which include folders — so it used
 * to GET /api/v1/sessions/group%3A<uuid>. The server correctly answered 404,
 * the loop read that as "session deleted" and evicted the row. The folder
 * vanished a few ms after every refresh re-added it, and its members reflowed
 * under the folder above, reading as if they had jumped into it.
 */
test("a folder row is never fetched as a session, and a 404 cannot evict it", async () => {
    const requested = [];
    const transport = {
        listSessions: async () => [{ sessionId: "s1", title: "S1", status: "idle", viewerGroupId: "g1" }],
        listSessionGroups: async () => [{ ...GROUP }],
        getSession: async (id) => {
            requested.push(id);
            if (String(id).startsWith("group:")) {
                const error = new Error("Not Found");
                error.status = 404;
                throw error;
            }
            return { sessionId: id, title: "S1", status: "idle", viewerGroupId: "g1" };
        },
        getSessionEvents: async () => [],
        subscribeSession: () => () => {},
    };
    const store = createStore(appReducer, createInitialState());
    const controller = new PilotSwarmUiController({ store, transport });

    await controller.refreshSessions();
    assert.equal(Boolean(store.getState().sessions.byId["group:g1"]), true, "the folder loaded");

    await controller.syncVisibleSessionDetails();

    assert.deepEqual(
        requested.filter((id) => String(id).startsWith("group:")),
        [],
        "a folder row must never be fetched as a session",
    );
    assert.equal(
        Boolean(store.getState().sessions.byId["group:g1"]),
        true,
        "the folder must survive the per-row detail sync",
    );

    // Belt and braces: even if some other path 404s a folder id, the eviction
    // must be refused — only sessions/groupsLoaded may remove a folder.
    controller.handleSessionGone("group:g1");
    assert.equal(
        Boolean(store.getState().sessions.byId["group:g1"]),
        true,
        "a 404 must not evict a folder row",
    );
});

