import { describe, it } from "vitest";
import { PilotSwarmClient } from "../../src/client.ts";
import { buildRunTurnConfig, childModelCreationOptions } from "../../src/session-proxy.ts";
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

    it("forwards model, reasoning effort, and context tier to child creation", () => {
        const childContract = { wakeOn: "completion" };
        const options = childModelCreationOptions({
            model: "github-copilot:gpt-5.6-terra",
            reasoningEffort: "xhigh",
            contextTier: "long_context",
            childContract,
        });

        assertEqual(options.model, "github-copilot:gpt-5.6-terra", "child model should inherit");
        assertEqual(options.reasoningEffort, "xhigh", "child reasoning effort should inherit");
        assertEqual(options.contextTier, "long_context", "child context tier should inherit");
        assertEqual(options.childContract, childContract, "child contract should inherit");
    });

    it("preserves the child wake contract in orchestration input", async () => {
        const childContract = {
            purpose: "Resolve customer anchors",
            wakeOn: "completion",
        };
        let orchestrationInput;
        const client = new PilotSwarmClient({});
        client._catalog = {
            async createSession() {},
            async getSession() { return { state: "pending" }; },
            async updateSession() {},
        };
        client.duroxideClient = {
            async startOrchestrationVersioned(_id, _name, input) {
                orchestrationInput = input;
            },
            async enqueueEvent() {},
        };

        const session = await client.createSession({
            sessionId: "child-contract-session",
            parentSessionId: "parent-session",
            childContract,
        });
        await session.send("Resolve the anchors", { bootstrap: true });

        assertEqual(
            orchestrationInput?.config?.childContract,
            childContract,
            "child contract should reach the durable orchestration input",
        );
    });
});
