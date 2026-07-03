/**
 * Web fact/graph store unit tests.
 *
 * The Web* stores implement the SDK's FactStore / EnhancedFactStore / GraphStore
 * interfaces over an ApiClient. These tests pin the client half deterministically
 * with a spy ApiClient — no server, no database:
 *   - createWebFactStore / createWebGraphStore branch correctly on capabilities
 *   - each method maps to the right operation name and param shape on the wire
 *   - in-cluster-only methods throw the documented capability errors
 *
 * The server half (real store round-trip, capability 409s) is covered by
 * webapi-e2e.test.js; access-control scoping by facts-access-control.test.js.
 *
 * Run: npx vitest run test/local/web-stores.test.js
 */

import { describe, it } from "vitest";
import { assert, assertEqual } from "../helpers/assertions.js";
import {
    WebFactStore,
    WebEnhancedFactStore,
    WebGraphStore,
    createWebFactStore,
    createWebGraphStore,
    isEnhancedFactStore,
    isGraphStore,
    EnhancedFactsUnsupportedError,
} from "pilotswarm-sdk";

/** A spy ApiClient: records every call and returns a canned result per op. */
function spyApi(responses = {}) {
    const calls = [];
    return {
        calls,
        last() {
            return calls[calls.length - 1];
        },
        call(name, params) {
            calls.push({ name, params });
            const r = responses[name];
            return Promise.resolve(typeof r === "function" ? r(params) : r);
        },
    };
}

/** Assert the most recent api.call matched (name, params). */
function assertCall(api, name, params, label) {
    const last = api.last();
    assertEqual(last.name, name, `${label}: op name`);
    assertEqual(JSON.stringify(last.params), JSON.stringify(params), `${label}: params`);
}

async function expectCode(fn, code, label) {
    try {
        await fn();
        assert(false, `${label}: expected throw with code ${code}`);
    } catch (error) {
        assertEqual(error?.code, code, `${label}: error code`);
    }
}

// Base-store methods for enhanced/crawler machinery throw EnhancedFactsUnsupportedError
// (the .code = "FACTS_ENHANCED_UNSUPPORTED" is applied at the HTTP boundary, not here).
async function expectEnhancedUnsupported(fn, label) {
    try {
        await fn();
        assert(false, `${label}: expected EnhancedFactsUnsupportedError`);
    } catch (error) {
        assert(
            error instanceof EnhancedFactsUnsupportedError || error?.name === "EnhancedFactsUnsupportedError",
            `${label}: expected EnhancedFactsUnsupportedError, got ${error?.name}: ${error?.message}`,
        );
    }
}

describe("web fact store (unit)", () => {
    it("createWebFactStore returns a base store when search is unsupported", async () => {
        const api = spyApi({ factsCapabilities: { search: false, embedder: false, graph: false } });
        const store = await createWebFactStore(api);
        assert(store instanceof WebFactStore, "is a WebFactStore");
        assert(!(store instanceof WebEnhancedFactStore), "not enhanced");
        assertEqual(isEnhancedFactStore(store), false, "isEnhancedFactStore false on base");
        assertEqual(api.last().name, "factsCapabilities", "reads capabilities first");
    });

    it("createWebFactStore returns an enhanced store when search is advertised", async () => {
        const api = spyApi({ factsCapabilities: { search: true, embedder: true, graph: false } });
        const store = await createWebFactStore(api);
        assert(store instanceof WebEnhancedFactStore, "is a WebEnhancedFactStore");
        assertEqual(isEnhancedFactStore(store), true, "isEnhancedFactStore true");
        assertEqual(store.capabilities.search, true, "capabilities.search");
        assertEqual(store.capabilities.embedder, true, "capabilities.embedder");
    });

    it("maps base data-plane methods to operations", async () => {
        const api = spyApi();
        const store = new WebFactStore(api);

        await store.storeFact({ key: "k", value: 1, shared: true });
        assertCall(api, "storeFact", { input: { key: "k", value: 1, shared: true } }, "storeFact");

        await store.storeFact([{ key: "a", value: 1 }, { key: "b", value: 2 }]);
        assertCall(api, "storeFact", { input: [{ key: "a", value: 1 }, { key: "b", value: 2 }] }, "storeFact batch");

        // readFacts spreads the query (not wrapped) so it becomes GET query params.
        await store.readFacts({ keyPattern: "a/%", scope: "shared", limit: 25 });
        assertCall(api, "readFacts", { keyPattern: "a/%", scope: "shared", limit: 25 }, "readFacts");

        await store.deleteFact({ key: "a/%", pattern: true, scope: "shared" });
        assertCall(api, "deleteFact", { input: { key: "a/%", pattern: true, scope: "shared" } }, "deleteFact");

        await store.forcePurgeFacts({ cutoff: "2020-01-01" });
        assertCall(api, "forcePurgeFacts", { input: { cutoff: "2020-01-01" } }, "forcePurgeFacts");
    });

    it("throws EnhancedFactsUnsupported for in-cluster crawler machinery", async () => {
        const store = new WebFactStore(spyApi());
        for (const fn of [
            () => store.readUncrawledFacts(),
            () => store.setFactsCrawled({ scopeKeys: [] }),
            () => store.purgeExpiredFacts(),
            () => store.deleteSessionFactsForSession("s"),
            () => store.getFactsStatsForSessions(["s"]),
        ]) {
            await expectEnhancedUnsupported(fn, "crawler method");
        }
    });

    it("maps enhanced methods to operations and blocks configureEmbedder", async () => {
        const api = spyApi();
        const store = new WebEnhancedFactStore(api, { search: true, embedder: true });

        await store.searchFacts("rollback", { limit: 5 });
        assertCall(api, "searchFacts", { query: "rollback", opts: { limit: 5 } }, "searchFacts");

        await store.similarFacts("shared:runbooks/deploy", { limit: 3 });
        assertCall(api, "similarFacts", { scopeKey: "shared:runbooks/deploy", opts: { limit: 3 } }, "similarFacts");

        await store.startEmbedder({ intervalSeconds: 10, batch: 20 });
        assertCall(api, "startFactsEmbedder", { intervalSeconds: 10, batch: 20 }, "startEmbedder");

        await store.stopEmbedder("done");
        assertCall(api, "stopFactsEmbedder", { reason: "done" }, "stopEmbedder");

        // configureEmbedder carries an embedding endpoint (secrets) — not exposed.
        await expectEnhancedUnsupported(() => store.configureEmbedder({}), "configureEmbedder");
    });
});

describe("web graph store (unit)", () => {
    it("createWebGraphStore returns null without a graph store", async () => {
        const api = spyApi({ factsCapabilities: { search: false, embedder: false, graph: false } });
        const store = await createWebGraphStore(api);
        assertEqual(store, null, "no graph → null");
    });

    it("createWebGraphStore returns a WebGraphStore when graph is advertised", async () => {
        const api = spyApi({ factsCapabilities: { search: false, embedder: false, graph: true } });
        const store = await createWebGraphStore(api);
        assert(store instanceof WebGraphStore, "is a WebGraphStore");
        assertEqual(isGraphStore(store), true, "isGraphStore true");
    });

    it("maps graph methods to operations", async () => {
        const api = spyApi();
        const store = new WebGraphStore(api);

        await store.searchGraphNodes({ nameLike: "pay" });
        assertCall(api, "searchGraphNodes", { query: { nameLike: "pay" } }, "searchGraphNodes");

        await store.searchGraphEdges({ predicate: "calls" });
        assertCall(api, "searchGraphEdges", { query: { predicate: "calls" } }, "searchGraphEdges");

        await store.upsertGraphNode({ kind: "service", name: "payments", agentId: "app" });
        assertCall(api, "upsertGraphNode", { input: { kind: "service", name: "payments", agentId: "app" } }, "upsertGraphNode");

        await store.upsertGraphEdge({ fromKey: "n1", toKey: "n2", predicate: "calls", agentId: "app" });
        assertCall(api, "upsertGraphEdge", { input: { fromKey: "n1", toKey: "n2", predicate: "calls", agentId: "app" } }, "upsertGraphEdge");

        await store.graphNeighbourhood("n1", 2, undefined, { namespace: "corpus/acme" });
        assertCall(api, "graphNeighbourhood", { nodeKey: "n1", depth: 2, namespace: "corpus/acme" }, "graphNeighbourhood");

        await store.deleteGraphNode("n1", { namespace: "corpus/acme" });
        assertCall(api, "deleteGraphNode", { nodeKey: "n1", namespace: "corpus/acme" }, "deleteGraphNode");

        await store.graphStats({ namespace: "corpus/acme" });
        assertCall(api, "graphStats", { namespace: "corpus/acme" }, "graphStats");

        await store.upsertGraphNamespace({ namespace: "corpus/acme" });
        assertCall(api, "upsertGraphNamespace", { input: { namespace: "corpus/acme" } }, "upsertGraphNamespace");
    });

    it("throws GRAPH_UNSUPPORTED for in-cluster reconciliation machinery", async () => {
        const store = new WebGraphStore(spyApi());
        await expectCode(() => store.mergeGraphNodes(), "GRAPH_UNSUPPORTED", "mergeGraphNodes");
        await expectCode(() => store.removeGraphEvidence(), "GRAPH_UNSUPPORTED", "removeGraphEvidence");
    });
});
