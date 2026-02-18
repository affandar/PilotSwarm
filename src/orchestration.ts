import type { TurnInput, TurnResult } from "./types.js";

/**
 * The durable agent orchestration.
 *
 * Each sendAndWait() creates one of these. It runs the LLM turn via
 * the runAgentTurn activity, handles wait/timer loops with session
 * dehydration/hydration, and returns the final response.
 *
 * Session affinity:
 * - `affinityKey` pins activities to a worker. Initially = sessionId.
 * - After dehydration, a new affinityKey is generated via ctx.newGuid()
 *   to break old affinity. hydrateSession + runAgentTurn both use the
 *   new key, guaranteeing co-location on the new worker.
 * - The Copilot sessionId (conversation identity) never changes.
 *
 * @internal
 */
export function* durableTurnOrchestration(
    ctx: any,
    input: TurnInput
): Generator<any, string, any> {
    let { prompt, iteration } = input;
    const dehydrateThreshold = (input as any).dehydrateThreshold ?? 30;
    const dehydrateOnInputRequired: number = (input as any).dehydrateOnInputRequired ?? 15;
    const blobEnabled = (input as any).blobEnabled ?? false;
    const needsHydration = (input as any).needsHydration ?? false;

    // Affinity key — determines which worker runs activities.
    // After dehydration, we generate a new key to break old affinity.
    let affinityKey: string = (input as any).affinityKey ?? input.sessionId;

    while (iteration < input.maxIterations) {
        // Hydrate from blob if session was dehydrated in a previous execution
        if (needsHydration && blobEnabled) {
            affinityKey = yield ctx.newGuid();
            yield ctx.scheduleActivityOnSession(
                "hydrateSession",
                { sessionId: input.sessionId },
                affinityKey
            );
        }

        ctx.traceInfo(
            `[turn ${iteration}] session=${input.sessionId} affinity=${affinityKey.slice(0, 8)} prompt="${prompt.slice(0, 80)}${prompt.length > 80 ? '...' : ''}"`
        );

        const result: TurnResult = yield ctx.scheduleActivityOnSession(
            "runAgentTurn",
            { ...input, prompt, iteration },
            affinityKey
        );

        switch (result.type) {
            case "completed":
                return result.content;

            case "wait":
                if (result.content) {
                    ctx.traceInfo(
                        `[durable-agent] Intermediate content: ${result.content.slice(0, 80)}...`
                    );
                }
                ctx.traceInfo(
                    `[durable-agent] Durable timer: ${result.seconds}s (${result.reason})`
                );

                const shouldDehydrateWait = blobEnabled && result.seconds > dehydrateThreshold;
                if (shouldDehydrateWait) {
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
                    iteration: iteration + 1,
                    needsHydration: shouldDehydrateWait,
                    dehydrateThreshold,
                    dehydrateOnInputRequired,
                    blobEnabled,
                    // affinityKey intentionally NOT passed — new one generated on hydration
                });
                return ""; // unreachable — continueAsNew restarts the orchestration

            case "input_required": {
                ctx.traceInfo(
                    `[durable-agent] Waiting for user input: ${result.question}`
                );

                const canDehydrateInput = blobEnabled && dehydrateOnInputRequired >= 0;

                if (canDehydrateInput && dehydrateOnInputRequired === 0) {
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
                        iteration: iteration + 1,
                        needsHydration: true,
                        dehydrateThreshold,
                        dehydrateOnInputRequired,
                        blobEnabled,
                    });
                    return "";
                }

                if (canDehydrateInput && dehydrateOnInputRequired > 0) {
                    // Race: user input vs grace period timer
                    ctx.traceInfo(
                        `[durable-agent] Dehydration grace period: ${dehydrateOnInputRequired}s`
                    );
                    const inputEvent = ctx.waitForEvent("user-input");
                    const graceTimer = ctx.scheduleTimer(dehydrateOnInputRequired * 1000);
                    const raceResult: any = yield ctx.race(inputEvent, graceTimer);

                    if (raceResult.index === 0) {
                        // User responded within grace period — no dehydration
                        ctx.traceInfo("[durable-agent] User responded within grace period, skipping dehydration");
                        yield ctx.continueAsNew({
                            ...input,
                            prompt: `The user was asked: "${result.question}"\nThe user responded: "${raceResult.value.answer}"`,
                            iteration: iteration + 1,
                            needsHydration: false,
                            dehydrateThreshold,
                            dehydrateOnInputRequired,
                            blobEnabled,
                        });
                        return "";
                    }

                    // Grace period elapsed — dehydrate, then wait for input
                    ctx.traceInfo("[durable-agent] Grace period elapsed, dehydrating");
                    yield ctx.scheduleActivityOnSession(
                        "dehydrateSession",
                        { sessionId: input.sessionId, reason: "input_required" },
                        affinityKey
                    );
                    const eventData: any = yield ctx.waitForEvent("user-input");
                    yield ctx.continueAsNew({
                        ...input,
                        prompt: `The user was asked: "${result.question}"\nThe user responded: "${eventData.answer}"`,
                        iteration: iteration + 1,
                        needsHydration: true,
                        dehydrateThreshold,
                        dehydrateOnInputRequired,
                        blobEnabled,
                    });
                    return "";
                }

                // No dehydration — just wait for input
                const eventData: any = yield ctx.waitForEvent("user-input");

                yield ctx.continueAsNew({
                    ...input,
                    prompt: `The user was asked: "${result.question}"\nThe user responded: "${eventData.answer}"`,
                    iteration: iteration + 1,
                    needsHydration: false,
                    dehydrateThreshold,
                    dehydrateOnInputRequired,
                    blobEnabled,
                });
                return ""; // unreachable — continueAsNew restarts the orchestration
            }

            case "error":
                throw new Error(result.message);
        }
    }

    throw new Error(
        `Max iterations (${input.maxIterations}) reached for session ${input.sessionId}`
    );
}
