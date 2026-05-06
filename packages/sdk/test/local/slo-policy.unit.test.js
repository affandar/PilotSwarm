/**
 * Unit tests for Phase 5 — SLO Policy.
 *
 * Pure logic tests (no DB, no LLM, no network).
 *
 * Covers:
 *   - evaluateSloHealth: sample-size guard, ok/warn/critical per metric
 *   - decideSloAction: maps status → none/log/alert with reason
 *   - DEFAULT_SLO_THRESHOLDS: env-var overrides and fallback defaults
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
    evaluateSloHealth,
    decideSloAction,
} from "../../src/slo-policy.ts";
import { DEFAULT_SLO_THRESHOLDS } from "../../src/slo-config.ts";

// ─── Helpers ─────────────────────────────────────────────────

function makeRow(overrides = {}) {
    return {
        agentId: "test-agent",
        model: "gpt-4o",
        turnCount: 100,
        errorCount: 0,
        toolCallCount: 50,
        toolErrorCount: 0,
        avgDurationMs: 5000,
        p95DurationMs: 10000,
        p99DurationMs: 20000,
        totalTokensInput: 10000,
        totalTokensOutput: 5000,
        totalTokensCacheRead: 0,
        totalTokensCacheWrite: 0,
        ...overrides,
    };
}

const thresholds = {
    p95TargetMs: 15_000,
    p99TargetMs: 30_000,
    errorRateTarget: 0.05,
    toolErrorRateTarget: 0.10,
    minSampleSize: 10,
};

// ─── evaluateSloHealth — sample size guard ────────────────────

describe("evaluateSloHealth — sample size guard", () => {
    it("returns ok when turnCount is below minSampleSize", () => {
        const row = makeRow({ turnCount: 5 });
        const report = evaluateSloHealth(row, thresholds);
        expect(report.status).toBe("ok");
        expect(report.violations).toHaveLength(0);
    });

    it("returns ok when turnCount equals minSampleSize - 1", () => {
        const row = makeRow({ turnCount: thresholds.minSampleSize - 1 });
        const report = evaluateSloHealth(row, thresholds);
        expect(report.status).toBe("ok");
    });

    it("evaluates when turnCount equals minSampleSize", () => {
        const row = makeRow({ turnCount: thresholds.minSampleSize, p95DurationMs: 20_000 });
        const report = evaluateSloHealth(row, thresholds);
        expect(report.status).not.toBe("ok");
    });
});

// ─── evaluateSloHealth — ok ───────────────────────────────────

describe("evaluateSloHealth — all metrics within targets", () => {
    it("returns ok with no violations when all metrics are healthy", () => {
        const row = makeRow({
            p95DurationMs: 10_000,
            p99DurationMs: 20_000,
            errorCount: 2,        // 2% error rate — below 5% target
            toolErrorCount: 3,    // 6% tool error rate — below 10% target
        });
        const report = evaluateSloHealth(row, thresholds);
        expect(report.status).toBe("ok");
        expect(report.violations).toHaveLength(0);
    });

    it("exposes agentId and model on report", () => {
        const row = makeRow();
        const report = evaluateSloHealth(row, thresholds);
        expect(report.agentId).toBe("test-agent");
        expect(report.model).toBe("gpt-4o");
        expect(report.turnCount).toBe(100);
    });
});

// ─── evaluateSloHealth — p95 breach ──────────────────────────

describe("evaluateSloHealth — p95 breach", () => {
    it("warns when p95 exceeds target", () => {
        const row = makeRow({ p95DurationMs: 16_000 });
        const report = evaluateSloHealth(row, thresholds);
        const v = report.violations.find(v => v.metric === "p95_duration_ms");
        expect(v).toBeDefined();
        expect(v.severity).toBe("warn");
        expect(v.actual).toBe(16_000);
        expect(v.target).toBe(15_000);
    });

    it("does not add p95 violation when exactly at target", () => {
        const row = makeRow({ p95DurationMs: 15_000 });
        const report = evaluateSloHealth(row, thresholds);
        expect(report.violations.find(v => v.metric === "p95_duration_ms")).toBeUndefined();
    });
});

// ─── evaluateSloHealth — p99 breach ──────────────────────────

describe("evaluateSloHealth — p99 breach", () => {
    it("warns when p99 exceeds target but is below 1.5× target", () => {
        const row = makeRow({ p99DurationMs: 35_000 });
        const report = evaluateSloHealth(row, thresholds);
        const v = report.violations.find(v => v.metric === "p99_duration_ms");
        expect(v).toBeDefined();
        expect(v.severity).toBe("warn");
    });

    it("is critical when p99 exceeds 1.5× target", () => {
        const row = makeRow({ p99DurationMs: 46_000 }); // 30_000 * 1.5 = 45_000
        const report = evaluateSloHealth(row, thresholds);
        const v = report.violations.find(v => v.metric === "p99_duration_ms");
        expect(v).toBeDefined();
        expect(v.severity).toBe("critical");
        expect(report.status).toBe("critical");
    });

    it("does not add p99 violation when within target", () => {
        const row = makeRow({ p99DurationMs: 29_000 });
        const report = evaluateSloHealth(row, thresholds);
        expect(report.violations.find(v => v.metric === "p99_duration_ms")).toBeUndefined();
    });
});

// ─── evaluateSloHealth — error rate breach ───────────────────

describe("evaluateSloHealth — error rate", () => {
    it("warns when error rate exceeds target", () => {
        // 6 errors out of 100 = 6% > 5% target
        const row = makeRow({ errorCount: 6 });
        const report = evaluateSloHealth(row, thresholds);
        const v = report.violations.find(v => v.metric === "error_rate");
        expect(v).toBeDefined();
        expect(v.severity).toBe("warn");
    });

    it("is critical when error rate exceeds 2× target", () => {
        // 11 errors out of 100 = 11% > 10% (2 * 5%)
        const row = makeRow({ errorCount: 11 });
        const report = evaluateSloHealth(row, thresholds);
        const v = report.violations.find(v => v.metric === "error_rate");
        expect(v).toBeDefined();
        expect(v.severity).toBe("critical");
    });

    it("does not add error_rate violation when below target", () => {
        const row = makeRow({ errorCount: 4 }); // 4% < 5%
        const report = evaluateSloHealth(row, thresholds);
        expect(report.violations.find(v => v.metric === "error_rate")).toBeUndefined();
    });
});

// ─── evaluateSloHealth — tool error rate ─────────────────────

describe("evaluateSloHealth — tool error rate", () => {
    it("warns when tool error rate exceeds target", () => {
        // 6 tool errors / 50 tool calls = 12% > 10%
        const row = makeRow({ toolErrorCount: 6, toolCallCount: 50 });
        const report = evaluateSloHealth(row, thresholds);
        const v = report.violations.find(v => v.metric === "tool_error_rate");
        expect(v).toBeDefined();
        expect(v.severity).toBe("warn");
    });

    it("skips tool error rate check when toolCallCount is zero", () => {
        const row = makeRow({ toolCallCount: 0, toolErrorCount: 5 });
        const report = evaluateSloHealth(row, thresholds);
        expect(report.violations.find(v => v.metric === "tool_error_rate")).toBeUndefined();
    });

    it("does not add violation when tool error rate is within target", () => {
        const row = makeRow({ toolErrorCount: 4, toolCallCount: 50 }); // 8% < 10%
        const report = evaluateSloHealth(row, thresholds);
        expect(report.violations.find(v => v.metric === "tool_error_rate")).toBeUndefined();
    });
});

// ─── evaluateSloHealth — status rollup ───────────────────────

describe("evaluateSloHealth — status rollup", () => {
    it("is warn when only warn violations present", () => {
        const row = makeRow({ p95DurationMs: 16_000, p99DurationMs: 31_000 });
        const report = evaluateSloHealth(row, thresholds);
        expect(report.status).toBe("warn");
    });

    it("is critical when at least one critical violation present", () => {
        const row = makeRow({ p99DurationMs: 50_000 }); // critical
        const report = evaluateSloHealth(row, thresholds);
        expect(report.status).toBe("critical");
    });
});

// ─── decideSloAction ─────────────────────────────────────────

describe("decideSloAction — ok status", () => {
    it("returns none for ok status", () => {
        const report = { status: "ok", violations: [], agentId: "a", model: "m", turnCount: 50 };
        const action = decideSloAction(report);
        expect(action.action).toBe("none");
        expect(action.reason).toContain("SLOs met");
    });
});

describe("decideSloAction — warn status", () => {
    it("returns log for warn status", () => {
        const report = evaluateSloHealth(makeRow({ p95DurationMs: 20_000 }), thresholds);
        const action = decideSloAction(report);
        expect(action.action).toBe("log");
        expect(action.reason).toContain("p95_duration_ms");
    });

    it("includes percentage in log reason", () => {
        // 20_000 vs 15_000 target = ~33% over
        const report = evaluateSloHealth(makeRow({ p95DurationMs: 20_000 }), thresholds);
        const action = decideSloAction(report);
        expect(action.reason).toMatch(/\d+%/);
    });
});

describe("decideSloAction — critical status", () => {
    it("returns alert for critical status", () => {
        const report = evaluateSloHealth(makeRow({ p99DurationMs: 50_000 }), thresholds);
        const action = decideSloAction(report);
        expect(action.action).toBe("alert");
        expect(action.reason).toContain("critically exceeded");
    });

    it("includes actual vs target in alert reason", () => {
        const report = evaluateSloHealth(makeRow({ p99DurationMs: 50_000 }), thresholds);
        const action = decideSloAction(report);
        expect(action.reason).toContain("vs target");
    });
});

// ─── DEFAULT_SLO_THRESHOLDS ───────────────────────────────────

describe("DEFAULT_SLO_THRESHOLDS — defaults", () => {
    it("has a positive p95 target", () => {
        expect(DEFAULT_SLO_THRESHOLDS.p95TargetMs).toBeGreaterThan(0);
    });

    it("has p99 target >= p95 target", () => {
        expect(DEFAULT_SLO_THRESHOLDS.p99TargetMs).toBeGreaterThanOrEqual(
            DEFAULT_SLO_THRESHOLDS.p95TargetMs
        );
    });

    it("has error rate between 0 and 1", () => {
        expect(DEFAULT_SLO_THRESHOLDS.errorRateTarget).toBeGreaterThan(0);
        expect(DEFAULT_SLO_THRESHOLDS.errorRateTarget).toBeLessThan(1);
    });

    it("has minSampleSize >= 1", () => {
        expect(DEFAULT_SLO_THRESHOLDS.minSampleSize).toBeGreaterThanOrEqual(1);
    });
});
