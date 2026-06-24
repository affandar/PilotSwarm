// DB-less unit tests for the open-graph quality core (graph-model.ts).
// Spec: 01-functional-spec §6.3 — evidence OPTIONAL; reinforcement counts
// only NOVEL evidence (known-evidence replays are no-ops). Run: npm test.

import { test } from "vitest";
import assert from "node:assert/strict";

import {
    normalizeName,
    nodeKeyOf,
    mergeAliases,
    predicateKey,
    reinforceConfidence,
    decideEdgeUpsert,
} from "../dist/src/graph-model.js";

// ─── canonicalization ───────────────────────────────────────────────────────

test("normalizeName: case/whitespace/punctuation/diacritics folded", () => {
    assert.equal(normalizeName("  Tom   Lane "), "tom lane");
    assert.equal(normalizeName("Tom-Lane"), "tom lane");
    assert.equal(normalizeName("Álvaro Herrera"), "alvaro herrera"); // diacritics stripped
    assert.equal(normalizeName(""), "");
});

test("normalizeName: does NOT collapse semantically-distinct surface forms", () => {
    // "Tom Lane" and "tgl" are different strings — identity is the harvester's
    // job (searchGraphNodes + mergeGraphNodes), not this function's.
    assert.notEqual(normalizeName("Tom Lane"), normalizeName("tgl"));
});

test("nodeKeyOf: kind + normalized name", () => {
    assert.equal(nodeKeyOf("person", "Tom Lane"), "person:tom-lane");
    assert.equal(nodeKeyOf("Code File", "src/backend/utils/adt/jsonbsubs.c"),
        "code_file:src-backend-utils-adt-jsonbsubs-c");
});

test("mergeAliases: dedup by surface form, first-seen order preserved", () => {
    assert.deepEqual(mergeAliases(["Tom Lane"], ["tgl", "TOM LANE", "tgl"]), ["Tom Lane", "tgl"]);
    assert.deepEqual(mergeAliases([], ["", "  ", "x"]), ["x"]);
});

// ─── non-Latin (non-English) names ──────────────────────────────────────────

test("normalizeName: preserves non-Latin letters while folding punctuation", () => {
    assert.equal(normalizeName("장성준"), "장성준");        // Korean / Hangul
    assert.equal(normalizeName("반지현"), "반지현");        // Korean / Hangul
    assert.equal(normalizeName("毛澤東"), "毛澤東");        // Chinese / Han
    assert.equal(normalizeName("Лев Толстой"), "лев толстой");   // Russian / Cyrillic
    assert.equal(normalizeName("Ωμέγα"), "ωμέγα");         // Greek diacritic is meaningful
});

test("nodeKeyOf: distinct non-Latin people get distinct non-empty node keys", () => {
    assert.equal(nodeKeyOf("Person", "장성준"), "person:장성준");
    assert.equal(nodeKeyOf("Person", "반지현"), "person:반지현");
    assert.notEqual(nodeKeyOf("Person", "장성준"), nodeKeyOf("Person", "반지현"));
    assert.notEqual(nodeKeyOf("Person", "장성준"), "person:");
});

test("nodeKeyOf: mixed Latin + non-Latin names keep both components", () => {
    assert.equal(nodeKeyOf("Person", "장성준 (jang)"), "person:장성준-jang");
    assert.notEqual(nodeKeyOf("Person", "장성준 (jang)"), nodeKeyOf("Person", "반지현 (jang)"));
});

test("predicateKey: non-Latin predicates remain distinct", () => {
    assert.equal(predicateKey("작성자"), "작성자");  // Korean "author"
    assert.equal(predicateKey("评论"), "评论");    // Chinese "comments"
    assert.notEqual(predicateKey("작성자"), predicateKey("评论"));
});

test("mergeAliases: distinct non-Latin aliases are preserved", () => {
    assert.deepEqual(mergeAliases([], ["장성준", "반지현"]), ["장성준", "반지현"]);
    assert.deepEqual(mergeAliases(["Tom Lane"], ["장성준"]), ["Tom Lane", "장성준"]);
});

// ─── predicate grouping ─────────────────────────────────────────────────────

test("predicateKey groups stopword/plural variants without freezing vocabulary", () => {
    assert.equal(predicateKey("revives argument from"), predicateKey("revives the argument from"));
    assert.equal(predicateKey("comments on"), predicateKey("comment on"));
    assert.notEqual(predicateKey("authored"), predicateKey("reviews"));
});

// ─── noisy-OR ───────────────────────────────────────────────────────────────

test("reinforceConfidence: monotonic, saturating, order-independent", () => {
    assert.ok(Math.abs(reinforceConfidence(0.8, 0.5) - 0.9) < 1e-9);
    assert.equal(reinforceConfidence(1, 0.3), 1);
    assert.equal(reinforceConfidence(0, 0), 0);
    const ab = reinforceConfidence(reinforceConfidence(0.3, 0.4), 0.5);
    const ba = reinforceConfidence(reinforceConfidence(0.5, 0.4), 0.3);
    assert.ok(Math.abs(ab - ba) < 1e-9);
});

// ─── evidence-aware edge upsert (01 §6.3) ───────────────────────────────────

test("decideEdgeUpsert: create when no edge exists; evidence OPTIONAL", () => {
    const withEv = decideEdgeUpsert({ confidence: 0.7, evidence: ["shared:a", "shared:a"] }, null);
    assert.equal(withEv.action, "create");
    assert.equal(withEv.observations, 1);
    assert.deepEqual(withEv.evidence, ["shared:a"], "incoming evidence deduped");

    const without = decideEdgeUpsert({}, null);
    assert.equal(without.action, "create");
    assert.equal(without.confidence, 1.0, "confidence defaults to 1.0");
    assert.deepEqual(without.evidence, []);
});

test("decideEdgeUpsert: NOVEL evidence reinforces (observations++, noisy-OR, union)", () => {
    const existing = { confidence: 0.8, observations: 1, evidence: ["shared:m3"] };
    const res = decideEdgeUpsert({ confidence: 0.5, evidence: ["shared:m4"] }, existing);
    assert.equal(res.action, "reinforce");
    assert.equal(res.observations, 2);
    assert.ok(Math.abs(res.confidence - 0.9) < 1e-9);
    assert.deepEqual(res.evidence, ["shared:m3", "shared:m4"]);
});

test("decideEdgeUpsert: ONLY-known evidence is an idempotent NO-OP (GR7 replay immunity)", () => {
    const existing = { confidence: 0.9, observations: 2, evidence: ["shared:m3", "shared:m4"] };
    const res = decideEdgeUpsert({ confidence: 0.99, evidence: ["shared:m3", "shared:m4"] }, existing);
    assert.equal(res.action, "noop");
    assert.equal(res.confidence, 0.9, "confidence untouched");
    assert.equal(res.observations, 2, "observations untouched");
    assert.deepEqual(res.evidence, existing.evidence, "evidence untouched");
});

test("decideEdgeUpsert: evidence-less re-assert STILL reinforces (GR8)", () => {
    const existing = { confidence: 0.5, observations: 1, evidence: ["shared:m3"] };
    const res = decideEdgeUpsert({ confidence: 0.5 }, existing);
    assert.equal(res.action, "reinforce");
    assert.equal(res.observations, 2);
    assert.ok(Math.abs(res.confidence - 0.75) < 1e-9);
});

test("decideEdgeUpsert: mixed known+novel evidence reinforces, unioning only the novel", () => {
    const existing = { confidence: 0.5, observations: 1, evidence: ["shared:m3"] };
    const res = decideEdgeUpsert({ confidence: 0.5, evidence: ["shared:m3", "shared:m5"] }, existing);
    assert.equal(res.action, "reinforce");
    assert.deepEqual(res.evidence, ["shared:m3", "shared:m5"]);
});
