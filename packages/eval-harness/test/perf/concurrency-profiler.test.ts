import { describe, it, expect } from "vitest";
import {
  ConcurrencyProfiler,
  computeScalingFactor,
} from "../../src/perf/concurrency-profiler.js";
import type { Driver, DriverOptions } from "../../src/drivers/types.js";
import type { EvalSample, ObservedResult } from "../../src/types.js";

function sample(): EvalSample {
  return {
    id: "perf",
    input: { prompt: "hi" },
    expected: { toolCalls: [] },
  } as unknown as EvalSample;
}

class FakeLatencyDriver implements Driver {
  constructor(private latencyMs: number, private fail = false) {}
  async run(_s: EvalSample, _o?: DriverOptions): Promise<ObservedResult> {
    if (this.fail) throw new Error("fail");
    return {
      toolCalls: [],
      finalResponse: "",
      sessionId: "sess",
      latencyMs: this.latencyMs,
    } as ObservedResult;
  }
}

describe("computeScalingFactor", () => {
  it("returns 1 for empty levels", () => {
    expect(computeScalingFactor({}, [])).toBe(1);
  });

  it("returns 1 when baseline is zero", () => {
    expect(
      computeScalingFactor(
        {
          1: {
            count: 0,
            meanLatency: 0,
            p50Latency: 0,
            p95Latency: 0,
            failures: 0,
            percentiles: { count: 0, p50: 0, p95: 0, p99: 0, min: 0, max: 0, meanMs: 0 },
          },
        },
        [1],
      ),
    ).toBe(1);
  });

  it("returns ratio of max-N mean to min-N mean", () => {
    const byN = {
      1: {
        count: 1,
        meanLatency: 100,
        p50Latency: 100,
        p95Latency: 100,
        failures: 0,
        percentiles: {
          count: 1,
          p50: 100,
          p95: 100,
          p99: 100,
          min: 100,
          max: 100,
          meanMs: 100,
        },
      },
      4: {
        count: 1,
        meanLatency: 250,
        p50Latency: 250,
        p95Latency: 250,
        failures: 0,
        percentiles: {
          count: 1,
          p50: 250,
          p95: 250,
          p99: 250,
          min: 250,
          max: 250,
          meanMs: 250,
        },
      },
    };
    expect(computeScalingFactor(byN, [1, 4])).toBe(2.5);
  });
});

describe("ConcurrencyProfiler", () => {
  it("rejects empty levels", async () => {
    const p = new ConcurrencyProfiler();
    await expect(
      p.profile({
        driverFactory: () => new FakeLatencyDriver(10),
        sample: sample(),
        levels: [],
      }),
    ).rejects.toThrow(/levels/);
  });

  it("rejects non-positive levels", async () => {
    const p = new ConcurrencyProfiler();
    await expect(
      p.profile({
        driverFactory: () => new FakeLatencyDriver(10),
        sample: sample(),
        levels: [0],
      }),
    ).rejects.toThrow(/positive/);
    await expect(
      p.profile({
        driverFactory: () => new FakeLatencyDriver(10),
        sample: sample(),
        levels: [1.5],
      }),
    ).rejects.toThrow(/positive/);
  });

  it("runs N parallel drivers and records latencies", async () => {
    const profiler = new ConcurrencyProfiler();
    const result = await profiler.profile({
      driverFactory: () => new FakeLatencyDriver(50),
      sample: sample(),
      levels: [1, 4],
      samplesPerLevel: 1,
    });
    expect(result.byN[1]?.count).toBe(1);
    expect(result.byN[4]?.count).toBe(4);
    expect(result.byN[1]?.meanLatency).toBe(50);
    expect(result.byN[4]?.meanLatency).toBe(50);
    expect(result.scalingFactor).toBe(1);
  });

  it("counts failures separately from latencies", async () => {
    const profiler = new ConcurrencyProfiler();
    let calls = 0;
    const result = await profiler.profile({
      driverFactory: () => {
        calls += 1;
        return new FakeLatencyDriver(20, calls % 2 === 0);
      },
      sample: sample(),
      levels: [4],
      samplesPerLevel: 1,
    });
    const stat = result.byN[4]!;
    expect(stat.failures).toBe(2);
    expect(stat.count).toBe(2);
  });

  it("samplesPerLevel multiplies attempts per N", async () => {
    const profiler = new ConcurrencyProfiler();
    const result = await profiler.profile({
      driverFactory: () => new FakeLatencyDriver(5),
      sample: sample(),
      levels: [2],
      samplesPerLevel: 3,
    });
    expect(result.byN[2]?.count).toBe(6);
  });

  // H2 fix: failure-aware effective scaling
  it("inflates effectiveMeanLatency with failure rate (H2)", async () => {
    const profiler = new ConcurrencyProfiler();
    let calls = 0;
    const result = await profiler.profile({
      // 4 attempts: 2 succeed at 100ms, 2 fail.
      driverFactory: () => {
        calls += 1;
        return new FakeLatencyDriver(100, calls % 2 === 0);
      },
      sample: sample(),
      levels: [4],
      samplesPerLevel: 1,
    });
    const stat = result.byN[4]!;
    expect(stat.failures).toBe(2);
    expect(stat.failureRate).toBe(0.5);
    // effective = mean(100) * (1 + 0.5) = 150
    expect(stat.effectiveMeanLatency).toBe(150);
  });

  it("scalingFactor uses effectiveMeanLatency so failures cannot mask contention (H2)", async () => {
    const profiler = new ConcurrencyProfiler();
    // N=1: 1 success, no failures. effLatency = 100.
    // N=4: 1 success at 100ms, 3 failures. mean = 100, failureRate=0.75,
    //      effLatency = 100 * 1.75 = 175. scalingFactor = 1.75.
    let n1Calls = 0;
    let n4Calls = 0;
    const result = await profiler.profile({
      driverFactory: () => {
        // First call goes to N=1 (the smaller level runs first).
        const isN1 = n1Calls + n4Calls === 0;
        if (isN1) {
          n1Calls += 1;
          return new FakeLatencyDriver(100, false);
        }
        n4Calls += 1;
        return new FakeLatencyDriver(100, n4Calls > 1);
      },
      sample: sample(),
      levels: [1, 4],
      samplesPerLevel: 1,
    });
    expect(result.byN[1]?.failures).toBe(0);
    expect(result.byN[4]?.failures).toBe(3);
    // scaling factor honestly reflects the failure penalty
    expect(result.scalingFactor).toBeCloseTo(1.75, 2);
  });

  it("aborts via failureRateAbortThreshold when crossed (H2)", async () => {
    const profiler = new ConcurrencyProfiler();
    let calls = 0;
    const result = await profiler.profile({
      driverFactory: () => {
        calls += 1;
        return new FakeLatencyDriver(50, calls > 1); // first ok, rest fail
      },
      sample: sample(),
      levels: [4],
      samplesPerLevel: 1,
      failureRateAbortThreshold: 0.5,
    });
    expect(result.abortedReason).toMatch(/failureRate.*> threshold 0.5/);
  });

  it("preflight capacity guard refuses when projected connections > maxConnections", async () => {
    const profiler = new ConcurrencyProfiler();
    let createCount = 0;
    const result = await profiler.profile({
      driverFactory: () => {
        createCount += 1;
        return new FakeLatencyDriver(10);
      },
      sample: sample(),
      levels: [1, 2, 4, 8],
      samplesPerLevel: 1,
      capacity: { connectionsPerDriver: 5, maxConnections: 30 },
    });
    expect(result.abortedReason).toMatch(/capacity guard/);
    // Aborted before any driver was instantiated.
    expect(createCount).toBe(0);
    expect(Object.keys(result.byN)).toEqual([]);
  });

  it("preflight capacity guard allows runs that fit within budget", async () => {
    const profiler = new ConcurrencyProfiler();
    const result = await profiler.profile({
      driverFactory: () => new FakeLatencyDriver(10),
      sample: sample(),
      levels: [1, 2],
      samplesPerLevel: 1,
      capacity: { connectionsPerDriver: 5, maxConnections: 100 },
    });
    expect(result.abortedReason).toBeUndefined();
    expect(result.byN[1]?.count).toBe(1);
    expect(result.byN[2]?.count).toBe(2);
  });
});
