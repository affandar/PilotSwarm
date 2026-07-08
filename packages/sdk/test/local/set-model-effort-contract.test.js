/**
 * setSessionModel reasoning-effort contract (source-level, in the style of
 * lossy-handoff-observability.test.js).
 *
 * A model switch WITHOUT an explicit reasoning effort must PRESERVE the
 * session's current effort. The orchestration's set_model handler already
 * treats an absent args.reasoningEffort as "keep old"; the regression was
 * management-client injecting the model descriptor's defaultReasoningEffort
 * whenever the caller omitted the option (observed live: switching a session
 * back to azure-openai:gpt-5.4 silently flipped its effort to xhigh).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "vitest";
import { assert, assertIncludes } from "../helpers/assertions.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = fs.readFileSync(
    path.resolve(__dirname, "../../src/management-client.ts"),
    "utf8",
);

describe("setSessionModel reasoning-effort contract", () => {
    it("only sends reasoningEffort when the caller explicitly provided one", () => {
        assertIncludes(
            SRC,
            'const hasExplicitEffort = !!opts && "reasoningEffort" in opts;',
            "setSessionModel must gate effort on an explicit caller option",
        );
        assertIncludes(
            SRC,
            "...(hasExplicitEffort ? { reasoningEffort: nextReasoningEffort } : {})",
            "the set_model args must omit reasoningEffort entirely when not explicitly provided (absent key = preserve current)",
        );
    });

    it("never falls back to the model descriptor's default effort on switch", () => {
        // The regression pattern: `: (match.defaultReasoningEffort ?? null)`
        // as the else-branch of the effort resolution inside setSessionModel.
        const setModelBlock = SRC.slice(
            SRC.indexOf("async setSessionModel("),
            SRC.indexOf("async setSessionModel(") + 2500,
        );
        assert(
            !setModelBlock.includes("match.defaultReasoningEffort"),
            "setSessionModel must not inject the descriptor's defaultReasoningEffort when the caller omitted effort",
        );
    });
});
