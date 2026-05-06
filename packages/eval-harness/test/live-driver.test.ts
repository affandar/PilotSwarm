import { describe, it, expect, vi } from "vitest";
import { LiveDriver } from "../src/drivers/live-driver.js";
import type { Driver, DriverOptions } from "../src/drivers/types.js";
import type { EvalSample } from "../src/types.js";

describe("LiveDriver", () => {
  it("implements Driver interface", () => {
    const driver: Driver = new LiveDriver();
    expect(typeof driver.run).toBe("function");
  });

  it("constructor accepts options", () => {
    const options: DriverOptions = { model: "gpt-4", timeout: 30_000 };
    const driver = new LiveDriver(options);
    expect(driver).toBeInstanceOf(LiveDriver);
  });

  it("run method is async (returns a Promise)", () => {
    const driver = new LiveDriver();
    expect(typeof driver.run).toBe("function");
    expect(driver.run.constructor.name).toBe("AsyncFunction");
  });
});

describe("LiveDriver: validation", () => {
  function makeSample(overrides: Partial<EvalSample> = {}): EvalSample {
    return {
      id: "s1",
      description: "test",
      input: { prompt: "hi" },
      expected: { toolSequence: "unordered" },
      timeoutMs: 60_000,
      ...overrides,
    };
  }

  it("throws when sample has context messages", async () => {
    const driver = new LiveDriver();
    const sample = makeSample({
      input: {
        prompt: "follow up",
        context: [
          { role: "user", content: "hi" },
          { role: "assistant", content: "hello" },
        ],
      },
    });
    await expect(driver.run(sample)).rejects.toThrow(/context/i);
  });

  it("throws on unknown tool name", async () => {
    const driver = new LiveDriver();
    const sample = makeSample({ tools: ["test_add", "definitely_not_a_tool"] });
    await expect(driver.run(sample)).rejects.toThrow(/definitely_not_a_tool/);
  });
});

describe("LiveDriver: lifecycle / cleanup", () => {
  function makeSample(overrides: Partial<EvalSample> = {}): EvalSample {
    return {
      id: "leak-test",
      description: "leak",
      input: { prompt: "hi" },
      expected: { toolSequence: "unordered" },
      timeoutMs: 60_000,
      ...overrides,
    };
  }

  function fakeEnv() {
    return {
      cleanup: vi.fn().mockResolvedValue(undefined),
      store: "postgresql://fake/none",
      duroxideSchema: "d",
      cmsSchema: "c",
      factsSchema: "f",
      sessionStateDir: "/tmp/never-used",
    };
  }

  it("cleans up env when worker.start fails", async () => {
    const env = fakeEnv();
    class FailingWorker {
      registerTools() {}
      setSessionConfig() {}
      async start() {
        throw new Error("worker boom");
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
    const driver = new LiveDriver(undefined, {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      createEnv: () => env as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      WorkerCtor: FailingWorker as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ClientCtor: NoopClient as any,
    });
    await expect(driver.run(makeSample())).rejects.toThrow(/worker boom/);
    expect(env.cleanup).toHaveBeenCalled();
  });

  it("cleans up env + stops worker when client.start fails", async () => {
    const env = fakeEnv();
    const workerStop = vi.fn().mockResolvedValue(undefined);
    class OkWorker {
      registerTools() {}
      setSessionConfig() {}
      async start() {}
      stop = workerStop;
    }
    class FailingClient {
      async start() {
        throw new Error("client boom");
      }
      async stop() {}
      async createSession() {
        return { sessionId: "x", sendAndWait: async () => "", getInfo: async () => null };
      }
    }
    const driver = new LiveDriver(undefined, {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      createEnv: () => env as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      WorkerCtor: OkWorker as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ClientCtor: FailingClient as any,
    });
    await expect(driver.run(makeSample())).rejects.toThrow(/client boom/);
    expect(workerStop).toHaveBeenCalled();
    expect(env.cleanup).toHaveBeenCalled();
  });

  it("uses a unique workerNodeId per run", async () => {
    const env = fakeEnv();
    const workerConfigs: Array<Record<string, unknown>> = [];
    class CapturingWorker {
      constructor(cfg: Record<string, unknown>) {
        workerConfigs.push(cfg);
      }
      registerTools() {}
      setSessionConfig() {}
      async start() {
        throw new Error("stop early");
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
    const driver = new LiveDriver(undefined, {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      createEnv: () => env as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      WorkerCtor: CapturingWorker as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ClientCtor: NoopClient as any,
    });
    await expect(driver.run(makeSample({ id: "a" }))).rejects.toThrow();
    await expect(driver.run(makeSample({ id: "b" }))).rejects.toThrow();
    expect(workerConfigs).toHaveLength(2);
    expect(workerConfigs[0].workerNodeId).not.toBe(workerConfigs[1].workerNodeId);
    expect(String(workerConfigs[0].workerNodeId)).toMatch(/^eval-/);
  });

  // F20: even when worker.start() throws, the worker object has been
  // constructed and may have allocated resources. Cleanup must call
  // worker.stop() exactly once to avoid leaks.
  it("F20: calls worker.stop() exactly once when worker.start() throws after construction", async () => {
    const env = fakeEnv();
    const workerStop = vi.fn().mockResolvedValue(undefined);
    class FailingWorker {
      registerTools() {}
      setSessionConfig() {}
      async start() {
        throw new Error("worker boom after partial alloc");
      }
      stop = workerStop;
    }
    class NoopClient {
      async start() {}
      async stop() {}
      async createSession() {
        return { sessionId: "x", sendAndWait: async () => "", getInfo: async () => null };
      }
    }
    const driver = new LiveDriver(undefined, {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      createEnv: () => env as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      WorkerCtor: FailingWorker as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ClientCtor: NoopClient as any,
    });
    await expect(driver.run(makeSample())).rejects.toThrow(/worker boom/);
    expect(workerStop).toHaveBeenCalledTimes(1);
    expect(env.cleanup).toHaveBeenCalled();
  });

  it("F20: swallows errors from worker.stop() during cleanup so original start error surfaces", async () => {
    const env = fakeEnv();
    const workerStop = vi.fn().mockRejectedValue(new Error("stop also boom"));
    class FailingWorker {
      registerTools() {}
      setSessionConfig() {}
      async start() {
        throw new Error("primary start boom");
      }
      stop = workerStop;
    }
    class NoopClient {
      async start() {}
      async stop() {}
      async createSession() {
        return { sessionId: "x", sendAndWait: async () => "", getInfo: async () => null };
      }
    }
    const driver = new LiveDriver(undefined, {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      createEnv: () => env as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      WorkerCtor: FailingWorker as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ClientCtor: NoopClient as any,
    });
    await expect(driver.run(makeSample())).rejects.toThrow(/primary start boom/);
    expect(workerStop).toHaveBeenCalledTimes(1);
    expect(env.cleanup).toHaveBeenCalled();
  });

  it("F20: calls client.stop() exactly once when client.start() throws after construction", async () => {
    const env = fakeEnv();
    const workerStop = vi.fn().mockResolvedValue(undefined);
    const clientStop = vi.fn().mockResolvedValue(undefined);
    class OkWorker {
      registerTools() {}
      setSessionConfig() {}
      async start() {}
      stop = workerStop;
    }
    class FailingClient {
      async start() {
        throw new Error("client boom after partial alloc");
      }
      stop = clientStop;
      async createSession() {
        return { sessionId: "x", sendAndWait: async () => "", getInfo: async () => null };
      }
    }
    const driver = new LiveDriver(undefined, {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      createEnv: () => env as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      WorkerCtor: OkWorker as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ClientCtor: FailingClient as any,
    });
    await expect(driver.run(makeSample())).rejects.toThrow(/client boom/);
    expect(clientStop).toHaveBeenCalledTimes(1);
    expect(workerStop).toHaveBeenCalledTimes(1);
    expect(env.cleanup).toHaveBeenCalled();
  });

  it("F20: does NOT call worker.stop() when worker was never constructed (env factory throws)", async () => {
    const workerStop = vi.fn().mockResolvedValue(undefined);
    class CountingWorker {
      registerTools() {}
      setSessionConfig() {}
      async start() {}
      stop = workerStop;
    }
    class NoopClient {
      async start() {}
      async stop() {}
      async createSession() {
        return { sessionId: "x", sendAndWait: async () => "", getInfo: async () => null };
      }
    }
    const driver = new LiveDriver(undefined, {
      createEnv: () => {
        throw new Error("env factory boom");
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      WorkerCtor: CountingWorker as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ClientCtor: NoopClient as any,
    });
    await expect(driver.run(makeSample())).rejects.toThrow(/env factory boom/);
    expect(workerStop).not.toHaveBeenCalled();
  });
});
