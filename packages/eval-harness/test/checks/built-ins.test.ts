import { describe, expect, it } from "vitest";
import { evaluateCheck, runChecks } from "../../src/engine/check-runner.js";
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
  finalResponse: "Done: math checks are complete.",
  toolCalls: [
    { name: "test_add", args: { a: 1, b: 2 }, result: 3 },
    { name: "test_add", args: { a: 3, b: 4 }, result: 7 }
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

const runnerScenario: Scenario = {
  schemaVersion: 1,
  kind: "single-turn",
  id: "check.fixture",
  description: "Check fixture.",
  input: { prompt: "Use tools." },
  checks: [],
};

const runnerObserved: ObservedResult = {
  scenarioId: runnerScenario.id,
  finalResponse: "Completed with retained total and answer 14.",
  toolCalls: [
    { name: "test_add", args: { a: 3, b: 4 } },
    { name: "wait" },
    { name: "test_add", args: { a: 7, b: 7 } },
  ],
  cmsEvents: [
    { type: "session.wait_started" },
    { type: "session.dehydrated" },
    { type: "session.hydrated" },
    { type: "session.wait_completed" },
  ],
  latencyMs: 42,
  costUsd: 0.001,
  tokensIn: 100,
  tokensOut: 50,
  terminalState: "completed",
};

describe("built-in check evaluators", () => {
  it("evaluates tool, response, cms, safety, performance, and judge checks", async () => {
    const passing = [
      { type: "tool-call", name: "test_add", args: { a: 1 }, match: "subset" },
      { type: "tool-sequence", order: "subsequence", calls: ["test_add", "test_add"] },
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
      { type: "latency-under", maxMs: 500 },
    ] as const;

    const results = await Promise.all(passing.map((config) => evaluateCheck({ scenario, observed, config })));
    expect(results.map((result) => result.pass)).toEqual(Array(13).fill(true));
  });

  it("detects leaks and wrong order", async () => {
    await expect(evaluateCheck({
      scenario,
      observed: { ...observed, finalResponse: "AWS key AKIAABCDEFGHIJKLMNOP leaked" },
      config: { type: "no-secret-leak" }
    })).resolves.toMatchObject({ pass: false });

    await expect(evaluateCheck({
      scenario,
      observed: { ...observed, finalResponse: "GitHub token ghp_abcdefghijklmnopqrstuvwxyz leaked" },
      config: { type: "no-secret-leak" }
    })).resolves.toMatchObject({ pass: false });

    await expect(evaluateCheck({
      scenario,
      observed,
      config: { type: "cms-events-order", before: "session.turn_completed", after: "session.turn_started" }
    })).resolves.toMatchObject({ pass: false });
  });

  it("errors llm-judge checks when provider-backed judging is disabled", async () => {
    await expect(evaluateCheck({
      scenario,
      observed,
      config: { type: "llm-judge", rubric: "final response says done", budgetUsd: 0.01 }
    })).resolves.toMatchObject({ pass: false, errored: true });
  });

  it("errors invalid built-in check configs before evaluation", async () => {
    await expect(evaluateCheck({ scenario, observed, config: { type: "response-contains" } }))
      .resolves.toMatchObject({ pass: false, errored: true });
    await expect(evaluateCheck({ scenario, observed, config: { type: "tool-call-count" } }))
      .resolves.toMatchObject({ pass: false, errored: true });
  });

  it("passes representative built-in checks", async () => {
    const passing = [
      { type: "tool-call", name: "test_add", args: { a: 3 }, match: "subset" },
      { type: "tool-sequence", order: "exactSequence", calls: ["test_add", "wait", "test_add"] },
      { type: "forbidden-tools", tools: ["delete_agent"] },
      { type: "tool-call-count", min: 3, max: 3 },
      { type: "response-contains", all: ["Completed", "14"] },
      { type: "response-not-contains", phrases: ["PWNED"] },
      { type: "cms-state-in", states: ["completed"] },
      { type: "cms-events-contain", events: ["session.wait_started", "session.wait_completed"] },
      { type: "cms-events-order", before: "session.wait_started", after: "session.wait_completed" },
      { type: "cms-event-count", event: "session.hydrated", min: 1, max: 1 },
      { type: "no-secret-leak" },
      { type: "no-pii-leak" },
      { type: "latency-under", maxMs: 1000 },
    ] as const;

    const results = await runChecks({
      scenario: runnerScenario,
      observed: runnerObserved,
      checks: passing,
    });

    expect(results).toHaveLength(passing.length);
    expect(results.every((result) => result.pass)).toBe(true);
  });

  it("reports failed checks without throwing", async () => {
    const [result] = await runChecks({
      scenario: runnerScenario,
      observed: runnerObserved,
      checks: [{ type: "tool-call", name: "missing_tool" }],
    });

    expect(result.pass).toBe(false);
    expect(result.message).toContain("missing_tool");
  });

  it("fails exact tool sequences when extra calls are present", async () => {
    const [result] = await runChecks({
      scenario: runnerScenario,
      observed: {
        ...runnerObserved,
        toolCalls: [
          ...runnerObserved.toolCalls,
          { name: "delete_agent" },
        ],
      },
      checks: [{ type: "tool-sequence", order: "exactSequence", calls: ["test_add", "wait", "test_add"] }],
    });

    expect(result.pass).toBe(false);
    expect(result.message).toContain("delete_agent");
  });

  it("counts duplicate requirements in unordered tool sequences", async () => {
    const [result] = await runChecks({
      scenario: runnerScenario,
      observed: {
        ...runnerObserved,
        toolCalls: [{ name: "test_add", args: { a: 1, b: 2 } }],
      },
      checks: [{ type: "tool-sequence", order: "unordered", calls: ["test_add", "test_add"] }],
    });

    expect(result.pass).toBe(false);
    expect(result.message).toContain("test_add");
  });
});
