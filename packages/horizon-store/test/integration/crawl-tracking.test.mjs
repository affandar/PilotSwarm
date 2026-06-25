// §2.1a Crawl tracking (C1–C7) — last_crawled_at and scopeKey + etag receipts.
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
        (await store.readUncrawledFacts({ keyPrefix: ns, limit: 100 })).facts.map((f) => f.scopeKey).sort();

    it("C1 new fact is uncrawled and carries scopeKey", async () => {
        await store.storeFact({ key: "arch/c1", value: { text: "hello" }, shared: true });
        const { facts } = await store.readUncrawledFacts({ limit: 100 });
        const f = facts.find((x) => x.scopeKey === "shared:arch/c1");
        assert.ok(f, "new fact must be in the queue");
    });

    it("C2 setFactsCrawled with scopeKey + etag stamps and drains", async () => {
        const { facts } = await store.readUncrawledFacts({ limit: 100 });
        const f = facts.find((x) => x.scopeKey === "shared:arch/c1");
        const res = await store.setFactsCrawled({ scopeKeys: [{ scopeKey: f.scopeKey, etag: f.etag }] });
        assert.deepEqual(res, { affected: 1, skipped: 0 });
        assert.ok(!(await uncrawledKeys()).includes("shared:arch/c1"));
    });

    it("C3 content change resets crawl state", async () => {
        await store.storeFact({ key: "arch/c1", value: { text: "hello CHANGED" }, shared: true });
        assert.ok((await uncrawledKeys()).includes("shared:arch/c1"));
    });

    it("C4 identical-content write does NOT reset the stamp", async () => {
        const { facts } = await store.readUncrawledFacts({ limit: 100 });
        const f = facts.find((x) => x.scopeKey === "shared:arch/c1");
        await store.setFactsCrawled({ scopeKeys: [{ scopeKey: f.scopeKey, etag: f.etag }] });
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

    it("content edit clears an existing embedding and requeues crawl", async () => {
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

    it("F5 setFactsCrawled true/false does not clear existing embedding state", async () => {
        await store.storeFact({ key: "arch/f5", value: { text: "keep vector" }, shared: true });
        const hasEmbeddedAt = (await pool.query(
            `SELECT EXISTS (
                SELECT 1 FROM information_schema.columns
                WHERE table_schema = $1 AND table_name = 'facts' AND column_name = 'embedded_at'
            ) AS exists`, [schema])).rows[0].exists;
        const embeddedAtSet = hasEmbeddedAt ? ", embedded_at = now() - interval '1 minute'" : "";
        await pool.query(
            `UPDATE "${schema}".facts SET embedding = $1::vector, embedding_model = 'seeded-4'${embeddedAtSet}
             WHERE scope_key = 'shared:arch/f5'`, ["[1,0,0,0]"]);
        const embeddedAtSelect = hasEmbeddedAt ? ", embedded_at::text AS embedded_at" : "";
        const seeded = await pool.query(
            `SELECT embedding IS NOT NULL AS has_vec, embedding_model${embeddedAtSelect}
             FROM "${schema}".facts WHERE scope_key = 'shared:arch/f5'`);

        const mark = await store.setFactsCrawled({ keyPrefix: "arch/f5", crawled: true });
        assert.equal(mark.affected, 1, "set crawled marks the row");
        const marked = await pool.query(
            `SELECT embedding IS NOT NULL AS has_vec, embedding_model, last_crawled_at IS NOT NULL AS crawled${embeddedAtSelect}
             FROM "${schema}".facts WHERE scope_key = 'shared:arch/f5'`);
        assert.equal(marked.rows[0].has_vec, true, "marking crawled preserves the vector");
        assert.equal(marked.rows[0].embedding_model, "seeded-4", "marking crawled preserves embedding_model");
        if (hasEmbeddedAt) assert.equal(marked.rows[0].embedded_at, seeded.rows[0].embedded_at, "marking crawled preserves embedded_at");
        assert.equal(marked.rows[0].crawled, true, "row is crawled");

        const recrawl = await store.setFactsCrawled({ keyPrefix: "arch/f5", crawled: false });
        assert.equal(recrawl.affected, 1, "set uncrawled requeues the row");
        const requeued = await pool.query(
            `SELECT embedding IS NOT NULL AS has_vec, embedding_model, last_crawled_at IS NULL AS uncrawled${embeddedAtSelect}
             FROM "${schema}".facts WHERE scope_key = 'shared:arch/f5'`);
        assert.equal(requeued.rows[0].has_vec, true, "recrawl preserves the vector");
        assert.equal(requeued.rows[0].embedding_model, "seeded-4", "recrawl preserves embedding_model");
        if (hasEmbeddedAt) assert.equal(requeued.rows[0].embedded_at, seeded.rows[0].embedded_at, "recrawl preserves embedded_at");
        assert.equal(requeued.rows[0].uncrawled, true, "row is requeued");
    });

    it("C7 mark with current etag skips facts already marked", async () => {
        await store.storeFact({ key: "arch/c7", value: { text: "v1" }, shared: true });
        const { facts } = await store.readUncrawledFacts({ keyPrefix: "arch", limit: 100 });
        const f = facts.find((x) => x.scopeKey === "shared:arch/c7");
        assert.deepEqual(await store.setFactsCrawled({ scopeKeys: [{ scopeKey: f.scopeKey, etag: f.etag }] }), { affected: 1, skipped: 0 });
        const res = await store.setFactsCrawled({ scopeKeys: [{ scopeKey: f.scopeKey, etag: f.etag }] });
        assert.deepEqual(res, { affected: 0, skipped: 1 });
        assert.ok(!(await uncrawledKeys("arch")).includes("shared:arch/c7"), "already-marked fact stays drained");
    });

    it("setFactsCrawled validates input", async () => {
        await assert.rejects(() => store.setFactsCrawled({ scopeKeys: [{ contentHash: "old" }] }), /scopeKey/);
        await assert.rejects(() => store.setFactsCrawled({ scopeKeys: [] }), /non-empty/);
        await assert.rejects(() => store.setFactsCrawled({}), /exactly one/);
        await assert.rejects(() => store.setFactsCrawled({ keyPrefix: "" }), /non-empty/);
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

    it("A4h embeddedOnly gate excludes unembedded live rows; tombstones always surface", async () => {
        await store.storeFact({ key: "emb/live-noembed", value: { t: 1 }, shared: true });
        await store.storeFact({ key: "emb/live-embed", value: { t: 2 }, shared: true });
        await pool.query(
            `UPDATE "${schema}".facts SET embedding = $1::vector, embedding_model = 'seed-4'
             WHERE scope_key = 'shared:emb/live-embed'`, ["[1,0,0,0]"]);
        const embedded = (await store.readUncrawledFacts({ keyPrefix: "emb/", limit: 100, embeddedOnly: true }))
            .facts.map((f) => f.scopeKey);
        assert.ok(embedded.includes("shared:emb/live-embed"), "embedded live row surfaces");
        assert.ok(!embedded.includes("shared:emb/live-noembed"), "unembedded live row excluded under embeddedOnly");

        await store.storeFact({ key: "emb/tomb", value: { t: 3 }, shared: true });
        await store.deleteFact({ key: "emb/tomb", shared: true });
        const withTomb = (await store.readUncrawledFacts({ keyPrefix: "emb/", limit: 100, embeddedOnly: true }))
            .facts.map((f) => f.scopeKey);
        assert.ok(withTomb.includes("shared:emb/tomb"), "tombstone surfaces under embeddedOnly regardless of embedding");
    });

    it("prefix flush + scopeKeys stomp/recrawl parity", async () => {
        await store.storeFact([
            { key: "pfx/x/1", value: 1, shared: true },
            { key: "pfx/x/2", value: 2, shared: true },
            { key: "pfx/y/1", value: 3, shared: true },
        ]);
        const flush = await store.setFactsCrawled({ keyPrefix: "pfx/x/", crawled: true });
        assert.equal(flush.affected, 2, "prefix flush marks both pfx/x rows");
        assert.equal((await uncrawledKeys("pfx/x/")).length, 0, "pfx/x drained");
        assert.ok((await uncrawledKeys("pfx/y/")).includes("shared:pfx/y/1"), "disjoint pfx/y untouched");

        const rec = await store.setFactsCrawled({ keyPrefix: "pfx/x/", crawled: false });
        assert.equal(rec.affected, 2, "prefix recrawl requeues both pfx/x rows");
        assert.equal((await uncrawledKeys("pfx/x/")).length, 2, "pfx/x requeued");

        // scopeKeys stomp marks the two listed rows; an unlisted queued row stays.
        const stomp = await store.setFactsCrawled({ scopeKeys: [{ scopeKey: "shared:pfx/x/1" }, { scopeKey: "shared:pfx/x/2" }], crawled: true });
        assert.equal(stomp.affected, 2, "scopeKeys stomp marks the two listed rows");
        assert.ok((await uncrawledKeys("pfx/y/")).includes("shared:pfx/y/1"), "unlisted pfx/y row untouched by scopeKeys stomp");
    });
});
