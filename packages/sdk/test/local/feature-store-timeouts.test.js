import { afterEach, describe, it, expect, vi } from "vitest";
import { FeatureStore } from "../../src/feature-store.ts";

afterEach(() => vi.useRealTimers());
describe("feature database deadlines", () => {
    it("bounds pool acquisition and releases a connection delivered after timeout", async () => {
        vi.useFakeTimers(); let deliver;
        const client = { release: vi.fn(), query: vi.fn() };
        const pool = { connect: () => new Promise(resolve => { deliver = resolve; }) };
        const result = new FeatureStore(pool, "cms").revisions();
        const rejection = expect(result).rejects.toThrow("connection timed out");
        await vi.advanceTimersByTimeAsync(5_000); await rejection;
        deliver(client); await vi.advanceTimersByTimeAsync(0);
        expect(client.release).toHaveBeenCalledOnce(); expect(client.query).not.toHaveBeenCalled();
    });
    it("sets server deadlines and destroys failed transaction connections", async () => {
        const failure = new Error("query timed out");
        const client = { release: vi.fn(), query: vi.fn().mockResolvedValueOnce({ rows: [] }).mockRejectedValueOnce(failure) };
        const store = new FeatureStore({ connect: async () => client }, "cms");
        await expect(store.snapshot(["copilot.native_tasks"])).rejects.toBe(failure);
        expect(client.query.mock.calls[0][0]).toMatchObject({ text: expect.stringContaining("SET LOCAL statement_timeout"), query_timeout: 6_000 });
        expect(client.release).toHaveBeenCalledWith(failure);
        expect(client.query.mock.calls.some(([q]) => q.text === "COMMIT")).toBe(false);
    });
});


it("bounds a real stalled PostgreSQL handshake so catalog shutdown completes", { timeout: 20_000 }, async () => {
    const { createServer } = await import("node:net");
    const { PgSessionCatalog } = await import("../../src/cms.ts");
    const sockets = new Set();
    const server = createServer(socket => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); socket.resume(); });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    const catalog = await PgSessionCatalog.create(`postgresql://test:test@127.0.0.1:${server.address().port}/test`, "test_features");
    let deadline;
    try {
        expect(catalog.pool.options.connectionTimeoutMillis).toBe(10_000);
        await expect(catalog.features.revisions()).rejects.toThrow(/timed out/);
        await Promise.race([catalog.close(), new Promise((_, reject) => {
            deadline = setTimeout(() => reject(new Error("Catalog close blocked by abandoned handshake")), 8_000);
        })]);
    } finally {
        clearTimeout(deadline);
        for (const socket of sockets) socket.destroy();
        await new Promise(resolve => server.close(resolve));
        await catalog.close();
    }
});
