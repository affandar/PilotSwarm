import { appendChatCall, CHAT_CALL_EVENT_TYPES } from "./chat-activity.js";

// Native Copilot work is local to one parent turn. Durable spawn_agent
// sessions deliberately do not enter this projection.
const TERMINAL = new Set(["completed", "failed", "cancelled", "interrupted"]);
const clip = (value, max = 240) => typeof value === "string" ? value.trim().slice(0, max) : "";
const timeMs = value => {
    const ms = typeof value === "number" ? value : new Date(value).getTime();
    return Number.isFinite(ms) && ms > 0 ? ms : null;
};
const resultText = value => typeof value === "string" ? value
    : value?.detailedContent || value?.content || value?.textResultForLlm || value?.message || value?.error?.message || "";

export const NATIVE_TASK_LABELS = {
    starting: "Starting", running: "Running", waiting: "Waiting", completed: "Done",
    failed: "Failed", cancelled: "Cancelled", interrupted: "Interrupted",
};

function findTask(chat, task) {
    for (let groupIndex = chat.length - 1; groupIndex >= 0; groupIndex--) {
        const group = chat[groupIndex];
        if (group.kind !== "native-task-group") continue;
        const taskIndex = group.tasks.findLastIndex(item =>
            (task.toolCallId && item.toolCallId === task.toolCallId)
            || (task.agentId && item.agentId === task.agentId && (!task.toolCallId || !item.toolCallId))
            || (task.id && item.id === task.id));
        if (taskIndex >= 0) return { groupIndex, taskIndex };
    }
    return null;
}

function updateTask(chat, patch, event, { authoritative = false } = {}) {
    const match = findTask(chat, patch);
    const previous = match ? chat[match.groupIndex].tasks[match.taskIndex] : null;
    if (previous?.ownerId && patch.ownerId && previous.ownerId !== patch.ownerId) return;
    if (patch.revision != null && previous?.revision != null && patch.revision < previous.revision) return;
    const next = {
        id: patch.toolCallId || patch.agentId || patch.id,
        title: "Native task", status: "starting", toolCalls: 0,
        startedAt: timeMs(patch.startedAt) || timeMs(event.createdAt),
        ...previous,
        ...Object.fromEntries(Object.entries(patch).filter(([,value]) => value !== undefined)),
        telemetryStale: false,
    };
    if (!next.id) return;
    next.id = previous?.id || next.id;
    next.startedAt = previous?.startedAt || timeMs(patch.startedAt) || timeMs(event.createdAt);
    next.completedAt = timeMs(next.completedAt);
    // Cleanup and late progress must not replace a confirmed outcome. A
    // cancelled:true completion is handled before it becomes terminal.
    if (previous && TERMINAL.has(previous.status)
        && (!previous.inferredTerminal || !TERMINAL.has(patch.status))) {
        next.status = previous.status;
        next.error = previous.error;
        next.completedAt = previous.completedAt;
        next.durationMs = previous.durationMs;
        if (!TERMINAL.has(patch.status) || patch.status === "cancelled") next.toolCalls = previous.toolCalls;
        if (!patch.result && !patch.error) next.preview = previous.preview;
    } else if (TERMINAL.has(patch.status) && !patch.inferredTerminal) {
        next.inferredTerminal = false;
        // A late real outcome replaces the explanatory text of an inferred
        // interruption, rather than displaying that stale error under Done.
        if (previous?.inferredTerminal) next.error = patch.error || "";
    }
    next.title = clip(next.title, 160) || "Native task";
    if (next.title === "Native task" && previous?.title) next.title = previous.title;
    next.preview = clip(next.preview);
    next.result = clip(next.result, 4000);
    next.error = clip(next.error, 1000);
    next.toolCalls = Math.max(Number(previous?.toolCalls) || 0, Number(next.toolCalls) || 0);
    next.recentActivity = Array.isArray(next.recentActivity)
        ? next.recentActivity.slice(-5).map(a => ({ message: clip(a.message), timestamp: a.timestamp })) : [];
    if (match) {
        const group = chat[match.groupIndex];
        const tasks = [...group.tasks];
        tasks[match.taskIndex] = next;
        chat[match.groupIndex] = { ...group, tasks };
        return;
    }
    // A retained snapshot can arrive after newer chat. Insert at its original
    // start time instead of attaching it permanently to the transcript tail.
    const later = next.startedAt ? chat.findIndex(item => Number(item.createdAt) > next.startedAt) : -1;
    const insertion = later < 0 ? chat.length : later;
    const prior = chat[insertion - 1];
    if (prior?.kind === "native-task-group" && prior.tasks.length < 32) {
        chat[insertion - 1] = { ...prior, tasks: [...prior.tasks, next] };
    } else {
        chat.splice(insertion, 0, {
            id: `native-tasks:${event.sessionId}:${next.id}`, kind: "native-task-group", role: "system",
            createdAt: next.startedAt, tasks: [next],
        });
    }
}

// Correlate by runtime identity, never by tool name or arrival time. External
// callbacks may arrive before the child event; move that existing disclosure
// under its owner as soon as the explicit relationship becomes available.
export function appendNativeTaskCall(chat, event) {
    const type = (event?.eventType || "").replace(/^native\./, "");
    if (!CHAT_CALL_EVENT_TYPES.includes(type) || type === "session.agent_spawned") return false;
    const data = event.data || {};
    const explicit = Boolean(data.nativeAgentId || data.parentToolCallId || event.eventType.startsWith("native."));
    const keys = [data.toolCallId && `call:${data.toolCallId}`, data.requestId && `request:${data.requestId}`].filter(Boolean);
    let match = explicit ? findTask(chat, { toolCallId: data.parentToolCallId, agentId: data.nativeAgentId }) : null;
    const namespace = `${event.sessionId}:${data.durableSessionId || ""}`;
    if (!match && !explicit) {
        for (let g = chat.length - 1; g >= 0 && !match; g--) {
            if (chat[g].kind !== "native-task-group") continue;
            const t = chat[g].tasks.findIndex(task => task.calls?.some(call => call.namespace === namespace
                && call.callKeys.some(key => keys.includes(key))));
            if (t >= 0) match = { groupIndex: g, taskIndex: t };
        }
    }
    if (!match && explicit && (data.parentToolCallId || data.nativeAgentId)) {
        updateTask(chat, { toolCallId: data.parentToolCallId, agentId: data.nativeAgentId, status: "running" }, event);
        match = findTask(chat, { toolCallId: data.parentToolCallId, agentId: data.nativeAgentId });
    }
    if (!match) return explicit; // Unknown child activity must not impersonate the parent.
    const group = chat[match.groupIndex];
    const task = group.tasks[match.taskIndex];
    const calls = [...(task.calls || [])];
    for (let i = chat.length - 1; i >= 0; i--) {
        const call = chat[i];
        if (call.kind !== "chat-call" || call.namespace !== namespace || !call.callKeys.some(key => keys.includes(key))) continue;
        if (!calls.some(item => item.callKeys.some(key => call.callKeys.includes(key)))) calls.push(call);
        chat.splice(i, 1);
    }
    appendChatCall(calls, { ...event, eventType: type });
    const tasks = [...group.tasks];
    tasks[match.taskIndex] = { ...task, calls, toolCalls: Math.max(task.toolCalls || 0, calls.length) };
    // Removing a parent disclosure can shift the group's index.
    chat[chat.indexOf(group)] = { ...group, tasks };
    return true;
}

export function appendNativeTaskEvent(chat, event) {
    const type = event?.eventType || "";
    const data = event?.data || {};
    if (type === "native.task_updated") {
        if (data.id && NATIVE_TASK_LABELS[data.status]) updateTask(chat, data, event, { authoritative: true });
        return;
    }
    if (type === "session.turn_completed" || type === "session.turn_stopped") {
        for (let i = 0; i < chat.length; i++) {
            if (chat[i].kind !== "native-task-group") continue;
            chat[i] = { ...chat[i], tasks: chat[i].tasks.map(task => TERMINAL.has(task.status) ? task : {
                ...task, status: "interrupted", inferredTerminal: true, completedAt: timeMs(event.createdAt),
                error: type === "session.turn_stopped" ? "The parent turn was stopped." : "The parent turn ended before a task result was confirmed.",
            }) };
        }
        return;
    }
    const lifecycle = type.startsWith("subagent.");
    const child = type.startsWith("native.");
    const taskTool = !child && !data.nativeAgentId && (data.toolName || data.name) === "task"
        && ["tool.execution_start", "tool.execution_complete"].includes(type);
    if (!lifecycle && !child && !taskTool) return;
    const args = data.arguments || data.args || {};
    const toolCallId = child ? data.parentToolCallId : data.toolCallId;
    const agentId = data.nativeAgentId || data.agentId;
    const patch = { toolCallId, agentId };
    const found = findTask(chat, patch);
    const previous = found ? chat[found.groupIndex].tasks[found.taskIndex] : null;
    if (!previous && !lifecycle && !taskTool) return;
    if (!previous || taskTool || type === "subagent.started") Object.assign(patch, {
        title: args.description || args.name || (previous?.title !== "Native task" ? previous?.title : null) || data.agentDisplayName || "Native task",
        profile: args.agent_type || data.agentName || data.agentType,
        model: data.model,
    });
    if (type === "subagent.configured") {
        Object.assign(patch, { model: data.model, reasoningEffort: data.reasoningEffort });
    } else if (type === "subagent.started") {
        patch.status = "running";
    } else if (type === "subagent.completed" || type === "subagent.failed") {
        Object.assign(patch, {
            status: data.cancelled ? "cancelled" : type === "subagent.failed" ? "failed" : "completed",
            completedAt: event.createdAt, durationMs: data.durationMs, toolCalls: data.totalToolCalls,
            ...(data.cancelled ? { error: "Task was cancelled before returning a result." }
                : type === "subagent.failed" ? { error: clip(resultText(data.error) || data.message || "Native task failed.", 1000) } : {}),
        });
    } else if (type === "tool.execution_start") {
        patch.status = "starting";
    } else if (type === "tool.execution_complete") {
        const failed = data.success === false || data.result?.success === false || Boolean(data.error)
            || ["failure", "failed", "rejected", "denied"].includes(data.result?.resultType ?? data.resultType);
        const text = resultText(data.result) || resultText(data.error);
        Object.assign(patch, { status: failed ? "failed" : "completed", completedAt: event.createdAt,
            ...(failed ? { error: clip(text, 1000) || "Native task request failed." } : { result: clip(text, 4000) }) });
    } else if (type === "native.tool.execution_start") {
        const ids = previous.toolCallIds || [];
        patch.toolCallIds = data.toolCallId && !ids.includes(data.toolCallId) ? [...ids, data.toolCallId].slice(-500) : ids;
        patch.toolCalls = Math.max(previous.toolCalls || 0, patch.toolCallIds.length);
        patch.preview = args.description || (data.toolName ? `Using ${data.toolName}` : "Working");
    } else if (type === "native.assistant.message") {
        // Do not expose reasoning, tool arguments, or the whole child transcript.
        patch.preview = clip(data.content);
    } else return;
    updateTask(chat, patch, event);
}

export function applyNativeTaskSnapshot(history, payload, meta = {}) {
    if (payload?.phase === "unavailable" && history) return { ...history,
        nativeTaskSnapshot: history.nativeTaskSnapshot ? { ...history.nativeTaskSnapshot, liveSeq: undefined } : undefined,
        chat: history.chat.map(group => group.kind !== "native-task-group" ? group : { ...group,
            tasks: group.tasks.map(task => TERMINAL.has(task.status) ? task : { ...task, telemetryStale: true }) }) };
    if (payload?.version !== 1 || !Array.isArray(payload.tasks) || !payload.ownerId) return history;
    const current = history || { chat: [], activity: [], events: [], lastSeq: 0 };
    const latest = current.nativeTaskSnapshot;
    const newestRecordedOwner = Math.max(0, ...current.chat
        .filter(group => group.kind === "native-task-group")
        .flatMap(group => group.tasks.map(task => Number(task.ownerStartedAt) || 0)));
    // The retained live row can belong to an old publisher that finished
    // writing after a newer turn. On reconnect, durable summary owners fence
    // that row even when this viewer has not received a live snapshot yet.
    if (Number.isFinite(payload.ownerStartedAt) && payload.ownerStartedAt < newestRecordedOwner) {
        if (latest?.ownerStartedAt >= newestRecordedOwner) return current;
        return { ...current, chat: current.chat.map(group => group.kind !== "native-task-group" ? group : { ...group,
            tasks: group.tasks.map(task => !TERMINAL.has(task.status) && task.ownerStartedAt === newestRecordedOwner
                ? { ...task, telemetryStale: true } : task) }) };
    }
    if (Number.isFinite(latest?.ownerStartedAt) && Number.isFinite(payload.ownerStartedAt)
        && payload.ownerStartedAt < latest.ownerStartedAt) return current;
    if (latest?.ownerId === payload.ownerId && latest.revision >= payload.revision) return current;
    if (latest?.ownerId === payload.ownerId && Number.isFinite(meta.seq)
        && Number.isFinite(latest?.liveSeq) && meta.seq <= latest.liveSeq) return current;
    const chat = [...current.chat];
    for (const task of payload.tasks.slice(0, 32)) {
        if (!task?.id || !NATIVE_TASK_LABELS[task.status]) continue;
        const ended = current.events?.some(e => ["session.turn_completed", "session.turn_stopped"].includes(e.eventType)
            && timeMs(e.createdAt) > timeMs(task.startedAt));
        const patch = { ...task, ownerId: payload.ownerId, ownerStartedAt: payload.ownerStartedAt, revision: payload.revision };
        if (ended && !TERMINAL.has(patch.status)) {
            patch.status = "interrupted";
            patch.inferredTerminal = true;
            patch.error = "The parent turn ended before a task result was confirmed.";
        }
        updateTask(chat, patch, { sessionId: meta.sessionId, createdAt: task.startedAt }, { authoritative: true });
    }
    return { ...current, chat, nativeTaskSnapshot: { ownerId: payload.ownerId, ownerStartedAt: payload.ownerStartedAt,
        revision: payload.revision, liveSeq: meta.seq } };
}
