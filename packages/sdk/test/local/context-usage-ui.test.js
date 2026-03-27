import { describe, it } from "vitest";
import {
    computeContextPercent,
    formatTokenCount,
    formatContextHeaderBadge,
    formatContextListBadge,
    formatContextCompactionBadge,
    formatCompactionActivityMarkup,
} from "../../../cli/cli/context-usage.js";
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

        assertIncludes(formatContextHeaderBadge(low), "ctx 12k/128k 9%", "header should show a compact meter");
        assertIncludes(formatContextHeaderBadge(warning), "{yellow-fg}", "warning header badge should be yellow");
        assertIncludes(formatContextHeaderBadge(danger), "{red-fg}", "danger header badge should be red");

        assertEqual(formatContextListBadge(low), "", "low usage should not clutter the session list");
        assertIncludes(formatContextListBadge(warning), "[ctx 74%]", "warning usage should show a list badge");
        assertIncludes(formatContextListBadge(danger), "{red-fg}", "danger usage should show a red list badge");
    });

    it("prioritizes compaction badges over percentage badges", () => {
        const compacting = { currentTokens: 90000, tokenLimit: 128000, compaction: { state: "running" } };
        const failed = { currentTokens: 90000, tokenLimit: 128000, compaction: { state: "failed" } };

        assertEqual(formatContextListBadge(compacting), " {magenta-fg}[compact]{/magenta-fg}");
        assertEqual(formatContextCompactionBadge(compacting), " {magenta-fg}[compacting]{/magenta-fg}");
        assertEqual(formatContextListBadge(failed), " {red-fg}[compact !]{/red-fg}");
        assertEqual(formatContextCompactionBadge(failed), " {red-fg}[compact failed]{/red-fg}");
    });

    it("formats compaction activity lines for start, success, and failure", () => {
        const started = formatCompactionActivityMarkup("12:34:56", "session.compaction_start", {});
        const completed = formatCompactionActivityMarkup("12:34:56", "session.compaction_complete", { success: true, tokensRemoved: 12345 });
        const failed = formatCompactionActivityMarkup("12:34:56", "session.compaction_complete", { success: false, error: "boom" });

        assertIncludes(started, "[compaction]", "start line should mention compaction");
        assertIncludes(completed, "freed 12.3k", "success line should report tokens removed");
        assertIncludes(failed, "failed: boom", "failed line should include the error");
        assert(completed.includes("{magenta-fg}") && failed.includes("{red-fg}"), "success and failure lines should be color-coded");
    });
});
