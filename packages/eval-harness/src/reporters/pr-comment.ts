import { appendFileSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { dirname } from "node:path";

import type {
  CIGateResult,
  MatrixResult,
  MultiTrialResult,
  RegressionResult,
} from "../types.js";
import type { AggregateReporter } from "./aggregate-types.js";
import { escapeMarkdownCell, formatPValue, matrixMarkdown, multiTrialMarkdown, pct } from "./util.js";

function gateResultMarkdown(
  gate: CIGateResult,
  regressions?: RegressionResult[],
  extras?: { noQualityCurrentSamples?: string[] },
): string {
  const lines: string[] = [];
  const badge = gate.pass ? "✅ **PASS**" : "❌ **FAIL**";
  lines.push(`## CI Gate: ${badge}`);
  lines.push("");

  if (gate.passRate !== undefined) {
    lines.push(`**Pass Rate:** ${pct(gate.passRate)}%  `);
  }
  if (gate.regressionCount !== undefined) {
    lines.push(`**Regressions:** ${gate.regressionCount}  `);
  }
  if (gate.totalCostUsd !== undefined) {
    lines.push(`**Total Cost:** $${gate.totalCostUsd.toFixed(4)}  `);
  }
  lines.push("");

  lines.push(`### Reasons`);
  lines.push("");
  for (const r of gate.reasons) {
    lines.push(`- ${escapeMarkdownCell(r)}`);
  }
  lines.push("");

  if (regressions && regressions.length > 0) {
    // F21: column header reflects whether the displayed p-value is raw or
    // multiple-testing-corrected. RegressionDetector applies the same
    // correction across all regressions in a detection result, so derive the
    // label from the first non-"none" correction encountered.
    const correctionInUse = regressions
      .map((r) => r.correction)
      .find((c) => c && c !== "none");
    const pValueHeader = correctionInUse
      ? `p-value (adjusted, ${correctionInUse})`
      : `p-value`;

    lines.push(`### Sample Comparison vs Baseline`);
    lines.push("");
    lines.push(
      `| Sample | Baseline | Current | Δ | ${pValueHeader} | Direction |`,
    );
    lines.push(`|---|---|---|---|---|---|`);
    for (const r of regressions) {
      const delta = (r.currentPassRate - r.baselinePassRate) * 100;
      const sign = delta >= 0 ? "+" : "";
      const dirLabel = r.significant
        ? r.direction
        : `${r.direction} (n.s.)`;
      // F21: display the adjusted p-value when present so the rendered cell
      // matches the significance label (which is decided on adjustedPValue).
      // Fall back to raw pValue when adjustedPValue is missing.
      // F13: route through formatPValue so non-finite values (NaN, ±Infinity)
      // render as em-dash instead of leaking "NaN"/"Infinity" tokens.
      const displayedP = r.adjustedPValue ?? r.pValue;
      lines.push(
        `| ${escapeMarkdownCell(r.sampleId)} | ${pct(r.baselinePassRate)}% | ${pct(r.currentPassRate)}% | ${sign}${delta.toFixed(1)}pp | ${formatPValue(displayedP)} | ${escapeMarkdownCell(dirLabel)} |`,
      );
    }
    lines.push("");
  }

  // F1: render samples with no quality signal in their own section so they
  // are not confused with regressions. These are infra outages on the current
  // run side, not statistical regressions, so they have no baseline / current
  // / delta / p-value cells — only the sample IDs matter for triage.
  const noQualityIds = extras?.noQualityCurrentSamples ?? [];
  if (noQualityIds.length > 0) {
    lines.push(`### No Quality Signal`);
    lines.push("");
    lines.push(
      `The following sample(s) ran in the current job but produced no quality signal (treated as infra outages, not regressions):`,
    );
    lines.push("");
    for (const id of noQualityIds) {
      lines.push(`- ${escapeMarkdownCell(id)}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

export class PRCommentReporter implements AggregateReporter {
  private readonly outputPath: string;
  private wroteMainSection = false;

  constructor(outputPath: string) {
    this.outputPath = outputPath;
  }

  private ensureDir(): void {
    mkdirSync(dirname(this.outputPath), { recursive: true });
  }

  private writeOrAppend(content: string): void {
    this.ensureDir();
    if (!existsSync(this.outputPath) || !this.wroteMainSection) {
      writeFileSync(this.outputPath, content, "utf8");
      this.wroteMainSection = true;
    } else {
      appendFileSync(this.outputPath, `\n${content}`, "utf8");
    }
  }

  onMultiTrialComplete(result: MultiTrialResult): void {
    this.writeOrAppend(
      multiTrialMarkdown(result, {
        title: "Eval Results",
        includeTaskVersion: true,
        includeModel: true,
      }),
    );
  }

  onMatrixComplete(result: MatrixResult): void {
    this.writeOrAppend(matrixMarkdown(result));
  }

  writeGateResult(
    gate: CIGateResult,
    regressions?: RegressionResult[],
    extras?: { noQualityCurrentSamples?: string[] },
  ): void {
    this.ensureDir();
    const content = gateResultMarkdown(gate, regressions, extras);
    // F19: mirror writeOrAppend semantics — on a fresh reporter instance the
    // existing file may be stale (left over from a prior run). Only append
    // when this reporter has already written its own main section in this
    // process; otherwise overwrite to avoid emitting prior-run content.
    if (!existsSync(this.outputPath) || !this.wroteMainSection) {
      writeFileSync(this.outputPath, content, "utf8");
    } else {
      appendFileSync(this.outputPath, `\n${content}`, "utf8");
    }
    this.wroteMainSection = true;
  }
}
