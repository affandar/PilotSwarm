import { describe, expect, it } from "vitest";
import { evaluateCheck } from "../../src/engine/check-runner.js";
import type { ObservedResult, Scenario } from "../../src/types.js";

const scenario: Scenario = {
  schemaVersion: 1,
  kind: "single-turn",
  id: "checks.demo",
  description: "Checks",
  agent: "default",
  tools: [],
  tags: [],
  checks: [],
  input: { prompt: "Demo" },
  llmJudgeRequired: false
};

const observed: ObservedResult = {
  scenarioId: "checks.demo",
  finalResponse: "Done: Paris is sunny and complete.",
  toolCalls: [
    { name: "test_weather", args: { city: "Paris" }, result: "sunny" },
    { name: "test_add", args: { a: 1, b: 2 }, result: 3 }
  ],
  cmsEvents: [
    { type: "session.turn_started" },
    { type: "session.wait_started" },
    { type: "session.wait_completed" },
    { type: "session.turn_completed" }
  ],
  latencyMs: 250,
  costUsd: 0.002,
  tokensIn: 20,
  tokensOut: 30,
  terminalState: "completed"
};

describe("built-in check evaluators", () => {
  it("evaluates tool, response, cms, safety, performance, and judge checks", async () => {
    const passing = [
      { type: "tool-call", name: "test_weather", args: { city: "Paris" }, match: "subset" },
      { type: "tool-sequence", order: "subsequence", calls: ["test_weather", "test_add"] },
      { type: "forbidden-tools", tools: ["error_tool"] },
      { type: "tool-call-count", min: 2, max: 2 },
      { type: "response-contains", all: ["Done", "complete"] },
      { type: "response-not-contains", phrases: ["API_KEY"] },
      { type: "cms-state-in", states: ["completed"] },
      { type: "cms-events-contain", events: ["session.turn_started", "session.turn_completed"] },
      { type: "cms-events-order", before: "session.wait_started", after: "session.wait_completed" },
      { type: "cms-event-count", event: "session.turn_completed", min: 1, max: 1 },
      { type: "no-secret-leak" },
      { type: "no-pii-leak" },
      { type: "llm-judge", rubric: "final response says done", budgetUsd: 0.01 },
      { type: "latency-under", maxMs: 500 },
      { type: "cost-under", maxUsd: 0.01 },
      { type: "tokens-under", maxTotal: 100 },
      { type: "goal-completed" }
    ] as const;

    const results = await Promise.all(passing.map((config) => evaluateCheck({ scenario, observed, config })));
    expect(results.map((result) => result.pass)).toEqual(Array(17).fill(true));
  });

  it("detects leaks and wrong order", async () => {
    await expect(evaluateCheck({
      scenario,
      observed: { ...observed, finalResponse: "AWS key AKIAABCDEFGHIJKLMNOP leaked" },
      config: { type: "no-secret-leak" }
    })).resolves.toMatchObject({ pass: false });

    await expect(evaluateCheck({
      scenario,
      observed,
      config: { type: "cms-events-order", before: "session.turn_completed", after: "session.turn_started" }
    })).resolves.toMatchObject({ pass: false });
  });
});
