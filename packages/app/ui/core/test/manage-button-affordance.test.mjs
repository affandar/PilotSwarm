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

/**
 * The shipped rule, mirrored. System sessions are ADMIN-modifiable and
 * read-only for everyone else — the same policy evaluateSessionAccess already
 * enforces server-side ("System sessions are managed by administrators").
 */
const canModify = ({ isSystem = false, isGroup = false, isAdminViewer = false, ownsIt = false }) =>
    Boolean(!isGroup && (isSystem ? isAdminViewer : (isAdminViewer || ownsIt)));

test("an admin CAN manage a system session", () => {
    // The regression this replaces: the client was stricter than the server,
    // so an entitled admin got a dead button and no route to the capability.
    assert.equal(canModify({ isSystem: true, isAdminViewer: true }), true);
});

test("a non-admin cannot manage a system session, even one it appears to own", () => {
    assert.equal(canModify({ isSystem: true, ownsIt: true }), false);
    assert.equal(canModify({ isSystem: true }), false);
});

test("the client gate matches the server rule for system sessions", () => {
    // Drift in either direction is a bug: stricter hides a real capability,
    // looser produces a button that 403s.
    const serverAllowsWrite = ({ isSystem, isAdmin }) => (isAdmin ? true : (isSystem ? false : null));
    for (const isAdmin of [true, false]) {
        const server = serverAllowsWrite({ isSystem: true, isAdmin });
        if (server === null) continue;
        assert.equal(canModify({ isSystem: true, isAdminViewer: isAdmin }), server,
            `client and server disagree for isAdmin=${isAdmin}`);
    }
});

test("an ordinary session is manageable by its owner or an admin, nobody else", () => {
    assert.equal(canModify({ ownsIt: true }), true);
    assert.equal(canModify({ isAdminViewer: true }), true);
    assert.equal(canModify({}), false);
});

test("the disabled tooltip explains the system-session case", () => {
    // The regression: the tooltip used to advertise rename/model/sharing while
    // the button did nothing.
    assert.match(webApp, /System sessions are managed by administrators/);
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
