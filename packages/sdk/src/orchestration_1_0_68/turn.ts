import type { MessageSender } from "../message-sender.js";
import type { PromptAttachmentRef } from "../types.js";
import type { OrchestrationInput, TurnResult } from "../types.js";
import { SESSION_STATE_MISSING_PREFIX, stopTurnQueueName } from "../types.js";
import { createSessionProxy } from "../session-proxy.js";
import { planHoldRelease } from "../wait-affinity.js";
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
    drainLeadingQueuedScheduleActions,
    ensureTaskContext,
    maybeSummarize,
    publishStatus,
    releaseAffinity,
    versionedContinueAsNew,
    wrapWithResumeContext,
    writeCommandResponse,
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

function currentModelLabel(runtime: DurableSessionRuntime): string {
    const model = runtime.state.config.model || "(default)";
    const effort = runtime.state.config.reasoningEffort;
    return effort ? `${model}:${effort}` : model;
}

/**
 * Scan a finished turn's captured events for a failed `set_session_model` tool
 * call. The inline control tool returns its outcome as a plain string (see
 * session-proxy `setSessionModel`), so `tool.execution_complete.data.result`
 * is usually a string; some transports wrap it as `{ content }`. We match the
 * `set_session_model failed` marker across both shapes. Exported for unit tests.
 */
export function detectFailedModelSwitch(events: Array<{ eventType?: string; data?: any }> | undefined): string | null {
    if (!Array.isArray(events)) return null;
    for (const event of events) {
        if (event?.eventType !== "tool.execution_complete") continue;
        const data = event.data || {};
        const result = data.result ?? data.output;
        const content = typeof result === "string"
            ? result
            : String(result?.content ?? result?.detailedContent ?? data.content ?? "");
        if (/set_session_model (?:failed|is unavailable|rejected)/i.test(content)) return content.trim();
    }
    return null;
}

function captureFailedModelSwitchNotice(runtime: DurableSessionRuntime, result: TurnResult): string | null {
    const failure = detectFailedModelSwitch((result as any)?.events);
    if (!failure) return null;
    const modelLabel = currentModelLabel(runtime);
    runtime.state.runtimeModelNotice = `Previous model switch failed; current runtime model is ${modelLabel}. If asked what model you are using, answer this value.`;
    runtime.ctx.traceInfo(`[orch] queued failed model-switch correction: ${failure.slice(0, 160)}`);
    return `Continue on ${modelLabel}; the requested model switch failed.`;
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

        // Lifecycle protocol: nothing to dehydrate — the last commit is the
        // durable truth. Release affinity so the retry can land anywhere;
        // the retry's preamble hydrates clean from the committed snapshot
        // (the broken warm session is detected via the turn sentinel).
        if (state.blobEnabled) {
            yield* releaseAffinity(runtime, "error", {
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
            nextStep: "release_affinity_and_resume_on_any_worker",
        },
    }]);

    if (state.blobEnabled) {
        yield* releaseAffinity(runtime, "lossy_handoff", {
            detail: handoffMessage,
            error: errorMessage,
            phase: rc.phase,
            retries: COPILOT_CONNECTION_CLOSED_MAX_RETRIES,
            retryDelaySeconds: COPILOT_CONNECTION_CLOSED_RETRY_DELAY_SECONDS,
            nextStep: "release_affinity_and_resume_on_any_worker",
        });
        yield* versionedContinueAsNew(runtime, continueInput(runtime, {
            ...retryContinueOverrides(state, rc),
            retryCount: 0,
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
            needsHydration: state.needsHydration,
        };
    }
    return {
        ...(rc.systemOnlyTurn ? {} : { prompt: rc.sourcePrompt }),
        ...(rc.requiredTool ? { requiredTool: rc.requiredTool } : {}),
        ...(rc.turnSystemPrompt ? { systemPrompt: rc.turnSystemPrompt } : {}),
        ...(rc.cycleOrigin ? { cycleOrigin: rc.cycleOrigin } : {}),
        retryCount: state.retryCount,
        needsHydration: state.needsHydration,
    };
}

/** @internal Project a non-retryable credential failure without terminating the orchestration. */
export function* projectAuthFailure(
    runtime: DurableSessionRuntime,
    errorMessage: string,
): Generator<any, void, any> {
    const blockedDetail = `${errorMessage} — ${AUTH_FAILURE_USER_HINT}`;
    runtime.state.blockedError = { message: blockedDetail, authFailure: true };
    publishStatus(runtime, "error", {
        error: blockedDetail,
        retriesExhausted: true,
        authFailure: true,
    });
    yield* writeLatestResponse(runtime, {
        iteration: runtime.state.iteration,
        type: "error",
        content: blockedDetail,
    });
    yield runtime.manager.updateCmsState(runtime.input.sessionId, "error", blockedDetail, null);
    runtime.state.retryCount = 0;
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
        yield* releaseAffinity(runtime, "error", {
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
    sender?: MessageSender,
    attachments?: PromptAttachmentRef[],
): Generator<any, void, any> {
    const { ctx, state } = runtime;
    let prompt = promptText;
    let promptIsBootstrap = isBootstrap;

    // Lifecycle protocol (P5): no needsHydration probe. The old protocol
    // asked a worker "do you have my files?" before every turn — an extra
    // session activity whose answer could desync from reality, and whose
    // "no" triggered a legacy hydrate that the runTurn preamble would then
    // repeat (double download per cold wake). The preamble self-validates
    // against the versioned store; state.needsHydration survives only as
    // one-shot normalization of legacy (≤1.0.56) continue-as-new inputs.

    if (state.needsHydration && state.blobEnabled && prompt) {
        prompt = wrapWithResumeContext(runtime, prompt);
    }

    let turnSystemPrompt = state.pendingSystemPrompt;
    state.pendingSystemPrompt = undefined;
    const extractedPrompt = extractPromptSystemContext(prompt);
    prompt = extractedPrompt.prompt ?? "";
    turnSystemPrompt = mergePrompt(turnSystemPrompt, extractedPrompt.systemPrompt);
    if (prompt && state.runtimeModelNotice) {
        turnSystemPrompt = mergePrompt(turnSystemPrompt, state.runtimeModelNotice);
        state.runtimeModelNotice = undefined;
    }
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
        // Stop-turn race: the in-flight runTurn activity vs a dequeue on the
        // TURN-SCOPED stop queue (stopTurn.<iteration>). Scoping the queue to
        // the turn index makes stale stop events structurally unable to kill a
        // later turn — a race loser is dropped and cannot be un-dropped.
        // When the stop wins, duroxide cancel-requests the dropped runTurn
        // work item (lock-steal → isCancelled poll → SDK abort) as the
        // guaranteed backstop; handleTurnStopped layers the fast-path
        // same-affinity abortTurn on top.
        // Lifecycle protocol: a deterministic per-turn key (recorded GUID)
        // rides in the activity input with the last committed version. The
        // worker self-validates against them (preamble) and commits the
        // post-turn snapshot inside the activity, returning the new version.
        const snapshotTurnKey: string = state.blobEnabled ? yield ctx.newGuid() : "";
        const turnTask = runtime.session.runTurn(prompt, promptIsBootstrap, state.iteration, {
            ...(runtime.options.parentSessionId ? { parentSessionId: runtime.options.parentSessionId } : {}),
            nestingLevel: runtime.options.nestingLevel,
            // Session regeneration: scope the worker's store access to the
            // current epoch chain; the first post-flip turn dispatches as
            // runTurn2 (conditional epoch init — see createSessionProxy).
            ...(state.transcriptEpoch > 0 ? { transcriptEpoch: state.transcriptEpoch } : {}),
            ...(state.epochStartPending ? { epochStart: true } : {}),
            ...(requiredTool ? { requiredTool } : {}),
            ...(cycleOrigin ? { cycleOrigin } : {}),
            retryCount: state.retryCount,
            ...(clientMessageIds && clientMessageIds.length > 0 ? { clientMessageIds } : {}),
            ...(sender ? { sender } : {}),
            ...(attachments && attachments.length > 0 ? { attachments } : {}),
            // Store-wins (1.0.59): send only the turnKey. expectedVersion is
            // retired from the wire — the store-wins worker reconciles against
            // the store's own version, never the orchestration's belief.
            // state.snapshotVersion remains an internal telemetry mirror (it
            // powers snapshot_lineage_jump); it is simply no longer transmitted.
            ...(snapshotTurnKey
                ? { snapshot: { turnKey: snapshotTurnKey } }
                : {}),
        });
        const stopTask = ctx.dequeueEvent(stopTurnQueueName(state.iteration));
        const race: any = yield ctx.race(turnTask, stopTask);

        if (race.index === 1) {
            yield* handleTurnStopped(runtime, race.value, clientMessageIds);
            return;
        }

        // The select bridge flattens activity failures into their raw error
        // string (duroxide-node make_select_future) instead of throwing, so a
        // failed runTurn must be re-thrown here to reach the existing retry
        // machinery in the catch below.
        const raced = normalizeRacedTurnValue(race.value);
        if (raced.kind === "error") {
            throw new Error(raced.message);
        }
        turnResult = raced.result;

        // Session regeneration: the rebirth is PROVEN only by the epoch-start
        // turn's committed snapshot (or, for storeless sessions, a non-error
        // result). Until then health reads rebuilding and session.regenerated
        // never fires; a failing grounding turn retries with epochStartPending
        // intact so a retry re-enters the conditional epoch init.
        if (state.epochStartPending && state.pendingEpochCommit) {
            const resultType = String((turnResult as any)?.type ?? "");
            const snapVersion = Number((turnResult as any)?.snapshotVersion);
            const proven = Number.isFinite(snapVersion) && snapVersion >= 1
                ? true
                : (!state.blobEnabled && resultType !== "error" && resultType !== "stopped");
            if (proven) {
                const commit = state.pendingEpochCommit;
                state.epochStartPending = false;
                state.pendingEpochCommit = null;
                const nowMs: number = yield ctx.utcNow();
                yield runtime.manager.recordRegenerated(runtime.input.sessionId, {
                    epoch: commit.toEpoch,
                    attemptId: commit.attemptId,
                    stats: {
                        kind: "regen",
                        fromEpoch: commit.fromEpoch,
                        toEpoch: commit.toEpoch,
                        trigger: commit.trigger,
                        ...(commit.archiveMs ? { archiveMs: commit.archiveMs } : {}),
                        ...(commit.distillMs ? { distillMs: commit.distillMs } : {}),
                        ...(commit.turnsArchived ? { turnsArchived: commit.turnsArchived } : {}),
                        ...(commit.compactionsArchived ? { compactionsArchived: commit.compactionsArchived } : {}),
                        ...(commit.distillMode ? { distillMode: commit.distillMode } : {}),
                        ...(commit.distillerModel ? { distillerModel: commit.distillerModel } : {}),
                        ...(commit.distillerSessionId ? { distillerSessionId: commit.distillerSessionId } : {}),
                        totalMs: Math.max(0, nowMs - (commit as any).requestedAtMs || 0),
                    },
                });
                ctx.traceInfo(`[orch] epoch ${commit.toEpoch} rebirth proven (snapshot v${snapVersion || 0})`);
            }
        }
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
            ctx.traceInfo(`[orch] runTurn FAILED with auth error; not retrying: ${errorMsg}`);
            yield* projectAuthFailure(runtime, errorMsg);
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

    let result: TurnResult = typeof turnResult === "string" ? JSON.parse(turnResult) : turnResult;
    // Lifecycle protocol: adopt the version the activity committed. The
    // returned value is authoritative even when it disagrees with the
    // expectation (self-healing after a store restore). state.snapshotVersion
    // is a telemetry MIRROR only — store-wins never gates on it.
    if (typeof (result as any)?.snapshotVersion === "number") {
        const adoptedVersion = (result as any).snapshotVersion as number;
        const priorVersion = state.snapshotVersion;
        // Store-wins observability: the adopted store version diverged from
        // prior+1 — someone else moved the store the control plane didn't author.
        //   forward  (adopted > prior+1): a discarded/foreign turn published in
        //            the gap and this turn hydrated + committed on top (the
        //            incident's self-heal).
        //   backward (adopted < prior): the store regressed below the mirror — a
        //            restore from an older backup / data loss — which is silent
        //            on a fresh markerless worker (no local marker → no
        //            snapshot_regressed), so the mirror is the only witness.
        // Deterministic on replay: both operands come from recorded state and
        // the recorded activity result. (New yield in 1.0.59 — the reason this
        // change required freezing 1.0.58; see orchestration_1_0_58/.)
        const forwardJump = adoptedVersion > priorVersion + 1;
        const backwardJump = adoptedVersion < priorVersion;
        if (priorVersion > 0 && (forwardJump || backwardJump)) {
            yield runtime.manager.recordSessionEvent(runtime.input.sessionId, [{
                eventType: "session.snapshot_lineage_jump",
                data: { from: priorVersion, to: adoptedVersion, direction: backwardJump ? "backward" : "forward" },
            }]);
        }
        state.snapshotVersion = adoptedVersion;
    }
    const observedAt: number = yield ctx.utcNow();
    state.contextUsage = updateContextUsageFromEvents(state.contextUsage, (result as any)?.events, observedAt);
    const failedModelSwitchContinuePrompt = captureFailedModelSwitchNotice(runtime, result);
    if (failedModelSwitchContinuePrompt && result.type === "completed") {
        result = {
            ...result,
            forceContinuePrompt: failedModelSwitchContinuePrompt,
        } as TurnResult;
    }

    state.iteration++;
    yield* maybeSummarize(runtime);
    yield* refreshTrackedSubAgents(runtime);

    if ("queuedActions" in result && Array.isArray((result as any).queuedActions) && (result as any).queuedActions.length > 0) {
        state.pendingToolActions.push(...(result as any).queuedActions);
        ctx.traceInfo(`[orch] queued ${(result as any).queuedActions.length} extra action(s) from turn`);
    }
    yield* drainLeadingQueuedScheduleActions(runtime, prompt);

    yield* handleTurnResult(runtime, result, prompt, cycleOrigin, clientMessageIds);
}

// ─── Stop-turn race support ─────────────────────────────────

/**
 * Normalize a raced runTurn branch value. The duroxide-node select bridge
 * flattens activity failures into their raw error string (make_select_future:
 * `Ok(v) => v, Err(e) => e`) instead of throwing into the generator, so the
 * caller must distinguish a TurnResult payload from an error message.
 */
export function normalizeRacedTurnValue(value: any): { kind: "result"; result: any } | { kind: "error"; message: string } {
    let v = value;
    if (typeof v === "string") {
        try {
            v = JSON.parse(v);
        } catch {
            return { kind: "error", message: value };
        }
    }
    if (v && typeof v === "object" && typeof (v as any).type === "string") {
        return { kind: "result", result: v };
    }
    return { kind: "error", message: typeof value === "string" ? value : JSON.stringify(value ?? null) };
}

/**
 * Stop won the race against the in-flight runTurn activity.
 *
 * The dropped runTurn future is already cancel-requested by duroxide (the
 * guaranteed backstop: lock-steal → isCancelled poll → SDK abort, ~2-7s).
 * This path layers the fast-path interrupt on top and owns the authoritative
 * durable bookkeeping — the aborted activity's own writeback is best-effort
 * (it is skipped entirely when the backstop delivered the abort).
 */
function* handleTurnStopped(
    runtime: DurableSessionRuntime,
    stopEventRaw: any,
    clientMessageIds?: string[],
): Generator<any, void, any> {
    const { ctx, state } = runtime;
    let stopEvent: any = stopEventRaw;
    if (typeof stopEvent === "string") {
        try { stopEvent = JSON.parse(stopEvent); } catch { stopEvent = {}; }
    }
    if (!stopEvent || typeof stopEvent !== "object") stopEvent = {};
    const reason = typeof stopEvent.reason === "string" && stopEvent.reason ? stopEvent.reason : "Stopped by user";
    const stoppedIteration = state.iteration;

    ctx.traceInfo(`[orch] stop_turn won the race for turn ${stoppedIteration}; aborting in-flight turn`);
    state.config.turnSystemPrompt = undefined;
    state.retryCount = 0;

    // Fast-path interrupt: same-affinity abortTurn lands on the worker owning
    // the warm session and aborts the SDK request immediately (concurrent
    // dispatch requires stable workerNodeId + a free slot; otherwise the
    // backstop still stops the turn, just slower). Awaiting it also
    // guarantees the per-session run-turn lock is free again before this
    // loop can dispatch the next prompt.
    let abortOutcome: any = null;
    try {
        const raw: any = yield runtime.session.abortTurn(reason, stoppedIteration);
        abortOutcome = typeof raw === "string" ? JSON.parse(raw) : raw;
    } catch (err: any) {
        ctx.traceInfo(`[orch] abortTurn activity failed (backstop cancellation still applies): ${err?.message ?? err}`);
        abortOutcome = { outcome: "no_active_turn", detail: `abortTurn failed: ${err?.message ?? err}` };
    }

    // The race already decided the turn's fate: even when abortTurn reports
    // no_active_turn (the backstop got there first, or the turn had just
    // ended), the user's stop is the durable outcome. Record turn_stopped
    // unconditionally and annotate how the interrupt was delivered.
    yield runtime.manager.recordSessionEvent(runtime.input.sessionId, [
        {
            eventType: "session.turn_stopped",
            data: {
                reason,
                turnIndex: stoppedIteration,
                interrupt: abortOutcome?.outcome ?? "unknown",
                ...(abortOutcome?.detail ? { detail: abortOutcome.detail } : {}),
                ...(clientMessageIds && clientMessageIds.length > 0 ? { clientMessageIds } : {}),
            },
        },
        { eventType: "system.message", data: { content: "Turn stopped by user." } },
    ]);
    // Authoritative CMS transition — also clears active_turn_index (migration
    // 0024 clears it on any state transition away from "running").
    yield runtime.manager.updateCmsState(runtime.input.sessionId, "idle");

    // The turn ran and consumed context even though its result was discarded.
    state.iteration++;

    if (typeof stopEvent.id === "string" && stopEvent.id) {
        yield* writeCommandResponse(runtime, {
            id: stopEvent.id,
            cmd: "stop_turn",
            result: {
                outcome: abortOutcome?.outcome === "stop_forced" ? "stop_forced" : "stopped",
                turnIndex: stoppedIteration,
                ...(abortOutcome?.detail ? { detail: abortOutcome.detail } : {}),
            },
        });
    }

    // Same scheduling semantics as a completed turn: resume interrupted
    // timers, re-arm cron schedules, else idle (skips: writeLatestResponse,
    // parent CHILD_UPDATE notify, forgotten-timer nudge).
    yield* schedulePostTurnContinuation(runtime);
}


// ─── Post-turn continuation: resume timers / re-arm schedules / go idle ───
//
// Extracted verbatim from the tail of the `completed` turn-result case so the
// stop-turn path shares identical scheduling semantics: stopping a turn must
// not silently kill a recurring session's cron loop or a resumable wait
// (stop-turn plan, edge E9).

function* schedulePostTurnContinuation(runtime: DurableSessionRuntime): Generator<any, void, any> {
    const { ctx, state, options } = runtime;

    if (state.interruptedWaitTimer && state.interruptedWaitTimer.remainingSec > 0) {
        const saved = state.interruptedWaitTimer;
        state.interruptedWaitTimer = null;
        ctx.traceInfo(`[orch] auto-resuming interrupted wait: ${saved.remainingSec}s (${saved.reason})`);

        // Lifecycle protocol: state is durable from the turn commit — the
        // wait only decides hold (keep GUID, worker stays warm) vs release
        // (rotate GUID, wake-up hydrates anywhere).
        const resumeWaitPlan = planHoldRelease({
            blobEnabled: state.blobEnabled,
            seconds: saved.remainingSec,
            holdWindowSeconds: options.idleTimeout,
        });
        if (resumeWaitPlan.shouldRelease) {
            yield* releaseAffinity(runtime, "timer");
        }

        const resumeNow: number = yield ctx.utcNow();
        publishStatus(runtime, "waiting", {
            waitSeconds: saved.remainingSec,
            waitReason: saved.reason,
            waitStartedAt: resumeNow,
        });

        state.activeTimer = {
            deadlineMs: resumeNow + saved.remainingSec * 1000,
            originalDurationMs: saved.remainingSec * 1000,
            reason: saved.reason,
            type: "wait",
        };
        return;
    }

    if (state.interruptedCronTimer && state.interruptedCronTimer.remainingMs > 0) {
        const saved = state.interruptedCronTimer;
        state.interruptedCronTimer = null;
        const remainingMs = Math.max(0, saved.remainingMs);
        const remainingSec = Math.max(1, Math.round(remainingMs / 1000));
        ctx.traceInfo(`[orch] auto-resuming interrupted cron: ${remainingSec}s remain (${saved.reason})`);

        const cronResumePlan = planHoldRelease({
            blobEnabled: state.blobEnabled,
            seconds: remainingSec,
            holdWindowSeconds: options.idleTimeout,
        });
        if (cronResumePlan.shouldRelease) {
            yield* releaseAffinity(runtime, "cron");
        }

        const resumeNow: number = yield ctx.utcNow();
        publishStatus(runtime, "waiting", {
            waitSeconds: remainingSec,
            waitReason: saved.reason,
            waitStartedAt: resumeNow,
        });

        state.activeTimer = {
            deadlineMs: resumeNow + remainingMs,
            originalDurationMs: remainingMs,
            reason: saved.reason,
            type: "cron",
        };
        return;
    }

    if (state.cronSchedule) {
        const activeCron = { ...state.cronSchedule };
        const cronPlan = planHoldRelease({
            blobEnabled: state.blobEnabled,
            seconds: activeCron.intervalSeconds,
            holdWindowSeconds: options.idleTimeout,
        });
        if (cronPlan.shouldRelease) {
            yield* releaseAffinity(runtime, "cron");
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

        state.activeTimer = {
            deadlineMs: cronStartedAt + activeCron.intervalSeconds * 1000,
            originalDurationMs: activeCron.intervalSeconds * 1000,
            reason: activeCron.reason,
            type: "cron",
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
        const cronAtPlan = planHoldRelease({
            blobEnabled: state.blobEnabled,
            seconds: waitSeconds,
            holdWindowSeconds: options.idleTimeout,
        });
        if (cronAtPlan.shouldRelease) {
            yield* releaseAffinity(runtime, "cron_at");
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

        state.activeTimer = {
            deadlineMs: nowMs + waitMs,
            originalDurationMs: waitMs,
            reason: activeCronAt.reason,
            type: "cron_at",
        };
        return;
    }

    if (!state.blobEnabled || options.idleTimeout < 0) {
        return;
    }

    // The idle timer IS the affinity hold window (lifecycle protocol §3.4):
    // any session activity re-arms it via the drain machinery, and its fire
    // releases the worker — it no longer dehydrates.
    publishStatus(runtime, "idle");
    const idleNow: number = yield ctx.utcNow();
    state.activeTimer = {
        deadlineMs: idleNow + options.idleTimeout * 1000,
        originalDurationMs: options.idleTimeout * 1000,
        reason: "idle timeout",
        type: "idle",
    };
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
    clientMessageIds?: string[],
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

            if (result.forceContinuePrompt) {
                ctx.traceInfo(`[orch] continuing after terminal model switch failure`);
                yield* versionedContinueAsNew(runtime, continueInputWithPrompt(runtime, result.forceContinuePrompt, {
                    bootstrapPrompt: true,
                }));
                return;
            }

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
                // A spawned child's FIRST completion always reaches the parent
                // regardless of the wake policy: suppressing it (e.g. a
                // wakeOn=completion contract classifying a verdict-less final
                // answer as merely "material") strands the parent until a
                // human pokes. Later completions respect the contract.
                const firstParentReport = !cycleOrigin && !state.reportedFirstCompletionToParent;
                if (wakeDecision.wake || firstParentReport) {
                    state.reportedFirstCompletionToParent = true;
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
                    return;
                }
            }

            yield* schedulePostTurnContinuation(runtime);
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

            // Lifecycle protocol: waits within the hold window keep the
            // affinity GUID (worker stays warm — this is now the default,
            // no wait_on_worker opt-in needed); longer waits release. The
            // legacy `preserveWorkerAffinity` flag is accepted and simply
            // subsumed: holds within the window always preserve affinity.
            const waitPlan = planHoldRelease({
                blobEnabled: state.blobEnabled,
                seconds: result.seconds,
                holdWindowSeconds: options.idleTimeout,
            });
            if (waitPlan.shouldRelease) {
                yield* releaseAffinity(runtime, "timer");
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
                preserveWorkerAffinity: !waitPlan.shouldRelease,
            });

            yield runtime.manager.recordSessionEvent(runtime.input.sessionId, [{
                eventType: "session.wait_started",
                data: { seconds: result.seconds, reason: result.reason, preserveAffinity: !waitPlan.shouldRelease },
            }]);

            state.activeTimer = {
                deadlineMs: waitStartedAt + result.seconds * 1000,
                originalDurationMs: result.seconds * 1000,
                reason: result.reason,
                type: "wait",
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
                return;
            }

            // Lifecycle protocol: waiting on a human is a HOLD, not a
            // dehydrate — arm the hold-window timer directly (its fire
            // releases affinity; an answer within the window lands warm).
            if (options.inputGracePeriod === 0) {
                const inputHoldNow: number = yield ctx.utcNow();
                const inputHoldSeconds = options.idleTimeout > 0 ? options.idleTimeout : 1_800;
                state.activeTimer = {
                    deadlineMs: inputHoldNow + inputHoldSeconds * 1000,
                    originalDurationMs: inputHoldSeconds * 1000,
                    reason: "idle timeout (input required)",
                    type: "idle",
                };
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

        case "stopped": {
            // Defensive: a turn only classifies "stopped" when the stop marker
            // was set, which normally means handleTurnStopped already ran via
            // the race. Handle it anyway so a marker-set turn that somehow
            // returns through the normal path still lands idle with the event
            // trail (processPrompt already incremented state.iteration).
            ctx.traceInfo("[session] turn reported stopped");
            state.retryCount = 0;
            yield runtime.manager.recordSessionEvent(runtime.input.sessionId, [{
                eventType: "session.turn_stopped",
                data: {
                    reason: (result as any).reason ?? "Stopped by user",
                    turnIndex: state.iteration - 1,
                    interrupt: "turn-result",
                    ...(clientMessageIds && clientMessageIds.length > 0 ? { clientMessageIds } : {}),
                },
            }]);
            yield runtime.manager.updateCmsState(runtime.input.sessionId, "idle");
            yield* schedulePostTurnContinuation(runtime);
            return;
        }

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
            const activeCron = state.cronSchedule;
            if (!activeCron) {
                // A cancel cannot retract the already-scheduled durable timer,
                // so a stale cron fire with no schedule is expected — ignore it.
                ctx.traceInfo("[orch] cron timer fired but no active cronSchedule exists");
                return;
            }
            yield runtime.manager.recordSessionEvent(runtime.input.sessionId, [{
                eventType: "session.cron_fired",
                data: {},
            }]);
            const cycleReportGuidance = "If this cycle finds material changes or blockers that should wake your parent, call report_cycle(status='material' or status='blocked', summary='...') before finishing. If nothing material changed, do NOT call report_cycle at all — just end the turn silently. Do not emit report_cycle(status='quiet') on an uneventful cycle, and never write a tool call as text.";
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
                `If nothing material changed, do NOT call report_cycle at all — just end the turn silently. ` +
                `Do not emit report_cycle(status='quiet') on an uneventful cycle, and never write a tool call as text.]`;
            if (timer.shouldRehydrate) {
                yield* processPrompt(
                    runtime,
                    wrapWithResumeContext(runtime, "Resume your recurring task.",
                        `Scheduled wall-clock cron wake-up for "${activeCronAt.reason}". ` +
                        `Schedule: ${description}. Scheduled fire: ${new Date(scheduledAtMs).toISOString()}. ` +
                        `If this cycle finds material changes or blockers that should wake your parent, call report_cycle(status='material' or status='blocked', summary='...') before finishing. ` +
                        `If nothing material changed, do NOT call report_cycle at all — just end the turn silently. ` +
                        `Do not emit report_cycle(status='quiet') on an uneventful cycle, and never write a tool call as text.`),
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
            // Lifecycle protocol: hold window expired → release the worker.
            // No dehydrate — every completed turn already committed its
            // snapshot; the old worker's copy is a cache its own eviction
            // clock reclaims.
            ctx.traceInfo("[session] hold window expired, releasing worker affinity");
            yield* releaseAffinity(runtime, "idle");
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
                        } else if (parsed.status === "idle") {
                            // Quiescent child: answered and parked with an empty
                            // queue. It will never speak again unprompted, so
                            // treating it as still-running polls forever
                            // (observed live: 70+ min of 30s polls). "idle"
                            // satisfies the wait via isAgentWaitSettledStatus.
                            agent.status = "idle";
                        } else if (parsed.status === "input_required") {
                            agent.status = "input_required";
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
                    // Re-assert "waiting" each poll (mirrors the shutdown
                    // branch) so a stale "running" from a mid-wait worker
                    // swap self-heals instead of spinning "Working…".
                    publishStatus(runtime, "waiting", {
                        waitReason: `waiting for ${nowRunning.length} agent(s)`,
                        waitStartedAt: now,
                    });
                }
            }
            return;
        }
        case "input-grace": {
            // Lifecycle protocol: grace elapsed without an answer → enter
            // the hold window (idle timer). The eventual idle fire releases
            // affinity; an answer any time before that lands warm.
            const graceElapsedNow: number = yield runtime.ctx.utcNow();
            const holdSeconds = runtime.options.idleTimeout > 0 ? runtime.options.idleTimeout : 1_800;
            state.activeTimer = {
                deadlineMs: graceElapsedNow + holdSeconds * 1000,
                originalDurationMs: holdSeconds * 1000,
                reason: "idle timeout (input required)",
                type: "idle",
            };
            return;
        }
    }
}
