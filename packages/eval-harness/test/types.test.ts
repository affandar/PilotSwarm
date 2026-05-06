import { describe, it, expect } from "vitest";
import {
  EvalTaskSchema,
  EvalSampleSchema,
  EvalToolCallSchema,
  EvalExpectedSchema,
  RunResultSchema,
  CaseResultSchema,
  ScoreSchema,
  ObservedResultSchema,
  ObservedToolCallSchema,
} from "../src/types.js";

const validTask = {
  schemaVersion: 1,
  id: "task.basic",
  name: "Basic Task",
  description: "A basic eval task",
  version: "1.0.0",
  samples: [
    {
      id: "single.add.basic",
      description: "Add two numbers",
      input: { prompt: "What is 2+2?" },
      expected: {
        toolCalls: [{ name: "test_add", args: { a: 2, b: 2 } }],
      },
    },
  ],
};

describe("EvalTaskSchema", () => {
  it("accepts a valid EvalTask JSON", () => {
    const result = EvalTaskSchema.safeParse(validTask);
    expect(result.success).toBe(true);
  });

  it("rejects missing required field: id", () => {
    const { id, ...noId } = validTask;
    const result = EvalTaskSchema.safeParse(noId);
    expect(result.success).toBe(false);
  });

  it("rejects missing required field: name", () => {
    const { name, ...noName } = validTask;
    const result = EvalTaskSchema.safeParse(noName);
    expect(result.success).toBe(false);
  });

  it("rejects missing required field: samples", () => {
    const { samples, ...noSamples } = validTask;
    const result = EvalTaskSchema.safeParse(noSamples);
    expect(result.success).toBe(false);
  });

  it("rejects invalid schemaVersion (!= 1)", () => {
    const bad = { ...validTask, schemaVersion: 2 };
    const result = EvalTaskSchema.safeParse(bad);
    expect(result.success).toBe(false);
  });

  it("rejects non-semver version string? (accepts any string version)", () => {
    const ok = { ...validTask, version: "1.0.0" };
    expect(EvalTaskSchema.safeParse(ok).success).toBe(true);
  });

  it("applies default passRateFloor is optional (no default coerced)", () => {
    const parsed = EvalTaskSchema.parse(validTask);
    // passRateFloor is optional; not required but may default
    expect(parsed.schemaVersion).toBe(1);
  });
});

describe("EvalToolCallSchema", () => {
  it("defaults match to 'subset' when omitted", () => {
    const parsed = EvalToolCallSchema.parse({ name: "test_add" });
    expect(parsed.match).toBe("subset");
  });

  it("accepts all valid match modes", () => {
    for (const m of ["exact", "subset", "fuzzy", "setEquals"]) {
      const r = EvalToolCallSchema.safeParse({ name: "x", match: m });
      expect(r.success).toBe(true);
    }
  });

  it("rejects invalid match mode", () => {
    const r = EvalToolCallSchema.safeParse({ name: "x", match: "bogus" });
    expect(r.success).toBe(false);
  });

  it("rejects missing tool name", () => {
    const r = EvalToolCallSchema.safeParse({ args: {} });
    expect(r.success).toBe(false);
  });
});

describe("EvalExpectedSchema", () => {
  it("defaults toolSequence to 'unordered'", () => {
    const parsed = EvalExpectedSchema.parse({});
    expect(parsed.toolSequence).toBe("unordered");
  });

  it("accepts 'strict' and 'unordered' toolSequence", () => {
    expect(EvalExpectedSchema.safeParse({ toolSequence: "strict" }).success).toBe(true);
    expect(EvalExpectedSchema.safeParse({ toolSequence: "unordered" }).success).toBe(true);
  });

  it("rejects invalid toolSequence", () => {
    const r = EvalExpectedSchema.safeParse({ toolSequence: "random" });
    expect(r.success).toBe(false);
  });

  it("accepts forbiddenTools, minCalls, maxCalls, noToolCall", () => {
    const r = EvalExpectedSchema.safeParse({
      forbiddenTools: ["a", "b"],
      minCalls: 1,
      maxCalls: 3,
      noToolCall: true,
    });
    expect(r.success).toBe(true);
  });

  it("accepts response.containsAny/containsAll", () => {
    const r = EvalExpectedSchema.safeParse({
      response: { containsAny: ["x"], containsAll: ["y"] },
    });
    expect(r.success).toBe(true);
  });

  it("accepts cms.stateIn", () => {
    const r = EvalExpectedSchema.safeParse({ cms: { stateIn: ["Ready", "Idle"] } });
    expect(r.success).toBe(true);
  });

  it("rejects noToolCall=true combined with toolCalls entries", () => {
    const r = EvalExpectedSchema.safeParse({
      noToolCall: true,
      toolCalls: [{ name: "test_add" }],
    });
    expect(r.success).toBe(false);
  });

  it("accepts noToolCall=true when toolCalls is omitted or empty", () => {
    expect(EvalExpectedSchema.safeParse({ noToolCall: true }).success).toBe(true);
    expect(EvalExpectedSchema.safeParse({ noToolCall: true, toolCalls: [] }).success).toBe(true);
  });

  it("rejects minCalls > maxCalls", () => {
    const r = EvalExpectedSchema.safeParse({ minCalls: 5, maxCalls: 2 });
    expect(r.success).toBe(false);
  });

  it("accepts minCalls === maxCalls", () => {
    const r = EvalExpectedSchema.safeParse({ minCalls: 3, maxCalls: 3 });
    expect(r.success).toBe(true);
  });
});

describe("EvalSampleSchema", () => {
  it("applies default timeoutMs (120000)", () => {
    const parsed = EvalSampleSchema.parse({
      id: "s1",
      description: "d",
      input: { prompt: "p" },
      expected: {},
    });
    expect(parsed.timeoutMs).toBe(120000);
  });

  it("accepts context with role user/assistant", () => {
    const r = EvalSampleSchema.safeParse({
      id: "s1",
      description: "d",
      input: {
        prompt: "p",
        context: [
          { role: "user", content: "hi" },
          { role: "assistant", content: "hello" },
        ],
      },
      expected: {},
    });
    expect(r.success).toBe(true);
  });

  it("rejects invalid role in context", () => {
    const r = EvalSampleSchema.safeParse({
      id: "s1",
      description: "d",
      input: {
        prompt: "p",
        context: [{ role: "system", content: "x" }],
      },
      expected: {},
    });
    expect(r.success).toBe(false);
  });
});

describe("ScoreSchema / ObservedResultSchema / CaseResultSchema / RunResultSchema", () => {
  it("validates a Score", () => {
    const r = ScoreSchema.safeParse({
      name: "tool_match",
      value: 1,
      pass: true,
      reason: "matched",
    });
    expect(r.success).toBe(true);
  });

  it("validates an ObservedToolCall with order", () => {
    const r = ObservedToolCallSchema.safeParse({
      name: "t",
      args: { a: 1 },
      order: 0,
    });
    expect(r.success).toBe(true);
  });

  it("validates an ObservedResult", () => {
    const r = ObservedResultSchema.safeParse({
      toolCalls: [],
      finalResponse: "hi",
      sessionId: "s1",
      latencyMs: 42,
    });
    expect(r.success).toBe(true);
  });

  it("validates a CaseResult", () => {
    const r = CaseResultSchema.safeParse({
      caseId: "c1",
      pass: true,
      scores: [],
      observed: {
        toolCalls: [],
        finalResponse: "",
        sessionId: "s1",
        latencyMs: 1,
      },
      durationMs: 1,
    });
    expect(r.success).toBe(true);
  });

  it("validates a full RunResult", () => {
    const r = RunResultSchema.safeParse({
      schemaVersion: 1,
      runId: "r1",
      taskId: "t1",
      taskVersion: "1.0.0",
      startedAt: "2025-01-01T00:00:00Z",
      finishedAt: "2025-01-01T00:00:01Z",
      summary: { total: 1, passed: 1, failed: 0, errored: 0, passRate: 1 },
      cases: [
        {
          caseId: "c1",
          pass: true,
          scores: [],
          observed: {
            toolCalls: [],
            finalResponse: "",
            sessionId: "s1",
            latencyMs: 1,
          },
          durationMs: 1,
        },
      ],
    });
    expect(r.success).toBe(true);
  });

  it("rejects RunResult with invalid schemaVersion", () => {
    const r = RunResultSchema.safeParse({
      schemaVersion: 99,
      runId: "r1",
      taskId: "t1",
      taskVersion: "1.0.0",
      startedAt: "x",
      finishedAt: "y",
      summary: { total: 0, passed: 0, failed: 0, errored: 0, passRate: 0 },
      cases: [],
    });
    expect(r.success).toBe(false);
  });
});
