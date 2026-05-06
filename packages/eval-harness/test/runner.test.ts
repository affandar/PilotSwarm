import { describe, it, expect, vi } from "vitest";
import { EvalRunner } from "../src/runner.js";
import type { Reporter } from "../src/reporters/types.js";
import { FakeDriver } from "../src/drivers/fake-driver.js";
import type { Driver } from "../src/drivers/types.js";
import { EvalTaskSchema, type EvalSample, type EvalTask, type ObservedResult } from "../src/types.js";

function sample(id: string, toolName = "add"): EvalSample {
  return {
    id,
    description: `sample ${id}`,
    input: { prompt: `run ${id}` },
    expected: {
      toolCalls: [{ name: toolName, args: { a: 1, b: 2 }, match: "subset" }],
      toolSequence: "unordered",
    },
    timeoutMs: 120000,
  };
}

function task(samples: EvalSample[]): EvalTask {
  return {
    schemaVersion: 1,
    id: "task-x",
    name: "Task X",
    description: "a task",
    version: "1.0.0",
    samples,
  };
}

function observed(overrides: Partial<ObservedResult> = {}): ObservedResult {
  return {
    toolCalls: [{ name: "add", args: { a: 1, b: 2 }, order: 0 }],
    finalResponse: "done",
    sessionId: "sess-1",
    latencyMs: 10,
    ...overrides,
  };
}

describe("EvalRunner.runTask", () => {
  it("runs a single-case task and returns a RunResult", async () => {
    const driver = FakeDriver.fromMap({
      "s1": observed(),
    });
    const runner = new EvalRunner({ driver });
    const result = await runner.runTask(task([sample("s1")]));
    expect(result.schemaVersion).toBe(1);
    expect(result.cases).toHaveLength(1);
    expect(result.summary.total).toBe(1);
  });

  it("includes correct runId, taskId, and taskVersion", async () => {
    const driver = FakeDriver.fromMap({ "s1": observed() });
    const runner = new EvalRunner({ driver, runId: "run-abc" });
    const result = await runner.runTask(task([sample("s1")]));
    expect(result.runId).toBe("run-abc");
    expect(result.taskId).toBe("task-x");
    expect(result.taskVersion).toBe("1.0.0");
  });

  it("passing case has pass=true and all scores pass", async () => {
    const driver = FakeDriver.fromMap({ "s1": observed() });
    const runner = new EvalRunner({ driver });
    const result = await runner.runTask(task([sample("s1")]));
    expect(result.cases[0].pass).toBe(true);
    expect(result.cases[0].scores.length).toBeGreaterThan(0);
    expect(result.cases[0].scores.every((s) => s.pass)).toBe(true);
  });

  it("failing case has pass=false with failing scores present", async () => {
    const driver = FakeDriver.fromMap({
      "s1": observed({ toolCalls: [{ name: "wrong_tool", args: {}, order: 0 }] }),
    });
    const runner = new EvalRunner({ driver });
    const result = await runner.runTask(task([sample("s1")]));
    expect(result.cases[0].pass).toBe(false);
    expect(result.cases[0].scores.some((s) => !s.pass)).toBe(true);
  });

  it("multiple cases: summary totals correct (passed, failed, errored)", async () => {
    const throwingDriver: Driver = {
      async run(s) {
        if (s.id === "s3") throw new Error("boom");
        if (s.id === "s1") return observed();
        return observed({ toolCalls: [{ name: "wrong_tool", args: {}, order: 0 }] });
      },
    };
    const runner = new EvalRunner({ driver: throwingDriver });
    const result = await runner.runTask(task([sample("s1"), sample("s2"), sample("s3")]));
    expect(result.summary.total).toBe(3);
    expect(result.summary.passed).toBe(1);
    expect(result.summary.failed).toBe(1);
    expect(result.summary.errored).toBe(1);
  });

  it("calculates passRate correctly", async () => {
    const driver: Driver = {
      async run(s) {
        if (s.id === "s1") return observed();
        return observed({ toolCalls: [{ name: "wrong", args: {}, order: 0 }] });
      },
    };
    const runner = new EvalRunner({ driver });
    const result = await runner.runTask(task([sample("s1"), sample("s2")]));
    expect(result.summary.passRate).toBe(0.5);
  });

  it("excludes infra errors from passRate because they are not quality failures", async () => {
    const driver: Driver = {
      async run(s) {
        if (s.id === "s1") return observed();
        throw new Error("driver down");
      },
    };
    const runner = new EvalRunner({ driver });
    const result = await runner.runTask(task([sample("s1"), sample("s2")]));
    expect(result.summary.passed).toBe(1);
    expect(result.summary.errored).toBe(1);
    expect(result.summary.passRate).toBe(1);
  });

  it("captures infraError when driver throws", async () => {
    const driver: Driver = {
      async run() {
        throw new Error("driver exploded");
      },
    };
    const runner = new EvalRunner({ driver });
    const result = await runner.runTask(task([sample("s1")]));
    expect(result.cases[0].infraError).toContain("driver exploded");
  });

  it("infraError case: pass=false and scores empty", async () => {
    const driver: Driver = {
      async run() {
        throw new Error("fail");
      },
    };
    const runner = new EvalRunner({ driver });
    const result = await runner.runTask(task([sample("s1")]));
    expect(result.cases[0].pass).toBe(false);
    expect(result.cases[0].scores).toEqual([]);
  });

  it("calls reporters.onRunStart with task and runId", async () => {
    const reporter: Reporter = {
      onRunStart: vi.fn(),
      onCaseResult: vi.fn(),
      onRunComplete: vi.fn(),
    };
    const driver = FakeDriver.fromMap({ "s1": observed() });
    const runner = new EvalRunner({ driver, reporters: [reporter], runId: "r1" });
    const t = task([sample("s1")]);
    await runner.runTask(t);
    expect(reporter.onRunStart).toHaveBeenCalledWith(t, "r1");
  });

  it("calls reporters.onCaseResult for each case", async () => {
    const reporter: Reporter = {
      onRunStart: vi.fn(),
      onCaseResult: vi.fn(),
      onRunComplete: vi.fn(),
    };
    const driver = FakeDriver.fromMap({ "s1": observed(), "s2": observed() });
    const runner = new EvalRunner({ driver, reporters: [reporter] });
    await runner.runTask(task([sample("s1"), sample("s2")]));
    expect(reporter.onCaseResult).toHaveBeenCalledTimes(2);
  });

  it("calls reporters.onRunComplete with full RunResult", async () => {
    const reporter: Reporter = {
      onRunStart: vi.fn(),
      onCaseResult: vi.fn(),
      onRunComplete: vi.fn(),
    };
    const driver = FakeDriver.fromMap({ "s1": observed() });
    const runner = new EvalRunner({ driver, reporters: [reporter] });
    const result = await runner.runTask(task([sample("s1")]));
    expect(reporter.onRunComplete).toHaveBeenCalledWith(result);
  });
});

describe("EvalRunner.checkPassRateFloor", () => {
  it("returns true when passRate >= floor, false when below", async () => {
    const driver = FakeDriver.fromMap({ "s1": observed() });
    const runner = new EvalRunner({ driver });
    const result = await runner.runTask(task([sample("s1")]));
    // one passing case → passRate = 1.0
    expect(runner.checkPassRateFloor(result, 0.5)).toBe(true);
    expect(runner.checkPassRateFloor(result, 1.0)).toBe(true);
    // unreachable floor
    const badDriver = FakeDriver.fromMap({
      "s1": observed({ toolCalls: [{ name: "wrong", args: {}, order: 0 }] }),
    });
    const runner2 = new EvalRunner({ driver: badDriver });
    const result2 = await runner2.runTask(task([sample("s1")]));
    expect(runner2.checkPassRateFloor(result2, 0.5)).toBe(false);
  });
});

describe("EvalRunner: timeoutMs enforcement", () => {
  it("passes timeoutMs to driver via DriverOptions", async () => {
    const captured: Array<number | undefined> = [];
    const driver: Driver = {
      async run(_s, options) {
        captured.push(options?.timeout);
        return observed();
      },
    };
    const s: EvalSample = { ...sample("s1"), timeoutMs: 4242 };
    const runner = new EvalRunner({ driver });
    await runner.runTask(task([s]));
    expect(captured).toEqual([4242]);
  });

  it("marks case as infraError when driver exceeds timeout", async () => {
    const driver: Driver = {
      run() {
        return new Promise(() => {
          /* never resolves */
        });
      },
    };
    const s: EvalSample = { ...sample("s1"), timeoutMs: 50 };
    const runner = new EvalRunner({ driver });
    const result = await runner.runTask(task([s]));
    expect(result.cases[0].infraError).toBeDefined();
    expect(result.cases[0].infraError).toMatch(/timeout/i);
    expect(result.cases[0].pass).toBe(false);
  });
});

describe("EvalRunner: zero-expectation samples", () => {
  it("sample with no expectations cannot pass silently", () => {
    const noExpectSample: EvalSample = {
      id: "noexp",
      description: "no expectations",
      input: { prompt: "anything" },
      expected: { toolSequence: "unordered" },
      timeoutMs: 120000,
    };
    expect(() =>
      EvalTaskSchema.parse({
        schemaVersion: 1,
        id: "task-x",
        name: "Task X",
        description: "a task",
        version: "1.0.0",
        samples: [noExpectSample],
      }),
    ).toThrow(/no expected criteria/i);
  });

  it("programmatic hollow samples do not pass silently if they bypass loading", async () => {
    const noExpectSample: EvalSample = {
      id: "noexp",
      description: "no expectations",
      input: { prompt: "anything" },
      expected: { toolSequence: "unordered" },
      timeoutMs: 120000,
    };
    const driver = FakeDriver.fromMap({
      noexp: observed({ toolCalls: [], finalResponse: "anything goes" }),
    });
    const runner = new EvalRunner({ driver });

    const result = await runner.runTask(task([noExpectSample]));

    expect(result.cases[0].pass).toBe(false);
    expect(result.cases[0].scores).toEqual([]);
  });
});

describe("EvalRunner: AbortSignal on timeout", () => {
  it("aborts driver via signal when sample timeoutMs elapses", async () => {
    let receivedSignal: AbortSignal | undefined;
    const driver: Driver = {
      run(_sample, options) {
        receivedSignal = options?.signal;
        return new Promise((_resolve, reject) => {
          options?.signal?.addEventListener("abort", () => {
            reject(new Error("driver observed abort"));
          });
        });
      },
    };
    const s: EvalSample = { ...sample("s1"), timeoutMs: 30 };
    const runner = new EvalRunner({ driver });
    const result = await runner.runTask(task([s]));
    expect(receivedSignal).toBeDefined();
    expect(receivedSignal!.aborted).toBe(true);
    expect(result.cases[0].infraError).toBeDefined();
  });

  it("does NOT abort signal when driver finishes normally", async () => {
    let signalAfter: boolean | undefined;
    const driver: Driver = {
      async run(_sample, options) {
        const result = observed();
        signalAfter = options?.signal?.aborted;
        return result;
      },
    };
    const runner = new EvalRunner({ driver });
    await runner.runTask(task([sample("s1")]));
    expect(signalAfter).toBe(false);
  });
});

describe("EvalRunner: runId per runTask", () => {
  it("generates a fresh runId per runTask call when none is supplied", async () => {
    const driver = FakeDriver.fromMap({ "s1": observed() });
    const runner = new EvalRunner({ driver });
    const r1 = await runner.runTask(task([sample("s1")]));
    const r2 = await runner.runTask(task([sample("s1")]));
    expect(r1.runId).toBeTruthy();
    expect(r2.runId).toBeTruthy();
    expect(r1.runId).not.toBe(r2.runId);
  });

  it("reuses a constructor-supplied runId across runTask calls", async () => {
    const driver = FakeDriver.fromMap({ "s1": observed() });
    const runner = new EvalRunner({ driver, runId: "fixed-id" });
    const r1 = await runner.runTask(task([sample("s1")]));
    const r2 = await runner.runTask(task([sample("s1")]));
    expect(r1.runId).toBe("fixed-id");
    expect(r2.runId).toBe("fixed-id");
  });

  it("sanitizes a constructor-supplied runId so it is path-safe", async () => {
    const driver = FakeDriver.fromMap({ "s1": observed() });
    const runner = new EvalRunner({ driver, runId: "../../evil/run id" });
    const result = await runner.runTask(task([sample("s1")]));
    expect(result.runId).not.toContain("/");
    expect(result.runId).not.toContain("..");
    expect(result.runId).not.toContain(" ");
  });
});

function noToolCallSample(id: string): EvalSample {
  return {
    id,
    description: `noToolCall sample ${id}`,
    input: { prompt: "say hello, do not call any tools" },
    expected: { noToolCall: true, toolSequence: "unordered" },
    timeoutMs: 120000,
  };
}

describe("EvalRunner: F7 hollow turn rejection (noToolCall:true + empty observed)", () => {
  it("rejects hollow observed (toolCalls:[] + finalResponse:'') as infra when noToolCall:true is expected", async () => {
    const driver = FakeDriver.fromMap({
      h1: observed({ toolCalls: [], finalResponse: "" }),
    });
    const runner = new EvalRunner({ driver });
    const result = await runner.runTask(task([noToolCallSample("h1")]));

    expect(result.summary.errored).toBe(1);
    expect(result.summary.passed).toBe(0);
    expect(result.summary.failed).toBe(0);
    expect(result.summary.passRate).toBeUndefined();
    expect(result.summary.noQualitySignal).toBe(true);
    expect(result.cases[0].pass).toBe(false);
    expect(result.cases[0].scores).toEqual([]);
    expect(result.cases[0].infraError).toMatch(/hollow/i);
    expect(result.cases[0].infraError).toMatch(/runner/i);
  });

  it("rejects whitespace/newline/zero-width-only finalResponse as hollow when noToolCall:true is expected", async () => {
    // Covers F7 (whitespace, newline) and F18 (zero-width / invisible chars).
    // JS String.prototype.trim() does NOT strip U+200B-U+200D and U+FEFF, so
    // a buggy/evasive driver could return one of those and bypass the F7 guard.
    for (const [id, finalResponse] of [
      ["h2", "   "],
      ["h3", "\n"],
      ["zw1", "\u200B"],
      ["zw2", "\u200C"],
      ["zw3", "\u200D"],
      ["zw4", "\uFEFF"],
      ["zw5", "  \u200B \u200D \uFEFF\n"],
    ] as const) {
      const driver = FakeDriver.fromMap({ [id]: observed({ toolCalls: [], finalResponse }) });
      const runner = new EvalRunner({ driver });
      const result = await runner.runTask(task([noToolCallSample(id)]));
      expect(result.summary.errored, `id=${id}`).toBe(1);
      expect(result.cases[0].infraError, `id=${id}`).toMatch(/hollow/i);
    }
  });

  it("happy path: noToolCall:true + non-empty response → quality pass (behavior preserved)", async () => {
    const driver = FakeDriver.fromMap({
      h4: observed({ toolCalls: [], finalResponse: "Hello!" }),
    });
    const runner = new EvalRunner({ driver });
    const result = await runner.runTask(task([noToolCallSample("h4")]));
    expect(result.summary.passed).toBe(1);
    expect(result.summary.errored).toBe(0);
    expect(result.cases[0].pass).toBe(true);
    expect(result.cases[0].infraError).toBeUndefined();
  });

  it("preserves no-criteria + empty observed → quality fail (not infra) for programmatic bypass", async () => {
    const noExpectSample: EvalSample = {
      id: "noexp",
      description: "no expectations",
      input: { prompt: "anything" },
      expected: { toolSequence: "unordered" },
      timeoutMs: 120000,
    };
    const driver = FakeDriver.fromMap({
      noexp: observed({ toolCalls: [], finalResponse: "" }),
    });
    const runner = new EvalRunner({ driver });
    const result = await runner.runTask(task([noExpectSample]));
    expect(result.cases[0].pass).toBe(false);
    expect(result.cases[0].infraError).toBeUndefined();
    expect(result.cases[0].scores).toEqual([]);
  });

  it("preserves response.containsAll + whitespace observed → quality fail (not infra)", async () => {
    const respSample: EvalSample = {
      id: "rs",
      description: "response containsAll",
      input: { prompt: "say foo" },
      expected: {
        response: { containsAll: ["foo"] },
        toolSequence: "unordered",
      },
      timeoutMs: 120000,
    };
    const driver = FakeDriver.fromMap({
      rs: observed({ toolCalls: [], finalResponse: "   " }),
    });
    const runner = new EvalRunner({ driver });
    const result = await runner.runTask(task([respSample]));
    expect(result.cases[0].infraError).toBeUndefined();
    expect(result.cases[0].pass).toBe(false);
    expect(result.summary.failed).toBe(1);
    expect(result.summary.errored).toBe(0);
  });

  it("allowHollowResults:true escape hatch lets hollow noToolCall pass quality grading", async () => {
    const driver = FakeDriver.fromMap({
      hh: observed({ toolCalls: [], finalResponse: "" }),
    });
    const runner = new EvalRunner({ driver, allowHollowResults: true });
    const result = await runner.runTask(task([noToolCallSample("hh")]));
    expect(result.summary.errored).toBe(0);
    expect(result.summary.passed).toBe(1);
    expect(result.cases[0].pass).toBe(true);
  });

  // F18: real text mixed with zero-width chars is NOT hollow.
  it("F18: response containing real text mixed with zero-width chars is NOT hollow", async () => {
    const driver = FakeDriver.fromMap({
      zw6: observed({ toolCalls: [], finalResponse: "\u200BHello\u200B" }),
    });
    const runner = new EvalRunner({ driver });
    const result = await runner.runTask(task([noToolCallSample("zw6")]));
    expect(result.summary.errored).toBe(0);
    expect(result.summary.passed).toBe(1);
    expect(result.cases[0].pass).toBe(true);
    expect(result.cases[0].infraError).toBeUndefined();
  });
});

describe("EvalRunner: grader and reporter resilience", () => {
  it("does not abort run when a reporter throws — logs and continues", async () => {
    const flakyReporter: Reporter = {
      onRunStart: vi.fn(() => {
        throw new Error("reporter onRunStart boom");
      }),
      onCaseResult: vi.fn(() => {
        throw new Error("reporter onCaseResult boom");
      }),
      onRunComplete: vi.fn(() => {
        throw new Error("reporter onRunComplete boom");
      }),
    };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const driver = FakeDriver.fromMap({ "s1": observed() });
    const runner = new EvalRunner({ driver, reporters: [flakyReporter] });
    const result = await runner.runTask(task([sample("s1")]));
    expect(result.cases).toHaveLength(1);
    expect(result.cases[0].pass).toBe(true);
    warn.mockRestore();
  });

  it("captures error stack in infraError when driver throws", async () => {
    const driver: Driver = {
      async run() {
        throw new Error("driver kaboom");
      },
    };
    const runner = new EvalRunner({ driver });
    const result = await runner.runTask(task([sample("s1")]));
    expect(result.cases[0].infraError).toContain("driver kaboom");
    expect(result.cases[0].infraError).toMatch(/at /);
  });

  it("classifies grader throws as grader infra errors, not quality failures", async () => {
    const driver = FakeDriver.fromMap({
      "s1": observed({ toolCalls: [{ name: "add", args: { broken: {} }, order: 0 }] }),
    });
    const badSample = sample("s1");
    badSample.expected.toolCalls = [
      {
        name: "add",
        args: { broken: {} },
        match: "unsupported" as never,
      },
    ];
    const runner = new EvalRunner({ driver });
    const result = await runner.runTask(task([badSample]));
    expect(result.summary.failed).toBe(0);
    expect(result.summary.errored).toBe(1);
    expect(result.cases[0].scores).toEqual([]);
    expect(result.cases[0].infraError).toMatch(/^grader:/);
  });

  it("awaits async reporter methods", async () => {
    const order: string[] = [];
    const asyncReporter: Reporter = {
      async onRunStart() {
        await new Promise((r) => setTimeout(r, 5));
        order.push("start");
      },
      async onCaseResult() {
        await new Promise((r) => setTimeout(r, 5));
        order.push("case");
      },
      async onRunComplete() {
        await new Promise((r) => setTimeout(r, 5));
        order.push("complete");
      },
    };
    const driver = FakeDriver.fromMap({ "s1": observed() });
    const runner = new EvalRunner({ driver, reporters: [asyncReporter] });
    await runner.runTask(task([sample("s1")]));
    expect(order).toEqual(["start", "case", "complete"]);
  });

  describe("failOnReporterError (iter18 WS-I)", () => {
    it("default: swallows reporter errors and warns", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const throwingReporter: Reporter = {
          onRunStart() {
            throw new Error("reporter onRunStart boom");
          },
          onCaseResult() {},
          onRunComplete() {},
        };
        const driver = FakeDriver.fromMap({ "s1": observed() });
        const runner = new EvalRunner({ driver, reporters: [throwingReporter] });
        const result = await runner.runTask(task([sample("s1")]));
        expect(result.summary.passed).toBe(1);
        expect(warnSpy).toHaveBeenCalled();
      } finally {
        warnSpy.mockRestore();
      }
    });

    it("failOnReporterError:true rethrows reporter errors", async () => {
      const throwingReporter: Reporter = {
        onRunStart() {
          throw new Error("reporter onRunStart boom");
        },
        onCaseResult() {},
        onRunComplete() {},
      };
      const driver = FakeDriver.fromMap({ "s1": observed() });
      const runner = new EvalRunner({
        driver,
        reporters: [throwingReporter],
        failOnReporterError: true,
      });
      await expect(runner.runTask(task([sample("s1")]))).rejects.toThrow(
        /reporter onRunStart boom/,
      );
    });
  });
});


// G8: EVAL_REPORTS_DIR / reportsDir auto-wiring of JsonlReporter
describe("EvalRunner: reports auto-wiring (G8)", () => {
  function buildPassingTask(): EvalTask {
    return EvalTaskSchema.parse({
      schemaVersion: 1,
      id: "g8-task",
      name: "G8 Test Task",
      description: "G8 reports auto-wiring test task",
      version: "1.0.0",
      samples: [
        {
          id: "s1",
          description: "minimal passing sample",
          input: { prompt: "hi" },
          expected: { noToolCall: true },
          timeoutMs: 120000,
        },
      ],
    });
  }

  function passingDriver(): Driver {
    return {
      async run(_sample: EvalSample): Promise<ObservedResult> {
        return {
          sessionId: "sid",
          toolCalls: [],
          finalResponse: "ok response",
          cmsState: "idle",
          latencyMs: 10,
        };
      },
    } as unknown as Driver;
  }

  it("appends a JsonlReporter when reportsDir is provided", async () => {
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "eval-reports-g8-"));
    try {
      const runner = new EvalRunner({
        driver: passingDriver(),
        runId: "g8-explicit",
        reportsDir: dir,
      });
      await runner.runTask(buildPassingTask());
      const file = path.join(dir, "g8-explicit.jsonl");
      expect(fs.existsSync(file)).toBe(true);
      const lines = fs.readFileSync(file, "utf8").trim().split("\n");
      expect(lines.length).toBeGreaterThanOrEqual(2);
      const header = JSON.parse(lines[0]!);
      expect(header.type).toBe("run");
      expect(header.runId).toBe("g8-explicit");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("appends a JsonlReporter when EVAL_REPORTS_DIR env var is set", async () => {
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "eval-reports-g8-env-"));
    const prev = process.env.EVAL_REPORTS_DIR;
    process.env.EVAL_REPORTS_DIR = dir;
    try {
      const runner = new EvalRunner({
        driver: passingDriver(),
        runId: "g8-env",
      });
      await runner.runTask(buildPassingTask());
      const file = path.join(dir, "g8-env.jsonl");
      expect(fs.existsSync(file)).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.EVAL_REPORTS_DIR;
      else process.env.EVAL_REPORTS_DIR = prev;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("explicit reportsDir option wins over EVAL_REPORTS_DIR env var", async () => {
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const envDir = fs.mkdtempSync(path.join(os.tmpdir(), "eval-reports-g8-env2-"));
    const optDir = fs.mkdtempSync(path.join(os.tmpdir(), "eval-reports-g8-opt-"));
    const prev = process.env.EVAL_REPORTS_DIR;
    process.env.EVAL_REPORTS_DIR = envDir;
    try {
      const runner = new EvalRunner({
        driver: passingDriver(),
        runId: "g8-opt-wins",
        reportsDir: optDir,
      });
      await runner.runTask(buildPassingTask());
      // Option wins → file in optDir, NOT envDir.
      expect(fs.existsSync(path.join(optDir, "g8-opt-wins.jsonl"))).toBe(true);
      expect(fs.existsSync(path.join(envDir, "g8-opt-wins.jsonl"))).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.EVAL_REPORTS_DIR;
      else process.env.EVAL_REPORTS_DIR = prev;
      fs.rmSync(envDir, { recursive: true, force: true });
      fs.rmSync(optDir, { recursive: true, force: true });
    }
  });

  it("does NOT auto-add a JsonlReporter when caller already supplied one", async () => {
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const callerDir = fs.mkdtempSync(path.join(os.tmpdir(), "eval-reports-g8-caller-"));
    const autoDir = fs.mkdtempSync(path.join(os.tmpdir(), "eval-reports-g8-auto-"));
    const { JsonlReporter } = await import("../src/reporters/jsonl.js");
    try {
      const runner = new EvalRunner({
        driver: passingDriver(),
        runId: "g8-caller",
        reporters: [new JsonlReporter(callerDir)],
        reportsDir: autoDir, // would normally add another, but should be skipped
      });
      await runner.runTask(buildPassingTask());
      expect(fs.existsSync(path.join(callerDir, "g8-caller.jsonl"))).toBe(true);
      expect(fs.existsSync(path.join(autoDir, "g8-caller.jsonl"))).toBe(false);
    } finally {
      fs.rmSync(callerDir, { recursive: true, force: true });
      fs.rmSync(autoDir, { recursive: true, force: true });
    }
  });

  it("no auto-wiring when neither reportsDir nor EVAL_REPORTS_DIR is set", async () => {
    const prev = process.env.EVAL_REPORTS_DIR;
    delete process.env.EVAL_REPORTS_DIR;
    try {
      const runner = new EvalRunner({
        driver: passingDriver(),
        runId: "g8-none",
      });
      const result = await runner.runTask(buildPassingTask());
      expect(result.runId).toBe("g8-none");
      // No directory was created — the ((runner as any).reporters) is empty.
      expect(((runner as unknown as { reporters: unknown[] }).reporters).length).toBe(0);
    } finally {
      if (prev !== undefined) process.env.EVAL_REPORTS_DIR = prev;
    }
  });
});
