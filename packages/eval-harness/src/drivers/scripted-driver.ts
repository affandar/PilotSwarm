import type { Driver, DriverOptions } from "./types.js";
import type {
  DurabilityFaultMode,
  DurabilityFaultPoint,
  DurabilityObservation,
  EvalSample,
  ObservedResult,
} from "../types.js";

export interface DurabilityFixtureStep {
  type: "respond" | "crash" | "recover";
  /** For "respond": the ObservedResult to return if this is the last step. */
  response?: ObservedResult;
  /** For "crash": fault details recorded into the DurabilityObservation. */
  faultPoint?: DurabilityFaultPoint;
  faultMode?: DurabilityFaultMode;
  /** For "recover": post-recovery ObservedResult (takes precedence over any earlier respond). */
  recoveryResponse?: ObservedResult;
  /** Optional explicit durability observation override (applied after auto-build). */
  durability?: Partial<DurabilityObservation>;
}

export interface DurabilityFixtureScenario {
  sampleId: string;
  steps: DurabilityFixtureStep[];
}

/** @deprecated Use DurabilityFixtureStep. */
export type ScriptedStep = DurabilityFixtureStep;
/** @deprecated Use DurabilityFixtureScenario. */
export type ScriptedScenario = DurabilityFixtureScenario;

/**
 * Fixture-based illustrative durability driver.
 *
 * ⚠️ NOT FOR PRODUCTION DURABILITY EVALUATION ⚠️
 *
 * This driver does not crash a real worker, replay orchestration history, or
 * verify hydration / handoff. Durability observations are derived entirely from
 * the JSON script supplied by the test author, then passed to `gradeDurability`.
 * The grader is therefore evaluating its own input — passing scores prove only
 * that the grader reads the fixture correctly, NOT that PilotSwarm survives
 * real worker crashes.
 *
 * Use this driver for:
 *   - Unit-testing `gradeDurability` score outputs on synthetic inputs.
 *   - Documenting expected `DurabilityObservation` shapes.
 *
 * Do NOT use this driver for:
 *   - Production durability eval baselines (CIGate / RegressionDetector).
 *   - Demonstrating PilotSwarm crash-recovery to maintainers / customers.
 *
 * For real durability evidence, see:
 *   - `test/durability-live.test.ts` — real worker kill + CMS event proof.
 *   - `ChaosDriver` wrapping `LiveDriver` with `beforeRunHook` that calls
 *     `worker.kill()` mid-`runTurn` against a live PilotSwarm SDK harness.
 *
 * @see ChaosDriver
 * @see LiveDriver
 */
export class DurabilityFixtureDriver implements Driver {
  private scenarios: Map<string, DurabilityFixtureScenario>;
  private crashOnly: Map<string, { faultPoint: DurabilityFaultPoint; faultMode: DurabilityFaultMode }>;

  constructor(scenarios: DurabilityFixtureScenario[]) {
    this.scenarios = new Map();
    this.crashOnly = new Map();
    for (const s of scenarios) {
      this.scenarios.set(s.sampleId, s);
    }
    if (
      process.env.NODE_ENV !== "test" &&
      process.env.VITEST !== "true" &&
      process.env.EVAL_HARNESS_SUPPRESS_FIXTURE_WARN !== "1"
    ) {
      // Surface the tautology to anyone who instantiates this outside of test
      // contexts. Vitest sets VITEST=true and NODE_ENV=test so existing grader
      // unit tests stay quiet.
      console.warn(
        "[eval-harness] DurabilityFixtureDriver is fixture-only and does NOT prove crash recovery. " +
          "For production durability eval, use ChaosDriver + LiveDriver with a real worker.kill() hook " +
          "or run test/durability-live.test.ts. Set EVAL_HARNESS_SUPPRESS_FIXTURE_WARN=1 to silence.",
      );
    }
  }

  async run(sample: EvalSample, options?: DriverOptions): Promise<ObservedResult> {
    const scenario = this.scenarios.get(sample.id);
    if (!scenario) {
      throw new Error(`DurabilityFixtureDriver: unknown sampleId "${sample.id}"`);
    }
    await new Promise((resolve) => setTimeout(resolve, 1));
    if (options?.signal?.aborted) {
      throw new Error(`DurabilityFixtureDriver: aborted while serving sample "${sample.id}"`);
    }

    const composed = this.buildResult(scenario);
    if (composed === null) {
      throw new Error(
        `DurabilityFixtureDriver: scenario "${sample.id}" crashed without recovery (infra error)`,
      );
    }
    return structuredClone(composed);
  }

  private buildResult(scenario: DurabilityFixtureScenario): ObservedResult | null {
    const steps = scenario.steps;
    if (steps.length === 0) {
      throw new Error(`DurabilityFixtureDriver: scenario "${scenario.sampleId}" has no steps`);
    }

    // Locate the last crash step (if any) and the last respond/recover steps.
    let crashIdx = -1;
    let lastRespondIdx = -1;
    let lastRecoverIdx = -1;
    for (let i = 0; i < steps.length; i++) {
      const s = steps[i];
      if (s.type === "crash") crashIdx = i;
      if (s.type === "respond") lastRespondIdx = i;
      if (s.type === "recover") lastRecoverIdx = i;
    }

    const hasCrash = crashIdx !== -1;
    const hasRecover = lastRecoverIdx !== -1 && lastRecoverIdx > crashIdx;

    if (hasCrash && !hasRecover) {
      return null; // infra error path
    }

    // Base result comes from whichever is later: last recover or last respond.
    // This allows a respond step after recover to supply the final answer
    // while the recover step still contributes durability metadata.
    const finalIdx = Math.max(lastRecoverIdx, lastRespondIdx);
    if (finalIdx === -1) {
      throw new Error(
        `DurabilityFixtureDriver: scenario "${scenario.sampleId}" has no respond/recover step`,
      );
    }
    const finalStep = steps[finalIdx];
    const base =
      finalStep.type === "recover" ? finalStep.recoveryResponse : finalStep.response;
    if (!base) {
      throw new Error(
        `DurabilityFixtureDriver: scenario "${scenario.sampleId}" step ${finalIdx} missing payload`,
      );
    }
    const result: ObservedResult = structuredClone(base);

    // Pre-crash respond (if any) contributes tool call counts to the durability observation.
    let preCrashRespond: ObservedResult | undefined;
    if (hasCrash) {
      for (let i = crashIdx - 1; i >= 0; i--) {
        if (steps[i].type === "respond") {
          preCrashRespond = steps[i].response;
          break;
        }
      }
    }

    if (hasCrash) {
      const crash = steps[crashIdx];
      const recover = hasRecover ? steps[lastRecoverIdx] : undefined;
      const observation: DurabilityObservation = {
        scenario: scenario.sampleId,
        faultPoint: crash.faultPoint ?? "during_tool_call",
        faultMode: crash.faultMode ?? "worker_crash",
        injected: true,
        recovered: hasRecover,
        preCrashState: preCrashRespond?.cmsState,
        toolCallsBeforeFault: preCrashRespond?.toolCalls.length ?? 0,
        ...(crash.durability ?? {}),
        ...(recover?.durability ?? {}),
        ...(finalStep.type === "respond" ? finalStep.durability ?? {} : {}),
        postRecoveryState: result.cmsState,
        toolCallsAfterRecovery: result.toolCalls.length,
      };
      result.durability = observation;
    } else if (finalStep.durability) {
      // Respond-only scenarios may still carry a durability observation (e.g. no fault injected).
      const base: DurabilityObservation = {
        scenario: scenario.sampleId,
        faultPoint: "before_turn",
        faultMode: "worker_crash",
        injected: false,
        recovered: true,
        toolCallsBeforeFault: 0,
        toolCallsAfterRecovery: result.toolCalls.length,
        ...finalStep.durability,
      };
      result.durability = base;
    }

    return result;
  }

  static fromScenarios(scenarios: DurabilityFixtureScenario[]): DurabilityFixtureDriver {
    return new DurabilityFixtureDriver(scenarios);
  }
}

/** @deprecated Use DurabilityFixtureDriver. */
export const ScriptedDriver = DurabilityFixtureDriver;
