import { randomUUID } from "node:crypto";
import type { SessionCatalogProvider, SessionRow } from "./cms.js";

const SESSION_MESSAGE_RATE_WINDOW_MS = 10 * 60 * 1000;
const SESSION_MESSAGE_SENDER_LIMIT = 10;
const SESSION_MESSAGE_TARGET_LIMIT = 3;
const sessionMessageRateBuckets = new Map<string, { bucketStart: number; senderCount: number; targetCounts: Map<string, number> }>();

export type SessionMessageReason = "help" | "guidance" | "fact-request" | "status-request" | "handoff";
export type SessionMessageVerdict = "answered" | "declined" | "blocked" | "stale";

export interface InternalSessionMessageRuntime {
    catalog: SessionCatalogProvider;
    duroxideClient: {
        getStatus(orchestrationId: string): Promise<{ status?: string } | null | undefined>;
        enqueueEvent(orchestrationId: string, eventName: string, payload: string): Promise<unknown>;
    };
}

function normalizeSessionId(value: unknown): string {
    return String(value || "").replace(/^session-/, "").trim();
}

function reserveSessionMessageRate(senderSessionId: string, targetSessionId: string): { ok: true } | { ok: false; retryAfterMs: number; reason: string } {
    const now = Date.now();
    let bucket = sessionMessageRateBuckets.get(senderSessionId);
    if (!bucket || now - bucket.bucketStart >= SESSION_MESSAGE_RATE_WINDOW_MS) {
        bucket = { bucketStart: now, senderCount: 0, targetCounts: new Map() };
        sessionMessageRateBuckets.set(senderSessionId, bucket);
    }
    const retryAfterMs = Math.max(1000, SESSION_MESSAGE_RATE_WINDOW_MS - (now - bucket.bucketStart));
    if (bucket.senderCount >= SESSION_MESSAGE_SENDER_LIMIT) {
        return { ok: false, retryAfterMs, reason: `sender limit ${SESSION_MESSAGE_SENDER_LIMIT}/10m exceeded` };
    }
    const targetCount = bucket.targetCounts.get(targetSessionId) || 0;
    if (targetCount >= SESSION_MESSAGE_TARGET_LIMIT) {
        return { ok: false, retryAfterMs, reason: `target limit ${SESSION_MESSAGE_TARGET_LIMIT}/10m exceeded` };
    }
    bucket.senderCount += 1;
    bucket.targetCounts.set(targetSessionId, targetCount + 1);
    return { ok: true };
}

export function resetSessionMessageRateLimitsForTests(): void {
    sessionMessageRateBuckets.clear();
}

async function assertOrchestrationLive(
    duroxideClient: InternalSessionMessageRuntime["duroxideClient"],
    orchestrationId: string,
    sessionId: string,
    operation: string,
): Promise<void> {
    let status: string | undefined;
    try {
        const info = await duroxideClient.getStatus(orchestrationId);
        status = info?.status;
    } catch {
        return;
    }
    if (!status || status === "NotFound" || status === "Unknown") {
        throw new Error(
            `Cannot ${operation} for session ${sessionId.slice(0, 8)}: orchestration ${orchestrationId} is not started (status=${status ?? "missing"}).`,
        );
    }
}

async function validateSessionMessageTarget(
    catalog: SessionCatalogProvider,
    fromSessionId: string,
    toSessionId: string,
    operationKind: "messages" | "replies",
): Promise<SessionRow> {
    if (!fromSessionId || !toSessionId) throw new Error("fromSessionId and toSessionId are required");
    if (fromSessionId === toSessionId) throw new Error("Cannot send a session message to the same session");

    const targetRow = await catalog.getSession(toSessionId).catch(() => null);
    if (!targetRow) throw new Error(`Session ${toSessionId.slice(0, 8)} was not found.`);
    if (targetRow.state === "failed" || targetRow.state === "cancelled") {
        throw new Error(`Session ${toSessionId.slice(0, 8)} is terminal and cannot accept cross-session ${operationKind}.`);
    }
    if (targetRow.state === "completed" && targetRow.parentSessionId && !targetRow.isSystem) {
        throw new Error(`Session ${toSessionId.slice(0, 8)} is completed and cannot accept cross-session ${operationKind}.`);
    }
    return targetRow;
}

export async function sendInternalSessionMessage(
    runtime: InternalSessionMessageRuntime,
    input: {
        fromSessionId: string;
        toSessionId: string;
        subject: string;
        body: string;
        reason?: SessionMessageReason;
        expectsResponse?: boolean;
        expiresAt?: string;
    },
): Promise<{ requestId: string }> {
    const fromSessionId = normalizeSessionId(input.fromSessionId);
    const toSessionId = normalizeSessionId(input.toSessionId);
    const subject = String(input.subject || "").trim();
    const body = String(input.body || "").trim();
    if (!subject || !body) throw new Error("subject and body are required");
    if (Buffer.byteLength(body, "utf8") > 8192) throw new Error("session message body exceeds 8 KB");

    await validateSessionMessageTarget(runtime.catalog, fromSessionId, toSessionId, "messages");
    const rate = reserveSessionMessageRate(fromSessionId, toSessionId);
    if (!rate.ok) {
        throw new Error(`session message rate_limited: ${rate.reason}; retry_after_ms=${rate.retryAfterMs}`);
    }

    const orchestrationId = `session-${toSessionId}`;
    await assertOrchestrationLive(runtime.duroxideClient, orchestrationId, toSessionId, "sendSessionMessage");
    const requestId = randomUUID();
    const replyInstructions = input.expectsResponse
        ? `\nReceiver instructions:\n` +
            `- This request expects a response. After you have the answer, call reply_session_message(request_id="${requestId}", session_id="${fromSessionId}", verdict="answered", body=<your concise answer>).\n` +
            `- If you cannot answer, still call reply_session_message with verdict="blocked", "declined", or "stale" and explain why.\n` +
            `- Do not only write the answer in your own chat transcript; the sender receives it only through reply_session_message.\n`
        : `\nReceiver instructions:\n` +
            `- This is a one-way session message. Record or act on it if useful; no reply is required unless the body explicitly asks for one.\n`;
    const message =
        `[SESSION_MESSAGE request_id=${requestId} from=${fromSessionId} subject=${JSON.stringify(subject).slice(1, -1)}${input.reason ? ` reason=${input.reason}` : ""}${input.expectsResponse ? " expects_response=true" : ""}${input.expiresAt ? ` expires_at=${input.expiresAt}` : ""}]\n` +
        replyInstructions +
        `\nRequest body:\n${body}`;
    await runtime.duroxideClient.enqueueEvent(
        orchestrationId,
        "messages",
        JSON.stringify({ prompt: message }),
    );
    return { requestId };
}

export async function replyInternalSessionMessage(
    runtime: InternalSessionMessageRuntime,
    input: {
        requestId: string;
        fromSessionId: string;
        toSessionId: string;
        verdict?: SessionMessageVerdict;
        body: string;
    },
): Promise<void> {
    const fromSessionId = normalizeSessionId(input.fromSessionId);
    const toSessionId = normalizeSessionId(input.toSessionId);
    const requestId = String(input.requestId || "").trim();
    const body = String(input.body || "").trim();
    if (!fromSessionId || !toSessionId || !requestId || !body) {
        throw new Error("requestId, fromSessionId, toSessionId, and body are required");
    }
    if (fromSessionId === toSessionId) throw new Error("Cannot reply to the same session");
    if (Buffer.byteLength(body, "utf8") > 8192) throw new Error("session reply body exceeds 8 KB");

    await validateSessionMessageTarget(runtime.catalog, fromSessionId, toSessionId, "replies");
    const rate = reserveSessionMessageRate(fromSessionId, toSessionId);
    if (!rate.ok) {
        throw new Error(`session reply rate_limited: ${rate.reason}; retry_after_ms=${rate.retryAfterMs}`);
    }

    const orchestrationId = `session-${toSessionId}`;
    await assertOrchestrationLive(runtime.duroxideClient, orchestrationId, toSessionId, "replySessionMessage");
    const verdict = input.verdict || "answered";
    const message =
        `[SESSION_MESSAGE_RESPONSE request_id=${requestId} from=${fromSessionId} verdict=${verdict}]\n` +
        `This is the requested cross-session response. Incorporate it into your work; do not ask the target again unless the answer is incomplete.\n\n` +
        body;
    await runtime.duroxideClient.enqueueEvent(
        orchestrationId,
        "messages",
        JSON.stringify({ prompt: message }),
    );
}
