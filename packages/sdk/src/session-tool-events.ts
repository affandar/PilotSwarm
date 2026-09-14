export interface SessionEventLike {
    seq: number;
    eventType: string;
    data: unknown;
}

export interface SessionToolEventBase {
    seq: number;
    toolName: string;
    toolCallId?: string;
}

export interface SessionToolStartEvent extends SessionToolEventBase {
    phase: "start";
}

export interface SessionToolCompleteEvent extends SessionToolEventBase {
    phase: "complete";
    success: boolean;
}

export type SessionToolEvent = SessionToolStartEvent | SessionToolCompleteEvent;

export interface SessionToolExecution {
    toolCallId: string;
    toolName: string;
    start?: SessionToolStartEvent;
    completion?: SessionToolCompleteEvent;
}

export interface SessionToolEventSource {
    on(handler: (event: SessionEventLike) => void): () => void;
    getMessages(limit?: number): Promise<readonly SessionEventLike[]>;
}

export interface SessionToolEventTrackerOptions {
    catchUpLimit?: number;
    onEvent?: (event: SessionToolEvent) => void;
    onStart?: (event: SessionToolStartEvent) => void;
    onComplete?: (event: SessionToolCompleteEvent) => void;
}

export interface SessionToolEventFinishResult {
    durableEventCount: number;
    trackedEventCount: number;
    highWatermark: number;
}

export const DEFAULT_SESSION_TOOL_EVENT_CATCH_UP_LIMIT = 500;
export const MAX_SESSION_TOOL_EVENT_CATCH_UP_LIMIT = 10_000;

function asRecord(value: unknown): Record<string, unknown> | undefined {
    return value !== null && typeof value === "object" && !Array.isArray(value)
        ? value as Record<string, unknown>
        : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
    if (typeof value !== "string") return undefined;
    const trimmed = value.trim();
    return trimmed || undefined;
}

/**
 * Classify one generic session event without applying delivery or error policy.
 * Malformed and unrelated events return undefined.
 */
export function classifySessionToolEvent(event: unknown): SessionToolEvent | undefined {
    const record = asRecord(event);
    if (!record) return undefined;
    const seq = record?.seq;
    if (!Number.isSafeInteger(seq) || (seq as number) < 0) return undefined;

    const eventType = record?.eventType;
    if (eventType !== "tool.execution_start" && eventType !== "tool.execution_complete") {
        return undefined;
    }

    const data = asRecord(record.data);
    const toolName = nonEmptyString(data?.toolName) ?? nonEmptyString(data?.name);
    if (!toolName) return undefined;

    const toolCallId = nonEmptyString(data?.toolCallId) ?? nonEmptyString(data?.callId);
    const base = {
        seq: seq as number,
        toolName,
        ...(toolCallId ? { toolCallId } : {}),
    };
    if (eventType === "tool.execution_start") {
        return { ...base, phase: "start" };
    }
    if (typeof data?.success !== "boolean") return undefined;
    return { ...base, phase: "complete", success: data.success };
}

/**
 * Sequence-aware, source-independent tool-event ledger.
 *
 * Sequence numbers are identities, not an arrival-order gate: a delayed event
 * below the current high watermark is still accepted once, while an already
 * seen sequence is ignored. Public event collections are always sorted by
 * sequence and the high watermark never decreases.
 */
export class SessionToolEventLedger {
    readonly attempted = new Set<string>();
    readonly succeeded = new Set<string>();
    readonly failed = new Set<string>();

    private readonly bySequence = new Map<number, SessionToolEvent>();
    private readonly byToolCallId = new Map<string, SessionToolExecution>();
    private maxSequence = -1;

    get highWatermark(): number {
        return this.maxSequence;
    }

    get size(): number {
        return this.bySequence.size;
    }

    get events(): SessionToolEvent[] {
        return [...this.bySequence.values()].sort((left, right) => left.seq - right.seq);
    }

    get completed(): SessionToolCompleteEvent[] {
        return this.events.filter((event): event is SessionToolCompleteEvent => event.phase === "complete");
    }

    get executions(): SessionToolExecution[] {
        return [...this.byToolCallId.values()]
            .map((execution) => ({ ...execution }))
            .sort((left, right) => (
                (left.start?.seq ?? left.completion?.seq ?? 0)
                - (right.start?.seq ?? right.completion?.seq ?? 0)
            ));
    }

    ingest(input: unknown): SessionToolEvent | undefined {
        const event = classifySessionToolEvent(input);
        if (!event || this.bySequence.has(event.seq)) return undefined;

        this.bySequence.set(event.seq, event);
        this.maxSequence = Math.max(this.maxSequence, event.seq);
        if (event.phase === "start") {
            this.attempted.add(event.toolName);
        } else {
            (event.success ? this.succeeded : this.failed).add(event.toolName);
        }

        if (event.toolCallId) {
            const execution = this.byToolCallId.get(event.toolCallId) ?? {
                toolCallId: event.toolCallId,
                toolName: event.toolName,
            };
            execution.toolName = event.toolName;
            if (event.phase === "start") execution.start = event;
            else execution.completion = event;
            this.byToolCallId.set(event.toolCallId, execution);
        }
        return event;
    }
}

/**
 * Tracks live tool events and performs one durable catch-up when finished.
 *
 * Durable read failures reject finish(); callers decide whether to propagate,
 * retry, or deliberately ignore them. The subscription remains active while
 * catch-up is pending so reconnect/live races are deduplicated by sequence.
 */
export class SessionToolEventTracker {
    readonly ledger = new SessionToolEventLedger();

    private readonly source: SessionToolEventSource;
    private readonly options: SessionToolEventTrackerOptions;
    private readonly catchUpLimit: number;
    private unsubscribeSource: (() => void) | undefined;
    private finishPromise: Promise<SessionToolEventFinishResult> | undefined;

    constructor(source: SessionToolEventSource, options: SessionToolEventTrackerOptions = {}) {
        const catchUpLimit = options.catchUpLimit ?? DEFAULT_SESSION_TOOL_EVENT_CATCH_UP_LIMIT;
        if (!Number.isSafeInteger(catchUpLimit)
            || catchUpLimit < 1
            || catchUpLimit > MAX_SESSION_TOOL_EVENT_CATCH_UP_LIMIT) {
            throw new RangeError(
                `catchUpLimit must be a positive safe integer no greater than ${MAX_SESSION_TOOL_EVENT_CATCH_UP_LIMIT}`,
            );
        }
        this.source = source;
        this.options = options;
        this.catchUpLimit = catchUpLimit;
        this.unsubscribeSource = source.on((event) => this.ingest(event));
    }

    get attempted(): ReadonlySet<string> {
        return this.ledger.attempted;
    }

    get succeeded(): ReadonlySet<string> {
        return this.ledger.succeeded;
    }

    get failed(): ReadonlySet<string> {
        return this.ledger.failed;
    }

    get completed(): SessionToolCompleteEvent[] {
        return this.ledger.completed;
    }

    get highWatermark(): number {
        return this.ledger.highWatermark;
    }

    ingest(input: unknown): SessionToolEvent | undefined {
        const event = this.ledger.ingest(input);
        if (!event) return undefined;
        this.options.onEvent?.(event);
        if (event.phase === "start") this.options.onStart?.(event);
        else this.options.onComplete?.(event);
        return event;
    }

    unsubscribe(): void {
        const unsubscribe = this.unsubscribeSource;
        this.unsubscribeSource = undefined;
        unsubscribe?.();
    }

    finish(): Promise<SessionToolEventFinishResult> {
        if (!this.finishPromise) this.finishPromise = this.finishOnce();
        return this.finishPromise;
    }

    private async finishOnce(): Promise<SessionToolEventFinishResult> {
        try {
            const durableEvents = await this.source.getMessages(this.catchUpLimit);
            for (const event of [...durableEvents].sort((left, right) => left.seq - right.seq)) {
                this.ingest(event);
            }
            return {
                durableEventCount: durableEvents.length,
                trackedEventCount: this.ledger.size,
                highWatermark: this.ledger.highWatermark,
            };
        } finally {
            this.unsubscribe();
        }
    }
}
