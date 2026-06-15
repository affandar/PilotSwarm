// @pilotswarm/horizon-store — open-graph quality core (DB-less, unit-tested).
//
// An LLM-built, ontology-free graph degenerates into noise without these pure
// guards. These functions hold the policy; the typed Cypher layer just applies
// their output. See docs/proposals/enhancedfactstore/01-functional-spec.md §6.

// ─── Node canonicalization ───────────────────────────────────────────────────

/**
 * Normalize a surface name for SURFACE-FORM dedup only (case, whitespace,
 * punctuation, diacritics). This does NOT solve semantic identity — "Tom Lane"
 * vs "tgl" is resolved by the harvester via searchGraphNodes + mergeGraphNodes,
 * which records an alias. Keep this conservative so we never collapse distinct
 * people.
 */
export function normalizeName(raw: string): string {
    return (raw ?? "")
        .normalize("NFKD")
        .replace(/[̀-ͯ]/g, "") // strip diacritics
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, " ")     // punctuation → space
        .trim()
        .replace(/\s+/g, " ");
}

/** Canonical dedup key: `<normalized-kind>:<normalized-name>`. */
export function nodeKeyOf(kind: string, name: string): string {
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

// ─── Predicate normalization ─────────────────────────────────────────────────

// Tiny stopword set so "revives argument from" and "revives the argument from"
// group together. Deliberately small — we group, we do NOT enforce a vocabulary.
const PREDICATE_STOPWORDS = new Set([
    "a", "an", "the", "to", "of", "in", "on", "with", "for", "from", "by",
    "that", "this", "it", "its", "their", "his", "her",
]);

/**
 * Normalize a free-text predicate into a grouping key. The original predicate
 * is kept verbatim on the edge; this is only for matching/analytics so the open
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

// ─── Confidence reinforcement (noisy-OR) ─────────────────────────────────────

/**
 * Combine an existing edge confidence with a new independent observation.
 * Monotonic, saturating, order-independent:  c' = 1 - (1-c_old)(1-c_obs).
 */
export function reinforceConfidence(existing: number, observation: number): number {
    const a = clamp01(existing);
    const b = clamp01(observation);
    return 1 - (1 - a) * (1 - b);
}

export function clamp01(x: number): number {
    if (!Number.isFinite(x)) return 0;
    if (x < 0) return 0;
    if (x > 1) return 1;
    return x;
}

// ─── Edge-upsert decision (evidence-aware reinforcement — 01 §6.3) ──────────

export interface ExistingEdge {
    confidence: number;
    observations: number;
    evidence: string[];
}

export interface EdgeUpsertDecision {
    /** create: no edge existed. reinforce: bump observations + noisy-OR.
     * noop: re-assert carried only already-known evidence — idempotent. */
    action: "create" | "reinforce" | "noop";
    confidence: number;
    observations: number;
    evidence: string[];
}

/**
 * Evidence is OPTIONAL (the graph stays permissive). Reinforcement counts only
 * NOVEL observations: an assertion reinforces iff it carries ≥1 evidence
 * scopeKey not already on the edge, or carries no evidence at all. Re-asserting
 * with only already-known evidence is an idempotent no-op — a duplicate/replayed
 * harvest of the same fact cannot inflate observations or confidence.
 */
export function decideEdgeUpsert(
    input: { confidence?: number; evidence?: string[] },
    existing: ExistingEdge | null,
): EdgeUpsertDecision {
    const obsConfidence = clamp01(input.confidence ?? 1.0);
    const incoming = [...new Set(input.evidence ?? [])];

    if (!existing) {
        return { action: "create", confidence: obsConfidence, observations: 1, evidence: incoming };
    }

    const known = new Set(existing.evidence ?? []);
    const novel = incoming.filter((e) => !known.has(e));

    if (incoming.length > 0 && novel.length === 0) {
        return {
            action: "noop",
            confidence: existing.confidence,
            observations: existing.observations,
            evidence: existing.evidence,
        };
    }

    return {
        action: "reinforce",
        confidence: reinforceConfidence(existing.confidence, obsConfidence),
        observations: existing.observations + 1,
        evidence: [...(existing.evidence ?? []), ...novel],
    };
}
