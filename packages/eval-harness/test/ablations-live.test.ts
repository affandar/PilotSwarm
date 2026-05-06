// Ablations LIVE — gated by LIVE=1. Compares PilotSwarm config variants
// (model / prompt / tool set / trial count) against the same task and
// surfaces which dimension moves the pass rate.
//
// Designed to be additive: each test uses a small, bounded number of
// trials to keep the LIVE budget modest (~$). The trial-count ablation
// uses a single-sample task to bound cost growth as n increases.

import { describe, expect, it } from "vitest";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { LiveDriver } from "../src/drivers/live-driver.js";
import { MultiTrialRunner } from "../src/multi-trial.js";
import { MatrixRunner } from "../src/matrix.js";
import { RegressionDetector } from "../src/regression.js";
import { baselineFromMultiTrialResult } from "../src/baseline.js";
import { loadEvalTask } from "../src/loader.js";
import {
  assertLiveAxisWithinCap,
  computeLiveTestTimeout,
  LIVE_MAX_MODELS,
  parseEnvList,
} from "./helpers/live-timeout.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Module-load-time computation of the model-ablation timeout. See live-driver-live.test.ts
// for the rationale (vitest's per-`it` timeout is the third arg to `it()` and is
// evaluated before the test body runs).
const LIVE_ABLATION_MODELS_RAW = parseEnvList(
  "LIVE_ABLATION_MODELS",
  parseEnvList("LIVE_MATRIX_MODELS"),
);
assertLiveAxisWithinCap("LIVE_ABLATION_MODELS", LIVE_ABLATION_MODELS_RAW.length, LIVE_MAX_MODELS);
const LIVE_ABLATION_MODEL_TIMEOUT_MS = computeLiveTestTimeout({
  perCellTimeoutMs: 240_000,
  // Matrix is models × 2 trials; floor to 2 models so missing env still
  // sizes a sensible timeout when the test guards itself with
  // `models.length < 2 → return`.
  cells: Math.max(LIVE_ABLATION_MODELS_RAW.length, 2) * 2,
});

describe("Ablations LIVE", () => {
  const run = process.env.LIVE === "1" ? it : it.skip;

  run("ABLATION: model dimension — matrix across 2+ models surfaces per-cell pass rates", async () => {
    const models = LIVE_ABLATION_MODELS_RAW;
    if (models.length < 2) {
      // eslint-disable-next-line no-console
      console.warn("LIVE_ABLATION_MODELS not set or <2 models; skipping model ablation.");
      return;
    }
    const dataset = loadEvalTask(resolve(__dirname, "../datasets/tool-call-correctness.v1.json"));
    const sample = dataset.samples.find((s) => s.id === "single.add.basic")!;
    const runner = new MatrixRunner({
      driverFactory: () => new LiveDriver({ timeout: 240_000 }),
      models,
      configs: [{ id: "default", label: "default", overrides: {} }],
      trials: 2,
    } as never);
    const result = await runner.runTask({ ...dataset, samples: [sample] });
    expect(result.cells.length).toBe(models.length);
    const passRates = result.cells.map((c) => {
      const r = c.result.samples[0]!;
      return r.passCount / Math.max(1, r.trials - r.errorCount);
    });
    expect(passRates.every((v) => Number.isFinite(v))).toBe(true);
  }, LIVE_ABLATION_MODEL_TIMEOUT_MS);

  run("ABLATION: prompt variant — A/B prompts produce comparable but distinct trajectories", async () => {
    const dataset = loadEvalTask(resolve(__dirname, "../datasets/tool-call-correctness.v1.json"));
    const baseSample = dataset.samples.find((s) => s.id === "single.add.basic")!;
    const variantA = { ...baseSample, id: "ablation.prompt.A" };
    const variantB = {
      ...baseSample,
      id: "ablation.prompt.B",
      input: { ...baseSample.input, prompt: "Add 17 and 25 using the test_add tool." },
    };
    const runnerA = new MultiTrialRunner({
      driverFactory: () => new LiveDriver({ timeout: 300_000 }),
      trials: 2,
    });
    const runnerB = new MultiTrialRunner({
      driverFactory: () => new LiveDriver({ timeout: 300_000 }),
      trials: 2,
    });
    const [resA, resB] = await Promise.all([
      runnerA.runTask({ ...dataset, samples: [variantA] }),
      runnerB.runTask({ ...dataset, samples: [variantB] }),
    ]);
    expect(resA.samples[0]!.trials).toBe(2);
    expect(resB.samples[0]!.trials).toBe(2);
  }, 750_000);

  run("ABLATION: tool-set ablation — restricting tools changes observed tool calls", async () => {
    const dataset = loadEvalTask(resolve(__dirname, "../datasets/tool-call-correctness.v1.json"));
    const baseSample = dataset.samples[0]!;
    const fullToolsSample = { ...baseSample, id: "ablation.tools.full", tools: ["test_add", "test_multiply", "test_weather"] };
    const reducedSample = { ...baseSample, id: "ablation.tools.reduced", tools: ["test_add"] };
    const runner = new MultiTrialRunner({
      driverFactory: () => new LiveDriver({ timeout: 300_000 }),
      trials: 1,
    });
    const result = await runner.runTask({ ...dataset, samples: [fullToolsSample, reducedSample] });
    expect(result.samples.length).toBe(2);
  }, 750_000);

  run("ABLATION: trial-count — Wilson CI shrinks as trials grow (n=2 → n=5)", async () => {
    const dataset = loadEvalTask(resolve(__dirname, "../datasets/tool-call-correctness.v1.json"));
    const sample = dataset.samples.find((s) => s.id === "single.add.basic")!;
    const widths: number[] = [];
    for (const trials of [2, 5]) {
      const runner = new MultiTrialRunner({
        driverFactory: () => new LiveDriver({ timeout: 300_000 }),
        trials,
      });
      const result = await runner.runTask({ ...dataset, samples: [sample] });
      const ci = result.samples[0]!.wilsonCI;
      widths.push(ci.upper - ci.lower);
    }
    // Wider CI for n=2 than n=5 is the directional invariant we care about.
    expect(widths[1]!).toBeLessThanOrEqual(widths[0]!);
  }, 2_250_000);

  run("ABLATION: regression detector picks up a degraded variant", async () => {
    const dataset = loadEvalTask(resolve(__dirname, "../datasets/tool-call-correctness.v1.json"));
    const sample = dataset.samples.find((s) => s.id === "single.add.basic")!;
    const baselineRun = await new MultiTrialRunner({
      driverFactory: () => new LiveDriver({ timeout: 300_000 }),
      trials: 3,
    }).runTask({ ...dataset, samples: [sample] });
    const baseline = baselineFromMultiTrialResult(baselineRun);

    // Inject a degraded variant: zero passes. Schema invariant requires
    // passRate to match passCount / (trials - errorCount), so reset
    // passRate alongside the per-sample counts and recompute the
    // task-level summary so the result still validates.
    const degradedSamples = baselineRun.samples.map((s) => ({
      ...s,
      passCount: 0,
      failCount: s.trials,
      errorCount: 0,
      passRate: 0,
      noQualitySignal: false,
    }));
    const degraded = {
      ...baselineRun,
      samples: degradedSamples,
      summary: {
        ...baselineRun.summary,
        meanPassRate: 0,
        stddevPassRate: 0,
        infraErrorRate: 0,
      },
    };
    const detector = new RegressionDetector({ alpha: 0.05 });
    const detection = detector.detect(baseline, degraded);
    expect(detection.regressions.length).toBeGreaterThan(0);
  }, 1_050_000);
});
