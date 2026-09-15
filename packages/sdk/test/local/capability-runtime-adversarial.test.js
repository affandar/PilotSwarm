import { describe, expect, it } from "vitest";
import { bindCapabilities, nextCapabilityState } from "../../src/capability-runtime.ts";
import { capabilityRef, resolveCapabilitySource } from "../../src/capability-catalog.ts";

const ALICE = { provider: "test", subject: "alice" };
const BOB = { provider: "test", subject: "bob" };
const tool = (name, value = name) => ({ name, description: name, parameters: { type: "object" }, handler: async () => value });
function source(id, { owner = null, tools = [tool("lookup")], mcp = {} } = {}) {
    return { id, name: "same-name", source: "published", revision: `${id}-v1`,
        scope: owner ? "user" : "shared", owner, packageId: id, artifacts: [],
        tools: new Map(tools.map(t => [t.name, t])), mcpServers: mcp };
}
const select = (sourceId, tools = [], mcpServers = []) => ({ sourceId, tools, mcpServers });
const empty = () => ({ revision: 0, selections: [] });
const request = (extra = {}) => ({ source_ref: capabilityRef("shared", "shared-v1", "source"),
    tools: ["lookup"], expected_revision: 0, request_id: "request-1", ...extra });

describe("capability selection atomicity and retry identity", () => {
    it("does not mutate a prior state while constructing an additive or removal revision", () => {
        const before = empty();
        const attached = nextCapabilityState(before, "shared", request());
        expect(before).toEqual(empty());
        expect(attached).toMatchObject({ changed: true, state: { revision: 1,
            selections: [select("shared", ["lookup"])] } });
        const removed = nextCapabilityState(attached.state, "shared", request({
            action: "remove", expected_revision: 1, request_id: "remove-1",
        }));
        expect(removed.state.selections).toEqual([]);
        expect(attached.state.selections).toEqual([{
            ...select("shared", ["lookup"]),
            sourceRef: request().source_ref,
        }]);
    });

    it("rejects stale revision and reused identity with a different selection without partial mutation", () => {
        const attached = nextCapabilityState(empty(), "shared", request()).state;
        const snapshot = structuredClone(attached);
        expect(() => nextCapabilityState(attached, "shared", request({ request_id: "other", tools: ["second"] }))).toThrow(/revision conflict/i);
        expect(() => nextCapabilityState(attached, "shared", request({ tools: ["second"], expected_revision: 1 }))).toThrow(/different package change/i);
        expect(attached).toEqual(snapshot);
    });

    it("replays an acknowledged request without advancing the revision", () => {
        const attached = nextCapabilityState(empty(), "shared", request()).state;
        const retry = nextCapabilityState(attached, "shared", request());
        expect(retry.changed).toBe(false);
        expect(retry.state).toBe(attached);
        expect(retry.state.revision).toBe(1);
    });

    it("pins retry identity to the exact source revision", () => {
        const attached = nextCapabilityState(empty(), "shared", request()).state;
        expect(() => nextCapabilityState(attached, "shared", request({
            source_ref: capabilityRef("shared", "shared-v2", "source"), expected_revision: 1,
        }))).toThrow(/different package change/i);
    });

    it("identifies the same request despite JSON property ordering", () => {
        const attached = nextCapabilityState(empty(), "shared", request()).state;
        const retry = { request_id: "request-1", expected_revision: 1, tools: ["lookup"],
            source_ref: request().source_ref };
        expect(nextCapabilityState(attached, "shared", retry).state).toBe(attached);
    });

    it("identifies an equivalent add request despite set ordering and the optional action default", () => {
        const attached = nextCapabilityState(empty(), "shared", request({ tools: ["lookup", "second"] })).state;
        const retry = request({ tools: ["second", "lookup"], action: "add", expected_revision: 1 });
        expect(nextCapabilityState(attached, "shared", retry).state).toBe(attached);
    });

    it("records a no-op receipt without claiming the runtime binding changed", () => {
        const attached = nextCapabilityState(empty(), "shared", request()).state;
        const noop = request({ request_id: "noop-1", expected_revision: 1 });
        const result = nextCapabilityState(attached, "shared", noop);
        expect(result.changed).toBe(false);
        expect(result.state.revision).toBe(2);
        expect(nextCapabilityState(result.state, "shared", noop).state).toBe(result.state);
    });
});

describe("capability binding exact identity and access boundaries", () => {
    it("binds the exact requested package handler and server despite a private same-name shadow", async () => {
        const shared = source("shared", { tools: [tool("lookup", "shared handler")],
            mcp: { data: { type: "http", url: "https://shared.example", tools: ["read"] } } });
        const own = source("own", { owner: ALICE, tools: [tool("lookup", "private handler")],
            mcp: { data: { type: "http", url: "https://private.example", tools: ["write"] } } });
        const result = bindCapabilities([own, shared], ALICE, [select("shared", ["lookup"], ["data"])], [], {}, null, true);
        expect(await result.tools[0].handler()).toBe("shared handler");
        expect(result.mcpServers.data.url).toBe("https://shared.example");
    });

    it("fails private binding after an owner change without falling back to a shared namesake", () => {
        const sources = [source("own", { owner: ALICE }), source("shared")];
        expect(() => resolveCapabilitySource(sources, BOB, capabilityRef("own", "own-v1", "source"))).toThrow(/inaccessible/);
        expect(() => bindCapabilities(sources, BOB, [select("own", ["lookup"])], [], {}, null, true)).toThrow(/inaccessible/);
        expect(bindCapabilities(sources, null, [select("own", ["lookup"])], [], {}, null)).toMatchObject({ tools: [], unavailable: ["own"] });
    });

    it("rejects a stale source reference after a package update", () => {
        const original = source("shared");
        expect(() => resolveCapabilitySource([{ ...original, revision: "new-version" }], ALICE,
            capabilityRef("shared", original.revision, "source"))).toThrow(/changed/);
    });

    it("marks a persisted exact selection unavailable after a package update", () => {
        const original = source("shared");
        const selection = { ...select("shared", ["lookup"]),
            sourceRef: capabilityRef("shared", original.revision, "source") };
        const updated = { ...original, revision: "shared-v2" };
        expect(bindCapabilities([updated], ALICE, [selection], [], {}, null)).toMatchObject({
            tools: [], unavailable: ["shared"],
        });
        expect(() => bindCapabilities([updated], ALICE, [selection], [], {}, null, true)).toThrow(/changed|revision/i);
    });

    it("does not refresh remaining exports when removing through a newer source ref", () => {
        const oldRef = capabilityRef("shared", "shared-v1", "source");
        const attached = nextCapabilityState(empty(), "shared", request({
            source_ref: oldRef, tools: ["lookup", "second"],
        })).state;
        const removed = nextCapabilityState(attached, "shared", request({
            source_ref: capabilityRef("shared", "shared-v2", "source"), tools: ["lookup"],
            action: "remove", expected_revision: 1, request_id: "remove-new-ref",
        })).state;
        expect(removed.selections[0]).toMatchObject({ sourceRef: oldRef, tools: ["second"] });
    });

    it("does not partially attach a source when any selected export is unavailable", () => {
        const src = source("shared", { mcp: { good: { type: "http", url: "https://example.test" } } });
        const selections = [select("shared", ["lookup", "missing"], ["good"])];
        expect(() => bindCapabilities([src], ALICE, selections, [], {}, null, true)).toThrow(/unavailable/);
        expect(bindCapabilities([src], ALICE, selections, [], {}, null)).toMatchObject({ tools: [], mcpServers: {}, unavailable: ["shared"] });
        expect([...src.tools.keys()]).toEqual(["lookup"]);
    });

    it("rejects collisions with original tools and between selected sources", () => {
        const a = source("a"), b = source("b");
        expect(() => bindCapabilities([a], ALICE, [select("a", ["lookup"])], [tool("lookup")], {}, null, true)).toThrow(/collision/);
        expect(() => bindCapabilities([a, b], ALICE, [select("a", ["lookup"]), select("b", ["lookup"])], [], {}, null, true)).toThrow(/collision/);
    });

    it("rejects framework/native control exports regardless of source visibility", () => {
        for (const name of ["task", "use_package", "set_cluster_feature_flag"]) {
            const src = source("shared", { tools: [tool(name)] });
            expect(() => bindCapabilities([src], ALICE, [select("shared", [name])], [], {}, null, true)).toThrow(/reserved/);
        }
    });

    it("enforces deployment MCP identity and strips allowlist metadata from the bound config", () => {
        const cfg = { type: "http", url: "https://restricted.test", tools: ["read"], allowedAgents: ["ops:analyst"] };
        const src = source("static-ops", { mcp: { restricted: cfg } });
        const selection = [select(src.id, [], ["restricted"])];
        for (const agent of [null, { name: "analyst", namespace: "other" },
            { name: "analyst", namespace: "ops", packageId: "private", packageScope: "user" }]) {
            expect(() => bindCapabilities([src], ALICE, selection, [], {}, agent, true)).toThrow(/restricted/);
        }
        const result = bindCapabilities([src], ALICE, selection, [], {}, { name: "analyst", namespace: "ops" }, true);
        expect(result.mcpServers.restricted).toEqual({ type: "http", url: cfg.url, tools: ["read"] });
        expect(cfg.allowedAgents).toEqual(["ops:analyst"]);
    });

    it.each(["constructor", "toString", "__proto__"])("cannot bind an inherited MCP entry named %s", name => {
        const src = source("empty", { tools: [], mcp: {} });
        expect(() => bindCapabilities([src], ALICE, [select(src.id, [], [name])], [], {}, null, true)).toThrow(/unavailable|invalid|reserved/i);
    });
});
