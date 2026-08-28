import assert from "node:assert/strict";
import test from "node:test";
import { delegatedMcpAuthFingerprint } from "../../dist/session-manager.js";

test("credential rotation changes the MCP auth fingerprint", () => {
    const first = delegatedMcpAuthFingerprint({
        remote: {
            headers: { Authorization: "Bearer token-one" },
        },
        local: {
            command: "node",
            env: { STATIC: "same", ACCESS_TOKEN: "token-one" },
        },
    });
    const second = delegatedMcpAuthFingerprint({
        local: {
            command: "node",
            env: { ACCESS_TOKEN: "token-two", STATIC: "same" },
        },
        remote: {
            headers: { Authorization: "Bearer token-two" },
        },
    });

    assert.notEqual(first, second);
    assert.equal(first.length, 64);
    assert.ok(!first.includes("token-one"));
});

test("object ordering does not change the MCP auth fingerprint", () => {
    const first = delegatedMcpAuthFingerprint({
        serverB: { env: { B: "two", A: "one" } },
        serverA: { headers: { Authorization: "Bearer stable" } },
    });
    const second = delegatedMcpAuthFingerprint({
        serverA: { headers: { Authorization: "Bearer stable" } },
        serverB: { env: { A: "one", B: "two" } },
    });

    assert.equal(first, second);
});
