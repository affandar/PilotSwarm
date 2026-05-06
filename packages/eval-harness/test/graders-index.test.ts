import { describe, it, expect } from "vitest";
import { gradeEvalCase } from "../src/graders/index.js";
import type { ObservedResult, EvalExpected } from "../src/types.js";

function mkObserved(overrides: Partial<ObservedResult> = {}): ObservedResult {
  return {
    toolCalls: [],
    finalResponse: "",
    sessionId: "s1",
    latencyMs: 0,
    ...overrides,
  };
}

describe("gradeEvalCase", () => {
  it("full case with tool calls + response + CMS → multiple scores returned", () => {
    const observed = mkObserved({
      toolCalls: [{ name: "add", args: { a: 1, b: 2 }, order: 0 }],
      finalResponse: "The sum is 3",
      cmsState: "idle",
    });
    const expected: EvalExpected = {
      toolCalls: [{ name: "add", args: { a: 1, b: 2 }, match: "subset" }],
      toolSequence: "unordered",
      response: { containsAll: ["3"] },
      cms: { stateIn: ["idle"] },
    };
    const scores = gradeEvalCase(observed, expected);
    expect(scores.length).toBeGreaterThan(1);
    expect(scores.some((s) => s.name === "tool-names")).toBe(true);
    expect(scores.some((s) => s.name === "response-contains")).toBe(true);
    expect(scores.some((s) => s.name === "cms-state")).toBe(true);
  });

  it("no tool expectations → tool graders skipped (but forbidden/call-count can still apply if set)", () => {
    const observed = mkObserved({ finalResponse: "hi" });
    const expected: EvalExpected = {
      toolSequence: "unordered",
      response: { containsAll: ["hi"] },
    };
    const scores = gradeEvalCase(observed, expected);
    expect(scores.some((s) => s.name === "tool-names")).toBe(false);
    expect(scores.some((s) => s.name === "response-contains")).toBe(true);
  });

  it("no response expectations → response grader skipped", () => {
    const observed = mkObserved({
      toolCalls: [{ name: "add", args: {}, order: 0 }],
    });
    const expected: EvalExpected = {
      toolCalls: [{ name: "add", match: "subset" }],
      toolSequence: "unordered",
    };
    const scores = gradeEvalCase(observed, expected);
    expect(scores.some((s) => s.name === "response-contains")).toBe(false);
  });

  it("all passing → all scores pass", () => {
    const observed = mkObserved({
      toolCalls: [{ name: "add", args: { a: 1, b: 2 }, order: 0 }],
      finalResponse: "result 3",
      cmsState: "idle",
    });
    const expected: EvalExpected = {
      toolCalls: [{ name: "add", args: { a: 1, b: 2 }, match: "subset" }],
      toolSequence: "strict",
      response: { containsAll: ["3"] },
      cms: { stateIn: ["idle"] },
    };
    const scores = gradeEvalCase(observed, expected);
    expect(scores.every((s) => s.pass)).toBe(true);
  });

  it("mixed results → correct pass/fail per score", () => {
    const observed = mkObserved({
      toolCalls: [{ name: "multiply", args: {}, order: 0 }],
      finalResponse: "wrong",
      cmsState: "errored",
    });
    const expected: EvalExpected = {
      toolCalls: [{ name: "add", match: "subset" }],
      toolSequence: "unordered",
      response: { containsAll: ["right"] },
      cms: { stateIn: ["idle"] },
    };
    const scores = gradeEvalCase(observed, expected);
    expect(scores.every((s) => !s.pass)).toBe(true);
  });

  it("matches expected tool calls to distinct observed calls (no double-counting)", () => {
    // Two expected calls to test_weather with different args.
    // Only one observed call. The same observed call must NOT satisfy both expectations.
    const observed = mkObserved({
      toolCalls: [{ name: "test_weather", args: { city: "Paris" }, order: 0 }],
    });
    const expected: EvalExpected = {
      toolCalls: [
        { name: "test_weather", args: { city: "Paris" }, match: "subset" },
        { name: "test_weather", args: { city: "London" }, match: "subset" },
      ],
      toolSequence: "unordered",
    };
    const scores = gradeEvalCase(observed, expected);
    const argScores = scores.filter((s) => s.name === "tool-args:test_weather");
    expect(argScores).toHaveLength(2);
    // Exactly one should pass (Paris), the other should fail (London missing — no observed call left).
    const passCount = argScores.filter((s) => s.pass).length;
    expect(passCount).toBe(1);
  });

  it("matches most-constrained expectations first to avoid mis-pairing duplicates", () => {
    // Two observed calls to the same tool, one with extra args.
    // A naive greedy match (in declaration order) would pair the less-specific
    // expected call with the more-specific observed call, then fail to match
    // the more-specific expected call against what's left. Sorting expected by
    // arg-count descending fixes this.
    const observed = mkObserved({
      toolCalls: [
        { name: "f", args: { a: 1 }, order: 0 },
        { name: "f", args: { a: 1, b: 2 }, order: 1 },
      ],
    });
    const expected: EvalExpected = {
      toolCalls: [
        { name: "f", args: { a: 1 }, match: "subset" },
        { name: "f", args: { a: 1, b: 2 }, match: "subset" },
      ],
      toolSequence: "unordered",
    };
    const scores = gradeEvalCase(observed, expected);
    const argScores = scores.filter((s) => s.name.startsWith("tool-args:f"));
    expect(argScores).toHaveLength(2);
    expect(argScores.every((s) => s.pass)).toBe(true);
  });
});
