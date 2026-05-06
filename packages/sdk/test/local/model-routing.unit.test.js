/**
 * Unit tests for Token Optimization Phase 3 — model routing.
 *
 * Pure logic tests (no DB, no LLM, no network).
 *
 * Covers:
 *   - classifyTurnContext: background/research/interactive classification
 *   - buildCandidateChain: cost-ordered candidates, explicit override, MAX_CANDIDATES cap
 *   - isModelFallbackEligibleError: model-layer vs session-layer error discrimination
 *   - routeTurn: full route decision with RouteDecision shape
 */

import { describe, it, expect } from "vitest";
import {
    classifyTurnContext,
    buildCandidateChain,
    isModelFallbackEligibleError,
    routeTurn,
    MAX_CANDIDATES,
} from "../../src/model-routing.ts";
import { ModelProviderRegistry } from "../../src/index.ts";

// ─── Helpers ────────────────────────────────────────────────────

/** Build a credentialed registry with known models for testing. */
function makeRegistry(models = [
    { name: "fast-model",   cost: "low" },
    { name: "smart-model",  cost: "high" },
    { name: "mid-model",    cost: "medium" },
    { name: "plain-model" },              // no cost tag → cost = undefined
]) {
    return new ModelProviderRegistry({
        providers: [
            {
                id: "test-provider",
                type: "openai",
                apiKey: "test-key-literal",   // literal value bypasses env lookup
                baseUrl: "https://api.test.local/v1",
                models,
            },
        ],
    });
}

/** Qualified name helper. */
const q = (name) => `test-provider:${name}`;

// ─── classifyTurnContext ──────────────────────────────────────

describe("classifyTurnContext — background signals", () => {
    it("returns background for facts-manager agent identity", () => {
        expect(classifyTurnContext({ agentIdentity: "facts-manager" })).toBe("background");
    });

    it("returns background for sweeper agent identity", () => {
        expect(classifyTurnContext({ agentIdentity: "sweeper" })).toBe("background");
    });

    it("returns background for resource-manager agent identity", () => {
        expect(classifyTurnContext({ agentIdentity: "resource-manager" })).toBe("background");
    });

    it("returns background for resourcemgr agent identity (short form)", () => {
        expect(classifyTurnContext({ agentIdentity: "resourcemgr" })).toBe("background");
    });

    it("returns background for pilotswarm-system-agent prompt layer kind", () => {
        expect(classifyTurnContext({ promptLayeringKind: "pilotswarm-system-agent" })).toBe("background");
    });

    it("returns background for app-system-agent prompt layer kind", () => {
        expect(classifyTurnContext({ promptLayeringKind: "app-system-agent" })).toBe("background");
    });

    it("returns background for isBootstrap=true", () => {
        expect(classifyTurnContext({ isBootstrap: true })).toBe("background");
    });

    it("returns background for isInternal=true", () => {
        expect(classifyTurnContext({ isInternal: true })).toBe("background");
    });

    it("background takes priority over research keywords in prompt", () => {
        expect(classifyTurnContext({
            agentIdentity: "sweeper",
            prompt: "research and analyze the web",
        })).toBe("background");
    });

    it("bootstrap takes priority over research keywords", () => {
        expect(classifyTurnContext({
            isBootstrap: true,
            prompt: "search the web for research",
        })).toBe("background");
    });
});

describe("classifyTurnContext — research signals", () => {
    it("returns research when prompt contains 'search'", () => {
        expect(classifyTurnContext({ prompt: "search for articles about rust" })).toBe("research");
    });

    it("returns research when prompt contains 'browse'", () => {
        expect(classifyTurnContext({ prompt: "browse the web for info" })).toBe("research");
    });

    it("returns research when prompt contains 'research'", () => {
        expect(classifyTurnContext({ prompt: "research the topic deeply" })).toBe("research");
    });

    it("returns research when prompt contains 'analyze'", () => {
        expect(classifyTurnContext({ prompt: "analyze the performance data" })).toBe("research");
    });

    it("returns research when prompt contains 'investigate'", () => {
        expect(classifyTurnContext({ prompt: "investigate the failing tests" })).toBe("research");
    });

    it("is case-insensitive for research keywords", () => {
        expect(classifyTurnContext({ prompt: "SEARCH for info" })).toBe("research");
        expect(classifyTurnContext({ prompt: "ANALYZE results" })).toBe("research");
    });
});

describe("classifyTurnContext — interactive (default)", () => {
    it("returns interactive for a normal user prompt with no signals", () => {
        expect(classifyTurnContext({ prompt: "hello world" })).toBe("interactive");
    });

    it("returns interactive when no params provided", () => {
        expect(classifyTurnContext({})).toBe("interactive");
    });

    it("returns interactive for an empty prompt", () => {
        expect(classifyTurnContext({ prompt: "" })).toBe("interactive");
    });

    it("returns interactive for unknown agent identity", () => {
        expect(classifyTurnContext({ agentIdentity: "user-defined-agent" })).toBe("interactive");
    });

    it("returns interactive when isBootstrap and isInternal are both false", () => {
        expect(classifyTurnContext({ isBootstrap: false, isInternal: false, prompt: "hello" })).toBe("interactive");
    });
});

// ─── buildCandidateChain ─────────────────────────────────────

describe("buildCandidateChain — no registry", () => {
    it("returns empty array when registry is undefined", () => {
        expect(buildCandidateChain({ category: "interactive" })).toEqual([]);
    });

    it("returns empty array when registry is null", () => {
        expect(buildCandidateChain({ category: "research" }, null)).toEqual([]);
    });
});

describe("buildCandidateChain — background category (cheap first)", () => {
    it("puts low-cost model before medium-cost before high-cost", () => {
        const registry = makeRegistry();
        const chain = buildCandidateChain({ category: "background" }, registry);
        const fastIdx   = chain.indexOf(q("fast-model"));   // low
        const midIdx    = chain.indexOf(q("mid-model"));    // medium
        const smartIdx  = chain.indexOf(q("smart-model"));  // high
        expect(fastIdx).toBeGreaterThanOrEqual(0);
        expect(fastIdx).toBeLessThan(midIdx < 0 ? Infinity : midIdx);
        if (midIdx >= 0 && smartIdx >= 0) expect(midIdx).toBeLessThan(smartIdx);
    });

    it("includes uncosted model before medium/high models", () => {
        const registry = makeRegistry();
        const chain = buildCandidateChain({ category: "background" }, registry);
        const plainIdx = chain.indexOf(q("plain-model"));   // undefined cost
        const smartIdx = chain.indexOf(q("smart-model"));   // high
        if (plainIdx >= 0 && smartIdx >= 0) {
            expect(plainIdx).toBeLessThan(smartIdx);
        }
    });
});

describe("buildCandidateChain — research category (expensive first)", () => {
    it("puts high-cost model before medium-cost before low-cost", () => {
        const registry = makeRegistry();
        const chain = buildCandidateChain({ category: "research" }, registry);
        const smartIdx = chain.indexOf(q("smart-model"));   // high
        const midIdx   = chain.indexOf(q("mid-model"));     // medium
        const fastIdx  = chain.indexOf(q("fast-model"));    // low
        expect(smartIdx).toBeGreaterThanOrEqual(0);
        expect(smartIdx).toBeLessThan(midIdx < 0 ? Infinity : midIdx);
        if (midIdx >= 0 && fastIdx >= 0) expect(midIdx).toBeLessThan(fastIdx);
    });
});

describe("buildCandidateChain — interactive category (cheap then mid then uncosted then high)", () => {
    it("starts with low-cost model", () => {
        const registry = makeRegistry();
        const chain = buildCandidateChain({ category: "interactive" }, registry);
        expect(chain[0]).toBe(q("fast-model"));
    });

    it("low-cost before medium-cost", () => {
        const registry = makeRegistry();
        const chain = buildCandidateChain({ category: "interactive" }, registry);
        const fastIdx = chain.indexOf(q("fast-model"));
        const midIdx  = chain.indexOf(q("mid-model"));
        if (midIdx >= 0) expect(fastIdx).toBeLessThan(midIdx);
    });
});

describe("buildCandidateChain — explicit model override", () => {
    it("places the explicit model first in the chain", () => {
        const registry = makeRegistry();
        const chain = buildCandidateChain({
            category: "interactive",
            explicitModel: q("smart-model"),
        }, registry);
        expect(chain[0]).toBe(q("smart-model"));
    });

    it("does not duplicate the explicit model in fallback positions", () => {
        const registry = makeRegistry();
        const chain = buildCandidateChain({
            category: "interactive",
            explicitModel: q("smart-model"),
        }, registry);
        const occurrences = chain.filter(m => m === q("smart-model")).length;
        expect(occurrences).toBe(1);
    });

    it("accepts bare model name (without provider prefix)", () => {
        const registry = makeRegistry();
        const chain = buildCandidateChain({
            category: "background",
            explicitModel: "fast-model",
        }, registry);
        expect(chain[0]).toBe(q("fast-model"));
    });

    it("ignores an unknown explicit model (not duplicated or inserted if not in registry)", () => {
        const registry = makeRegistry();
        const chain = buildCandidateChain({
            category: "interactive",
            explicitModel: "gpt-999-does-not-exist",
        }, registry);
        expect(chain.includes("gpt-999-does-not-exist")).toBe(false);
    });
});

describe("buildCandidateChain — MAX_CANDIDATES cap", () => {
    it("returns at most MAX_CANDIDATES models", () => {
        const registry = makeRegistry();
        const chain = buildCandidateChain({ category: "research" }, registry);
        expect(chain.length).toBeLessThanOrEqual(MAX_CANDIDATES);
    });

    it("stays within cap even when registry has many models", () => {
        const registry = makeRegistry([
            { name: "m1", cost: "low" },
            { name: "m2", cost: "low" },
            { name: "m3", cost: "medium" },
            { name: "m4", cost: "medium" },
            { name: "m5", cost: "high" },
            { name: "m6", cost: "high" },
        ]);
        const chain = buildCandidateChain({ category: "research" }, registry);
        expect(chain.length).toBeLessThanOrEqual(MAX_CANDIDATES);
    });

    it("stays within cap even with an explicit model provided", () => {
        const registry = makeRegistry([
            { name: "m1", cost: "high" },
            { name: "m2", cost: "medium" },
            { name: "m3", cost: "low" },
            { name: "m4", cost: "low" },
        ]);
        const chain = buildCandidateChain({
            category: "interactive",
            explicitModel: "test-provider:m1",
        }, registry);
        expect(chain.length).toBeLessThanOrEqual(MAX_CANDIDATES);
    });
});

describe("buildCandidateChain — deduplication", () => {
    it("has no duplicate model names", () => {
        const registry = makeRegistry();
        const chain = buildCandidateChain({ category: "background" }, registry);
        const unique = new Set(chain);
        expect(unique.size).toBe(chain.length);
    });
});

// ─── isModelFallbackEligibleError ───────────────────────────

describe("isModelFallbackEligibleError — ineligible (non-model errors)", () => {
    it("returns false for undefined", () => {
        expect(isModelFallbackEligibleError(undefined)).toBe(false);
    });

    it("returns false for empty string", () => {
        expect(isModelFallbackEligibleError("")).toBe(false);
    });

    it("returns false for 'Session not found'", () => {
        expect(isModelFallbackEligibleError("Session not found")).toBe(false);
    });

    it("returns false for 'Connection is closed'", () => {
        expect(isModelFallbackEligibleError("Connection is closed")).toBe(false);
    });

    it("returns false for a generic error message", () => {
        expect(isModelFallbackEligibleError("Something went wrong")).toBe(false);
    });

    it("returns false for a tool-call error", () => {
        expect(isModelFallbackEligibleError("assistant message with 'tool_calls' must be followed")).toBe(false);
    });
});

describe("isModelFallbackEligibleError — eligible (model-layer errors)", () => {
    it("returns true for 'model not found'", () => {
        expect(isModelFallbackEligibleError("model not found")).toBe(true);
    });

    it("returns true for 'Model is not available'", () => {
        expect(isModelFallbackEligibleError("Model is not available")).toBe(true);
    });

    it("returns true for 'Model \"gpt-5.4-mini\" is not available' (model name in message)", () => {
        expect(isModelFallbackEligibleError('Model "gpt-5.4-mini" is not available.')).toBe(true);
    });

    it("returns true for full Execution failed wrapping of model-not-available", () => {
        expect(isModelFallbackEligibleError('Execution failed: Model "gpt-5.4-mini" is not available.')).toBe(true);
    });

    it("returns true for 'rate limit exceeded'", () => {
        expect(isModelFallbackEligibleError("rate limit exceeded")).toBe(true);
    });

    it("returns true for HTTP 429 in error message", () => {
        expect(isModelFallbackEligibleError("Request failed with status 429")).toBe(true);
    });

    it("returns true for HTTP 503 in error message", () => {
        expect(isModelFallbackEligibleError("Upstream error 503")).toBe(true);
    });

    it("returns true for 'overloaded'", () => {
        expect(isModelFallbackEligibleError("The model is currently overloaded")).toBe(true);
    });

    it("returns true for 'service unavailable'", () => {
        expect(isModelFallbackEligibleError("service unavailable")).toBe(true);
    });

    it("returns true for 'too many requests'", () => {
        expect(isModelFallbackEligibleError("Too many requests")).toBe(true);
    });

    it("is case-insensitive", () => {
        expect(isModelFallbackEligibleError("RATE LIMIT")).toBe(true);
        expect(isModelFallbackEligibleError("MODEL NOT FOUND")).toBe(true);
    });
});

// ─── routeTurn ───────────────────────────────────────────────

describe("routeTurn — RouteDecision shape", () => {
    it("returns a RouteDecision with all required fields", () => {
        const registry = makeRegistry();
        const decision = routeTurn({ prompt: "hello" }, registry);
        expect(decision).toHaveProperty("category");
        expect(decision).toHaveProperty("primary");
        expect(decision).toHaveProperty("candidates");
        expect(decision).toHaveProperty("isExplicitOverride");
    });

    it("category matches classifyTurnContext output", () => {
        const registry = makeRegistry();
        const dec = routeTurn({ agentIdentity: "sweeper" }, registry);
        expect(dec.category).toBe("background");
    });

    it("isExplicitOverride is true when model is provided", () => {
        const registry = makeRegistry();
        const dec = routeTurn({ model: q("smart-model"), prompt: "hello" }, registry);
        expect(dec.isExplicitOverride).toBe(true);
    });

    it("isExplicitOverride is false when no model is provided", () => {
        const registry = makeRegistry();
        const dec = routeTurn({ prompt: "hello" }, registry);
        expect(dec.isExplicitOverride).toBe(false);
    });

    it("primary equals candidates[0]", () => {
        const registry = makeRegistry();
        const dec = routeTurn({ prompt: "hello" }, registry);
        expect(dec.primary).toBe(dec.candidates[0]);
    });

    it("primary is undefined and candidates is empty when no registry", () => {
        const dec = routeTurn({ prompt: "hello" });
        expect(dec.primary).toBeUndefined();
        expect(dec.candidates).toEqual([]);
    });

    it("explicit model is the primary", () => {
        const registry = makeRegistry();
        const dec = routeTurn({ model: q("smart-model"), prompt: "hello" }, registry);
        expect(dec.primary).toBe(q("smart-model"));
    });

    it("candidates length respects MAX_CANDIDATES", () => {
        const registry = makeRegistry();
        const dec = routeTurn({ prompt: "analyze this data" }, registry);
        expect(dec.candidates.length).toBeLessThanOrEqual(MAX_CANDIDATES);
    });
});
