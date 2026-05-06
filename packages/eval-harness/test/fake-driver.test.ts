import { describe, it, expect } from "vitest";
import { FakeDriver } from "../src/drivers/fake-driver.js";
import type { Driver } from "../src/drivers/types.js";
import type { EvalSample, ObservedResult } from "../src/types.js";
import { ObservedResultSchema } from "../src/types.js";

function makeSample(id: string, prompt = "hello"): EvalSample {
  return {
    id,
    description: `sample ${id}`,
    input: { prompt },
    expected: { toolSequence: "unordered" },
    timeoutMs: 120_000,
  };
}

function makeResult(overrides: Partial<ObservedResult> = {}): ObservedResult {
  return {
    toolCalls: [],
    finalResponse: "ok",
    sessionId: "sess-1",
    latencyMs: 10,
    ...overrides,
  };
}

describe("FakeDriver", () => {
  it("returns pre-configured response for matching sampleId", async () => {
    const response = makeResult({ finalResponse: "hello world", sessionId: "s-1" });
    const driver = new FakeDriver([{ sampleId: "sample-a", response }]);
    const result = await driver.run(makeSample("sample-a"));
    expect(result.finalResponse).toBe("hello world");
    expect(result.sessionId).toBe("s-1");
  });

  it("throws error for unknown sampleId", async () => {
    const driver = new FakeDriver([{ sampleId: "known", response: makeResult() }]);
    await expect(driver.run(makeSample("unknown"))).rejects.toThrow(/unknown/i);
  });

  it("FakeDriver.fromMap() creates driver from record", async () => {
    const driver = FakeDriver.fromMap({
      "s-1": makeResult({ finalResponse: "r1" }),
      "s-2": makeResult({ finalResponse: "r2" }),
    });
    expect(await (await driver.run(makeSample("s-1"))).finalResponse).toBe("r1");
    expect((await driver.run(makeSample("s-2"))).finalResponse).toBe("r2");
  });

  it("returns correct tool calls from scenario", async () => {
    const response = makeResult({
      toolCalls: [
        { name: "test_add", args: { a: 1, b: 2 }, result: { result: 3 }, order: 0 },
      ],
    });
    const driver = new FakeDriver([{ sampleId: "sid", response }]);
    const result = await driver.run(makeSample("sid"));
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].name).toBe("test_add");
    expect(result.toolCalls[0].args).toEqual({ a: 1, b: 2 });
  });

  it("returns correct final response", async () => {
    const driver = new FakeDriver([
      { sampleId: "x", response: makeResult({ finalResponse: "the final answer is 42" }) },
    ]);
    const result = await driver.run(makeSample("x"));
    expect(result.finalResponse).toBe("the final answer is 42");
  });

  it("returns correct sessionId", async () => {
    const driver = new FakeDriver([
      { sampleId: "x", response: makeResult({ sessionId: "session-abc" }) },
    ]);
    const result = await driver.run(makeSample("x"));
    expect(result.sessionId).toBe("session-abc");
  });

  it("multiple scenarios each return its own response", async () => {
    const driver = new FakeDriver([
      { sampleId: "a", response: makeResult({ finalResponse: "A" }) },
      { sampleId: "b", response: makeResult({ finalResponse: "B" }) },
      { sampleId: "c", response: makeResult({ finalResponse: "C" }) },
    ]);
    expect((await driver.run(makeSample("a"))).finalResponse).toBe("A");
    expect((await driver.run(makeSample("b"))).finalResponse).toBe("B");
    expect((await driver.run(makeSample("c"))).finalResponse).toBe("C");
  });

  it("implements Driver interface (run method exists)", () => {
    const driver: Driver = new FakeDriver([]);
    expect(typeof driver.run).toBe("function");
  });

  it("ObservedResult shape validates against schema", async () => {
    const driver = new FakeDriver([
      {
        sampleId: "s",
        response: makeResult({
          toolCalls: [{ name: "t", args: {}, order: 0 }],
          finalResponse: "done",
          sessionId: "sess",
          latencyMs: 5,
        }),
      },
    ]);
    const result = await driver.run(makeSample("s"));
    expect(() => ObservedResultSchema.parse(result)).not.toThrow();
  });

  it("simulates small latency (non-negative latencyMs)", async () => {
    const driver = new FakeDriver([
      { sampleId: "s", response: makeResult({ latencyMs: 1 }) },
    ]);
    const result = await driver.run(makeSample("s"));
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("returns distinct objects for repeated calls to same sampleId (no mutation leak)", async () => {
    const stored = makeResult({
      finalResponse: "original",
      toolCalls: [{ name: "test_add", args: { a: 1 }, order: 0 }],
    });
    const driver = new FakeDriver([{ sampleId: "s", response: stored }]);

    const r1 = await driver.run(makeSample("s"));
    const r2 = await driver.run(makeSample("s"));

    expect(r1).not.toBe(r2);
    expect(r1.toolCalls).not.toBe(r2.toolCalls);

    // mutate r1; r2 must remain unaffected
    r1.finalResponse = "mutated";
    (r1.toolCalls[0].args as Record<string, unknown>).a = 999;

    expect(r2.finalResponse).toBe("original");
    expect(r2.toolCalls[0].args).toEqual({ a: 1 });

    // Stored scenario also unaffected for future runs
    const r3 = await driver.run(makeSample("s"));
    expect(r3.finalResponse).toBe("original");
    expect(r3.toolCalls[0].args).toEqual({ a: 1 });
  });
});
