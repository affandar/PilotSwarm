import test from "node:test";
import assert from "node:assert/strict";
import {
    API_PREFIX,
    OPERATIONS,
    buildOperationRequest,
    coerceQueryValue,
    getOperation,
    artifactDownloadPath,
} from "../src/protocol.js";

test("operation names and method+path pairs are unique", () => {
    const names = new Set();
    const routes = new Set();
    for (const op of OPERATIONS) {
        assert.ok(!names.has(op.name), `duplicate operation name: ${op.name}`);
        names.add(op.name);
        const route = `${op.method} ${op.path}`;
        assert.ok(!routes.has(route), `duplicate route: ${route}`);
        routes.add(route);
    }
});

test("every path param has a matching :segment and vice versa", () => {
    for (const op of OPERATIONS) {
        const templateParams = [...op.path.matchAll(/:([\w]+)/g)].map((m) => m[1]);
        const declaredPathParams = Object.entries(op.params || {})
            .filter(([, spec]) => spec.in === "path")
            .map(([key, spec]) => spec.name || key);
        assert.deepEqual(
            [...templateParams].sort(),
            [...declaredPathParams].sort(),
            `path params mismatch for ${op.name} (${op.path})`,
        );
    }
});

test("GET/DELETE operations carry no body params", () => {
    for (const op of OPERATIONS) {
        if (op.method !== "GET" && op.method !== "DELETE") continue;
        const bodyParams = Object.entries(op.params || {}).filter(([, spec]) => spec.in === "body");
        assert.equal(bodyParams.length, 0, `${op.name} is ${op.method} but declares body params`);
    }
});

test("buildOperationRequest resolves path, query, and body placement", () => {
    const { method, path, query, body } = buildOperationRequest("getSessionEvents", {
        sessionId: "abc/123",
        afterSeq: 5,
        limit: 50,
    });
    assert.equal(method, "GET");
    assert.equal(path, `${API_PREFIX}/management/sessions/abc%2F123/events`);
    assert.equal(query.get("afterSeq"), "5");
    assert.equal(query.get("limit"), "50");
    assert.equal(body, null);

    const send = buildOperationRequest("sendMessage", {
        sessionId: "s1",
        prompt: "hello",
        options: { clientMessageIds: ["m1"] },
    });
    assert.equal(send.method, "POST");
    assert.equal(send.path, `${API_PREFIX}/sessions/s1/messages`);
    assert.deepEqual(send.body, { prompt: "hello", options: { clientMessageIds: ["m1"] } });
});

test("json query params round-trip through encode + coerce", () => {
    const cursor = { updatedAt: 1751500000000, sessionId: "abc" };
    const { query } = buildOperationRequest("listSessionsPage", { limit: 10, cursor, includeDeleted: true });
    assert.deepEqual(coerceQueryValue(query.get("cursor"), "json"), cursor);
    assert.equal(coerceQueryValue(query.get("limit"), "number"), 10);
    assert.equal(coerceQueryValue(query.get("includeDeleted"), "boolean"), true);
});

test("missing required path params throw", () => {
    assert.throws(() => buildOperationRequest("getSession", {}), /requires param 'sessionId'/);
    assert.throws(() => buildOperationRequest("nonexistentOp", {}), /Unknown API operation/);
});

test("null body values are preserved (github copilot key clear)", () => {
    const { body } = buildOperationRequest("setCurrentUserGitHubCopilotKey", { key: null });
    assert.deepEqual(body, { key: null });
});

test("moveSessionsToGroup carries nullable groupId in body", () => {
    const { body } = buildOperationRequest("moveSessionsToGroup", { groupId: null, sessionIds: ["a"] });
    assert.deepEqual(body, { groupId: null, sessionIds: ["a"] });
});

test("coerceQueryValue rejects malformed json", () => {
    assert.throws(() => coerceQueryValue("{nope", "json"), /Malformed JSON/);
});

test("artifactDownloadPath encodes segments", () => {
    assert.equal(
        artifactDownloadPath("s 1", "a/b.txt"),
        `${API_PREFIX}/sessions/s%201/artifacts/a%2Fb.txt/download`,
    );
});

test("getOperation returns the table entry", () => {
    assert.equal(getOperation("listSessions").method, "GET");
    assert.equal(getOperation("missing"), null);
});
