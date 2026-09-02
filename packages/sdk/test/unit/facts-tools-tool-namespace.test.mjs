// `tools/` (and any host-reserved prefix) belongs to tools. The agent-facing
// fact tools refuse it for EVERY agent identity — the Facts Manager and the
// tuner included, which the older reserved prefixes exempt — and strip such
// rows from every read and search result.
import test from "node:test";
import assert from "node:assert/strict";
import { createFactTools, normalizeToolOnlyPrefixes, isToolOnlyFactKey } from "../../dist/facts-tools.js";

function fakeStore(rows = []) {
    const calls = { store: [], delete: [] };
    return {
        calls,
        async storeFact(input) {
            const inputs = Array.isArray(input) ? input : [input];
            calls.store.push(...inputs);
            const result = { stored: inputs.length, facts: inputs.map((i) => ({ key: i.key, shared: i.shared === true, stored: true })) };
            return Array.isArray(input) ? result : result.facts[0];
        },
        async readFacts() { return { count: rows.length, facts: rows }; },
        async deleteFact(input) { calls.delete.push(input); return input.pattern ? { keyPattern: input.key, scope: "session", deleted: 0 } : { key: input.key, shared: false, deleted: false }; },
    };
}

const CTX = { sessionId: "s1" };
const toolsFor = (store, agentIdentity, reservedFactPrefixes) => Object.fromEntries(
    createFactTools({ factStore: store, agentIdentity, reservedFactPrefixes }).map((t) => [t.name, t]),
);

for (const identity of ["task-agent", "facts-manager", "agent-tuner"]) {
    test(`${identity}: store_fact under tools/ is refused, with the tool-namespace message`, async () => {
        const store = fakeStore();
        const { store_fact } = toolsFor(store, identity);
        const out = await store_fact.handler({ key: "tools/proxy/binding", value: 1 }, CTX);
        // The tuner is read-only and its own refusal comes first; either way the
        // write is refused and nothing reaches the store.
        assert.match(String(out.error), identity === "agent-tuner" ? /read-only/ : /'tools\/' key namespace belongs to tools/);
        assert.equal(store.calls.store.length, 0, "nothing reached the store");
        const batch = await store_fact.handler({ facts: [{ key: "ok/a", value: 1 }, { key: "tools/x", value: 2 }] }, CTX);
        assert.match(String(batch.error), identity === "agent-tuner" ? /read-only/ : /belongs to tools/);
        assert.equal(store.calls.store.length, 0, "a batch is all-or-nothing");
    });

    test(`${identity}: read_facts refuses a pattern aimed at tools/ and strips tools/ rows from a broad read`, async () => {
        const rows = [
            { key: "tools/proxy/binding", value: 1, shared: false, sessionId: "s1" },
            { key: "notes/a", value: 2, shared: false, sessionId: "s1" },
        ];
        const { read_facts } = toolsFor(fakeStore(rows), identity);
        for (const pattern of ["tools/proxy/binding", "tools/*", "tools/%", "tools/proxy/*"]) {
            const out = await read_facts.handler({ key_pattern: pattern }, CTX);
            assert.match(String(out.error), /belongs to tools/, `pattern ${pattern}`);
        }
        const broad = await read_facts.handler({ key_pattern: "*" }, CTX);
        assert.equal(broad.error, undefined);
        assert.deepEqual(broad.facts.map((f) => f.key), ["notes/a"], "the tools/ row was stripped");
        assert.equal(broad.count, 1);
        const unfiltered = await read_facts.handler({}, CTX);
        assert.deepEqual(unfiltered.facts.map((f) => f.key), ["notes/a"]);
    });

    test(`${identity}: delete_fact refuses tools/ keys and any pattern that could touch them`, async () => {
        const store = fakeStore();
        const { delete_fact } = toolsFor(store, identity);
        const refusal = identity === "agent-tuner" ? /read-only/ : /belongs to tools/;
        const exact = await delete_fact.handler({ key: "tools/proxy/binding" }, CTX);
        assert.match(String(exact.error), refusal);
        for (const pattern of ["tools/*", "t*", "*"]) {
            const out = await delete_fact.handler({ key: pattern, pattern: true }, CTX);
            assert.match(String(out.error), refusal, `pattern ${pattern}`);
        }
        assert.equal(store.calls.delete.length, 0);
    });
}

test("the Facts Manager keeps its exemption on the OLD reserved prefixes (regression guard)", async () => {
    const store = fakeStore();
    const { store_fact } = toolsFor(store, "facts-manager");
    const out = await store_fact.handler({ key: "skills/x", value: 1 }, CTX);
    assert.equal(out.error, undefined, "skills/ is the Facts Manager's own namespace");
    assert.equal(store.calls.store.length, 1);
    const task = toolsFor(fakeStore(), "task-agent");
    const refused = await task.store_fact.handler({ key: "skills/x", value: 1 }, CTX);
    assert.match(String(refused.error), /reserved for the Facts Manager/);
});

test("a host-reserved prefix behaves exactly like tools/, for every identity", async () => {
    for (const identity of ["task-agent", "facts-manager"]) {
        const rows = [{ key: "bindings/svc", value: 1, shared: true }, { key: "notes/b", value: 2, shared: true }];
        const tools = toolsFor(fakeStore(rows), identity, ["bindings", "/x/"]);
        const w = await tools.store_fact.handler({ key: "bindings/svc", value: 1, shared: true }, CTX);
        assert.match(String(w.error), /'bindings\/' key namespace belongs to tools/);
        const w2 = await tools.store_fact.handler({ key: "x/y", value: 1 }, CTX);
        assert.match(String(w2.error), /'x\/' key namespace belongs to tools/, "a leading slash and a missing trailing slash are normalised");
        const r = await tools.read_facts.handler({ key_pattern: "*", scope: "shared" }, CTX);
        assert.deepEqual(r.facts.map((f) => f.key), ["notes/b"]);
    }
    assert.deepEqual(normalizeToolOnlyPrefixes(["bindings", "/x/", "", null]), ["tools/", "bindings/", "x/"]);
    // The check is per prefix set (never process-wide): pass the host's set.
    const hostSet = normalizeToolOnlyPrefixes(["x/"]);
    assert.equal(isToolOnlyFactKey("x/y", hostSet), true);
    assert.equal(isToolOnlyFactKey("x/y"), false, "the default set is tools/ only");
    assert.equal(isToolOnlyFactKey("xy/z", hostSet), false);
    assert.equal(isToolOnlyFactKey("tools/z"), true);
});

test("an unreserved key written by a tool is ordinary knowledge: agents read it", async () => {
    const rows = [{ key: "service/catalog", value: { n: 3 }, shared: true }];
    const { read_facts } = toolsFor(fakeStore(rows), "task-agent");
    const out = await read_facts.handler({ key_pattern: "service/*", scope: "shared" }, CTX);
    assert.deepEqual(out.facts.map((f) => f.key), ["service/catalog"]);
});

// ── Found by the adversarial pass ─────────────────────────────────────────

test("a backslash-escaped LIKE pattern cannot sneak past the tools/ check", async () => {
    // PostgreSQL LIKE: `tools\/%` matches every key under tools/ (backslash
    // escapes the slash), while its raw literal head `tools\/` matched no
    // prefix check. Unescaped before comparing now.
    const store = fakeStore([{ key: "tools/proxy/binding", value: 1 }, { key: "notes/a", value: 2 }]);
    const { delete_fact, read_facts } = toolsFor(store, "task-agent");
    for (const pattern of ["tools\\/%", "t\\o\\ols/%", "tools\\/proxy/*", "\\t%"]) {
        const out = await delete_fact.handler({ key: pattern, pattern: true }, CTX);
        assert.match(String(out.error), /belongs to tools/, `delete pattern ${pattern}`);
        const read = await read_facts.handler({ key_pattern: pattern }, CTX);
        assert.ok(read.error || !read.facts.some((f) => f.key.startsWith("tools/")), `read pattern ${pattern} leaked`);
    }
    assert.equal(store.calls.delete.length, 0);
});

test("bulk_store_facts refuses tools/ records, for the Facts Manager too", async () => {
    for (const identity of ["task-agent", "facts-manager"]) {
        const store = fakeStore();
        const { bulk_store_facts } = toolsFor(store, identity);
        const out = await bulk_store_facts.handler({ facts: [{ key: "ok/a", value: 1 }, { key: "tools/x", value: 2 }] }, CTX);
        const text = JSON.stringify(out);
        assert.match(text, /namespace_denied|belongs to tools/, `${identity}: ${text.slice(0, 200)}`);
        assert.ok(!store.calls.store.some((c) => c.key === "tools/x"), "the tools/ record never reached the store");
    }
});

test("facts_search and facts_similar refuse the tools namespace and strip tools/ rows, for every identity", async () => {
    for (const identity of ["task-agent", "facts-manager", "agent-tuner"]) {
        const rows = [{ key: "tools/proxy/binding", value: 1, scopeKey: "shared:tools/proxy/binding", score: 0.9 }, { key: "notes/a", value: 2, scopeKey: "shared:notes/a", score: 0.8 }];
        const enhanced = {
            capabilities: { search: true, embedder: false },
            async searchFacts() { return { count: rows.length, facts: rows }; },
            async similarFacts() { return { count: rows.length, facts: rows }; },
            async readFacts() { return { count: rows.length, facts: rows }; },
            async storeFact(i) { return { key: i.key, shared: false, stored: true }; },
            async deleteFact(i) { return { key: i.key, shared: false, deleted: false }; },
        };
        const tools = Object.fromEntries(createFactTools({ factStore: enhanced, enhancedFactStore: enhanced, agentIdentity: identity }).map((t) => [t.name, t]));
        assert.ok(tools.facts_search && tools.facts_similar, `${identity}: search tools registered`);
        for (const namespace of ["tools", "tools/", "tools/proxy"]) {
            const out = await tools.facts_search.handler({ query: "binding", namespace }, CTX);
            assert.match(String(out.error), /belongs to tools/, `${identity} search namespace ${namespace}`);
        }
        const broad = await tools.facts_search.handler({ query: "binding" }, CTX);
        assert.deepEqual((broad.facts || []).map((f) => f.key), ["notes/a"], `${identity}: search results stripped`);
        const similar = await tools.facts_similar.handler({ scopeKey: "shared:notes/a" }, CTX);
        assert.deepEqual((similar.facts || []).map((f) => f.key), ["notes/a"], `${identity}: similar results stripped`);
    }
});

test("the crawl queue (facts_read_uncrawled) never hands out tools/ rows", async () => {
    const { createGraphTools } = await import("../../dist/graph-tools.js");
    const rows = [
        { key: "tools/proxy/binding", value: 1, scopeKey: "session:s1:tools/proxy/binding", etag: 1 },
        { key: "notes/a", value: 2, scopeKey: "session:s1:notes/a", etag: 2 },
    ];
    const factStore = { async readUncrawledFacts() { return { count: rows.length, facts: rows }; } };
    for (const identity of ["facts-manager", "crawler"]) {
        const tools = Object.fromEntries(createGraphTools({ graphStore: {}, factStore, agentIdentity: identity, isCrawler: identity === "crawler" }).map((t) => [t.name, t]));
        assert.ok(tools.facts_read_uncrawled, `${identity} has the crawl queue`);
        const out = await tools.facts_read_uncrawled.handler({});
        assert.deepEqual(out.facts.map((f) => f.key), ["notes/a"]);
        assert.equal(out.count, 1);
        const refused = await tools.facts_read_uncrawled.handler({ keyPrefix: "tools/proxy" });
        assert.match(String(refused.error), /belongs to tools/);
    }
});

test("the prefix set is per createFactTools call, not process-wide", async () => {
    const host = toolsFor(fakeStore(), "task-agent", ["bindings/"]);
    const plain = toolsFor(fakeStore(), "task-agent");
    // The plain set was created AFTER the host one: the host's extra prefix
    // must still hold there, and must not leak into the plain one.
    const refused = await host.store_fact.handler({ key: "bindings/x", value: 1 }, CTX);
    assert.match(String(refused.error), /'bindings\/' key namespace belongs to tools/);
    const allowed = await plain.store_fact.handler({ key: "bindings/x", value: 1 }, CTX);
    assert.equal(allowed.error, undefined, "a worker without the option treats bindings/ as ordinary");
});
