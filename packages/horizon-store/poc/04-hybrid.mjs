// poc/04-hybrid.mjs — Phase 4: end-to-end hybrid fusion (SKELETON, exercises real fusion).
//
// This PoC ties the DB-less fusion core (src/query-builder.ts) to the three
// candidate sources. The fusion step runs for real against synthetic candidates
// so the wiring is demonstrable today; the DB-backed candidate fetches for
// semantic/graph are wired once 02/03 land.
//
// Run: npm run build && node --env-file=.env poc/04-hybrid.mjs

import { fuseWeighted, fuseRRF } from "../dist/src/query-builder.js";

// Synthetic candidates standing in for:
//   lexical  → facts_lexical_candidates
//   semantic → facts_semantic_candidates
//   graph    → AGE proximity score
const candidates = [
    { scopeKey: "shared:skills/hydration-recovery", lexical: 0.31, semantic: 0.88, graph: 0.6 },
    { scopeKey: "shared:skills/blob-store-config", lexical: 0.05, semantic: 0.71, graph: 0.9 },
    { scopeKey: "shared:skills/unrelated-networking", lexical: 0.40, semantic: 0.12 },
    { scopeKey: "session:owner:notes/hydrate-log", lexical: 0.22, graph: 0.3 },
];

console.log("Weighted-normalized fusion (default weights):");
for (const c of fuseWeighted(candidates)) {
    console.log(`  ${c.score.toFixed(3)}  ${c.scopeKey}  ${JSON.stringify(c.signals)}`);
}

console.log("\nReciprocal Rank Fusion (scale-free):");
for (const c of fuseRRF(candidates)) {
    console.log(`  ${c.score.toFixed(4)}  ${c.scopeKey}`);
}

console.log(
    "\n[skeleton] Fusion runs for real above. DB-backed semantic/graph candidate\n" +
    "fetches are wired once PoCs 02 and 03 land. ACL resolution (facts_resolve_visible)\n" +
    "is applied AFTER fusion — fusion never sees values, only scope_keys + scores.",
);
