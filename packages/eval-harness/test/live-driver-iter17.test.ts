import { describe, it, expect, vi } from "vitest";
import { LiveDriver } from "../src/drivers/live-driver.js";
import type { EvalSample } from "../src/types.js";

/**
 * F28 (iter17): close cleanup-family asymmetry — `client.stop()` failures
 * must surface on a successful primary path, mirroring the worker.stop()
 * (iter16) and env.cleanup() (iter14) semantics.
 */
describe("F28 iter17: LiveDriver surfaces client.stop() failures on success path", () => {
  function makeSample(): EvalSample {
    return {
      id: "f28-iter17",
      description: "f28-iter17",
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

  function okWorker() {
    return class OkWorker {
      registerTools() {}
      setSessionConfig() {}
      async start() {}
      async stop() {}
    };
  }

  it("primary success + client.stop() throws → driver throws stop's error", async () => {
    const env = fakeEnv();
    const clientStop = vi.fn().mockRejectedValue(new Error("client stop boom"));
    class OkClient {
      async start() {}
      stop = clientStop;
      async createSession() {
        return {
          sessionId: "sid-f28-iter17",
          sendAndWait: async () => "ok response",
          getInfo: async () => ({ state: "active" }),
        };
      }
    }
    const driver = new LiveDriver(undefined, {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      createEnv: () => env as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      WorkerCtor: okWorker() as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ClientCtor: OkClient as any,
    });
    await expect(driver.run(makeSample())).rejects.toThrow(/client stop boom/);
    expect(clientStop).toHaveBeenCalledTimes(1);
    expect(env.cleanup).toHaveBeenCalled();
  });

  it("primary throws + client.stop() also throws → driver throws primary error (stop logged)", async () => {
    const env = fakeEnv();
    const clientStop = vi.fn().mockRejectedValue(new Error("client stop secondary"));
    class FailingClient {
      async start() {}
      stop = clientStop;
      async createSession() {
        throw new Error("primary client boom");
      }
    }
    const driver = new LiveDriver(undefined, {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      createEnv: () => env as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      WorkerCtor: okWorker() as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ClientCtor: FailingClient as any,
    });
    await expect(driver.run(makeSample())).rejects.toThrow(/primary client boom/);
    expect(clientStop).toHaveBeenCalledTimes(1);
    expect(env.cleanup).toHaveBeenCalled();
  });

  it("primary success + client.stop() success → returns normal result", async () => {
    const env = fakeEnv();
    const clientStop = vi.fn().mockResolvedValue(undefined);
    class OkClient {
      async start() {}
      stop = clientStop;
      async createSession() {
        return {
          sessionId: "sid-ok",
          sendAndWait: async () => "ok response",
          getInfo: async () => ({ state: "active" }),
        };
      }
    }
    const driver = new LiveDriver(undefined, {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      createEnv: () => env as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      WorkerCtor: okWorker() as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ClientCtor: OkClient as any,
    });
    const result = await driver.run(makeSample());
    expect(result.sessionId).toBe("sid-ok");
    expect(result.finalResponse).toBe("ok response");
    expect(clientStop).toHaveBeenCalledTimes(1);
    expect(env.cleanup).toHaveBeenCalled();
  });
});
