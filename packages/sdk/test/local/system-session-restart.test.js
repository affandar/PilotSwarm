import { describe, it } from "vitest";
import { PilotSwarmManagementClient } from "../../src/management-client.js";
import { systemAgentUUID } from "../../src/agent-loader.js";
import { assert, assertEqual, assertIncludes } from "../helpers/assertions.js";

function makeRow(sessionId, overrides = {}) {
    return {
        sessionId,
        orchestrationId: `session-${sessionId}`,
        title: "Restartable Agent",
        titleLocked: false,
        state: "running",
        model: "test:model",
        reasoningEffort: null,
        createdAt: new Date(1_000),
        updatedAt: new Date(1_000),
        lastActiveAt: new Date(1_000),
        deletedAt: null,
        currentIteration: 0,
        lastError: null,
        waitReason: null,
        parentSessionId: null,
        isSystem: true,
        agentId: "restartable",
        splash: null,
        groupId: null,
        shortSummary: null,
        summaryState: null,
        summaryUpdatedAt: null,
        owner: null,
        ...overrides,
    };
}

function createRestartHarness() {
    const agent = {
        name: "restartable",
        id: "restartable",
        title: "Restartable Agent",
        system: true,
        prompt: "You are restartable.",
        initialPrompt: "Bootstrap now.",
        tools: ["read_facts"],
        namespace: "test-app",
        promptLayerKind: "app-system-agent",
    };
    const sessionId = systemAgentUUID(agent.id);
    const rows = new Map([[sessionId, makeRow(sessionId)]]);
    const calls = [];

    const catalog = {
        async getSession(id) {
            const row = rows.get(id);
            return row && !row.deletedAt ? row : null;
        },
        async createSession(id, opts = {}) {
            const previous = rows.get(id) || makeRow(id);
            rows.set(id, {
                ...previous,
                ...opts,
                sessionId: id,
                state: "pending",
                deletedAt: null,
                isSystem: opts.isSystem ?? previous.isSystem,
                agentId: opts.agentId ?? previous.agentId,
                model: opts.model ?? previous.model,
                splash: opts.splash ?? previous.splash,
                parentSessionId: opts.parentSessionId ?? previous.parentSessionId,
                createdAt: previous.createdAt || new Date(1_000),
                updatedAt: new Date(2_000),
            });
            calls.push({ type: "createSession", id, opts });
        },
        async updateSession(id, updates = {}) {
            const previous = rows.get(id) || makeRow(id);
            rows.set(id, {
                ...previous,
                ...updates,
                updatedAt: new Date(3_000),
            });
            calls.push({ type: "updateSession", id, updates });
        },
        async archiveSystemSessionForRestart(id, state, lastError) {
            const row = rows.get(id);
            if (row && !row.isSystem) throw new Error("Cannot archive non-system session for system restart");
            rows.set(id, {
                ...row,
                state,
                lastError,
                orchestrationId: null,
                currentIteration: 0,
                deletedAt: new Date(4_000),
                updatedAt: new Date(4_000),
            });
            calls.push({ type: "archiveSystemSessionForRestart", id, state, lastError });
        },
    };

    const duroxide = {
        async getInstanceInfo() {
            return { status: "Running", orchestrationVersion: "1.0.test" };
        },
        async getStatus() {
            return { status: "Running", customStatus: JSON.stringify({ status: rows.get(sessionId)?.state || "running" }), customStatusVersion: 1 };
        },
        async enqueueEvent(orchId, name, body) {
            calls.push({ type: "enqueueEvent", orchId, name, body: JSON.parse(body) });
        },
        async cancelInstance(orchId, reason) {
            calls.push({ type: "cancelInstance", orchId, reason });
        },
        async deleteInstance(orchId, recursive) {
            calls.push({ type: "deleteInstance", orchId, recursive });
        },
        async startOrchestrationVersioned(orchId, name, input, version) {
            calls.push({ type: "startOrchestrationVersioned", orchId, name, input, version });
        },
    };

    const facts = {
        async deleteSessionFactsForSession(id) {
            calls.push({ type: "deleteSessionFactsForSession", id });
        },
    };

    const mgmt = new PilotSwarmManagementClient({ store: "postgres://unused", systemAgents: [agent] });
    mgmt._started = true;
    mgmt._catalog = catalog;
    mgmt._duroxideClient = duroxide;
    mgmt._factStore = facts;
    mgmt._modelProviders = { defaultModel: "test:model" };
    mgmt._systemAgents = [agent];

    return { mgmt, rows, calls, agent, sessionId };
}

function callTypes(calls) {
    return calls.map((call) => call.type);
}

describe("system session restart management", () => {
    it("hard-deletes a system session through the privileged restart path and recreates it", async () => {
        const { mgmt, rows, calls, sessionId } = createRestartHarness();

        const result = await mgmt.restartSystemSession("restartable", {
            disposition: "hard_delete",
            reason: "test reset",
        });

        assertEqual(result.sessionId, sessionId, "restart result should identify the deterministic system session");
        assertEqual(result.disposition, "hard_delete", "restart result disposition");
        assertEqual(rows.get(sessionId).isSystem, true, "replacement row should be a system session again");
        assertEqual(rows.get(sessionId).state, "running", "replacement row should be running");
        assert(callTypes(calls).includes("archiveSystemSessionForRestart"), "restart should archive the previous CMS row");
        assert(callTypes(calls).includes("deleteSessionFactsForSession"), "restart should clear session-scoped facts");
        const startCall = calls.find((call) => call.type === "startOrchestrationVersioned");
        assert(startCall, "restart should start a new orchestration");
        assertEqual(startCall.input.prompt, "Bootstrap now.", "replacement should use the system agent initial prompt");
        assertEqual(startCall.input.isSystem, true, "replacement orchestration input should be marked system");
    });

    it("terminates before restarting when requested", async () => {
        const { mgmt, calls } = createRestartHarness();

        await mgmt.restartSystemSession("restartable", {
            disposition: "terminate",
            reason: "operator requested",
        });

        const cancelCall = calls.find((call) => call.type === "cancelInstance");
        assert(cancelCall, "terminate disposition should cancel the existing orchestration");
        assertIncludes(cancelCall.reason, "operator requested", "terminate reason should be forwarded");
        assert(callTypes(calls).includes("startOrchestrationVersioned"), "terminate disposition should start a replacement");
    });

    it("marks complete before restarting when requested", async () => {
        const { mgmt, rows, calls, sessionId } = createRestartHarness();
        mgmt.sendCommand = async (id, command) => {
            calls.push({ type: "sendCommand", id, command });
            rows.set(id, { ...rows.get(id), state: "completed" });
        };

        await mgmt.restartSystemSession(sessionId, {
            disposition: "complete",
            reason: "finished current maintenance cycle",
        });

        const commandCall = calls.find((call) => call.type === "sendCommand");
        assert(commandCall, "complete disposition should send a done command first");
        assertEqual(commandCall.command.cmd, "done", "complete disposition command");
        assert(callTypes(calls).includes("startOrchestrationVersioned"), "complete disposition should start a replacement");
        assert(!callTypes(calls).includes("cancelInstance"), "complete disposition should not force-cancel first");
    });
});
