/**
 * Resource tracker — captures process RSS / heap / external memory and a
 * sampled memory watch. Lightweight: no I/O, no external deps. Designed
 * for use inside MultiTrialRunner and during LIVE perf tests.
 */

export interface MemorySnapshot {
  rssMB: number;
  heapUsedMB: number;
  externalMB: number;
  capturedAt: number;
}

export interface MemoryWatchResult {
  samples: number[]; // RSS in MB, in capture order
  peakRssMB: number;
  meanRssMB: number;
  durationMs: number;
}

export interface ResourceTrackerOptions {
  /** Test-only injection point for `process.memoryUsage()`. */
  memoryUsage?: () => NodeJS.MemoryUsage;
}

const MB = 1024 * 1024;

export class ResourceTracker {
  private memoryUsage: () => NodeJS.MemoryUsage;
  private timer: NodeJS.Timeout | null = null;
  private samples: number[] = [];
  private startedAt = 0;
  private watching = false;

  constructor(opts: ResourceTrackerOptions = {}) {
    this.memoryUsage = opts.memoryUsage ?? (() => process.memoryUsage());
  }

  snapshotMemory(): MemorySnapshot {
    const m = this.memoryUsage();
    return {
      rssMB: m.rss / MB,
      heapUsedMB: m.heapUsed / MB,
      externalMB: (m.external ?? 0) / MB,
      capturedAt: Date.now(),
    };
  }

  isWatching(): boolean {
    return this.watching;
  }

  startMemoryWatch(intervalMs = 250): void {
    if (this.watching) throw new Error("ResourceTracker: memory watch already started");
    this.samples = [];
    this.startedAt = Date.now();
    this.watching = true;
    // Capture an immediate sample so very short watches still produce data.
    this.samples.push(this.snapshotMemory().rssMB);
    const interval = Math.max(10, intervalMs);
    this.timer = setInterval(() => {
      if (!this.watching) return;
      this.samples.push(this.snapshotMemory().rssMB);
    }, interval);
    if (typeof this.timer.unref === "function") this.timer.unref();
  }

  stopMemoryWatch(): MemoryWatchResult {
    if (!this.watching) {
      return { samples: [], peakRssMB: 0, meanRssMB: 0, durationMs: 0 };
    }
    this.watching = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    const samples = [...this.samples];
    const n = samples.length;
    const peak = n > 0 ? Math.max(...samples) : 0;
    const mean = n > 0 ? samples.reduce((a, b) => a + b, 0) / n : 0;
    return {
      samples,
      peakRssMB: peak,
      meanRssMB: mean,
      durationMs: Date.now() - this.startedAt,
    };
  }

  /** Difference of two memory snapshots, in MB. */
  static deltaMB(before: MemorySnapshot, after: MemorySnapshot): {
    rssMB: number;
    heapUsedMB: number;
    externalMB: number;
  } {
    return {
      rssMB: after.rssMB - before.rssMB,
      heapUsedMB: after.heapUsedMB - before.heapUsedMB,
      externalMB: after.externalMB - before.externalMB,
    };
  }
}
