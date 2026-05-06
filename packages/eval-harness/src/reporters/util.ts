import type {
  MatrixCell,
  MatrixResult,
  MultiTrialResult,
  SampleTrialResult,
} from "../types.js";
import {
  formatPValue as formatPValueCanonical,
  formatRate as formatRateCanonical,
} from "./format.js";

export function escapeMarkdownCell(value: unknown): string {
  return String(value)
    .replace(/\r\n|\r|\n/g, " ")
    .replace(/[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g, "")
    .replace(/\|/g, "\\|")
    .replace(/`/g, "\\`")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/@/g, "&#64;")
    .replace(/([[\]()!*_~])/g, "\\$1")
    .replace(/^#/g, "\\#");
}

export function pct(rate: number | undefined): string {
  // Delegate to canonical formatter then strip the trailing "%" so existing
  // call sites that build "{pct}%" templates keep working unchanged.
  const formatted = formatRateCanonical(rate, 1);
  if (formatted === "—") return "—";
  return formatted.slice(0, -1);
}

/**
 * Format a p-value for markdown rendering. Non-finite values (NaN, ±Infinity)
 * render as an em-dash so that statistically meaningless cells do not leak
 * "NaN"/"Infinity" tokens into PR comments. Delegates to the canonical
 * `formatPValue` in `./format.ts`.
 */
export function formatPValue(p: number | undefined): string {
  return formatPValueCanonical(p);
}

export function collectKs(samples: SampleTrialResult[]): number[] {
  const set = new Set<number>();
  for (const s of samples) {
    for (const k of Object.keys(s.passAtK)) set.add(Number(k));
  }
  return [...set].filter((k) => Number.isFinite(k)).sort((a, b) => a - b);
}

export function formatPassAtKCell(s: SampleTrialResult, k: number): string {
  if (k > s.trials) return "—";
  const v = s.passAtK[k];
  if (v === undefined) return "—";
  // H6 (iter19): only render finite rates in [0,1]; NaN/Infinity/out-of-range
  // collapse to the missing-value glyph rather than leaking literal `NaN`.
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 1) {
    return "—";
  }
  return v.toFixed(2);
}

export function formatPassRateCell(s: SampleTrialResult): string {
  const nonErrorTrials = s.trials - s.errorCount;
  const denominator = Math.max(0, nonErrorTrials);
  if (s.noQualitySignal || s.passRate === undefined) {
    return s.errorCount > 0
      ? `n/a (0/${denominator} quality, ${s.errorCount} infra errors)`
      : `n/a (0/${denominator})`;
  }
  if (s.errorCount > 0) {
    return `${pct(s.passRate)}% (${s.passCount}/${denominator} quality, ${s.errorCount} infra errors)`;
  }
  return `${pct(s.passRate)}% (${s.passCount}/${denominator})`;
}

export function countMultiTrialInfraErrors(result: MultiTrialResult): number {
  return result.samples.reduce((sum, sample) => sum + sample.errorCount, 0);
}

export function formatMatrixCell(result: MultiTrialResult): string {
  const ci = result.summary.pooledPassRateCI ?? result.summary.passRateCI;
  const infraErrors = countMultiTrialInfraErrors(result);
  const infraClause = infraErrors > 0 ? ` (${infraErrors} infra errors)` : "";
  const rate = result.summary.noQualitySignal ? "n/a" : `${pct(result.summary.meanPassRate)}%`;
  return `${rate} (CI: ${pct(ci.lower)}-${pct(ci.upper)}%)${infraClause}`;
}

export function findCell(
  cells: MatrixCell[],
  model: string,
  configId: string,
): MatrixCell | undefined {
  return cells.find((c) => c.model === model && c.configId === configId);
}

export function multiTrialMarkdown(
  result: MultiTrialResult,
  options: { title?: string; includeTaskVersion?: boolean; includeModel?: boolean } = {},
): string {
  const lines: string[] = [];
  const { taskId, trials, summary, samples, model } = result;
  lines.push(`## ${options.title ?? "Multi-Trial"}: ${escapeMarkdownCell(taskId)}`);
  lines.push("");
  if (options.includeTaskVersion) {
    lines.push(`**Task Version:** ${escapeMarkdownCell(result.taskVersion)}  `);
  }
  if (options.includeModel && model) {
    lines.push(`**Model:** ${escapeMarkdownCell(model)}  `);
  }
  lines.push(`**Trials:** ${trials}  `);
  lines.push(
    `**Mean Pass Rate:** ${summary.noQualitySignal ? "n/a" : `${pct(summary.meanPassRate)}%`}  `,
  );
  lines.push(
    `**Pooled Pass Rate CI:** ${pct((summary.pooledPassRateCI ?? summary.passRateCI).lower)}-${pct((summary.pooledPassRateCI ?? summary.passRateCI).upper)}%  `,
  );
  lines.push("");

  const ks = collectKs(samples);
  const header = ["Sample", "Pass Rate", ...ks.map((k) => `pass@${k}`)];
  lines.push(`| ${header.join(" | ")} |`);
  lines.push(`|${header.map(() => "---").join("|")}|`);

  for (const s of samples) {
    const rateCell = formatPassRateCell(s);
    const kCells = ks.map((k) => formatPassAtKCell(s, k));
    lines.push(`| ${escapeMarkdownCell(s.sampleId)} | ${rateCell} | ${kCells.join(" | ")} |`);
  }
  lines.push("");
  return lines.join("\n");
}

export function matrixMarkdown(
  result: MatrixResult,
  options: { includePerSampleBreakdown?: boolean } = {},
): string {
  const lines: string[] = [];
  const { taskId, taskVersion, gitSha, models, configs, cells, summary } = result;
  const trials = cells[0]?.result.trials ?? 0;

  lines.push(`## Eval Matrix: ${escapeMarkdownCell(taskId)}`);
  lines.push("");
  lines.push(`**Task:** ${escapeMarkdownCell(taskId)} v${escapeMarkdownCell(taskVersion)}  `);
  lines.push(`**Trials per cell:** ${trials}  `);
  if (gitSha) lines.push(`**Git SHA:** ${escapeMarkdownCell(gitSha)}  `);
  lines.push("");

  lines.push(`### Pass Rates`);
  lines.push("");
  const header = ["Model", ...configs.map((c) => escapeMarkdownCell(c.label))];
  lines.push(`| ${header.join(" | ")} |`);
  lines.push(`|${header.map(() => "---").join("|")}|`);
  for (const m of models) {
    const row: string[] = [escapeMarkdownCell(m)];
    for (const cfg of configs) {
      const cell = findCell(cells, m, cfg.id);
      if (!cell) {
        row.push("—");
        continue;
      }
      row.push(formatMatrixCell(cell.result));
    }
    lines.push(`| ${row.join(" | ")} |`);
  }
  lines.push("");

  lines.push(`### Best / Worst`);
  lines.push("");
  const best = findCell(cells, summary.bestPassRate.model, summary.bestPassRate.configId);
  const worst = findCell(cells, summary.worstPassRate.model, summary.worstPassRate.configId);
  if (best) {
    lines.push(
      `- **Best:** ${escapeMarkdownCell(best.model)} × ${escapeMarkdownCell(best.configLabel)} — ${pct(summary.bestPassRate.passRate)}%`,
    );
  }
  if (worst) {
    lines.push(
      `- **Worst:** ${escapeMarkdownCell(worst.model)} × ${escapeMarkdownCell(worst.configLabel)} — ${pct(summary.worstPassRate.passRate)}%`,
    );
  }
  lines.push("");

  if (options.includePerSampleBreakdown) {
    lines.push(`### Per-Sample Breakdown`);
    lines.push("");
    for (const cell of cells) {
      const cellRate = pct(cell.result.summary.meanPassRate);
      lines.push("<details>");
      lines.push(`<summary>${escapeMarkdownCell(cell.model)} × ${escapeMarkdownCell(cell.configLabel)} (${cellRate}%)</summary>`);
      lines.push("");
      const ks = collectKs(cell.result.samples);
      const subHeader = ["Sample", "Pass Rate", ...ks.map((k) => `pass@${k}`)];
      lines.push(`| ${subHeader.join(" | ")} |`);
      lines.push(`|${subHeader.map(() => "---").join("|")}|`);
      if (cell.result.samples.length === 0) {
        lines.push(`| — | — |`);
      }
      for (const s of cell.result.samples) {
        const rateCell = formatPassRateCell(s);
        const kCells = ks.map((k) => formatPassAtKCell(s, k));
        lines.push(`| ${escapeMarkdownCell(s.sampleId)} | ${rateCell} | ${kCells.join(" | ")} |`);
      }
      lines.push("");
      lines.push("</details>");
      lines.push("");
    }
  }

  return lines.join("\n");
}
