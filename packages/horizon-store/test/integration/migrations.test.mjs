// §6 Migrations (MG1–MG6 per 06-provider-test-plan §3): fresh apply with
// catalog assertions, idempotency, advisory-lock concurrency, partial-chain
// resume, trigger semantics at the DB level, unknown-future-version refusal.

import { describe, it, beforeAll, afterAll } from "vitest";
import assert from "node:assert/strict";
import { HAS_DB, DB_URL, uniqueNames, dropSchemaAndGraph, rawPool } from "./_db.mjs";

describe.skipIf(!HAS_DB)("migrations (MG1–MG6)", () => {
    let pool, api;
    const cleanups = [];

    beforeAll(async () => {
        api = await import("../../dist/src/index.js");
        pool = rawPool();
    });
    afterAll(async () => {
        for (const fn of cleanups.reverse()) await fn().catch(() => {});
        await pool?.end();
    });

    const tokens = (names) => ({ schema: names.schema, graphName: names.graph, embeddingDim: 4 });
    const freshNames = (tag) => {
        const names = uniqueNames(tag);
        cleanups.push(() => dropSchemaAndGraph(names.schema, names.graph));
        return names;
    };

    it("MG1 fresh apply: versions recorded in order; expected objects exist (catalog-level)", async () => {
        const names = freshNames("mg1");
        await api.runMigrations(pool, names.schema, api.loadMigrations(tokens(names)), api.HORIZON_FACTS_LOCK_SEED);

        const { rows: vers } = await pool.query(
            `SELECT version FROM "${names.schema}".schema_migrations ORDER BY version`);
        assert.deepEqual(vers.map((r) => r.version), ["0001", "0002", "0003", "0004", "0005", "0006", "0007", "0008", "0009"]);

        const { rows: cols } = await pool.query(
            `SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'facts'`,
            [names.schema]);
        const colSet = new Set(cols.map((r) => r.column_name));
        for (const c of ["scope_key", "last_crawled_at", "embedding", "embedding_model", "last_embed_error", "last_embed_error_at", "embed_retry_at", "search_text"]) {
            assert.ok(colSet.has(c), `column ${c} exists`);
        }
        assert.ok(!colSet.has("content_hash"), "content_hash removed from minimal schema");
        assert.ok(!colSet.has("last_embedded_hash"), "last_embedded_hash removed from minimal schema");

        const { rows: procs } = await pool.query(
            `SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = $1`,
            [names.schema]);
        const procSet = new Set(procs.map((r) => r.proname));
        for (const p of ["facts_store", "facts_read", "facts_delete", "facts_delete_session", "facts_stats",
                         "facts_search_lexical", "facts_search_semantic", "facts_similar",
                         "facts_read_uncrawled", "facts_mark_crawled", "facts_embedding_failures",
                         "facts_touch", "embedder_workflow", "facts_acl", "embed_error_code", "embed_error_label"]) {
            assert.ok(procSet.has(p), `proc ${p} exists`);
        }

        const { rows: trig } = await pool.query(
            `SELECT tgname FROM pg_trigger tr JOIN pg_class c ON c.oid = tr.tgrelid
             JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND NOT tr.tgisinternal`,
            [names.schema]);
        assert.ok(trig.some((r) => r.tgname === "facts_touch"), "facts_touch trigger installed");

        const { rows: g } = await pool.query(`SELECT 1 FROM ag_catalog.ag_graph WHERE name = $1`, [names.graph]);
        assert.equal(g.length, 1, "AGE graph created");

        const { rows: idx } = await pool.query(
            `SELECT indexname FROM pg_indexes WHERE schemaname = $1`, [names.schema]);
        assert.ok(idx.some((r) => r.indexname === "idx_facts_embedding"), "ANN index exists");
        assert.ok(idx.some((r) => r.indexname === "idx_facts_lexical"), "BM25 index exists");
    });

    it("MG2 idempotent re-run is a no-op", async () => {
        const names = freshNames("mg2");
        const migs = api.loadMigrations(tokens(names));
        await api.runMigrations(pool, names.schema, migs, api.HORIZON_FACTS_LOCK_SEED);
        const { rows: before } = await pool.query(
            `SELECT version, applied_at FROM "${names.schema}".schema_migrations ORDER BY version`);
        await api.runMigrations(pool, names.schema, migs, api.HORIZON_FACTS_LOCK_SEED);
        const { rows: after } = await pool.query(
            `SELECT version, applied_at FROM "${names.schema}".schema_migrations ORDER BY version`);
        assert.deepEqual(after, before, "version rows unchanged (incl. applied_at)");
    });

    it("MG3 two concurrent initializers don't corrupt the schema (advisory lock)", async () => {
        const names = freshNames("mg3");
        const mk = () => api.HorizonDBFactStore.create({
            connectionString: DB_URL, schema: names.schema, graphName: names.graph, embeddingDim: 4 });
        const [s1, s2] = await Promise.all([mk(), mk()]);
        await Promise.all([s1.initialize(), s2.initialize()]);
        await s1.close(); await s2.close();
        const { rows } = await pool.query(
            `SELECT count(*)::int AS n FROM "${names.schema}".schema_migrations`);
        // The FACT provider runs all non-AGE migrations; the 0003 AGE bootstrap belongs to
        // HorizonDBGraphStore (07 D2) and is not recorded in the facts schema.
        assert.equal(rows[0].n, 8, "each FACT migration recorded exactly once");
    });

    it("MG4 partial-chain resume: only the missing tail is applied", async () => {
        const names = freshNames("mg4");
        const migs = api.loadMigrations(tokens(names));
        await api.runMigrations(pool, names.schema, migs.slice(0, 3), api.HORIZON_FACTS_LOCK_SEED);
        await api.runMigrations(pool, names.schema, migs, api.HORIZON_FACTS_LOCK_SEED);
        const { rows } = await pool.query(
            `SELECT version FROM "${names.schema}".schema_migrations ORDER BY version`);
        assert.deepEqual(rows.map((r) => r.version), ["0001", "0002", "0003", "0004", "0005", "0006", "0007", "0008", "0009"]);
    });

    it("MG5 trigger semantics (direct SQL probes)", async () => {
        const names = freshNames("mg5");
        await api.runMigrations(pool, names.schema, api.loadMigrations(tokens(names)), api.HORIZON_FACTS_LOCK_SEED);
        const T = `"${names.schema}".facts`;

        await pool.query(
            `INSERT INTO ${T} (scope_key, key, value, shared, transient) VALUES ('shared:k/1', 'k/1', '{"text":"v1"}', true, false)`);
        let { rows } = await pool.query(`SELECT last_crawled_at FROM ${T} WHERE scope_key = 'shared:k/1'`);
        assert.equal(rows[0].last_crawled_at, null, "new row is uncrawled");

        await pool.query(`UPDATE ${T} SET last_crawled_at = now(), embedding = '[1,0,0,0]'::vector, embedded_at = now(), embedding_model = 'seeded-4', last_embed_error = 1001, last_embed_error_at = now(), embed_retry_at = now() WHERE scope_key = 'shared:k/1'`);
        await pool.query(`UPDATE ${T} SET value = '{"text":"v2"}' WHERE scope_key = 'shared:k/1'`);
        ({ rows } = await pool.query(`SELECT last_crawled_at, embedding IS NULL AS embedding_cleared, embedded_at, embedding_model, last_embed_error, last_embed_error_at, embed_retry_at FROM ${T} WHERE scope_key = 'shared:k/1'`));
        assert.equal(rows[0].last_crawled_at, null, "content change resets crawl stamp");
        assert.equal(rows[0].embedding_cleared, true, "content change clears stale embedding");
        assert.equal(rows[0].embedded_at, null, "content change clears embedding timestamp");
        assert.equal(rows[0].embedding_model, null, "content change clears embedding model");
        assert.equal(rows[0].last_embed_error, null, "content change clears terminal embedding error");
        assert.equal(rows[0].last_embed_error_at, null, "content change clears terminal embedding error timestamp");
        assert.equal(rows[0].embed_retry_at, null, "content change clears transient retry state");

        await pool.query(`UPDATE ${T} SET last_crawled_at = now() WHERE scope_key = 'shared:k/1'`);
        await pool.query(`UPDATE ${T} SET value = '{"text":"v2"}' WHERE scope_key = 'shared:k/1'`); // identical
        ({ rows } = await pool.query(`SELECT last_crawled_at FROM ${T} WHERE scope_key = 'shared:k/1'`));
        assert.notEqual(rows[0].last_crawled_at, null, "identical-content write keeps the stamp");

        // CHECK constraint parity (B14): shared+transient rejected.
        await assert.rejects(() => pool.query(
            `INSERT INTO ${T} (scope_key, key, value, shared, transient) VALUES ('shared:k/bad', 'k/bad', '{}', true, true)`));
    });

    it("MG6 unknown future version → refuses loudly, never repairs", async () => {
        const names = freshNames("mg6");
        const migs = api.loadMigrations(tokens(names));
        await api.runMigrations(pool, names.schema, migs, api.HORIZON_FACTS_LOCK_SEED);
        await pool.query(
            `INSERT INTO "${names.schema}".schema_migrations (version, name) VALUES ('9999', 'from_the_future')`);
        await assert.rejects(
            () => api.runMigrations(pool, names.schema, migs, api.HORIZON_FACTS_LOCK_SEED),
            /9999.*newer deployment|newer deployment.*9999/s);
    });
});
