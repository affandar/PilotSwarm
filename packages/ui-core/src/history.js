import { formatTimestamp, shortSessionId, stripTerminalMarkupTags, summarizeJson } from "./formatting.js";
import { formatCompactionActivityRuns } from "./context-usage.js";

export const DEFAULT_HISTORY_EVENT_LIMIT = 300;
export const HISTORY_EVENT_LIMIT_STEPS = [
    DEFAULT_HISTORY_EVENT_LIMIT,
    1_000,
    3_000,
    10_000,
];

function clampHistoryItems(items, maxItems) {
    const list = Array.isArray(items) ? items.filter(Boolean) : [];
    const safeMax = Math.max(DEFAULT_HISTORY_EVENT_LIMIT, Number(maxItems) || DEFAULT_HISTORY_EVENT_LIMIT);
    return list.length > safeMax ? list.slice(-safeMax) : list;
}

function normalizeMessageText(text) {
    return String(text || "").replace(/\r\n/g, "\n").trim();
}

export function parseAskedAndAnsweredExchange(text) {
    const source = String(text || "").replace(/\r\n/g, "\n").trim();
    const prefix = 'The user was asked: "';
    const marker = '"\nThe user responded: "';

    if (!source.startsWith(prefix) || !source.endsWith('"')) return null;
    const markerIndex = source.indexOf(marker, prefix.length);
    if (markerIndex === -1) return null;

    const question = source.slice(prefix.length, markerIndex);
    const answer = source.slice(markerIndex + marker.length, -1);
    if (!question.trim() || !answer.trim()) return null;
    return { question, answer };
}

function hasVisibleMessageText(text) {
    return normalizeMessageText(stripTerminalMarkupTags(text)).length > 0;
}

function isInternalSystemLikeText(text) {
    const normalized = normalizeMessageText(text);
    if (!normalized) return false;

    return /^\[SYSTEM:/i.test(normalized)
        || /^\[CHILD_UPDATE\b/i.test(normalized)
        || /^Sub-agent spawned successfully\./i.test(normalized)
        || /^Message sent to sub-agent /i.test(normalized)
        || /^No sub-agents have been spawned yet\./i.test(normalized)
        || /^Sub-agent status report \(/i.test(normalized)
        || /^Active sessions \(/i.test(normalized)
        || /^Sub-agents completed:/i.test(normalized)
        || /^Sub-agent .* has been (completed gracefully|cancelled|deleted)\./i.test(normalized)
        || /^(spawn_agent|message_agent|check_agents|wait_for_agents|complete_agent|cancel_agent|delete_agent) failed/i.test(normalized);
}

function deriveChatRole(event, fallbackRole, text) {
    if (event?.eventType === "system.message") return "system";
    if ((fallbackRole === "user" || fallbackRole === "assistant") && isInternalSystemLikeText(text)) return "system";
    return fallbackRole;
}

function areMessagesEquivalent(left, right) {
    if (!left || !right) return false;
    if (left.role !== right.role) return false;

    const leftText = normalizeMessageText(left.text);
    const rightText = normalizeMessageText(right.text);
    if (!leftText || !rightText || leftText !== rightText) return false;

    const leftTime = Number(left.createdAt || 0);
    const rightTime = Number(right.createdAt || 0);
    if (left.optimistic || right.optimistic) return true;
    if (!leftTime || !rightTime) return false;
    return Math.abs(leftTime - rightTime) <= 5_000;
}

export function dedupeChatMessages(chat = []) {
    const deduped = [];

    for (const message of chat) {
        if (!message) continue;
        const previous = deduped[deduped.length - 1];
        if (!areMessagesEquivalent(previous, message)) {
            deduped.push(message);
            continue;
        }

        if (previous?.optimistic && !message?.optimistic) {
            deduped[deduped.length - 1] = message;
            continue;
        }
        if (!previous?.optimistic && message?.optimistic) {
            continue;
        }

        const previousTime = Number(previous?.createdAt || 0);
        const currentTime = Number(message?.createdAt || 0);
        deduped[deduped.length - 1] = currentTime >= previousTime ? message : previous;
    }

    return deduped;
}

function buildChatMessage(event, role) {
    const text = String(messageTextFromEvent(event) || "").replace(/\r\n/g, "\n");
    if (!hasVisibleMessageText(text)) return null;
    return {
        id: `${event.sessionId}:${event.seq}`,
        role: deriveChatRole(event, role, text),
        text,
        time: formatTimestamp(event.createdAt),
        createdAt: event.createdAt instanceof Date ? event.createdAt.getTime() : new Date(event.createdAt).getTime(),
    };
}

function reconcileOptimisticMessage(chat, incomingMessage) {
    if (!Array.isArray(chat) || incomingMessage?.role !== "user") {
        return [...(chat || [])];
    }

    const normalizedIncoming = normalizeMessageText(incomingMessage.text);
    const parsedExchange = parseAskedAndAnsweredExchange(incomingMessage.text);
    const normalizedAnsweredText = parsedExchange ? normalizeMessageText(parsedExchange.answer) : "";
    let removed = false;

    return chat.filter((message) => {
        if (removed) return true;
        if (!message?.optimistic || message.role !== incomingMessage.role) return true;
        const normalizedMessageText = normalizeMessageText(message.text);
        if (normalizedMessageText !== normalizedIncoming && normalizedMessageText !== normalizedAnsweredText) return true;
        removed = true;
        return false;
    });
}

function messageTextFromEvent(event) {
    const data = event?.data;
    if (typeof data === "string") return data;
    if (data && typeof data === "object") {
        if (typeof data.content === "string") return data.content;
        if (typeof data.text === "string") return data.text;
        if (typeof data.message === "string") return data.message;
        if (typeof data.question === "string") return data.question;
    }
    return summarizeJson(data);
}

function flattenRunsText(runs) {
    return (runs || []).map((run) => run?.text || "").join("");
}

function summarizeActivityPreview(text, maxLen = 120) {
    const compact = String(text || "")
        .replace(/\s+/g, " ")
        .trim();
    if (!compact) return "";
    return compact.length > maxLen
        ? `${compact.slice(0, maxLen - 3)}...`
        : compact;
}

function joinUniqueActivityDetail(parts = []) {
    const seen = new Set();
    const normalized = [];
    for (const part of parts) {
        const text = String(part || "").trim();
        if (!text) continue;
        const key = text.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        normalized.push(text);
    }
    return normalized.join(" | ");
}

function formatDehydrationActivityDetail(event, fallbackBody = "") {
    return joinUniqueActivityDetail([
        event?.data?.reason,
        event?.data?.detail,
        event?.data?.message,
        event?.data?.error,
        fallbackBody,
    ]);
}

function formatLossyHandoffActivityDetail(event, fallbackBody = "") {
    return joinUniqueActivityDetail([
        event?.data?.message,
        event?.data?.detail,
        event?.data?.error,
        fallbackBody,
    ]);
}

function formatToolArgValue(value) {
    if (value == null) return "null";
    if (typeof value === "string") {
        return JSON.stringify(value.length > 32 ? `${value.slice(0, 29)}...` : value);
    }
    if (typeof value === "number" || typeof value === "boolean") return String(value);
    if (Array.isArray(value)) return `[${value.length}]`;
    if (typeof value === "object") return "{...}";
    return String(value);
}

function formatToolArgsSummary(toolName, args) {
    if (!args || typeof args !== "object") return "";

    if (toolName === "wait") {
        const seconds = args.seconds != null ? `${args.seconds}s` : "?";
        const preserve = args.preserveWorkerAffinity === true ? " preserve=true" : "";
        const reason = typeof args.reason === "string" && args.reason
            ? ` reason=${JSON.stringify(args.reason)}`
            : "";
        return ` ${seconds}${preserve}${reason}`;
    }

    if (toolName === "cron") {
        if (args.action === "cancel") return " cancel";
        const seconds = args.seconds != null ? `${args.seconds}s` : "?";
        const reason = typeof args.reason === "string" && args.reason
            ? ` reason=${JSON.stringify(args.reason)}`
            : "";
        return ` ${seconds}${reason}`;
    }

    const entries = Object.entries(args)
        .slice(0, 4)
        .map(([key, value]) => `${key}=${formatToolArgValue(value)}`);
    if (entries.length === 0) return "";
    const suffix = Object.keys(args).length > entries.length ? ", ..." : "";
    return ` ${entries.join(", ")}${suffix}`;
}

function buildActivityPrefix(time) {
    return time ? [{ text: `[${time}] `, color: "white" }] : [];
}

function buildLabeledActivityRuns(time, label, labelColor, detail = "", detailColor = "white") {
    return [
        ...buildActivityPrefix(time),
        { text: label, color: labelColor },
        ...(detail ? [{ text: ` ${detail}`, color: detailColor }] : []),
    ];
}

function formatEventSnippet(event, maxLen = 96) {
    const body = summarizeActivityPreview(stripTerminalMarkupTags(messageTextFromEvent(event)), maxLen);
    return body || "";
}

function formatToolActivityRuns(time, event, phase = "start") {
    const toolName = event?.data?.toolName || event?.data?.name || "tool";
    const args = event?.data?.arguments || event?.data?.args;
    const durableSessionId = event?.data?.durableSessionId;
    const summary = formatToolArgsSummary(toolName, args);

    return [
        ...buildActivityPrefix(time),
        {
            text: phase === "start" ? `▶ ${toolName}${summary}` : `✓ ${toolName}`,
            color: phase === "start" ? "yellow" : "green",
        },
        ...(durableSessionId
            ? [{ text: ` [${shortSessionId(durableSessionId)}]`, color: "gray" }]
            : []),
    ];
}

function formatActivity(event) {
    const time = formatTimestamp(event.createdAt);
    const body = formatEventSnippet(event);
    let runs = null;

    switch (event.eventType) {
        case "assistant.usage":
        case "session.info":
        case "session.idle":
        case "session.usage_info":
        case "pending_messages.modified":
        case "abort":
        case "assistant.turn_end":
            return null;

        case "tool.execution_start":
            runs = formatToolActivityRuns(time, event, "start");
            break;

        case "tool.execution_complete":
            runs = formatToolActivityRuns(time, event, "complete");
            break;

        case "assistant.reasoning":
            runs = buildLabeledActivityRuns(time, "[reasoning]", "gray", body || "…", "white");
            break;

        case "assistant.turn_start":
            runs = buildLabeledActivityRuns(time, "[turn start]", "gray", body);
            break;

        case "session.turn_completed":
            runs = buildLabeledActivityRuns(
                time,
                "[turn completed]",
                "gray",
                event?.data?.iteration != null ? `iter ${event.data.iteration}` : body,
            );
            break;

        case "session.lossy_handoff":
            runs = buildLabeledActivityRuns(
                time,
                "[lossy handoff]",
                "red",
                formatLossyHandoffActivityDetail(event, body) || "handoff to a new worker",
            );
            break;

        case "session.dehydrated":
            runs = buildLabeledActivityRuns(
                time,
                "[dehydrated]",
                "red",
                formatDehydrationActivityDetail(event, body),
            );
            break;

        case "session.hydrated":
        case "session.rehydrated":
            runs = buildLabeledActivityRuns(time, "[rehydrated]", "green", body);
            break;

        case "session.wait_started": {
            const seconds = event?.data?.seconds != null ? `${event.data.seconds}s` : "?";
            const reason = typeof event?.data?.reason === "string" && event.data.reason
                ? ` reason=${JSON.stringify(event.data.reason)}`
                : "";
            const preserve = event?.data?.preserveAffinity ? " preserve=true" : "";
            runs = buildLabeledActivityRuns(time, "[wait]", "yellow", `${seconds}${preserve}${reason}`.trim());
            break;
        }

        case "session.input_required_started":
            runs = buildLabeledActivityRuns(time, "[input]", "yellow", body);
            break;

        case "session.agent_spawned":
            runs = buildLabeledActivityRuns(
                time,
                "[spawn]",
                "cyan",
                event?.data?.agentId || shortSessionId(event?.data?.childSessionId),
                "white",
            );
            break;

        case "session.cron_started":
            runs = buildLabeledActivityRuns(
                time,
                "[cron]",
                "magenta",
                `started${event?.data?.seconds != null ? ` ${event.data.seconds}s` : ""}${event?.data?.reason ? ` reason=${JSON.stringify(event.data.reason)}` : ""}`,
            );
            break;

        case "session.cron_fired":
            runs = buildLabeledActivityRuns(
                time,
                "[cron]",
                "magenta",
                `fired${event?.data?.reason ? ` reason=${JSON.stringify(event.data.reason)}` : ""}`,
            );
            break;

        case "session.cron_cancelled":
            runs = buildLabeledActivityRuns(
                time,
                "[cron]",
                "magenta",
                `cancelled${event?.data?.reason ? ` reason=${JSON.stringify(event.data.reason)}` : ""}`,
            );
            break;

        case "session.command_received":
            runs = buildLabeledActivityRuns(
                time,
                "[command]",
                "magenta",
                `/${event?.data?.cmd || "?"}${body ? ` ${body}` : ""}`,
            );
            break;

        case "session.command_completed":
            runs = buildLabeledActivityRuns(
                time,
                "[command]",
                "magenta",
                `/${event?.data?.cmd || "?"} ok${body ? ` ${body}` : ""}`,
            );
            break;

        case "session.compaction_start":
        case "session.compaction_complete":
            runs = formatCompactionActivityRuns(time, event.eventType, event.data || {});
            break;

        case "session.error":
            runs = buildLabeledActivityRuns(time, "[error]", "red", body || "session error", "white");
            break;

        default:
            runs = [
                ...buildActivityPrefix(time),
                { text: `[${event.eventType}]`, color: "gray" },
                ...(body ? [{ text: ` ${body}`, color: "white" }] : []),
            ];
            break;
    }

    return {
        id: `${event.sessionId}:${event.seq}`,
        eventType: event.eventType,
        time,
        text: flattenRunsText(runs),
        line: runs,
    };
}

export function getNextHistoryEventLimit(currentLimit = DEFAULT_HISTORY_EVENT_LIMIT) {
    const safeCurrent = Math.max(DEFAULT_HISTORY_EVENT_LIMIT, Number(currentLimit) || DEFAULT_HISTORY_EVENT_LIMIT);
    const nextLimit = HISTORY_EVENT_LIMIT_STEPS.find((limit) => limit > safeCurrent);
    return nextLimit || Math.min(100_000, safeCurrent * 2);
}

export function buildHistoryModel(events = [], options = {}) {
    const requestedLimit = Math.max(
        DEFAULT_HISTORY_EVENT_LIMIT,
        Number(options.requestedLimit ?? options.eventLimit ?? DEFAULT_HISTORY_EVENT_LIMIT) || DEFAULT_HISTORY_EVENT_LIMIT,
    );
    const chat = [];
    const activity = [];
    const storedEvents = [];

    for (const event of events) {
        storedEvents.push(event);
        if (event.eventType === "user.message") {
            const message = buildChatMessage(event, "user");
            if (message) chat.push(message);
            continue;
        }
        if (event.eventType === "assistant.message") {
            const message = buildChatMessage(event, "assistant");
            if (message) chat.push(message);
            continue;
        }
        if (event.eventType === "system.message") {
            const message = buildChatMessage(event, "system");
            if (message) chat.push(message);
            continue;
        }
        const activityItem = formatActivity(event);
        if (activityItem) activity.push(activityItem);
    }

    return {
        chat: dedupeChatMessages(chat),
        activity,
        events: storedEvents.slice(-requestedLimit),
        loadedEventLimit: requestedLimit,
        loadedEventCount: storedEvents.length,
        hasOlderEvents: storedEvents.length >= requestedLimit,
    };
}

export function appendEventToHistory(history, event) {
    const existingEvents = Array.isArray(history?.events) ? history.events : [];
    const loadedEventLimit = Math.max(
        DEFAULT_HISTORY_EVENT_LIMIT,
        Number(history?.loadedEventLimit ?? DEFAULT_HISTORY_EVENT_LIMIT) || DEFAULT_HISTORY_EVENT_LIMIT,
    );
    const nextEvents = existingEvents.length > 0 && existingEvents[existingEvents.length - 1]?.seq === event?.seq
        ? existingEvents
        : [...existingEvents, event].slice(-loadedEventLimit);
    const next = {
        chat: clampHistoryItems(history?.chat || [], loadedEventLimit),
        activity: clampHistoryItems(history?.activity || [], loadedEventLimit),
        events: nextEvents,
        lastSeq: event.seq,
        loadedEventLimit,
        loadedEventCount: Math.max(Number(history?.loadedEventCount || 0), nextEvents.length),
        hasOlderEvents: Boolean(history?.hasOlderEvents),
    };

    if (event.eventType === "user.message") {
        const message = buildChatMessage(event, "user");
        if (!message) return next;
        next.chat = reconcileOptimisticMessage(next.chat, message);
        next.chat.push(message);
        next.chat = clampHistoryItems(dedupeChatMessages(next.chat), loadedEventLimit);
        return next;
    }
    if (event.eventType === "assistant.message") {
        const message = buildChatMessage(event, "assistant");
        if (!message) return next;
        next.chat.push(message);
        next.chat = clampHistoryItems(dedupeChatMessages(next.chat), loadedEventLimit);
        return next;
    }
    if (event.eventType === "system.message") {
        const message = buildChatMessage(event, "system");
        if (!message) return next;
        next.chat.push(message);
        next.chat = clampHistoryItems(dedupeChatMessages(next.chat), loadedEventLimit);
        return next;
    }
    const activityItem = formatActivity(event);
    if (activityItem) {
        next.activity.push(activityItem);
        next.activity = clampHistoryItems(next.activity, loadedEventLimit);
    }
    return next;
}

export function createSplashCard(branding) {
    if (!branding?.splash) return [];
    const title = branding.title || "PilotSwarm";
    const hint = "{gray-fg}Start interacting with this session to replace the splash screen.{/gray-fg}";
    return [{
        id: `splash:${title}`,
        role: "system",
        text: `${branding.splash}\n\n${hint}`,
        time: "",
        splash: true,
    }];
}

export function buildSessionLabel(session) {
    const title = session.title || shortSessionId(session.sessionId);
    const shortId = shortSessionId(session.sessionId);
    return title.includes(shortId) ? title : `${title} (${shortId})`;
}
