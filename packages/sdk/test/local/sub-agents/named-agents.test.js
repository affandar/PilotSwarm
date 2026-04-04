/**
 * Named agent resolution tests.
 *
 * Verifies that:
 * - user-creatable named agents resolve as creatable
 * - worker-managed system agents resolve as non-creatable
 * - system agent metadata is still available for diagnostics/rejection paths
 *
 * Run: npx vitest run test/local/sub-agents/named-agents.test.js
 */

import { describe, expect, it } from "vitest";
import { registerActivities } from "../../../src/session-proxy.ts";

function makeResolveHarness() {
    const handlers = {};
    const runtime = {
        registerActivity(name, handler) {
            handlers[name] = handler;
        },
    };

    const sessionManager = {
        getModelSummary: () => undefined,
    };

    registerActivities(
        runtime,
        sessionManager,
        null,
        undefined,
        null,
        undefined,
        undefined,
        undefined,
        undefined,
        [
            {
                name: "sweeper",
                description: "Worker-managed maintenance agent",
                prompt: "You are sweeper.",
                tools: ["scancompletedsessions"],
                system: true,
                id: "sweeper",
                title: "Sweeper Agent",
                parent: "pilotswarm",
                namespace: "pilotswarm",
                promptLayerKind: "pilotswarm-system-agent",
            },
        ],
        null,
        [],
        [
            {
                name: "alpha",
                description: "User-creatable test agent",
                prompt: "You are alpha.",
                tools: ["bash"],
                namespace: "testapp",
                title: "Alpha Agent",
                promptLayerKind: "app-agent",
            },
        ],
        undefined,
        "worker-1",
    );

    return {
        resolveAgentConfig: handlers.resolveAgentConfig,
    };
}

describe("Sub-Agent: Named agent resolution", () => {
    it("marks worker-managed system agents as non-creatable", async () => {
        const { resolveAgentConfig } = makeResolveHarness();

        const agent = await resolveAgentConfig({}, { agentName: "sweeper" });

        expect(agent).not.toBeNull();
        expect(agent.name).toBe("sweeper");
        expect(agent.system).toBe(true);
        expect(agent.creatable).toBe(false);
        expect(agent.parent).toBe("pilotswarm");
        expect(agent.title).toBe("Sweeper Agent");
    });

    it("keeps user agents creatable", async () => {
        const { resolveAgentConfig } = makeResolveHarness();

        const agent = await resolveAgentConfig({}, { agentName: "alpha" });

        expect(agent).not.toBeNull();
        expect(agent.name).toBe("alpha");
        expect(agent.system).toBe(false);
        expect(agent.creatable).toBe(true);
        expect(agent.namespace).toBe("testapp");
    });
});
