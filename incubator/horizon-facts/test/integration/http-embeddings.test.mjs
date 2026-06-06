// Integration — HorizonDB provider embedding (PROVIDER tests, not PilotSwarm).
//
// Embedding generation is an INTERNAL capability of this provider. PilotSwarm
// only passes the endpoint config and toggles the lifecycle (configureEmbedder /
// startEmbedder / stopEmbedder / embedderStatus); it never triggers embedding or
// waits on any df instance. These provider tests verify the MECHANISM:
//   1. Endpoint sanity (_embedPendingNode): sends the EXACT request df.http sends
//      (same headers/body, read from embedding_config) via Node fetch against the
//      local stub — proves our request shape is correct. dim 8.
//   2. In-DB df.http() one-shot (_embedNewFactsInDbOnce): with a live endpoint,
//      each fact is embedded by a real pg_durable df.http() instance; asserts the
//      real-dim vectors land and durable hz-embed instances ran.
//   3. Durable embedder LIFECYCLE: start the background df.loop cron, observe the
//      OUTCOME (vectors appear; changed facts re-embed), then stop it.
//
// Run: HORIZON_DATABASE_URL=... HORIZON_EMBED_URL=... HORIZON_EMBED_API_KEY=... \
//      npm run test:integration

import { test, before, after } from "node:test";
import assert from "node:assert/strict";

import { HorizonFactStore } from "../../dist/src/index.js";
import {
    HAS_DB, DB_URL, EMBED_DIM, uniqueNames, startEmbeddingStub, stubEmbedding,
    dropSchemaAndGraph, rawPool,
    HAS_REAL_EMBED, REAL_EMBED_DIM, realEmbedding,
} from "./_db.mjs";

const opts = { skip: !HAS_DB ? "HORIZON_DATABASE_URL not set" : false };

let store, stub, names;

before(async () => {
    if (!HAS_DB) return;
    stub = await startEmbeddingStub();
    names = uniqueNames();
    store = await HorizonFactStore.create({
        connectionString: DB_URL,
        schema: names.schema,
        graphName: names.graph,
        embedding: stubEmbedding(stub.url),
    });
    await store.initialize();
});

after(async () => {
    if (!HAS_DB) return;
    await store?.close();
    await stub?.close();
    await dropSchemaAndGraph(DB_URL, names.schema, names.graph);
});

test("endpoint sanity: _embedPendingNode sends df.http's exact request shape", opts, async () => {
    await store.storeFact({ key: "skills/jsonb", shared: true,
        value: { name: "jsonb subscript", text: "jsonb subscript patch" } });
    await store.storeFact({ key: "skills/vacuum", shared: true,
        value: { name: "vacuum", text: "autovacuum planner" } });

    // Reads the stored embedding_config (written by initialize/configureEmbedder)
    // and posts the IDENTICAL request df.http builds — this is the sanity check.
    const n = await store._embedPendingNode(10);
    assert.equal(n, 2, "embedded both pending facts");

    const pool = rawPool();
    try {
        const { rows } = await pool.query(
            `SELECT embedding IS NOT NULL AS has_emb, embedding_model
             FROM "${names.schema}".facts ORDER BY id`);
        assert.equal(rows.length, 2);
        assert.ok(rows.every((r) => r.has_emb), "all facts have embeddings");
        assert.ok(rows.every((r) => r.embedding_model), "embedding_model recorded");
        console.log(`  embedded ${rows.length} facts via endpoint sanity check (dim ${EMBED_DIM})`);
    } finally {
        await pool.end();
    }

    // Idempotent: nothing pending now.
    const again = await store._embedPendingNode(10);
    assert.equal(again, 0, "no re-embedding when content unchanged");
});

test("in-DB df.http capability is reported", opts, async () => {
    const cap = store.httpEmbeddingCapability();
    assert.ok(cap, "capability reported during initialize()");
    console.log(`  df.http available: ${cap.inDbHttp}`);
    if (!cap.inDbHttp) {
        console.log(`  NOTE: ${cap.note}`);
        return; // honest skip — cluster lacks pg_durable df.http
    }
    assert.equal(cap.installed, true, "durable embedding procedure installed");
});

// Live in-DB embedding: each fact embedded by a real pg_durable df.http()
// instance calling the actual Azure model. Needs a DB-reachable endpoint.
const inDbOpts = {
    skip: !HAS_DB ? "HORIZON_DATABASE_URL not set"
        : !HAS_REAL_EMBED ? "HORIZON_EMBED_URL/API_KEY not set (live endpoint required for in-DB df.http)"
        : false,
};

test("in-DB df.http embeds facts via the real endpoint", inDbOpts, async () => {
    const liveNames = uniqueNames();
    const live = await HorizonFactStore.create({
        connectionString: DB_URL,
        schema: liveNames.schema,
        graphName: liveNames.graph,
        embedding: realEmbedding(),
    });
    try {
        await live.initialize();
        const cap = live.httpEmbeddingCapability();
        assert.ok(cap?.inDbHttp, "df.http present on cluster");
        if (cap.note) console.log(`  ${cap.note}`);
        console.log(`  in-DB endpoint host: ${new URL(cap.effectiveUrl).hostname}`);

        await live.storeFact({ key: "skills/indb-1", shared: true,
            value: { name: "in-db embed", text: "embedded inside postgres via df.http" } });
        await live.storeFact({ key: "skills/indb-2", shared: true,
            value: { name: "vacuum tuning", text: "autovacuum planner cost settings" } });

        // Drives embed_new_facts_durable(): one durable df.http instance per fact.
        const n = await live._embedNewFactsInDbOnce(10);
        assert.equal(n, 2, "embedded both pending facts in-DB");
        console.log(`  embed_new_facts_durable() embedded ${n} fact(s) via df.http`);

        const pool = rawPool();
        try {
            const { rows } = await pool.query(
                `SELECT vector_dims(embedding) AS dim, embedding_model
                 FROM "${liveNames.schema}".facts ORDER BY id`);
            assert.equal(rows.length, 2);
            assert.ok(rows.every((r) => r.dim === REAL_EMBED_DIM),
                `all facts embedded at dim ${REAL_EMBED_DIM}`);
            assert.ok(rows.every((r) => r.embedding_model), "embedding_model recorded");
            console.log(`  vectors: dim ${rows[0].dim}, model ${rows[0].embedding_model}`);

            // A durable df.http instance actually ran (label 'hz-embed').
            const { rows: inst } = await pool.query(
                `SELECT count(*)::int AS n FROM df.instances WHERE label = 'hz-embed'`);
            assert.ok(inst[0].n >= 2, "durable hz-embed instances were created");
            console.log(`  durable df.http instances (hz-embed): ${inst[0].n}`);
        } finally {
            await pool.end();
        }

        // Idempotent: nothing pending now.
        const again = await live._embedNewFactsInDbOnce(10);
        assert.equal(again, 0, "no re-embedding when content unchanged");
    } finally {
        await live.close();
        await dropSchemaAndGraph(DB_URL, liveNames.schema, liveNames.graph);
    }
});

// Durable embedder LIFECYCLE: the background generator the provider actually
// uses in production. We drive it ONLY through the lifecycle API (start/stop/
// status) and assert on the OUTCOME — vectors appear, changed facts re-embed —
// the way PilotSwarm would observe it, never waiting on a df instance. One
// explicit df-lifecycle proof is kept (the loop instance is pending while
// running, cancelled after stop) since this is a provider mechanism test. Uses a
// 1s tick for speed (production default is 5s). Needs the live endpoint.
test("durable embedder lifecycle: start → embeds & re-embeds → stop", inDbOpts, async () => {
    const cronNames = uniqueNames();
    const live = await HorizonFactStore.create({
        connectionString: DB_URL,
        schema: cronNames.schema,
        graphName: cronNames.graph,
        embedding: realEmbedding(),
    });
    const pool = rawPool();
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    // OUTCOME observation only: has this fact's vector landed / advanced?
    const embeddedAtOf = async (key) => (await pool.query(
        `SELECT embedded_at FROM "${cronNames.schema}".facts WHERE key = $1`, [key])).rows[0]?.embedded_at;
    const waitUntil = async (label, fn, maxMs = 15000) => {
        const deadline = Date.now() + maxMs;
        let ok = false;
        do { await sleep(1000); ok = await fn(); } while (!ok && Date.now() < deadline);
        assert.ok(ok, `${label}: not observed within ${maxMs}ms`);
    };

    try {
        await live.initialize();
        assert.ok(live.httpEmbeddingCapability()?.inDbHttp, "df.http present on cluster");

        await live.storeFact({ key: "skills/cron-1", shared: true,
            value: { name: "jsonb subscript", text: "jsonb subscript patch" } });
        await live.storeFact({ key: "skills/cron-2", shared: true,
            value: { name: "vacuum tuning", text: "autovacuum planner cost" } });

        // Lifecycle: not running yet.
        assert.equal((await live.embedderStatus()).running, false, "embedder idle before start");

        // Start the background embedder (1s tick for the test).
        const started = await live.startEmbedder({ intervalSeconds: 1, batch: 64 });
        assert.equal(started.running, true, "embedder running after start");
        assert.ok(started.instanceId, "status exposes instance id");
        console.log(`  started embedder (1s tick), running=${started.running}`);

        // Idempotent: starting again returns the SAME running instance.
        const again = await live.startEmbedder({ intervalSeconds: 1, batch: 64 });
        assert.equal(again.instanceId, started.instanceId, "second start reuses the running instance");

        // OUTCOME: both facts get embedded by the background loop.
        await waitUntil("initial embed", async () => {
            const { rows } = await pool.query(
                `SELECT count(*) FILTER (WHERE embedding IS NOT NULL)::int AS emb, count(*)::int AS total
                 FROM "${cronNames.schema}".facts`);
            return rows[0].emb === 2 && rows[0].total === 2;
        });
        const { rows: dims } = await pool.query(
            `SELECT vector_dims(embedding) AS dim FROM "${cronNames.schema}".facts ORDER BY id`);
        assert.ok(dims.every((r) => r.dim === REAL_EMBED_DIM), `embedded at dim ${REAL_EMBED_DIM}`);
        console.log(`  background loop embedded both facts at dim ${REAL_EMBED_DIM}`);

        // df-lifecycle proof: the loop instance is active while running.
        const { rows: act } = await pool.query(`SELECT status FROM df.instances WHERE id = $1`,
            [started.instanceId]);
        assert.ok(["pending", "running"].includes(act[0]?.status),
            `df loop active while running (status ${act[0]?.status})`);

        // OUTCOME: mutate a fact → loop re-embeds it (embedded_at advances).
        const before = await embeddedAtOf("skills/cron-1");
        await live.storeFact({ key: "skills/cron-1", shared: true,
            value: { name: "jsonb subscript", text: "jsonb subscript patch — REVISED with replication notes" } });
        await waitUntil("re-embed changed fact", async () => {
            const now = await embeddedAtOf("skills/cron-1");
            return now && (!before || new Date(now) > new Date(before));
        });
        console.log("  changed fact re-embedded by the background loop");

        // Lifecycle: status reflects running, then stop flips it off.
        const running = await live.embedderStatus();
        assert.equal(running.running, true);
        assert.equal(running.instanceId, started.instanceId);

        const stopped = await live.stopEmbedder("test done");
        assert.equal(stopped.running, false, "embedder reports stopped");

        // df-lifecycle proof: instance is cancelled after stop.
        await sleep(1500);
        const final = await live.embedderStatus();
        assert.equal(final.running, false, "still stopped");
        assert.equal(final.status, "cancelled", "df loop cancelled after stop");
        console.log("  embedder stopped; df loop cancelled");

        // Second stop is a no-op.
        const noop = await live.stopEmbedder();
        assert.equal(noop.running, false, "stopping an already-stopped embedder is a no-op");
    } finally {
        await pool.end();
        await live.close();
        await dropSchemaAndGraph(DB_URL, cronNames.schema, cronNames.graph);
    }
});
