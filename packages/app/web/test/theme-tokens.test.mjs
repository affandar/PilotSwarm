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


// ── Dialog height on mobile ────────────────────────────────────────────
//
// Reported live from an iPhone: the Manage-session dialog was cut off at the
// bottom with its content unreachable. `.ps-modal` already had this fix and
// carries a comment explaining it — iOS Safari's toolbars eat 12-15vh, so a
// `vh` ceiling exceeds what is actually visible. The Manage dialog is a
// SEPARATE overlay (`.ps-share-*`) and never inherited it.
//
// The second half of the bug is subtler: these dialogs set `height`, not
// `max-height`, so a viewport clamp on `max-height` alone does nothing. A
// fixed-height flex child in a centred, padded overlay overflows BOTH ends,
// which is why the action row went off-screen with no way to scroll to it.

/** Every rule body for a selector, in source order. The stylesheet has several
 *  920px blocks and overrides that precede their base rule, so "first match"
 *  is the wrong rule as often as the right one. */
function rulesFor(selector) {
    const out = [];
    const needle = selector + " {";
    for (let i = css.indexOf(needle); i !== -1; i = css.indexOf(needle, i + 1)) {
        // Reject a longer selector that merely ENDS with this one
        // (".ps-modal" must not match ".ps-share-modal").
        const before = css[i - 1];
        if (before && /[\w.-]/.test(before)) continue;
        out.push({ index: i, body: css.slice(i, css.indexOf("}", i)) });
    }
    return out;
}

test("fixed-height dialogs are clamped to their overlay", () => {
    for (const selector of [".ps-share-modal", ".ps-modal.ps-admin-add"]) {
        const base = rulesFor(selector).find((r) => r.body.includes("width: min("));
        assert.ok(base, `${selector} base rule not found — renamed?`);
        assert.match(base.body, /height: min\(/, `${selector} sets a fixed height`);
        assert.match(
            base.body,
            /max-height: 100%/,
            `${selector} sets height (not max-height), so it must also clamp to the overlay or it overflows both ends`,
        );
    }
});

test("every dialog gets a small-viewport ceiling on phones, and it WINS", () => {
    // svh, not vh: vh is the LARGE viewport (browser chrome hidden), which is
    // exactly the measurement that is wrong while the toolbars are showing.
    //
    // The order half of this assertion is the one that matters. An earlier
    // version only checked the svh rule EXISTED, and passed against a build
    // where it was dead: media queries contribute no specificity, so a mobile
    // override written above a same-specificity base rule loses to it. The
    // stylesheet looked right and shipped a ceiling that never applied. The
    // bug was only visible in the built artifact.
    for (const selector of [".ps-modal", ".ps-share-modal"]) {
        const rules = rulesFor(selector);
        const capped = rules.filter((r) => /\d+svh/.test(r.body));
        assert.ok(capped.length > 0, `${selector} has no svh ceiling; a vh one is wrong on iOS`);

        const overridden = rules.filter((r) => /\d+vh[^a-z]/.test(r.body) && !/svh/.test(r.body));
        for (const base of overridden) {
            assert.ok(
                capped.some((c) => c.index > base.index),
                `${selector}: the svh ceiling is written BEFORE a vh rule of equal specificity, so it never applies`,
            );
        }
    }
});

test("the manage overlay respects the home-indicator inset", () => {
    const insetAware = rulesFor(".ps-share-overlay")
        .some((r) => /env\(safe-area-inset-bottom\)/.test(r.body));
    assert.ok(insetAware, "the indicator strip is not part of svh");
});


// ── Scroll-past-end room at the foot of the session list ───────────────
//
// At the bottom of a long list the last row sat flush against the detail box
// below it, which reads as "cut off" rather than "this is the end". The tail is
// PADDING, not a spacer element: padding grows the scrollable height, so the
// list scrolls into the space, whereas a spacer would always occupy it and
// steal a row from a short list.
//
// The trap this guards is the wrap variant, which overrides `padding-bottom`
// outright — omitting the tail there would drop the slack in that mode only,
// which is exactly the kind of thing nobody notices until they resize.

test("every session-list rule that sets padding-bottom includes the tail", () => {
    // Match the class as a whole token: a plain indexOf also hits
    // `.ps-session-list-button`, which is a different element with its own
    // padding and nothing to do with the tail.
    const rules = [];
    const head = /([^{}]*)\{([^{}]*)\}/g;
    for (let m = head.exec(css); m; m = head.exec(css)) {
        if (!/\.ps-session-list(?![\w-])/.test(m[1])) continue;
        rules.push(m[2]);
    }
    // The shorthand `padding: a b c` sets padding-bottom too, but it is the
    // BASE rule both variants override, so it is not required to carry the tail.
    const withPadding = rules.filter((body) => /padding-bottom:/.test(body));
    assert.ok(withPadding.length >= 3, `expected the desktop, wrap and mobile rules; found ${withPadding.length}`);
    for (const body of withPadding) {
        assert.match(
            body,
            /var\(--ps-list-tail\)/,
            "a session-list rule sets padding-bottom without the tail, so it silently has no end-of-scroll slack",
        );
    }
});

test("the tail is a token, and grows with the touch scale", () => {
    // Taller rows mean two rows of slack is more pixels; a fixed value would
    // read as cramped in Mobile mode.
    const base = css.match(/:root\s*{[^}]*--ps-list-tail:\s*(\d+)px/);
    const touch = css.match(/:root\[data-ps-touch="1"\]\s*{[^}]*--ps-list-tail:\s*(\d+)px/);
    assert.ok(base, "--ps-list-tail must be defined at :root");
    assert.ok(touch, "--ps-list-tail must be re-defined under the touch scale");
    assert.ok(
        Number(touch[1]) > Number(base[1]),
        `touch tail ${touch[1]}px should exceed base ${base[1]}px`,
    );
});
