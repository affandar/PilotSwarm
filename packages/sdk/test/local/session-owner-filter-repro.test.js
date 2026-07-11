/**
 * Session owner-filter behavior.
 *
 * Part 1 (repro) — the default -> pick-owner -> All -> back transitions the
 * user reported. The pure controller/selector logic is correct across all
 * three; the live-app symptoms live in the React/profile-sync layer (covered by
 * the fixes in web-app.js: principal-derived default fallback) and in the
 * frozen modal snapshot (Part 3 below).
 *
 * Part 2 — a single "System" bucket. System-agent children inherit the System
 * USER as owner (not is_system, so they stay deletable). They must fold into
 * the one static "System" entry, never mint a duplicate "System" owner bucket.
 *
 * Part 3 — the open filter modal tracks the live session set (its item list is
 * snapshotted into modal.items for keyboard nav, but the periodic refresh
 * rebuilds it in place).
 */
import { describe, it } from "vitest";
import { PilotSwarmUiController, defaultOwnerFilterForPrincipal } from "../../../app/ui/core/src/controller.js";
import { appReducer } from "../../../app/ui/core/src/reducer.js";
import { selectSessionRows } from "../../../app/ui/core/src/selectors.js";
import { createInitialState } from "../../../app/ui/core/src/state.js";
import { createStore } from "../../../app/ui/core/src/store.js";
import { assert, assertEqual } from "../helpers/assertions.js";

const AFFAN = { provider: "entra", subject: "e8677004", email: "daraffan@microsoft.com", displayName: "Affan Dar" };
const BERTAN = { provider: "entra", subject: "1ec5caaa", email: "bertanari@microsoft.com", displayName: "Bertan Ari" };
const SYSTEM_OWNER = { provider: "system", subject: "system", email: null, displayName: "System" };
const SYSTEM_OWNER_KEY = "systemsystem";

const DEFAULT_FILTER = { all: false, includeSystem: true, includeUnowned: false, includeMe: true, ownerKeys: [] };

function makeController(transportOverrides = {}) {
    const store = createStore(appReducer, createInitialState({ mode: "web" }));
    const controller = new PilotSwarmUiController({
        store,
        transport: {
            start: async () => {}, stop: async () => {}, listSessions: async () => [],
            getSessionEvents: async () => [], subscribeSession: () => () => {}, ...transportOverrides,
        },
    });
    store.dispatch({ type: "auth/context", principal: AFFAN, authorization: { allowed: true, role: "admin" } });
    return { store, controller };
}

function loadSessions(store, sessions) {
    store.dispatch({ type: "sessions/loaded", sessions });
}

function setup(extra = []) {
    const { store, controller } = makeController();
    loadSessions(store, [
        { sessionId: "aaaa1111-0000-4000-8000-000000000001", title: "Affan session 1", status: "idle", owner: AFFAN, createdAt: 5, updatedAt: 50 },
        { sessionId: "aaaa2222-0000-4000-8000-000000000002", title: "Affan session 2", status: "idle", owner: AFFAN, createdAt: 4, updatedAt: 40 },
        { sessionId: "bbbb1111-0000-4000-8000-000000000003", title: "Bertan session", status: "idle", owner: BERTAN, createdAt: 3, updatedAt: 30 },
        { sessionId: "5y5aaaaa-0000-4000-8000-000000000004", title: "Facts Manager", status: "idle", isSystem: true, createdAt: 2, updatedAt: 20 },
        ...extra,
    ]);
    return { store, controller };
}

const ids = (store) => selectSessionRows(store.getState()).map((r) => r.sessionId.slice(0, 4)).sort();
const modalItems = (store) => store.getState().ui.modal?.items || [];
const ownerBuckets = (store) => modalItems(store).filter((i) => i.kind === "owner");
const systemLabelled = (store) => modalItems(store).filter((i) => (i.label || "") === "System");

// ── Part 1: the reported transitions ──────────────────────────────────

describe("owner filter behavior repro", () => {
    it("default filter (authed) shows my sessions + system, not others", () => {
        const { store } = setup();
        store.dispatch({ type: "sessions/ownerFilter", filter: DEFAULT_FILTER });
        assert(ids(store).includes("aaaa"), "my sessions visible by default");
        assert(ids(store).includes("5y5a"), "system visible by default");
        assert(!ids(store).includes("bbbb"), "others NOT visible by default");
    });

    it("picking Bertan from the default surfaces Bertan (the reported failure)", () => {
        const { store, controller } = setup();
        store.dispatch({ type: "sessions/ownerFilter", filter: DEFAULT_FILTER });
        controller.openSessionOwnerFilter();
        const bertanIndex = modalItems(store).findIndex((i) => i.kind === "owner" && /bertan/i.test(i.label || ""));
        assert(bertanIndex >= 0, "Bertan owner item exists in the filter modal");
        controller.toggleSessionOwnerFilter(bertanIndex);
        assert(ids(store).includes("bbbb"), "Bertan's session becomes visible after picking Bertan");
    });

    it("All then back to Bertan is consistent with picking Bertan directly", () => {
        const { store, controller } = setup();
        store.dispatch({ type: "sessions/ownerFilter", filter: DEFAULT_FILTER });
        controller.openSessionOwnerFilter();
        const allIndex = modalItems(store).findIndex((i) => i.kind === "all");
        controller.toggleSessionOwnerFilter(allIndex);
        assertEqual(ids(store).length, 4, "All shows every session");
        const bertanIndex = modalItems(store).findIndex((i) => i.kind === "owner" && /bertan/i.test(i.label || ""));
        controller.toggleSessionOwnerFilter(bertanIndex);
        assert(ids(store).includes("bbbb"), "Bertan visible after All->Bertan");
    });

    it("defaultOwnerFilterForPrincipal is Me+System for a user, All for anon", () => {
        const authed = defaultOwnerFilterForPrincipal(AFFAN);
        assertEqual(authed.all, false, "authed default is narrowed");
        assertEqual(authed.includeMe, true, "authed default includes me");
        assertEqual(authed.includeSystem, true, "authed default includes system");
        const anon = defaultOwnerFilterForPrincipal(null);
        assertEqual(anon.all, true, "anonymous default is All");
    });
});

// ── Part 2: one "System" bucket, covering system-owned children ────────

const FACTS_MANAGER_ID = "5y5aaaaa-0000-4000-8000-000000000004";
const SYSTEM_CHILD = {
    sessionId: "5c1d0000-0000-4000-8000-00000000000c",
    title: "helper spawned by Facts Manager",
    status: "idle",
    owner: SYSTEM_OWNER,
    isSystem: false,
    parentSessionId: FACTS_MANAGER_ID,
    createdAt: 1,
    updatedAt: 10,
};

// System session subtrees are auto-collapsed by default; expand so the child is
// in the flat list and the ONLY thing deciding its visibility is the owner
// filter (not the tree-collapse, which is orthogonal to this behavior).
function expandFacts(store) {
    store.dispatch({ type: "sessions/expand", sessionId: FACTS_MANAGER_ID });
}

describe("owner filter: unified System bucket", () => {
    it("shows exactly one 'System' entry even with a System-owned child present", () => {
        const { store, controller } = setup([SYSTEM_CHILD]);
        controller.openSessionOwnerFilter();
        assertEqual(systemLabelled(store).length, 1, "exactly one item labelled 'System'");
        assert(
            !ownerBuckets(store).some((i) => i.ownerKey === SYSTEM_OWNER_KEY),
            "no duplicate 'owner' bucket for the System user",
        );
        // The one System entry is the static system kind, not an owner bucket.
        assertEqual(systemLabelled(store)[0].kind, "system", "the System entry is the static system filter");
    });

    it("includeSystem matches BOTH is_system agents and System-owned children", () => {
        const { store } = setup([SYSTEM_CHILD]);
        expandFacts(store);
        store.dispatch({ type: "sessions/ownerFilter", filter: DEFAULT_FILTER });
        const visible = ids(store);
        assert(visible.includes("5y5a"), "the is_system Facts Manager shows under System");
        assert(visible.includes("5c1d"), "the System-owned child shows under System too");
    });

    it("the System-owned child is hidden when System is unchecked", () => {
        const { store } = setup([SYSTEM_CHILD]);
        expandFacts(store);
        store.dispatch({
            type: "sessions/ownerFilter",
            filter: { all: false, includeSystem: false, includeUnowned: false, includeMe: true, ownerKeys: [] },
        });
        const visible = ids(store);
        assert(!visible.includes("5c1d"), "System-owned child hidden without includeSystem");
        assert(!visible.includes("5y5a"), "is_system agent hidden without includeSystem");
        assert(visible.includes("aaaa"), "my own sessions still visible");
    });

    it("a System-owned child never counts as 'Me' or as an 'Unowned' session", () => {
        const { store } = setup([SYSTEM_CHILD]);
        expandFacts(store);
        // Me + Unowned (no system): the child must NOT leak in via either.
        store.dispatch({
            type: "sessions/ownerFilter",
            filter: { all: false, includeSystem: false, includeUnowned: true, includeMe: true, ownerKeys: [] },
        });
        assert(!ids(store).includes("5c1d"), "System-owned child is not Me and not Unowned");
    });
});

// ── Part 3: the open modal tracks the live session set ─────────────────

describe("owner filter modal stays live while open", () => {
    it("rebuilds its entry list when a new owner arrives during a refresh", () => {
        const { store, controller } = setup();
        controller.openSessionOwnerFilter();
        const before = ownerBuckets(store).map((i) => i.label);
        assert(!before.some((l) => /carol/i.test(l)), "Carol not present before her session loads");

        // Simulate the periodic catalog refresh bringing in a new owner's
        // session, then the refresh hook rebuilding the open modal in place.
        const CAROL = { provider: "entra", subject: "c0000001", email: "carol@x.com", displayName: "Carol" };
        loadSessions(store, [
            ...Object.values(store.getState().sessions.byId).filter((s) => !s.isGroup),
            { sessionId: "ca101111-0000-4000-8000-0000000000ca", title: "Carol session", status: "idle", owner: CAROL, createdAt: 6, updatedAt: 60 },
        ]);
        controller.refreshOpenSessionOwnerFilterModal();

        const after = ownerBuckets(store).map((i) => i.label);
        assert(after.some((l) => /carol/i.test(l)), "Carol's owner bucket appears without reopening the modal");
    });

    it("preserves the highlighted row (by id) across a rebuild", () => {
        const { store, controller } = setup();
        controller.openSessionOwnerFilter();
        // Highlight Bertan's bucket.
        const bertanIndex = modalItems(store).findIndex((i) => i.kind === "owner" && /bertan/i.test(i.label || ""));
        assert(bertanIndex >= 0, "Bertan present");
        store.dispatch({ type: "ui/modalSelection", index: bertanIndex });
        const highlightedId = modalItems(store)[bertanIndex].id;

        // A new owner arrives ABOVE Bertan (sorts by display name: Carol < Bertan? no —
        // 'Bertan' < 'Carol', so add 'Aaron' to shift Bertan's index).
        const AARON = { provider: "entra", subject: "a0000001", email: "aaron@x.com", displayName: "Aaron" };
        loadSessions(store, [
            ...Object.values(store.getState().sessions.byId).filter((s) => !s.isGroup),
            { sessionId: "aa701111-0000-4000-8000-0000000000a7", title: "Aaron session", status: "idle", owner: AARON, createdAt: 7, updatedAt: 70 },
        ]);
        controller.refreshOpenSessionOwnerFilterModal();

        const newIndex = store.getState().ui.modal.selectedIndex;
        assertEqual(modalItems(store)[newIndex].id, highlightedId, "selection follows Bertan to its new index");
    });
});
