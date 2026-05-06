/**
 * Unified prompt-testing reporter — emits a Markdown summary plus an optional
 * JSON artifact. Pure function: takes results, returns strings; the caller is
 * responsible for writing files (so tests can introspect the output without
 * touching the filesystem).
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { PromptTestMatrixResult } from "./types.js";
import type { DriftReport } from "./suites/regression.js";

export interface PromptTestingReportInput {
  /** One matrix per "section" in the report (e.g., per suite). */
  matrices: Array<{ title: string; matrix: PromptTestMatrixResult }>;
  drift?: Array<{ title: string; report: DriftReport }>;
  /** Optional commentary appended to the markdown output. */
  notes?: string;
}

export interface PromptTestingReport {
  markdown: string;
  json: PromptTestingReportInput;
}

export function renderReport(input: PromptTestingReportInput): PromptTestingReport {
  const lines: string[] = [];
  lines.push("# Prompt Testing Report");
  lines.push("");
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push("");

  for (const section of input.matrices) {
    lines.push(`## ${section.title}`);
    lines.push("");
    lines.push(`Baseline: \`${section.matrix.baseline.label}\``);
    lines.push("");
    lines.push("### Per-variant summary");
    lines.push("");
    lines.push("| variant | passRate | toolCallAccuracy | meanLatencyMs |");
    lines.push("| --- | ---: | ---: | ---: |");
    for (const variant of section.matrix.variants) {
      const v = section.matrix.summary.perVariant[variant.id];
      if (!v) continue;
      lines.push(
        `| \`${variant.id}\` | ${v.passRate.toFixed(3)} | ${v.toolCallAccuracy.toFixed(3)} | ${Math.round(v.meanLatency)} |`,
      );
    }
    lines.push("");
    if (section.matrix.models.length > 0) {
      lines.push("### Per-model summary");
      lines.push("");
      lines.push("| model | passRate | meanLatencyMs |");
      lines.push("| --- | ---: | ---: |");
      for (const model of section.matrix.models) {
        const m = section.matrix.summary.perModel[model];
        if (!m) continue;
        lines.push(
          `| \`${model}\` | ${m.passRate.toFixed(3)} | ${Math.round(m.meanLatency)} |`,
        );
      }
      lines.push("");
      lines.push("### Cross-cell pass rates (variant × model)");
      lines.push("");
      const header = ["variant", ...section.matrix.models].map((h) => `\`${h}\``);
      lines.push(`| ${header.join(" | ")} |`);
      lines.push(`| ${header.map(() => "---").join(" | ")} |`);
      for (const variant of section.matrix.variants) {
        const cells = section.matrix.summary.crossCells[variant.id] ?? {};
        const row = [
          `\`${variant.id}\``,
          ...section.matrix.models.map((m) =>
            cells[m] !== undefined ? cells[m]!.toFixed(3) : "-",
          ),
        ];
        lines.push(`| ${row.join(" | ")} |`);
      }
      lines.push("");
    }
    const errored = section.matrix.cells.filter((c) => c.errored);
    if (errored.length > 0) {
      lines.push(`### ⚠️  Errors (${errored.length} cell(s))`);
      lines.push("");
      lines.push("| variant | model | trial | sampleId | message |");
      lines.push("| --- | --- | ---: | --- | --- |");
      for (const c of errored) {
        const message = (c.errorMessage ?? "<no message>").replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
        const truncated = message.length > 240 ? `${message.slice(0, 237)}…` : message;
        lines.push(
          `| \`${c.variantId}\` | \`${c.model ?? "default"}\` | ${c.trial} | \`${c.sampleId ?? "-"}\` | ${truncated} |`,
        );
      }
      lines.push("");
    }
    if (section.matrix.cleanupErrors && section.matrix.cleanupErrors.length > 0) {
      lines.push(`### ⚠️  Plugin-dir cleanup errors (${section.matrix.cleanupErrors.length})`);
      lines.push("");
      lines.push("| pluginDir | error |");
      lines.push("| --- | --- |");
      for (const e of section.matrix.cleanupErrors) {
        const msg = e.error.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
        lines.push(`| \`${e.pluginDir}\` | ${msg.length > 240 ? `${msg.slice(0, 237)}…` : msg} |`);
      }
      lines.push("");
    }
  }

  if (input.drift && input.drift.length > 0) {
    lines.push("## Drift / Regression");
    lines.push("");
    for (const d of input.drift) {
      lines.push(`### ${d.title} — ${d.report.passed ? "✅ PASS" : "❌ FAIL"}`);
      lines.push("");
      lines.push(
        `golden: tcAcc=${d.report.golden.toolCallAccuracyMean.toFixed(3)}, ` +
          `instrFollow=${d.report.golden.instructionFollowingMean.toFixed(3)}, ` +
          `latencyMs=${Math.round(d.report.golden.latencyMsMean)}`,
      );
      lines.push(
        `current: tcAcc=${d.report.current.toolCallAccuracyMean.toFixed(3)}, ` +
          `instrFollow=${d.report.current.instructionFollowingMean.toFixed(3)}, ` +
          `latencyMs=${Math.round(d.report.current.latencyMsMean)}`,
      );
      if (d.report.reasons.length > 0) {
        lines.push("");
        lines.push("Reasons:");
        for (const r of d.report.reasons) lines.push(`- ${r}`);
      }
      if (d.report.notes && d.report.notes.length > 0) {
        lines.push("");
        lines.push("Notes:");
        for (const n of d.report.notes) lines.push(`- ${n}`);
      }
      if (d.report.perSample && d.report.perSample.length > 0) {
        const failedSamples = d.report.perSample.filter((s) => !s.passed);
        if (failedSamples.length > 0) {
          lines.push("");
          lines.push("Per-sample failures:");
          for (const s of failedSamples) {
            lines.push(`- \`${s.sampleId}\``);
            for (const r of s.reasons) lines.push(`  - ${r}`);
          }
        }
      }
      lines.push("");
    }
  }

  if (input.notes) {
    lines.push("## Notes");
    lines.push("");
    lines.push(input.notes);
    lines.push("");
  }

  return { markdown: lines.join("\n"), json: input };
}

export interface WriteReportOptions {
  /** Output dir for both the markdown and JSON files. */
  outDir: string;
  /** Markdown filename (default: prompt-testing-report.md). */
  markdownFile?: string;
  /** JSON filename (default: prompt-testing-results.json). */
  jsonFile?: string;
}

export function writeReport(
  report: PromptTestingReport,
  options: WriteReportOptions,
): { markdownPath: string; jsonPath: string } {
  const dir = resolve(options.outDir);
  mkdirSync(dir, { recursive: true });
  const mdName = options.markdownFile ?? "prompt-testing-report.md";
  const jsonName = options.jsonFile ?? "prompt-testing-results.json";
  const markdownPath = resolve(dir, mdName);
  const jsonPath = resolve(dir, jsonName);
  // Ensure the parent dir exists for nested paths.
  mkdirSync(dirname(markdownPath), { recursive: true });
  writeFileSync(markdownPath, report.markdown, "utf8");
  writeFileSync(jsonPath, JSON.stringify(report.json, null, 2) + "\n", "utf8");
  return { markdownPath, jsonPath };
}
