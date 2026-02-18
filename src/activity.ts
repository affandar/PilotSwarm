import type { CopilotSession } from "@github/copilot-sdk";
import type { SessionManager } from "./session-manager.js";
import type { SessionBlobStore } from "./blob-store.js";
import type { DurableSessionConfig, TurnResult, TurnInput } from "./types.js";
import {
    createSystemTools,
    mergeTools,
    type TurnState,
} from "./system-tools.js";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

/**
 * Creates the runAgentTurn activity function.
 * Closes over the SessionManager, session configs, and optionally a blob store
 * for periodic checkpointing.
 * @internal
 */
export function createRunAgentTurnActivity(
    sessionManager: SessionManager,
    sessionConfigs: Map<string, DurableSessionConfig>,
    blobStore?: SessionBlobStore | null,
    checkpointFrequencyMs = 60_000,
    dehydrateOnIdleSeconds = 15,
) {
    // Per-session idle dehydration timers (worker-scoped, survives across activities)
    const idleTimers = new Map<string, ReturnType<typeof setTimeout>>();

    return async (activityCtx: any, input: TurnInput): Promise<TurnResult> => {
        activityCtx.traceInfo(
            `[activity] session=${input.sessionId} iteration=${input.iteration}`
        );

        // Cancel any pending idle dehydration for this session
        const existingTimer = idleTimers.get(input.sessionId);
        if (existingTimer) {
            clearTimeout(existingTimer);
            idleTimers.delete(input.sessionId);
            activityCtx.traceInfo(
                `[activity] cancelled idle dehydration timer for ${input.sessionId}`
            );
        }
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

        // Start periodic checkpoint if blob store is available
        let checkpointInterval: ReturnType<typeof setInterval> | null = null;
        if (blobStore && checkpointFrequencyMs > 0) {
            checkpointInterval = setInterval(async () => {
                try {
                    await blobStore.checkpoint(input.sessionId);
                    activityCtx.traceInfo(
                        `[activity] checkpoint saved for session ${input.sessionId}`
                    );
                } catch (err: any) {
                    activityCtx.traceWarn(
                        `[activity] checkpoint failed: ${err.message}`
                    );
                }
            }, checkpointFrequencyMs);
        }

        try {
            // Get or create the Copilot SDK session.
            // Three cases:
            //   1. Warm (same worker, no dehydration): getSession returns live session
            //   2. Post-hydration (new worker): local files exist from hydrateSession → resumeSession
            //   3. Brand new: no files → createSession
            let session: CopilotSession | null =
                sessionManager.getSession(input.sessionId);

            if (!session) {
                const sessionDir = path.join(
                    os.homedir(), ".copilot", "session-state", input.sessionId
                );
                const sessionConfig = {
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
                };

                if (fs.existsSync(sessionDir)) {
                    // Post-hydration or existing local files — resume from events.jsonl
                    activityCtx.traceInfo(
                        `[activity] resuming session ${input.sessionId} from local files`
                    );
                    session = await sessionManager.resumeSession(
                        input.sessionId, sessionConfig
                    );
                } else if (blobStore && await blobStore.exists(input.sessionId)) {
                    // Session was idle-dehydrated — auto-hydrate from blob
                    activityCtx.traceInfo(
                        `[activity] auto-hydrating session ${input.sessionId} from blob`
                    );
                    await blobStore.hydrate(input.sessionId);
                    session = await sessionManager.resumeSession(
                        input.sessionId, sessionConfig
                    );
                }

                if (!session) {
                    // Brand new session
                    session = await sessionManager.createSession(sessionConfig);
                }
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

            // Schedule idle dehydration if blob is available
            const completedResult: TurnResult = {
                type: "completed",
                content: response?.data?.content ?? "(no response)",
            };

            if (blobStore && dehydrateOnIdleSeconds >= 0) {
                const sid = input.sessionId;
                const timer = setTimeout(async () => {
                    idleTimers.delete(sid);
                    try {
                        console.log(`[idle-dehydrate] session=${sid} idle for ${dehydrateOnIdleSeconds}s, dehydrating`);
                        await sessionManager.destroySession(sid);
                        await blobStore.dehydrate(sid, { reason: "idle" });
                        console.log(`[idle-dehydrate] session=${sid} dehydrated ✓`);
                    } catch (err: any) {
                        console.error(`[idle-dehydrate] session=${sid} failed: ${err.message}`);
                    }
                }, dehydrateOnIdleSeconds * 1000);
                idleTimers.set(sid, timer);
            }

            return completedResult;
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
        } finally {
            // Always stop periodic checkpointing when the turn ends
            if (checkpointInterval) {
                clearInterval(checkpointInterval);
            }
        }
    };
}

/**
 * Creates the dehydrateSession activity.
 * Saves session state to blob and removes from SessionManager.
 * @internal
 */
export function createDehydrateActivity(
    sessionManager: SessionManager,
    blobStore: SessionBlobStore,
) {
    return async (_activityCtx: any, input: { sessionId: string; reason?: string }): Promise<void> => {
        // Destroy the in-memory session (flushes writes to disk)
        await sessionManager.destroySession(input.sessionId);

        // Dehydrate to blob
        await blobStore.dehydrate(input.sessionId, { reason: input.reason });
    };
}

/**
 * Creates the hydrateSession activity.
 * Downloads session state from blob to local disk.
 * @internal
 */
export function createHydrateActivity(
    blobStore: SessionBlobStore,
) {
    return async (_activityCtx: any, input: { sessionId: string }): Promise<void> => {
        await blobStore.hydrate(input.sessionId);
    };
}
