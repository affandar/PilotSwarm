import { describe, expect, it, vi } from "vitest";
import { ManagedSession } from "../../src/managed-session.ts";

class FakeCopilotSession {
    registeredTools = [];
    listeners = new Map();
    catchAllHandlers = [];
    scriptedToolCalls = [];
    scriptedEvents = [];
    assistantContent = "ok";
    aborted = false;

    on(eventType, handler) {
        if (typeof eventType === "function") {
            this.catchAllHandlers.push(eventType);
            return () => {
                this.catchAllHandlers = this.catchAllHandlers.filter((candidate) => candidate !== eventType);
            };
        }
        const handlers = this.listeners.get(eventType) ?? [];
        handlers.push(handler);
        this.listeners.set(eventType, handlers);
        return () => {
            const current = this.listeners.get(eventType) ?? [];
            this.listeners.set(eventType, current.filter((candidate) => candidate !== handler));
        };
    }

    registerTools(tools) {
        this.registeredTools = tools;
    }

    emit(eventType, payload = {}) {
        for (const handler of this.catchAllHandlers) {
            handler({ type: eventType, data: payload.data ?? payload });
        }
        const handlers = this.listeners.get(eventType) ?? [];
        for (const handler of handlers) {
            handler(payload);
        }
    }

    async send() {
        this.aborted = false;
        queueMicrotask(async () => {
            for (const call of this.scriptedToolCalls) {
                if (this.aborted) break;
                const tool = this.registeredTools.find((candidate) => candidate.name === call.name);
                if (!tool) throw new Error(`Missing fake tool: ${call.name}`);
                await tool.handler(call.args ?? {});
            }
            if (!this.aborted && this.assistantContent != null) {
                this.emit("assistant.message", { data: { content: this.assistantContent } });
            }
            for (const event of this.scriptedEvents) {
                this.emit(event.type, { data: event.data ?? {} });
            }
            this.emit("session.idle", { data: {} });
        });
    }

    abort() {
        this.aborted = true;
    }
}

describe("inline control tool execution", () => {
    it("keeps spawn_agent inline when a control bridge is provided", async () => {
        const fakeSession = new FakeCopilotSession();
        fakeSession.scriptedToolCalls = [
            { name: "spawn_agent", args: { task: "say hi" } },
        ];
        fakeSession.assistantContent = "Spawned one and continuing.";

        const controlToolBridge = {
            spawnAgent: vi.fn(async () => "[SYSTEM: spawned]"),
            messageAgent: vi.fn(),
            checkAgents: vi.fn(),
            resolveWaitForAgents: vi.fn(),
            listSessions: vi.fn(),
            completeAgent: vi.fn(),
            cancelAgent: vi.fn(),
            deleteAgent: vi.fn(),
        };

        const managed = new ManagedSession("inline-spawn", fakeSession, {});
        const result = await managed.runTurn("spawn a child", { controlToolBridge });

        expect(controlToolBridge.spawnAgent).toHaveBeenCalledTimes(1);
        expect(fakeSession.aborted).toBe(false);
        expect(result.type).toBe("completed");
        expect(result.content).toBe("Spawned one and continuing.");
    });
    it("keeps sub-agent stub schemas aligned with live schemas", () => {
        const spawnTool = ManagedSession.subAgentToolDefs().find((tool) => tool.name === "spawn_agent");
        const completeTool = ManagedSession.subAgentToolDefs().find((tool) => tool.name === "complete_agent");
        const cancelTool = ManagedSession.subAgentToolDefs().find((tool) => tool.name === "cancel_agent");

        expect(spawnTool?.parameters?.properties?.title?.type).toBe("string");
        expect(spawnTool?.parameters?.properties?.contract?.type).toBe("object");
        expect(spawnTool?.parameters?.properties?.contract?.description).toContain("no separate contract tool exists");
        expect(completeTool?.parameters?.properties?.result?.type).toBe("object");
        expect(cancelTool?.parameters?.properties?.partial_result?.type).toBe("object");
    });

    it("advertises structured summary and cross-session reply requirements", () => {
        const tools = ManagedSession.systemToolDefs();
        const summaryTool = tools.find((tool) => tool.name === "update_session_summary");
        const sendTool = tools.find((tool) => tool.name === "send_session_message");
        const replyTool = tools.find((tool) => tool.name === "reply_session_message");

        expect(summaryTool?.description).toContain("Do not pass a string for summary_state");
        expect(summaryTool?.description).toContain("Keep it concise and scannable");
        expect(summaryTool?.description).toContain("short Markdown tables");
        expect(summaryTool?.parameters?.properties?.summary_state?.required).toContain("schemaVersion");
        expect(summaryTool?.parameters?.properties?.summary_state?.required).toContain("structureChangeLog");
        expect(sendTool?.description).toContain("normal chat transcript is not the response channel");
        expect(replyTool?.description).toContain("Do not only write the answer in your own chat");
    });

    it("blocks user tool side effects after a wait boundary", async () => {
        const fakeSession = new FakeCopilotSession();
        const storeFact = vi.fn(async () => "stored");
        fakeSession.scriptedToolCalls = [
            { name: "wait", args: { seconds: 60, reason: "pause before next write" } },
            { name: "store_fact", args: { key: "post-wait", value: "should not write yet" } },
        ];
        fakeSession.assistantContent = "waiting";

        const managed = new ManagedSession("inline-wait-boundary", fakeSession, {
            waitThreshold: 0,
            tools: [{ name: "store_fact", parameters: { type: "object", properties: {} }, handler: storeFact }],
        });
        const result = await managed.runTurn("wait then write");

        expect(result.type).toBe("wait");
        expect(storeFact).not.toHaveBeenCalled();
    });

    it("blocks system side effects after a wait boundary", async () => {
        const fakeSession = new FakeCopilotSession();
        const summaryState = {
            schemaVersion: 1,
            updatedAt: "2026-05-18T00:00:00.000Z",
            intent: "Wait",
            summary: "Waiting.",
            state: {},
            openQuestions: [],
            blockers: [],
            nextActions: [],
            links: [],
            structureChangeLog: [],
        };
        fakeSession.scriptedToolCalls = [
            { name: "wait", args: { seconds: 60, reason: "pause before summary" } },
            { name: "update_session_summary", args: { summary_state: summaryState, short_summary: "Should not update" } },
        ];
        fakeSession.assistantContent = "waiting";

        const controlToolBridge = {
            updateSessionSummary: vi.fn(async () => "updated"),
        };

        const managed = new ManagedSession("inline-wait-summary-boundary", fakeSession, { waitThreshold: 0 });
        const result = await managed.runTurn("wait then summarize", { controlToolBridge });

        expect(result.type).toBe("wait");
        expect(controlToolBridge.updateSessionSummary).not.toHaveBeenCalled();
    });

    it("advertises and forwards an optional spawn_agent title", async () => {
        const fakeSession = new FakeCopilotSession();
        fakeSession.scriptedToolCalls = [
            { name: "spawn_agent", args: { task: "say hi", title: "Research Child" } },
        ];
        fakeSession.assistantContent = "Spawned titled child.";

        const controlToolBridge = {
            spawnAgent: vi.fn(async () => "[SYSTEM: spawned]"),
            messageAgent: vi.fn(),
            checkAgents: vi.fn(),
            resolveWaitForAgents: vi.fn(),
            listSessions: vi.fn(),
            completeAgent: vi.fn(),
            cancelAgent: vi.fn(),
            deleteAgent: vi.fn(),
        };

        const managed = new ManagedSession("inline-spawn-title", fakeSession, {});
        const result = await managed.runTurn("spawn a titled child", { controlToolBridge });

        const spawnTool = fakeSession.registeredTools.find((tool) => tool.name === "spawn_agent");
        expect(spawnTool?.parameters?.properties?.title?.type).toBe("string");
        expect(controlToolBridge.spawnAgent).toHaveBeenCalledWith(expect.objectContaining({
            task: "say hi",
            title: "Research Child",
        }));
        expect(result.type).toBe("completed");
        expect(result.content).toBe("Spawned titled child.");
    });

    it("advertises and forwards child contracts and results", async () => {
        const fakeSession = new FakeCopilotSession();
        fakeSession.scriptedToolCalls = [
            {
                name: "spawn_agent",
                args: {
                    task: "collect evidence",
                    contract: {
                        purpose: "Evidence collection",
                        expectedFacts: [{ key: "result/evidence", required: true }],
                    },
                },
            },
            {
                name: "complete_agent",
                args: {
                    agent_id: "session-child",
                    result: {
                        verdict: "success",
                        summary: "Evidence collected.",
                        factsWritten: [{ kind: "fact", key: "result/evidence" }],
                    },
                },
            },
            {
                name: "cancel_agent",
                args: {
                    agent_id: "session-other-child",
                    reason: "stale",
                    partial_result: { verdict: "cancelled", summary: "No longer needed." },
                },
            },
        ];
        fakeSession.assistantContent = "Recorded child outcomes.";

        const controlToolBridge = {
            spawnAgent: vi.fn(async () => "[SYSTEM: spawned]"),
            messageAgent: vi.fn(),
            checkAgents: vi.fn(),
            resolveWaitForAgents: vi.fn(),
            listSessions: vi.fn(),
            completeAgent: vi.fn(async () => "[SYSTEM: completed]"),
            cancelAgent: vi.fn(async () => "[SYSTEM: cancelled]"),
            deleteAgent: vi.fn(),
            updateSessionSummary: vi.fn(),
            sendSessionMessage: vi.fn(),
            replySessionMessage: vi.fn(),
        };

        const managed = new ManagedSession("inline-contracts", fakeSession, {});
        const result = await managed.runTurn("spawn with contract", { controlToolBridge });

        const spawnTool = fakeSession.registeredTools.find((tool) => tool.name === "spawn_agent");
        const completeTool = fakeSession.registeredTools.find((tool) => tool.name === "complete_agent");
        const cancelTool = fakeSession.registeredTools.find((tool) => tool.name === "cancel_agent");
        expect(spawnTool?.parameters?.properties?.contract?.type).toBe("object");
        expect(completeTool?.parameters?.properties?.result?.type).toBe("object");
        expect(cancelTool?.parameters?.properties?.partial_result?.type).toBe("object");
        expect(controlToolBridge.spawnAgent).toHaveBeenCalledWith(expect.objectContaining({
            task: "collect evidence",
            contract: expect.objectContaining({ purpose: "Evidence collection" }),
        }));
        expect(controlToolBridge.completeAgent).toHaveBeenCalledWith(expect.objectContaining({
            agent_id: "session-child",
            result: expect.objectContaining({ verdict: "success" }),
        }));
        expect(controlToolBridge.cancelAgent).toHaveBeenCalledWith(expect.objectContaining({
            agent_id: "session-other-child",
            partial_result: expect.objectContaining({ verdict: "cancelled" }),
        }));
        expect(result.type).toBe("completed");
    });

    it("forwards summary and cross-session coordination tools inline", async () => {
        const fakeSession = new FakeCopilotSession();
        const summaryState = {
            schemaVersion: 1,
            updatedAt: "2026-05-16T00:00:00.000Z",
            intent: "Track work",
            summary: "Ready.",
            state: { cmsState: "idle" },
            openQuestions: [],
            blockers: [],
            nextActions: [],
            links: [],
            structureChangeLog: [],
        };
        fakeSession.scriptedToolCalls = [
            { name: "update_session_summary", args: { summary_state: summaryState, short_summary: "Ready" } },
            { name: "send_session_message", args: { session_id: "target", subject: "Status", body: "What is current state?", expects_response: true } },
            { name: "reply_session_message", args: { request_id: "req-1", session_id: "source", body: "Answered." } },
        ];
        fakeSession.assistantContent = "Coordinated.";

        const controlToolBridge = {
            spawnAgent: vi.fn(),
            messageAgent: vi.fn(),
            checkAgents: vi.fn(),
            resolveWaitForAgents: vi.fn(),
            listSessions: vi.fn(),
            completeAgent: vi.fn(),
            cancelAgent: vi.fn(),
            deleteAgent: vi.fn(),
            updateSessionSummary: vi.fn(async () => "[SYSTEM: summary updated]"),
            sendSessionMessage: vi.fn(async () => "[SYSTEM: message queued]"),
            replySessionMessage: vi.fn(async () => "[SYSTEM: reply queued]"),
        };

        const managed = new ManagedSession("inline-coordination", fakeSession, {});
        const result = await managed.runTurn("coordinate", { controlToolBridge });

        expect(fakeSession.registeredTools.some((tool) => tool.name === "update_session_summary")).toBe(true);
        expect(fakeSession.registeredTools.some((tool) => tool.name === "send_session_message")).toBe(true);
        expect(fakeSession.registeredTools.some((tool) => tool.name === "reply_session_message")).toBe(true);
        expect(controlToolBridge.updateSessionSummary).toHaveBeenCalledWith(expect.objectContaining({ short_summary: "Ready" }));
        expect(controlToolBridge.sendSessionMessage).toHaveBeenCalledWith(expect.objectContaining({ session_id: "target", expects_response: true }));
        expect(controlToolBridge.replySessionMessage).toHaveBeenCalledWith(expect.objectContaining({ request_id: "req-1" }));
        expect(result.type).toBe("completed");
    });

    it("advertises model reasoning options through list_available_models", async () => {
        const fakeSession = new FakeCopilotSession();
        fakeSession.assistantContent = "checked models";

        const managed = new ManagedSession("inline-list-models", fakeSession, {});
        await managed.runTurn("list models", {
            modelSummary: "Available models\n- github-copilot:gpt-5.5 [reasoning: medium, xhigh; default: medium]",
        });

        const listTool = fakeSession.registeredTools.find((tool) => tool.name === "list_available_models");
        expect(listTool?.description).toContain("supported reasoning efforts");
        const result = await listTool.handler({});
        expect(result).toContain("github-copilot:gpt-5.5");
        expect(result).toContain("reasoning: medium, xhigh; default: medium");
    });

    it("advertises and forwards an optional spawn_agent reasoning_effort", async () => {
        const fakeSession = new FakeCopilotSession();
        fakeSession.scriptedToolCalls = [
            { name: "spawn_agent", args: { task: "reason deeply", model: "github-copilot:gpt-5.5", reasoning_effort: "xhigh" } },
        ];
        fakeSession.assistantContent = "Spawned reasoning child.";

        const controlToolBridge = {
            spawnAgent: vi.fn(async () => "[SYSTEM: spawned]"),
            messageAgent: vi.fn(),
            checkAgents: vi.fn(),
            resolveWaitForAgents: vi.fn(),
            listSessions: vi.fn(),
            completeAgent: vi.fn(),
            cancelAgent: vi.fn(),
            deleteAgent: vi.fn(),
        };

        const managed = new ManagedSession("inline-spawn-reasoning", fakeSession, {});
        const result = await managed.runTurn("spawn a high reasoning child", { controlToolBridge });

        const spawnTool = fakeSession.registeredTools.find((tool) => tool.name === "spawn_agent");
        expect(spawnTool?.parameters?.properties?.reasoning_effort?.enum).toEqual(["low", "medium", "high", "xhigh"]);
        expect(controlToolBridge.spawnAgent).toHaveBeenCalledWith(expect.objectContaining({
            task: "reason deeply",
            model: "github-copilot:gpt-5.5",
            reasoning_effort: "xhigh",
        }));
        expect(result.type).toBe("completed");
        expect(result.content).toBe("Spawned reasoning child.");
    });

    it("still suspends the turn for wait_for_agents", async () => {
        const fakeSession = new FakeCopilotSession();
        fakeSession.scriptedToolCalls = [
            { name: "wait_for_agents", args: {} },
        ];

        const controlToolBridge = {
            spawnAgent: vi.fn(),
            messageAgent: vi.fn(),
            checkAgents: vi.fn(),
            resolveWaitForAgents: vi.fn(async () => []),
            listSessions: vi.fn(),
            completeAgent: vi.fn(),
            cancelAgent: vi.fn(),
            deleteAgent: vi.fn(),
        };

        const managed = new ManagedSession("wait-for-agents", fakeSession, {});
        const result = await managed.runTurn("wait on children", { controlToolBridge });

        expect(result.type).toBe("wait_for_agents");
        expect(controlToolBridge.resolveWaitForAgents).toHaveBeenCalledTimes(1);
        expect(fakeSession.aborted).toBe(false);
    });

    it("does not abort the session for long wait() but blocks later tool side effects", async () => {
        const fakeSession = new FakeCopilotSession();
        const regularToolHandler = vi.fn(async () => "ok");
        fakeSession.scriptedToolCalls = [
            { name: "wait", args: { seconds: 120, reason: "pause work" } },
            { name: "regular_tool", args: { value: 1 } },
        ];

        const managed = new ManagedSession("inline-wait", fakeSession, {
            tools: [{
                name: "regular_tool",
                description: "test tool",
                parameters: { type: "object", properties: {} },
                handler: regularToolHandler,
            }],
        });

        const result = await managed.runTurn("pause and keep transcript valid");

        expect(result.type).toBe("wait");
        expect(regularToolHandler).not.toHaveBeenCalled();
        expect(fakeSession.aborted).toBe(false);
    });

    it("does not abort the session for ask_user() but blocks later tool side effects", async () => {
        const fakeSession = new FakeCopilotSession();
        const regularToolHandler = vi.fn(async () => "ok");
        fakeSession.scriptedToolCalls = [
            { name: "ask_user", args: { question: "Need approval?" } },
            { name: "regular_tool", args: { value: 1 } },
        ];

        const managed = new ManagedSession("inline-ask-user", fakeSession, {
            tools: [{
                name: "regular_tool",
                description: "test tool",
                parameters: { type: "object", properties: {} },
                handler: regularToolHandler,
            }],
        });

        const result = await managed.runTurn("ask the user and keep transcript valid");

        expect(result.type).toBe("input_required");
        expect(regularToolHandler).not.toHaveBeenCalled();
        expect(fakeSession.aborted).toBe(false);
    });

    it("converts thrown user tool errors into failure tool results instead of surfacing SDK tool errors", async () => {
        const fakeSession = new FakeCopilotSession();
        const failingToolHandler = vi.fn(async () => {
            throw new Error("HTTP 404");
        });
        fakeSession.scriptedToolCalls = [
            { name: "regular_tool", args: { value: 1 } },
        ];
        fakeSession.assistantContent = "Handled the tool failure.";

        const managed = new ManagedSession("inline-tool-failure", fakeSession, {
            tools: [{
                name: "regular_tool",
                description: "test tool",
                parameters: { type: "object", properties: {} },
                handler: failingToolHandler,
            }],
        });

        const result = await managed.runTurn("run a tool that fails");

        expect(failingToolHandler).toHaveBeenCalledTimes(1);
        expect(result.type).toBe("completed");
        expect(result.content).toBe("Handled the tool failure.");
        expect(fakeSession.aborted).toBe(false);
    });

    it("suppresses the benign post-completion null-length query error when the assistant already replied", async () => {
        const fakeSession = new FakeCopilotSession();
        fakeSession.assistantContent = "Hello! I'm here and ready to help.";
        fakeSession.scriptedEvents = [{
            type: "session.error",
            data: {
                message: "Cannot read properties of null (reading 'length')",
                errorType: "query",
            },
        }];
        const onEvent = vi.fn();

        const managed = new ManagedSession("benign-query-error", fakeSession, {});
        const result = await managed.runTurn("say hello", { onEvent });

        expect(result.type).toBe("completed");
        expect(result.content).toBe("Hello! I'm here and ready to help.");
        expect(result.events?.some((event) => event.eventType === "session.error")).toBe(false);
        expect(onEvent.mock.calls.some(([event]) => event?.eventType === "session.error")).toBe(false);
    });

    it("still surfaces the null-length query error when the turn produced no assistant message", async () => {
        const fakeSession = new FakeCopilotSession();
        fakeSession.assistantContent = null;
        fakeSession.scriptedEvents = [{
            type: "session.error",
            data: {
                message: "Cannot read properties of null (reading 'length')",
                errorType: "query",
            },
        }];
        const onEvent = vi.fn();

        const managed = new ManagedSession("fatal-query-error", fakeSession, {});
        const result = await managed.runTurn("say hello", { onEvent });

        expect(result.type).toBe("error");
        expect(result.message).toContain("Cannot read properties of null");
        expect(onEvent.mock.calls.some(([event]) => event?.eventType === "session.error")).toBe(true);
    });

    it("does not capture empty assistant messages at wait_for_agents boundaries", async () => {
        const fakeSession = new FakeCopilotSession();
        fakeSession.scriptedToolCalls = [
            { name: "wait_for_agents", args: { agent_ids: ["session-child"] } },
        ];
        fakeSession.assistantContent = "";
        const onEvent = vi.fn();

        const managed = new ManagedSession("blank-assistant-wait", fakeSession, {});
        const result = await managed.runTurn("wait for the child", { onEvent });

        expect(result.type).toBe("wait_for_agents");
        expect(result.events?.some((event) => event.eventType === "assistant.message")).toBe(false);
        expect(onEvent.mock.calls.some(([event]) => event?.eventType === "assistant.message")).toBe(false);
    });

    it("sanitizes replayed null assistant content before sending the next turn", async () => {
        const fakeSession = new FakeCopilotSession();
        fakeSession._chatMessages = [
            { role: "user", content: "spawn children" },
            { role: "assistant", content: null },
            { role: "assistant", content: "   " },
            { role: "assistant", content: null, tool_calls: [{ id: "call-1", type: "function", function: { name: "wait_for_agents", arguments: "{}" } }] },
            { role: "user", content: null },
        ];
        fakeSession._systemContextMessages = [
            { role: "assistant", content: null },
            { role: "system", content: null },
        ];

        const managed = new ManagedSession("sanitize-replay-history", fakeSession, {});
        const result = await managed.runTurn("resume after child completion");

        expect(result.type).toBe("completed");
        expect(fakeSession._chatMessages).toEqual([
            { role: "user", content: "spawn children" },
            { role: "assistant", content: "", tool_calls: [{ id: "call-1", type: "function", function: { name: "wait_for_agents", arguments: "{}" } }] },
            { role: "user", content: "" },
        ]);
        expect(fakeSession._systemContextMessages).toEqual([
            { role: "system", content: "" },
        ]);
    });
});
