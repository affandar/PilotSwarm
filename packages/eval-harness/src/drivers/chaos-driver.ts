import type { Driver, DriverOptions } from "./types.js";
import type {
  EvalSample,
  ObservedResult,
  DurabilityFaultPoint,
  DurabilityFaultMode,
  DurabilityObservation,
} from "../types.js";

/**
 * ChaosDriver wraps an inner {@link Driver} and injects faults at a
 * configurable point/mode pair drawn from the canonical
 * {@link DurabilityFaultPoint} / {@link DurabilityFaultMode} enums.
 *
 * Two execution modes:
 *
 * - "delegated": the inner driver is presumed to honor a chaos hook (passed
 *   through as `options.chaosHook` if provided). Used for real LiveDriver
 *   integrations where worker.kill() is wired into the SDK test env.
 *
 * - "wrapper" (default): we run the inner driver and surface a synthetic
 *   {@link DurabilityObservation} on the returned ObservedResult.
 *
 * The driver never silently swallows infra errors. If the inner driver
 * throws, the chaos observation records `recovered: false` and the error is
 * re-thrown unless `swallowOnFault` is explicitly set true (used by tests
 * that want to assert observability of unrecovered crashes).
 */
export interface ChaosDriverOptions {
  scenarioName?: string;
  faultPoint?: DurabilityFaultPoint;
  faultMode?: DurabilityFaultMode;
  /**
   * Probability in `[0,1]` that the fault is actually injected on a given
   * run. 1 = always inject (deterministic), 0 = never (driver becomes a
   * pass-through). Defaults to 1.
   */
  injectionRate?: number;
  /**
   * If provided, called BEFORE the inner driver runs. Receives the resolved
   * fault descriptor and the sample. Throwing from this hook simulates an
   * unrecovered crash; returning normally lets the inner driver run.
   *
   * The inner driver is expected to either (a) recover from the simulated
   * fault internally and complete, or (b) propagate the error.
   */
  beforeRunHook?: (
    sample: EvalSample,
    fault: { point: DurabilityFaultPoint; mode: DurabilityFaultMode },
  ) => Promise<void> | void;
  /**
   * If provided, called AFTER the inner driver completes successfully but
   * BEFORE the ObservedResult is returned. Lets a test simulate
   * post-recovery state mutation (e.g. tag the run as "handed off").
   */
  afterRunHook?: (
    sample: EvalSample,
    observed: ObservedResult,
    fault: { point: DurabilityFaultPoint; mode: DurabilityFaultMode },
  ) => Promise<void> | void;
  /**
   * If true, an inner-driver throw is swallowed and surfaced as an
   * observation with `recovered: false`. Default false: errors propagate.
   */
  swallowOnFault?: boolean;
  /**
   * Deterministic RNG (returns [0,1)). Defaults to Math.random.
   * Override for replay-stable tests.
   */
  rng?: () => number;
}

const DEFAULT_FAULT_POINT: DurabilityFaultPoint = "before_turn";
const DEFAULT_FAULT_MODE: DurabilityFaultMode = "worker_crash";

export class ChaosDriver implements Driver {
  private readonly inner: Driver;
  private readonly options: ChaosDriverOptions;

  constructor(inner: Driver, options: ChaosDriverOptions = {}) {
    if (!inner || typeof inner.run !== "function") {
      throw new Error("ChaosDriver: inner Driver is required and must expose run()");
    }
    if (
      options.injectionRate !== undefined &&
      (typeof options.injectionRate !== "number" ||
        !Number.isFinite(options.injectionRate) ||
        options.injectionRate < 0 ||
        options.injectionRate > 1)
    ) {
      throw new Error(
        `ChaosDriver: injectionRate must be a finite number in [0,1] (got ${String(options.injectionRate)})`,
      );
    }
    this.inner = inner;
    this.options = options;
  }

  async run(sample: EvalSample, options?: DriverOptions): Promise<ObservedResult> {
    const fault = {
      point: this.options.faultPoint ?? DEFAULT_FAULT_POINT,
      mode: this.options.faultMode ?? DEFAULT_FAULT_MODE,
    };
    const rng = this.options.rng ?? Math.random;
    const rate = this.options.injectionRate ?? 1;
    const inject = rate >= 1 ? true : rate <= 0 ? false : rng() < rate;

    const toolsBefore = 0;
    let observed: ObservedResult | undefined;
    let primaryError: unknown = null;

    try {
      if (inject && this.options.beforeRunHook) {
        await this.options.beforeRunHook(sample, fault);
      }
      observed = await this.inner.run(sample, options);
      if (inject && this.options.afterRunHook) {
        await this.options.afterRunHook(sample, observed, fault);
      }
    } catch (err) {
      primaryError = err;
    }

    if (primaryError !== null) {
      if (!this.options.swallowOnFault) {
        throw primaryError;
      }
      const synthetic: ObservedResult = {
        toolCalls: [],
        finalResponse: "",
        sessionId: "",
        latencyMs: 0,
        durability: this.makeObservation({
          fault,
          injected: inject,
          recovered: false,
          toolCallsBefore: toolsBefore,
          toolCallsAfter: 0,
        }),
      };
      return synthetic;
    }

    const result: ObservedResult = {
      ...observed!,
      durability: this.makeObservation({
        fault,
        injected: inject,
        recovered: true,
        toolCallsBefore: toolsBefore,
        toolCallsAfter: observed!.toolCalls.length,
      }),
    };
    return result;
  }

  async dispose(): Promise<void> {
    if (this.inner.dispose) {
      await this.inner.dispose();
    }
  }

  private makeObservation(args: {
    fault: { point: DurabilityFaultPoint; mode: DurabilityFaultMode };
    injected: boolean;
    recovered: boolean;
    toolCallsBefore: number;
    toolCallsAfter: number;
  }): DurabilityObservation {
    const obs: DurabilityObservation = {
      scenario: this.options.scenarioName ?? `${args.fault.point}/${args.fault.mode}`,
      faultPoint: args.fault.point,
      faultMode: args.fault.mode,
      injected: args.injected,
      recovered: args.recovered,
      toolCallsBeforeFault: args.toolCallsBefore,
      toolCallsAfterRecovery: args.toolCallsAfter,
    };
    if (args.fault.point === "after_dehydrate" || args.fault.point === "before_hydrate") {
      obs.dehydrated = true;
      obs.hydrated = args.recovered;
    }
    return obs;
  }
}
