import type {
    CommandMessage,
    CommandResponse,
    OrchestrationInput,
    PilotSwarmSessionStatus,
    SessionCommandResponse,
    SessionResponsePayload,
    SessionStatusSignal,
    TurnAction,
} from "../types.js";
import {
    COMMAND_VERSION_KEY,
    RESPONSE_LATEST_KEY,
    RESPONSE_VERSION_KEY,
    commandResponseKey,
} from "../types.js";
import { createSessionProxy } from "../session-proxy.js";
import {
    beginGracefulShutdown,
    type ShutdownMode,
} from "./agents.js";
import {
    FIRST_SUMMARIZE_DELAY,
    INTERNAL_SYSTEM_TURN_PROMPT,
    REPEAT_SUMMARIZE_DELAY,
    type DurableSessionRuntime,
} from "./state.js";
import {
    appendSystemContext,
    extractPromptSystemContext,
    mergePrompt,
} from "./utils.js";

// ─── Custom status / KV helpers ─────────────────────────────

export function publishStatus(
    runtime: DurableSessionRuntime,
    status: PilotSwarmSessionStatus,
    extra: Record<string, unknown> = {},
): void {
    const { state } = runtime;
    const signal: SessionStatusSignal = {
        status,
        iteration: state.iteration,
        ...(state.lastResponseVersion > 0 ? { responseVersion: state.lastResponseVersion } : {}),
        ...(state.lastCommandVersion > 0 ? { commandVersion: state.lastCommandVersion } : {}),
        ...(state.lastCommandId ? { commandId: state.lastCommandId } : {}),
        ...(state.cronSchedule
            ? {
                cronActive: true,
                cronInterval: state.cronSchedule.intervalSeconds,
                cronReason: state.cronSchedule.reason,
            }
            : { cronActive: false }),
        ...(state.contextUsage ? { contextUsage: state.contextUsage } : {}),
        ...extra,
    } as SessionStatusSignal;
    runtime.ctx.setCustomStatus(JSON.stringify(signal));
}

function writeJsonValue(ctx: any, key: string, value: unknown): void {
    ctx.setValue(key, JSON.stringify(value));
}

export function readCounter(ctx: any, key: string): number {
    const raw = ctx.getValue(key);
    if (raw == null) return 0;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : 0;
}

function bumpCounter(ctx: any, key: string): number {
    const next = readCounter(ctx, key) + 1;
    ctx.setValue(key, String(next));
    return next;
}

export function* writeLatestResponse(
    runtime: DurableSessionRuntime,
    payload: Omit<SessionResponsePayload, "schemaVersion" | "version" | "emittedAt">,
): Generator<any, SessionResponsePayload, any> {
    const version = bumpCounter(runtime.ctx, RESPONSE_VERSION_KEY);
    const emittedAt: number = yield runtime.ctx.utcNow();
    const responsePayload: SessionResponsePayload = {
        schemaVersion: 1,
        version,
        emittedAt,
        ...payload,
    };
    writeJsonValue(runtime.ctx, RESPONSE_LATEST_KEY, responsePayload);
    runtime.state.lastResponseVersion = version;
    return responsePayload;
}

export function* writeCommandResponse(
    runtime: DurableSessionRuntime,
    response: CommandResponse,
): Generator<any, SessionCommandResponse, any> {
    const version = bumpCounter(runtime.ctx, COMMAND_VERSION_KEY);
    const emittedAt: number = yield runtime.ctx.utcNow();
    const payload: SessionCommandResponse = {
        ...response,
        schemaVersion: 1,
        version,
        emittedAt,
    };
    writeJsonValue(runtime.ctx, commandResponseKey(response.id), payload);
    runtime.state.lastCommandVersion = version;
    runtime.state.lastCommandId = response.id;
    yield runtime.manager.recordSessionEvent(runtime.input.sessionId, [{
        eventType: "session.command_completed",
        data: { cmd: response.cmd, id: response.id },
    }]);
    return payload;
}

// ─── Hydration / dehydration / checkpointing ────────────────

export function wrapWithResumeContext(
    runtime: DurableSessionRuntime,
    userPrompt: string,
    extra?: string,
): string {
    const base = runtime.state.pendingRehydrationMessage ??
        `The session was dehydrated and has been rehydrated on a new worker. ` +
        `The LLM conversation history is preserved.`;
    runtime.state.pendingRehydrationMessage = undefined;
    const parts = [userPrompt, ``, `[SYSTEM: ${base}`];
    if (extra) parts.push(extra);
    parts.push(`]`);
    return parts.join("\n");
}

export function* dehydrateForNextTurn(
    runtime: DurableSessionRuntime,
    reason: string,
    resetAffinity = true,
    eventData?: Record<string, unknown>,
): Generator<any, void, any> {
    const { ctx, state } = runtime;
    if (state.needsHydration) {
        ctx.traceInfo(`[orch] skipping dehydrate (reason=${reason}) because the session is already marked dehydrated`);
        state.activeTimer = null;
        return;
    }

    if (state.lastLiveSessionAction === "dehydrate") {
        ctx.traceInfo(`[orch] skipping redundant dehydrate (reason=${reason}) because the last live-session action was already dehydrate`);
        state.activeTimer = null;
        return;
    }

    ctx.traceInfo(`[orch] dehydrating session (reason=${reason}, resetAffinity=${resetAffinity})`);
    state.activeTimer = null;
    state.lastLiveSessionAction = "dehydrate";
    const dehydrateResult = yield runtime.session.dehydrate(reason, eventData);
    const lossyHandoff = dehydrateResult?.lossyHandoff;
    if (lossyHandoff && typeof lossyHandoff === "object") {
        const lossyMessage = String((lossyHandoff as any).message || "dehydrate lost the live Copilot session state");
        ctx.traceInfo(`[orch] ${lossyMessage}`);
        state.needsHydration = false;
        state.preserveAffinityOnHydrate = false;
        if (resetAffinity) {
            state.affinityKey = yield ctx.newGuid();
            runtime.session = createSessionProxy(ctx, runtime.input.sessionId, state.affinityKey, state.config);
        }
        return;
    }
    state.needsHydration = true;
    state.preserveAffinityOnHydrate = !resetAffinity;
    if (resetAffinity) {
        state.affinityKey = yield ctx.newGuid();
        runtime.session = createSessionProxy(ctx, runtime.input.sessionId, state.affinityKey, state.config);
    }
}

export function* maybeCheckpoint(runtime: DurableSessionRuntime): Generator<any, void, any> {
    if (!runtime.state.blobEnabled || runtime.options.checkpointInterval < 0) return;
    try {
        runtime.ctx.traceInfo(`[orch] checkpoint (iteration=${runtime.state.iteration})`);
        yield runtime.session.checkpoint();
    } catch (err: any) {
        runtime.ctx.traceInfo(`[orch] checkpoint failed: ${err.message ?? err}`);
    }
}

export function* maybeSummarize(runtime: DurableSessionRuntime): Generator<any, void, any> {
    if (runtime.options.isSystem) return;
    const now: number = yield runtime.ctx.utcNow();
    if (runtime.state.nextSummarizeAt === 0) {
        runtime.state.nextSummarizeAt = now + FIRST_SUMMARIZE_DELAY;
        return;
    }
    if (now < runtime.state.nextSummarizeAt) return;
    try {
        runtime.ctx.traceInfo(`[orch] summarizing session title`);
        yield runtime.manager.summarizeSession(runtime.input.sessionId);
    } catch (err: any) {
        runtime.ctx.traceInfo(`[orch] summarize failed: ${err.message}`);
    }
    runtime.state.nextSummarizeAt = now + REPEAT_SUMMARIZE_DELAY;
}

// ─── Task context / cron action helpers ─────────────────────

export function ensureTaskContext(runtime: DurableSessionRuntime, sourcePrompt?: string): void {
    if (runtime.state.taskContext || !sourcePrompt) return;
    runtime.state.taskContext = sourcePrompt.slice(0, 2000);
    const base = typeof runtime.options.baseSystemMessage === "string"
        ? runtime.options.baseSystemMessage ?? ""
        : (runtime.options.baseSystemMessage as any)?.content ?? "";
    runtime.state.config.systemMessage = base + (base ? "\n\n" : "") +
        "[RECURRING TASK]\n" +
        "Original user request (always remember, even if conversation history is truncated):\n\"" +
        runtime.state.taskContext + "\"";
}

export function applyCronAction(
    runtime: DurableSessionRuntime,
    action: Extract<TurnAction, { type: "cron" }>,
    sourcePrompt?: string,
): void {
    runtime.state.interruptedCronTimer = null;
    if (action.action === "cancel") {
        runtime.ctx.traceInfo("[orch] cron cancelled");
        runtime.state.cronSchedule = undefined;
        return;
    }

    ensureTaskContext(runtime, sourcePrompt);
    runtime.state.cronSchedule = {
        intervalSeconds: action.intervalSeconds,
        reason: action.reason,
    };
    runtime.ctx.traceInfo(`[orch] cron scheduled: every ${action.intervalSeconds}s (${action.reason})`);
}

export function drainLeadingQueuedCronActions(runtime: DurableSessionRuntime, sourcePrompt?: string): void {
    while (runtime.state.pendingToolActions[0]?.type === "cron") {
        applyCronAction(
            runtime,
            runtime.state.pendingToolActions.shift() as Extract<TurnAction, { type: "cron" }>,
            sourcePrompt,
        );
    }
}

// ─── Cancellation tombstone helpers ─────────────────────────

export function promptIdsIntersectCancellation(runtime: DurableSessionRuntime, ids: string[]): boolean {
    return ids.length > 0 && ids.some((id) => runtime.state.cancelledMessageIds.has(id));
}

export function* recordCancelledMessageIds(
    runtime: DurableSessionRuntime,
    ids: string[],
    reason: string,
): Generator<any, void, any> {
    const nextIds = ids.filter((id) => id && !runtime.state.emittedCancelledMessageIds.has(id));
    if (nextIds.length === 0) return;
    for (const id of nextIds) runtime.state.emittedCancelledMessageIds.add(id);
    yield runtime.manager.recordSessionEvent(runtime.input.sessionId, [{
        eventType: "pending_messages.cancelled",
        data: {
            clientMessageIds: nextIds,
            reason,
        },
    }]);
}

// ─── Pending child-digest accumulation ──────────────────────

export function bufferChildUpdate(
    runtime: DurableSessionRuntime,
    update: { sessionId: string; updateType: string; content: string },
    observedAtMs: number,
): void {
    if (!runtime.state.pendingChildDigest) {
        runtime.state.pendingChildDigest = {
            startedAtMs: observedAtMs,
            updates: [],
        };
    }

    const nextEntry = {
        sessionId: update.sessionId,
        updateType: update.updateType,
        ...(update.content ? { content: update.content.slice(0, 2000) } : {}),
        observedAtMs,
    };
    const existingIndex = runtime.state.pendingChildDigest.updates.findIndex((entry) => entry.sessionId === update.sessionId);
    if (existingIndex >= 0) {
        runtime.state.pendingChildDigest.updates[existingIndex] = nextEntry;
    } else {
        runtime.state.pendingChildDigest.updates.push(nextEntry);
    }
}

export function clearPendingChildDigest(runtime: DurableSessionRuntime): void {
    runtime.state.pendingChildDigest = null;
}

export function buildPendingChildDigestSystemPrompt(runtime: DurableSessionRuntime): string | undefined {
    const digest = runtime.state.pendingChildDigest;
    if (!digest || digest.updates.length === 0) return undefined;

    const lines = digest.updates.map((update) => {
        const agent = runtime.state.subAgents.find((entry) => entry.sessionId === update.sessionId);
        const label = agent?.orchId ?? update.sessionId;
        const task = agent?.task ? `Task: "${agent.task.slice(0, 120)}"\n` : "";
        const status = agent?.status ?? update.updateType;
        const resultText = String(update.content || agent?.result || "").trim();
        const result = resultText ? resultText.slice(0, 240) : "(no summary)";
        return `  - Agent ${label}\n` +
            `    ${task}` +
            `    Update: ${update.updateType}\n` +
            `    Status: ${status}\n` +
            `    Result: ${result}`;
    });

    return `Buffered child updates arrived during the last 30 seconds:\n${lines.join("\n")}\nReview the updates and continue your task.`;
}

export function flushPendingChildDigestIntoPrompt(
    runtime: DurableSessionRuntime,
    rawPrompt: string | undefined,
): string | undefined {
    const childDigestPrompt = buildPendingChildDigestSystemPrompt(runtime);
    if (!childDigestPrompt) return rawPrompt;
    clearPendingChildDigest(runtime);
    return appendSystemContext(rawPrompt, childDigestPrompt);
}

// ─── Followup queueing ──────────────────────────────────────

export function queueFollowup(runtime: DurableSessionRuntime, nextPrompt: string): void {
    let text = nextPrompt;
    const trimmed = text.trim();
    if (trimmed.startsWith("[SYSTEM:") && trimmed.endsWith("]")) {
        text = trimmed.slice("[SYSTEM:".length, -1).trim();
    }
    runtime.state.pendingPrompt = mergePrompt(runtime.state.pendingPrompt, text);
}

// ─── Continue-as-new construction ───────────────────────────

export function buildContinueInput(
    runtime: DurableSessionRuntime,
    overrides: Partial<OrchestrationInput> = {},
): OrchestrationInput {
    const { state, options, input } = runtime;
    const {
        prompt: overridePrompt,
        requiredTool: overrideRequiredTool,
        systemPrompt: overrideSystemPrompt,
        bootstrapPrompt: overrideBootstrapPrompt,
        rehydrationMessage: overrideRehydrationMessage,
        ...restOverrides
    } = overrides;

    const carriedPrompt = overridePrompt ?? state.pendingPrompt;
    const carriedRequiredTool = overrideRequiredTool ?? state.pendingRequiredTool;
    const carriedSystemPrompt = overrideSystemPrompt ?? state.pendingSystemPrompt;
    const carriedRehydrationMessage = overrideRehydrationMessage ?? state.pendingRehydrationMessage;
    const promptForInput = carriedPrompt
        ?? (carriedSystemPrompt ? INTERNAL_SYSTEM_TURN_PROMPT : undefined);
    const bootstrapForInput = overrideBootstrapPrompt
        ?? (carriedPrompt ? state.bootstrapPrompt : carriedSystemPrompt ? true : undefined);

    return {
        sessionId: input.sessionId,
        config: state.config,
        iteration: state.iteration,
        affinityKey: state.affinityKey,
        preserveAffinityOnHydrate: state.preserveAffinityOnHydrate,
        needsHydration: state.needsHydration,
        blobEnabled: state.blobEnabled,
        dehydrateThreshold: options.dehydrateThreshold,
        idleTimeout: options.idleTimeout,
        inputGracePeriod: options.inputGracePeriod,
        checkpointInterval: options.checkpointInterval,
        ...(carriedRehydrationMessage ? { rehydrationMessage: carriedRehydrationMessage } : {}),
        nextSummarizeAt: state.nextSummarizeAt,
        taskContext: state.taskContext,
        baseSystemMessage: options.baseSystemMessage,
        ...(state.cronSchedule ? { cronSchedule: state.cronSchedule } : {}),
        ...(state.contextUsage ? { contextUsage: state.contextUsage } : {}),
        ...(carriedSystemPrompt ? { systemPrompt: carriedSystemPrompt } : {}),
        ...(promptForInput ? { prompt: promptForInput } : {}),
        ...(carriedRequiredTool ? { requiredTool: carriedRequiredTool } : {}),
        ...(promptForInput && bootstrapForInput !== undefined ? { bootstrapPrompt: bootstrapForInput } : {}),
        subAgents: state.subAgents,
        ...(state.pendingToolActions.length > 0 ? { pendingToolActions: state.pendingToolActions } : {}),
        parentSessionId: options.parentSessionId,
        nestingLevel: options.nestingLevel,
        ...(options.isSystem ? { isSystem: true } : {}),
        retryCount: 0,
        ...(state.pendingInputQuestion ? { pendingInputQuestion: state.pendingInputQuestion } : {}),
        ...(state.waitingForAgentIds ? { waitingForAgentIds: state.waitingForAgentIds } : {}),
        ...(state.interruptedWaitTimer ? { interruptedWaitTimer: state.interruptedWaitTimer } : {}),
        ...(state.interruptedCronTimer ? { interruptedCronTimer: state.interruptedCronTimer } : {}),
        ...(state.pendingChildDigest ? { pendingChildDigest: state.pendingChildDigest } : {}),
        ...(state.pendingShutdown ? { pendingShutdown: state.pendingShutdown } : {}),
        ...restOverrides,
    };
}

export function buildContinueInputWithPrompt(
    runtime: DurableSessionRuntime,
    nextPrompt?: string,
    overrides: Partial<OrchestrationInput> = {},
): OrchestrationInput {
    const extracted = extractPromptSystemContext(nextPrompt);
    const mergedPrompt = mergePrompt(runtime.state.pendingPrompt, extracted.prompt);
    const mergedSystemPrompt = mergePrompt(runtime.state.pendingSystemPrompt, extracted.systemPrompt);
    return buildContinueInput(runtime, {
        ...(mergedPrompt ? { prompt: mergedPrompt } : {}),
        ...(mergedSystemPrompt ? { systemPrompt: mergedSystemPrompt } : {}),
        ...overrides,
    });
}

function* checkpointBeforeWarmContinueAsNew(runtime: DurableSessionRuntime): Generator<any, void, any> {
    if (!runtime.state.blobEnabled) return;
    try {
        runtime.ctx.traceInfo(`[orch] checkpoint before warm continueAsNew (iteration=${runtime.state.iteration})`);
        yield runtime.session.checkpoint();
    } catch (err: any) {
        runtime.ctx.traceInfo(`[orch] warm continueAsNew checkpoint failed: ${err.message ?? err}`);
    }
}

/** Capture the active timer state into a continueAsNew input and yield the version-bumped CAN. */
export function* versionedContinueAsNew(
    runtime: DurableSessionRuntime,
    canInput: OrchestrationInput,
): Generator<any, void, any> {
    const { state } = runtime;
    if (state.activeTimer) {
        const now: number = yield runtime.ctx.utcNow();
        const remainingMs = Math.max(0, state.activeTimer.deadlineMs - now);
        canInput.activeTimerState = {
            remainingMs,
            reason: state.activeTimer.reason,
            type: state.activeTimer.type,
            originalDurationMs: state.activeTimer.originalDurationMs,
            ...(state.activeTimer.shouldRehydrate ? { shouldRehydrate: true } : {}),
            ...(state.activeTimer.waitPlan ? { waitPlan: state.activeTimer.waitPlan } : {}),
            ...(state.activeTimer.content ? { content: state.activeTimer.content } : {}),
            ...(state.activeTimer.question ? { question: state.activeTimer.question } : {}),
            ...(state.activeTimer.choices ? { choices: state.activeTimer.choices } : {}),
            ...(state.activeTimer.allowFreeform !== undefined ? { allowFreeform: state.activeTimer.allowFreeform } : {}),
            ...(state.activeTimer.agentIds ? { agentIds: state.activeTimer.agentIds } : {}),
        };
    }
    if (!canInput.needsHydration) {
        yield* checkpointBeforeWarmContinueAsNew(runtime);
    }
    canInput.sourceOrchestrationVersion = runtime.versions.currentVersion;
    yield runtime.ctx.continueAsNewVersioned(canInput, runtime.versions.latestVersion);
}

export function continueInput(
    runtime: DurableSessionRuntime,
    overrides: Partial<OrchestrationInput> = {},
): OrchestrationInput {
    return buildContinueInput(runtime, overrides);
}

export function continueInputWithPrompt(
    runtime: DurableSessionRuntime,
    nextPrompt?: string,
    overrides: Partial<OrchestrationInput> = {},
): OrchestrationInput {
    return buildContinueInputWithPrompt(runtime, nextPrompt, overrides);
}

// ─── Command handling ───────────────────────────────────────

export function* handleCommand(
    runtime: DurableSessionRuntime,
    cmdMsg: CommandMessage,
): Generator<any, void, any> {
    runtime.ctx.traceInfo(`[orch-cmd] ${cmdMsg.cmd} id=${cmdMsg.id}`);
    yield runtime.manager.recordSessionEvent(runtime.input.sessionId, [{
        eventType: "session.command_received",
        data: { cmd: cmdMsg.cmd, id: cmdMsg.id },
    }]);

    switch (cmdMsg.cmd) {
        case "set_model": {
            const newModel = String(cmdMsg.args?.model || "");
            const oldModel = runtime.state.config.model || "(default)";
            runtime.state.config = { ...runtime.state.config, model: newModel };
            const resp: CommandResponse = {
                id: cmdMsg.id,
                cmd: cmdMsg.cmd,
                result: { ok: true, oldModel, newModel },
            };
            yield* writeCommandResponse(runtime, resp);
            publishStatus(runtime, "idle");
            yield* versionedContinueAsNew(runtime, continueInput(runtime));
            return;
        }
        case "list_models": {
            publishStatus(runtime, "idle", { cmdProcessing: cmdMsg.id });
            let models: unknown;
            try {
                const raw: any = yield runtime.manager.listModels();
                models = typeof raw === "string" ? JSON.parse(raw) : raw;
            } catch (err: any) {
                const resp: CommandResponse = {
                    id: cmdMsg.id,
                    cmd: cmdMsg.cmd,
                    error: err.message || String(err),
                };
                yield* writeCommandResponse(runtime, resp);
                publishStatus(runtime, "idle");
                return;
            }
            const resp: CommandResponse = {
                id: cmdMsg.id,
                cmd: cmdMsg.cmd,
                result: { models, currentModel: runtime.state.config.model },
            };
            yield* writeCommandResponse(runtime, resp);
            publishStatus(runtime, "idle");
            return;
        }
        case "get_info": {
            const resp: CommandResponse = {
                id: cmdMsg.id,
                cmd: cmdMsg.cmd,
                result: {
                    model: runtime.state.config.model || "(default)",
                    iteration: runtime.state.iteration,
                    sessionId: runtime.input.sessionId,
                    affinityKey: runtime.state.affinityKey,
                    affinityKeyShort: runtime.state.affinityKey?.slice(0, 8),
                    preserveAffinityOnHydrate: runtime.state.preserveAffinityOnHydrate,
                    needsHydration: runtime.state.needsHydration,
                    blobEnabled: runtime.state.blobEnabled,
                    contextUsage: runtime.state.contextUsage,
                },
            };
            yield* writeCommandResponse(runtime, resp);
            publishStatus(runtime, "idle");
            return;
        }
        case "done":
        case "cancel":
        case "delete": {
            runtime.ctx.traceInfo(`[orch] ${cmdMsg.cmd} command received — beginning graceful ${cmdMsg.cmd}`);
            yield* beginGracefulShutdown(runtime, cmdMsg.cmd as ShutdownMode, cmdMsg);
            return;
        }
        default: {
            const resp: CommandResponse = {
                id: cmdMsg.id,
                cmd: cmdMsg.cmd,
                error: `Unknown command: ${cmdMsg.cmd}`,
            };
            yield* writeCommandResponse(runtime, resp);
            publishStatus(runtime, "idle");
            return;
        }
    }
}
