/**
 * Direct-parity shims: the direct client's positional signatures, verified
 * against the exact wire calls they must produce (pure, no network).
 *
 * `new PilotSwarmManagementClient({ apiUrl })` returns the web client under
 * the direct client's TYPE. The compile-time proof
 * (_WebSatisfiesManagementSurface) guarantees every direct method EXISTS on
 * the web client; these tests guarantee each shim also maps its positional
 * arguments onto the right operation and wire params — the mapping mirrors
 * the web fact/graph stores, which exercised these shapes in production.
 *
 * A wrong mapping here is the exact bug class this layer exists to kill:
 * `placeSessionsInGroup(viewer, ids, gid)` used to send the viewer object as
 * the sessionIds array, silently.
 *
 * Run: node --test test/unit/web-client-shims.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";

import { WebPilotSwarmManagementClient } from "../../dist/web/web-management-client.js";
import { createManagementOps } from "../../dist/web/generated-op-methods.js";
import { WEB_MODE_UNSUPPORTED } from "../../api/src/protocol.js";

function clientWithFakeApi() {
    const client = Object.create(WebPilotSwarmManagementClient.prototype);
    const calls = [];
    client._api = { call: async (name, params) => { calls.push({ name, params }); return "ok"; } };
    Object.defineProperty(client, "ops", {
        value: createManagementOps((name, params) => client._api.call(name, params)),
    });
    return { client, calls };
}

const USER = { provider: "entra", subject: "u1" };

/**
 * One row per shim: positional invocation → expected (op, wire params).
 * `undefined` values are asserted verbatim — buildOperationRequest drops
 * them at request time, so the shape here is what the shim itself emits.
 */
const SHIM_CASES = [
    // — facts —
    { call: (c) => c.readFacts({ keyPattern: "k*", scope: "shared" }), op: "readFacts", params: { keyPattern: "k*", scope: "shared" } },
    { call: (c) => c.storeFact({ key: "k", value: 1 }), op: "storeFact", params: { input: { key: "k", value: 1 } } },
    { call: (c) => c.deleteFact({ key: "k" }), op: "deleteFact", params: { input: { key: "k" } } },
    { call: (c) => c.searchFacts("q", { limit: 5 }), op: "searchFacts", params: { query: "q", opts: { limit: 5 } } },
    { call: (c) => c.similarFacts("scope-1", { limit: 3 }), op: "similarFacts", params: { scopeKey: "scope-1", opts: { limit: 3 } } },
    { call: (c) => c.forcePurgeFacts({ olderThanDays: 7 }), op: "forcePurgeFacts", params: { input: { olderThanDays: 7 } } },
    // — embedder —
    { call: (c) => c.getEmbedderStatus(), op: "getEmbedderStatus", params: {} },
    { call: (c) => c.startEmbedder({ intervalSeconds: 60, batch: 10 }), op: "startFactsEmbedder", params: { intervalSeconds: 60, batch: 10 } },
    { call: (c) => c.stopEmbedder("done"), op: "stopFactsEmbedder", params: { reason: "done" } },
    // — graph —
    { call: (c) => c.searchGraphNodes({ text: "x" }), op: "searchGraphNodes", params: { query: { text: "x" } } },
    { call: (c) => c.searchGraphEdges({ text: "y" }), op: "searchGraphEdges", params: { query: { text: "y" } } },
    { call: (c) => c.graphNeighbourhood("n1", 2, { namespace: "ns" }), op: "graphNeighbourhood", params: { nodeKey: "n1", depth: 2, namespace: "ns" } },
    { call: (c) => c.upsertGraphNode({ key: "n1" }), op: "upsertGraphNode", params: { input: { key: "n1" } } },
    { call: (c) => c.upsertGraphEdge({ from: "a", to: "b" }), op: "upsertGraphEdge", params: { input: { from: "a", to: "b" } } },
    { call: (c) => c.deleteGraphNode("n1", { namespace: "ns" }), op: "deleteGraphNode", params: { nodeKey: "n1", namespace: "ns" } },
    { call: (c) => c.deleteGraphEdge("a", "b", "p", { namespace: "ns" }), op: "deleteGraphEdge", params: { fromKey: "a", toKey: "b", predicateKey: "p", namespace: "ns" } },
    { call: (c) => c.graphStats({ namespace: "ns" }), op: "graphStats", params: { namespace: "ns" } },
    { call: (c) => c.listGraphNamespaces({ prefix: "p", includeArchived: true, includeDetails: false }), op: "listGraphNamespaces", params: { prefix: "p", includeArchived: true, includeDetails: false } },
    { call: (c) => c.getGraphNamespace("ns"), op: "getGraphNamespace", params: { namespace: "ns" } },
    { call: (c) => c.upsertGraphNamespace({ namespace: "ns" }), op: "upsertGraphNamespace", params: { input: { namespace: "ns" } } },
    { call: (c) => c.deleteGraphNamespace("ns"), op: "deleteGraphNamespace", params: { namespace: "ns" } },
    // — session sharing / authz —
    { call: (c) => c.getSessionAccess("s1", USER), op: "getSessionAccess", params: { sessionId: "s1" } },
    { call: (c) => c.setSessionVisibility("s1", "shared_read"), op: "setSessionVisibility", params: { sessionId: "s1", visibility: "shared_read" } },
    { call: (c) => c.grantSessionShare("s1", USER, "read", { provider: "entra", subject: "granter" }), op: "grantSessionShare", params: { sessionId: "s1", user: USER, access: "read" } },
    { call: (c) => c.revokeSessionShare("s1", USER), op: "revokeSessionShare", params: { sessionId: "s1", user: USER } },
    { call: (c) => c.listSessionShares("s1"), op: "listSessionShares", params: { sessionId: "s1" } },
    { call: (c) => c.listKnownUsers({ limit: 10 }), op: "listKnownUsers", params: { limit: 10 } },
    { call: (c) => c.listAuthzAudit({ limit: 5, sessionId: "s1" }), op: "listAuthzAudit", params: { limit: 5, sessionId: "s1" } },
];

test("every shim maps its positional arguments onto the right wire call", async () => {
    for (const { call, op, params } of SHIM_CASES) {
        const { client, calls } = clientWithFakeApi();
        await call(client);
        assert.equal(calls.length, 1, `${op}: expected exactly one wire call`);
        assert.equal(calls[0].name, op, `expected op ${op}, got ${calls[0].name}`);
        assert.deepEqual(calls[0].params, params, `${op}: wrong wire params`);
    }
});

test("placeSessionsInGroup accepts both calling conventions", async () => {
    const { client, calls } = clientWithFakeApi();

    // web/transport shape: (sessionIds, groupId)
    await client.placeSessionsInGroup(["s1", "s2"], "g1");
    // direct shape: (viewer, sessionIds, groupId) — viewer dropped, server derives it
    await client.placeSessionsInGroup(USER, ["s3"], null);

    assert.deepEqual(calls, [
        { name: "placeSessionsInGroup", params: { groupId: "g1", sessionIds: ["s1", "s2"] } },
        { name: "placeSessionsInGroup", params: { groupId: null, sessionIds: ["s3"] } },
    ]);
});

test("direct-only plumbing refuses loudly with WEB_MODE_UNSUPPORTED", () => {
    const { client } = clientWithFakeApi();
    for (const method of [
        "factsCapabilities",
        "listSessionsVisible",
        "recordAuthzAudit",
        "dumpSession",
        "sendCommand",
        "getCommandResponse",
        "listGroupSessions",
        "normalizeModel",
        "getModelCredentialStatus",
    ]) {
        assert.throws(
            () => client[method](),
            (error) => error?.code === WEB_MODE_UNSUPPORTED,
            `${method} should throw a typed WEB_MODE_UNSUPPORTED error`,
        );
    }
});
