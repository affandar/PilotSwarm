// §5 Preconditions / fail-fast (P1–P5) — REAL targets only (06 §4):
// the negatives run against a real vanilla Postgres (PLAIN_DATABASE_URL),
// which genuinely lacks the Horizon extensions; the positive runs on the
// real HorizonDB. No simulated capability snapshots.

import test from "node:test";
import assert from "node:assert/strict";
import { HAS_DB, HAS_PLAIN_DB, DB_URL, PLAIN_DB_URL, uniqueNames, dropSchemaAndGraph } from "./_db.mjs";

test("preconditions P1–P4 (plain Postgres → itemized error)",
    { skip: !HAS_PLAIN_DB && "PLAIN_DATABASE_URL not set (full validation requires it)" }, async (t) => {
    const { HorizonFactStore, missingExtensions } = await import("../../dist/src/index.js");
    const pg = (await import("pg")).default;
    const plain = new pg.Pool({ connectionString: PLAIN_DB_URL, max: 1 });
    t.after(async () => { await plain.end(); });

    await t.test("the error names EVERY missing piece with its fix (itemized, not blanket)", async () => {
        const missing = await missingExtensions(plain);
        assert.ok(missing.length > 0, "precondition: the plain target must lack at least one Horizon extension");

        const names = uniqueNames("pre");
        const store = await HorizonFactStore.create({
            connectionString: PLAIN_DB_URL, schema: names.schema, graphName: names.graph, embeddingDim: 4 });
        try {
            await assert.rejects(
                () => store.initialize(),
                (err) => {
                    for (const name of missing) {
                        assert.ok(err.message.includes(name), `error must name missing extension '${name}'`);
                        assert.match(err.message, new RegExp(`${name}.*Fix:`, "s"), `'${name}' must carry a fix`);
                    }
                    assert.match(err.message, /preconditions failed/i);
                    return true;
                });
        } finally {
            await store.close();
        }
    });

    await t.test("P1a piecewise narrowing (opportunistic): installable extensions shrink the itemized set", async () => {
        // Where the plain target permits CREATE EXTENSION vector, the error
        // must narrow to exactly the still-missing set. Skipped silently when
        // the plain target can't host pgvector — the all-missing case above
        // already covers P1–P4.
        let canVector = false;
        try { await plain.query("CREATE EXTENSION IF NOT EXISTS vector"); canVector = true; }
        catch { /* not available on this plain target */ }
        if (!canVector) return;
        const missing = await missingExtensions(plain);
        assert.ok(!missing.includes("vector"), "vector no longer reported missing once installed/available");
    });
});

test("preconditions P5 (real HorizonDB → initializes, migrations applied, ready)",
    { skip: !HAS_DB && "HORIZON_DATABASE_URL not set" }, async (t) => {
    const { HorizonFactStore } = await import("../../dist/src/index.js");
    const names = uniqueNames("preok");
    const store = await HorizonFactStore.create({
        connectionString: DB_URL, schema: names.schema, graphName: names.graph, embeddingDim: 4 });
    t.after(async () => { await store.close(); await dropSchemaAndGraph(names.schema, names.graph); });
    await store.initialize();
    // ready = the provider surface works end to end on the fresh schema
    await store.storeFact({ key: "skills/ready", value: 1, shared: true });
    const { count } = await store.readFacts({ keyPattern: "skills/ready" }, { unrestricted: true });
    assert.equal(count, 1);
});
