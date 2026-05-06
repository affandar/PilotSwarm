/**
 * Per-process in-memory DB call metrics.
 *
 * Counters accumulate until the process restarts. These are NOT fleet-wide
 * aggregates — each worker process has its own independent snapshot.
 *
 * @module
 */

export interface DbMetricsSnapshot {
    /** Total call count per method key. */
    counts: Record<string, number>;
    /** Error call count per method key. */
    errors: Record<string, number>;
    /** Cumulative duration in milliseconds per method key. */
    totalMs: Record<string, number>;
    /** Average duration in milliseconds per method key (computed from totalMs/counts). */
    avgMs: Record<string, number>;
    /** ISO timestamp when this snapshot was taken. */
    capturedAt: string;
}

class DbMetrics {
    private _counts:  Record<string, number> = {};
    private _errors:  Record<string, number> = {};
    private _totalMs: Record<string, number> = {};

    record(method: string, durationMs: number, isError = false): void {
        this._counts[method]  = (this._counts[method]  ?? 0) + 1;
        this._totalMs[method] = (this._totalMs[method] ?? 0) + durationMs;
        if (isError) this._errors[method] = (this._errors[method] ?? 0) + 1;
    }

    snapshot(): DbMetricsSnapshot {
        const avgMs: Record<string, number> = {};
        for (const m of Object.keys(this._counts)) {
            avgMs[m] = this._counts[m] > 0
                ? Math.round(this._totalMs[m] / this._counts[m])
                : 0;
        }
        return {
            counts:     { ...this._counts  },
            errors:     { ...this._errors  },
            totalMs:    { ...this._totalMs },
            avgMs,
            capturedAt: new Date().toISOString(),
        };
    }
}

/**
 * Per-process singleton. Use low-cardinality keys like "cms.getSession" — never
 * include session IDs, user data, or other dynamic values in the method key.
 */
export const globalDbMetrics = new DbMetrics();
