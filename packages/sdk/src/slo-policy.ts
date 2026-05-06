import type { FleetTurnAnalyticsRow } from "./cms.js";
import type { SloThresholds } from "./slo-config.js";

export type SloStatus = "ok" | "warn" | "critical";

export interface SloViolation {
    metric: string;
    actual: number;
    target: number;
    severity: "warn" | "critical";
}

export interface SloHealthReport {
    status: SloStatus;
    violations: SloViolation[];
    agentId: string | null;
    model: string | null;
    turnCount: number;
}

export interface SloAction {
    action: "none" | "log" | "alert";
    reason: string;
}

export function evaluateSloHealth(
    row: FleetTurnAnalyticsRow,
    thresholds: SloThresholds,
): SloHealthReport {
    const base = { agentId: row.agentId, model: row.model, turnCount: row.turnCount };

    if (row.turnCount < thresholds.minSampleSize) {
        return { ...base, status: "ok", violations: [] };
    }

    const violations: SloViolation[] = [];

    if (row.p95DurationMs > thresholds.p95TargetMs) {
        violations.push({
            metric: "p95_duration_ms",
            actual: row.p95DurationMs,
            target: thresholds.p95TargetMs,
            severity: "warn",
        });
    }

    if (row.p99DurationMs > thresholds.p99TargetMs) {
        violations.push({
            metric: "p99_duration_ms",
            actual: row.p99DurationMs,
            target: thresholds.p99TargetMs,
            severity: row.p99DurationMs > thresholds.p99TargetMs * 1.5 ? "critical" : "warn",
        });
    }

    const errorRate = row.turnCount > 0 ? row.errorCount / row.turnCount : 0;
    if (errorRate > thresholds.errorRateTarget) {
        violations.push({
            metric: "error_rate",
            actual: errorRate,
            target: thresholds.errorRateTarget,
            severity: errorRate > thresholds.errorRateTarget * 2 ? "critical" : "warn",
        });
    }

    if (row.toolCallCount > 0) {
        const toolErrorRate = row.toolErrorCount / row.toolCallCount;
        if (toolErrorRate > thresholds.toolErrorRateTarget) {
            violations.push({
                metric: "tool_error_rate",
                actual: toolErrorRate,
                target: thresholds.toolErrorRateTarget,
                severity: "warn",
            });
        }
    }

    const hasCritical = violations.some(v => v.severity === "critical");
    const status: SloStatus = hasCritical ? "critical" : violations.length > 0 ? "warn" : "ok";
    return { ...base, status, violations };
}

export function decideSloAction(report: SloHealthReport): SloAction {
    if (report.status === "ok") {
        return { action: "none", reason: "all SLOs met" };
    }

    const worst = report.violations.find(v => v.severity === "critical") ?? report.violations[0];
    const pct = Math.round(((worst.actual - worst.target) / worst.target) * 100);

    if (report.status === "critical") {
        return {
            action: "alert",
            reason: `${worst.metric} critically exceeded (${worst.actual.toFixed(1)} vs target ${worst.target})`,
        };
    }

    return {
        action: "log",
        reason: `${worst.metric} exceeded by ${pct}%`,
    };
}
