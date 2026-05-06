/**
 * Robustness suite — mutates the *user prompt* (not the agent prompt) to test
 * whether the agent's behavior is stable under paraphrasing.
 *
 * Strategy: take a base sample, generate K paraphrased variants of the user
 * prompt, and run all of them under the same prompt variant. Stability =
 * stddev of toolCallAccuracy across paraphrases.
 *
 * # Paraphrase source
 *
 * Two modes, in priority order:
 *   1. Caller supplies `paraphrases: string[]` — fully deterministic.
 *      THIS IS THE PRODUCTION-RECOMMENDED PATH.
 *   2. Caller supplies only `count` — the suite calls the OpenAI API at
 *      `gpt-4o-mini` to generate paraphrases. REQUIRES `OPENAI_API_KEY`.
 *      Without the key, `runRobustnessSuite()` throws immediately with a
 *      clear error. There is no template-fallback path; LLM-paraphrasing
 *      without an LLM is silently degenerate and would mask robustness
 *      regressions.
 *
 * The paraphrase carried for each variant is recorded on
 * `PromptVariant.paraphrase` so reports can attribute behavior changes.
 */

import { runVariantMatrix } from "../variant-runner.js";
import type { EvalSample } from "../../types.js";
import type {
  PromptTestMatrixResult,
  PromptTestResult,
  PromptUnderTest,
  PromptVariant,
  PerVariantSummary,
  PerModelSummary,
} from "../types.js";

export interface RunRobustnessSuiteOptions {
  baseline: PromptUnderTest;
  /** Single agent-prompt variant under test. */
  variant: PromptVariant;
  /** Base sample whose `input.prompt` will be paraphrased. */
  sample: EvalSample;
  /** Hand-authored paraphrased prompts (preferred — deterministic). */
  paraphrases?: string[];
  /** Number of paraphrases when not provided (used for LLM mode only). */
  count?: number;
  models?: string[];
  trials?: number;
  timeoutMs?: number;
}

interface OpenAIChatResponse {
  choices?: Array<{ message?: { content?: string } }>;
  error?: { message?: string };
}

async function llmParaphrase(prompt: string, count: number): Promise<string[]> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error(
      "robustness: paraphrase generation requires OPENAI_API_KEY when paraphrases[] is not provided",
    );
  }
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      temperature: 0.7,
      messages: [
        {
          role: "system",
          content:
            "You generate paraphrases of a user prompt that preserve the exact request and any " +
            "specific tool / number / verb the user mentioned. Output ONE paraphrase per line, " +
            "no numbering, no commentary.",
        },
        { role: "user", content: `Generate ${count} paraphrases of:\n\n${prompt}` },
      ],
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "<unreadable>");
    throw new Error(`robustness: OpenAI HTTP ${res.status}: ${text.slice(0, 400)}`);
  }
  const json = (await res.json()) as OpenAIChatResponse;
  if (json.error?.message) {
    throw new Error(`robustness: OpenAI error: ${json.error.message}`);
  }
  const content = json.choices?.[0]?.message?.content ?? "";
  const lines = content.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
  if (lines.length < count) {
    throw new Error(
      `robustness: paraphraser returned ${lines.length} lines, expected ${count}`,
    );
  }
  return lines.slice(0, count);
}

export interface RobustnessResult {
  matrix: PromptTestMatrixResult;
  paraphrases: string[];
  /** Standard deviation of `toolCallAccuracy` across paraphrases. */
  toolCallAccuracyStddev: number;
  /** Mean tool-call accuracy across paraphrases. */
  toolCallAccuracyMean: number;
}

function stddev(values: number[]): number {
  if (values.length === 0) return 0;
  const mean = values.reduce((acc, v) => acc + v, 0) / values.length;
  const variance =
    values.reduce((acc, v) => acc + (v - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

function makeParaphraseVariant(
  baseVariant: PromptVariant,
  paraphrase: string,
  index: number,
): PromptVariant {
  const v: PromptVariant = {
    id: `${baseVariant.id}::para-${index}`,
    baseline: baseVariant.baseline,
    paraphrase,
  };
  if (baseVariant.mutation) v.mutation = baseVariant.mutation;
  if (baseVariant.override) v.override = baseVariant.override;
  return v;
}

export async function runRobustnessSuite(
  options: RunRobustnessSuiteOptions,
): Promise<RobustnessResult> {
  const count = options.count ?? 3;
  const paraphrases =
    options.paraphrases && options.paraphrases.length > 0
      ? options.paraphrases
      : await llmParaphrase(options.sample.input.prompt, count);

  // Build one variant per paraphrase, all sharing the same agent-prompt
  // override (so we vary the user prompt, not the system prompt).
  const variants: PromptVariant[] = paraphrases.map((p, i) =>
    makeParaphraseVariant(options.variant, p, i),
  );

  const reportedModels = options.models?.filter((m) => m !== "") ?? [];

  // Run each paraphrase as its own single-variant matrix call (because
  // `runVariantMatrix` cannot take a per-variant sample), then aggregate.
  const cells: PromptTestResult[] = [];
  const cleanupErrors: NonNullable<PromptTestMatrixResult["cleanupErrors"]> = [];
  for (let i = 0; i < paraphrases.length; i++) {
    const p = paraphrases[i]!;
    const sample: EvalSample = {
      ...options.sample,
      id: `${options.sample.id}::para-${i}`,
      input: { ...options.sample.input, prompt: p },
    };
    const matrixOpts: Parameters<typeof runVariantMatrix>[0] = {
      baseline: options.baseline,
      variants: [variants[i]!],
      sample,
    };
    if (options.models) matrixOpts.models = options.models;
    if (options.trials !== undefined) matrixOpts.trials = options.trials;
    if (options.timeoutMs !== undefined) matrixOpts.timeoutMs = options.timeoutMs;
    const sub = await runVariantMatrix(matrixOpts);
    cells.push(...sub.cells);
    if (sub.cleanupErrors && sub.cleanupErrors.length > 0) {
      cleanupErrors.push(...sub.cleanupErrors);
    }
  }

  // Per-variant + per-model + cross-cell summaries.
  const perVariant: Record<string, PerVariantSummary> = {};
  for (const v of variants) {
    const variantCells = cells.filter((c) => c.variantId === v.id);
    const valid = variantCells.filter((c) => !c.errored);
    const meanLatency =
      valid.length === 0 ? 0 : valid.reduce((a, c) => a + c.latencyMs, 0) / valid.length;
    const meanAccuracy =
      valid.length === 0 ? 0 : valid.reduce((a, c) => a + c.toolCallAccuracy, 0) / valid.length;
    perVariant[v.id] = {
      passRate: meanAccuracy,
      meanLatency,
      toolCallAccuracy: meanAccuracy,
    };
  }

  const perModel: Record<string, PerModelSummary> = {};
  const crossCells: Record<string, Record<string, number>> = {};
  if (reportedModels.length > 0) {
    for (const m of reportedModels) {
      const modelCells = cells.filter((c) => c.model === m);
      const valid = modelCells.filter((c) => !c.errored);
      const meanLatency =
        valid.length === 0 ? 0 : valid.reduce((a, c) => a + c.latencyMs, 0) / valid.length;
      const passRate =
        valid.length === 0
          ? 0
          : valid.filter((c) => c.toolCallAccuracy >= 0.5 && c.instructionFollowing >= 0.5).length /
            valid.length;
      perModel[m] = { passRate, meanLatency };
    }
    for (const v of variants) {
      crossCells[v.id] = {};
      for (const m of reportedModels) {
        const subset = cells.filter((c) => c.variantId === v.id && c.model === m);
        const valid = subset.filter((c) => !c.errored);
        crossCells[v.id]![m] =
          valid.length === 0
            ? 0
            : valid.filter((c) => c.toolCallAccuracy >= 0.5 && c.instructionFollowing >= 0.5).length /
              valid.length;
      }
    }
  }

  const matrix: PromptTestMatrixResult = {
    baseline: options.baseline,
    variants,
    models: reportedModels,
    cells,
    summary: { perVariant, perModel, crossCells },
  };
  if (cleanupErrors.length > 0) matrix.cleanupErrors = cleanupErrors;

  const accuracies = cells.filter((c) => !c.errored).map((c) => c.toolCallAccuracy);
  const mean =
    accuracies.length === 0 ? 0 : accuracies.reduce((a, v) => a + v, 0) / accuracies.length;
  return {
    matrix,
    paraphrases,
    toolCallAccuracyStddev: stddev(accuracies),
    toolCallAccuracyMean: mean,
  };
}
