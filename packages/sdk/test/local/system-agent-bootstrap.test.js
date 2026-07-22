import { describe, it } from "vitest";
import {
    buildSystemAgentBootstrapPayload,
    PilotSwarmWorker,
    resolveWorkerTurnTimeoutMs,
} from "../../src/worker.ts";
import { DEFAULT_TURN_TIMEOUT_MS } from "../../src/managed-session.ts";
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

    it("resolves the deployment turn timeout with explicit option precedence", () => {
        assertEqual(DEFAULT_TURN_TIMEOUT_MS, 20 * 60_000, "SDK turn timeout should default to 20 minutes");
        assertEqual(resolveWorkerTurnTimeoutMs(undefined, "1200000"), 1_200_000, "deployment env should configure the timeout");
        assertEqual(resolveWorkerTurnTimeoutMs(900_000, "1200000"), 900_000, "explicit worker option should win");
        assertEqual(resolveWorkerTurnTimeoutMs(undefined, "0"), 0, "deployment env should support disabling the cap");
        assertEqual(resolveWorkerTurnTimeoutMs(undefined, "invalid"), DEFAULT_TURN_TIMEOUT_MS, "invalid env should use the SDK default");
    });
});
