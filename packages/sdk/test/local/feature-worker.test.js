import { afterEach, describe, it, expect, vi } from "vitest";
import { PilotSwarmWorker } from "../../src/worker.ts";
import { FeatureFlagCache } from "../../src/feature-flag-cache.ts";
import { FEATURE_FLAGS } from "../../src/feature-flags.ts";

const key = "copilot.native_tasks";
afterEach(() => vi.useRealTimers());
async function workerFixture(interval = 0) {
    let revision = 1, enabled = false;
    const revisions = vi.fn(async () => [{ featureKey: key, revision: String(revision) }]);
    const cache = new FeatureFlagCache({ revisions, snapshot: async () => ({ definitions: [{ ...FEATURE_FLAGS[key], featureKey: key, revision: String(revision) }], settings: [{ featureKey: key, scope: "cluster", userId: null, enabled, allowUserOverride: false, revision: String(revision) }] }) });
    await cache.pollRevisionsAndRefresh();
    // Exercise the real timer, refresh, heartbeat and stop paths without a
    // Duroxide runtime or unrelated provider/bootstrap dependencies.
    const worker = Object.assign(Object.create(PilotSwarmWorker.prototype), {
        config: { nativeSubagents: "sync", workerNodeId: "fixture", workerPool: "default" }, _featureFlags: cache, _agentPackagesRefreshMs: interval,
        _catalog: { workerHeartbeat: vi.fn(async () => {}), close: vi.fn(async () => {}) },
        _buildRegistrarInfo: () => ({ consumes: ["feature-flags"] }), _collectWorkerHealth: () => ({}),
        _workerPhase: "ready",
        sessionManager: { shutdown: vi.fn(async () => {}) }, refreshAgentPackages: vi.fn(async () => {}),
    });
    return { worker, cache, revisions, catalog: worker._catalog, set(value) { enabled = value; revision++; } };
}
describe("feature worker polling", () => {
    it("polls without package configuration, reports applied revisions and stops cleanly", async () => {
        vi.useFakeTimers(); const f = await workerFixture();
        f.worker._startConfigurationPolling(); await vi.advanceTimersByTimeAsync(0);
        expect(f.catalog.workerHeartbeat.mock.calls.at(-1)[0].state["feature-flags"]).toMatchObject({ appliedRevisions: { [key]: "1" }, nativeCapability: "sync" });
        f.set(true); await vi.advanceTimersByTimeAsync(20_000);
        expect(f.cache.resolve(key, null, { required: true }).enabled).toBe(true);
        expect(f.catalog.workerHeartbeat.mock.calls.at(-1)[0].state["feature-flags"].appliedRevisions[key]).toBe("2");
        expect(f.worker.refreshAgentPackages).not.toHaveBeenCalled();
        await f.worker.stop(); const reads = f.revisions.mock.calls.length;
        await vi.advanceTimersByTimeAsync(60_000); expect(f.revisions).toHaveBeenCalledTimes(reads);
        expect(f.catalog.close).toHaveBeenCalledOnce();
    });
    it("continues feature convergence during an unfinished package installation", async () => {
        vi.useFakeTimers(); const f = await workerFixture(20_000);
        let finish;
        f.worker._agentPackagesCacheDir = "unused-fixture-cache";
        f.worker.artifactStore = {};
        f.worker._agentPackagesEpoch = 1;
        f.catalog.agentRegistryEpoch = vi.fn(() => new Promise(resolve => { finish = resolve; }));
        f.worker.refreshAgentPackages = PilotSwarmWorker.prototype.refreshAgentPackages;
        f.worker._startConfigurationPolling();
        f.set(true); await vi.advanceTimersByTimeAsync(20_000);
        expect(f.cache.resolve(key, null, { required: true }).enabled).toBe(true);
        f.set(false); await vi.advanceTimersByTimeAsync(20_000);
        expect(f.cache.resolve(key, null, { required: true }).enabled).toBe(false);
        expect(f.catalog.agentRegistryEpoch).toHaveBeenCalledOnce();
        expect(f.worker._agentPackagesRefreshing).toBe(true);
        finish(1); await vi.advanceTimersByTimeAsync(0);
        expect(f.worker._agentPackagesRefreshing).toBe(false);
        await f.worker.stop();
    });
    it("uses the configured positive interval and recovers from a failed heartbeat", async () => {
        vi.useFakeTimers(); const f = await workerFixture(1_234);
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        try {
            f.catalog.workerHeartbeat.mockRejectedValueOnce(new Error("temporary registry outage"));
            f.worker._startConfigurationPolling(); await vi.advanceTimersByTimeAsync(0);
            expect(f.worker._registryReporting).toBe(false);
            f.set(true); const before = f.revisions.mock.calls.length;
            await vi.advanceTimersByTimeAsync(1_233); expect(f.revisions).toHaveBeenCalledTimes(before);
            await vi.advanceTimersByTimeAsync(1);
            expect(f.cache.resolve(key, null, { required: true }).enabled).toBe(true);
            expect(f.catalog.workerHeartbeat.mock.calls.at(-1)[0].state["feature-flags"].appliedRevisions[key]).toBe("2");
        } finally { await f.worker.stop(); warn.mockRestore(); }
    });
    it("discards an in-flight cache load before closing the catalog on stop", async () => {
        vi.useFakeTimers(); const f = await workerFixture();
        let finish, started;
        const entered = new Promise(resolve => { started = resolve; });
        const cache = new FeatureFlagCache({ revisions: async () => [{ featureKey: key, revision: "2" }],
            snapshot: () => { started(); return new Promise(resolve => { finish = resolve; }); } });
        f.worker._featureFlags = cache;
        f.worker._startConfigurationPolling();
        const refresh = f.worker.refreshWorkerConfiguration(); await entered;
        const stopping = f.worker.stop();
        expect(f.catalog.close).not.toHaveBeenCalled();
        finish({ definitions: [{ ...FEATURE_FLAGS[key], featureKey: key, revision: "2" }], settings: [] });
        await Promise.all([refresh, stopping]);
        expect(cache.state.initialized).toBe(false); expect(f.catalog.close).toHaveBeenCalledOnce();
    });

});
