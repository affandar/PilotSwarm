/**
 * Composition tiers — the four supported store wirings an agent can run with,
 * exercised THROUGH THE SDK TOOL LAYER (createFactTools + createGraphTools), the
 * way a worker actually composes a session's tools. This is the deployment
 * matrix as one file:
 *
 *   Tier 1  base fact store ONLY                          (always-on, vanilla PG)
 *   Tier 2  base + graph store, super basic harvester     (HDB-gated)
 *   Tier 3  enhanced fact store ONLY, all search modes    (HDB + embedder-gated)
 *   Tier 4  enhanced + graph store, super basic harvester (HDB-gated)
 *
 * The DB-less tool-registration matrix is in enhanced-tool-gating.test.js; the
 * detailed base+graph composition (ACL, cross-provider) is in
 * enhanced-composition.integration.test.js. This file proves each TIER composes
 * and round-trips end to end against the real stores.
 *
 * Tiers 2/4 harvest does NOT need the embedder — the harvester reads the crawl
 * queue with embeddedOnly=false. Only Tier 3's semantic/hybrid query path needs
 * the live embedder (HORIZON_EMBED_*).
 *
 * Run (HDB tiers): node --env-file=../horizon-store/.env \
 *   ../../node_modules/vitest/vitest.mjs run test/local/composition-tiers.integration.test.js
 */

import { describe, it, beforeAll, afterAll } from "vitest";
import { assert, assertEqual } from "../helpers/assertions.js";
import {
    PgFactStore,
    createFactStoreForUrl,
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
const HAS_EMBED = !!(process.env.HORIZON_EMBED_URL && process.env.HORIZON_EMBED_API_KEY);
const EMBED_CFG = {
    url: process.env.HORIZON_EMBED_URL,
    model: process.env.HORIZON_EMBED_MODEL || "text-embedding-3-small",
    dim: Number(process.env.HORIZON_EMBED_DIM || 1536),
    apiKey: process.env.HORIZON_EMBED_API_KEY,
    apiKeyHeader: process.env.HORIZON_EMBED_API_KEY_HEADER || "api-key",
    inputField: "input",
};

const byName = (tools, n) => tools.find((t) => t.name === n);
// Harvester graph-tool access: own session only, no extra lineage grants.
const graphAccess = { resolveAccess: async (sid) => ({ readerSessionId: sid ?? null, grantedSessionIds: [] }) };

function uniqueNames(tag) {
    const r = Math.random().toString(36).slice(2, 8);
    return { schema: `tier_${tag}_${r}`, graph: `tierg_${tag}_${r}` };
}

function graphBootstrapLockKey() {
    let hash = 0x48_5a_46;
    for (const ch of "horizon-graph-bootstrap") hash = ((hash << 5) - hash + ch.charCodeAt(0)) | 0;
    return hash;
}

async function dropPgSchema(schema, url = PG_URL) {
    const { default: pg } = await import("pg");
    const pool = new pg.Pool({ connectionString: url, max: 1 });
    try { await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); } finally { await pool.end(); }
}

async function dropHdb(schema, graph) {
    const { default: pg } = await import("pg");
    const pool = new pg.Pool({ connectionString: HDB_URL, max: 1 });
    try {
        try { await pool.query(`LOAD 'age'`); } catch { /* preloaded */ }
        await pool.query(`SET search_path = ag_catalog, "$user", public`);
        if (graph) {
            await pool.query("SELECT pg_advisory_lock($1)", [graphBootstrapLockKey()]);
            try { await pool.query(`SELECT drop_graph($1, true)`, [graph]); } catch { /* may not exist */ }
            finally { await pool.query("SELECT pg_advisory_unlock($1)", [graphBootstrapLockKey()]).catch(() => {}); }
        }
        if (schema) await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    } finally { await pool.end(); }
}

async function countEmbedded(schema) {
    const { default: pg } = await import("pg");
    const pool = new pg.Pool({ connectionString: HDB_URL, max: 1 });
    try {
        const { rows } = await pool.query(`SELECT count(*)::int AS n FROM "${schema}".facts WHERE embedding IS NOT NULL`);
        return rows[0]?.n ?? 0;
    } finally { await pool.end(); }
}

async function pollUntil(fn, { timeoutMs = 180_000, intervalMs = 1_500, label = "condition" } = {}) {
    const start = Date.now();
    for (;;) {
        if (await fn()) return;
        if (Date.now() - start > timeoutMs) throw new Error(`pollUntil timed out waiting for: ${label}`);
        await new Promise((r) => setTimeout(r, intervalMs));
    }
}

// ── Tier 1: base fact store ONLY ─────────────────────────────────────────────
describe("Tier 1: base fact store ONLY (through the tool layer)", () => {
    let factStore, schema;

    beforeAll(async () => {
        ({ schema } = uniqueNames("base"));
        factStore = await PgFactStore.create(PG_URL, schema);
        await factStore.initialize();
    }, 60_000);
    afterAll(async () => {
        await factStore?.close().catch(() => {});
        if (schema) await dropPgSchema(schema).catch(() => {});
    });

    it("composes ONLY base KV tools — no search, no graph, no crawl", () => {
        assertEqual(isEnhancedFactStore(factStore), false, "PgFactStore is a plain FactStore");
        // A base-only deployment never passes enhancedFactStore or a graphStore,
        // so the composed surface is exactly the base KV tools.
        const names = new Set(createFactTools({ factStore }).map((t) => t.name));
        assert(names.has("store_fact") && names.has("read_facts") && names.has("delete_fact"), "base KV tools present");
        assert(!names.has("facts_search") && !names.has("facts_similar"), "no enhanced search tools on a base store");
        assert(![...names].some((n) => n.startsWith("graph_")), "no graph tools without a graph store");
        assert(!names.has("facts_read_uncrawled"), "no harvester crawl tools without a graph store");
    });

    it("store_fact → read_facts → delete_fact round-trips through the handlers", async () => {
        const tools = createFactTools({ factStore });
        const storeFact = byName(tools, "store_fact");
        const readFacts = byName(tools, "read_facts");
        const deleteFact = byName(tools, "delete_fact");
        const key = `tier1/${Math.random().toString(36).slice(2, 8)}`;

        const stored = await storeFact.handler({ key, value: { v: 1 }, shared: true }, { sessionId: "t1" });
        assert(!stored.error, `store_fact via the tool succeeded (${stored.error ?? ""})`);

        const read = await readFacts.handler({ scope: "shared", key_pattern: key }, { sessionId: "t1" });
        assert(read.facts.some((f) => f.key === key), "stored fact reads back through read_facts");

        const del = await deleteFact.handler({ key, shared: true }, { sessionId: "t1" });
        assert(del.deleted === true || Number(del.deleted) >= 1, "delete_fact removes the fact");

        const after = await readFacts.handler({ scope: "shared", key_pattern: key }, { sessionId: "t1" });
        assert(!after.facts.some((f) => f.key === key), "deleted fact no longer reads back");
    });
});

// ── Tier 2: base + graph store, super basic harvester ────────────────────────
describe.skipIf(!HAS_HDB)("Tier 2: base fact store + graph store (super basic harvester)", () => {
    let factStore, graphStore, names;

    beforeAll(async () => {
        names = uniqueNames("basegraph");
        factStore = await PgFactStore.create(PG_URL, names.schema);
        await factStore.initialize();
        graphStore = await createGraphStoreForUrl(HDB_URL, names.graph);
        await graphStore.initialize();
    }, 120_000);
    afterAll(async () => {
        await factStore?.close().catch(() => {});
        await graphStore?.close().catch(() => {});
        if (names) {
            await dropHdb(null, names.graph).catch(() => {});
            await dropPgSchema(names.schema).catch(() => {});
        }
    });

    it("base + graph surface has graph tools but NO enhanced search tools", () => {
        assertEqual(isEnhancedFactStore(factStore), false, "base store stays a plain FactStore even beside a graph");
        const factNames = createFactTools({ factStore }).map((t) => t.name);
        const graphNames = createGraphTools({ factStore, graphStore, agentIdentity: "default", ...graphAccess }).map((t) => t.name);
        const names2 = new Set([...factNames, ...graphNames]);
        assert(names2.has("graph_search_nodes") && names2.has("graph_search_edges"), "graph read tools present");
        assert(!names2.has("facts_search") && !names2.has("facts_similar"), "a base store yields NO search tools even beside a graph");
    });

    it("super basic harvester: store_fact → read_uncrawled → graph node → mark_crawled → resolve", async () => {
        const runId = Math.random().toString(36).slice(2, 8);
        const ns = `intake/tier2-${runId}/`;
        const storeFact = byName(createFactTools({ factStore }), "store_fact");
        const harv = createGraphTools({
            factStore, graphStore, agentIdentity: "app-harvester", isHarvester: true, agentId: "app-harvester", ...graphAccess,
        });
        const readUncrawled = byName(harv, "facts_read_uncrawled");
        const markCrawled = byName(harv, "facts_set_crawled");
        const upsertNode = byName(harv, "graph_upsert_node");
        const searchNodes = byName(harv, "graph_search_nodes");

        const factKey = `${ns}widget`;
        await storeFact.handler({ key: factKey, value: { name: "Widget", text: "Widget powers the line" }, shared: true }, { sessionId: "h" });

        const queue = await readUncrawled.handler({ namespace: ns, limit: 50 }, { sessionId: "h" });
        const queued = queue.facts.find((f) => f.key === factKey);
        assert(queued && typeof queued.etag === "number" && queued.etag > 0, "intake fact is queued with an etag receipt");

        const node = await upsertNode.handler({ kind: "thing", name: `Widget-${runId}`, evidence: [queued.scopeKey] }, { sessionId: "h" });
        assert(node.nodeKey, "graph node created from the intake fact");

        const marked = await markCrawled.handler({ scopeKeys: [{ scopeKey: queued.scopeKey, etag: queued.etag }] }, { sessionId: "h" });
        assertEqual(marked.affected, 1, "the receipt stamps the fact crawled");
        const after = await readUncrawled.handler({ namespace: ns, limit: 50 }, { sessionId: "h" });
        assert(!after.facts.some((f) => f.key === factKey), "harvested fact left the crawl queue");

        const hit = (await searchNodes.handler({ nameLike: `Widget-${runId}` }, { sessionId: "h" })).find((n) => n.nodeKey === node.nodeKey);
        assert(hit && hit.evidence.includes(queued.scopeKey), "node carries the fact scopeKey as evidence");
        const resolved = await factStore.readFacts({ scopeKeys: hit.evidence }, { unrestricted: true });
        assert(resolved.facts.some((f) => f.key === factKey), "evidence resolves back to the source fact (cross-provider)");
    }, 120_000);
});

// ── Tier 3: enhanced fact store ONLY, all search modes ───────────────────────
describe.skipIf(!HAS_HDB || !HAS_EMBED)("Tier 3: enhanced fact store ONLY (lexical / semantic / hybrid / similar)", () => {
    let factStore, schema;

    beforeAll(async () => {
        ({ schema } = uniqueNames("enh"));
        // Embedding config at construction sets the column dim (1536) AND lights
        // capabilities.embedder; the durable in-DB loop does the embedding.
        factStore = await createFactStoreForUrl(HDB_URL, schema, { provider: "horizon", embedding: EMBED_CFG });
        await factStore.initialize();
        await factStore.configureEmbedder(EMBED_CFG);
        await factStore.startEmbedder({ intervalSeconds: 1, batch: 16 });
    }, 120_000);
    afterAll(async () => {
        await factStore?.stopEmbedder?.("tier3 teardown").catch(() => {});
        await factStore?.close().catch(() => {});
        if (schema) await dropHdb(schema, schema).catch(() => {});
    }, 120_000);

    const CORPUS = [
        { key: "corpus/tier3/jsonb", text: "jsonb subscripting assignment semantics in PostgreSQL" },
        { key: "corpus/tier3/jsonb2", text: "subscript syntax for jsonb columns and missing keys" },
        { key: "corpus/tier3/cooking", text: "a recipe for slow-cooked lamb with rosemary" },
    ];

    it("enhanced (no graph) surface has search tools but NO graph tools", () => {
        assert(isEnhancedFactStore(factStore), "horizon fact store is an EnhancedFactStore");
        assertEqual(factStore.capabilities.search, true, "advertises search capability");
        const names = new Set(createFactTools({ factStore, enhancedFactStore: factStore, agentIdentity: "agent-tuner" }).map((t) => t.name));
        assert(names.has("facts_search") && names.has("facts_similar"), "enhanced store lights up the search tools");
        assert(![...names].some((n) => n.startsWith("graph_")), "no graph tools without a graph store");
    });

    it("all search modes return results through facts_search / facts_similar", async () => {
        for (const c of CORPUS) await factStore.storeFact({ key: c.key, value: { text: c.text }, shared: true });
        await pollUntil(() => countEmbedded(schema).then((n) => n >= CORPUS.length), { label: "corpus embedded", timeoutMs: 180_000 });

        // agent-tuner → unrestricted investigator read surface, so a missed ACL
        // grant can never make these assertions vacuous.
        const tools = createFactTools({ factStore, enhancedFactStore: factStore, agentIdentity: "agent-tuner" });
        const search = byName(tools, "facts_search");
        const similar = byName(tools, "facts_similar");

        // Lexical (BM25 keyword) — works off search_text, independent of vectors.
        const lex = await search.handler({ query: "jsonb subscript", mode: "lexical", limit: 5 }, { sessionId: "t3" });
        assert(lex.facts.some((f) => f.key?.startsWith("corpus/tier3/jsonb")), "lexical search finds the jsonb facts");

        // Semantic (natural-language query, embedded at search time vs stored vectors).
        const sem = await search.handler({ query: "how do I index nested JSON fields", mode: "semantic", limit: 5 }, { sessionId: "t3" });
        const semKeys = sem.facts.map((f) => f.key);
        assert(semKeys.includes("corpus/tier3/jsonb") || semKeys.includes("corpus/tier3/jsonb2"), "semantic search finds the related jsonb facts");
        const cookRank = semKeys.indexOf("corpus/tier3/cooking");
        if (cookRank !== -1) {
            const best = Math.min(
                semKeys.indexOf("corpus/tier3/jsonb") === -1 ? Infinity : semKeys.indexOf("corpus/tier3/jsonb"),
                semKeys.indexOf("corpus/tier3/jsonb2") === -1 ? Infinity : semKeys.indexOf("corpus/tier3/jsonb2"),
            );
            assert(best < cookRank, "the clearly-related jsonb facts outrank the unrelated cooking fact");
        }

        // Hybrid (lexical ⊕ semantic fusion) — top hit carries at least one signal.
        const hyb = await search.handler({ query: "jsonb subscript", mode: "hybrid", limit: 5 }, { sessionId: "t3" });
        assert(hyb.facts.length > 0, "hybrid search returns results");
        assert(hyb.facts[0].signals == null || hyb.facts[0].signals.lexical !== undefined || hyb.facts[0].signals.semantic !== undefined,
            "hybrid top hit carries a fusion signal");

        // Similar (vector kNN over a stored embedding — no query text).
        const sim = await similar.handler({ scopeKey: "shared:corpus/tier3/jsonb", k: 5 }, { sessionId: "t3" });
        assert(sim.facts.length >= 1, "facts_similar returns neighbours of the anchor fact");
        assert(sim.facts.some((f) => f.key === "corpus/tier3/jsonb2"), "the nearest neighbour of a jsonb fact is the other jsonb fact");
    }, 240_000);
});

// ── Tier 4: enhanced + graph store, super basic harvester ────────────────────
describe.skipIf(!HAS_HDB)("Tier 4: enhanced fact store + graph store (super basic harvester)", () => {
    let factStore, graphStore, names;

    beforeAll(async () => {
        names = uniqueNames("enhgraph");
        // No embedding endpoint needed: the harvester reads the crawl queue with
        // embeddedOnly=false, so the harvest round-trip never waits on vectors.
        factStore = await createFactStoreForUrl(HDB_URL, names.schema, { provider: "horizon" });
        await factStore.initialize();
        graphStore = await createGraphStoreForUrl(HDB_URL, names.graph);
        await graphStore.initialize();
    }, 120_000);
    afterAll(async () => {
        await factStore?.close().catch(() => {});
        await graphStore?.close().catch(() => {});
        if (names) await dropHdb(names.schema, names.graph).catch(() => {});
    }, 120_000);

    it("enhanced + graph is the FULL surface: search tools AND graph tools", () => {
        assert(isEnhancedFactStore(factStore), "horizon fact store is an EnhancedFactStore");
        const factNames = createFactTools({ factStore, enhancedFactStore: factStore, agentIdentity: "default" }).map((t) => t.name);
        const graphNames = createGraphTools({ factStore, graphStore, agentIdentity: "default", ...graphAccess }).map((t) => t.name);
        const all = new Set([...factNames, ...graphNames]);
        assert(all.has("facts_search") && all.has("facts_similar"), "enhanced store lights up search tools");
        assert(all.has("graph_search_nodes") && all.has("graph_search_edges"), "graph store lights up graph read tools");
    });

    it("super basic harvester drives a real graph harvest off the enhanced store", async () => {
        const runId = Math.random().toString(36).slice(2, 8);
        const ns = `intake/tier4-${runId}/`;
        const storeFact = byName(createFactTools({ factStore, enhancedFactStore: factStore }), "store_fact");
        const harv = createGraphTools({
            factStore, graphStore, agentIdentity: "app-harvester", isHarvester: true, agentId: "app-harvester", ...graphAccess,
        });
        const readUncrawled = byName(harv, "facts_read_uncrawled");
        const markCrawled = byName(harv, "facts_set_crawled");
        const upsertNode = byName(harv, "graph_upsert_node");
        const searchNodes = byName(harv, "graph_search_nodes");

        const factKey = `${ns}gadget`;
        await storeFact.handler({ key: factKey, value: { name: "Gadget", text: "Gadget calibrates the sensor" }, shared: true }, { sessionId: "h" });

        const queue = await readUncrawled.handler({ namespace: ns, limit: 50 }, { sessionId: "h" });
        const queued = queue.facts.find((f) => f.key === factKey);
        assert(queued && typeof queued.etag === "number" && queued.etag > 0, "intake fact queued with an etag (no embedder required)");

        const node = await upsertNode.handler({ kind: "thing", name: `Gadget-${runId}`, evidence: [queued.scopeKey] }, { sessionId: "h" });
        assert(node.nodeKey, "graph node created from the enhanced-store intake fact");

        const marked = await markCrawled.handler({ scopeKeys: [{ scopeKey: queued.scopeKey, etag: queued.etag }] }, { sessionId: "h" });
        assertEqual(marked.affected, 1, "receipt stamps the fact crawled");
        const after = await readUncrawled.handler({ namespace: ns, limit: 50 }, { sessionId: "h" });
        assert(!after.facts.some((f) => f.key === factKey), "harvested fact left the crawl queue");

        const hit = (await searchNodes.handler({ nameLike: `Gadget-${runId}` }, { sessionId: "h" })).find((n) => n.nodeKey === node.nodeKey);
        assert(hit && hit.evidence.includes(queued.scopeKey), "node carries the fact scopeKey as evidence");
        const resolved = await factStore.readFacts({ scopeKeys: hit.evidence }, { unrestricted: true });
        assert(resolved.facts.some((f) => f.key === factKey), "evidence resolves back through the enhanced fact provider");
    }, 120_000);
});
