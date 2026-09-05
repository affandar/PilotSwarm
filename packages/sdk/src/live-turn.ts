/**
 * Ephemeral live-turn helpers.
 *
 * These helpers intentionally know nothing about CMS, orchestration, or the
 * portal. ManagedSession uses LiveTurnCoalescer to turn token deltas into
 * bounded snapshots; SessionProxy uses LatestValuePublisher to keep slow
 * live-plane writes from becoming an unbounded queue.
 */
import { randomUUID } from "node:crypto";

export interface LiveTurnPayload {
    phase: "live" | "idle";
    streamId?: string;
    messageId: string | null;
    text: string;
    reasoningId: string | null;
    reasoningText: string;
    truncated?: boolean;
}

export interface LiveTurnCoalescerOptions {
    intervalMs?: number;
    charThreshold?: number;
}

function eventText(data: unknown): { text: string; delta: boolean } {
    if (typeof data === "string") return { text: data, delta: true };
    if (!data || typeof data !== "object") return { text: "", delta: true };
    if (typeof (data as any).deltaContent === "string") {
        return { text: (data as any).deltaContent, delta: true };
    }
    if (typeof (data as any).delta === "string") {
        return { text: (data as any).delta, delta: true };
    }
    const value = (data as any).content ?? (data as any).text ?? "";
    return { text: typeof value === "string" ? value : "", delta: false };
}

function eventId(data: unknown, primary: string, fallback: string): string {
    if (!data || typeof data !== "object") return fallback;
    const value = (data as any)[primary] ?? (data as any).id;
    return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

/** Merge a cumulative snapshot into retained text without duplicating it. */
export function mergeLiveText(existing: string, incoming: string): string {
    const next = String(incoming || "");
    if (!next) return existing;
    if (!existing) return next;
    if (next.startsWith(existing)) return next;
    if (existing.startsWith(next) || existing.endsWith(next)) return existing;
    return `${existing}${next}`;
}

export class LiveTurnCoalescer {
    private readonly emit: (payload: LiveTurnPayload) => void;
    private readonly intervalMs: number;
    private readonly charThreshold: number;
    private readonly messageText = new Map<string, string>();
    private readonly reasoningText = new Map<string, string>();
    private activeMessageId: string | null = null;
    private activeReasoningId: string | null = null;
    private pendingChars = 0;
    private timer: ReturnType<typeof setTimeout> | null = null;
    private idleSent = true;
    private lastLiveSignature: string | null = null;
    private lastFlushAt = -Infinity;
    private truncated = false;
    private streamId = randomUUID();

    constructor(emit: (payload: LiveTurnPayload) => void, options: LiveTurnCoalescerOptions = {}) {
        this.emit = emit;
        this.intervalMs = Math.max(1, Math.floor(options.intervalMs ?? 100));
        this.charThreshold = Math.max(1, Math.floor(options.charThreshold ?? 512));
    }

    startTurn(): void {
        this.streamId = randomUUID();
        this.cancelTimer();
        this.messageText.clear();
        this.reasoningText.clear();
        this.activeMessageId = null;
        this.activeReasoningId = null;
        this.pendingChars = 0;
        this.idleSent = false;
        this.lastLiveSignature = null;
        this.lastFlushAt = -Infinity;
        this.truncated = false;
    }

    messageDelta(data: unknown): void {
        const incoming = eventText(data);
        // Metadata/empty chunks are not message boundaries. In particular,
        // Copilot's streaming progress contains bytes, not a message ID/text.
        if (!incoming.text) return;
        const id = eventId(data, "messageId", "assistant");
        if (this.activeMessageId && this.activeMessageId !== id) {
            this.flushLive();
            this.messageText.clear();
            this.reasoningText.clear();
            this.activeReasoningId = null;
            this.truncated = false;
        }
        this.activeMessageId = id;
        const before = this.messageText.get(id) || "";
        const after = incoming.delta ? `${before}${incoming.text}` : mergeLiveText(before, incoming.text);
        this.messageText.set(id, this.boundText(after));
        this.pendingChars += Math.max(0, after.length - before.length);
        this.idleSent = false;
        this.scheduleOrFlush();
    }

    reasoningDelta(data: unknown): void {
        const incoming = eventText(data);
        if (!incoming.text) return;
        const id = eventId(data, "reasoningId", "reasoning");
        if (this.activeReasoningId && this.activeReasoningId !== id) {
            this.flushLive();
            this.reasoningText.clear();
            this.messageText.clear();
            this.activeMessageId = null;
            this.truncated = false;
        }
        this.activeReasoningId = id;
        const before = this.reasoningText.get(id) || "";
        const after = incoming.delta ? `${before}${incoming.text}` : mergeLiveText(before, incoming.text);
        this.reasoningText.set(id, this.boundText(after));
        this.pendingChars += Math.max(0, after.length - before.length);
        this.idleSent = false;
        this.scheduleOrFlush();
    }

    finalMessage(data: unknown): void {
        const id = eventId(data, "messageId", this.activeMessageId || "assistant");
        if (this.activeMessageId && this.activeMessageId !== id) this.flushLive();
        const content = eventText(data).text;
        this.activeMessageId = id;
        if (content) this.messageText.set(id, this.boundText(content));
        this.idleSent = false;
        this.flushLive();
    }

    finalReasoning(data: unknown): void {
        const id = eventId(data, "reasoningId", this.activeReasoningId || "reasoning");
        if (this.activeReasoningId && this.activeReasoningId !== id) this.flushLive();
        const content = eventText(data).text;
        this.activeReasoningId = id;
        if (content) this.reasoningText.set(id, this.boundText(content));
        this.idleSent = false;
        this.flushLive();
    }

    flushLive(): void {
        this.cancelTimer();
        const text = this.activeMessageId ? (this.messageText.get(this.activeMessageId) || "") : "";
        const reasoningText = this.activeReasoningId ? (this.reasoningText.get(this.activeReasoningId) || "") : "";
        if (!text && !reasoningText) {
            this.pendingChars = 0;
            return;
        }
        const payload: LiveTurnPayload = {
            phase: "live",
            streamId: this.streamId,
            messageId: this.activeMessageId,
            text,
            reasoningId: this.activeReasoningId,
            reasoningText,
            ...(this.truncated ? { truncated: true } : {}),
        };
        const signature = JSON.stringify(payload);
        if (signature !== this.lastLiveSignature) {
            this.emit(payload);
            this.lastLiveSignature = signature;
            this.lastFlushAt = Date.now();
        }
        this.pendingChars = 0;
    }

    finishTurn(): void {
        this.flushLive();
        if (this.idleSent) return;
        this.emit({
            phase: "idle",
            streamId: this.streamId,
            messageId: null,
            text: "",
            reasoningId: null,
            reasoningText: "",
        });
        this.idleSent = true;
    }

    dispose(): void {
        this.cancelTimer();
    }

    private scheduleOrFlush(): void {
        // A character threshold may accelerate the FIRST paint, never turn
        // a fast provider into a DB write and transcript rebuild per token.
        if (this.pendingChars >= this.charThreshold && Date.now() - this.lastFlushAt >= this.intervalMs) {
            this.flushLive();
            return;
        }
        if (this.timer) return;
        this.timer = setTimeout(() => {
            this.timer = null;
            this.flushLive();
        }, Number.isFinite(this.lastFlushAt)
            ? Math.max(1, this.intervalMs - Math.max(0, Date.now() - this.lastFlushAt))
            : this.intervalMs);
        (this.timer as any).unref?.();
    }

    private cancelTimer(): void {
        if (!this.timer) return;
        clearTimeout(this.timer);
        this.timer = null;
    }

    private boundText(text: string): string {
        // Two 16K UTF-16 previews fit under 256KiB even with JSON escaping.
        // The durable message is never truncated.
        if (text.length <= 16_384) return text;
        this.truncated = true;
        return text.slice(0, 16_384);
    }
}

/**
 * One operation in flight, one replaceable waiting value. Enqueueing ten
 * updates while a publish is blocked therefore produces exactly two writes:
 * the first and the newest.
 */
export class LatestValuePublisher<T> {
    private inFlight: Promise<void> | null = null;
    private pending: T | undefined;
    private hasPending = false;

    constructor(
        private readonly publish: (value: T) => Promise<unknown>,
        private readonly onError: (error: unknown) => void = () => {},
    ) {}

    enqueue(value: T): void {
        this.pending = value;
        this.hasPending = true;
        this.pump();
    }

    async drain(): Promise<void> {
        while (this.inFlight || this.hasPending) {
            this.pump();
            if (this.inFlight) await this.inFlight;
        }
    }

    private pump(): void {
        if (this.inFlight || !this.hasPending) return;
        const value = this.pending as T;
        this.pending = undefined;
        this.hasPending = false;
        this.inFlight = Promise.resolve()
            .then(() => this.publish(value))
            .catch((error) => {
                try { this.onError(error); } catch {}
            })
            .then(() => undefined)
            .finally(() => {
                this.inFlight = null;
                this.pump();
            });
    }
}
