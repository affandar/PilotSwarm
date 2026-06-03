// @incubator/horizon-facts — open-graph quality core (DB-less, unit-tested).
//
// An LLM-built, ontology-free graph degenerates into noise without three pure
// guards. These functions hold the policy; the HorizonDB adapter just applies
// their output. See CRAWLER.md §5.

import type { RelAssertion } from "./types.js";

// ─── 5.1 Entity canonicalization ────────────────────────────────────────────

/**
 * Normalize a surface name for SURFACE-FORM dedup only (case, whitespace,
 * punctuation, diacritics). This does NOT solve semantic identity — "Tom Lane"
 * vs "tgl" is resolved by the crawler via searchEntities + mergeEntities, which
 * records an alias. Keep this conservative so we never collapse distinct people.
 */
export function normalizeName(raw: string): string {
    return (raw ?? "")
        .normalize("NFKD")
        .replace(/[\u0300-\u036f]/g, "") // strip diacritics
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, " ")     // punctuation → space
        .trim()
        .replace(/\s+/g, " ");
}

/** Canonical dedup key: `<normalized-kind>:<normalized-name>`. */
export function entityKey(kind: string, name: string): string {
    const k = normalizeName(kind).replace(/\s+/g, "_");
    const n = normalizeName(name).replace(/\s+/g, "-");
    return `${k}:${n}`;
}

/** Merge alias lists, de-duplicated by surface form, preserving first-seen order. */
export function mergeAliases(existing: string[], incoming: string[]): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const a of [...(existing ?? []), ...(incoming ?? [])]) {
        const norm = normalizeName(a);
        if (!norm || seen.has(norm)) continue;
        seen.add(norm);
        out.push(a.trim());
    }
    return out;
}

// ─── 5.2 Predicate normalization ────────────────────────────────────────────

// Tiny stopword set so "revives argument from" and "revives the argument from"
// group together. Deliberately small — we group, we do NOT enforce a vocabulary.
const PREDICATE_STOPWORDS = new Set([
    "a", "an", "the", "to", "of", "in", "on", "with", "for", "from", "by",
    "that", "this", "it", "its", "their", "his", "her",
]);

/**
 * Normalize a free-text predicate into a grouping key. The original predicate is
 * kept verbatim elsewhere; this is only for querying/analytics so the open
 * vocabulary stays queryable without being frozen.
 */
export function predicateKey(predicate: string): string {
    const words = normalizeName(predicate)
        .split(" ")
        .filter((w) => w && !PREDICATE_STOPWORDS.has(w));
    // crude stem: drop a trailing 's' on each token (comments→comment)
    const stemmed = words.map((w) => (w.length > 3 && w.endsWith("s") ? w.slice(0, -1) : w));
    return stemmed.join("_");
}

// ─── 5.3 Confidence reinforcement (noisy-OR) ────────────────────────────────

/**
 * Combine an existing edge confidence with a new independent observation.
 * Monotonic, saturating, order-independent:  c' = 1 - (1-c_old)(1-c_obs).
 */
export function reinforceConfidence(existing: number, observation: number): number {
    const a = clamp01(existing);
    const b = clamp01(observation);
    return 1 - (1 - a) * (1 - b);
}

function clamp01(x: number): number {
    if (!Number.isFinite(x)) return 0;
    if (x < 0) return 0;
    if (x > 1) return 1;
    return x;
}

// ─── Assertion validation + edge-merge decision ─────────────────────────────

export interface ExistingEdge {
    fromKey: string;
    toKey: string;
    predicateKey: string;
    confidence: number;
    observations: number;
    evidence: string[];
}

export interface EdgeMergeResult {
    action: "create" | "reinforce";
    confidence: number;
    observations: number;
    evidence: string[];
}

/**
 * Validate a relationship assertion. Returns an error string, or null if valid.
 * The structural guard against hallucinated edges: evidence is mandatory.
 */
export function validateAssertion(r: RelAssertion): string | null {
    if (!r.fromKey || !r.toKey) return "assertion requires fromKey and toKey";
    if (r.fromKey === r.toKey) return "self-referential edge rejected";
    if (!r.predicate || !r.predicate.trim()) return "assertion requires a predicate";
    if (!Array.isArray(r.evidence) || r.evidence.length === 0) {
        return "assertion rejected: at least one evidence fact is required";
    }
    if (typeof r.confidence !== "number" || r.confidence < 0 || r.confidence > 1) {
        return "confidence must be in [0,1]";
    }
    if (!r.agentId) return "assertion requires an asserting agentId";
    return null;
}

/**
 * Decide whether an assertion creates a new edge or reinforces an existing one.
 * Edges match on (fromKey, toKey, predicateKey) — i.e. surface variants of the
 * same predicate between the same nodes reinforce rather than duplicate.
 */
export function decideEdgeMerge(r: RelAssertion, existing: ExistingEdge | null): EdgeMergeResult {
    const pk = predicateKey(r.predicate);
    if (
        existing &&
        existing.fromKey === r.fromKey &&
        existing.toKey === r.toKey &&
        existing.predicateKey === pk
    ) {
        return {
            action: "reinforce",
            confidence: reinforceConfidence(existing.confidence, r.confidence),
            observations: existing.observations + 1,
            evidence: mergeEvidence(existing.evidence, r.evidence),
        };
    }
    return {
        action: "create",
        confidence: clamp01(r.confidence),
        observations: 1,
        evidence: [...new Set(r.evidence)],
    };
}

function mergeEvidence(existing: string[], incoming: string[]): string[] {
    return [...new Set([...(existing ?? []), ...(incoming ?? [])])];
}
