import { formatHumanDurationSeconds, formatTimestamp, shortSessionId, stripTerminalMarkupTags, summarizeJson } from "./formatting.js";
import { formatCompactionActivityRuns } from "./context-usage.js";
import { canonicalSystemTitle } from "./system-titles.js";

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

const REHYDRATION_NOTICE_PREFIX_RE = /^The session was dehydrated and has been rehydrated on a new worker(?: \([^)]+\))?\./i;
const REHYDRATION_NOTICE_FULL_RE = /^The session was dehydrated and has been rehydrated on a new worker(?: \([^)]+\))?\.\s*The LLM conversation history is preserved\.?/i;

export function isRehydrationNoticeText(text) {
    return REHYDRATION_NOTICE_PREFIX_RE.test(normalizeMessageText(text));
}

export function stripLeadingRehydrationNoticeText(text) {
    const normalized = String(text || "").replace(/\r\n/g, "\n").trim();
    if (!normalized) return "";

    const stripped = normalized.replace(REHYDRATION_NOTICE_FULL_RE, "").trimStart();
    if (stripped !== normalized) return stripped.trim();
    if (isRehydrationNoticeText(normalized)) {
        return normalized.replace(REHYDRATION_NOTICE_PREFIX_RE, "").trim();
    }
    return normalized;
}

function splitSystemNoticeSegments(text) {
    const lines = String(text || "").replace(/\r\n/g, "\n").split("\n");
    const segments = [];
    let textLines = [];

    function flushText() {
        if (textLines.length === 0) return;
        segments.push({
            kind: "text",
            text: textLines.join("\n"),
        });
        textLines = [];
    }

    for (let index = 0; index < lines.length;) {
        const line = lines[index];
        if (!/^\s*\[SYSTEM:/i.test(line)) {
            textLines.push(line);
            index += 1;
            continue;
        }

        const singleLineMatch = /^\s*\[SYSTEM:\s*(.*?)\]\s*$/i.exec(line);
        if (singleLineMatch) {
            flushText();
            segments.push({
                kind: "system",
                text: singleLineMatch[1].trim(),
            });
            index += 1;
            continue;
        }

        const noticeLines = [line.replace(/^\s*\[SYSTEM:\s*/i, "")];
        let closingIndex = -1;
        for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
            const closingLine = lines[cursor];
            if (closingLine.trim() === "]") {
                closingIndex = cursor;
                break;
            }

            if (/\]\s*$/.test(closingLine.trim())) {
                const closingContent = closingLine.replace(/\]\s*$/, "");
                if (closingContent.trim()) {
                    noticeLines.push(closingContent);
                }
                closingIndex = cursor;
                break;
            }

            noticeLines.push(closingLine);
        }

        if (closingIndex === -1) {
            textLines.push(line);
            index += 1;
            continue;
        }

        flushText();
        segments.push({
            kind: "system",
            text: noticeLines.join("\n").trim(),
        });
        index = closingIndex + 1;
    }

    flushText();
    return segments;
}

function extractVisibleChatText(text, role) {
    const normalized = String(text || "").replace(/\r\n/g, "\n");
    if (role === "user" || role === "assistant") {
        return splitSystemNoticeSegments(normalized)
            .filter((segment) => segment.kind === "text")
            .map((segment) => segment.text)
            .join("\n")
            .trim();
    }
    return normalized.trim();
}

function extractEmbeddedSystemNoticeTexts(text, role) {
    if (role !== "user" && role !== "assistant") return [];
    return splitSystemNoticeSegments(text)
        .filter((segment) => segment.kind === "system")
        .map((segment) => segment.text)
        .filter(Boolean);
}

function comparableMessageText(message) {
    const normalized = normalizeMessageText(message?.text || "");
    if (!normalized) return "";
    if (message?.role === "user" || message?.role === "assistant") {
        const visibleText = extractVisibleChatText(normalized, message.role);
        if (visibleText) return visibleText;
    }
    return stripLeadingRehydrationNoticeText(normalized);
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
        || /^Buffered child updates arrived /i.test(normalized)
        || /^There is an active recurring schedule every /i.test(normalized)
        || /^It remains active automatically after this turn completes/i.test(normalized)
        || /^Sub-agent spawned successfully\./i.test(normalized)
        || /^Message sent to sub-agent /i.test(normalized)
        || /^No sub-agents have been spawned yet\./i.test(normalized)
        || /^Sub-agent status report \(/i.test(normalized)
        || /^Active sessions \(/i.test(normalized)
        || /^Sub-agents completed:/i.test(normalized)
        || /^Sub-agent .* has been (completed gracefully|cancelled|deleted)\./i.test(normalized)
        || /^The runtime recovered this session after the worker lost the live Copilot session\./i.test(normalized)
        || /^The runtime recovered this session after the live Copilot session was lost on a worker\./i.test(normalized)
        || /^The runtime is replaying this turn after a worker restart/i.test(normalized)
        || /^The runtime detected missing Copilot session state for /i.test(normalized)
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

    const leftText = comparableMessageText(left);
    const rightText = comparableMessageText(right);
    if (!leftText || !rightText || leftText !== rightText) return false;

    const leftTime = Number(left.createdAt || 0);
    const rightTime = Number(right.createdAt || 0);
    if (left.optimistic || right.optimistic) return true;
    if (!leftTime || !rightTime) return false;
    return Math.abs(leftTime - rightTime) <= 10_000;
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
    const text = extractVisibleChatText(messageTextFromEvent(event), role);
    if (!hasVisibleMessageText(text)) return null;
    return {
        id: `${event.sessionId}:${event.seq}`,
        role: deriveChatRole(event, role, text),
        text,
        time: formatTimestamp(event.createdAt),
        createdAt: event.createdAt instanceof Date ? event.createdAt.getTime() : new Date(event.createdAt).getTime(),
    };
}

function shouldRenderSystemMessageAsActivity(event) {
    // We never surface system.message events in the chat pane. The chat
    // pane is reserved for the user/assistant dialogue. System messages
    // include the per-turn system prompt sent to the LLM (which is large,
    // repetitive, and operator-noise) plus internal rehydration notices.
    // The full content remains in CMS — the agent-tuner reads them via
    // `read_agent_events` filtered to `event_types: ["system.message"]`.
    return event?.eventType === "system.message";
}

function buildEmbeddedSystemNoticeActivityItems(event, role) {
    return extractEmbeddedSystemNoticeTexts(messageTextFromEvent(event), role)
        .map((text, index) => formatActivity({
            ...event,
            seq: `${event?.seq ?? "?"}:system:${index + 1}`,
            eventType: "system.message",
            data: { content: text },
        }))
        .filter(Boolean);
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

function formatRehydrationActivityDetail(event, fallbackBody = "") {
    const rawBody = messageTextFromEvent(event);
    const stripped = stripLeadingRehydrationNoticeText(fallbackBody);
    return joinUniqueActivityDetail([
        stripLeadingRehydrationNoticeText(rawBody),
        stripped,
        event?.data?.detail,
        event?.data?.message,
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
    const toolCallId = typeof event?.data?.toolCallId === "string" ? event.data.toolCallId : "";
    const requestId = typeof event?.data?.requestId === "string" ? event.data.requestId : "";
    const toolName = event?.data?.toolName
        || event?.data?.name
        || (toolCallId ? `tool call ${toolCallId.slice(0, 8)}` : requestId ? `tool request ${requestId.slice(0, 8)}` : "tool");
    const args = event?.data?.arguments || event?.data?.args;
    const durableSessionId = event?.data?.durableSessionId;
    const summary = formatToolArgsSummary(toolName, args);
    const phasePrefix = phase === "start"
        ? "▶"
        : phase === "partial"
            ? "…"
            : "✓";
    const phaseColor = phase === "start"
        ? "yellow"
        : phase === "partial"
            ? "cyan"
            : "green";

    return [
        ...buildActivityPrefix(time),
        {
            text: `${phasePrefix} ${toolName}${summary}`,
            color: phaseColor,
        },
        ...(durableSessionId
            ? [{ text: ` [sess ${shortSessionId(durableSessionId)}]`, color: "gray" }]
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
        case "pending_messages.cancelled":
        case "abort":
        case "assistant.turn_end":
        case "assistant.streaming_progress":
            return null;

        case "tool.execution_start":
            runs = formatToolActivityRuns(time, event, "start");
            break;

        case "tool.execution_complete":
            runs = formatToolActivityRuns(time, event, "complete");
            break;

        case "tool.execution_partial_result":
            runs = formatToolActivityRuns(time, event, "partial");
            break;

        case "tool.execution_progress": {
            const data = (event?.data ?? {}) || {};
            const toolName = data.toolName || data.name || "tool";
            const detail = typeof data.message === "string" && data.message
                ? data.message
                : typeof data.detail === "string" && data.detail
                    ? data.detail
                    : (data.percent != null ? `${Math.round(Number(data.percent))}%` : "running…");
            runs = buildLabeledActivityRuns(time, "[tool]", "cyan", `${toolName} ${detail}`, "white");
            break;
        }

        case "assistant.reasoning":
            runs = buildLabeledActivityRuns(time, "[reasoning]", "gray", body || "…", "white");
            break;

        case "assistant.intent": {
            const data = (event?.data ?? {}) || {};
            const text = typeof data.summary === "string" && data.summary
                ? data.summary
                : typeof data.intent === "string" && data.intent
                    ? data.intent
                    : (body || "");
            runs = buildLabeledActivityRuns(time, "[intent]", "gray", text || "…", "white");
            break;
        }

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
                "yellow",
                formatLossyHandoffActivityDetail(event, body) || "handoff to a new worker",
            );
            break;

        case "session.dehydrated":
            runs = buildLabeledActivityRuns(
                time,
                "[dehydrated]",
                "cyan",
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

        case "system.message":
            if (isRehydrationNoticeText(messageTextFromEvent(event))) {
                runs = buildLabeledActivityRuns(
                    time,
                    "[rehydrated]",
                    "green",
                    formatRehydrationActivityDetail(event, body) || "conversation preserved",
                );
            } else {
                runs = buildLabeledActivityRuns(time, "[system]", "gray", body || "system message");
            }
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
        seq: Number.isFinite(Number(event?.seq)) ? Number(event.seq) : 0,
        createdAt: event?.createdAt instanceof Date
            ? event.createdAt.getTime()
            : (event?.createdAt ? new Date(event.createdAt).getTime() : 0),
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
            activity.push(...buildEmbeddedSystemNoticeActivityItems(event, "user"));
            const message = buildChatMessage(event, "user");
            if (message) chat.push(message);
            continue;
        }
        if (event.eventType === "assistant.message") {
            activity.push(...buildEmbeddedSystemNoticeActivityItems(event, "assistant"));
            const message = buildChatMessage(event, "assistant");
            if (message) chat.push(message);
            continue;
        }
        if (event.eventType === "system.message") {
            if (shouldRenderSystemMessageAsActivity(event)) {
                const activityItem = formatActivity(event);
                if (activityItem) activity.push(activityItem);
            } else {
                const message = buildChatMessage(event, "system");
                if (message) chat.push(message);
            }
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
        next.activity.push(...buildEmbeddedSystemNoticeActivityItems(event, "user"));
        next.activity = clampHistoryItems(next.activity, loadedEventLimit);
        const message = buildChatMessage(event, "user");
        if (!message) return next;
        next.chat = reconcileOptimisticMessage(next.chat, message);
        next.chat.push(message);
        next.chat = clampHistoryItems(dedupeChatMessages(next.chat), loadedEventLimit);
        return next;
    }
    if (event.eventType === "assistant.message") {
        next.activity.push(...buildEmbeddedSystemNoticeActivityItems(event, "assistant"));
        next.activity = clampHistoryItems(next.activity, loadedEventLimit);
        const message = buildChatMessage(event, "assistant");
        if (!message) return next;
        next.chat.push(message);
        next.chat = clampHistoryItems(dedupeChatMessages(next.chat), loadedEventLimit);
        return next;
    }
    if (event.eventType === "system.message") {
        if (shouldRenderSystemMessageAsActivity(event)) {
            const activityItem = formatActivity(event);
            if (activityItem) {
                next.activity.push(activityItem);
                next.activity = clampHistoryItems(next.activity, loadedEventLimit);
            }
        } else {
            const message = buildChatMessage(event, "system");
            if (!message) return next;
            next.chat.push(message);
            next.chat = clampHistoryItems(dedupeChatMessages(next.chat), loadedEventLimit);
        }
        return next;
    }
    const activityItem = formatActivity(event);
    if (activityItem) {
        next.activity.push(activityItem);
        next.activity = clampHistoryItems(next.activity, loadedEventLimit);
    }
    return next;
}

export function createSplashCard(branding, session = null) {
    const splash = typeof session?.splash === "string" && session.splash.trim()
        ? session.splash
        : branding?.splash;
    if (!splash) return [];
    const title = session?.isSystem
        ? canonicalSystemTitle(session, branding?.title || "PilotSwarm")
        : (session?.title || branding?.title || "PilotSwarm");
    const hint = "{gray-fg}Start interacting with this session to replace the splash screen.{/gray-fg}";
    return [{
        id: `splash:${title}`,
        role: "system",
        text: `${splash}\n\n${hint}`,
        time: "",
        splash: true,
    }];
}

export function buildSessionLabel(session) {
    const title = session.title || shortSessionId(session.sessionId);
    const shortId = shortSessionId(session.sessionId);
    return title.includes(shortId) ? title : `${title} (${shortId})`;
}
