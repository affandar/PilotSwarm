/**
 * Durability perf tracker — captures per-operation timings for rehydrate /
 * replay / checkpoint / dehydrate.
 *
 * Honesty contract (post-reaudit G4 / NEW BLOCKER 1 fix):
 *
 * Every recorded sample carries a *source* tag, surfaced through
 * `TrackerPercentiles.source`, so consumers can distinguish real
 * SDK-derived signal from coarse harness wall-clock numbers from
 * arbitrary explicit stopwatch samples:
 *
 *   - `"cms-events"`        — paired CMS `*-start`/`*-end` events
 *                             consumed by `recordFromCmsEvents()`. This
 *                             is the only first-class "real durability"
 *                             source and currently produces zero samples
 *                             in production because the SDK does not
 *                             emit the required `*-start` events. The
 *                             tracker logs and returns early in that
 *                             case rather than faking.
 *   - `"harness-wallclock"` — coarse wall-clock measurement taken by the
 *                             harness around an entire `LiveDriver.run()`
 *                             (or similar). Useful as a regression
 *                             sentinel but NOT a real durability latency.
 *   - `"explicit"`          — caller-supplied stopwatch (e.g. tests).
 *   - `"none"`              — no samples and no source claim.
 *
 * `replay` is permanently `available: false` via the public API. The
 * only way to populate it is `_recordReplayForTesting()`, which is
 * intentionally underscored and absent from the public type surface
 * exposed by `src/perf/index.ts`. Real replay timing requires a
 * duroxide trace parser the harness does not have today.
 */

export type TrackerSource =
  | "none"
  | "cms-events"
  | "harness-wallclock"
  | "explicit";

export type DurabilityBucket = "rehydrate" | "checkpoint" | "dehydrate";

export interface TrackerPercentiles {
  count: number;
  p50: number;
  p95: number;
  p99: number;
  min: number;
  max: number;
  meanMs: number;
  /**
   * Whether this percentile bucket has a real measurement source. False
   * means "no SDK hook / no CMS events / no harness measurement"; treat
   * the zero values as unmeasured, not as a clean zero.
   */
  available: boolean;
  /**
   * Provenance of the samples backing these percentiles. Consumers MUST
   * inspect this when interpreting latency: `harness-wallclock` is a
   * coarse end-to-end signal, not a real durability latency.
   */
  source: TrackerSource;
  unavailableReason?: string;
}

export interface DurabilityRecord {
  sessionId: string;
  ms: number;
  meta?: Record<string, unknown>;
  at: number;
}

export interface DurabilityPercentiles {
  rehydrate: TrackerPercentiles;
  replay: TrackerPercentiles;
  checkpoint: TrackerPercentiles;
  dehydrate: TrackerPercentiles;
}

const REPLAY_DEFERRED_REASON =
  "requires duroxide trace parser, not currently implemented";

const CMS_EVENTS_DEFERRED_REASON =
  "requires SDK start-event instrumentation, not currently emitted";

function emptyAvailable(source: TrackerSource): TrackerPercentiles {
  return {
    count: 0,
    p50: 0,
    p95: 0,
    p99: 0,
    min: 0,
    max: 0,
    meanMs: 0,
    available: true,
    source,
  };
}

function emptyUnavailable(
  reason: string,
  source: TrackerSource = "none",
): TrackerPercentiles {
  return {
    count: 0,
    p50: 0,
    p95: 0,
    p99: 0,
    min: 0,
    max: 0,
    meanMs: 0,
    available: false,
    source,
    unavailableReason: reason,
  };
}

export function percentilesOf(
  samples: number[],
  source: TrackerSource = "explicit",
): TrackerPercentiles {
  const n = samples.length;
  if (n === 0) return emptyAvailable(source);
  const sorted = [...samples].sort((a, b) => a - b);
  const pick = (p: number): number => {
    const idx = Math.min(n - 1, Math.max(0, Math.ceil(p * n) - 1));
    return sorted[idx]!;
  };
  const sum = sorted.reduce((acc, v) => acc + v, 0);
  return {
    count: n,
    p50: pick(0.5),
    p95: pick(0.95),
    p99: pick(0.99),
    min: sorted[0]!,
    max: sorted[n - 1]!,
    meanMs: sum / n,
    available: true,
    source,
  };
}

function validatedMs(ms: number, label: string): number {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) {
    throw new Error(
      `DurabilityTracker.${label}: ms must be a finite non-negative number (got ${String(ms)})`,
    );
  }
  return ms;
}

/**
 * Subset of a CMS `SessionEvent` row that the tracker needs. Defined here
 * (not imported) so the eval-harness package doesn't take a build-time
 * dep on the SDK's internal types.
 */
export interface CmsLikeEvent {
  sessionId: string;
  eventType: string;
  createdAt: Date | number | string;
}

interface PairConfig {
  startTypes: string[];
  endTypes: string[];
  bucket: DurabilityBucket;
}

const DEFAULT_PAIRS: PairConfig[] = [
  {
    startTypes: ["session.rehydrate-start", "session.rehydrate-attempt"],
    endTypes: ["session.hydrated", "session.rehydrated"],
    bucket: "rehydrate",
  },
  {
    startTypes: ["session.checkpoint-start"],
    endTypes: ["session.checkpointed"],
    bucket: "checkpoint",
  },
  {
    startTypes: ["session.dehydrate-start"],
    endTypes: ["session.dehydrated"],
    bucket: "dehydrate",
  },
];

function toMs(value: Date | number | string): number {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number") return value;
  return new Date(value).getTime();
}

export interface CmsPairingResult {
  rehydrateSamples: number;
  checkpointSamples: number;
  dehydrateSamples: number;
  unpairedStarts: number;
  /**
   * True when the input event stream contained none of the configured
   * `*-start` event types. In that case the tracker logs a deferral
   * notice and produces zero samples — this is the *expected* state
   * against the current PilotSwarm SDK, which only emits terminal
   * `session.hydrated` / `session.dehydrated` events.
   */
  noStartEventsFound: boolean;
}

export interface RecordFromCmsEventsOptions {
  /**
   * Optional sink for the deferral log so callers can capture / silence
   * the notice. Defaults to `console.warn`.
   */
  logger?: (msg: string) => void;
}

export class DurabilityTracker {
  // Per-source sample storage. Each source's samples are isolated so a
  // bucket reporting `source: cms-events` cannot include harness-wallclock
  // samples (and vice versa). When `percentiles()` returns, it picks the
  // highest-fidelity available source per bucket and reports samples from
  // that source ONLY.
  private rehydrateRecsByCms: DurabilityRecord[] = [];
  private rehydrateRecsByHarness: DurabilityRecord[] = [];
  private rehydrateRecsByExplicit: DurabilityRecord[] = [];
  private replayRecsByExplicit: DurabilityRecord[] = [];
  private checkpointRecsByCms: DurabilityRecord[] = [];
  private checkpointRecsByHarness: DurabilityRecord[] = [];
  private checkpointRecsByExplicit: DurabilityRecord[] = [];
  private dehydrateRecsByCms: DurabilityRecord[] = [];
  private dehydrateRecsByHarness: DurabilityRecord[] = [];
  private dehydrateRecsByExplicit: DurabilityRecord[] = [];

  recordRehydrate(
    sessionId: string,
    ms: number,
    meta?: Record<string, unknown>,
  ): void {
    this.rehydrateRecsByExplicit.push({
      sessionId,
      ms: validatedMs(ms, "recordRehydrate"),
      meta,
      at: Date.now(),
    });
  }

  recordCheckpoint(sessionId: string, ms: number, sizeBytes?: number): void {
    this.checkpointRecsByExplicit.push({
      sessionId,
      ms: validatedMs(ms, "recordCheckpoint"),
      meta: sizeBytes != null ? { sizeBytes } : undefined,
      at: Date.now(),
    });
  }

  recordDehydrate(sessionId: string, ms: number): void {
    this.dehydrateRecsByExplicit.push({
      sessionId,
      ms: validatedMs(ms, "recordDehydrate"),
      at: Date.now(),
    });
  }

  /**
   * Record a coarse harness wall-clock measurement taken around an
   * entire driver run. This is NOT real durability — it includes LLM
   * setup, tool execution, and teardown. It is exposed so tier-3
   * dashboards can show *some* signal while the real CMS-event source
   * is deferred. The resulting `TrackerPercentiles.source` is
   * `"harness-wallclock"`, which the reporter renders distinctly.
   *
   * Source provenance: harness-wallclock samples are stored in their
   * own bucket, isolated from CMS-events and explicit samples. When
   * a bucket has both harness-wallclock and CMS-events recorded, the
   * percentiles surface the higher-fidelity CMS-events samples ONLY —
   * harness samples are never mixed into a CMS-events percentile.
   */
  recordHarnessWallclock(
    bucket: DurabilityBucket,
    sessionId: string,
    ms: number,
    meta?: Record<string, unknown>,
  ): void {
    const validated = validatedMs(ms, "recordHarnessWallclock");
    const rec: DurabilityRecord = {
      sessionId,
      ms: validated,
      meta: { ...(meta ?? {}), source: "harness-wallclock" },
      at: Date.now(),
    };
    if (bucket === "rehydrate") {
      this.rehydrateRecsByHarness.push(rec);
    } else if (bucket === "checkpoint") {
      this.checkpointRecsByHarness.push(rec);
    } else {
      this.dehydrateRecsByHarness.push(rec);
    }
  }

  /**
   * Internal-only test escape hatch for `replay` — intentionally not
   * exposed in the public type surface (`src/perf/index.ts`) and not
   * named `recordReplay`. Even when this is called, `percentiles().replay`
   * remains `available: false` with the deferred-reason marker, so no
   * downstream report can claim replay was measured. Use only inside
   * unit tests that exercise tracker plumbing.
   *
   * @internal
   */
  _recordReplayForTesting(
    sessionId: string,
    ms: number,
    historyDepth: number,
  ): void {
    this.replayRecsByExplicit.push({
      sessionId,
      ms: validatedMs(ms, "_recordReplayForTesting"),
      meta: { historyDepth, source: "explicit" },
      at: Date.now(),
    });
  }

  /**
   * Derive rehydrate / checkpoint / dehydrate latencies from a stream of
   * CMS events (typically obtained via
   * `PilotSwarmManagementClient.getSessionEvents(sessionId)`).
   *
   * Pairing rule: each `*-start` event consumes the next `*` end event
   * of the matching bucket on the same session, in chronological order.
   * Unpaired start events are reported via `unpairedStarts` so callers
   * can detect dropped/incomplete cycles.
   *
   * Reaudit G4 fix: if the input event stream contains NONE of the
   * configured `*-start` event types, the tracker returns early with
   * `noStartEventsFound: true` and emits a one-line deferral log. This
   * is the production-default state today because the SDK only emits
   * terminal `session.hydrated` / `session.dehydrated` events. The
   * tracker explicitly does NOT pair end-only events into latencies.
   *
   * `replay` is intentionally never derived here — duroxide does not
   * emit a paired CMS event for replay.
   */
  recordFromCmsEvents(
    sessionId: string,
    events: ReadonlyArray<CmsLikeEvent>,
    pairs: ReadonlyArray<PairConfig> = DEFAULT_PAIRS,
    opts: RecordFromCmsEventsOptions = {},
  ): CmsPairingResult {
    const result: CmsPairingResult = {
      rehydrateSamples: 0,
      checkpointSamples: 0,
      dehydrateSamples: 0,
      unpairedStarts: 0,
      noStartEventsFound: true,
    };
    const sessionEvents = events
      .filter((e) => e.sessionId === sessionId)
      .map((e) => ({ ...e, _ms: toMs(e.createdAt) }))
      .sort((a, b) => a._ms - b._ms);

    const allStartTypes = new Set<string>();
    for (const pair of pairs) for (const t of pair.startTypes) allStartTypes.add(t);
    const sawStart = sessionEvents.some((e) => allStartTypes.has(e.eventType));

    if (!sawStart) {
      const log = opts.logger ?? defaultDeferralLogger;
      log(
        `[DurabilityTracker] no '*-start' events found for session ${sessionId} — durability sampling deferred (${CMS_EVENTS_DEFERRED_REASON}).`,
      );
      return result;
    }

    result.noStartEventsFound = false;

    for (const pair of pairs) {
      const startSet = new Set(pair.startTypes);
      const endSet = new Set(pair.endTypes);
      const pendingStarts: Array<{ at: number }> = [];
      for (const ev of sessionEvents) {
        if (startSet.has(ev.eventType)) {
          pendingStarts.push({ at: ev._ms });
        } else if (endSet.has(ev.eventType)) {
          const start = pendingStarts.shift();
          if (!start) continue;
          const ms = Math.max(0, ev._ms - start.at);
          if (pair.bucket === "rehydrate") {
            this.rehydrateRecsByCms.push({
              sessionId,
              ms,
              meta: { source: "cms-events" },
              at: Date.now(),
            });
            result.rehydrateSamples += 1;
          } else if (pair.bucket === "checkpoint") {
            this.checkpointRecsByCms.push({
              sessionId,
              ms,
              meta: { source: "cms-events" },
              at: Date.now(),
            });
            result.checkpointSamples += 1;
          } else {
            this.dehydrateRecsByCms.push({
              sessionId,
              ms,
              meta: { source: "cms-events" },
              at: Date.now(),
            });
            result.dehydrateSamples += 1;
          }
        }
      }
      result.unpairedStarts += pendingStarts.length;
    }
    return result;
  }

  records(): {
    rehydrate: DurabilityRecord[];
    replay: DurabilityRecord[];
    checkpoint: DurabilityRecord[];
    dehydrate: DurabilityRecord[];
  } {
    // Records are flattened from all source buckets for diagnostic introspection.
    // Note: callers should rely on `percentiles()` for source-pure aggregates.
    return {
      rehydrate: [
        ...this.rehydrateRecsByCms,
        ...this.rehydrateRecsByHarness,
        ...this.rehydrateRecsByExplicit,
      ],
      replay: [...this.replayRecsByExplicit],
      checkpoint: [
        ...this.checkpointRecsByCms,
        ...this.checkpointRecsByHarness,
        ...this.checkpointRecsByExplicit,
      ],
      dehydrate: [
        ...this.dehydrateRecsByCms,
        ...this.dehydrateRecsByHarness,
        ...this.dehydrateRecsByExplicit,
      ],
    };
  }

  /**
   * Diagnostic API: per-source sample counts for a bucket. Useful for
   * reporting and for verifying that source isolation is preserved.
   */
  countsBySource(): {
    rehydrate: { cms: number; harness: number; explicit: number };
    checkpoint: { cms: number; harness: number; explicit: number };
    dehydrate: { cms: number; harness: number; explicit: number };
  } {
    return {
      rehydrate: {
        cms: this.rehydrateRecsByCms.length,
        harness: this.rehydrateRecsByHarness.length,
        explicit: this.rehydrateRecsByExplicit.length,
      },
      checkpoint: {
        cms: this.checkpointRecsByCms.length,
        harness: this.checkpointRecsByHarness.length,
        explicit: this.checkpointRecsByExplicit.length,
      },
      dehydrate: {
        cms: this.dehydrateRecsByCms.length,
        harness: this.dehydrateRecsByHarness.length,
        explicit: this.dehydrateRecsByExplicit.length,
      },
    };
  }

  percentiles(): DurabilityPercentiles {
    // Source isolation contract: when a bucket has samples from multiple
    // sources, we surface ONLY the highest-fidelity available source's
    // samples. Priority order: cms-events > harness-wallclock > explicit.
    // This guarantees that a bucket reporting `source: cms-events` cannot
    // include any harness-wallclock or explicit samples in its percentiles.
    const computeBucket = (
      cmsRecs: DurabilityRecord[],
      harnessRecs: DurabilityRecord[],
      explicitRecs: DurabilityRecord[],
      missingReason: string,
    ): TrackerPercentiles => {
      let chosenRecs: DurabilityRecord[];
      let chosenSource: TrackerSource;
      if (cmsRecs.length > 0) {
        chosenRecs = cmsRecs;
        chosenSource = "cms-events";
      } else if (harnessRecs.length > 0) {
        chosenRecs = harnessRecs;
        chosenSource = "harness-wallclock";
      } else if (explicitRecs.length > 0) {
        chosenRecs = explicitRecs;
        chosenSource = "explicit";
      } else {
        return emptyUnavailable(missingReason);
      }
      return percentilesOf(chosenRecs.map((r) => r.ms), chosenSource);
    };

    const rehydrate = computeBucket(
      this.rehydrateRecsByCms,
      this.rehydrateRecsByHarness,
      this.rehydrateRecsByExplicit,
      "no rehydrate samples recorded",
    );
    const checkpoint = computeBucket(
      this.checkpointRecsByCms,
      this.checkpointRecsByHarness,
      this.checkpointRecsByExplicit,
      "no checkpoint samples recorded",
    );
    const dehydrate = computeBucket(
      this.dehydrateRecsByCms,
      this.dehydrateRecsByHarness,
      this.dehydrateRecsByExplicit,
      "no dehydrate samples recorded",
    );

    // Replay is permanently deferred: even if `_recordReplayForTesting`
    // populated samples, expose them as unavailable so no public report
    // can accidentally claim replay was measured.
    const replayBase = this.replayRecsByExplicit.length === 0
      ? emptyUnavailable(REPLAY_DEFERRED_REASON)
      : percentilesOf(
          this.replayRecsByExplicit.map((r) => r.ms),
          "explicit",
        );
    const replay: TrackerPercentiles = {
      ...replayBase,
      available: false,
      unavailableReason: REPLAY_DEFERRED_REASON,
    };

    return { rehydrate, replay, checkpoint, dehydrate };
  }

  reset(): void {
    this.rehydrateRecsByCms = [];
    this.rehydrateRecsByHarness = [];
    this.rehydrateRecsByExplicit = [];
    this.replayRecsByExplicit = [];
    this.checkpointRecsByCms = [];
    this.checkpointRecsByHarness = [];
    this.checkpointRecsByExplicit = [];
    this.dehydrateRecsByCms = [];
    this.dehydrateRecsByHarness = [];
    this.dehydrateRecsByExplicit = [];
  }
}

function defaultDeferralLogger(msg: string): void {
  // eslint-disable-next-line no-console
  console.warn(msg);
}

export const __DURABILITY_DEFERRED_REASONS__ = {
  replay: REPLAY_DEFERRED_REASON,
  cmsEvents: CMS_EVENTS_DEFERRED_REASON,
} as const;
