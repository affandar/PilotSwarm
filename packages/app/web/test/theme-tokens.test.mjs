// Every --ps-* custom property the stylesheet READS must actually be
// published by something.
//
// WHY THIS EXISTS: the Workers pane referenced --ps-muted-foreground, which
// nothing has ever defined. `var(--ps-muted-foreground, #8b949e)` therefore
// resolved to a hardcoded GitHub grey in EVERY theme, so that pane quietly
// ignored the palette. Worse, the sequence pane's rules used --ps-text and
// --ps-text-muted with NO fallback: an undefined custom property makes the
// declaration invalid at computed-value time, so those rules did nothing at
// all. Both failures are invisible — no console warning, no broken layout,
// just colours that are subtly not the theme's.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CSS = path.resolve(__dirname, "../src/index.css");
// Where a token can legitimately come from, other than the stylesheet itself.
const JS_SOURCES = [
    path.resolve(__dirname, "../../ui/react/src/web-app.js"),
    path.resolve(__dirname, "../src/App.jsx"),
];

const css = fs.readFileSync(CSS, "utf8");
const js = JS_SOURCES.map((file) => fs.readFileSync(file, "utf8")).join("\n");

// Defined in the stylesheet: `--ps-x:` anywhere (:root, a theme block, or a
// rule that scopes it to a subtree).
const definedInCss = new Set([...css.matchAll(/(--ps-[a-z0-9-]+)\s*:/g)].map((m) => m[1]));
// Published from JS: setProperty("--ps-x", …) or an inline style key.
const publishedFromJs = new Set([
    ...[...js.matchAll(/setProperty\(\s*["'](--ps-[a-z0-9-]+)["']/g)].map((m) => m[1]),
    ...[...js.matchAll(/["'](--ps-[a-z0-9-]+)["']\s*:/g)].map((m) => m[1]),
]);

// Referenced, with whether the reference carries its own fallback.
const references = [...css.matchAll(/var\(\s*(--ps-[a-z0-9-]+)\s*(,?)/g)]
    .map((match) => ({ name: match[1], hasFallback: match[2] === "," }));

test("every --ps-* token the stylesheet reads is published somewhere", () => {
    const unresolved = [...new Set(
        references
            .filter((ref) => !definedInCss.has(ref.name) && !publishedFromJs.has(ref.name) && !ref.hasFallback)
            .map((ref) => ref.name),
    )];
    assert.deepEqual(unresolved, [], `unresolvable token(s): ${unresolved.join(", ")}`);
});

test("a fallback is not a licence to invent a token name", () => {
    // A fallback keeps the rule VALID, so an undefined name fails silently
    // rather than loudly: the hardcoded fallback wins in every theme, which
    // is exactly how the Workers pane came to ignore the palette. Fallbacks
    // are for tokens that exist and are optionally overridden.
    const inventedWithFallback = [...new Set(
        references
            .filter((ref) => ref.hasFallback && !definedInCss.has(ref.name) && !publishedFromJs.has(ref.name))
            .map((ref) => ref.name),
    )];
    assert.deepEqual(inventedWithFallback, [],
        `token(s) that only ever resolve to their hardcoded fallback: ${inventedWithFallback.join(", ")}`);
});

test("the semantic status colours come from the theme palette", () => {
    // These four are the palette bridge: the terminal rows read theme.tui.green
    // through resolveColor(), and the DOM chrome must read the same value or
    // the two halves of the same screen disagree about what "ready" looks like.
    for (const token of ["--ps-accent", "--ps-success", "--ps-warning", "--ps-danger"]) {
        assert.ok(publishedFromJs.has(token), `${token} must be published from the active theme`);
    }
});
