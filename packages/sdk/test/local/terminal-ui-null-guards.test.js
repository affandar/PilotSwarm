import { describe, it } from "vitest";
import {
    tokenizeInlineMarkdown,
    parseTerminalMarkupRuns,
    shortSessionId,
    stripTerminalMarkupTags,
} from "../../../ui-core/src/formatting.js";
import { assertEqual } from "../helpers/assertions.js";

describe("terminal UI null guards", () => {
    it("coerces nullable ids and markup text safely", () => {
        assertEqual(shortSessionId(null), "", "shortSessionId should not throw on null ids");
        assertEqual(shortSessionId("session-12345678-1234"), "session-", "shortSessionId should preserve current truncation semantics");
        assertEqual(stripTerminalMarkupTags(null), "", "terminal markup stripping should not throw on null");

        const parsed = parseTerminalMarkupRuns(null);
        assertEqual(Array.isArray(parsed), true, "terminal markup parsing should return lines");
        assertEqual(Array.isArray(parsed[0]), true, "terminal markup parsing should return run arrays");
        assertEqual(parsed[0][0]?.text || "", "", "empty input should yield an empty text run");
    });

    it("parses terminal markup into neutral run arrays", () => {
        const parsed = parseTerminalMarkupRuns("{cyan-fg}hello{/cyan-fg}");
        assertEqual(parsed[0][0]?.text, "hello", "terminal markup should keep the text payload");
        assertEqual(parsed[0][0]?.color, "cyan", "terminal markup should preserve the foreground color");
    });

    it("does not strip underscores from bare URLs while tokenizing inline markdown", () => {
        const tokens = tokenizeInlineMarkdown("See https://example.com/releases/train_payload_v2/report_file.md for details");
        assertEqual(tokens.length, 3, "bare URLs should split into text, link, and trailing text tokens");
        assertEqual(tokens[0]?.text, "See ", "leading text should stay intact before the bare URL token");
        assertEqual(tokens[1]?.type, "link", "bare URLs should tokenize as links");
        assertEqual(tokens[1]?.href, "https://example.com/releases/train_payload_v2/report_file.md", "bare URL href should preserve underscores");
        assertEqual(tokens[2]?.text, " for details", "trailing text should stay intact after the bare URL token");
    });
});
