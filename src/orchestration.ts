import type { TurnInput, TurnResult } from "./types.js";

/**
 * The durable agent orchestration.
 *
 * Each sendAndWait() creates one of these. It runs the LLM turn via
 * the runAgentTurn activity, handles wait/timer loops, and returns
 * the final response.
 *
 * @internal
 */
export function* durableTurnOrchestration(
    ctx: any,
    input: TurnInput
): Generator<any, string, any> {
    let { prompt, iteration } = input;

    while (iteration < input.maxIterations) {
        ctx.traceInfo(
            `[turn ${iteration}] session=${input.sessionId} prompt="${prompt.slice(0, 80)}${prompt.length > 80 ? '...' : ''}"`
        );

        const result: TurnResult = yield ctx.scheduleActivity(
            "runAgentTurn",
            { ...input, prompt, iteration }
        );

        switch (result.type) {
            case "completed":
                return result.content;

            case "wait":
                // Emit intermediate content before scheduling timer
                if (result.content) {
                    ctx.traceInfo(
                        `[durable-agent] Intermediate content: ${result.content.slice(0, 80)}...`
                    );
                }
                ctx.traceInfo(
                    `[durable-agent] Durable timer: ${result.seconds}s (${result.reason})`
                );
                yield ctx.scheduleTimer(result.seconds * 1000);
                prompt = `The ${result.seconds} second wait is now complete. Continue with your task.`;
                iteration++;
                break;

            case "input_required": {
                ctx.traceInfo(
                    `[durable-agent] Waiting for user input: ${result.question}`
                );
                const eventData: any = yield ctx.waitForEvent("user-input");
                prompt = `The user was asked: "${result.question}"\nThe user responded: "${eventData.answer}"`;
                iteration++;
                break;
            }

            case "error":
                throw new Error(result.message);
        }

        // Truncate orchestration history to avoid unbounded growth
        yield ctx.continueAsNew({
            ...input,
            prompt,
            iteration,
        });
    }

    throw new Error(
        `Max iterations (${input.maxIterations}) reached for session ${input.sessionId}`
    );
}
