/**
 * Unit tests for Token Optimization Phase 2 — adaptive knowledge-index loading.
 *
 * Pure logic tests (no DB, no LLM, no network).
 *
 * Covers:
 *   - decideKnowledgeLoad: first-turn, bootstrap skip, internal skip,
 *     keyword signal, periodic refresh, never-loaded, refresh disabled
 *   - promptNeedsKnowledge: keyword patterns
 *   - classifyContextPressure: utilization thresholds (ok / warn / high)
 */

import { describe, it, expect } from "vitest";
import {
    decideKnowledgeLoad,
    promptNeedsKnowledge,
    classifyContextPressure,
    DEFAULT_KNOWLEDGE_REFRESH_INTERVAL,
} from "../../src/knowledge-load-policy.ts";

// ─── decideKnowledgeLoad ─────────────────────────────────────────

describe("decideKnowledgeLoad — first-turn behavior", () => {
    it("always loads on iteration 0 for a normal user prompt", () => {
        const result = decideKnowledgeLoad({
            iteration: 0,
            isBootstrap: false,
            isInternal: false,
            prompt: "hello world",
            lastLoadedIteration: -1,
        });
        expect(result.load).toBe(true);
        expect(result.reason).toBe("first_turn");
    });

    it("loads on iteration 0 even when prompt is empty", () => {
        const result = decideKnowledgeLoad({
            iteration: 0,
            isBootstrap: false,
            isInternal: false,
            prompt: "",
            lastLoadedIteration: -1,
        });
        expect(result.load).toBe(true);
        expect(result.reason).toBe("first_turn");
    });

    it("loads on iteration 0 even when isBootstrap is true (warm cache for session)", () => {
        const result = decideKnowledgeLoad({
            iteration: 0,
            isBootstrap: true,
            isInternal: false,
            prompt: "boot",
            lastLoadedIteration: -1,
        });
        expect(result.load).toBe(true);
        expect(result.reason).toBe("first_turn");
    });

    it("loads when lastLoadedIteration is -1 regardless of iteration number", () => {
        const result = decideKnowledgeLoad({
            iteration: 7,
            isBootstrap: false,
            isInternal: false,
            prompt: "do something",
            lastLoadedIteration: -1,
        });
        expect(result.load).toBe(true);
        expect(result.reason).toBe("first_turn");
    });
});

describe("decideKnowledgeLoad — skip for internal/bootstrap turns", () => {
    it("skips when isBootstrap=true and iteration > 0", () => {
        const result = decideKnowledgeLoad({
            iteration: 3,
            isBootstrap: true,
            isInternal: false,
            prompt: "Internal orchestration wake-up.",
            lastLoadedIteration: 0,
        });
        expect(result.load).toBe(false);
        expect(result.reason).toBe("internal_system_prompt");
    });

    it("skips when isInternal=true and iteration > 0", () => {
        const result = decideKnowledgeLoad({
            iteration: 2,
            isBootstrap: false,
            isInternal: true,
            prompt: "Internal orchestration wake-up. The user did not send a new message.",
            lastLoadedIteration: 1,
        });
        expect(result.load).toBe(false);
        expect(result.reason).toBe("internal_system_prompt");
    });

    it("skips when both isBootstrap and isInternal are true and iteration > 0", () => {
        const result = decideKnowledgeLoad({
            iteration: 4,
            isBootstrap: true,
            isInternal: true,
            prompt: "system tick",
            lastLoadedIteration: 3,
        });
        expect(result.load).toBe(false);
        expect(result.reason).toBe("internal_system_prompt");
    });
});

describe("decideKnowledgeLoad — keyword signal forces load", () => {
    const cases = [
        { label: "word 'skills'", prompt: "Tell me about skills in this cluster" },
        { label: "word 'facts'", prompt: "What facts do we have stored?" },
        { label: "word 'knowledge'", prompt: "Do you have knowledge about networking?" },
        { label: "word 'asks'", prompt: "List the open asks please" },
        { label: "word 'curated'", prompt: "Show curated content" },
        { label: "term 'read_facts'", prompt: "Use read_facts to look this up" },
        { label: "path 'skills/'", prompt: "Check skills/infra/k8s for me" },
        { label: "path 'asks/'", prompt: "Is there anything in asks/networking?" },
    ];

    for (const { label, prompt } of cases) {
        it(`forces load when prompt contains ${label}`, () => {
            const result = decideKnowledgeLoad({
                iteration: 2,
                isBootstrap: false,
                isInternal: false,
                prompt,
                lastLoadedIteration: 1,
            });
            expect(result.load).toBe(true);
            expect(result.reason).toBe("keyword_signal");
        });
    }

    it("does NOT force load for an unrelated prompt between refreshes", () => {
        const result = decideKnowledgeLoad({
            iteration: 2,
            isBootstrap: false,
            isInternal: false,
            prompt: "Can you summarize the last 5 commits?",
            lastLoadedIteration: 1,
        });
        expect(result.load).toBe(false);
        expect(result.reason).toBe("already_loaded");
    });
});

describe("decideKnowledgeLoad — periodic refresh", () => {
    it("refreshes when interval is reached (default 5)", () => {
        const result = decideKnowledgeLoad({
            iteration: 5,
            isBootstrap: false,
            isInternal: false,
            prompt: "just a normal turn",
            lastLoadedIteration: 0,
        });
        expect(result.load).toBe(true);
        expect(result.reason).toBe("periodic_refresh");
    });

    it("refreshes when interval is exceeded", () => {
        const result = decideKnowledgeLoad({
            iteration: 8,
            isBootstrap: false,
            isInternal: false,
            prompt: "normal turn",
            lastLoadedIteration: 2,
        });
        expect(result.load).toBe(true);
        expect(result.reason).toBe("periodic_refresh");
    });

    it("does NOT refresh before interval is reached", () => {
        const result = decideKnowledgeLoad({
            iteration: 3,
            isBootstrap: false,
            isInternal: false,
            prompt: "normal turn",
            lastLoadedIteration: 0,
        });
        expect(result.load).toBe(false);
        expect(result.reason).toBe("already_loaded");
    });

    it("honors custom refreshInterval", () => {
        const loadAt3 = decideKnowledgeLoad({
            iteration: 3,
            isBootstrap: false,
            isInternal: false,
            prompt: "normal",
            lastLoadedIteration: 0,
            refreshInterval: 3,
        });
        expect(loadAt3.load).toBe(true);
        expect(loadAt3.reason).toBe("periodic_refresh");

        const skipAt2 = decideKnowledgeLoad({
            iteration: 2,
            isBootstrap: false,
            isInternal: false,
            prompt: "normal",
            lastLoadedIteration: 0,
            refreshInterval: 3,
        });
        expect(skipAt2.load).toBe(false);
    });

    it("disables periodic refresh when refreshInterval=0", () => {
        const result = decideKnowledgeLoad({
            iteration: 100,
            isBootstrap: false,
            isInternal: false,
            prompt: "normal",
            lastLoadedIteration: 0,
            refreshInterval: 0,
        });
        expect(result.load).toBe(false);
        expect(result.reason).toBe("already_loaded");
    });

    it("default refresh interval constant is 5", () => {
        expect(DEFAULT_KNOWLEDGE_REFRESH_INTERVAL).toBe(5);
    });
});

// ─── promptNeedsKnowledge ────────────────────────────────────────

describe("promptNeedsKnowledge", () => {
    it("returns true for 'skills' (case-insensitive)", () => {
        expect(promptNeedsKnowledge("List available Skills")).toBe(true);
        expect(promptNeedsKnowledge("check my skills")).toBe(true);
        expect(promptNeedsKnowledge("SKILLS")).toBe(true);
    });

    it("returns true for 'facts'", () => {
        expect(promptNeedsKnowledge("what facts do you have")).toBe(true);
    });

    it("returns true for 'knowledge'", () => {
        expect(promptNeedsKnowledge("Do you have knowledge about X?")).toBe(true);
    });

    it("returns true for 'read_facts' tool name", () => {
        expect(promptNeedsKnowledge("call read_facts to check")).toBe(true);
    });

    it("returns true for namespace paths", () => {
        expect(promptNeedsKnowledge("look in skills/infra/k8s")).toBe(true);
        expect(promptNeedsKnowledge("check asks/networking")).toBe(true);
    });

    it("returns false for irrelevant text", () => {
        expect(promptNeedsKnowledge("deploy my application to production")).toBe(false);
        expect(promptNeedsKnowledge("summarize the last 10 commits")).toBe(false);
        expect(promptNeedsKnowledge("hello world")).toBe(false);
        expect(promptNeedsKnowledge("")).toBe(false);
    });
});

// ─── classifyContextPressure ─────────────────────────────────────

describe("classifyContextPressure", () => {
    it("returns 'ok' below warn threshold", () => {
        expect(classifyContextPressure(0)).toBe("ok");
        expect(classifyContextPressure(0.5)).toBe("ok");
        expect(classifyContextPressure(0.699)).toBe("ok");
    });

    it("returns 'warn' at and above 0.70 up to (not including) 0.85", () => {
        expect(classifyContextPressure(0.70)).toBe("warn");
        expect(classifyContextPressure(0.75)).toBe("warn");
        expect(classifyContextPressure(0.849)).toBe("warn");
    });

    it("returns 'high' at and above 0.85", () => {
        expect(classifyContextPressure(0.85)).toBe("high");
        expect(classifyContextPressure(0.90)).toBe("high");
        expect(classifyContextPressure(1.0)).toBe("high");
    });

    it("handles edge values at exact thresholds", () => {
        expect(classifyContextPressure(0.70)).toBe("warn");
        expect(classifyContextPressure(0.85)).toBe("high");
    });
});
