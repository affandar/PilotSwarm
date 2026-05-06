import { describe, it, expect } from "vitest";
import { gradeOrdering } from "../src/graders/ordering.js";
import type { ObservedToolCall, EvalToolCall } from "../src/types.js";

function obs(name: string, order: number): ObservedToolCall {
  return { name, args: {}, order };
}

describe("gradeOrdering: strict", () => {
  it("correct order passes", () => {
    const observed = [obs("a", 0), obs("b", 1), obs("c", 2)];
    const expected: EvalToolCall[] = [
      { name: "a", match: "subset" },
      { name: "b", match: "subset" },
      { name: "c", match: "subset" },
    ];
    const s = gradeOrdering(observed, expected, "strict");
    expect(s.pass).toBe(true);
    expect(s.value).toBe(1);
  });

  it("wrong order fails", () => {
    const observed = [obs("c", 0), obs("b", 1), obs("a", 2)];
    const expected: EvalToolCall[] = [
      { name: "a", match: "subset" },
      { name: "b", match: "subset" },
      { name: "c", match: "subset" },
    ];
    const s = gradeOrdering(observed, expected, "strict");
    expect(s.pass).toBe(false);
  });

  it("subsequence match (extra calls between) passes", () => {
    const observed = [obs("a", 0), obs("x", 1), obs("b", 2), obs("y", 3), obs("c", 4)];
    const expected: EvalToolCall[] = [
      { name: "a", match: "subset" },
      { name: "b", match: "subset" },
      { name: "c", match: "subset" },
    ];
    const s = gradeOrdering(observed, expected, "strict");
    expect(s.pass).toBe(true);
  });

  it("missing expected call fails", () => {
    const observed = [obs("a", 0), obs("c", 1)];
    const expected: EvalToolCall[] = [
      { name: "a", match: "subset" },
      { name: "b", match: "subset" },
      { name: "c", match: "subset" },
    ];
    const s = gradeOrdering(observed, expected, "strict");
    expect(s.pass).toBe(false);
  });
});

describe("gradeOrdering: unordered", () => {
  it("all present any order passes", () => {
    const observed = [obs("c", 0), obs("a", 1), obs("b", 2)];
    const expected: EvalToolCall[] = [
      { name: "a", match: "subset" },
      { name: "b", match: "subset" },
      { name: "c", match: "subset" },
    ];
    const s = gradeOrdering(observed, expected, "unordered");
    expect(s.pass).toBe(true);
    expect(s.value).toBe(1);
  });

  it("missing call fails", () => {
    const observed = [obs("a", 0), obs("c", 1)];
    const expected: EvalToolCall[] = [
      { name: "a", match: "subset" },
      { name: "b", match: "subset" },
      { name: "c", match: "subset" },
    ];
    const s = gradeOrdering(observed, expected, "unordered");
    expect(s.pass).toBe(false);
  });
});

describe("gradeOrdering: edge cases", () => {
  it("empty expected → passes trivially", () => {
    const s = gradeOrdering([obs("a", 0)], [], "strict");
    expect(s.pass).toBe(true);
    expect(s.value).toBe(1);
  });

  it("respects explicit order field", () => {
    const observed = [obs("a", 0), obs("b", 1)];
    const expected: EvalToolCall[] = [
      { name: "b", match: "subset", order: 0 },
      { name: "a", match: "subset", order: 1 },
    ];
    const s = gradeOrdering(observed, expected, "strict");
    expect(s.pass).toBe(false);
  });
});

describe("gradeOrdering: multiset semantics", () => {
  it("unordered: fails when expected has 2 calls to same tool but observed has only 1", () => {
    const observed = [obs("test_weather", 0)];
    const expected: EvalToolCall[] = [
      { name: "test_weather", match: "subset" },
      { name: "test_weather", match: "subset" },
    ];
    const s = gradeOrdering(observed, expected, "unordered");
    expect(s.pass).toBe(false);
    expect(s.value).toBeCloseTo(0.5, 5);
  });

  it("unordered: passes when expected has 2 calls to same tool and observed has 2", () => {
    const observed = [obs("test_weather", 0), obs("test_weather", 1)];
    const expected: EvalToolCall[] = [
      { name: "test_weather", match: "subset" },
      { name: "test_weather", match: "subset" },
    ];
    const s = gradeOrdering(observed, expected, "unordered");
    expect(s.pass).toBe(true);
    expect(s.value).toBe(1);
  });
});
