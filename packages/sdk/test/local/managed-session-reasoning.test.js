import { describe, expect, it } from "vitest";
import { ManagedSession } from "../../src/managed-session.ts";

class FakeCopilotSession {
    registeredTools = [];
    listeners = new Map();
    catchAllHandlers = [];
    assistantContent = "Done.";

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
        queueMicrotask(() => {
            this.emit("assistant.reasoning_delta", {
                data: { deltaContent: "Checking hydration" },
            });
            this.emit("assistant.reasoning_delta", {
                data: { deltaContent: " and replay state." },
            });
            this.emit("assistant.message", {
                data: { content: this.assistantContent },
            });
            this.emit("session.idle", { data: {} });
        });
    }

    abort() {}
}

describe("managed session reasoning snapshots", () => {
    it("publishes durable assistant.reasoning snapshots from reasoning deltas", async () => {
        const fakeSession = new FakeCopilotSession();
        const managed = new ManagedSession("reasoning-snapshots", fakeSession, {});
        const events = [];

        const result = await managed.runTurn("diagnose it", {
            onEvent: (event) => events.push(event),
        });

        const reasoningEvents = events.filter((event) => event.eventType === "assistant.reasoning");

        expect(result.type).toBe("completed");
        expect(reasoningEvents.length).toBeGreaterThan(0);
        expect(reasoningEvents[reasoningEvents.length - 1]?.data?.content)
            .toContain("Checking hydration and replay state.");
        expect(events.some((event) => event.eventType === "assistant.reasoning_delta")).toBe(true);
    });
});
