import type { TurnInput, TurnResult, DurableSessionStatus } from "./types.js";

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
 * One orchestration per copilot session. Uses a single FIFO event queue
 * ("messages") for all client→orchestration communication: user prompts,
 * interrupts, and user-input answers all go through the same queue.
 *
 * Main loop:
 *   ① Dequeue message from "messages" queue
 *   ② Hydrate from blob if needed (after dehydration)
 *   ③ Run LLM turn via activity (pinned to session-owning worker)
 *   ④ Handle result: completed → idle wait, wait → timer, input → wait for answer
 *
 * Session affinity:
 * - `affinityKey` pins activities to a worker where the copilot session
 *   lives in memory. Initially = sessionId.
 * - After dehydration, affinityKey is reset (newGuid) so the next
 *   hydration can land on any available worker.
 *
 * Event queue vs waitForEvent:
 * - dequeueEvent("messages") is a persistent FIFO mailbox that survives
 *   continueAsNew boundaries. Messages sent while the orchestration is
 *   busy (e.g., running a turn) are queued and delivered in order.
 * - This eliminates the need for separate "interrupt", "next-message",
 *   and "user-input" event types — one queue handles all.
 *
 * @internal
 */
export function* durableSessionOrchestration(
    ctx: any,
    input: TurnInput
): Generator<any, string, any> {
    const dehydrateThreshold = (input as any).dehydrateThreshold ?? 30;
    const idleTimeout: number = (input as any).idleTimeout ?? 30;
    const inputGracePeriod: number = (input as any).inputGracePeriod ?? 30;
    const blobEnabled = (input as any).blobEnabled ?? false;
    let needsHydration = (input as any).needsHydration ?? false;
    let affinityKey: string = (input as any).affinityKey ?? input.sessionId;
    let iteration: number = (input as any).iteration ?? 0;

    // ─── Shared continueAsNew input builder ──────────────────────
    function continueInput(overrides: Record<string, unknown> = {}) {
        return {
            sessionId: input.sessionId,
            waitThreshold: input.waitThreshold,
            systemMessage: (input as any).systemMessage,
            model: (input as any).model,
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

    // ─── Helper: dehydrate + reset affinity ──────────────────────
    function* dehydrate(reason: string): Generator<any, void, any> {
        yield ctx.scheduleActivityOnSession(
            "dehydrateSession",
            { sessionId: input.sessionId, reason },
            affinityKey
        );
        needsHydration = true;
        affinityKey = yield ctx.newGuid();
    }

    // ─── MAIN LOOP ──────────────────────────────────────────────
    while (true) {
        // ① DEQUEUE MESSAGE
        setStatus(ctx, "idle", { iteration });
        const msg: any = yield ctx.dequeueEvent("messages");
        const msgData = typeof msg === "string" ? JSON.parse(msg) : msg;
        let prompt: string = msgData.prompt;

        ctx.traceInfo(
            `[turn ${iteration}] session=${input.sessionId} affinity=${affinityKey.slice(0, 8)} prompt="${prompt.slice(0, 80)}${prompt.length > 80 ? "..." : ""}"`
        );

        // ② HYDRATE (if session was dehydrated to blob)
        if (needsHydration && blobEnabled) {
            affinityKey = yield ctx.newGuid();
            yield ctx.scheduleActivityOnSession(
                "hydrateSession",
                { sessionId: input.sessionId },
                affinityKey
            );
            needsHydration = false;
        }

        // ③ RUN TURN
        setStatus(ctx, "running", { iteration });
        const turnResult: any = yield ctx.scheduleActivityOnSession(
            "runAgentTurn",
            { ...input, prompt, iteration },
            affinityKey
        );
        const result: TurnResult = typeof turnResult === "string"
            ? JSON.parse(turnResult) : turnResult;
        iteration++;

        // ④ HANDLE RESULT
        switch (result.type) {
            case "completed":
                ctx.traceInfo(`[response] ${result.content}`);

                if (!blobEnabled || idleTimeout < 0) {
                    // No blob or idle disabled — stay warm, loop back to ① (dequeue)
                    setStatus(ctx, "idle", { iteration, turnResult: result });
                    continue;
                }

                // Race: next message vs idle timeout
                {
                    setStatus(ctx, "idle", { iteration, turnResult: result });
                    const nextMsg = ctx.dequeueEvent("messages");
                    const idleTimer = ctx.scheduleTimer(idleTimeout * 1000);
                    const raceResult: any = yield ctx.race(nextMsg, idleTimer);

                    if (raceResult.index === 0) {
                        // User sent a message within idle window — stay warm
                        ctx.traceInfo("[session] user responded within idle window, staying warm");
                        // continueAsNew to keep history bounded
                        const raceMsg = typeof raceResult.value === "string"
                            ? JSON.parse(raceResult.value) : raceResult.value;
                        yield ctx.continueAsNew(continueInput({
                            prompt: raceMsg.prompt,
                        }));
                        return ""; // unreachable
                    }

                    // Idle timeout — dehydrate, then continueAsNew.
                    // Next dequeue will hydrate on any available worker.
                    ctx.traceInfo("[session] idle timeout, dehydrating");
                    yield* dehydrate("idle");
                    yield ctx.continueAsNew(continueInput());
                    return ""; // unreachable
                }

            case "wait":
                if (result.content) {
                    setStatus(ctx, "running", { iteration, intermediateContent: result.content });
                    ctx.traceInfo(
                        `[durable-agent] Intermediate content: ${result.content.slice(0, 80)}...`
                    );
                }
                ctx.traceInfo(
                    `[durable-agent] Durable timer: ${result.seconds}s (${result.reason})`
                );

                {
                    const shouldDehydrate = blobEnabled && result.seconds > dehydrateThreshold;
                    if (shouldDehydrate) {
                        yield* dehydrate("timer");
                    }

                    setStatus(ctx, "waiting", {
                        iteration,
                        waitSeconds: result.seconds,
                        waitReason: result.reason,
                        ...(result.content ? { turnResult: { type: "completed", content: result.content } } : {}),
                    });

                    // Race: timer vs next message (interrupt)
                    const timerTask = ctx.scheduleTimer(result.seconds * 1000);
                    const interruptMsg = ctx.dequeueEvent("messages");
                    const timerRace: any = yield ctx.race(timerTask, interruptMsg);

                    if (timerRace.index === 1) {
                        // Message arrived during wait — treat as interrupt
                        const interruptData = typeof timerRace.value === "string"
                            ? JSON.parse(timerRace.value) : timerRace.value;
                        ctx.traceInfo(
                            `[session] wait interrupted: "${(interruptData.prompt || "").slice(0, 60)}"`
                        );
                        if (shouldDehydrate) {
                            // Already dehydrated — continueAsNew with hydration
                            yield ctx.continueAsNew(continueInput({
                                prompt: interruptData.prompt,
                            }));
                            return "";
                        }
                        // Still warm — loop to ③ (but we need continueAsNew to keep history bounded)
                        yield ctx.continueAsNew(continueInput({
                            prompt: interruptData.prompt,
                            needsHydration: false,
                        }));
                        return "";
                    }

                    // Timer completed
                    const timerPrompt = `The ${result.seconds} second wait is now complete. Continue with your task.`;
                    if (shouldDehydrate) {
                        yield ctx.continueAsNew(continueInput({
                            prompt: timerPrompt,
                        }));
                        return "";
                    }
                    // Still warm — continueAsNew to keep history bounded
                    yield ctx.continueAsNew(continueInput({
                        prompt: timerPrompt,
                        needsHydration: false,
                    }));
                    return "";
                }

            case "input_required":
                ctx.traceInfo(
                    `[durable-agent] Waiting for user input: ${result.question}`
                );

                if (!blobEnabled || inputGracePeriod < 0) {
                    // No blob — just wait on queue, session stays warm
                    setStatus(ctx, "input_required", {
                        iteration,
                        turnResult: result,
                        pendingQuestion: result.question,
                        choices: result.choices,
                        allowFreeform: result.allowFreeform,
                    });
                    const answerMsg: any = yield ctx.dequeueEvent("messages");
                    const answerData = typeof answerMsg === "string"
                        ? JSON.parse(answerMsg) : answerMsg;
                    // continueAsNew to keep history bounded
                    yield ctx.continueAsNew(continueInput({
                        prompt: `The user was asked: "${result.question}"\nThe user responded: "${answerData.answer}"`,
                        needsHydration: false,
                    }));
                    return "";
                }

                if (inputGracePeriod === 0) {
                    // Dehydrate immediately
                    setStatus(ctx, "input_required", {
                        iteration,
                        turnResult: result,
                        pendingQuestion: result.question,
                    });
                    yield* dehydrate("input_required");

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
                        turnResult: result,
                        pendingQuestion: result.question,
                        choices: result.choices,
                        allowFreeform: result.allowFreeform,
                    });
                    ctx.traceInfo(`[durable-agent] Input grace period: ${inputGracePeriod}s`);
                    const answerEvt = ctx.dequeueEvent("messages");
                    const graceTimer = ctx.scheduleTimer(inputGracePeriod * 1000);
                    const raceResult: any = yield ctx.race(answerEvt, graceTimer);

                    if (raceResult.index === 0) {
                        ctx.traceInfo("[durable-agent] User answered within grace period");
                        const answerData = typeof raceResult.value === "string"
                            ? JSON.parse(raceResult.value) : raceResult.value;
                        yield ctx.continueAsNew(continueInput({
                            prompt: `The user was asked: "${result.question}"\nThe user responded: "${answerData.answer}"`,
                            needsHydration: false,
                        }));
                        return "";
                    }

                    // Grace elapsed — dehydrate, then wait for answer
                    ctx.traceInfo("[durable-agent] Grace period elapsed, dehydrating");
                    yield* dehydrate("input_required");

                    const answerMsg: any = yield ctx.dequeueEvent("messages");
                    const answerData = typeof answerMsg === "string"
                        ? JSON.parse(answerMsg) : answerMsg;
                    yield ctx.continueAsNew(continueInput({
                        prompt: `The user was asked: "${result.question}"\nThe user responded: "${answerData.answer}"`,
                    }));
                    return "";
                }

            case "cancelled":
                ctx.traceInfo("[session] activity self-cancelled");
                continue;

            case "error":
                throw new Error(result.message);
        }
    }
}
