import { afterEach, describe, expect, it, vi } from "vitest";
import { NativeTaskObserver } from "../../src/native-task-observer.ts";

function harness(overrides = {}, options = {}) {
    const events = [];
    const rpc = { list: vi.fn(async () => ({ tasks: [] })), getProgress: vi.fn(async () => ({ progress: null })), ...overrides };
    const observer = new NativeTaskObserver({ rpc: { tasks: rpc } }, { emit: e => events.push(e), ...options });
    const emit = (type, data = {}, agentId) => observer.observe({ type, data, agentId, timestamp: new Date().toISOString() });
    const start = (id = "call", agentId = "agent") => {
        emit("tool.execution_start", { toolName: "task", toolCallId: id, arguments: { description: "Read the runtime", agent_type: "swarm-explore" } });
        emit("subagent.started", { toolCallId: id, agentName: "swarm-explore" }, agentId);
    };
    const tick = () => events.filter(e => e.eventType === "session.native_tasks_tick").at(-1)?.data;
    const summaries = () => events.filter(e => e.eventType === "native.task_updated").map(e => e.data);
    return { observer, events, rpc, emit, start, tick, summaries };
}

afterEach(() => vi.useRealTimers());

describe("native task observation", () => {
    it("coalesces bursts, refreshes once more after an in-flight change, and bounds progress", async () => {
        vi.useFakeTimers();
        let release;
        const row = { type: "agent", id: "agent", toolCallId: "call", status: "running", resolvedModel: "resolved" };
        const h = harness({ list: vi.fn().mockImplementationOnce(() => new Promise(resolve => { release = resolve; })).mockResolvedValue({ tasks: [row] }),
            getProgress: vi.fn(async () => ({ progress: { type: "agent", latestIntent: "Inspecting the queue", recentActivity: Array.from({ length: 20 }, () => ({ message: "x".repeat(400), timestamp: "2026-09-08T00:00:00Z" })) } })) });
        h.start();
        for (let i = 0; i < 100; i++) h.emit("session.background_tasks_changed");
        await vi.advanceTimersByTimeAsync(300);
        expect(h.rpc.list).toHaveBeenCalledTimes(1);
        for (let i = 0; i < 100; i++) h.emit("session.background_tasks_changed");
        release({ tasks: [row] });
        await vi.advanceTimersByTimeAsync(600);
        expect(h.rpc.list).toHaveBeenCalledTimes(2);
        expect(h.tick().tasks[0]).toMatchObject({ model: "resolved", preview: "Inspecting the queue" });
        expect(h.tick().tasks[0].recentActivity).toHaveLength(5);
        expect(h.tick().tasks[0].recentActivity[0].message).toHaveLength(240);
        expect(h.summaries()).toHaveLength(1);
        h.observer.finish();
    });

    it("uses actual instance identities and never treats child tool errors or idle as completion", async () => {
        vi.useFakeTimers();
        const h = harness({ list: async () => ({ tasks: [{ type: "agent", id: "agent", toolCallId: "call", status: "idle" }] }) });
        h.start();
        h.start("other-call", "other-agent");
        h.emit("subagent.configured", { model: "actual" }, "agent");
        h.emit("tool.execution_start", { toolCallId: "read", parentToolCallId: "call", toolName: "view" }, "agent");
        h.emit("tool.execution_start", { toolCallId: "read", parentToolCallId: "call", toolName: "view" }, "agent");
        h.emit("tool.execution_complete", { toolCallId: "read", parentToolCallId: "call", success: false }, "agent");
        h.emit("session.idle", {}, "agent");
        await vi.advanceTimersByTimeAsync(600);
        expect(h.tick().tasks[0]).toMatchObject({ id: "call", agentId: "agent", model: "actual", status: "waiting", toolCalls: 1 });
        expect(h.tick().tasks[1]).toMatchObject({ id: "other-call", agentId: "other-agent", status: "running", toolCalls: 0 });
        h.observer.finish();
    });

    it("retains completion and result through cleanup cancellation, removal and late progress", async () => {
        vi.useFakeTimers();
        let release;
        const h = harness({ list: async () => ({ tasks: [{ type: "agent", id: "agent", toolCallId: "call", status: "running" }] }),
            getProgress: () => new Promise(resolve => { release = resolve; }) });
        h.start();
        await vi.advanceTimersByTimeAsync(300);
        h.emit("subagent.completed", { toolCallId: "call", durationMs: 500, totalToolCalls: 7 }, "agent");
        h.emit("tool.execution_complete", { toolName: "task", toolCallId: "call", success: true, result: { content: "Saved to temporary file", detailedContent: "The durable result" } });
        h.emit("subagent.completed", { toolCallId: "call", cancelled: true, durationMs: 900, totalToolCalls: 99, error: "cleanup failure", model: "wrong" }, "agent");
        h.emit("tool.execution_start", { toolCallId: "late-child-tool", toolName: "bash", arguments: { description: "late cleanup" } }, "agent");
        h.emit("tool.execution_complete", { toolName: "task", toolCallId: "call", success: false, error: "cleanup task failure", result: "No result" });
        release({ progress: { type: "agent", latestIntent: "Stale progress", recentActivity: [] } });
        await vi.advanceTimersByTimeAsync(600);
        h.observer.finish();
        expect(h.tick().tasks[0]).toMatchObject({ status: "completed", durationMs: 500, toolCalls: 7, result: "The durable result", preview: "The durable result" });
        expect(h.tick().tasks[0].error).toBeUndefined();
        expect(h.tick().tasks[0].model).not.toBe("wrong");
        expect(h.summaries().at(-1)).toMatchObject({ status: "completed", result: "The durable result" });
    });

    it("distinguishes denied tasks, cancellation and abandoned running work", () => {
        const h = harness();
        h.emit("tool.execution_start", { toolName: "task", toolCallId: "denied" });
        h.emit("tool.execution_complete", { toolName: "task", toolCallId: "denied", success: false, result: { content: "Permission denied" } });
        h.start("cancelled", "cancelled-agent");
        h.emit("subagent.completed", { toolCallId: "cancelled", cancelled: true }, "cancelled-agent");
        h.start("abandoned", "lost-agent");
        h.observer.finish();
        expect(h.tick().tasks.map(t => t.status)).toEqual(["failed", "cancelled", "interrupted"]);
        expect(h.tick().phase).toBe("idle");
    });

    it("does not wait on hung RPCs, retry behind them, or publish their late result", async () => {
        vi.useFakeTimers();
        let release;
        const h = harness({ list: vi.fn(() => new Promise(resolve => { release = resolve; })) }, { timeoutMs: 20 });
        h.start();
        await vi.advanceTimersByTimeAsync(321);
        for (let i = 0; i < 100; i++) h.emit("session.background_tasks_changed");
        await vi.advanceTimersByTimeAsync(1_000);
        expect(h.rpc.list).toHaveBeenCalledTimes(1);
        h.observer.finish();
        const count = h.events.length;
        release({ tasks: [{ type: "agent", id: "agent", toolCallId: "call", status: "running" }] });
        await vi.advanceTimersByTimeAsync(1_000);
        expect(h.events).toHaveLength(count);
        expect(h.rpc.getProgress).not.toHaveBeenCalled();
    });

    it("does not overlap registry batches when one progress RPC fails and another hangs", async () => {
        vi.useFakeTimers();
        const h = harness({ list: vi.fn(async () => ({ tasks: [
            { type: "agent", id: "agent", toolCallId: "call", status: "running" },
            { type: "agent", id: "other-agent", toolCallId: "other-call", status: "running" },
        ] })), getProgress: vi.fn(({ id }) => id === "agent" ? Promise.reject(new Error("failed")) : new Promise(() => {})) }, { timeoutMs: 1_000 });
        h.start();
        h.start("other-call", "other-agent");
        await vi.advanceTimersByTimeAsync(300);
        h.emit("session.background_tasks_changed");
        await vi.advanceTimersByTimeAsync(1_500);
        expect(h.rpc.list).toHaveBeenCalledTimes(1);
        expect(h.rpc.getProgress).toHaveBeenCalledTimes(2);
        h.observer.finish();
    });

    it("survives registry failure and bounds escaped payload bytes", async () => {
        vi.useFakeTimers();
        const h = harness({ list: async () => { throw new Error("not implemented"); } });
        for (let i = 0; i < 40; i++) {
            h.start(`call-${i}`, `agent-${i}`);
            h.emit("tool.execution_complete", { toolName: "task", toolCallId: `call-${i}`, success: true, result: "\u0000".repeat(20_000) });
        }
        await vi.advanceTimersByTimeAsync(500);
        h.observer.finish();
        expect(h.tick().truncated).toBe(true);
        expect(Buffer.byteLength(JSON.stringify(h.tick()))).toBeLessThanOrEqual(240_000);
        expect(h.summaries().at(-1).result.length).toBe(4_096);
    });
});
