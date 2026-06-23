// §5 Preconditions / fail-fast (P1–P5) — REAL targets only (06 §4):
// the negatives run against a real vanilla Postgres (PLAIN_DATABASE_URL,
// auto-recast from the repo root .env's DATABASE_URL), which genuinely lacks
// the Horizon extensions; the positive runs on the real HorizonDB. No
// simulated capability snapshots.

import { describe, it, beforeAll, afterAll } from "vitest";
import assert from "node:assert/strict";
import { HAS_DB, HAS_PLAIN_DB, DB_URL, PLAIN_DB_URL, uniqueNames, dropSchemaAndGraph, rawPool } from "./_db.mjs";

describe.skipIf(!HAS_PLAIN_DB)("preconditions P1–P4 (plain Postgres → itemized error)", () => {
    let api, plain;

    beforeAll(async () => {
        api = await import("../../dist/src/index.js");
        plain = rawPool(PLAIN_DB_URL);
    });
    afterAll(async () => { await plain?.end(); });

    it("each provider names EVERY missing piece it needs, with its fix (itemized)", async () => {
        const factMissing = await api.missingFactExtensions(plain);
        const graphMissing = await api.missingGraphExtensions(plain);
        assert.ok(factMissing.length + graphMissing.length > 0,
            "precondition: the plain target must lack at least one Horizon extension");

        const names = uniqueNames("pre");
        // Fact provider (07 D2): fail-fast names the missing FACT extensions (NOT age).
        if (factMissing.length > 0) {
            const fs = await api.HorizonDBFactStore.create({
                connectionString: PLAIN_DB_URL, schema: names.schema, graphName: names.graph, embeddingDim: 4 });
            try {
                await assert.rejects(() => fs.initialize(), (err) => {
                    for (const name of factMissing) {
                        assert.ok(err.message.includes(name), `fact error must name missing extension '${name}'`);
                        assert.match(err.message, new RegExp(`${name}.*Fix:`, "s"), `'${name}' must carry a fix`);
                    }
                    assert.match(err.message, /preconditions failed/i);
                    return true;
                });
            } finally { await fs.close(); }
        }
        // Graph provider (07 D2): fail-fast names age when it is missing.
        if (graphMissing.length > 0) {
            const gs = await api.HorizonDBGraphStore.create({
                connectionString: PLAIN_DB_URL, schema: names.schema, graphName: names.graph, embeddingDim: 4 });
            try {
                await assert.rejects(() => gs.initialize(), (err) => {
                    for (const name of graphMissing) {
                        assert.ok(err.message.includes(name), `graph error must name missing extension '${name}'`);
                        assert.match(err.message, new RegExp(`${name}.*Fix:`, "s"), `'${name}' must carry a fix`);
                    }
                    assert.match(err.message, /preconditions failed/i);
                    return true;
                });
            } finally { await gs.close(); }
        }
    });

    it("P1a piecewise narrowing (opportunistic): installable extensions shrink the itemized set", async () => {
        // Where the plain target permits CREATE EXTENSION vector, the error
        // must narrow to exactly the still-missing set. Skipped silently when
        // the plain target can't host pgvector — the all-missing case above
        // already covers P1–P4.
        let canVector = false;
        try { await plain.query("CREATE EXTENSION IF NOT EXISTS vector"); canVector = true; }
        catch { /* not available on this plain target */ }
        if (!canVector) return;
        const missing = await api.missingExtensions(plain);
        assert.ok(!missing.includes("vector"), "vector no longer reported missing once installed/available");
    });
});

describe.skipIf(!HAS_DB)("preconditions P5 (real HorizonDB → initializes, migrations applied, ready)", () => {
    let store, names;

    beforeAll(async () => {
        const { HorizonDBFactStore } = await import("../../dist/src/index.js");
        names = uniqueNames("preok");
        store = await HorizonDBFactStore.create({
            connectionString: DB_URL, schema: names.schema, graphName: names.graph, embeddingDim: 4 });
        await store.initialize();
    });
    afterAll(async () => {
        await store?.close();
        if (names) await dropSchemaAndGraph(names.schema, names.graph);
    });

    it("ready = the provider surface works end to end on the fresh schema", async () => {
        await store.storeFact({ key: "skills/ready", value: 1, shared: true });
        const { count } = await store.readFacts({ keyPattern: "skills/ready" }, { unrestricted: true });
        assert.equal(count, 1);
    });
});
