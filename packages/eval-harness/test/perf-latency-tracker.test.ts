import { describe, it, expect } from "vitest";
import { LatencyTracker, CostTracker } from "../src/perf/latency-tracker.js";

describe("LatencyTracker", () => {
  it("returns zeroed percentiles when empty", () => {
    const t = new LatencyTracker();
    expect(t.size()).toBe(0);
    const p = t.percentiles();
    expect(p).toEqual({ count: 0, p50: 0, p95: 0, p99: 0, min: 0, max: 0, meanMs: 0 });
  });

  it("records samples and computes percentiles via nearest-rank ceil", () => {
    const t = new LatencyTracker();
    for (const v of [10, 20, 30, 40, 50, 60, 70, 80, 90, 100]) t.record(v);
    const p = t.percentiles();
    expect(p.count).toBe(10);
    expect(p.min).toBe(10);
    expect(p.max).toBe(100);
    expect(p.meanMs).toBe(55);
    expect(p.p50).toBe(50);
    expect(p.p95).toBe(100);
    expect(p.p99).toBe(100);
  });

  it("rejects non-finite or negative latencies", () => {
    const t = new LatencyTracker();
    expect(() => t.record(Number.NaN)).toThrow(/finite/);
    expect(() => t.record(Number.POSITIVE_INFINITY)).toThrow(/finite/);
    expect(() => t.record(-1)).toThrow(/non-negative/);
  });

  it("reset clears samples", () => {
    const t = new LatencyTracker();
    t.record(1);
    t.record(2);
    t.reset();
    expect(t.size()).toBe(0);
    expect(t.percentiles().count).toBe(0);
  });

  it("handles single-sample case (all percentiles equal)", () => {
    const t = new LatencyTracker();
    t.record(42);
    const p = t.percentiles();
    expect(p).toMatchObject({ count: 1, p50: 42, p95: 42, p99: 42, min: 42, max: 42, meanMs: 42 });
  });
});

describe("CostTracker", () => {
  it("returns zeroed breakdown when empty", () => {
    const t = new CostTracker();
    expect(t.breakdown()).toEqual({ totalUsd: 0, perTrialUsd: 0, trials: 0 });
  });

  it("records costs and computes per-trial average", () => {
    const t = new CostTracker();
    t.record(0.1);
    t.record(0.2);
    t.record(0.3);
    const b = t.breakdown();
    expect(b.totalUsd).toBeCloseTo(0.6, 9);
    expect(b.perTrialUsd).toBeCloseTo(0.2, 9);
    expect(b.trials).toBe(3);
  });

  it("rejects non-finite or negative costs", () => {
    const t = new CostTracker();
    expect(() => t.record(Number.NaN)).toThrow(/finite/);
    expect(() => t.record(-0.01)).toThrow(/non-negative/);
  });
});
