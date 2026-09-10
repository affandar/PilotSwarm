import { expect, it } from "vitest";
import { NativeTaskObserver } from "../../src/native-task-observer.ts";

it("keeps the successful invocation's duration after a later cleanup completion", () => {
    const events = [];
    const observer = new NativeTaskObserver({ rpc: { tasks: { list: async () => ({ tasks: [] }) } } }, { emit: e => events.push(e) });
    const emit = (type, data) => observer.observe({ type, data, agentId: "agent", timestamp: "2026-09-08T00:00:00Z" });
    emit("subagent.started", { toolCallId: "call", agentName: "swarm-explore" });
    emit("subagent.completed", { toolCallId: "call", durationMs: 500, totalToolCalls: 7 });
    emit("subagent.completed", { toolCallId: "call", cancelled: true, durationMs: 1000, totalToolCalls: 7 });
    observer.finish();
    const task = events.filter(e => e.eventType === "session.native_tasks_tick").at(-1).data.tasks[0];
    expect(task.status).toBe("completed");
    expect(task.durationMs).toBe(500);
});
