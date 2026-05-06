import { standardNormalCdf } from "./stats.js";
import type {
  Baseline,
  BaselineSample,
  MultiTrialResult,
  SampleTrialResult,
  RegressionDetectionResult,
  RegressionResult,
} from "./types.js";
import {
  normalizeBaseline,
  normalizeMultiTrialResult,
} from "./validation/normalize-result.js";

export type MultipleTestingCorrection = "none" | "bonferroni" | "bh";

export interface RegressionDetectorConfig {
  alpha?: number;
  correction?: MultipleTestingCorrection;
  /**
   * When true, allows `detect()` to proceed when the baseline's taskVersion
   * differs from the current run's taskVersion (a `console.warn` is emitted).
   * Defaults to false: a version mismatch throws to prevent silently
   * comparing across incompatible task definitions.
   */
  allowVersionDrift?: boolean;
  /**
   * F15: when true, allows `detect()` to proceed when the baseline's `model`
   * differs from the current run's `model`. Defaults to false: a model
   * mismatch throws to prevent silently comparing pass rates across models
   * (which can produce meaningless or misleading regression signals). If
   * either side's `model` is undefined, no check is performed (legacy
   * compat).
   */
  allowModelDrift?: boolean;
}

export type RegressionDetectorOptions = RegressionDetectorConfig;

function proportionZTest(
  x1: number,
  n1: number,
  x2: number,
  n2: number,
): { pValue: number; z: number } {
  if (n1 <= 0 || n2 <= 0) return { pValue: 1, z: 0 };
  const p1 = x1 / n1;
  const p2 = x2 / n2;
  const pPooled = (x1 + x2) / (n1 + n2);
  const se = Math.sqrt(pPooled * (1 - pPooled) * (1 / n1 + 1 / n2));
  if (se === 0 || !Number.isFinite(se)) return { pValue: 1, z: 0 };
  const z = (p1 - p2) / se;
  const pValue = 2 * (1 - standardNormalCdf(Math.abs(z)));
  return { pValue, z };
}

export class RegressionDetector {
  private readonly alpha: number;
  private readonly correction: MultipleTestingCorrection;
  private readonly allowVersionDrift: boolean;
  private readonly allowModelDrift: boolean;

  constructor(config: number | RegressionDetectorConfig = 0.05) {
    this.alpha = typeof config === "number" ? config : config.alpha ?? 0.05;
    this.correction = typeof config === "number" ? "none" : config.correction ?? "none";
    this.allowVersionDrift =
      typeof config === "number" ? false : config.allowVersionDrift === true;
    this.allowModelDrift =
      typeof config === "number" ? false : config.allowModelDrift === true;
    const alpha = this.alpha;
    if (!Number.isFinite(alpha) || alpha < 0 || alpha > 1) {
      throw new Error(
        `RegressionDetector: alpha must be in [0, 1] (got ${alpha})`,
      );
    }
    if (!["none", "bonferroni", "bh"].includes(this.correction)) {
      throw new Error(`RegressionDetector: unknown correction "${this.correction}"`);
    }
  }

  detect(baseline: Baseline, current: MultiTrialResult): RegressionDetectionResult {
    // Trust-boundary normalization: validate both inputs through central
    // normalizers. Throws structured errors on shape violations so callers
    // see immediately that the inputs are corrupt rather than silently
    // proceeding with NaN-laden math.
    baseline = normalizeBaseline(baseline);
    current = normalizeMultiTrialResult(current);
    if (baseline.taskId !== current.taskId) {
      throw new Error(
        `RegressionDetector: baseline taskId "${baseline.taskId}" does not match current taskId "${current.taskId}"`,
      );
    }
    if (baseline.taskVersion !== current.taskVersion) {
      const message =
        `Regression detection refused: baseline taskVersion '${baseline.taskVersion}' does not match current taskVersion '${current.taskVersion}'. Pass { allowVersionDrift: true } to override.`;
      if (!this.allowVersionDrift) {
        throw new Error(message);
      }
      console.warn(message);
    }
    // F15: if both sides declare a model and they differ, refuse unless the
    // caller explicitly opts in via { allowModelDrift: true }. If either
    // side's model is undefined, fall through (legacy compat).
    if (
      baseline.model !== undefined &&
      current.model !== undefined &&
      baseline.model !== current.model &&
      !this.allowModelDrift
    ) {
      throw new Error(
        `RegressionDetector: baseline model '${baseline.model}' does not match current model '${current.model}'. Pass { allowModelDrift: true } to override.`,
      );
    }
    const results: RegressionResult[] = [];
    const baselineSampleIds = new Set(baseline.samples.map((sample) => sample.sampleId));
    const currentSampleIds = new Set(current.samples.map((sample) => sample.sampleId));
    const missingBaselineSamples = baseline.samples
      .filter((sample) => !currentSampleIds.has(sample.sampleId))
      .map((sample) => sample.sampleId);
    const newCurrentSamples = current.samples
      .filter((sample) => !baselineSampleIds.has(sample.sampleId))
      .map((sample) => sample.sampleId);
    // F1: collect current samples with no quality signal so downstream gates
    // can report them as infra outages instead of synthesizing 0% regression
    // entries. These are excluded from the regression analysis below.
    const noQualityCurrentSamples: string[] = [];

    for (const currentSample of current.samples) {
      const baselineSample = baseline.samples.find(
        (b) => b.sampleId === currentSample.sampleId,
      );
      if (!baselineSample) continue;

      // F1: skip current samples that produced no quality signal — comparing
      // their (undefined) passRate to baseline as 0% would forge a regression.
      if (
        currentSample.passRate === undefined ||
        currentSample.noQualitySignal === true
      ) {
        noQualityCurrentSamples.push(currentSample.sampleId);
        continue;
      }

      const basePassRate = baselineSample.passRate;
      const currPassRate = currentSample.passRate;
      const baselineNonErrorTrials = baselineDenominator(baselineSample);
      const currentNonErrorTrials = currentSampleDenominator(currentSample);

      // Always use two-proportion z-test. The baseline format stores
      // aggregate passCount/trials only — not per-trial outcomes — so
      // McNemar's test (which requires real paired data) cannot be applied
      // without fabricating a pairing, which produces false positives.
      const zResult = proportionZTest(
        baselineSample.passCount,
        baselineNonErrorTrials,
        currentSample.passCount,
        currentNonErrorTrials,
      );
      const pValue = zResult.pValue;
      const rawDirection: "improved" | "regressed" | "unchanged" =
        currPassRate > basePassRate
          ? "improved"
          : currPassRate < basePassRate
            ? "regressed"
            : "unchanged";
      results.push({
        sampleId: currentSample.sampleId,
        baselinePassRate: basePassRate,
        currentPassRate: currPassRate,
        pValue,
        adjustedPValue: pValue,
        correction: this.correction,
        significant: false,
        direction: rawDirection,
      });
    }

    const adjusted = adjustPValues(results.map((r) => r.pValue), this.correction);
    for (let i = 0; i < results.length; i++) {
      const r = results[i]!;
      r.adjustedPValue = adjusted[i]!;
      r.significant = r.adjustedPValue < this.alpha;
      if (!r.significant) r.direction = "unchanged";
    }

    return { regressions: results, missingBaselineSamples, newCurrentSamples, noQualityCurrentSamples };
  }
}

function baselineDenominator(sample: BaselineSample): number {
  if (sample.nonErrorTrials !== undefined) return sample.nonErrorTrials;
  console.warn(
    `RegressionDetector: baseline sample "${sample.sampleId}" is missing nonErrorTrials; falling back to raw trials, so p-values may be inconsistent with displayed pass rates when infra errors are present.`,
  );
  return sample.trials;
}

function currentSampleDenominator(sample: SampleTrialResult): number {
  return sample.trials - sample.errorCount;
}

function adjustPValues(pValues: number[], correction: MultipleTestingCorrection): number[] {
  if (correction === "none") return [...pValues];
  const n = pValues.length;
  if (correction === "bonferroni") {
    return pValues.map((p) => Math.min(1, p * n));
  }

  const ranked = pValues
    .map((p, index) => ({ p, index }))
    .sort((a, b) => a.p - b.p);
  const adjusted = new Array<number>(n);
  let next = 1;
  for (let i = n - 1; i >= 0; i--) {
    const rank = i + 1;
    next = Math.min(next, (ranked[i]!.p * n) / rank);
    adjusted[ranked[i]!.index] = next;
  }
  return adjusted;
}
