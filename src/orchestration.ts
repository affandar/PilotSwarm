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
 * One orchestration per copilot session. Loops: run turn → wait for
 * next message (racing idle timer) → run turn → ... until the session
 * is destroyed or max iterations reached.
 *
 * Session affinity:
 * - `affinityKey` pins activities to a worker where the copilot session
 *   lives in memory. Initially = sessionId (copilotSessionId).
 * - When idle timer or long timer fires, the orchestration dehydrates
 *   the session to blob, waits for the trigger, then continueAsNew
 *   with a new affinityKey (via ctx.newGuid()) to break old affinity.
 * - hydrateSession + runAgentTurn share the new key = co-located.
 * - The copilotSessionId (conversation identity) never changes.
 *
 * Status reporting:
 * - Custom status is set on every state transition so clients can track
 *   progress via waitForStatusChange() instead of polling history.
 * - Turn results are included in the custom status JSON so clients can
 *   read them directly without scraping execution history.
 *
 * @internal
 */
export function* durableSessionOrchestration(
    ctx: any,
    input: TurnInput
): Generator<any, string, any> {
    let { prompt, iteration } = input;
    const dehydrateThreshold = (input as any).dehydrateThreshold ?? 30;
    const idleTimeout: number = (input as any).idleTimeout ?? 30;
    const inputGracePeriod: number = (input as any).inputGracePeriod ?? 30;
    const blobEnabled = (input as any).blobEnabled ?? false;
    const needsHydration = (input as any).needsHydration ?? false;
    let hydrated = false;
    const awaitingMessage = (input as any).awaitingMessage ?? false;
    const awaitingUserInput = (input as any).awaitingUserInput ?? false;
    const pendingQuestion: string = (input as any).pendingQuestion ?? "";
    const pendingTimer = (input as any).pendingTimer ?? null;

    let affinityKey: string = (input as any).affinityKey ?? input.sessionId;

    // If we continued-as-new after idle dehydration, wait for user message first
    if (awaitingMessage) {
        setStatus(ctx, "idle", { iteration });
        ctx.traceInfo("[session] awaiting next user message (post-dehydrate)");
        const msgData: any = yield ctx.waitForEvent("next-message");
        prompt = msgData.prompt;
    }

    // If we continued-as-new after input_required grace period, wait for user answer first
    if (awaitingUserInput) {
        setStatus(ctx, "input_required", { iteration, pendingQuestion });
        ctx.traceInfo("[session] awaiting user input answer (post-dehydrate)");
        const eventData: any = yield ctx.waitForEvent("user-input");
        prompt = `The user was asked: "${pendingQuestion}"\nThe user responded: "${eventData.answer}"`;
    }

    // If we continued-as-new to run a durable timer, race it against interrupt
    // (separate execution ensures no orphaned "interrupt" subscription from turn race)
    if (pendingTimer) {
        // Include any intermediate turn result from the previous execution so
        // the client can see it (waitForStatusChange may skip rapid versions).
        const lastTurnResult = (input as any).lastTurnResult ?? null;
        setStatus(ctx, "waiting", {
            iteration,
            waitSeconds: pendingTimer.seconds,
            waitReason: pendingTimer.reason,
            ...(lastTurnResult ? { turnResult: lastTurnResult } : {}),
        });
        ctx.traceInfo(`[session] durable timer: ${pendingTimer.seconds}s — interruptible`);
        const timerTask = ctx.scheduleTimer(pendingTimer.seconds * 1000);
        const timerInterrupt = ctx.waitForEvent("interrupt");
        const timerRace: any = yield ctx.race(timerTask, timerInterrupt);

        if (timerRace.index === 1) {
            // Interrupted during wait
            const interruptData = typeof timerRace.value === "string"
                ? JSON.parse(timerRace.value) : timerRace.value;
            ctx.traceInfo(
                `[session] wait interrupted: "${(interruptData.prompt || "").slice(0, 60)}"`
            );
            yield ctx.continueAsNew({
                ...input,
                prompt: interruptData.prompt,
                iteration,
                needsHydration: pendingTimer.dehydrated,
                pendingTimer: null,
                awaitingMessage: false,
                awaitingUserInput: false,
                blobEnabled,
                dehydrateThreshold,
                idleTimeout,
                inputGracePeriod,
                affinityKey: pendingTimer.dehydrated ? undefined : affinityKey,
            });
            return "";
        }

        // Timer completed — run the next turn
        prompt = `The ${pendingTimer.seconds} second wait is now complete. Continue with your task.`;
        yield ctx.continueAsNew({
            ...input,
            prompt,
            iteration,
            needsHydration: pendingTimer.dehydrated,
            pendingTimer: null,
            awaitingMessage: false,
            awaitingUserInput: false,
            blobEnabled,
            dehydrateThreshold,
            idleTimeout,
            inputGracePeriod,
            affinityKey: pendingTimer.dehydrated ? undefined : affinityKey,
        });
        return "";
    }

    while (true) {
        // ── HYDRATE (if we were dehydrated and haven't hydrated yet) ──
        if (needsHydration && blobEnabled && !hydrated) {
            affinityKey = yield ctx.newGuid();
            yield ctx.scheduleActivityOnSession(
                "hydrateSession",
                { sessionId: input.sessionId },
                affinityKey
            );
            hydrated = true;
        }

        // ── RUN TURN (raced against interrupt) ──
        setStatus(ctx, "running", { iteration });
        ctx.traceInfo(
            `[turn ${iteration}] session=${input.sessionId} affinity=${affinityKey.slice(0, 8)} prompt="${prompt.slice(0, 80)}${prompt.length > 80 ? '...' : ''}"`
        );

        const turnTask = ctx.scheduleActivityOnSession(
            "runAgentTurn",
            { ...input, prompt, iteration },
            affinityKey
        );
        const interruptEvt = ctx.waitForEvent("interrupt");
        const turnRace: any = yield ctx.race(turnTask, interruptEvt);

        if (turnRace.index === 1) {
            // User interrupted — activity will be cancelled cooperatively.
            // continueAsNew to clean orphaned activity subscription.
            const interruptData = typeof turnRace.value === "string"
                ? JSON.parse(turnRace.value) : turnRace.value;
            ctx.traceInfo(
                `[session] interrupted by user: "${(interruptData.prompt || "").slice(0, 60)}"`
            );
            yield ctx.continueAsNew({
                ...input,
                prompt: interruptData.prompt,
                iteration: iteration + 1,
                needsHydration: false,
                awaitingMessage: false,
                awaitingUserInput: false,
                blobEnabled,
                dehydrateThreshold,
                idleTimeout,
                inputGracePeriod,
                affinityKey, // same worker — session is still warm
            });
            return ""; // unreachable
        }

        // Activity completed — parse result
        const result: TurnResult = typeof turnRace.value === "string"
            ? JSON.parse(turnRace.value) : turnRace.value;

        iteration++;

        // ── HANDLE RESULT ──
        switch (result.type) {
            case "completed":
                ctx.traceInfo(`[response] ${result.content}`);

                if (!blobEnabled || idleTimeout < 0) {
                    // No blob or idle disabled — wait forever, session stays warm
                    setStatus(ctx, "idle", { iteration, turnResult: result });
                    const msgData: any = yield ctx.waitForEvent("next-message");
                    prompt = msgData.prompt;
                    continue;
                }

                // Race: next user message vs idle timer
                {
                    setStatus(ctx, "idle", { iteration, turnResult: result });
                    const nextMsg = ctx.waitForEvent("next-message");
                    const idleTimer = ctx.scheduleTimer(idleTimeout * 1000);
                    const raceResult: any = yield ctx.race(nextMsg, idleTimer);

                    if (raceResult.index === 0) {
                        ctx.traceInfo("[session] user responded within idle window, staying warm");
                        const msgData = typeof raceResult.value === "string"
                            ? JSON.parse(raceResult.value) : raceResult.value;

                        yield ctx.continueAsNew({
                            ...input,
                            prompt: msgData.prompt,
                            iteration,
                            needsHydration: false,
                            awaitingMessage: false,
                            awaitingUserInput: false,
                            blobEnabled,
                            dehydrateThreshold,
                            idleTimeout,
                            inputGracePeriod,
                            affinityKey, // same worker
                        });
                        return ""; // unreachable
                    }

                    // Idle timeout — dehydrate, then continueAsNew.
                    ctx.traceInfo("[session] idle timeout, dehydrating");
                    yield ctx.scheduleActivityOnSession(
                        "dehydrateSession",
                        { sessionId: input.sessionId, reason: "idle" },
                        affinityKey
                    );

                    // Fresh affinity key — next hydration lands on any available worker
                    const newAffinityIdle: string = yield ctx.newGuid();

                    yield ctx.continueAsNew({
                        ...input,
                        prompt: "", // placeholder — overwritten by waitForEvent in next execution
                        iteration,
                        needsHydration: true,
                        awaitingMessage: true,
                        awaitingUserInput: false,
                        blobEnabled,
                        dehydrateThreshold,
                        idleTimeout,
                        inputGracePeriod,
                        affinityKey: newAffinityIdle,
                    });
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
                        yield ctx.scheduleActivityOnSession(
                            "dehydrateSession",
                            { sessionId: input.sessionId, reason: "timer" },
                            affinityKey
                        );
                    }

                    // Fresh affinity key if dehydrated — next hydration lands on any worker
                    const timerAffinityKey: string = shouldDehydrate
                        ? yield ctx.newGuid()
                        : affinityKey;

                    yield ctx.continueAsNew({
                        ...input,
                        prompt: "",
                        iteration,
                        needsHydration: false,
                        pendingTimer: { seconds: result.seconds, dehydrated: shouldDehydrate, reason: result.reason },
                        awaitingMessage: false,
                        awaitingUserInput: false,
                        blobEnabled,
                        dehydrateThreshold,
                        idleTimeout,
                        inputGracePeriod,
                        affinityKey: timerAffinityKey,
                        // Carry turnResult + intermediateContent into the continueAsNew
                        // input so the preamble can include them in the "waiting" status.
                        // This ensures the client sees them even if rapid status changes
                        // cause version skips in waitForStatusChange.
                        lastTurnResult: result.content ? { type: "completed", content: result.content } : undefined,
                    });
                    return ""; // unreachable
                }

            case "input_required":
                ctx.traceInfo(
                    `[durable-agent] Waiting for user input: ${result.question}`
                );

                if (!blobEnabled || inputGracePeriod < 0) {
                    // No blob — just wait, session stays warm
                    setStatus(ctx, "input_required", {
                        iteration,
                        turnResult: result,
                        pendingQuestion: result.question,
                        choices: result.choices,
                        allowFreeform: result.allowFreeform,
                    });
                    const eventData: any = yield ctx.waitForEvent("user-input");
                    prompt = `The user was asked: "${result.question}"\nThe user responded: "${eventData.answer}"`;
                    continue;
                }

                if (inputGracePeriod === 0) {
                    // Dehydrate immediately
                    setStatus(ctx, "input_required", {
                        iteration,
                        turnResult: result,
                        pendingQuestion: result.question,
                    });
                    yield ctx.scheduleActivityOnSession(
                        "dehydrateSession",
                        { sessionId: input.sessionId, reason: "input_required" },
                        affinityKey
                    );

                    // Fresh affinity key — next hydration lands on any worker
                    const newAffinityInput: string = yield ctx.newGuid();

                    const eventData: any = yield ctx.waitForEvent("user-input");
                    yield ctx.continueAsNew({
                        ...input,
                        prompt: `The user was asked: "${result.question}"\nThe user responded: "${eventData.answer}"`,
                        iteration,
                        needsHydration: true,
                        awaitingMessage: false,
                        awaitingUserInput: false,
                        blobEnabled,
                        dehydrateThreshold,
                        idleTimeout,
                        inputGracePeriod,
                        affinityKey: newAffinityInput,
                    });
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
                    const answerEvt = ctx.waitForEvent("user-input");
                    const graceTimer = ctx.scheduleTimer(inputGracePeriod * 1000);
                    const raceResult: any = yield ctx.race(answerEvt, graceTimer);

                    if (raceResult.index === 0) {
                        ctx.traceInfo("[durable-agent] User answered within grace period");
                        const answerData = typeof raceResult.value === "string"
                            ? JSON.parse(raceResult.value) : raceResult.value;
                        prompt = `The user was asked: "${result.question}"\nThe user responded: "${answerData.answer}"`;
                        continue;
                    }

                    // Grace elapsed — dehydrate, then continueAsNew.
                    ctx.traceInfo("[durable-agent] Grace period elapsed, dehydrating");
                    yield ctx.scheduleActivityOnSession(
                        "dehydrateSession",
                        { sessionId: input.sessionId, reason: "input_required" },
                        affinityKey
                    );

                    // Fresh affinity key — next hydration lands on any worker
                    const newAffinityGrace: string = yield ctx.newGuid();

                    yield ctx.continueAsNew({
                        ...input,
                        prompt: "", // placeholder
                        iteration,
                        needsHydration: true,
                        awaitingMessage: false,
                        awaitingUserInput: true,
                        pendingQuestion: result.question,
                        blobEnabled,
                        dehydrateThreshold,
                        idleTimeout,
                        inputGracePeriod,
                        affinityKey: newAffinityGrace,
                    });
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
