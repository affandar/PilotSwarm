import { describe, it, expect, vi } from "vitest";
import { LiveDriver } from "../src/drivers/live-driver.js";
import type { EvalSample } from "../src/types.js";

describe("F28: LiveDriver surfaces worker.stop() failures on success path", () => {
  function makeSample(): EvalSample {
    return {
      id: "f28",
      description: "f28",
      input: { prompt: "hi" },
      expected: { toolSequence: "unordered" },
      timeoutMs: 60_000,
    };
  }

  function fakeEnv() {
    return {
      cleanup: vi.fn().mockResolvedValue(undefined),
      store: "postgresql://fake/none",
      duroxideSchema: "d",
      cmsSchema: "c",
      factsSchema: "f",
      sessionStateDir: "/never-used",
    };
  }

  function okClient() {
    return class OkClient {
      async start() {}
      async stop() {}
      async createSession() {
        return {
          sessionId: "sid-f28",
          sendAndWait: async () => "ok response",
          getInfo: async () => ({ state: "active" }),
        };
      }
    };
  }

  it("primary success + worker.stop() throws → driver throws stop's error", async () => {
    const env = fakeEnv();
    const workerStop = vi.fn().mockRejectedValue(new Error("worker stop boom"));
    class OkWorker {
      registerTools() {}
      setSessionConfig() {}
      async start() {}
      stop = workerStop;
    }
    const driver = new LiveDriver(undefined, {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      createEnv: () => env as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      WorkerCtor: OkWorker as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ClientCtor: okClient() as any,
    });
    await expect(driver.run(makeSample())).rejects.toThrow(/worker stop boom/);
    expect(workerStop).toHaveBeenCalledTimes(1);
    expect(env.cleanup).toHaveBeenCalled();
  });

  it("primary throws + worker.stop() also throws → driver throws primary error (stop logged)", async () => {
    const env = fakeEnv();
    const workerStop = vi.fn().mockRejectedValue(new Error("worker stop secondary"));
    class FailingWorker {
      registerTools() {}
      setSessionConfig() {}
      async start() {
        throw new Error("primary worker boom");
      }
      stop = workerStop;
    }
    const driver = new LiveDriver(undefined, {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      createEnv: () => env as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      WorkerCtor: FailingWorker as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ClientCtor: okClient() as any,
    });
    await expect(driver.run(makeSample())).rejects.toThrow(/primary worker boom/);
    expect(workerStop).toHaveBeenCalledTimes(1);
    expect(env.cleanup).toHaveBeenCalled();
  });

  it("primary success + worker.stop() success → returns normal result", async () => {
    const env = fakeEnv();
    const workerStop = vi.fn().mockResolvedValue(undefined);
    class OkWorker {
      registerTools() {}
      setSessionConfig() {}
      async start() {}
      stop = workerStop;
    }
    const driver = new LiveDriver(undefined, {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      createEnv: () => env as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      WorkerCtor: OkWorker as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ClientCtor: okClient() as any,
    });
    const result = await driver.run(makeSample());
    expect(result.sessionId).toBe("sid-f28");
    expect(result.finalResponse).toBe("ok response");
    expect(workerStop).toHaveBeenCalledTimes(1);
    expect(env.cleanup).toHaveBeenCalled();
  });
});
