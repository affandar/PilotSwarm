// Graph namespace registry (graph-fact-search enhancements). Real-surface
// integration: runs against the live HorizonDB named by HORIZON_DATABASE_URL and
// SKIPs when unset. Covers the registry CRUD, default<->NULL semantics, exact
// deletion, frontmatter validation, the provider cache, schema placement, and
// the injection-hardened Cypher wrapper.

import { describe, it, beforeAll, afterAll } from "vitest";
import assert from "node:assert/strict";
import { HAS_DB, DB_URL, makeStore, uniqueNames, dropSchemaAndGraph, rawPool } from "./_db.mjs";

const agentId = "tester";

describe.skipIf(!HAS_DB)("graph namespace registry", () => {
    let store, graphStore, schema, graph, registrySchema;

    beforeAll(async () => {
        ({ store, graphStore, schema, graph, registrySchema } = await makeStore({ tag: "gns" }));
    });
    afterAll(async () => {
        await store?.close();
        if (schema) await dropSchemaAndGraph(schema, graph, registrySchema);
    });

    // ── bootstrap + placement ────────────────────────────────────────────────

    it("NS1 bootstrap seeds the default row and is idempotent across re-init", async () => {
        await graphStore.initialize(); // second init must be a no-op, not a dup
        const def = await graphStore.getGraphNamespace("default");
        assert.ok(def, "default row exists");
        assert.equal(def.namespace, "default");
        assert.equal(def.archived, false);
        assert.ok(def.frontmatter.description.length > 0, "default has a description");
    });

    it("NS1b graph-only concurrent bootstrap creates exactly one default row and no facts schema", async () => {
        const { HorizonDBGraphStore } = await import("../../dist/src/index.js");
        const names = uniqueNames("gnsboot");
        const cfg = { connectionString: DB_URL, schema: names.schema, graphName: names.graph, registrySchema: names.registrySchema, namespaceCacheTtlMs: 0 };
        const a = await HorizonDBGraphStore.create(cfg);
        const b = await HorizonDBGraphStore.create(cfg);
        const pool = rawPool();
        try {
            await Promise.all([a.initialize(), b.initialize()]);
            const defaults = await pool.query(
                `SELECT count(*)::int AS c FROM "${names.registrySchema}".graph_namespaces WHERE namespace = 'default'`);
            assert.equal(defaults.rows[0].c, 1, "exactly one default row after concurrent graph-only init");

            const factsSchema = await pool.query(
                `SELECT 1 FROM information_schema.schemata WHERE schema_name = $1`, [names.schema]);
            assert.equal(factsSchema.rowCount, 0, "graph-only init did not create the facts schema");
        } finally {
            await a.close();
            await b.close();
            await pool.end();
            await dropSchemaAndGraph(names.schema, names.graph, names.registrySchema);
        }
    });

    it("NS2 registry table lives in the graph-owned schema, NOT the AGE graph schema", async () => {
        const pool = rawPool();
        try {
            const inRegistry = await pool.query(
                `SELECT 1 FROM information_schema.tables WHERE table_schema = $1 AND table_name = 'graph_namespaces'`,
                [registrySchema]);
            assert.equal(inRegistry.rowCount, 1, `graph_namespaces is in ${registrySchema}`);
            const inAgeSchema = await pool.query(
                `SELECT 1 FROM information_schema.tables WHERE table_schema = $1 AND table_name = 'graph_namespaces'`,
                [graph]);
            assert.equal(inAgeSchema.rowCount, 0, "graph_namespaces is NOT inside the AGE graph schema");
        } finally {
            await pool.end();
        }
    });

    // ── upsert / get / list ──────────────────────────────────────────────────

    it("NS3 upsert creates a compact, listable namespace", async () => {
        const info = await graphStore.upsertGraphNamespace({
            namespace: "corpus/pgsql-hackers",
            frontmatter: { name: "pgsql-hackers", description: "PostgreSQL mailing-list graph." },
        });
        assert.equal(info.namespace, "corpus/pgsql-hackers");
        assert.equal(info.archived, false);
        assert.equal(info.frontmatter.name, "pgsql-hackers");

        const list = await graphStore.listGraphNamespaces();
        const row = list.find((n) => n.namespace === "corpus/pgsql-hackers");
        assert.ok(row, "namespace appears in list");
        assert.equal(row.source, undefined, "compact list omits detail fields");
    });

    it("NS4 idempotent upsert: frontmatter-only re-upsert preserves details (COALESCE) and updates frontmatter", async () => {
        await graphStore.upsertGraphNamespace({
            namespace: "corpus/acme",
            frontmatter: { name: "acme", description: "Acme support corpus." },
            source: "facts under corpus/acme/* feed this graph",
            nodeSchema: { kinds: ["ticket", "person"] },
            harvestConfig: { mode: "incremental" },
        });
        // Re-upsert with ONLY frontmatter — details must survive, frontmatter changes.
        const updated = await graphStore.upsertGraphNamespace({
            namespace: "corpus/acme",
            frontmatter: { name: "acme", description: "Acme support-ticket graph (v2)." },
        });
        assert.equal(updated.frontmatter.description, "Acme support-ticket graph (v2).");
        const full = await graphStore.getGraphNamespace("corpus/acme");
        assert.equal(full.source, "facts under corpus/acme/* feed this graph", "source preserved");
        assert.deepEqual(full.nodeSchema, { kinds: ["ticket", "person"] }, "nodeSchema preserved");
        assert.deepEqual(full.harvestConfig, { mode: "incremental" }, "harvestConfig preserved");
    });

    it("NS5 includeDetails returns detail fields; getGraphNamespace returns null for missing", async () => {
        const detailed = await graphStore.listGraphNamespaces({ prefix: "corpus/acme", includeDetails: true });
        const acme = detailed.find((n) => n.namespace === "corpus/acme");
        assert.ok(acme.source && acme.nodeSchema, "details present with includeDetails");
        assert.equal(await graphStore.getGraphNamespace("corpus/does-not-exist"), null);
    });

    it("NS6 prefix is a string-prefix over registry rows (not an AGE subtree query)", async () => {
        await graphStore.upsertGraphNamespace({ namespace: "corpus/acme-eu", frontmatter: { description: "EU shard." } });
        const acme = await graphStore.listGraphNamespaces({ prefix: "corpus/acme" });
        const names = acme.map((n) => n.namespace).sort();
        assert.ok(names.includes("corpus/acme"));
        assert.ok(names.includes("corpus/acme-eu"), "string-prefix matches corpus/acme-eu too");
    });

    it("NS7 concurrent upsert of the same namespace yields exactly one row", async () => {
        const ns = "corpus/concurrent";
        await Promise.all([
            graphStore.upsertGraphNamespace({ namespace: ns, frontmatter: { description: "a" } }),
            graphStore.upsertGraphNamespace({ namespace: ns, frontmatter: { description: "b" } }),
            graphStore.upsertGraphNamespace({ namespace: ns, frontmatter: { description: "c" } }),
        ]);
        const rows = await graphStore.listGraphNamespaces({ prefix: ns, includeArchived: true, includeDetails: true });
        assert.equal(rows.filter((row) => row.namespace === ns).length, 1, "single row after concurrent upserts");
    });

    // ── archive ──────────────────────────────────────────────────────────────

    it("NS8 archive hides from default list but keeps the row; includeArchived shows it", async () => {
        await graphStore.upsertGraphNamespace({ namespace: "corpus/retired", frontmatter: { description: "old." } });
        await graphStore.upsertGraphNode({ kind: "doc", name: "Retired Doc", namespace: "corpus/retired", agentId });
        assert.equal(await graphStore.archiveGraphNamespace("corpus/retired"), true);
        const active = await graphStore.listGraphNamespaces();
        assert.ok(!active.some((n) => n.namespace === "corpus/retired"), "archived excluded by default");
        const all = await graphStore.listGraphNamespaces({ includeArchived: true });
        assert.ok(all.some((n) => n.namespace === "corpus/retired" && n.archived === true), "includeArchived shows it");
        // get returns archived rows regardless.
        const got = await graphStore.getGraphNamespace("corpus/retired");
        assert.equal(got.archived, true);
        const hits = await graphStore.searchGraphNodes({ namespace: "corpus/retired", kind: "doc" }, { unrestricted: true });
        assert.ok(hits.some((h) => h.nodeKey === "doc:retired-doc"), "archive is non-destructive; targeted graph search still works");
    });

    it("NS9 upsert can clear archived back to false", async () => {
        await graphStore.upsertGraphNamespace({ namespace: "corpus/retired", frontmatter: { description: "back." } });
        const got = await graphStore.getGraphNamespace("corpus/retired");
        assert.equal(got.archived, false, "re-upsert reactivates");
    });

    it("NS10 default cannot be archived", async () => {
        assert.equal(await graphStore.archiveGraphNamespace("default"), false);
        const def = await graphStore.getGraphNamespace("default");
        assert.equal(def.archived, false);
    });

    // ── default <-> NULL semantics ───────────────────────────────────────────

    it("NS11 writing namespace 'default' stores NULL; search 'default' matches IS NULL only", async () => {
        await graphStore.upsertGraphNode({ kind: "note", name: "Unscoped Note", namespace: "default", agentId });
        await graphStore.upsertGraphNode({ kind: "note", name: "Scoped Note", namespace: "corpus/x", agentId });

        const def = await graphStore.searchGraphNodes({ namespace: "default", kind: "note" }, { unrestricted: true });
        const keys = def.map((h) => h.nodeKey);
        assert.ok(keys.includes("note:unscoped-note"), "default search finds the unscoped node");
        assert.ok(!keys.includes("note:scoped-note"), "default search excludes the namespaced node");
        const unscoped = def.find((h) => h.nodeKey === "note:unscoped-note");
        assert.equal(unscoped.namespace, undefined, "stored as NULL, not the literal 'default'");

        const pool = rawPool();
        try {
            try {
                await pool.query(`LOAD 'age'`);
            } catch (err) {
                if (!/access to library "age" is not allowed/i.test(String(err?.message ?? ""))) throw err;
            }
            await pool.query(`SET search_path = ag_catalog, "$user", public`);
            const row = await pool.query(
                `SELECT * FROM cypher('${graph}', $$ MATCH (n:GraphNode { node_key: 'note:unscoped-note' }) RETURN n.namespace $$) AS (namespace agtype)`);
            assert.equal(row.rows.length, 1, "raw AGE row exists");
            assert.match(String(row.rows[0].namespace), /null/i, "raw AGE property is NULL, not literal default");
        } finally {
            await pool.end();
        }
    });

    it("NS12 explicit 'default' on an existing namespaced node re-homes it to NULL", async () => {
        await graphStore.upsertGraphNode({ kind: "note", name: "Rehomed", namespace: "corpus/rehome", agentId });
        // Re-home to default (explicit) clears the namespace.
        await graphStore.upsertGraphNode({ kind: "note", name: "Rehomed", namespace: "default", agentId });
        const scoped = await graphStore.searchGraphNodes({ namespace: "corpus/rehome", kind: "note" }, { unrestricted: true });
        assert.ok(!scoped.some((h) => h.nodeKey === "note:rehomed"), "no longer in corpus/rehome");
        const def = await graphStore.searchGraphNodes({ namespace: "default", kind: "note" }, { unrestricted: true });
        assert.ok(def.some((h) => h.nodeKey === "note:rehomed"), "now in the default/NULL partition");
    });

    it("NS12b default namespace applies to edge search and graphStats", async () => {
        const a = await graphStore.upsertGraphNode({ kind: "note", name: "Default Edge A", namespace: "default", agentId });
        const b = await graphStore.upsertGraphNode({ kind: "note", name: "Default Edge B", namespace: "default", agentId });
        const c = await graphStore.upsertGraphNode({ kind: "note", name: "Named Edge C", namespace: "corpus/edge", agentId });
        await graphStore.upsertGraphEdge({ fromKey: a.nodeKey, toKey: b.nodeKey, predicate: "mentions", namespace: "default", agentId, evidence: ["shared:ns/default-edge"] });
        await graphStore.upsertGraphEdge({ fromKey: c.nodeKey, toKey: b.nodeKey, predicate: "points to default", namespace: "corpus/edge", agentId, evidence: ["shared:ns/bridge-edge"] });

        const edges = await graphStore.searchGraphEdges({ namespace: "default" }, { unrestricted: true });
        const predicates = edges.map((e) => e.predicate);
        assert.ok(predicates.includes("mentions"), "default edge search includes NULL edge namespace");
        assert.ok(predicates.includes("points to default"), "default edge search includes edges attached to NULL endpoints");

        const stats = await graphStore.graphStats({ namespace: "default" });
        assert.ok(stats.nodeCount >= 2, "default stats count NULL nodes");
        assert.ok(stats.edgeCount >= 2, "default stats count NULL edge/endpoints");
    });

    // ── delete (exact, re-runnable, guarded) ─────────────────────────────────

    it("NS13 delete drops exact-namespace graph data + row, leaves facts, is re-runnable", async () => {
        await graphStore.upsertGraphNamespace({ namespace: "corpus/del", frontmatter: { description: "to delete." } });
        const del = await graphStore.upsertGraphNode({ kind: "doc", name: "Del Doc", namespace: "corpus/del", agentId, evidence: ["shared:corpus/del/f1"] });
        const child = await graphStore.upsertGraphNode({ kind: "doc", name: "Child Doc", namespace: "corpus/del/child", agentId });
        const other = await graphStore.upsertGraphNode({ kind: "doc", name: "Other Doc", namespace: "corpus/other", agentId });
        await graphStore.upsertGraphEdge({ fromKey: del.nodeKey, toKey: other.nodeKey, predicate: "bridge out", namespace: "corpus/other", agentId });
        await graphStore.upsertGraphEdge({ fromKey: other.nodeKey, toKey: child.nodeKey, predicate: "child bridge", namespace: "corpus/other", agentId });

        const res = await graphStore.deleteGraphNamespace("corpus/del");
        assert.equal(res.deleted, true, "registry row deleted");
        assert.equal(res.nodesDeleted, 1, "only exact-namespace node deleted");
        assert.equal(res.edgesDeleted, 1, "edge attached to deleted node counted and deleted");
        assert.equal(await graphStore.getGraphNamespace("corpus/del"), null, "row gone");

        // Exact-only: the child-namespace node is NOT deleted.
        const childHits = await graphStore.searchGraphNodes({ namespace: "corpus/del/child", kind: "doc" }, { unrestricted: true });
        assert.ok(childHits.some((h) => h.nodeKey === "doc:child-doc"), "child namespace node survives (exact, not subtree)");
        const otherHits = await graphStore.searchGraphNodes({ namespace: "corpus/other", kind: "doc" }, { unrestricted: true });
        assert.ok(otherHits.some((h) => h.nodeKey === "doc:other-doc"), "unrelated namespace node survives");
        const remainingEdges = await graphStore.searchGraphEdges({ namespace: "corpus/other" }, { unrestricted: true });
        assert.ok(!remainingEdges.some((e) => e.predicate === "bridge out"), "edge attached to deleted node is gone");
        assert.ok(remainingEdges.some((e) => e.predicate === "child bridge"), "edge not attached to exact namespace survives");

        // Re-runnable: second delete is a no-op with honest zero counts.
        const again = await graphStore.deleteGraphNamespace("corpus/del");
        assert.equal(again.deleted, false);
        assert.equal(again.nodesDeleted, 0);
    });

    it("NS14 default cannot be deleted", async () => {
        await assert.rejects(() => graphStore.deleteGraphNamespace("default"), /default.*cannot be deleted/i);
    });

    // ── frontmatter validation ───────────────────────────────────────────────

    it("NS15 frontmatter: name defaults to namespace; blank description rejected; oversize truncated", async () => {
        const info = await graphStore.upsertGraphNamespace({ namespace: "corpus/noname", frontmatter: { description: "x." } });
        assert.equal(info.frontmatter.name, "corpus/noname", "name defaults to the namespace");

        await assert.rejects(
            () => graphStore.upsertGraphNamespace({ namespace: "corpus/blank", frontmatter: { description: "   " } }),
            /description is required/i);

        const huge = "d".repeat(5000);
        const capped = await graphStore.upsertGraphNamespace({ namespace: "corpus/huge", frontmatter: { name: "n".repeat(5000), description: huge } });
        assert.ok(capped.frontmatter.name.length < 5000, "oversized name is truncated");
        assert.ok(capped.frontmatter.description.length < 5000, "oversized description is truncated");
        const listed = (await graphStore.listGraphNamespaces({ prefix: "corpus/huge" }))[0];
        assert.ok(listed.frontmatter.name.length < 5000, "compact list returns capped name");
        assert.ok(listed.frontmatter.description.length < 5000, "compact list returns capped description");
    });

    // ── orphan / empty namespaces ────────────────────────────────────────────

    it("NS16 graph data under an UNregistered namespace is allowed; an empty registered namespace lists fine", async () => {
        // Unregistered namespace with graph data (registry is authoritative for discovery, not a write gate).
        await graphStore.upsertGraphNode({ kind: "doc", name: "Orphan", namespace: "corpus/unregistered", agentId });
        const orphan = await graphStore.searchGraphNodes({ namespace: "corpus/unregistered", kind: "doc" }, { unrestricted: true });
        assert.ok(orphan.some((h) => h.nodeKey === "doc:orphan"), "graph write under unregistered namespace works");
        assert.equal(await graphStore.getGraphNamespace("corpus/unregistered"), null, "no registry row for it");

        // Empty registered namespace lists normally.
        await graphStore.upsertGraphNamespace({ namespace: "corpus/empty", frontmatter: { description: "no data yet." } });
        const list = await graphStore.listGraphNamespaces({ prefix: "corpus/empty" });
        assert.ok(list.some((n) => n.namespace === "corpus/empty"));
    });

    // ── trigger ──────────────────────────────────────────────────────────────

    it("NS17 updated_at advances via trigger on update", async () => {
        const pool = rawPool();
        try {
            await pool.query(
                `INSERT INTO "${registrySchema}".graph_namespaces (namespace, frontmatter, updated_at)
                 VALUES ('corpus/trigger-sentinel', '{"description":"old"}'::jsonb, '2000-01-01T00:00:00Z')`);
        } finally {
            await pool.end();
        }
        const before = await graphStore.getGraphNamespace("corpus/trigger-sentinel");
        assert.equal(before.updatedAt, new Date("2000-01-01T00:00:00Z").toISOString(), "raw sentinel timestamp installed");
        await graphStore.upsertGraphNamespace({ namespace: "corpus/trigger-sentinel", frontmatter: { description: "touched." } });
        const after = await graphStore.getGraphNamespace("corpus/trigger-sentinel");
        assert.ok(new Date(after.updatedAt) > new Date(before.updatedAt), "updated_at advanced");
    });

    // ── injection hardening ──────────────────────────────────────────────────

    it("NS18 namespace with $$, quotes, backslashes cannot break the Cypher wrapper", async () => {
        await graphStore.upsertGraphNode({ kind: "doc", name: "Injection Sentinel", namespace: "corpus/sentinel", agentId });
        const evil = "corpus/inj$$x'\"\\;--";
        await graphStore.upsertGraphNamespace({ namespace: evil, frontmatter: { description: "nasty." } });
        await graphStore.upsertGraphNode({ kind: "doc", name: "Evil Doc", namespace: evil, agentId });
        // Search + delete must execute safely (no SQL error, no breakout).
        const hits = await graphStore.searchGraphNodes({ namespace: evil, kind: "doc" }, { unrestricted: true });
        assert.ok(hits.some((h) => h.nodeKey === "doc:evil-doc"), "namespaced search with $$ works");
        const res = await graphStore.deleteGraphNamespace(evil);
        assert.equal(res.deleted, true);
        assert.ok(res.nodesDeleted >= 1, "node under injection-y namespace deleted");
        const sentinel = await graphStore.searchGraphNodes({ namespace: "corpus/sentinel", kind: "doc" }, { unrestricted: true });
        assert.ok(sentinel.some((h) => h.nodeKey === "doc:injection-sentinel"), "sentinel namespace survives; no breakout side effect");
    });
});

// ── cache behavior (dedicated stores so TTL is controlled) ───────────────────

describe.skipIf(!HAS_DB)("graph namespace cache", () => {
    async function makeGraphStore(tag, ttlMs) {
        const { HorizonDBGraphStore } = await import("../../dist/src/index.js");
        const r = Math.random().toString(36).slice(2, 8);
        const graph = `hzg_${tag}_${r}`;
        const names = { schema: `hzt_${tag}_${r}`, graph, registrySchema: `${graph}_registry` };
        const gs = await HorizonDBGraphStore.create({
            connectionString: DB_URL, schema: names.schema, graphName: names.graph, registrySchema: names.registrySchema, namespaceCacheTtlMs: ttlMs,
        });
        await gs.initialize();
        return { gs, ...names };
    }

    it("NS19 TTL=0 always reloads; writes via another path are immediately visible", async () => {
        const { gs, schema, graph, registrySchema } = await makeGraphStore("cache0", 0);
        const pool = rawPool();
        try {
            await gs.listGraphNamespaces(); // prime; TTL=0 must still reload next time
            await pool.query(
                `INSERT INTO "${registrySchema}".graph_namespaces (namespace, frontmatter)
                 VALUES ('corpus/raw', '{"description":"raw"}'::jsonb)`);
            const list = await gs.listGraphNamespaces();
            assert.ok(list.some((n) => n.namespace === "corpus/raw"), "TTL=0 sees the out-of-band write");
        } finally {
            await pool.end();
            await gs.close();
            await dropSchemaAndGraph(schema, graph, registrySchema);
        }
    });

    it("NS20 within TTL the snapshot is cached; writes through the store invalidate; clock expiry reloads", async () => {
        const { gs, schema, graph, registrySchema } = await makeGraphStore("cache1", 60_000);
        const pool = rawPool();
        let t = 1000;
        gs.setNamespaceCacheClock(() => t);
        try {
            await gs.listGraphNamespaces();                 // snapshot at t=1000 (default only)
            await pool.query(
                `INSERT INTO "${registrySchema}".graph_namespaces (namespace, frontmatter)
                 VALUES ('corpus/stale', '{"description":"stale"}'::jsonb)`);
            let list = await gs.listGraphNamespaces();        // still t=1000 -> cached, stale row hidden
            assert.ok(!list.some((n) => n.namespace === "corpus/stale"), "cached snapshot hides out-of-band write within TTL");

            // A write THROUGH the store invalidates the snapshot immediately.
            await gs.upsertGraphNamespace({ namespace: "corpus/fresh", frontmatter: { description: "fresh" } });
            list = await gs.listGraphNamespaces();
            assert.ok(list.some((n) => n.namespace === "corpus/fresh"), "store write invalidates cache");
            assert.ok(list.some((n) => n.namespace === "corpus/stale"), "reload after invalidation also picks up the raw row");

            // prefix + includeArchived are projected from the cached snapshot.
            await gs.upsertGraphNamespace({ namespace: "corpus/cachearch", frontmatter: { description: "archived." } });
            await gs.archiveGraphNamespace("corpus/cachearch");
            list = await gs.listGraphNamespaces({ prefix: "corpus/cachearch" });
            assert.equal(list.length, 0, "archived row hidden by default via snapshot filter");
            list = await gs.listGraphNamespaces({ prefix: "corpus/cachearch", includeArchived: true });
            assert.equal(list.length, 1, "includeArchived exposes archived row via snapshot filter");
            assert.equal(list[0].archived, true);

            await gs.deleteGraphNamespace("corpus/cachearch");
            list = await gs.listGraphNamespaces({ prefix: "corpus/cachearch", includeArchived: true });
            assert.equal(list.length, 0, "delete invalidates cache immediately");

            // Advance the clock past the TTL -> next list reloads.
            await pool.query(
                `INSERT INTO "${registrySchema}".graph_namespaces (namespace, frontmatter)
                 VALUES ('corpus/stale2', '{"description":"stale2"}'::jsonb)`);
            list = await gs.listGraphNamespaces();           // still within TTL -> hidden
            assert.ok(!list.some((n) => n.namespace === "corpus/stale2"), "second raw row hidden within TTL");
            t += 61_000;
            list = await gs.listGraphNamespaces();           // past TTL -> reload
            assert.ok(list.some((n) => n.namespace === "corpus/stale2"), "snapshot reloads after TTL expiry");
        } finally {
            await pool.end();
            await gs.close();
            await dropSchemaAndGraph(schema, graph, registrySchema);
        }
    });

    it("NS20b a second provider instance converges within its own TTL", async () => {
        const { HorizonDBGraphStore } = await import("../../dist/src/index.js");
        const r = Math.random().toString(36).slice(2, 8);
        const graph = `hzg_cache2_${r}`;
        const names = { schema: `hzt_cache2_${r}`, graph, registrySchema: `${graph}_registry` };
        const cfg = { connectionString: DB_URL, schema: names.schema, graphName: names.graph, registrySchema: names.registrySchema, namespaceCacheTtlMs: 60_000 };
        const a = await HorizonDBGraphStore.create(cfg);
        const b = await HorizonDBGraphStore.create(cfg);
        let ta = 1000, tb = 1000;
        a.setNamespaceCacheClock(() => ta);
        b.setNamespaceCacheClock(() => tb);
        try {
            await a.initialize();
            await b.initialize();
            await b.listGraphNamespaces(); // b caches default-only
            await a.upsertGraphNamespace({ namespace: "corpus/cross-worker", frontmatter: { description: "x." } });
            let bList = await b.listGraphNamespaces();
            assert.ok(!bList.some((n) => n.namespace === "corpus/cross-worker"), "second provider stays stale within its TTL");
            tb += 61_000;
            bList = await b.listGraphNamespaces();
            assert.ok(bList.some((n) => n.namespace === "corpus/cross-worker"), "second provider reloads after its own TTL");
        } finally {
            await a.close();
            await b.close();
            await dropSchemaAndGraph(names.schema, names.graph, names.registrySchema);
        }
    });

    it("NS21 initialize() fails fast when registrySchema collides with the AGE graph name", async () => {
        const { HorizonDBGraphStore } = await import("../../dist/src/index.js");
        const r = Math.random().toString(36).slice(2, 8);
        const name = `hzc_${r}`;
        const gs = await HorizonDBGraphStore.create({
            connectionString: DB_URL, schema: `hzt_coll_${r}`, graphName: name, registrySchema: name,
        });
        try {
            await assert.rejects(() => gs.initialize(), /must differ from the AGE graph name/i);
        } finally {
            await gs.close();
        }
    });
});
