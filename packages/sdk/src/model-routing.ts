/**
 * Token Optimization Phase 3 — model routing policy.
 *
 * Pure functions (no I/O) that decide:
 *   1. Which turn category applies (interactive / research / background).
 *   2. An ordered candidate chain of model names to try (primary + fallbacks).
 *   3. Whether an error message is model-layer eligible for a fallback attempt.
 *
 * All decision logic lives here so it can be unit-tested without DB or LLM.
 *
 * Routing categories:
 *   background  — system agents, bootstrap ticks → use cheapest available model
 *   research    — web/analysis keywords → use strongest available model
 *   interactive — default user turns → use fastest/cheapest model
 */

import type { ModelProviderRegistry } from "./model-providers.js";

// ─── Turn category ────────────────────────────────────────────

export type TurnCategory = "interactive" | "research" | "background";

const BACKGROUND_AGENT_IDENTITIES = new Set([
    "facts-manager",
    "sweeper",
    "resource-manager",
    "resourcemgr",
    "slo-monitor",
]);

const BACKGROUND_LAYER_KINDS = new Set([
    "pilotswarm-system-agent",
    "app-system-agent",
]);

const RESEARCH_SIGNAL_RES: ReadonlyArray<RegExp> = [
    /\bsearch\b/i,
    /\bbrowse\b/i,
    /\bweb\b/i,
    /\bresearch\b/i,
    /\banalyz/i,
    /\bdiagnos/i,
    /\binvestigat/i,
];

export interface TurnContextParams {
    /** Agent identity string, if any. */
    agentIdentity?: string;
    /** Prompt layering kind (from SerializableSessionConfig). */
    promptLayeringKind?: string;
    /** True when this turn is a bootstrap/system-generated prompt. */
    isBootstrap?: boolean;
    /** True when the prompt is an internal orchestration message. */
    isInternal?: boolean;
    /** Raw prompt text — used for research keyword detection. */
    prompt?: string;
}

/**
 * Classify a turn into a routing category.
 * Background > research > interactive (first match wins).
 */
export function classifyTurnContext(params: TurnContextParams): TurnCategory {
    const { agentIdentity, promptLayeringKind, isBootstrap, isInternal, prompt } = params;

    if (isBootstrap || isInternal) return "background";
    if (agentIdentity && BACKGROUND_AGENT_IDENTITIES.has(agentIdentity)) return "background";
    if (promptLayeringKind && BACKGROUND_LAYER_KINDS.has(promptLayeringKind)) return "background";

    if (prompt && RESEARCH_SIGNAL_RES.some((re) => re.test(prompt))) return "research";

    return "interactive";
}

// ─── Candidate chain ──────────────────────────────────────────

/** Maximum number of candidates (primary + fallbacks) in any chain. */
export const MAX_CANDIDATES = 3;

/**
 * Cost tier preference per category.
 * `undefined` represents models with no cost tag (neutral tier).
 */
const COST_PREFERENCE: Record<TurnCategory, ReadonlyArray<"low" | "medium" | "high" | undefined>> = {
    background: ["low", undefined, "medium", "high"],
    interactive: ["low", "medium", undefined, "high"],
    research:    ["high", "medium", undefined, "low"],
};

export interface RoutingParams {
    /** Pre-classified turn category. */
    category: TurnCategory;
    /** If set, this model is placed first regardless of cost ordering. */
    explicitModel?: string;
}

/**
 * Build an ordered list of qualified model names to try for this turn.
 * The first entry is the primary; subsequent entries are ordered fallbacks.
 * Returns an empty array if no registry is provided.
 * Never exceeds MAX_CANDIDATES entries and never duplicates a model.
 */
export function buildCandidateChain(
    params: RoutingParams,
    registry?: ModelProviderRegistry | null,
): string[] {
    if (!registry) return [];

    const { category, explicitModel } = params;

    // Resolve explicit model to qualified form
    let resolvedExplicit: string | undefined;
    if (explicitModel) {
        resolvedExplicit = registry.normalize(explicitModel);
    }

    const allModels = registry.allModels;
    const costPref = COST_PREFERENCE[category];

    // Build ordered fallback list by iterating tiers (excluding explicit)
    const ordered: string[] = [];
    for (const tier of costPref) {
        for (const desc of allModels) {
            if (resolvedExplicit && desc.qualifiedName === resolvedExplicit) continue;
            if (desc.cost === tier) {
                ordered.push(desc.qualifiedName);
            }
        }
    }

    // Dedup while preserving order
    const seen = new Set<string>();
    const deduped: string[] = [];
    for (const name of ordered) {
        if (!seen.has(name)) {
            seen.add(name);
            deduped.push(name);
        }
    }

    // Build chain: explicit first, then fallbacks, capped at MAX_CANDIDATES
    const chain: string[] = [];
    if (resolvedExplicit) {
        chain.push(resolvedExplicit);
    }
    for (const name of deduped) {
        if (chain.length >= MAX_CANDIDATES) break;
        chain.push(name);
    }

    return chain;
}

// ─── Route decision ───────────────────────────────────────────

export interface RouteDecision {
    /** Classified turn category. */
    category: TurnCategory;
    /** Primary model qualified name (first candidate), or undefined if no registry. */
    primary: string | undefined;
    /** Full ordered candidate list (primary + fallbacks). */
    candidates: string[];
    /** True when the caller specified an explicit model override. */
    isExplicitOverride: boolean;
}

export interface RouteTurnParams extends TurnContextParams {
    /** Explicit model override from session config. */
    model?: string;
}

/**
 * Compute the full route decision for a turn.
 * Combines classifyTurnContext + buildCandidateChain into a single call.
 */
export function routeTurn(
    params: RouteTurnParams,
    registry?: ModelProviderRegistry | null,
): RouteDecision {
    const category = classifyTurnContext(params);
    const isExplicitOverride = !!params.model;
    const candidates = buildCandidateChain({ category, explicitModel: params.model }, registry);
    return {
        category,
        primary: candidates[0],
        candidates,
        isExplicitOverride,
    };
}

// ─── Fallback error detection ────────────────────────────────

/**
 * Patterns in error messages that indicate a model-layer failure
 * where trying an alternative model may succeed.
 */
const FALLBACK_ELIGIBLE_PATTERNS: ReadonlyArray<RegExp> = [
    /model\s*(".*?"\s*)?(not\s*found|is\s*not\s*(available|supported|accessible))/i,
    /rate\s*limit/i,
    /\b429\b/,
    /\b503\b/,
    /overloaded/i,
    /service\s*unavailable/i,
    /model\s*unavailable/i,
    /too\s*many\s*requests/i,
    /quota\s*(exceeded|limit)/i,
    /capacity\s*(exceeded|limit)/i,
];

/**
 * Patterns that indicate session/connection layer errors — NOT model-layer.
 * These must not trigger a model fallback.
 */
const FALLBACK_INELIGIBLE_PATTERNS: ReadonlyArray<RegExp> = [
    /session\s*not\s*found/i,
    /connection\s*is\s*closed/i,
];

/**
 * Returns true if the error message suggests a model-layer failure
 * where switching to a fallback model may recover the turn.
 * Never throws; always returns false for null/undefined inputs.
 */
export function isModelFallbackEligibleError(message?: string): boolean {
    if (!message) return false;
    if (FALLBACK_INELIGIBLE_PATTERNS.some((re) => re.test(message))) return false;
    return FALLBACK_ELIGIBLE_PATTERNS.some((re) => re.test(message));
}
