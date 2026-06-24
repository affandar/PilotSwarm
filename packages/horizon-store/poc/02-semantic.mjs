// poc/02-semantic.mjs — Phase 2: embedding column + ANN recall (SKELETON).
//
// This PoC requires HorizonDB AI pipelines (or an external embedding model) to
// populate facts.embedding. It is a structured skeleton: it sets up the schema
// and documents the exact flow, then stops at the embedding call, which must be
// wired to whatever embedding endpoint the HorizonDB AI pipeline exposes.
//
// Flow to validate:
//   1. Seed facts (no embeddings yet).
//   2. Run the embed pipeline (embed_new_facts) — drains embedding IS NULL.
//   3. Embed a query string with the same model.
//   4. facts_semantic_candidates(query_embedding) returns the conceptually
//      related fact even with NO lexical term overlap (the headline win).
//   5. ACL resolution (facts_resolve_visible) still filters by scope.
//
// Run: npm run build && node --env-file=.env poc/02-semantic.mjs

import { connect, SCHEMA } from "./_common.mjs";

async function embed(_text) {
    // TODO(incubation): wire to the HorizonDB AI-pipeline embedding function,
    // e.g. SELECT ai.embed($1) or the model endpoint from .env (HZ_EMBED_MODEL).
    throw new Error(
        "02-semantic is a skeleton: connect embed() to the HorizonDB AI-pipeline " +
        "embedding function before running. See SPEC.md §2.1 (embed_new_facts).",
    );
}

async function main() {
    const client = await connect();
    try {
        console.log(`Schema: ${SCHEMA}`);
        console.log("Step 1: seed facts (done via _common.seedFact).");
        console.log("Step 2: run embed_new_facts pipeline (004_pipelines.sql).");
        console.log("Step 3: embed the query string with the same model.");
        await embed("how do we recover a session that won't hydrate?");
        // Steps 4–5 unreachable until embed() is wired. Intentional.
    } finally {
        await client.end();
    }
}

main().catch((err) => {
    console.error(`\n[skeleton] ${err.message}`);
    process.exit(3); // distinct code: "not yet wired", not a logic failure
});
