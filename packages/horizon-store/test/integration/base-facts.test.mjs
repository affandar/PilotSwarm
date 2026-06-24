// §2.1 Base FactStore regression (B1–B7) — drop-in parity + scopeKeys.

import { describe, it, beforeAll, afterAll } from "vitest";
import assert from "node:assert/strict";
import { HAS_DB, makeStore, dropSchemaAndGraph, aclOf } from "./_db.mjs";

describe.skipIf(!HAS_DB)("base facts (B1–B7)", () => {
    let store, schema, graph;

    beforeAll(async () => {
        ({ store, schema, graph } = await makeStore({ tag: "base" }));
    });
    afterAll(async () => {
        await store?.close();
        if (schema) await dropSchemaAndGraph(schema, graph);
    });

    it("B1 store + read shared fact round-trips with shared: scope_key", async () => {
        const res = await store.storeFact({ key: "skills/b1", value: { name: "b1" }, shared: true, agentId: "a1" });
        assert.deepEqual(res, { key: "skills/b1", shared: true, stored: true });
        const { facts } = await store.readFacts({ keyPattern: "skills/b1" }, aclOf(null, [], true));
        assert.equal(facts.length, 1);
        assert.equal(facts[0].scopeKey, "shared:skills/b1");
        assert.equal(facts[0].shared, true);
        assert.deepEqual(facts[0].value, { name: "b1" });
    });

    it("B2 session fact requires sessionId; session: scope_key", async () => {
        await assert.rejects(() => store.storeFact({ key: "notes/b2", value: 1 }), /sessionId/);
        await store.storeFact({ key: "notes/b2", value: { v: 2 }, sessionId: "S1" });
        const { facts } = await store.readFacts({ keyPattern: "notes/b2", scope: "session" }, aclOf("S1"));
        assert.equal(facts.length, 1);
        assert.equal(facts[0].scopeKey, "session:S1:notes/b2");
    });

    it("B3 delete fact: deleted true, gone on re-read", async () => {
        await store.storeFact({ key: "skills/b3", value: 1, shared: true });
        const del = await store.deleteFact({ key: "skills/b3", shared: true });
        assert.equal(del.deleted, true);
        const again = await store.deleteFact({ key: "skills/b3", shared: true });
        assert.equal(again.deleted, false);
        const { count } = await store.readFacts({ keyPattern: "skills/b3" }, aclOf(null, [], true));
        assert.equal(count, 0);
    });

    it("B4 deleteSessionFactsForSession removes only that session's non-shared facts", async () => {
        await store.storeFact({ key: "notes/b4a", value: 1, sessionId: "SB4" });
        await store.storeFact({ key: "notes/b4b", value: 2, sessionId: "SB4" });
        await store.storeFact({ key: "notes/b4c", value: 3, sessionId: "SB4-other" });
        await store.storeFact({ key: "skills/b4shared", value: 4, shared: true });
        const n = await store.deleteSessionFactsForSession("SB4");
        assert.equal(n, 2);
        const rest = await store.readFacts({ keyPattern: "%b4%" }, aclOf(null, [], true));
        const keys = rest.facts.map((f) => f.key).sort();
        assert.deepEqual(keys, ["notes/b4c", "skills/b4shared"]);
    });

    it("B5 stats buckets: namespace bucketing and byte counts", async () => {
        await store.storeFact({ key: "skills/b5", value: { pad: "x".repeat(10) }, sessionId: "SB5" });
        await store.storeFact({ key: "asks/b5", value: { pad: "y".repeat(20) }, sessionId: "SB5" });
        await store.storeFact({ key: "misc/b5", value: 1, sessionId: "SB5" });
        const rows = await store.getSessionFactsStats("SB5");
        const byNs = Object.fromEntries(rows.map((r) => [r.namespace, r]));
        assert.equal(byNs["skills"].factCount, 1);
        assert.equal(byNs["asks"].factCount, 1);
        assert.equal(byNs["(other)"].factCount, 1);
        assert.ok(byNs["asks"].totalValueBytes > byNs["skills"].totalValueBytes);
        const shared = await store.getSharedFactsStats();
        assert.ok(Array.isArray(shared));

        // multi-session aggregation (spawn-tree stats)
        await store.storeFact({ key: "skills/b5-sib", value: { pad: "z".repeat(5) }, sessionId: "SB5-sib" });
        const tree = await store.getFactsStatsForSessions(["SB5", "SB5-sib"]);
        const skills = tree.find((r) => r.namespace === "skills");
        assert.equal(skills.factCount, 2, "aggregates across the session array");
    });

    it("B6 readFacts({scopeKeys}) returns exactly the accessible subset, with scopeKey exposed", async () => {
        await store.storeFact({ key: "skills/b6", value: 1, shared: true });
        await store.storeFact({ key: "notes/b6", value: 2, sessionId: "SB6" });
        await store.storeFact({ key: "notes/b6x", value: 3, sessionId: "SB6-other" });
        const wanted = ["shared:skills/b6", "session:SB6:notes/b6", "session:SB6-other:notes/b6x", "shared:does/not-exist"];
        const { facts } = await store.readFacts({ scopeKeys: wanted }, aclOf("SB6"));
        const got = facts.map((f) => f.scopeKey).sort();
        assert.deepEqual(got, ["session:SB6:notes/b6", "shared:skills/b6"]);
    });

    it("B7 (neg) inaccessible/unknown scopeKeys silently omitted, not an error", async () => {
        const { count } = await store.readFacts(
            { scopeKeys: ["session:SOMEONE-ELSE:notes/zzz", "shared:never/was"] }, aclOf("SB7"));
        assert.equal(count, 0);
    });

    it("upsert: re-store overwrites in place (same scope_key)", async () => {
        await store.storeFact({ key: "skills/up", value: { v: 1 }, shared: true });
        await store.storeFact({ key: "skills/up", value: { v: 2 }, shared: true });
        const { facts } = await store.readFacts({ keyPattern: "skills/up" }, aclOf(null, [], true));
        assert.equal(facts.length, 1);
        assert.deepEqual(facts[0].value, { v: 2 });
    });
});
