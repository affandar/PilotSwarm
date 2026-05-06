export interface SloThresholds {
    /** Warn if p95 turn latency exceeds this (ms). */
    p95TargetMs: number;
    /** Warn if p99 turn latency exceeds this (ms). */
    p99TargetMs: number;
    /** Warn if error_count / turn_count exceeds this fraction (0–1). */
    errorRateTarget: number;
    /** Warn if tool_error_count / tool_call_count exceeds this fraction (0–1). */
    toolErrorRateTarget: number;
    /** Skip evaluation if turn_count is below this — avoids noise on sparse data. */
    minSampleSize: number;
}

export const DEFAULT_SLO_THRESHOLDS: SloThresholds = {
    p95TargetMs:         Number(process.env.SLO_P95_TARGET_MS)          || 15_000,
    p99TargetMs:         Number(process.env.SLO_P99_TARGET_MS)          || 30_000,
    errorRateTarget:     Number(process.env.SLO_ERROR_RATE_TARGET)      || 0.05,
    toolErrorRateTarget: Number(process.env.SLO_TOOL_ERROR_RATE_TARGET) || 0.10,
    minSampleSize:       Number(process.env.SLO_MIN_SAMPLE_SIZE)        || 10,
};
