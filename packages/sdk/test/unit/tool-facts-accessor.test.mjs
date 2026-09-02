// The facts accessor a worker-registered tool receives as `invocation.facts`.
//
// WHY THESE EXIST: the proposal (docs/proposals/tool-context-facts-accessor.md)
// had three defects in its first draft, and each is pinned here:
//   1. reads must be EXACT — a LIKE pattern would let `a_b` match `aXb`
//   2. every call is bound to exactly one of three scopes; a tool can never
//      name an arbitrary session
//   3. delete exists, so a dead binding can be dropped and re-bound
import test from "node:test";
import assert from "node:assert/strict";
import { createToolFactsAccessor, TOOL_PRIVATE_FACT_PREFIX } from "../../dist/tool-facts-accessor.js";

/** A FactStore fake that records calls and serves a tiny in-memory map by scope key. */
function fakeStore() {
    const rows = new Map();
    const calls = { read: [], store: [], delete: [] };
    const scopeKey = (key, shared, sessionId) => (shared ? `shared:${key}` : `session:${sessionId}:${key}`);
    return {
        rows, calls,
        async readFacts(query, access) {
            calls.read.push({ query, access });
            const facts = (query.scopeKeys || []).map((k) => rows.get(k)).filter(Boolean);
            return { count: facts.length, facts };
        },
        async storeFact(input) {
            calls.store.push(input);
            const sk = scopeKey(input.key, input.shared === true, input.sessionId);
            rows.set(sk, { key: input.key, value: input.value, shared: input.shared === true, sessionId: input.sessionId, agentId: input.agentId ?? null });
            return { key: input.key, shared: input.shared === true, stored: true };
        },
        async deleteFact(input) {
            calls.delete.push(input);
            const sk = scopeKey(input.key, input.shared === true, input.sessionId);
            const had = rows.delete(sk);
            return { key: input.key, shared: input.shared === true, deleted: had };
        },
    };
}

const accessorFor = (store, extra = {}) => createToolFactsAccessor({
    factStore: store, durableSessionId: "child-1", rootSessionId: "root-1", agentId: "proxy-tool", ...extra,
});

test("reads are exact: a key with an underscore does not match its LIKE-wildcard cousin", async () => {
    const store = fakeStore();
    const facts = accessorFor(store);
    await facts.store("tools/svc/a_b", { real: true });
    await facts.store("tools/svc/aXb", { decoy: true });
    assert.deepEqual(await facts.read("tools/svc/a_b"), { real: true });
    const [call] = store.calls.read;
    assert.deepEqual(call.query.scopeKeys, ["session:child-1:tools/svc/a_b"], "read by scope key, never keyPattern");
    assert.equal(call.query.keyPattern, undefined);
    assert.equal(call.query.limit, 1);
    assert.equal(call.access.readerSessionId, "child-1");
});

test("an absent key reads as null", async () => {
    const facts = accessorFor(fakeStore());
    assert.equal(await facts.read("tools/svc/missing"), null);
});

test("the three scopes bind to exactly session, root, or shared, and nothing else", async () => {
    const store = fakeStore();
    const facts = accessorFor(store);
    assert.equal(facts.durableSessionId, "child-1");
    assert.equal(facts.rootSessionId, "root-1");
    await facts.store("k", 1);
    await facts.store("k", 2, { scope: "root" });
    await facts.store("k", 3, { scope: "shared" });
    assert.deepEqual([...store.rows.keys()].sort(), ["session:child-1:k", "session:root-1:k", "shared:k"]);
    assert.equal(await facts.read("k"), 1);
    assert.equal(await facts.read("k", { scope: "root" }), 2);
    assert.equal(await facts.read("k", { scope: "shared" }), 3);
    // A sibling in the same tree sees the root and shared rows, not the session one.
    const sibling = createToolFactsAccessor({ factStore: store, durableSessionId: "child-2", rootSessionId: "root-1" });
    assert.equal(await sibling.read("k"), null);
    assert.equal(await sibling.read("k", { scope: "root" }), 2);
    assert.equal(await sibling.read("k", { scope: "shared" }), 3);
    await assert.rejects(() => facts.read("k", { scope: "other-session" }), /unknown scope/);
    // Shared rows are real shared facts; session rows are session-bound with provenance.
    const shared = store.calls.store.find((c) => c.shared === true);
    assert.equal(shared.agentId, "proxy-tool");
    const session = store.calls.store.find((c) => c.shared !== true && c.sessionId === "child-1");
    assert.equal(session.agentId, "proxy-tool");
});

test("delete removes the exact key in its scope and reports whether a row went", async () => {
    const store = fakeStore();
    const facts = accessorFor(store);
    await facts.store("tools/svc/binding", { id: 1 });
    await facts.store("tools/svc/binding", { id: 2 }, { scope: "shared" });
    assert.equal(await facts.delete("tools/svc/binding"), true);
    assert.equal(await facts.delete("tools/svc/binding"), false, "already gone");
    assert.equal(await facts.read("tools/svc/binding"), null);
    assert.deepEqual(await facts.read("tools/svc/binding", { scope: "shared" }), { id: 2 }, "the shared row is untouched");
    assert.equal(store.calls.delete[0].pattern, false, "never a pattern delete");
});

test("a top-level session is its own root; a blank key is refused", async () => {
    const store = fakeStore();
    const top = createToolFactsAccessor({ factStore: store, durableSessionId: "top" });
    assert.equal(top.rootSessionId, "top");
    await assert.rejects(() => top.read("   "), /non-empty/);
    assert.equal(TOOL_PRIVATE_FACT_PREFIX, "tools/");
});
