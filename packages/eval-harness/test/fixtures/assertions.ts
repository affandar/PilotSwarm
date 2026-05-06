/**
 * Schema-aware metric accessors and assertions.
 *
 * Decouples test code from `result.summary.*` field names. When the harness
 * renames or restructures a summary field, change it here once instead of
 * in 12 files / 115 access sites.
 */
import { expect } from "vitest";
import type { MultiTrialResult, RunResult } from "../../src/types.js";

type AnyResult = RunResult | MultiTrialResult;

interface MultiTrialLikeSummary {
  meanPassRate?: number;
  pooledPassRate?: number;
  passRateCI?: { lower: number; upper: number; point: number };
  pooledPassRateCI?: { lower: number; upper: number; point: number };
  infraErrorRate?: number;
  infraErroredTrials?: number;
  total?: number;
  trials?: number;
}

interface RunLikeSummary {
  total?: number;
  passed?: number;
  failed?: number;
  errored?: number;
  passRate?: number;
  noQualitySignal?: boolean;
}

function asMTSummary(result: AnyResult): MultiTrialLikeSummary | undefined {
  const s = (result as unknown as { summary?: unknown }).summary;
  if (!s || typeof s !== "object") return undefined;
  const obj = s as MultiTrialLikeSummary;
  if ("meanPassRate" in obj || "trials" in obj || "passRateCI" in obj) return obj;
  return undefined;
}

function asRunSummary(result: AnyResult): RunLikeSummary | undefined {
  const s = (result as unknown as { summary?: unknown }).summary;
  if (!s || typeof s !== "object") return undefined;
  return s as RunLikeSummary;
}

/** Pass-rate accessor that works for RunResult or MultiTrialResult. */
export function getPassRate(result: AnyResult): number | undefined {
  const mt = asMTSummary(result);
  if (mt) {
    if (typeof mt.meanPassRate === "number") return mt.meanPassRate;
    if (typeof mt.pooledPassRate === "number") return mt.pooledPassRate;
    if (mt.passRateCI && typeof mt.passRateCI.point === "number") return mt.passRateCI.point;
  }
  const run = asRunSummary(result);
  if (run && typeof run.passRate === "number") return run.passRate;
  return undefined;
}

/** Infra-error rate accessor; returns 0 if not present. */
export function getInfraErrorRate(result: AnyResult): number {
  const mt = asMTSummary(result);
  if (mt && typeof mt.infraErrorRate === "number") return mt.infraErrorRate;
  return 0;
}

export interface QualitySummaryExpect {
  passRate?: number;
  infraErrorRate?: number;
  total?: number;
  trials?: number;
  noQualitySignal?: boolean;
}

/** Assert summary fields without coupling to layout. */
export function expectQualitySummary(
  result: AnyResult,
  expected: QualitySummaryExpect,
): void {
  if (expected.passRate !== undefined) {
    expect(getPassRate(result)).toBeCloseTo(expected.passRate, 6);
  }
  if (expected.infraErrorRate !== undefined) {
    expect(getInfraErrorRate(result)).toBeCloseTo(expected.infraErrorRate, 6);
  }
  if (expected.total !== undefined) {
    const s = (result as unknown as { summary: { total?: number } }).summary;
    expect(s.total).toBe(expected.total);
  }
  if (expected.trials !== undefined) {
    const s = (result as unknown as { summary: { trials?: number } }).summary;
    expect(s.trials).toBe(expected.trials);
  }
  if (expected.noQualitySignal !== undefined) {
    const run = asRunSummary(result);
    expect(run?.noQualitySignal ?? false).toBe(expected.noQualitySignal);
  }
}
