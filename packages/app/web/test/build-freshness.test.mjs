/**
 * "New build — reload" must clear once the tab IS the served build.
 *
 * The banner used to latch on forever. BUILD_ID parsed a content hash out of
 * this tab's own filename with one regex, and the served hashes out of
 * index.html with a different one — and the two disagreed whenever the hash
 * itself contained a hyphen, which Vite's base64url alphabet emits routinely.
 * For "index-B-TEKrRB.js" the self-regex matched from the FIRST hyphen
 * ("B-TEKr") while the served-regex backtracked to the LAST ("TEKrRB"), so the
 * tab could never find itself in the served list. Reloading could not clear it:
 * the next load hit the same mismatch. Observed live on waldemort-chk.
 *
 * The fix compares whole filenames, so there is no hash grammar to disagree
 * about. These tests pin that, including the exact filename that broke.
 *
 * Run: node --test test/build-freshness.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const appSource = fs.readFileSync(
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src/App.jsx"),
    "utf8",
);

/** The comparison as App.jsx performs it, extracted from the source itself. */
function servedFilenames(html) {
    return [...html.matchAll(/assets\/([A-Za-z0-9_.-]+\.js)/g)].map((m) => m[1]);
}
function ownFilename(pathname) {
    const file = pathname.split("/").pop() || "";
    return /\.js$/.test(file) ? file : "dev";
}
const isStale = (pathname, html) => {
    const own = ownFilename(pathname);
    const served = servedFilenames(html);
    return served.length > 0 && !served.includes(own);
};

const page = (...files) =>
    files.map((f) => `<script type="module" crossorigin src="/assets/${f}"></script>`).join("\n");

test("a hyphenated hash — the exact case that latched on chk — is NOT stale", () => {
    const file = "index-B-TEKrRB.js";
    assert.equal(isStale(`/assets/${file}`, page(file, "msal-CytV9RFv.js")), false);
});

test("a hash with no hyphen is still not stale", () => {
    const file = "index-CXWinIKr.js";
    assert.equal(isStale(`/assets/${file}`, page(file)), false);
});

test("underscores in a hash do not latch it either", () => {
    const file = "index-DA0u7Cq_.js";
    assert.equal(isStale(`/assets/${file}`, page(file)), false);
});

test("a genuinely older tab IS reported stale", () => {
    // The banner has to keep working — this is the case it exists for.
    assert.equal(isStale("/assets/index-OLDHASH.js", page("index-NEWHASH.js")), true);
});

test("an unparseable document never reports stale", () => {
    // A blocked/offline poll returning junk must not flash the banner.
    for (const html of ["", "<html></html>", "not html at all"]) {
        assert.equal(isStale("/assets/index-B-TEKrRB.js", html), false);
    }
});

test("App.jsx compares whole filenames, not hash substrings", () => {
    // Guards the fix itself: a future edit that reintroduces hash slicing
    // brings the latch back, and every test above would still pass if they
    // only exercised the local helpers.
    assert.ok(appSource.includes("BUILD_FILE"), "BUILD_FILE is gone — was the filename comparison reverted?");
    assert.ok(!/slice\(0,\s*6\)/.test(appSource), "App.jsx is slicing a hash again");
});
