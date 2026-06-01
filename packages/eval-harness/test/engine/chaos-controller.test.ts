import { describe, expect, it } from "vitest";
import { createChaosController, isChaosSkipError } from "../../src/engine/chaos-controller.js";
import type { Scenario } from "../../src/types.js";

function scenario(onTargetMissing: "error" | "skip" | "best-effort" = "error", injectAt = "during-wait"): Scenario {
  return {
    schemaVersion: 1,
    kind: "durable-trajectory",
    id: `chaos.${onTargetMissing}.${injectAt}`,
    description: "Chaos controller unit scenario.",
    input: { prompt: "Use tools." },
    chaos: { injectAt, type: "worker-restart", onTargetMissing },
    checks: [],
  };
}

describe("chaos controller", () => {
  it("fails when required injection is not reached", async () => {
    const controller = createChaosController(scenario("error", "during-wait"), {
      async replaceWorker() {},
    });

    await expect(controller.flush()).rejects.toThrow(/was not reached/);
    expect(controller.metadata()).toMatchObject({ injected: false, injectAt: "during-wait" });
  });

  it("suppresses missing targets in best-effort mode", async () => {
    const controller = createChaosController(scenario("best-effort"), {
      async replaceWorker() {
        throw new Error("should not be called without session context");
      },
    });

    await controller.beforeTurn("wait durably");
    await controller.afterTurn();
    await expect(controller.flush()).resolves.toBeUndefined();
    expect(controller.metadata()).toMatchObject({
      injected: false,
      events: [{ trigger: "during-wait", action: "target-missing" }],
    });
  });

  it("returns a skip error when skip-mode injection cannot find a target", async () => {
    const controller = createChaosController(scenario("skip"), {
      async replaceWorker() {},
    });

    let caught: unknown;
    try {
      await controller.beforeTurn("wait durably");
      await controller.afterTurn();
      await controller.flush();
    } catch (error) {
      caught = error;
    }

    expect(isChaosSkipError(caught)).toBe(true);
  });

  it("injects during-wait only after wait-started evidence appears", async () => {
    const replacements: string[] = [];
    let cmsEvents: Array<{ eventType: string }> = [];
    const controller = createChaosController(scenario("error", "during-wait"), {
      async replaceWorker(_index, sessionId) {
        replacements.push(sessionId);
      },
    });
    controller.setSessionContext(
      () => "session-wait",
      {},
      [],
      async () => cmsEvents,
    );

    await controller.beforeTurn("wait durably");
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(replacements).toEqual([]);

    cmsEvents = [{ eventType: "session.wait_started" }];
    await controller.flush();

    expect(replacements).toEqual(["session-wait"]);
    expect(controller.metadata()).toMatchObject({
      injected: true,
      events: [{ trigger: "during-wait", action: "replace-worker" }],
    });
  });

  it("interrupts pending chaos sleeps on cancel", async () => {
    const controller = createChaosController({
      ...scenario("error", "during-wait"),
      chaos: {
        injectAt: "during-wait",
        type: "worker-restart",
        params: { delayMs: 100 },
        onTargetMissing: "error",
      },
    }, {
      async replaceWorker() {},
    });
    controller.setSessionContext(
      () => "session-wait",
      {},
      [],
      async () => [{ eventType: "session.wait_started" }],
    );

    const startedAt = Date.now();
    await controller.beforeTurn("wait durably");
    await new Promise((resolve) => setTimeout(resolve, 10));
    await controller.cancel();

    expect(Date.now() - startedAt).toBeLessThan(50);
  });

  it("fails during-wait when the turn completes before wait-started evidence", async () => {
    const controller = createChaosController(scenario("error", "during-wait"), {
      async replaceWorker() {},
    });
    controller.setSessionContext(
      () => "session-wait",
      {},
      [],
      async () => [],
    );

    await controller.beforeTurn("wait durably");
    await controller.afterTurn();

    await expect(controller.flush()).rejects.toThrow(/Turn completed before durable wait was observed/);
    expect(controller.metadata()).toMatchObject({ injected: false });
  });
});
