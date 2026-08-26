/**
 * A failed provider change must not leave a banner behind.
 *
 * The Model Providers pane renders `mutation.error` as a red band. Nothing
 * cleared it except the NEXT mutation, so cancelling a failed sheet left the
 * band sitting over an unchanged list until something else happened to
 * succeed — and while the sheet was open the SAME text was printed twice at
 * once, in the sheet and in the pane behind it.
 *
 * Pre-existing, and reachable from Add as well as Update: the sheet is just
 * the third door into it.
 *
 * Run: node --test test/admin-provider-error-dismiss.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { appReducer } from "../src/reducer.js";
import { createInitialState } from "../src/state.js";

const webApp = readFileSync(fileURLToPath(new URL("../../react/src/web-app.js", import.meta.url)), "utf8");

const failed = () => appReducer(
    createInitialState({ mode: "web" }),
    { type: "admin/modelProviders/mutationFailed", error: "the change was refused" },
);

test("a failed mutation records the error", () => {
    assert.equal(failed().admin.modelProviders.mutation.error, "the change was refused");
});

test("dismissing clears it", () => {
    const cleared = appReducer(failed(), { type: "admin/modelProviders/mutationDismissed" });
    assert.equal(cleared.admin.modelProviders.mutation.error, null);
});

test("dismissing with nothing to dismiss keeps the same object", () => {
    // A no-op that returned a new object would re-render every subscriber on
    // each sheet open and close.
    const clean = createInitialState({ mode: "web" });
    assert.equal(appReducer(clean, { type: "admin/modelProviders/mutationDismissed" }), clean);
});

test("dismissing does not disturb a pending mutation's other fields", () => {
    const pending = appReducer(
        createInitialState({ mode: "web" }),
        { type: "admin/modelProviders/mutationPending", pending: "update" },
    );
    const after = appReducer(pending, { type: "admin/modelProviders/mutationDismissed" });
    // Nothing to clear, so it is the same state — the pending marker survives
    // by construction rather than by being copied carefully.
    assert.equal(after, pending);
    assert.equal(after.admin.modelProviders.mutation.pending, "update");
});

test("the sheet's open and close paths both dismiss", () => {
    // Close is the reported bug. Open matters too: a banner from a previous
    // abandoned attempt must not greet the next one.
    const close = webApp.slice(webApp.indexOf("const closeProviderSheet = React.useCallback("));
    assert.match(
        close.slice(0, close.indexOf("}, [")),
        /dismissAdminModelProviderMutationError\(\)/,
        "closing a sheet must drop the banner it raised",
    );
    const openers = webApp.slice(webApp.indexOf("onAddPersonal:"), webApp.indexOf("onUpdatePersonal:") + 400);
    const dismissals = (openers.match(/dismissAdminModelProviderMutationError\(\)/g) || []).length;
    assert.equal(dismissals, 3, "all three sheet openers (add personal, add shared, update) must start clean");
});

test("the pane stays quiet about a mutation while the sheet is showing it", () => {
    assert.match(webApp, /sheetOpen: Boolean\(providerSheet\)/, "the section has to be told");
    assert.match(
        webApp,
        /providers\.error \|\| \(providers\.mutation\?\.error && !sheetOpen\)/,
        "a mutation error is suppressed while its sheet is up — but a LOAD error is not, that is the pane's own",
    );
});

test("editing a field clears the sheet's stale message", () => {
    assert.match(webApp, /onDirty: \(\) => setProviderSheetError\(null\)/, "the parent must supply it");
    const sheet = webApp.slice(webApp.indexOf("function CreateProviderSheet("));
    const body = sheet.slice(0, sheet.indexOf("\nfunction "));
    const wired = (body.match(/onDirty\?\.\(\)/g) || []).length;
    assert.equal(wired, 3, "name, type and credential must all answer the error");
});
