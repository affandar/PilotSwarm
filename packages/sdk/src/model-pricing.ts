/**
 * Claude model pricing and USD cost estimation.
 *
 * Prices are per million tokens (MTok) in USD, as of April 2026.
 * Unknown models return 0 — no error thrown.
 *
 * @module
 */

export interface ModelPricing {
    inputPerMTok:      number;
    outputPerMTok:     number;
    cacheReadPerMTok:  number;
    cacheWritePerMTok: number;
}

/** USD per million tokens. Update when Anthropic publishes new prices. */
export const MODEL_PRICING: Record<string, ModelPricing> = {
    "claude-opus-4-7": {
        inputPerMTok:      15,
        outputPerMTok:     75,
        cacheReadPerMTok:  1.5,
        cacheWritePerMTok: 18.75,
    },
    "claude-sonnet-4-6": {
        inputPerMTok:      3,
        outputPerMTok:     15,
        cacheReadPerMTok:  0.3,
        cacheWritePerMTok: 3.75,
    },
    "claude-haiku-4-5-20251001": {
        inputPerMTok:      0.8,
        outputPerMTok:     4,
        cacheReadPerMTok:  0.08,
        cacheWritePerMTok: 1.0,
    },
};

/**
 * Estimate total cost in USD for a set of token counts against a named model.
 * Returns 0 if the model is not in MODEL_PRICING.
 */
export function estimateCostUsd(
    tokensInput:      number,
    tokensOutput:     number,
    tokensCacheRead:  number,
    tokensCacheWrite: number,
    model: string,
): number {
    const p = MODEL_PRICING[model];
    if (!p) return 0;
    const M = 1_000_000;
    return (
        (tokensInput      / M) * p.inputPerMTok      +
        (tokensOutput     / M) * p.outputPerMTok     +
        (tokensCacheRead  / M) * p.cacheReadPerMTok  +
        (tokensCacheWrite / M) * p.cacheWritePerMTok
    );
}
