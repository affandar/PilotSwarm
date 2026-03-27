import { describe, it } from "vitest";
import { ManagedSession } from "../../src/managed-session.ts";
import { assertEqual } from "../helpers/assertions.js";

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

describe("cron tool plumbing", () => {
    it("queues cron on completed turns without aborting the turn", async () => {
        const fakeSession = new FakeCopilotSession();
        fakeSession.scriptedToolCalls = [
            { name: "cron", args: { seconds: 45, reason: "check sub-agents and summarize news" } },
        ];
        fakeSession.assistantContent = "Started monitoring.";

        const managed = new ManagedSession("cron-only", fakeSession, {});
        const result = await managed.runTurn("Monitor every 45 seconds.");

        assertEqual(result.type, "completed", "cron-only turn should still complete normally");
        assertEqual(result.content, "Started monitoring.", "cron-only turn should preserve assistant text");
        assertEqual(result.queuedActions?.length ?? 0, 1, "cron-only turn should queue one cron action");
        assertEqual(result.queuedActions?.[0]?.type, "cron", "queued action should be cron");
        assertEqual(result.queuedActions?.[0]?.action, "set", "cron action should schedule");
    });

    it("keeps wait as the primary blocking result when cron is also called", async () => {
        const fakeSession = new FakeCopilotSession();
        fakeSession.scriptedToolCalls = [
            { name: "cron", args: { seconds: 45, reason: "check sub-agents and summarize news" } },
            { name: "wait", args: { seconds: 120, reason: "poll sub-agents" } },
        ];

        const managed = new ManagedSession("cron-then-wait", fakeSession, { waitThreshold: 0 });
        const result = await managed.runTurn("Monitor every 45 seconds and poll after spawning.");

        assertEqual(result.type, "wait", "wait should remain the primary blocking result");
        assertEqual(result.seconds, 120, "wait result should keep its duration");
        assertEqual(result.reason, "poll sub-agents", "wait result should keep its reason");
        assertEqual(result.queuedActions?.length ?? 0, 1, "cron should survive as a queued action before orchestration handling");
        assertEqual(result.queuedActions?.[0]?.type, "cron", "queued action should be cron");
        assertEqual(result.queuedActions?.[0]?.action, "set", "queued cron action should schedule");
    });
});
