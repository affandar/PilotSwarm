import { describe, it } from "vitest";
import {
    computeContextPercent,
    formatTokenCount,
    getContextHeaderBadge,
    getContextListBadge,
    getContextCompactionBadge,
    formatCompactionActivityRuns,
} from "../../../ui-core/src/context-usage.js";
import { assert, assertEqual, assertIncludes } from "../helpers/assertions.js";

describe("context usage UI helpers", () => {
    it("computes percentages from either utilization or raw token counts", () => {
        assertEqual(computeContextPercent({ utilization: 0.42 }), 42, "utilization ratio");
        assertEqual(computeContextPercent({ currentTokens: 64000, tokenLimit: 128000 }), 50, "raw token counts");
        assertEqual(computeContextPercent(null), null, "missing usage");
    });

    it("formats compact token counts for header and activity displays", () => {
        assertEqual(formatTokenCount(999), "999");
        assertEqual(formatTokenCount(12345), "12.3k");
        assertEqual(formatTokenCount(2500000), "2.5m");
    });

    it("formats header and session-list badges with threshold colors", () => {
        const low = { currentTokens: 12000, tokenLimit: 128000, utilization: 12000 / 128000 };
        const warning = { currentTokens: 95000, tokenLimit: 128000, utilization: 95000 / 128000 };
        const danger = { currentTokens: 116000, tokenLimit: 128000, utilization: 116000 / 128000 };

        assertEqual(getContextHeaderBadge(low)?.text, "ctx 12k/128k 9%", "header should show a compact meter");
        assertEqual(getContextHeaderBadge(warning)?.color, "yellow", "warning header badge should be yellow");
        assertEqual(getContextHeaderBadge(danger)?.color, "red", "danger header badge should be red");

        assertEqual(getContextListBadge(low), null, "low usage should not clutter the session list");
        assertEqual(getContextListBadge(warning)?.text, "[ctx 74%]", "warning usage should show a list badge");
        assertEqual(getContextListBadge(danger)?.color, "red", "danger usage should show a red list badge");
    });

    it("prioritizes compaction badges over percentage badges", () => {
        const compacting = { currentTokens: 90000, tokenLimit: 128000, compaction: { state: "running" } };
        const failed = { currentTokens: 90000, tokenLimit: 128000, compaction: { state: "failed" } };

        assertEqual(getContextListBadge(compacting)?.text, "[compact]");
        assertEqual(getContextCompactionBadge(compacting)?.text, "[compacting]");
        assertEqual(getContextListBadge(failed)?.text, "[compact !]");
        assertEqual(getContextCompactionBadge(failed)?.text, "[compact failed]");
    });

    it("formats compaction activity lines for start, success, and failure", () => {
        const started = formatCompactionActivityRuns("12:34:56", "session.compaction_start", {});
        const completed = formatCompactionActivityRuns("12:34:56", "session.compaction_complete", { success: true, tokensRemoved: 12345 });
        const failed = formatCompactionActivityRuns("12:34:56", "session.compaction_complete", { success: false, error: "boom" });

        const flatten = (runs) => (runs || []).map((run) => run?.text || "").join("");
        assertIncludes(flatten(started), "[compaction]", "start line should mention compaction");
        assertIncludes(flatten(completed), "freed 12.3k", "success line should report tokens removed");
        assertIncludes(flatten(failed), "failed: boom", "failed line should include the error");
        assert(completed.some((run) => run.color === "magenta") && failed.some((run) => run.color === "red"), "success and failure lines should be color-coded");
    });
});
