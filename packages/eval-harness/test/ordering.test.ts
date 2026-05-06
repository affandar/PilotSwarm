import { describe, it, expect } from "vitest";
import { gradeOrdering } from "../src/graders/ordering.js";
import type { ObservedToolCall, EvalToolCall } from "../src/types.js";

function obs(name: string, order: number): ObservedToolCall {
  return { name, args: {}, order };
}

const abcExpected: EvalToolCall[] = [
  { name: "a", match: "subset" },
  { name: "b", match: "subset" },
  { name: "c", match: "subset" },
];

describe("gradeOrdering", () => {
  it("strict: subsequence with extras passes; missing call fails", () => {
    const observed = [obs("a", 0), obs("x", 1), obs("b", 2), obs("y", 3), obs("c", 4)];
    expect(gradeOrdering(observed, abcExpected, "strict").pass).toBe(true);
    expect(gradeOrdering([obs("a", 0), obs("c", 1)], abcExpected, "strict").pass).toBe(false);
  });

  it("strict: wrong order fails", () => {
    expect(gradeOrdering([obs("c", 0), obs("b", 1), obs("a", 2)], abcExpected, "strict").pass).toBe(false);
  });

  it("exactSequence rejects interleaved calls; subsequence accepts them", () => {
    const observed = [obs("a", 0), obs("delete_db", 1), obs("b", 2)];
    const exp: EvalToolCall[] = [
      { name: "a", match: "subset" },
      { name: "b", match: "subset" },
    ];
    expect(gradeOrdering(observed, exp, "exactSequence").pass).toBe(false);
    expect(gradeOrdering(observed, exp, "subsequence").pass).toBe(true);
  });

  it("unordered: all present any order passes; missing fails", () => {
    expect(gradeOrdering([obs("c", 0), obs("a", 1), obs("b", 2)], abcExpected, "unordered").pass).toBe(true);
    expect(gradeOrdering([obs("a", 0), obs("c", 1)], abcExpected, "unordered").pass).toBe(false);
  });

  it("empty expected passes trivially with value=1", () => {
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
    expect(gradeOrdering(observed, expected, "strict").pass).toBe(false);
  });

  it("unordered enforces multiset semantics: 2 expected vs 1 observed of same tool fails with partial value", () => {
    const expected: EvalToolCall[] = [
      { name: "test_weather", match: "subset" },
      { name: "test_weather", match: "subset" },
    ];
    const partial = gradeOrdering([obs("test_weather", 0)], expected, "unordered");
    expect(partial.pass).toBe(false);
    expect(partial.value).toBeCloseTo(0.5, 5);
    const full = gradeOrdering([obs("test_weather", 0), obs("test_weather", 1)], expected, "unordered");
    expect(full.pass).toBe(true);
    expect(full.value).toBe(1);
  });
});
