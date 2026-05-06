import { describe, it, expect } from "vitest";
import {
  PerfReporter,
  renderJson,
  renderMarkdown,
} from "../../src/perf/reporter.js";
import { BudgetChecker } from "../../src/perf/perf-budget.js";
import type { PerfReport } from "../../src/perf/perf-budget.js";

const fullReport: PerfReport = {
  latency: { count: 3, p50: 100, p95: 200, p99: 300, min: 50, max: 300, meanMs: 150 },
  cost: { totalUsd: 0.6, perTrialUsd: 0.2, trials: 3 },
  dbDelta: {
    available: true,
    queries: 42,
    execTimeMs: 123.45,
    topSlowDelta: [
      {
        queryHash: "h1",
        calls: 5,
        meanExecTimeMs: 10,
        totalExecTimeMs: 50,
        queryPreview: "SELECT * FROM cms.sessions WHERE id=$1",
      },
    ],
    byCategory: {
      orchestration: 5,
      cms: 30,
      facts: 0,
      "session-store": 0,
      "blob-store": 2,
      other: 5,
    },
  },
  dbPerTurn: 14,
  dbPerSpawn: 25,
  durability: {
    rehydrate: { count: 2, p50: 10, p95: 20, p99: 20, min: 10, max: 20, meanMs: 15, available: true, source: "cms-events" },
    replay: { count: 0, p50: 0, p95: 0, p99: 0, min: 0, max: 0, meanMs: 0, available: false, source: "none", unavailableReason: "deferred — requires duroxide trace parser" },
    checkpoint: { count: 1, p50: 5, p95: 5, p99: 5, min: 5, max: 5, meanMs: 5, available: true, source: "cms-events" },
    dehydrate: { count: 1, p50: 8, p95: 8, p99: 8, min: 8, max: 8, meanMs: 8, available: true, source: "cms-events" },
  },
  resource: {
    memory: { samples: [100, 110], peakRssMB: 120, meanRssMB: 105, durationMs: 1000 },
    activity: {
      samples: [],
      peak: 7,
      meanByDatabase: { ps: 4 },
      peakByDatabase: { ps: 7 },
      durationMs: 1000,
    },
  },
  concurrency: {
    levels: [1, 4],
    scalingFactor: 1.6,
    byN: {
      1: {
        count: 1,
        meanLatency: 100,
        p50Latency: 100,
        p95Latency: 100,
        failures: 0,
        failureRate: 0,
        effectiveMeanLatency: 100,
        percentiles: { count: 1, p50: 100, p95: 100, p99: 100, min: 100, max: 100, meanMs: 100, available: true, source: "explicit" },
      },
      4: {
        count: 4,
        meanLatency: 160,
        p50Latency: 160,
        p95Latency: 200,
        failures: 0,
        failureRate: 0,
        effectiveMeanLatency: 160,
        percentiles: { count: 4, p50: 160, p95: 200, p99: 200, min: 100, max: 200, meanMs: 160, available: true, source: "explicit" },
      },
    },
  },
  meta: { suite: "demo" },
};

describe("renderMarkdown", () => {
  it("emits a section per dimension present", () => {
    const md = renderMarkdown(fullReport, { title: "Demo" });
    expect(md).toMatch(/# Demo/);
    expect(md).toMatch(/## Latency/);
    expect(md).toMatch(/## Cost/);
    expect(md).toMatch(/## DB Calls/);
    expect(md).toMatch(/## Durability/);
    expect(md).toMatch(/## Resource/);
    expect(md).toMatch(/## Concurrency/);
    expect(md).toMatch(/## Meta/);
  });

  it("emits coverage banner with unavailable durability.replay (H6)", () => {
    const md = renderMarkdown(fullReport);
    expect(md).toMatch(/## Coverage/);
    expect(md).toMatch(/durability\.replay.*duroxide trace parser/);
  });

  it("always renders advertised Tier 3 sections, even when unmeasured (H6)", () => {
    const md = renderMarkdown(fullReport);
    expect(md).toMatch(/## Tool-call latency/);
    expect(md).toMatch(/## Cleanup rate/);
    expect(md).toMatch(/## Cold-start vs warm-reload/);
    // Each unmeasured section must explicitly say so.
    expect(md).toMatch(/_unavailable: deferred — requires per-tool driver instrumentation/);
    expect(md).toMatch(/_unavailable: deferred — real sweeper-rate measurement/);
    expect(md).toMatch(/_unavailable: deferred — true cold\/warm distinction/);
  });

  it("highlights configured budget but missing measurement", () => {
    const md = renderMarkdown(
      {},
      { budget: { latency: { p50Ms: 1, p95Ms: 1, p99Ms: 1 } } },
    );
    expect(md).toMatch(/configured budget but no measurement/);
    expect(md).toMatch(/\*\*latency\*\*/);
  });

  it("renders unavailable DB delta cleanly", () => {
    const md = renderMarkdown({
      dbDelta: {
        available: false,
        unavailableReason: "missing extension",
        queries: 0,
        execTimeMs: 0,
        topSlowDelta: [],
        byCategory: {
          orchestration: 0,
          cms: 0,
          facts: 0,
          "session-store": 0,
          "blob-store": 0,
          other: 0,
        },
      },
    });
    expect(md).toMatch(/_unavailable: missing extension_/);
  });

  it("renders budget result with violations", () => {
    const result = BudgetChecker.check(
      { latency: { p50Ms: 1, p95Ms: 1, p99Ms: 1 } },
      {
        latency: {
          count: 1,
          p50: 100,
          p95: 100,
          p99: 100,
          min: 100,
          max: 100,
          meanMs: 100,
        },
      },
    );
    const md = renderMarkdown(fullReport, { budgetResult: result });
    expect(md).toMatch(/## Budget/);
    expect(md).toMatch(/FAIL/);
    expect(md).toMatch(/violations/);
  });

  it("renders even when sections are missing", () => {
    const md = renderMarkdown({ latency: fullReport.latency }, { title: "Slim" });
    expect(md).toMatch(/# Slim/);
    expect(md).toMatch(/## Latency/);
    expect(md).not.toMatch(/## Cost/);
  });

  it("Durability deferred banner: shown when no bucket has cms-events source", () => {
    const md = renderMarkdown({
      durability: {
        rehydrate: { count: 0, p50: 0, p95: 0, p99: 0, min: 0, max: 0, meanMs: 0, available: false, source: "none", unavailableReason: "no rehydrate samples" },
        replay: { count: 0, p50: 0, p95: 0, p99: 0, min: 0, max: 0, meanMs: 0, available: false, source: "none", unavailableReason: "deferred replay" },
        checkpoint: { count: 0, p50: 0, p95: 0, p99: 0, min: 0, max: 0, meanMs: 0, available: false, source: "none" },
        dehydrate: { count: 0, p50: 0, p95: 0, p99: 0, min: 0, max: 0, meanMs: 0, available: false, source: "none" },
      },
    });
    expect(md).toMatch(/_deferred — requires SDK start-event instrumentation/);
  });

  it("Durability mixed-source banner: shown when SOME buckets are real CMS but harness-wallclock is also present (V3 audit fix)", () => {
    const md = renderMarkdown({
      durability: {
        // Real CMS-events source
        rehydrate: { count: 1, p50: 10, p95: 10, p99: 10, min: 10, max: 10, meanMs: 10, available: true, source: "cms-events" },
        // Permanently deferred
        replay: { count: 0, p50: 0, p95: 0, p99: 0, min: 0, max: 0, meanMs: 0, available: false, source: "none", unavailableReason: "deferred replay" },
        // Harness-wallclock (NOT real)
        checkpoint: { count: 1, p50: 5000, p95: 5000, p99: 5000, min: 5000, max: 5000, meanMs: 5000, available: true, source: "harness-wallclock" },
        dehydrate: { count: 0, p50: 0, p95: 0, p99: 0, min: 0, max: 0, meanMs: 0, available: false, source: "none" },
      },
    });
    // Should NOT show the all-deferred banner (we have CMS events)
    expect(md).not.toMatch(/_deferred — requires SDK start-event instrumentation/);
    // SHOULD show the mixed-source warning per V3 audit fix
    expect(md).toMatch(/mixed source.*harness-wallclock/);
    expect(md).toMatch(/NOT real durability/);
  });

  it("Durability mixed-source banner: NOT shown when ALL non-deferred buckets are CMS", () => {
    const md = renderMarkdown({
      durability: {
        rehydrate: { count: 1, p50: 10, p95: 10, p99: 10, min: 10, max: 10, meanMs: 10, available: true, source: "cms-events" },
        replay: { count: 0, p50: 0, p95: 0, p99: 0, min: 0, max: 0, meanMs: 0, available: false, source: "none", unavailableReason: "deferred replay" },
        checkpoint: { count: 1, p50: 5, p95: 5, p99: 5, min: 5, max: 5, meanMs: 5, available: true, source: "cms-events" },
        dehydrate: { count: 1, p50: 8, p95: 8, p99: 8, min: 8, max: 8, meanMs: 8, available: true, source: "cms-events" },
      },
    });
    expect(md).not.toMatch(/_deferred — requires SDK start-event instrumentation/);
    expect(md).not.toMatch(/mixed source/);
  });

  it("Durability table renders source column with per-row source values (V4 audit follow-up)", () => {
    const md = renderMarkdown({
      durability: {
        rehydrate: { count: 1, p50: 10, p95: 10, p99: 10, min: 10, max: 10, meanMs: 10, available: true, source: "cms-events" },
        replay: { count: 0, p50: 0, p95: 0, p99: 0, min: 0, max: 0, meanMs: 0, available: false, source: "none", unavailableReason: "deferred replay" },
        checkpoint: { count: 2, p50: 6000, p95: 6000, p99: 6000, min: 6000, max: 6000, meanMs: 6000, available: true, source: "harness-wallclock" },
        dehydrate: { count: 1, p50: 30, p95: 30, p99: 30, min: 30, max: 30, meanMs: 30, available: true, source: "explicit" },
      },
    });
    // Header includes the source column.
    expect(md).toMatch(/\| op \| count \| p50 \| p95 \| p99 \| mean \| source \| available \|/);
    // Per-row source values are visible.
    expect(md).toMatch(/\| rehydrate \|.*\| cms-events \|/);
    expect(md).toMatch(/\| replay \|.*\| none \|/);
    expect(md).toMatch(/\| checkpoint \|.*\| harness-wallclock \|/);
    expect(md).toMatch(/\| dehydrate \|.*\| explicit \|/);
  });

  it("Durability deferred banner: shown when zero CMS buckets but harness samples present (V4 audit follow-up)", () => {
    const md = renderMarkdown({
      durability: {
        rehydrate: { count: 1, p50: 5000, p95: 5000, p99: 5000, min: 5000, max: 5000, meanMs: 5000, available: true, source: "harness-wallclock" },
        replay: { count: 0, p50: 0, p95: 0, p99: 0, min: 0, max: 0, meanMs: 0, available: false, source: "none", unavailableReason: "deferred replay" },
        checkpoint: { count: 1, p50: 4000, p95: 4000, p99: 4000, min: 4000, max: 4000, meanMs: 4000, available: true, source: "harness-wallclock" },
        dehydrate: { count: 0, p50: 0, p95: 0, p99: 0, min: 0, max: 0, meanMs: 0, available: false, source: "none" },
      },
    });
    expect(md).toMatch(/_deferred — requires SDK start-event instrumentation/);
    expect(md).toMatch(/coarse regression sentinel only/);
    expect(md).toMatch(/NOT real durability/);
  });
});

describe("renderJson", () => {
  it("returns parseable JSON with report + meta", () => {
    const json = renderJson(fullReport, { title: "Demo" });
    const parsed = JSON.parse(json) as { title: string; report: PerfReport };
    expect(parsed.title).toBe("Demo");
    expect(parsed.report.latency?.p95).toBe(200);
  });

  it("default title when not provided", () => {
    const json = renderJson(fullReport);
    const parsed = JSON.parse(json) as { title: string };
    expect(parsed.title).toBe("Perf Report");
  });

  it("includes generatedAt ISO timestamp", () => {
    const parsed = JSON.parse(renderJson(fullReport)) as { generatedAt: string };
    expect(() => new Date(parsed.generatedAt).toISOString()).not.toThrow();
  });
});

describe("PerfReporter", () => {
  it("class wrapper delegates to render functions", () => {
    const r = new PerfReporter();
    expect(r.renderMarkdown(fullReport)).toMatch(/Perf Report/);
    expect(JSON.parse(r.renderJson(fullReport))).toBeTruthy();
  });
});
