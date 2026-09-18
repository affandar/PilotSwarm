import {
    SIGNAL_BUFFER_KEY_PREFIX,
    SIGNAL_BUFFER_LIMIT,
    SIGNAL_DEDUP_LIMIT,
    SIGNAL_STATE_KEY,
    SignalValidationError,
    parseSessionSignal,
    summarizeSignal,
    type SessionSignalState,
    type SessionSignalV1,
    type SignalWaitRequest,
} from "../session-signals.js";
import { planHoldRelease } from "../wait-affinity.js";
import { publishStatus, releaseAffinity, writeLatestResponse } from "./lifecycle.js";
import type { DurableSessionRuntime } from "./state.js";

export function readSignalBuffer(runtime: DurableSessionRuntime): SessionSignalV1[] {
    const signals: SessionSignalV1[] = [];
    for (let index = 0; index < SIGNAL_BUFFER_LIMIT; index++) {
        const raw = runtime.ctx.getValue(`${SIGNAL_BUFFER_KEY_PREFIX}${index}`);
        if (raw != null) signals.push(parseSessionSignal(JSON.parse(raw)));
    }
    return signals;
}

function writeSignalBuffer(runtime: DurableSessionRuntime, signals: SessionSignalV1[]): void {
    for (let index = 0; index < SIGNAL_BUFFER_LIMIT; index++) {
        const key = `${SIGNAL_BUFFER_KEY_PREFIX}${index}`;
        const serialized = signals[index] ? JSON.stringify(signals[index]) : undefined;
        if (serialized !== undefined) {
            if (runtime.ctx.getValue(key) !== serialized) runtime.ctx.setValue(key, serialized);
        } else if (runtime.ctx.getValue(key) != null) {
            runtime.ctx.clearValue(key);
        }
    }
}

export function publishSignalState(
    runtime: DurableSessionRuntime,
    buffered = readSignalBuffer(runtime),
): void {
    const value: SessionSignalState = {
        version: 1,
        ...(runtime.state.pendingSignalWait ? { pendingWait: runtime.state.pendingSignalWait } : {}),
        interrupted: runtime.state.signalWaitInterrupted,
        buffered: buffered.map(summarizeSignal),
    };
    runtime.ctx.setValue(SIGNAL_STATE_KEY, JSON.stringify(value));
}

function readySignalIndex(runtime: DurableSessionRuntime, buffered: SessionSignalV1[]): number {
    if (runtime.state.pendingShutdown) return -1;
    const wait = runtime.state.pendingSignalWait;
    const matchingWake = wait && buffered.some(signal => signal.wake && wait.names.includes(signal.name));
    if (wait && (!runtime.state.signalWaitInterrupted || matchingWake)) {
        const match = buffered.findIndex(signal => wait.names.includes(signal.name));
        if (match >= 0) return match;
    }
    return buffered.findIndex(signal => signal.wake);
}

export function hasReadySignal(runtime: DurableSessionRuntime): boolean {
    return readySignalIndex(runtime, readSignalBuffer(runtime)) >= 0;
}

export function* receiveSignal(runtime: DurableSessionRuntime, value: unknown): Generator<any, void, any> {
    let signal: SessionSignalV1;
    try {
        signal = parseSessionSignal(value);
    } catch (error) {
        if (!(error instanceof SignalValidationError)) throw error;
        yield runtime.manager.recordSessionEvent(runtime.input.sessionId, [{
            eventType: "session.signal_rejected",
            data: { code: error.code, reason: error.message },
        }]);
        return;
    }
    const summary = summarizeSignal(signal);
    if (runtime.state.pendingShutdown) {
        yield runtime.manager.recordSessionEvent(runtime.input.sessionId, [{
            eventType: "session.signal_rejected",
            data: { ...summary, reason: "target_shutting_down" },
        }]);
        return;
    }
    const buffered = readSignalBuffer(runtime);
    if (runtime.state.recentSignalIds.includes(signal.signalId)
        || buffered.some(entry => entry.signalId === signal.signalId)) {
        yield runtime.manager.recordSessionEvent(runtime.input.sessionId, [{
            eventType: "session.signal_duplicate",
            data: { ...summary, windowSize: SIGNAL_DEDUP_LIMIT },
        }]);
        return;
    }
    const dropped = buffered.length === SIGNAL_BUFFER_LIMIT ? buffered.shift() : undefined;
    buffered.push(signal);
    runtime.state.recentSignalIds = [...runtime.state.recentSignalIds, signal.signalId].slice(-SIGNAL_DEDUP_LIMIT);
    writeSignalBuffer(runtime, buffered);
    publishSignalState(runtime, buffered);
    yield runtime.manager.recordSessionEvent(runtime.input.sessionId, [
        { eventType: "session.signal_received", data: summary },
        ...(dropped ? [{
            eventType: "session.signal_dropped",
            data: { ...summarizeSignal(dropped), reason: "buffer_overflow", policy: "drop_oldest", bufferLimit: SIGNAL_BUFFER_LIMIT },
        }] : []),
        { eventType: "session.signal_buffered", data: summary },
    ]);
}

export function* interruptSignalWait(
    runtime: DurableSessionRuntime,
    kind: "user" | "system" | "signal",
): Generator<any, void, any> {
    const wait = runtime.state.pendingSignalWait;
    if (!wait || runtime.state.signalWaitInterrupted) return;
    runtime.state.signalWaitInterrupted = true;
    if (runtime.state.activeTimer?.type === "signal-timeout") runtime.state.activeTimer = null;
    publishSignalState(runtime);
    yield runtime.manager.recordSessionEvent(runtime.input.sessionId, [{
        eventType: "session.signal_wait_interrupted",
        data: { ...wait, kind },
    }]);
}

export function* cancelSignalWait(
    runtime: DurableSessionRuntime,
    disposition: "cancelled" | "replaced" | "stopped" | "session_terminated",
): Generator<any, void, any> {
    const wait = runtime.state.pendingSignalWait;
    if (!wait) return;
    runtime.state.pendingSignalWait = null;
    runtime.state.signalWaitInterrupted = false;
    if (runtime.state.activeTimer?.type === "signal-timeout") runtime.state.activeTimer = null;
    publishSignalState(runtime);
    yield runtime.manager.recordSessionEvent(runtime.input.sessionId, [{
        eventType: "session.signal_wait_cancelled",
        data: { ...wait, disposition },
    }]);
}

export function* armSignalWait(
    runtime: DurableSessionRuntime,
    startedNow?: number,
): Generator<any, void, any> {
    const { state, ctx } = runtime;
    const wait = state.pendingSignalWait;
    if (!wait) return;
    const resumed = state.signalWaitInterrupted;
    state.signalWaitInterrupted = false;
    const now: number = startedNow ?? (yield ctx.utcNow());
    const deadlineMs = wait.deadline ? Date.parse(wait.deadline) : undefined;
    const remainingSeconds = deadlineMs === undefined ? undefined : Math.max(0, Math.ceil((deadlineMs - now) / 1000));
    if (!hasReadySignal(runtime) && state.blobEnabled
        && (remainingSeconds === undefined || planHoldRelease({
            blobEnabled: state.blobEnabled,
            seconds: remainingSeconds,
            holdWindowSeconds: runtime.options.idleTimeout,
        }).shouldRelease)) {
        yield* releaseAffinity(runtime, "signal-wait");
    }
    state.activeTimer = deadlineMs === undefined ? null : {
        type: "signal-timeout",
        signalWaitId: wait.waitId,
        deadlineMs,
        originalDurationMs: deadlineMs - Date.parse(wait.startedAt),
        reason: wait.reason,
    };
    publishSignalState(runtime);
    const reason = `Waiting for signal: ${wait.names.join(", ")} (${wait.reason})`;
    publishStatus(runtime, "waiting", {
        waitReason: reason,
        waitStartedAt: Date.parse(wait.startedAt),
        ...(remainingSeconds !== undefined ? { waitSeconds: remainingSeconds } : {}),
    });
    yield runtime.manager.updateCmsState(runtime.input.sessionId, "waiting", null, reason);
    if (resumed) {
        yield runtime.manager.recordSessionEvent(runtime.input.sessionId, [{
            eventType: "session.signal_wait_resumed",
            data: wait,
        }]);
    }
}

export function* startSignalWait(
    runtime: DurableSessionRuntime,
    request: Extract<SignalWaitRequest, { action: "wait" }>,
    content?: string,
): Generator<any, void, any> {
    yield* cancelSignalWait(runtime, "replaced");
    const now: number = yield runtime.ctx.utcNow();
    const waitId: string = yield runtime.ctx.newGuid();
    runtime.state.pendingSignalWait = {
        waitId,
        names: [...request.names],
        reason: request.reason,
        startedAt: new Date(now).toISOString(),
        ...(request.timeoutSeconds !== undefined
            ? { deadline: new Date(now + request.timeoutSeconds * 1000).toISOString() } : {}),
    };
    runtime.state.signalWaitInterrupted = false;
    runtime.state.pendingInputQuestion = null;
    runtime.state.waitingForAgentIds = null;
    runtime.state.interruptedWaitTimer = null;
    runtime.state.activeTimer = null;
    if (content) {
        yield* writeLatestResponse(runtime, {
            iteration: runtime.state.iteration,
            type: "wait",
            content,
            signalWait: runtime.state.pendingSignalWait,
            waitReason: request.reason,
            waitStartedAt: now,
            ...(request.timeoutSeconds !== undefined ? { waitSeconds: request.timeoutSeconds } : {}),
        });
    }
    yield runtime.manager.recordSessionEvent(runtime.input.sessionId, [{
        eventType: "session.signal_wait_started",
        data: runtime.state.pendingSignalWait,
    }]);
    yield* armSignalWait(runtime, now);
}

export function* takeReadySignal(runtime: DurableSessionRuntime): Generator<any, SessionSignalV1 | undefined, any> {
    const buffered = readSignalBuffer(runtime);
    const index = readySignalIndex(runtime, buffered);
    if (index < 0) return undefined;
    const [signal] = buffered.splice(index, 1);
    const { state } = runtime;
    const wait = state.pendingSignalWait;
    // A matching wake still satisfies a saved wait while an interrupt is
    // budget-blocked. Its accepted user input rides along in budgetStash.
    const matches = wait && wait.names.includes(signal.name);
    const now: number = yield runtime.ctx.utcNow();
    if (matches) {
        state.pendingSignalWait = null;
        state.signalWaitInterrupted = false;
        state.activeTimer = null;
    } else {
        yield* interruptSignalWait(runtime, "signal");
        // A waking signal interrupts an ordinary timer just like queued input;
        // it must not erase the timer when its own turn completes.
        const timer = state.activeTimer;
        if (timer?.type === "wait") {
            state.interruptedWaitTimer = {
                remainingSec: Math.max(1, Math.ceil((timer.deadlineMs - now) / 1000)),
                reason: timer.reason,
                shouldRehydrate: timer.shouldRehydrate ?? false,
                ...(timer.waitPlan ? { waitPlan: timer.waitPlan } : {}),
                interruptKind: "child",
                ...(timer.budget ? { budget: true } : {}),
            };
        } else if (timer?.type === "cron") {
            state.interruptedCronTimer = {
                remainingMs: Math.max(0, timer.deadlineMs - now),
                originalDurationMs: timer.originalDurationMs,
                reason: timer.reason,
            };
        } else if (timer?.type === "agent-poll") {
            state.waitingForAgentIds = null;
        }
        state.activeTimer = null;
    }
    writeSignalBuffer(runtime, buffered);
    publishSignalState(runtime, buffered);
    yield runtime.manager.recordSessionEvent(runtime.input.sessionId, [{
        eventType: "session.signal_consumed",
        data: {
            ...summarizeSignal(signal),
            mode: matches ? "wait" : "wake",
            ...(matches ? { waitId: wait.waitId, waitDurationMs: Math.max(0, now - Date.parse(wait.startedAt)) } : {}),
        },
    }]);
    return signal;
}

export function* timeoutSignalWait(
    runtime: DurableSessionRuntime,
    waitId: string,
): Generator<any, string | undefined, any> {
    const { state } = runtime;
    const wait = state.pendingSignalWait;
    if (!wait || wait.waitId !== waitId || state.signalWaitInterrupted) return undefined;
    state.pendingSignalWait = null;
    if (state.activeTimer?.type === "signal-timeout" && state.activeTimer.signalWaitId === waitId) state.activeTimer = null;
    publishSignalState(runtime);
    yield runtime.manager.recordSessionEvent(runtime.input.sessionId, [{
        eventType: "session.signal_wait_timeout",
        data: wait,
    }]);
    return `[SIGNAL WAIT TIMED OUT]\nNo matching signal (${wait.names.join(", ")}) was consumed before the wait ended. ` +
        `The original deadline was ${wait.deadline}. Continue the existing task and decide how to proceed.`;
}
