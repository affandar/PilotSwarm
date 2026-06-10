// @incubator/horizon-facts — DB-less core.
//
// This module holds the parts of the read path that do NOT need a database:
//   - query/namespace fragment normalization (unit-testable)
//   - candidate fusion (combining lexical/semantic candidates into a single
//     ranked list). There is NO graph signal: searchFacts is facts-store-only
//     (01-functional-spec §4.2); graph retrieval is the separate GraphInterface.
//
// Keeping these pure makes the fusion algorithm A/B-testable offline and keeps
// the HorizonDB adapter thin.

import type { SearchWeights } from "./types.js";

// ─── query/namespace normalization ──────────────────────────────────────────

/**
 * Normalize the raw lexical query (BM25). The scoring function treats text as
 * data, so we only normalize whitespace. Returns null for empty queries —
 * callers turn that into a defined empty result, not a crash (04 L4).
 */
export function buildLexicalQuery(raw: string): string | null {
    const trimmed = (raw ?? "").replace(/\s+/g, " ").trim();
    return trimmed.length > 0 ? trimmed : null;
}

/**
 * Normalize a namespace ("skills") into a SQL LIKE prefix ("skills/%").
 * Mirrors PilotSwarm's reserved knowledge namespaces.
 */
export function namespacePrefix(namespace?: string): string | null {
    if (!namespace) return null;
    const clean = namespace.replace(/\/+$/, "");
    return clean.length > 0 ? `${clean}/%` : null;
}

// ─── Candidate fusion ───────────────────────────────────────────────────────

export interface Candidate {
    scopeKey: string;
    /** Raw per-signal scores. Any subset may be present. */
    lexical?: number;   // BM25 score, unbounded ≥ 0
    semantic?: number;  // cosine similarity, 0..1
}

export interface FusedCandidate {
    scopeKey: string;
    score: number;
    signals: { lexical?: number; semantic?: number };
}

const DEFAULT_WEIGHTS: Required<SearchWeights> = { lexical: 1, semantic: 1 };

/** Min-max normalize a list of numbers into 0..1. Constant lists map to 1. */
export function normalize(values: number[]): number[] {
    if (values.length === 0) return [];
    let min = Infinity;
    let max = -Infinity;
    for (const v of values) {
        if (v < min) min = v;
        if (v > max) max = v;
    }
    if (max === min) return values.map(() => (max === 0 ? 0 : 1));
    return values.map((v) => (v - min) / (max - min));
}

/**
 * Weighted-normalized-score fusion.
 *
 * Each signal is min-max normalized across its own candidate set, then combined
 * with the configured weights. A candidate missing a signal contributes 0 for
 * that signal. Returns candidates sorted by fused score descending.
 */
export function fuseWeighted(candidates: Candidate[], weights?: SearchWeights): FusedCandidate[] {
    const w = { ...DEFAULT_WEIGHTS, ...(weights ?? {}) };

    const lexNorm = normByKey(candidates, "lexical");
    const semNorm = normByKey(candidates, "semantic");

    const fused: FusedCandidate[] = candidates.map((c) => {
        const signals: FusedCandidate["signals"] = {};
        let score = 0;
        if (c.lexical !== undefined) {
            signals.lexical = c.lexical;
            score += w.lexical * (lexNorm.get(c.scopeKey) ?? 0);
        }
        if (c.semantic !== undefined) {
            signals.semantic = c.semantic;
            score += w.semantic * (semNorm.get(c.scopeKey) ?? 0);
        }
        return { scopeKey: c.scopeKey, score, signals };
    });

    return fused.sort((a, b) => b.score - a.score || a.scopeKey.localeCompare(b.scopeKey));
}

// ─── helpers ────────────────────────────────────────────────────────────────

function normByKey(candidates: Candidate[], signal: "lexical" | "semantic"): Map<string, number> {
    const present = candidates.filter((c) => typeof c[signal] === "number");
    const norm = normalize(present.map((c) => c[signal] as number));
    const out = new Map<string, number>();
    present.forEach((c, i) => out.set(c.scopeKey, norm[i]));
    return out;
}
