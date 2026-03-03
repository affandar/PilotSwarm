import type {
    TurnResult,
    OrchestrationInput,
    SubAgentEntry,
    SerializableSessionConfig,
    DurableSessionStatus,
    CommandMessage,
    CommandResponse,
} from "./types.js";
import { createSessionProxy, createSessionManagerProxy } from "./session-proxy.js";

/**
 * Set custom status as a JSON blob of session state.
 * Clients read this via waitForStatusChange() or getStatus().
 * @internal
 */
function setStatus(ctx: any, status: DurableSessionStatus, extra?: Record<string, unknown>) {
    ctx.setCustomStatus(JSON.stringify({ status, ...extra }));
}

/**
 * Long-lived durable session orchestration.
 *
 * One orchestration per copilot session. Uses:
 *   - SessionProxy for session-scoped operations (runTurn, dehydrate, hydrate, destroy)
 *   - SessionManagerProxy for global operations (listModels)
 *   - A single FIFO event queue ("messages") for all client→orchestration communication
 *
 * Main loop:
 *   1. Dequeue message from "messages" queue
 *   2. session.hydrate() if needed
 *   3. session.runTurn(prompt) — returns TurnResult
 *   4. Handle result: completed → idle wait, wait → timer, input → wait for answer
 *
 * @internal
 */
export function* durableSessionOrchestration_1_0_4(
    ctx: any,
    input: OrchestrationInput,
): Generator<any, string, any> {
    const dehydrateThreshold = input.dehydrateThreshold ?? 30;
    const idleTimeout = input.idleTimeout ?? 30;
    const inputGracePeriod = input.inputGracePeriod ?? 30;
    const checkpointInterval = input.checkpointInterval ?? -1; // seconds, -1 = disabled
    const rehydrationMessage = input.rehydrationMessage;
    const blobEnabled = input.blobEnabled ?? false;
    let needsHydration = input.needsHydration ?? false;
    let affinityKey = input.affinityKey ?? input.sessionId;
    let iteration = input.iteration ?? 0;
    let config = { ...input.config };
    let retryCount = input.retryCount ?? 0;
    let taskContext = input.taskContext;
    const baseSystemMessage = input.baseSystemMessage ?? config.systemMessage;
    const MAX_RETRIES = 3;
    const MAX_SUB_AGENTS = 5;

    // ─── Sub-agent tracking ──────────────────────────────────
    let subAgents: SubAgentEntry[] = input.subAgents ? [...input.subAgents] : [];
    let spawnCount = input.spawnCount ?? 0;
    // parentSessionId: prefer new field, fall back to old parentOrchId for backward compat
    const parentSessionId = input.parentSessionId
        ?? (input.parentOrchId ? input.parentOrchId.replace(/^session-/, '') : undefined);

    // If we have a captured task context, inject it into the system message
    // so it survives LLM conversation truncation (BasicTruncator never drops system messages).
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
    // First summarize at iteration 0 + 60s, then every 300s.
    // We track the target timestamp (epoch ms) across continueAsNew.
    // 0 means "schedule on first turn completion".
    let nextSummarizeAt = input.nextSummarizeAt ?? 0;

    // ─── Create proxies ──────────────────────────────────────
    const manager = createSessionManagerProxy(ctx);
    let session = createSessionProxy(ctx, input.sessionId, affinityKey, config);

    // ─── Helper: wrap prompt with resume context after dehydration ──
    function wrapWithResumeContext(userPrompt: string, extra?: string): string {
        const base = rehydrationMessage ??
            `The session was dehydrated and has been rehydrated on a new worker. ` +
            `The LLM conversation history is preserved, but you should acknowledge the context switch. ` +
            `After responding to the user's message below, resume exactly what you were doing before. ` +
            `If you were in the middle of a recurring task, continue it.`;
        const parts = [`[SYSTEM: ${base}`];
        if (extra) parts.push(extra);
        parts.push(`]`);
        parts.push(``);
        parts.push(userPrompt);
        return parts.join('\n');
    }

    // ─── Shared continueAsNew input builder ──────────────────
    function continueInput(overrides: Partial<OrchestrationInput> = {}): OrchestrationInput {
        return {
            sessionId: input.sessionId,
            config,
            iteration,
            affinityKey,
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
            subAgents,
            spawnCount,
            parentSessionId,
            retryCount: 0, // reset by default; overrides can set it
            ...overrides,
        };
    }

    // ─── Helper: dehydrate + reset affinity ──────────────────
    function* dehydrateAndReset(reason: string): Generator<any, void, any> {
        ctx.traceInfo(`[orch] dehydrating session (reason=${reason})`);
        yield session.dehydrate(reason);
        needsHydration = true;
        affinityKey = yield ctx.newGuid();
        session = createSessionProxy(ctx, input.sessionId, affinityKey, config);
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
    const FIRST_SUMMARIZE_DELAY = 60_000;    // 1 minute
    const REPEAT_SUMMARIZE_DELAY = 300_000;  // 5 minutes
    function* maybeSummarize(): Generator<any, void, any> {
        const now: number = yield ctx.utcNow();
        // Schedule first summarize 60s after session start
        if (nextSummarizeAt === 0) {
            nextSummarizeAt = now + FIRST_SUMMARIZE_DELAY;
            return;
        }
        if (now < nextSummarizeAt) return;
        // Time to summarize — fire and forget (best effort)
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
    /** Set by the "completed" handler so the dequeue loop doesn't overwrite it. */
    let lastTurnResult: any = undefined;

    ctx.traceInfo(`[orch] start: iter=${iteration} pending=${pendingPrompt ? `"${pendingPrompt.slice(0, 40)}"` : 'NONE'} hydrate=${needsHydration} blob=${blobEnabled}`);

    // ─── MAIN LOOP ──────────────────────────────────────────
    while (true) {
        // ① GET NEXT PROMPT
        let prompt = "";
        if (pendingPrompt) {
            prompt = pendingPrompt;
            pendingPrompt = undefined;
        } else {
            // If we have a completed turnResult, include it in the idle status
            // so clients can read it via waitForStatusChange. Without this,
            // a bare setStatus("idle") between yields would overwrite it.
            if (lastTurnResult) {
                setStatus(ctx, "idle", { iteration, turnResult: lastTurnResult });
            } else {
                setStatus(ctx, "idle", { iteration });
            }

            let gotPrompt = false;
            while (!gotPrompt) {
                // All messages (from users and child agents) arrive on the "messages" queue.
                // Child agents communicate via the SDK (sendToSession), which enqueues
                // to the same "messages" queue as user prompts.
                let msgData: any;
                const msg: any = yield ctx.dequeueEvent("messages");
                msgData = typeof msg === "string" ? JSON.parse(msg) : msg;

                // ── Command dispatch ─────────────────────────
                if (msgData.type === "cmd") {
                    const cmdMsg = msgData as CommandMessage;
                    ctx.traceInfo(`[orch-cmd] ${cmdMsg.cmd} id=${cmdMsg.id}`);

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
                            setStatus(ctx, "idle", { iteration, cmdResponse: resp });
                            yield ctx.continueAsNew(continueInput());
                            return "";
                        }
                        case "list_models": {
                            setStatus(ctx, "idle", { iteration, cmdProcessing: cmdMsg.id });
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
                                setStatus(ctx, "idle", { iteration, cmdResponse: resp });
                                continue;
                            }
                            const resp: CommandResponse = {
                                id: cmdMsg.id,
                                cmd: cmdMsg.cmd,
                                result: { models, currentModel: config.model },
                            };
                            setStatus(ctx, "idle", { iteration, cmdResponse: resp });
                            continue;
                        }
                        case "get_info": {
                            const resp: CommandResponse = {
                                id: cmdMsg.id,
                                cmd: cmdMsg.cmd,
                                result: {
                                    model: config.model || "(default)",
                                    iteration,
                                    sessionId: input.sessionId,
                                    affinityKey: affinityKey?.slice(0, 8),
                                    needsHydration,
                                    blobEnabled,
                                },
                            };
                            setStatus(ctx, "idle", { iteration, cmdResponse: resp });
                            continue;
                        }
                        default: {
                            const resp: CommandResponse = {
                                id: cmdMsg.id,
                                cmd: cmdMsg.cmd,
                                error: `Unknown command: ${cmdMsg.cmd}`,
                            };
                            setStatus(ctx, "idle", { iteration, cmdResponse: resp });
                            continue;
                        }
                    }
                }

                prompt = msgData.prompt;
                gotPrompt = true;
                lastTurnResult = undefined; // Clear after new prompt arrives
            }
        }

        // If the session needs hydration, the LLM lost in-memory context.
        // Wrap the user's prompt with resume instructions so the LLM picks up where it left off.
        if (needsHydration && blobEnabled && prompt) {
            prompt = wrapWithResumeContext(prompt);
        }

        ctx.traceInfo(`[turn ${iteration}] session=${input.sessionId} prompt="${prompt.slice(0, 80)}"`);

        // ② HYDRATE if session was dehydrated (with retry)
        if (needsHydration && blobEnabled) {
            let hydrateAttempts = 0;
            while (true) {
                try {
                    affinityKey = yield ctx.newGuid();
                    session = createSessionProxy(ctx, input.sessionId, affinityKey, config);
                    yield session.hydrate();
                    needsHydration = false;
                    break;
                } catch (hydrateErr: any) {
                    hydrateAttempts++;
                    const hMsg = hydrateErr.message || String(hydrateErr);
                    ctx.traceInfo(`[orch] hydrate FAILED (attempt ${hydrateAttempts}/${MAX_RETRIES}): ${hMsg}`);
                    if (hydrateAttempts >= MAX_RETRIES) {
                        setStatus(ctx, "error", {
                            iteration,
                            error: `Hydrate failed after ${MAX_RETRIES} attempts: ${hMsg}`,
                            retriesExhausted: true,
                        });
                        // Can't proceed without hydration — wait for next user message to retry
                        break;
                    }
                    const hydrateDelay = 10 * Math.pow(2, hydrateAttempts - 1);
                    setStatus(ctx, "error", {
                        iteration,
                        error: `Hydrate failed: ${hMsg} (retry ${hydrateAttempts}/${MAX_RETRIES} in ${hydrateDelay}s)`,
                    });
                    yield ctx.scheduleTimer(hydrateDelay * 1000);
                }
            }
            if (needsHydration) continue; // hydrate exhausted retries — go back to dequeue
        }

        // ③ RUN TURN via SessionProxy (with retry on failure)
        setStatus(ctx, "running", { iteration });
        let turnResult: any;
        try {
            turnResult = yield session.runTurn(prompt);
        } catch (err: any) {
            // Activity failed (e.g. Copilot timeout, network error).
            const errorMsg = err.message || String(err);
            retryCount++;
            ctx.traceInfo(`[orch] runTurn FAILED (attempt ${retryCount}/${MAX_RETRIES}): ${errorMsg}`);

            if (retryCount >= MAX_RETRIES) {
                // Exhausted retries — park in error state but don't crash.
                // The orchestration stays alive and will retry on the next user message.
                ctx.traceInfo(`[orch] max retries exhausted, waiting for user input`);
                setStatus(ctx, "error", {
                    iteration,
                    error: `Failed after ${MAX_RETRIES} attempts: ${errorMsg}`,
                    retriesExhausted: true,
                });
                // Reset retry count and wait for next user message
                retryCount = 0;
                continue;
            }

            setStatus(ctx, "error", {
                iteration,
                error: `${errorMsg} (retry ${retryCount}/${MAX_RETRIES} in 15s)`,
            });

            // Exponential backoff: 15s, 30s, 60s
            const retryDelay = 15 * Math.pow(2, retryCount - 1);
            ctx.traceInfo(`[orch] retrying in ${retryDelay}s`);

            if (blobEnabled) {
                yield* dehydrateAndReset("error");
            }

            yield ctx.scheduleTimer(retryDelay * 1000);
            yield ctx.continueAsNew(continueInput({
                prompt,
                retryCount,
                needsHydration: blobEnabled ? true : needsHydration,
            }));
            return "";
        }
        // Successful activity — reset retry counter
        retryCount = 0;

        const result: TurnResult = typeof turnResult === "string"
            ? JSON.parse(turnResult) : turnResult;
        iteration++;

        // Strip events from result before putting in customStatus (events go to CMS, not status)
        const { events: _events, ...statusResult } = result as any;

        // ── Summarize title if due ──────────────────────────
        yield* maybeSummarize();

        // ④ HANDLE RESULT
        switch (result.type) {
            case "completed":
                ctx.traceInfo(`[response] ${result.content}`);

                // If this is a child orchestration, notify the parent about our completion
                // via the SDK — sends to the parent's "messages" queue like any other message.
                if (parentSessionId) {
                    try {
                        yield manager.sendToSession(parentSessionId,
                            `[CHILD_UPDATE from=${input.sessionId} type=completed iter=${iteration}]\n${result.content.slice(0, 2000)}`);
                    } catch (err: any) {
                        ctx.traceInfo(`[orch] sendToSession(parent) failed: ${err.message} (non-fatal)`);
                    }
                }

                if (!blobEnabled || idleTimeout < 0) {
                    // Store the result so the dequeue-idle setStatus includes it
                    lastTurnResult = statusResult;
                    // Checkpoint while idle (no dehydration path)
                    yield* maybeCheckpoint();
                    continue;
                }

                // Race: next message vs idle timeout
                {
                    setStatus(ctx, "idle", { iteration, turnResult: statusResult });
                    yield* maybeCheckpoint();
                    const nextMsg = ctx.dequeueEvent("messages");
                    const idleTimer = ctx.scheduleTimer(idleTimeout * 1000);
                    const raceResult: any = yield ctx.race(nextMsg, idleTimer);

                    if (raceResult.index === 0) {
                        ctx.traceInfo("[session] user responded within idle window");
                        const raceMsg = typeof raceResult.value === "string"
                            ? JSON.parse(raceResult.value) : (raceResult.value ?? {});
                        if (raceMsg.prompt) {
                            yield ctx.continueAsNew(continueInput({ prompt: raceMsg.prompt }));
                        } else {
                            yield ctx.continueAsNew(continueInput());
                        }
                        return "";
                    }

                    // Idle timeout → dehydrate. Next message will need resume context.
                    ctx.traceInfo("[session] idle timeout, dehydrating");
                    yield* dehydrateAndReset("idle");
                    // Don't continueAsNew with a prompt — wait for the next user message,
                    // which will be wrapped with resume context because needsHydration=true.
                    yield ctx.continueAsNew(continueInput());
                    return "";
                }

            case "wait":
                // Capture original user prompt as task context for recurring tasks.
                // This ensures the LLM remembers its task even after conversation truncation.
                if (!taskContext) {
                    taskContext = prompt.slice(0, 2000);
                    const base = typeof baseSystemMessage === 'string'
                        ? baseSystemMessage ?? ''
                        : (baseSystemMessage as any)?.content ?? '';
                    config.systemMessage = base + (base ? '\n\n' : '') +
                        '[RECURRING TASK]\n' +
                        'Original user request (always remember, even if conversation history is truncated):\n"' +
                        taskContext + '"';
                }

                if (result.content) {
                    setStatus(ctx, "running", { iteration, intermediateContent: result.content });
                    ctx.traceInfo(`[orch] intermediate: ${result.content.slice(0, 80)}`);
                }

                // If this is a child orchestration, notify the parent on every wait cycle
                // via the SDK — sends a message to the parent's "messages" queue.
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

                {
                    const shouldDehydrate = blobEnabled && result.seconds > dehydrateThreshold;
                    if (shouldDehydrate) {
                        yield* dehydrateAndReset("timer");
                    }

                    const waitStartedAt: number = yield ctx.utcNow();

                    setStatus(ctx, "waiting", {
                        iteration,
                        waitSeconds: result.seconds,
                        waitReason: result.reason,
                        waitStartedAt,
                        ...(result.content ? { turnResult: { type: "completed", content: result.content } } : {}),
                    });

                    // Checkpoint before the blocking wait
                    if (!shouldDehydrate) yield* maybeCheckpoint();

                    const timerTask = ctx.scheduleTimer(result.seconds * 1000);
                    const interruptMsg = ctx.dequeueEvent("messages");
                    const timerRace: any = yield ctx.race(timerTask, interruptMsg);

                    if (timerRace.index === 1) {
                        const interruptData = typeof timerRace.value === "string"
                            ? JSON.parse(timerRace.value) : (timerRace.value ?? {});
                        ctx.traceInfo(`[session] wait interrupted: "${(interruptData.prompt || "").slice(0, 60)}"`);

                        // Calculate remaining time for resume context
                        const interruptedAt: number = yield ctx.utcNow();
                        const elapsedSec = Math.round((interruptedAt - waitStartedAt) / 1000);
                        const remainingSec = Math.max(0, result.seconds - elapsedSec);
                        const userPrompt = interruptData.prompt || "";

                        let finalPrompt: string;
                        if (shouldDehydrate && userPrompt) {
                            finalPrompt = wrapWithResumeContext(
                                userPrompt,
                                `You were waiting on a ${result.seconds}s timer (reason: "${result.reason}"). ` +
                                `${elapsedSec}s have elapsed, ${remainingSec}s remain. ` +
                                `After handling the user's message, restart the wait using the wait tool for the remaining ${remainingSec} seconds only.`,
                            );
                        } else if (userPrompt) {
                            // Not dehydrated but still interrupted — give timing context
                            finalPrompt = `${userPrompt}\n\n` +
                                `[SYSTEM: You were waiting on a ${result.seconds}s timer (reason: "${result.reason}"). ` +
                                `${elapsedSec}s elapsed, ${remainingSec}s remain. ` +
                                `After handling this message, restart the wait using the wait tool for the remaining ${remainingSec} seconds only.]`;
                        } else {
                            finalPrompt = userPrompt;
                        }

                        yield ctx.continueAsNew(continueInput({
                            prompt: finalPrompt,
                            needsHydration: shouldDehydrate ? true : needsHydration,
                        }));
                        return "";
                    }

                    const timerPrompt = `The ${result.seconds} second wait is now complete. Continue with your task.`;
                    yield ctx.continueAsNew(continueInput({
                        prompt: timerPrompt,
                        needsHydration: shouldDehydrate ? true : needsHydration,
                    }));
                    return "";
                }

            case "input_required":
                ctx.traceInfo(`[orch] waiting for user input: ${result.question}`);

                if (!blobEnabled || inputGracePeriod < 0) {
                    setStatus(ctx, "input_required", {
                        iteration,
                        turnResult: statusResult,
                        pendingQuestion: result.question,
                        choices: result.choices,
                        allowFreeform: result.allowFreeform,
                    });
                    yield* maybeCheckpoint();
                    const answerMsg: any = yield ctx.dequeueEvent("messages");
                    const answerData = typeof answerMsg === "string"
                        ? JSON.parse(answerMsg) : answerMsg;
                    yield ctx.continueAsNew(continueInput({
                        prompt: `The user was asked: "${result.question}"\nThe user responded: "${answerData.answer}"`,
                        needsHydration: false,
                    }));
                    return "";
                }

                if (inputGracePeriod === 0) {
                    setStatus(ctx, "input_required", {
                        iteration,
                        turnResult: statusResult,
                        pendingQuestion: result.question,
                    });
                    yield* dehydrateAndReset("input_required");
                    const answerMsg: any = yield ctx.dequeueEvent("messages");
                    const answerData = typeof answerMsg === "string"
                        ? JSON.parse(answerMsg) : answerMsg;
                    yield ctx.continueAsNew(continueInput({
                        prompt: `The user was asked: "${result.question}"\nThe user responded: "${answerData.answer}"`,
                    }));
                    return "";
                }

                // Race: user answer vs grace period
                {
                    setStatus(ctx, "input_required", {
                        iteration,
                        turnResult: statusResult,
                        pendingQuestion: result.question,
                        choices: result.choices,
                        allowFreeform: result.allowFreeform,
                    });
                    const answerEvt = ctx.dequeueEvent("messages");
                    const graceTimer = ctx.scheduleTimer(inputGracePeriod * 1000);
                    const raceResult: any = yield ctx.race(answerEvt, graceTimer);

                    if (raceResult.index === 0) {
                        const answerData = typeof raceResult.value === "string"
                            ? JSON.parse(raceResult.value) : (raceResult.value ?? {});
                        yield ctx.continueAsNew(continueInput({
                            prompt: `The user was asked: "${result.question}"\nThe user responded: "${answerData.answer}"`,
                            needsHydration: false,
                        }));
                        return "";
                    }

                    yield* dehydrateAndReset("input_required");
                    const answerMsg: any = yield ctx.dequeueEvent("messages");
                    const answerData = typeof answerMsg === "string"
                        ? JSON.parse(answerMsg) : answerMsg;
                    yield ctx.continueAsNew(continueInput({
                        prompt: `The user was asked: "${result.question}"\nThe user responded: "${answerData.answer}"`,
                    }));
                    return "";
                }

            case "cancelled":
                ctx.traceInfo("[session] turn cancelled");
                continue;

            // ─── Sub-Agent Result Handlers ───────────────────

            case "spawn_agent": {
                // Enforce max sub-agents
                const activeCount = subAgents.filter(a => a.status === "running").length;
                if (activeCount >= MAX_SUB_AGENTS) {
                    ctx.traceInfo(`[orch] spawn_agent denied: ${activeCount}/${MAX_SUB_AGENTS} agents running`);
                    yield ctx.continueAsNew(continueInput({
                        prompt: `[SYSTEM: spawn_agent failed — you already have ${activeCount} running sub-agents (max ${MAX_SUB_AGENTS}). ` +
                            `Wait for some to complete before spawning more.]`,
                    }));
                    return "";
                }

                // Generate unique child IDs
                // Use spawnCount (monotonic across all continueAsNew calls) to guarantee uniqueness
                const childSessionId = `${input.sessionId}_sub_${String(spawnCount).padStart(5, '0')}`;
                spawnCount++;
                const childOrchId = `session-${childSessionId}`;

                ctx.traceInfo(`[orch] spawning sub-agent via SDK: task="${result.task.slice(0, 80)}"`);

                // Build child config — inherit parent's config with optional overrides
                const childConfig: SerializableSessionConfig = {
                    ...config,
                    ...(result.systemMessage ? { systemMessage: result.systemMessage } : {}),
                    ...(result.toolNames ? { toolNames: result.toolNames } : {}),
                };

                // Use the DurableCopilotClient SDK to create and start the child session.
                // This handles: CMS registration (with parentSessionId), orchestration startup,
                // and initial task prompt — all through the standard SDK path.
                try {
                    yield manager.spawnChildSession(childSessionId, input.sessionId, childConfig, result.task);
                } catch (err: any) {
                    ctx.traceInfo(`[orch] spawnChildSession failed: ${err.message}`);
                    yield ctx.continueAsNew(continueInput({
                        prompt: `[SYSTEM: spawn_agent failed: ${err.message}]`,
                    }));
                    return "";
                }

                // Track the sub-agent
                subAgents.push({
                    orchId: childOrchId,
                    sessionId: childSessionId,
                    task: result.task.slice(0, 500),
                    status: "running",
                });

                // Feed confirmation back to the LLM
                const spawnMsg = `[SYSTEM: Sub-agent spawned successfully.\n` +
                    `  Agent ID: ${childOrchId}\n` +
                    `  Task: "${result.task.slice(0, 200)}"\n` +
                    `  The agent is now running autonomously. Use check_agents to monitor progress, ` +
                    `message_agent to send instructions, or wait_for_agents to block until completion.]`;

                yield ctx.continueAsNew(continueInput({ prompt: spawnMsg }));
                return "";
            }

            case "message_agent": {
                const targetOrchId = result.agentId;
                const agentEntry = subAgents.find(a => a.orchId === targetOrchId);

                if (!agentEntry) {
                    ctx.traceInfo(`[orch] message_agent: unknown agent ${targetOrchId}`);
                    yield ctx.continueAsNew(continueInput({
                        prompt: `[SYSTEM: message_agent failed — agent "${targetOrchId}" not found. ` +
                            `Known agents: ${subAgents.map(a => a.orchId).join(", ") || "none"}]`,
                    }));
                    return "";
                }

                ctx.traceInfo(`[orch] message_agent via SDK: ${agentEntry.sessionId} msg="${result.message.slice(0, 60)}"`);

                try {
                    yield manager.sendToSession(agentEntry.sessionId, result.message);
                } catch (err: any) {
                    ctx.traceInfo(`[orch] message_agent failed: ${err.message}`);
                    yield ctx.continueAsNew(continueInput({
                        prompt: `[SYSTEM: message_agent failed: ${err.message}]`,
                    }));
                    return "";
                }

                yield ctx.continueAsNew(continueInput({
                    prompt: `[SYSTEM: Message sent to sub-agent ${targetOrchId}: "${result.message.slice(0, 200)}"]`,
                }));
                return "";
            }

            case "check_agents": {
                ctx.traceInfo(`[orch] check_agents: ${subAgents.length} agents tracked`);

                if (subAgents.length === 0) {
                    yield ctx.continueAsNew(continueInput({
                        prompt: `[SYSTEM: No sub-agents have been spawned yet.]`,
                    }));
                    return "";
                }

                // Get fresh status for each agent via the SDK
                const statusLines: string[] = [];
                for (const agent of subAgents) {
                    try {
                        const rawStatus: string = yield manager.getSessionStatus(agent.sessionId);
                        const parsed = JSON.parse(rawStatus);

                        // Update local tracking
                        if (parsed.status === "completed" || parsed.status === "failed") {
                            agent.status = parsed.status;
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

                yield ctx.continueAsNew(continueInput({
                    prompt: `[SYSTEM: Sub-agent status report (${subAgents.length} agents):\n${statusLines.join("\n")}]`,
                }));
                return "";
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

                yield ctx.continueAsNew(continueInput({
                    prompt: `[SYSTEM: Active sessions (${sessions.length}):\n${lines.join("\n")}]`,
                }));
                return "";
            }

            case "wait_for_agents": {
                let targetIds = result.agentIds;

                // If empty, wait for all running agents
                if (!targetIds || targetIds.length === 0) {
                    targetIds = subAgents.filter(a => a.status === "running").map(a => a.orchId);
                }

                if (targetIds.length === 0) {
                    ctx.traceInfo(`[orch] wait_for_agents: no running agents to wait for`);
                    yield ctx.continueAsNew(continueInput({
                        prompt: `[SYSTEM: No running sub-agents to wait for. All agents have already completed.]`,
                    }));
                    return "";
                }

                ctx.traceInfo(`[orch] wait_for_agents: waiting for ${targetIds.length} agents`);
                setStatus(ctx, "running", {
                    iteration,
                    waitingForAgents: targetIds,
                });

                // Poll-based wait: check child status via SDK on a timer.
                // Race each poll with user messages so the parent stays responsive.
                const POLL_INTERVAL_MS = 10_000; // 10 seconds
                const MAX_WAIT_ITERATIONS = 360; // ~1 hour max
                for (let waitIter = 0; waitIter < MAX_WAIT_ITERATIONS; waitIter++) {
                    // Check if all targets are done (from local tracking)
                    const stillRunning = targetIds.filter(id => {
                        const agent = subAgents.find(a => a.orchId === id);
                        return agent && agent.status === "running";
                    });
                    if (stillRunning.length === 0) break;

                    // Race: user message vs poll timer (duroxide race supports exactly 2 tasks)
                    const userMsg = ctx.dequeueEvent("messages");
                    const pollTimer = ctx.scheduleTimer(POLL_INTERVAL_MS);
                    const waitRace: any = yield ctx.race(userMsg, pollTimer);

                    if (waitRace.index === 0) {
                        // User message interrupted the wait — handle it
                        const interruptData = typeof waitRace.value === "string"
                            ? JSON.parse(waitRace.value) : (waitRace.value ?? {});
                        if (interruptData.prompt) {
                            ctx.traceInfo(`[orch] wait_for_agents interrupted by user: "${interruptData.prompt.slice(0, 60)}"`);
                            yield ctx.continueAsNew(continueInput({
                                prompt: interruptData.prompt,
                            }));
                            return "";
                        }
                    }

                    // Poll: check each still-running agent via SDK
                    ctx.traceInfo(`[orch] wait_for_agents: polling ${stillRunning.length} agents (iter ${waitIter})`);
                    for (const targetId of stillRunning) {
                        const agent = subAgents.find(a => a.orchId === targetId);
                        if (!agent || agent.status !== "running") continue;
                        try {
                            const rawStatus: string = yield manager.getSessionStatus(agent.sessionId);
                            const parsed = JSON.parse(rawStatus);
                            if (parsed.status === "completed" || parsed.status === "failed") {
                                agent.status = parsed.status;
                                if (parsed.result) agent.result = parsed.result.slice(0, 2000);
                            }
                        } catch {}
                    }
                }

                // Build results summary
                const resultLines: string[] = [];
                for (const targetId of targetIds) {
                    const agent = subAgents.find(a => a.orchId === targetId);
                    if (!agent) continue;
                    resultLines.push(
                        `  - Agent ${agent.orchId}\n` +
                        `    Task: "${agent.task.slice(0, 120)}"\n` +
                        `    Status: ${agent.status}\n` +
                        `    Result: ${agent.result ?? "(no result)"}`
                    );
                }

                yield ctx.continueAsNew(continueInput({
                    prompt: `[SYSTEM: Sub-agents completed:\n${resultLines.join("\n")}]`,
                }));
                return "";
            }

            case "error": {
                // Treat like an activity failure — retry with backoff.
                retryCount++;
                ctx.traceInfo(`[orch] turn returned error (attempt ${retryCount}/${MAX_RETRIES}): ${result.message}`);

                if (retryCount >= MAX_RETRIES) {
                    ctx.traceInfo(`[orch] max retries exhausted for turn error, waiting for user input`);
                    setStatus(ctx, "error", {
                        iteration,
                        error: `Failed after ${MAX_RETRIES} attempts: ${result.message}`,
                        retriesExhausted: true,
                    });
                    retryCount = 0;
                    continue;
                }

                setStatus(ctx, "error", {
                    iteration,
                    error: `${result.message} (retry ${retryCount}/${MAX_RETRIES})`,
                });

                const errorRetryDelay = 15 * Math.pow(2, retryCount - 1);
                ctx.traceInfo(`[orch] retrying in ${errorRetryDelay}s after turn error`);

                if (blobEnabled) {
                    yield* dehydrateAndReset("error");
                }

                yield ctx.scheduleTimer(errorRetryDelay * 1000);
                yield ctx.continueAsNew(continueInput({
                    prompt,
                    retryCount,
                    needsHydration: blobEnabled ? true : needsHydration,
                }));
                return "";
            }
        }
    }
}
