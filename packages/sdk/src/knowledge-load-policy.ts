/**
 * Token Optimization Phase 2 — adaptive knowledge-index load policy.
 *
 * Pure functions (no I/O) that decide:
 *   1. Whether to hit the fact-store for the knowledge index on a given turn.
 *   2. Whether context-window utilization warrants a pressure warning.
 *
 * All decision logic lives here so it can be unit-tested without DB or LLM.
 *
 * Load conditions (first match wins):
 *   first_turn      — iteration === 0 or never loaded (warms the session cache).
 *   internal_prompt — bootstrap tick / orchestration wake-up → skip.
 *   keyword_signal  — prompt contains skill/fact/knowledge terms → load.
 *   periodic_refresh — (iteration - lastLoaded) ≥ refreshInterval → load.
 *   already_loaded  — none of the above → skip.
 */

// ─── Knowledge load decision ─────────────────────────────────────

/** Turns between automatic background refreshes of the knowledge index. */
export const DEFAULT_KNOWLEDGE_REFRESH_INTERVAL = 5;

export type KnowledgeLoadReason =
    | "first_turn"
    | "keyword_signal"
    | "periodic_refresh"
    | "internal_system_prompt"
    | "already_loaded";

export interface KnowledgeLoadDecision {
    load: boolean;
    reason: KnowledgeLoadReason;
}

/** Patterns whose presence in a user prompt signals likely knowledge need. */
const KNOWLEDGE_SIGNAL_RES: ReadonlyArray<RegExp> = [
    /\bskills?\b/i,
    /\bfact[s]?\b/i,
    /\bknowledge\b/i,
    /\basks?\b/i,
    /\bcurated\b/i,
    /\bread_facts\b/i,
    /skills\//i,
    /asks\//i,
];

/** Returns true if the prompt text contains knowledge-index signal words. */
export function promptNeedsKnowledge(prompt: string): boolean {
    return KNOWLEDGE_SIGNAL_RES.some((re) => re.test(prompt));
}

export interface KnowledgeLoadParams {
    /** Current orchestration iteration (0-based). */
    iteration: number;
    /** True when this turn is a bootstrap/system-generated prompt, not user-authored. */
    isBootstrap: boolean;
    /** True when the prompt is an internal orchestration message (timer ticks, etc.). */
    isInternal: boolean;
    /** Raw prompt text — used for keyword-signal detection. */
    prompt: string;
    /**
     * Iteration number when the knowledge index was last loaded.
     * Use -1 to signal "never loaded".
     */
    lastLoadedIteration: number;
    /**
     * Turns between automatic periodic refreshes.
     * 0 = disable periodic refresh (keyword + first-turn still apply).
     * Default: DEFAULT_KNOWLEDGE_REFRESH_INTERVAL (5).
     */
    refreshInterval?: number;
}

/**
 * Decide whether to load the knowledge index on this turn.
 * Never throws; all inputs are defensive.
 */
export function decideKnowledgeLoad(params: KnowledgeLoadParams): KnowledgeLoadDecision {
    const {
        iteration,
        isBootstrap,
        isInternal,
        prompt,
        lastLoadedIteration,
        refreshInterval = DEFAULT_KNOWLEDGE_REFRESH_INTERVAL,
    } = params;

    // First turn / never loaded: always warm the cache even for bootstrap.
    if (iteration === 0 || lastLoadedIteration < 0) {
        return { load: true, reason: "first_turn" };
    }

    // Internal/system-generated prompts do not warrant a DB round-trip.
    if (isBootstrap || isInternal) {
        return { load: false, reason: "internal_system_prompt" };
    }

    // Keyword signal: user explicitly references skills or facts.
    if (promptNeedsKnowledge(prompt)) {
        return { load: true, reason: "keyword_signal" };
    }

    // Periodic refresh.
    if (refreshInterval > 0 && (iteration - lastLoadedIteration) >= refreshInterval) {
        return { load: true, reason: "periodic_refresh" };
    }

    return { load: false, reason: "already_loaded" };
}

// ─── Context pressure classification ────────────────────────────

export type ContextPressureLevel = "ok" | "warn" | "high";

/** Thresholds for context-window pressure warnings. */
const CONTEXT_PRESSURE_WARN_THRESHOLD = 0.70;
const CONTEXT_PRESSURE_HIGH_THRESHOLD = 0.85;

/**
 * Classify context-window utilization into a pressure level.
 * Used to emit early warnings before the compaction engine fires.
 */
export function classifyContextPressure(utilization: number): ContextPressureLevel {
    if (utilization >= CONTEXT_PRESSURE_HIGH_THRESHOLD) return "high";
    if (utilization >= CONTEXT_PRESSURE_WARN_THRESHOLD) return "warn";
    return "ok";
}
