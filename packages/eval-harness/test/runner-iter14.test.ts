import { describe, it, expect, vi } from "vitest";
import { isVisuallyEmpty, EvalRunner } from "../src/runner.js";
import { TrajectoryRunner } from "../src/trajectory-runner.js";
import { LiveDriver } from "../src/drivers/live-driver.js";
import type { Driver } from "../src/drivers/types.js";
import type {
  EvalSample,
  EvalTask,
  ObservedResult,
  TrajectoryTask,
  TrajectorySample,
  ObservedTrajectory,
} from "../src/types.js";
import type { MultiTurnDriver } from "../src/drivers/multi-turn-types.js";

describe("F7: isVisuallyEmpty Unicode-aware", () => {
  it("treats representative invisibles (ZWSP, RLO, BOM, mixed) as visually empty and real chars/whitespace correctly", () => {
    expect(isVisuallyEmpty("\u200B")).toBe(true);
    expect(isVisuallyEmpty("\u202E")).toBe(true);
    expect(isVisuallyEmpty("\uFEFF")).toBe(true);
    expect(isVisuallyEmpty(" \t\n\u200B\u2060\uFEFF\u202E ")).toBe(true);
    expect(isVisuallyEmpty(undefined)).toBe(true);
    expect(isVisuallyEmpty(null)).toBe(true);
    expect(isVisuallyEmpty("")).toBe(true);
    expect(isVisuallyEmpty("   ")).toBe(true);

    expect(isVisuallyEmpty("a")).toBe(false);
    expect(isVisuallyEmpty("\u200B\u2060a\uFEFF")).toBe(false);
  });
});

describe("F7: hollow-turn guard catches invisible-character responses", () => {
  function silentDriver(finalResponse: string): Driver {
    return {
      async run(): Promise<ObservedResult> {
        return { toolCalls: [], finalResponse, sessionId: "s", latencyMs: 0 };
      },
    };
  }
  const sample: EvalSample = {
    id: "hollow-invis",
    description: "noToolCall expectation with invisible response",
    input: { prompt: "say nothing" },
    expected: { toolSequence: "unordered", noToolCall: true },
    timeoutMs: 60_000,
  };
  const task: EvalTask = { id: "t", version: 1, samples: [sample] };

  it("hoists invisible-only single-turn response to infraError (representative ZWNJ)", async () => {
    const runner = new EvalRunner({ driver: silentDriver("\u2060") });
    const result = await runner.runTask(task);
    expect(result.cases[0].infraError).toMatch(/hollow/);
    expect(result.cases[0].pass).toBe(false);
  });
});

describe("F7: trajectory hollow-turn guard catches invisible-character responses", () => {
  const sample: TrajectorySample = {
    id: "hollow-traj",
    description: "noToolCall trajectory with invisible response",
    turns: [{ input: { prompt: "say nothing" }, expected: { toolSequence: "unordered", noToolCall: true } }],
    timeoutMs: 60_000,
  };
  const task: TrajectoryTask = { id: "t", version: 1, samples: [sample] };

  it("hoists invisible-only trajectory turn response to infraError (representative ZWSP)", async () => {
    const driver: MultiTurnDriver = {
      async runTrajectory(): Promise<ObservedTrajectory> {
        return {
          turns: [{ toolCalls: [], response: "\u200B", latencyMs: 0 }],
          sessionId: "s",
          totalLatencyMs: 0,
        };
      },
    };
    const runner = new TrajectoryRunner({ driver });
    const result = await runner.runTask(task);
    expect(result.cases[0].infraError).toMatch(/hollow/);
  });
});

describe("F25: live-driver cleanup error masking", () => {
  function makeSample(): EvalSample {
    return {
      id: "f25",
      description: "f25",
      input: { prompt: "hi" },
      expected: { toolSequence: "unordered" },
      timeoutMs: 60_000,
    };
  }
  function fakeEnv(cleanup: () => Promise<void>) {
    return {
      cleanup: vi.fn(cleanup),
      store: "postgresql://fake/none",
      duroxideSchema: "d",
      cmsSchema: "c",
      factsSchema: "f",
      sessionStateDir: "/tmp/never-used",
    };
  }

  it("primary error masks cleanup error: rethrows PRIMARY, logs cleanup", async () => {
    const env = fakeEnv(async () => {
      throw new Error("cleanup boom");
    });
    class FailingWorker {
      registerTools() {}
      setSessionConfig() {}
      async start() {
        throw new Error("primary boom");
      }
      async stop() {}
    }
    class NoopClient {
      async start() {}
      async stop() {}
      async createSession() {
        return { sessionId: "x", sendAndWait: async () => "", getInfo: async () => null };
      }
    }
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const consoleErrSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    // G16: cleanup-after-primary-error warning text is gated on
    // EVAL_VERBOSE_TEARDOWN=1 so demo/perf runs stay quiet by default.
    // This test asserts the warning IS emitted under verbose mode (the
    // promote-to-primary semantics is already covered by the "primary
    // path succeeds" test below). Under default (not-set), the warning
    // is suppressed but primaryError is still rethrown — verified
    // separately by the "default" coverage in the dedicated G16 test
    // (see runner-iter14.test.ts: G16 default-quiet test).
    const prevEnv = process.env.EVAL_VERBOSE_TEARDOWN;
    process.env.EVAL_VERBOSE_TEARDOWN = "1";
    try {
      const driver = new LiveDriver(undefined, {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        createEnv: () => env as any,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        WorkerCtor: FailingWorker as any,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ClientCtor: NoopClient as any,
      });
      await expect(driver.run(makeSample())).rejects.toThrow(/primary boom/);
      expect(env.cleanup).toHaveBeenCalled();
      const allLogs =
        stderrSpy.mock.calls.map((c) => String(c[0])).join("") +
        "\n" +
        consoleErrSpy.mock.calls.map((c) => c.map(String).join(" ")).join("\n");
      expect(allLogs).toMatch(/cleanup boom/);
    } finally {
      if (prevEnv === undefined) delete process.env.EVAL_VERBOSE_TEARDOWN;
      else process.env.EVAL_VERBOSE_TEARDOWN = prevEnv;
      stderrSpy.mockRestore();
      consoleErrSpy.mockRestore();
    }
  });

  it("G16: default-quiet — primary error masks cleanup error WITHOUT emitting warning text", async () => {
    const env = fakeEnv(async () => {
      throw new Error("cleanup boom default");
    });
    class FailingWorker {
      registerTools() {}
      setSessionConfig() {}
      async start() {
        throw new Error("primary boom default");
      }
      async stop() {}
    }
    class NoopClient {
      async start() {}
      async stop() {}
      async createSession() {
        return { sessionId: "x", sendAndWait: async () => "", getInfo: async () => null };
      }
    }
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const consoleErrSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const prevEnv = process.env.EVAL_VERBOSE_TEARDOWN;
    delete process.env.EVAL_VERBOSE_TEARDOWN;
    try {
      const driver = new LiveDriver(undefined, {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        createEnv: () => env as any,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        WorkerCtor: FailingWorker as any,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ClientCtor: NoopClient as any,
      });
      await expect(driver.run(makeSample())).rejects.toThrow(/primary boom default/);
      expect(env.cleanup).toHaveBeenCalled();
      const allLogs =
        stderrSpy.mock.calls.map((c) => String(c[0])).join("") +
        "\n" +
        consoleErrSpy.mock.calls.map((c) => c.map(String).join(" ")).join("\n");
      expect(allLogs).not.toMatch(/cleanup boom default/);
      expect(allLogs).not.toMatch(/env\.cleanup\(\) failed during cleanup error path/);
    } finally {
      if (prevEnv !== undefined) process.env.EVAL_VERBOSE_TEARDOWN = prevEnv;
      stderrSpy.mockRestore();
      consoleErrSpy.mockRestore();
    }
  });

  it("primary path succeeds, cleanup throws: driver run surfaces cleanup error", async () => {
    const env = fakeEnv(async () => {
      throw new Error("cleanup-only boom");
    });
    class OkWorker {
      registerTools() {}
      setSessionConfig() {}
      async start() {}
      async stop() {}
    }
    class OkClient {
      async start() {}
      async stop() {}
      async createSession() {
        return {
          sessionId: "ok",
          sendAndWait: async () => "fine",
          getInfo: async () => ({ state: "complete" }),
        };
      }
    }
    const driver = new LiveDriver(undefined, {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      createEnv: () => env as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      WorkerCtor: OkWorker as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ClientCtor: OkClient as any,
    });
    await expect(driver.run(makeSample())).rejects.toThrow(/cleanup-only boom/);
    expect(env.cleanup).toHaveBeenCalled();
  });
});
