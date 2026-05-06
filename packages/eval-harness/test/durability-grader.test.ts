import { describe, it, expect } from "vitest";
import { resolve } from "node:path";
import {
  DurabilityExpectedSchema,
  DurabilityFaultModeSchema,
  DurabilityFaultPointSchema,
  DurabilityObservationSchema,
  EvalExpectedSchema,
  ObservedResultSchema,
} from "../src/types.js";
import type {
  DurabilityExpected,
  DurabilityObservation,
  EvalSample,
  ObservedResult,
} from "../src/types.js";
import { ChaosDriver } from "../src/drivers/chaos-driver.js";
import { DurabilityFixtureDriver, type DurabilityFixtureScenario } from "../src/drivers/scripted-driver.js";
import { gradeDurability } from "../src/graders/durability.js";
import { gradeEvalCase } from "../src/graders/index.js";
import { loadEvalTask } from "../src/loader.js";

function makeSample(id: string, prompt = "hello"): EvalSample {
  return {
    id,
    description: `sample ${id}`,
    input: { prompt },
    expected: { toolSequence: "unordered" },
    timeoutMs: 120_000,
  };
}

function makeResult(overrides: Partial<ObservedResult> = {}): ObservedResult {
  return {
    toolCalls: [],
    finalResponse: "ok",
    sessionId: "sess-1",
    latencyMs: 10,
    ...overrides,
  };
}

function makeObservation(overrides: Partial<DurabilityObservation> = {}): DurabilityObservation {
  return {
    scenario: "test",
    faultPoint: "during_tool_call",
    faultMode: "worker_crash",
    injected: true,
    recovered: true,
    toolCallsBeforeFault: 0,
    toolCallsAfterRecovery: 0,
    ...overrides,
  };
}

describe("DurabilityObservation types", () => {
  it("DurabilityFaultPointSchema accepts all documented fault points", () => {
    for (const p of [
      "before_turn",
      "during_tool_call",
      "after_tool_call",
      "after_turn",
      "after_dehydrate",
      "before_hydrate",
    ]) {
      expect(() => DurabilityFaultPointSchema.parse(p)).not.toThrow();
    }
    expect(() => DurabilityFaultPointSchema.parse("bogus")).toThrow();
  });

  it("DurabilityFaultModeSchema accepts all documented fault modes", () => {
    for (const m of [
      "worker_crash",
      "tool_timeout",
      "tool_throw",
      "network_disconnect",
    ]) {
      expect(() => DurabilityFaultModeSchema.parse(m)).not.toThrow();
    }
    expect(() => DurabilityFaultModeSchema.parse("bogus")).toThrow();
  });

  it("DurabilityObservationSchema requires core fields and defaults optionals to undefined", () => {
    const parsed = DurabilityObservationSchema.parse({
      scenario: "s",
      faultPoint: "during_tool_call",
      faultMode: "worker_crash",
      injected: true,
      recovered: false,
      toolCallsBeforeFault: 1,
      toolCallsAfterRecovery: 0,
    });
    expect(parsed.dehydrated).toBeUndefined();
    expect(parsed.timerAccuracyMs).toBeUndefined();
  });

  it("DurabilityExpectedSchema defaults mustRecover to true", () => {
    const parsed = DurabilityExpectedSchema.parse({});
    expect(parsed.mustRecover).toBe(true);
  });

  it("ObservedResultSchema allows optional durability field", () => {
    const ok = ObservedResultSchema.parse({
      toolCalls: [],
      finalResponse: "ok",
      sessionId: "s",
      latencyMs: 0,
      durability: makeObservation(),
    });
    expect(ok.durability?.scenario).toBe("test");

    const noDur = ObservedResultSchema.parse({
      toolCalls: [],
      finalResponse: "ok",
      sessionId: "s",
      latencyMs: 0,
    });
    expect(noDur.durability).toBeUndefined();
  });

  it("EvalExpectedSchema allows optional durability expectations", () => {
    const ok = EvalExpectedSchema.parse({
      durability: { mustRecover: true, finalStateIn: ["idle"] },
    });
    expect(ok.durability?.mustRecover).toBe(true);

    const none = EvalExpectedSchema.parse({});
    expect(none.durability).toBeUndefined();
  });
});

describe("DurabilityFixtureDriver (synthetic fixtures — NOT a durability proof)", () => {
  it("returns scripted result for known sampleId", async () => {
    const driver = new DurabilityFixtureDriver([
      {
        sampleId: "a",
        steps: [{ type: "respond", response: makeResult({ finalResponse: "hi" }) }],
      },
    ]);
    const result = await driver.run(makeSample("a"));
    expect(result.finalResponse).toBe("hi");
  });

  it("throws for unknown sampleId", async () => {
    const driver = new DurabilityFixtureDriver([]);
    await expect(driver.run(makeSample("missing"))).rejects.toThrow(/unknown/i);
  });

  it("attaches durability observation when scenario has crash + recover", async () => {
    const driver = new DurabilityFixtureDriver([
      {
        sampleId: "a",
        steps: [
          { type: "respond", response: makeResult({ cmsState: "running" }) },
          { type: "crash", faultPoint: "during_tool_call", faultMode: "worker_crash" },
          {
            type: "recover",
            recoveryResponse: makeResult({
              cmsState: "completed",
              toolCalls: [{ name: "t", args: {}, order: 0 }],
            }),
          },
        ],
      },
    ]);
    const result = await driver.run(makeSample("a"));
    expect(result.durability).toBeDefined();
    expect(result.durability!.recovered).toBe(true);
    expect(result.durability!.faultPoint).toBe("during_tool_call");
    expect(result.durability!.faultMode).toBe("worker_crash");
    expect(result.durability!.postRecoveryState).toBe("completed");
    expect(result.durability!.toolCallsAfterRecovery).toBe(1);
    expect(result.cmsState).toBe("completed");
  });

  it("treats crash-only scenario (no recover) as infra error", async () => {
    const driver = new DurabilityFixtureDriver([
      {
        sampleId: "a",
        steps: [
          { type: "respond", response: makeResult() },
          { type: "crash", faultPoint: "after_turn", faultMode: "worker_crash" },
        ],
      },
    ]);
    await expect(driver.run(makeSample("a"))).rejects.toThrow(/crashed without recovery/i);
  });

  it("respects abort signal", async () => {
    const driver = new DurabilityFixtureDriver([
      { sampleId: "a", steps: [{ type: "respond", response: makeResult() }] },
    ]);
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(driver.run(makeSample("a"), { signal: ctrl.signal })).rejects.toThrow(
      /aborted/i,
    );
  });

  it("returns independent copies (structuredClone)", async () => {
    const base = makeResult({ finalResponse: "v1" });
    const driver = new DurabilityFixtureDriver([
      { sampleId: "a", steps: [{ type: "respond", response: base }] },
    ]);
    const r = await driver.run(makeSample("a"));
    r.finalResponse = "mutated";
    const r2 = await driver.run(makeSample("a"));
    expect(r2.finalResponse).toBe("v1");
  });

  it("uses respond step after recover as final result", () => {
    const scenario = {
      sampleId: "respond-after-recover",
      steps: [
        { type: "respond" as const, response: { toolCalls: [], finalResponse: "before crash", sessionId: "s1", latencyMs: 50 } },
        { type: "crash" as const, faultPoint: "during_tool_call" as const, faultMode: "worker_crash" as const },
        {
          type: "recover" as const,
          recoveryResponse: { toolCalls: [], finalResponse: "recovered", sessionId: "s1", latencyMs: 100 },
          durability: {
            scenario: "respond-after-recover",
            faultPoint: "during_tool_call" as const,
            faultMode: "worker_crash" as const,
            injected: true,
            recovered: true,
            toolCallsBeforeFault: 0,
            toolCallsAfterRecovery: 0,
          },
        },
        {
          type: "respond" as const,
          response: {
            toolCalls: [{ name: "test_add", args: { a: 1, b: 2 }, order: 0 }],
            finalResponse: "final answer",
            sessionId: "s1",
            latencyMs: 150,
          },
        },
      ],
    };
    const driver = new DurabilityFixtureDriver([scenario]);
    return driver
      .run({ id: "respond-after-recover", description: "", input: { prompt: "" }, expected: {}, timeoutMs: 5000 } as any)
      .then((result) => {
        expect(result.finalResponse).toBe("final answer");
        expect(result.toolCalls).toHaveLength(1);
        expect(result.durability).toBeDefined();
      });
  });

  it("derives durability post-recovery state from final result, not recovery step", async () => {
    const scenario: DurabilityFixtureScenario = {
      sampleId: "stale-dur-fix",
      steps: [
        { type: "respond", response: { toolCalls: [], finalResponse: "initial", sessionId: "s1", latencyMs: 10 } },
        { type: "crash", faultPoint: "during_tool_call", faultMode: "worker_crash" },
        { type: "recover", recoveryResponse: { toolCalls: [], finalResponse: "recovering", sessionId: "s1", latencyMs: 50, cmsState: "recovering" },
          durability: {
            scenario: "stale-dur-fix", faultPoint: "during_tool_call", faultMode: "worker_crash",
            injected: true, recovered: true, toolCallsBeforeFault: 0, toolCallsAfterRecovery: 0,
          }
        },
        { type: "respond", response: {
          toolCalls: [{ name: "test_add", args: { a: 1, b: 2 }, order: 0 }, { name: "test_multiply", args: { a: 3, b: 4 }, order: 1 }],
          finalResponse: "completed", sessionId: "s1", latencyMs: 100, cmsState: "completed"
        }},
      ],
    };
    const driver = new DurabilityFixtureDriver([scenario]);
    const result = await driver.run({ id: "stale-dur-fix", description: "", input: { prompt: "" }, expected: {}, timeoutMs: 5000 } as any);

    expect(result.finalResponse).toBe("completed");
    expect(result.cmsState).toBe("completed");
    expect(result.toolCalls).toHaveLength(2);

    expect(result.durability).toBeDefined();
    expect(result.durability!.postRecoveryState).toBe("completed");
    expect(result.durability!.toolCallsAfterRecovery).toBe(2);
  });

  it("merges durability from final respond step after recovery", async () => {
    const scenario: DurabilityFixtureScenario = {
      sampleId: "final-respond-dur",
      steps: [
        { type: "respond", response: { toolCalls: [], finalResponse: "before", sessionId: "s1", latencyMs: 10 } },
        { type: "crash", faultPoint: "during_tool_call", faultMode: "worker_crash",
          durability: {
            scenario: "final-respond-dur", faultPoint: "during_tool_call", faultMode: "worker_crash",
            injected: true, recovered: false, toolCallsBeforeFault: 1, toolCallsAfterRecovery: 0,
          }
        },
        { type: "recover", recoveryResponse: { toolCalls: [], finalResponse: "recovering", sessionId: "s1", latencyMs: 50 },
          durability: {
            scenario: "final-respond-dur", faultPoint: "during_tool_call", faultMode: "worker_crash",
            injected: true, recovered: true, toolCallsBeforeFault: 1, toolCallsAfterRecovery: 0,
            hydrated: true,
          }
        },
        { type: "respond",
          response: { toolCalls: [{ name: "test_add", args: { a: 1, b: 2 }, order: 0 }], finalResponse: "done", sessionId: "s1", latencyMs: 100, cmsState: "completed" },
          durability: {
            scenario: "final-respond-dur", faultPoint: "during_tool_call", faultMode: "worker_crash",
            injected: true, recovered: true, toolCallsBeforeFault: 1, toolCallsAfterRecovery: 1,
            timerAccuracyMs: 42,
            workerHandoff: true,
          }
        },
      ],
    };
    const driver = new DurabilityFixtureDriver([scenario]);
    const result = await driver.run({ id: "final-respond-dur", description: "", input: { prompt: "" }, expected: {}, timeoutMs: 5000 } as any);

    expect(result.durability).toBeDefined();
    expect(result.durability!.timerAccuracyMs).toBe(42);
    expect(result.durability!.workerHandoff).toBe(true);
    expect(result.durability!.hydrated).toBe(true);
    expect(result.durability!.postRecoveryState).toBe("completed");
    expect(result.durability!.toolCallsAfterRecovery).toBe(1);
  });
});

describe("ChaosDriver", () => {
  it("rejects construction without an inner driver", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(() => new ChaosDriver(undefined as any)).toThrow(/inner Driver is required/);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(() => new ChaosDriver({} as any)).toThrow(/inner Driver is required/);
  });

  it("rejects out-of-range injectionRate", () => {
    const inner = { run: async () => makeResult() };
    expect(() => new ChaosDriver(inner, { injectionRate: 1.5 })).toThrow(/injectionRate/);
    expect(() => new ChaosDriver(inner, { injectionRate: -0.1 })).toThrow(/injectionRate/);
    expect(() => new ChaosDriver(inner, { injectionRate: Number.NaN })).toThrow(/injectionRate/);
  });

  it("delegates to inner driver and tags ObservedResult with a durability observation", async () => {
    const inner = { run: async () => makeResult({ toolCalls: [{ name: "x", args: {}, order: 0 }] }) };
    const driver = new ChaosDriver(inner, {
      scenarioName: "smoke",
      faultPoint: "before_turn",
      faultMode: "worker_crash",
    });
    const result = await driver.run(makeSample("s1"));
    expect(result.toolCalls.length).toBe(1);
    expect(result.durability).toBeDefined();
    expect(result.durability!.scenario).toBe("smoke");
    expect(result.durability!.faultPoint).toBe("before_turn");
    expect(result.durability!.faultMode).toBe("worker_crash");
    expect(result.durability!.injected).toBe(true);
    expect(result.durability!.recovered).toBe(true);
    expect(result.durability!.toolCallsAfterRecovery).toBe(1);
  });

  it("invokes beforeRunHook and afterRunHook with resolved fault descriptor", async () => {
    const calls: string[] = [];
    const inner = { run: async () => makeResult() };
    const driver = new ChaosDriver(inner, {
      faultPoint: "during_tool_call",
      faultMode: "tool_throw",
      beforeRunHook: (sample, fault) => {
        calls.push(`before:${sample.id}:${fault.point}/${fault.mode}`);
      },
      afterRunHook: (sample, _observed, fault) => {
        calls.push(`after:${sample.id}:${fault.point}/${fault.mode}`);
      },
    });
    await driver.run(makeSample("s2"));
    expect(calls).toEqual([
      "before:s2:during_tool_call/tool_throw",
      "after:s2:during_tool_call/tool_throw",
    ]);
  });

  it("re-throws inner-driver errors by default (no silent swallowing)", async () => {
    const inner = {
      run: async () => {
        throw new Error("inner blew up");
      },
    };
    const driver = new ChaosDriver(inner);
    await expect(driver.run(makeSample("s3"))).rejects.toThrow(/inner blew up/);
  });

  it("with swallowOnFault:true, surfaces unrecovered observation", async () => {
    const inner = {
      run: async () => {
        throw new Error("crash");
      },
    };
    const driver = new ChaosDriver(inner, {
      swallowOnFault: true,
      faultPoint: "during_tool_call",
      faultMode: "worker_crash",
    });
    const result = await driver.run(makeSample("s4"));
    expect(result.durability).toBeDefined();
    expect(result.durability!.injected).toBe(true);
    expect(result.durability!.recovered).toBe(false);
  });

  it("respects injectionRate=0 (pure pass-through)", async () => {
    let beforeCalled = false;
    const inner = { run: async () => makeResult() };
    const driver = new ChaosDriver(inner, {
      injectionRate: 0,
      beforeRunHook: () => {
        beforeCalled = true;
      },
    });
    const result = await driver.run(makeSample("s5"));
    expect(beforeCalled).toBe(false);
    expect(result.durability!.injected).toBe(false);
  });

  it("dehydrate fault points populate dehydrated/hydrated flags", async () => {
    const inner = { run: async () => makeResult() };
    const driver = new ChaosDriver(inner, {
      faultPoint: "after_dehydrate",
      faultMode: "worker_crash",
    });
    const result = await driver.run(makeSample("s6"));
    expect(result.durability!.dehydrated).toBe(true);
    expect(result.durability!.hydrated).toBe(true);
  });

  it("uses injected rng for deterministic injection decisions", async () => {
    const inner = { run: async () => makeResult() };
    const driver = new ChaosDriver(inner, {
      injectionRate: 0.5,
      rng: () => 0.9,
    });
    const result = await driver.run(makeSample("s7"));
    expect(result.durability!.injected).toBe(false);
  });

  it("disposes inner driver on dispose()", async () => {
    let disposed = false;
    const inner = {
      run: async () => makeResult(),
      dispose: async () => {
        disposed = true;
      },
    };
    const driver = new ChaosDriver(inner);
    await driver.dispose();
    expect(disposed).toBe(true);
  });

  it("produces a schema-valid DurabilityObservation", async () => {
    const inner = { run: async () => makeResult() };
    const driver = new ChaosDriver(inner);
    const result = await driver.run(makeSample("s8"));
    const parsed = DurabilityObservationSchema.safeParse(result.durability);
    expect(parsed.success).toBe(true);
  });
});

describe("gradeDurability (scoring synthetic observations — production proof lives in test/durability-live.test.ts)", () => {
  it("returns empty array when no durability expected", () => {
    expect(gradeDurability(undefined, undefined)).toEqual([]);
    expect(gradeDurability(makeObservation(), undefined)).toEqual([]);
  });

  it("fails when timer expected but observation missing", () => {
    const observed: DurabilityObservation = {
      scenario: "timer-missing",
      faultPoint: "after_turn",
      faultMode: "worker_crash",
      injected: true,
      recovered: true,
      toolCallsBeforeFault: 1,
      toolCallsAfterRecovery: 1,
    };
    const expected: DurabilityExpected = {
      mustRecover: true,
      maxTimerDriftMs: 500,
    };
    const scores = gradeDurability(observed, expected);
    const timerScore = scores.find((s) => s.name === "timer-accuracy");
    expect(timerScore).toBeDefined();
    expect(timerScore!.pass).toBe(false);
    expect(timerScore!.value).toBe(0);
    expect(timerScore!.reason).toContain("missing");
  });

  it("returns durability-missing when expected but not observed", () => {
    const scores = gradeDurability(undefined, { mustRecover: true });
    expect(scores).toHaveLength(1);
    expect(scores[0].name).toBe("durability-missing");
    expect(scores[0].pass).toBe(false);
  });

  it("scores recovery success", () => {
    const scores = gradeDurability(makeObservation({ recovered: true }), {
      mustRecover: true,
    });
    const s = scores.find((x) => x.name === "crash-recovery")!;
    expect(s.pass).toBe(true);
    expect(s.value).toBe(1);
  });

  it("scores recovery failure", () => {
    const scores = gradeDurability(makeObservation({ recovered: false }), {
      mustRecover: true,
    });
    const s = scores.find((x) => x.name === "crash-recovery")!;
    expect(s.pass).toBe(false);
    expect(s.value).toBe(0);
    expect(s.reason).toMatch(/Failed to recover/);
  });

  it("scores post-recovery state match", () => {
    const scores = gradeDurability(
      makeObservation({ postRecoveryState: "idle" }),
      { mustRecover: true, finalStateIn: ["idle", "completed"] },
    );
    const s = scores.find((x) => x.name === "post-recovery-state")!;
    expect(s.pass).toBe(true);
  });

  it("scores post-recovery state mismatch", () => {
    const scores = gradeDurability(
      makeObservation({ postRecoveryState: "errored" }),
      { mustRecover: true, finalStateIn: ["idle", "completed"] },
    );
    const s = scores.find((x) => x.name === "post-recovery-state")!;
    expect(s.pass).toBe(false);
  });

  it("scores tool calls after recovery", () => {
    const passing = gradeDurability(
      makeObservation({ toolCallsAfterRecovery: 3 }),
      { mustRecover: true, minToolCallsAfterRecovery: 2 },
    ).find((s) => s.name === "tool-calls-after-recovery")!;
    expect(passing.pass).toBe(true);

    const failing = gradeDurability(
      makeObservation({ toolCallsAfterRecovery: 0 }),
      { mustRecover: true, minToolCallsAfterRecovery: 1 },
    ).find((s) => s.name === "tool-calls-after-recovery")!;
    expect(failing.pass).toBe(false);
  });

  it("scores timer accuracy within tolerance", () => {
    const s = gradeDurability(
      makeObservation({ timerAccuracyMs: 100 }),
      { mustRecover: true, maxTimerDriftMs: 250 },
    ).find((x) => x.name === "timer-accuracy")!;
    expect(s.pass).toBe(true);
    expect(s.value).toBe(1);
  });

  it("scores timer accuracy exceeding tolerance with partial credit falling to zero", () => {
    const s = gradeDurability(
      makeObservation({ timerAccuracyMs: 1000 }),
      { mustRecover: true, maxTimerDriftMs: 100 },
    ).find((x) => x.name === "timer-accuracy")!;
    expect(s.pass).toBe(false);
    expect(s.value).toBeLessThan(1);
    expect(s.value).toBeGreaterThanOrEqual(0);
  });

  it("fails timer-accuracy when observation has no timerAccuracyMs", () => {
    const scores = gradeDurability(makeObservation(), {
      mustRecover: true,
      maxTimerDriftMs: 100,
    });
    const timer = scores.find((s) => s.name === "timer-accuracy");
    expect(timer).toBeDefined();
    expect(timer!.pass).toBe(false);
    expect(timer!.value).toBe(0);
  });

  it("scores dehydration requirement", () => {
    const ok = gradeDurability(makeObservation({ dehydrated: true }), {
      mustRecover: true,
      requireDehydrated: true,
    }).find((s) => s.name === "dehydration")!;
    expect(ok.pass).toBe(true);

    const bad = gradeDurability(makeObservation({ dehydrated: false }), {
      mustRecover: true,
      requireDehydrated: true,
    }).find((s) => s.name === "dehydration")!;
    expect(bad.pass).toBe(false);
  });

  it("scores hydration requirement", () => {
    const ok = gradeDurability(makeObservation({ hydrated: true }), {
      mustRecover: true,
      requireHydrated: true,
    }).find((s) => s.name === "hydration")!;
    expect(ok.pass).toBe(true);

    const bad = gradeDurability(makeObservation({ hydrated: undefined }), {
      mustRecover: true,
      requireHydrated: true,
    }).find((s) => s.name === "hydration")!;
    expect(bad.pass).toBe(false);
  });

  it("scores worker handoff requirement", () => {
    const ok = gradeDurability(makeObservation({ workerHandoff: true }), {
      mustRecover: true,
      requireWorkerHandoff: true,
    }).find((s) => s.name === "worker-handoff")!;
    expect(ok.pass).toBe(true);

    const bad = gradeDurability(makeObservation({ workerHandoff: false }), {
      mustRecover: true,
      requireWorkerHandoff: true,
    }).find((s) => s.name === "worker-handoff")!;
    expect(bad.pass).toBe(false);
  });

  it("handles partial observations (undefined optional fields)", () => {
    const scores = gradeDurability(makeObservation(), {
      mustRecover: true,
      finalStateIn: ["idle"],
    });
    const state = scores.find((s) => s.name === "post-recovery-state")!;
    expect(state.pass).toBe(false);
    expect(state.reason).toMatch(/undefined/);
  });
});

describe("gradeEvalCase with durability", () => {
  it("includes durability scores when both expected and observed are present", () => {
    const observed: ObservedResult = makeResult({
      durability: makeObservation({ recovered: true, postRecoveryState: "idle" }),
    });
    const expected: { toolSequence: "unordered"; durability: DurabilityExpected } = {
      toolSequence: "unordered",
      durability: { mustRecover: true, finalStateIn: ["idle"] },
    };
    const scores = gradeEvalCase(observed, expected);
    expect(scores.some((s) => s.name === "crash-recovery")).toBe(true);
    expect(scores.some((s) => s.name === "post-recovery-state")).toBe(true);
  });

  it("omits durability scores when not expected and not observed", () => {
    const scores = gradeEvalCase(makeResult(), { toolSequence: "unordered" });
    expect(scores.some((s) => s.name.startsWith("crash-") || s.name.startsWith("timer-"))).toBe(
      false,
    );
    expect(scores.some((s) => s.name === "durability-missing")).toBe(false);
  });

  it("produces durability-missing when expected but observation absent", () => {
    const scores = gradeEvalCase(makeResult(), {
      toolSequence: "unordered",
      durability: { mustRecover: true },
    });
    expect(scores.some((s) => s.name === "durability-missing")).toBe(true);
  });

  it("V1 tool-call grading still fires alongside durability grading", () => {
    const observed: ObservedResult = makeResult({
      toolCalls: [{ name: "t", args: { a: 1 }, order: 0 }],
      durability: makeObservation({ recovered: true }),
    });
    const scores = gradeEvalCase(observed, {
      toolSequence: "unordered",
      toolCalls: [{ name: "t", match: "subset", args: { a: 1 } }],
      durability: { mustRecover: true },
    });
    expect(scores.some((s) => s.name === "tool-names")).toBe(true);
    expect(scores.some((s) => s.name === "crash-recovery")).toBe(true);
  });
});

describe("durability fixture dataset", () => {
  const fixturePath = resolve(
    process.cwd(),
    "datasets",
    "durability-scenarios.v1.json",
  );

  it("loads durability-scenarios.v1.json successfully", () => {
    const task = loadEvalTask(fixturePath);
    expect(task.id).toBe("durability-scenarios");
    expect(task.runnable).toBe(false);
    expect(task.samples.length).toBe(8);
  });

  it("skips the illustrative durability dataset in live mode", () => {
    const messages: string[] = [];
    const task = loadEvalTask(fixturePath, {
      mode: "live",
      onSkip: (message) => messages.push(message),
    });
    expect(task).toBeUndefined();
    expect(messages[0]).toMatch(/skipping non-runnable dataset/i);
  });

  it("every sample has a durability expectation", () => {
    const task = loadEvalTask(fixturePath);
    for (const s of task.samples) {
      expect(s.expected.durability, `sample ${s.id} missing durability`).toBeDefined();
      expect(s.expected.durability!.mustRecover).toBe(true);
    }
  });

  it("covers all documented scenario categories", () => {
    const task = loadEvalTask(fixturePath);
    const ids = task.samples.map((s) => s.id);
    expect(ids).toContain("crash.worker-crash-mid-tool");
    expect(ids).toContain("crash.worker-crash-after-turn");
    expect(ids).toContain("crash.tool-timeout");
    expect(ids).toContain("crash.tool-throw");
    expect(ids).toContain("recovery.dehydrate-hydrate");
    expect(ids).toContain("recovery.worker-handoff");
    expect(ids).toContain("timer.fires-after-crash");
    expect(ids).toContain("timer.drift-within-tolerance");
  });
});
