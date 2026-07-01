import type { OrchestrationInput, TurnResult } from "../types.js";
import { SESSION_STATE_MISSING_PREFIX } from "../types.js";
import { createSessionProxy } from "../session-proxy.js";
import { planWaitHandling } from "../wait-affinity.js";
import {
    buildShutdownWaitReason,
    failPendingShutdown,
    getStillRunningAgentIds,
    handleSubAgentAction,
    isSubAgentTerminalStatus,
    maybeResolveAgentWaitCompletion,
    refreshTrackedSubAgents,
} from "./agents.js";
import {
    applyCronAtAction,
    applyCronAction,
    continueInput,
    continueInputWithPrompt,
    dehydrateForNextTurn,
    drainLeadingQueuedScheduleActions,
    ensureTaskContext,
    maybeCheckpoint,
    maybeSummarize,
    publishStatus,
    versionedContinueAsNew,
    wrapWithResumeContext,
    writeLatestResponse,
} from "./lifecycle.js";
import { describeCronAt } from "../cron-at.js";
import { shouldWakeParentForChildUpdate } from "../child-notifications.js";
import {
    INTERNAL_SYSTEM_TURN_PROMPT,
    MAX_RETRIES,
    SHUTDOWN_POLL_INTERVAL_MS,
    SHUTDOWN_TIMEOUT_MS,
    type DurableSessionRuntime,
} from "./state.js";
import {
    AUTH_FAILURE_USER_HINT,
    COPILOT_CONNECTION_CLOSED_MAX_RETRIES,
    COPILOT_CONNECTION_CLOSED_RETRY_DELAY_SECONDS,
    appendSystemContext,
    buildConnectionClosedRetryDetail,
    buildLossyHandoffRehydrationMessage,
    buildLossyHandoffSummary,
    extractPromptSystemContext,
    isAuthFailureError,
    isCopilotConnectionClosedError,
    mergePrompt,
    updateContextUsageFromEvents,
} from "./utils.js";

// ─── runTurn error / retry handling ─────────────────────────

interface RetryContext {
    sourcePrompt: string;
    systemOnlyTurn: boolean;
    requiredTool?: string;
    turnSystemPrompt?: string;
    cycleOrigin?: "cron" | "cron_at";
    /** Phase tag stamped on emitted lossy_handoff / dehydrate events. */
    phase: "runTurn.throw" | "turn.result.error";
}

function* handleConnectionClosedRetry(
    runtime: DurableSessionRuntime,
    errorMessage: string,
    rc: RetryContext,
): Generator<any, void, any> {
    const { state } = runtime;
    if (state.retryCount <= COPILOT_CONNECTION_CLOSED_MAX_RETRIES) {
        const retryDetail = buildConnectionClosedRetryDetail(state.retryCount);
        publishStatus(runtime, "error", {
            error: `${errorMessage} (${retryDetail})`,
            recoverableTransportLoss: true,
        });
        runtime.ctx.traceInfo(
            `[orch] live Copilot connection lost; retrying in ${COPILOT_CONNECTION_CLOSED_RETRY_DELAY_SECONDS}s`,
        );

        if (state.blobEnabled) {
            yield* dehydrateForNextTurn(runtime, "error", true, {
                detail: retryDetail,
                error: errorMessage,
                phase: rc.phase,
                retryAttempt: state.retryCount,
                maxRetries: COPILOT_CONNECTION_CLOSED_MAX_RETRIES,
                retryDelaySeconds: COPILOT_CONNECTION_CLOSED_RETRY_DELAY_SECONDS,
            });
        }

        yield runtime.ctx.scheduleTimer(COPILOT_CONNECTION_CLOSED_RETRY_DELAY_SECONDS * 1000);
        yield* versionedContinueAsNew(runtime, continueInput(runtime, retryContinueOverrides(state, rc)));
        return;
    }

    const handoffMessage = buildLossyHandoffSummary(errorMessage);
    runtime.ctx.traceInfo(`[orch] ${handoffMessage}`);
    publishStatus(runtime, "error", {
        error: handoffMessage,
        retriesExhausted: true,
        lossyHandoff: true,
    });
    yield runtime.manager.recordSessionEvent(runtime.input.sessionId, [{
        eventType: "session.lossy_handoff",
        data: {
            message: handoffMessage,
            error: errorMessage,
            phase: rc.phase,
            retries: COPILOT_CONNECTION_CLOSED_MAX_RETRIES,
            retryDelaySeconds: COPILOT_CONNECTION_CLOSED_RETRY_DELAY_SECONDS,
            nextStep: "dehydrate_and_resume_on_new_worker",
        },
    }]);

    if (state.blobEnabled) {
        yield* dehydrateForNextTurn(runtime, "lossy_handoff", true, {
            detail: handoffMessage,
            error: errorMessage,
            phase: rc.phase,
            retries: COPILOT_CONNECTION_CLOSED_MAX_RETRIES,
            retryDelaySeconds: COPILOT_CONNECTION_CLOSED_RETRY_DELAY_SECONDS,
            nextStep: "dehydrate_and_resume_on_new_worker",
        });
        yield* versionedContinueAsNew(runtime, continueInput(runtime, {
            ...retryContinueOverrides(state, rc),
            retryCount: 0,
            needsHydration: true,
            rehydrationMessage: buildLossyHandoffRehydrationMessage(errorMessage),
        }));
        return;
    }

    publishStatus(runtime, "error", {
        error: `${handoffMessage} Durable handoff is unavailable because blob persistence is disabled.`,
        retriesExhausted: true,
        lossyHandoff: false,
    });
    state.retryCount = 0;
}

function retryContinueOverrides(state: DurableSessionRuntime["state"], rc: RetryContext): Partial<OrchestrationInput> {
    if (rc.phase === "turn.result.error") {
        return {
            prompt: rc.sourcePrompt,
            ...(rc.cycleOrigin ? { cycleOrigin: rc.cycleOrigin } : {}),
            retryCount: state.retryCount,
            needsHydration: state.blobEnabled ? true : state.needsHydration,
        };
    }
    return {
        ...(rc.systemOnlyTurn ? {} : { prompt: rc.sourcePrompt }),
        ...(rc.requiredTool ? { requiredTool: rc.requiredTool } : {}),
        ...(rc.turnSystemPrompt ? { systemPrompt: rc.turnSystemPrompt } : {}),
        ...(rc.cycleOrigin ? { cycleOrigin: rc.cycleOrigin } : {}),
        retryCount: state.retryCount,
        needsHydration: state.blobEnabled ? true : state.needsHydration,
    };
}

function* handleGenericRetry(
    runtime: DurableSessionRuntime,
    errorMessage: string,
    rc: RetryContext,
): Generator<any, void, any> {
    const { state } = runtime;
    if (state.retryCount >= MAX_RETRIES) {
        runtime.ctx.traceInfo(`[orch] max retries exhausted, waiting for user input`);
        publishStatus(runtime, "error", {
            error: `Failed after ${MAX_RETRIES} attempts: ${errorMessage}`,
            retriesExhausted: true,
        });
        state.retryCount = 0;
        return;
    }

    const retryDelay = 15 * Math.pow(2, state.retryCount - 1);
    publishStatus(runtime, "error", {
        error: `${errorMessage} (retry ${state.retryCount}/${MAX_RETRIES} in ${retryDelay}s)`,
    });
    runtime.ctx.traceInfo(`[orch] retrying in ${retryDelay}s${rc.phase === "turn.result.error" ? " after turn error" : ""}`);

    if (state.blobEnabled) {
        yield* dehydrateForNextTurn(runtime, "error", true, {
            detail: errorMessage,
            error: errorMessage,
            phase: rc.phase,
            retryAttempt: state.retryCount,
            maxRetries: MAX_RETRIES,
            retryDelaySeconds: retryDelay,
        });
    }
    yield runtime.ctx.scheduleTimer(retryDelay * 1000);
    yield* versionedContinueAsNew(runtime, continueInput(runtime, retryContinueOverrides(state, rc)));
}

// ─── processPrompt: hydrate → runTurn → handleTurnResult ────

export function* processPrompt(
    runtime: DurableSessionRuntime,
    promptText: string,
    isBootstrap: boolean,
    requiredTool?: string,
    clientMessageIds?: string[],
    cycleOrigin?: "cron" | "cron_at",
): Generator<any, void, any> {
    const { ctx, state } = runtime;
    let prompt = promptText;
    let promptIsBootstrap = isBootstrap;

    if (state.blobEnabled && !state.needsHydration) {
        try {
            state.needsHydration = yield runtime.session.needsHydration();
        } catch (err: any) {
            ctx.traceInfo(`[orch] needsHydration probe failed: ${err.message ?? err}`);
        }
    }

    if (state.needsHydration && state.blobEnabled && prompt) {
        prompt = wrapWithResumeContext(runtime, prompt);
    }

    let turnSystemPrompt = state.pendingSystemPrompt;
    state.pendingSystemPrompt = undefined;
    const extractedPrompt = extractPromptSystemContext(prompt);
    prompt = extractedPrompt.prompt ?? "";
    turnSystemPrompt = mergePrompt(turnSystemPrompt, extractedPrompt.systemPrompt);
    const systemOnlyTurn = !prompt && !!turnSystemPrompt;
    if (systemOnlyTurn) {
        prompt = INTERNAL_SYSTEM_TURN_PROMPT;
        promptIsBootstrap = true;
    }
    state.config.turnSystemPrompt = turnSystemPrompt;

    ctx.traceInfo(`[turn ${state.iteration}] session=${runtime.input.sessionId} prompt="${prompt.slice(0, 80)}"`);

    if (state.needsHydration && state.blobEnabled) {
        let hydrateAttempts = 0;
        while (true) {
            try {
                if (!state.preserveAffinityOnHydrate) {
                    state.affinityKey = yield ctx.newGuid();
                }
                runtime.session = createSessionProxy(ctx, runtime.input.sessionId, state.affinityKey, state.config);
                yield runtime.session.hydrate();
                state.needsHydration = false;
                state.preserveAffinityOnHydrate = false;
                state.lastLiveSessionAction = "session-activity";
                break;
            } catch (hydrateErr: any) {
                const hMsg = hydrateErr.message || String(hydrateErr);
                if (
                    hMsg.includes("blob does not exist")
                    || hMsg.includes("BlobNotFound")
                    || hMsg.includes("Session archive not found")
                    || hMsg.includes("404")
                ) {
                    ctx.traceInfo(`[orch] hydrate skipped — blob not found, starting fresh session`);
                    state.needsHydration = false;
                    state.preserveAffinityOnHydrate = false;
                    break;
                }
                hydrateAttempts++;
                ctx.traceInfo(`[orch] hydrate FAILED (attempt ${hydrateAttempts}/${MAX_RETRIES}): ${hMsg}`);
                if (hydrateAttempts >= MAX_RETRIES) {
                    publishStatus(runtime, "error", {
                        error: `Hydrate failed after ${MAX_RETRIES} attempts: ${hMsg}`,
                        retriesExhausted: true,
                    });
                    break;
                }
                const hydrateDelay = 10 * Math.pow(2, hydrateAttempts - 1);
                publishStatus(runtime, "error", {
                    error: `Hydrate failed: ${hMsg} (retry ${hydrateAttempts}/${MAX_RETRIES} in ${hydrateDelay}s)`,
                });
                yield ctx.scheduleTimer(hydrateDelay * 1000);
            }
        }
        if (state.needsHydration) return;
    }

    if (state.config.agentIdentity !== "facts-manager") {
        try {
            yield runtime.manager.loadKnowledgeIndex();
        } catch (knErr: any) {
            ctx.traceInfo(`[orch] loadKnowledgeIndex failed (non-fatal): ${knErr.message || knErr}`);
        }
    }

    publishStatus(runtime, "running", { iteration: state.iteration + 1 });
    let turnResult: any;
    try {
        state.lastLiveSessionAction = "session-activity";
        turnResult = yield runtime.session.runTurn(prompt, promptIsBootstrap, state.iteration, {
            ...(runtime.options.parentSessionId ? { parentSessionId: runtime.options.parentSessionId } : {}),
            nestingLevel: runtime.options.nestingLevel,
            ...(requiredTool ? { requiredTool } : {}),
            ...(cycleOrigin ? { cycleOrigin } : {}),
            retryCount: state.retryCount,
            ...(clientMessageIds && clientMessageIds.length > 0 ? { clientMessageIds } : {}),
        });
    } catch (err: any) {
        state.config.turnSystemPrompt = undefined;
        const errorMsg = err.message || String(err);
        const missingStateIndex = errorMsg.indexOf(SESSION_STATE_MISSING_PREFIX);
        if (missingStateIndex >= 0) {
            const fatalError = errorMsg.slice(missingStateIndex + SESSION_STATE_MISSING_PREFIX.length).trim();
            ctx.traceInfo(`[orch] fatal missing session state: ${fatalError}`);
            publishStatus(runtime, "failed", { error: fatalError, fatal: true });
            yield runtime.manager.updateCmsState(runtime.input.sessionId, "failed", fatalError);
            throw new Error(fatalError);
        }

        if (isAuthFailureError(errorMsg)) {
            const blockedDetail = `${errorMsg} — ${AUTH_FAILURE_USER_HINT}`;
            ctx.traceInfo(`[orch] runTurn FAILED with auth error; not retrying: ${errorMsg}`);
            publishStatus(runtime, "error", {
                error: blockedDetail,
                retriesExhausted: true,
                authFailure: true,
            });
            state.retryCount = 0;
            return;
        }

        state.retryCount++;
        ctx.traceInfo(`[orch] runTurn FAILED (attempt ${state.retryCount}/${MAX_RETRIES}): ${errorMsg}`);

        const rc: RetryContext = {
            sourcePrompt: prompt,
            systemOnlyTurn,
            requiredTool,
            cycleOrigin,
            turnSystemPrompt,
            phase: "runTurn.throw",
        };

        if (isCopilotConnectionClosedError(errorMsg)) {
            yield* handleConnectionClosedRetry(runtime, errorMsg, rc);
            return;
        }

        yield* handleGenericRetry(runtime, errorMsg, rc);
        return;
    }
    state.config.turnSystemPrompt = undefined;
    state.retryCount = 0;

    const result: TurnResult = typeof turnResult === "string" ? JSON.parse(turnResult) : turnResult;
    const observedAt: number = yield ctx.utcNow();
    state.contextUsage = updateContextUsageFromEvents(state.contextUsage, (result as any)?.events, observedAt);

    state.iteration++;
    yield* maybeSummarize(runtime);
    yield* refreshTrackedSubAgents(runtime);

    if ("queuedActions" in result && Array.isArray((result as any).queuedActions) && (result as any).queuedActions.length > 0) {
        state.pendingToolActions.push(...(result as any).queuedActions);
        ctx.traceInfo(`[orch] queued ${(result as any).queuedActions.length} extra action(s) from turn`);
    }
    yield* drainLeadingQueuedScheduleActions(runtime, prompt);

    yield* handleTurnResult(runtime, result, prompt, cycleOrigin);
}

// ─── handleTurnResult: dispatch on TurnResult variant ───────

function coerceChildQuestionToWait(
    runtime: DurableSessionRuntime,
    result: TurnResult,
): TurnResult {
    if (
        result.type === "completed"
        && runtime.options.parentSessionId
        && typeof result.content === "string"
        && /^QUESTION FOR PARENT:/i.test(result.content.trim())
    ) {
        runtime.ctx.traceInfo("[orch] coercing child QUESTION FOR PARENT result into durable wait");
        return {
            type: "wait",
            seconds: 60,
            reason: "waiting for parent answer",
            content: result.content.trim(),
            model: (result as any).model,
        } as TurnResult;
    }
    return result;
}

function* synthesizeWaitInterruptReplyIfNeeded(
    runtime: DurableSessionRuntime,
    result: TurnResult,
): Generator<any, TurnResult, any> {
    if (
        runtime.state.interruptedWaitTimer?.interruptKind === "user"
        && (result.type === "completed" || result.type === "wait")
        && !(typeof result.content === "string" && result.content.trim())
    ) {
        const content = "I'm here. Resuming the timer.";
        const next = { ...result, content } as TurnResult;
        yield runtime.manager.recordSessionEvent(runtime.input.sessionId, [{
            eventType: "assistant.message",
            data: {
                content,
                synthetic: true,
                reason: "wait_interrupt_empty_reply",
            },
        }]);
        runtime.ctx.traceInfo("[orch] synthesized visible assistant reply for wait interrupt");
        return next;
    }
    return result;
}

export function* handleTurnResult(
    runtime: DurableSessionRuntime,
    result: TurnResult,
    sourcePrompt: string,
    cycleOrigin?: "cron" | "cron_at",
): Generator<any, void, any> {
    const { ctx, state, options } = runtime;
    result = coerceChildQuestionToWait(runtime, result);
    result = yield* synthesizeWaitInterruptReplyIfNeeded(runtime, result);

    switch (result.type) {
        case "completed": {
            ctx.traceInfo(`[response] ${result.content}`);
            yield* writeLatestResponse(runtime, {
                iteration: state.iteration,
                type: "completed",
                content: result.content,
                model: (result as any).model,
            });

            if (options.parentSessionId) {
                const cycleReport = (result as any).cycleReport;
                const cycleMaterial = cycleReport?.status === "material" || cycleReport?.status === "blocked"
                    ? true
                    : cycleReport?.status === "quiet"
                        ? false
                        : undefined;
                const wakeDecision = shouldWakeParentForChildUpdate({
                    update: {
                        kind: "completed",
                        summary: cycleReport?.summary || result.content,
                        ...(cycleOrigin ? { cyclic: true } : {}),
                        ...(cycleMaterial !== undefined ? { material: cycleMaterial } : {}),
                        ...(cycleReport?.status === "blocked" ? { result: { verdict: "blocked" as const } } : {}),
                    },
                    contract: state.config.childContract,
                });
                if (wakeDecision.wake) {
                    try {
                        const meta = [
                            `from=${runtime.input.sessionId}`,
                            `type=completed`,
                            `iter=${state.iteration}`,
                            ...(cycleOrigin ? [`cycle=${cycleOrigin}`] : []),
                            ...(cycleReport?.status ? [`status=${cycleReport.status}`] : []),
                        ].join(" ");
                        const notifyContent = cycleReport?.summary || result.content;
                        yield runtime.manager.sendToSession(options.parentSessionId,
                            `[CHILD_UPDATE ${meta}]\n${notifyContent.slice(0, 2000)}`);
                    } catch (err: any) {
                        ctx.traceInfo(`[orch] sendToSession(parent) failed: ${err.message} (non-fatal)`);
                    }
                } else {
                    yield runtime.manager.recordSessionEvent(runtime.input.sessionId, [{
                        eventType: "session.child_update_suppressed",
                        data: { direction: "child_to_parent", updateType: "completed", cycleOrigin, cycleReport, ...wakeDecision },
                    }]);
                }

                if (runtime.input.isSystem && !state.cronSchedule && !state.cronAtSchedule) {
                    ctx.traceInfo(`[orch] system sub-agent completed turn, continuing loop`);
                    yield* maybeCheckpoint(runtime);
                    return;
                }
            }

            // Forgotten-timer safety net
            {
                const runningAgents = state.subAgents.filter(a => a.status === "running");
                if (runningAgents.length > 0 && !runtime.input.forgottenTimerNudged && !state.cronSchedule && !state.cronAtSchedule) {
                    const names = runningAgents.map(a => a.task?.slice(0, 40) || a.orchId).join(", ");
                    ctx.traceInfo(`[orch] forgotten-timer safety: ${runningAgents.length} agents still running, nudging LLM`);
                    yield* versionedContinueAsNew(runtime, continueInputWithPrompt(runtime,
                        `[SYSTEM: You ended your turn without calling wait(), but you have ${runningAgents.length} sub-agent(s) still running: ${names}. ` +
                        `Without a wait() call, your monitoring/polling loop is DEAD — the orchestration will NOT wake you up automatically. ` +
                        `You MUST call wait() now to schedule your next check-in. Call wait() with an appropriate interval to continue your loop.]`,
                        { forgottenTimerNudged: true },
                    ));
                    return;
                }
            }

            if (state.interruptedWaitTimer && state.interruptedWaitTimer.remainingSec > 0) {
                const saved = state.interruptedWaitTimer;
                state.interruptedWaitTimer = null;
                ctx.traceInfo(`[orch] auto-resuming interrupted wait: ${saved.remainingSec}s (${saved.reason})`);

                if (saved.shouldRehydrate) {
                    yield* dehydrateForNextTurn(runtime, "timer", saved.waitPlan?.resetAffinityOnDehydrate ?? true);
                }

                const resumeNow: number = yield ctx.utcNow();
                publishStatus(runtime, "waiting", {
                    waitSeconds: saved.remainingSec,
                    waitReason: saved.reason,
                    waitStartedAt: resumeNow,
                });

                if (!saved.shouldRehydrate) yield* maybeCheckpoint(runtime);

                state.activeTimer = {
                    deadlineMs: resumeNow + saved.remainingSec * 1000,
                    originalDurationMs: saved.remainingSec * 1000,
                    reason: saved.reason,
                    type: "wait",
                    shouldRehydrate: saved.shouldRehydrate,
                    waitPlan: saved.waitPlan,
                };
                return;
            }

            if (state.interruptedCronTimer && state.interruptedCronTimer.remainingMs > 0) {
                const saved = state.interruptedCronTimer;
                state.interruptedCronTimer = null;
                const remainingMs = Math.max(0, saved.remainingMs);
                const remainingSec = Math.max(1, Math.round(remainingMs / 1000));
                ctx.traceInfo(`[orch] auto-resuming interrupted cron: ${remainingSec}s remain (${saved.reason})`);

                const cronResumePlan = planWaitHandling({
                    blobEnabled: state.blobEnabled,
                    seconds: remainingSec,
                    dehydrateThreshold: options.dehydrateThreshold,
                });
                if (cronResumePlan.shouldDehydrate) {
                    yield* dehydrateForNextTurn(runtime, "cron", cronResumePlan.resetAffinityOnDehydrate);
                }

                const resumeNow: number = yield ctx.utcNow();
                publishStatus(runtime, "waiting", {
                    waitSeconds: remainingSec,
                    waitReason: saved.reason,
                    waitStartedAt: resumeNow,
                });

                if (!cronResumePlan.shouldDehydrate) yield* maybeCheckpoint(runtime);

                state.activeTimer = {
                    deadlineMs: resumeNow + remainingMs,
                    originalDurationMs: remainingMs,
                    reason: saved.reason,
                    type: "cron",
                    shouldRehydrate: cronResumePlan.shouldDehydrate,
                };
                return;
            }

            if (state.cronSchedule) {
                const activeCron = { ...state.cronSchedule };
                const cronPlan = planWaitHandling({
                    blobEnabled: state.blobEnabled,
                    seconds: activeCron.intervalSeconds,
                    dehydrateThreshold: options.dehydrateThreshold,
                });
                if (cronPlan.shouldDehydrate) {
                    yield* dehydrateForNextTurn(runtime, "cron", cronPlan.resetAffinityOnDehydrate);
                }
                yield runtime.manager.recordSessionEvent(runtime.input.sessionId, [{
                    eventType: "session.cron_started",
                    data: { intervalSeconds: activeCron.intervalSeconds, reason: activeCron.reason },
                }]);
                const cronStartedAt: number = yield ctx.utcNow();
                ctx.traceInfo(`[orch] cron timer: ${activeCron.intervalSeconds}s (${activeCron.reason})`);
                publishStatus(runtime, "waiting", {
                    waitSeconds: activeCron.intervalSeconds,
                    waitReason: activeCron.reason,
                    waitStartedAt: cronStartedAt,
                });
                if (!cronPlan.shouldDehydrate) yield* maybeCheckpoint(runtime);

                state.activeTimer = {
                    deadlineMs: cronStartedAt + activeCron.intervalSeconds * 1000,
                    originalDurationMs: activeCron.intervalSeconds * 1000,
                    reason: activeCron.reason,
                    type: "cron",
                    shouldRehydrate: cronPlan.shouldDehydrate,
                };
                return;
            }

            if (state.cronAtSchedule) {
                const activeCronAt = { ...state.cronAtSchedule };
                if (activeCronAt.maxFires !== undefined && activeCronAt.firesCompleted >= activeCronAt.maxFires) {
                    state.cronAtSchedule = undefined;
                    yield runtime.manager.recordSessionEvent(runtime.input.sessionId, [{
                        eventType: "session.cron_at_completed",
                        data: { reason: activeCronAt.reason, firesCompleted: activeCronAt.firesCompleted, maxFires: activeCronAt.maxFires },
                    }]);
                    return;
                }

                const nowMs: number = yield ctx.utcNow();
                let nextFireAtMs = activeCronAt.nextFireAtMs;
                let nextOccurrenceKey = activeCronAt.nextOccurrenceKey;
                if (!nextFireAtMs || !nextOccurrenceKey) {
                    const nextFire = yield runtime.manager.computeCronAtNextFire(activeCronAt, nowMs, activeCronAt.lastOccurrenceKey);
                    nextFireAtMs = nextFire.nextFireAtMs;
                    nextOccurrenceKey = nextFire.occurrenceKey;
                    state.cronAtSchedule = {
                        ...activeCronAt,
                        nextFireAtMs,
                        nextOccurrenceKey,
                    };
                }
                if (nextFireAtMs === undefined || !nextOccurrenceKey) {
                    throw new Error("cron_at next-fire computation did not return a fire time");
                }

                const waitMs = Math.max(0, nextFireAtMs - nowMs);
                const waitSeconds = Math.max(0, Math.ceil(waitMs / 1000));
                const cronAtPlan = planWaitHandling({
                    blobEnabled: state.blobEnabled,
                    seconds: waitSeconds,
                    dehydrateThreshold: options.dehydrateThreshold,
                });
                if (cronAtPlan.shouldDehydrate) {
                    yield* dehydrateForNextTurn(runtime, "cron_at", cronAtPlan.resetAffinityOnDehydrate);
                }
                yield runtime.manager.recordSessionEvent(runtime.input.sessionId, [{
                    eventType: "session.cron_at_started",
                    data: {
                        ...state.cronAtSchedule,
                        nextFireAt: new Date(nextFireAtMs).toISOString(),
                    },
                }]);
                publishStatus(runtime, "waiting", {
                    waitSeconds,
                    waitReason: activeCronAt.reason,
                    waitStartedAt: nowMs,
                });
                if (!cronAtPlan.shouldDehydrate) yield* maybeCheckpoint(runtime);

                state.activeTimer = {
                    deadlineMs: nowMs + waitMs,
                    originalDurationMs: waitMs,
                    reason: activeCronAt.reason,
                    type: "cron_at",
                    shouldRehydrate: cronAtPlan.shouldDehydrate,
                };
                return;
            }

            if (!state.blobEnabled || options.idleTimeout < 0) {
                yield* maybeCheckpoint(runtime);
                return;
            }

            publishStatus(runtime, "idle");
            yield* maybeCheckpoint(runtime);
            const idleNow: number = yield ctx.utcNow();
            state.activeTimer = {
                deadlineMs: idleNow + options.idleTimeout * 1000,
                originalDurationMs: options.idleTimeout * 1000,
                reason: "idle timeout",
                type: "idle",
            };
            return;
        }

        case "cron":
            applyCronAction(runtime, result, sourcePrompt);
            return;

        case "cron_at":
            yield* applyCronAtAction(runtime, result, sourcePrompt);
            return;

        case "wait": {
            state.interruptedWaitTimer = null;
            ensureTaskContext(runtime, sourcePrompt);

            if (options.parentSessionId) {
                const notifyContent = result.content
                    ? result.content.slice(0, 2000)
                    : `[wait: ${result.reason} (${result.seconds}s)]`;
                const wakeDecision = shouldWakeParentForChildUpdate({
                    update: { kind: "wait", summary: notifyContent },
                    contract: state.config.childContract,
                });
                if (wakeDecision.wake) {
                    try {
                        yield runtime.manager.sendToSession(options.parentSessionId,
                            `[CHILD_UPDATE from=${runtime.input.sessionId} type=wait iter=${state.iteration}]\n${notifyContent}`);
                    } catch (err: any) {
                        ctx.traceInfo(`[orch] sendToSession(parent) wait failed: ${err.message} (non-fatal)`);
                    }
                } else {
                    yield runtime.manager.recordSessionEvent(runtime.input.sessionId, [{
                        eventType: "session.child_update_suppressed",
                        data: { direction: "child_to_parent", updateType: "wait", ...wakeDecision },
                    }]);
                }
            }

            ctx.traceInfo(`[orch] durable timer: ${result.seconds}s (${result.reason})`);

            const waitPlan = planWaitHandling({
                blobEnabled: state.blobEnabled,
                seconds: result.seconds,
                dehydrateThreshold: options.dehydrateThreshold,
                preserveWorkerAffinity: result.preserveWorkerAffinity,
            });
            if (waitPlan.shouldDehydrate) {
                yield* dehydrateForNextTurn(runtime, "timer", waitPlan.resetAffinityOnDehydrate);
            }

            const waitStartedAt: number = yield ctx.utcNow();
            if (result.content) {
                yield* writeLatestResponse(runtime, {
                    iteration: state.iteration,
                    type: "wait",
                    content: result.content,
                    waitReason: result.reason,
                    waitSeconds: result.seconds,
                    waitStartedAt,
                    model: (result as any).model,
                });
                ctx.traceInfo(`[orch] intermediate: ${result.content.slice(0, 80)}`);
            }

            publishStatus(runtime, "waiting", {
                waitSeconds: result.seconds,
                waitReason: result.reason,
                waitStartedAt,
                preserveWorkerAffinity: waitPlan.preserveAffinityOnHydrate,
            });

            if (!waitPlan.shouldDehydrate) yield* maybeCheckpoint(runtime);

            yield runtime.manager.recordSessionEvent(runtime.input.sessionId, [{
                eventType: "session.wait_started",
                data: { seconds: result.seconds, reason: result.reason, preserveAffinity: waitPlan.preserveAffinityOnHydrate },
            }]);

            state.activeTimer = {
                deadlineMs: waitStartedAt + result.seconds * 1000,
                originalDurationMs: result.seconds * 1000,
                reason: result.reason,
                type: "wait",
                shouldRehydrate: waitPlan.shouldDehydrate,
                waitPlan,
                content: result.content,
            };
            return;
        }

        case "input_required": {
            ctx.traceInfo(`[orch] waiting for user input: ${result.question}`);
            yield* writeLatestResponse(runtime, {
                iteration: state.iteration,
                type: "input_required",
                question: result.question,
                choices: result.choices,
                allowFreeform: result.allowFreeform,
                model: (result as any).model,
            });

            state.pendingInputQuestion = {
                question: result.question,
                choices: result.choices,
                allowFreeform: result.allowFreeform,
            };
            publishStatus(runtime, "input_required");

            if (!state.blobEnabled || options.inputGracePeriod < 0) {
                yield* maybeCheckpoint(runtime);
                return;
            }

            if (options.inputGracePeriod === 0) {
                yield* dehydrateForNextTurn(runtime, "input_required");
                return;
            }

            const graceNow: number = yield ctx.utcNow();
            state.activeTimer = {
                deadlineMs: graceNow + options.inputGracePeriod * 1000,
                originalDurationMs: options.inputGracePeriod * 1000,
                reason: "input grace period",
                type: "input-grace",
                question: result.question,
                choices: result.choices,
                allowFreeform: result.allowFreeform,
            };
            return;
        }

        case "cancelled":
            ctx.traceInfo("[session] turn cancelled");
            return;

        case "spawn_agent":
        case "message_agent":
        case "check_agents":
        case "list_sessions":
        case "wait_for_agents":
        case "complete_agent":
        case "cancel_agent":
        case "delete_agent":
            yield* handleSubAgentAction(runtime, result);
            return;

        case "error": {
            const missingStateIndex = result.message.indexOf(SESSION_STATE_MISSING_PREFIX);
            if (missingStateIndex >= 0) {
                const fatalError = result.message.slice(missingStateIndex + SESSION_STATE_MISSING_PREFIX.length).trim();
                ctx.traceInfo(`[orch] fatal missing session state: ${fatalError}`);
                publishStatus(runtime, "failed", { error: fatalError, fatal: true });
                yield runtime.manager.updateCmsState(runtime.input.sessionId, "failed", fatalError);
                throw new Error(fatalError);
            }

            state.retryCount++;
            ctx.traceInfo(`[orch] turn returned error (attempt ${state.retryCount}/${MAX_RETRIES}): ${result.message}`);

            const rc: RetryContext = {
                sourcePrompt,
                systemOnlyTurn: false,
                cycleOrigin,
                phase: "turn.result.error",
            };

            if (isCopilotConnectionClosedError(result.message)) {
                yield* handleConnectionClosedRetry(runtime, result.message, rc);
                return;
            }

            yield* handleGenericRetry(runtime, result.message, rc);
            return;
        }
    }
}

// ─── processTimer: handle fired timers by type ──────────────

export function* processTimer(
    runtime: DurableSessionRuntime,
    timerItem: any,
): Generator<any, void, any> {
    const { ctx, state } = runtime;
    const timer = timerItem.timer;
    switch (timer.type) {
        case "wait": {
            const seconds = Math.round(timer.originalDurationMs / 1000);
            yield runtime.manager.recordSessionEvent(runtime.input.sessionId, [{
                eventType: "session.wait_completed",
                data: { seconds },
            }]);
            const timerPrompt = `The ${seconds} second wait is now complete. Continue with your task.`;
            const resumeSystemPrompt = [
                timer.reason ? `Wait reason: "${timer.reason}".` : undefined,
                state.taskContext ? `Original user request: "${state.taskContext}".` : undefined,
                "Resume the interrupted task now.",
                "Do not treat this as a new unrelated user request.",
                "Do not call wait() again for the delay that already finished.",
            ].filter(Boolean).join(" ");
            yield* processPrompt(
                runtime,
                appendSystemContext(timerPrompt, resumeSystemPrompt) ?? timerPrompt,
                false,
            );
            return;
        }
        case "cron": {
            yield runtime.manager.recordSessionEvent(runtime.input.sessionId, [{
                eventType: "session.cron_fired",
                data: {},
            }]);
            const activeCron = state.cronSchedule!;
            const cycleReportGuidance = "If this cycle finds material changes or blockers that should wake your parent, call report_cycle(status='material' or status='blocked', summary='...') before finishing. If nothing material changed, omit report_cycle or call report_cycle(status='quiet').";
            const cronPrompt = `[SYSTEM: Scheduled cron wake-up for: "${activeCron.reason}". Resume your recurring task. ${cycleReportGuidance}]`;
            if (timer.shouldRehydrate) {
                yield* processPrompt(
                    runtime,
                    wrapWithResumeContext(runtime, "Resume your recurring task.",
                        `Scheduled cron wake-up for: "${activeCron.reason}". ${cycleReportGuidance}`),
                    true,
                    undefined,
                    undefined,
                    "cron",
                );
            } else {
                yield* processPrompt(runtime, cronPrompt, true, undefined, undefined, "cron");
            }
            return;
        }
        case "cron_at": {
            const activeCronAt = state.cronAtSchedule;
            if (!activeCronAt) {
                ctx.traceInfo("[orch] cron_at timer fired but no active cronAtSchedule exists");
                return;
            }
            const scheduledAtMs = activeCronAt.nextFireAtMs ?? timer.deadlineMs;
            const occurrenceKey = activeCronAt.nextOccurrenceKey;
            yield runtime.manager.recordSessionEvent(runtime.input.sessionId, [{
                eventType: "session.cron_at_fired",
                data: {
                    scheduledAt: new Date(scheduledAtMs).toISOString(),
                    occurrenceKey,
                    tz: activeCronAt.tz,
                    minute: activeCronAt.minute,
                    hour: activeCronAt.hour,
                    dayOfWeek: activeCronAt.dayOfWeek,
                    dayOfMonth: activeCronAt.dayOfMonth,
                    firesCompleted: activeCronAt.firesCompleted + 1,
                },
            }]);
            const firedSchedule = {
                ...activeCronAt,
                firesCompleted: activeCronAt.firesCompleted + 1,
                ...(occurrenceKey ? { lastOccurrenceKey: occurrenceKey } : {}),
                nextFireAtMs: undefined,
                nextOccurrenceKey: undefined,
            };
            const finalFire = firedSchedule.maxFires !== undefined && firedSchedule.firesCompleted >= firedSchedule.maxFires;
            state.cronAtSchedule = finalFire ? undefined : firedSchedule;
            if (finalFire) {
                yield runtime.manager.recordSessionEvent(runtime.input.sessionId, [{
                    eventType: "session.cron_at_completed",
                    data: { reason: firedSchedule.reason, firesCompleted: firedSchedule.firesCompleted, maxFires: firedSchedule.maxFires },
                }]);
            }
            const description = describeCronAt(activeCronAt);
            const cronAtPrompt =
                `[SYSTEM: Scheduled wall-clock cron wake-up for "${activeCronAt.reason}". ` +
                `Schedule: ${description}. Scheduled fire: ${new Date(scheduledAtMs).toISOString()}. ` +
                `Resume your recurring task now. ` +
                `If this cycle finds material changes or blockers that should wake your parent, call report_cycle(status='material' or status='blocked', summary='...') before finishing. ` +
                `If nothing material changed, omit report_cycle or call report_cycle(status='quiet').]`;
            if (timer.shouldRehydrate) {
                yield* processPrompt(
                    runtime,
                    wrapWithResumeContext(runtime, "Resume your recurring task.",
                        `Scheduled wall-clock cron wake-up for "${activeCronAt.reason}". ` +
                        `Schedule: ${description}. Scheduled fire: ${new Date(scheduledAtMs).toISOString()}. ` +
                        `If this cycle finds material changes or blockers that should wake your parent, call report_cycle(status='material' or status='blocked', summary='...') before finishing. ` +
                        `If nothing material changed, omit report_cycle or call report_cycle(status='quiet').`),
                    true,
                    undefined,
                    undefined,
                    "cron_at",
                );
            } else {
                yield* processPrompt(runtime, cronAtPrompt, true, undefined, undefined, "cron_at");
            }
            return;
        }
        case "idle": {
            ctx.traceInfo("[session] idle timeout, dehydrating");
            yield* dehydrateForNextTurn(runtime, "idle");
            return;
        }
        case "agent-poll": {
            if (state.waitingForAgentIds) {
                const stillRunning = state.waitingForAgentIds.filter(id => {
                    const agent = state.subAgents.find(a => a.orchId === id);
                    return agent && !isSubAgentTerminalStatus(agent.status);
                });
                ctx.traceInfo(`[orch] wait_for_agents: fallback poll, checking ${stillRunning.length} agents`);
                for (const targetId of stillRunning) {
                    const agent = state.subAgents.find(a => a.orchId === targetId);
                    if (!agent || isSubAgentTerminalStatus(agent.status)) continue;
                    try {
                        const rawStatus: string = yield runtime.manager.getSessionStatus(agent.sessionId);
                        const parsed = JSON.parse(rawStatus);
                        if (parsed.status === "failed") {
                            agent.status = "failed";
                        } else if (parsed.status === "completed") {
                            agent.status = "completed";
                        } else if (parsed.status === "cancelled") {
                            agent.status = "cancelled";
                        } else if (parsed.status === "waiting") {
                            agent.status = "waiting";
                        }
                        if (parsed.result) {
                            agent.result = parsed.result.slice(0, 2000);
                        }
                    } catch {}
                }

                if (yield* maybeResolveAgentWaitCompletion(runtime)) {
                    return;
                }

                const nowRunning = getStillRunningAgentIds(state.subAgents, state.waitingForAgentIds);

                if (state.pendingShutdown) {
                    const now: number = yield ctx.utcNow();
                    if (now >= state.pendingShutdown.deadlineAtMs) {
                        const timeoutMessage =
                            `Graceful ${state.pendingShutdown.mode} timed out after ${Math.round(SHUTDOWN_TIMEOUT_MS / 1000)}s ` +
                            `waiting for ${nowRunning.length} child session(s): ${nowRunning.join(", ") || "unknown"}`;
                        yield* failPendingShutdown(runtime, timeoutMessage);
                        return;
                    }

                    const remainingMs = Math.max(0, state.pendingShutdown.deadlineAtMs - now);
                    const nextPollMs = Math.min(SHUTDOWN_POLL_INTERVAL_MS, remainingMs);
                    state.activeTimer = {
                        deadlineMs: now + nextPollMs,
                        originalDurationMs: nextPollMs,
                        reason: buildShutdownWaitReason(state.pendingShutdown),
                        type: "agent-poll",
                        agentIds: state.waitingForAgentIds,
                    };
                    publishStatus(runtime, "waiting", {
                        waitReason: buildShutdownWaitReason(state.pendingShutdown),
                        waitStartedAt: state.pendingShutdown.startedAtMs,
                        waitSeconds: Math.ceil(remainingMs / 1000),
                    });
                } else {
                    const now: number = yield ctx.utcNow();
                    state.activeTimer = {
                        deadlineMs: now + 30_000,
                        originalDurationMs: 30_000,
                        reason: `waiting for ${nowRunning.length} agent(s)`,
                        type: "agent-poll",
                        agentIds: state.waitingForAgentIds,
                    };
                }
            }
            return;
        }
        case "input-grace": {
            yield* dehydrateForNextTurn(runtime, "input_required");
            return;
        }
    }
}
