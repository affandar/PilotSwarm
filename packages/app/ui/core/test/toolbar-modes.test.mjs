/**
 * One MODE at a time: Workspace, Budget or the Admin Console.
 *
 * `ui.budgetOpen` and `admin.visible` are independent flags, and they used to
 * be independently true — Budget could open behind an open Admin Console and
 * the toolbar lit both as active. The controller now closes one when the
 * other opens, and offers the Workspace as a destination of its own.
 *
 * Run: node --test ui/core/test/toolbar-modes.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";

import { PilotSwarmUiController } from "../src/controller.js";
import { appReducer } from "../src/reducer.js";
import { createInitialState } from "../src/state.js";
import { createStore } from "../src/store.js";
import { UI_COMMANDS } from "../src/commands.js";

function makeController() {
    const store = createStore(appReducer, createInitialState({ mode: "web" }));
    // A transport with nothing on it: every load the modes trigger fails
    // softly (the controller records loadFailed and moves on), which is all
    // this test needs — it is about the two flags, not the data behind them.
    const controller = new PilotSwarmUiController({ store, transport: {} });
    return { store, controller };
}

const flags = (store) => ({
    budget: Boolean(store.getState().ui.budgetOpen),
    admin: Boolean(store.getState().admin?.visible),
});

test("opening the Admin Console closes Budget, and the other way round", async () => {
    const { store, controller } = makeController();
    assert.equal(controller.currentMode(), "workspace");

    await controller.openBudget().catch(() => {});
    assert.deepEqual(flags(store), { budget: true, admin: false });
    assert.equal(controller.currentMode(), "budget");

    await controller.openAdminConsole().catch(() => {});
    assert.deepEqual(flags(store), { budget: false, admin: true }, "Budget must close when Admin opens");
    assert.equal(controller.currentMode(), "admin");

    await controller.openBudget().catch(() => {});
    assert.deepEqual(flags(store), { budget: true, admin: false }, "Admin must close when Budget opens");
});

test("OPEN_WORKSPACE is the way back from either mode", async () => {
    const { store, controller } = makeController();
    await controller.openAdminConsole().catch(() => {});
    await controller.handleCommand(UI_COMMANDS.OPEN_WORKSPACE);
    assert.deepEqual(flags(store), { budget: false, admin: false });
    assert.equal(controller.currentMode(), "workspace");

    await controller.openBudget().catch(() => {});
    await controller.handleCommand(UI_COMMANDS.OPEN_WORKSPACE);
    assert.deepEqual(flags(store), { budget: false, admin: false });
});
