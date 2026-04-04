import { describe, it } from "vitest";
import { buildRunTurnConfig } from "../../src/session-proxy.ts";
import { assertEqual, assertIncludes } from "../helpers/assertions.js";

describe("runTurn config backfill", () => {
    it("backfills missing agentIdentity from catalog metadata", () => {
        const config = buildRunTurnConfig(
            {
                model: "azure-openai:gpt-5.4-mini",
                boundAgentName: "facts-manager",
            },
            "host-a",
            "facts-manager",
        );

        assertEqual(config.agentIdentity, "facts-manager", "missing agent identity should be backfilled");
        assertIncludes(String(config.turnSystemPrompt), 'Running on host "host-a".', "host context should still be appended");
    });

    it("preserves explicit agentIdentity", () => {
        const config = buildRunTurnConfig(
            {
                model: "azure-openai:gpt-5.4-mini",
                boundAgentName: "facts-manager",
                agentIdentity: "facts-manager",
            },
            "host-b",
            "wrong-fallback",
        );

        assertEqual(config.agentIdentity, "facts-manager", "explicit identity should win over fallback");
    });
});
