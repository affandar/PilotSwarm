// DB-less unit tests for the enhanced-facts core. These run in CI without a
// HorizonDB instance. Run: `npm test` (uses node --test).
//
// NOTE: tests import from the compiled output in dist/, so run `npm run build`
// first (the `test` script assumes a prior build, matching repo conventions).

import { test } from "node:test";
import assert from "node:assert/strict";

import {
    buildWebsearchQuery,
    namespacePrefix,
    normalize,
    fuseWeighted,
    fuseRRF,
} from "../dist/src/query-builder.js";

test("buildWebsearchQuery normalizes whitespace and rejects empty", () => {
    assert.equal(buildWebsearchQuery("  hydrate   blob  store "), "hydrate blob store");
    assert.equal(buildWebsearchQuery(""), null);
    assert.equal(buildWebsearchQuery("   "), null);
    // websearch operators pass through untouched (data, not code).
    assert.equal(buildWebsearchQuery('hydration "blob store" -sqlite'), 'hydration "blob store" -sqlite');
});

test("namespacePrefix maps a namespace to a LIKE prefix", () => {
    assert.equal(namespacePrefix("skills"), "skills/%");
    assert.equal(namespacePrefix("skills/"), "skills/%");
    assert.equal(namespacePrefix(undefined), null);
    assert.equal(namespacePrefix(""), null);
});

test("normalize maps to 0..1 and handles constant lists", () => {
    assert.deepEqual(normalize([0, 5, 10]), [0, 0.5, 1]);
    assert.deepEqual(normalize([3, 3, 3]), [1, 1, 1]); // constant non-zero → 1
    assert.deepEqual(normalize([0, 0]), [0, 0]); // constant zero → 0
    assert.deepEqual(normalize([]), []);
});

test("fuseWeighted: a fact strong in two signals beats single-signal facts", () => {
    // IMPORTANT: min-max normalization sends each signal's *minimum* to 0, so a
    // realistic pool needs a weak baseline per signal — otherwise a tiny
    // degenerate pool can zero out a 'strong in both' fact (a known min-max
    // pathology we rely on RRF to avoid). With a proper pool the intuition holds.
    const fused = fuseWeighted([
        { scopeKey: "a", lexical: 0.9, semantic: 0.9 }, // strong in both
        { scopeKey: "b", lexical: 1.0 },                // only lexical (best lexical)
        { scopeKey: "c", semantic: 1.0 },               // only semantic (best semantic)
        { scopeKey: "d", lexical: 0.05 },               // weak lexical baseline
        { scopeKey: "e", semantic: 0.05 },              // weak semantic baseline
    ]);
    assert.equal(fused[0].scopeKey, "a");
    // signals are preserved verbatim for tuning/debugging
    assert.equal(fused[0].signals.lexical, 0.9);
    assert.equal(fused[0].signals.semantic, 0.9);
});

test("fuseWeighted: missing signal contributes 0, not a penalty crash", () => {
    const fused = fuseWeighted([
        { scopeKey: "a", lexical: 10 },
        { scopeKey: "b", lexical: 0, semantic: 1 },
    ]);
    // both appear; no NaN scores
    assert.equal(fused.length, 2);
    for (const f of fused) assert.ok(Number.isFinite(f.score));
});

test("fuseWeighted: graph weight default (0.5) is lower than lexical/semantic", () => {
    // Same normalized contribution from one signal, different weights.
    const lexicalOnly = fuseWeighted([{ scopeKey: "x", lexical: 1 }, { scopeKey: "y", lexical: 0 }]);
    const graphOnly = fuseWeighted([{ scopeKey: "x", graph: 1 }, { scopeKey: "y", graph: 0 }]);
    assert.ok(lexicalOnly[0].score > graphOnly[0].score);
});

test("fuseWeighted: custom weights override defaults", () => {
    const fused = fuseWeighted(
        [
            { scopeKey: "a", lexical: 1, semantic: 0 },
            { scopeKey: "b", lexical: 0, semantic: 1 },
        ],
        { lexical: 0, semantic: 1 },
    );
    assert.equal(fused[0].scopeKey, "b"); // lexical zeroed out
});

test("fuseRRF: rank-based fusion is scale-free", () => {
    // Lexical scores are huge (ts_rank), semantic are tiny (cosine) — RRF should
    // not let the large-scale signal dominate purely by magnitude.
    const fused = fuseRRF([
        { scopeKey: "a", lexical: 1000, semantic: 0.1 },
        { scopeKey: "b", lexical: 1, semantic: 0.99 },
    ]);
    // 'a' ranks #1 lexical + #2 semantic; 'b' ranks #2 lexical + #1 semantic.
    // With equal weights they tie on rank sum → deterministic tiebreak by key.
    assert.equal(fused.length, 2);
    assert.ok(Math.abs(fused[0].score - fused[1].score) < 1e-9);
    assert.equal(fused[0].scopeKey, "a"); // localeCompare tiebreak
});

test("fuseWeighted is deterministic (stable tiebreak by scopeKey)", () => {
    const input = [
        { scopeKey: "z", lexical: 1 },
        { scopeKey: "a", lexical: 1 },
    ];
    const r1 = fuseWeighted(input);
    const r2 = fuseWeighted(input);
    assert.deepEqual(r1.map((c) => c.scopeKey), r2.map((c) => c.scopeKey));
    assert.equal(r1[0].scopeKey, "a"); // tie → lexicographic
});
