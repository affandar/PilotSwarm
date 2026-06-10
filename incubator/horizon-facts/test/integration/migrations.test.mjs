// §6 Migrations (MG1–MG6 per 06-provider-test-plan §3): fresh apply with
// catalog assertions, idempotency, advisory-lock concurrency, partial-chain
// resume, trigger semantics at the DB level, unknown-future-version refusal.

import test from "node:test";
import assert from "node:assert/strict";
import { HAS_DB, DB_URL, uniqueNames, dropSchemaAndGraph, rawPool } from "./_db.mjs";

test("migrations (MG1–MG6)", { skip: !HAS_DB && "HORIZON_DATABASE_URL not set" }, async (t) => {
    const { loadMigrations, runMigrations, HORIZON_FACTS_LOCK_SEED, HorizonFactStore } =
        await import("../../dist/src/index.js");
    const pool = rawPool();
    t.after(async () => { await pool.end(); });

    const tokens = (names) => ({ schema: names.schema, graphName: names.graph, embeddingDim: 4 });

    await t.test("MG1 fresh apply: versions recorded in order; expected objects exist (catalog-level)", async (tt) => {
        const names = uniqueNames("mg1");
        tt.after(async () => dropSchemaAndGraph(names.schema, names.graph));
        await runMigrations(pool, names.schema, loadMigrations(tokens(names)), HORIZON_FACTS_LOCK_SEED);

        const { rows: vers } = await pool.query(
            `SELECT version FROM "${names.schema}".schema_migrations ORDER BY version`);
        assert.deepEqual(vers.map((r) => r.version), ["0001", "0002", "0003", "0004", "0005"]);

        const { rows: cols } = await pool.query(
            `SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'facts'`,
            [names.schema]);
        const colSet = new Set(cols.map((r) => r.column_name));
        for (const c of ["scope_key", "content_hash", "last_crawled_at", "embedding", "embedding_model", "last_embedded_hash", "search_text"]) {
            assert.ok(colSet.has(c), `column ${c} exists`);
        }

        const { rows: procs } = await pool.query(
            `SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = $1`,
            [names.schema]);
        const procSet = new Set(procs.map((r) => r.proname));
        for (const p of ["facts_store", "facts_read", "facts_delete", "facts_delete_session", "facts_stats",
                         "facts_search_lexical", "facts_search_semantic", "facts_similar",
                         "facts_read_uncrawled", "facts_mark_crawled", "facts_touch", "embedder_workflow", "facts_acl"]) {
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
    });

    await t.test("MG2 idempotent re-run is a no-op", async (tt) => {
        const names = uniqueNames("mg2");
        tt.after(async () => dropSchemaAndGraph(names.schema, names.graph));
        const migs = loadMigrations(tokens(names));
        await runMigrations(pool, names.schema, migs, HORIZON_FACTS_LOCK_SEED);
        const { rows: before } = await pool.query(
            `SELECT version, applied_at FROM "${names.schema}".schema_migrations ORDER BY version`);
        await runMigrations(pool, names.schema, migs, HORIZON_FACTS_LOCK_SEED);
        const { rows: after } = await pool.query(
            `SELECT version, applied_at FROM "${names.schema}".schema_migrations ORDER BY version`);
        assert.deepEqual(after, before, "version rows unchanged (incl. applied_at)");
    });

    await t.test("MG3 two concurrent initializers don't corrupt the schema (advisory lock)", async (tt) => {
        const names = uniqueNames("mg3");
        tt.after(async () => dropSchemaAndGraph(names.schema, names.graph));
        const mk = () => HorizonFactStore.create({
            connectionString: DB_URL, schema: names.schema, graphName: names.graph, embeddingDim: 4 });
        const [s1, s2] = await Promise.all([mk(), mk()]);
        await Promise.all([s1.initialize(), s2.initialize()]);
        await s1.close(); await s2.close();
        const { rows } = await pool.query(
            `SELECT count(*)::int AS n FROM "${names.schema}".schema_migrations`);
        assert.equal(rows[0].n, 5, "each migration recorded exactly once");
    });

    await t.test("MG4 partial-chain resume: only the missing tail is applied", async (tt) => {
        const names = uniqueNames("mg4");
        tt.after(async () => dropSchemaAndGraph(names.schema, names.graph));
        const migs = loadMigrations(tokens(names));
        await runMigrations(pool, names.schema, migs.slice(0, 3), HORIZON_FACTS_LOCK_SEED);
        await runMigrations(pool, names.schema, migs, HORIZON_FACTS_LOCK_SEED);
        const { rows } = await pool.query(
            `SELECT version FROM "${names.schema}".schema_migrations ORDER BY version`);
        assert.deepEqual(rows.map((r) => r.version), ["0001", "0002", "0003", "0004", "0005"]);
    });

    await t.test("MG5 trigger semantics (direct SQL probes)", async (tt) => {
        const names = uniqueNames("mg5");
        tt.after(async () => dropSchemaAndGraph(names.schema, names.graph));
        await runMigrations(pool, names.schema, loadMigrations(tokens(names)), HORIZON_FACTS_LOCK_SEED);
        const T = `"${names.schema}".facts`;

        await pool.query(
            `INSERT INTO ${T} (scope_key, key, value, shared, transient) VALUES ('shared:k/1', 'k/1', '{"text":"v1"}', true, false)`);
        let { rows } = await pool.query(`SELECT content_hash, last_crawled_at FROM ${T} WHERE scope_key = 'shared:k/1'`);
        assert.match(rows[0].content_hash, /^[0-9a-f]{32}$/, "INSERT sets content_hash");
        assert.equal(rows[0].last_crawled_at, null, "new row is uncrawled");

        await pool.query(`UPDATE ${T} SET last_crawled_at = now() WHERE scope_key = 'shared:k/1'`);
        await pool.query(`UPDATE ${T} SET value = '{"text":"v2"}' WHERE scope_key = 'shared:k/1'`);
        ({ rows } = await pool.query(`SELECT last_crawled_at FROM ${T} WHERE scope_key = 'shared:k/1'`));
        assert.equal(rows[0].last_crawled_at, null, "content change resets crawl stamp");

        await pool.query(`UPDATE ${T} SET last_crawled_at = now() WHERE scope_key = 'shared:k/1'`);
        await pool.query(`UPDATE ${T} SET value = '{"text":"v2"}' WHERE scope_key = 'shared:k/1'`); // identical
        ({ rows } = await pool.query(`SELECT last_crawled_at FROM ${T} WHERE scope_key = 'shared:k/1'`));
        assert.notEqual(rows[0].last_crawled_at, null, "identical-content write keeps the stamp");

        // CHECK constraint parity (B14): shared+transient rejected.
        await assert.rejects(() => pool.query(
            `INSERT INTO ${T} (scope_key, key, value, shared, transient) VALUES ('shared:k/bad', 'k/bad', '{}', true, true)`));
    });

    await t.test("MG6 unknown future version → refuses loudly, never repairs", async (tt) => {
        const names = uniqueNames("mg6");
        tt.after(async () => dropSchemaAndGraph(names.schema, names.graph));
        const migs = loadMigrations(tokens(names));
        await runMigrations(pool, names.schema, migs, HORIZON_FACTS_LOCK_SEED);
        await pool.query(
            `INSERT INTO "${names.schema}".schema_migrations (version, name) VALUES ('9999', 'from_the_future')`);
        await assert.rejects(
            () => runMigrations(pool, names.schema, migs, HORIZON_FACTS_LOCK_SEED),
            /9999.*newer deployment|newer deployment.*9999/s);
    });
});
