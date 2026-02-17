import type { CopilotSession } from "@github/copilot-sdk";
import type { SessionManager } from "./session-manager.js";
import type { DurableSessionConfig, TurnResult, TurnInput } from "./types.js";
import {
    createSystemTools,
    mergeTools,
    type TurnState,
} from "./system-tools.js";

/**
 * Creates the runAgentTurn activity function.
 * Closes over the SessionManager and session configs (Phase 1: same process).
 * @internal
 */
export function createRunAgentTurnActivity(
    sessionManager: SessionManager,
    sessionConfigs: Map<string, DurableSessionConfig>
) {
    return async (activityCtx: any, input: TurnInput): Promise<TurnResult> => {
        activityCtx.traceInfo(
            `[activity] session=${input.sessionId} iteration=${input.iteration}`
        );
        const config = sessionConfigs.get(input.sessionId);
        // In scaled mode, workers don't have the in-memory config — use
        // the systemMessage/model from TurnInput which travels through the store.
        const effectiveConfig: DurableSessionConfig = config ?? {
            systemMessage: input.systemMessage ?? "You are a helpful assistant.",
            model: input.model,
        };
        if (!config && !input.systemMessage) {
            activityCtx.traceInfo(
                `[activity] no config for session ${input.sessionId}, using defaults (scaled mode)`
            );
        }

        // Mutable state shared with the wait tool handler
        const turnState: TurnState = {
            pendingWait: null,
            pendingInput: null,
            session: null,
            waitThreshold: input.waitThreshold,
        };

        // Create system tools bound to this turn's state
        const systemTools = createSystemTools(turnState);
        const allTools = mergeTools(effectiveConfig.tools ?? [], systemTools);

        // If user provided onUserInputRequest, intercept it for durable flow:
        // abort the session and return input_required to the orchestration,
        // which then waits for an external event carrying the user's answer.
        const onUserInputRequest = effectiveConfig.onUserInputRequest
            ? async (request: any) => {
                  turnState.pendingInput = {
                      question: request.question,
                      choices: request.choices,
                      allowFreeform: request.allowFreeform,
                  };
                  if (turnState.session) {
                      turnState.session.abort();
                  }
                  return { answer: "", wasFreeform: false };
              }
            : undefined;

        try {
            // Get or create the Copilot SDK session
            let session: CopilotSession | null =
                sessionManager.getSession(input.sessionId);

            if (!session) {
                session = await sessionManager.createSession({
                    sessionId: input.sessionId,
                    tools: allTools,
                    model: effectiveConfig.model,
                    systemMessage:
                        typeof effectiveConfig.systemMessage === "string"
                            ? { content: effectiveConfig.systemMessage }
                            : effectiveConfig.systemMessage,
                    workingDirectory: effectiveConfig.workingDirectory,
                    onUserInputRequest,
                    hooks: effectiveConfig.hooks,
                    infiniteSessions: { enabled: false },
                });
            } else {
                // Re-register tools for this turn (tools include fresh turnState refs)
                session.registerTools(allTools);
            }

            turnState.session = session;

            // Run one LLM turn
            const response = await session.sendAndWait(
                { prompt: input.prompt },
                300_000 // 5 min timeout per turn
            );

            // Check if user input was requested (same pattern as wait tool)
            if (turnState.pendingInput) {
                return {
                    type: "input_required",
                    ...turnState.pendingInput,
                };
            }

            // Check if the wait tool fired and aborted
            if (turnState.pendingWait) {
                return {
                    type: "wait",
                    seconds: turnState.pendingWait.seconds,
                    reason: turnState.pendingWait.reason,
                    content: response?.data?.content,
                };
            }

            return {
                type: "completed",
                content: response?.data?.content ?? "(no response)",
            };
        } catch (err: any) {
            // If abort was caused by user input request
            if (turnState.pendingInput) {
                return {
                    type: "input_required",
                    ...turnState.pendingInput,
                };
            }

            // If abort was caused by our wait tool, that's expected
            if (turnState.pendingWait) {
                // Try to capture what the LLM said before calling wait
                let content: string | undefined;
                try {
                    const msgs = await turnState.session!.getMessages();
                    for (let i = msgs.length - 1; i >= 0; i--) {
                        const m = msgs[i] as any;
                        if (m.type === "assistant" && m.content) {
                            content = typeof m.content === "string"
                                ? m.content
                                : m.content.content ?? m.content.text;
                            break;
                        }
                    }
                } catch {}
                return {
                    type: "wait",
                    seconds: turnState.pendingWait.seconds,
                    reason: turnState.pendingWait.reason,
                    content,
                };
            }

            return {
                type: "error",
                message: err.message ?? String(err),
            };
        }
    };
}
