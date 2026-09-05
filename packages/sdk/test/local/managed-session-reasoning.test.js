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
            this.emit("assistant.turn_start", { data: {} });
            this.emit("assistant.reasoning_delta", {
                data: { reasoningId: "r1", deltaContent: "Checking hydration" },
            });
            this.emit("assistant.reasoning_delta", {
                data: { reasoningId: "r1", deltaContent: " and replay state." },
            });
            this.emit("assistant.message_delta", { data: { messageId: "m1", deltaContent: "Do" } });
            this.emit("assistant.message_delta", { data: { messageId: "m1", deltaContent: "ne." } });
            this.emit("assistant.message", {
                data: { messageId: "m1", content: this.assistantContent },
            });
            this.emit("assistant.turn_end", { data: {} });
            this.emit("session.idle", { data: {} });
        });
    }

    abort() {}
}

describe("managed session reasoning snapshots", () => {
    it("ignores interleaved progress-only notifications without resetting text or reasoning", async () => {
        const fakeSession = new FakeCopilotSession();
        const fragments = ["Hello ", "world", "!".repeat(600)];
        const answer = fragments.join("");
        let snapshotsBeforeFinal = [];
        fakeSession.send = async () => {
            queueMicrotask(() => {
                fakeSession.emit("assistant.turn_start");
                fakeSession.emit("assistant.reasoning_delta", { reasoningId: "r1", deltaContent: "Retained thought" });
                for (const deltaContent of fragments) {
                    fakeSession.emit("assistant.streaming_delta", { totalResponseSizeBytes: 1000 });
                    fakeSession.emit("assistant.message_delta", { messageId: "m1", deltaContent });
                    fakeSession.emit("assistant.streaming_delta", { totalResponseSizeBytes: 2000 });
                }
                snapshotsBeforeFinal = events.filter(event => event.eventType === "assistant.live_tick");
                fakeSession.emit("assistant.message", { messageId: "m1", content: answer });
                fakeSession.emit("assistant.turn_end");
                fakeSession.emit("session.idle");
            });
        };
        const events = [];
        const result = await new ManagedSession("interleaved-progress", fakeSession, {}).runTurn("go", {
            liveTurn: true, onEvent: event => events.push(event),
        });
        expect(result.type).toBe("completed");
        expect(snapshotsBeforeFinal).toHaveLength(1);
        expect(snapshotsBeforeFinal[0].data.text).toBe(answer);
        const ticks = events.filter(event => event.eventType === "assistant.live_tick" && event.data.phase === "live").map(event => event.data);
        expect(ticks.length).toBeGreaterThan(0);
        expect(ticks.length).toBeLessThanOrEqual(2);
        for (const tick of ticks) {
            expect(tick.messageId).toBe("m1");
            expect(tick.reasoningText).toBe("Retained thought");
            expect(answer.startsWith(tick.text)).toBe(true);
        }
        expect(ticks.at(-1).text).toBe(answer);
        const end = events.find(event => event.eventType === "assistant.turn_end");
        expect(end.data.streamingDeltas).toBe(fragments.length);
        expect(end.data.streamingChars).toBe(answer.length);
        expect(events.filter(event => event.eventType === "assistant.streaming_delta")).toHaveLength(fragments.length * 2);
        expect(result.events.some(event => event.eventType === "assistant.streaming_delta")).toBe(false);
    });

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

    it("emits coalesced live ticks only when requested and preserves streaming counters", async () => {
        const without = [];
        await new ManagedSession("live-off", new FakeCopilotSession(), {}).runTurn("go", {
            onEvent: (event) => without.push(event),
        });
        expect(without.filter((event) => event.eventType === "assistant.live_tick")).toHaveLength(0);
        const offTurnEnd = without.find((event) => event.eventType === "assistant.turn_end");
        expect(offTurnEnd.data.streamingDeltas).toBe(2);
        expect(offTurnEnd.data.streamingChars).toBe(5);

        const withLive = [];
        await new ManagedSession("live-on", new FakeCopilotSession(), {}).runTurn("go", {
            liveTurn: true,
            onEvent: (event) => withLive.push(event),
        });
        const ticks = withLive.filter((event) => event.eventType === "assistant.live_tick").map((event) => event.data);
        expect(ticks.some((tick) => tick.phase === "live" && tick.messageId === "m1" && tick.text === "Done.")).toBe(true);
        expect(ticks.at(-1)).toEqual({ phase: "idle", streamId: expect.any(String), messageId: null, text: "", reasoningId: null, reasoningText: "" });
        expect(ticks.at(-1).streamId).toBe(ticks.find((tick) => tick.phase === "live").streamId);
        const onTurnEnd = withLive.find((event) => event.eventType === "assistant.turn_end");
        expect(onTurnEnd.data.streamingDeltas).toBe(2);
        expect(onTurnEnd.data.streamingChars).toBe(5);
    });

    it("requires a rebind when the resolved provider fingerprint changes", () => {
        const managed = new ManagedSession("provider-rotation", new FakeCopilotSession(), {
            model: "team:gpt",
            providerFingerprint: "old",
        });
        expect(managed.requiresModelRebind({
            model: "team:gpt",
            providerFingerprint: "new",
        })).toBe(true);
        expect(managed.requiresModelRebind({
            model: "team:gpt",
            providerFingerprint: "old",
        })).toBe(false);
    });
});
