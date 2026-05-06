import { z } from "zod";
import {
  CIGateConfigSchema,
  MultiTrialResultBaseSchema,
  RegressionDetectionResultSchema,
  type CIGateConfig,
  type CIGateResult,
  type MultiTrialResult,
  type RegressionDetectionResult,
  type RegressionResult,
  type SampleTrialResult,
} from "./types.js";
import { parseAtBoundary } from "./validation/trust-boundary.js";

const QUALITY_GATE_REQUIRED_REASON =
  "CIGate requires passRateFloor for quality approval — cost, infra, regression-only, and operational gates cannot replace a pass-rate floor. Configure passRateFloor with a value in (0, 1].";
const SUMMARY_INTEGRITY_EPSILON = 1e-9;
const REGRESSION_RATE_EPSILON = 1e-9;

/**
 * F18: optional task hint passed alongside a MultiTrialResult so CIGate can
 * inherit a passRateFloor from the task definition when the gate config does
 * not set one. Precedence is: CIGateConfig.passRateFloor > task.passRateFloor
 * > QUALITY_GATE_REQUIRED error.
 */
export interface CIGateTaskHint {
  passRateFloor?: number;
}

/**
 * F2/F18: strict schema for the task hint. `passRateFloor` must be a finite
 * number in (0, 1]. Invalid values (Infinity, NaN, 0, negatives, > 1) are
 * rejected loudly instead of silently weakening or disabling the gate.
 */
const CIGateTaskHintSchema = z
  .object({
    passRateFloor: z.number().finite().gt(0).lte(1).optional(),
  })
  .strict();

export class CIGate {
  private readonly config: CIGateConfig;

  constructor(config: CIGateConfig) {
    // H8 (iter19): route the constructor config through parseAtBoundary so
    // Symbol/Function/BigInt at the root (or any depth) is rejected uniformly,
    // matching the policy already enforced on `evaluate()` inputs.
    const parsed = parseAtBoundary<CIGateConfig>(
      CIGateConfigSchema as unknown as z.ZodType<CIGateConfig>,
      config,
      { context: "CIGate.constructor:config" },
    );
    if (!parsed.ok) {
      throw new Error(`CIGate: invalid config: ${parsed.error}`);
    }
    this.config = parsed.data;
  }

  evaluate(
    result: MultiTrialResult,
    regressionInput?: RegressionDetectionResult,
    totalCostUsd?: number,
    task?: CIGateTaskHint,
  ): CIGateResult {
    const reasons: string[] = [];
    let pass = true;

    // F2/F18: strict-validate the task hint BEFORE anything else. Invalid
    // values must throw with a descriptive error instead of silently
    // disabling/weakening the floor downstream.
    if (task !== undefined) {
      const parsedHint = CIGateTaskHintSchema.safeParse(task);
      if (!parsedHint.success) {
        throw new Error(
          "CIGate: invalid task hint: passRateFloor must be a finite number in (0,1]",
        );
      }
    }

    // F11 + iter18: schema-validate via central trust-boundary parser. This
    // both runs the structural Zod schema AND deep-walks the value to reject
    // Symbol/Function/BigInt at any depth (which Zod tolerates inside
    // `z.unknown()` slots but breaks `structuredClone` and represents an
    // adversarial-input vector). On failure we return a fail-closed verdict
    // with descriptive reasons rather than a TypeError.
    const parsedBoundary = parseAtBoundary(MultiTrialResultBaseSchema, result, {
      context: "CIGate.evaluate:result",
    });
    if (!parsedBoundary.ok) {
      return {
        pass: false,
        reasons: [`MultiTrialResult failed schema validation: ${parsedBoundary.error}`],
      };
    }
    // `parseAtBoundary` already returns a frozen, deep-cloned, type-safe
    // snapshot — TOCTOU-safe by construction. Use ONLY `safe` for downstream
    // reads.
    const safe: MultiTrialResult = parsedBoundary.data as MultiTrialResult;

    const aggregate = recomputeQualityAggregate(safe);

    // F3: when not trusting summary, summary.meanPassRate must match recomputed
    // unweighted mean (preserved friendly message), AND must be present whenever
    // quality samples exist. Absence is treated as an integrity violation.
    if (!this.config.trustSummary) {
      const supplied = safe.summary.meanPassRate;
      const recomputed = aggregate.meanPassRate;
      if (
        supplied !== undefined &&
        (recomputed === undefined || Math.abs(supplied - recomputed) > SUMMARY_INTEGRITY_EPSILON)
      ) {
        pass = false;
        reasons.push(
          `summary.meanPassRate (${formatOptionalRate(supplied)}) does not match recomputed value (${formatOptionalRate(recomputed)}) — input integrity violated`,
        );
      }
      if (supplied === undefined && recomputed !== undefined) {
        pass = false;
        reasons.push(
          "summary.meanPassRate is missing while quality samples exist — strict integrity requires explicit meanPassRate (set trustSummary: true to opt out)",
        );
      }
    }

    // F16 + F2: regressionInput must be the object form. Array form is rejected.
    let regression: RegressionDetectionResult | undefined;
    let regressionInputInvalid = false;
    if (regressionInput !== undefined) {
      if (Array.isArray(regressionInput)) {
        pass = false;
        regressionInputInvalid = true;
        reasons.push(
          "CIGate.evaluate no longer accepts RegressionResult[] as regressionInput — pass a RegressionDetectionResult object so missingBaselineSamples and newCurrentSamples can be honored",
        );
      } else {
        const parsedRegression = RegressionDetectionResultSchema.safeParse(regressionInput);
        if (!parsedRegression.success) {
          pass = false;
          regressionInputInvalid = true;
          const issues = parsedRegression.error.issues
            .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
            .join("; ");
          reasons.push(`RegressionDetectionResult failed schema validation: ${issues}`);
        } else {
          regression = parsedRegression.data;
        }
      }
    }

    const regressions = regression?.regressions;
    const missingBaselineSamples = regression?.missingBaselineSamples ?? [];
    const newCurrentSamples = regression?.newCurrentSamples ?? [];
    const noQualityCurrentSamples = regression?.noQualityCurrentSamples ?? [];
    const baselineComparisonPerformed = regression !== undefined;

    // F11: cross-check sample IDs in regressionInput against safe.samples.
    if (regression !== undefined) {
      const currentSampleIds = new Set(safe.samples.map((s) => s.sampleId));

      const ghostRegressions = regression.regressions
        .map((r) => r.sampleId)
        .filter((id) => !currentSampleIds.has(id));
      if (ghostRegressions.length > 0) {
        pass = false;
        reasons.push(
          `regressionInput references sample IDs not present in current run: ${ghostRegressions.join(", ")}`,
        );
      }

      const missingButPresent = regression.missingBaselineSamples.filter((id) =>
        currentSampleIds.has(id),
      );
      if (missingButPresent.length > 0) {
        pass = false;
        reasons.push(
          `regressionInput.missingBaselineSamples contains IDs that exist in the current run: ${missingButPresent.join(", ")}`,
        );
      }

      const newButAbsent = regression.newCurrentSamples.filter((id) => !currentSampleIds.has(id));
      if (newButAbsent.length > 0) {
        pass = false;
        reasons.push(
          `regressionInput.newCurrentSamples contains IDs missing from the current run: ${newButAbsent.join(", ")}`,
        );
      }

      // F4: a sampleId cannot simultaneously appear in regressions and
      // newCurrentSamples — that's logically incoherent (a "new" sample has
      // no baseline to regress against). Fail-closed if any overlap exists.
      const regressionIds = new Set(regression.regressions.map((r) => r.sampleId));
      const newCurrentSet = new Set(regression.newCurrentSamples);
      const both: string[] = [];
      for (const id of regressionIds) {
        if (newCurrentSet.has(id)) both.push(id);
      }
      if (both.length > 0) {
        pass = false;
        reasons.push(
          `Regression result is incoherent: sample(s) ${both.join(", ")} appear as both regressions and newCurrentSamples`,
        );
      }

      // F1: each regression entry must be internally consistent — direction
      // must agree with rate comparison, significance must agree with
      // direction, and currentPassRate must match the actual sample's
      // passRate. This blocks forged inputs that claim "improved" while the
      // pass rate dropped, or fabricate a current rate that disagrees with
      // the sample. Ghost sample IDs are already reported above; we skip the
      // sample cross-check for them to avoid duplicate noise.
      const sampleById = new Map<string, SampleTrialResult>(
        safe.samples.map((s) => [s.sampleId, s]),
      );
      for (const r of regression.regressions) {
        const sample = sampleById.get(r.sampleId);
        const issues = validateRegressionEntryConsistency(r, sample);
        if (issues.length > 0) {
          pass = false;
          for (const issue of issues) {
            reasons.push(
              `regressionInput entry for sample "${r.sampleId}" inconsistent: ${issue}`,
            );
          }
        }
      }
    }

    // F18: passRateFloor precedence is CIGateConfig.passRateFloor >
    // task.passRateFloor > QUALITY_GATE_REQUIRED error. Resolve the effective
    // floor here so downstream checks (and the QUALITY_GATE_REQUIRED guard)
    // see the inherited value.
    const effectivePassRateFloor =
      this.config.passRateFloor ?? task?.passRateFloor;
    const qualityGateConfigured = effectivePassRateFloor !== undefined;

    if (safe.dryRun === true) {
      pass = false;
      reasons.push(
        "CIGate received a dry-run MultiTrialResult — re-run without dryRun to gate on real quality signal",
      );
    }

    if ((this.config.requireNoInfraOutage ?? true) && aggregate.outageSamples.length > 0) {
      pass = false;
      reasons.push(
        `infra outage on sample(s): ${aggregate.outageSamples.join(", ")} — no quality signal collected`,
      );
    }

    // F1: noQualityCurrentSamples reported by RegressionDetector are samples
    // that ran in the current job but produced no quality signal. They are
    // surfaced separately from `regressions` to avoid synthesizing a 0%
    // regression entry for an infra outage. Honor requireNoInfraOutage here
    // as a distinct fail reason so reporters can render them in their own
    // section.
    if (
      (this.config.requireNoInfraOutage ?? true) &&
      noQualityCurrentSamples.length > 0
    ) {
      pass = false;
      reasons.push(
        `infra outage: ${noQualityCurrentSamples.length} sample(s) had no quality signal: ${noQualityCurrentSamples.join(", ")}`,
      );
    }

    // F12: when regression data is required by config (failOnNewSamples
    // defaults to true; allowMissingBaselineSamples defaults to false) but
    // the caller supplied no regression input, fail closed. Without baseline
    // comparison we cannot prove the absence of new/missing samples, so the
    // strict gates must reject the run rather than let it pass by omission.
    if (
      regression === undefined &&
      (this.config.failOnNewSamples || !this.config.allowMissingBaselineSamples)
    ) {
      pass = false;
      reasons.push(
        "failOnNewSamples configured but regression data not provided — cannot verify absence of new/missing samples",
      );
    }

    if (!this.config.allowMissingBaselineSamples && missingBaselineSamples.length > 0) {
      pass = false;
      reasons.push(`missing baseline samples: ${missingBaselineSamples.join(", ")}`);
    }

    if (
      this.config.failOnNewSamples &&
      baselineComparisonPerformed &&
      newCurrentSamples.length > 0
    ) {
      pass = false;
      reasons.push(
        `new samples added vs baseline: ${newCurrentSamples.join(", ")} — opt out with failOnNewSamples: false`,
      );
    }

    if (
      this.config.maxInfraErrors !== undefined &&
      aggregate.infraErrorCount > this.config.maxInfraErrors
    ) {
      pass = false;
      reasons.push(
        `${aggregate.infraErrorCount} infra error${aggregate.infraErrorCount === 1 ? "" : "s"} exceed max ${this.config.maxInfraErrors}`,
      );
    }

    // F13: passRateFloor is evaluated against POOLED non-error pass rate, not
    // the unweighted per-sample mean. This prevents a single tiny passing sample
    // from masking a large failing one.
    // F18: prefer config.passRateFloor; fall back to task.passRateFloor.
    if (effectivePassRateFloor !== undefined) {
      if (aggregate.pooledPassRate === undefined) {
        pass = false;
        reasons.push(
          "passRateFloor configured but no quality signal was collected (all samples were infra outages or empty)",
        );
      } else if (aggregate.pooledPassRate < effectivePassRateFloor) {
        pass = false;
        reasons.push(
          `Pass rate ${(aggregate.pooledPassRate * 100).toFixed(1)}% below floor ${(effectivePassRateFloor * 100).toFixed(1)}%`,
        );
      }
    }

    let regressionCount: number | undefined;
    if (regressions) {
      regressionCount = regressions.filter(
        (r) => r.significant && r.direction === "regressed",
      ).length;
    }

    if (
      this.config.maxRegressions !== undefined &&
      regressions === undefined &&
      !regressionInputInvalid
    ) {
      pass = false;
      reasons.push("maxRegressions configured but regression data not provided");
    }

    if (this.config.maxRegressions !== undefined && regressions) {
      const regCount = regressionCount ?? 0;
      if (regCount > this.config.maxRegressions) {
        pass = false;
        reasons.push(
          `${regCount} regression${regCount === 1 ? "" : "s"} exceed max ${this.config.maxRegressions}`,
        );
      }
    }

    if (this.config.maxCostUsd !== undefined && totalCostUsd === undefined) {
      pass = false;
      reasons.push("maxCostUsd configured but cost data not provided");
    }

    if (this.config.maxCostUsd !== undefined && totalCostUsd !== undefined) {
      if (!Number.isFinite(totalCostUsd) || totalCostUsd < 0) {
        pass = false;
        reasons.push("totalCostUsd is invalid (non-finite or negative)");
      } else if (totalCostUsd > this.config.maxCostUsd) {
        pass = false;
        reasons.push(
          `Cost $${totalCostUsd.toFixed(4)} exceeds max $${this.config.maxCostUsd.toFixed(4)}`,
        );
      }
    }

    if (!qualityGateConfigured) {
      pass = false;
      reasons.push(QUALITY_GATE_REQUIRED_REASON);
    } else if (pass && reasons.length === 0) {
      reasons.push("All gates passed");
    }

    const out: CIGateResult = {
      pass,
      reasons,
      passRate: aggregate.pooledPassRate,
    };
    if (regressionCount !== undefined) out.regressionCount = regressionCount;
    if (totalCostUsd !== undefined && Number.isFinite(totalCostUsd) && totalCostUsd >= 0) {
      out.totalCostUsd = totalCostUsd;
    }
    return out;
  }

  exitCode(result: CIGateResult): number {
    return result.pass ? 0 : 1;
  }
}

interface RecomputedQualityAggregate {
  qualityDenominator: number;
  qualityPassCount: number;
  /** Unweighted mean of per-sample passRates over non-outage samples. */
  meanPassRate?: number;
  /** Pooled non-error pass rate: sum(passCount) / sum(nonErrorTrials) over non-outage samples. */
  pooledPassRate?: number;
  infraErrorCount: number;
  outageSamples: string[];
}

function recomputeQualityAggregate(result: MultiTrialResult): RecomputedQualityAggregate {
  let qualityDenominator = 0;
  let qualityPassCount = 0;
  let infraErrorCount = 0;
  const outageSamples: string[] = [];
  const samplePassRates: number[] = [];

  for (const sample of result.samples) {
    const nonErrorTrials = sample.trials - sample.errorCount;
    infraErrorCount += sample.errorCount;
    if (sample.noQualitySignal === true || nonErrorTrials <= 0) {
      outageSamples.push(sample.sampleId);
      continue;
    }
    qualityDenominator += nonErrorTrials;
    qualityPassCount += sample.passCount;
    samplePassRates.push(sample.passCount / nonErrorTrials);
  }

  return {
    qualityDenominator,
    qualityPassCount,
    ...(samplePassRates.length === 0
      ? {}
      : {
          meanPassRate:
            samplePassRates.reduce((sum, rate) => sum + rate, 0) / samplePassRates.length,
        }),
    ...(qualityDenominator === 0
      ? {}
      : { pooledPassRate: qualityPassCount / qualityDenominator }),
    infraErrorCount,
    outageSamples,
  };
}

function formatOptionalRate(value: number | undefined): string {
  return value === undefined ? "undefined" : `${value}`;
}

function validateRegressionEntryConsistency(
  r: RegressionResult,
  sample: SampleTrialResult | undefined,
): string[] {
  const issues: string[] = [];
  const eps = REGRESSION_RATE_EPSILON;
  const delta = r.currentPassRate - r.baselinePassRate;

  if (delta > eps && r.direction === "regressed") {
    issues.push(
      `direction "regressed" contradicts currentPassRate (${r.currentPassRate}) > baselinePassRate (${r.baselinePassRate})`,
    );
  } else if (delta < -eps && r.direction === "improved") {
    issues.push(
      `direction "improved" contradicts currentPassRate (${r.currentPassRate}) < baselinePassRate (${r.baselinePassRate})`,
    );
  } else if (Math.abs(delta) <= eps && r.direction !== "unchanged") {
    issues.push(
      `direction "${r.direction}" contradicts equal pass rates (current=${r.currentPassRate}, baseline=${r.baselinePassRate}); expected "unchanged"`,
    );
  }

  if (r.significant && r.direction === "unchanged") {
    issues.push('significant=true contradicts direction "unchanged"');
  }
  if (!r.significant && (r.direction === "improved" || r.direction === "regressed")) {
    issues.push(`significant=false contradicts direction "${r.direction}"`);
  }
  // iter18 F8: pValue=0 with significant=false is incoherent — a p-value of
  // exactly zero is the strongest possible rejection of the null. If the
  // detector emitted significant=false alongside it, the regression entry's
  // significance flag has been corrupted relative to its own p-value.
  if (r.pValue === 0 && !r.significant) {
    issues.push("pValue=0 contradicts significant=false (zero p-value is the strongest rejection of the null)");
  }

  if (sample) {
    if (sample.passRate === undefined) {
      issues.push(
        "sample has no quality signal (passRate undefined) — regression entry should not exist",
      );
    } else if (Math.abs(sample.passRate - r.currentPassRate) > eps) {
      issues.push(
        `currentPassRate (${r.currentPassRate}) does not match sample.passRate (${sample.passRate})`,
      );
    }
  }

  return issues;
}
