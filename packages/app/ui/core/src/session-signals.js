import { formatHumanDurationSeconds } from "./formatting.js";

export const SIGNAL_EVENT_TYPES = [
    "session.signal_received",
    "session.signal_buffered",
    "session.signal_consumed",
    "session.signal_duplicate",
    "session.signal_dropped",
    "session.signal_rejected",
    "session.signal_wait_started",
    "session.signal_wait_interrupted",
    "session.signal_wait_resumed",
    "session.signal_wait_cancelled",
    "session.signal_wait_timeout",
];
const signalEventTypes = new Set(SIGNAL_EVENT_TYPES);
const dormantStatuses = new Set(["waiting", "idle", "unknown"]);

// These are labels, not markup, links, or prompts. In particular, never read
// inline signal data or dereference payloadRef while deriving a UI view.
function text(value) {
    return typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f-\u009f]/gu, " ").trim() : "";
}

function names(wait) {
    return Array.isArray(wait?.names) ? wait.names.map(text).filter(Boolean).join(", ") : "";
}

function waitTiming(wait) {
    if (!wait?.deadline) return "no deadline";
    const deadline = new Date(wait.deadline);
    if (!Number.isFinite(deadline.getTime())) return "deadline unavailable";
    const local = deadline.toLocaleString(undefined, {
        month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
        hour12: false, timeZoneName: "short",
    }).replace(/,\s*/gu, " ").replace(/\s+/gu, " ").trim();
    return `until ${local}`;
}

export function isSignalWaiting(session) {
    return !session?.isGroup && Boolean(names(session?.signalWait))
        && session?.signalWaitInterrupted !== true
        && dormantStatuses.has(session?.status || "unknown");
}

export function selectSessionSignalWait(session) {
    const pendingNames = names(session?.signalWait);
    const interrupted = session?.signalWaitInterrupted === true;
    // During interruption, a wait belongs to that turn (e.g. its provider
    // budget), not to the suspended signal wait.
    if (interrupted && session?.status === "waiting") return null;
    // A pending question, error, or terminal state keeps its own UX.
    // Running is allowed only for the one-turn interruption of a saved wait.
    if (!pendingNames || session?.isGroup
        || (!isSignalWaiting(session) && !(interrupted
            && (dormantStatuses.has(session?.status || "unknown") || session?.status === "running")))) return null;
    const timing = waitTiming(session.signalWait);
    return {
        interrupted,
        color: "yellow",
        text: `${interrupted ? "Signal wait interrupted" : "Waiting for signal"}: ${pendingNames} · ${timing}`,
        badge: `[signal${interrupted ? " interrupted" : ""}: ${pendingNames} · ${timing}]`,
    };
}

function statusVersion(value) {
    if (value == null || value === "" || typeof value === "boolean") return null;
    const number = Number(value);
    return Number.isSafeInteger(number) && number > 0 ? number : null;
}

function snapshotOrder(previous, next) {
    const previousVersion = statusVersion(previous?.statusVersion);
    const nextVersion = statusVersion(next?.statusVersion);
    if (previousVersion != null && nextVersion != null) return Math.sign(nextVersion - previousVersion);
    const timestamp = (value) => typeof value === "number" ? value : Date.parse(value || "");
    const before = timestamp(previous?.updatedAt);
    const after = timestamp(next?.updatedAt);
    return before > 0 && after > 0 ? Math.sign(after - before) : null;
}

/**
 * Full list/detail snapshots only, not partial event/UI patches. Omission
 * clears a wait only in a rich status snapshot: a valid statusVersion,
 * explicit signal metadata (including null), or a caller-confirmed detail
 * read. CMS-only list timestamps do not establish signal lifecycle authority.
 * Sessions that have never carried this metadata are completely unchanged.
 */
export function reconcileSignalWaitSnapshot(previous, next, { authoritative = false } = {}) {
    if (previous?.signalWait == null && next?.signalWait == null) return next;
    const terminal = ["completed", "cancelled", "terminated", "failed"].includes(next?.status)
        || ["Completed", "Terminated", "Failed"].includes(next?.orchestrationStatus);
    if (!terminal && !authoritative && statusVersion(next?.statusVersion) == null
        && next.signalWait === undefined && next.signalWaitInterrupted === undefined) {
        // CMS rows carry catalog changes, not live wait state. Keep the
        // runtime fields together: an interrupted signal's provider-budget
        // wait still owns its status/reason/timer. Retain the status timestamp
        // too, so a catalog rename cannot make the next rich read look stale.
        return {
            ...next,
            status: previous.status,
            statusVersion: previous.statusVersion,
            updatedAt: previous.updatedAt,
            orchestrationStatus: previous.orchestrationStatus,
            signalWait: previous.signalWait,
            signalWaitInterrupted: previous.signalWaitInterrupted,
            waitReason: previous.waitReason,
            waitStartedAt: previous.waitStartedAt,
            waitSeconds: previous.waitSeconds,
            pauseState: previous.pauseState,
        };
    }
    const order = snapshotOrder(previous, next);
    if (previous?.signalWait !== undefined && order != null
        && (order < 0 || (order === 0 && !terminal))) {
        return {
            ...next,
            signalWait: previous.signalWait,
            signalWaitInterrupted: previous.signalWaitInterrupted,
            ...(order === 0 && previous.signalWaitInterrupted === true && next.signalWaitInterrupted === true
                ? {}
                : { waitStartedAt: previous.waitStartedAt, waitSeconds: previous.waitSeconds }),
        };
    }
    const wait = terminal ? null
        : next.signalWait === undefined && next.signalWaitInterrupted === true
            ? previous?.signalWait
            : next.signalWait;
    return {
        ...next,
        signalWait: wait || null,
        signalWaitInterrupted: Boolean(wait && next.signalWaitInterrupted === true),
        waitStartedAt: next.waitStartedAt ?? null,
        // An interrupting turn may carry its own provider-budget timer.
        waitSeconds: wait && !wait.deadline && next.signalWaitInterrupted !== true ? null : next.waitSeconds ?? null,
    };
}

/** One metadata-only description for bulk/live Activity and the sequence. */
export function describeSignalEvent(event) {
    if (!signalEventTypes.has(event?.eventType)) return null;
    const data = event?.data && typeof event.data === "object" ? event.data : {};
    const waitEvent = event.eventType.startsWith("session.signal_wait_");
    const phase = event.eventType.slice(waitEvent ? "session.signal_wait_".length : "session.signal_".length);
    const wake = !waitEvent && phase === "consumed";
    const timeout = waitEvent && phase === "timeout";
    const marker = wake ? "↑ " : timeout ? "! " : "";
    const color = wake ? "green"
        : phase === "rejected" ? "red"
            : phase === "duplicate" || phase === "cancelled" ? "gray"
                : waitEvent || phase === "dropped" ? "yellow" : "cyan";
    const subject = waitEvent ? names(data) || "unknown" : text(data.name) || "unknown";
    const mode = wake && (data.mode === "wait" || data.mode === "wake") ? ` (${data.mode})` : "";
    const summary = `${marker}${timeout ? "timed out" : phase}: ${subject}${mode}`;
    const timing = waitEvent ? waitTiming(data) : "";
    const details = [];
    if (waitEvent) {
        details.push(timing);
    } else {
        if (text(data.source?.kind)) details.push(`source ${text(data.source.kind)}`);
        if (text(data.source?.actorId)) details.push(`actor ${text(data.source.actorId)}`);
        if (text(data.source?.receiptId)) details.push(`receipt ${text(data.source.receiptId)}`);
        if (data.wake === true && !wake) details.push("wake requested");
        if (Number.isFinite(data.waitDurationMs) && data.waitDurationMs >= 0) {
            details.push(`waited ${formatHumanDurationSeconds(data.waitDurationMs / 1000)}`);
        }
        if (text(data.signalId)) details.push(`id ${text(data.signalId)}`);
        if (Number.isFinite(data.dataBytes) && data.dataBytes >= 0) details.push(`${data.dataBytes} bytes`);
        if (text(data.payloadRef)) details.push(`payload ${text(data.payloadRef)}`);
    }
    if (text(data.waitId)) details.push(`wait ${text(data.waitId)}`);
    if (text(data.disposition)) details.push(`disposition ${text(data.disposition)}`);
    if (text(data.reason)) details.push(`reason: ${text(data.reason)}`);
    return {
        label: waitEvent ? "[signal wait]" : "[signal]",
        color,
        text: [summary, ...details].join(" · "),
        sequenceText: `${marker}signal ${waitEvent ? "wait " : ""}${timeout ? "timed out" : phase}: ${subject}${mode}${timing ? ` · ${timing}` : ""}`,
        type: wake ? "signal_wake" : timeout ? "signal_timeout" : "signal",
    };
}
