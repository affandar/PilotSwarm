import { describe, it, expect } from "vitest";
import { ResourceTracker } from "../../src/perf/resource-tracker.js";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const MB = 1024 * 1024;

function makeFakeMemory(values: number[]): () => NodeJS.MemoryUsage {
  let i = 0;
  return () => {
    const rss = (values[Math.min(i, values.length - 1)] ?? 0) * MB;
    i++;
    return {
      rss,
      heapUsed: rss / 2,
      heapTotal: rss,
      external: rss / 4,
      arrayBuffers: 0,
    } as NodeJS.MemoryUsage;
  };
}

describe("ResourceTracker", () => {
  it("snapshotMemory returns MB-converted values", () => {
    const t = new ResourceTracker({ memoryUsage: makeFakeMemory([100]) });
    const s = t.snapshotMemory();
    expect(s.rssMB).toBe(100);
    expect(s.heapUsedMB).toBe(50);
    expect(s.externalMB).toBe(25);
  });

  it("startMemoryWatch / stopMemoryWatch roundtrip", async () => {
    const t = new ResourceTracker({ memoryUsage: makeFakeMemory([10, 20, 30, 40]) });
    expect(t.isWatching()).toBe(false);
    t.startMemoryWatch(15);
    expect(t.isWatching()).toBe(true);
    await sleep(60);
    const r = t.stopMemoryWatch();
    expect(t.isWatching()).toBe(false);
    expect(r.samples.length).toBeGreaterThanOrEqual(2);
    expect(r.peakRssMB).toBeGreaterThanOrEqual(r.meanRssMB);
    expect(r.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("rejects double-start", () => {
    const t = new ResourceTracker({ memoryUsage: makeFakeMemory([10]) });
    t.startMemoryWatch(50);
    expect(() => t.startMemoryWatch(50)).toThrow(/already started/);
    t.stopMemoryWatch();
  });

  it("stop without start returns empty", () => {
    const t = new ResourceTracker({ memoryUsage: makeFakeMemory([10]) });
    const r = t.stopMemoryWatch();
    expect(r).toEqual({ samples: [], peakRssMB: 0, meanRssMB: 0, durationMs: 0 });
  });

  it("captures at least one sample even for very short watch", () => {
    const t = new ResourceTracker({ memoryUsage: makeFakeMemory([10, 20]) });
    t.startMemoryWatch(100_000);
    const r = t.stopMemoryWatch();
    expect(r.samples.length).toBeGreaterThanOrEqual(1);
    expect(r.peakRssMB).toBeGreaterThan(0);
  });

  it("ResourceTracker.deltaMB computes per-field differences", () => {
    const before = { rssMB: 50, heapUsedMB: 25, externalMB: 5, capturedAt: 0 };
    const after = { rssMB: 90, heapUsedMB: 40, externalMB: 8, capturedAt: 1 };
    const d = ResourceTracker.deltaMB(before, after);
    expect(d).toEqual({ rssMB: 40, heapUsedMB: 15, externalMB: 3 });
  });
});
