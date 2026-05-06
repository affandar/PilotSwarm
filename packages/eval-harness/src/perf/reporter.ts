/**
 * Unified perf reporter — renders a PerfReport (and optional budget check
 * result) as markdown for build artifacts and as JSON for CI ingestion.
 *
 * H6 fix: every advertised Tier 3 dimension has an explicit section,
 * including the ones the harness does not yet measure first-class
 * (`toolCallLatency`, `cleanupRate`, `coldVsWarm`). Missing sections
 * surface as a "Coverage" warning block so consumers see the gap rather
 * than silent absence.
 */

import type { PerfReport, PerfBudget, BudgetCheckResult } from "./perf-budget.js";

export interface RenderOptions {
  title?: string;
  budget?: PerfBudget;
  budgetResult?: BudgetCheckResult;
}

export function renderJson(report: PerfReport, opts: RenderOptions = {}): string {
  return JSON.stringify(
    {
      title: opts.title ?? "Perf Report",
      generatedAt: new Date().toISOString(),
      report,
      budget: opts.budget,
      budgetResult: opts.budgetResult,
      coverage: coverageSummary(report, opts.budget),
    },
    null,
    2,
  );
}

function fmt(n: number | undefined, digits = 2): string {
  if (n == null || !Number.isFinite(n)) return "n/a";
  return n.toFixed(digits);
}

interface CoverageSummary {
  measured: string[];
  unavailable: Array<{ dim: string; reason: string }>;
  missingButBudgeted: string[];
}

function coverageSummary(report: PerfReport, budget?: PerfBudget): CoverageSummary {
  const measured: string[] = [];
  const unavailable: Array<{ dim: string; reason: string }> = [];
  const missingButBudgeted: string[] = [];

  const probe = (
    dim: string,
    isMeasured: boolean,
    unavailableReason: string | undefined,
    isBudgeted: boolean,
  ): void => {
    if (isMeasured) measured.push(dim);
    else if (unavailableReason) unavailable.push({ dim, reason: unavailableReason });
    else if (isBudgeted) missingButBudgeted.push(dim);
  };

  probe("latency", !!report.latency && report.latency.count > 0, undefined, !!budget?.latency);
  probe("cost", !!report.cost && report.cost.trials > 0, undefined, !!budget?.cost);
  probe(
    "dbCalls",
    !!report.dbDelta && report.dbDelta.available,
    report.dbDelta && !report.dbDelta.available ? report.dbDelta.unavailableReason : undefined,
    !!budget?.dbQueries,
  );
  probe(
    "durability.rehydrate",
    !!report.durability?.rehydrate.available && report.durability.rehydrate.count > 0,
    !report.durability?.rehydrate.available ? report.durability?.rehydrate.unavailableReason : undefined,
    !!budget?.durability?.rehydrateP95Ms,
  );
  probe(
    "durability.replay",
    !!report.durability?.replay.available && report.durability.replay.count > 0,
    !report.durability?.replay.available ? report.durability?.replay.unavailableReason : undefined,
    !!budget?.durability?.replayP95Ms,
  );
  probe(
    "durability.checkpoint",
    !!report.durability?.checkpoint.available && report.durability.checkpoint.count > 0,
    !report.durability?.checkpoint.available ? report.durability?.checkpoint.unavailableReason : undefined,
    !!budget?.durability?.checkpointP95Ms,
  );
  probe(
    "durability.dehydrate",
    !!report.durability?.dehydrate.available && report.durability.dehydrate.count > 0,
    !report.durability?.dehydrate.available ? report.durability?.dehydrate.unavailableReason : undefined,
    !!budget?.durability?.dehydrateP95Ms,
  );
  probe("resource.memory", !!report.resource?.memory, undefined, !!budget?.resource?.peakRssMB);
  probe(
    "resource.connections",
    !!report.resource?.activity,
    undefined,
    !!budget?.resource?.peakConnections,
  );
  probe(
    "concurrency",
    !!report.concurrency && !report.concurrency.abortedReason,
    report.concurrency?.abortedReason,
    !!budget?.concurrency,
  );
  probe(
    "toolCallLatency",
    !!report.toolCallLatency && report.toolCallLatency.available,
    report.toolCallLatency && !report.toolCallLatency.available
      ? report.toolCallLatency.unavailableReason
      : undefined,
    false,
  );
  probe(
    "cleanupRate",
    !!report.cleanupRate && report.cleanupRate.available,
    report.cleanupRate && !report.cleanupRate.available
      ? report.cleanupRate.unavailableReason
      : undefined,
    false,
  );
  probe(
    "coldVsWarm",
    !!report.coldVsWarm && report.coldVsWarm.available,
    report.coldVsWarm && !report.coldVsWarm.available
      ? report.coldVsWarm.unavailableReason
      : undefined,
    false,
  );

  return { measured, unavailable, missingButBudgeted };
}

export function renderMarkdown(report: PerfReport, opts: RenderOptions = {}): string {
  const lines: string[] = [];
  lines.push(`# ${opts.title ?? "Perf Report"}`);
  lines.push("");

  // Coverage banner — first thing in the report so missing dimensions are
  // not buried under whatever was measured.
  const coverage = coverageSummary(report, opts.budget);
  if (coverage.unavailable.length > 0 || coverage.missingButBudgeted.length > 0) {
    lines.push("## Coverage");
    lines.push("");
    if (coverage.measured.length > 0) {
      lines.push(`- measured: ${coverage.measured.join(", ")}`);
    }
    if (coverage.unavailable.length > 0) {
      lines.push("- ⚠️ unavailable:");
      for (const u of coverage.unavailable) {
        lines.push(`  - **${u.dim}**: ${u.reason}`);
      }
    }
    if (coverage.missingButBudgeted.length > 0) {
      lines.push("- ❌ configured budget but no measurement:");
      for (const d of coverage.missingButBudgeted) {
        lines.push(`  - **${d}**`);
      }
    }
    lines.push("");
  }

  if (report.latency) {
    const l = report.latency;
    lines.push("## Latency");
    lines.push("");
    lines.push("| count | p50 | p95 | p99 | min | max | mean |");
    lines.push("|---|---|---|---|---|---|---|");
    lines.push(
      `| ${l.count} | ${fmt(l.p50)} | ${fmt(l.p95)} | ${fmt(l.p99)} | ${fmt(l.min)} | ${fmt(l.max)} | ${fmt(l.meanMs)} |`,
    );
    lines.push("");
  }

  if (report.cost) {
    lines.push("## Cost");
    lines.push("");
    lines.push("| trials | totalUsd | perTrialUsd |");
    lines.push("|---|---|---|");
    lines.push(
      `| ${report.cost.trials} | ${fmt(report.cost.totalUsd, 4)} | ${fmt(report.cost.perTrialUsd, 4)} |`,
    );
    lines.push("");
  }

  if (report.dbDelta) {
    const d = report.dbDelta;
    lines.push("## DB Calls");
    lines.push("");
    if (!d.available) {
      lines.push(`_unavailable: ${d.unavailableReason ?? "unknown"}_`);
    } else {
      lines.push(`- queries: **${d.queries}**`);
      lines.push(`- execTimeMs: **${fmt(d.execTimeMs)}**`);
      if (report.dbPerTurn != null) lines.push(`- dbPerTurn: **${fmt(report.dbPerTurn)}**`);
      if (report.dbPerSpawn != null) lines.push(`- dbPerSpawn: **${fmt(report.dbPerSpawn)}**`);
      if (report.dbPerSweep != null) lines.push(`- dbPerSweep: **${fmt(report.dbPerSweep)}**`);
      lines.push("");
      lines.push("### By category");
      lines.push("");
      lines.push("| category | calls |");
      lines.push("|---|---|");
      for (const [cat, n] of Object.entries(d.byCategory)) {
        lines.push(`| ${cat} | ${n} |`);
      }
      lines.push("");
      if (d.topSlowDelta.length > 0) {
        lines.push("### Top slow (delta)");
        lines.push("");
        lines.push("| calls | meanMs | totalMs | preview |");
        lines.push("|---|---|---|---|");
        for (const r of d.topSlowDelta) {
          const preview = r.queryPreview.replace(/\s+/g, " ").slice(0, 120);
          lines.push(
            `| ${r.calls} | ${fmt(r.meanExecTimeMs)} | ${fmt(r.totalExecTimeMs)} | ${preview} |`,
          );
        }
        lines.push("");
      }
    }
  }

  if (report.durability) {
    const d = report.durability;
    lines.push("## Durability");
    lines.push("");
    // Honesty banner: covers two distinct conditions independently.
    //   1. ANY bucket lacks a CMS-events source → durability is partially deferred.
    //   2. ANY bucket has harness-wallclock samples → those are NOT real
    //      durability latencies; explicit warning required even if other
    //      buckets are CMS-derived (mixed-report case).
    const buckets = [d.rehydrate, d.replay, d.checkpoint, d.dehydrate];
    const hasCmsSource = buckets.some((b) => b.source === "cms-events");
    const hasHarnessSource = buckets.some((b) => b.source === "harness-wallclock");
    const allCmsOrUnavailable = buckets.every(
      (b) => b.source === "cms-events" || !b.available,
    );
    if (!hasCmsSource) {
      lines.push(
        "_deferred — requires SDK start-event instrumentation, not currently emitted. " +
          (hasHarnessSource
            ? "Showing `harness-wallclock` samples below as a coarse regression sentinel only — these are NOT real durability latencies._"
            : "No `harness-wallclock` samples were recorded either._"),
      );
      lines.push("");
    } else if (hasHarnessSource && !allCmsOrUnavailable) {
      // Mixed report: some buckets are real CMS-events, others are
      // harness-wallclock. Do not suppress the harness-wallclock warning
      // just because one bucket happens to be real — surface it explicitly.
      lines.push(
        "_⚠️ mixed source: some buckets below have `harness-wallclock` samples — those are NOT real durability latencies, only coarse regression sentinels. The `source` column distinguishes them per bucket._",
      );
      lines.push("");
    }
    lines.push("| op | count | p50 | p95 | p99 | mean | source | available |");
    lines.push("|---|---|---|---|---|---|---|---|");
    for (const [name, p] of Object.entries(d)) {
      const avail = p.available ? "✅" : `❌ ${p.unavailableReason ?? ""}`;
      lines.push(
        `| ${name} | ${p.count} | ${fmt(p.p50)} | ${fmt(p.p95)} | ${fmt(p.p99)} | ${fmt(p.meanMs)} | ${p.source} | ${avail} |`,
      );
    }
    lines.push("");
  }

  if (report.resource) {
    lines.push("## Resource");
    lines.push("");
    if (report.resource.memory) {
      const m = report.resource.memory;
      lines.push(
        `- memory: peakRssMB=**${fmt(m.peakRssMB)}** meanRssMB=**${fmt(m.meanRssMB)}** samples=${m.samples.length} durationMs=${m.durationMs}`,
      );
    }
    if (report.resource.activity) {
      const a = report.resource.activity;
      const dbs = Object.entries(a.peakByDatabase)
        .map(([db, n]) => `${db || "(none)"}=${n}`)
        .join(", ");
      lines.push(
        `- pg connections: peak=**${a.peak}** durationMs=${a.durationMs} byDb={${dbs}}`,
      );
    }
    lines.push("");
  }

  if (report.concurrency) {
    const c = report.concurrency;
    lines.push("## Concurrency");
    lines.push("");
    if (c.abortedReason) {
      lines.push(`- ⚠️ **aborted**: ${c.abortedReason}`);
      lines.push("");
    } else {
      lines.push(`- scalingFactor: **${fmt(c.scalingFactor)}** (effLatency@maxN / effLatency@minN, failure-aware)`);
      lines.push("");
      lines.push("| N | count | meanLatency | effMean | p50 | p95 | failures | failureRate |");
      lines.push("|---|---|---|---|---|---|---|---|");
      for (const N of c.levels) {
        const s = c.byN[N];
        if (!s) continue;
        lines.push(
          `| ${N} | ${s.count} | ${fmt(s.meanLatency)} | ${fmt(s.effectiveMeanLatency)} | ${fmt(s.p50Latency)} | ${fmt(s.p95Latency)} | ${s.failures} | ${fmt(s.failureRate, 3)} |`,
        );
      }
      lines.push("");
    }
  }

  // ── Advertised-but-not-yet-measured Tier 3 sections ──
  // Always render these explicitly so the report's "coverage" is honest.
  lines.push("## Tool-call latency");
  lines.push("");
  if (!report.toolCallLatency || !report.toolCallLatency.available) {
    const reason = report.toolCallLatency?.available === false
      ? report.toolCallLatency.unavailableReason
      : "deferred — requires per-tool driver instrumentation not currently implemented";
    lines.push(`_unavailable: ${reason}_`);
  } else {
    lines.push("| tool | count | p50 | p95 | p99 | mean |");
    lines.push("|---|---|---|---|---|---|");
    for (const [tool, p] of Object.entries(report.toolCallLatency.perToolMs)) {
      lines.push(
        `| ${tool} | ${p.count} | ${fmt(p.p50)} | ${fmt(p.p95)} | ${fmt(p.p99)} | ${fmt(p.meanMs)} |`,
      );
    }
  }
  lines.push("");

  lines.push("## Cleanup rate");
  lines.push("");
  if (!report.cleanupRate || !report.cleanupRate.available) {
    const reason = report.cleanupRate?.available === false
      ? report.cleanupRate.unavailableReason
      : "deferred — real sweeper-rate measurement requires SDK / system-agent fixture not currently wired into eval-harness";
    lines.push(`_unavailable: ${reason}_`);
  } else {
    lines.push(
      `- sessionsPerMinute: **${fmt(report.cleanupRate.sessionsPerMinute)}** (sample size ${report.cleanupRate.sample})`,
    );
  }
  lines.push("");

  lines.push("## Cold-start vs warm-reload");
  lines.push("");
  if (!report.coldVsWarm || !report.coldVsWarm.available) {
    const reason = report.coldVsWarm?.available === false
      ? report.coldVsWarm.unavailableReason
      : "deferred — true cold/warm distinction requires SDK runtime reuse not currently exposed by LiveDriver";
    lines.push(`_unavailable: ${reason}_`);
  } else {
    lines.push("| phase | count | p50 | p95 | p99 | mean |");
    lines.push("|---|---|---|---|---|---|");
    for (const [phase, p] of [
      ["cold", report.coldVsWarm.cold],
      ["warm", report.coldVsWarm.warm],
    ] as const) {
      lines.push(
        `| ${phase} | ${p.count} | ${fmt(p.p50)} | ${fmt(p.p95)} | ${fmt(p.p99)} | ${fmt(p.meanMs)} |`,
      );
    }
  }
  lines.push("");

  if (opts.budgetResult) {
    lines.push("## Budget");
    lines.push("");
    lines.push(`- result: **${opts.budgetResult.passed ? "PASS" : "FAIL"}**`);
    if (opts.budgetResult.violations.length > 0) {
      lines.push("- violations:");
      for (const v of opts.budgetResult.violations) lines.push(`  - ${v}`);
    }
    lines.push("");
    if (opts.budgetResult.details.length > 0) {
      lines.push("| dim | result | reason |");
      lines.push("|---|---|---|");
      for (const d of opts.budgetResult.details) {
        lines.push(`| ${d.dim} | ${d.passed ? "✅" : "❌"} | ${d.reason ?? ""} |`);
      }
    }
    lines.push("");
  }

  if (report.meta && Object.keys(report.meta).length > 0) {
    lines.push("## Meta");
    lines.push("");
    lines.push("```json");
    lines.push(JSON.stringify(report.meta, null, 2));
    lines.push("```");
    lines.push("");
  }

  return lines.join("\n");
}

export class PerfReporter {
  renderMarkdown(report: PerfReport, opts: RenderOptions = {}): string {
    return renderMarkdown(report, opts);
  }
  renderJson(report: PerfReport, opts: RenderOptions = {}): string {
    return renderJson(report, opts);
  }
}
