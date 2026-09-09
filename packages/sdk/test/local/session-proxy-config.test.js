import { handleSubAgentAction } from "../../src/orchestration/agents.ts";
import { handleSubAgentAction as frozenSpawn } from "../../src/orchestration_1_0_72/agents.ts";
import { describe, expect, it, vi } from "vitest";
import { PilotSwarmClient } from "../../src/client.ts";
import { bootstrapTurnOptions, buildRunTurnConfig, childModelCreationOptions } from "../../src/session-proxy.ts";
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

    it("forwards a named agent's initial required tool only on its bootstrap send", () => {
        expect(bootstrapTurnOptions("package_catalog")).toEqual({
            bootstrap: true,
            requiredTool: "package_catalog",
        });
        expect(bootstrapTurnOptions()).toEqual({ bootstrap: true });
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

        // Structural, not reference, equality: since 0.5.56 the start config
        // is projected through a JSON round-trip (undefined-stripping merge
        // with the durable creation config), so the input carries a
        // deep-equal CLONE. Reference identity never survived the durable
        // boundary anyway — duroxide serializes the input to JSON.
        assertEqual(
            JSON.stringify(orchestrationInput?.config?.childContract),
            JSON.stringify(childContract),
            "child contract should reach the durable orchestration input",
        );
    });
});

// Inspect the durable activity payload: it is the boundary serialized for replay.
describe("spawn context override and replay", () => {
    function payload(handler, override) {
        const config = { model: "parent:model", contextTier: "long_context", reasoningEffort: "high" };
        const spawnChildSession = vi.fn(() => ({ activity: "spawnChildSession" }));
        handler({ ctx: { traceInfo() {} }, state: { config, subAgents: [] },
            options: { nestingLevel: 0 }, input: { sessionId: "parent" },
            manager: { spawnChildSession } }, { type: "spawn_agent", task: "Review", model: "review:model", ...override }).next();
        expect(config.contextTier).toBe("long_context");
        return spawnChildSession.mock.calls[0];
    }
    it("overrides inherited long context for a default-only review model", () => {
        expect(payload(handleSubAgentAction, { contextTier: "default" })[1]).toMatchObject({
            model: "review:model", contextTier: "default", reasoningEffort: "high",
        });
    });
    it("preserves the frozen activity payload when no context override is supplied", () => {
        expect(JSON.stringify(payload(handleSubAgentAction, {}))).toBe(JSON.stringify(payload(frozenSpawn, {})));
        expect(payload(handleSubAgentAction, {})[1].contextTier).toBe("long_context");
    });
});
