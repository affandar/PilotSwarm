import { describe, it, expect } from "vitest";
import {
  createEvalToolTracker,
  createEvalAddTool,
  createEvalMultiplyTool,
  createEvalWeatherTool,
} from "../src/fixtures/eval-tools.js";

describe("EvalToolTracker", () => {
  it("starts empty and records ordered invocations across tools with results", async () => {
    const { tracker, tools } = createEvalToolTracker();
    expect(tracker.invocations).toEqual([]);
    await tools.add.handler({ a: 1, b: 2 });
    await tools.multiply.handler({ a: 3, b: 4 });
    expect(tracker.invocations).toHaveLength(2);
    expect(tracker.invocations[0]).toMatchObject({ name: "test_add", args: { a: 1, b: 2 }, order: 0, result: { result: 3 } });
    expect(tracker.invocations[1]).toMatchObject({ name: "test_multiply", order: 1, result: { result: 12 } });
    expect(typeof tracker.invocations[0].timestamp).toBe("number");
  });

  it("reset() clears history and restarts order from 0", async () => {
    const { tracker, tools } = createEvalToolTracker();
    await tools.add.handler({ a: 1, b: 2 });
    tracker.reset();
    expect(tracker.invocations).toEqual([]);
    await tools.add.handler({ a: 9, b: 9 });
    expect(tracker.invocations[0].order).toBe(0);
  });
});

describe("standalone tool factories", () => {
  it("createEvalAddTool / createEvalMultiplyTool share tracker state", async () => {
    const { tracker } = createEvalToolTracker();
    const add = createEvalAddTool(tracker);
    const mul = createEvalMultiplyTool(tracker);
    await add.handler({ a: 1, b: 2 });
    await mul.handler({ a: 3, b: 4 });
    expect(tracker.invocations.map((i) => i.name)).toEqual(["test_add", "test_multiply"]);
    expect(add.name).toBe("test_add");
    expect(mul.name).toBe("test_multiply");
  });
});

describe("createEvalWeatherTool", () => {
  it("defaults unit to 'fahrenheit' when omitted and records invocations", async () => {
    const { tracker, tools } = createEvalToolTracker();
    const r1 = await tools.weather.handler({ city: "Seattle" });
    const r2 = await tools.weather.handler({ city: "NYC", unit: "celsius" });
    expect(r1).toMatchObject({ city: "Seattle", unit: "fahrenheit" });
    expect(r2).toMatchObject({ city: "NYC", unit: "celsius" });
    expect(tracker.invocations).toHaveLength(2);
  });

  it("exposes 'unit' as optional in the tool parameter schema", () => {
    const { tracker } = createEvalToolTracker();
    const weather = createEvalWeatherTool(tracker);
    const params = weather.parameters as { properties: Record<string, unknown>; required?: string[] };
    expect(params.properties).toHaveProperty("unit");
    expect(params.required).toContain("city");
    expect(params.required ?? []).not.toContain("unit");
  });
});
