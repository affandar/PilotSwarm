import type { CommandMessage, OrchestrationInput, TurnResult } from "../types.js";
import { sanitizePromptAttachmentRefs, ATTACHMENTS_MAX_COUNT } from "../types.js";
import { messageSenderKey } from "../message-sender.js";
import {
    applyChildUpdate,
    maybeResolveAgentWaitCompletion,
    parseChildUpdate,
    isAgentWaitSettledStatus,
} from "./agents.js";
import {
    bufferChildUpdate,
    drainLeadingQueuedScheduleActions,
    flushPendingChildDigestIntoPrompt,
    handleCommand,
    promptIdsIntersectCancellation,
    publishStatus,
    queueFollowup,
    recordCancelledMessageIds,
    wrapWithResumeContext,
} from "./lifecycle.js";
import { shouldWakeParentForChildDigest } from "../child-notifications.js";
import {
    CHILD_UPDATE_BATCH_MS,
    FIFO_BUCKET_COUNT,
    MAX_BUCKET_BYTES,
    MAX_DRAIN_PER_TURN,
    MAX_PREDISPATCH_SWEEP,
    NON_BLOCKING_TIMER_MS,
    PREDISPATCH_CANCEL_SWEEP_MS,
    touchRecentClientMessageIds,
    type ActiveTimer,
    type DurableSessionRuntime,
    type PendingChildDigest,
} from "./state.js";
import { handleTurnResult, processPrompt, processTimer } from "./turn.js";
import { validClientMessageIds , noteMessageSender, applySenderAttribution, maybeQueueSharedPreamble } from "./utils.js";

// ─── KV FIFO bucket primitives ──────────────────────────────

function fifoBucketKey(index: number): string {
    return `fifo.${index}`;
}

function readFifoBucket(ctx: any, index: number): any[] {
    const raw = ctx.getValue(fifoBucketKey(index));
    if (!raw) return [];
    try { return JSON.parse(raw); } catch { return []; }
}

function writeFifoBucket(ctx: any, index: number, items: any[]): void {
    if (items.length === 0) {
        ctx.clearValue(fifoBucketKey(index));
    } else {
        ctx.setValue(fifoBucketKey(index), JSON.stringify(items));
    }
}

export function appendToFifo(runtime: DurableSessionRuntime, newItems: any[]): void {
    const { ctx } = runtime;
    let writeBucketIdx = 0;
    for (let i = FIFO_BUCKET_COUNT - 1; i >= 0; i--) {
        if (readFifoBucket(ctx, i).length > 0) { writeBucketIdx = i; break; }
    }
    for (const item of newItems) {
        const bucket = readFifoBucket(ctx, writeBucketIdx);
        bucket.push(item);
        const serialized = JSON.stringify(bucket);
        if (serialized.length > MAX_BUCKET_BYTES) {
            bucket.pop();
            writeFifoBucket(ctx, writeBucketIdx, bucket);
            writeBucketIdx++;
            if (writeBucketIdx >= FIFO_BUCKET_COUNT) {
                ctx.traceInfo(`[fifo] overflow — ${newItems.length} item(s) may rely on carry-forward`);
                return;
            }
            writeFifoBucket(ctx, writeBucketIdx, [item]);
        } else {
            writeFifoBucket(ctx, writeBucketIdx, bucket);
        }
    }
}

function popFifoItem(runtime: DurableSessionRuntime): any | null {
    const { ctx } = runtime;
    for (let i = 0; i < FIFO_BUCKET_COUNT; i++) {
        const items = readFifoBucket(ctx, i);
        if (items.length > 0) {
            const [first, ...rest] = items;
            writeFifoBucket(ctx, i, rest);
            return first;
        }
    }
    return null;
}

function popFirstFifoItemMatching(runtime: DurableSessionRuntime, predicate: (item: any) => boolean): any | null {
    const { ctx } = runtime;
    for (let i = 0; i < FIFO_BUCKET_COUNT; i++) {
        const items = readFifoBucket(ctx, i);
        const index = items.findIndex(predicate);
        if (index >= 0) {
            const [item] = items.splice(index, 1);
            writeFifoBucket(ctx, i, items);
            return item;
        }
    }
    return null;
}

function popNextDispatchFifoItem(runtime: DurableSessionRuntime): any | null {
    const interactive = popFirstFifoItemMatching(
        runtime,
        (item) => item?.kind === "prompt" || item?.kind === "answer",
    );
    if (interactive) {
        runtime.ctx.traceInfo(`[fifo] dispatching interactive ${interactive.kind} before queued timers`);
        return interactive;
    }
    return popFifoItem(runtime);
}

function hasFifoItems(runtime: DurableSessionRuntime): boolean {
    const { ctx } = runtime;
    for (let i = 0; i < FIFO_BUCKET_COUNT; i++) {
        if (readFifoBucket(ctx, i).length > 0) return true;
    }
    return false;
}

function appendPromptStashToFifo(runtime: DurableSessionRuntime, stash: any[]): void {
    appendToFifo(runtime, stash);
    for (const item of stash) {
        if (item?.kind !== "prompt") continue;
        const ids = validClientMessageIds(item.clientMessageIds);
        touchRecentClientMessageIds(runtime.state, ids);
    }
}

function duplicateClientMessageIds(
    runtime: DurableSessionRuntime,
    ids: string[],
    pendingIds: Set<string>,
): string[] {
    if (ids.length === 0) return [];
    const recent = new Set(runtime.state.recentClientMessageIds);
    return ids.filter((id) => recent.has(id) || pendingIds.has(id));
}

function* recordDuplicatePrompt(
    runtime: DurableSessionRuntime,
    ids: string[],
    duplicateIds: string[],
    source: string,
): Generator<any, void, any> {
    const recent = new Set(runtime.state.recentClientMessageIds);
    touchRecentClientMessageIds(runtime.state, duplicateIds.filter((id) => recent.has(id)));
    runtime.ctx.traceInfo(`[${source}] suppressing duplicate prompt (duplicateIds=${duplicateIds.join(",")})`);
    yield runtime.manager.recordSessionEvent(runtime.input.sessionId, [{
        eventType: "session.message_duplicate_suppressed",
        data: {
            clientMessageIds: ids,
            duplicateClientMessageIds: duplicateIds,
            windowSize: 20,
            source,
        },
    }]);
}

// ─── Timer race candidate selection ─────────────────────────

function nextTimerCandidate(
    activeTimer: ActiveTimer | null,
    pendingChildDigest: PendingChildDigest | null,
    now: number,
): { kind: "active" | "child-digest"; remainingMs: number; timer?: ActiveTimer } | null {
    const candidates: Array<{ kind: "active" | "child-digest"; remainingMs: number; timer?: ActiveTimer }> = [];
    if (activeTimer) {
        candidates.push({
            kind: "active",
            remainingMs: Math.max(0, activeTimer.deadlineMs - now),
            timer: activeTimer,
        });
    }
    if (pendingChildDigest && !pendingChildDigest.ready && pendingChildDigest.updates.length > 0) {
        candidates.push({
            kind: "child-digest",
            remainingMs: Math.max(0, pendingChildDigest.startedAtMs + CHILD_UPDATE_BATCH_MS - now),
        });
    }
    if (candidates.length === 0) return null;
    candidates.sort((left, right) => left.remainingMs - right.remainingMs);
    return candidates[0];
}

// ─── drain: greedily move queue events + timer fires into KV FIFO ──

function hasReadyPendingChildDigest(runtime: DurableSessionRuntime): boolean {
    const digest = runtime.state.pendingChildDigest;
    return Boolean(digest?.ready && digest.updates.length > 0);
}

function needsBlockingDequeue(runtime: DurableSessionRuntime): boolean {
    const { state } = runtime;
    return (
        state.legacyPendingMessage === undefined &&
        !state.activeTimer &&
        !hasReadyPendingChildDigest(runtime) &&
        state.pendingToolActions.length === 0 &&
        !state.pendingPrompt &&
        !hasFifoItems(runtime)
    );
}

export function* drain(runtime: DurableSessionRuntime): Generator<any, void, any> {
    const { ctx, state } = runtime;
    const stash: any[] = [];
    const seenChildUpdates = new Set<string>();
    const cancelledThisDrain = new Set<string>();
    const pendingClientMessageIds = new Set<string>();

    for (let i = 0; i < MAX_DRAIN_PER_TURN; i++) {
        let msg: any = null;

        if (state.legacyPendingMessage !== undefined) {
            msg = state.legacyPendingMessage;
            state.legacyPendingMessage = undefined;

        } else if (state.regen) {
            // Session regeneration: while a pipeline is pending, drain does a
            // SINGLE non-blocking sweep for a pre-empting control cmd
            // (cancel_regen / cancel / delete) and then yields to the run loop
            // to advance the next stage. It must never park on the session's
            // armed idle/affinity/cron timer (up to 30 min) or on a blocking
            // dequeue — either would stall the flip indefinitely.
            const msgTask = ctx.dequeueEvent("messages");
            const timerTask = ctx.scheduleTimer(NON_BLOCKING_TIMER_MS);
            const race: any = yield ctx.race(msgTask, timerTask);
            if (race.index === 1) break;
            msg = typeof race.value === "string" ? JSON.parse(race.value) : race.value;

        } else if (state.activeTimer || (state.pendingChildDigest && !state.pendingChildDigest.ready)) {
            const now: number = yield ctx.utcNow();
            const candidate = nextTimerCandidate(state.activeTimer, state.pendingChildDigest, now);
            if (!candidate) continue;

            if (candidate.remainingMs === 0) {
                if (candidate.kind === "active" && candidate.timer) {
                    stash.push({ kind: "timer", timer: { ...candidate.timer }, firedAtMs: now });
                    state.activeTimer = null;
                } else if (state.pendingChildDigest && state.pendingChildDigest.updates.length > 0) {
                    state.pendingChildDigest.ready = true;
                    break;
                }
                continue;
            }

            const msgTask = ctx.dequeueEvent("messages");
            const timerTask = ctx.scheduleTimer(candidate.remainingMs);
            const race: any = yield ctx.race(msgTask, timerTask);

            if (race.index === 1) {
                if (candidate.kind === "active" && candidate.timer) {
                    const firedAt: number = yield ctx.utcNow();
                    stash.push({ kind: "timer", timer: { ...candidate.timer }, firedAtMs: firedAt });
                    state.activeTimer = null;
                } else if (state.pendingChildDigest && state.pendingChildDigest.updates.length > 0) {
                    state.pendingChildDigest.ready = true;
                    break;
                }
                continue;
            }

            msg = typeof race.value === "string" ? JSON.parse(race.value) : race.value;

        } else if (!state.regen && needsBlockingDequeue(runtime)) {
            if (i > 0) break;
            if (state.pendingInputQuestion) {
                publishStatus(runtime, "input_required");
            } else if (state.blockedError) {
                publishStatus(runtime, "error", {
                    error: state.blockedError.message,
                    retriesExhausted: true,
                    ...(state.blockedError.authFailure ? { authFailure: true } : {}),
                });
            } else {
                publishStatus(runtime, "idle");
            }
            const rawMsg: any = yield ctx.dequeueEvent("messages");
            msg = typeof rawMsg === "string" ? JSON.parse(rawMsg) : rawMsg;

        } else {
            const msgTask = ctx.dequeueEvent("messages");
            const timerTask = ctx.scheduleTimer(NON_BLOCKING_TIMER_MS);
            const race: any = yield ctx.race(msgTask, timerTask);
            if (race.index === 1) break;
            msg = typeof race.value === "string" ? JSON.parse(race.value) : race.value;
        }

        if (!msg) continue;

        if (msg && Array.isArray(msg.cancelPending) && msg.cancelPending.length > 0) {
            const validCancelIds: string[] = [];
            for (const id of msg.cancelPending) {
                if (typeof id === "string" && id) {
                    validCancelIds.push(id);
                    cancelledThisDrain.add(id);
                    state.cancelledMessageIds.add(id);
                }
            }
            if (validCancelIds.length > 0) {
                ctx.traceInfo(`[drain] received cancel tombstone (ids=${validCancelIds.join(",")})`);
            }
            for (let s = stash.length - 1; s >= 0; s--) {
                const item = stash[s];
                if (item?.kind !== "prompt") continue;
                const ids: string[] = Array.isArray(item.clientMessageIds) ? item.clientMessageIds : [];
                if (ids.some((id) => cancelledThisDrain.has(id))) {
                    ctx.traceInfo(`[drain] dropping stashed prompt cancelled by tombstone (ids=${ids.join(",")})`);
                    yield* recordCancelledMessageIds(runtime, ids, "drain-stash");
                    stash.splice(s, 1);
                }
            }
            continue;
        }

        if (msg.type === "cmd") {
            if (stash.length > 0) { appendPromptStashToFifo(runtime, stash); stash.length = 0; }
            yield* handleCommand(runtime, msg as CommandMessage);
            if (state.orchestrationResult !== null) return;
            // Session regeneration: a pending pipeline is advanced by the run
            // loop — return control instead of draining on (a blocking
            // dequeue here would park the session with the regen never
            // starting). Later cmds still pre-empt: the loop re-enters drain
            // between stages and this pass is non-blocking while regen is set.
            if (state.regen) return;
            continue;
        }

        const childUpdate = parseChildUpdate(msg.prompt);
        if (childUpdate) {
            const key = `${childUpdate.sessionId}|${childUpdate.updateType}|${childUpdate.content ?? ""}`;
            if (!seenChildUpdates.has(key)) {
                seenChildUpdates.add(key);
                const wasExpectingReport = state.subAgents.find(
                    (agent) => agent.sessionId === childUpdate.sessionId,
                )?.expectsReport === true;
                const tracked = yield* applyChildUpdate(runtime, childUpdate);
                if (tracked && !state.pendingShutdown) {
                    const childObservedAt: number = yield ctx.utcNow();
                    bufferChildUpdate(runtime, childUpdate, childObservedAt);
                    // Fast-path only on a FIRST report from a child spawned with
                    // an outstanding expectation — routine later updates keep
                    // the normal batch window.
                    if (wasExpectingReport) markDigestReadyIfAllAgentsSettled(runtime);
                }
                if (tracked && state.waitingForAgentIds) {
                    yield* maybeResolveAgentWaitCompletion(runtime);
                }
            }
            continue;
        }

        if (msg.answer !== undefined) {
            const interruptsInputHold = Boolean(state.pendingInputQuestion)
                && (state.activeTimer?.type === "input-grace" || state.activeTimer?.type === "idle");
            if (interruptsInputHold) {
                ctx.traceInfo(`[drain] answer interrupted ${state.activeTimer!.type} timer`);
                state.activeTimer = null;
            }
            stash.push({ kind: "answer", answer: msg.answer, wasFreeform: msg.wasFreeform, ...(msg.sender && typeof msg.sender === "object" ? { sender: msg.sender } : {}) });
            if (interruptsInputHold) break;
            continue;
        }

        if (msg.prompt) {
            const incomingClientMessageIds: string[] = validClientMessageIds(msg.clientMessageIds);
            if (promptIdsIntersectCancellation(runtime, incomingClientMessageIds)) {
                ctx.traceInfo(`[drain] dropping incoming prompt cancelled by tombstone (ids=${incomingClientMessageIds.join(",")})`);
                yield* recordCancelledMessageIds(runtime, incomingClientMessageIds, "drain-incoming");
                continue;
            }

            const duplicateIds = duplicateClientMessageIds(runtime, incomingClientMessageIds, pendingClientMessageIds);
            if (duplicateIds.length > 0) {
                yield* recordDuplicatePrompt(runtime, incomingClientMessageIds, duplicateIds, "drain");
                continue;
            }

            let userPrompt = msg.prompt;
            state.blockedError = undefined;

            if (state.activeTimer?.type === "wait") {
                const now: number = yield ctx.utcNow();
                const remainingMs = Math.max(0, state.activeTimer.deadlineMs - now);
                const remainingSec = Math.round(remainingMs / 1000);
                const elapsedMs = state.activeTimer.originalDurationMs - remainingMs;
                const elapsedSec = Math.round(elapsedMs / 1000);
                const totalSec = Math.round(state.activeTimer.originalDurationMs / 1000);
                ctx.traceInfo(`[drain] user prompt interrupted wait timer, ${remainingSec}s remain — orchestration will auto-resume`);

                state.interruptedWaitTimer = {
                    remainingSec,
                    reason: state.activeTimer.reason,
                    shouldRehydrate: state.activeTimer.shouldRehydrate ?? false,
                    waitPlan: state.activeTimer.waitPlan,
                    interruptKind: "user",
                };

                if (state.activeTimer.shouldRehydrate && userPrompt) {
                    userPrompt = wrapWithResumeContext(
                        runtime,
                        userPrompt,
                        `Your ${totalSec}s timer (reason: "${state.activeTimer.reason}") was interrupted by the above message. ` +
                        `${elapsedSec}s elapsed, ${remainingSec}s remain. ` +
                        `Reply to the message. The timer will be automatically resumed after your reply.`,
                    );
                } else if (userPrompt) {
                    userPrompt = `${userPrompt}\n\n` +
                        `[SYSTEM: The above is a message that interrupted your ${totalSec}s timer (reason: "${state.activeTimer.reason}"). ` +
                        `${elapsedSec}s elapsed, ${remainingSec}s remain. ` +
                        `Reply to the message. The timer will be automatically resumed after your reply.]`;
                }
                state.activeTimer = null;
            } else if (state.activeTimer?.type === "cron") {
                const activeCron = state.cronSchedule;
                const now: number = yield ctx.utcNow();
                const remainingMs = Math.max(0, state.activeTimer.deadlineMs - now);
                state.interruptedCronTimer = {
                    remainingMs,
                    reason: state.activeTimer.reason,
                    originalDurationMs: state.activeTimer.originalDurationMs,
                    ...(state.activeTimer.shouldRehydrate ? { shouldRehydrate: true } : {}),
                };
                const cronResumeNote =
                    `This is an internal recurring schedule, not a new user prompt. ` +
                    `There is an active recurring schedule every ${activeCron?.intervalSeconds ?? "?"} seconds for "${activeCron?.reason ?? state.activeTimer.reason}". ` +
                    `The next cron wake-up will keep the original schedule and resume after the remaining ${Math.round(remainingMs / 1000)} seconds unless you explicitly reset cron. ` +
                    `Do NOT call wait() just to keep the recurring loop alive. ` +
                    `Call cron(action="cancel") only if you need to stop it.`;
                if (state.activeTimer.shouldRehydrate && userPrompt) {
                    userPrompt = wrapWithResumeContext(runtime, userPrompt, cronResumeNote);
                } else if (userPrompt) {
                    userPrompt = `${userPrompt}\n\n[SYSTEM: ${cronResumeNote}]`;
                }
                ctx.traceInfo(`[drain] user prompt interrupted cron timer`);
                state.activeTimer = null;
            } else if (state.activeTimer?.type === "cron_at") {
                const activeCronAt = state.cronAtSchedule;
                const now: number = yield ctx.utcNow();
                const remainingMs = Math.max(0, state.activeTimer.deadlineMs - now);
                const scheduledAt = activeCronAt?.nextFireAtMs ? new Date(activeCronAt.nextFireAtMs).toISOString() : "unknown";
                const cronAtResumeNote =
                    `This is an internal wall-clock recurring schedule, not a new user prompt. ` +
                    `There is an active wall-clock schedule for "${activeCronAt?.reason ?? state.activeTimer.reason}". ` +
                    `The pending scheduled fire (${scheduledAt}) is preserved and will run after this turn completes; ` +
                    `if the scheduled time passes while you respond, it will fire immediately afterward unless you explicitly cancel or reset the schedule. ` +
                    `Do NOT call wait() just to keep the recurring loop alive. ` +
                    `Call cron_at(action="cancel") only if you need to stop it.`;
                if (state.activeTimer.shouldRehydrate && userPrompt) {
                    userPrompt = wrapWithResumeContext(runtime, userPrompt, cronAtResumeNote);
                } else if (userPrompt) {
                    userPrompt = `${userPrompt}\n\n[SYSTEM: ${cronAtResumeNote}]`;
                }
                ctx.traceInfo(`[drain] user prompt interrupted cron_at timer (${Math.round(remainingMs / 1000)}s remain)`);
                state.activeTimer = null;
            } else if (state.activeTimer?.type === "idle") {
                ctx.traceInfo(`[drain] user prompt within idle window, cancelling idle timer`);
                state.activeTimer = null;
            } else if (state.activeTimer?.type === "agent-poll") {
                ctx.traceInfo(`[drain] user prompt interrupted agent wait`);
                state.waitingForAgentIds = null;
                state.activeTimer = null;
            }

            if (state.pendingChildDigest?.updates.length) {
                userPrompt = flushPendingChildDigestIntoPrompt(runtime, userPrompt);
            }

            const incomingAttachments = sanitizePromptAttachmentRefs(msg.attachments);
            stash.push({
                kind: "prompt",
                prompt: userPrompt,
                bootstrap: Boolean(msg.bootstrap),
                ...(msg.requiredTool ? { requiredTool: msg.requiredTool } : {}),
                ...(incomingClientMessageIds.length > 0 ? { clientMessageIds: incomingClientMessageIds } : {}),
                ...(msg.sender && typeof msg.sender === "object" ? { sender: msg.sender } : {}),
                ...(incomingAttachments.length > 0 ? { attachments: incomingAttachments } : {}),
            });
            for (const id of incomingClientMessageIds) pendingClientMessageIds.add(id);
            continue;
        }

        ctx.traceInfo(`[drain] skipping unknown: ${JSON.stringify(msg).slice(0, 120)}`);
    }

    if (stash.length > 0) appendPromptStashToFifo(runtime, stash);
}

// ─── Pre-dispatch sweep: grab any pending cancel tombstone ──

function* sweepMessagesBeforePromptDispatch(runtime: DurableSessionRuntime): Generator<any, void, any> {
    const { ctx, state } = runtime;
    const stash: any[] = [];
    const seenChildUpdates = new Set<string>();
    const pendingClientMessageIds = new Set<string>();

    for (let i = 0; i < MAX_PREDISPATCH_SWEEP; i++) {
        const msgTask = ctx.dequeueEvent("messages");
        const timerTask = ctx.scheduleTimer(PREDISPATCH_CANCEL_SWEEP_MS);
        const race: any = yield ctx.race(msgTask, timerTask);
        if (race.index === 1) break;

        const msg = typeof race.value === "string" ? JSON.parse(race.value) : race.value;
        if (!msg) continue;

        if (msg && Array.isArray(msg.cancelPending) && msg.cancelPending.length > 0) {
            const validCancelIds = validClientMessageIds(msg.cancelPending);
            for (const id of validCancelIds) state.cancelledMessageIds.add(id);
            if (validCancelIds.length > 0) {
                ctx.traceInfo(`[predispatch] received cancel tombstone (ids=${validCancelIds.join(",")})`);
                for (let s = stash.length - 1; s >= 0; s--) {
                    const item = stash[s];
                    if (item?.kind !== "prompt") continue;
                    const ids: string[] = Array.isArray(item.clientMessageIds) ? item.clientMessageIds : [];
                    if (ids.some((id) => validCancelIds.includes(id))) {
                        ctx.traceInfo(`[predispatch] dropping stashed prompt cancelled by tombstone (ids=${ids.join(",")})`);
                        yield* recordCancelledMessageIds(runtime, ids, "predispatch-stash");
                        stash.splice(s, 1);
                    }
                }
            }
            continue;
        }

        if (msg.type === "cmd") {
            if (stash.length > 0) { appendPromptStashToFifo(runtime, stash); stash.length = 0; }
            yield* handleCommand(runtime, msg as CommandMessage);
            if (state.orchestrationResult !== null) return;
            // Session regeneration: a pending pipeline is advanced by the run
            // loop — return control instead of draining on (a blocking
            // dequeue here would park the session with the regen never
            // starting). Later cmds still pre-empt: the loop re-enters drain
            // between stages and this pass is non-blocking while regen is set.
            if (state.regen) return;
            continue;
        }

        const childUpdate = parseChildUpdate(msg.prompt);
        if (childUpdate) {
            const key = `${childUpdate.sessionId}|${childUpdate.updateType}|${childUpdate.content ?? ""}`;
            if (!seenChildUpdates.has(key)) {
                seenChildUpdates.add(key);
                const wasExpectingReport = state.subAgents.find(
                    (agent) => agent.sessionId === childUpdate.sessionId,
                )?.expectsReport === true;
                const tracked = yield* applyChildUpdate(runtime, childUpdate);
                if (tracked && !state.pendingShutdown) {
                    const childObservedAt: number = yield ctx.utcNow();
                    bufferChildUpdate(runtime, childUpdate, childObservedAt);
                    // Fast-path only on a FIRST report from a child spawned with
                    // an outstanding expectation — routine later updates keep
                    // the normal batch window.
                    if (wasExpectingReport) markDigestReadyIfAllAgentsSettled(runtime);
                }
                if (tracked && state.waitingForAgentIds) {
                    yield* maybeResolveAgentWaitCompletion(runtime);
                }
            }
            continue;
        }

        if (msg.answer !== undefined) {
            stash.push({ kind: "answer", answer: msg.answer, wasFreeform: msg.wasFreeform, ...(msg.sender && typeof msg.sender === "object" ? { sender: msg.sender } : {}) });
            continue;
        }

        if (msg.prompt) {
            const incomingClientMessageIds = validClientMessageIds(msg.clientMessageIds);
            if (promptIdsIntersectCancellation(runtime, incomingClientMessageIds)) {
                ctx.traceInfo(`[predispatch] dropping incoming prompt cancelled by tombstone (ids=${incomingClientMessageIds.join(",")})`);
                yield* recordCancelledMessageIds(runtime, incomingClientMessageIds, "predispatch-incoming");
                continue;
            }
            const duplicateIds = duplicateClientMessageIds(runtime, incomingClientMessageIds, pendingClientMessageIds);
            if (duplicateIds.length > 0) {
                yield* recordDuplicatePrompt(runtime, incomingClientMessageIds, duplicateIds, "predispatch");
                continue;
            }
            const sweepAttachments = sanitizePromptAttachmentRefs(msg.attachments);
            stash.push({
                kind: "prompt",
                prompt: msg.prompt,
                bootstrap: Boolean(msg.bootstrap),
                ...(msg.requiredTool ? { requiredTool: msg.requiredTool } : {}),
                ...(incomingClientMessageIds.length > 0 ? { clientMessageIds: incomingClientMessageIds } : {}),
                ...(msg.sender && typeof msg.sender === "object" ? { sender: msg.sender } : {}),
                ...(sweepAttachments.length > 0 ? { attachments: sweepAttachments } : {}),
            });
            for (const id of incomingClientMessageIds) pendingClientMessageIds.add(id);
            continue;
        }

        ctx.traceInfo(`[predispatch] skipping unknown: ${JSON.stringify(msg).slice(0, 120)}`);
    }

    if (stash.length > 0) appendPromptStashToFifo(runtime, stash);
}

// ─── decide: pop and process one item from FIFO ─────────────

function* processAnswer(runtime: DurableSessionRuntime, answerItem: any): Generator<any, void, any> {
    const question = runtime.state.pendingInputQuestion?.question ?? "a question";
    runtime.state.pendingInputQuestion = null;
    // Any writer may answer (security model); attribution shows who did.
    const sender = noteMessageSender(runtime, answerItem.sender);
    const answeredBy = runtime.state.multiWriter && sender?.display ? ` (answered by ${sender.display})` : "";
    const answerPrompt = `The user was asked: "${question}"\nThe user responded${answeredBy}: "${answerItem.answer}"`;
    maybeQueueSharedPreamble(runtime);
    yield* processPrompt(runtime, answerPrompt, false, undefined, undefined, undefined, sender);
}

export function* decide(runtime: DurableSessionRuntime): Generator<any, boolean, any> {
    const { ctx, state } = runtime;

    // Priority 1: pending tool actions (in-memory, replay carry-forward).
    yield* drainLeadingQueuedScheduleActions(runtime);
    if (state.pendingToolActions.length > 0) {
        const action = state.pendingToolActions.shift()!;
        ctx.traceInfo(`[orch] replaying queued action: ${action.type} remaining=${state.pendingToolActions.length}`);
        yield* handleTurnResult(runtime, action as unknown as TurnResult, "");
        return true;
    }

    // Priority 2: pending prompt (CAN carry-forward or queueFollowup).
    // Hold while waiting for agents — let confirmations accumulate and merge
    // with the agents-done summary for one combined LLM turn.
    if (state.pendingPrompt && !state.waitingForAgentIds) {
        const prompt = state.pendingPrompt;
        const isBootstrap = state.bootstrapPrompt;
        const requiredTool = state.pendingRequiredTool;
        const cycleOrigin = state.pendingCycleOrigin;
        const pendingAttachments = state.pendingAttachments;
        state.pendingPrompt = undefined;
        state.bootstrapPrompt = false;
        state.pendingRequiredTool = undefined;
        state.pendingCycleOrigin = undefined;
        state.pendingAttachments = undefined;
        yield* processPrompt(
            runtime,
            prompt,
            isBootstrap,
            requiredTool,
            undefined,
            cycleOrigin,
            undefined,
            pendingAttachments && pendingAttachments.length > 0 ? pendingAttachments : undefined,
        );
        return true;
    }

    // Priority 3: FIFO — next item in arrival order, with prompt batching.
    const item = popNextDispatchFifoItem(runtime);
    if (item) {
        switch (item.kind) {
            case "prompt": {
                const ids: string[] = Array.isArray(item.clientMessageIds) ? item.clientMessageIds : [];
                if (ids.length > 0) {
                    yield* sweepMessagesBeforePromptDispatch(runtime);
                    if (state.orchestrationResult !== null) return true;
                }
                if (promptIdsIntersectCancellation(runtime, ids)) {
                    ctx.traceInfo(`[decide] dropping FIFO prompt cancelled by tombstone (ids=${ids.join(",")})`);
                    yield* recordCancelledMessageIds(runtime, ids, "decide-fifo");
                    return true;
                }

                // Batch consecutive prompt FIFO items into a single Copilot turn.
                // Multi-writer attribution: note each item's sender (may flip
                // the session to multi-writer), prefix segments with [FROM:]
                // once flipped, and keep a single turn-level sender only when
                // every merged segment came from the same identity.
                const firstSender = noteMessageSender(runtime, item.sender);
                let mergedPrompt = applySenderAttribution(runtime, firstSender, String(item.prompt || ""));
                let mergedBootstrap = item.bootstrap ?? false;
                let mergedRequiredTool = item.requiredTool;
                const mergedClientMessageIds: string[] = [...ids];
                const mergedAttachments = sanitizePromptAttachmentRefs(item.attachments);
                let turnSender = firstSender;
                let mixedSenders = false;
                while (true) {
                    const peek = popFifoItem(runtime);
                    if (!peek) break;
                    if (peek.kind !== "prompt") {
                        appendToFifo(runtime, [peek]);
                        break;
                    }
                    const peekIds: string[] = Array.isArray(peek.clientMessageIds) ? peek.clientMessageIds : [];
                    if (promptIdsIntersectCancellation(runtime, peekIds)) {
                        ctx.traceInfo(`[decide] dropping merged FIFO prompt cancelled by tombstone (ids=${peekIds.join(",")})`);
                        yield* recordCancelledMessageIds(runtime, peekIds, "decide-merge");
                        continue;
                    }
                    const peekSender = noteMessageSender(runtime, peek.sender);
                    if (messageSenderKey(peekSender ?? null) !== messageSenderKey(turnSender ?? null)) {
                        mixedSenders = true;
                    }
                    mergedPrompt = `${mergedPrompt}\n\n${applySenderAttribution(runtime, peekSender, String(peek.prompt || ""))}`;
                    mergedBootstrap = mergedBootstrap || (peek.bootstrap ?? false);
                    if (!mergedRequiredTool && peek.requiredTool) mergedRequiredTool = peek.requiredTool;
                    for (const id of peekIds) mergedClientMessageIds.push(id);
                    // Merged messages pool their image attachments in arrival
                    // order, bounded by the per-turn cap (overflow is dropped
                    // here deterministically rather than failing the turn).
                    for (const ref of sanitizePromptAttachmentRefs(peek.attachments)) {
                        if (mergedAttachments.length >= ATTACHMENTS_MAX_COUNT) break;
                        mergedAttachments.push(ref);
                    }
                }
                maybeQueueSharedPreamble(runtime);
                yield* processPrompt(
                    runtime,
                    mergedPrompt,
                    mergedBootstrap,
                    mergedRequiredTool,
                    mergedClientMessageIds.length > 0 ? mergedClientMessageIds : undefined,
                    undefined,
                    mixedSenders ? undefined : turnSender,
                    mergedAttachments.length > 0 ? mergedAttachments : undefined,
                );
                break;
            }
            case "answer":
                yield* processAnswer(runtime, item);
                break;
            case "timer":
                yield* processTimer(runtime, item);
                break;
            case "agents-done":
                queueFollowup(runtime, item.summary);
                break;
            default:
                ctx.traceInfo(`[decide] unknown FIFO item kind: ${item.kind}`);
        }
        return true;
    }

    // Priority 4: buffered child digest — only after user/FIFO work is drained.
    if (state.pendingChildDigest?.ready && state.pendingChildDigest.updates.length > 0 && !state.waitingForAgentIds) {
        yield* processPendingChildDigest(runtime);
        return true;
    }

    return false;
}

// ─── pending child digest dispatch (timer-aware) ────────────

import {
    buildPendingChildDigestSystemPrompt,
    clearPendingChildDigest,
} from "./lifecycle.js";

/**
 * All-quiet fast path: a freshly buffered child update revealed that EVERY
 * tracked sub-agent is settled (terminal, idle, or blocked on input) — nothing
 * will ever act again unprompted. Deliver the digest immediately instead of
 * waiting out the remainder of the batch window so the parent looks at its
 * children NOW rather than after a human pokes it.
 */
function markDigestReadyIfAllAgentsSettled(runtime: DurableSessionRuntime): void {
    const { state } = runtime;
    if (state.waitingForAgentIds) return; // wait resolution handles this case
    if (!state.pendingChildDigest || state.pendingChildDigest.updates.length === 0) return;
    if (state.subAgents.length === 0) return;
    if (!state.subAgents.every((agent) => isAgentWaitSettledStatus(agent.status))) return;
    state.pendingChildDigest.ready = true;
}


function* processPendingChildDigest(runtime: DurableSessionRuntime): Generator<any, void, any> {
    const { ctx, state } = runtime;
    const digestPrompt = buildPendingChildDigestSystemPrompt(runtime);
    if (!digestPrompt) {
        clearPendingChildDigest(runtime);
        return;
    }

    const digestDecision = shouldWakeParentForChildDigest(
        state.pendingChildDigest!.updates.map((update) => {
            const agent = state.subAgents.find((entry) => entry.sessionId === update.sessionId);
            return {
                update: {
                    kind: update.updateType === "wait"
                        ? "wait"
                        : update.updateType === "failed"
                            ? "error"
                            : update.updateType === "cancelled" || update.updateType === "deleted"
                                ? "cancelled"
                                : update.updateType === "completed"
                                    ? "completed"
                                    : "progress",
                    summary: update.content,
                    ...(update.cycleOrigin ? { cyclic: true } : {}),
                    ...(update.cycleStatus === "material" || update.cycleStatus === "blocked"
                        ? { material: true }
                        : update.cycleStatus === "quiet"
                            ? { material: false }
                            : {}),
                            ...(update.verdict ? { result: { verdict: update.verdict } } : update.cycleStatus === "blocked" ? { result: { verdict: "blocked" as const } } : {}),
                },
                contract: agent?.contract,
            } as const;
        }),
    );
    if (!digestDecision.wake) {
        yield runtime.manager.recordSessionEvent(runtime.input.sessionId, [{
            eventType: "session.child_update_suppressed",
            data: {
                reason: digestDecision.reason,
                policy: digestDecision.policy,
                classification: digestDecision.classification,
                updateCount: state.pendingChildDigest!.updates.length,
            },
        }]);
        clearPendingChildDigest(runtime);
        return;
    }

    if (state.activeTimer?.type === "wait") {
        const now: number = yield ctx.utcNow();
        const remainingMs = Math.max(0, state.activeTimer.deadlineMs - now);
        const remainingSec = Math.round(remainingMs / 1000);
        const elapsedMs = state.activeTimer.originalDurationMs - remainingMs;
        const elapsedSec = Math.round(elapsedMs / 1000);
        const totalSec = Math.round(state.activeTimer.originalDurationMs / 1000);
        state.interruptedWaitTimer = {
            remainingSec,
            reason: state.activeTimer.reason,
            shouldRehydrate: state.activeTimer.shouldRehydrate ?? false,
            waitPlan: state.activeTimer.waitPlan,
            interruptKind: "child",
        };
        state.activeTimer = null;
        clearPendingChildDigest(runtime);
        yield* processPrompt(
            runtime,
            `[SYSTEM: Buffered child updates interrupted your ${totalSec}s timer (reason: "${state.interruptedWaitTimer.reason}"). ` +
                `${elapsedSec}s elapsed, ${remainingSec}s remain. ` +
                `Review the updates and continue your task now. The remaining wait will be resumed automatically after this turn completes.\n\n${digestPrompt}]`,
            true,
        );
        return;
    }

    if (state.activeTimer?.type === "cron") {
        const activeCron = state.cronSchedule;
        const now: number = yield ctx.utcNow();
        const remainingMs = Math.max(0, state.activeTimer.deadlineMs - now);
        state.interruptedCronTimer = {
            remainingMs,
            reason: state.activeTimer.reason,
            originalDurationMs: state.activeTimer.originalDurationMs,
            ...(state.activeTimer.shouldRehydrate ? { shouldRehydrate: true } : {}),
        };
        state.activeTimer = null;
        clearPendingChildDigest(runtime);
        yield* processPrompt(
            runtime,
            `[SYSTEM: This is an internal orchestration wake-up caused by child session updates; the user did not send a new message. ` +
                `Buffered child updates arrived while your recurring schedule was waiting for the next wake-up${activeCron ? ` ("${activeCron.reason}")` : ""}. ` +
                `Review the updates and continue your task now. The recurring cron schedule remains active and will be re-armed automatically after this turn completes.\n\n${digestPrompt}]`,
            true,
        );
        return;
    }

    if (state.activeTimer?.type === "cron_at") {
        const activeCronAt = state.cronAtSchedule;
        const scheduledAt = activeCronAt?.nextFireAtMs ? new Date(activeCronAt.nextFireAtMs).toISOString() : "unknown";
        state.activeTimer = null;
        clearPendingChildDigest(runtime);
        yield* processPrompt(
            runtime,
            `[SYSTEM: This is an internal orchestration wake-up caused by child session updates; the user did not send a new message. ` +
                `Buffered child updates arrived while your wall-clock schedule was waiting for its next fire${activeCronAt ? ` ("${activeCronAt.reason}", scheduled ${scheduledAt})` : ""}. ` +
                `Review the updates and continue your task now. The wall-clock cron schedule remains active and will be re-armed automatically after this turn completes.\n\n${digestPrompt}]`,
            true,
        );
        return;
    }

    if (state.activeTimer?.type === "idle") {
        state.activeTimer = null;
    } else if (state.activeTimer?.type === "agent-poll") {
        state.waitingForAgentIds = null;
        state.activeTimer = null;
    }

    clearPendingChildDigest(runtime);
    yield* processPrompt(runtime, `[SYSTEM: ${digestPrompt}]`, true);
}

// Re-export for any external consumers (e.g. legacy compat shims).
export { OrchestrationInput };
