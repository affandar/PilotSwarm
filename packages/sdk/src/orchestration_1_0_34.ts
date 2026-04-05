import {
    RESPONSE_VERSION_KEY,
    COMMAND_VERSION_KEY,
    RESPONSE_LATEST_KEY,
    commandResponseKey,
} from "./types.js";
import {
    SESSION_STATE_MISSING_PREFIX,
} from "./types.js";
import type {
    TurnAction,
    TurnResult,
    OrchestrationInput,
    SubAgentEntry,
    SerializableSessionConfig,
    PilotSwarmSessionStatus,
    CommandMessage,
    CommandResponse,
    SessionResponsePayload,
    SessionCommandResponse,
    SessionStatusSignal,
    SessionContextUsage,
} from "./types.js";
import { createSessionProxy, createSessionManagerProxy } from "./session-proxy.js";
import { planWaitHandling } from "./wait-affinity.js";

/**
 * Set custom status as a JSON blob of session state.
 * Clients read this via waitForStatusChange() or getStatus().
 * @internal
 */
function setStatus(ctx: any, status: PilotSwarmSessionStatus, extra?: Record<string, unknown>) {
    const signal: SessionStatusSignal = { status, ...(extra ?? {}) } as SessionStatusSignal;
    ctx.setCustomStatus(JSON.stringify(signal));
}

function cloneContextUsage(contextUsage?: SessionContextUsage): SessionContextUsage | undefined {
    if (!contextUsage) return undefined;
    return {
        ...contextUsage,
        ...(contextUsage.compaction ? { compaction: { ...contextUsage.compaction } } : {}),
    };
}

function finiteNumber(value: unknown): number | undefined {
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function optionalBoolean(value: unknown): boolean | undefined {
    return typeof value === "boolean" ? value : undefined;
}

function isSubAgentTerminalStatus(status?: string): boolean {
    return status === "completed" || status === "failed" || status === "cancelled";
}

function updateContextUsageFromEvents(
    previous: SessionContextUsage | undefined,
    events: Array<{ eventType?: string; data?: any }> | undefined,
    observedAt: number,
): SessionContextUsage | undefined {
    let next = cloneContextUsage(previous);
    if (!Array.isArray(events) || events.length === 0) return next;

    for (const event of events) {
        if (!event || typeof event !== "object") continue;
        const eventType = event.eventType;
        const data = event.data;
        if (!eventType || !data || typeof data !== "object") continue;

        if (eventType === "session.usage_info") {
            const tokenLimit = finiteNumber(data.tokenLimit);
            const currentTokens = finiteNumber(data.currentTokens);
            const messagesLength = finiteNumber(data.messagesLength);
            if (tokenLimit == null || currentTokens == null || messagesLength == null) continue;

            next = {
                ...(next ?? {}),
                tokenLimit,
                currentTokens,
                utilization: tokenLimit > 0 ? currentTokens / tokenLimit : 0,
                messagesLength,
                updatedAt: observedAt,
            };

            const systemTokens = finiteNumber(data.systemTokens);
            if (systemTokens != null) next.systemTokens = systemTokens;
            const conversationTokens = finiteNumber(data.conversationTokens);
            if (conversationTokens != null) next.conversationTokens = conversationTokens;
            const toolDefinitionsTokens = finiteNumber(data.toolDefinitionsTokens);
            if (toolDefinitionsTokens != null) next.toolDefinitionsTokens = toolDefinitionsTokens;
            const isInitial = optionalBoolean(data.isInitial);
            if (isInitial != null) next.isInitial = isInitial;
            continue;
        }

        if (!next) continue;

        if (eventType === "assistant.usage") {
            const inputTokens = finiteNumber(data.inputTokens);
            if (inputTokens != null) next.lastInputTokens = inputTokens;
            const outputTokens = finiteNumber(data.outputTokens);
            if (outputTokens != null) next.lastOutputTokens = outputTokens;
            const cacheReadTokens = finiteNumber(data.cacheReadTokens);
            if (cacheReadTokens != null) next.lastCacheReadTokens = cacheReadTokens;
            const cacheWriteTokens = finiteNumber(data.cacheWriteTokens);
            if (cacheWriteTokens != null) next.lastCacheWriteTokens = cacheWriteTokens;
            next.updatedAt = observedAt;
            continue;
        }

        if (eventType === "session.compaction_start") {
            const compaction = {
                ...(next.compaction ?? { state: "idle" as const }),
                state: "running" as const,
                startedAt: observedAt,
                completedAt: undefined,
                error: undefined,
            };
            next.compaction = compaction;
            next.updatedAt = observedAt;
            continue;
        }

        if (eventType === "session.compaction_complete") {
            const compaction: NonNullable<SessionContextUsage["compaction"]> = {
                ...(next.compaction ?? { state: "idle" }),
                state: data.success === false ? "failed" : "succeeded",
                completedAt: observedAt,
            };
            if (typeof data.error === "string" && data.error) compaction.error = data.error;
            else delete compaction.error;

            const preCompactionTokens = finiteNumber(data.preCompactionTokens);
            if (preCompactionTokens != null) compaction.preCompactionTokens = preCompactionTokens;
            const postCompactionTokens = finiteNumber(data.postCompactionTokens);
            if (postCompactionTokens != null) compaction.postCompactionTokens = postCompactionTokens;
            const preCompactionMessagesLength = finiteNumber(data.preCompactionMessagesLength);
            if (preCompactionMessagesLength != null) compaction.preCompactionMessagesLength = preCompactionMessagesLength;
            const messagesRemoved = finiteNumber(data.messagesRemoved);
            if (messagesRemoved != null) compaction.messagesRemoved = messagesRemoved;
            const tokensRemoved = finiteNumber(data.tokensRemoved);
            if (tokensRemoved != null) compaction.tokensRemoved = tokensRemoved;
            const systemTokens = finiteNumber(data.systemTokens);
            if (systemTokens != null) compaction.systemTokens = systemTokens;
            const conversationTokens = finiteNumber(data.conversationTokens);
            if (conversationTokens != null) compaction.conversationTokens = conversationTokens;
            const toolDefinitionsTokens = finiteNumber(data.toolDefinitionsTokens);
            if (toolDefinitionsTokens != null) compaction.toolDefinitionsTokens = toolDefinitionsTokens;

            const compactionTokensUsed = data.compactionTokensUsed && typeof data.compactionTokensUsed === "object"
                ? data.compactionTokensUsed
                : null;
            if (compactionTokensUsed) {
                const compactionInputTokens = finiteNumber(compactionTokensUsed.input);
                if (compactionInputTokens != null) compaction.inputTokens = compactionInputTokens;
                const compactionOutputTokens = finiteNumber(compactionTokensUsed.output);
                if (compactionOutputTokens != null) compaction.outputTokens = compactionOutputTokens;
                const compactionCachedInputTokens = finiteNumber(compactionTokensUsed.cachedInput);
                if (compactionCachedInputTokens != null) compaction.cachedInputTokens = compactionCachedInputTokens;
            }

            if (postCompactionTokens != null) {
                next.currentTokens = postCompactionTokens;
                next.utilization = next.tokenLimit > 0 ? postCompactionTokens / next.tokenLimit : 0;
            }
            if (preCompactionMessagesLength != null && messagesRemoved != null) {
                next.messagesLength = Math.max(0, preCompactionMessagesLength - messagesRemoved);
            }
            if (systemTokens != null) next.systemTokens = systemTokens;
            if (conversationTokens != null) next.conversationTokens = conversationTokens;
            if (toolDefinitionsTokens != null) next.toolDefinitionsTokens = toolDefinitionsTokens;
            next.compaction = compaction;
            next.updatedAt = observedAt;
        }
    }

    return next;
}

/**
 * Flat event loop durable session orchestration (v1.0.34).
 *
 * Replaces the nested while loops of v1.0.31 with a single
 * drain → decide → process loop backed by a KV FIFO work buffer.
 *
 * @internal
 */
export const CURRENT_ORCHESTRATION_VERSION = "1.0.34";

export function* durableSessionOrchestration_1_0_34(
    ctx: any,
    input: OrchestrationInput,
): Generator<any, string, any> {
    const rawTraceInfo = typeof ctx.traceInfo === "function" ? ctx.traceInfo.bind(ctx) : null;
    if (rawTraceInfo) {
        ctx.traceInfo = (message: string) => rawTraceInfo(`[v1.0.34] ${message}`);
    }
    const dehydrateThreshold = input.dehydrateThreshold ?? 30;
    const idleTimeout = input.idleTimeout ?? 30;
    const inputGracePeriod = input.inputGracePeriod ?? 30;
    const checkpointInterval = input.checkpointInterval ?? -1;
    const rehydrationMessage = input.rehydrationMessage;
    const blobEnabled = input.blobEnabled ?? false;
    let needsHydration = input.needsHydration ?? false;
    let affinityKey = input.affinityKey ?? input.sessionId;
    let preserveAffinityOnHydrate = input.preserveAffinityOnHydrate ?? false;
    let iteration = input.iteration ?? 0;
    let config = { ...input.config };
    let retryCount = input.retryCount ?? 0;
    let taskContext = input.taskContext;
    const baseSystemMessage = input.baseSystemMessage ?? config.systemMessage;
    const isSystem = input.isSystem ?? false;
    let cronSchedule = input.cronSchedule ? { ...input.cronSchedule } : undefined;
    let contextUsage = cloneContextUsage(input.contextUsage);
    const MAX_RETRIES = 3;
    const MAX_SUB_AGENTS = 20;
    const MAX_NESTING_LEVEL = 2;
    const CHILD_UPDATE_BATCH_MS = 30_000;

    // ─── Sub-agent tracking ──────────────────────────────────
    let subAgents: SubAgentEntry[] = input.subAgents ? [...input.subAgents] : [];
    let pendingToolActions: TurnAction[] = input.pendingToolActions ? [...input.pendingToolActions] : [];
    const parentSessionId = input.parentSessionId
        ?? (input.parentOrchId ? input.parentOrchId.replace(/^session-/, '') : undefined);
    const nestingLevel = input.nestingLevel ?? 0;

    if (taskContext) {
        const base = typeof baseSystemMessage === 'string'
            ? baseSystemMessage ?? ''
            : (baseSystemMessage as any)?.content ?? '';
        config.systemMessage = base + (base ? '\n\n' : '') +
            '[RECURRING TASK]\n' +
            'Original user request (always remember, even if conversation history is truncated):\n"' +
            taskContext + '"';
    }

    // ─── Title summarization timer ───────────────────────────
    let nextSummarizeAt = input.nextSummarizeAt ?? 0;

    // ─── Create proxies ──────────────────────────────────────
    const manager = createSessionManagerProxy(ctx);
    let session = createSessionProxy(ctx, input.sessionId, affinityKey, config);

    function writeJsonValue(key: string, value: unknown): void {
        ctx.setValue(key, JSON.stringify(value));
    }

    function readCounter(key: string): number {
        const raw = ctx.getValue(key);
        if (raw == null) return 0;
        const parsed = Number(raw);
        return Number.isFinite(parsed) ? parsed : 0;
    }

    function bumpCounter(key: string): number {
        const next = readCounter(key) + 1;
        ctx.setValue(key, String(next));
        return next;
    }

    let lastResponseVersion = readCounter(RESPONSE_VERSION_KEY);
    let lastCommandVersion = readCounter(COMMAND_VERSION_KEY);
    let lastCommandId: string | undefined;

    function publishStatus(status: PilotSwarmSessionStatus, extra: Record<string, unknown> = {}): void {
        const signal: Record<string, unknown> = {
            iteration,
            ...(lastResponseVersion > 0 ? { responseVersion: lastResponseVersion } : {}),
            ...(lastCommandVersion > 0 ? { commandVersion: lastCommandVersion } : {}),
            ...(lastCommandId ? { commandId: lastCommandId } : {}),
            ...(cronSchedule
                ? {
                    cronActive: true,
                    cronInterval: cronSchedule.intervalSeconds,
                    cronReason: cronSchedule.reason,
                }
                : { cronActive: false }),
            ...(contextUsage ? { contextUsage } : {}),
            ...extra,
        };
        setStatus(ctx, status, signal);
    }

    function* writeLatestResponse(
        payload: Omit<SessionResponsePayload, "schemaVersion" | "version" | "emittedAt">,
    ): Generator<any, SessionResponsePayload, any> {
        const version = bumpCounter(RESPONSE_VERSION_KEY);
        const emittedAt: number = yield ctx.utcNow();
        const responsePayload: SessionResponsePayload = {
            schemaVersion: 1,
            version,
            emittedAt,
            ...payload,
        };
        writeJsonValue(RESPONSE_LATEST_KEY, responsePayload);
        lastResponseVersion = version;
        return responsePayload;
    }

    function* writeCommandResponse(
        response: CommandResponse,
    ): Generator<any, SessionCommandResponse, any> {
        const version = bumpCounter(COMMAND_VERSION_KEY);
        const emittedAt: number = yield ctx.utcNow();
        const payload: SessionCommandResponse = {
            ...response,
            schemaVersion: 1,
            version,
            emittedAt,
        };
        writeJsonValue(commandResponseKey(response.id), payload);
        lastCommandVersion = version;
        lastCommandId = response.id;
        yield manager.recordSessionEvent(input.sessionId, [{
            eventType: "session.command_completed",
            data: { cmd: response.cmd, id: response.id },
        }]);
        return payload;
    }

    // ─── Helper: wrap prompt with resume context after dehydration ──
    function wrapWithResumeContext(userPrompt: string, extra?: string): string {
        const base = rehydrationMessage ??
            `The session was dehydrated and has been rehydrated on a new worker. ` +
            `The LLM conversation history is preserved.`;
        const parts = [userPrompt, ``, `[SYSTEM: ${base}`];
        if (extra) parts.push(extra);
        parts.push(`]`);
        return parts.join('\n');
    }

    function mergePrompt(existingPrompt?: string, nextPrompt?: string): string | undefined {
        if (!existingPrompt) return nextPrompt;
        if (!nextPrompt) return existingPrompt;
        return `${existingPrompt}\n\n${nextPrompt}`;
    }

    const INTERNAL_SYSTEM_TURN_PROMPT = "Continue with the latest system instructions.";

    function extractPromptSystemContext(rawPrompt?: string): { prompt?: string; systemPrompt?: string } {
        if (!rawPrompt) return {};

        const trimmed = rawPrompt.trim();
        if (trimmed.startsWith("[SYSTEM:") && trimmed.endsWith("]")) {
            return {
                systemPrompt: trimmed.slice("[SYSTEM:".length, -1).trim(),
            };
        }

        const marker = rawPrompt.lastIndexOf("\n\n[SYSTEM:");
        if (marker >= 0 && rawPrompt.trimEnd().endsWith("]")) {
            const prompt = rawPrompt.slice(0, marker).trim();
            const systemPrompt = rawPrompt.slice(marker + 2).trim();
            return {
                ...(prompt ? { prompt } : {}),
                systemPrompt: systemPrompt.slice("[SYSTEM:".length, -1).trim(),
            };
        }

        return { prompt: rawPrompt };
    }

    function appendSystemContext(rawPrompt: string | undefined, extraSystemPrompt?: string): string | undefined {
        if (!extraSystemPrompt) return rawPrompt;
        const extracted = extractPromptSystemContext(rawPrompt);
        const mergedSystemPrompt = mergePrompt(extracted.systemPrompt, extraSystemPrompt);
        if (!mergedSystemPrompt) return extracted.prompt ?? rawPrompt;
        if (extracted.prompt) {
            return `${extracted.prompt}\n\n[SYSTEM: ${mergedSystemPrompt}]`;
        }
        return `[SYSTEM: ${mergedSystemPrompt}]`;
    }

    function ensureTaskContext(sourcePrompt?: string): void {
        if (taskContext || !sourcePrompt) return;
        taskContext = sourcePrompt.slice(0, 2000);
        const base = typeof baseSystemMessage === "string"
            ? baseSystemMessage ?? ""
            : (baseSystemMessage as any)?.content ?? "";
        config.systemMessage = base + (base ? "\n\n" : "") +
            "[RECURRING TASK]\n" +
            "Original user request (always remember, even if conversation history is truncated):\n\"" +
            taskContext + "\"";
    }

    function applyCronAction(action: Extract<TurnAction, { type: "cron" }>, sourcePrompt?: string): void {
        if (action.action === "cancel") {
            ctx.traceInfo("[orch] cron cancelled");
            cronSchedule = undefined;
            return;
        }

        ensureTaskContext(sourcePrompt);
        cronSchedule = {
            intervalSeconds: action.intervalSeconds,
            reason: action.reason,
        };
        ctx.traceInfo(`[orch] cron scheduled: every ${action.intervalSeconds}s (${action.reason})`);
    }

    function drainLeadingQueuedCronActions(sourcePrompt?: string): void {
        while (pendingToolActions[0]?.type === "cron") {
            applyCronAction(pendingToolActions.shift() as Extract<TurnAction, { type: "cron" }>, sourcePrompt);
        }
    }

    // ─── Shared continueAsNew input builder ──────────────────
    function continueInput(overrides: Partial<OrchestrationInput> = {}): OrchestrationInput {
        const {
            prompt: overridePrompt,
            requiredTool: overrideRequiredTool,
            systemPrompt: overrideSystemPrompt,
            bootstrapPrompt: overrideBootstrapPrompt,
            ...restOverrides
        } = overrides;
        const carriedPrompt = overridePrompt ?? pendingPrompt;
        const carriedRequiredTool = overrideRequiredTool ?? pendingRequiredTool;
        const carriedSystemPrompt = overrideSystemPrompt ?? pendingSystemPrompt;
        const promptForInput = carriedPrompt ?? (carriedSystemPrompt ? INTERNAL_SYSTEM_TURN_PROMPT : undefined);
        const bootstrapForInput = overrideBootstrapPrompt
            ?? (carriedPrompt ? bootstrapPrompt : carriedSystemPrompt ? true : undefined);
        return {
            sessionId: input.sessionId,
            config,
            iteration,
            affinityKey,
            preserveAffinityOnHydrate,
            needsHydration,
            blobEnabled,
            dehydrateThreshold,
            idleTimeout,
            inputGracePeriod,
            checkpointInterval,
            rehydrationMessage,
            nextSummarizeAt,
            taskContext,
            baseSystemMessage,
            ...(cronSchedule ? { cronSchedule } : {}),
            ...(contextUsage ? { contextUsage } : {}),
            ...(carriedSystemPrompt ? { systemPrompt: carriedSystemPrompt } : {}),
            ...(promptForInput ? { prompt: promptForInput } : {}),
            ...(carriedRequiredTool ? { requiredTool: carriedRequiredTool } : {}),
            ...(promptForInput && bootstrapForInput !== undefined ? { bootstrapPrompt: bootstrapForInput } : {}),
            subAgents,
            ...(pendingToolActions.length > 0 ? { pendingToolActions } : {}),
            parentSessionId,
            nestingLevel,
            ...(isSystem ? { isSystem: true } : {}),
            retryCount: 0,
            ...(pendingInputQuestion ? { pendingInputQuestion } : {}),
            ...(waitingForAgentIds ? { waitingForAgentIds } : {}),
            ...(interruptedWaitTimer ? { interruptedWaitTimer } : {}),
            ...(pendingChildDigest ? { pendingChildDigest } : {}),
            ...restOverrides,
        };
    }

    function continueInputWithPrompt(nextPrompt?: string, overrides: Partial<OrchestrationInput> = {}): OrchestrationInput {
        const extracted = extractPromptSystemContext(nextPrompt);
        const mergedPrompt = mergePrompt(pendingPrompt, extracted.prompt);
        const mergedSystemPrompt = mergePrompt(pendingSystemPrompt, extracted.systemPrompt);
        return continueInput({
            ...(mergedPrompt ? { prompt: mergedPrompt } : {}),
            ...(mergedSystemPrompt ? { systemPrompt: mergedSystemPrompt } : {}),
            ...overrides,
        });
    }

    /** Queue a followup prompt for the LLM. In the flat loop, never CANs.
     *  Unlike CAN carry-forward, followups go directly into pendingPrompt
     *  as user-visible text. The [SYSTEM: ...] wrapper is stripped so
     *  processPrompt doesn't extract it into turnSystemPrompt (which would
     *  create a "Continue with system instructions" prompt that loops). */
    function queueFollowup(nextPrompt: string): void {
        // Strip [SYSTEM: ...] wrapper — tool results should be visible prompt text
        let text = nextPrompt;
        const trimmed = text.trim();
        if (trimmed.startsWith("[SYSTEM:") && trimmed.endsWith("]")) {
            text = trimmed.slice("[SYSTEM:".length, -1).trim();
        }
        pendingPrompt = mergePrompt(pendingPrompt, text);
    }

    function* ensureWarmResumeCheckpoint(): Generator<any, void, any> {
        if (!blobEnabled) return;
        try {
            ctx.traceInfo(`[orch] checkpoint before warm continueAsNew (iteration=${iteration})`);
            yield session.checkpoint();
        } catch (err: any) {
            ctx.traceInfo(`[orch] warm continueAsNew checkpoint failed: ${err.message ?? err}`);
        }
    }

    /** Yield this to continueAsNew into the current (latest) orchestration version. */
    function* versionedContinueAsNew(canInput: OrchestrationInput): Generator<any, void, any> {
        // Carry active timer state across CAN
        if (activeTimer) {
            const now: number = yield ctx.utcNow();
            const remainingMs = Math.max(0, activeTimer.deadlineMs - now);
            canInput.activeTimerState = {
                remainingMs,
                reason: activeTimer.reason,
                type: activeTimer.type,
                originalDurationMs: activeTimer.originalDurationMs,
                ...(activeTimer.shouldRehydrate ? { shouldRehydrate: true } : {}),
                ...(activeTimer.waitPlan ? { waitPlan: activeTimer.waitPlan } : {}),
                ...(activeTimer.content ? { content: activeTimer.content } : {}),
                ...(activeTimer.question ? { question: activeTimer.question } : {}),
                ...(activeTimer.choices ? { choices: activeTimer.choices } : {}),
                ...(activeTimer.allowFreeform !== undefined ? { allowFreeform: activeTimer.allowFreeform } : {}),
                ...(activeTimer.agentIds ? { agentIds: activeTimer.agentIds } : {}),
            };
        }
        if (!canInput.needsHydration) {
            yield* ensureWarmResumeCheckpoint();
        }
        yield ctx.continueAsNewVersioned(canInput, CURRENT_ORCHESTRATION_VERSION);
    }

    function parseChildUpdate(promptText?: string): { sessionId: string; updateType: string; content: string } | null {
        if (typeof promptText !== "string") return null;
        const match = promptText.match(/^\[CHILD_UPDATE from=(\S+) type=(\S+)/);
        if (!match) return null;
        return {
            sessionId: match[1],
            updateType: match[2].replace(/\]$/, ""),
            content: promptText.split("\n").slice(1).join("\n").trim(),
        };
    }

    function bufferChildUpdate(update: { sessionId: string; updateType: string; content: string }, observedAtMs: number): void {
        if (!pendingChildDigest) {
            pendingChildDigest = {
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
        const existingIndex = pendingChildDigest.updates.findIndex((entry) => entry.sessionId === update.sessionId);
        if (existingIndex >= 0) {
            pendingChildDigest.updates[existingIndex] = nextEntry;
        } else {
            pendingChildDigest.updates.push(nextEntry);
        }
    }

    function clearPendingChildDigest(): void {
        pendingChildDigest = null;
    }

    function buildPendingChildDigestSystemPrompt(): string | undefined {
        if (!pendingChildDigest || pendingChildDigest.updates.length === 0) return undefined;

        const lines = pendingChildDigest.updates.map((update) => {
            const agent = subAgents.find((entry) => entry.sessionId === update.sessionId);
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

    function flushPendingChildDigestIntoPrompt(rawPrompt: string | undefined): string | undefined {
        const childDigestPrompt = buildPendingChildDigestSystemPrompt();
        if (!childDigestPrompt) return rawPrompt;
        clearPendingChildDigest();
        return appendSystemContext(rawPrompt, childDigestPrompt);
    }

    function* processPendingChildDigest(): Generator<any, void, any> {
        const digestPrompt = buildPendingChildDigestSystemPrompt();
        if (!digestPrompt) {
            clearPendingChildDigest();
            return;
        }

        if (activeTimer?.type === "wait") {
            const now: number = yield ctx.utcNow();
            const remainingMs = Math.max(0, activeTimer.deadlineMs - now);
            const remainingSec = Math.round(remainingMs / 1000);
            const elapsedMs = activeTimer.originalDurationMs - remainingMs;
            const elapsedSec = Math.round(elapsedMs / 1000);
            const totalSec = Math.round(activeTimer.originalDurationMs / 1000);
            interruptedWaitTimer = {
                remainingSec,
                reason: activeTimer.reason,
                shouldRehydrate: activeTimer.shouldRehydrate ?? false,
                waitPlan: activeTimer.waitPlan,
            };
            activeTimer = null;
            clearPendingChildDigest();
            yield* processPrompt(
                `[SYSTEM: Buffered child updates interrupted your ${totalSec}s timer (reason: "${interruptedWaitTimer.reason}"). ` +
                    `${elapsedSec}s elapsed, ${remainingSec}s remain. ` +
                    `Review the updates and continue your task now. The remaining wait will be resumed automatically after this turn completes.\n\n${digestPrompt}]`,
                true,
            );
            return;
        }

        if (activeTimer?.type === "cron") {
            const activeCron = cronSchedule;
            activeTimer = null;
            clearPendingChildDigest();
            yield* processPrompt(
                `[SYSTEM: Buffered child updates arrived while your recurring schedule was waiting for the next wake-up${activeCron ? ` ("${activeCron.reason}")` : ""}. ` +
                    `Review the updates and continue your task now. The recurring cron schedule remains active and will be re-armed automatically after this turn completes.\n\n${digestPrompt}]`,
                true,
            );
            return;
        }

        if (activeTimer?.type === "idle") {
            activeTimer = null;
        } else if (activeTimer?.type === "agent-poll") {
            waitingForAgentIds = null;
            activeTimer = null;
        }

        clearPendingChildDigest();
        yield* processPrompt(`[SYSTEM: ${digestPrompt}]`, true);
    }

    function* applyChildUpdate(update: { sessionId: string; updateType: string; content: string }): Generator<any, void, any> {
        ctx.traceInfo(`[orch] child update from=${update.sessionId} type=${update.updateType}`);
        const agent = subAgents.find(a => a.sessionId === update.sessionId);
        if (!agent) return;

        if (update.content) {
            agent.result = update.content.slice(0, 2000);
        }

        if (update.updateType === "completed") {
            agent.status = "completed";
        }

        try {
            const rawStatus: string = yield manager.getSessionStatus(agent.sessionId);
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
            if (parsed.result && parsed.result !== "done") {
                agent.result = parsed.result.slice(0, 2000);
            }
        } catch {}
    }

    function* refreshTrackedSubAgents(): Generator<any, void, any> {
        try {
            const rawChildren: string = yield manager.listChildSessions(input.sessionId);
            const directChildren = JSON.parse(rawChildren) as Array<{
                orchId: string;
                sessionId: string;
                title?: string;
                status?: string;
                iterations?: number;
                parentSessionId?: string;
                isSystem?: boolean;
                agentId?: string;
                result?: string;
                error?: string;
            }>;

            const refreshed = directChildren
                .filter(child => !child.isSystem)
                .map((child) => {
                    const existing = subAgents.find(agent => agent.sessionId === child.sessionId || agent.orchId === child.orchId);
                    const rawStatus = child.status ?? existing?.status ?? "running";
                    const normalizedStatus =
                        rawStatus === "failed" ? "failed"
                            : rawStatus === "cancelled" ? "cancelled"
                                : rawStatus === "waiting" ? "waiting"
                                : rawStatus === "completed" ? "completed"
                                    : "running";
                    return {
                        orchId: child.orchId,
                        sessionId: child.sessionId,
                        task: existing?.task ?? child.title ?? "(spawned sub-agent)",
                        status: normalizedStatus,
                        result: child.result ?? existing?.result,
                        agentId: child.agentId ?? existing?.agentId,
                    } satisfies SubAgentEntry;
                });

            subAgents = refreshed;
        } catch (err: any) {
            ctx.traceInfo(`[orch] refreshTrackedSubAgents failed (non-fatal): ${err.message ?? err}`);
        }
    }

    function buildWaitForAgentsFollowup(targetIds: string[]): string {
        const summaries = targetIds
            .map((targetId) => subAgents.find((agent) => agent.orchId === targetId))
            .filter((agent): agent is SubAgentEntry => Boolean(agent))
            .map((agent) =>
                `  - Agent ${agent.orchId}\n` +
                `    Task: "${agent.task.slice(0, 120)}"\n` +
                `    Status: ${agent.status}\n` +
                `    Result: ${agent.result ?? "(no result)"}`,
            );

        if (summaries.length === 0) {
            return `[SYSTEM: No tracked sub-agents produced a completion summary.]`;
        }

        if (summaries.length === 1) {
            return `[SYSTEM: Sub-agent completed. If the user asked you to relay the child's final output, return the single sub-agent Result text verbatim.\n${summaries[0]}]`;
        }

        return `[SYSTEM: Sub-agents completed:\n${summaries.join("\n")}]`;
    }

    // ─── Helper: dehydrate and optionally release affinity ───
    function* dehydrateForNextTurn(reason: string, resetAffinity = true): Generator<any, void, any> {
        ctx.traceInfo(`[orch] dehydrating session (reason=${reason}, resetAffinity=${resetAffinity})`);
        yield session.dehydrate(reason);
        needsHydration = true;
        preserveAffinityOnHydrate = !resetAffinity;
        if (resetAffinity) {
            affinityKey = yield ctx.newGuid();
            session = createSessionProxy(ctx, input.sessionId, affinityKey, config);
        }
    }

    // ─── Helper: checkpoint without releasing pin ────────────
    function* maybeCheckpoint(): Generator<any, void, any> {
        if (!blobEnabled || checkpointInterval < 0) return;
        try {
            ctx.traceInfo(`[orch] checkpoint (iteration=${iteration})`);
            yield session.checkpoint();
        } catch (err: any) {
            ctx.traceInfo(`[orch] checkpoint failed: ${err.message ?? err}`);
        }
    }

    // ─── Helper: summarize session title if due ──────────────
    const FIRST_SUMMARIZE_DELAY = 60_000;
    const REPEAT_SUMMARIZE_DELAY = 300_000;
    function* maybeSummarize(): Generator<any, void, any> {
        if (isSystem) return;
        const now: number = yield ctx.utcNow();
        if (nextSummarizeAt === 0) {
            nextSummarizeAt = now + FIRST_SUMMARIZE_DELAY;
            return;
        }
        if (now < nextSummarizeAt) return;
        try {
            ctx.traceInfo(`[orch] summarizing session title`);
            yield manager.summarizeSession(input.sessionId);
        } catch (err: any) {
            ctx.traceInfo(`[orch] summarize failed: ${err.message}`);
        }
        nextSummarizeAt = now + REPEAT_SUMMARIZE_DELAY;
    }

    // ─── Prompt carried from continueAsNew ───────────────────
    let pendingPrompt: string | undefined = input.prompt;
    let pendingRequiredTool: string | undefined = input.requiredTool;
    let pendingSystemPrompt: string | undefined = input.systemPrompt;
    let bootstrapPrompt = input.bootstrapPrompt ?? false;

    // ─── Active timer state (flat event loop) ────────────────
    interface ActiveTimer {
        deadlineMs: number;
        originalDurationMs: number;
        reason: string;
        type: "wait" | "cron" | "idle" | "agent-poll" | "input-grace";
        shouldRehydrate?: boolean;
        waitPlan?: { shouldDehydrate: boolean; resetAffinityOnDehydrate: boolean; preserveAffinityOnHydrate: boolean };
        content?: string;
        question?: string;
        choices?: string[];
        allowFreeform?: boolean;
        agentIds?: string[];
    }

    let activeTimer: ActiveTimer | null = null;
    let waitingForAgentIds: string[] | null = input.waitingForAgentIds ?? null;
    let pendingInputQuestion: { question: string; choices?: string[]; allowFreeform?: boolean } | null =
        input.pendingInputQuestion ?? null;
    let orchestrationResult: string | null = null;

    /** Saved when a user message interrupts an active wait timer.
     *  After the LLM's response turn completes, the orchestration
     *  automatically re-arms the remaining wait — no LLM action needed. */
    let interruptedWaitTimer: {
        remainingSec: number;
        reason: string;
        shouldRehydrate: boolean;
        waitPlan?: ActiveTimer["waitPlan"];
    } | null = input.interruptedWaitTimer ?? null;
    let pendingChildDigest: NonNullable<OrchestrationInput["pendingChildDigest"]> | null =
        input.pendingChildDigest
            ? {
                startedAtMs: input.pendingChildDigest.startedAtMs,
                ...(input.pendingChildDigest.ready ? { ready: true } : {}),
                updates: [...(input.pendingChildDigest.updates || [])],
            }
            : null;

    // Reconstruct active timer from CAN input
    if (input.activeTimerState) {
        const initNow: number = yield ctx.utcNow();
        activeTimer = {
            deadlineMs: initNow + (input.activeTimerState.remainingMs ?? 0),
            originalDurationMs: input.activeTimerState.originalDurationMs ?? input.activeTimerState.remainingMs ?? 0,
            reason: input.activeTimerState.reason,
            type: input.activeTimerState.type,
            ...(input.activeTimerState.shouldRehydrate ? { shouldRehydrate: true } : {}),
            ...(input.activeTimerState.waitPlan ? { waitPlan: input.activeTimerState.waitPlan } : {}),
            ...(input.activeTimerState.content ? { content: input.activeTimerState.content } : {}),
            ...(input.activeTimerState.question ? { question: input.activeTimerState.question } : {}),
            ...(input.activeTimerState.choices ? { choices: input.activeTimerState.choices } : {}),
            ...(input.activeTimerState.allowFreeform !== undefined ? { allowFreeform: input.activeTimerState.allowFreeform } : {}),
            ...(input.activeTimerState.agentIds ? { agentIds: input.activeTimerState.agentIds } : {}),
        };
    }

    // Handle legacy pendingMessage from older versions
    if (input.pendingMessage) {
        const legacyMsg = input.pendingMessage as any;
        if (legacyMsg.prompt && !pendingPrompt) {
            pendingPrompt = legacyMsg.prompt;
            bootstrapPrompt = Boolean(legacyMsg.bootstrap);
            pendingRequiredTool = legacyMsg.requiredTool;
        }
    }

    // ─── KV FIFO Work Buffer ────────────────────────────────
    const FIFO_BUCKET_COUNT = 20;
    const MAX_BUCKET_BYTES = 14 * 1024;
    const MAX_DRAIN_PER_TURN = 50;
    const MAX_ITERATIONS_PER_EXECUTION = 100;
    const NON_BLOCKING_TIMER_MS = 10;

    function nextTimerCandidate(now: number): {
        kind: "active" | "child-digest";
        remainingMs: number;
        timer?: ActiveTimer;
    } | null {
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

    function fifoBucketKey(i: number): string { return `fifo.${i}`; }

    function readFifoBucket(i: number): any[] {
        const raw = ctx.getValue(fifoBucketKey(i));
        if (!raw) return [];
        try { return JSON.parse(raw); } catch { return []; }
    }

    function writeFifoBucket(i: number, items: any[]): void {
        if (items.length === 0) {
            ctx.clearValue(fifoBucketKey(i));
        } else {
            ctx.setValue(fifoBucketKey(i), JSON.stringify(items));
        }
    }

    function appendToFifo(newItems: any[]): void {
        let writeBucketIdx = 0;
        for (let i = FIFO_BUCKET_COUNT - 1; i >= 0; i--) {
            if (readFifoBucket(i).length > 0) { writeBucketIdx = i; break; }
        }
        for (const item of newItems) {
            const bucket = readFifoBucket(writeBucketIdx);
            bucket.push(item);
            const serialized = JSON.stringify(bucket);
            if (serialized.length > MAX_BUCKET_BYTES) {
                bucket.pop();
                writeFifoBucket(writeBucketIdx, bucket);
                writeBucketIdx++;
                if (writeBucketIdx >= FIFO_BUCKET_COUNT) {
                    ctx.traceInfo(`[fifo] overflow — ${newItems.length} item(s) may rely on carry-forward`);
                    return;
                }
                writeFifoBucket(writeBucketIdx, [item]);
            } else {
                writeFifoBucket(writeBucketIdx, bucket);
            }
        }
    }

    function popFifoItem(): any | null {
        for (let i = 0; i < FIFO_BUCKET_COUNT; i++) {
            const items = readFifoBucket(i);
            if (items.length > 0) {
                const [first, ...rest] = items;
                writeFifoBucket(i, rest);
                return first;
            }
        }
        return null;
    }

    function hasFifoItems(): boolean {
        for (let i = 0; i < FIFO_BUCKET_COUNT; i++) {
            if (readFifoBucket(i).length > 0) return true;
        }
        return false;
    }

    ctx.traceInfo(`[orch] start: iter=${iteration} pending=${pendingPrompt ? `"${pendingPrompt.slice(0, 40)}"` : 'NONE'} queued=${pendingToolActions.length} hydrate=${needsHydration} blob=${blobEnabled} timer=${activeTimer?.type ?? 'none'}`);

    // ─── Policy enforcement (orchestration-side) ─────────────
    if (iteration === 0 && !parentSessionId && !isSystem) {
        const workerPolicy: { policy: any; allowedAgentNames: string[] } = yield manager.getWorkerSessionPolicy();
        const policy = workerPolicy.policy;
        if (policy && policy.creation?.mode === "allowlist") {
            const agentId = input.agentId;
            const allowedNames = workerPolicy.allowedAgentNames;
            if (!agentId && !policy.creation.allowGeneric) {
                ctx.traceInfo(`[orch] policy rejection: generic session not allowed`);
                publishStatus("failed", { policyRejected: true });
                yield manager.updateCmsState(input.sessionId, "rejected");
                return "[POLICY] Session rejected: generic sessions are not allowed by session creation policy.";
            }
            if (agentId && allowedNames.length > 0 && !allowedNames.includes(agentId)) {
                ctx.traceInfo(`[orch] policy rejection: agent "${agentId}" not in allowed list`);
                publishStatus("failed", { policyRejected: true });
                yield manager.updateCmsState(input.sessionId, "rejected");
                return `[POLICY] Session rejected: agent "${agentId}" is not in the allowed agent list.`;
            }
        }
    }

    // ─── Resolve agent config for top-level named-agent sessions ───
    if (iteration === 0 && !parentSessionId && input.agentId && !isSystem) {
        const agentDef: any = yield manager.resolveAgentConfig(input.agentId);
        if (agentDef?.system && agentDef?.creatable === false) {
            const message =
                `Agent "${input.agentId}" is a worker-managed system agent and cannot be started manually. ` +
                `If it is missing, the workers likely need to be restarted.`;
            ctx.traceInfo(`[orch] top-level named session denied: ${message}`);
            publishStatus("failed", { workerManagedAgent: true });
            yield manager.updateCmsState(input.sessionId, "failed", message);
            return `[SYSTEM: ${message}]`;
        }
        if (agentDef) {
            const mergedToolNames = Array.from(new Set([
                ...(agentDef.tools ?? []),
                ...(config.toolNames ?? []),
            ]));
            if (mergedToolNames.length > 0) {
                config.toolNames = mergedToolNames;
                ctx.traceInfo(`[orch] merged top-level agent tools for ${input.agentId}: ${mergedToolNames.join(", ")}`);
            }
            session = createSessionProxy(ctx, input.sessionId, affinityKey, config);
        }
    }

    if (input.agentId) {
        config.agentIdentity = input.agentId;
    }

    // ═══════════════════════════════════════════════════════════
    // ═══ HANDLE COMMAND (extracted from main loop) ════════════
    // ═══════════════════════════════════════════════════════════

    function* handleCommand(cmdMsg: CommandMessage): Generator<any, void, any> {
        ctx.traceInfo(`[orch-cmd] ${cmdMsg.cmd} id=${cmdMsg.id}`);
        yield manager.recordSessionEvent(input.sessionId, [{
            eventType: "session.command_received",
            data: { cmd: cmdMsg.cmd, id: cmdMsg.id },
        }]);

        switch (cmdMsg.cmd) {
            case "set_model": {
                const newModel = String(cmdMsg.args?.model || "");
                const oldModel = config.model || "(default)";
                config = { ...config, model: newModel };
                const resp: CommandResponse = {
                    id: cmdMsg.id,
                    cmd: cmdMsg.cmd,
                    result: { ok: true, oldModel, newModel },
                };
                yield* writeCommandResponse(resp);
                publishStatus("idle");
                yield* versionedContinueAsNew(continueInput());
                return; // unreachable after CAN
            }
            case "list_models": {
                publishStatus("idle", { cmdProcessing: cmdMsg.id });
                let models: unknown;
                try {
                    const raw: any = yield manager.listModels();
                    models = typeof raw === "string" ? JSON.parse(raw) : raw;
                } catch (err: any) {
                    const resp: CommandResponse = {
                        id: cmdMsg.id,
                        cmd: cmdMsg.cmd,
                        error: err.message || String(err),
                    };
                    yield* writeCommandResponse(resp);
                    publishStatus("idle");
                    return;
                }
                const resp: CommandResponse = {
                    id: cmdMsg.id,
                    cmd: cmdMsg.cmd,
                    result: { models, currentModel: config.model },
                };
                yield* writeCommandResponse(resp);
                publishStatus("idle");
                return;
            }
            case "get_info": {
                const resp: CommandResponse = {
                    id: cmdMsg.id,
                    cmd: cmdMsg.cmd,
                    result: {
                        model: config.model || "(default)",
                        iteration,
                        sessionId: input.sessionId,
                        affinityKey: affinityKey,
                        affinityKeyShort: affinityKey?.slice(0, 8),
                        preserveAffinityOnHydrate,
                        needsHydration,
                        blobEnabled,
                        contextUsage,
                    },
                };
                yield* writeCommandResponse(resp);
                publishStatus("idle");
                return;
            }
            case "done": {
                ctx.traceInfo(`[orch] /done command received — completing session`);

                const liveChildren = subAgents.filter((agent) => !isSubAgentTerminalStatus(agent.status));
                if (liveChildren.length > 0) {
                    ctx.traceInfo(`[orch] /done: completing ${liveChildren.length} sub-agent(s)`);
                    for (const child of liveChildren) {
                        try {
                            const childCmdId = `done-cascade-${iteration}-${child.sessionId.slice(0, 8)}`;
                            yield manager.sendCommandToSession(child.sessionId,
                                { type: "cmd", cmd: "done", id: childCmdId, args: { reason: "Parent session completing" } });
                            child.status = "completed";
                            ctx.traceInfo(`[orch] /done: completed child ${child.sessionId}`);
                        } catch (err: any) {
                            ctx.traceInfo(`[orch] /done: failed to complete child ${child.sessionId}: ${err.message} (non-fatal)`);
                        }
                    }
                }

                if (parentSessionId) {
                    try {
                        const doneReason = String(cmdMsg.args?.reason || "Session completed by user");
                        yield manager.sendToSession(parentSessionId,
                            `[CHILD_UPDATE from=${input.sessionId} type=completed iter=${iteration}]\n${doneReason}`);
                    } catch (err: any) {
                        ctx.traceInfo(`[orch] sendToSession(parent) on /done failed: ${err.message} (non-fatal)`);
                    }
                }

                try {
                    yield session.destroy();
                } catch {}

                const resp: CommandResponse = {
                    id: cmdMsg.id,
                    cmd: cmdMsg.cmd,
                    result: { ok: true, message: "Session completed" },
                };
                yield* writeCommandResponse(resp);
                publishStatus("completed");
                orchestrationResult = "done";
                return;
            }
            default: {
                const resp: CommandResponse = {
                    id: cmdMsg.id,
                    cmd: cmdMsg.cmd,
                    error: `Unknown command: ${cmdMsg.cmd}`,
                };
                yield* writeCommandResponse(resp);
                publishStatus("idle");
                return;
            }
        }
    }

    // ═══════════════════════════════════════════════════════════
    // ═══ DRAIN — greedily move queue + timer into KV FIFO ════
    // ═══════════════════════════════════════════════════════════

    function needsBlockingDequeue(): boolean {
        return (
            !activeTimer &&
            pendingToolActions.length === 0 &&
            !pendingPrompt &&
            !hasFifoItems()
        );
    }

    function* drain(): Generator<any, void, any> {
        const stash: any[] = [];
        const seenChildUpdates = new Set<string>();

        for (let i = 0; i < MAX_DRAIN_PER_TURN; i++) {
            let msg: any = null;

            // ─── Mode 1: Active Timer / Child Digest — race dequeue vs timer ───
            if (activeTimer || (pendingChildDigest && !pendingChildDigest.ready)) {
                const now: number = yield ctx.utcNow();
                const candidate = nextTimerCandidate(now);
                if (!candidate) continue;

                if (candidate.remainingMs === 0) {
                    if (candidate.kind === "active" && candidate.timer) {
                        stash.push({ kind: "timer", timer: { ...candidate.timer }, firedAtMs: now });
                        activeTimer = null;
                    } else if (pendingChildDigest && pendingChildDigest.updates.length > 0) {
                        pendingChildDigest.ready = true;
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
                        activeTimer = null;
                    } else if (pendingChildDigest && pendingChildDigest.updates.length > 0) {
                        pendingChildDigest.ready = true;
                        break;
                    }
                    continue; // keep draining — pick up queued msgs in mode 3
                }

                msg = typeof race.value === "string" ? JSON.parse(race.value) : race.value;
                // activeTimer / pending child digest stay set — deadlines unchanged

            // ─── Mode 2: Blocking Dequeue — nothing to process ──
            } else if (needsBlockingDequeue()) {
                if (i > 0) break; // only block on first iteration
                publishStatus(pendingInputQuestion ? "input_required" : "idle");
                const rawMsg: any = yield ctx.dequeueEvent("messages");
                msg = typeof rawMsg === "string" ? JSON.parse(rawMsg) : rawMsg;

            // ─── Mode 3: Non-blocking Dequeue — opportunistic ───
            } else {
                const msgTask = ctx.dequeueEvent("messages");
                const timerTask = ctx.scheduleTimer(NON_BLOCKING_TIMER_MS);
                const race: any = yield ctx.race(msgTask, timerTask);
                if (race.index === 1) break; // queue empty
                msg = typeof race.value === "string" ? JSON.parse(race.value) : race.value;
            }

            if (!msg) continue;

            // ─── Route: Commands → handle immediately ───────────
            if (msg.type === "cmd") {
                // Flush anything already stashed before handling the command
                if (stash.length > 0) { appendToFifo(stash); stash.length = 0; }
                yield* handleCommand(msg as CommandMessage);
                if (orchestrationResult !== null) return;
                continue;
            }

            // ─── Route: Child updates → apply immediately ───────
            const childUpdate = parseChildUpdate(msg.prompt);
            if (childUpdate) {
                const key = `${childUpdate.sessionId}|${childUpdate.updateType}|${childUpdate.content ?? ""}`;
                if (!seenChildUpdates.has(key)) {
                    seenChildUpdates.add(key);
                    yield* applyChildUpdate(childUpdate);
                    const childObservedAt: number = yield ctx.utcNow();
                    bufferChildUpdate(childUpdate, childObservedAt);

                    // Check if all waited-for agents are now done
                    if (waitingForAgentIds) {
                        const allDone = waitingForAgentIds.every(id => {
                            const agent = subAgents.find(a => a.orchId === id);
                            return agent && isSubAgentTerminalStatus(agent.status);
                        });
                        if (allDone) {
                            // Merge directly into pendingPrompt (not FIFO) so it
                            // combines with accumulated tool action confirmations
                            // and produces a single LLM turn, matching v1.0.31 behavior.
                            queueFollowup(buildWaitForAgentsFollowup(waitingForAgentIds));
                            waitingForAgentIds = null;
                            clearPendingChildDigest();
                            activeTimer = null;
                        }
                    }
                }
                continue;
            }

            // ─── Route: Answers → stash ─────────────────────────
            if (msg.answer !== undefined) {
                stash.push({ kind: "answer", answer: msg.answer, wasFreeform: msg.wasFreeform });
                continue;
            }

            // ─── Route: User prompts → stash ────────────────────
            if (msg.prompt) {
                let userPrompt = msg.prompt;

                // If a wait/cron timer is active, cancel it and augment the prompt
                // with timer-interrupt context (matches v1.0.31 wait-loop behavior).
                if (activeTimer?.type === "wait") {
                    const now: number = yield ctx.utcNow();
                    const remainingMs = Math.max(0, activeTimer.deadlineMs - now);
                    const remainingSec = Math.round(remainingMs / 1000);
                    const elapsedMs = activeTimer.originalDurationMs - remainingMs;
                    const elapsedSec = Math.round(elapsedMs / 1000);
                    const totalSec = Math.round(activeTimer.originalDurationMs / 1000);
                    ctx.traceInfo(`[drain] user prompt interrupted wait timer, ${remainingSec}s remain — orchestration will auto-resume`);

                    // Save the interrupted timer. The orchestration will automatically
                    // re-arm it after the LLM's response turn completes. This avoids
                    // conflicting "call wait(N) to resume" instructions that clash
                    // with agent-specific prompts.
                    interruptedWaitTimer = {
                        remainingSec,
                        reason: activeTimer.reason,
                        shouldRehydrate: activeTimer.shouldRehydrate ?? false,
                        waitPlan: activeTimer.waitPlan,
                    };

                    // Just tell the LLM about the context, not what to do next
                    if (activeTimer.shouldRehydrate && userPrompt) {
                        userPrompt = wrapWithResumeContext(
                            userPrompt,
                            `Your ${totalSec}s timer (reason: "${activeTimer.reason}") was interrupted by the above message. ` +
                            `${elapsedSec}s elapsed, ${remainingSec}s remain. ` +
                            `Reply to the message. The timer will be automatically resumed after your reply.`,
                        );
                    } else if (userPrompt) {
                        userPrompt = `${userPrompt}\n\n` +
                            `[SYSTEM: The above is a message that interrupted your ${totalSec}s timer (reason: "${activeTimer.reason}"). ` +
                            `${elapsedSec}s elapsed, ${remainingSec}s remain. ` +
                            `Reply to the message. The timer will be automatically resumed after your reply.]`;
                    }
                    activeTimer = null;
                } else if (activeTimer?.type === "cron") {
                    const activeCron = cronSchedule;
                    const cronResumeNote =
                        `There is an active recurring schedule every ${activeCron?.intervalSeconds ?? "?"} seconds for "${activeCron?.reason ?? activeTimer.reason}". ` +
                        `It remains active automatically after this turn completes, so do NOT call wait() just to keep the recurring loop alive. ` +
                        `Call cron(action="cancel") only if you need to stop it.`;
                    if (activeTimer.shouldRehydrate && userPrompt) {
                        userPrompt = wrapWithResumeContext(userPrompt, cronResumeNote);
                    } else if (userPrompt) {
                        userPrompt = `${userPrompt}\n\n[SYSTEM: ${cronResumeNote}]`;
                    }
                    ctx.traceInfo(`[drain] user prompt interrupted cron timer`);
                    activeTimer = null;
                } else if (activeTimer?.type === "idle") {
                    ctx.traceInfo(`[drain] user prompt within idle window, cancelling idle timer`);
                    activeTimer = null;
                } else if (activeTimer?.type === "agent-poll") {
                    ctx.traceInfo(`[drain] user prompt interrupted agent wait`);
                    waitingForAgentIds = null;
                    activeTimer = null;
                }

                if (pendingChildDigest?.updates.length) {
                    userPrompt = flushPendingChildDigestIntoPrompt(userPrompt);
                }

                stash.push({
                    kind: "prompt",
                    prompt: userPrompt,
                    bootstrap: Boolean(msg.bootstrap),
                    ...(msg.requiredTool ? { requiredTool: msg.requiredTool } : {}),
                });
                continue;
            }

            ctx.traceInfo(`[drain] skipping unknown: ${JSON.stringify(msg).slice(0, 120)}`);
        }

        if (stash.length > 0) appendToFifo(stash);
    }

    // ═══════════════════════════════════════════════════════════
    // ═══ PROCESS PROMPT — hydrate + runTurn + handleResult ═══
    // ═══════════════════════════════════════════════════════════

    function* processPrompt(promptText: string, isBootstrap: boolean, requiredTool?: string): Generator<any, void, any> {
        let prompt = promptText;
        let promptIsBootstrap = isBootstrap;

        if (blobEnabled && !needsHydration) {
            try {
                needsHydration = yield session.needsHydration();
            } catch (err: any) {
                ctx.traceInfo(`[orch] needsHydration probe failed: ${err.message ?? err}`);
            }
        }

        if (needsHydration && blobEnabled && prompt) {
            prompt = wrapWithResumeContext(prompt);
        }

        let turnSystemPrompt = pendingSystemPrompt;
        pendingSystemPrompt = undefined;
        const extractedPrompt = extractPromptSystemContext(prompt);
        prompt = extractedPrompt.prompt ?? "";
        turnSystemPrompt = mergePrompt(turnSystemPrompt, extractedPrompt.systemPrompt);
        const systemOnlyTurn = !prompt && !!turnSystemPrompt;
        if (systemOnlyTurn) {
            prompt = "Continue with the latest system instructions.";
            promptIsBootstrap = true;
        }
        config.turnSystemPrompt = turnSystemPrompt;

        ctx.traceInfo(`[turn ${iteration}] session=${input.sessionId} prompt="${prompt.slice(0, 80)}"`);

        // Hydrate if needed (with retry)
        if (needsHydration && blobEnabled) {
            let hydrateAttempts = 0;
            while (true) {
                try {
                    if (!preserveAffinityOnHydrate) {
                        affinityKey = yield ctx.newGuid();
                    }
                    session = createSessionProxy(ctx, input.sessionId, affinityKey, config);
                    yield session.hydrate();
                    needsHydration = false;
                    preserveAffinityOnHydrate = false;
                    break;
                } catch (hydrateErr: any) {
                    const hMsg = hydrateErr.message || String(hydrateErr);
                    if (hMsg.includes("blob does not exist") || hMsg.includes("BlobNotFound") || hMsg.includes("404")) {
                        ctx.traceInfo(`[orch] hydrate skipped — blob not found, starting fresh session`);
                        needsHydration = false;
                        preserveAffinityOnHydrate = false;
                        break;
                    }
                    hydrateAttempts++;
                    ctx.traceInfo(`[orch] hydrate FAILED (attempt ${hydrateAttempts}/${MAX_RETRIES}): ${hMsg}`);
                    if (hydrateAttempts >= MAX_RETRIES) {
                        publishStatus("error", {
                            error: `Hydrate failed after ${MAX_RETRIES} attempts: ${hMsg}`,
                            retriesExhausted: true,
                        });
                        break;
                    }
                    const hydrateDelay = 10 * Math.pow(2, hydrateAttempts - 1);
                    publishStatus("error", {
                        error: `Hydrate failed: ${hMsg} (retry ${hydrateAttempts}/${MAX_RETRIES} in ${hydrateDelay}s)`,
                    });
                    yield ctx.scheduleTimer(hydrateDelay * 1000);
                }
            }
            if (needsHydration) return;
        }

        // Load knowledge index
        if (config.agentIdentity !== "facts-manager") {
            try {
                yield manager.loadKnowledgeIndex();
            } catch (knErr: any) {
                ctx.traceInfo(`[orch] loadKnowledgeIndex failed (non-fatal): ${knErr.message || knErr}`);
            }
        }

        // Run turn
        publishStatus("running", { iteration: iteration + 1 });
        let turnResult: any;
        try {
            turnResult = yield session.runTurn(prompt, promptIsBootstrap, iteration, {
                ...(parentSessionId ? { parentSessionId } : {}),
                nestingLevel,
                ...(requiredTool ? { requiredTool } : {}),
                retryCount,
            });
        } catch (err: any) {
            config.turnSystemPrompt = undefined;
            const errorMsg = err.message || String(err);
            const missingStateIndex = errorMsg.indexOf(SESSION_STATE_MISSING_PREFIX);
            if (missingStateIndex >= 0) {
                const fatalError = errorMsg.slice(missingStateIndex + SESSION_STATE_MISSING_PREFIX.length).trim();
                ctx.traceInfo(`[orch] fatal missing session state: ${fatalError}`);
                publishStatus("failed", { error: fatalError, fatal: true });
                yield manager.updateCmsState(input.sessionId, "failed", fatalError);
                throw new Error(fatalError);
            }
            retryCount++;
            ctx.traceInfo(`[orch] runTurn FAILED (attempt ${retryCount}/${MAX_RETRIES}): ${errorMsg}`);

            if (retryCount >= MAX_RETRIES) {
                ctx.traceInfo(`[orch] max retries exhausted, waiting for user input`);
                publishStatus("error", {
                    error: `Failed after ${MAX_RETRIES} attempts: ${errorMsg}`,
                    retriesExhausted: true,
                });
                retryCount = 0;
                return;
            }

            publishStatus("error", {
                error: `${errorMsg} (retry ${retryCount}/${MAX_RETRIES} in 15s)`,
            });
            const retryDelay = 15 * Math.pow(2, retryCount - 1);
            ctx.traceInfo(`[orch] retrying in ${retryDelay}s`);

            if (blobEnabled) {
                yield* dehydrateForNextTurn("error");
            }
            yield ctx.scheduleTimer(retryDelay * 1000);
            yield* versionedContinueAsNew(continueInput({
                ...(systemOnlyTurn ? {} : { prompt }),
                ...(requiredTool ? { requiredTool } : {}),
                ...(turnSystemPrompt ? { systemPrompt: turnSystemPrompt } : {}),
                retryCount,
                needsHydration: blobEnabled ? true : needsHydration,
            }));
            return;
        }
        config.turnSystemPrompt = undefined;
        retryCount = 0;

        const result: TurnResult = typeof turnResult === "string" ? JSON.parse(turnResult) : turnResult;
        const observedAt: number = yield ctx.utcNow();
        contextUsage = updateContextUsageFromEvents(contextUsage, (result as any)?.events, observedAt);

        iteration++;
        yield* maybeSummarize();
        yield* refreshTrackedSubAgents();

        if ("queuedActions" in result && Array.isArray(result.queuedActions) && result.queuedActions.length > 0) {
            pendingToolActions.push(...result.queuedActions);
            ctx.traceInfo(`[orch] queued ${result.queuedActions.length} extra action(s) from turn`);
        }
        drainLeadingQueuedCronActions(prompt);

        yield* handleTurnResult(result, prompt);
    }

    // ═══════════════════════════════════════════════════════════
    // ═══ HANDLE TURN RESULT — sets timer instead of loops ════
    // ═══════════════════════════════════════════════════════════

    function* handleTurnResult(result: TurnResult, sourcePrompt: string): Generator<any, void, any> {
        if (
            result.type === "completed"
            && parentSessionId
            && typeof result.content === "string"
            && /^QUESTION FOR PARENT:/i.test(result.content.trim())
        ) {
            ctx.traceInfo("[orch] coercing child QUESTION FOR PARENT result into durable wait");
            result = {
                type: "wait",
                seconds: 60,
                reason: "waiting for parent answer",
                content: result.content.trim(),
                model: (result as any).model,
            } as TurnResult;
        }

        switch (result.type) {
            case "completed": {
                ctx.traceInfo(`[response] ${result.content}`);
                yield* writeLatestResponse({
                    iteration,
                    type: "completed",
                    content: result.content,
                    model: (result as any).model,
                });

                // Notify parent if sub-agent
                if (parentSessionId) {
                    try {
                        yield manager.sendToSession(parentSessionId,
                            `[CHILD_UPDATE from=${input.sessionId} type=completed iter=${iteration}]\n${result.content.slice(0, 2000)}`);
                    } catch (err: any) {
                        ctx.traceInfo(`[orch] sendToSession(parent) failed: ${err.message} (non-fatal)`);
                    }

                    if (!cronSchedule) {
                        if (input.isSystem) {
                            ctx.traceInfo(`[orch] system sub-agent completed turn, continuing loop`);
                            yield* maybeCheckpoint();
                            return;
                        }
                        ctx.traceInfo(`[orch] sub-agent completed task, auto-terminating`);
                        try { yield session.destroy(); } catch {}
                        publishStatus("completed");
                        orchestrationResult = "done";
                        return;
                    }
                }

                // Forgotten-timer safety net
                {
                    const runningAgents = subAgents.filter(a => a.status === "running");
                    if (runningAgents.length > 0 && !input.forgottenTimerNudged && !cronSchedule) {
                        const names = runningAgents.map(a => a.task?.slice(0, 40) || a.orchId).join(", ");
                        ctx.traceInfo(`[orch] forgotten-timer safety: ${runningAgents.length} agents still running, nudging LLM`);
                        yield* versionedContinueAsNew(continueInputWithPrompt(
                            `[SYSTEM: You ended your turn without calling wait(), but you have ${runningAgents.length} sub-agent(s) still running: ${names}. ` +
                            `Without a wait() call, your monitoring/polling loop is DEAD — the orchestration will NOT wake you up automatically. ` +
                            `You MUST call wait() now to schedule your next check-in. Call wait() with an appropriate interval to continue your loop.]`,
                            { forgottenTimerNudged: true },
                        ));
                        return;
                    }
                }

                // Auto-resume interrupted wait timer. If the LLM's turn completed
                // without re-issuing wait() itself, the orchestration re-arms the
                // remaining time automatically. This avoids conflicting "call wait(N)"
                // instructions that clash with agent-specific prompts.
                if (interruptedWaitTimer && interruptedWaitTimer.remainingSec > 0) {
                    const saved = interruptedWaitTimer;
                    interruptedWaitTimer = null;
                    ctx.traceInfo(`[orch] auto-resuming interrupted wait: ${saved.remainingSec}s (${saved.reason})`);

                    if (saved.shouldRehydrate) {
                        yield* dehydrateForNextTurn("timer", saved.waitPlan?.resetAffinityOnDehydrate ?? true);
                    }

                    const resumeNow: number = yield ctx.utcNow();
                    publishStatus("waiting", {
                        waitSeconds: saved.remainingSec,
                        waitReason: saved.reason,
                        waitStartedAt: resumeNow,
                    });

                    if (!saved.shouldRehydrate) yield* maybeCheckpoint();

                    activeTimer = {
                        deadlineMs: resumeNow + saved.remainingSec * 1000,
                        originalDurationMs: saved.remainingSec * 1000,
                        reason: saved.reason,
                        type: "wait",
                        shouldRehydrate: saved.shouldRehydrate,
                        waitPlan: saved.waitPlan,
                    };
                    return;
                }

                if (cronSchedule) {
                    const activeCron = { ...cronSchedule };
                    const shouldDehydrate = blobEnabled;
                    if (shouldDehydrate) {
                        yield* dehydrateForNextTurn("cron", true);
                    }
                    yield manager.recordSessionEvent(input.sessionId, [{
                        eventType: "session.cron_started",
                        data: { intervalSeconds: activeCron.intervalSeconds, reason: activeCron.reason },
                    }]);
                    const cronStartedAt: number = yield ctx.utcNow();
                    ctx.traceInfo(`[orch] cron timer: ${activeCron.intervalSeconds}s (${activeCron.reason})`);
                    publishStatus("waiting", {
                        waitSeconds: activeCron.intervalSeconds,
                        waitReason: activeCron.reason,
                        waitStartedAt: cronStartedAt,
                    });
                    if (!shouldDehydrate) yield* maybeCheckpoint();

                    activeTimer = {
                        deadlineMs: cronStartedAt + activeCron.intervalSeconds * 1000,
                        originalDurationMs: activeCron.intervalSeconds * 1000,
                        reason: activeCron.reason,
                        type: "cron",
                        shouldRehydrate: shouldDehydrate,
                    };
                    return;
                }

                if (!blobEnabled || idleTimeout < 0) {
                    yield* maybeCheckpoint();
                    return; // no timer — main loop will CAN
                }

                // Set idle timer
                publishStatus("idle");
                yield* maybeCheckpoint();
                const idleNow: number = yield ctx.utcNow();
                activeTimer = {
                    deadlineMs: idleNow + idleTimeout * 1000,
                    originalDurationMs: idleTimeout * 1000,
                    reason: "idle timeout",
                    type: "idle",
                };
                return;
            }

            case "cron":
                applyCronAction(result, sourcePrompt);
                return;

            case "wait": {
                // LLM re-issued wait itself — clear any saved interrupted timer
                interruptedWaitTimer = null;
                ensureTaskContext(sourcePrompt);

                if (parentSessionId) {
                    try {
                        const notifyContent = result.content
                            ? result.content.slice(0, 2000)
                            : `[wait: ${result.reason} (${result.seconds}s)]`;
                        yield manager.sendToSession(parentSessionId,
                            `[CHILD_UPDATE from=${input.sessionId} type=wait iter=${iteration}]\n${notifyContent}`);
                    } catch (err: any) {
                        ctx.traceInfo(`[orch] sendToSession(parent) wait failed: ${err.message} (non-fatal)`);
                    }
                }

                ctx.traceInfo(`[orch] durable timer: ${result.seconds}s (${result.reason})`);

                const waitPlan = planWaitHandling({
                    blobEnabled,
                    seconds: result.seconds,
                    dehydrateThreshold,
                    preserveWorkerAffinity: result.preserveWorkerAffinity,
                });
                if (waitPlan.shouldDehydrate) {
                    yield* dehydrateForNextTurn("timer", waitPlan.resetAffinityOnDehydrate);
                }

                const waitStartedAt: number = yield ctx.utcNow();
                if (result.content) {
                    yield* writeLatestResponse({
                        iteration,
                        type: "wait",
                        content: result.content,
                        waitReason: result.reason,
                        waitSeconds: result.seconds,
                        waitStartedAt,
                        model: (result as any).model,
                    });
                    ctx.traceInfo(`[orch] intermediate: ${result.content.slice(0, 80)}`);
                }

                publishStatus("waiting", {
                    waitSeconds: result.seconds,
                    waitReason: result.reason,
                    waitStartedAt,
                    preserveWorkerAffinity: waitPlan.preserveAffinityOnHydrate,
                });

                if (!waitPlan.shouldDehydrate) yield* maybeCheckpoint();

                yield manager.recordSessionEvent(input.sessionId, [{
                    eventType: "session.wait_started",
                    data: { seconds: result.seconds, reason: result.reason, preserveAffinity: waitPlan.preserveAffinityOnHydrate },
                }]);

                activeTimer = {
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
                yield* writeLatestResponse({
                    iteration,
                    type: "input_required",
                    question: result.question,
                    choices: result.choices,
                    allowFreeform: result.allowFreeform,
                    model: (result as any).model,
                });

                pendingInputQuestion = {
                    question: result.question,
                    choices: result.choices,
                    allowFreeform: result.allowFreeform,
                };
                publishStatus("input_required");

                if (!blobEnabled || inputGracePeriod < 0) {
                    yield* maybeCheckpoint();
                    // No timer — drain will block on dequeue (mode 2) for the answer
                    return;
                }

                if (inputGracePeriod === 0) {
                    yield* dehydrateForNextTurn("input_required");
                    // No timer — drain will block on dequeue for the answer
                    return;
                }

                // Set grace period timer
                const graceNow: number = yield ctx.utcNow();
                activeTimer = {
                    deadlineMs: graceNow + inputGracePeriod * 1000,
                    originalDurationMs: inputGracePeriod * 1000,
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

            // ─── Sub-Agent Result Handlers ───────────────────

            case "spawn_agent": {
                const childNestingLevel = nestingLevel + 1;
                if (childNestingLevel > MAX_NESTING_LEVEL) {
                    ctx.traceInfo(`[orch] spawn_agent denied: nesting level ${nestingLevel} is at max (${MAX_NESTING_LEVEL})`);
                    queueFollowup(
                        `[SYSTEM: spawn_agent failed — you are already at nesting level ${nestingLevel} (max ${MAX_NESTING_LEVEL}). ` +
                        `Sub-agents at this depth cannot spawn further sub-agents. Handle the task directly instead.]`);
                    return;
                }

                const activeCount = subAgents.filter(a => a.status === "running").length;
                if (activeCount >= MAX_SUB_AGENTS) {
                    ctx.traceInfo(`[orch] spawn_agent denied: ${activeCount}/${MAX_SUB_AGENTS} agents running`);
                    queueFollowup(
                        `[SYSTEM: spawn_agent failed — you already have ${activeCount} running sub-agents (max ${MAX_SUB_AGENTS}). ` +
                        `Wait for some to complete before spawning more.]`);
                    return;
                }

                let agentTask = result.task;
                let agentSystemMessage = result.systemMessage;
                let agentToolNames = result.toolNames;
                let agentModel = result.model;
                let agentIsSystem = false;
                let agentTitle: string | undefined;
                let agentId: string | undefined;
                let agentSplash: string | undefined;
                let boundAgentName: string | undefined;
                let promptLayeringKind: "app-agent" | "app-system-agent" | "pilotswarm-system-agent" | undefined;
                let resolvedAgentName = result.agentName;

                const applyAgentDef = (agentDef: any, useDefinitionDefaults = false) => {
                    agentTask = useDefinitionDefaults
                        ? (agentDef.initialPrompt || `You are the ${agentDef.name} agent. Begin your work.`)
                        : (result.task || agentDef.initialPrompt || `You are the ${agentDef.name} agent. Begin your work.`);
                    agentSystemMessage = useDefinitionDefaults ? undefined : result.systemMessage;
                    agentToolNames = useDefinitionDefaults
                        ? (agentDef.tools ?? undefined)
                        : (result.toolNames ?? agentDef.tools ?? undefined);
                    agentIsSystem = agentDef.system ?? false;
                    agentTitle = agentDef.title;
                    agentId = agentDef.id ?? resolvedAgentName;
                    agentSplash = agentDef.splash;
                    boundAgentName = agentDef.name;
                    promptLayeringKind = agentDef.promptLayerKind
                        ?? (agentDef.system
                            ? ((agentDef.namespace || "pilotswarm") === "pilotswarm"
                                ? "pilotswarm-system-agent"
                                : "app-system-agent")
                            : "app-agent");
                };

                if (resolvedAgentName) {
                    ctx.traceInfo(`[orch] resolving agent config for: ${resolvedAgentName}`);
                    const agentDef = yield manager.resolveAgentConfig(resolvedAgentName);
                    if (!agentDef) {
                        queueFollowup(`[SYSTEM: spawn_agent failed — agent "${resolvedAgentName}" not found. Use list_agents to see available agents.]`);
                        return;
                    }
                    if (agentDef.system && agentDef.creatable === false) {
                        queueFollowup(
                            `[SYSTEM: spawn_agent failed — agent "${resolvedAgentName}" is a worker-managed system agent and cannot be spawned from a session. ` +
                            `If it is missing, the workers likely need to be restarted.]`,
                        );
                        return;
                    }
                    applyAgentDef(agentDef, resolvedAgentName !== result.agentName);
                }

                if (agentModel && !agentModel.includes(":")) {
                    ctx.traceInfo(`[orch] spawn_agent denied: unqualified model override "${agentModel}"`);
                    queueFollowup(
                        `[SYSTEM: spawn_agent failed — model "${agentModel}" is not allowed. ` +
                        `When overriding a sub-agent model, first call list_available_models and then use the exact provider:model value from that list. ` +
                        `If you are unsure, omit model so the sub-agent inherits your current model.]`);
                    return;
                }

                // Dedup guard: prevent re-spawning a named agent that already exists
                // as a child of this session. This catches post-rehydration re-spawns
                // when the LLM loses context that children are already running.
                if (agentId) {
                    const existingChild = subAgents.find(a => a.agentId === agentId && a.status === "running");
                    if (existingChild) {
                        ctx.traceInfo(`[orch] spawn_agent deduplicated: agent "${agentId}" already running as ${existingChild.orchId}`);
                        queueFollowup(
                            `[SYSTEM: Agent "${resolvedAgentName || agentId}" is already running as sub-agent ${existingChild.orchId.slice(0, 16)}. ` +
                            `Use check_agents to see its status, or message_agent to communicate with it.]`);
                        return;
                    }
                }

                if (!agentTitle && agentIsSystem) {
                    const text = agentTask || "";
                    const titleMatch = text.match(/You are the \*{0,2}([^*\n]+?)\*{0,2}\s*[—–-]/i)
                        || text.match(/You are the \*{0,2}([^*\n]+?Agent)\*{0,2}/i);
                    if (titleMatch) {
                        agentTitle = titleMatch[1].trim();
                    }
                }

                ctx.traceInfo(`[orch] spawning sub-agent via SDK: task="${agentTask.slice(0, 80)}" model=${agentModel || "inherit"} agent=${resolvedAgentName || "custom"} nestingLevel=${childNestingLevel}`);

                const {
                    boundAgentName: _parentBoundAgentName,
                    promptLayering: _parentPromptLayering,
                    ...parentConfig
                } = config;
                const childConfig: SerializableSessionConfig = {
                    ...parentConfig,
                    ...(agentModel ? { model: agentModel } : {}),
                    ...(agentSystemMessage ? { systemMessage: agentSystemMessage } : {}),
                    ...(boundAgentName ? { boundAgentName } : {}),
                    ...(promptLayeringKind ? { promptLayering: { kind: promptLayeringKind } } : {}),
                    ...(agentToolNames ? { toolNames: agentToolNames } : {}),
                };

                const parentSystemMsg = typeof childConfig.systemMessage === "string"
                    ? childConfig.systemMessage
                    : (childConfig.systemMessage as any)?.content ?? "";
                const canSpawnMore = childNestingLevel < MAX_NESTING_LEVEL;
                const timingInstruction = agentIsSystem
                    ? `- For recurring or periodic work, use the \`cron\` tool instead of ending every cycle with \`wait\`. ` +
                      `Call \`cron(seconds=<N>, reason="...")\` to start or update the durable recurring schedule, ` +
                      `then finish turns normally so the orchestration wakes you automatically on each cron cycle. ` +
                      `Use \`wait\` only for one-shot delays inside a turn. ` +
                      `Call \`cron(action="cancel")\` only when you intentionally want to stop the recurring loop.\n`
                    : `- For ANY waiting, sleeping, delaying, or scheduling, you MUST use the \`wait\`, \`wait_on_worker\`, or \`cron\` tools. ` +
                      `Use \`wait\` or \`wait_on_worker\` for one-shot delays. Use \`cron\` for recurring or periodic monitoring. ` +
                      `Do NOT burn tokens polling inside one LLM turn; after a brief immediate re-check at most, yield with a durable timer. ` +
                      `NEVER use setTimeout, sleep, setInterval, or any other timing mechanism. ` +
                      `Durable waits survive process restarts.\n`;
                const subAgentPreamble =
                    `[SUB-AGENT CONTEXT]\n` +
                    `You are a sub-agent spawned by a parent session (ID: session-${input.sessionId}).\n` +
                    `Your nesting level: ${childNestingLevel} (max: ${MAX_NESTING_LEVEL}).\n` +
                    `Your task: "${agentTask.slice(0, 500)}"\n\n` +
                    `Instructions:\n` +
                    `- Focus exclusively on your assigned task.\n` +
                    `- Your final response will be automatically forwarded to the parent agent.\n` +
                    `- Be thorough but concise — the parent will synthesize results from multiple agents.\n` +
                    `- Do NOT ask the user for input — you are autonomous.\n` +
                    `- You are autonomous and goal-driven. If the task implies ongoing monitoring or follow-through until done, keep yourself alive with durable timers until the goal is complete or you can no longer make progress.\n` +
                    `- If it is ambiguous whether the task should become a long-running recurring workflow, report that ambiguity back to the parent instead of guessing or asking the user directly.\n` +
                    `- When your task is complete, provide a clear summary of your findings/results.\n` +
                    `- If you write any files with write_artifact, you MUST also call export_artifact and include the artifact:// link in your response.\n` +
                    `- If you override a sub-agent model, you MUST first call list_available_models in this session and use only an exact provider:model value returned there. ` +
                    `NEVER invent, guess, shorten, or reuse a stale model name.\n` +
                    `- Worker-managed system agents are not valid spawn targets. If you expect one and it is missing, report that the workers likely need to be restarted.\n` +
                    timingInstruction +
                    (canSpawnMore
                        ? `- If your parent task explicitly asks you to spawn sub-agents, delegate, fan out, or parallelize work, you SHOULD do so within runtime limits instead of collapsing the task into a direct answer. ` +
                          `If delegation was not explicitly requested, use your judgment and avoid unnecessary fan-out. ` +
                          `You have ${MAX_NESTING_LEVEL - childNestingLevel} level(s) of nesting remaining. After spawning, call wait_for_agents to block until they finish.\n`
                        : `- You CANNOT spawn sub-agents — you are at the maximum nesting depth. Handle everything directly.\n`);
                childConfig.systemMessage = subAgentPreamble + (parentSystemMsg ? "\n\n" + parentSystemMsg : "");

                let childSessionId: string;
                try {
                    childSessionId = yield manager.spawnChildSession(input.sessionId, childConfig, agentTask, childNestingLevel, agentIsSystem, agentTitle, agentId, agentSplash);
                } catch (err: any) {
                    ctx.traceInfo(`[orch] spawnChildSession failed: ${err.message}`);
                    queueFollowup(`[SYSTEM: spawn_agent failed: ${err.message}]`);
                    return;
                }

                const childOrchId = `session-${childSessionId}`;

                yield manager.recordSessionEvent(input.sessionId, [{
                    eventType: "session.agent_spawned",
                    data: { childSessionId, agentId: agentId || undefined, task: agentTask.slice(0, 500) },
                }]);

                subAgents.push({
                    orchId: childOrchId,
                    sessionId: childSessionId,
                    task: agentTask.slice(0, 500),
                    status: "running",
                    agentId: agentId || undefined,
                });

                queueFollowup(
                    `[SYSTEM: Sub-agent spawned successfully.\n` +
                    `  Agent ID: ${childOrchId}\n` +
                    `  ${resolvedAgentName ? `Agent: ${resolvedAgentName}\n  ` : ``}Task: "${agentTask.slice(0, 200)}"\n` +
                    `  The agent is now running autonomously. Continue your work in this SAME turn and keep following the user's remaining steps. ` +
                    `Do NOT stop just because the child started. If you need to pause, call wait or wait_for_agents explicitly. ` +
                    `You can also use check_agents to poll status, ` +
                    `or message_agent to send instructions.]`);
                return;
            }

            case "message_agent": {
                const targetOrchId = result.agentId;
                const agentEntry = subAgents.find(a => a.orchId === targetOrchId);

                if (!agentEntry) {
                    ctx.traceInfo(`[orch] message_agent: unknown agent ${targetOrchId}`);
                    queueFollowup(
                        `[SYSTEM: message_agent failed — agent "${targetOrchId}" not found. ` +
                        `Known agents: ${subAgents.map(a => a.orchId).join(", ") || "none"}]`);
                    return;
                }

                ctx.traceInfo(`[orch] message_agent via SDK: ${agentEntry.sessionId} msg="${result.message.slice(0, 60)}"`);

                try {
                    yield manager.sendToSession(agentEntry.sessionId, result.message);
                } catch (err: any) {
                    ctx.traceInfo(`[orch] message_agent failed: ${err.message}`);
                    queueFollowup(`[SYSTEM: message_agent failed: ${err.message}]`);
                    return;
                }

                queueFollowup(
                    `[SYSTEM: Message sent to sub-agent ${targetOrchId}: "${result.message.slice(0, 200)}". ` +
                    `Continue your work in this SAME turn. If you are waiting on the child, call wait_for_agents explicitly rather than stopping here.]`,
                );
                return;
            }

            case "check_agents": {
                ctx.traceInfo(`[orch] check_agents: ${subAgents.length} agents tracked`);

                if (subAgents.length === 0) {
                    queueFollowup(`[SYSTEM: No sub-agents have been spawned yet.]`);
                    return;
                }

                const statusLines: string[] = [];
                for (const agent of subAgents) {
                    try {
                        const rawStatus: string = yield manager.getSessionStatus(agent.sessionId);
                        const parsed = JSON.parse(rawStatus);
                        if (parsed.status === "completed" || parsed.status === "failed" || parsed.status === "idle") {
                            agent.status = parsed.status === "failed" ? "failed" : "completed";
                            if (parsed.result) agent.result = parsed.result.slice(0, 1000);
                        }
                        statusLines.push(
                            `  - Agent ${agent.orchId}\n` +
                            `    Task: "${agent.task.slice(0, 120)}"\n` +
                            `    Status: ${parsed.status}\n` +
                            `    Iterations: ${parsed.iterations ?? 0}\n` +
                            `    Output: ${parsed.result ?? "(no output yet)"}`
                        );
                    } catch (err: any) {
                        statusLines.push(
                            `  - Agent ${agent.orchId}\n` +
                            `    Task: "${agent.task.slice(0, 120)}"\n` +
                            `    Status: unknown (error: ${err.message})`
                        );
                    }
                }

                queueFollowup(`[SYSTEM: Sub-agent status report (${subAgents.length} agents):\n${statusLines.join("\n")}]`);
                return;
            }

            case "list_sessions": {
                ctx.traceInfo(`[orch] list_sessions`);

                const rawSessions: string = yield manager.listSessions();
                const sessions = JSON.parse(rawSessions);

                const lines: string[] = sessions.map((s: any) =>
                    `  - ${s.sessionId}${s.sessionId === input.sessionId ? " (this session)" : ""}\n` +
                    `    Title: ${s.title ?? "(untitled)"}\n` +
                    `    Status: ${s.status}, Iterations: ${s.iterations ?? 0}\n` +
                    `    Parent: ${s.parentSessionId ?? "none"}`
                );

                queueFollowup(`[SYSTEM: Active sessions (${sessions.length}):\n${lines.join("\n")}]`);
                return;
            }

            case "wait_for_agents": {
                let targetIds = result.agentIds;
                if (!targetIds || targetIds.length === 0) {
                    const runningAgentIds = subAgents.filter(a => a.status === "running").map(a => a.orchId);
                    targetIds = runningAgentIds.length > 0
                        ? runningAgentIds
                        : subAgents.map(a => a.orchId);
                }

                if (targetIds.length === 0) {
                    ctx.traceInfo(`[orch] wait_for_agents: no running agents to wait for`);
                    queueFollowup(`[SYSTEM: No running sub-agents to wait for. All agents have already completed.]`);
                    return;
                }

                // Check if all are already done
                const stillRunning = targetIds.filter(id => {
                    const agent = subAgents.find(a => a.orchId === id);
                    return agent && !isSubAgentTerminalStatus(agent.status);
                });

                if (stillRunning.length === 0) {
                    queueFollowup(buildWaitForAgentsFollowup(targetIds));
                    return;
                }

                ctx.traceInfo(`[orch] wait_for_agents: waiting for ${targetIds.length} agents`);
                publishStatus("running");
                waitingForAgentIds = targetIds;

                const agentPollNow: number = yield ctx.utcNow();
                activeTimer = {
                    deadlineMs: agentPollNow + 30_000,
                    originalDurationMs: 30_000,
                    reason: `waiting for ${targetIds.length} agent(s)`,
                    type: "agent-poll",
                    agentIds: targetIds,
                };
                return;
            }

            case "complete_agent": {
                const targetOrchId = result.agentId;
                const agentEntry = subAgents.find(a => a.orchId === targetOrchId);

                if (!agentEntry) {
                    ctx.traceInfo(`[orch] complete_agent: unknown agent ${targetOrchId}`);
                    queueFollowup(
                        `[SYSTEM: complete_agent failed — agent "${targetOrchId}" not found. ` +
                        `Known agents: ${subAgents.map(a => a.orchId).join(", ") || "none"}]`);
                    return;
                }

                ctx.traceInfo(`[orch] complete_agent: sending /done to ${agentEntry.sessionId}`);

                try {
                    const cmdId = `done-${iteration}`;
                    yield manager.sendCommandToSession(agentEntry.sessionId,
                        { type: "cmd", cmd: "done", id: cmdId, args: { reason: "Completed by parent" } });
                    agentEntry.status = "completed";
                } catch (err: any) {
                    ctx.traceInfo(`[orch] complete_agent failed: ${err.message}`);
                    queueFollowup(`[SYSTEM: complete_agent failed: ${err.message}]`);
                    return;
                }

                queueFollowup(`[SYSTEM: Sub-agent ${targetOrchId} has been completed gracefully.]`);
                return;
            }

            case "cancel_agent": {
                const targetOrchId = result.agentId;
                const agentEntry = subAgents.find(a => a.orchId === targetOrchId);

                if (!agentEntry) {
                    ctx.traceInfo(`[orch] cancel_agent: unknown agent ${targetOrchId}`);
                    queueFollowup(
                        `[SYSTEM: cancel_agent failed — agent "${targetOrchId}" not found. ` +
                        `Known agents: ${subAgents.map(a => a.orchId).join(", ") || "none"}]`);
                    return;
                }

                const cancelReason = result.reason ?? "Cancelled by parent";
                ctx.traceInfo(`[orch] cancel_agent: cancelling ${agentEntry.sessionId} reason="${cancelReason}"`);

                try {
                    const descendants: string[] = yield manager.getDescendantSessionIds(agentEntry.sessionId);
                    if (descendants.length > 0) {
                        ctx.traceInfo(`[orch] cancel_agent: cascading cancel to ${descendants.length} descendant(s)`);
                        for (const descId of descendants) {
                            try {
                                yield manager.cancelSession(descId, `Ancestor ${agentEntry.sessionId} cancelled: ${cancelReason}`);
                            } catch (err: any) {
                                ctx.traceInfo(`[orch] cancel_agent: failed to cancel descendant ${descId}: ${err.message} (non-fatal)`);
                            }
                        }
                    }
                    yield manager.cancelSession(agentEntry.sessionId, cancelReason);
                    agentEntry.status = "cancelled";
                } catch (err: any) {
                    ctx.traceInfo(`[orch] cancel_agent failed: ${err.message}`);
                    queueFollowup(`[SYSTEM: cancel_agent failed: ${err.message}]`);
                    return;
                }

                queueFollowup(`[SYSTEM: Sub-agent ${targetOrchId} has been cancelled.${result.reason ? ` Reason: ${result.reason}` : ""}]`);
                return;
            }

            case "delete_agent": {
                const targetOrchId = result.agentId;
                const agentEntry = subAgents.find(a => a.orchId === targetOrchId);

                if (!agentEntry) {
                    ctx.traceInfo(`[orch] delete_agent: unknown agent ${targetOrchId}`);
                    queueFollowup(
                        `[SYSTEM: delete_agent failed — agent "${targetOrchId}" not found. ` +
                        `Known agents: ${subAgents.map(a => a.orchId).join(", ") || "none"}]`);
                    return;
                }

                const deleteReason = result.reason ?? "Deleted by parent";
                ctx.traceInfo(`[orch] delete_agent: deleting ${agentEntry.sessionId} reason="${deleteReason}"`);

                try {
                    const descendants: string[] = yield manager.getDescendantSessionIds(agentEntry.sessionId);
                    if (descendants.length > 0) {
                        ctx.traceInfo(`[orch] delete_agent: cascading delete to ${descendants.length} descendant(s)`);
                        for (const descId of descendants) {
                            try {
                                yield manager.deleteSession(descId, `Ancestor ${agentEntry.sessionId} deleted: ${deleteReason}`);
                            } catch (err: any) {
                                ctx.traceInfo(`[orch] delete_agent: failed to delete descendant ${descId}: ${err.message} (non-fatal)`);
                            }
                        }
                    }
                    yield manager.deleteSession(agentEntry.sessionId, deleteReason);
                    subAgents = subAgents.filter(a => a.orchId !== targetOrchId);
                } catch (err: any) {
                    ctx.traceInfo(`[orch] delete_agent failed: ${err.message}`);
                    queueFollowup(`[SYSTEM: delete_agent failed: ${err.message}]`);
                    return;
                }

                queueFollowup(`[SYSTEM: Sub-agent ${targetOrchId} has been deleted.${result.reason ? ` Reason: ${result.reason}` : ""}]`);
                return;
            }

            case "error": {
                const missingStateIndex = result.message.indexOf(SESSION_STATE_MISSING_PREFIX);
                if (missingStateIndex >= 0) {
                    const fatalError = result.message.slice(missingStateIndex + SESSION_STATE_MISSING_PREFIX.length).trim();
                    ctx.traceInfo(`[orch] fatal missing session state: ${fatalError}`);
                    publishStatus("failed", { error: fatalError, fatal: true });
                    yield manager.updateCmsState(input.sessionId, "failed", fatalError);
                    throw new Error(fatalError);
                }

                retryCount++;
                ctx.traceInfo(`[orch] turn returned error (attempt ${retryCount}/${MAX_RETRIES}): ${result.message}`);

                if (retryCount >= MAX_RETRIES) {
                    ctx.traceInfo(`[orch] max retries exhausted for turn error, waiting for user input`);
                    publishStatus("error", {
                        error: `Failed after ${MAX_RETRIES} attempts: ${result.message}`,
                        retriesExhausted: true,
                    });
                    retryCount = 0;
                    return;
                }

                publishStatus("error", {
                    error: `${result.message} (retry ${retryCount}/${MAX_RETRIES})`,
                });

                const errorRetryDelay = 15 * Math.pow(2, retryCount - 1);
                ctx.traceInfo(`[orch] retrying in ${errorRetryDelay}s after turn error`);

                if (blobEnabled) {
                    yield* dehydrateForNextTurn("error");
                }

                yield ctx.scheduleTimer(errorRetryDelay * 1000);
                yield* versionedContinueAsNew(continueInput({
                    prompt: sourcePrompt,
                    retryCount,
                    needsHydration: blobEnabled ? true : needsHydration,
                }));
                return;
            }
        }
    }

    // ═══════════════════════════════════════════════════════════
    // ═══ PROCESS TIMER — handles fired timers by type ════════
    // ═══════════════════════════════════════════════════════════

    function* processTimer(timerItem: any): Generator<any, void, any> {
        const timer = timerItem.timer;
        switch (timer.type) {
            case "wait": {
                const seconds = Math.round(timer.originalDurationMs / 1000);
                yield manager.recordSessionEvent(input.sessionId, [{
                    eventType: "session.wait_completed",
                    data: { seconds },
                }]);
                const timerPrompt = `The ${seconds} second wait is now complete. Continue with your task.`;
                yield* processPrompt(timerPrompt, false);
                return;
            }
            case "cron": {
                yield manager.recordSessionEvent(input.sessionId, [{
                    eventType: "session.cron_fired",
                    data: {},
                }]);
                const activeCron = cronSchedule!;
                const cronPrompt = `[SYSTEM: Scheduled cron wake-up for: "${activeCron.reason}". Resume your recurring task.]`;
                const shouldRehydrate = timer.shouldRehydrate;
                if (shouldRehydrate) {
                    yield* processPrompt(
                        wrapWithResumeContext("Resume your recurring task.",
                            `Scheduled cron wake-up for: "${activeCron.reason}".`),
                        true,
                    );
                } else {
                    yield* processPrompt(cronPrompt, true);
                }
                return;
            }
            case "idle": {
                ctx.traceInfo("[session] idle timeout, dehydrating");
                yield* dehydrateForNextTurn("idle");
                // No LLM turn — main loop will CAN
                return;
            }
            case "agent-poll": {
                // Fallback poll — check agent statuses via SDK
                if (waitingForAgentIds) {
                    const stillRunning = waitingForAgentIds.filter(id => {
                        const agent = subAgents.find(a => a.orchId === id);
                        return agent && !isSubAgentTerminalStatus(agent.status);
                    });
                    ctx.traceInfo(`[orch] wait_for_agents: fallback poll, checking ${stillRunning.length} agents`);
                    for (const targetId of stillRunning) {
                        const agent = subAgents.find(a => a.orchId === targetId);
                        if (!agent || isSubAgentTerminalStatus(agent.status)) continue;
                        try {
                            const rawStatus: string = yield manager.getSessionStatus(agent.sessionId);
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

                    // Check if all done now
                    const nowRunning = waitingForAgentIds.filter(id => {
                        const agent = subAgents.find(a => a.orchId === id);
                        return agent && !isSubAgentTerminalStatus(agent.status);
                    });

                    if (nowRunning.length === 0) {
                        // All done — build summary and queue as prompt
                        queueFollowup(buildWaitForAgentsFollowup(waitingForAgentIds));
                        waitingForAgentIds = null;
                    } else {
                        // Re-arm poll timer
                        const now: number = yield ctx.utcNow();
                        activeTimer = {
                            deadlineMs: now + 30_000,
                            originalDurationMs: 30_000,
                            reason: `waiting for ${nowRunning.length} agent(s)`,
                            type: "agent-poll",
                            agentIds: waitingForAgentIds,
                        };
                    }
                }
                return;
            }
            case "input-grace": {
                // Grace period expired — dehydrate and wait for answer
                yield* dehydrateForNextTurn("input_required");
                // No timer — drain will block on dequeue for the answer
                return;
            }
        }
    }

    // ═══════════════════════════════════════════════════════════
    // ═══ PROCESS ANSWER — format answer and run turn ═════════
    // ═══════════════════════════════════════════════════════════

    function* processAnswer(answerItem: any): Generator<any, void, any> {
        const question = pendingInputQuestion?.question ?? "a question";
        pendingInputQuestion = null;
        const answerPrompt = `The user was asked: "${question}"\nThe user responded: "${answerItem.answer}"`;
        yield* processPrompt(answerPrompt, false);
    }

    // ═══════════════════════════════════════════════════════════
    // ═══ DECIDE — pop + process one item from FIFO ══════════
    // ═══════════════════════════════════════════════════════════

    function* decide(): Generator<any, boolean, any> {
        // Priority 1: pending tool actions (in-memory)
        drainLeadingQueuedCronActions();
        if (pendingToolActions.length > 0) {
            const action = pendingToolActions.shift()!;
            ctx.traceInfo(`[orch] replaying queued action: ${action.type} remaining=${pendingToolActions.length}`);
            yield* handleTurnResult(action as unknown as TurnResult, "");
            return true;
        }

        // Priority 2: pending prompt from tool action followups or CAN carry-forward
        // Hold while waiting for agents — let confirmations accumulate and merge
        // with the agents-done summary for a single combined LLM turn.
        if (pendingPrompt && !waitingForAgentIds) {
            const prompt = pendingPrompt;
            const isBootstrap = bootstrapPrompt;
            const requiredTool = pendingRequiredTool;
            pendingPrompt = undefined;
            bootstrapPrompt = false;
            pendingRequiredTool = undefined;
            yield* processPrompt(prompt, isBootstrap, requiredTool);
            return true;
        }

        // Priority 3: FIFO — next item in arrival order
        const item = popFifoItem();
        if (item) {
            switch (item.kind) {
                case "prompt":
                    yield* processPrompt(item.prompt, item.bootstrap ?? false, item.requiredTool);
                    break;
                case "answer":
                    yield* processAnswer(item);
                    break;
                case "timer":
                    yield* processTimer(item);
                    break;
                case "agents-done":
                    queueFollowup(item.summary);
                    break;
                default:
                    ctx.traceInfo(`[decide] unknown FIFO item kind: ${item.kind}`);
            }
            return true;
        }

        // Priority 4: buffered child digest — only after user/FIFO work is drained
        if (pendingChildDigest?.ready && pendingChildDigest.updates.length > 0 && !waitingForAgentIds) {
            yield* processPendingChildDigest();
            return true;
        }

        return false;
    }

    // ═══════════════════════════════════════════════════════════
    // ═══ FLAT MAIN LOOP ══════════════════════════════════════
    // ═══════════════════════════════════════════════════════════

    let loopIteration = 0;

    while (true) {
        loopIteration++;

        // Safety valve: CAN if too many iterations in this execution
        if (loopIteration > MAX_ITERATIONS_PER_EXECUTION) {
            ctx.traceInfo(`[orch] iteration cap (${MAX_ITERATIONS_PER_EXECUTION}) — continuing as new`);
            yield* versionedContinueAsNew(continueInput());
            return "";
        }

        // DRAIN: greedily move queue events + timer fires into KV FIFO
        yield* drain();
        if (orchestrationResult !== null) return orchestrationResult;

        // DECIDE: pop + process one item from FIFO in arrival order
        const didWork = yield* decide();
        if (orchestrationResult !== null) return orchestrationResult;

        if (didWork) continue;

        // No buffered work — check if we should wait or CAN
        if (activeTimer) continue;          // drain will race the timer next iteration
        if (pendingInputQuestion) continue;  // drain will block on dequeue for answer

        // Truly nothing to do — CAN (safe checkpoint)
        ctx.traceInfo(`[orch] no buffered work, continuing as new`);
        yield* versionedContinueAsNew(continueInput());
        return "";
    }
}
