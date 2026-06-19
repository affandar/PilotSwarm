// §2.1a Crawl tracking (C1–C7) — last_crawled_at and scopeKey receipts.
// Tests run sequentially and build on each other's state (C1→C2→C3→C4).

import { describe, it, beforeAll, afterAll } from "vitest";
import assert from "node:assert/strict";
import { HAS_DB, makeStore, dropSchemaAndGraph, rawPool } from "./_db.mjs";

describe.skipIf(!HAS_DB)("crawl tracking (C1–C7)", () => {
    let store, schema, graph, pool;

    beforeAll(async () => {
        ({ store, schema, graph } = await makeStore({ tag: "crawl" }));
        pool = rawPool();
    });
    afterAll(async () => {
        await store?.close();
        await pool?.end();
        if (schema) await dropSchemaAndGraph(schema, graph);
    });

    const uncrawledKeys = async (ns) =>
        (await store.readUncrawledFacts({ namespace: ns, limit: 100 })).facts.map((f) => f.scopeKey).sort();

    it("C1 new fact is uncrawled and carries scopeKey", async () => {
        await store.storeFact({ key: "arch/c1", value: { text: "hello" }, shared: true });
        const { facts } = await store.readUncrawledFacts({ limit: 100 });
        const f = facts.find((x) => x.scopeKey === "shared:arch/c1");
        assert.ok(f, "new fact must be in the queue");
    });

    it("C2 markFactsCrawled with scopeKey stamps and drains", async () => {
        const { facts } = await store.readUncrawledFacts({ limit: 100 });
        const f = facts.find((x) => x.scopeKey === "shared:arch/c1");
        const res = await store.markFactsCrawled([{ scopeKey: f.scopeKey }]);
        assert.deepEqual(res, { marked: 1, skipped: 0 });
        assert.ok(!(await uncrawledKeys()).includes("shared:arch/c1"));
    });

    it("C3 content change resets crawl state", async () => {
        await store.storeFact({ key: "arch/c1", value: { text: "hello CHANGED" }, shared: true });
        assert.ok((await uncrawledKeys()).includes("shared:arch/c1"));
    });

    it("C4 identical-content write does NOT reset the stamp", async () => {
        const { facts } = await store.readUncrawledFacts({ limit: 100 });
        const f = facts.find((x) => x.scopeKey === "shared:arch/c1");
        await store.markFactsCrawled([{ scopeKey: f.scopeKey }]);
        await store.storeFact({ key: "arch/c1", value: { text: "hello CHANGED" }, shared: true }); // same content
        assert.ok(!(await uncrawledKeys()).includes("shared:arch/c1"), "no-op write must not re-queue");
    });

    it("C5 privileged: spans ALL scopes; namespace + limit apply", async () => {
        await store.storeFact({ key: "arch/c5-shared", value: 1, shared: true });
        await store.storeFact({ key: "arch/c5-s1", value: 2, sessionId: "S1" });
        await store.storeFact({ key: "other/c5", value: 3, sessionId: "S2" });
        const inNs = await uncrawledKeys("arch");
        assert.ok(inNs.includes("shared:arch/c5-shared"), "shared fact visible");
        assert.ok(inNs.includes("session:S1:arch/c5-s1"), "S1 session fact visible without any access ctx (privileged)");
        assert.ok(!inNs.includes("session:S2:other/c5"), "namespace filter applies");
        const { facts } = await store.readUncrawledFacts({ namespace: "arch", limit: 1 });
        assert.equal(facts.length, 1, "limit applies");
    });

    it("base provider batch store and explicit pattern delete", async () => {
        const batch = await store.storeFact([
            { key: "batch/hz/a", value: { n: 1 }, shared: true },
            { key: "batch/hz/b", value: { n: 2 }, shared: true },
            { key: "batch/hz/session", value: { n: 3 }, sessionId: "S-BATCH" },
        ]);
        assert.equal(batch.stored, 3, "storeFact stores every fact in batch mode");
        const read = await store.readFacts({ keyPattern: "batch/hz/%", scope: "accessible" }, { readerSessionId: "S-BATCH" });
        assert.equal(read.count, 3, "batch facts are readable through the normal surface");

        const sharedDelete = await store.deleteFact({ key: "batch/hz/*", pattern: true, scope: "shared", unrestricted: false });
        assert.equal(sharedDelete.deleted, 2, "shared pattern delete removes matching shared facts only");
        const sessionDelete = await store.deleteFact({ key: "batch/hz/*", pattern: true, scope: "session", sessionId: "S-BATCH" });
        assert.equal(sessionDelete.deleted, 1, "session pattern delete removes owned session facts");
    });

    it("C6 crawl reset does not clear an existing embedding (independent states)", async () => {
        await store.storeFact({ key: "arch/c6", value: { text: "embed me" }, shared: true });
        await pool.query(
            `UPDATE "${schema}".facts SET embedding = $1::vector, embedding_model = 'seeded-4'
             WHERE scope_key = 'shared:arch/c6'`, ["[1,0,0,0]"]);
        await store.storeFact({ key: "arch/c6", value: { text: "embed me EDITED" }, shared: true });
        const { rows } = await pool.query(
            `SELECT embedding IS NOT NULL AS has_vec, last_crawled_at IS NULL AS uncrawled,
                    embedding_model IS NULL AS embed_pending
             FROM "${schema}".facts WHERE scope_key = 'shared:arch/c6'`);
        assert.equal(rows[0].has_vec, false, "edit clears the existing vector");
        assert.equal(rows[0].uncrawled, true, "edit re-queues the crawl");
        assert.equal(rows[0].embed_pending, true, "edit marks embedding pending");
    });

    it("C7 scopeKey-only mark skips facts already marked", async () => {
        await store.storeFact({ key: "arch/c7", value: { text: "v1" }, shared: true });
        const { facts } = await store.readUncrawledFacts({ namespace: "arch", limit: 100 });
        const f = facts.find((x) => x.scopeKey === "shared:arch/c7");
        assert.deepEqual(await store.markFactsCrawled([{ scopeKey: f.scopeKey }]), { marked: 1, skipped: 0 });
        const res = await store.markFactsCrawled([{ scopeKey: f.scopeKey }]);
        assert.deepEqual(res, { marked: 0, skipped: 1 });
        assert.ok(!(await uncrawledKeys("arch")).includes("shared:arch/c7"), "already-marked fact stays drained");
    });

    it("markFactsCrawled validates receipts", async () => {
        await assert.rejects(() => store.markFactsCrawled([{ contentHash: "old" }]), /scopeKey/);
        assert.deepEqual(await store.markFactsCrawled([]), { marked: 0, skipped: 0 });
    });

    it("content edits clear internal embedding failure state", async () => {
        await store.storeFact({ key: "arch/embed-fail", value: { text: "oversized source placeholder" }, shared: true });
        await pool.query(
            `UPDATE "${schema}".facts
                SET last_embed_error = 1001,
                    last_crawled_at = now()
              WHERE scope_key = 'shared:arch/embed-fail'`);

        await store.storeFact({ key: "arch/embed-fail", value: { text: "rewritten shorter source" }, shared: true });
        const { rows } = await pool.query(
            `SELECT last_embed_error, last_crawled_at FROM "${schema}".facts WHERE scope_key = 'shared:arch/embed-fail'`);
        assert.equal(rows[0].last_embed_error, null, "rewrite clears last_embed_error");
        assert.equal(rows[0].last_crawled_at, null, "rewrite puts row back on crawler radar");
    });
});
