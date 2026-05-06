// Durability perf LIVE — gated by LIVE=1 PERF_DURABILITY=1.
//
// Reaudit G4 NEW BLOCKER 1 fix:
//
// The PilotSwarm SDK does not currently emit `session.rehydrate-start`,
// `session.dehydrate-start`, or `session.checkpoint-start` events; only
// terminal `session.hydrated` / `session.dehydrated` events. As a
// result, the CMS-events durability source is *deferred* —
// `DurabilityTracker.recordFromCmsEvents()` returns
// `noStartEventsFound: true` and produces zero samples for any real
// production event stream.
//
// This suite intentionally asserts the deferred state honestly:
//
//   1. Every durability bucket reports `available: false` after a real
//      LiveDriver run (no synthetic samples are injected). Replay
//      reports the deferred-reason string `requires duroxide trace
//      parser, not currently implemented`. The other three buckets
//      report `requires SDK start-event instrumentation, not currently
//      emitted` after a CMS pull yields no `*-start` events.
//
//   2. The optional harness-wallclock path is exercised, and the
//      resulting percentiles carry `source: "harness-wallclock"` —
//      consumers must distinguish this from real durability.
//
//   3. The CMS pairing path is still unit-tested end-to-end against a
//      synthetic event stream so the parser remains covered for the
//      day the SDK starts emitting `*-start` events.

import { describe, expect, it } from "vitest";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { LiveDriver } from "../src/drivers/live-driver.js";
import { loadEvalTask } from "../src/loader.js";
import {
  DurabilityTracker,
  __DURABILITY_DEFERRED_REASONS__,
  type CmsLikeEvent,
} from "../src/perf/durability-tracker.js";
import { BudgetChecker } from "../src/perf/perf-budget.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const liveAndDurability =
  process.env.LIVE === "1" && process.env.PERF_DURABILITY === "1";

describe("Durability perf LIVE (CMS-event-derived)", () => {
  const run = liveAndDurability ? it : it.skip;

  run(
    "PERF: durability percentiles surface honest unavailability when no CMS event source",
    async () => {
      const dataset = loadEvalTask(
        resolve(__dirname, "../datasets/tool-call-correctness.v1.json"),
      );
      const sample = dataset.samples[0]!;
      const driver = new LiveDriver({ timeout: 300_000 });
      await driver.run(sample);

      const tracker = new DurabilityTracker();
      const p = tracker.percentiles();

      // All four durability operations MUST be flagged unavailable.
      // No synthetic samples are recorded — the only honest surface is
      // "deferred until SDK emits start events / duroxide exposes a
      // trace parser".
      expect(p.rehydrate.available).toBe(false);
      expect(p.rehydrate.unavailableReason).toMatch(/no rehydrate samples recorded/);
      expect(p.checkpoint.available).toBe(false);
      expect(p.checkpoint.unavailableReason).toMatch(/no checkpoint samples recorded/);
      expect(p.dehydrate.available).toBe(false);
      expect(p.dehydrate.unavailableReason).toMatch(/no dehydrate samples recorded/);

      // Replay carries the duroxide-trace-parser deferred reason.
      expect(p.replay.available).toBe(false);
      expect(p.replay.unavailableReason).toBe(
        __DURABILITY_DEFERRED_REASONS__.replay,
      );

      // BudgetChecker must fail closed against a configured budget when
      // no measurement is available (and the budget isn't optional).
      const result = BudgetChecker.check(
        { durability: { rehydrateP95Ms: 1000 } },
        { durability: p },
      );
      expect(result.passed).toBe(false);
      expect(result.violations.some((v) => v.includes("rehydrate"))).toBe(true);
    },
    360_000,
  );

  run(
    "PERF: harness-wallclock fallback surfaces with explicit source label",
    async () => {
      // The harness can take a coarse wall-clock measurement around the
      // entire run as a regression sentinel. The resulting percentiles
      // MUST carry `source: "harness-wallclock"` so consumers do NOT
      // mistake them for real durability.
      const dataset = loadEvalTask(
        resolve(__dirname, "../datasets/tool-call-correctness.v1.json"),
      );
      const sample = dataset.samples[0]!;
      const driver = new LiveDriver({ timeout: 300_000 });
      const tracker = new DurabilityTracker();

      const t0 = Date.now();
      await driver.run(sample);
      const elapsedMs = Date.now() - t0;
      tracker.recordHarnessWallclock("rehydrate", sample.id, elapsedMs);
      tracker.recordHarnessWallclock("dehydrate", sample.id, elapsedMs);

      const p = tracker.percentiles();
      expect(p.rehydrate.available).toBe(true);
      expect(p.rehydrate.source).toBe("harness-wallclock");
      expect(p.rehydrate.count).toBe(1);
      expect(p.dehydrate.source).toBe("harness-wallclock");

      // Even with harness samples, replay MUST stay deferred.
      expect(p.replay.available).toBe(false);
      expect(p.replay.unavailableReason).toBe(
        __DURABILITY_DEFERRED_REASONS__.replay,
      );

      // Checkpoint had no samples — still unavailable.
      expect(p.checkpoint.available).toBe(false);
    },
    360_000,
  );

  run(
    "PERF: CMS-event pairing produces rehydrate latency from a synthetic event stream",
    async () => {
      // Validates the wiring even when no live SDK trace is plumbed in.
      // Synthetic events here are NOT product measurements — they prove
      // the tracker's CMS pairing path works end-to-end so that a
      // future SDK release that emits `*-start` events drops in
      // immediately.
      const tracker = new DurabilityTracker();
      const sessionId = "live-cms-pairing-demo";
      const events: CmsLikeEvent[] = [
        { sessionId, eventType: "session.rehydrate-start", createdAt: new Date(1_000) },
        { sessionId, eventType: "session.hydrated", createdAt: new Date(1_350) },
        { sessionId, eventType: "session.dehydrate-start", createdAt: new Date(2_000) },
        { sessionId, eventType: "session.dehydrated", createdAt: new Date(2_080) },
      ];
      const r = tracker.recordFromCmsEvents(sessionId, events);
      expect(r.noStartEventsFound).toBe(false);
      expect(r.rehydrateSamples).toBe(1);
      expect(r.dehydrateSamples).toBe(1);
      const p = tracker.percentiles();
      expect(p.rehydrate.available).toBe(true);
      expect(p.rehydrate.source).toBe("cms-events");
      expect(p.dehydrate.available).toBe(true);
      expect(p.dehydrate.source).toBe("cms-events");
      // Replay still has no source — must remain unavailable.
      expect(p.replay.available).toBe(false);
    },
  );
});
