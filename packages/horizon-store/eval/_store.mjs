// eval/_store.mjs — construct the two SEPARATE providers (07 D2) and a combined
// facade for the eval harness.
//
// Production wires HorizonDBFactStore (EnhancedFactStore) and HorizonDBGraphStore
// (GraphStore) independently. The evals drive a full harvest (facts + graph) from
// one logical "store", so this helper builds both providers over one HorizonDB
// and returns a thin facade plus the individual providers. The facade can be
// passed as BOTH arguments to createFactsTools(factStore, graphStore, opts) —
// it carries every facts and graph method.

const FACT_METHODS = [
    "storeFact", "readFacts", "deleteFact", "deleteSessionFactsForSession",
    "getSessionFactsStats", "getFactsStatsForSessions", "getSharedFactsStats",
    "searchFacts", "similarFacts", "readUncrawledFacts", "setFactsCrawled",
    "configureEmbedder", "startEmbedder", "stopEmbedder", "embedderStatus",
];
const GRAPH_METHODS = [
    "searchGraphNodes", "searchGraphEdges", "graphNeighbourhood",
    "upsertGraphNode", "upsertGraphEdge", "mergeGraphNodes",
    "deleteGraphNode", "deleteGraphEdge",
];

export function combinedStore(factStore, graphStore) {
    const s = {};
    for (const m of FACT_METHODS) if (typeof factStore[m] === "function") s[m] = (...a) => factStore[m](...a);
    for (const m of GRAPH_METHODS) if (typeof graphStore[m] === "function") s[m] = (...a) => graphStore[m](...a);
    s.initialize = async () => { await factStore.initialize(); await graphStore.initialize(); };
    s.close = async () => { await factStore.close(); await graphStore.close(); };
    return s;
}

/** Build (and by default initialize) both providers on the given config; return
 *  the facade and the individual providers. Pass { initialize: false } to read an
 *  already-harvested store without re-running migrations. */
export async function makeEvalStore(cfg, { initialize = true } = {}) {
    const { HorizonDBFactStore, HorizonDBGraphStore } = await import("../dist/src/index.js");
    const factStore = await HorizonDBFactStore.create(cfg);
    const graphStore = await HorizonDBGraphStore.create(cfg);
    if (initialize) {
        await factStore.initialize();
        await graphStore.initialize();
    }
    return { store: combinedStore(factStore, graphStore), factStore, graphStore };
}
