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
  it("extracts ObservedToolCall[] from tracker invocations", () => {
    const tracker = makeTracker([
      {
        name: "test_add",
        args: { a: 1, b: 2 },
        result: { result: 3 },
        timestamp: 1000,
        order: 0,
      },
    ]);
    const observed = extractObservedCalls(tracker);
    expect(observed).toHaveLength(1);
    expect(observed[0].name).toBe("test_add");
    expect(observed[0].args).toEqual({ a: 1, b: 2 });
    expect(observed[0].result).toEqual({ result: 3 });
  });

  it("preserves order field", () => {
    const tracker = makeTracker([
      { name: "a", args: {}, result: null, timestamp: 1, order: 0 },
      { name: "b", args: {}, result: null, timestamp: 2, order: 1 },
      { name: "c", args: {}, result: null, timestamp: 3, order: 2 },
    ]);
    const observed = extractObservedCalls(tracker);
    expect(observed.map((o) => o.order)).toEqual([0, 1, 2]);
  });

  it("preserves args and result", () => {
    const tracker = makeTracker([
      {
        name: "test_weather",
        args: { city: "Paris", unit: "celsius" },
        result: { temperature: 22, city: "Paris" },
        timestamp: 5,
        order: 0,
      },
    ]);
    const observed = extractObservedCalls(tracker);
    expect(observed[0].args).toEqual({ city: "Paris", unit: "celsius" });
    expect(observed[0].result).toEqual({ temperature: 22, city: "Paris" });
    expect(observed[0].timestamp).toBe(5);
  });

  it("returns empty array for empty tracker", () => {
    const tracker = makeTracker([]);
    expect(extractObservedCalls(tracker)).toEqual([]);
  });

  it("produces output that validates against ObservedToolCallSchema", () => {
    const tracker = makeTracker([
      {
        name: "test_multiply",
        args: { a: 3, b: 4 },
        result: { result: 12 },
        timestamp: 100,
        order: 0,
      },
    ]);
    const observed = extractObservedCalls(tracker);
    for (const call of observed) {
      expect(() => ObservedToolCallSchema.parse(call)).not.toThrow();
    }
  });
});
