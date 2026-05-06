import { describe, it, expect } from "vitest";
import { FakeDriver } from "../src/drivers/fake-driver.js";
import type { Driver } from "../src/drivers/types.js";
import type { EvalSample, ObservedResult } from "../src/types.js";
import { ObservedResultSchema } from "../src/types.js";
import { makeObservedResult } from "./fixtures/builders.js";

function makeSample(id: string, prompt = "hello"): EvalSample {
  return {
    id,
    description: `sample ${id}`,
    input: { prompt },
    expected: { toolSequence: "unordered" },
    timeoutMs: 120_000,
  };
}

describe("FakeDriver", () => {
  it("returns the configured response (finalResponse, sessionId, toolCalls) for a matching sampleId", async () => {
    const response: ObservedResult = makeObservedResult({
      finalResponse: "hello world",
      sessionId: "s-1",
      toolCalls: [{ name: "test_add", args: { a: 1, b: 2 }, result: { result: 3 }, order: 0 }],
    });
    const driver: Driver = new FakeDriver([{ sampleId: "sample-a", response }]);
    const r = await driver.run(makeSample("sample-a"));
    expect(r.finalResponse).toBe("hello world");
    expect(r.sessionId).toBe("s-1");
    expect(r.toolCalls).toHaveLength(1);
    expect(r.toolCalls[0].name).toBe("test_add");
    expect(() => ObservedResultSchema.parse(r)).not.toThrow();
  });

  it("throws for unknown sampleId (scripted failure path)", async () => {
    const driver = new FakeDriver([{ sampleId: "known", response: makeObservedResult() }]);
    await expect(driver.run(makeSample("unknown"))).rejects.toThrow(/unknown/i);
  });

  it("FakeDriver.fromMap() routes by sampleId", async () => {
    const driver = FakeDriver.fromMap({
      "s-1": makeObservedResult({ finalResponse: "r1" }),
      "s-2": makeObservedResult({ finalResponse: "r2" }),
    });
    expect((await driver.run(makeSample("s-1"))).finalResponse).toBe("r1");
    expect((await driver.run(makeSample("s-2"))).finalResponse).toBe("r2");
  });

  it("returns distinct cloned objects per call (no mutation leak across runs)", async () => {
    const stored = makeObservedResult({
      finalResponse: "original",
      toolCalls: [{ name: "test_add", args: { a: 1 }, order: 0 }],
    });
    const driver = new FakeDriver([{ sampleId: "s", response: stored }]);
    const r1 = await driver.run(makeSample("s"));
    const r2 = await driver.run(makeSample("s"));
    expect(r1).not.toBe(r2);
    r1.finalResponse = "mutated";
    (r1.toolCalls[0].args as Record<string, unknown>).a = 999;
    expect(r2.finalResponse).toBe("original");
    expect(r2.toolCalls[0].args).toEqual({ a: 1 });
  });
});
