# CI integration

How to wire eval-harness into a CI pipeline so quality regressions block merges.

## What CI gives you

| primitive | purpose |
|-----------|---------|
| `Baseline` (file on disk) | snapshot of last-known-good `MultiTrialResult` aggregates |
| `RegressionDetector` | two-proportion z-test baseline vs current per sample, with optional BH/Bonferroni correction |
| `CIGate` | combined verdict: pass-rate floor + max-regressions + max-cost + infra limits |
| `PRCommentReporter` | Markdown summary suitable for `gh pr comment` |

Source: `src/baseline.ts`, `src/regression.ts`, `src/ci-gate.ts`, `src/reporters/pr-comment.ts`.

## Minimum viable CI flow

```ts
import {
  saveBaseline,
  loadBaseline,
  RegressionDetector,
  CIGate,
  PRCommentReporter,
  MultiTrialRunner,
  LiveDriver,
  loadEvalTask,
} from "pilotswarm-eval-harness";

// 1. Run multi-trial against the change under review
const runner = new MultiTrialRunner({
  driverFactory: () => new LiveDriver({ timeout: 300_000 }),
  trials: 5,
});
const current = await runner.runTask(loadEvalTask("./datasets/tool-call-correctness.v1.json"));

// 2. Compare to last baseline
const baseline = loadBaseline(".eval-results/baseline.json");
const detection = new RegressionDetector({
  alpha: 0.05,
  correction: "bh",   // BH for ≥5 samples, "bonferroni" if <5, "none" if you want raw
}).detect(baseline, current);

// 3. Gate
const gate = new CIGate({
  passRateFloor: 0.8,        // REQUIRED — quality approval anchor
  maxRegressions: 0,         // supplementary; cannot replace passRateFloor
  maxCostUsd: 5,
  maxInfraErrors: 2,
});
const verdict = gate.evaluate(current, detection, totalCostUsd);

// 4. Surface in PR
const pr = new PRCommentReporter(".eval-results/pr-comment.md");
pr.onMultiTrialComplete(current);
pr.writeGateResult(verdict, detection.regressions);

// 5. Exit with the right code so CI fails on regression
process.exit(gate.exitCode(verdict));
```

## passRateFloor is mandatory

`CIGate.evaluate()` rejects any config without `passRateFloor`. Cost / infra / regression-only gates cannot replace a quality floor — `maxRegressions: 0` only proves "no worse than last time"; if last time was already broken, your gate ratifies broken-stays-broken.

If you want to be principled about it, set the floor at *baseline* `meanPassRate − 2σ` and let the regression detector catch movement.

## Baseline lifecycle

**Capture once after a known-good change:**

```ts
saveBaseline(currentResult, ".eval-results/baseline.json");
```

Refuses to write:

- Empty samples (override: `allowEmptyBaseline: true`).
- All-infra-error samples (override: `allowNoQualityBaseline: true` — warns and names affected samples).
- Pooled pass rate < 50% (override: `allowLowQualityBaseline: true` — fix the product instead).

**Refresh after intentional improvements:** rerun, save again, commit the new `baseline.json` alongside the source change. The PR diff documents the quality lift.

**Don't refresh to silence regressions** — that's the broken-stays-broken trap.

## Detecting added / removed samples

`RegressionDetector.detect()` returns:

```ts
{
  regressions: SampleRegression[],
  missingBaselineSamples: string[],   // baseline had it, current doesn't
  newCurrentSamples: string[],        // current has it, baseline doesn't
}
```

`CIGate.evaluate()` defaults:

- `failOnMissingBaselineSamples: true` — can't pass by deleting hard cases. Override: `allowMissingBaselineSamples: true` for intentional removals.
- `failOnNewSamples: true` — can't dilute aggregate by adding only-easy cases. Override: `failOnNewSamples: false` for intentional additions.

Both checks fire BEFORE quality verdict, so a clean run with sample drift fails loudly.

## Tampering protection

`CIGate.evaluate()` recomputes `meanPassRate` from `MultiTrialResult.samples` and rejects inputs whose supplied `summary.meanPassRate` disagrees with the recomputed value. Defends against post-processed JSON / forged summaries.

If you legitimately need to use authoritative precomputed summaries (e.g. cross-process aggregation), pass `trustSummary: true`. Gate decisions still use sample-level signal; only the summary integrity check is bypassed.

## Multiple-testing correction

The two-proportion z-test is per-sample. Run 50 samples, even with no real change, ~2-3 will show p<0.05 by chance. Three options:

| `correction` | when |
|---|---|
| `"none"` | <5 samples or you want raw signal |
| `"bonferroni"` | <5 samples and you want the strict family-wise bound |
| `"bh"` | ≥5 samples; controls FDR; usually the right default |

Reference: README "V5b — Baselines, Regression Detection..." for the full statistical caveat list.

## Cost tracking

`CIGate.maxCostUsd` reads from the `totalCostUsd` you pass in. The harness doesn't aggregate cost automatically — collect it from per-call observed `actualCostUsd` (LiveDriver passthrough) or judge `JudgeCost.estimatedCostUsd`. Sum across the run, then feed to `gate.evaluate()`.

`CostTracker` in `src/perf/` helps; example in `test/performance-live.test.ts` `PERF: cost-per-trial accumulates`.

## Infra error gate

`CIGate.maxInfraErrors: N` fails if more than N samples errored at the infra level (driver timeout, judge transport failure, schema mismatch on observed result). Distinct from quality fails — you usually want this small (0-2 in CI) so a flaky network doesn't poison the gate.

`requireNoInfraOutage: true` is stricter — fails if any sample has `noQualitySignal: true` (all trials infra-errored).

## PR comment surface

`PRCommentReporter` writes Markdown with:

- Summary table: pass rate ± Wilson CI, regression count, cost
- Per-sample regression list (sample id, baseline %, current %, p-value, direction)
- Gate verdict: pass / fail with reasons

Wire to GitHub Actions:

```yaml
- run: node ./scripts/run-eval.mjs    # writes .eval-results/pr-comment.md
- name: Post PR comment
  run: gh pr comment ${{ github.event.pull_request.number }} \
       --body-file .eval-results/pr-comment.md
  env:
    GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

The reporter is async-ready (`void | Promise<void>`) so swapping to Langfuse / OTel later doesn't require a contract change.

## Two-stage CI pattern

For projects where LIVE eval cost is significant:

| stage | runs | gates |
|---|---|---|
| pre-merge (every PR) | full FakeDriver suite + small LIVE smoke (1-3 samples) | quick floor (`passRateFloor: 0.95`), no regression detection |
| nightly (cron) | full LIVE multi-trial (5-10 trials × all samples) | strict floor + regression detection + max-cost |

Baseline lives on `main`; PR runs detect against it; nightly refreshes when `main` advances.

## Footguns

- **`maxRegressions: 0` alone** — looks principled but only enforces "no worse than baseline." Without `passRateFloor` it's gameable by deleting hard samples (caught by `failOnMissingBaselineSamples`) or refusing to save a bad baseline (caught by `allowLowQualityBaseline` refusal). Always set `passRateFloor`.
- **Single-trial LIVE gates** — Wilson CI on n=1 is meaningless. Run trials ≥ 5 if the gate is going to fail builds.
- **Forgetting `correction`** — defaults to `"none"`; large sample counts produce false positives. Set `bh` once you have ≥5 samples.
- **Cost gate alone** — `maxCostUsd` is operational, not quality. CIGate rejects "operational gates only" configs explicitly.

## Pointers

- README "V5b — Baselines, Regression Detection, CI Gates, PR Comments" — full statistical reference
- `src/ci-gate.ts` — `CIGate` config interface + verdict shape
- `src/regression.ts` — detector implementation
- `src/baseline.ts` — load/save/projection helpers
- `src/reporters/pr-comment.ts` — Markdown layout
- `test/ci-gate.test.ts` — pinned guardrail tests for the rules above
