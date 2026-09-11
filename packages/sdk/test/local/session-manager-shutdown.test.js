import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CopilotSession } from "@github/copilot-sdk";
import { createCopilotClient } from "../../src/copilot-client.ts";
import { SessionManager } from "../../src/session-manager.ts";

function deferred() {
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}

// Exercise the installed SDK's real stop/detach/forceStop methods. Only the
// process and wire are fake: an unresponsive detach is the release-gate repro.
function sdkClient(manager, { stalled = false } = {}) {
    const detach = deferred();
    const connection = {
        sendRequest: vi.fn(async (method) => {
            expect(method).toBe("session.detach");
            return stalled ? detach.promise : { success: true };
        }),
        dispose: vi.fn(() => detach.reject(new Error("Connection closed"))),
    };
    // The happy path never awaits detach.promise.
    void detach.promise.catch(() => {});
    const client = createCopilotClient({});
    const session = new CopilotSession("shutdown-fixture", connection);
    client.connection = connection;
    client.sessions.set(session.sessionId, session);
    const kill = vi.fn();
    if (stalled) client.cliProcess = { kill };
    const stop = vi.spyOn(client, "stop");
    const forceStop = vi.spyOn(client, "forceStop");
    // A pooled client may occupy both the default and BYOK alias slots.
    manager.client = client;
    manager.sessions.set(session.sessionId, { destroy: () => session.disconnect() });
    return { client, session, connection, stop, forceStop, kill };
}

describe("SessionManager final shutdown", () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.spyOn(console, "warn").mockImplementation(() => {});
    });
    afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

    it("gracefully detaches real SDK sessions once per unique client and clears local state", async () => {
        const manager = new SessionManager();
        const { connection, stop, forceStop } = sdkClient(manager);
        manager.setConfig("shutdown-fixture", { model: "test" });
        const unsubscribe = vi.fn();
        manager.unsubscribeFeatureFlags = unsubscribe;

        await manager.shutdown();
        await manager.shutdown();

        expect(connection.sendRequest).toHaveBeenCalledExactlyOnceWith("session.detach", { sessionId: "shutdown-fixture" });
        expect(stop).toHaveBeenCalledTimes(1);
        expect(forceStop).not.toHaveBeenCalled();
        expect(unsubscribe).toHaveBeenCalledTimes(1);
        expect(manager.activeSessionCount).toBe(0);
        expect(manager.clients.size).toBe(0);
        expect(manager.sessionConfigs.size).toBe(0);
        expect(vi.getTimerCount()).toBe(0);
    });

    it("bounds an actual SDK detach hang without modifying durable storage", async () => {
        const store = { delete: vi.fn(), dehydrate: vi.fn(), checkpoint: vi.fn() };
        const manager = new SessionManager(undefined, store);
        const { connection, forceStop, kill } = sdkClient(manager, { stalled: true });
        const heldLock = deferred().promise;
        manager.sessionLocks.set("shutdown-fixture", heldLock);
        let finished = false;
        const shutdown = manager.shutdown().then(() => { finished = true; });

        await vi.advanceTimersByTimeAsync(9_999);
        expect(finished).toBe(false);
        expect(forceStop).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        expect(finished).toBe(true);
        await shutdown;
        expect(forceStop).toHaveBeenCalledTimes(1);
        expect(connection.dispose).toHaveBeenCalledTimes(1);
        expect(kill).toHaveBeenCalledExactlyOnceWith("SIGKILL");
        for (const operation of Object.values(store)) expect(operation).not.toHaveBeenCalled();
        expect(manager.activeSessionCount).toBe(0);
        expect(manager.sessionLocks.get("shutdown-fixture")).toBe(heldLock);
        // SDK stop can finish its retry after forceStop closes the wire.
        await vi.advanceTimersByTimeAsync(500);
        expect(vi.getTimerCount()).toBe(0);
    });

    it("stops healthy clients immediately while other clients consume one shared deadline", async () => {
        const manager = new SessionManager();
        const stuck = [0, 1].map(() => ({ stop: vi.fn(() => new Promise(() => {})), forceStop: vi.fn(async () => {}) }));
        const healthy = { stop: vi.fn(async () => []), forceStop: vi.fn() };
        [...stuck, healthy].forEach((client, i) => manager.clients.set(`fixture-${i}`, client));
        let finished = false;
        const shutdown = manager.shutdown().then(() => { finished = true; });

        await vi.advanceTimersByTimeAsync(0);
        expect(healthy.stop).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(10_000);
        expect(finished).toBe(true);
        await shutdown;
        for (const client of stuck) expect(client.forceStop).toHaveBeenCalledTimes(1);
        expect(healthy.forceStop).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
    });

    it.each(["reject", "errors"])("force-stops when SDK stop reports %s", async (failure) => {
        const manager = new SessionManager();
        const client = {
            stop: vi.fn(async () => {
                if (failure === "reject") throw new Error("Transport unavailable");
                return [new Error("Transport unavailable")];
            }),
            forceStop: vi.fn(async () => {}),
        };
        manager.clients.set("fixture", client);
        await manager.shutdown();
        expect(client.forceStop).toHaveBeenCalledTimes(1);
        expect(vi.getTimerCount()).toBe(0);
    });

    it.each(["resolve", "reject"])("late %s after force-stop cannot clear a later manager lifetime", async (settle) => {
        const manager = new SessionManager();
        const graceful = deferred();
        const oldClient = { stop: vi.fn(() => graceful.promise), forceStop: vi.fn(async () => {}) };
        manager.clients.set("old", oldClient);
        let finished = false;
        const shutdown = manager.shutdown().then(() => { finished = true; });
        await vi.advanceTimersByTimeAsync(10_000);
        expect(finished).toBe(true);
        await shutdown;

        const newClient = { stop: vi.fn(async () => []), forceStop: vi.fn() };
        manager.clients.set("new", newClient);
        manager.setConfig("new-session", { model: "new-model" });
        if (settle === "resolve") graceful.resolve([]);
        else graceful.reject(new Error("Late transport failure"));
        await vi.advanceTimersByTimeAsync(0);
        expect(manager.clients.get("new")).toBe(newClient);
        expect(manager.sessionConfigs.has("new-session")).toBe(true);
        await manager.shutdown();
        expect(newClient.stop).toHaveBeenCalledTimes(1);
        expect(newClient.forceStop).not.toHaveBeenCalled();
    });

    it("individual session eviction leaves its shared client running", async () => {
        const manager = new SessionManager();
        const { stop, forceStop } = sdkClient(manager);
        await manager.destroySession("shutdown-fixture");
        expect(stop).not.toHaveBeenCalled();
        expect(forceStop).not.toHaveBeenCalled();
        expect(manager.clients.size).toBeGreaterThan(0);
        await manager.shutdown();
        expect(stop).toHaveBeenCalledTimes(1);
    });
});
