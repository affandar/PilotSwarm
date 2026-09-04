import { describe, expect, it } from "vitest";
import {
    buildSystemAgentBootstrapPayload,
    PilotSwarmWorker,
    resolveWorkerTurnTimeoutMs,
} from "../../src/worker.ts";
import { loadSystemAgentConfigs, startSystemAgents } from "../../src/system-agents.ts";
import { DEFAULT_TURN_TIMEOUT_MS } from "../../src/managed-session.ts";
import { assertEqual } from "../helpers/assertions.js";

describe("System agent bootstrap payload", () => {
    it("forwards agent identity into both config and orchestration input", () => {
        const agent = {
            id: "facts-manager",
            name: "facts-manager",
            namespace: "mgmt",
            tools: ["store_fact", "read_facts", "delete_fact"],
            initialRequiredTool: "read_facts",
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
        assertEqual(Object.hasOwn(serializableConfig, "initialRequiredTool"), false, "session config should not duplicate a turn contract");
        assertEqual(input.requiredTool, "read_facts", "bootstrap turn should use the existing requiredTool contract");
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

    it("rejects invalid enforcement metadata from direct agent config", () => {
        const invalid = {
            name: "invalid",
            id: "invalid",
            system: true,
            prompt: "Invalid.",
            schemaVersion: 2,
            tools: ["package_catalog"],
            initialRequiredTool: "package_catalog",
        };

        expect(() => loadSystemAgentConfigs({ disableManagementAgents: true, systemAgents: [invalid] }))
            .toThrow(/initialRequiredTool requires schemaVersion 3/);
        expect(() => new PilotSwarmWorker({
            store: "sqlite::memory:",
            disableManagementAgents: true,
            customAgents: [{ ...invalid, system: false }],
        })).toThrow(/Invalid custom agent/);
    });

    it("resolves the deployment turn timeout with explicit option precedence", () => {
        assertEqual(DEFAULT_TURN_TIMEOUT_MS, 20 * 60_000, "SDK turn timeout should default to 20 minutes");
        assertEqual(resolveWorkerTurnTimeoutMs(undefined, "1200000"), 1_200_000, "deployment env should configure the timeout");
        assertEqual(resolveWorkerTurnTimeoutMs(900_000, "1200000"), 900_000, "explicit worker option should win");
        assertEqual(resolveWorkerTurnTimeoutMs(undefined, "0"), 0, "deployment env should support disabling the cap");
        assertEqual(resolveWorkerTurnTimeoutMs(undefined, "invalid"), DEFAULT_TURN_TIMEOUT_MS, "invalid env should use the SDK default");
    });

    it("repairs a pending CMS row whose orchestration start previously failed", async () => {
        const row = {
            sessionId: "session-pending",
            model: "old:gpt",
            reasoningEffort: "low",
            contextTier: "default",
            state: "pending",
            orchestrationId: null,
        };
        const starts = [];
        const updates = [];
        const results = await startSystemAgents({
            catalog: {
                getSession: async () => row,
                createSession: async () => { throw new Error("must not recreate pending row"); },
                updateSession: async (_sessionId, update) => {
                    updates.push(update);
                    Object.assign(row, update);
                },
            },
            duroxideClient: {
                startOrchestrationVersioned: async (...args) => starts.push(args),
            },
            agents: [{ id: "pending", name: "pending", system: true, prompt: "pending" }],
            defaultModel: "new:gpt",
            defaultReasoningEffort: "high",
            defaultContextTier: "long_context",
            modelResolutionSource: "system_default",
            dehydrateThreshold: 30,
        });
        expect(starts).toHaveLength(1);
        expect(row.model).toBe("new:gpt");
        expect(row.reasoningEffort).toBe("high");
        expect(row.contextTier).toBe("long_context");
        expect(row.modelResolutionSource).toBe("system_default");
        expect(updates.some((update) => update.orchestrationId === starts[0][0])).toBe(true);
        expect(results[0].status).toBe("started");
    });

    it("repairs CMS when retry finds the orchestration already exists", async () => {
        const row = {
            sessionId: "session-pending",
            model: "team:gpt",
            state: "pending",
            orchestrationId: null,
        };
        const updates = [];
        const results = await startSystemAgents({
            catalog: {
                getSession: async () => row,
                createSession: async () => { throw new Error("must not recreate pending row"); },
                updateSession: async (_sessionId, update) => {
                    updates.push(update);
                    Object.assign(row, update);
                },
            },
            duroxideClient: {
                startOrchestrationVersioned: async () => { throw new Error("already exists"); },
            },
            agents: [{ id: "pending", name: "pending", system: true, prompt: "pending" }],
            defaultModel: "team:gpt",
            dehydrateThreshold: 30,
        });
        expect(row.orchestrationId).toBeTruthy();
        expect(row.state).toBe("running");
        expect(updates).toHaveLength(3); // target tuple, title, repaired orchestration state
        expect(results[0].status).toBe("raced");
    });
});
