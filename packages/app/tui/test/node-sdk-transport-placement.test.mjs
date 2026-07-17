import test from "node:test";
import assert from "node:assert/strict";
import { NodeSdkTransport } from "../src/node-sdk-transport.js";

function makeTransport({ currentUser } = {}) {
    const transport = new NodeSdkTransport({
        store: "sqlite::memory:",
        mode: "local",
        ...(currentUser ? { currentUser } : {}),
    });
    const calls = [];
    transport.mgmt = {
        placeSessionsInGroup: async (viewer, sessionIds, groupId) => {
            calls.push({ name: "placeSessionsInGroup", viewer, sessionIds, groupId });
            return sessionIds.map((id) => ({ rootSessionId: id, placed: true, reason: null }));
        },
        createSessionGroup: async (input) => {
            calls.push({ name: "createSessionGroup", input });
            return { groupId: "g1", ...input };
        },
    };
    return { transport, calls };
}

test("placeSessionsInGroup derives the viewer from the transport's current user", async () => {
    const { transport, calls } = makeTransport();
    const results = await transport.placeSessionsInGroup(["a", "b"], "g1");
    assert.equal(results.length, 2);
    assert.equal(calls[0].name, "placeSessionsInGroup");
    // Local TUI default principal, with isAdmin (direct mode has no
    // ownership enforcement, so every live session is readable).
    assert.equal(calls[0].viewer.provider, "local");
    assert.equal(calls[0].viewer.subject, "default");
    assert.equal(calls[0].viewer.isAdmin, true);
    assert.deepEqual(calls[0].sessionIds, ["a", "b"]);
    assert.equal(calls[0].groupId, "g1");
});

test("placeSessionsInGroup honors an explicit viewer and normalizes ungroup", async () => {
    const { transport, calls } = makeTransport({ currentUser: { provider: "dev", subject: "alice" } });
    await transport.placeSessionsInGroup(["a"], undefined, { provider: "dev", subject: "bob" });
    assert.equal(calls[0].viewer.provider, "dev");
    assert.equal(calls[0].viewer.subject, "bob");
    assert.equal(calls[0].groupId, null);

    await transport.placeSessionsInGroup(["a"], "g2");
    assert.equal(calls[1].viewer.subject, "alice", "falls back to the transport's current user");
});

test("createSessionGroup stamps the current user as owner when the key is omitted", async () => {
    const { transport, calls } = makeTransport({ currentUser: { provider: "dev", subject: "alice" } });
    await transport.createSessionGroup({ title: "Mine" });
    assert.equal(calls[0].input.owner.provider, "dev");
    assert.equal(calls[0].input.owner.subject, "alice");

    const explicit = { provider: "dev", subject: "carol", email: null, displayName: null };
    await transport.createSessionGroup({ title: "Hers", owner: explicit });
    assert.deepEqual(calls[1].input.owner, explicit, "an explicit owner (portal runtime) is preserved");

    await transport.createSessionGroup({ title: "Anon", owner: null });
    assert.equal(calls[2].input.owner, null, "an explicit null owner (portal runtime, anonymous) passes through");
});
