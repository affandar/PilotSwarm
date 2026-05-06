import { describe, it, expect } from "vitest";
import {
  createEvalToolTracker,
  createEvalAddTool,
  createEvalMultiplyTool,
  createEvalWeatherTool,
} from "../src/fixtures/eval-tools.js";

describe("EvalToolTracker", () => {
  it("starts with empty invocations", () => {
    const { tracker } = createEvalToolTracker();
    expect(tracker.invocations).toEqual([]);
  });

  it("records all invocations in order across tools", async () => {
    const { tracker, tools } = createEvalToolTracker();
    await tools.add.handler({ a: 1, b: 2 });
    await tools.multiply.handler({ a: 3, b: 4 });
    await tools.add.handler({ a: 5, b: 6 });

    expect(tracker.invocations.length).toBe(3);
    expect(tracker.invocations[0].name).toBe("test_add");
    expect(tracker.invocations[0].args).toEqual({ a: 1, b: 2 });
    expect(tracker.invocations[0].order).toBe(0);
    expect(tracker.invocations[1].name).toBe("test_multiply");
    expect(tracker.invocations[1].order).toBe(1);
    expect(tracker.invocations[2].name).toBe("test_add");
    expect(tracker.invocations[2].args).toEqual({ a: 5, b: 6 });
    expect(tracker.invocations[2].order).toBe(2);
  });

  it("records results of each invocation", async () => {
    const { tracker, tools } = createEvalToolTracker();
    await tools.add.handler({ a: 2, b: 3 });
    expect(tracker.invocations[0].result).toEqual({ result: 5 });
  });

  it("records a timestamp for each invocation", async () => {
    const { tracker, tools } = createEvalToolTracker();
    const before = Date.now();
    await tools.add.handler({ a: 1, b: 1 });
    const after = Date.now();
    const ts = tracker.invocations[0].timestamp;
    expect(typeof ts).toBe("number");
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after);
  });

  it("reset() clears history", async () => {
    const { tracker, tools } = createEvalToolTracker();
    await tools.add.handler({ a: 1, b: 2 });
    expect(tracker.invocations.length).toBe(1);
    tracker.reset();
    expect(tracker.invocations).toEqual([]);
  });

  it("reset() restarts order from 0", async () => {
    const { tracker, tools } = createEvalToolTracker();
    await tools.add.handler({ a: 1, b: 2 });
    tracker.reset();
    await tools.add.handler({ a: 9, b: 9 });
    expect(tracker.invocations[0].order).toBe(0);
  });

  it("records multiple calls to the same tool", async () => {
    const { tracker, tools } = createEvalToolTracker();
    await tools.add.handler({ a: 1, b: 1 });
    await tools.add.handler({ a: 2, b: 2 });
    await tools.add.handler({ a: 3, b: 3 });
    expect(tracker.invocations.length).toBe(3);
    expect(tracker.invocations.map((i) => i.result)).toEqual([
      { result: 2 },
      { result: 4 },
      { result: 6 },
    ]);
  });
});

describe("createEvalAddTool / createEvalMultiplyTool", () => {
  it("standalone factories share tracker state", async () => {
    const { tracker } = createEvalToolTracker();
    const add = createEvalAddTool(tracker);
    const mul = createEvalMultiplyTool(tracker);
    await add.handler({ a: 1, b: 2 });
    await mul.handler({ a: 3, b: 4 });
    expect(tracker.invocations.length).toBe(2);
    expect(tracker.invocations[0].name).toBe("test_add");
    expect(tracker.invocations[1].name).toBe("test_multiply");
  });

  it("add tool name is 'test_add' and multiply is 'test_multiply'", () => {
    const { tracker } = createEvalToolTracker();
    const add = createEvalAddTool(tracker);
    const mul = createEvalMultiplyTool(tracker);
    expect(add.name).toBe("test_add");
    expect(mul.name).toBe("test_multiply");
  });
});

describe("createEvalWeatherTool", () => {
  it("accepts optional unit parameter", async () => {
    const { tracker } = createEvalToolTracker();
    const weather = createEvalWeatherTool(tracker);
    const result = await weather.handler({ city: "Seattle", unit: "celsius" });
    expect(tracker.invocations[0].args).toEqual({ city: "Seattle", unit: "celsius" });
    expect(result).toMatchObject({ city: "Seattle", unit: "celsius" });
  });

  it("defaults unit to 'fahrenheit' when omitted", async () => {
    const { tracker } = createEvalToolTracker();
    const weather = createEvalWeatherTool(tracker);
    const result = await weather.handler({ city: "Seattle" });
    expect(result).toMatchObject({ city: "Seattle", unit: "fahrenheit" });
  });

  it("exposes 'unit' in the tool parameter schema as optional", () => {
    const { tracker } = createEvalToolTracker();
    const weather = createEvalWeatherTool(tracker);
    const params = weather.parameters as {
      properties: Record<string, unknown>;
      required?: string[];
    };
    expect(params.properties).toHaveProperty("unit");
    expect(params.properties).toHaveProperty("city");
    expect(params.required).toContain("city");
    expect(params.required ?? []).not.toContain("unit");
  });

  it("records weather invocations in tracker", async () => {
    const { tracker, tools } = createEvalToolTracker();
    await tools.weather.handler({ city: "Austin" });
    await tools.weather.handler({ city: "NYC", unit: "celsius" });
    expect(tracker.invocations.length).toBe(2);
    expect(tracker.invocations[0].name).toBe("test_weather");
    expect(tracker.invocations[0].args).toEqual({ city: "Austin" });
    expect(tracker.invocations[1].args).toEqual({ city: "NYC", unit: "celsius" });
  });
});
