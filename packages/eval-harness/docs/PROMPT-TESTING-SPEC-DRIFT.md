# Prompt Testing — Implementation vs Spec

The canonical design lives at `docs/superpowers/specs/2026-05-02-prompt-testing-design.md`
(repo root, outside this package). This file documents how the implementation
in `packages/eval-harness/src/prompt-testing/` deviates from that spec, and why.

## Resolved drift (implementation now matches spec)

- **Reuse of `MatrixRunner` + `MultiTrialRunner`** — `runVariantMatrix()`
  now drives a per-(variant, model) `MatrixRunner` (single sample, single
  config, N trials). This satisfies success criterion #5 ("re-uses
  existing matrix/multi-trial infrastructure"). Per-variant materialization
  remains the outer loop because each variant requires a unique
  `pluginDirs` baked into its `driverFactory`.
- **Bounded matrix size** — `runVariantMatrix({ maxCells })` defaults to 48
  cells (`variants × models × trials`) and throws an actionable error when
  exceeded (spec line 94).
- **Frozen golden baseline** — regression v2 stores per-sample
  observations: response digest + length, tool-call name/argKeys/argDigest
  sequence, plus aggregate means. Spec previously implied "frozen golden"
  but the v1 implementation only stored aggregate means.
- **Real safety-suite wrapper** — `runInjectionSuite()` runs the same 12
  programmatic safety checks as `safety-live.test.ts`, via the reusable
  graders in `src/prompt-testing/suites/safety-graders.ts`.

## Remaining intentional drift

- **Single-sample matrix call** — `runVariantMatrix({ sample })` still
  takes a single `EvalSample`, not `samples[]` as suggested by the spec
  signature on line 80. Multi-sample runs are achieved by calling the
  function once per sample at the suite level (e.g. `runInjectionSuite`).
  This keeps the per-cell `PromptTestResult` shape simple and lets each
  sample-level matrix be reported independently.
- **Golden filename** — implementation uses
  `default.agent.md.golden.v1.json` (filename includes the `.v1` schema
  marker for human discoverability); the spec mentions
  `default.agent.md.golden.json`. The schema *inside* the file is now v2;
  the filename suffix is preserved for backwards path compatibility.
- **Robustness "template fallback"** — the spec narrative implies
  paraphrase-without-API-key falls back to deterministic templates. The
  implementation rejects that path explicitly: deterministic
  paraphrasing-by-template is silently degenerate ("same prompt with
  different words") and would mask robustness regressions. Callers must
  either pass `paraphrases: string[]` (deterministic) or supply
  `OPENAI_API_KEY`.

## Spec doc updates pending

The repo-root spec (`docs/superpowers/specs/2026-05-02-prompt-testing-design.md`)
has not been updated as part of this fix because the audit-scoped change
window is limited to `packages/eval-harness/`. When that doc is next
touched, the following lines should be reconciled:

- Line 31: signature `runVariantMatrix({ variants, samples, models, trials })`
  → either `samples` should become `sample` (singular), or the
  implementation should accept `samples[]` and emit one cell per sample.
- Line 39: "Wraps safety-live.test.ts battery for variant runs." → should
  reference `src/prompt-testing/suites/safety-graders.ts` as the reusable
  grader source of truth.
- Line 47: `default.agent.md.golden.json` → match either filename
  convention.
- Lines 5–8 of `src/prompt-testing/suites/robustness.ts` (was) referenced
  "deterministic-template paraphrases when no API key" — reality is
  fail-loud. The header has been corrected; spec narrative could mirror.
