import { describe, it, expect, vi } from "vitest";
import { EvalRunner } from "../src/runner.js";
import type { Reporter } from "../src/reporters/types.js";
import { FakeDriver } from "../src/drivers/fake-driver.js";
import type { Driver } from "../src/drivers/types.js";
import type { EvalSample, EvalTask, ObservedResult } from "../src/types.js";

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
  it("sample with no expectations passes", async () => {
    const noExpectSample: EvalSample = {
      id: "noexp",
      description: "no expectations",
      input: { prompt: "anything" },
      expected: { toolSequence: "unordered" },
      timeoutMs: 120000,
    };
    const driver = FakeDriver.fromMap({
      "noexp": observed({ toolCalls: [], finalResponse: "anything goes" }),
    });
    const runner = new EvalRunner({ driver });
    const result = await runner.runTask(task([noExpectSample]));
    expect(result.cases[0].pass).toBe(true);
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
});
