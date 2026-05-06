/**
 * Regression suite — compares a fresh variant run against a frozen "golden"
 * file on disk and detects drift via per-sample matchers + aggregate
 * statistical thresholds.
 *
 * # Why v2?
 *
 * The v1 golden stored ONLY aggregate `toolCallAccuracyMean`,
 * `instructionFollowingMean`, and `latencyMsMean`. That schema cannot detect:
 *   - the model returning semantically different text while making the
 *     expected tool call (response is unrelated garbage but still scores 1)
 *   - the tool call args drifting silently (name still matches but the
 *     payload changed)
 *   - the tool call ORDER changing (name set still matches, sequence does not)
 *   - regression on a single sample within a multi-sample matrix when other
 *     samples mask the change in the mean
 *
 * # v2 schema (the one we write today)
 *
 * ```
 * {
 *   schemaVersion: 2,
 *   variantId: string,
 *   model: string | null,
 *   capturedAt: ISO,
 *   // Per-sample observations. The key is the ORIGINAL caller-supplied
 *   // sample id (the variant-runner mangles ids per cell; we strip the
 *   // mangling before persisting).
 *   samples: {
 *     [sampleId]: {
 *       sampleId: string,
 *       trials: number,
 *       toolCallAccuracyMean: number,
 *       instructionFollowingMean: number,
 *       latencyMsMean: number,
 *       observations: [
 *         {
 *           trial: number,
 *           toolCallAccuracy: number,
 *           instructionFollowing: number,
 *           latencyMs: number,
 *           // SHA-256 of the normalized response text. Normalization strips
 *           // ISO timestamps, UUIDs, and IPs (see `normalizeResponse`).
 *           responseDigest: string,
 *           responseLength: number,
 *           // Tool calls in observed order. Args are reduced to a sorted
 *           // list of arg keys + a SHA-256 of the normalized JSON value
 *           // (so payload drift fails the digest-equal matcher but does
 *           // not require us to persist potentially-sensitive args verbatim).
 *           toolCallSequence: [
 *             { name: string, argKeys: string[], argDigest: string },
 *             ...
 *           ],
 *         },
 *         ...
 *       ],
 *     },
 *     ...
 *   },
 *   // Aggregates over ALL non-errored cells (sum across samples).
 *   toolCallAccuracyMean: number,
 *   instructionFollowingMean: number,
 *   latencyMsMean: number,
 *   trials: number,
 *   // True when the source matrix had at least one valid (non-errored) cell.
 *   // False when the matrix produced no quality signal at all (every cell
 *   // errored). Drift comparisons against a no-signal current return a
 *   // dedicated reason rather than "all metrics dropped to 0".
 *   hasQualitySignal: boolean,
 * }
 * ```
 *
 * # Comparison
 *
 * `compareToGolden()` runs three layers:
 *   1. Aggregate-mean check (same as v1) for top-line drift.
 *   2. Per-sample matcher check: the default matcher requires the
 *      tool-call NAME sequence to match (set by default; configurable to
 *      strict-order via `toolCallOrder: "strict"`). Quality-metric drops
 *      per sample are also checked against the configured threshold.
 *   3. Optional per-sample response matcher: `digest` (frozen exact),
 *      `length-tolerance` (LLM-text-friendly default), `regex`, or
 *      `contains`. Defaults to `length-tolerance` because LLM final text
 *      is rarely byte-stable.
 *
 * # v1 compatibility
 *
 * `readGolden()` accepts both v1 and v2 files. v1 files round-trip through
 * an upgrader that preserves the aggregate means but reports
 * `hasQualitySignal: trials > 0` and `samples: {}` (no per-sample data).
 * Comparisons against a v1 golden therefore fall back to aggregate-only
 * checks and emit a warning suggesting a regen.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createHash } from "node:crypto";
import type { ObservedToolCall } from "../../types.js";
import type { PromptTestMatrixResult, PromptTestResult } from "../types.js";

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

export interface PromptGoldenObservation {
  trial: number;
  toolCallAccuracy: number;
  instructionFollowing: number;
  latencyMs: number;
  responseDigest: string;
  responseLength: number;
  toolCallSequence: Array<{
    name: string;
    argKeys: string[];
    argDigest: string;
  }>;
}

export interface PromptGoldenSample {
  sampleId: string;
  trials: number;
  toolCallAccuracyMean: number;
  instructionFollowingMean: number;
  latencyMsMean: number;
  observations: PromptGoldenObservation[];
}

/** v2 golden — current canonical schema. */
export interface PromptGoldenV2 {
  schemaVersion: 2;
  variantId: string;
  model: string | null;
  toolCallAccuracyMean: number;
  instructionFollowingMean: number;
  latencyMsMean: number;
  trials: number;
  capturedAt: string;
  hasQualitySignal: boolean;
  samples: Record<string, PromptGoldenSample>;
  /**
   * Optional provenance metadata. Set by callers that capture goldens
   * outside the normal LIVE refresh path (e.g. synthetic starters,
   * fixture-based regression tests, or tooling-generated baselines).
   * Production goldens should omit this and capture via `REFRESH_GOLDEN=1`.
   */
  metadata?: PromptGoldenMetadata;
}

/** Provenance/source markers for a golden file. */
export interface PromptGoldenMetadata {
  /**
   *   "live"              — captured via REFRESH_GOLDEN=1 against a real LLM (production)
   *   "synthetic-starter" — hand-authored seed conforming to the v2 schema; intended
   *                         to be replaced with a real capture before being trusted
   *                         in CI gating
   *   "fixture"           — synthesized in unit tests; never compared against live runs
   */
  kind: "live" | "synthetic-starter" | "fixture";
  /** Free-text note explaining the source / regeneration command. */
  note?: string;
}

/** v1 golden — legacy aggregate-only baseline. Kept for back-compat reads. */
export interface PromptGoldenV1 {
  schemaVersion: 1;
  variantId: string;
  model: string | null;
  toolCallAccuracyMean: number;
  instructionFollowingMean: number;
  latencyMsMean: number;
  trials: number;
  capturedAt: string;
}

export type PromptGolden = PromptGoldenV2;

// ---------------------------------------------------------------------------
// Drift threshold
// ---------------------------------------------------------------------------

export interface DriftThreshold {
  /** Absolute drop in toolCallAccuracy that fails the regression check. */
  maxToolCallAccuracyDrop: number;
  /** Absolute drop in instructionFollowing that fails. */
  maxInstructionFollowingDrop: number;
  /** Latency multiplier above which drift is flagged (current > golden * x). */
  latencyMultiplier: number;
  /**
   * How to compare per-sample tool-call sequences.
   *   "set"     — same set of names (default; LLM tool selection is stable
   *               in practice; order is not).
   *   "strict"  — same order AND same names.
   *   "off"     — skip tool-call comparison entirely (aggregate-only).
   */
  toolCallMatch: "set" | "strict" | "off";
  /**
   * Whether tool-call ARGUMENT digests must match. Off by default because
   * LLMs frequently re-format args (whitespace, key casing, irrelevant
   * fields). Turn on when args are critical to the regression.
   */
  toolCallArgsMustMatch: boolean;
  /**
   * Per-sample response matcher.
   *   "length-tolerance" — current length within `responseLengthTolerance`
   *                        of golden length (default; LLM-friendly).
   *   "digest"           — current digest must equal golden digest.
   *   "off"              — skip response comparison.
   */
  responseMatch: "length-tolerance" | "digest" | "off";
  /** Fractional length tolerance used by `responseMatch: "length-tolerance"`. */
  responseLengthTolerance: number;
  /** Per-sample max drop on toolCallAccuracy / instructionFollowing. */
  perSampleMaxDrop: number;
}

export const DEFAULT_DRIFT_THRESHOLD: DriftThreshold = {
  maxToolCallAccuracyDrop: 0.15,
  maxInstructionFollowingDrop: 0.15,
  latencyMultiplier: 2.0,
  toolCallMatch: "set",
  toolCallArgsMustMatch: false,
  responseMatch: "length-tolerance",
  responseLengthTolerance: 0.5,
  perSampleMaxDrop: 0.5,
};

// ---------------------------------------------------------------------------
// Drift report
// ---------------------------------------------------------------------------

export interface DriftReport {
  passed: boolean;
  reasons: string[];
  golden: PromptGolden;
  current: PromptGolden;
  /** Per-sample drift detail (only for samples present in golden). */
  perSample: Array<{
    sampleId: string;
    passed: boolean;
    reasons: string[];
  }>;
  /** Schema notes (e.g. "comparing against v1 golden — regenerate"). */
  notes: string[];
}

// ---------------------------------------------------------------------------
// Normalization (deterministic stripping for digests / response compare)
// ---------------------------------------------------------------------------

const ISO_TIMESTAMP_RE =
  /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?\b/g;
const UUID_RE = /\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/g;
const IPV4_RE = /\b(?:25[0-5]|2[0-4]\d|[01]?\d\d?)(?:\.(?:25[0-5]|2[0-4]\d|[01]?\d\d?)){3}\b/g;

/**
 * Deterministic normalization for response digest computation.
 * Strips wall-clock timestamps, UUIDs, IPs, and collapses whitespace —
 * patterns that vary trivially between runs and would otherwise make every
 * digest unique.
 */
export function normalizeResponse(text: string): string {
  return text
    .replace(ISO_TIMESTAMP_RE, "<TS>")
    .replace(UUID_RE, "<UUID>")
    .replace(IPV4_RE, "<IP>")
    .replace(/\s+/g, " ")
    .trim();
}

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

function digestArgs(args: Record<string, unknown> | undefined): {
  argKeys: string[];
  argDigest: string;
} {
  if (!args || typeof args !== "object") {
    return { argKeys: [], argDigest: sha256("") };
  }
  const argKeys = Object.keys(args).sort();
  // Stable JSON: sort keys recursively for deterministic digest.
  const stable = JSON.stringify(stableSort(args));
  return { argKeys, argDigest: sha256(normalizeResponse(stable)) };
}

function stableSort(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableSort);
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(obj).sort()) out[k] = stableSort(obj[k]);
    return out;
  }
  return value;
}

// ---------------------------------------------------------------------------
// Sample-id mangling helpers
// ---------------------------------------------------------------------------

/**
 * The variant-runner mangles sample ids as `<id>::<variantId>::<model>`.
 * When persisting / comparing goldens we want the original caller-supplied
 * id so the same golden file remains valid across variant relabels.
 */
function unmangleSampleId(
  cellSampleId: string | undefined,
  variantId: string,
): string {
  if (!cellSampleId) return "<unknown>";
  // Strip the trailing `::<variantId>::<model>` (or `::default`) suffix.
  const idx = cellSampleId.indexOf(`::${variantId}::`);
  if (idx < 0) return cellSampleId;
  return cellSampleId.slice(0, idx);
}

// ---------------------------------------------------------------------------
// Aggregate (matrix → golden)
// ---------------------------------------------------------------------------

function buildSample(
  sampleId: string,
  cells: PromptTestResult[],
): PromptGoldenSample {
  const valid = cells.filter((c) => !c.errored);
  const trials = valid.length;
  const toolCallAccuracyMean =
    trials === 0 ? 0 : valid.reduce((a, c) => a + c.toolCallAccuracy, 0) / trials;
  const instructionFollowingMean =
    trials === 0 ? 0 : valid.reduce((a, c) => a + c.instructionFollowing, 0) / trials;
  const latencyMsMean =
    trials === 0 ? 0 : valid.reduce((a, c) => a + c.latencyMs, 0) / trials;
  const observations: PromptGoldenObservation[] = valid.map((c) => ({
    trial: c.trial,
    toolCallAccuracy: c.toolCallAccuracy,
    instructionFollowing: c.instructionFollowing,
    latencyMs: c.latencyMs,
    responseDigest: sha256(normalizeResponse(c.finalResponse)),
    responseLength: normalizeResponse(c.finalResponse).length,
    toolCallSequence: c.observedToolCalls.map((tc: ObservedToolCall) => {
      const { argKeys, argDigest } = digestArgs(tc.args);
      return { name: tc.name, argKeys, argDigest };
    }),
  }));
  return {
    sampleId,
    trials,
    toolCallAccuracyMean,
    instructionFollowingMean,
    latencyMsMean,
    observations,
  };
}

function aggregate(
  matrix: PromptTestMatrixResult,
  variantId: string,
  model: string | null,
): PromptGolden {
  const cells = matrix.cells.filter(
    (c) =>
      c.variantId === variantId &&
      (model === null || c.model === model || (model === "" && !c.model)),
  );
  const valid = cells.filter((c) => !c.errored);
  const trials = valid.length;
  const toolCallAccuracyMean =
    trials === 0 ? 0 : valid.reduce((a, c) => a + c.toolCallAccuracy, 0) / trials;
  const instructionFollowingMean =
    trials === 0 ? 0 : valid.reduce((a, c) => a + c.instructionFollowing, 0) / trials;
  const latencyMsMean =
    trials === 0 ? 0 : valid.reduce((a, c) => a + c.latencyMs, 0) / trials;

  // Group cells by ORIGINAL sample id (unmangled).
  const bySample = new Map<string, PromptTestResult[]>();
  for (const c of cells) {
    const id = unmangleSampleId(c.sampleId, variantId);
    let arr = bySample.get(id);
    if (!arr) {
      arr = [];
      bySample.set(id, arr);
    }
    arr.push(c);
  }
  const samples: Record<string, PromptGoldenSample> = {};
  for (const [id, cs] of bySample) samples[id] = buildSample(id, cs);

  return {
    schemaVersion: 2,
    variantId,
    model,
    toolCallAccuracyMean,
    instructionFollowingMean,
    latencyMsMean,
    trials,
    capturedAt: new Date().toISOString(),
    hasQualitySignal: trials > 0,
    samples,
  };
}

// ---------------------------------------------------------------------------
// Capture / read
// ---------------------------------------------------------------------------

export interface CaptureGoldenOptions {
  matrix: PromptTestMatrixResult;
  variantId: string;
  model?: string | null;
  goldenPath: string;
}

export function captureGolden(options: CaptureGoldenOptions): PromptGolden {
  const golden = aggregate(
    options.matrix,
    options.variantId,
    options.model ?? null,
  );
  const dir = dirname(resolve(options.goldenPath));
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(options.goldenPath, JSON.stringify(golden, null, 2) + "\n", "utf8");
  return golden;
}

interface RawGoldenWithVersion {
  schemaVersion?: number;
  [key: string]: unknown;
}

function upgradeV1(v1: PromptGoldenV1): PromptGolden {
  return {
    schemaVersion: 2,
    variantId: v1.variantId,
    model: v1.model,
    toolCallAccuracyMean: v1.toolCallAccuracyMean,
    instructionFollowingMean: v1.instructionFollowingMean,
    latencyMsMean: v1.latencyMsMean,
    trials: v1.trials,
    capturedAt: v1.capturedAt,
    hasQualitySignal: v1.trials > 0,
    samples: {}, // v1 has no per-sample data
  };
}

/** Accept both schema versions and return a normalized v2 for comparison. */
function normalizeForCompare(g: PromptGolden | PromptGoldenV1): PromptGolden {
  if (g.schemaVersion === 1) return upgradeV1(g);
  return g;
}

export function readGolden(goldenPath: string): PromptGolden | null {
  if (!existsSync(goldenPath)) return null;
  const raw = readFileSync(goldenPath, "utf8");
  const parsed = JSON.parse(raw) as RawGoldenWithVersion;
  if (parsed.schemaVersion === 1) {
    return upgradeV1(parsed as unknown as PromptGoldenV1);
  }
  if (parsed.schemaVersion === 2) {
    return parsed as unknown as PromptGoldenV2;
  }
  throw new Error(
    `readGolden: ${goldenPath} has unsupported schemaVersion ${String(parsed.schemaVersion)}`,
  );
}

// ---------------------------------------------------------------------------
// Compare
// ---------------------------------------------------------------------------

export interface CompareGoldenOptions {
  matrix: PromptTestMatrixResult;
  variantId: string;
  model?: string | null;
  goldenPath: string;
  threshold?: Partial<DriftThreshold>;
}

export function compareToGolden(options: CompareGoldenOptions): DriftReport {
  const golden = readGolden(options.goldenPath);
  if (!golden) {
    throw new Error(
      `compareToGolden: golden file not found at ${options.goldenPath} ` +
        `(set REFRESH_GOLDEN=1 and re-run to capture).`,
    );
  }
  const current = aggregate(options.matrix, options.variantId, options.model ?? null);
  return compareGoldens(golden, current, options.threshold);
}

export function compareGoldens(
  goldenInput: PromptGolden | PromptGoldenV1,
  currentInput: PromptGolden | PromptGoldenV1,
  threshold?: Partial<DriftThreshold>,
): DriftReport {
  const golden = normalizeForCompare(goldenInput);
  const current = normalizeForCompare(currentInput);
  const t = { ...DEFAULT_DRIFT_THRESHOLD, ...(threshold ?? {}) };
  const reasons: string[] = [];
  const notes: string[] = [];
  const perSample: DriftReport["perSample"] = [];

  // Distinguish "no quality signal" — every cell errored — from real drift.
  if (!current.hasQualitySignal) {
    reasons.push(
      "current run has no quality signal (every cell errored); cannot assess drift",
    );
    return { passed: false, reasons, golden, current, perSample, notes };
  }
  if (!golden.hasQualitySignal) {
    notes.push(
      "golden has no quality signal — comparing aggregates only; consider regenerating the golden against a known-good run",
    );
  }

  const accDrop = golden.toolCallAccuracyMean - current.toolCallAccuracyMean;
  const ifDrop = golden.instructionFollowingMean - current.instructionFollowingMean;
  if (accDrop > t.maxToolCallAccuracyDrop) {
    reasons.push(
      `aggregate toolCallAccuracy dropped by ${accDrop.toFixed(3)} (threshold ${t.maxToolCallAccuracyDrop})`,
    );
  }
  if (ifDrop > t.maxInstructionFollowingDrop) {
    reasons.push(
      `aggregate instructionFollowing dropped by ${ifDrop.toFixed(3)} (threshold ${t.maxInstructionFollowingDrop})`,
    );
  }
  if (
    golden.latencyMsMean > 0 &&
    current.latencyMsMean > golden.latencyMsMean * t.latencyMultiplier
  ) {
    reasons.push(
      `aggregate latencyMs increased ${(current.latencyMsMean / golden.latencyMsMean).toFixed(2)}x ` +
        `(threshold ${t.latencyMultiplier}x)`,
    );
  }

  // Per-sample comparison. Only enumerate samples present in golden — extra
  // samples in current are reported as a note (they cannot be regression).
  const goldenSampleIds = Object.keys(golden.samples);
  const currentSampleIds = new Set(Object.keys(current.samples));
  if (goldenSampleIds.length === 0) {
    notes.push(
      "golden has no per-sample data (legacy v1 golden); per-sample comparison skipped",
    );
  }
  for (const sid of goldenSampleIds) {
    const g = golden.samples[sid]!;
    const c = current.samples[sid];
    const sampleReasons: string[] = [];
    if (!c) {
      sampleReasons.push(`sample missing from current run`);
      perSample.push({ sampleId: sid, passed: false, reasons: sampleReasons });
      reasons.push(`sample '${sid}': missing from current run`);
      continue;
    }
    // Aggregate-per-sample drops
    const sAccDrop = g.toolCallAccuracyMean - c.toolCallAccuracyMean;
    const sIfDrop = g.instructionFollowingMean - c.instructionFollowingMean;
    if (sAccDrop > t.perSampleMaxDrop) {
      sampleReasons.push(
        `toolCallAccuracy dropped by ${sAccDrop.toFixed(3)} (threshold ${t.perSampleMaxDrop})`,
      );
    }
    if (sIfDrop > t.perSampleMaxDrop) {
      sampleReasons.push(
        `instructionFollowing dropped by ${sIfDrop.toFixed(3)} (threshold ${t.perSampleMaxDrop})`,
      );
    }

    // Tool-call sequence comparison (compare per-trial, take the best
    // golden-vs-current pair index match).
    if (t.toolCallMatch !== "off" && g.observations.length > 0) {
      const trialsToCheck = Math.min(g.observations.length, c.observations.length);
      let mismatchedTrials = 0;
      for (let i = 0; i < trialsToCheck; i++) {
        const go = g.observations[i]!;
        const co = c.observations[i]!;
        const ok = matchToolSequence(go, co, t);
        if (!ok) mismatchedTrials++;
      }
      if (mismatchedTrials > 0) {
        sampleReasons.push(
          `tool-call sequence mismatch in ${mismatchedTrials}/${trialsToCheck} trial(s) ` +
            `(matcher=${t.toolCallMatch}, argsMustMatch=${String(t.toolCallArgsMustMatch)})`,
        );
      }
    }

    // Response matcher
    if (t.responseMatch !== "off" && g.observations.length > 0) {
      const trialsToCheck = Math.min(g.observations.length, c.observations.length);
      let mismatchedTrials = 0;
      for (let i = 0; i < trialsToCheck; i++) {
        const go = g.observations[i]!;
        const co = c.observations[i]!;
        if (!matchResponse(go, co, t)) mismatchedTrials++;
      }
      if (mismatchedTrials > 0) {
        sampleReasons.push(
          `response ${t.responseMatch} mismatch in ${mismatchedTrials}/${trialsToCheck} trial(s)`,
        );
      }
    }

    perSample.push({
      sampleId: sid,
      passed: sampleReasons.length === 0,
      reasons: sampleReasons,
    });
    for (const r of sampleReasons) reasons.push(`sample '${sid}': ${r}`);
  }

  // Extra samples in current (not in golden) — note only.
  for (const sid of currentSampleIds) {
    if (!golden.samples[sid]) {
      notes.push(`sample '${sid}' present in current run but not in golden`);
    }
  }

  return { passed: reasons.length === 0, reasons, golden, current, perSample, notes };
}

function matchToolSequence(
  golden: PromptGoldenObservation,
  current: PromptGoldenObservation,
  t: DriftThreshold,
): boolean {
  const g = golden.toolCallSequence;
  const c = current.toolCallSequence;
  if (t.toolCallMatch === "strict") {
    if (g.length !== c.length) return false;
    for (let i = 0; i < g.length; i++) {
      if (g[i]!.name !== c[i]!.name) return false;
      if (t.toolCallArgsMustMatch && g[i]!.argDigest !== c[i]!.argDigest) return false;
    }
    return true;
  }
  // "set" matcher
  const gNames = new Map<string, number>();
  for (const x of g) gNames.set(x.name, (gNames.get(x.name) ?? 0) + 1);
  const cNames = new Map<string, number>();
  for (const x of c) cNames.set(x.name, (cNames.get(x.name) ?? 0) + 1);
  if (gNames.size !== cNames.size) return false;
  for (const [name, count] of gNames) {
    if (cNames.get(name) !== count) return false;
  }
  if (t.toolCallArgsMustMatch) {
    // Multiset of argDigests
    const gd = g.map((x) => x.argDigest).sort();
    const cd = c.map((x) => x.argDigest).sort();
    if (gd.length !== cd.length) return false;
    for (let i = 0; i < gd.length; i++) if (gd[i] !== cd[i]) return false;
  }
  return true;
}

function matchResponse(
  golden: PromptGoldenObservation,
  current: PromptGoldenObservation,
  t: DriftThreshold,
): boolean {
  if (t.responseMatch === "digest") {
    return golden.responseDigest === current.responseDigest;
  }
  if (t.responseMatch === "length-tolerance") {
    if (golden.responseLength === 0) return current.responseLength === 0;
    const ratio = Math.abs(current.responseLength - golden.responseLength) / golden.responseLength;
    return ratio <= t.responseLengthTolerance;
  }
  return true;
}

/**
 * Synthetic drift detector for unit tests / CI canary: takes a base matrix
 * and produces a "degraded" copy where toolCallAccuracy is forced to 0.
 */
export function syntheticallyDegrade(
  matrix: PromptTestMatrixResult,
): PromptTestMatrixResult {
  const cells: PromptTestResult[] = matrix.cells.map((c) => ({
    ...c,
    toolCallAccuracy: 0,
    instructionFollowing: 0,
  }));
  return { ...matrix, cells };
}
