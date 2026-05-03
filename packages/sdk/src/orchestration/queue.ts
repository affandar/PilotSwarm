import type { CommandMessage, OrchestrationInput, TurnResult } from "../types.js";
import {
    applyChildUpdate,
    maybeResolveAgentWaitCompletion,
    parseChildUpdate,
} from "./agents.js";
import {
    bufferChildUpdate,
    drainLeadingQueuedCronActions,
    flushPendingChildDigestIntoPrompt,
    handleCommand,
    promptIdsIntersectCancellation,
    publishStatus,
    queueFollowup,
    recordCancelledMessageIds,
    wrapWithResumeContext,
} from "./lifecycle.js";
import {
    CHILD_UPDATE_BATCH_MS,
    FIFO_BUCKET_COUNT,
    MAX_BUCKET_BYTES,
    MAX_DRAIN_PER_TURN,
    MAX_PREDISPATCH_SWEEP,
    NON_BLOCKING_TIMER_MS,
    PREDISPATCH_CANCEL_SWEEP_MS,
    type ActiveTimer,
    type DurableSessionRuntime,
    type PendingChildDigest,
} from "./state.js";
import { handleTurnResult, processPrompt, processTimer } from "./turn.js";
import { validClientMessageIds } from "./utils.js";

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

    for (let i = 0; i < MAX_DRAIN_PER_TURN; i++) {
        let msg: any = null;

        if (state.legacyPendingMessage !== undefined) {
            msg = state.legacyPendingMessage;
            state.legacyPendingMessage = undefined;

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

        } else if (needsBlockingDequeue(runtime)) {
            if (i > 0) break;
            publishStatus(runtime, state.pendingInputQuestion ? "input_required" : "idle");
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
            if (stash.length > 0) { appendToFifo(runtime, stash); stash.length = 0; }
            yield* handleCommand(runtime, msg as CommandMessage);
            if (state.orchestrationResult !== null) return;
            continue;
        }

        const childUpdate = parseChildUpdate(msg.prompt);
        if (childUpdate) {
            const key = `${childUpdate.sessionId}|${childUpdate.updateType}|${childUpdate.content ?? ""}`;
            if (!seenChildUpdates.has(key)) {
                seenChildUpdates.add(key);
                const tracked = yield* applyChildUpdate(runtime, childUpdate);
                if (tracked && !state.pendingShutdown) {
                    const childObservedAt: number = yield ctx.utcNow();
                    bufferChildUpdate(runtime, childUpdate, childObservedAt);
                }
                if (tracked && state.waitingForAgentIds) {
                    yield* maybeResolveAgentWaitCompletion(runtime);
                }
            }
            continue;
        }

        if (msg.answer !== undefined) {
            stash.push({ kind: "answer", answer: msg.answer, wasFreeform: msg.wasFreeform });
            continue;
        }

        if (msg.prompt) {
            let userPrompt = msg.prompt;

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

            const incomingClientMessageIds: string[] = validClientMessageIds(msg.clientMessageIds);

            if (promptIdsIntersectCancellation(runtime, incomingClientMessageIds)) {
                ctx.traceInfo(`[drain] dropping incoming prompt cancelled by tombstone (ids=${incomingClientMessageIds.join(",")})`);
                yield* recordCancelledMessageIds(runtime, incomingClientMessageIds, "drain-incoming");
                continue;
            }

            stash.push({
                kind: "prompt",
                prompt: userPrompt,
                bootstrap: Boolean(msg.bootstrap),
                ...(msg.requiredTool ? { requiredTool: msg.requiredTool } : {}),
                ...(incomingClientMessageIds.length > 0 ? { clientMessageIds: incomingClientMessageIds } : {}),
            });
            continue;
        }

        ctx.traceInfo(`[drain] skipping unknown: ${JSON.stringify(msg).slice(0, 120)}`);
    }

    if (stash.length > 0) appendToFifo(runtime, stash);
}

// ─── Pre-dispatch sweep: grab any pending cancel tombstone ──

function* sweepMessagesBeforePromptDispatch(runtime: DurableSessionRuntime): Generator<any, void, any> {
    const { ctx, state } = runtime;
    const stash: any[] = [];
    const seenChildUpdates = new Set<string>();

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
            if (stash.length > 0) { appendToFifo(runtime, stash); stash.length = 0; }
            yield* handleCommand(runtime, msg as CommandMessage);
            if (state.orchestrationResult !== null) return;
            continue;
        }

        const childUpdate = parseChildUpdate(msg.prompt);
        if (childUpdate) {
            const key = `${childUpdate.sessionId}|${childUpdate.updateType}|${childUpdate.content ?? ""}`;
            if (!seenChildUpdates.has(key)) {
                seenChildUpdates.add(key);
                const tracked = yield* applyChildUpdate(runtime, childUpdate);
                if (tracked && !state.pendingShutdown) {
                    const childObservedAt: number = yield ctx.utcNow();
                    bufferChildUpdate(runtime, childUpdate, childObservedAt);
                }
                if (tracked && state.waitingForAgentIds) {
                    yield* maybeResolveAgentWaitCompletion(runtime);
                }
            }
            continue;
        }

        if (msg.answer !== undefined) {
            stash.push({ kind: "answer", answer: msg.answer, wasFreeform: msg.wasFreeform });
            continue;
        }

        if (msg.prompt) {
            const incomingClientMessageIds = validClientMessageIds(msg.clientMessageIds);
            if (promptIdsIntersectCancellation(runtime, incomingClientMessageIds)) {
                ctx.traceInfo(`[predispatch] dropping incoming prompt cancelled by tombstone (ids=${incomingClientMessageIds.join(",")})`);
                yield* recordCancelledMessageIds(runtime, incomingClientMessageIds, "predispatch-incoming");
                continue;
            }
            stash.push({
                kind: "prompt",
                prompt: msg.prompt,
                bootstrap: Boolean(msg.bootstrap),
                ...(msg.requiredTool ? { requiredTool: msg.requiredTool } : {}),
                ...(incomingClientMessageIds.length > 0 ? { clientMessageIds: incomingClientMessageIds } : {}),
            });
            continue;
        }

        ctx.traceInfo(`[predispatch] skipping unknown: ${JSON.stringify(msg).slice(0, 120)}`);
    }

    if (stash.length > 0) appendToFifo(runtime, stash);
}

// ─── decide: pop and process one item from FIFO ─────────────

function* processAnswer(runtime: DurableSessionRuntime, answerItem: any): Generator<any, void, any> {
    const question = runtime.state.pendingInputQuestion?.question ?? "a question";
    runtime.state.pendingInputQuestion = null;
    const answerPrompt = `The user was asked: "${question}"\nThe user responded: "${answerItem.answer}"`;
    yield* processPrompt(runtime, answerPrompt, false);
}

export function* decide(runtime: DurableSessionRuntime): Generator<any, boolean, any> {
    const { ctx, state } = runtime;

    // Priority 1: pending tool actions (in-memory, replay carry-forward).
    drainLeadingQueuedCronActions(runtime);
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
        state.pendingPrompt = undefined;
        state.bootstrapPrompt = false;
        state.pendingRequiredTool = undefined;
        yield* processPrompt(runtime, prompt, isBootstrap, requiredTool);
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
                let mergedPrompt = String(item.prompt || "");
                let mergedBootstrap = item.bootstrap ?? false;
                let mergedRequiredTool = item.requiredTool;
                const mergedClientMessageIds: string[] = [...ids];
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
                    mergedPrompt = `${mergedPrompt}\n\n${String(peek.prompt || "")}`;
                    mergedBootstrap = mergedBootstrap || (peek.bootstrap ?? false);
                    if (!mergedRequiredTool && peek.requiredTool) mergedRequiredTool = peek.requiredTool;
                    for (const id of peekIds) mergedClientMessageIds.push(id);
                }
                yield* processPrompt(
                    runtime,
                    mergedPrompt,
                    mergedBootstrap,
                    mergedRequiredTool,
                    mergedClientMessageIds.length > 0 ? mergedClientMessageIds : undefined,
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

function* processPendingChildDigest(runtime: DurableSessionRuntime): Generator<any, void, any> {
    const { ctx, state } = runtime;
    const digestPrompt = buildPendingChildDigestSystemPrompt(runtime);
    if (!digestPrompt) {
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
