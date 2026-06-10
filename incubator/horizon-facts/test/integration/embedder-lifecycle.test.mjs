// §4 Embedder lifecycle (E1–E3, E6–E12) — REAL endpoint configured throughout
// (06 §7: no stub tier; df.http runs in-database and must reach the endpoint).
// Lifecycle assertions go through embedderStatus() + the pg_durable instance
// table filtered by the schema label — never deeper into df internals.
// Tests are ORDERED and share lifecycle state.

import { describe, it, beforeAll, afterAll } from "vitest";
import assert from "node:assert/strict";
import {
    HAS_DB, HAS_REAL_EMBED, REAL_EMBED_DIM, realEmbedding,
    makeStore, dropSchemaAndGraph, rawPool, pollUntil,
} from "./_db.mjs";

describe.skipIf(!HAS_DB || !HAS_REAL_EMBED)("embedder lifecycle (E1–E3, E6–E12)", () => {
    let store, schema, graph, pool, firstInstance;

    beforeAll(async () => {
        ({ store, schema, graph } = await makeStore({ tag: "elc", embeddingDim: REAL_EMBED_DIM }));
        pool = rawPool();
    });
    afterAll(async () => {
        await store?.stopEmbedder("suite teardown").catch(() => {});
        await store?.close();
        await pool?.end();
        if (schema) await dropSchemaAndGraph(schema, graph);
    });

    const instancesForLabel = async () => {
        const { rows } = await pool.query(
            `SELECT id, status FROM df.instances WHERE label = $1 ORDER BY created_at DESC`,
            [`hz-embed-cron:${schema}`]);
        return rows;
    };

    it("E10 (neg) start before configure throws the precondition", async () => {
        await assert.rejects(() => store.startEmbedder(), /not configured|configureEmbedder/);
    });

    it("E12 configure while stopped writes vars only — no instance starts", async () => {
        const st = await store.configureEmbedder(realEmbedding());
        assert.equal(st.running, false);
        assert.equal((await instancesForLabel()).length, 0);
    });

    it("E1 status before start: running false", async () => {
        assert.deepEqual(await store.embedderStatus(), { running: false });
    });

    it("E2 start: running true, one instance", async () => {
        // Seed a small pending set so ticks do real work (06 §7).
        await store.storeFact({ key: "embed/e2", value: { text: "embedder lifecycle test fact" }, shared: true });
        const st = await store.startEmbedder({ intervalSeconds: 1, batch: 8 });
        assert.equal(st.running, true);
        assert.ok(st.instanceId);
        firstInstance = st.instanceId;
        assert.equal((await instancesForLabel()).length, 1);
    });

    it("E3 double start is a no-op returning the SAME instance", async () => {
        const st = await store.startEmbedder({ intervalSeconds: 1, batch: 8 });
        assert.equal(st.running, true);
        assert.equal(st.instanceId, firstInstance);
        assert.equal((await instancesForLabel()).length, 1, "still exactly one instance for the label");
    });

    it("E6 df-state while running is pending/running", async () => {
        const st = await store.embedderStatus();
        assert.ok(["pending", "running"].includes(st.status), `status=${st.status}`);
    });

    it("E11 configure while running RESTARTS: new instanceId, same label, still running", async () => {
        const st = await store.configureEmbedder(realEmbedding());
        assert.equal(st.running, true);
        assert.ok(st.instanceId);
        assert.notEqual(st.instanceId, firstInstance, "restart must mint a new instance (vars captured at df.start)");
        const rows = await instancesForLabel();
        const nonTerminal = rows.filter((r) => ["pending", "running"].includes(String(r.status)));
        assert.equal(nonTerminal.length, 1, "exactly one live instance after the restart");
        firstInstance = st.instanceId;
    });

    it("E7 stop cancels; E8 double stop is a no-op", async () => {
        const st = await store.stopEmbedder("test stop");
        assert.equal(st.running, false);
        await pollUntil(async () => {
            const rows = await instancesForLabel();
            return ["cancelled", "completed", "failed"].includes(String(rows[0]?.status));
        }, { label: "instance reaches a terminal state", timeoutMs: 30_000 });
        const again = await store.stopEmbedder("double stop");
        assert.equal(again.running, false);
    });

    it("E9 restart after stop: new running instance", async () => {
        const st = await store.startEmbedder({ intervalSeconds: 1, batch: 8 });
        assert.equal(st.running, true);
        assert.notEqual(st.instanceId, firstInstance);
    });
});
