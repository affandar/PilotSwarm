/** Worker lifecycle only: fake timers/stores; no runtime dispatch or LLM calls. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PilotSwarmWorker } from "../../src/worker.ts";
import { startSystemAgents } from "../../src/system-agents.ts";

const stores = vi.hoisted(() => ({ catalog: null, facts: null }));
vi.mock("../../src/storage-providers.ts", async original => ({
    ...await original(),
    getRuntimeStorageProvider: () => ({
        createSessionCatalog: async () => stores.catalog,
        createFactStore: async () => stores.facts,
    }),
}));
vi.mock("../../src/model-providers.ts", async original => ({
    ...await original(),
    createModelProvidersReloader: () => ({
        path: "fixture", current: { allProviders: [], allModels: [], hasModel: () => true },
        types: {}, checkAndReload: vi.fn(() => false),
    }),
}));
vi.mock("../../src/system-agents.ts", async original => ({ ...await original(), startSystemAgents: vi.fn(async () => []) }));
const { Runtime, SqliteProvider } = createRequire(import.meta.url)("duroxide");
const fixtures = [], deferreds = [];

function deferred() {
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    const result = { promise, resolve, reject };
    deferreds.push(result);
    return result;
}

function fixture() {
    const events = [];
    const dir = mkdtempSync(path.join(os.tmpdir(), "ps-provider-lifecycle-"));
    const catalog = { initialize: vi.fn(async () => {}), close: vi.fn(async () => events.push("catalog.close")) };
    stores.catalog = catalog;
    stores.facts = { initialize: vi.fn(async () => {}), close: vi.fn(async () => events.push("facts.close")) };
    const worker = new PilotSwarmWorker({ store: "sqlite://:memory:", githubToken: "fixture",
        sessionStateDir: dir, disableManagementAgents: true, workerNodeId: "provider-lifecycle-fixture" });
    // Native objects are constructed, but never started or connected externally.
    worker._createProvider = async () => SqliteProvider.inMemory();
    worker._startConfigurationPolling = vi.fn();
    worker._refreshProviderRegistry = vi.fn(async () => events.push("providers.refresh"));
    worker._startSystemAgents = vi.fn(async () => events.push("agents.start"));
    vi.spyOn(worker.sessionManager, "shutdown").mockImplementation(async () => events.push("manager.shutdown"));
    const result = { worker, catalog, events, dir, async start() {
        const starting = worker.start();
        await vi.waitFor(() => expect(worker._started).toBe(true));
        await vi.advanceTimersByTimeAsync(200);
        await starting;
        await vi.advanceTimersByTimeAsync(0);
    } };
    fixtures.push(result);
    return result;
}

beforeEach(() => {
    vi.useFakeTimers();
    vi.stubEnv("PILOTSWARM_SESSION_EVICT_MS", "0");
    vi.spyOn(Runtime.prototype, "start").mockResolvedValue(undefined);
    vi.spyOn(Runtime.prototype, "shutdown").mockResolvedValue(undefined);
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    startSystemAgents.mockClear();
});
afterEach(async () => {
    for (const item of deferreds.splice(0)) item.resolve();
    await vi.advanceTimersByTimeAsync(0);
    for (const f of fixtures.splice(0)) {
        await f.worker.stop();
        rmSync(f.dir, { recursive: true, force: true });
    }
    vi.clearAllTimers();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.useRealTimers();
});

describe("provider/system polling lifecycle", () => {
    it("does no background work before start or after stop", async () => {
        const f = fixture();
        await vi.advanceTimersByTimeAsync(60_000);
        expect(f.worker._refreshProviderRegistry).not.toHaveBeenCalled();
        expect(f.worker._startSystemAgents).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
        await f.start();
        expect(f.worker._startSystemAgents).toHaveBeenCalledOnce();
        await f.worker.stop();
        await vi.advanceTimersByTimeAsync(60_000);
        expect(f.worker._refreshProviderRegistry).not.toHaveBeenCalled();
        expect(f.worker._startSystemAgents).toHaveBeenCalledOnce();
        expect(vi.getTimerCount()).toBe(0);
    });

    it("restarts the same instance with exactly one poller", async () => {
        const f = fixture();
        await f.start();
        await f.worker.start();
        await vi.advanceTimersByTimeAsync(30_000);
        expect(f.worker._refreshProviderRegistry).toHaveBeenCalledOnce();
        await f.worker.stop();
        await vi.advanceTimersByTimeAsync(60_000);
        expect(f.worker._refreshProviderRegistry).toHaveBeenCalledOnce();
        await f.start();
        await vi.advanceTimersByTimeAsync(30_000);
        expect(f.worker._refreshProviderRegistry).toHaveBeenCalledTimes(2);
        expect(f.worker._startSystemAgents).toHaveBeenCalledTimes(4);
    });

    it("does not overlap polls or bootstrap after stop interrupts a provider refresh", async () => {
        const f = fixture();
        await f.start();
        const gate = deferred();
        f.worker._refreshProviderRegistry.mockImplementation(() => gate.promise);
        await vi.advanceTimersByTimeAsync(90_000);
        expect(f.worker._refreshProviderRegistry).toHaveBeenCalledOnce();
        const stopping = f.worker.stop();
        await vi.advanceTimersByTimeAsync(0);
        expect(f.catalog.close).not.toHaveBeenCalled();
        gate.resolve();
        await stopping;
        expect(f.worker._startSystemAgents).toHaveBeenCalledOnce();
        expect(f.catalog.close).toHaveBeenCalledOnce();
    });

    it("does not bootstrap when a provider refresh finishes after stop begins", async () => {
        const f = fixture();
        await f.start();
        const gate = deferred();
        f.worker._refreshProviderRegistry.mockImplementationOnce(() => gate.promise);
        await vi.advanceTimersByTimeAsync(30_000);
        const stopping = f.worker.stop();
        await vi.advanceTimersByTimeAsync(0);
        expect(Runtime.prototype.shutdown).toHaveBeenCalledOnce();
        gate.resolve();
        await stopping;
        await vi.advanceTimersByTimeAsync(0);
        expect(f.worker._startSystemAgents).toHaveBeenCalledOnce();
    });

    it("does not bootstrap if stopped during the startup readiness delay", async () => {
        const f = fixture();
        const starting = f.worker.start();
        await vi.waitFor(() => expect(f.worker._started).toBe(true));
        await f.worker.stop();
        await vi.advanceTimersByTimeAsync(60_000);
        await starting;
        expect(f.worker._startSystemAgents).not.toHaveBeenCalled();
        expect(f.worker._refreshProviderRegistry).not.toHaveBeenCalled();
    });

    it("settles initial bootstrap before closing the catalog without blocking worker.start", async () => {
        const f = fixture();
        const gate = deferred();
        f.worker._startSystemAgents.mockImplementation(async () => {
            f.events.push("bootstrap.begin");
            await gate.promise;
            f.events.push("bootstrap.end");
        });
        await f.start();
        const stopping = f.worker.stop();
        await vi.advanceTimersByTimeAsync(0);
        expect(f.catalog.close).not.toHaveBeenCalled();
        expect(Runtime.prototype.shutdown).toHaveBeenCalledOnce();
        gate.resolve();
        await stopping;
        expect(f.events.indexOf("bootstrap.end")).toBeLessThan(f.events.indexOf("manager.shutdown"));
        expect(f.events.indexOf("bootstrap.end")).toBeLessThan(f.events.indexOf("catalog.close"));
    });

    it("stops reconciliation at the beginning of graceful drain", async () => {
        const f = fixture();
        await f.start();
        const drain = deferred();
        Runtime.prototype.shutdown.mockImplementationOnce(() => drain.promise);
        vi.spyOn(f.worker.sessionManager, "sweepIdleSessions").mockResolvedValue(0);
        const stopping = f.worker.gracefulShutdown();
        await vi.advanceTimersByTimeAsync(60_000);
        expect(f.worker._refreshProviderRegistry).not.toHaveBeenCalled();
        drain.resolve();
        await stopping;
        expect(f.catalog.close).toHaveBeenCalledOnce();
    });

    it("recovers after a rejected refresh and settles rejection during stop", async () => {
        const f = fixture();
        await f.start();
        f.worker._refreshProviderRegistry.mockRejectedValueOnce(new Error("catalog unavailable"));
        await vi.advanceTimersByTimeAsync(60_000);
        expect(f.worker._refreshProviderRegistry).toHaveBeenCalledTimes(2);
        expect(f.worker._startSystemAgents).toHaveBeenCalledTimes(2);
        const gate = deferred();
        f.worker._refreshProviderRegistry.mockImplementationOnce(() => gate.promise);
        await vi.advanceTimersByTimeAsync(30_000);
        const stopping = f.worker.stop();
        gate.reject(new Error("catalog unavailable during stop"));
        await stopping;
        expect(f.catalog.close).toHaveBeenCalledOnce();
    });

    it("finishes an admitted agent start but does not begin another agent after stop", async () => {
        const f = fixture();
        await f.start();
        f.worker._startSystemAgents = PilotSwarmWorker.prototype._startSystemAgents;
        f.worker._loadedSystemAgents = ["one", "two"].map(id => ({ id, name: id, prompt: "fixture" }));
        f.catalog.providers = {
            getDefaults: async () => ({ system: { provider: "fixture", model: "fixture:model" } }),
            listSystemAgentModels: async () => [], allCredentials: async () => [],
        };
        const gate = deferred();
        startSystemAgents.mockImplementationOnce(() => gate.promise);
        await vi.advanceTimersByTimeAsync(30_000);
        expect(startSystemAgents).toHaveBeenCalledOnce();
        const stopping = f.worker.stop();
        await vi.advanceTimersByTimeAsync(0);
        expect(f.catalog.close).not.toHaveBeenCalled();
        gate.resolve([]);
        await stopping;
        expect(startSystemAgents).toHaveBeenCalledOnce();
    });
});
