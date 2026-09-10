import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { SessionManager } from "../../src/session-manager.ts";
import { ModelProviderRegistry } from "../../src/model-providers.ts";
import { createFeaturePolicy } from "../helpers/feature-policy.mjs";

const PARENT = "gpt-5.6-terra";
const CRITIC = "claude-sonnet-5";
const OTHER_CRITIC = "claude-opus-4.8";
const available = (...ids) => ids.map(id => ({ id, policy: { state: "enabled" } }));
const github = (id, models) => ({ id, type: "github", githubToken: `synthetic-${id}`, models });
const registry = (providers = [github("gh", [PARENT, CRITIC, OTHER_CRITIC])]) => new ModelProviderRegistry({ providers });
const managerWith = providers => new SessionManager(undefined, null, { modelProviders: providers ?? registry() });
const clientWith = (...models) => ({
    start: vi.fn(async () => {}),
    listModels: vi.fn(() => { throw new Error("SDK cached listModels must not be used"); }),
    rpc: { models: { list: vi.fn(async () => ({ models: available(...models) })) } },
});
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

describe("native critic session model selection", () => {
    it("intersects each owner's permitted provider with the actual client catalog on every preparation", async () => {
        const manager = managerWith();
        let permitted = true;
        const catalog = {
            getSession: vi.fn(async sessionId => ({ owner: { provider: "test", subject: sessionId } })),
            providers: {
                lookupUserId: vi.fn(async owner => owner.subject === "alice" ? 1 : 2),
                listProviders: vi.fn(async userId => [{ name: "gh", usableByMe: userId === 1 && permitted }]),
            },
        };
        manager.setSessionCatalog(catalog);
        const client = clientWith(PARENT, CRITIC);
        expect(await manager._resolveNativeCriticModel("alice", `gh:${PARENT}`, client)).toBe(CRITIC);
        expect(await manager._resolveNativeCriticModel("bob", `gh:${PARENT}`, client)).toBeNull();
        permitted = false;
        expect(await manager._resolveNativeCriticModel("alice", `gh:${PARENT}`, client)).toBeNull();
        expect(client.rpc.models.list).toHaveBeenCalledTimes(1);
        catalog.providers.listProviders.mockRejectedValueOnce(new Error("provider permissions unavailable"));
        expect(await manager._resolveNativeCriticModel("alice", `gh:${PARENT}`, client)).toBeNull();
        expect(client.rpc.models.list).toHaveBeenCalledTimes(1);
        expect(catalog.providers.listProviders.mock.calls.map(([userId, admin]) => [userId, admin])).toEqual([[1, false], [2, false], [1, false], [1, false]]);
        catalog.getSession.mockRejectedValueOnce(new Error("owner lookup unavailable"));
        expect(await manager._resolveNativeCriticModel("alice", `gh:${PARENT}`, client)).toBeNull();
        expect(client.rpc.models.list).toHaveBeenCalledTimes(1);
    });

    it("does not borrow a complementary model from another provider or outside the permitted catalog", async () => {
        const client = clientWith(PARENT, CRITIC);
        const split = managerWith(registry([github("gh", [PARENT]), github("other", [CRITIC])]));
        expect(await split._resolveNativeCriticModel("owner", `gh:${PARENT}`, client)).toBeNull();
        const unregistered = managerWith(registry([github("gh", [PARENT])]));
        expect(await unregistered._resolveNativeCriticModel("owner", `gh:${PARENT}`, client)).toBeNull();
        const disabled = clientWith(PARENT, CRITIC);
        disabled.rpc.models.list.mockResolvedValue({ models: [...available(PARENT), { id: CRITIC, policy: { state: "disabled" } }] });
        expect(await managerWith()._resolveNativeCriticModel("owner", `gh:${PARENT}`, disabled)).toBeNull();
    });

    it("rejects BYOK and unknown parent providers without querying an unrelated Copilot catalog", async () => {
        const providers = registry([{ id: "byok", type: "openai", apiKey: "synthetic", baseUrl: "http://127.0.0.1:1/v1", models: [PARENT, CRITIC] }]);
        const manager = managerWith(providers);
        const client = clientWith(PARENT, CRITIC);
        expect(await manager._resolveNativeCriticModel("owner", `byok:${PARENT}`, client)).toBeNull();
        expect(await manager._resolveNativeCriticModel("owner", `unknown:${PARENT}`, client)).toBeNull();
        expect(client.rpc.models.list).not.toHaveBeenCalled();
    });

    it("shares concurrent catalog reads only within the same credential-bound client", async () => {
        const manager = managerWith();
        const first = deferred();
        const ordering = [];
        const alice = clientWith();
        alice.start.mockImplementation(async () => { ordering.push("start"); });
        alice.rpc.models.list.mockImplementation(() => { ordering.push("list"); return first.promise; });
        const bob = clientWith(PARENT);
        const a = manager._resolveNativeCriticModel("alice-one", `gh:${PARENT}`, alice);
        const b = manager._resolveNativeCriticModel("alice-two", `gh:${PARENT}`, alice);
        await new Promise(resolve => setImmediate(resolve));
        expect(alice.rpc.models.list).toHaveBeenCalledTimes(1);
        expect(ordering).toEqual(["start", "list"]);
        first.resolve({ models: available(PARENT, CRITIC) });
        expect(await Promise.all([a, b])).toEqual([CRITIC, CRITIC]);
        expect(await manager._resolveNativeCriticModel("bob", `gh:${PARENT}`, bob)).toBeNull();
        expect(bob.rpc.models.list).toHaveBeenCalledTimes(1);
        expect(await manager._resolveNativeCriticModel("alice-three", `gh:${PARENT}`, alice)).toBe(CRITIC);
        expect(alice.rpc.models.list).toHaveBeenCalledTimes(1);
    });

    it("drops stale positive catalogs on refresh failure and retries after the shorter failure TTL", async () => {
        vi.useFakeTimers();
        try {
            const manager = managerWith();
            const client = clientWith(PARENT, CRITIC);
            expect(await manager._resolveNativeCriticModel("owner", `gh:${PARENT}`, client)).toBe(CRITIC);
            await vi.advanceTimersByTimeAsync(5 * 60_000 + 1);
            client.rpc.models.list.mockRejectedValueOnce(new Error("catalog unavailable"));
            expect(await manager._resolveNativeCriticModel("owner", `gh:${PARENT}`, client)).toBeNull();
            expect(await manager._resolveNativeCriticModel("owner", `gh:${PARENT}`, client)).toBeNull();
            expect(client.rpc.models.list).toHaveBeenCalledTimes(2);
            await vi.advanceTimersByTimeAsync(30_001);
            expect(await manager._resolveNativeCriticModel("owner", `gh:${PARENT}`, client)).toBe(CRITIC);
            expect(client.rpc.models.list).toHaveBeenCalledTimes(3);
            expect(client.listModels).not.toHaveBeenCalled();
        } finally { vi.useRealTimers(); }
    });

    it("times out optional catalog discovery and ignores a late successful response", async () => {
        vi.useFakeTimers();
        try {
            const manager = managerWith();
            const late = deferred();
            const client = clientWith();
            client.rpc.models.list.mockImplementation(() => late.promise);
            const selecting = manager._resolveNativeCriticModel("owner", `gh:${PARENT}`, client);
            await vi.advanceTimersByTimeAsync(5_000);
            expect(await selecting).toBeNull();
            late.resolve({ models: available(PARENT, CRITIC) });
            await Promise.resolve();
            expect(await manager._resolveNativeCriticModel("owner", `gh:${PARENT}`, client)).toBeNull();
            expect(client.rpc.models.list).toHaveBeenCalledTimes(1);
        } finally { vi.useRealTimers(); }
    });

    it("rebuilds the same warm session when a critic becomes unavailable, returns, or changes model", async () => {
        const home = mkdtempSync(join(tmpdir(), "ps-native-critic-session-"));
        const sessionId = randomUUID();
        const options = [];
        let models = available(PARENT, CRITIC);
        const create = config => {
            options.push(config);
            mkdirSync(join(home, "session-state", sessionId), { recursive: true });
            return { sessionId, disconnect: vi.fn(async () => {}), registerTools: vi.fn() };
        };
        const client = { ...clientWith(), rpc: { models: { list: vi.fn(async () => ({ models })) } }, createSession: async config => create(config),
            resumeSession: async (_id, config) => create(config), stop: async () => {} };
        const manager = new SessionManager(undefined, null, { nativeSubagents: "sync", modelProviders: registry() }, join(home, "session-state"));
        const policy = await createFeaturePolicy();
        manager.client = client;
        manager.setFeatureFlagCache(policy.cache);
        manager.setFactStore({ readFacts: async () => ({ count: 0, facts: [] }) });
        const config = { model: `gh:${PARENT}` };
        const selected = () => options.at(-1).customAgents.find(agent => agent.name === "swarm-rubber-duck")?.model ?? null;
        try {
            let previous = await manager.getOrCreate(sessionId, config, { turnIndex: 0 });
            expect(selected()).toBe(CRITIC);
            expect(await manager.getOrCreate(sessionId, config, { turnIndex: 1 })).toBe(previous);
            expect(options).toHaveLength(1);
            for (const [index, next] of [null, OTHER_CRITIC, CRITIC].entries()) {
                models = available(PARENT, ...(next ? [next] : []));
                manager.nativeCriticCatalogs.delete(client);
                const current = await manager.getOrCreate(sessionId, config, { turnIndex: index + 2 });
                expect(current).not.toBe(previous);
                expect(previous.getCopilotSession().disconnect).toHaveBeenCalledTimes(1);
                expect(selected()).toBe(next);
                expect(options.at(-1).customAgents.filter(agent => agent.name !== "swarm-rubber-duck").map(agent => agent.model)).toEqual([PARENT, PARENT]);
                expect(current.getCopilotSession().sessionId).toBe(sessionId);
                previous = current;
            }
            expect(options).toHaveLength(4);
        } finally { await manager.shutdown(); await policy.cache.stop(); rmSync(home, { recursive: true, force: true }); }
    });
});
