import { afterEach, describe, expect, it, vi } from "vitest";
import {
    DEFAULT_TURN_INACTIVITY_TIMEOUT_MS,
    DEFAULT_TURN_TIMEOUT_MS,
    ManagedSession,
    TURN_INACTIVITY_ERROR_MARKER,
} from "../../src/managed-session.ts";
import { isCopilotConnectionClosedError } from "../../src/orchestration/utils.ts";

// Regression shape for the 2026-07-12 waldemort-chk facts-manager zombie turn:
// the Copilot CLI subprocess acked send() and then OOM-crashed. No event —
// including session.idle — ever arrived, runTurn awaited forever, and the
// durable runTurn activity stayed in-flight while the session's queue backed
// up. The turn must settle on its own instead.
class FakeCopilotSession {
    catchAllHandlers = [];
    listeners = new Map();
    aborted = false;
    /** Called by send(); default is "ack then total silence" (dead subprocess). */
    onSend = () => {};

    on(eventTypeOrHandler, handler) {
        if (typeof eventTypeOrHandler === "function") {
            this.catchAllHandlers.push(eventTypeOrHandler);
            return () => {
                this.catchAllHandlers = this.catchAllHandlers.filter((h) => h !== eventTypeOrHandler);
            };
        }
        const handlers = this.listeners.get(eventTypeOrHandler) ?? [];
        handlers.push(handler);
        this.listeners.set(eventTypeOrHandler, handlers);
        return () => {
            const current = this.listeners.get(eventTypeOrHandler) ?? [];
            this.listeners.set(eventTypeOrHandler, current.filter((h) => h !== handler));
        };
    }

    registerTools() {}

    emit(eventType, payload = {}) {
        for (const handler of this.catchAllHandlers) {
            handler({ type: eventType, data: payload.data ?? payload });
        }
        for (const handler of this.listeners.get(eventType) ?? []) {
            handler(payload);
        }
    }

    async send() {
        this.onSend();
    }

    abort() {
        this.aborted = true;
    }
}

describe("turn inactivity watchdog (zombie-turn regression)", () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it("settles a silent-after-ack turn as a retryable transport-loss error", async () => {
        vi.useFakeTimers();
        const fake = new FakeCopilotSession(); // never emits anything
        const managed = new ManagedSession("zombie-turn", fake, {
            turnInactivityTimeoutMs: 5_000,
        });

        const turn = managed.runTurn("curate the intake backlog");
        await vi.advanceTimersByTimeAsync(5_100);
        const result = await turn;

        expect(result.type).toBe("error");
        expect(result.message).toContain(TURN_INACTIVITY_ERROR_MARKER);
        // The settle message must ride the orchestration's existing
        // connection-closed recovery (release affinity, retry on a fresh
        // subprocess, bounded by lossy-handoff fallback). If this classifier
        // stops matching, the zombie-turn fix silently downgrades to generic
        // retry handling — fail loudly here instead.
        expect(isCopilotConnectionClosedError(result.message)).toBe(true);
        expect(fake.aborted).toBe(true);
    });

    it("does not fire while events keep flowing, even past the threshold", async () => {
        vi.useFakeTimers();
        const fake = new FakeCopilotSession();
        // Emit a heartbeat event every 2s for 12s (4× the 3s threshold), then
        // complete normally — a slow-but-alive turn must not be killed.
        fake.onSend = () => {
            for (let ms = 2_000; ms <= 12_000; ms += 2_000) {
                setTimeout(() => fake.emit("tool.execution_partial_result", { data: {} }), ms);
            }
            setTimeout(() => {
                fake.emit("assistant.message", { data: { content: "Done." } });
                fake.emit("session.idle", { data: {} });
            }, 13_000);
        };
        const managed = new ManagedSession("alive-turn", fake, {
            turnInactivityTimeoutMs: 3_000,
        });

        const turn = managed.runTurn("long but healthy turn");
        await vi.advanceTimersByTimeAsync(14_000);
        const result = await turn;

        expect(result.type).toBe("completed");
        expect(fake.aborted).toBe(false);
    });

    it("is enabled by default (no config) and settles at the default threshold", async () => {
        vi.useFakeTimers();
        const fake = new FakeCopilotSession(); // dead after ack
        const managed = new ManagedSession("default-config-zombie", fake, {});

        const turn = managed.runTurn("prompt");
        await vi.advanceTimersByTimeAsync(DEFAULT_TURN_INACTIVITY_TIMEOUT_MS + 100);
        const result = await turn;

        expect(result.type).toBe("error");
        expect(isCopilotConnectionClosedError(result.message)).toBe(true);
    });

    it("explicit 0 disables the watchdog; the default wall-clock cap still settles the turn", async () => {
        vi.useFakeTimers();
        const fake = new FakeCopilotSession(); // dead after ack
        const managed = new ManagedSession("wall-clock-only", fake, {
            turnInactivityTimeoutMs: 0,
        });

        const turn = managed.runTurn("prompt");
        // With the watchdog disabled, only the wall-clock cap can settle the
        // turn. Advance past both thresholds; the settle message must be the
        // cap's, not the watchdog's.
        await vi.advanceTimersByTimeAsync(DEFAULT_TURN_INACTIVITY_TIMEOUT_MS * 2);
        await vi.advanceTimersByTimeAsync(DEFAULT_TURN_TIMEOUT_MS);
        const result = await turn;

        expect(result.type).toBe("error");
        expect(result.message).toContain("taking too long");
        expect(fake.aborted).toBe(true);
    });

    it("clears guard timers once a healthy turn completes", async () => {
        vi.useFakeTimers();
        const fake = new FakeCopilotSession();
        fake.onSend = () => {
            queueMicrotask(() => {
                fake.emit("assistant.message", { data: { content: "Done." } });
                fake.emit("session.idle", { data: {} });
            });
        };
        const managed = new ManagedSession("fast-turn", fake, {});

        const result = await managed.runTurn("quick");
        expect(result.type).toBe("completed");
        // Both guards (wall-clock cap + inactivity watchdog) must be cleared in
        // the finally block — a settled turn leaves nothing armed that could
        // later fire and reject an unobserved promise.
        expect(vi.getTimerCount()).toBe(0);
    });
});
