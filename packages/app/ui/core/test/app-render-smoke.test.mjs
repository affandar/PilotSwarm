// RENDER SMOKE TEST.
//
// Every other test here exercises reducers and selectors, so a crash in a
// component's render body reaches production untouched. That is exactly how
// "opening Artifacts blanks the page" shipped: panelActions read markedSet
// before its declaration, React unmounted the tree, and neither node --check
// nor 127 passing tests could see it.
//
// Server rendering runs component bodies without needing a DOM, which is
// where temporal-dead-zone errors, bad destructuring and undefined-callee
// bugs live. Effects do not run, so this does not replace a browser test —
// it catches the class of failure that has actually bitten us.
import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createStore } from "../src/store.js";
import { appReducer } from "../src/reducer.js";
import { createInitialState } from "../src/state.js";
import { PilotSwarmUiController } from "../src/controller.js";
import { INSPECTOR_TABS } from "../src/commands.js";

// The component module reads window at module and render time. Stub the few
// APIs it touches BEFORE importing it — deliberately minimal, so the test keeps
// exercising real component code rather than a simulated browser.
globalThis.window = globalThis.window || {
    innerWidth: 1440,
    innerHeight: 900,
    devicePixelRatio: 1,
    matchMedia: (query) => ({
        matches: /max-width:\s*920px/.test(String(query)) ? false : false,
        media: String(query),
        addEventListener() {},
        removeEventListener() {},
        addListener() {},
        removeListener() {},
    }),
    addEventListener() {},
    removeEventListener() {},
    requestAnimationFrame: (fn) => { fn(); return 0; },
    cancelAnimationFrame() {},
    getComputedStyle: () => ({ font: "13px monospace", getPropertyValue: () => "" }),
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
};
globalThis.document = globalThis.document || {
    documentElement: { style: { setProperty() {} }, classList: { add() {}, remove() {}, toggle() {} } },
    body: { classList: { add() {}, remove() {}, toggle() {} }, appendChild() {}, removeChild() {} },
    createElement: () => ({ style: {}, classList: { add() {} }, appendChild() {}, remove() {}, getBoundingClientRect: () => ({ width: 0, height: 0 }) }),
    querySelector: () => null,
    addEventListener() {},
    removeEventListener() {},
};
if (!globalThis.navigator?.clipboard) {
    // navigator is a read-only getter in Node; define over it instead.
    Object.defineProperty(globalThis, "navigator", {
        value: { userAgent: "node", clipboard: { writeText: async () => {} } },
        configurable: true,
    });
}

const { PilotSwarmWebApp } = await import("../../react/src/web-app.js");

function makeController(overrides = {}) {
    const store = createStore(appReducer, { ...createInitialState({ mode: "remote" }), ...overrides });
    // A transport stub: every method resolves empty. Render must not depend on
    // any of them, but the controller reads capability probes during render.
    const transport = new Proxy({}, {
        get: () => async () => ({}),
        has: () => true,
    });
    return new PilotSwarmUiController({ store, transport });
}

const render = (controller) => renderToStaticMarkup(
    React.createElement(PilotSwarmWebApp, { controller }),
);

test("the app renders without throwing", () => {
    const html = render(makeController());
    assert.ok(html.length > 0, "produced markup");
});

test("every inspector tab renders", () => {
    // The Artifacts crash was tab-specific — a smoke test that only rendered
    // the default tab would have missed it entirely.
    for (const tab of INSPECTOR_TABS) {
        const controller = makeController();
        controller.dispatch({ type: "ui/inspectorTab", inspectorTab: tab });
        assert.doesNotThrow(() => render(controller), `inspector tab "${tab}" must render`);
    }
});

test("the Files tab renders with an artifact selected and marked", () => {
    // Reproduces the exact shape that crashed: a selection plus bulk marks,
    // which is what put markedSet on the render path.
    const controller = makeController();
    controller.dispatch({ type: "ui/inspectorTab", inspectorTab: "files" });
    controller.dispatch({ type: "files/select", sessionId: "s1", filename: "a.patch" });
    controller.dispatch({ type: "files/toggleMark", artifactId: "s1/a.patch" });
    assert.doesNotThrow(() => render(controller), "Files tab with marks must render");
});

test("both chat view modes render", () => {
    for (const mode of ["transcript", "rich", "summary"]) {
        const controller = makeController();
        controller.dispatch({ type: "ui/chatViewMode", chatViewMode: mode });
        assert.doesNotThrow(() => render(controller), `chat view "${mode}" must render`);
    }
});

// The suite rendered at 1440px only, so every mobile-only branch — the mobile
// toolbar, MobileWorkspace, the chat-focus rail, the phone session pane — was
// unguarded. `viewport` starts at 0x0 and effects do not run under SSR, so the
// width falls through to window.innerWidth: setting that is enough to take the
// mobile path. Restored afterwards so the desktop tests keep their width.
test("the mobile layout renders on every inspector tab", () => {
    const desktopWidth = globalThis.window.innerWidth;
    globalThis.window.innerWidth = 390;
    try {
        for (const tab of INSPECTOR_TABS) {
            const controller = makeController();
            controller.dispatch({ type: "ui/inspectorTab", inspectorTab: tab });
            assert.doesNotThrow(() => render(controller), `mobile inspector tab "${tab}" must render`);
        }
    } finally {
        globalThis.window.innerWidth = desktopWidth;
    }
});

// NOT covered here, and deliberately so rather than covered badly: the
// chat-focus rail and the Node Map's mobile split both hang off component-local
// useState (chatFocusMode, mobilePane) with no reducer action behind them, so
// SSR always renders the default branch. A test that dispatched at them would
// pass while exercising nothing. They need a browser-driven test to be real.

test("the full-screen artifact preview renders", () => {
    const controller = makeController();
    controller.dispatch({ type: "ui/inspectorTab", inspectorTab: "files" });
    controller.dispatch({ type: "files/select", sessionId: "s1", filename: "a.md" });
    controller.dispatch({ type: "files/previewOrigin", origin: "chat", restoreArtifactId: null });
    controller.dispatch({ type: "files/fullscreen", fullscreen: true });
    assert.doesNotThrow(() => render(controller), "fullscreen preview must render");
});
