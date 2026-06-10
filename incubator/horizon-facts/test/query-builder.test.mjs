// DB-less unit tests for the enhanced-facts core. These run in CI without a
// HorizonDB instance. Run: `npm test` (uses node --test, after `npm run build`).
//
// searchFacts is facts-store-only (01 §4.2): there is no graph signal.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
    buildLexicalQuery,
    namespacePrefix,
    normalize,
    fuseWeighted,
} from "../dist/src/query-builder.js";

test("buildLexicalQuery normalizes whitespace and rejects empty (04 L4)", () => {
    assert.equal(buildLexicalQuery("  hydrate   blob  store "), "hydrate blob store");
    assert.equal(buildLexicalQuery(""), null);
    assert.equal(buildLexicalQuery("   "), null);
    // operators/quotes pass through untouched (data, not code).
    assert.equal(buildLexicalQuery('hydration "blob store" -sqlite'), 'hydration "blob store" -sqlite');
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
    // min-max normalization sends each signal's *minimum* to 0, so a realistic
    // pool needs a weak baseline per signal.
    const fused = fuseWeighted([
        { scopeKey: "a", lexical: 0.9, semantic: 0.9 }, // strong in both
        { scopeKey: "b", lexical: 1.0 },                // only lexical (best lexical)
        { scopeKey: "c", semantic: 1.0 },               // only semantic (best semantic)
        { scopeKey: "d", lexical: 0.05 },               // weak lexical baseline
        { scopeKey: "e", semantic: 0.05 },              // weak semantic baseline
    ]);
    assert.equal(fused[0].scopeKey, "a");
    // signals preserved verbatim for tuning/debugging (ScoredFact.signals)
    assert.equal(fused[0].signals.lexical, 0.9);
    assert.equal(fused[0].signals.semantic, 0.9);
});

test("fuseWeighted: missing signal contributes 0, not a penalty crash", () => {
    const fused = fuseWeighted([
        { scopeKey: "a", lexical: 10 },
        { scopeKey: "b", lexical: 0, semantic: 1 },
    ]);
    assert.equal(fused.length, 2);
    for (const f of fused) assert.ok(Number.isFinite(f.score));
});

test("fuseWeighted: weight overrides emulate single-mode behaviour (04 H2/H3)", () => {
    const pool = [
        { scopeKey: "a", lexical: 1, semantic: 0 },
        { scopeKey: "b", lexical: 0, semantic: 1 },
    ];
    assert.equal(fuseWeighted(pool, { semantic: 0 })[0].scopeKey, "a", "semantic=0 ⇒ lexical-only");
    assert.equal(fuseWeighted(pool, { lexical: 0 })[0].scopeKey, "b", "lexical=0 ⇒ semantic-only");
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
