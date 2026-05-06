import { describe, it, expect } from "vitest";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadEvalTask } from "../src/loader.js";
import { EvalRunner } from "../src/runner.js";
import { FakeDriver } from "../src/drivers/fake-driver.js";
import { ConsoleReporter } from "../src/reporters/console.js";
import type { ObservedResult } from "../src/types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const task = loadEvalTask(
  resolve(__dirname, "../datasets/tool-call-correctness.v1.json"),
);

const fakeScenarios: Record<string, ObservedResult> = {
  "single.add.basic": {
    toolCalls: [
      { name: "test_add", args: { a: 17, b: 25 }, result: { result: 42 }, order: 0 },
    ],
    finalResponse: "The result of 17 + 25 is 42.",
    sessionId: "fake-session-1",
    latencyMs: 100,
    cmsState: "idle",
  },
  "single.weather.multi-param": {
    toolCalls: [
      { name: "test_weather", args: { city: "Tokyo" }, result: { temperature: 72 }, order: 0 },
    ],
    finalResponse: "The weather in Tokyo is 72°F and sunny.",
    sessionId: "fake-session-2",
    latencyMs: 100,
    cmsState: "idle",
  },
  "selection.multiply-not-add": {
    toolCalls: [
      { name: "test_multiply", args: { a: 4, b: 5 }, result: { result: 20 }, order: 0 },
    ],
    finalResponse: "4 times 5 is 20.",
    sessionId: "fake-session-3",
    latencyMs: 100,
    cmsState: "idle",
  },
  "selection.no-tool-with-tools": {
    toolCalls: [],
    finalResponse: "Hello! How can I help you today?",
    sessionId: "fake-session-4",
    latencyMs: 50,
    cmsState: "idle",
  },
  "sequence.add-then-multiply": {
    toolCalls: [
      { name: "test_add", args: { a: 2, b: 3 }, result: { result: 5 }, order: 0 },
      { name: "test_multiply", args: { a: 4, b: 5 }, result: { result: 20 }, order: 1 },
    ],
    finalResponse: "2+3=5 and 4×5=20.",
    sessionId: "fake-session-5",
    latencyMs: 200,
    cmsState: "idle",
  },
  "multi.unordered-weather": {
    toolCalls: [
      { name: "test_weather", args: { city: "Tokyo" }, result: { temperature: 72 }, order: 0 },
      { name: "test_weather", args: { city: "London" }, result: { temperature: 55 }, order: 1 },
    ],
    finalResponse: "Tokyo: 72°F, London: 55°F.",
    sessionId: "fake-session-6",
    latencyMs: 150,
    cmsState: "idle",
  },
};

describe("eval:tool-call-correctness", () => {
  const driver = FakeDriver.fromMap(fakeScenarios);
  const runner = new EvalRunner({ driver, reporters: [new ConsoleReporter()] });

  it("loads golden dataset successfully", () => {
    expect(task.samples).toHaveLength(6);
    expect(task.schemaVersion).toBe(1);
  });

  it("all fake scenarios pass harness grading", async () => {
    const result = await runner.runTask(task);
    expect(result.summary.passed).toBe(6);
    expect(result.summary.failed).toBe(0);
    expect(result.summary.errored).toBe(0);
    expect(result.summary.passRate).toBe(1);
  });

  it("passes passRateFloor check", async () => {
    const result = await runner.runTask(task);
    expect(runner.checkPassRateFloor(result, task.passRateFloor ?? 0.8)).toBe(true);
  });

  for (const sample of task.samples) {
    it(`case: ${sample.id}`, async () => {
      const singleTask = { ...task, samples: [sample] };
      const result = await runner.runTask(singleTask);
      if (!result.cases[0].pass) {
        const failures = result.cases[0].scores.filter((s) => !s.pass);
        console.error(`Failed scores for ${sample.id}:`, failures);
      }
      expect(result.cases[0].pass).toBe(true);
    });
  }
});
