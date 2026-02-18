import type { TurnInput, TurnResult } from "./types.js";

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

    let affinityKey: string = (input as any).affinityKey ?? input.sessionId;

    // If we continued-as-new after idle dehydration, wait for user message first
    if (awaitingMessage) {
        ctx.traceInfo("[session] awaiting next user message (post-dehydrate)");
        const msgData: any = yield ctx.waitForEvent("next-message");
        prompt = msgData.prompt;
    }

    // If we continued-as-new after input_required grace period, wait for user answer first
    if (awaitingUserInput) {
        ctx.traceInfo("[session] awaiting user input answer (post-dehydrate)");
        const eventData: any = yield ctx.waitForEvent("user-input");
        prompt = `The user was asked: "${pendingQuestion}"\nThe user responded: "${eventData.answer}"`;
    }

    while (iteration < input.maxIterations) {
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

        // ── RUN TURN ──
        ctx.traceInfo(
            `[turn ${iteration}] session=${input.sessionId} affinity=${affinityKey.slice(0, 8)} prompt="${prompt.slice(0, 80)}${prompt.length > 80 ? '...' : ''}"`
        );

        const result: TurnResult = yield ctx.scheduleActivityOnSession(
            "runAgentTurn",
            { ...input, prompt, iteration },
            affinityKey
        );

        iteration++;

        // ── HANDLE RESULT ──
        switch (result.type) {
            case "completed":
                // Emit the response for the client to read from history
                ctx.traceInfo(`[response] ${result.content}`);

                if (!blobEnabled || idleTimeout < 0) {
                    // No blob or idle disabled — wait forever, session stays warm
                    const msgData: any = yield ctx.waitForEvent("next-message");
                    prompt = msgData.prompt;
                    continue;
                }

                // Race: next user message vs idle timer
                {
                    const nextMsg = ctx.waitForEvent("next-message");
                    const idleTimer = ctx.scheduleTimer(idleTimeout * 1000);
                    const raceResult: any = yield ctx.race(nextMsg, idleTimer);

                    if (raceResult.index === 0) {
                        // User sent message within idle window — session stays warm
                        ctx.traceInfo("[session] user responded within idle window, staying warm");
                        const msgData = typeof raceResult.value === "string"
                            ? JSON.parse(raceResult.value) : raceResult.value;
                        prompt = msgData.prompt;
                        continue; // same affinityKey, same worker
                    }

                    // Idle timeout — dehydrate, then continueAsNew.
                    // The next execution will waitForEvent with a clean subscription.
                    // This avoids the orphaned subscription from the race above
                    // consuming the event meant for the next wait.
                    ctx.traceInfo("[session] idle timeout, dehydrating");
                    yield ctx.scheduleActivityOnSession(
                        "dehydrateSession",
                        { sessionId: input.sessionId, reason: "idle" },
                        affinityKey
                    );

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
                    });
                    return ""; // unreachable
                }

            case "wait":
                if (result.content) {
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

                    yield ctx.scheduleTimer(result.seconds * 1000);

                    yield ctx.continueAsNew({
                        ...input,
                        prompt: `The ${result.seconds} second wait is now complete. Continue with your task.`,
                        iteration,
                        needsHydration: shouldDehydrate,
                        awaitingMessage: false,
                        awaitingUserInput: false,
                        blobEnabled,
                        dehydrateThreshold,
                        idleTimeout,
                        inputGracePeriod,
                        affinityKey: shouldDehydrate ? undefined : affinityKey,
                    });
                    return ""; // unreachable
                }

            case "input_required":
                ctx.traceInfo(
                    `[durable-agent] Waiting for user input: ${result.question}`
                );

                if (!blobEnabled || inputGracePeriod < 0) {
                    // No blob — just wait, session stays warm
                    const eventData: any = yield ctx.waitForEvent("user-input");
                    prompt = `The user was asked: "${result.question}"\nThe user responded: "${eventData.answer}"`;
                    continue;
                }

                if (inputGracePeriod === 0) {
                    // Dehydrate immediately
                    yield ctx.scheduleActivityOnSession(
                        "dehydrateSession",
                        { sessionId: input.sessionId, reason: "input_required" },
                        affinityKey
                    );
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
                    });
                    return "";
                }

                // Race: user answer vs grace period
                {
                    ctx.traceInfo(`[durable-agent] Input grace period: ${inputGracePeriod}s`);
                    const answerEvt = ctx.waitForEvent("user-input");
                    const graceTimer = ctx.scheduleTimer(inputGracePeriod * 1000);
                    const raceResult: any = yield ctx.race(answerEvt, graceTimer);

                    if (raceResult.index === 0) {
                        // User answered fast — stay warm
                        ctx.traceInfo("[durable-agent] User answered within grace period");
                        const answerData = typeof raceResult.value === "string"
                            ? JSON.parse(raceResult.value) : raceResult.value;
                        prompt = `The user was asked: "${result.question}"\nThe user responded: "${answerData.answer}"`;
                        continue;
                    }

                    // Grace elapsed — dehydrate, then continueAsNew.
                    // New execution will waitForEvent("user-input") with a clean subscription.
                    ctx.traceInfo("[durable-agent] Grace period elapsed, dehydrating");
                    yield ctx.scheduleActivityOnSession(
                        "dehydrateSession",
                        { sessionId: input.sessionId, reason: "input_required" },
                        affinityKey
                    );
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
                    });
                    return "";
                }

            case "error":
                throw new Error(result.message);
        }
    }

    throw new Error(
        `Max iterations (${input.maxIterations}) reached for session ${input.sessionId}`
    );
}
