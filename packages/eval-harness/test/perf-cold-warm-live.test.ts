// Cold-start vs warm-reload LIVE — gated by LIVE=1.
//
// Audit H4: a true cold/warm comparison requires SDK runtime reuse that
// LiveDriver does not currently expose — every `driver.run()` constructs
// and tears down a fresh worker/client/env. This suite is therefore
// honest about what it measures: turn-to-turn jitter on consecutive
// driver invocations. The (cold, warm) bucketing is preserved as a
// useful sentinel for catastrophic warm-reload regressions even though
// it cannot detect subtle warm-cache wins.
//
// To upgrade this test to a real cold/warm cycle, the harness needs:
//   1. A LiveDriver mode that retains a started worker/client across
//      runs and re-uses the same sessionId, OR
//   2. A management-client path to drive
//      dehydrate(sessionId) → rehydrate(sessionId) and time the gap.

import { describe, expect, it } from "vitest";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { LiveDriver } from "../src/drivers/live-driver.js";
import { loadEvalTask } from "../src/loader.js";
import { LatencyTracker } from "../src/perf/latency-tracker.js";
import type { PerfReport } from "../src/perf/perf-budget.js";
import { renderMarkdown } from "../src/perf/reporter.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

describe("Cold vs warm perf LIVE (jitter-only sentinel — H4)", () => {
  const run = process.env.LIVE === "1" ? it : it.skip;

  run("PERF: consecutive-run jitter sentinel (NOT a true cold/warm runtime test)", async () => {
    const dataset = loadEvalTask(
      resolve(__dirname, "../datasets/tool-call-correctness.v1.json"),
    );
    const sample = dataset.samples[0]!;
    const driver = new LiveDriver({ timeout: 300_000 });
    const cold = new LatencyTracker();
    const warm = new LatencyTracker();

    const cold0 = await driver.run(sample);
    cold.record(cold0.latencyMs);

    for (let i = 0; i < 2; i++) {
      const r = await driver.run(sample);
      warm.record(r.latencyMs);
    }

    const coldP = cold.percentiles();
    const warmP = warm.percentiles();
    expect(coldP.count).toBe(1);
    expect(warmP.count).toBe(2);

    // Surface the limitation explicitly in the rendered report so
    // consumers see the gap rather than silent absence.
    const report: PerfReport = {
      coldVsWarm: {
        available: false,
        unavailableReason:
          "true cold/warm comparison requires SDK runtime reuse not currently exposed by LiveDriver; numbers below are turn-to-turn jitter only",
      },
      meta: {
        coldP95Ms: coldP.p95,
        warmP95Ms: warmP.p95,
      },
    };
    const md = renderMarkdown(report, { title: "Cold vs warm" });
    console.log(md);

    // We don't enforce warm < cold (LLM jitter dominates), but warm
    // should not be more than 2x cold + 60s headroom — sentinel only.
    expect(warmP.p95).toBeLessThanOrEqual(coldP.p95 * 2 + 60_000);
  }, 1_050_000);
});
