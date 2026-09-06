export function shouldKeepSessionWarning(previousSession, nextSession) {
    if (!String(previousSession?.error || "").trim()) return false;
    if (nextSession?.error !== undefined) return false;
    if (["Completed", "Failed", "Terminated"].includes(String(nextSession?.orchestrationStatus || ""))) return false;
    if (["completed", "failed", "cancelled", "terminated"].includes(previousSession?.status)) return false;
    const nextStatus = String(nextSession?.status || "");
    if (["running", "error"].includes(nextStatus)) return true;
    if (!["idle", "waiting", "unknown", "pending", ""].includes(nextStatus)) return false;
    // Catalog/detail snapshots can lag a retry. A genuinely newer idle detail
    // (or a new durable wait) clears it; a same-age snapshot is not evidence
    // of recovery. Do not infer retry semantics from provider error wording.
    const previousVersion = Number(previousSession?.statusVersion);
    const nextVersion = Number(nextSession?.statusVersion);
    if (previousVersion > 0 && nextVersion > 0) return nextVersion <= previousVersion;
    const time = (value) => typeof value === "number" ? value : Date.parse(value || "");
    const previousAt = time(previousSession?.updatedAt);
    const nextAt = time(nextSession?.updatedAt);
    return previousAt > 0 && nextAt > 0 && nextAt <= previousAt;
}

const timeMs = value => value instanceof Date ? value.getTime()
    : typeof value === "number" ? value : Date.parse(value || "");
const errorText = event => typeof event?.data === "string" ? event.data
    : String(event?.data?.message || event?.data?.error || event?.data?.text || "").trim();
const sameError = (statusText, eventText) => Boolean(eventText) && statusText.includes(eventText);

export function buildSessionWarning(event) {
    const text = errorText(event);
    if (!text) return null;
    const failed = event?.data?.fatal === true;
    return {
        id: `${event.sessionId}:${event.seq}:warning`,
        kind: "session-warning", role: "system", text,
        warningSeq: Number(event.seq),
        createdAt: timeMs(event.createdAt) || null,
        cardTitle: failed ? "Error" : "Warning",
        cardTitleColor: failed ? "red" : "yellow",
        cardBorderColor: failed ? "red" : "yellow",
    };
}

// Status-only failures have no chat event yet (some never get one). Capture
// their position ONCE in shared state, not on each render/poll. Recovery ends
// the active episode but does not erase its notice. Durable error events are
// rendered separately and survive reload/history paging.
export function retainSessionWarnings(previous, next, events = [], now = Date.now()) {
    const warnings = previous?.chatWarnings || [];
    const last = warnings.at(-1);
    const text = String(next?.error || "").trim();
    const failed = next?.status === "failed" || next?.orchestrationStatus === "Failed";
    const active = Boolean(text) && (failed || !["completed", "cancelled", "terminated", "input_required"].includes(next?.status))
        && !["Completed", "Terminated"].includes(next?.orchestrationStatus);
    if (!active) {
        if (!last?.active) return next;
        return { ...next, chatWarnings: [...warnings.slice(0, -1), { ...last, active: false }] };
    }
    const since = last?.createdAt || 0;
    const event = events.findLast(e => e.eventType === "session.error"
        && timeMs(e.createdAt) > since && sameError(text, errorText(e)));
    // A retained error field can outlive a terminal/wait state. A later
    // running snapshot alone is not evidence of another failure episode.
    if (last && !last.active && text === last.text && text === String(previous?.error || "").trim() && !event) return next;
    const movedOn = last && text !== last.text && events.some(e =>
        Number(e.seq) > last.afterSeq && timeMs(e.createdAt) > last.createdAt
        && ["user.message", "assistant.message"].includes(e.eventType));
    if (last?.active && !movedOn) {
        if (last.text === text && last.failed === failed) return next;
        return { ...next, chatWarnings: [...warnings.slice(0, -1), { ...last, text, failed }] };
    }
    const ordinal = (last?.ordinal || 0) + 1;
    const previousWarnings = last?.active ? [...warnings.slice(0, -1), { ...last, active: false }] : warnings;
    return { ...next, chatWarnings: [...previousWarnings, {
        id: `session-error:${next.sessionId}:${ordinal}`, ordinal, text, failed, active: true,
        eventSeq: event ? Number(event.seq) : null,
        afterSeq: Number(events.at(-1)?.seq) || 0,
        since,
        createdAt: timeMs(event?.createdAt) || timeMs(next.updatedAt) || now,
    }].slice(-300) };
}

export function withSessionWarnings(chat, session, events = []) {
    const messages = [...chat];
    for (const warning of session?.chatWarnings || []) {
        // Status often wins the race against its durable event. Match only
        // that boundary, never a later failure after a new user/agent message.
        const following = events.filter(e => Number(e.seq) > warning.afterSeq);
        const boundary = following.find(e => ["session.error", "user.message", "assistant.message"].includes(e.eventType));
        // On initial load the catalog can arrive before any history at all.
        // Find its matching older event by the captured failure time, without
        // reusing an event from a previous error episode with identical text.
        // Chat can outlive the raw-event window when tool activity is noisy.
        // Reconcile from the retained warning rows, not only from raw events.
        const recorded = chat.findLast(m => m.kind === "session-warning"
            && timeMs(m.createdAt) > (warning.since || 0)
            && timeMs(m.createdAt) <= warning.createdAt
            && sameError(warning.text, m.text));
        const eventSeq = warning.eventSeq ?? recorded?.warningSeq
            ?? (boundary?.eventType === "session.error" && sameError(warning.text, errorText(boundary)) ? Number(boundary.seq) : null);
        const index = messages.findIndex(m => m.kind === "session-warning" && m.warningSeq === eventSeq);
        const notice = {
            id: warning.id, kind: "session-warning", role: "system", text: warning.text,
            createdAt: warning.createdAt,
            cardTitle: warning.failed ? "Error" : "Warning",
            cardTitleColor: warning.failed ? "red" : "yellow",
            cardBorderColor: warning.failed ? "red" : "yellow",
        };
        if (index >= 0) {
            // Preserve the mounted card while the durable row takes over.
            messages[index] = { ...messages[index], ...notice, createdAt: messages[index].createdAt };
        } else {
            const nextIndex = messages.findIndex(m => timeMs(m.createdAt) > warning.createdAt);
            messages.splice(nextIndex < 0 ? messages.length : nextIndex, 0, notice);
        }
    }
    return messages;
}
