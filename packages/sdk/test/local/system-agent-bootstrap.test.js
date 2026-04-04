import { describe, it } from "vitest";
import { buildSystemAgentBootstrapPayload, PilotSwarmWorker } from "../../src/worker.ts";
import { assertEqual } from "../helpers/assertions.js";

describe("System agent bootstrap payload", () => {
    it("forwards agent identity into both config and orchestration input", () => {
        const agent = {
            id: "facts-manager",
            name: "facts-manager",
            namespace: "mgmt",
            tools: ["store_fact", "read_facts", "delete_fact"],
            system: true,
            parent: "pilotswarm",
        };

        const { serializableConfig, input } = buildSystemAgentBootstrapPayload(agent, "azure-openai:gpt-5.4-mini", {
            sessionId: "session-fm",
            parentSessionId: "session-parent",
            blobEnabled: true,
            dehydrateThreshold: 30,
        });

        assertEqual(serializableConfig.agentIdentity, "facts-manager", "config should carry agent identity");
        assertEqual(input.agentId, "facts-manager", "orchestration input should carry agent id");
        assertEqual(input.config.agentIdentity, "facts-manager", "embedded config should carry agent identity");
        assertEqual(input.parentSessionId, "session-parent", "child parentSessionId should be preserved");
        assertEqual(input.isSystem, true, "system bootstrap input should mark system sessions");
    });

    it("defaults workers to a local durable session store", () => {
        const worker = new PilotSwarmWorker({
            store: "sqlite::memory:",
            disableManagementAgents: true,
        });

        assertEqual(worker.blobEnabled, true, "workers should default to durable local session state");
    });
});
