/**
 * E3 (enhancedfactstore 07 §1.5 composition tier): a BASE PgFactStore paired
 * with a REAL HorizonDBGraphStore, exercised THROUGH THE SDK TOOL LAYER
 * (createFactTools + createGraphTools), not the providers directly.
 *
 * The horizon provider's own crawl/graph/ACL semantics are covered against the
 * live DB by packages/horizon-store/test/integration/*. This suite covers the
 * thing neither those (provider-direct) nor the DB-less gating tests (fakes) can:
 * that the SDK tools compose a vanilla base fact store with a separate graph
 * store correctly, and that the base crawl queue drives a real graph harvest end
 * to end —
 *
 *   store_fact(intake) → facts_read_uncrawled → graph_upsert_node(evidence)
 *     → facts_mark_crawled → graph_search_nodes → readFacts(evidence) round-trip
 *
 * and that a BASE fact store yields NO search tools even with a graph present.
 *
 * Gated on HORIZON_DATABASE_URL (the graph). PgFactStore runs on the local test
 * Postgres (DATABASE_URL / default). Auto-skips on a vanilla checkout.
 *
 * Run: node --env-file=../../packages/horizon-store/.env \
 *      ../../node_modules/vitest/vitest.mjs run \
 *      test/local/enhanced-composition.integration.test.js
 */

import { describe, it, beforeAll, afterAll } from "vitest";
import { assert, assertEqual } from "../helpers/assertions.js";
import {
    PgFactStore,
    createGraphStoreForUrl,
    createFactTools,
    createGraphTools,
    isEnhancedFactStore,
} from "../../src/index.ts";

function normalizeHdbUrl(raw) {
    if (!raw) return "";
    if (!/[?&]sslmode=/.test(raw)) return raw;
    if (/[?&]uselibpqcompat=/.test(raw)) return raw;
    return raw + (raw.includes("?") ? "&" : "?") + "uselibpqcompat=true";
}

const HDB_URL = normalizeHdbUrl(process.env.HORIZON_DATABASE_URL || "");
const HAS_HDB = !!HDB_URL;
const PG_URL = process.env.PS_TEST_DATABASE_URL || process.env.TEST_DATABASE_URL
    || process.env.DATABASE_URL || "postgresql://postgres:postgres@localhost:5432/pilotswarm";

function uniqueNames(tag) {
    const r = Math.random().toString(36).slice(2, 8);
    return { schema: `e3_${tag}_${r}`, graph: `e3g_${tag}_${r}` };
}

async function dropGraph(graph) {
    const { default: pg } = await import("pg");
    const pool = new pg.Pool({ connectionString: HDB_URL, max: 1 });
    try {
        try { await pool.query(`LOAD 'age'`); } catch {}
        await pool.query(`SET search_path = ag_catalog, "$user", public`);
        try { await pool.query(`SELECT drop_graph($1, true)`, [graph]); } catch {}
    } finally {
        await pool.end();
    }
}

async function dropPgSchema(schema) {
    const { default: pg } = await import("pg");
    const pool = new pg.Pool({ connectionString: PG_URL, max: 1 });
    try { await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); } finally { await pool.end(); }
}

const byName = (tools, n) => tools.find((t) => t.name === n);
// Privileged read access for the assertion round-trips (mirrors the tuner path).
const ALL = { unrestricted: true };

describe.skipIf(!HAS_HDB)("E3: base PgFactStore + real graph composition (live HDB)", () => {
    let factStore, graphStore, names;

    beforeAll(async () => {
        names = uniqueNames("compose");
        factStore = await PgFactStore.create(PG_URL, names.schema);
        await factStore.initialize();
        graphStore = await createGraphStoreForUrl(HDB_URL, names.graph);
        await graphStore.initialize();
    }, 120_000);

    afterAll(async () => {
        await factStore?.close().catch((e) => console.warn("E3 factStore close failed:", e?.message));
        await graphStore?.close().catch((e) => console.warn("E3 graphStore close failed:", e?.message));
        if (names) {
            await dropGraph(names.graph).catch((e) => console.warn(`E3 drop graph ${names.graph} failed:`, e?.message));
            await dropPgSchema(names.schema).catch((e) => console.warn(`E3 drop schema ${names.schema} failed:`, e?.message));
        }
    });

    it("base facts + real graph: combined SDK surface has graph reads but NO search tools", () => {
        assertEqual(isEnhancedFactStore(factStore), false, "PgFactStore is a plain FactStore");
        // The composed surface a default session would actually receive: base fact
        // tools + graph tools (graph keys off !!graphStore, never facts capability).
        const factToolNames = createFactTools({ factStore }).map((t) => t.name);
        const graphToolNames = createGraphTools({
            factStore, graphStore, agentIdentity: "default",
            resolveAccess: async (sid) => ({ readerSessionId: sid ?? null, grantedSessionIds: [] }),
        }).map((t) => t.name);
        const all = new Set([...factToolNames, ...graphToolNames]);
        assert(all.has("store_fact") && all.has("read_facts"), "base KV tools present");
        assert(all.has("graph_search_nodes") && all.has("graph_search_edges") && all.has("graph_neighbourhood"),
            "the REAL graph store lights up the graph read surface");
        assert(!all.has("facts_search") && !all.has("facts_similar") && !all.has("search_skills"),
            "a base store yields NO enhanced search tools, even composed with a graph");
    });

    it("the base crawl queue drives a real graph harvest through the SDK tools", { timeout: 120_000 }, async () => {
        const runId = Math.random().toString(36).slice(2, 8);
        // A unique per-run namespace so the queue read can never be masked by an
        // unrelated fact past the page boundary.
        const ns = `intake/e3-${runId}/`;
        // Intake is written through the SDK store_fact TOOL (not the raw store),
        // exercising the documented store_fact → facts_read_uncrawled → harvest path.
        const factTools = createFactTools({ factStore });
        const storeFact = byName(factTools, "store_fact");
        const harvesterTools = createGraphTools({
            factStore, graphStore, agentIdentity: "app-harvester", isHarvester: true, agentId: "app-harvester",
            resolveAccess: async (sid) => ({ readerSessionId: sid ?? null, grantedSessionIds: [] }),
        });
        const readUncrawled = byName(harvesterTools, "facts_read_uncrawled");
        const markCrawled = byName(harvesterTools, "facts_mark_crawled");
        const upsertNode = byName(harvesterTools, "graph_upsert_node");
        const searchNodes = byName(harvesterTools, "graph_search_nodes");
        assert(storeFact && readUncrawled && markCrawled && upsertNode && searchNodes, "store_fact + harvester tools present");

        // 1. A fresh intake fact enters the base store THROUGH the SDK tool.
        const factKey = `${ns}alastor`;
        const stored = await storeFact.handler(
            { key: factKey, value: { name: "Alastor", text: "Alastor maintains the vacuum loop" }, shared: true },
            { sessionId: "harv1" },
        );
        assert(!stored.error, `store_fact via the tool succeeded (${stored.error ?? ""})`);

        // 2. The harvester reads the queue and finds the fact (with its receipt).
        const queue = await readUncrawled.handler({ namespace: ns, limit: 50 }, { sessionId: "harv1" });
        const queued = queue.facts.find((f) => f.key === factKey);
        assert(queued, "the new intake fact is in the uncrawled queue");
        assert(typeof queued.scopeKey === "string", "queued fact carries scopeKey");
        assert(typeof queued.etag === "number" && queued.etag > 0, "queued fact carries etag receipt");

        // 4. Harvest it into the graph: a node evidenced by the fact's scopeKey.
        const node = await upsertNode.handler(
            { kind: "service", name: `Alastor-${runId}`, evidence: [queued.scopeKey] },
            { sessionId: "harv1" },
        );
        assert(node.nodeKey, "graph node created");

        // 5. The receipt stamps it crawled → it leaves the queue.
        const marked = await markCrawled.handler({ stamps: [{ scopeKey: queued.scopeKey, etag: queued.etag }] }, { sessionId: "harv1" });
        assertEqual(marked.marked, 1, "exactly the one fact is stamped crawled");

        const after = await readUncrawled.handler({ namespace: ns, limit: 50 }, { sessionId: "harv1" });
        assert(!after.facts.some((f) => f.key === factKey), "the harvested fact has left the crawl queue");

        // 6. The node is findable and carries the evidence scopeKey, which
        //    resolves back through the SEPARATE base fact provider (cross-store).
        const hits = await searchNodes.handler({ nameLike: `Alastor-${runId}` }, { sessionId: "harv1" });
        const hit = hits.find((h) => h.nodeKey === node.nodeKey);
        assert(hit, "the harvested node is findable via graph_search_nodes");
        assert(hit.evidence.includes(queued.scopeKey), "node carries the fact scopeKey as evidence");
        const resolved = await factStore.readFacts({ scopeKeys: hit.evidence }, ALL);
        assert(resolved.facts.some((f) => f.key === factKey), "evidence resolves back to the source fact (cross-provider round-trip)");
    });

    it("graph read ACL is enforced through the tool layer (per-caller evidence filtering)", { timeout: 120_000 }, async () => {
        const runId = Math.random().toString(36).slice(2, 8);
        // Evidence the SAME node with BOTH a shared scopeKey (visible to everyone)
        // and a session-private scopeKey (visible only to the owner's lineage).
        // The shared evidence guarantees the stranger MUST find the node, so the
        // "private key is filtered" assertion can never pass vacuously.
        const sharedKey = `arch/e3-${runId}/shared`;
        const privateKey = `secret/e3-${runId}/private`;
        await factStore.storeFact({ key: sharedKey, value: { text: "shared evidence" }, shared: true });
        await factStore.storeFact({ key: privateKey, value: { text: "private evidence" }, sessionId: "ownerSession" });
        // Resolve the REAL scopeKeys from the store (no format assumptions).
        const sharedScopeKey = (await factStore.readFacts({ scope: "shared", keyPattern: sharedKey }, ALL)).facts.find((f) => f.key === sharedKey)?.scopeKey;
        const ownerScopeKey = (await factStore.readFacts({ sessionId: "ownerSession" }, ALL)).facts.find((f) => f.key === privateKey)?.scopeKey;
        assert(sharedScopeKey && ownerScopeKey, "resolved both evidence scopeKeys from the store");
        assert(ownerScopeKey.includes("ownerSession"), "private scopeKey is session-scoped to the owner");

        const nodeName = `secret-${runId}`;
        const harvesterTools = createGraphTools({
            factStore, graphStore, agentIdentity: "app-harvester", isHarvester: true, agentId: "app-harvester",
            resolveAccess: async (sid) => ({ readerSessionId: sid ?? null, grantedSessionIds: [] }),
        });
        const node = await byName(harvesterTools, "graph_upsert_node").handler(
            { kind: "secretthing", name: nodeName, evidence: [sharedScopeKey, ownerScopeKey] },
            { sessionId: "harv1" },
        );

        // A STRANGER (no lineage to ownerSession): must FIND the node (via shared
        // evidence) but see ONLY the shared scopeKey, never the private one.
        const strangerTools = createGraphTools({
            factStore, graphStore, agentIdentity: "default",
            resolveAccess: async (sid) => ({ readerSessionId: sid ?? null, grantedSessionIds: [] }),
        });
        const asStranger = await byName(strangerTools, "graph_search_nodes").handler({ nameLike: nodeName }, { sessionId: "strangerSession" });
        const strangerHit = asStranger.find((h) => h.nodeKey === node.nodeKey);
        assert(strangerHit, "the stranger FINDS the node (shared evidence makes this non-vacuous)");
        assert(strangerHit.evidence.includes(sharedScopeKey), "stranger sees the shared evidence");
        assert(!strangerHit.evidence.includes(ownerScopeKey), "stranger must NOT see the owner's private scopeKey");

        // A DIFFERENT reader whose lineage INCLUDES ownerSession (non-self grant):
        // proves grantedSessionIds is actually honored, not just readerSessionId.
        const childTools = createGraphTools({
            factStore, graphStore, agentIdentity: "default",
            resolveAccess: async (sid) => ({ readerSessionId: sid ?? null, grantedSessionIds: ["ownerSession"] }),
        });
        const asChild = await byName(childTools, "graph_search_nodes").handler({ nameLike: nodeName }, { sessionId: "childReaderSession" });
        const childHit = asChild.find((h) => h.nodeKey === node.nodeKey);
        assert(childHit, "the lineage-granted reader finds the node");
        assert(childHit.evidence.includes(ownerScopeKey),
            "a reader granted ownerSession via NON-SELF lineage sees the private scopeKey (grantedSessionIds honored)");
        assert(childHit.evidence.includes(sharedScopeKey), "and still sees the shared evidence");
    });
});
