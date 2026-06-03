// @incubator/horizon-facts — DB-less core.
//
// This module holds the parts of the read path that do NOT need a database:
//   - SQL/tsquery fragment building (so we can unit-test the generated SQL)
//   - candidate fusion (combining lexical/semantic/graph candidates into a
//     single ranked list)
//
// Keeping these pure makes the fusion algorithm A/B-testable offline and keeps
// the eventual HorizonDB adapter thin.

import type { SearchWeights } from "./types.js";

// ─── tsquery building ───────────────────────────────────────────────────────

/**
 * Build the argument for websearch_to_tsquery. websearch_to_tsquery is already
 * injection-safe (it never throws on bad input and treats text as data), so we
 * only normalize whitespace. Returns null for empty queries.
 */
export function buildWebsearchQuery(raw: string): string | null {
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
    lexical?: number;   // ts_rank, unbounded ≥ 0
    semantic?: number;  // cosine similarity, 0..1
    graph?: number;     // graph proximity, 0..1
}

export interface FusedCandidate {
    scopeKey: string;
    score: number;
    signals: { lexical?: number; semantic?: number; graph?: number };
}

const DEFAULT_WEIGHTS: Required<SearchWeights> = { lexical: 1, semantic: 1, graph: 0.5 };

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
 * that signal (it simply isn't boosted by it). Returns candidates sorted by
 * fused score descending.
 */
export function fuseWeighted(candidates: Candidate[], weights?: SearchWeights): FusedCandidate[] {
    const w = { ...DEFAULT_WEIGHTS, ...(weights ?? {}) };

    const lexNorm = normByKey(candidates, "lexical");
    const semNorm = normByKey(candidates, "semantic");
    const graphNorm = normByKey(candidates, "graph");

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
        if (c.graph !== undefined) {
            signals.graph = c.graph;
            score += w.graph * (graphNorm.get(c.scopeKey) ?? 0);
        }
        return { scopeKey: c.scopeKey, score, signals };
    });

    return fused.sort((a, b) => b.score - a.score || a.scopeKey.localeCompare(b.scopeKey));
}

/**
 * Reciprocal Rank Fusion (RRF). Rank-based, scale-free alternative to weighted
 * normalization. Each signal ranks its own candidates; a candidate's score is
 * the weighted sum of 1/(k + rank) across signals. Good when raw score scales
 * differ wildly between signals.
 */
export function fuseRRF(candidates: Candidate[], weights?: SearchWeights, k = 60): FusedCandidate[] {
    const w = { ...DEFAULT_WEIGHTS, ...(weights ?? {}) };
    const lexRank = rankByKey(candidates, "lexical");
    const semRank = rankByKey(candidates, "semantic");
    const graphRank = rankByKey(candidates, "graph");

    const fused: FusedCandidate[] = candidates.map((c) => {
        const signals: FusedCandidate["signals"] = {};
        let score = 0;
        if (c.lexical !== undefined) {
            signals.lexical = c.lexical;
            score += w.lexical * (1 / (k + (lexRank.get(c.scopeKey) ?? 0)));
        }
        if (c.semantic !== undefined) {
            signals.semantic = c.semantic;
            score += w.semantic * (1 / (k + (semRank.get(c.scopeKey) ?? 0)));
        }
        if (c.graph !== undefined) {
            signals.graph = c.graph;
            score += w.graph * (1 / (k + (graphRank.get(c.scopeKey) ?? 0)));
        }
        return { scopeKey: c.scopeKey, score, signals };
    });

    return fused.sort((a, b) => b.score - a.score || a.scopeKey.localeCompare(b.scopeKey));
}

// ─── helpers ────────────────────────────────────────────────────────────────

function normByKey(candidates: Candidate[], signal: keyof Candidate): Map<string, number> {
    const present = candidates.filter((c) => typeof c[signal] === "number") as Candidate[];
    const norm = normalize(present.map((c) => c[signal] as number));
    const out = new Map<string, number>();
    present.forEach((c, i) => out.set(c.scopeKey, norm[i]));
    return out;
}

function rankByKey(candidates: Candidate[], signal: keyof Candidate): Map<string, number> {
    const present = (candidates.filter((c) => typeof c[signal] === "number") as Candidate[])
        .slice()
        .sort((a, b) => (b[signal] as number) - (a[signal] as number));
    const out = new Map<string, number>();
    present.forEach((c, i) => out.set(c.scopeKey, i + 1)); // 1-based rank
    return out;
}
