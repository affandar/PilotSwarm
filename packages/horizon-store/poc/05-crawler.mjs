// poc/05-crawler.mjs — open-graph harvesting loop (runs DB-less today).
//
// Demonstrates the WHOLE search→resolve→assert flow from CRAWLER.md against an
// in-memory graph, driving the real quality core from src/graph-model.js. The
// two boundaries that need a real environment are clearly stubbed:
//   - extractRelationships()  → stands in for the LLM crawl call
//   - InMemoryGraph           → stands in for AGE (same operations, no DB)
// Everything else (canonicalization, dedup, evidence guard, confidence
// reinforcement, predicate grouping) is the production logic.
//
// Run: npm run build && node poc/05-crawler.mjs

import {
    entityKey, mergeAliases, predicateKey, normalizeName,
    validateAssertion, decideEdgeMerge,
} from "../dist/src/graph-model.js";

// ─── In-memory stand-in for the AGE-backed crawler interface ────────────────
class InMemoryGraph {
    constructor() {
        this.entities = new Map();      // entity_key → {kind,name,aliases,evidence}
        this.edges = [];                // {fromKey,toKey,predicate,predicateKey,confidence,observations,evidence}
        this.rejected = [];             // assertions blocked by the evidence guard
    }

    // search-first surface
    searchEntities({ kind, nameLike }) {
        return [...this.entities.values()].filter((e) =>
            (!kind || e.kind === kind) &&
            (!nameLike || e.name.toLowerCase().includes(nameLike.toLowerCase()) ||
                e.aliases.some((a) => a.toLowerCase().includes(nameLike.toLowerCase()))));
    }
    // Two query modes only: exact predicate (agent-owned ontology) and
    // anchor endpoints (explore around a known node). No fuzzy matching.
    searchRelationships({ predicate, predicateKey: pk, fromKey, toKey, minConfidence = 0 }) {
        const wantKey = pk ?? (predicate ? predicateKey(predicate) : undefined);
        return this.edges.filter((r) =>
            (wantKey === undefined || r.predicateKey === wantKey) &&  // EXACT, not LIKE
            (fromKey === undefined || r.fromKey === fromKey) &&
            (toKey === undefined || r.toKey === toKey) &&
            r.confidence >= minConfidence);
    }

    /**
     * RESOLVE step (CRAWLER.md §5.1): identity is NOT string-solvable, so before
     * creating an entity the crawler searches existing nodes for one whose name
     * OR any alias matches this surface form. If found, reuse it and record the
     * new surface form as an alias — this is how "tgl" attaches to Tom Lane
     * instead of spawning a duplicate person node.
     */
    resolveOrUpsert({ kind, name, aliases = [], evidence = [] }) {
        const surfaces = [name, ...aliases].map(normalizeName);
        for (const e of this.entities.values()) {
            if (e.kind !== kind) continue;
            const known = [e.name, ...e.aliases].map(normalizeName);
            if (known.some((k) => surfaces.includes(k))) {
                e.aliases = mergeAliases(e.aliases, [name, ...aliases]);
                e.evidence = [...new Set([...e.evidence, ...evidence])];
                return { entityKey: e.entityKey, created: false, ...e };
            }
        }
        const key = entityKey(kind, name);
        const node = { entityKey: key, kind, name, aliases: mergeAliases([], [name, ...aliases]), evidence };
        this.entities.set(key, node);
        return { entityKey: key, created: true, ...node };
    }

    assertRelationship(r) {
        const err = validateAssertion(r);
        if (err) { this.rejected.push({ r, err }); return { rejected: err }; }
        const pk = predicateKey(r.predicate);
        const existing = this.edges.find((e) =>
            e.fromKey === r.fromKey && e.toKey === r.toKey && e.predicateKey === pk) ?? null;
        const decision = decideEdgeMerge(r, existing);
        if (decision.action === "reinforce") {
            existing.confidence = decision.confidence;
            existing.observations = decision.observations;
            existing.evidence = decision.evidence;
            return { ...existing, reinforced: true };
        }
        const edge = {
            fromKey: r.fromKey, toKey: r.toKey, predicate: r.predicate, predicateKey: pk,
            confidence: decision.confidence, observations: decision.observations, evidence: decision.evidence,
        };
        this.edges.push(edge);
        return { ...edge, reinforced: false };
    }
}

// ─── Boundary stub: the LLM crawl call ──────────────────────────────────────
// In production this is the harvesting agent reading a message + the RECALL
// results, and emitting entities + free-text predicates. Here it's scripted to
// two messages from the same JSONB-subscripting debate so we can SHOW dedup +
// reinforcement deterministically.
function extractRelationships(message) {
    return message.extraction;
}

// Two archived messages — note the second re-states a relationship from the
// first (different surface form) and revives the same prior thread.
const MESSAGES = [
    {
        factKey: "shared:archive/pgsql-hackers/msg/1001",
        extraction: {
            entities: [
                { kind: "person", name: "Tom Lane", aliases: ["tgl"] },
                { kind: "patch", name: "v3 fix jsonb subscript" },
                { kind: "code_file", name: "src/backend/utils/adt/jsonbsubs.c" },
                { kind: "thread", name: "2025 jsonb subscript semantics" },
            ],
            rels: [
                { from: ["person", "Tom Lane"], to: ["patch", "v3 fix jsonb subscript"], predicate: "comments on", confidence: 0.95 },
                { from: ["patch", "v3 fix jsonb subscript"], to: ["code_file", "src/backend/utils/adt/jsonbsubs.c"], predicate: "touches", confidence: 0.9 },
                { from: ["patch", "v3 fix jsonb subscript"], to: ["thread", "2025 jsonb subscript semantics"], predicate: "revives argument from", confidence: 0.7 },
            ],
        },
    },
    {
        factKey: "shared:archive/pgsql-hackers/msg/1002",
        extraction: {
            entities: [
                { kind: "person", name: "tgl" },                       // SAME person, alias surface form
                { kind: "patch", name: "v3 fix jsonb subscript" },
            ],
            rels: [
                { from: ["person", "tgl"], to: ["patch", "v3 fix jsonb subscript"], predicate: "comment on", confidence: 0.8 }, // variant → reinforce
                { from: ["patch", "v3 fix jsonb subscript"], to: ["code_file", "src/backend/utils/adt/jsonbsubs.c"], predicate: "touches", confidence: 0.6, noEvidenceTest: false },
            ],
        },
    },
];

// ─── The harvest loop ───────────────────────────────────────────────────────
const g = new InMemoryGraph();

for (const msg of MESSAGES) {
    const ex = extractRelationships(msg);

    // RESOLVE: search existing entities by alias first, reuse or create. Build a
    // map from this message's surface (kind,name) → the canonical entity_key so
    // relationship assertions attach to the resolved node, not a duplicate.
    const resolved = new Map();
    for (const e of ex.entities) {
        const ref = g.resolveOrUpsert({ kind: e.kind, name: e.name, aliases: e.aliases, evidence: [msg.factKey] });
        resolved.set(`${e.kind}\u0000${e.name}`, ref.entityKey);
    }
    const keyFor = (kind, name) => resolved.get(`${kind}\u0000${name}`) ?? entityKey(kind, name);

    // ASSERT: each perceived relationship, with the originating message as evidence.
    for (const r of ex.rels) {
        g.assertRelationship({
            fromKey: keyFor(r.from[0], r.from[1]),
            toKey: keyFor(r.to[0], r.to[1]),
            predicate: r.predicate,
            confidence: r.confidence,
            evidence: [msg.factKey],
            agentId: "pg-mailing-list-crawler",
            model: "stub-llm",
        });
    }
}

// One deliberately invalid assertion to show the evidence guard rejecting it.
g.assertRelationship({
    fromKey: "person:tom-lane", toKey: "topic:hand-wavy-claim",
    predicate: "secretly controls", confidence: 0.99, evidence: [], agentId: "pg-mailing-list-crawler",
});

// ─── Report ─────────────────────────────────────────────────────────────────
console.log("ENTITIES (deduped):");
for (const e of g.entities.values()) {
    console.log(`  ${e.entityKey}  aliases=${JSON.stringify(e.aliases)}`);
}

console.log("\nRELATIONSHIPS (free-text predicates, reinforced):");
for (const r of g.edges) {
    console.log(`  ${r.fromKey} -[${r.predicate} | key=${r.predicateKey} conf=${r.confidence.toFixed(3)} obs=${r.observations}]-> ${r.toKey}`);
    console.log(`        evidence=${JSON.stringify(r.evidence)}`);
}

console.log("\nREJECTED (anti-hallucination guard):");
for (const x of g.rejected) console.log(`  ✖ "${x.r.predicate}" — ${x.err}`);

// ─── Assertions that make this a real PoC, not just a print ──────────────────
import assert from "node:assert/strict";

const tom = g.entities.get("person:tom-lane");
assert.ok(tom, "Tom Lane entity exists");
assert.ok(tom.aliases.map((a) => a.toLowerCase()).includes("tgl"),
    "INVARIANT: 'tgl' merged as an alias of Tom Lane, not a duplicate person");
assert.equal([...g.entities.values()].filter((e) => e.kind === "person").length, 1,
    "INVARIANT: only one person node despite two surface forms");

const commentsEdge = g.edges.find((e) => e.fromKey === "person:tom-lane" && e.predicateKey === predicateKey("comments on"));
assert.equal(commentsEdge.observations, 2, "INVARIANT: 'comments on' + 'comment on' reinforced one edge");
assert.ok(Math.abs(commentsEdge.confidence - (1 - (1 - 0.95) * (1 - 0.8))) < 1e-9,
    "INVARIANT: confidence combined via noisy-OR");
assert.equal(commentsEdge.evidence.length, 2, "INVARIANT: both messages recorded as evidence");

assert.equal(g.rejected.length, 1, "INVARIANT: the evidence-free assertion was rejected");
assert.ok(g.edges.every((e) => e.evidence.length > 0), "INVARIANT: every surviving edge is evidence-linked");

console.log("\n✔ all open-graph invariants held (dedup, reinforcement, evidence guard, provenance)");
console.log("[boundaries] extractRelationships() = LLM call; InMemoryGraph = AGE. Both stubbed; quality core is real.");
