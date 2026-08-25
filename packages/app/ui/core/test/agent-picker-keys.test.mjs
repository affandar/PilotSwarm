/**
 * The agent picker's keys, after it became a flat searchable list.
 *
 * It used to be a collapsible tree, and both hosts bound left/right to open
 * and close its headings. There are no headings any more — every row is an
 * agent — so those bindings had to go, and this file pins that they DID: a
 * host that still swallows the arrows would stop the search box's caret from
 * moving, which is a bug you only notice by typing.
 *
 * The bindings live in two host key handlers — a real terminal and a real
 * keydown event, neither of which the reducer tests reach — so they are
 * pinned here at the source, alongside the hint text they have to agree with.
 *
 * Run: node --test test/agent-picker-keys.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { createStore } from "../src/store.js";
import { appReducer } from "../src/reducer.js";
import { createInitialState } from "../src/state.js";
import { PilotSwarmUiController } from "../src/controller.js";
import { selectStatusBar } from "../src/selectors.js";

const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const webApp = read("../../react/src/web-app.js");
const tuiApp = read("../../../tui/src/app.js");

function makeController(transportOverrides = {}) {
    const store = createStore(appReducer, createInitialState({ mode: "web" }));
    const controller = new PilotSwarmUiController({
        store,
        transport: {
            listSessions: async () => [],
            subscribeSession: () => () => {},
            getCurrentUserProfile: async () => ({ provider: "t", subject: "u", profileSettings: {} }),
            listCreatableAgents: async () => [
                { name: "alpha", title: "Alpha", source: "builtin" },
                { name: "beta", title: "Beta", source: "builtin" },
            ],
            getSessionCreationPolicy: () => ({ creation: { allowGeneric: true } }),
            ...transportOverrides,
        },
    });
    return { controller, store };
}

// ── the hosts must not hijack the arrows ────────────────────────────────────

test("neither host binds left/right for the agent picker any more", () => {
    assert.doesNotMatch(
        webApp,
        /modal\.type === "sessionAgentPicker" && \(event\.key === "ArrowRight"/,
        "the web host must leave the arrows to the search input's caret",
    );
    assert.doesNotMatch(
        tuiApp,
        /modal\.type === "sessionAgentPicker" && \(key\.leftArrow/,
        "the TUI host has nothing to open or close either",
    );
});

test("the controller's arrow hook refuses, so the keystroke keeps travelling", () => {
    const { controller } = makeController();
    // Returning false is the contract: a truthy answer would mark the key
    // handled and the search box would never see it.
    assert.equal(controller.moveAgentPickerSection(1), false);
    assert.equal(controller.moveAgentPickerSection(-1), false);
});

// ── the hint has to describe the keys that exist ────────────────────────────

test("the status bar names search, and no longer names open/close", async () => {
    const { controller, store } = makeController();
    await controller.openSessionAgentPicker();

    const hint = selectStatusBar(store.getState())?.right || "";
    assert.match(hint, /search/i, "search is the primary way through the list now");
    assert.match(hint, /enter start/, "every row is an agent, so Enter always starts one");
    assert.doesNotMatch(hint, /open\/close/, "there is nothing left to open or close");
    assert.doesNotMatch(hint, /←\/→/, "naming a key that does nothing is worse than naming none");
});

// ── up/down still move, and land on something startable ─────────────────────

test("up and down move the selection across the flat list", async () => {
    const { controller, store } = makeController();
    await controller.openSessionAgentPicker();

    const startIndex = store.getState().ui.modal.selectedIndex;
    controller.moveModalSelection(1);
    assert.equal(store.getState().ui.modal.selectedIndex, startIndex + 1);
    controller.moveModalSelection(-1);
    assert.equal(store.getState().ui.modal.selectedIndex, startIndex);
});

test("a search that matches nothing leaves an empty list, not a stale selection", async () => {
    const { controller, store } = makeController();
    await controller.openSessionAgentPicker();

    controller.setAgentPickerQuery("zzzznothing");
    const modal = store.getState().ui.modal;
    assert.equal(modal.items.length, 0);
    assert.equal(modal.selectedIndex, 0, "the cursor resets rather than pointing past the end");
});
