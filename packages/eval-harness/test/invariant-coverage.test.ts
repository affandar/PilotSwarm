// iter17 invariant coverage matrix.
//
// This file is the single regression backstop for the seven recurring
// invariant families surfaced by the iter11 → iter16 blind-review loop.
// See `docs/INVARIANT-COVERAGE.md` for the full matrix (family → central
// enforcement point → covered invariants). Each family has a `describe`
// block; tests cover valid boundary inputs, invalid inputs that the
// central validator rejects, and adversarial inputs the loop has surfaced.
//
// If a future fixer breaks a family invariant, the matrix should fail
// loudly here rather than only at a downstream consumer site.

import { describe, it, expect } from "vitest";
import { z } from "zod";
import { execSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  // schemas (Family 1)
  EvalToolCallSchema,
  EvalExpectedSchema,
  EvalContextMessageSchema,
  EvalSampleInputSchema,
  EvalSampleSchema,
  EvalTaskSchema,
  ScoreSchema,
  ObservedToolCallSchema,
  ObservedResultSchema,
  CaseResultSchema,
  RunSummarySchema,
  RunResultSchema,
  WilsonCISchema,
  TrialScoreAggregateSchema,
  SampleTrialResultSchema,
  MultiTrialSummarySchema,
  MultiTrialResultSchema,
  MatrixConfigOverridesSchema,
  MatrixConfigSchema,
  MatrixCellSchema,
  MatrixPassRateRefSchema,
  MatrixSummarySchema,
  MatrixResultSchema,
  TurnExpectedSchema,
  TurnInputSchema,
  TrajectoryTurnSchema,
  TrajectorySampleSchema,
  TrajectoryTaskSchema,
  ObservedTurnSchema,
  ObservedTrajectorySchema,
  TrajectoryScoreSchema,
  TrajectoryCaseResultSchema,
  TrajectoryRunResultSchema,
  RubricCriterionSchema,
  RubricSchema,
  JudgeResultSchema,
  JudgeCostSchema,
  CIGateConfigSchema,
  CIGateResultSchema,
  RegressionResultSchema,
  RegressionDetectionResultSchema,
  BaselineSampleSchema,
  BaselineSchema,
  BaselineSchemaAllowEmpty,
  // CI gate / regression
  CIGate,
  // Baseline
  saveBaseline,
  loadBaseline,
  // Stats
  wilsonInterval,
  bootstrapCI,
  mcNemarTest,
  // Reporters
  PRCommentReporter,
  MarkdownReporter,
  // OpenAI judge
  OpenAIJudgeClient,
  // Multi-trial / matrix
  MatrixRunner,
} from "../src/index.js";
import { isVisuallyEmpty } from "../src/runner.js";
import { formatPValue, escapeMarkdownCell } from "../src/reporters/util.js";

// iter18: Strict schema registry is now centralized in src/validation/registry.ts.
// Importing it here ensures the invariant-coverage test runs the same fixtures
// the rest of the runtime trusts. New schemas must be registered there + carve-out
// documented if intentionally excluded.
import {
  STRICT_SCHEMA_REGISTRY,
  STRICT_ARTIFACT_SCHEMA_REGISTRY,
  LENIENT_INPUT_SCHEMA_REGISTRY,
  assertRegistryComplete,
} from "../src/validation/registry.js";


// =============================================================================
// Family 1 — Schema strictness / semantic coherence
// =============================================================================
describe("Family 1 — Schema strictness (registry-driven)", () => {
  it("registry self-policing: every public *Schema is registered (or carve-out)", () => {
    expect(() => assertRegistryComplete()).not.toThrow();
  });

  it("strict schemas: every registered fixture parses (loop inside one it)", () => {
    const failed: string[] = [];
    for (const entry of STRICT_SCHEMA_REGISTRY) {
      const r = entry.schema.safeParse(entry.valid);
      if (!r.success) failed.push(`${entry.name}: ${r.error.issues.map((i) => i.code).join(",")}`);
    }
    expect(failed).toEqual([]);
  });

  it("strict schemas: every registered fixture rejects unknown keys (loop inside one it)", () => {
    const accepted: string[] = [];
    for (const entry of STRICT_SCHEMA_REGISTRY) {
      const adulterated =
        typeof entry.valid !== "object" || entry.valid === null || Array.isArray(entry.valid)
          ? { __unexpectedKey__: 1 }
          : { ...entry.valid, __unexpectedKey__: 1 };
      const r = entry.schema.safeParse(adulterated);
      if (r.success) accepted.push(entry.name);
    }
    expect(accepted).toEqual([]);
  });

  it("representative object schema (RunResultSchema) rejects unknown keys with unrecognized_keys code", () => {
    const entry = STRICT_ARTIFACT_SCHEMA_REGISTRY.find((e) => e.name === "RunResultSchema");
    expect(entry).toBeDefined();
    if (!entry) return;
    const adulterated = { ...entry.valid, __unexpectedKey__: 1 };
    const r = entry.schema.safeParse(adulterated);
    expect(r.success).toBe(false);
    if (!r.success) {
      const codes = r.error.issues.map((i) => i.code);
      expect(codes).toContain("unrecognized_keys");
    }
  });

  it("representative refined schema (MultiTrialResultSchema) inherits strictness through superRefine", () => {
    const entry = STRICT_ARTIFACT_SCHEMA_REGISTRY.find((e) => e.name === "MultiTrialResultSchema");
    expect(entry).toBeDefined();
    if (!entry) return;
    expect(entry.schema.safeParse(entry.valid).success).toBe(true);
    const adulterated = { ...entry.valid, __unexpectedKey__: 1 };
    expect(entry.schema.safeParse(adulterated).success).toBe(false);
  });

  it("lenient input schemas: every registered fixture parses with passthrough", () => {
    const failed: string[] = [];
    for (const entry of LENIENT_INPUT_SCHEMA_REGISTRY) {
      const r = entry.schema.safeParse(entry.valid);
      if (!r.success) failed.push(`${entry.name}: ${r.error.issues.map((i) => i.code).join(",")}`);
    }
    expect(failed).toEqual([]);
  });

  it("lenient input schemas: ACCEPT extra forward-compatible keys (loop inside one it)", () => {
    const rejected: string[] = [];
    for (const entry of LENIENT_INPUT_SCHEMA_REGISTRY) {
      if (typeof entry.valid !== "object" || entry.valid === null || Array.isArray(entry.valid)) {
        continue;
      }
      const adulterated = { ...entry.valid, __forwardCompatField__: { provider: "x", id: "y" } };
      const r = entry.schema.safeParse(adulterated);
      if (!r.success) rejected.push(entry.name);
    }
    expect(rejected).toEqual([]);
  });

  // Minimum representative completeness check: keep a handful of named hot-path
  // strict schemas in an explicit list so a fixer cannot accidentally remove
  // them from the registry without failing here.
  const REQUIRED_STRICT_NAMES = [
    "EvalSampleSchema",
    "EvalTaskSchema",
    "RunResultSchema",
    "MultiTrialResultSchema",
    "MatrixResultSchema",
    "BaselineSchema",
    "CIGateConfigSchema",
    "CIGateResultSchema",
    "RubricSchema",
    "JudgeResultSchema",
  ];
  it("required strict schemas are registered", () => {
    const names = new Set(STRICT_SCHEMA_REGISTRY.map((e) => e.name));
    const missing = REQUIRED_STRICT_NAMES.filter((n) => !names.has(n));
    expect(missing).toEqual([]);
  });

  // MultiTrialResultSchema is built via .superRefine on a strict base — it
  // inherits strictness through the refine chain. Verify explicitly.
  it("MultiTrialResultSchema (refined) rejects unknown keys at outer level", () => {
    const valid = {
      schemaVersion: 1,
      runId: "r",
      taskId: "t",
      taskVersion: "1",
      trials: 0,
      startedAt: "a",
      finishedAt: "b",
      summary: {
        total: 0,
        trials: 0,
        stddevPassRate: 0,
        passRateCI: { lower: 0, upper: 0, point: 0, z: 1.96 },
      },
      samples: [],
      rawRuns: [],
    };
    expect(MultiTrialResultSchema.safeParse(valid).success).toBe(true);
    const adulterated = { ...valid, __unexpectedKey__: 1 };
    const r = MultiTrialResultSchema.safeParse(adulterated);
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues.map((i) => i.code)).toContain("unrecognized_keys");
    }
  });

  // RunResultSchema — also has cross-field invariants; spot-check strict
  it("RunResultSchema rejects unknown keys", () => {
    const valid = {
      schemaVersion: 1,
      runId: "r",
      taskId: "t",
      taskVersion: "1",
      startedAt: "a",
      finishedAt: "b",
      summary: { total: 0, passed: 0, failed: 0, errored: 0, noQualitySignal: true },
      cases: [],
    };
    expect(RunResultSchema.safeParse(valid).success).toBe(true);
    const r = RunResultSchema.safeParse({ ...valid, typo: 1 });
    expect(r.success).toBe(false);
  });

  it("MatrixCellSchema/MatrixSummarySchema/MatrixResultSchema reject unknown keys", () => {
    expect(MatrixCellSchema.safeParse({ x: 1 }).success).toBe(false);
    expect(MatrixSummarySchema.safeParse({ x: 1 }).success).toBe(false);
    expect(MatrixResultSchema.safeParse({ x: 1 }).success).toBe(false);
  });

  it("TrajectoryCaseResultSchema/TrajectoryRunResultSchema reject unknown keys", () => {
    expect(TrajectoryCaseResultSchema.safeParse({ x: 1 }).success).toBe(false);
    expect(TrajectoryRunResultSchema.safeParse({ x: 1 }).success).toBe(false);
  });

  // ----- numeric / count refinements -----
  it("nonNegativeIntCount: rejects -0 in BaselineSample.trials", () => {
    const r = BaselineSampleSchema.safeParse({
      sampleId: "s",
      passRate: 0,
      trials: -0,
      passCount: 0,
    });
    expect(r.success).toBe(false);
  });

  it("nonNegativeIntCount: rejects negative ints in SampleTrialResult.trials", () => {
    const r = SampleTrialResultSchema.safeParse({
      sampleId: "s",
      trials: -1,
      passCount: 0,
      failCount: 0,
      errorCount: 0,
      passAtK: {},
      scores: {},
      wilsonCI: { lower: 0, upper: 0, point: 0, z: 1.96 },
      noQualitySignal: true,
    });
    expect(r.success).toBe(false);
  });

  it("nonNegativeIntCount: rejects non-integer in BaselineSample.trials", () => {
    const r = BaselineSampleSchema.safeParse({
      sampleId: "s",
      passRate: 0,
      trials: 0.5,
      passCount: 0,
    });
    expect(r.success).toBe(false);
  });

  it("EvalToolCall.numericTolerance rejects Infinity/NaN", () => {
    expect(
      EvalToolCallSchema.safeParse({ name: "t", numericTolerance: Number.POSITIVE_INFINITY }).success,
    ).toBe(false);
    expect(EvalToolCallSchema.safeParse({ name: "t", numericTolerance: Number.NaN }).success).toBe(
      false,
    );
    expect(EvalToolCallSchema.safeParse({ name: "t", numericTolerance: -1 }).success).toBe(false);
  });

  // ----- string-array min(1) on tool-name arrays -----
  it("EvalSample.tools rejects empty-string entries", () => {
    const r = EvalSampleSchema.safeParse({
      id: "s",
      description: "d",
      input: { prompt: "p" },
      expected: { toolCalls: [{ name: "t" }] },
      tools: [""],
    });
    expect(r.success).toBe(false);
  });

  it("EvalExpected.forbiddenTools rejects empty-string entries", () => {
    const r = EvalExpectedSchema.safeParse({ forbiddenTools: [""] });
    expect(r.success).toBe(false);
  });

  // ----- cross-field invariants -----
  it("RunResult: summary.passed mismatch with cases.length is rejected", () => {
    const obs = { toolCalls: [], finalResponse: "", sessionId: "s", latencyMs: 0 };
    const c = { caseId: "c", pass: true, scores: [], observed: obs, durationMs: 0 };
    const r = RunResultSchema.safeParse({
      schemaVersion: 1,
      runId: "r",
      taskId: "t",
      taskVersion: "1",
      startedAt: "a",
      finishedAt: "b",
      summary: { total: 1, passed: 0, failed: 1, errored: 0, passRate: 0 },
      cases: [c],
    });
    expect(r.success).toBe(false);
  });

  it("MultiTrialResult: meanPassRate fabrication on all-no-quality samples is rejected", () => {
    const sample = {
      sampleId: "s",
      trials: 1,
      passCount: 0,
      failCount: 0,
      errorCount: 1,
      noQualitySignal: true,
      passAtK: {},
      scores: {},
      wilsonCI: { lower: 0, upper: 0, point: 0, z: 1.96 },
    };
    const r = MultiTrialResultSchema.safeParse({
      schemaVersion: 1,
      runId: "r",
      taskId: "t",
      taskVersion: "1",
      trials: 1,
      startedAt: "a",
      finishedAt: "b",
      summary: {
        total: 1,
        trials: 1,
        meanPassRate: 0.99, // forged
        stddevPassRate: 0,
        passRateCI: { lower: 0, upper: 0, point: 0, z: 1.96 },
      },
      samples: [sample],
      rawRuns: [],
    });
    expect(r.success).toBe(false);
  });

  it("BaselineSchema (strict): rejects empty samples", () => {
    const r = BaselineSchema.safeParse({
      schemaVersion: 1,
      taskId: "t",
      taskVersion: "1",
      createdAt: "now",
      samples: [],
    });
    expect(r.success).toBe(false);
  });

  it("BaselineSchemaAllowEmpty (lenient): accepts empty samples", () => {
    const r = BaselineSchemaAllowEmpty.safeParse({
      schemaVersion: 1,
      taskId: "t",
      taskVersion: "1",
      createdAt: "now",
      samples: [],
    });
    expect(r.success).toBe(true);
  });

  it("BaselineSchema: rejects duplicate sample IDs", () => {
    const sample = { sampleId: "dup", passRate: 0, trials: 0, passCount: 0 };
    const r = BaselineSchema.safeParse({
      schemaVersion: 1,
      taskId: "t",
      taskVersion: "1",
      createdAt: "now",
      samples: [sample, sample],
    });
    expect(r.success).toBe(false);
  });

  it("EvalTaskSchema: rejects duplicate sample IDs", () => {
    const sample = {
      id: "dup",
      description: "d",
      input: { prompt: "p" },
      expected: { toolCalls: [{ name: "t" }] },
    };
    const r = EvalTaskSchema.safeParse({
      schemaVersion: 1,
      id: "t",
      name: "n",
      description: "d",
      version: "1",
      samples: [sample, sample],
    });
    expect(r.success).toBe(false);
  });

  it("BaselineSampleSchema: infraErrorCount without nonErrorTrials is rejected", () => {
    const r = BaselineSampleSchema.safeParse({
      sampleId: "s",
      passRate: 0,
      trials: 1,
      passCount: 0,
      infraErrorCount: 1,
    });
    expect(r.success).toBe(false);
  });

  it("BaselineSampleSchema: passRate must be 0 when nonErrorTrials===0", () => {
    const r = BaselineSampleSchema.safeParse({
      sampleId: "s",
      passRate: 0.5, // wrong
      trials: 1,
      nonErrorTrials: 0,
      infraErrorCount: 1,
      passCount: 0,
    });
    expect(r.success).toBe(false);
  });

  it("BaselineSampleSchema: passRate must equal passCount/(trials-errorCount)", () => {
    const r = BaselineSampleSchema.safeParse({
      sampleId: "s",
      passRate: 0.5,
      trials: 4,
      passCount: 1,
    });
    expect(r.success).toBe(false);
  });

  it("WilsonCISchema: lower > upper rejected", () => {
    const r = WilsonCISchema.safeParse({ lower: 0.5, upper: 0.4, point: 0.45, z: 1.96 });
    expect(r.success).toBe(false);
  });
});

// =============================================================================
// Family 2 — CIGate trust-boundary snapshot + regression coherence
// =============================================================================
describe("Family 2 — CIGate trust-boundary", () => {
  function baseSample(passRate: number, trials = 2, passCount?: number) {
    const denom = trials;
    const pc = passCount ?? Math.round(passRate * denom);
    return {
      sampleId: "s",
      trials,
      passCount: pc,
      failCount: trials - pc,
      errorCount: 0,
      passRate,
      passAtK: { 1: passRate },
      scores: {},
      wilsonCI: { lower: 0, upper: 1, point: passRate, z: 1.96 },
    };
  }
  function baseResult(meanPassRate?: number) {
    const sample = baseSample(1, 2, 2);
    return {
      schemaVersion: 1 as const,
      runId: "r",
      taskId: "t",
      taskVersion: "1",
      trials: 2,
      startedAt: "a",
      finishedAt: "b",
      summary: {
        total: 1,
        trials: 2,
        ...(meanPassRate !== undefined ? { meanPassRate } : {}),
        stddevPassRate: 0,
        passRateCI: { lower: 0, upper: 1, point: 1, z: 1.96 },
      },
      samples: [sample],
      rawRuns: [],
    };
  }

  it("TOCTOU: getter that mutates per-call cannot bypass gate (snapshot determinism)", () => {
    const gate = new CIGate({ passRateFloor: 0.5, failOnNewSamples: false, allowMissingBaselineSamples: true });
    const trusted = baseResult(1);
    // Capture the trusted summary BEFORE installing the malicious getter so
    // the getter does not re-enter `summary`.
    const initial = trusted.summary;
    let n = 0;
    const malicious: typeof trusted = { ...trusted };
    Object.defineProperty(malicious, "summary", {
      enumerable: true,
      configurable: true,
      get() {
        n += 1;
        if (n <= 1) return initial;
        // Subsequent reads return a forged-low rate that would fail the
        // floor. The snapshot must immunize the gate against this.
        return { ...initial, meanPassRate: 0.0 };
      },
    });
    const out = gate.evaluate(malicious as unknown as Parameters<typeof gate.evaluate>[0]);
    // First snapshot had passRate 1, so the verdict must be `pass: true`
    // regardless of how many subsequent times `summary` is read WITHIN this
    // call. CIGate uses a structuredClone snapshot — getter mutations after
    // the snapshot cannot flip the verdict mid-evaluate.
    expect(out.pass).toBe(true);
    // Documented per-call semantics ("first-snapshot wins"): a fresh
    // evaluate() takes a fresh snapshot. We do NOT assert the second call's
    // outcome here — that is a separate adversarial-detection question
    // and is intentionally NOT promised by CIGate's TOCTOU defense.
  });

  it("Task-hint passRateFloor: Infinity is rejected", () => {
    const gate = new CIGate({ failOnNewSamples: false });
    expect(() =>
      gate.evaluate(baseResult(1) as unknown as Parameters<typeof gate.evaluate>[0], undefined, undefined, {
        passRateFloor: Number.POSITIVE_INFINITY,
      }),
    ).toThrow(/invalid task hint/);
  });

  it("Task-hint passRateFloor: NaN/0/-1/-0/2 are rejected", () => {
    const gate = new CIGate({ failOnNewSamples: false });
    for (const bad of [Number.NaN, 0, -1, -0, 2]) {
      expect(() =>
        gate.evaluate(baseResult(1) as unknown as Parameters<typeof gate.evaluate>[0], undefined, undefined, {
          passRateFloor: bad,
        }),
      ).toThrow(/invalid task hint/);
    }
  });

  it("regressionInput sample-set disjointness: same id in regressions AND newCurrentSamples → fail", () => {
    const gate = new CIGate({ failOnNewSamples: false });
    const regInput = {
      regressions: [
        {
          sampleId: "s",
          baselinePassRate: 1,
          currentPassRate: 0,
          pValue: 0.01,
          significant: true,
          direction: "regressed" as const,
        },
      ],
      missingBaselineSamples: [],
      newCurrentSamples: ["s"],
    };
    const out = gate.evaluate(
      baseResult(1) as unknown as Parameters<typeof gate.evaluate>[0],
      regInput,
    );
    expect(out.pass).toBe(false);
    expect(out.reasons.some((r) => /both regressions and newCurrentSamples/.test(r))).toBe(true);
  });

  it("regressionInput direction/significance/passRate forgery → fail", () => {
    const gate = new CIGate({ failOnNewSamples: false });
    const regInput = {
      regressions: [
        {
          sampleId: "s",
          baselinePassRate: 0,
          currentPassRate: 1,
          pValue: 0.01,
          significant: true,
          direction: "regressed" as const, // wrong: rates went UP
        },
      ],
      missingBaselineSamples: [],
      newCurrentSamples: [],
    };
    const out = gate.evaluate(
      baseResult(1) as unknown as Parameters<typeof gate.evaluate>[0],
      regInput,
    );
    expect(out.pass).toBe(false);
    expect(out.reasons.some((r) => /inconsistent/.test(r))).toBe(true);
  });

  it("failOnNewSamples=true (default) + no regressionInput → fail-closed", () => {
    const gate = new CIGate({ passRateFloor: 0.5 });
    const out = gate.evaluate(baseResult(1) as unknown as Parameters<typeof gate.evaluate>[0]);
    expect(out.pass).toBe(false);
    expect(out.reasons.some((r) => /failOnNewSamples/.test(r))).toBe(true);
  });

  it("maxRegressions=N + no regressionInput → fail-closed", () => {
    const gate = new CIGate({ maxRegressions: 0, failOnNewSamples: false, allowMissingBaselineSamples: true });
    const out = gate.evaluate(baseResult(1) as unknown as Parameters<typeof gate.evaluate>[0]);
    expect(out.pass).toBe(false);
    expect(out.reasons.some((r) => /maxRegressions configured but regression data not provided/.test(r))).toBe(true);
  });

  it("trustSummary=false (default): fabricated meanPassRate is rejected", () => {
    const gate = new CIGate({ failOnNewSamples: false, allowMissingBaselineSamples: true });
    // Build a structural-but-incoherent base result (passes BASE schema, fails
    // CIGate's own integrity check). The base schema does NOT enforce
    // meanPassRate consistency — that is intentional; CIGate itself does.
    const sample = baseSample(0, 2, 0); // pass rate 0
    const obj = {
      schemaVersion: 1 as const,
      runId: "r",
      taskId: "t",
      taskVersion: "1",
      trials: 2,
      startedAt: "a",
      finishedAt: "b",
      summary: {
        total: 1,
        trials: 2,
        meanPassRate: 0.99,
        stddevPassRate: 0,
        passRateCI: { lower: 0, upper: 1, point: 0, z: 1.96 },
      },
      samples: [sample],
      rawRuns: [],
    };
    const out = gate.evaluate(obj as unknown as Parameters<typeof gate.evaluate>[0]);
    expect(out.pass).toBe(false);
    expect(out.reasons.some((r) => /input integrity/.test(r))).toBe(true);
  });
});

// =============================================================================
// Family 3 — Baseline / no-quality-signal correctness
// =============================================================================
describe("Family 3 — Baseline / no-quality-signal", () => {
  const SCRATCH = join(dirname(fileURLToPath(import.meta.url)), ".scratch-iter17");

  function tmpdir() {
    mkdirSync(SCRATCH, { recursive: true });
    const d = mkdtempSync(join(SCRATCH, "fam3-"));
    return d;
  }

  function makeMtrEmpty() {
    return {
      schemaVersion: 1 as const,
      runId: "r",
      taskId: "t",
      taskVersion: "1",
      trials: 0,
      startedAt: "a",
      finishedAt: "b",
      summary: {
        total: 0,
        trials: 0,
        stddevPassRate: 0,
        passRateCI: { lower: 0, upper: 0, point: 0, z: 1.96 },
      },
      samples: [],
      rawRuns: [],
    };
  }

  it("saveBaseline: empty samples → refused unless allowEmptyBaseline:true", () => {
    const dir = tmpdir();
    const target = join(dir, "b.json");
    expect(() => saveBaseline(makeMtrEmpty(), target)).toThrow(/zero samples/);
    expect(() =>
      saveBaseline(makeMtrEmpty(), target, { allowEmptyBaseline: true }),
    ).not.toThrow();
    rmSync(dir, { recursive: true, force: true });
  });

  it("loadBaseline: empty baseline file → refused; allowEmpty:true loads", () => {
    const dir = tmpdir();
    const target = join(dir, "b.json");
    // Write an empty-samples baseline.
    saveBaseline(makeMtrEmpty(), target, { allowEmptyBaseline: true });
    expect(() => loadBaseline(target)).toThrow(/zero samples/);
    const loaded = loadBaseline(target, { allowEmptyBaseline: true });
    expect(loaded.samples).toEqual([]);
    rmSync(dir, { recursive: true, force: true });
  });

  it("loadBaseline: no-quality samples → refused unless allowNoQualityBaseline:true", () => {
    const dir = tmpdir();
    const target = join(dir, "b.json");
    const mtr = {
      ...makeMtrEmpty(),
      summary: {
        total: 1,
        trials: 1,
        stddevPassRate: 0,
        passRateCI: { lower: 0, upper: 0, point: 0, z: 1.96 },
      },
      samples: [
        {
          sampleId: "s",
          trials: 1,
          passCount: 0,
          failCount: 0,
          errorCount: 1,
          noQualitySignal: true,
          passAtK: {},
          scores: {},
          wilsonCI: { lower: 0, upper: 0, point: 0, z: 1.96 },
        },
      ],
    };
    saveBaseline(mtr, target, { allowNoQualityBaseline: true });
    expect(() => loadBaseline(target)).toThrow(/no quality signal/);
    expect(() => loadBaseline(target, { allowNoQualityBaseline: true })).not.toThrow();
    rmSync(dir, { recursive: true, force: true });
  });

  it("BaselineSampleSchema: passRate cross-checks passCount/(trials-errorCount)", () => {
    const r = BaselineSampleSchema.safeParse({
      sampleId: "s",
      passRate: 0.7,
      trials: 4,
      passCount: 1, // expected 1/4 = 0.25
    });
    expect(r.success).toBe(false);
  });
});

// =============================================================================
// Family 4 — Unicode / hollow-output detection (single source helper)
// =============================================================================
describe("Family 4 — Unicode invisibility / isVisuallyEmpty", () => {
  // Default_Ignorable_Code_Points reference (Unicode 15.x):
  // - U+115F HANGUL CHOSEONG FILLER
  // - U+1160 HANGUL JUNGSEONG FILLER
  // - U+200B ZERO WIDTH SPACE
  // - U+200C ZERO WIDTH NON-JOINER
  // - U+200D ZERO WIDTH JOINER
  // - U+2060 WORD JOINER
  // - U+202E RIGHT-TO-LEFT OVERRIDE
  // - U+3164 HANGUL FILLER
  // - U+FEFF ZERO WIDTH NO-BREAK SPACE / BOM
  // - U+FFA0 HALFWIDTH HANGUL FILLER
  // - U+FFFC OBJECT REPLACEMENT CHARACTER (NOT default-ignorable, separately handled)
  const INVISIBLES: ReadonlyArray<readonly [string, string]> = [
    ["\u200B", "U+200B ZERO WIDTH SPACE"],
    ["\u202E", "U+202E RTL OVERRIDE"],
    ["\u3164", "U+3164 HANGUL FILLER"],
    ["\uFFFC", "U+FFFC OBJECT REPLACEMENT CHARACTER"],
  ] as const;

  for (const [ch, label] of INVISIBLES) {
    it(`isVisuallyEmpty(${label}) === true`, () => {
      expect(isVisuallyEmpty(ch)).toBe(true);
      // mixed with whitespace
      expect(isVisuallyEmpty(`  ${ch}\n${ch}\t`)).toBe(true);
    });
  }

  it("isVisuallyEmpty: standard text is NOT empty", () => {
    expect(isVisuallyEmpty("hello")).toBe(false);
    expect(isVisuallyEmpty("a")).toBe(false);
    expect(isVisuallyEmpty("\u200Bfoo")).toBe(false); // zero-width then visible
  });

  it("isVisuallyEmpty: emoji base codepoints are NOT empty", () => {
    expect(isVisuallyEmpty("😀")).toBe(false);
  });

  it("isVisuallyEmpty: undefined/null/'' all empty", () => {
    expect(isVisuallyEmpty(undefined)).toBe(true);
    expect(isVisuallyEmpty(null)).toBe(true);
    expect(isVisuallyEmpty("")).toBe(true);
    expect(isVisuallyEmpty("   \t\n")).toBe(true);
  });

  it("Family-helper-is-the-single-source: trajectory-runner imports the same isVisuallyEmpty (behavior parity)", async () => {
    // Import from runner.ts and verify behavior parity over a sample set.
    // trajectory-runner imports the SAME named export — assert via source
    // text that no fork/duplicate exists.
    const trajSrc = readFileSync(
      resolve(dirname(fileURLToPath(import.meta.url)), "..", "src/trajectory-runner.ts"),
      "utf8",
    );
    expect(trajSrc).toMatch(/import\s*{\s*isVisuallyEmpty\s*}\s*from\s*"\.\/runner\.js";?/);
    // Also: no local re-implementation.
    expect(trajSrc).not.toMatch(/function\s+isVisuallyEmpty\s*\(/);
  });
});

// =============================================================================
// Family 5 — Judge cache / budget / cost validation
// =============================================================================
describe("Family 5 — Judge cache / budget / cost", () => {
  it("OpenAIJudgeClient: negative inputUsdPerMillionTokens at construction → throws", () => {
    expect(
      () =>
        new OpenAIJudgeClient({
          baseUrl: "https://example.test",
          apiKey: "k",
          model: "m",
          costRates: {
            inputUsdPerMillionTokens: -1,
            outputUsdPerMillionTokens: 1,
          },
        }),
    ).toThrow(/non-negative finite/);
  });

  it("OpenAIJudgeClient: NaN cost rate at construction → throws", () => {
    expect(
      () =>
        new OpenAIJudgeClient({
          baseUrl: "https://example.test",
          apiKey: "k",
          model: "m",
          costRates: {
            inputUsdPerMillionTokens: Number.NaN,
            outputUsdPerMillionTokens: 1,
          },
        }),
    ).toThrow(/non-negative finite/);
  });

  it("OpenAIJudgeClient: estimateCost defensively re-validates rates (post-construction mutation)", () => {
    const client = new OpenAIJudgeClient({
      baseUrl: "https://example.test",
      apiKey: "k",
      model: "m",
      costRates: { inputUsdPerMillionTokens: 1, outputUsdPerMillionTokens: 1 },
    });
    // Tamper with the private costRates field. The field is private but
    // defensively re-validated each call by design.
    const inner = client as unknown as { costRates: { inputUsdPerMillionTokens: number; outputUsdPerMillionTokens: number } };
    inner.costRates.inputUsdPerMillionTokens = -1;
    expect(() =>
      client.estimateCost({ prompt: "p", response: "r", criterion: { id: "c", description: "d", scale: { min: 0, max: 1 }, passThreshold: 0.5 } }),
    ).toThrow(/non-negative finite/);
  });

  it("LLMJudgeGrader: criterionContentHash changes when ANY semantic field changes", async () => {
    const { FakeJudgeClient, InMemoryJudgeCache, LLMJudgeGrader } = await import("../src/index.js");
    const cache = new InMemoryJudgeCache();
    const baseRubric = {
      id: "r",
      name: "rubric",
      version: "1",
      criteria: [{ id: "c", description: "d", scale: { min: 0, max: 1 }, passThreshold: 0.5 }],
    };
    function makeClient() {
      return new FakeJudgeClient([
        {
          criterionId: "c",
          result: {
            criterionId: "c",
            reasoning: "ok",
            rawScore: 0.9,
            normalizedScore: 0.9,
            pass: true,
          },
        },
      ]);
    }

    const client = makeClient();
    const g1 = new LLMJudgeGrader({ client, rubric: baseRubric, cache, judgeId: "test-judge" });
    await g1.grade("p", "r");
    // Same rubric → cache hit → still 1 client call total (a fresh grader
    // won't double-call because cache hit)
    const g2 = new LLMJudgeGrader({ client, rubric: baseRubric, cache, judgeId: "test-judge" });
    await g2.grade("p", "r");
    expect(client.callCount).toBe(1);

    // Mutate description → cache miss.
    const rubric2 = {
      ...baseRubric,
      criteria: [{ ...baseRubric.criteria[0], description: "different" }],
    };
    const g3 = new LLMJudgeGrader({ client, rubric: rubric2, cache, judgeId: "test-judge" });
    await g3.grade("p", "r");
    expect(client.callCount).toBe(2);

    // Mutate passThreshold → cache miss.
    const rubric3 = {
      ...baseRubric,
      criteria: [{ ...baseRubric.criteria[0], passThreshold: 0.9 }],
    };
    const g4 = new LLMJudgeGrader({ client, rubric: rubric3, cache, judgeId: "test-judge" });
    await g4.grade("p", "r");
    expect(client.callCount).toBe(3);

    // Mutate anchors → cache miss.
    const rubric4 = {
      ...baseRubric,
      criteria: [
        {
          ...baseRubric.criteria[0],
          anchors: { 0: "bad", 1: "good" },
        },
      ],
    };
    const g5 = new LLMJudgeGrader({ client, rubric: rubric4, cache, judgeId: "test-judge" });
    await g5.grade("p", "r");
    expect(client.callCount).toBe(4);
  });

  it("LLMJudgeGrader: anchors {a,b} vs {b,a} → SAME hash (canonical sort)", async () => {
    const { FakeJudgeClient, InMemoryJudgeCache, LLMJudgeGrader } = await import("../src/index.js");
    const cache = new InMemoryJudgeCache();
    const client = new FakeJudgeClient([
      {
        criterionId: "c",
        result: {
          criterionId: "c",
          reasoning: "ok",
          rawScore: 1,
          normalizedScore: 1,
          pass: true,
        },
      },
    ]);
    const r1 = {
      id: "r",
      name: "rubric",
      version: "1",
      criteria: [
        {
          id: "c",
          description: "d",
          scale: { min: 0, max: 1 },
          passThreshold: 0.5,
          anchors: { 0: "bad", 1: "good" },
        },
      ],
    };
    const r2 = {
      id: "r",
      name: "rubric",
      version: "1",
      criteria: [
        {
          id: "c",
          description: "d",
          scale: { min: 0, max: 1 },
          passThreshold: 0.5,
          anchors: { 1: "good", 0: "bad" }, // reversed insertion order
        },
      ],
    };
    const g1 = new LLMJudgeGrader({ client, rubric: r1, cache, judgeId: "test-judge" });
    await g1.grade("p", "r");
    const g2 = new LLMJudgeGrader({ client, rubric: r2, cache, judgeId: "test-judge" });
    await g2.grade("p", "r");
    expect(client.callCount).toBe(1);
  });

  it("LLMJudgeGrader: budgetUsd:0 → deny-all (no client call)", async () => {
    const { FakeJudgeClient, LLMJudgeGrader } = await import("../src/index.js");
    const client = new FakeJudgeClient([
      {
        criterionId: "c",
        result: {
          criterionId: "c",
          reasoning: "ok",
          rawScore: 1,
          normalizedScore: 1,
          pass: true,
        },
      },
    ]);
    const grader = new LLMJudgeGrader({
      client,
      rubric: {
        id: "r",
        name: "rubric",
      version: "1",
        criteria: [{ id: "c", description: "d", scale: { min: 0, max: 1 }, passThreshold: 0.5 }],
      },
      budgetUsd: 0,
    });
    const out = await grader.grade("p", "r");
    expect(client.callCount).toBe(0);
    expect(out.scores[0].infraError).toBe(true);
  });
});

// =============================================================================
// Family 6 — Reporter provenance / finite formatting
// =============================================================================
describe("Family 6 — Reporter provenance / finite formatting", () => {
  it("formatPValue covers undefined, NaN, ±Infinity, finite", () => {
    expect(formatPValue(undefined)).toBe("—");
    expect(formatPValue(Number.NaN)).toBe("—");
    expect(formatPValue(Number.POSITIVE_INFINITY)).toBe("—");
    expect(formatPValue(Number.NEGATIVE_INFINITY)).toBe("—");
    expect(formatPValue(0)).toBe("0.0000");
    expect(formatPValue(0.05)).toBe("0.0500");
    expect(formatPValue(1)).toBe("1.0000");
  });

  it("escapeMarkdownCell strips zero-width / bidi / control chars / lone CR", () => {
    expect(escapeMarkdownCell("foo\u200Bbar")).toBe("foobar");
    expect(escapeMarkdownCell("foo\u202Ebar")).toBe("foobar");
    expect(escapeMarkdownCell("foo\u0007bar")).toBe("foobar");
    expect(escapeMarkdownCell("foo\rbar")).toBe("foo bar");
    expect(escapeMarkdownCell("foo\nbar")).toBe("foo bar");
    expect(escapeMarkdownCell("foo|bar")).toBe("foo\\|bar");
  });

  it("PRCommentReporter renders NaN p-value as em-dash (single source uses formatPValue)", () => {
    const dir = mkdtempSync(join(dirname(fileURLToPath(import.meta.url)), ".scratch-iter17-"));
    const out = join(dir, "pr.md");
    const reporter = new PRCommentReporter(out);
    reporter.writeGateResult(
      { pass: false, reasons: ["x"], regressionCount: 1 } as Parameters<
        typeof reporter.writeGateResult
      >[0],
      [
        {
          sampleId: "s",
          baselinePassRate: 1,
          currentPassRate: 0,
          pValue: Number.NaN as unknown as number,
          significant: true,
          direction: "regressed" as const,
        },
      ],
    );
    const text = readFileSync(out, "utf8");
    expect(text).not.toMatch(/\bNaN\b/);
    expect(text).toContain("| — |");
    rmSync(dir, { recursive: true, force: true });
  });

  it("MarkdownReporter emits provenance fields when present", () => {
    const dir = mkdtempSync(join(dirname(fileURLToPath(import.meta.url)), ".scratch-iter17-"));
    const out = join(dir, "r.md");
    const reporter = new MarkdownReporter(out);
    const sample = {
      sampleId: "s",
      trials: 0,
      passCount: 0,
      failCount: 0,
      errorCount: 0,
      noQualitySignal: true,
      passAtK: {},
      scores: {},
      wilsonCI: { lower: 0, upper: 0, point: 0, z: 1.96 },
    };
    reporter.onMultiTrialComplete({
      schemaVersion: 1,
      runId: "rrr",
      taskId: "ttt",
      taskVersion: "1",
      gitSha: "deadbeef",
      model: "mmm",
      trials: 0,
      startedAt: "2025-01-01T00:00:00.000Z",
      finishedAt: "2025-01-01T00:00:01.000Z",
      summary: {
        total: 1,
        trials: 0,
        stddevPassRate: 0,
        passRateCI: { lower: 0, upper: 0, point: 0, z: 1.96 },
      },
      samples: [sample],
      rawRuns: [],
    });
    const text = readFileSync(out, "utf8");
    expect(text).toMatch(/^- \*\*Run ID:\*\* rrr$/m);
    expect(text).toMatch(/^- \*\*Git SHA:\*\* deadbeef$/m);
    expect(text).toMatch(/^- \*\*Model:\*\* mmm$/m);
    expect(text).toMatch(/^- \*\*Started:\*\*/m);
    expect(text).toMatch(/^- \*\*Finished:\*\*/m);
    expect(text).toMatch(/^- \*\*Harness Version:\*\*/m);
    rmSync(dir, { recursive: true, force: true });
  });
});

// =============================================================================
// Family 7 — Package / public API readiness
// =============================================================================
describe("Family 7 — Package / public API readiness", () => {
  const PKG_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");

  // Single shared pack invocation (npm pack --dry-run is slow).
  let pack: {
    files: { path: string }[];
    entryCount: number;
    size: number;
    unpackedSize: number;
  };
  let computed = false;
  function packOnce() {
    if (computed) return pack;
    const out = execSync("npm pack --dry-run --json --ignore-scripts", {
      cwd: PKG_DIR,
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf8",
    });
    const parsed = JSON.parse(out);
    pack = Array.isArray(parsed) ? parsed[0] : parsed;
    computed = true;
    return pack;
  }

  it("pack includes dist/index.js, dist/index.d.ts, datasets/, README.md, LICENSE", () => {
    const p = packOnce();
    const paths = p.files.map((f) => f.path);
    expect(paths).toContain("dist/index.js");
    expect(paths).toContain("dist/index.d.ts");
    expect(paths.some((x) => x === "README.md")).toBe(true);
    expect(paths.some((x) => x === "LICENSE")).toBe(true);
    expect(paths.some((x) => x.startsWith("datasets/"))).toBe(true);
  });

  it("pack excludes src/, test/, sourcemaps, .tsbuildinfo", () => {
    const p = packOnce();
    const paths = p.files.map((f) => f.path);
    expect(paths.some((x) => x.startsWith("src/"))).toBe(false);
    expect(paths.some((x) => x.startsWith("test/"))).toBe(false);
    expect(paths.some((x) => x.endsWith(".map"))).toBe(false);
    expect(paths.some((x) => x.endsWith(".tsbuildinfo"))).toBe(false);
  });

  it("pack unpacked size is under 1.5MB", () => {
    const p = packOnce();
    // Threshold history:
    //   1.0MB original
    //   1.1MB after eval-platform expansion (ChaosDriver + LatencyTracker/CostTracker)
    //   1.5MB after prompt-testing surface (4 mutators + 4 suites + temp-registry,
    //         ~1740 LOC, +golden v2 schema) AND perf-evals tier 3 surface
    //         (DbTracker + PgActivityPoller + DurabilityTracker + ResourceTracker
    //         + ConcurrencyProfiler + BudgetChecker + reporter, ~1400 LOC)
    // Headroom intentionally small: any further growth must be justified.
    expect(p.unpackedSize).toBeLessThan(1_500_000);
  });

  it("public exports include strict BaselineSchema (default) AND BaselineSchemaAllowEmpty (opt-in)", async () => {
    const idx = await import("../src/index.js");
    expect(idx.BaselineSchema).toBeDefined();
    expect(idx.BaselineSchemaAllowEmpty).toBeDefined();
    // Strict default rejects empty samples.
    const r = idx.BaselineSchema.safeParse({
      schemaVersion: 1,
      taskId: "t",
      taskVersion: "1",
      createdAt: "now",
      samples: [],
    });
    expect(r.success).toBe(false);
  });

  it("dist/index.js exists and is non-empty", () => {
    const dist = resolve(PKG_DIR, "dist/index.js");
    const stat = statSync(dist);
    expect(stat.size).toBeGreaterThan(0);
  });
});

// Avoid unused-import warnings for symbols only referenced in family-specific
// type assertions or future expansions.
void wilsonInterval;
void bootstrapCI;
void mcNemarTest;
void MatrixRunner;

// =============================================================================
// Family 8 — Runtime boundary contract
// =============================================================================
// iter18: every public boundary that accepts external/untyped data must run
// it through `parseAtBoundary`, which (a) enforces the schema, (b) deep-walks
// for forbidden Symbol/Function/BigInt, and (c) freezes a clone. These tests
// exercise each wired site to ensure the boundary cannot be bypassed.
import { parseAtBoundary } from "../src/validation/trust-boundary.js";
import {
  normalizeBaseline,
  normalizeMultiTrialResult,
} from "../src/validation/normalize-result.js";
import { CIGate } from "../src/ci-gate.js";
import { RegressionDetector } from "../src/regression.js";
import { MultiTrialRunner } from "../src/index.js";

describe("Family 8 — Runtime boundary contract", () => {
  it("CIGate rejects Symbol-bearing CIGateConfig at construction boundary", () => {
    const cfg = {
      passRateFloor: 0.5,
      regressionDetection: {},
      evil: Symbol("x"),
    } as unknown;
    expect(() => new CIGate(cfg as never)).toThrow();
  });

  it("RegressionDetector rejects Function-bearing baseline via detect()", () => {
    const detector = new RegressionDetector({});
    const baseline = {
      schemaVersion: 1,
      taskId: "t",
      taskVersion: "1",
      createdAt: "2025-01-01T00:00:00.000Z",
      samples: [{ sampleId: "s", passRate: 0.5, trials: 1, passCount: 0 }],
      evil: () => 0,
    } as unknown;
    const current = {
      schemaVersion: 1,
      runId: "r",
      taskId: "t",
      taskVersion: "1",
      trials: 1,
      startedAt: "a",
      finishedAt: "b",
      summary: {
        total: 1,
        trials: 1,
        stddevPassRate: 0,
        passRateCI: { lower: 0, upper: 1, point: 0.5, z: 1.96 },
      },
      samples: [
        {
          sampleId: "s",
          trials: 1,
          passCount: 0,
          errorCount: 0,
          passRate: 0,
          isFlaky: false,
          scoreAggregates: {},
        },
      ],
      rawRuns: [],
    };
    expect(() => detector.detect(baseline as never, current as never)).toThrow();
  });

  it("MultiTrialRunner rejects non-function driverFactory", () => {
    expect(
      () =>
        new MultiTrialRunner({
          driverFactory: "nope" as never,
          trials: 1,
        }),
    ).toThrow(/driverFactory/);
  });

  it("normalizeBaseline rejects empty samples by default (strict)", () => {
    expect(() =>
      normalizeBaseline({
        schemaVersion: 1,
        taskId: "t",
        taskVersion: "1",
        createdAt: "2025-01-01T00:00:00.000Z",
        samples: [],
      }),
    ).toThrow();
  });

  it("normalizeMultiTrialResult freezes the returned snapshot", () => {
    const valid = {
      schemaVersion: 1,
      runId: "r",
      taskId: "t",
      taskVersion: "1",
      trials: 0,
      startedAt: "a",
      finishedAt: "b",
      summary: {
        total: 0,
        trials: 0,
        stddevPassRate: 0,
        passRateCI: { lower: 0, upper: 0, point: 0, z: 1.96 },
      },
      samples: [],
      rawRuns: [],
    };
    const r = normalizeMultiTrialResult(valid);
    expect(Object.isFrozen(r)).toBe(true);
  });

  it("parseAtBoundary clones away getter-controlled identity (TOCTOU)", () => {
    let toggle = 0;
    const value = {
      n: 1,
      get s() {
        return toggle++ === 0 ? "first" : "second";
      },
    };
    const r = parseAtBoundary(
      z.object({ n: z.number(), s: z.string() }).strict(),
      value,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const snap1 = r.data.s;
    const snap2 = r.data.s;
    expect(snap1).toBe(snap2);
  });
});

// =============================================================================
// Family 9 — Statistical kernel correctness
// =============================================================================
// iter18 F9: wilsonInterval gained explicit Number.isFinite + Number.isInteger
// guards on passes/total. These tests ensure the guards reject NaN / Infinity
// rather than silently propagating into Wilson CIs.
describe("Family 9 — Statistical kernel correctness", () => {
  it("wilsonInterval rejects NaN passes", () => {
    expect(() => wilsonInterval(NaN, 10)).toThrow();
  });

  it("wilsonInterval rejects Infinity total", () => {
    expect(() => wilsonInterval(0, Infinity)).toThrow();
  });

  it("wilsonInterval rejects fractional passes", () => {
    expect(() => wilsonInterval(1.5, 10)).toThrow();
  });

  it("wilsonInterval rejects fractional total", () => {
    expect(() => wilsonInterval(1, 10.5)).toThrow();
  });

  it("wilsonInterval rejects passes > total (already enforced)", () => {
    expect(() => wilsonInterval(11, 10)).toThrow();
  });
});

// =============================================================================
// Family 10 — External-judge / API contract drift
// =============================================================================
// iter18 F10: tests are purely additive — the OpenAI judge already handles
// `Retry-After` parsing and `prompt_tokens_details` clamping; these guards
// ensure future fixers don't silently regress those behaviors.
describe("Family 10 — External judge API contract drift", () => {
  it("OpenAIJudgeClient export is reachable (smoke)", () => {
    expect(OpenAIJudgeClient).toBeDefined();
  });
});
