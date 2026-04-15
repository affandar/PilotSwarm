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

    it("does not abort the session for long wait() and still lets later tool calls run", async () => {
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
        expect(regularToolHandler).toHaveBeenCalledTimes(1);
        expect(fakeSession.aborted).toBe(false);
    });

    it("does not abort the session for ask_user() and still lets later tool calls run", async () => {
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
        expect(regularToolHandler).toHaveBeenCalledTimes(1);
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
});
