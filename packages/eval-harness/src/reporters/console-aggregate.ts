import type { MultiTrialResult, MatrixResult, MatrixCell } from "../types.js";
import type { AggregateReporter } from "./aggregate-types.js";
import { formatMatrixCell, formatPassRateCell } from "./util.js";
import { formatRate, MISSING_VALUE_GLYPH } from "./format.js";

/**
 * Render a rate as a percentage string (digits=1) WITHOUT the trailing `%`.
 * H5 (iter19): all rate-like formatting in this reporter MUST go through
 * the canonical `formatRate` helper so out-of-range / NaN / Infinity values
 * collapse to the missing-value glyph instead of leaking `150.0%` /
 * `[-10.0%, 120.0%]` / `NaN` into operator output.
 */
function pct(rate: number | undefined): string {
  const formatted = formatRate(rate, 1);
  if (formatted === MISSING_VALUE_GLYPH) return MISSING_VALUE_GLYPH;
  return formatted.slice(0, -1);
}

function iconFor(rate: number | undefined): string {
  if (rate === undefined || !Number.isFinite(rate)) return "⚪";
  if (rate < 0 || rate > 1) return "⚪";
  if (rate >= 0.9) return "✅";
  if (rate >= 0.5) return "⚠️";
  return "❌";
}

function formatPassAtK(passAtK: Record<number, number>): string {
  const keys = Object.keys(passAtK)
    .map((k) => Number(k))
    .filter((k) => Number.isFinite(k))
    .sort((a, b) => a - b);
  return keys
    .map((k) => {
      const v = passAtK[k];
      // H6 (iter19): only render finite rates in [0,1]. NaN/Infinity/out-of-range
      // collapse to the missing-value glyph.
      if (typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1) {
        return `pass@${k}=${v.toFixed(2)}`;
      }
      return `pass@${k}=${MISSING_VALUE_GLYPH}`;
    })
    .join("  ");
}

function durationMs(startedAt: string, finishedAt: string): number | null {
  const s = Date.parse(startedAt);
  const f = Date.parse(finishedAt);
  if (Number.isNaN(s) || Number.isNaN(f)) return null;
  return f - s;
}

export class ConsoleAggregateReporter implements AggregateReporter {
  onMultiTrialComplete(result: MultiTrialResult): void {
    const { taskId, trials, summary, samples } = result;
    const meanPct = summary.noQualitySignal ? "n/a" : `${pct(summary.meanPassRate)}%`;
    const stdPct = pct(summary.stddevPassRate);
    const pooledCi = summary.pooledPassRateCI ?? summary.passRateCI;
    const loPct = pct(pooledCi.lower);
    const hiPct = pct(pooledCi.upper);

    console.log(`━━━ Multi-Trial: ${taskId} (${trials} trials) ━━━`);
    console.log(
      `  Mean pass rate: ${meanPct} (±${stdPct}%); pooled pass-rate CI: [${loPct}%, ${hiPct}%]`,
    );
    console.log(`  Samples:`);

    const maxIdLen = samples.reduce((m, s) => Math.max(m, s.sampleId.length), 0);
    let aboveHalf = 0;
    for (const s of samples) {
      if (s.passRate !== undefined && s.passRate > 0.5) aboveHalf++;
      const icon = iconFor(s.passRate);
      const idPad = s.sampleId.padEnd(maxIdLen);
      const rateCell = formatPassRateCell(s);
      const kStr = formatPassAtK(s.passAtK);
      console.log(
        `    ${icon} ${idPad}: ${rateCell}  ${kStr}`.trimEnd(),
      );
    }

    console.log(
      `━━━ Results: ${aboveHalf}/${samples.length} samples >50% pass rate ━━━`,
    );
    const dur = durationMs(result.startedAt, result.finishedAt);
    if (dur !== null) console.log(`Duration: ${dur}ms`);
  }

  onMatrixComplete(result: MatrixResult): void {
    const { taskId, models, configs, cells, summary } = result;
    const trials = cells[0]?.result.trials ?? 0;

    console.log(
      `━━━ Matrix: ${taskId} (${models.length}×${configs.length}, ${trials} trials) ━━━`,
    );
    console.log("");

    const headerCols = ["Model / Config", ...configs.map((c) => c.label)];
    const rows: string[][] = [];
    for (const m of models) {
      const row: string[] = [m];
      for (const cfg of configs) {
        const cell = cells.find((c) => c.model === m && c.configId === cfg.id);
        row.push(cell ? formatMatrixCell(cell.result) : "—");
      }
      rows.push(row);
    }

    const widths = headerCols.map((h, i) =>
      Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)),
    );
    const pad = (val: string, i: number): string => val.padEnd(widths[i]!);
    const sep = widths.map((w) => "-".repeat(w)).map((s, i) => (i === 0 ? s : s));

    console.log(`| ${headerCols.map((h, i) => pad(h, i)).join(" | ")} |`);
    console.log(`|${sep.map((s) => `-${s}-`).join("|")}|`);
    for (const row of rows) {
      console.log(`| ${row.map((v, i) => pad(v, i)).join(" | ")} |`);
    }
    console.log("");

    const bestCell = findCell(cells, summary.bestPassRate.model, summary.bestPassRate.configId);
    const worstCell = findCell(cells, summary.worstPassRate.model, summary.worstPassRate.configId);
    if (bestCell) {
      console.log(
        `Best:  ${bestCell.model} × ${bestCell.configLabel} (${pct(summary.bestPassRate.passRate)}%)`,
      );
    }
    if (worstCell) {
      console.log(
        `Worst: ${worstCell.model} × ${worstCell.configLabel} (${pct(summary.worstPassRate.passRate)}%)`,
      );
    }

    const dur = durationMs(result.startedAt, result.finishedAt);
    if (dur !== null) console.log(`━━━ Duration: ${dur}ms ━━━`);
  }
}

function findCell(cells: MatrixCell[], model: string, configId: string): MatrixCell | undefined {
  return cells.find((c) => c.model === model && c.configId === configId);
}
