import { describe, it, expect } from "vitest";
import { extractObservedCalls } from "../src/observers/tool-tracker.js";
import { ObservedToolCallSchema } from "../src/types.js";
import type { EvalToolTracker } from "../src/fixtures/eval-tools.js";

function makeTracker(invocations: EvalToolTracker["invocations"]): EvalToolTracker {
  return {
    invocations,
    reset() {
      this.invocations = [];
    },
  };
}

describe("extractObservedCalls", () => {
  it("extracts ObservedToolCall[] preserving name/args/result/order/timestamp", () => {
    const tracker = makeTracker([
      { name: "test_add", args: { a: 1, b: 2 }, result: { result: 3 }, timestamp: 1000, order: 0 },
      { name: "test_weather", args: { city: "Paris" }, result: { temperature: 22 }, timestamp: 1001, order: 1 },
    ]);
    const observed = extractObservedCalls(tracker);
    expect(observed).toHaveLength(2);
    expect(observed.map((o) => o.order)).toEqual([0, 1]);
    expect(observed[0]).toMatchObject({ name: "test_add", args: { a: 1, b: 2 }, result: { result: 3 }, timestamp: 1000 });
    expect(observed[1].args).toEqual({ city: "Paris" });
  });

  it("returns empty array for empty tracker", () => {
    expect(extractObservedCalls(makeTracker([]))).toEqual([]);
  });

  it("output validates against ObservedToolCallSchema", () => {
    const tracker = makeTracker([
      { name: "test_multiply", args: { a: 3, b: 4 }, result: { result: 12 }, timestamp: 100, order: 0 },
    ]);
    for (const c of extractObservedCalls(tracker)) {
      expect(() => ObservedToolCallSchema.parse(c)).not.toThrow();
    }
  });
});
