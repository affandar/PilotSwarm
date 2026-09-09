import { describe, it, expect } from "vitest";
import { FEATURE_FLAGS, resolveFeatureDefinition } from "../../src/feature-flags.ts";
import { FeatureFlagCache } from "../../src/feature-flag-cache.ts";

const key = "copilot.native_tasks";
const owner = { provider: "test", subject: "alice" };
const def = (revision = "1") => ({ featureKey: key, ...FEATURE_FLAGS[key], revision });
const cluster = (enabled, allowUserOverride) => ({ featureKey: key, scope: "cluster", userId: null, enabled, allowUserOverride, revision: "1" });
const user = enabled => ({ featureKey: key, scope: "user", userId: 1, owner, enabled, allowUserOverride: null, revision: "1" });
const deferred = () => { let resolve; let reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
function fixture() {
    let snapshot = { definitions: [def()], settings: [] }; let failed = false; let reads = 0;
    const store = { revisions: async () => { if (failed) throw new Error("offline"); return snapshot.definitions.map(({ featureKey, revision }) => ({ featureKey, revision })); },
        snapshot: async () => { reads++; return structuredClone(snapshot); } };
    return { cache: new FeatureFlagCache(store), store, set: value => { snapshot = value; }, fail: value => { failed = value; }, reads: () => reads };
}

describe("feature resolution", () => {
    for (const enabled of [false, true]) for (const override of [false, true]) for (const preference of [undefined, false, true]) {
        it(`cluster=${enabled} override=${override} user=${preference}`, () => {
            const decision = resolveFeatureDefinition(def(), cluster(enabled, override), preference === undefined ? undefined : user(preference));
            expect(decision.enabled).toBe(override && preference !== undefined ? preference : enabled);
            expect(decision.source).toBe(override && preference !== undefined ? "user" : "cluster");
        });
    }
    it("published defaults apply only when cluster/user entries are absent", () => {
        expect(resolveFeatureDefinition({ ...def(), defaultEnabled: true }).enabled).toBe(true);
        expect(resolveFeatureDefinition({ ...def(), defaultEnabled: true }, cluster(false, false)).enabled).toBe(false);
    });
    it("requires an explicit fallback or error policy, including runtime callers", () => {
        const { cache } = fixture();
        for (const options of [undefined, {}, { required: false }, { required: true, fallback: false }, { fallback: "false" }]) {
            expect(() => cache.resolve(key, owner, options)).toThrow(TypeError);
        }
        expect(cache.resolve(key, owner, { fallback: true })).toMatchObject({ enabled: true, source: "fallback", reason: "cache_unavailable" });
        expect(cache.resolve(key, owner, { fallback: false }).enabled).toBe(false);
        expect(() => cache.resolve(key, owner, { required: true })).toThrow(/cache_unavailable/);
        expect(cache.resolve("typo", owner, { fallback: false }).reason).toBe("unknown_key");
        expect(() => cache.resolve("typo", owner, { required: true })).toThrow(/unknown_key/);
    });
    it("does not replace a resolved false with fallback true", async () => {
        const { cache } = fixture(); await cache.pollRevisionsAndRefresh();
        expect(cache.resolve(key, owner, { fallback: true })).toMatchObject({ enabled: false, source: "default" });
    });
});

describe("feature worker cache", () => {
    it("adopts scoped changes and deletes across two workers without lookup I/O", async () => {
        const f = fixture(); const second = new FeatureFlagCache(f.store);
        await Promise.all([f.cache.pollRevisionsAndRefresh(), second.pollRevisionsAndRefresh()]);
        f.set({ definitions: [def("2")], settings: [cluster(false, true), user(true)] });
        await f.cache.pollRevisionsAndRefresh();
        expect(f.cache.resolve(key, owner, { required: true }).enabled).toBe(true);
        expect(second.resolve(key, owner, { required: true }).enabled).toBe(false);
        expect(f.cache.resolve(key, { ...owner, subject: "bob" }, { required: true }).enabled).toBe(false);
        await second.pollRevisionsAndRefresh();
        expect(second.resolve(key, owner, { required: true }).enabled).toBe(true);
        const before = f.reads();
        for (let i = 0; i < 100; i++) f.cache.resolve(key, owner, { required: true });
        await f.cache.pollRevisionsAndRefresh(); expect(f.reads()).toBe(before);
        f.set({ definitions: [def("3")], settings: [cluster(false, true)] });
        await f.cache.pollRevisionsAndRefresh();
        expect(f.cache.resolve(key, owner, { required: true }).enabled).toBe(false);
        f.set({ definitions: [], settings: [] }); await f.cache.pollRevisionsAndRefresh();
        expect(f.cache.resolve(key, owner, { fallback: true })).toMatchObject({ enabled: true, reason: "catalog_missing" });
        expect(() => f.cache.resolve(key, owner, { required: true })).toThrow(/catalog_missing/);
    });
    it("retains last good data on errors, retries unchanged desired revisions, rejects stale snapshots", async () => {
        const f = fixture(); f.set({ definitions: [def("2")], settings: [cluster(true, false)] });
        await f.cache.pollRevisionsAndRefresh(); f.fail(true); await f.cache.pollRevisionsAndRefresh();
        expect(f.cache.resolve(key, owner, { fallback: false })).toMatchObject({ enabled: true, stale: true, revision: "2" });
        f.fail(false); f.set({ definitions: [def("1")], settings: [] }); await f.cache.pollRevisionsAndRefresh();
        expect(f.cache.state.lastError).toMatch(/stale/);
        expect(f.cache.resolve(key, owner, { required: true }).revision).toBe("2");
        f.set({ definitions: [def("3")], settings: [cluster(false, false)] });
        const original = f.store.snapshot; f.store.snapshot = async () => { throw new Error("temporary read failure"); };
        await f.cache.pollRevisionsAndRefresh(); expect(f.cache.state.appliedRevisions[key]).toBe("2");
        f.store.snapshot = original; await f.cache.pollRevisionsAndRefresh();
        expect(f.cache.resolve(key, owner, { required: true })).toMatchObject({ enabled: false, revision: "3", stale: false });
    });
    it("does not partially publish invalid settings or alias store objects", async () => {
        const f = fixture(); await f.cache.pollRevisionsAndRefresh();
        const valid = { definitions: [def("2")], settings: [cluster(true, false)] };
        f.store.snapshot = async () => valid; f.set(valid); await f.cache.pollRevisionsAndRefresh();
        valid.settings[0].enabled = false;
        expect(f.cache.resolve(key, owner, { required: true }).enabled).toBe(true);
        const bad = { definitions: [def("3")], settings: [cluster(false, false), cluster(true, true)] };
        f.set(bad); f.store.snapshot = async () => bad; await f.cache.pollRevisionsAndRefresh();
        expect(f.cache.state.lastError).toMatch(/Invalid/);
        expect(f.cache.resolve(key, owner, { required: true }).revision).toBe("2");
    });
    it("coalesces overlapping polls and discards a load completed after shutdown", async () => {
        const load = deferred(); const started = deferred(); let calls = 0; let changes = 0;
        const cache = new FeatureFlagCache({ revisions: async () => [{ featureKey: key, revision: "1" }], snapshot: () => { calls++; started.resolve(); return load.promise; } });
        cache.onChange(() => { changes++; });
        const a = cache.pollRevisionsAndRefresh(); const b = cache.pollRevisionsAndRefresh();
        await started.promise; expect(calls).toBe(1);
        const stopped = cache.stop(); load.resolve({ definitions: [def()], settings: [] });
        await Promise.all([a, b, stopped]); expect(changes).toBe(0); expect(cache.state.initialized).toBe(false);
        await cache.pollRevisionsAndRefresh(); expect(calls).toBe(1);
    });
});


describe("bounded feature cache reads", () => {
    it("fails closed on startup and permits shutdown when a store never responds", async () => {
        const cache = new FeatureFlagCache({ revisions: () => new Promise(() => {}), snapshot: () => new Promise(() => {}) }, 20);
        const pending = cache.pollRevisionsAndRefresh();
        await pending;
        expect(cache.resolve("copilot.native_tasks", null, { fallback: false })).toMatchObject({ enabled: false, stale: true, reason: "cache_unavailable" });
        expect(cache.state.lastError).toContain("timed out");
        await cache.stop();
    });
});
