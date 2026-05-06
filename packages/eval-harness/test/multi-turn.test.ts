import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import {
  TrajectoryTaskSchema,
  TrajectorySampleSchema,
  ObservedTurnSchema,
  ObservedTrajectorySchema,
  TrajectoryCaseResultSchema,
  type TrajectorySample,
  type TrajectoryTask,
  type ObservedTrajectory,
} from "../src/types.js";
import { FakeMultiTurnDriver } from "../src/drivers/fake-multi-turn-driver.js";
import { gradeTrajectory } from "../src/graders/trajectory.js";
import { TrajectoryRunner, type TrajectoryReporter } from "../src/trajectory-runner.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

function sample(overrides: Partial<TrajectorySample> = {}): TrajectorySample {
  return TrajectorySampleSchema.parse({
    id: "s1",
    description: "test",
    turns: [
      {
        input: { prompt: "add 1+2" },
        expected: {
          toolCalls: [{ name: "test_add", args: { a: 1, b: 2 }, match: "subset" }],
        },
      },
      {
        input: { prompt: "multiply 3*4" },
        expected: {
          toolCalls: [{ name: "test_multiply", args: { a: 3, b: 4 }, match: "subset" }],
        },
      },
    ],
    timeoutMs: 1000,
    ...overrides,
  });
}

function observed(overrides: Partial<ObservedTrajectory> = {}): ObservedTrajectory {
  return {
    turns: [
      {
        toolCalls: [{ name: "test_add", args: { a: 1, b: 2 }, order: 0 }],
        response: "3",
        latencyMs: 10,
      },
      {
        toolCalls: [{ name: "test_multiply", args: { a: 3, b: 4 }, order: 0 }],
        response: "12",
        latencyMs: 10,
      },
    ],
    sessionId: "sess-1",
    totalLatencyMs: 20,
    ...overrides,
  };
}

describe("TrajectoryTask types", () => {
  it("validates a well-formed trajectory task", () => {
    const task: TrajectoryTask = {
      schemaVersion: 1,
      id: "t",
      name: "t",
      description: "d",
      version: "1.0.0",
      samples: [sample()],
    };
    expect(() => TrajectoryTaskSchema.parse(task)).not.toThrow();
  });

  it("rejects empty turns", () => {
    expect(() =>
      TrajectorySampleSchema.parse({
        id: "s",
        description: "d",
        turns: [],
      }),
    ).toThrow();
  });

  it("accepts optional expected / tools / tags", () => {
    const s = TrajectorySampleSchema.parse({
      id: "s",
      description: "d",
      turns: [{ input: { prompt: "p" }, expected: { noToolCall: true } }],
    });
    expect(s.timeoutMs).toBe(120000);
    expect(s.expected).toBeUndefined();
  });

  it("rejects a trajectory turn with no expected criteria", () => {
    const result = TrajectorySampleSchema.safeParse({
      id: "s",
      description: "d",
      turns: [{ input: { prompt: "p" }, expected: {} }],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.message).toMatch(/no expected criteria/i);
    }
  });
});

describe("FakeMultiTurnDriver", () => {
  it("returns scripted trajectory for known sample", async () => {
    const traj = observed({ sessionId: "abc" });
    const driver = new FakeMultiTurnDriver([{ sampleId: "s1", trajectory: traj }]);
    const result = await driver.runTrajectory(sample());
    expect(result.sessionId).toBe("abc");
    expect(result.turns).toHaveLength(2);
  });

  it("throws for unknown sample", async () => {
    const driver = new FakeMultiTurnDriver([]);
    await expect(driver.runTrajectory(sample())).rejects.toThrow(/unknown/i);
  });

  it("respects abort signal", async () => {
    const driver = new FakeMultiTurnDriver([
      { sampleId: "s1", trajectory: observed() },
    ]);
    const ac = new AbortController();
    ac.abort();
    await expect(
      driver.runTrajectory(sample(), { signal: ac.signal }),
    ).rejects.toThrow(/aborted/i);
  });
});

describe("gradeTrajectory", () => {
  it("scores each turn independently and prefixes with turn index", () => {
    const score = gradeTrajectory(observed(), sample());
    expect(score.turnScores).toHaveLength(2);
    for (const ts of score.turnScores) {
      for (const s of ts) {
        expect(s.name.startsWith("t")).toBe(true);
        expect(s.name).toMatch(/^t\d+\//);
      }
    }
    expect(score.turnScores.every((ts) => ts.every((s) => s.pass))).toBe(true);
  });

  it("scores context retention across turns (found)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const s = sample({
      turns: [
        { input: { prompt: "context" }, expected: { noToolCall: true } },
        { input: { prompt: "reference" }, expected: { noToolCall: true } },
      ],
      expected: {
        contextRetention: [{ term: "Osaka", mustAppearAfterTurn: 0 }],
      },
    });
    const obs: ObservedTrajectory = {
      turns: [
        { toolCalls: [], response: "ok Osaka", latencyMs: 1 },
        { toolCalls: [], response: "still Osaka", latencyMs: 1 },
      ],
      sessionId: "x",
      totalLatencyMs: 2,
    };
    const score = gradeTrajectory(obs, s);
    expect(score.crossTurnScores).toHaveLength(1);
    expect(score.crossTurnScores[0].pass).toBe(true);
    expect(score.crossTurnScores[0].name).toBe("context-retention/Osaka");
    warn.mockRestore();
  });

  it("warns when context retention only matches lexical text", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const s = sample({
      turns: [
        { input: { prompt: "remember Osaka" }, expected: { noToolCall: true } },
        { input: { prompt: "use it" }, expected: { noToolCall: true } },
      ],
      expected: {
        contextRetention: [{ term: "Osaka", mustAppearAfterTurn: 0 }],
      },
    });
    const obs: ObservedTrajectory = {
      turns: [
        { toolCalls: [], response: "noted", latencyMs: 1 },
        { toolCalls: [], response: "Osaka is sunny", latencyMs: 1 },
      ],
      sessionId: "x",
      totalLatencyMs: 2,
    };

    const score = gradeTrajectory(obs, s);

    expect(score.crossTurnScores[0].pass).toBe(true);
    expect(score.crossTurnScores[0].reason).toMatch(/lexical regex/i);
    expect(warn).toHaveBeenCalledWith(
      'contextRetention matched only via lexical regex on "Osaka" — this can pass parroting agents. Configure requireToolArgUse for stronger validation, OR add a turn-end response check that requires the term in a meaningful semantic context.',
    );
    warn.mockRestore();
  });

  it("fails context retention when term missing", () => {
    const s = sample({
      turns: [
        { input: { prompt: "p1" }, expected: { noToolCall: true } },
        { input: { prompt: "p2" }, expected: { noToolCall: true } },
      ],
      expected: {
        contextRetention: [{ term: "Osaka", mustAppearAfterTurn: 0 }],
      },
    });
    const obs: ObservedTrajectory = {
      turns: [
        { toolCalls: [], response: "hello", latencyMs: 1 },
        { toolCalls: [], response: "world", latencyMs: 1 },
      ],
      sessionId: "x",
      totalLatencyMs: 2,
    };
    const score = gradeTrajectory(obs, s);
    expect(score.crossTurnScores[0].pass).toBe(false);
  });

  it("supports JSON-loadable context retention for tool-argument checks", () => {
    const s = sample({
      turns: [
        { input: { prompt: "remember blue" }, expected: { noToolCall: true } },
        { input: { prompt: "use it" }, expected: { toolCalls: [{ name: "paint", args: { color: "blue" } }] } },
      ],
      expected: {
        contextRetention: [
          {
            term: "blue",
            mustAppearAfterTurn: 0,
            requireToolArgUse: { toolName: "paint", argPath: "color" },
          },
        ],
      },
    });
    const obs: ObservedTrajectory = {
      turns: [
        { toolCalls: [], response: "blue", latencyMs: 1 },
        {
          toolCalls: [{ name: "paint", args: { color: "blue" }, order: 0 }],
          response: "done",
          latencyMs: 1,
        },
      ],
      sessionId: "x",
      totalLatencyMs: 2,
    };
    const score = gradeTrajectory(obs, s);
    expect(score.crossTurnScores[0].pass).toBe(true);
  });

  it("does not pass tool-argument context retention for response-only parroting", () => {
    const s = sample({
      turns: [
        { input: { prompt: "remember Osaka" }, expected: { noToolCall: true } },
        { input: { prompt: "use it" }, expected: { noToolCall: true } },
      ],
      expected: {
        contextRetention: [
          {
            term: "Osaka",
            mustAppearAfterTurn: 0,
            requireToolArgUse: { toolName: "test_weather", argPath: "city" },
          },
        ],
      },
    });
    const obs: ObservedTrajectory = {
      turns: [
        { toolCalls: [], response: "Osaka", latencyMs: 1 },
        { toolCalls: [], response: "Osaka Osaka Osaka", latencyMs: 1 },
      ],
      sessionId: "x",
      totalLatencyMs: 2,
    };

    const score = gradeTrajectory(obs, s);

    expect(score.crossTurnScores[0].pass).toBe(false);
  });

  it("scores goal completion", () => {
    const s = sample({ expected: { goalCompleted: true } });
    const score = gradeTrajectory(observed(), s);
    const goal = score.holisticScores.find((x) => x.name === "goal-completed");
    expect(goal).toBeDefined();
    expect(goal!.pass).toBe(true);
  });

  it("scores call budget within limit", () => {
    const s = sample({ expected: { maxTotalToolCalls: 5 } });
    const score = gradeTrajectory(observed(), s);
    const budget = score.holisticScores.find((x) => x.name === "call-budget");
    expect(budget).toBeDefined();
    expect(budget!.pass).toBe(true);
  });

  it("scores call budget exceeding limit", () => {
    const s = sample({ expected: { maxTotalToolCalls: 1 } });
    const score = gradeTrajectory(observed(), s);
    const budget = score.holisticScores.find((x) => x.name === "call-budget");
    expect(budget!.pass).toBe(false);
  });

  it("handles missing observed turns", () => {
    const obs: ObservedTrajectory = {
      turns: [
        { toolCalls: [{ name: "test_add", args: { a: 1, b: 2 }, order: 0 }], response: "3", latencyMs: 1 },
      ],
      sessionId: "x",
      totalLatencyMs: 1,
    };
    const score = gradeTrajectory(obs, sample());
    expect(score.turnScores).toHaveLength(2);
    expect(score.turnScores[1].some((s) => s.name === "t2/missing")).toBe(true);
    expect(score.turnScores[1].every((s) => !s.pass)).toBe(true);
  });

  it("handles more observed turns than expected (extras fail turn-count)", () => {
    const obs = observed({
      turns: [
        ...observed().turns,
        { toolCalls: [], response: "extra", latencyMs: 1 },
      ],
      totalLatencyMs: 21,
    });
    const score = gradeTrajectory(obs, sample());
    expect(score.turnScores).toHaveLength(2);
    const turnCountScore = score.holisticScores.find((s) => s.name === "turn-count");
    expect(turnCountScore).toBeDefined();
    expect(turnCountScore!.pass).toBe(false);
  });

  it("passes turn-count when observed matches expected turn count", () => {
    const observed: ObservedTrajectory = {
      turns: [
        { toolCalls: [{ name: "test_add", args: { a: 1, b: 2 }, order: 0 }], response: "3", latencyMs: 50 },
      ],
      sessionId: "s1",
      totalLatencyMs: 50,
    };
    const sample = {
      id: "exact-turns",
      description: "test",
      turns: [
        { input: { prompt: "add" }, expected: { toolCalls: [{ name: "test_add", args: { a: 1, b: 2 } }] } },
      ],
      timeoutMs: 5000,
    };
    const score = gradeTrajectory(observed, sample as any);
    const turnCountScore = score.holisticScores.find((s) => s.name === "turn-count");
    expect(turnCountScore).toBeDefined();
    expect(turnCountScore!.pass).toBe(true);
  });

  it("emits an infra error if a hollow turn bypasses schema validation", () => {
    const hollow = {
      id: "hollow",
      description: "test",
      turns: [{ input: { prompt: "p" }, expected: {} }],
      timeoutMs: 5000,
    } as any;
    const score = gradeTrajectory(
      {
        turns: [{ toolCalls: [], response: "ok", latencyMs: 1 }],
        sessionId: "x",
        totalLatencyMs: 1,
      },
      hollow,
    );
    const infra = score.turnScores[0].find((s) => s.infraError);
    expect(infra).toBeDefined();
    expect(infra!.pass).toBe(false);
    expect(infra!.value).toBe(0);
    expect(infra!.reason).toMatch(/no expected criteria/i);
  });
});

describe("TrajectoryRunner", () => {
  const task: TrajectoryTask = {
    schemaVersion: 1,
    id: "tt",
    name: "tt",
    description: "d",
    version: "1.0.0",
    samples: [sample()],
  };

  it("runs trajectory task and produces result", async () => {
    const driver = FakeMultiTurnDriver.fromMap({ s1: observed() });
    const runner = new TrajectoryRunner({ driver });
    const result = await runner.runTask(task);
    expect(result.schemaVersion).toBe(1);
    expect(result.cases).toHaveLength(1);
    expect(result.cases[0].pass).toBe(true);
    expect(result.summary.passRate).toBe(1);
  });

  it("handles infra errors", async () => {
    const driver = new FakeMultiTurnDriver([]);
    const runner = new TrajectoryRunner({ driver });
    const result = await runner.runTask(task);
    expect(result.cases[0].pass).toBe(false);
    expect(result.cases[0].infraError).toMatch(/unknown/i);
    expect(result.summary.errored).toBe(1);
  });

  it("classifies trajectory grader throws as infra errors, not quality failures", async () => {
    const badSample = sample();
    badSample.turns[0].expected.toolCalls = [
      { name: "test_add", args: { broken: {} }, match: "unsupported" as never },
    ];
    const badTask: TrajectoryTask = {
      ...task,
      samples: [badSample],
    };
    const driver = FakeMultiTurnDriver.fromMap({ s1: observed() });
    const runner = new TrajectoryRunner({ driver });

    const result = await runner.runTask(badTask);

    expect(result.summary.failed).toBe(0);
    expect(result.summary.errored).toBe(1);
    expect(result.cases[0].trajectoryScore).toEqual({
      turnScores: [],
      crossTurnScores: [],
      holisticScores: [],
    });
    expect(result.cases[0].infraError).toMatch(/^grader:/);
  });

  it("hoists trajectory score infra errors to case-level infra errors", async () => {
    const hollowSample = {
      ...sample(),
      turns: [{ input: { prompt: "p" }, expected: {} }],
    } as TrajectorySample;
    const hollowTask: TrajectoryTask = {
      ...task,
      samples: [hollowSample],
    };
    const driver = FakeMultiTurnDriver.fromMap({
      s1: {
        turns: [{ toolCalls: [], response: "ok", latencyMs: 1 }],
        sessionId: "x",
        totalLatencyMs: 1,
      },
    });
    const runner = new TrajectoryRunner({ driver });

    const result = await runner.runTask(hollowTask);

    expect(result.summary.passed).toBe(0);
    expect(result.summary.failed).toBe(0);
    expect(result.summary.errored).toBe(1);
    expect(result.summary.passRate).toBeUndefined();
    expect(result.summary.noQualitySignal).toBe(true);
    expect(result.cases[0].infraError).toMatch(/no expected criteria/i);
  });

  it("computes pass rate correctly with mixed results", async () => {
    const badObs: ObservedTrajectory = {
      turns: [
        { toolCalls: [{ name: "wrong", args: {}, order: 0 }], response: "no", latencyMs: 1 },
      ],
      sessionId: "x",
      totalLatencyMs: 1,
    };
    const driver = FakeMultiTurnDriver.fromMap({ s1: observed(), s2: badObs });
    const runner = new TrajectoryRunner({ driver });
    const mixedTask: TrajectoryTask = {
      ...task,
      samples: [sample(), sample({ id: "s2" })],
    };
    const result = await runner.runTask(mixedTask);
    expect(result.summary.total).toBe(2);
    expect(result.summary.passed).toBe(1);
    expect(result.summary.failed).toBe(1);
    expect(result.summary.passRate).toBe(0.5);
  });

  describe("F7 hollow turn rejection (noToolCall:true + empty observed turn)", () => {
    function noToolCallTrajectorySample(id = "ntc"): TrajectorySample {
      return TrajectorySampleSchema.parse({
        id,
        description: "noToolCall trajectory",
        turns: [
          {
            input: { prompt: "say hi, no tools" },
            expected: { noToolCall: true },
          },
        ],
        timeoutMs: 1000,
      });
    }

    it("hoists infraError when a noToolCall:true turn has empty response and no tool calls", async () => {
      const sampleNtc = noToolCallTrajectorySample();
      const driver = FakeMultiTurnDriver.fromMap({
        ntc: {
          turns: [{ toolCalls: [], response: "", latencyMs: 1 }],
          sessionId: "x",
          totalLatencyMs: 1,
        },
      });
      const runner = new TrajectoryRunner({ driver });
      const result = await runner.runTask({
        ...task,
        samples: [sampleNtc],
      });
      expect(result.summary.errored).toBe(1);
      expect(result.summary.passed).toBe(0);
      expect(result.summary.failed).toBe(0);
      expect(result.summary.passRate).toBeUndefined();
      expect(result.summary.noQualitySignal).toBe(true);
      expect(result.cases[0].pass).toBe(false);
      expect(result.cases[0].infraError).toMatch(/hollow/i);
      expect(result.cases[0].infraError).toMatch(/runner/i);
    });

    it("hoists infraError for whitespace/newline/zero-width-only responses in a noToolCall:true turn", async () => {
      for (const [id, response] of [
        ["ntc-ws", "   "],
        ["ntc-nl", "\n"],
        ["ntc-zw1", "\u200B"],
        ["ntc-zw2", "\u200C"],
        ["ntc-zw3", "\u200D"],
        ["ntc-zw4", "\uFEFF"],
      ] as const) {
        const sampleNtc = noToolCallTrajectorySample(id);
        const driver = FakeMultiTurnDriver.fromMap({
          [id]: {
            turns: [{ toolCalls: [], response, latencyMs: 1 }],
            sessionId: "x",
            totalLatencyMs: 1,
          },
        });
        const runner = new TrajectoryRunner({ driver });
        const result = await runner.runTask({ ...task, samples: [sampleNtc] });
        expect(result.summary.errored, `id=${id}`).toBe(1);
        expect(result.cases[0].infraError, `id=${id}`).toMatch(/hollow/i);
      }
    });

    it("hoists infraError when ANY turn in a multi-turn trajectory is hollow", async () => {
      const multiSample = TrajectorySampleSchema.parse({
        id: "ntc-multi",
        description: "two-turn with hollow second",
        turns: [
          {
            input: { prompt: "add 1+2" },
            expected: { toolCalls: [{ name: "test_add", args: { a: 1, b: 2 }, match: "subset" }] },
          },
          {
            input: { prompt: "now say hi, no tools" },
            expected: { noToolCall: true },
          },
        ],
        timeoutMs: 1000,
      });
      const driver = FakeMultiTurnDriver.fromMap({
        "ntc-multi": {
          turns: [
            { toolCalls: [{ name: "test_add", args: { a: 1, b: 2 }, order: 0 }], response: "3", latencyMs: 1 },
            { toolCalls: [], response: "", latencyMs: 1 },
          ],
          sessionId: "x",
          totalLatencyMs: 2,
        },
      });
      const runner = new TrajectoryRunner({ driver });
      const result = await runner.runTask({ ...task, samples: [multiSample] });
      expect(result.summary.errored).toBe(1);
      expect(result.cases[0].infraError).toMatch(/hollow/i);
    });

    it("happy path: noToolCall:true with non-empty response → quality pass (preserved)", async () => {
      const sampleNtc = noToolCallTrajectorySample("ntc-ok");
      const driver = FakeMultiTurnDriver.fromMap({
        "ntc-ok": {
          turns: [{ toolCalls: [], response: "Hello!", latencyMs: 1 }],
          sessionId: "x",
          totalLatencyMs: 1,
        },
      });
      const runner = new TrajectoryRunner({ driver });
      const result = await runner.runTask({ ...task, samples: [sampleNtc] });
      expect(result.summary.passed).toBe(1);
      expect(result.summary.errored).toBe(0);
      expect(result.cases[0].pass).toBe(true);
    });

    it("allowHollowResults:true escape hatch permits hollow noToolCall turns to be quality-graded", async () => {
      const sampleNtc = noToolCallTrajectorySample("ntc-allow");
      const driver = FakeMultiTurnDriver.fromMap({
        "ntc-allow": {
          turns: [{ toolCalls: [], response: "", latencyMs: 1 }],
          sessionId: "x",
          totalLatencyMs: 1,
        },
      });
      const runner = new TrajectoryRunner({ driver, allowHollowResults: true });
      const result = await runner.runTask({ ...task, samples: [sampleNtc] });
      expect(result.summary.errored).toBe(0);
      expect(result.summary.passed).toBe(1);
      expect(result.cases[0].pass).toBe(true);
    });

    // F18: zero-width / invisible chars are also covered above. JS String.prototype.trim()
    // does NOT strip U+200B-U+200D / U+FEFF — keep multi-turn coverage too.
    it("F18: hoists infraError when ANY trajectory turn is zero-width-only", async () => {
      const multiSample = TrajectorySampleSchema.parse({
        id: "ntc-multi-zw",
        description: "two-turn with zero-width second",
        turns: [
          {
            input: { prompt: "add 1+2" },
            expected: { toolCalls: [{ name: "test_add", args: { a: 1, b: 2 }, match: "subset" }] },
          },
          {
            input: { prompt: "now say hi, no tools" },
            expected: { noToolCall: true },
          },
        ],
        timeoutMs: 1000,
      });
      const driver = FakeMultiTurnDriver.fromMap({
        "ntc-multi-zw": {
          turns: [
            { toolCalls: [{ name: "test_add", args: { a: 1, b: 2 }, order: 0 }], response: "3", latencyMs: 1 },
            { toolCalls: [], response: "\u200B\uFEFF", latencyMs: 1 },
          ],
          sessionId: "x",
          totalLatencyMs: 2,
        },
      });
      const runner = new TrajectoryRunner({ driver });
      const result = await runner.runTask({ ...task, samples: [multiSample] });
      expect(result.summary.errored).toBe(1);
      expect(result.cases[0].infraError).toMatch(/hollow/i);
    });
  });

  it("forwards events to reporters", async () => {
    const events: string[] = [];
    const reporter: TrajectoryReporter = {
      onRunStart: () => void events.push("start"),
      onCaseResult: () => void events.push("case"),
      onRunComplete: () => void events.push("complete"),
    };
    const driver = FakeMultiTurnDriver.fromMap({ s1: observed() });
    const runner = new TrajectoryRunner({ driver, reporters: [reporter] });
    await runner.runTask(task);
    expect(events).toEqual(["start", "case", "complete"]);
  });
});

describe("v4 review fixes", () => {
  it("fails context retention when term appears only at boundary turn", () => {
    const observed: ObservedTrajectory = {
      turns: [
        { toolCalls: [], response: "Osaka is great", latencyMs: 50 },
        { toolCalls: [], response: "Sure thing", latencyMs: 50 },
      ],
      sessionId: "s1",
      totalLatencyMs: 100,
    };
    const sampleCase = {
      id: "cr-boundary",
      description: "test",
      turns: [
        { input: { prompt: "Tell me about Osaka" }, expected: { noToolCall: true } },
        { input: { prompt: "What did I ask about?" }, expected: { noToolCall: true } },
      ],
      expected: {
        contextRetention: [{ term: "Osaka", mustAppearAfterTurn: 0 }],
      },
      timeoutMs: 5000,
    };
    const score = gradeTrajectory(observed, sampleCase as any);
    const crScore = score.crossTurnScores.find((s) => s.name.includes("Osaka"));
    expect(crScore).toBeDefined();
    expect(crScore!.pass).toBe(false);
  });

  it("fails when goalCompleted is false but all turns pass", () => {
    const observed: ObservedTrajectory = {
      turns: [
        {
          toolCalls: [{ name: "test_add", args: { a: 1, b: 2 }, order: 0 }],
          response: "3",
          latencyMs: 50,
        },
      ],
      sessionId: "s1",
      totalLatencyMs: 50,
    };
    const sampleCase = {
      id: "goal-false",
      description: "test",
      turns: [
        {
          input: { prompt: "add" },
          expected: { toolCalls: [{ name: "test_add", args: { a: 1, b: 2 } }] },
        },
      ],
      expected: { goalCompleted: false },
      timeoutMs: 5000,
    };
    const score = gradeTrajectory(observed, sampleCase as any);
    const goalScore = score.holisticScores.find((s) => s.name === "goal-completed");
    expect(goalScore).toBeDefined();
    expect(goalScore!.pass).toBe(false);
  });

  it("rejects Infinity in ObservedTurn latencyMs", () => {
    const result = ObservedTurnSchema.safeParse({
      toolCalls: [],
      response: "ok",
      latencyMs: Infinity,
    });
    expect(result.success).toBe(false);
  });

  it("rejects Infinity in ObservedTrajectory totalLatencyMs", () => {
    const result = ObservedTrajectorySchema.safeParse({
      turns: [],
      sessionId: "s1",
      totalLatencyMs: Infinity,
    });
    expect(result.success).toBe(false);
  });

  it("rejects Infinity in TrajectoryCaseResult durationMs", () => {
    const result = TrajectoryCaseResultSchema.safeParse({
      caseId: "c1",
      pass: true,
      trajectoryScore: { turnScores: [], crossTurnScores: [], holisticScores: [] },
      observed: { turns: [], sessionId: "s1", totalLatencyMs: 0 },
      durationMs: Infinity,
    });
    expect(result.success).toBe(false);
  });
});

describe("multi-turn fixtures", () => {
  const path = resolve(__dirname, "../datasets/multi-turn-scenarios.v1.json");
  const raw = JSON.parse(readFileSync(path, "utf8"));

  it("loads multi-turn-scenarios.v1.json", () => {
    expect(() => TrajectoryTaskSchema.parse(raw)).not.toThrow();
  });

  it("all samples have valid trajectory schema", () => {
    const task = TrajectoryTaskSchema.parse(raw);
    expect(task.samples.length).toBeGreaterThanOrEqual(6);
    for (const s of task.samples) {
      expect(s.turns.length).toBeGreaterThanOrEqual(1);
      expect(s.id.startsWith("multi-turn.")).toBe(true);
    }
  });

  it("context-retention fixture uses JSON-loadable tool-argument retention", () => {
    const task = TrajectoryTaskSchema.parse(raw);
    const retention = task.samples.find((s) => s.id === "multi-turn.context-retention")!;
    expect(retention.expected?.contextRetention?.[0].requireToolArgUse).toEqual({
      toolName: "test_weather",
      argPath: "city",
    });
  });
});
