// poc/03-graph.mjs — Phase 3: AGE structural backfill + lineage traversal (SKELETON).
//
// Requires the AGE extension in HorizonDB. Structured skeleton documenting the
// flow; the Cypher MERGE/MATCH statements are canonical in ../sql/002_age_graph.sql.
//
// Flow to validate:
//   1. LOAD 'age'; create_graph('horizon_facts').
//   2. Backfill Session nodes + SPAWNED edges from a seeded spawn tree
//      (root → child → grandchild).
//   3. Backfill Fact nodes + STORED edges.
//   4. Lineage traversal: MATCH (root)-[:SPAWNED*0..]->(s) RETURN s.id.
//   5. Feed those session ids as granted_ids into facts_resolve_visible and
//      confirm a grandchild can read an ancestor's session-scoped fact, but a
//      sibling outside the tree cannot (the governance invariant).
//
// Run: npm run build && node --env-file=.env poc/03-graph.mjs

import { connect } from "./_common.mjs";

async function ensureAge(client) {
    try {
        await client.query("LOAD 'age'");
        await client.query('SET search_path = ag_catalog, "$user", public');
    } catch (err) {
        throw new Error(
            "AGE not available on this instance: " + err.message +
            "\nThis PoC requires HorizonDB with the AGE extension enabled.",
        );
    }
}

async function main() {
    const client = await connect();
    try {
        await ensureAge(client);
        console.log("AGE loaded. See ../sql/002_age_graph.sql for the canonical");
        console.log("backfill + lineage Cypher to drive steps 2–5.");
        // TODO(incubation): execute the backfill Cypher via cypher() calls, then
        // assert lineage visibility through facts_resolve_visible.
        console.log("\n[skeleton] backfill + traversal assertions not yet wired.");
        process.exit(3);
    } finally {
        await client.end();
    }
}

main().catch((err) => {
    console.error(`\n[skeleton] ${err.message}`);
    process.exit(3);
});
