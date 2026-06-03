// DB-less unit tests for the open-graph quality core. Run: npm test (after build).

import { test } from "node:test";
import assert from "node:assert/strict";

import {
    normalizeName,
    entityKey,
    mergeAliases,
    predicateKey,
    reinforceConfidence,
    validateAssertion,
    decideEdgeMerge,
} from "../dist/src/graph-model.js";

// ─── canonicalization ───────────────────────────────────────────────────────

test("normalizeName: case/whitespace/punctuation/diacritics folded", () => {
    assert.equal(normalizeName("  Tom   Lane "), "tom lane");
    assert.equal(normalizeName("Tom-Lane"), "tom lane");
    assert.equal(normalizeName("Peter Eisentraut"), "peter eisentraut");
    assert.equal(normalizeName("Álvaro Herrera"), "alvaro herrera"); // diacritics stripped
});

test("normalizeName: does NOT collapse semantically-distinct surface forms", () => {
    // "Tom Lane" and "tgl" are different strings — identity is the crawler's job,
    // not this function's. They must remain distinct keys.
    assert.notEqual(normalizeName("Tom Lane"), normalizeName("tgl"));
});

test("entityKey: kind + normalized name", () => {
    assert.equal(entityKey("person", "Tom Lane"), "person:tom-lane");
    assert.equal(entityKey("Code File", "src/backend/utils/adt/jsonbsubs.c"),
        "code_file:src-backend-utils-adt-jsonbsubs-c");
});

test("mergeAliases: dedups by surface form, preserves first-seen", () => {
    const merged = mergeAliases(["Tom Lane"], ["tom lane", "tgl", "Tom Lane"]);
    assert.deepEqual(merged, ["Tom Lane", "tgl"]); // "tom lane" dup of "Tom Lane"
});

// ─── predicate normalization ────────────────────────────────────────────────

test("predicateKey: surface variants of a predicate group together", () => {
    assert.equal(
        predicateKey("revives argument from"),
        predicateKey("revives the argument from"),
    );
    assert.equal(predicateKey("comments on"), "comment"); // "on" stopword, "comments" stemmed
});

test("predicateKey: genuinely different predicates stay distinct", () => {
    assert.notEqual(predicateKey("touches"), predicateKey("supersedes"));
    assert.notEqual(predicateKey("reviewed and approved"), predicateKey("reviewed but disagreed"));
});

// ─── confidence reinforcement ───────────────────────────────────────────────

test("reinforceConfidence: noisy-OR is monotonic and saturating", () => {
    const once = reinforceConfidence(0.6, 0.6);
    assert.ok(Math.abs(once - 0.84) < 1e-9);
    const twice = reinforceConfidence(once, 0.6);
    assert.ok(Math.abs(twice - 0.936) < 1e-9);
    assert.ok(twice > once && once > 0.6); // strictly increasing
    assert.ok(twice < 1); // never reaches certainty
});

test("reinforceConfidence: order-independent", () => {
    const a = reinforceConfidence(reinforceConfidence(0.3, 0.5), 0.8);
    const b = reinforceConfidence(reinforceConfidence(0.8, 0.5), 0.3);
    assert.ok(Math.abs(a - b) < 1e-9);
});

test("reinforceConfidence: clamps junk input", () => {
    assert.equal(reinforceConfidence(2, -1), 1 - (1 - 1) * (1 - 0)); // 1 and 0 clamps → 1
    assert.equal(reinforceConfidence(NaN, 0), 0);
});

// ─── assertion validation (the anti-hallucination guard) ────────────────────

const base = {
    fromKey: "person:tom-lane",
    toKey: "patch:v3-fix",
    predicate: "comments on",
    confidence: 0.9,
    evidence: ["shared:archive/msg/123"],
    agentId: "pg-crawler",
};

test("validateAssertion: a well-formed assertion passes", () => {
    assert.equal(validateAssertion(base), null);
});

test("validateAssertion: missing evidence is REJECTED", () => {
    assert.match(validateAssertion({ ...base, evidence: [] }), /evidence/);
    assert.match(validateAssertion({ ...base, evidence: undefined }), /evidence/);
});

test("validateAssertion: self-edge, missing predicate, bad confidence rejected", () => {
    assert.match(validateAssertion({ ...base, toKey: base.fromKey }), /self-referential/);
    assert.match(validateAssertion({ ...base, predicate: "  " }), /predicate/);
    assert.match(validateAssertion({ ...base, confidence: 1.5 }), /confidence/);
    assert.match(validateAssertion({ ...base, agentId: "" }), /agentId/);
});

// ─── edge merge decision ────────────────────────────────────────────────────

test("decideEdgeMerge: new edge when none exists", () => {
    const res = decideEdgeMerge(base, null);
    assert.equal(res.action, "create");
    assert.equal(res.observations, 1);
    assert.equal(res.confidence, 0.9);
});

test("decideEdgeMerge: reinforces a matching edge (predicate variant counts as same)", () => {
    const existing = {
        fromKey: "person:tom-lane",
        toKey: "patch:v3-fix",
        predicateKey: predicateKey("comments on"),
        confidence: 0.6,
        observations: 1,
        evidence: ["shared:archive/msg/100"],
    };
    // assert with a surface-variant predicate + new evidence
    const res = decideEdgeMerge(
        { ...base, predicate: "comment on", confidence: 0.6, evidence: ["shared:archive/msg/123"] },
        existing,
    );
    assert.equal(res.action, "reinforce");
    assert.equal(res.observations, 2);
    assert.ok(Math.abs(res.confidence - 0.84) < 1e-9);
    assert.deepEqual(res.evidence.sort(), ["shared:archive/msg/100", "shared:archive/msg/123"]);
});

test("decideEdgeMerge: different predicate between same nodes creates a separate edge", () => {
    const existing = {
        fromKey: "person:tom-lane",
        toKey: "patch:v3-fix",
        predicateKey: predicateKey("comments on"),
        confidence: 0.6,
        observations: 1,
        evidence: [],
    };
    const res = decideEdgeMerge({ ...base, predicate: "disagrees with" }, existing);
    assert.equal(res.action, "create");
});
