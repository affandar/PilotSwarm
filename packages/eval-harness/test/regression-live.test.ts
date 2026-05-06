// Regression LIVE — gated by LIVE=1. Saves a baseline from a real
// LiveDriver multi-trial run, then runs current under intentionally worse
// conditions and asserts RegressionDetector flags it; also asserts a stable
// equivalent rerun does NOT flag.
//
// G7 fix: `baselineFromMultiTrialResult` was never exported from
// `../src/baseline.js`. The public API is `saveBaseline(result, path, opts?)`
// which accepts a MultiTrialResult directly and persists the canonical
// Baseline shape. Callers then `loadBaseline(path)` to retrieve it. For
// in-memory comparison without disk round-trip, we mirror `saveBaseline`'s
// internal conversion in `baselineFromRun()` below.

import { describe, expect, it } from "vitest";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LiveDriver } from "../src/drivers/live-driver.js";
import { MultiTrialRunner } from "../src/multi-trial.js";
import { RegressionDetector } from "../src/regression.js";
import { CIGate } from "../src/ci-gate.js";
import { saveBaseline, loadBaseline } from "../src/baseline.js";
import { loadEvalTask } from "../src/loader.js";
import type { Baseline, MultiTrialResult } from "../src/types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Convert a `MultiTrialResult` into a canonical `Baseline` shape — mirrors
 * `saveBaseline()`'s internal conversion exactly so the detector compares
 * apples-to-apples. The detector treats baseline-shaped and result-shaped
 * inputs differently; persisting and loading via JSON would round-trip
 * `passRate: undefined` to `0`, which can falsely trip the detector's
 * pass-rate-drop heuristic on an identity comparison.
 */
function baselineFromRun(result: MultiTrialResult): Baseline {
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

describe("Regression LIVE", () => {
  const run = process.env.LIVE === "1" ? it : it.skip;

  run("detects regression from actual PilotSwarm baseline to current run", async () => {
    const driver = new LiveDriver({ timeout: 240_000 });
    const dataset = loadEvalTask(resolve(__dirname, "../datasets/tool-call-correctness.v1.json"));
    const sample = dataset.samples[0]!;

    // Baseline: trials high → presumed stable pass.
    // G7 V2 fix: MultiTrialRunner takes `driverFactory: () => Driver`, not
    // `driver: Driver`. The factory is invoked per trial. We pass
    // `() => driver` (NOT `() => new LiveDriver(...)`) and reuse a single
    // shared `LiveDriver` across the 3 trials because LiveDriver is
    // stateless between `run()` calls — its `dispose()` is a no-op and the
    // SDK worker it lazily constructs is torn down per `run()`. Fresh
    // per-trial instances would only add construction overhead.
    const baselineRun = await new MultiTrialRunner({
      driverFactory: () => driver,
      trials: 3,
    }).runTask({
      ...dataset,
      samples: [sample],
    });
    const dir = mkdtempSync(join(tmpdir(), "eval-regression-live-"));
    const path = join(dir, "baseline.json");
    // G7 fix: `saveBaseline(result: MultiTrialResult, filePath: string, options?)`
    // — pass the MultiTrialResult directly, not a pre-built Baseline.
    saveBaseline(baselineRun, path);
    const loaded = loadBaseline(path);

    // Inject worse current: zero-trials degenerate (all infra-error) — the
    // detector must surface either the missing-quality signal or the
    // pass-rate drop.
    // G7 fix: schema enforces `passRate: undefined` when there's no quality
    // signal (`trials - errorCount === 0`). Inheriting the baseline's
    // passRate produced a validation throw on the detector path. Set it
    // to undefined explicitly.
    const currentDegenerate = {
      ...baselineRun,
      samples: baselineRun.samples.map((s) => ({
        ...s,
        passRate: undefined,
        passCount: 0,
        failCount: 0,
        errorCount: s.trials,
        noQualitySignal: true,
      })),
    };
    const detector = new RegressionDetector({ alpha: 0.05 });
    const detection = detector.detect(loaded, currentDegenerate);
    // G7 V2 fix: `regressions[]` always contains one entry per compared
    // sample (even when not significant). Filter for actual significant
    // regressions. Note: the direction enum is `"regressed"` not
    // `"regression"` — V1 of this fix used the wrong literal and was
    // dead code.
    const significantRegressions = detection.regressions.filter(
      (r) => r.significant === true && r.direction === "regressed",
    );
    // G7 V2 fix: assert the DETECTOR'S output for missing-quality samples
    // (`detection.noQualityCurrentSamples`), not the input's
    // `noQualitySignal` flag. Asserting the input would silently pass
    // even if the detector stopped surfacing the outage — exactly the
    // kind of shortcut the audit gate is meant to catch.
    const flaggedOrMissing =
      significantRegressions.length > 0 ||
      detection.missingBaselineSamples.length > 0 ||
      detection.noQualityCurrentSamples.length > 0;
    expect(flaggedOrMissing).toBe(true);

    const gate = new CIGate({ passRateFloor: 0.5 });
    const gated = gate.evaluate({ result: currentDegenerate, baseline: loaded } as never);
    expect(gated.pass).toBe(false);
  }, 870_000);

  run("does not flag equivalent actual PilotSwarm rerun as regression", async () => {
    const driver = new LiveDriver({ timeout: 240_000 });
    const dataset = loadEvalTask(resolve(__dirname, "../datasets/tool-call-correctness.v1.json"));
    const sample = dataset.samples[0]!;
    // G7 V2 fix: see the same fix in the previous test. MultiTrialRunner
    // requires `driverFactory: () => Driver`. A SHARED stateless
    // `LiveDriver` across trials is intentional: `LiveDriver.dispose()`
    // is a no-op and the SDK worker is torn down per `run()`, so reusing
    // the instance costs nothing and avoids extra construction.
    const baselineRun = await new MultiTrialRunner({
      driverFactory: () => driver,
      trials: 3,
    }).runTask({
      ...dataset,
      samples: [sample],
    });
    // G7 fix: build the baseline shape inline using the same conversion
    // `saveBaseline()` performs internally, then compare against the
    // original run. Going through disk would lossily round-trip
    // `passRate: undefined` to `0`, breaking the identity check.
    const baseline = baselineFromRun(baselineRun);
    // Same run as both baseline and current → no SIGNIFICANT regression
    // at typical alpha.
    //
    // G7 V2 fix: `RegressionDetector.detect()` returns one entry in
    // `regressions[]` for EVERY sample compared, regardless of significance
    // (`significant: false` and `direction: "unchanged"` for non-flagged
    // samples). The original assertion `regressions.length === 0` was
    // therefore guaranteed to fail whenever there was at least one sample.
    // The intent of "no regression" is that no entry is BOTH significant
    // AND flagged with `direction: "regressed"` (the real enum value;
    // V1 of this fix used `"regression"` which is impossible).
    const detector = new RegressionDetector({ alpha: 0.05 });
    const detection = detector.detect(baseline, baselineRun);
    const significantRegressions = detection.regressions.filter(
      (r) => r.significant === true && r.direction === "regressed",
    );
    expect(
      significantRegressions,
      `unexpected significant regressions on equivalent rerun: ${JSON.stringify(significantRegressions)}`,
    ).toEqual([]);
  }, 870_000);
});
