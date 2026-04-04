import { describe, expect, it, vi } from "vitest";
import { ManagedSession } from "../../src/managed-session.ts";

class FakeCopilotSession {
    registeredTools = [];
    listeners = new Map();
    catchAllHandlers = [];
    scriptedToolCalls = [];
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
});
