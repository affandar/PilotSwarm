import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import {
  BaselineSchema,
  BaselineSchemaAllowEmpty,
  type Baseline,
  type MultiTrialResult,
} from "./types.js";

import { parseAtBoundary } from "./validation/trust-boundary.js";

export interface SaveBaselineOptions {
  allowNoQualityBaseline?: boolean;
  allowLowQualityBaseline?: boolean;
  allowEmptyBaseline?: boolean;
}

export interface LoadBaselineOptions {
  allowNoQualityBaseline?: boolean;
  allowLowQualityBaseline?: boolean;
  allowEmptyBaseline?: boolean;
}

// Below 50% pass rate suggests the baseline represents a broken product;
// allowing this enables broken-stays-broken gaming with regression-only CI gates.
const LOW_QUALITY_BASELINE_PASS_RATE_FLOOR = 0.5;

// In-memory projection of MultiTrialResult → Baseline. Same shape as
// what `saveBaseline` would persist, but without filesystem I/O or
// quality refusal — the caller (typically tests) is responsible for
// any guardrails. Kept narrow so RegressionDetector can consume it
// directly without round-tripping through disk.
export function baselineFromMultiTrialResult(
  result: MultiTrialResult,
): Baseline {
  return {
    schemaVersion: 1,
    taskId: result.taskId,
    taskVersion: result.taskVersion,
    ...(result.model !== undefined ? { model: result.model } : {}),
    createdAt: new Date().toISOString(),
    samples: result.samples.map((s) => ({
      sampleId: s.sampleId,
      passRate: s.passRate ?? 0,
      trials: s.trials,
      nonErrorTrials: s.trials - s.errorCount,
      infraErrorCount: s.errorCount,
      passCount: s.passCount,
    })),
  };
}

export function saveBaseline(
  result: MultiTrialResult,
  filePath: string,
  options: SaveBaselineOptions = {},
): void {
  const baseline: Baseline = {
    schemaVersion: 1,
    taskId: result.taskId,
    taskVersion: result.taskVersion,
    ...(result.model !== undefined ? { model: result.model } : {}),
    createdAt: new Date().toISOString(),
    samples: result.samples.map((s) => ({
      sampleId: s.sampleId,
      passRate: s.passRate ?? 0,
      trials: s.trials,
      nonErrorTrials: s.trials - s.errorCount,
      infraErrorCount: s.errorCount,
      passCount: s.passCount,
    })),
  };
  // F21/WS6: Use lenient schema internally so `refuseEmptyBaseline` can
  // produce the documented friendly error message. The strict
  // `BaselineSchema` is the public API contract and rejects empty samples;
  // here we want to surface the actionable opt-in message instead of a raw
  // ZodError. When `allowEmptyBaseline` is true the lenient schema passes
  // through; when false, `refuseEmptyBaseline` throws with the
  // documented message before any further processing.
  BaselineSchemaAllowEmpty.parse(baseline);
  refuseEmptyBaseline(
    baseline,
    options.allowEmptyBaseline === true,
    "saveBaseline",
  );
  warnOrRefuseNoQualityBaseline(
    baseline,
    options.allowNoQualityBaseline === true,
    "saveBaseline",
  );
  warnOrRefuseLowQualityBaseline(
    baseline,
    options.allowLowQualityBaseline === true,
    "saveBaseline",
  );
  mkdirSync(dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp.${process.pid}.${randomBytes(4).toString("hex")}`;
  writeFileSync(tmpPath, JSON.stringify(baseline, null, 2), "utf8");
  try {
    renameSync(tmpPath, filePath);
  } catch (err) {
    try {
      rmSync(tmpPath, { force: true });
    } catch {
      // ignore cleanup failure; preserve the original baseline error
    }
    throw err;
  }
}

function warnOrRefuseLowQualityBaseline(
  baseline: Baseline,
  allow: boolean,
  source: "saveBaseline" | "loadBaseline",
): void {
  // F2: pool by denominator (passCount / nonErrorTrials), not unweighted mean
  // of per-sample rates. Unweighted mean is vulnerable to Simpson's paradox —
  // a 1/1 sample alongside a 0/100 sample averages to 50% but actually
  // represents a broken baseline. Pooled rate excludes no-quality samples
  // (denom=0) so they don't dilute the signal.
  let totalPass = 0;
  let totalDenom = 0;
  for (const sample of baseline.samples) {
    const denom = sample.nonErrorTrials ?? sample.trials;
    if (denom > 0) {
      totalPass += sample.passCount;
      totalDenom += denom;
    }
  }
  if (totalDenom === 0) return;

  const meanPassRate = totalPass / totalDenom;
  if (meanPassRate >= LOW_QUALITY_BASELINE_PASS_RATE_FLOOR) return;

  const verb = source === "saveBaseline" ? "save" : "load";
  const message =
    `Refusing to ${verb} baseline: pooled pass rate ${(meanPassRate * 100).toFixed(2)}% is below 50% — this would let a broken baseline ratify broken current runs in regression-only CI gates. Pass { allowLowQualityBaseline: true } to override, or fix the product first.`;
  if (!allow) {
    throw new Error(message);
  }
  console.warn(message);
}

export function loadBaseline(
  filePath: string,
  options: LoadBaselineOptions = {},
): Baseline {
  const raw = readFileSync(filePath, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `loadBaseline: file at ${filePath} is not valid JSON: ${(err as Error).message}`,
    );
  }
  // F21/WS6: same rationale as saveBaseline — parse with lenient schema so
  // refuseEmptyBaseline can produce the documented friendly error message.
  // External file → use parseAtBoundary for deep-walk + freeze.
  const r = parseAtBoundary(BaselineSchemaAllowEmpty, parsed, {
    context: `loadBaseline:${filePath}`,
  });
  if (!r.ok) {
    throw new Error(`loadBaseline: ${r.error}`);
  }
  const baseline = r.data;
  refuseEmptyBaseline(
    baseline,
    options.allowEmptyBaseline === true,
    "loadBaseline",
  );
  if (
    baseline.samples.some(
      (sample) =>
        sample.nonErrorTrials === undefined ||
        sample.infraErrorCount === undefined,
    )
  ) {
    console.warn(
      "loadBaseline: baseline is missing nonErrorTrials/infraErrorCount; regression p-values may be inconsistent with displayed pass rates when infra errors are present.",
    );
  }
  warnOrRefuseNoQualityBaseline(
    baseline,
    options.allowNoQualityBaseline === true,
    "loadBaseline",
  );
  warnOrRefuseLowQualityBaseline(
    baseline,
    options.allowLowQualityBaseline === true,
    "loadBaseline",
  );
  return baseline;
}

function warnOrRefuseNoQualityBaseline(
  baseline: Baseline,
  allow: boolean,
  source: "saveBaseline" | "loadBaseline",
): void {
  const noQualitySamples = baseline.samples
    .filter((sample) => (sample.nonErrorTrials ?? sample.trials) === 0)
    .map((sample) => sample.sampleId);
  if (noQualitySamples.length === 0) return;

  const sampleList = noQualitySamples.join(", ");
  const verb = source === "saveBaseline" ? "save" : "load";
  if (!allow) {
    throw new Error(
      `Refusing to ${verb} baseline: sample(s) ${sampleList} have no quality signal (all trials infra-errored). Pass { allowNoQualityBaseline: true } to override.`,
    );
  }
  console.warn(
    `${source}: baseline sample(s) ${sampleList} have no quality signal (all trials infra-errored); regression detection will have no quality signal for those samples.`,
  );
}

function refuseEmptyBaseline(
  baseline: Baseline,
  allow: boolean,
  source: "saveBaseline" | "loadBaseline",
): void {
  if (baseline.samples.length > 0) return;
  if (allow) return;
  const verb = source === "saveBaseline" ? "save" : "load";
  throw new Error(
    `Refusing to ${verb} baseline: baseline has zero samples; pass allowEmptyBaseline:true to opt in.`,
  );
}
