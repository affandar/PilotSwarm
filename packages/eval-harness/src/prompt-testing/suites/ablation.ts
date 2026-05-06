/**
 * Ablation suite — measures *functional impact* of a prompt mutation by
 * running the same task under (baseline, variant) and comparing tool-call
 * accuracy + response quality.
 *
 * Reuses `runVariantMatrix` and the existing `tool-call-correctness.v1.json`
 * dataset (configurable).
 */

import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadEvalTask } from "../../loader.js";
import { runVariantMatrix } from "../variant-runner.js";
import type {
  PromptTestMatrixResult,
  PromptUnderTest,
  PromptVariant,
} from "../types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_DATASET = resolve(__dirname, "../../../datasets/tool-call-correctness.v1.json");

export interface RunAblationSuiteOptions {
  baseline: PromptUnderTest;
  variants: PromptVariant[];
  /** Path to an EvalTask JSON. Defaults to tool-call-correctness.v1.json. */
  datasetPath?: string;
  /** Sample id to use. If omitted, uses the first sample in the dataset. */
  sampleId?: string;
  models?: string[];
  trials?: number;
  timeoutMs?: number;
}

export async function runAblationSuite(
  options: RunAblationSuiteOptions,
): Promise<PromptTestMatrixResult> {
  const path = options.datasetPath ?? DEFAULT_DATASET;
  const task = loadEvalTask(path);
  const sample = options.sampleId
    ? task.samples.find((s) => s.id === options.sampleId)
    : task.samples[0];
  if (!sample) {
    throw new Error(
      `runAblationSuite: sample ${options.sampleId ?? "<first>"} not found in ${path}`,
    );
  }
  const matrixOpts: Parameters<typeof runVariantMatrix>[0] = {
    baseline: options.baseline,
    variants: options.variants,
    sample,
  };
  if (options.models) matrixOpts.models = options.models;
  if (options.trials !== undefined) matrixOpts.trials = options.trials;
  if (options.timeoutMs !== undefined) matrixOpts.timeoutMs = options.timeoutMs;
  return await runVariantMatrix(matrixOpts);
}

/**
 * Compare ablation pass rates of one variant against another (e.g. baseline
 * vs minimize-50). Returns {delta, baselineRate, variantRate}. A negative
 * delta indicates the variant degrades the metric.
 */
export interface AblationDelta {
  baselineRate: number;
  variantRate: number;
  delta: number;
  metric: "passRate" | "toolCallAccuracy";
}

export function computeAblationDelta(
  result: PromptTestMatrixResult,
  baselineVariantId: string,
  candidateVariantId: string,
  metric: "passRate" | "toolCallAccuracy" = "toolCallAccuracy",
): AblationDelta {
  const b = result.summary.perVariant[baselineVariantId];
  const c = result.summary.perVariant[candidateVariantId];
  if (!b) throw new Error(`baseline variant '${baselineVariantId}' not in matrix summary`);
  if (!c) throw new Error(`candidate variant '${candidateVariantId}' not in matrix summary`);
  const baselineRate = metric === "passRate" ? b.passRate : b.toolCallAccuracy;
  const variantRate = metric === "passRate" ? c.passRate : c.toolCallAccuracy;
  return {
    baselineRate,
    variantRate,
    delta: variantRate - baselineRate,
    metric,
  };
}
