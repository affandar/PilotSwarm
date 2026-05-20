import { describe, expect, it } from "vitest";
import { runChecks } from "../src/engine/check-runner.js";
import type { ObservedResult, Scenario } from "../src/types.js";

const scenario: Scenario = {
  schemaVersion: 1,
  kind: "single-turn",
  id: "check.fixture",
  description: "Check fixture.",
  input: { prompt: "Use tools." },
  checks: [],
};

const observed: ObservedResult = {
  scenarioId: scenario.id,
  finalResponse: "Completed with Tokyo weather and answer 14.",
  toolCalls: [
    { name: "test_add", args: { a: 3, b: 4 } },
    { name: "wait" },
    { name: "test_multiply", args: { a: 7, b: 2 } },
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

describe("built-in check runner", () => {
  it("passes representative built-in checks", async () => {
    const results = await runChecks({
      scenario,
      observed,
      checks: [
        { type: "tool-call", name: "test_add", args: { a: 3 }, match: "subset" },
        { type: "tool-sequence", order: "exactSequence", calls: ["test_add", "wait", "test_multiply"] },
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
        { type: "cost-under", maxUsd: 0.01 },
        { type: "tokens-under", maxTotal: 200 },
        { type: "goal-completed" },
      ],
    });

    expect(results.every((result) => result.pass)).toBe(true);
  });

  it("reports failed checks without throwing", async () => {
    const [result] = await runChecks({
      scenario,
      observed,
      checks: [{ type: "tool-call", name: "missing_tool" }],
    });

    expect(result.pass).toBe(false);
    expect(result.message).toContain("missing_tool");
  });

  it("fails exact tool sequences when extra calls are present", async () => {
    const [result] = await runChecks({
      scenario,
      observed: {
        ...observed,
        toolCalls: [
          ...observed.toolCalls,
          { name: "delete_agent" },
        ],
      },
      checks: [{ type: "tool-sequence", order: "exactSequence", calls: ["test_add", "wait", "test_multiply"] }],
    });

    expect(result.pass).toBe(false);
    expect(result.message).toContain("delete_agent");
  });
});
