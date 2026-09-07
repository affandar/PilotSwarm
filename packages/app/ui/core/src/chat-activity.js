import { formatTimestamp } from "./formatting.js";

// Only user-relevant calls belong in the conversation. Diagnostics (including
// empty-response notices) remain in Activity. These types also survive paging.
export const CHAT_CALL_EVENT_TYPES = [
    "tool.execution_start", "tool.execution_complete",
    "tool.execution_partial_result", "tool.execution_progress",
    "external_tool.requested", "external_tool.completed",
    "session.agent_spawned",
];
const callTypes = new Set(CHAT_CALL_EVENT_TYPES);
const agentTools = /(?:^|[.:/])(?:spawn_agent|message_agent|send_message|send_session_message|reply_session_message|wait_for_agents|check_agents|complete_agent|cancel_agent|delete_agent|list_agents)$/;

export function callText(value) {
    if (typeof value === "string") return value;
    if (value == null) return "";
    try { return JSON.stringify(value, null, 2); } catch { return String(value); }
}

export function firstCallLine(value) {
    return callText(value).split(/\r?\n/).find(line => line.trim())?.trim() || "";
}

function argumentPreview(args) {
    if (!args || typeof args !== "object") return firstCallLine(args);
    // Prefer the human instruction/command over JSON's opening brace.
    for (const key of ["command", "cmd", "task", "message", "prompt", "subject", "body", "query", "path", "reason", "agent_ids", "agent_id"]) {
        if (args[key] != null) return firstCallLine(typeof args[key] === "object" ? JSON.stringify(args[key]) : args[key]);
    }
    return Object.entries(args).map(([key, value]) => `${key}: ${typeof value === "object" ? JSON.stringify(value) : value}`).join(" · ").split(/\r?\n/)[0];
}

/** Update one disclosure in place; never coalesce distinct calls by text. */
export function appendChatCall(chat, event) {
    if (!callTypes.has(event?.eventType)) return false;
    const data = event.data || {};
    const namespace = `${event.sessionId}:${data.durableSessionId || ""}`;
    const keys = [data.toolCallId && `call:${data.toolCallId}`, data.requestId && `request:${data.requestId}`].filter(Boolean);
    const spawned = event.eventType === "session.agent_spawned";
    if (spawned) keys.push(`spawn:${event.seq}`);
    const index = keys.length ? chat.findIndex(item => item.kind === "chat-call" && item.namespace === namespace && item.callKeys.some(key => keys.includes(key))) : -1;
    const previous = index >= 0 ? chat[index] : null;
    // SDK external completion only dismisses its request UI. Without the
    // request or execution event there is no meaningful call to display.
    if (!previous && event.eventType === "external_tool.completed") return true;
    const name = spawned ? "Agent started" : data.toolName || data.name || previous?.name || "Tool call";
    const args = data.arguments ?? data.args ?? previous?.arguments;
    const complete = event.eventType === "tool.execution_complete";
    const failed = complete && (data.success === false || Boolean(data.error));
    const item = {
        ...previous,
        id: previous?.id || `${namespace}:tool:${keys[0] || `event:${event.seq}`}`,
        kind: "chat-call", role: "tool", namespace,
        callKeys: [...new Set([...(previous?.callKeys || []), ...keys])],
        name, arguments: args,
        category: spawned || agentTools.test(name) ? "Agent" : "Tool",
        text: spawned ? firstCallLine(data.task) : argumentPreview(args) || previous?.text || "",
        time: previous?.time || formatTimestamp(event.createdAt),
        createdAt: previous?.createdAt || new Date(event.createdAt).getTime(),
        status: complete ? (failed ? "Failed" : "Done") : previous?.status || (spawned ? "Started" : "Called"),
    };
    if (complete) {
        item.result = data.result ?? data.output;
        item.error = data.error;
        item.partial = "";
        item.progress = "";
    } else if (item.status === "Called") {
        if (event.eventType === "tool.execution_partial_result" && previous?.lastPartialSeq !== event.seq) {
            item.partial = `${previous?.partial || ""}${data.partialOutput || ""}`;
            item.lastPartialSeq = event.seq;
        }
        if (data.progressMessage) item.progress = data.progressMessage;
    }
    if (spawned) item.result = { childSessionId: data.childSessionId, agentId: data.agentId, task: data.task };
    if (index >= 0) chat[index] = item;
    else chat.push(item);
    return true;
}

export function chatCallLine(item) {
    const sections = [
        item.arguments !== undefined ? `Arguments\n${callText(item.arguments)}` : "",
        item.progress ? `Progress\n${item.progress}` : "",
        item.partial ? `Output\n${item.partial}` : "",
        item.result !== undefined ? `Result\n${callText(item.result)}` : "",
        item.error ? `Error\n${callText(item.error)}` : "",
    ].filter(Boolean);
    return {
        kind: "chatCall", callKey: item.id, category: item.category,
        text: `${item.name}${item.text ? ` — ${item.text}` : ""}`,
        body: sections.join("\n\n") || "Call recorded; no output has been recorded yet.",
        status: item.status, time: item.time,
    };
}
