// The "Hide page chrome" share option: `show_chrome=false`.
//
// Three things have to hold for the feature to work, and each fails silently in
// a different way, so each is pinned here:
//   1. the parameter is read, and ONLY the explicit "false" opts in;
//   2. it survives the sign-in stash — otherwise it works for the sender and
//      not for the recipient, who is the entire audience for a share link;
//   3. the strip names the deployment through the same helper the real header
//      uses, so a rebranded portal cannot end up calling itself "PilotSwarm".
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
    DEEP_LINK_SESSION_STORAGE_KEY,
    parseStashedDeepLinkTarget,
    readDeepLinkTargetFromUrl,
    writeShowChromeParam,
} from "../src/lib/deep-link.js";

const APP = readFileSync(fileURLToPath(new URL("../src/App.jsx", import.meta.url)), "utf8");
const WEB_APP = readFileSync(fileURLToPath(new URL(
    "../../ui/react/src/web-app.js", import.meta.url)), "utf8");
const CSS = readFileSync(fileURLToPath(new URL("../src/index.css", import.meta.url)), "utf8");

/** Drive the real parser against a URL by standing in for `window`. */
function targetFor(search) {
    const previous = globalThis.window;
    globalThis.window = { location: { search } };
    try {
        return readDeepLinkTargetFromUrl();
    } finally {
        if (previous === undefined) delete globalThis.window;
        else globalThis.window = previous;
    }
}

/** Drive the URL rewrite against a fake history, returning what it replaced. */
function rewriteFrom(href, show, { history } = {}) {
    const previous = globalThis.window;
    const calls = [];
    globalThis.window = {
        location: { href },
        history: history === null ? {} : {
            state: { some: "state" },
            replaceState: (state, title, url) => calls.push({ state, title, url }),
        },
    };
    try {
        const returned = writeShowChromeParam(show);
        return { calls, returned };
    } finally {
        if (previous === undefined) delete globalThis.window;
        else globalThis.window = previous;
    }
}

// ─── 1. Reading the parameter ───────────────────────────────────────────────

test("only the explicit show_chrome=false hides the chrome", () => {
    assert.equal(targetFor("?session=s1&show_chrome=false").hideChrome, true);

    // Everything else keeps the header. The absent case is the one that
    // matters most: every link written before this parameter existed must go on
    // behaving exactly as it did, which is also what makes the checkbox's
    // "default unchecked" real.
    assert.equal(targetFor("?session=s1").hideChrome, false, "absent → chrome stays");
    assert.equal(targetFor("?session=s1&show_chrome=true").hideChrome, false, "true → chrome stays");
    assert.equal(targetFor("?session=s1&show_chrome=0").hideChrome, false, "0 is not false");
    assert.equal(targetFor("?session=s1&show_chrome=False").hideChrome, false, "not case-folded");
    assert.equal(targetFor("?session=s1&show_chrome=").hideChrome, false, "empty → chrome stays");
});

test("show_chrome rides alongside the rest of the canvas share link", () => {
    // The exact shape CanvasShareDialog emits with the box checked.
    const target = targetFor("?session=abc&view=canvas&slot=1&max=1&show_chrome=false");
    assert.deepEqual(target, {
        sessionId: "abc",
        artifact: null,
        fullscreen: false,
        canvas: true,
        max: true,
        slot: 1,
        hideChrome: true,
    });
});

// ─── 1b. The slot the link always carried but nobody read ───────────────────
// The dialog has always emitted &slot=<n>; the parser ignored it, so a link to
// a session's SECOND canvas opened its first. That is worse with show_chrome,
// where the wrong canvas fills the whole page with no chrome to correct it by.

test("the link's slot is read, so a second canvas opens as itself", () => {
    assert.equal(targetFor("?session=s1&view=canvas&slot=2&max=1").slot, 2);
    assert.equal(targetFor("?session=s1&view=canvas&slot=5").slot, 5);
});

test("a missing or unparseable slot stays null and defers to the reducer", () => {
    // Deliberately not normalized here: canvas/flip already clamps to 1..5 and
    // falls back to slot 1, so these land exactly where they always did rather
    // than growing a second, disagreeing clamp.
    assert.equal(targetFor("?session=s1&view=canvas").slot, null, "absent");
    assert.equal(targetFor("?session=s1&view=canvas&slot=").slot, null, "empty");
    assert.equal(targetFor("?session=s1&view=canvas&slot=abc").slot, null, "not a number");
    assert.equal(targetFor("?session=s1&view=canvas&slot=1.5").slot, null, "not an integer");
});

test("the slot survives the sign-in stash too", () => {
    const stashed = JSON.stringify(targetFor("?session=s1&view=canvas&slot=3&show_chrome=false"));
    const restored = parseStashedDeepLinkTarget(stashed);
    assert.equal(restored.slot, 3);
    assert.equal(restored.hideChrome, true);
});

test("the canvas flip is handed the link's slot", () => {
    const workspace = APP.slice(APP.indexOf("function PortalWorkspace"));
    assert.match(workspace, /type: "canvas\/flip",[\s\S]{0,400}?slot: deepLinkTarget\?\.slot/,
        "the parsed slot actually reaches the dispatch");
});

test("show_chrome alone does not conjure a target", () => {
    assert.equal(targetFor("?show_chrome=false"), null, "no session id, no deep link");
});

// ─── 2. Surviving the redirect sign-in ──────────────────────────────────────

test("hideChrome round-trips through the sign-in stash", () => {
    // A signed-out recipient is stashed to sessionStorage and restored after
    // the redirect. If this field were dropped the mode would work only for
    // people who were already signed in.
    const stashed = JSON.stringify(targetFor("?session=s1&view=canvas&max=1&show_chrome=false"));
    const restored = parseStashedDeepLinkTarget(stashed);
    assert.equal(restored.hideChrome, true);
    assert.equal(restored.canvas, true);
    assert.equal(restored.sessionId, "s1");
});

test("a stash without the field restores as chrome-visible, never undefined", () => {
    const restored = parseStashedDeepLinkTarget(JSON.stringify({ sessionId: "s1" }));
    assert.equal(restored.hideChrome, false);

    // The pre-upgrade bare-string stash still resolves rather than throwing.
    assert.equal(parseStashedDeepLinkTarget("s1").sessionId, "s1");
    assert.equal(parseStashedDeepLinkTarget(""), null);
    assert.equal(parseStashedDeepLinkTarget("{not json"), null);
});

test("the stash key is unchanged, so an in-flight sign-in still lands", () => {
    assert.equal(DEEP_LINK_SESSION_STORAGE_KEY, "pilotswarm.portal.deepLinkSession");
});

// ─── 3. The dialog emits it only when asked ─────────────────────────────────

test("the share dialog appends show_chrome only when the box is checked", () => {
    const link = WEB_APP.slice(WEB_APP.indexOf("const sessionLink ="));
    const line = link.slice(0, link.indexOf("\n"));
    assert.match(line, /hideChrome \? "&show_chrome=false" : ""/,
        "the parameter is conditional on the checkbox, not always present");
    assert.match(WEB_APP, /const \[hideChrome, setHideChrome\] = React\.useState\(false\)/,
        "default unchecked");
});

// ─── 4. The chromeless render path ──────────────────────────────────────────

test("chrome hiding swaps the header for the strip and nothing else", () => {
    const workspace = APP.slice(APP.indexOf("function PortalWorkspace"));
    assert.match(workspace, /chromeHidden\s*\?\s*React\.createElement\(PortalChromelessStrip/,
        "the strip stands in for PortalHeader");
    assert.match(workspace, /useState\(\(\) => Boolean\(deepLinkTarget\?\.hideChrome\)\)/,
        "seeded from the deep link, but stateful so it can be restored");
    assert.match(workspace, /onShowChrome: \(\) => \{[\s\S]{0,400}?setChromeHidden\(false\)/,
        "the restore control actually restores");

    // The dev-auth banner is a security notice, not decoration: a cosmetic
    // display option must not be able to suppress it.
    const banner = workspace.indexOf("portal-dev-banner");
    const strip = workspace.indexOf("PortalChromelessStrip");
    assert.ok(banner > 0 && banner < strip,
        "the dev banner is rendered before, and independently of, the chrome switch");
});

test("the strip names the deployment with the same helper the header uses", () => {
    // Not a hard-coded "PilotSwarm": a portal whose plugin sets portal.title
    // (Waldemort does) must say its own name in the strip too.
    const stripFn = APP.slice(APP.indexOf("function PortalChromelessStrip"));
    assert.match(stripFn.slice(0, stripFn.indexOf("function PortalWorkspace")),
        /getWorkspaceTitle\(branding\)/,
        "the strip label goes through getWorkspaceTitle");
    assert.match(APP, /branding\?\.title \|\| "PilotSwarm"/,
        "which falls back to PilotSwarm only when branding names nothing");
    assert.match(APP, /React\.createElement\(PortalChromelessStrip, \{\s*branding: portal\?\.branding/,
        "and it is handed the deployment's branding");
});

test("the restore control is recessed but still keyboard reachable", () => {
    const rule = CSS.slice(CSS.indexOf(".portal-chromeless-strip-restore {"));
    const block = rule.slice(0, rule.indexOf("}"));
    assert.match(block, /opacity: 0\.\d+/, "recessed at rest");
    assert.match(CSS, /\.portal-chromeless-strip-restore:focus-visible \{[^}]*opacity: 1/,
        "focus brings it back — otherwise a keyboard user lands on an invisible control");
    assert.match(CSS, /\.portal-chromeless-strip-restore:focus-visible \{[^}]*outline:/,
        "with a real focus ring");
});

test("hiding chrome also hides the workspace toolbar", () => {
    // A maximized canvas covers .ps-workspace-grid, which begins BELOW this
    // bar — so without an explicit rule the toolbar survived "hide page chrome"
    // and the workspace was still plainly on screen.
    assert.match(CSS, /\.portal-app-shell\.is-chromeless \.ps-toolbar \{\s*display: none;/,
        "the toolbar is hidden in chromeless mode");
    // display:none, not opacity: hidden chrome must leave the tab order too.
    const rule = CSS.slice(CSS.indexOf(".portal-app-shell.is-chromeless .ps-toolbar {"));
    assert.doesNotMatch(rule.slice(0, rule.indexOf("}")), /opacity|visibility/,
        "not merely painted out — it must leave the a11y tree and tab order");
});

test("the workspace padding collapses so the canvas runs edge to edge", () => {
    assert.match(CSS, /\.portal-app-shell\.is-chromeless > \.portal-main \{\s*padding: 0;/);
});

// ─── 6. The address bar follows the view ────────────────────────────────────
// Clicking "Show chrome" has to flip the parameter, or a reload — or the URL
// copied out of the bar and passed on — throws the viewer back into the
// chromeless view they just left.

test("showing chrome flips show_chrome=false to true in place", () => {
    const { calls, returned } = rewriteFrom(
        "http://portal.example/?session=s1&view=canvas&slot=1&max=1&show_chrome=false", true);
    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /show_chrome=true/);
    assert.doesNotMatch(calls[0].url, /show_chrome=false/);
    assert.match(returned, /show_chrome=true/);
});

test("the rest of the link is left exactly as it was", () => {
    const { calls } = rewriteFrom(
        "http://portal.example/?session=s1&view=canvas&slot=2&max=1&show_chrome=false", true);
    const params = new URLSearchParams(calls[0].url.slice(calls[0].url.indexOf("?")));
    assert.equal(params.get("session"), "s1");
    assert.equal(params.get("view"), "canvas");
    assert.equal(params.get("slot"), "2", "the slot must survive — it decides WHICH canvas");
    assert.equal(params.get("max"), "1");
    assert.equal(params.get("show_chrome"), "true");
});

test("it replaces the history entry rather than pushing one", () => {
    // A cosmetic toggle must not put itself between the viewer and Back, and
    // must not accumulate entries if they toggle repeatedly.
    const { calls } = rewriteFrom("http://portal.example/?show_chrome=false", true);
    assert.deepEqual(calls[0].state, { some: "state" }, "the existing history state is preserved");
});

test("the path and hash survive, and the origin is not re-stated", () => {
    const { calls } = rewriteFrom("http://portal.example/sub/path?show_chrome=false#frag", true);
    assert.ok(calls[0].url.startsWith("/sub/path?"), `relative to the origin: ${calls[0].url}`);
    assert.ok(calls[0].url.endsWith("#frag"), `hash kept: ${calls[0].url}`);
});

test("a URL with no show_chrome gains an explicit one", () => {
    // Reached from a stash-restored load, where the redirect dropped the query
    // string entirely. Saying "true" out loud beats an absence that happens to
    // mean the same thing.
    const { calls } = rewriteFrom("http://portal.example/", true);
    assert.match(calls[0].url, /show_chrome=true/);
});

test("a browser without replaceState is a no-op, not a crash", () => {
    // The on-screen toggle is what matters; the URL is bookkeeping.
    const { calls, returned } = rewriteFrom("http://portal.example/?show_chrome=false", true, { history: null });
    assert.equal(calls.length, 0);
    assert.equal(returned, null);
});

test("the strip's button is what triggers the rewrite", () => {
    const workspace = APP.slice(APP.indexOf("function PortalWorkspace"));
    assert.match(workspace, /onShowChrome: \(\) => \{[\s\S]{0,400}?writeShowChromeParam\(true\)/,
        "clicking Show chrome updates the URL as well as the state");
});

// ─── 5. The branding chain the strip label depends on ───────────────────────
// Driven through the real resolver against a real plugin.json shape, so a
// change to how portal.title is resolved fails here rather than silently
// renaming a rebranded deployment's canvas strip back to "PilotSwarm".

test("a plugin's portal.title becomes the name the strip shows", async () => {
    const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { resolvePortalConfigFromPluginDirs } = await import(
        "../../tui/src/plugin-config.js");

    // The shape Waldemort ships in its plugin/plugin.json.
    const dir = mkdtempSync(join(tmpdir(), "ps-branding-"));
    try {
        writeFileSync(join(dir, "plugin.json"), JSON.stringify({
            name: "waldemort",
            portal: { title: "Waldemort", pageTitle: "Waldemort — Postgres Stress Testing" },
        }));
        const branded = resolvePortalConfigFromPluginDirs([dir]);
        assert.equal(branded?.branding?.title, "Waldemort");

        // And with no plugin at all, the same chain yields the stock name, so
        // the strip never renders an empty or undefined deployment label.
        const plain = resolvePortalConfigFromPluginDirs([]);
        assert.equal(plain?.branding?.title, "PilotSwarm");
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
