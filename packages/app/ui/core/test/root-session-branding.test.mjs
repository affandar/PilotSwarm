// The root system session is named after the deployment's branding.
//
// WHY: `canonicalSystemTitle` maps agentId "pilotswarm" to the branding title,
// so on WALDEMORT the root row must read "Waldemort". Two things went wrong at
// once and the second hid behind the first:
//
//   1. the portal built a SYNTHETIC state for selectSessionRows that omitted
//      `branding`, so its rows fell back to the literal "PilotSwarm" while the
//      controller's own calls (real state) produced the branded name;
//   2. per-row memoization keyed on `sessions.flat` — shared by both callers —
//      with deps that omitted branding, so a row built by one caller was served
//      to the other and the root session's name FLIPPED between the two.
import test from "node:test";
import assert from "node:assert/strict";
import { selectSessionRows } from "../src/index.js";

const ROOT = {
    sessionId: "11111111-1111-1111-1111-111111111111",
    title: "PilotSwarm",
    agentId: "pilotswarm",
    isSystem: true,
    status: "idle",
};

const FLAT = [{ sessionId: ROOT.sessionId, depth: 0, hasChildren: false, collapsed: false }];
// Every memo dependency except branding must be referentially STABLE across
// calls, or the cache misses on something else and the test proves nothing.
const BY_ID = { [ROOT.sessionId]: ROOT };
const OWNER_FILTER = { all: true };
const AUTH = {};
const PINNED = [];
const SELECTED = [];

function stateWith(brandingTitle) {
    return {
        branding: brandingTitle ? { title: brandingTitle } : undefined,
        sessions: {
            activeSessionId: null,
            byId: BY_ID,
            // Same array identity across calls: this is what the row memo keys on,
            // and what let one caller's result leak into another's.
            flat: FLAT,
            filterQuery: "",
            ownerFilter: OWNER_FILTER,
            pinnedIds: PINNED,
            selectedIds: SELECTED,
            selectMode: false,
        },
        auth: AUTH,
        connection: { mode: "remote" },
    };
}

const titleOf = (rows) => rows[0].text;

test("the root system row is named after the branding title", () => {
    const rows = selectSessionRows(stateWith("Waldemort"));
    assert.match(titleOf(rows), /Waldemort/, "root row should carry the deployment branding");
});

test("branding changes are not masked by the row memo", () => {
    // Interleave the two callers over the SAME flat array, exactly as the
    // portal and the controller do. Each must get its own branding back.
    const branded = titleOf(selectSessionRows(stateWith("Waldemort")));
    const unbranded = titleOf(selectSessionRows(stateWith(null)));
    const brandedAgain = titleOf(selectSessionRows(stateWith("Waldemort")));

    assert.match(branded, /Waldemort/);
    assert.match(unbranded, /PilotSwarm/, "no branding should fall back to PilotSwarm");
    assert.match(brandedAgain, /Waldemort/, "the memo served a stale branding — the flip is back");
});
