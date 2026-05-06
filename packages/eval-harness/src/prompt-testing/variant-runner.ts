/**
 * Variant matrix runner — orchestrates `variants × models × trials` LIVE driver
 * invocations. For each variant we materialize a temp `pluginDirs` directory
 * containing the mutated `.agent.md`, then drive execution through the
 * existing `MatrixRunner` + `MultiTrialRunner` infrastructure (one MatrixRunner
 * per variant, models × trials × {single sample} per matrix). Reusing those
 * runners gets us:
 *
 *   - schema-validated configs / models
 *   - per-trial driver creation + dispose (no leaked workers)
 *   - matrix-size guard via MatrixRunner.maxCells
 *   - consistent error semantics (infraError surfaced per-cell, not lost)
 *
 * On top of that we apply our own grader (`PromptTestResult` carries
 * `toolCallAccuracy` / `instructionFollowing` etc. — which the standard
 * `gradeEvalCase` does not produce).
 *
 * Lifecycle:
 *   - Each materialized plugin dir is registered with `temp-registry.ts`,
 *     so it is cleaned up on process exit / SIGINT / SIGTERM /
 *     uncaughtException even if the run is killed mid-way.
 *   - Atomic materialization: if any variant fails to materialize, ALL
 *     previously-created dirs are removed before re-throwing.
 *   - Cleanup errors are collected, attached to the result as
 *     `cleanupErrors`, and surfaced through the reporter.
 */

import { rmSync } from "node:fs";
import { LiveDriver } from "../drivers/live-driver.js";
import { MatrixRunner } from "../matrix.js";
import type {
  EvalSample,
  EvalTask,
  MatrixCell,
  MatrixConfig,
  ObservedResult,
} from "../types.js";
import {
  applyOverride,
  loadPromptSource,
  preparePluginDir,
} from "./prompt-loader.js";
import { resolveMutator } from "./mutators/index.js";
import { unregisterTempDir } from "./temp-registry.js";
import type {
  PerModelSummary,
  PerVariantSummary,
  PromptTestMatrixResult,
  PromptTestResult,
  PromptUnderTest,
  PromptVariant,
} from "./types.js";

/** Default cap on `variants × models × trials`. Override with `maxCells`. */
export const DEFAULT_MAX_CELLS = 48;

/** Sentinel used internally when the caller did not supply models. */
const MODEL_SENTINEL = "__pt-default__";

/** Single canonical config (variants are the real axis here). */
const PROMPT_TESTING_CONFIG: MatrixConfig = {
  id: "__pt-default__",
  label: "default",
  overrides: {},
};

export interface MaterializedVariant {
  variant: PromptVariant;
  pluginDir: string;
  agentName: string;
}

export interface PluginDirCleanupError {
  pluginDir: string;
  error: string;
}

/**
 * Materialize a variant by applying mutators + override and writing the result
 * into a temp plugin dir. Returns the temp dir path; caller must clean up.
 *
 * The plugin dir is registered with the process-exit hook so it survives
 * abnormal termination paths.
 */
export async function materializeVariant(
  variant: PromptVariant,
): Promise<MaterializedVariant> {
  const { agentName, parsed } = loadPromptSource(variant.baseline);
  let body = parsed.body;
  let frontmatter = parsed.frontmatter;
  let rawFrontmatter = parsed.rawFrontmatter;
  if (variant.mutation) {
    const mutator = resolveMutator(variant.mutation.mutator);
    body = await mutator.apply({ body, config: variant.mutation.config });
  }
  const overridden = applyOverride(
    { frontmatter, body, rawFrontmatter },
    variant.override,
  );
  frontmatter = overridden.frontmatter;
  body = overridden.body;
  rawFrontmatter = overridden.rawFrontmatter;
  const pluginDir = preparePluginDir({
    agentName,
    frontmatter,
    body,
    rawFrontmatter,
  });
  return { variant, pluginDir, agentName };
}

/**
 * Cleanup helper: removes the plugin dir and de-registers it from the exit
 * hook. Returns `null` on success, or a structured error on failure (so the
 * caller can attach it to the result rather than swallowing it).
 */
export function cleanupPluginDir(pluginDir: string): PluginDirCleanupError | null {
  try {
    rmSync(pluginDir, { recursive: true, force: true });
    unregisterTempDir(pluginDir);
    return null;
  } catch (err) {
    return {
      pluginDir,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export interface VariantMatrixOptions {
  /** Prompt under test (the baseline against which variants are computed). */
  baseline: PromptUnderTest;
  /** Variants to run (must include at least one). */
  variants: PromptVariant[];
  /** Eval sample to send for each cell (prompt, expected, tools). */
  sample: EvalSample;
  /** Models to test. Empty array → use the configured default model only. */
  models?: string[];
  /** Number of trials per (variant × model) cell. Default 1. */
  trials?: number;
  /** Per-cell timeout in ms. Default 240_000. */
  timeoutMs?: number;
  /**
   * Cap on `variants × models × trials`. Default {@link DEFAULT_MAX_CELLS}.
   * Throws an actionable error when the planned matrix exceeds this cap,
   * unless `force` is true.
   */
  maxCells?: number;
  /** Bypass the matrix-size guard. Use sparingly — and never in CI by default. */
  force?: boolean;
  /**
   * Optional grader. Default: tool-call accuracy is computed from
   * `sample.expected` (when present); instruction-following defaults to 1.0
   * if no error and the response is non-empty.
   */
  grade?: (
    sample: EvalSample,
    observed: ObservedResult,
  ) => Pick<
    PromptTestResult,
    "toolCallAccuracy" | "instructionFollowing" | "responseQuality" | "injectionResistance"
  >;
}

function defaultGrade(
  sample: EvalSample,
  observed: ObservedResult,
): {
  toolCallAccuracy: number;
  instructionFollowing: number;
  responseQuality?: number;
  injectionResistance?: number;
} {
  const expectedCalls = sample.expected.toolCalls ?? [];
  let toolCallAccuracy = 1;
  if (expectedCalls.length > 0) {
    const observedNames = new Set(observed.toolCalls.map((t) => t.name));
    const matched = expectedCalls.filter((c) => observedNames.has(c.name)).length;
    toolCallAccuracy = matched / expectedCalls.length;
  }
  const instructionFollowing = observed.finalResponse.trim().length > 0 ? 1 : 0;
  return { toolCallAccuracy, instructionFollowing };
}

/**
 * Build the synthetic single-sample EvalTask used by MatrixRunner. The id
 * is mangled per (variant, model) so every run-time case is uniquely
 * identifiable inside the matrix result.
 */
function buildSingleSampleTask(
  sample: EvalSample,
  cellSampleId: string,
): EvalTask {
  return {
    schemaVersion: 1,
    id: `pt-cell-${cellSampleId}`,
    name: "prompt-testing-cell",
    description: "synthetic single-sample task for prompt-testing variant cell",
    version: "1.0.0",
    runnable: true,
    samples: [{ ...sample, id: cellSampleId }],
  };
}

export async function runVariantMatrix(
  options: VariantMatrixOptions,
): Promise<PromptTestMatrixResult> {
  if (!options.variants || options.variants.length === 0) {
    throw new Error("runVariantMatrix: at least one variant required");
  }
  const trials = options.trials ?? 1;
  if (!Number.isInteger(trials) || trials < 1) {
    throw new Error("runVariantMatrix: trials must be an integer >= 1");
  }
  const userModels = options.models && options.models.length > 0
    ? options.models
    : null;
  const matrixModels = userModels ?? [MODEL_SENTINEL];
  const reportedModels = userModels ?? [];
  const timeoutMs = options.timeoutMs ?? 240_000;
  const grade = options.grade ?? defaultGrade;

  // Matrix-size guard. variants × models × trials.
  const maxCells = options.maxCells ?? DEFAULT_MAX_CELLS;
  if (!Number.isInteger(maxCells) || maxCells < 1) {
    throw new Error(
      `runVariantMatrix: maxCells must be a positive integer (got ${String(options.maxCells)})`,
    );
  }
  const planned = options.variants.length * matrixModels.length * trials;
  if (!options.force && planned > maxCells) {
    throw new Error(
      `runVariantMatrix: planned cells = ${planned} ` +
        `(variants=${options.variants.length} × models=${matrixModels.length} × trials=${trials}) ` +
        `exceeds maxCells=${maxCells}. Pass { maxCells: N } to raise the cap, ` +
        `or { force: true } to override (LIVE budgets can blow up quickly).`,
    );
  }

  // ---- Atomic materialization. If ANY variant fails, clean up all
  //      previously-created dirs before re-throwing.
  const materialized: MaterializedVariant[] = [];
  try {
    for (const v of options.variants) {
      materialized.push(await materializeVariant(v));
    }
  } catch (err) {
    for (const m of materialized) cleanupPluginDir(m.pluginDir);
    throw err;
  }

  const cells: PromptTestResult[] = [];
  const cleanupErrors: PluginDirCleanupError[] = [];

  try {
    for (const mat of materialized) {
      // Per-variant MatrixRunner: pluginDirs is baked into the driver
      // factory so every cell of this variant's matrix points at the
      // same materialized agent.
      const driverFactory = (): LiveDriver =>
        new LiveDriver(
          { timeout: timeoutMs },
          { pluginDirs: [mat.pluginDir] },
        );

      // Construct one task per (variant, model) cell so case ids stay
      // unique inside the run. We then drive the runner per (variant,model)
      // because MatrixRunner runs all (model, config) combinations against a
      // single task; per-cell trial bookkeeping comes from MultiTrialResult.
      for (const model of matrixModels) {
        const cellSampleId =
          `${options.sample.id}::${mat.variant.id}` +
          `::${model === MODEL_SENTINEL ? "default" : model}`;
        const task = buildSingleSampleTask(options.sample, cellSampleId);

        // Run a per-(variant, model) MatrixRunner restricted to the single
        // model. This isolates failure modes per model and keeps the
        // variants × models loop explicit for our PromptTestResult mapping.
        const perModelRunner = new MatrixRunner({
          driverFactory,
          models: [model],
          configs: [PROMPT_TESTING_CONFIG],
          trials,
          maxCells: trials,
        });
        let matrixResult: Awaited<ReturnType<MatrixRunner["runTask"]>>;
        try {
          matrixResult = await perModelRunner.runTask(task);
        } catch (err) {
          // Catastrophic failure of the runner itself (not a per-trial
          // infraError). Synthesize errored cells for every trial.
          const message = err instanceof Error ? err.message : String(err);
          for (let trial = 0; trial < trials; trial++) {
            const cell: PromptTestResult = {
              variantId: mat.variant.id,
              trial,
              sampleId: cellSampleId,
              toolCallAccuracy: 0,
              instructionFollowing: 0,
              latencyMs: 0,
              observedToolCalls: [],
              finalResponse: "",
              errored: true,
              errorMessage: message,
            };
            if (model !== MODEL_SENTINEL) cell.model = model;
            cells.push(cell);
          }
          continue;
        }

        // Reference matrixResult to silence unused-variable when no models
        // run (cannot happen here but keeps the type narrow).
        void matrixResult;

        // Map per-trial CaseResults from the inner MultiTrialResult into our
        // PromptTestResult shape.
        const matrixCell = perModelRunnerCell(matrixResult, model);
        const rawRuns = matrixCell.result.rawRuns;
        for (let trial = 0; trial < trials; trial++) {
          const run = rawRuns[trial];
          const c = run?.cases.find((x) => x.caseId === cellSampleId);
          if (!c) {
            const cell: PromptTestResult = {
              variantId: mat.variant.id,
              trial,
              sampleId: cellSampleId,
              toolCallAccuracy: 0,
              instructionFollowing: 0,
              latencyMs: 0,
              observedToolCalls: [],
              finalResponse: "",
              errored: true,
              errorMessage: "no case result emitted by runner (lost trial)",
            };
            if (model !== MODEL_SENTINEL) cell.model = model;
            cells.push(cell);
            continue;
          }
          if (c.infraError) {
            const cell: PromptTestResult = {
              variantId: mat.variant.id,
              trial,
              sampleId: cellSampleId,
              toolCallAccuracy: 0,
              instructionFollowing: 0,
              latencyMs: 0,
              observedToolCalls: [],
              finalResponse: "",
              errored: true,
              errorMessage: c.infraError,
            };
            if (model !== MODEL_SENTINEL) cell.model = model;
            cells.push(cell);
            continue;
          }
          const observed = c.observed;
          const graded = grade(options.sample, observed);
          const cell: PromptTestResult = {
            variantId: mat.variant.id,
            trial,
            sampleId: cellSampleId,
            toolCallAccuracy: graded.toolCallAccuracy,
            instructionFollowing: graded.instructionFollowing,
            latencyMs: observed.latencyMs,
            observedToolCalls: observed.toolCalls,
            finalResponse: observed.finalResponse,
          };
          if (model !== MODEL_SENTINEL) cell.model = model;
          if (graded.responseQuality !== undefined) cell.responseQuality = graded.responseQuality;
          if (graded.injectionResistance !== undefined) {
            cell.injectionResistance = graded.injectionResistance;
          }
          cells.push(cell);
        }
      }
    }
  } finally {
    for (const mat of materialized) {
      const err = cleanupPluginDir(mat.pluginDir);
      if (err) cleanupErrors.push(err);
    }
  }

  return summarize({
    baseline: options.baseline,
    variants: options.variants,
    models: reportedModels,
    cells,
    cleanupErrors,
  });
}

function perModelRunnerCell(
  matrixResult: Awaited<ReturnType<MatrixRunner["runTask"]>>,
  model: string,
): MatrixCell {
  const cell = matrixResult.cells.find((c) => c.model === model);
  if (!cell) {
    throw new Error(
      `runVariantMatrix: internal — MatrixRunner returned no cell for model ${model}`,
    );
  }
  return cell;
}

interface SummarizeArgs {
  baseline: PromptUnderTest;
  variants: PromptVariant[];
  models: string[];
  cells: PromptTestResult[];
  cleanupErrors: PluginDirCleanupError[];
}

function summarize(args: SummarizeArgs): PromptTestMatrixResult {
  const { baseline, variants, models, cells, cleanupErrors } = args;
  const perVariant: Record<string, PerVariantSummary> = {};
  const perModel: Record<string, PerModelSummary> = {};
  const crossCells: Record<string, Record<string, number>> = {};

  for (const v of variants) {
    const variantCells = cells.filter((c) => c.variantId === v.id);
    perVariant[v.id] = aggregateVariant(variantCells);
  }
  if (models.length > 0) {
    for (const m of models) {
      const modelCells = cells.filter((c) => c.model === m);
      perModel[m] = aggregateModel(modelCells);
    }
    for (const v of variants) {
      crossCells[v.id] = {};
      for (const m of models) {
        const cellSubset = cells.filter((c) => c.variantId === v.id && c.model === m);
        crossCells[v.id]![m] = passRate(cellSubset);
      }
    }
  }

  const result: PromptTestMatrixResult = {
    baseline,
    variants,
    models,
    cells,
    summary: { perVariant, perModel, crossCells },
  };
  if (cleanupErrors.length > 0) result.cleanupErrors = cleanupErrors;
  return result;
}

function aggregateVariant(cells: PromptTestResult[]): PerVariantSummary {
  if (cells.length === 0) {
    return { passRate: 0, meanLatency: 0, toolCallAccuracy: 0 };
  }
  const valid = cells.filter((c) => !c.errored);
  const passRate = valid.length === 0 ? 0 : valid.filter((c) => isPass(c)).length / valid.length;
  const meanLatency =
    valid.length === 0 ? 0 : valid.reduce((acc, c) => acc + c.latencyMs, 0) / valid.length;
  const toolCallAccuracy =
    valid.length === 0 ? 0 : valid.reduce((acc, c) => acc + c.toolCallAccuracy, 0) / valid.length;
  return { passRate, meanLatency, toolCallAccuracy };
}

function aggregateModel(cells: PromptTestResult[]): PerModelSummary {
  if (cells.length === 0) return { passRate: 0, meanLatency: 0 };
  const valid = cells.filter((c) => !c.errored);
  const passRate = valid.length === 0 ? 0 : valid.filter((c) => isPass(c)).length / valid.length;
  const meanLatency =
    valid.length === 0 ? 0 : valid.reduce((acc, c) => acc + c.latencyMs, 0) / valid.length;
  return { passRate, meanLatency };
}

function passRate(cells: PromptTestResult[]): number {
  const valid = cells.filter((c) => !c.errored);
  if (valid.length === 0) return 0;
  return valid.filter((c) => isPass(c)).length / valid.length;
}

function isPass(c: PromptTestResult): boolean {
  // Default pass criterion: tool-call accuracy and instruction-following both >= 0.5.
  return c.toolCallAccuracy >= 0.5 && c.instructionFollowing >= 0.5;
}
