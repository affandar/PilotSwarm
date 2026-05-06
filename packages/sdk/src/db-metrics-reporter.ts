/**
 * Periodic reporter that persists per-process DB call metric deltas into
 * db_call_metric_buckets every ~60 seconds.
 *
 * Lifecycle: call start() once after catalog is ready, stop() on shutdown.
 * Errors are caught and forwarded to onError — the reporter never crashes.
 * The internal timer is unref'd so it does not prevent process exit.
 *
 * @module
 */

import os from "node:os";
import type { DbCallMetricBucketInput, SessionCatalogProvider } from "./cms.js";
import type { DbMetricsSnapshot } from "./db-metrics.js";

// ─── Types ────────────────────────────────────────────────────────

/** Anything that can produce a metrics snapshot (enables test injection). */
export interface DbMetricsSource {
    snapshot(): DbMetricsSnapshot;
}

interface DbMetricsReporterOptions {
    /** CMS catalog to write metric buckets to. */
    catalog: Pick<SessionCatalogProvider, "upsertDbCallMetricBucketBatch">;
    /** Metrics source — typically globalDbMetrics. */
    metrics: DbMetricsSource;
    /** Process identity string: "<hostname>:<pid>:<bootTs>". */
    processId: string;
    /** Process role label (e.g. "worker", "portal", "cli"). */
    processRole: string;
    /** Flush interval in milliseconds. Default: 60_000. */
    intervalMs?: number;
    /** Called with flush errors instead of throwing. Default: no-op. */
    onError?: (err: unknown) => void;
}

// ─── Helpers ──────────────────────────────────────────────────────

/** UTC minute bucket: truncates a Date to the start of its minute. */
function toMinuteBucket(d: Date): Date {
    return new Date(Math.floor(d.getTime() / 60_000) * 60_000);
}

/** Module-level boot timestamp captured once when this module first loads. */
const PROCESS_BOOT_TS = Date.now();

/** Build the stable per-process identity string "<hostname>:<pid>:<bootTs>". */
export function makeProcessId(): string {
    return `${os.hostname()}:${process.pid}:${PROCESS_BOOT_TS}`;
}

/** Read process role from PILOTSWARM_PROCESS_ROLE env var, falling back to "unknown". */
export function makeProcessRole(): string {
    const role = (process.env.PILOTSWARM_PROCESS_ROLE ?? "").trim();
    return role || "unknown";
}

// ─── Reporter ─────────────────────────────────────────────────────

/**
 * Periodically flushes per-process DB call metric deltas to db_call_metric_buckets.
 *
 * Algorithm per interval:
 *   1. Snapshot current counters.
 *   2. Compute per-method delta vs previous snapshot (clamped to ≥ 0).
 *   3. Build one DbCallMetricBucketInput row per method with non-zero delta.
 *   4. Skip DB write if no non-zero rows (completely idle interval).
 *   5. Upsert rows via catalog.upsertDbCallMetricBucketBatch.
 *   6. Store current snapshot as new baseline for the next interval.
 */
export class DbMetricsReporter {
    private _catalog: Pick<SessionCatalogProvider, "upsertDbCallMetricBucketBatch">;
    private _metrics: DbMetricsSource;
    private _processId: string;
    private _processRole: string;
    private _intervalMs: number;
    private _onError: (err: unknown) => void;
    private _timer: ReturnType<typeof setInterval> | null = null;
    private _prevSnapshot: DbMetricsSnapshot | null = null;

    constructor(opts: DbMetricsReporterOptions) {
        this._catalog     = opts.catalog;
        this._metrics     = opts.metrics;
        this._processId   = opts.processId;
        this._processRole = opts.processRole;
        this._intervalMs  = opts.intervalMs ?? 60_000;
        this._onError     = opts.onError ?? (() => {});
    }

    /** Start the periodic flush interval. Idempotent — safe to call multiple times. */
    start(): void {
        if (this._timer) return;
        // Capture baseline immediately so first interval sees real deltas.
        this._prevSnapshot = this._metrics.snapshot();
        this._timer = setInterval(() => {
            this.flushOnce().catch(() => {});
        }, this._intervalMs);
        // Don't keep the process alive just for this timer.
        if (typeof (this._timer as any).unref === "function") {
            (this._timer as any).unref();
        }
    }

    /** Stop the periodic flush interval. Idempotent. Does not flush outstanding deltas. */
    stop(): void {
        if (!this._timer) return;
        clearInterval(this._timer);
        this._timer = null;
    }

    /**
     * Compute and flush current delta to the DB right now.
     * Safe to call manually (e.g. on graceful shutdown).
     * Never throws — errors are forwarded to onError.
     */
    async flushOnce(): Promise<void> {
        try {
            const current = this._metrics.snapshot();
            const rows = this._computeDeltaRows(current);
            // Always advance baseline so next interval delta is correct.
            this._prevSnapshot = current;
            if (rows.length === 0) return;
            await this._catalog.upsertDbCallMetricBucketBatch(rows);
        } catch (err) {
            this._onError(err);
        }
    }

    private _computeDeltaRows(current: DbMetricsSnapshot): DbCallMetricBucketInput[] {
        const bucket = toMinuteBucket(new Date());
        const prev = this._prevSnapshot;
        const rows: DbCallMetricBucketInput[] = [];

        for (const method of Object.keys(current.counts)) {
            // Clamp negatives to 0 — protects against counter resets or clock skew.
            const calls   = Math.max(0, (current.counts[method]  ?? 0) - (prev?.counts[method]  ?? 0));
            const errors  = Math.max(0, (current.errors[method]  ?? 0) - (prev?.errors[method]  ?? 0));
            const totalMs = Math.max(0, (current.totalMs[method] ?? 0) - (prev?.totalMs[method] ?? 0));
            if (calls === 0 && errors === 0 && totalMs === 0) continue;
            rows.push({
                bucket,
                process:     this._processId,
                processRole: this._processRole,
                method,
                calls,
                errors,
                totalMs,
            });
        }

        return rows;
    }
}
