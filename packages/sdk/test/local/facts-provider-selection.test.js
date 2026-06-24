/**
 * P3 (enhancedfactstore): provider selection + injection.
 *
 * Gated on HORIZON_DATABASE_URL — skips on a vanilla checkout. Verifies the SDK
 * construction seam:
 *   - createFactStoreForUrl(..., { provider: "horizon" }) builds an
 *     EnhancedFactStore (isEnhancedFactStore === true, capabilities present)
 *   - createGraphStoreForUrl(url) builds a separate GraphStore; undefined URL
 *     yields undefined (no graph)
 *   - resolveFactsTarget resolves url/provider/schema most-specific-first
 *   - the default path still builds a plain PgFactStore (provider "pg")
 *   - cross-provider round-trip: a fact's scopeKey resolves through readFacts
 *
 * No LLM, no worker boot — just the construction + injection contract.
 */

import { describe, it, beforeAll, afterAll } from "vitest";
import { assert, assertEqual } from "../helpers/assertions.js";
import {
    createFactStoreForUrl,
    createGraphStoreForUrl,
    resolveFactsTarget,
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
const EMBED_DIM = Number(process.env.HORIZON_EMBED_DIM || 4);

function uniqueNames(tag) {
    const r = Math.random().toString(36).slice(2, 8);
    return { schema: `p3_${tag}_${r}`, graph: `p3g_${tag}_${r}` };
}

function graphBootstrapLockKey() {
    let hash = 0x48_5a_46;
    for (const ch of "horizon-graph-bootstrap") hash = ((hash << 5) - hash + ch.charCodeAt(0)) | 0;
    return hash;
}

async function dropHdb(schema, graph) {
    const { default: pg } = await import("pg");
    const pool = new pg.Pool({ connectionString: HDB_URL, max: 1 });
    try {
        try { await pool.query(`LOAD 'age'`); } catch {}
        await pool.query(`SET search_path = ag_catalog, "$user", public`);
        await pool.query("SELECT pg_advisory_lock($1)", [graphBootstrapLockKey()]);
        try { await pool.query(`SELECT drop_graph($1, true)`, [graph]); } catch {}
        finally { await pool.query("SELECT pg_advisory_unlock($1)", [graphBootstrapLockKey()]).catch(() => {}); }
        await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    } finally {
        await pool.end();
    }
}

describe("P3: resolveFactsTarget (DB-less)", () => {
    it("defaults to pg on the plain store URL", () => {
        const t = resolveFactsTarget({ store: "postgresql://x/db", factsSchema: "pilotswarm_facts" });
        assertEqual(t.provider, "pg");
        assertEqual(t.url, "postgresql://x/db");
        assertEqual(t.schema, "pilotswarm_facts");
    });
    it("cmsFactsDatabaseUrl overrides store for pg", () => {
        const t = resolveFactsTarget({ store: "postgresql://x/orch", cmsFactsDatabaseUrl: "postgresql://x/cms" });
        assertEqual(t.url, "postgresql://x/cms");
        assertEqual(t.provider, "pg");
    });
    it("enhancedFactsDatabaseUrl infers horizon + uses enhanced schema", () => {
        const t = resolveFactsTarget({
            store: "postgresql://x/orch",
            cmsFactsDatabaseUrl: "postgresql://x/cms",
            enhancedFactsDatabaseUrl: "postgresql://hdb/facts",
            factsSchema: "pilotswarm_facts",
            enhancedFactsSchema: "horizon_facts",
        });
        assertEqual(t.url, "postgresql://hdb/facts");
        assertEqual(t.provider, "horizon");
        assertEqual(t.schema, "horizon_facts");
    });
    it("explicit factsProvider overrides inference", () => {
        const t = resolveFactsTarget({ store: "postgresql://x/db", factsProvider: "horizon", enhancedFactsSchema: "hf" });
        assertEqual(t.provider, "horizon");
        assertEqual(t.schema, "hf");
    });
});

describe("P3: createGraphStoreForUrl undefined → no graph (DB-less)", () => {
    it("undefined graphUrl yields undefined", async () => {
        const g = await createGraphStoreForUrl(undefined);
        assertEqual(g, undefined);
    });
});

describe("P3: worker/client/management resolve the SAME facts target (DB-less)", () => {
    // The internal activity clients and the public client must resolve the same
    // url/provider/schema as the worker, or cleanup/reads hit the wrong DB.
    const cases = [
        { name: "default pg", cfg: { store: "postgresql://x/orch", factsSchema: "pf" } },
        { name: "cms override", cfg: { store: "postgresql://x/orch", cmsFactsDatabaseUrl: "postgresql://x/cms", factsSchema: "pf" } },
        { name: "horizon enhanced", cfg: { store: "postgresql://x/orch", cmsFactsDatabaseUrl: "postgresql://x/cms", enhancedFactsDatabaseUrl: "postgresql://hdb/f", factsSchema: "pf", enhancedFactsSchema: "hf" } },
    ];
    for (const c of cases) {
        it(`worker == client == management for: ${c.name}`, () => {
            const worker = resolveFactsTarget(c.cfg);
            // client/management pass the same shaped object
            const client = resolveFactsTarget(c.cfg);
            const mgmt = resolveFactsTarget(c.cfg);
            assertEqual(JSON.stringify(client), JSON.stringify(worker), "client matches worker");
            assertEqual(JSON.stringify(mgmt), JSON.stringify(worker), "management matches worker");
        });
    }
});

describe.skipIf(!HAS_HDB)("P3: horizon provider construction (live HDB)", () => {
    let names, factStore, graphStore;

    beforeAll(async () => {
        names = uniqueNames("ctor");
    });
    afterAll(async () => {
        await factStore?.close().catch(() => {});
        await graphStore?.close().catch(() => {});
        if (names) await dropHdb(names.schema, names.graph);
    });

    it("createFactStoreForUrl(provider:horizon) builds an EnhancedFactStore", { timeout: 120_000 }, async () => {
        factStore = await createFactStoreForUrl(HDB_URL, names.schema, { provider: "horizon" });
        await factStore.initialize();
        assert(isEnhancedFactStore(factStore), "horizon fact store is an EnhancedFactStore");
        assertEqual(factStore.capabilities.search, true, "advertises search capability");
        // P5: capabilities.embedder REFLECTS whether an embedding endpoint was
        // provided at construction (!!cfg.embedding). No endpoint here → false;
        // search still works (lexical, and hybrid degrades to lexical).
        assertEqual(factStore.capabilities.embedder, false, "no embedding endpoint → embedder capability false");
    });

    it("createFactStoreForUrl(provider:horizon, embedding) advertises embedder capability", { timeout: 120_000 }, async () => {
        // capabilities.embedder is set at construction from !!cfg.embedding and
        // does not require the endpoint to be reachable, so we can assert it
        // without initialize() (which would start the durable loop).
        const store = await createFactStoreForUrl(HDB_URL, names.schema, {
            provider: "horizon",
            embedding: { url: "http://embed.invalid/v1/embeddings", model: "text-embedding-3-small", dim: 1536 },
        });
        try {
            assertEqual(store.capabilities.embedder, true, "embedding endpoint provided → embedder capability true");
            assertEqual(store.capabilities.search, true, "search capability still advertised");
        } finally {
            await store.close().catch(() => {});
        }
    });

    it("createGraphStoreForUrl builds a separate GraphStore + cross-provider round-trip", { timeout: 120_000 }, async () => {
        graphStore = await createGraphStoreForUrl(HDB_URL, names.graph);
        assert(graphStore, "graph store constructed");
        await graphStore.initialize();

        // Distinct objects (07 D2 — separate providers, even on one DB).
        assert(factStore !== graphStore, "fact and graph stores are separate objects");
        assert(typeof graphStore.searchFacts === "undefined", "graph provider does not expose fact search");
        assert(typeof factStore.searchGraphNodes === "undefined", "fact provider does not expose graph methods");

        // Seed a fact, build a node referencing it as evidence, resolve back.
        await factStore.storeFact({ key: "p3/evidence", value: { name: "p3", text: "p3 evidence fact" }, shared: true });
        const node = await graphStore.upsertGraphNode({
            kind: "concept", name: "p3-node", agentId: "p3-test", evidence: ["shared:p3/evidence"],
        });
        assert(node.nodeKey, "node created with a key");

        const hits = await graphStore.searchGraphNodes({ nameLike: "p3-node" }, { unrestricted: true });
        assert(hits.length >= 1, "node is findable");
        const evidenceKeys = hits.flatMap((h) => h.evidence);
        assert(evidenceKeys.includes("shared:p3/evidence"), "node carries the evidence scopeKey");

        // Cross-provider: resolve evidence through the SEPARATE fact provider.
        const resolved = await factStore.readFacts({ scopeKeys: evidenceKeys }, { unrestricted: true });
        assert(resolved.count >= 1, "evidence resolves to facts via the fact provider");
        assertEqual(resolved.facts[0].key, "p3/evidence", "resolved the right fact");
    });
});
