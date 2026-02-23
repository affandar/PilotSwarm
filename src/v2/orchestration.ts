import type {
    TurnResult,
    OrchestrationInput,
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
 * Long-lived durable session orchestration (v2).
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
export function* durableSessionOrchestration(
    ctx: any,
    input: OrchestrationInput,
): Generator<any, string, any> {
    const dehydrateThreshold = input.dehydrateThreshold ?? 30;
    const idleTimeout = input.idleTimeout ?? 30;
    const inputGracePeriod = input.inputGracePeriod ?? 30;
    const blobEnabled = input.blobEnabled ?? false;
    let needsHydration = input.needsHydration ?? false;
    let affinityKey = input.affinityKey ?? input.sessionId;
    let iteration = input.iteration ?? 0;
    let config = { ...input.config };

    // ─── Create proxies ──────────────────────────────────────
    const manager = createSessionManagerProxy(ctx);
    let session = createSessionProxy(ctx, input.sessionId, affinityKey, config);

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
            ...overrides,
        };
    }

    // ─── Helper: dehydrate + reset affinity ──────────────────
    function* dehydrateAndReset(reason: string): Generator<any, void, any> {
        yield session.dehydrate(reason);
        needsHydration = true;
        affinityKey = yield ctx.newGuid();
        session = createSessionProxy(ctx, input.sessionId, affinityKey, config);
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
                const msg: any = yield ctx.dequeueEvent("messages");
                const msgData = typeof msg === "string" ? JSON.parse(msg) : msg;

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

        ctx.traceInfo(`[turn ${iteration}] session=${input.sessionId} prompt="${prompt.slice(0, 80)}"`);

        // ② HYDRATE if session was dehydrated
        if (needsHydration && blobEnabled) {
            affinityKey = yield ctx.newGuid();
            session = createSessionProxy(ctx, input.sessionId, affinityKey, config);
            yield session.hydrate();
            needsHydration = false;
        }

        // ③ RUN TURN via SessionProxy
        setStatus(ctx, "running", { iteration });
        const turnResult: any = yield session.runTurn(prompt);
        const result: TurnResult = typeof turnResult === "string"
            ? JSON.parse(turnResult) : turnResult;
        iteration++;

        // Strip events from result before putting in customStatus (events go to CMS, not status)
        const { events: _events, ...statusResult } = result as any;

        // ④ HANDLE RESULT
        switch (result.type) {
            case "completed":
                ctx.traceInfo(`[response] ${result.content}`);

                if (!blobEnabled || idleTimeout < 0) {
                    // Store the result so the dequeue-idle setStatus includes it
                    lastTurnResult = statusResult;
                    continue;
                }

                // Race: next message vs idle timeout
                {
                    setStatus(ctx, "idle", { iteration, turnResult: statusResult });
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

                    ctx.traceInfo("[session] idle timeout, dehydrating");
                    yield* dehydrateAndReset("idle");
                    yield ctx.continueAsNew(continueInput());
                    return "";
                }

            case "wait":
                if (result.content) {
                    setStatus(ctx, "running", { iteration, intermediateContent: result.content });
                    ctx.traceInfo(`[orch] intermediate: ${result.content.slice(0, 80)}`);
                }
                ctx.traceInfo(`[orch] durable timer: ${result.seconds}s (${result.reason})`);

                {
                    const shouldDehydrate = blobEnabled && result.seconds > dehydrateThreshold;
                    if (shouldDehydrate) {
                        yield* dehydrateAndReset("timer");
                    }

                    setStatus(ctx, "waiting", {
                        iteration,
                        waitSeconds: result.seconds,
                        waitReason: result.reason,
                        ...(result.content ? { turnResult: { type: "completed", content: result.content } } : {}),
                    });

                    const timerTask = ctx.scheduleTimer(result.seconds * 1000);
                    const interruptMsg = ctx.dequeueEvent("messages");
                    const timerRace: any = yield ctx.race(timerTask, interruptMsg);

                    if (timerRace.index === 1) {
                        const interruptData = typeof timerRace.value === "string"
                            ? JSON.parse(timerRace.value) : (timerRace.value ?? {});
                        ctx.traceInfo(`[session] wait interrupted: "${(interruptData.prompt || "").slice(0, 60)}"`);
                        yield ctx.continueAsNew(continueInput({
                            prompt: interruptData.prompt,
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

            case "error":
                throw new Error(result.message);
        }
    }
}
