// eval/validate-graph-split.mjs — SCOPED graph construction + validation eval
// for the SPLIT-PROVIDER shape (07 D2).
//
// Validates that a harvested graph is well-formed AND that the two SEPARATE
// providers compose: the graph (HorizonDBGraphStore) holds structure + evidence
// scopeKeys, and those scopeKeys resolve back to real fact values through the
// SEPARATE fact provider (HorizonDBFactStore). This is the cross-provider
// round-trip the split must preserve — graphStore.searchGraphNodes(...) ->
// scopeKeys -> factStore.readFacts({ scopeKeys }).
//
// Usage (reads an ALREADY-harvested schema/graph — run after harvest-once):
//   HARVEST_SCHEMA=... HARVEST_GRAPH=... QUALITY_EMBED_DIM=... \
//     node --env-file-if-exists=.env eval/validate-graph-split.mjs
//
// Gates (SKIP, exit 0): HORIZON_DATABASE_URL.

import assert from "node:assert/strict";

function normalizeDbUrl(raw) {
    if (!raw) return "";
    if (!/[?&]sslmode=/.test(raw)) return raw;
    if (/[?&]uselibpqcompat=/.test(raw)) return raw;
    return raw + (raw.includes("?") ? "&" : "?") + "uselibpqcompat=true";
}

const DB_URL = normalizeDbUrl(process.env.HORIZON_DATABASE_URL || "");
const SCHEMA = process.env.HARVEST_SCHEMA;
const GRAPH = process.env.HARVEST_GRAPH;
const DIM = Number(process.env.QUALITY_EMBED_DIM || process.env.HORIZON_EMBED_DIM || 1536);

if (!DB_URL) { console.log("SKIP validate-graph-split — missing HORIZON_DATABASE_URL."); process.exit(0); }
if (!SCHEMA || !GRAPH) { console.error("validate-graph-split requires HARVEST_SCHEMA + HARVEST_GRAPH."); process.exit(1); }

async function main() {
    console.log(`validate-graph-split  schema=${SCHEMA} graph=${GRAPH} dim=${DIM}`);

    // Construct the TWO SEPARATE providers explicitly — this is the shape under
    // test. They share one HorizonDB here (the bundled case), but are distinct
    // objects with distinct pools (07 D2).
    const { HorizonDBFactStore, HorizonDBGraphStore } = await import("../dist/src/index.js");
    const cfg = { connectionString: DB_URL, schema: SCHEMA, graphName: GRAPH, embeddingDim: DIM };
    const factStore = await HorizonDBFactStore.create(cfg);
    const graphStore = await HorizonDBGraphStore.create(cfg);

    assert.notEqual(factStore, graphStore, "fact and graph providers must be distinct objects");
    assert.equal(typeof factStore.searchFacts, "function", "fact provider exposes searchFacts");
    assert.equal(typeof factStore.searchGraphNodes, "undefined", "fact provider must NOT expose graph methods (split, 07 D2)");
    assert.equal(typeof graphStore.searchGraphNodes, "function", "graph provider exposes searchGraphNodes");
    assert.equal(typeof graphStore.searchFacts, "undefined", "graph provider must NOT expose fact methods (split, 07 D2)");
    console.log("  ✓ providers are separate; neither leaks the other's surface");

    const all = { unrestricted: true };
    const failures = [];
    try {
        // 1) Structure exists — the harvest built nodes.
        const nodes = await graphStore.searchGraphNodes({ limit: 200 }, all);
        console.log(`  graph nodes (sample up to 200): ${nodes.length}`);
        if (nodes.length === 0) failures.push("no graph nodes — harvest produced an empty graph");

        // 2) Structure exists — the harvest built edges. Probe a few nodes'
        //    neighbourhoods until we find edges (some nodes are leaves).
        let edgeCount = 0;
        for (const n of nodes.slice(0, 25)) {
            const sub = await graphStore.graphNeighbourhood(n.nodeKey, 1, all);
            edgeCount += sub.edges.length;
            if (edgeCount > 0) break;
        }
        console.log(`  edges found probing first nodes: ${edgeCount}`);
        if (nodes.length >= 2 && edgeCount === 0) {
            failures.push("graph has >=2 nodes but no edges — relationships were not harvested");
        }

        // 3) CROSS-PROVIDER round-trip (the split's load-bearing invariant):
        //    a node's evidence scopeKeys must resolve to real facts through the
        //    SEPARATE fact provider.
        const evidenced = nodes.find((n) => Array.isArray(n.evidence) && n.evidence.length > 0);
        if (!evidenced) {
            failures.push("no node carries evidence — cannot validate cross-provider resolution");
        } else {
            const scopeKeys = evidenced.evidence.slice(0, 5);
            const { facts } = await factStore.readFacts({ scopeKeys }, all);
            console.log(`  cross-provider: node "${evidenced.name}" has ${evidenced.evidence.length} evidence key(s); ` +
                `resolved ${facts.length}/${scopeKeys.length} via the SEPARATE fact provider`);
            if (facts.length === 0) {
                failures.push("evidence scopeKeys did not resolve to facts through the fact provider — cross-provider link broken");
            } else {
                const got = new Set(facts.map((f) => f.scopeKey));
                const missing = scopeKeys.filter((k) => !got.has(k));
                if (missing.length === scopeKeys.length) {
                    failures.push(`none of the probed evidence keys resolved (${scopeKeys.join(", ")})`);
                }
            }
        }

        // 4) Seed pivot: a resolved evidence scopeKey, fed back as a graph seed,
        //    must re-reach its node (facts_search -> graph pivot path).
        if (evidenced && evidenced.evidence.length > 0) {
            const seed = evidenced.evidence[0];
            const pivot = await graphStore.searchGraphNodes({ seeds: [seed], depth: 1 }, all);
            console.log(`  seed pivot: evidence "${seed}" reaches ${pivot.length} node(s)`);
            if (pivot.length === 0) failures.push("seed pivot from an evidence key reached no nodes (EVIDENCED_BY broken)");
        }
    } finally {
        await factStore.close();
        await graphStore.close();
    }

    if (failures.length > 0) {
        console.error(`\n✗ validation FAILED (${failures.length}):`);
        for (const f of failures) console.error(`   - ${f}`);
        process.exit(1);
    }
    console.log(`\n✓ graph construction + split-provider validation PASSED`);
}

main().catch((err) => {
    console.error("\nVALIDATE ERROR:", err?.stack || err?.message || err);
    process.exit(1);
});
