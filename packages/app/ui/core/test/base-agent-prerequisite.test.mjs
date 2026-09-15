import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PilotSwarmUiController, appReducer, createInitialState, createStore } from "../src/index.js";
import { FeatureFlagsPanel } from "../../react/src/feature-flags-panel.js";
import { projectFeatureWorkerState } from "../../../../sdk/api/src/admin-diagnostics.js";

const BASE = "agents.base_v2", NATIVE = "copilot.native_tasks";
const profile = { provider: "test", subject: "owner", isAdmin: false };
function flag(key, enabled, extra = {}) {
    return { featureKey: key, displayName: key, description: "Feature", revision: "1",
        defaultEnabled: false, defaultAllowUserOverride: true,
        cluster: { enabled: false, allowUserOverride: true }, user: { enabled },
        effective: enabled, source: "user", supported: true, ...extra };
}
function fixture(nativeEnabled, baseEnabled = true) {
    let offline = false;
    const writes = [];
    const data = { flags: [flag(NATIVE, nativeEnabled), flag(BASE, baseEnabled, {
        effective: nativeEnabled && baseEnabled,
        ...(baseEnabled && !nativeEnabled ? { reason: "requires_native_tasks" } : {}),
    })] };
    const store = createStore(appReducer, createInitialState({ mode: "remote" }));
    store.dispatch({ type: "admin/profile/loaded", profile });
    const transport = { listSessions: async () => [], subscribeSession: () => () => {},
        getMyFeatureFlags: async () => { if (offline) throw new Error("refresh offline"); return data; },
        setMyFeatureFlag: async input => { writes.push(input); return { revision: "2", setting: { enabled: input.enabled } }; } };
    const controller = new PilotSwarmUiController({ store, transport });
    return { controller, store, writes, offline: () => { offline = true; },
        current: key => store.getState().admin.features.data.flags.find(value => value.featureKey === key) };
}

for (const enabled of [true, false]) test(`a saved native ${enabled ? "On" : "Off"} recomputes Base V2 even if refresh fails`, async () => {
    const h = fixture(!enabled);
    await h.controller.refreshFeatureFlags();
    h.offline();
    await h.controller.saveFeatureFlag(NATIVE, { enabled });
    assert.equal(h.current(BASE).effective, enabled);
    assert.equal(h.current(BASE).user.enabled, true, "Base V2 preference remains intact");
    assert.equal(h.current(BASE).reason, enabled ? undefined : "requires_native_tasks");
    assert.equal(h.writes.length, 1, "no implicit prerequisite mutation");
});

test("saving Base V2 On retains its preference while native tasks remain Off", async () => {
    const h = fixture(false, false);
    await h.controller.refreshFeatureFlags();
    h.offline();
    await h.controller.saveFeatureFlag(BASE, { enabled: true });
    assert.equal(h.current(BASE).user.enabled, true);
    assert.equal(h.current(BASE).effective, false);
    assert.equal(h.current(NATIVE).effective, false);
    assert.equal(h.writes.length, 1);
    const state = h.store.getState();
    const html = renderToStaticMarkup(React.createElement(FeatureFlagsPanel, { controller: h.controller,
        features: state.admin.features, isAdmin: false, workers: [] }));
    assert.match(html, /Base Agent V2 is currently Off because it requires Native Copilot tasks/);
    assert.match(html, /preference is saved/);
});

test("safe worker diagnostics retain the Base V2 capability and revision", () => {
    assert.deepEqual(projectFeatureWorkerState({ protocolVersion: 1, initialized: true,
        supportedKeys: [BASE, NATIVE, "private.internal"],
        appliedRevisions: { [BASE]: "4", [NATIVE]: "8", "private.internal": "1" } }), {
        protocolVersion: 1, initialized: true, supportedKeys: [BASE, NATIVE],
        appliedRevisions: { [BASE]: "4", [NATIVE]: "8" },
    });
});
