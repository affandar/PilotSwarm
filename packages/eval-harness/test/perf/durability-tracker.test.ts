import { describe, it, expect } from "vitest";
import {
  DurabilityTracker,
  __DURABILITY_DEFERRED_REASONS__,
  percentilesOf,
} from "../../src/perf/durability-tracker.js";
import type { CmsLikeEvent } from "../../src/perf/durability-tracker.js";
// API-surface guard: import the public types-and-symbols barrel and
// assert no `recordReplay`-style escape hatch is part of it.
import * as PerfPublic from "../../src/perf/index.js";

describe("percentilesOf", () => {
  it("returns zeros for empty input (with available=true since explicit source claim)", () => {
    expect(percentilesOf([])).toMatchObject({
      count: 0,
      p50: 0,
      p95: 0,
      p99: 0,
      min: 0,
      max: 0,
      meanMs: 0,
      available: true,
      source: "explicit",
    });
  });

  it("computes nearest-rank ceil percentiles", () => {
    const p = percentilesOf([10, 20, 30, 40, 50, 60, 70, 80, 90, 100]);
    expect(p.count).toBe(10);
    expect(p.p50).toBe(50);
    expect(p.min).toBe(10);
    expect(p.max).toBe(100);
    expect(p.meanMs).toBe(55);
    expect(p.available).toBe(true);
  });

  it("handles single sample", () => {
    expect(percentilesOf([42])).toMatchObject({
      count: 1,
      p50: 42,
      p95: 42,
      p99: 42,
      min: 42,
      max: 42,
      available: true,
    });
  });

  it("propagates the requested source label", () => {
    expect(percentilesOf([1, 2, 3], "cms-events").source).toBe("cms-events");
    expect(percentilesOf([1, 2, 3], "harness-wallclock").source).toBe(
      "harness-wallclock",
    );
  });
});

describe("DurabilityTracker — explicit recording", () => {
  it("records rehydrate / checkpoint / dehydrate and computes percentiles", () => {
    const t = new DurabilityTracker();
    for (const ms of [10, 20, 30]) t.recordRehydrate("s1", ms);
    t.recordCheckpoint("s1", 50, 1024);
    t.recordDehydrate("s1", 200);
    const p = t.percentiles();
    expect(p.rehydrate.count).toBe(3);
    expect(p.checkpoint.count).toBe(1);
    expect(p.dehydrate.count).toBe(1);
    expect(p.rehydrate.p50).toBe(20);
    expect(p.rehydrate.available).toBe(true);
    expect(p.rehydrate.source).toBe("explicit");
    expect(p.checkpoint.source).toBe("explicit");
    expect(p.dehydrate.source).toBe("explicit");
  });

  it("rejects non-finite or negative ms", () => {
    const t = new DurabilityTracker();
    expect(() => t.recordRehydrate("s", Number.NaN)).toThrow(/finite/);
    expect(() => t.recordCheckpoint("s", Number.POSITIVE_INFINITY)).toThrow(/finite/);
    expect(() => t.recordDehydrate("s", -0.1)).toThrow(/non-negative/);
    expect(() =>
      t.recordHarnessWallclock("rehydrate", "s", -1),
    ).toThrow(/non-negative/);
  });

  it("attaches meta on records", () => {
    const t = new DurabilityTracker();
    t.recordCheckpoint("s", 10, 2048);
    const r = t.records();
    expect(r.checkpoint[0]?.meta).toEqual({ sizeBytes: 2048 });
  });

  it("reset clears all records and source flags", () => {
    const t = new DurabilityTracker();
    t.recordRehydrate("s", 1);
    t.recordCheckpoint("s", 1);
    t.recordDehydrate("s", 1);
    t.reset();
    const p = t.percentiles();
    expect(p.rehydrate.count).toBe(0);
    expect(p.rehydrate.available).toBe(false);
    expect(p.replay.available).toBe(false);
    expect(p.checkpoint.available).toBe(false);
    expect(p.dehydrate.available).toBe(false);
  });
});

describe("DurabilityTracker — harness-wallclock source", () => {
  it("records harness-wallclock samples and labels source explicitly", () => {
    const t = new DurabilityTracker();
    t.recordHarnessWallclock("rehydrate", "s1", 250);
    t.recordHarnessWallclock("rehydrate", "s1", 350);
    t.recordHarnessWallclock("dehydrate", "s1", 80);
    const p = t.percentiles();
    expect(p.rehydrate.count).toBe(2);
    expect(p.rehydrate.available).toBe(true);
    expect(p.rehydrate.source).toBe("harness-wallclock");
    expect(p.dehydrate.source).toBe("harness-wallclock");
    expect(p.checkpoint.available).toBe(false);
  });

  it("source isolation: CMS-events percentiles do NOT include harness-wallclock samples (V3 audit fix)", () => {
    // Audit V3 caught this: previously harness-wallclock and CMS-events
    // shared the same bucket array, so a bucket reporting source: "cms-events"
    // could include fake harness-wallclock samples in its percentiles.
    // This test enforces source isolation: when both sources are present,
    // CMS-events percentiles must reflect ONLY the CMS-events samples.
    const t = new DurabilityTracker();
    // Add a wildly inflated harness-wallclock sample (10s = 10000ms).
    t.recordHarnessWallclock("rehydrate", "s1", 10_000);
    // Add a real CMS-events sample (100ms — much faster than harness).
    const events: CmsLikeEvent[] = [
      { sessionId: "s1", eventType: "session.rehydrate-start", createdAt: 1000 },
      { sessionId: "s1", eventType: "session.hydrated", createdAt: 1100 },
    ];
    t.recordFromCmsEvents("s1", events);

    const p = t.percentiles().rehydrate;
    expect(p.source).toBe("cms-events");
    expect(p.count).toBe(1); // ONLY the CMS sample, NOT the harness one
    expect(p.p50).toBe(100); // CMS sample value, not the 10000ms harness sample
    expect(p.p95).toBe(100);
    expect(p.p99).toBe(100); // V4 audit follow-up: assert p99 too
    expect(p.max).toBe(100);
    expect(p.min).toBe(100);
    expect(p.meanMs).toBe(100);

    // Per-source counts diagnostic: both sources retained their samples
    // internally, but the percentile only surfaces the highest-fidelity one.
    const counts = t.countsBySource();
    expect(counts.rehydrate.cms).toBe(1);
    expect(counts.rehydrate.harness).toBe(1);
    expect(counts.rehydrate.explicit).toBe(0);
  });

  it("source isolation: harness-wallclock percentiles do NOT include explicit samples", () => {
    const t = new DurabilityTracker();
    t.recordRehydrate("s1", 50_000); // explicit, large
    t.recordHarnessWallclock("rehydrate", "s2", 200); // harness, small

    const p = t.percentiles().rehydrate;
    // harness-wallclock has higher fidelity than explicit, so it wins.
    expect(p.source).toBe("harness-wallclock");
    expect(p.count).toBe(1);
    expect(p.p50).toBe(200);

    const counts = t.countsBySource();
    expect(counts.rehydrate.harness).toBe(1);
    expect(counts.rehydrate.explicit).toBe(1);
  });

  it("source priority: cms-events > harness-wallclock > explicit", () => {
    const t = new DurabilityTracker();
    t.recordRehydrate("s1", 9000); // explicit
    t.recordHarnessWallclock("rehydrate", "s1", 5000); // harness
    // No CMS yet → harness wins
    expect(t.percentiles().rehydrate.source).toBe("harness-wallclock");

    // Add CMS → CMS wins
    const events: CmsLikeEvent[] = [
      { sessionId: "s1", eventType: "session.rehydrate-start", createdAt: 1000 },
      { sessionId: "s1", eventType: "session.hydrated", createdAt: 1500 },
    ];
    t.recordFromCmsEvents("s1", events);
    const p = t.percentiles().rehydrate;
    expect(p.source).toBe("cms-events");
    expect(p.count).toBe(1);
    expect(p.max).toBe(500);
  });
});

describe("DurabilityTracker — replay is permanently deferred (G4 fix)", () => {
  it("does NOT expose recordReplay on the public API surface", () => {
    // Compile-time guarantee: removed from public types, AND no
    // identically named export sneaks in via the perf barrel.
    expect(
      (PerfPublic as unknown as Record<string, unknown>).recordReplay,
    ).toBeUndefined();
    const t = new DurabilityTracker() as unknown as Record<string, unknown>;
    expect(t.recordReplay).toBeUndefined();
  });

  it("does NOT expose synthetic timeRehydrate/timeCheckpoint/timeDehydrate helpers", () => {
    const t = new DurabilityTracker() as unknown as Record<string, unknown>;
    expect(t.timeRehydrate).toBeUndefined();
    expect(t.timeCheckpoint).toBeUndefined();
    expect(t.timeDehydrate).toBeUndefined();
  });

  it("replay is unavailable on a fresh tracker with the deferred reason", () => {
    const t = new DurabilityTracker();
    const p = t.percentiles();
    expect(p.replay.available).toBe(false);
    expect(p.replay.unavailableReason).toBe(
      __DURABILITY_DEFERRED_REASONS__.replay,
    );
  });

  it("replay STAYS unavailable even when other buckets are populated", () => {
    const t = new DurabilityTracker();
    t.recordRehydrate("s", 100);
    t.recordCheckpoint("s", 50);
    t.recordDehydrate("s", 200);
    const p = t.percentiles();
    expect(p.rehydrate.available).toBe(true);
    expect(p.checkpoint.available).toBe(true);
    expect(p.dehydrate.available).toBe(true);
    expect(p.replay.available).toBe(false);
  });

  it("replay STAYS unavailable even after _recordReplayForTesting (escape hatch)", () => {
    const t = new DurabilityTracker();
    t._recordReplayForTesting("s", 75, 5);
    const p = t.percentiles();
    expect(p.replay.available).toBe(false);
    expect(p.replay.unavailableReason).toBe(
      __DURABILITY_DEFERRED_REASONS__.replay,
    );
    // Even though samples were injected, count is exposed for diagnostic
    // visibility but `available` is forced to false so consumers cannot
    // build dashboards on top of it.
    expect(p.replay.count).toBe(1);
  });

  it("CMS-events parser does NOT derive replay samples even with rehydrate events present", () => {
    const t = new DurabilityTracker();
    const events: CmsLikeEvent[] = [
      { sessionId: "s1", eventType: "session.rehydrate-start", createdAt: 0 },
      { sessionId: "s1", eventType: "session.hydrated", createdAt: 100 },
    ];
    t.recordFromCmsEvents("s1", events);
    expect(t.percentiles().replay.available).toBe(false);
  });
});

describe("DurabilityTracker — honest unavailability flags", () => {
  it("flags rehydrate / checkpoint / dehydrate unavailable on a fresh tracker", () => {
    const t = new DurabilityTracker();
    const p = t.percentiles();
    expect(p.rehydrate.unavailableReason).toMatch(/no rehydrate samples recorded/);
    expect(p.checkpoint.unavailableReason).toMatch(/no checkpoint samples recorded/);
    expect(p.dehydrate.unavailableReason).toMatch(/no dehydrate samples recorded/);
  });

  it("source defaults to 'none' on the unavailable buckets", () => {
    const t = new DurabilityTracker();
    const p = t.percentiles();
    expect(p.rehydrate.source).toBe("none");
    expect(p.checkpoint.source).toBe("none");
    expect(p.dehydrate.source).toBe("none");
  });
});

describe("DurabilityTracker.recordFromCmsEvents", () => {
  function ev(eventType: string, atMs: number, sessionId = "s1"): CmsLikeEvent {
    return { sessionId, eventType, createdAt: new Date(atMs) };
  }

  it("returns noStartEventsFound=true and produces no samples when only end events are present", () => {
    const logs: string[] = [];
    const t = new DurabilityTracker();
    const events: CmsLikeEvent[] = [
      ev("session.hydrated", 1_500),
      ev("session.dehydrated", 2_500),
    ];
    const r = t.recordFromCmsEvents("s1", events, undefined, {
      logger: (m) => logs.push(m),
    });
    expect(r.noStartEventsFound).toBe(true);
    expect(r.rehydrateSamples).toBe(0);
    expect(r.checkpointSamples).toBe(0);
    expect(r.dehydrateSamples).toBe(0);
    expect(logs.length).toBe(1);
    expect(logs[0]).toMatch(/durability sampling deferred/);
    expect(logs[0]).toMatch(/SDK start-event instrumentation/);
    // Tracker remains unavailable.
    const p = t.percentiles();
    expect(p.rehydrate.available).toBe(false);
    expect(p.dehydrate.available).toBe(false);
  });

  it("pairs rehydrate-start → hydrated and records latency with cms-events source", () => {
    const t = new DurabilityTracker();
    const events: CmsLikeEvent[] = [
      ev("session.rehydrate-start", 1_000),
      ev("session.hydrated", 1_500),
      ev("session.rehydrate-start", 5_000),
      ev("session.hydrated", 5_300),
    ];
    const result = t.recordFromCmsEvents("s1", events);
    expect(result.noStartEventsFound).toBe(false);
    expect(result.rehydrateSamples).toBe(2);
    expect(result.unpairedStarts).toBe(0);
    const p = t.percentiles();
    expect(p.rehydrate.count).toBe(2);
    expect(p.rehydrate.available).toBe(true);
    expect(p.rehydrate.source).toBe("cms-events");
    expect(p.rehydrate.min).toBe(300);
    expect(p.rehydrate.max).toBe(500);
  });

  it("pairs dehydrate-start → dehydrated and checkpoint cycles", () => {
    const t = new DurabilityTracker();
    const events: CmsLikeEvent[] = [
      ev("session.checkpoint-start", 100),
      ev("session.checkpointed", 150),
      ev("session.dehydrate-start", 200),
      ev("session.dehydrated", 280),
    ];
    const result = t.recordFromCmsEvents("s1", events);
    expect(result.checkpointSamples).toBe(1);
    expect(result.dehydrateSamples).toBe(1);
    const p = t.percentiles();
    expect(p.checkpoint.p95).toBe(50);
    expect(p.checkpoint.source).toBe("cms-events");
    expect(p.dehydrate.p95).toBe(80);
    expect(p.dehydrate.source).toBe("cms-events");
  });

  it("ignores events for other sessions", () => {
    const t = new DurabilityTracker();
    const events: CmsLikeEvent[] = [
      ev("session.rehydrate-start", 100, "other"),
      ev("session.hydrated", 200, "other"),
      ev("session.rehydrate-start", 100, "s1"),
      ev("session.hydrated", 250, "s1"),
    ];
    t.recordFromCmsEvents("s1", events);
    const p = t.percentiles();
    expect(p.rehydrate.count).toBe(1);
    expect(p.rehydrate.p95).toBe(150);
  });

  it("counts unpaired starts", () => {
    const t = new DurabilityTracker();
    const events: CmsLikeEvent[] = [
      ev("session.rehydrate-start", 100),
      ev("session.rehydrate-start", 200),
      ev("session.hydrated", 250),
    ];
    const result = t.recordFromCmsEvents("s1", events);
    expect(result.rehydrateSamples).toBe(1);
    expect(result.unpairedStarts).toBe(1);
  });

  it("handles out-of-order events deterministically by sorting on createdAt", () => {
    const t = new DurabilityTracker();
    const events: CmsLikeEvent[] = [
      ev("session.hydrated", 200),
      ev("session.rehydrate-start", 100),
    ];
    const result = t.recordFromCmsEvents("s1", events);
    expect(result.rehydrateSamples).toBe(1);
    expect(t.percentiles().rehydrate.p95).toBe(100);
  });
});
