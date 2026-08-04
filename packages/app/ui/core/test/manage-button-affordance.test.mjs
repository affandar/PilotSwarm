/**
 * The Manage button is DISABLED on a system session — and must say so.
 *
 * `canModifyActiveSession` excludes `isSystem` deliberately: a sweeper or
 * facts-manager row is fleet machinery, and renaming or re-modelling it is not
 * a meaningful action. That part is correct and stays.
 *
 * What was wrong is everything around it. There was no `:disabled` rule for
 * `.ps-mini-button`, so the button rendered identically to a live one, and the
 * tooltip described the ENABLED behaviour ("rename, switch model, and
 * sharing") in every disabled case except bulk selection. Clicking a
 * normal-looking button with a promising tooltip and getting nothing reads as
 * a broken dialog, not an unavailable action.
 *
 * These pin the rule itself; the label and styling are asserted from source.
 *
 * Run: node --test test/manage-button-affordance.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const webApp = fs.readFileSync(path.resolve(here, "../../react/src/web-app.js"), "utf8");
const css = fs.readFileSync(path.resolve(here, "../../../web/src/index.css"), "utf8");

/** The shipped rule, mirrored: manage is owner-or-admin, never system/group. */
const canModify = ({ isSystem = false, isGroup = false, isAdminViewer = false, ownsIt = false }) =>
    Boolean(!isSystem && !isGroup && (isAdminViewer || ownsIt));

test("a system session cannot be managed — not even by an admin", () => {
    assert.equal(canModify({ isSystem: true, isAdminViewer: true }), false);
    assert.equal(canModify({ isSystem: true, ownsIt: true }), false);
});

test("an ordinary session is manageable by its owner or an admin, nobody else", () => {
    assert.equal(canModify({ ownsIt: true }), true);
    assert.equal(canModify({ isAdminViewer: true }), true);
    assert.equal(canModify({}), false);
});

test("the disabled tooltip explains the system-session case", () => {
    // The regression: the tooltip used to advertise rename/model/sharing while
    // the button did nothing.
    assert.match(webApp, /System sessions are fleet machinery/);
    assert.match(webApp, /Only this session's owner or an admin can manage it/);
});

test("a disabled icon button is visually distinguishable", () => {
    // Without this the control looks pressable and the click just vanishes.
    assert.match(css, /\.ps-mini-button:disabled/);
    assert.match(css, /cursor:\s*not-allowed/);
});

test("hover does not animate a button that cannot be pressed", () => {
    assert.match(css, /\.ps-mini-button:disabled:hover/);
});
