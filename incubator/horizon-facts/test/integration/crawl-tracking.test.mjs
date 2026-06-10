// §2.1a Crawl tracking (C1–C7) — last_crawled_at, receipts, race guard.

import test from "node:test";
import assert from "node:assert/strict";
import { HAS_DB, makeStore, dropSchemaAndGraph, rawPool } from "./_db.mjs";

test("crawl tracking (C1–C7)", { skip: !HAS_DB && "HORIZON_DATABASE_URL not set" }, async (t) => {
    const { store, schema, graph } = await makeStore({ tag: "crawl" });
    const pool = rawPool();
    t.after(async () => { await store.close(); await pool.end(); await dropSchemaAndGraph(schema, graph); });

    const uncrawledKeys = async (ns) =>
        (await store.readUncrawledFacts({ namespace: ns, limit: 100 })).facts.map((f) => f.scopeKey).sort();

    await t.test("C1 new fact is uncrawled and carries contentHash", async () => {
        await store.storeFact({ key: "arch/c1", value: { text: "hello" }, shared: true });
        const { facts } = await store.readUncrawledFacts({ limit: 100 });
        const f = facts.find((x) => x.scopeKey === "shared:arch/c1");
        assert.ok(f, "new fact must be in the queue");
        assert.match(f.contentHash, /^[0-9a-f]{32}$/);
    });

    await t.test("C2 markFactsCrawled with matching hash stamps and drains", async () => {
        const { facts } = await store.readUncrawledFacts({ limit: 100 });
        const f = facts.find((x) => x.scopeKey === "shared:arch/c1");
        const res = await store.markFactsCrawled([{ scopeKey: f.scopeKey, contentHash: f.contentHash }]);
        assert.deepEqual(res, { marked: 1, skipped: 0 });
        assert.ok(!(await uncrawledKeys()).includes("shared:arch/c1"));
    });

    await t.test("C3 content change resets crawl state", async () => {
        await store.storeFact({ key: "arch/c1", value: { text: "hello CHANGED" }, shared: true });
        assert.ok((await uncrawledKeys()).includes("shared:arch/c1"));
    });

    await t.test("C4 identical-content write does NOT reset the stamp", async () => {
        const { facts } = await store.readUncrawledFacts({ limit: 100 });
        const f = facts.find((x) => x.scopeKey === "shared:arch/c1");
        await store.markFactsCrawled([{ scopeKey: f.scopeKey, contentHash: f.contentHash }]);
        await store.storeFact({ key: "arch/c1", value: { text: "hello CHANGED" }, shared: true }); // same content
        assert.ok(!(await uncrawledKeys()).includes("shared:arch/c1"), "no-op write must not re-queue");
    });

    await t.test("C5 privileged: spans ALL scopes; namespace + limit apply", async () => {
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

    await t.test("C6 crawl reset does not clear an existing embedding (independent states)", async () => {
        await store.storeFact({ key: "arch/c6", value: { text: "embed me" }, shared: true });
        await pool.query(
            `UPDATE "${schema}".facts SET embedding = $1::vector, embedding_model = 'seeded-4', last_embedded_hash = content_hash
             WHERE scope_key = 'shared:arch/c6'`, ["[1,0,0,0]"]);
        await store.storeFact({ key: "arch/c6", value: { text: "embed me EDITED" }, shared: true });
        const { rows } = await pool.query(
            `SELECT embedding IS NOT NULL AS has_vec, last_crawled_at IS NULL AS uncrawled,
                    last_embedded_hash IS DISTINCT FROM content_hash AS embed_pending
             FROM "${schema}".facts WHERE scope_key = 'shared:arch/c6'`);
        assert.equal(rows[0].has_vec, true, "edit must not clear the existing vector");
        assert.equal(rows[0].uncrawled, true, "edit re-queues the crawl");
        assert.equal(rows[0].embed_pending, true, "edit marks embedding pending");
    });

    await t.test("C7 (race) edit between read and mark → stamp skipped, fact stays queued", async () => {
        await store.storeFact({ key: "arch/c7", value: { text: "v1" }, shared: true });
        const { facts } = await store.readUncrawledFacts({ namespace: "arch", limit: 100 });
        const f = facts.find((x) => x.scopeKey === "shared:arch/c7");
        // The mid-crawl edit:
        await store.storeFact({ key: "arch/c7", value: { text: "v2 — changed under the harvester" }, shared: true });
        const res = await store.markFactsCrawled([{ scopeKey: f.scopeKey, contentHash: f.contentHash }]);
        assert.deepEqual(res, { marked: 0, skipped: 1 });
        assert.ok((await uncrawledKeys("arch")).includes("shared:arch/c7"), "fact must remain queued");
    });

    await t.test("markFactsCrawled validates receipts", async () => {
        await assert.rejects(() => store.markFactsCrawled([{ scopeKey: "shared:x" }]), /contentHash/);
        assert.deepEqual(await store.markFactsCrawled([]), { marked: 0, skipped: 0 });
    });
});
