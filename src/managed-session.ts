import { defineTool, type Tool, type CopilotSession } from "@github/copilot-sdk";
import type { TurnResult, TurnOptions, ManagedSessionConfig, CapturedEvent } from "./types.js";

/**
 * Mutable state shared between the wait tool handler and runTurn().
 * @internal
 */
interface TurnState {
    pendingWait: { seconds: number; reason: string } | null;
    pendingInput: { question: string; choices?: string[]; allowFreeform?: boolean } | null;
    session: CopilotSession | null;
    waitThreshold: number;
}

/**
 * ManagedSession — wraps a CopilotSession and provides the interface
 * that the orchestration calls into (via SessionProxy).
 *
 * Key design decisions:
 *  1. Uses send() + on() internally, never sendAndWait().
 *  2. runTurn() returns a TurnResult to the orchestration — the orchestration
 *     decides what to do with wait/input_required/completed.
 *  3. The session stays alive in memory across runTurn() calls.
 *  4. Abort is cooperative — the orchestration cancels via race, which
 *     triggers abort() on this session.
 *
 * @internal
 */
export class ManagedSession {
    readonly sessionId: string;
    private copilotSession: CopilotSession;
    private config: ManagedSessionConfig;

    constructor(
        sessionId: string,
        copilotSession: CopilotSession,
        config: ManagedSessionConfig,
    ) {
        this.sessionId = sessionId;
        this.copilotSession = copilotSession;
        this.config = config;
    }

    /**
     * System tool definitions for session creation.
     * These are registered at createSession time so the LLM sees them.
     * Handlers are placeholder stubs — real handlers are set per-turn in runTurn().
     */
    static systemToolDefs(): Tool<any>[] {
        const waitTool = defineTool("wait", {
            description:
                "REQUIRED: The ONLY way to wait, pause, sleep, or delay. " +
                "You MUST call this tool whenever you need to wait, pause, delay, " +
                "poll, check back later, schedule a future action, or implement " +
                "any recurring/periodic task. NEVER use bash sleep, setTimeout, " +
                "setInterval, cron, or any other timing mechanism. This tool " +
                "enables durable waiting that survives process restarts.",
            parameters: {
                type: "object",
                properties: {
                    seconds: { type: "number", description: "How long to wait in seconds" },
                    reason: { type: "string", description: "Why you're waiting" },
                },
                required: ["seconds"],
            },
            handler: async () => "stub",
        });

        const askUserTool = defineTool("ask_user", {
            description:
                "Ask the user a question and wait for their response. " +
                "Use this when you need clarification or user input before proceeding.",
            parameters: {
                type: "object",
                properties: {
                    question: { type: "string", description: "The question to ask the user" },
                    choices: {
                        type: "array",
                        items: { type: "string" },
                        description: "Optional list of choices for the user",
                    },
                    allowFreeform: {
                        type: "boolean",
                        description: "Whether to allow freeform text input (default: true)",
                    },
                },
                required: ["question"],
            },
            handler: async () => "stub",
        });

        return [waitTool, askUserTool];
    }

    /**
     * Run one LLM turn.
     *
     * The wait tool is injected automatically. If the LLM calls wait()
     * with seconds > waitThreshold, we abort the session and return
     * a "wait" result so the orchestration can schedule a durable timer.
     *
     * Similarly, if onUserInputRequest fires, we abort and return
     * "input_required" so the orchestration can wait for the user's answer.
     */
    async runTurn(prompt: string, opts?: TurnOptions): Promise<TurnResult> {
        const turnState: TurnState = {
            pendingWait: null,
            pendingInput: null,
            session: this.copilotSession,
            waitThreshold: this.config.waitThreshold ?? 30,
        };

        // Build system tools (wait tool + ask_user tool)
        const waitTool = defineTool("wait", {
            description:
                "REQUIRED: The ONLY way to wait, pause, sleep, or delay. " +
                "You MUST call this tool whenever you need to wait, pause, delay, " +
                "poll, check back later, schedule a future action, or implement " +
                "any recurring/periodic task. NEVER use bash sleep, setTimeout, " +
                "setInterval, cron, or any other timing mechanism. This tool " +
                "enables durable waiting that survives process restarts.",
            parameters: {
                type: "object",
                properties: {
                    seconds: { type: "number", description: "How long to wait in seconds" },
                    reason: { type: "string", description: "Why you're waiting" },
                },
                required: ["seconds"],
            },
            handler: async (args: { seconds: number; reason?: string }) => {
                const reason = args.reason ?? "unspecified";
                if (args.seconds <= turnState.waitThreshold) {
                    await new Promise(r => setTimeout(r, args.seconds * 1000));
                    return `Waited for ${args.seconds} seconds. The wait is complete, you may continue.`;
                }
                turnState.pendingWait = { seconds: args.seconds, reason };
                if (turnState.session) turnState.session.abort();
                return "aborted";
            },
        });

        const askUserTool = defineTool("ask_user", {
            description:
                "Ask the user a question and wait for their response. " +
                "Use this when you need clarification or user input before proceeding.",
            parameters: {
                type: "object",
                properties: {
                    question: { type: "string", description: "The question to ask the user" },
                    choices: {
                        type: "array",
                        items: { type: "string" },
                        description: "Optional list of choices for the user",
                    },
                    allowFreeform: {
                        type: "boolean",
                        description: "Whether to allow freeform text input (default: true)",
                    },
                },
                required: ["question"],
            },
            handler: async (args: { question: string; choices?: string[]; allowFreeform?: boolean }) => {
                turnState.pendingInput = {
                    question: args.question,
                    choices: args.choices,
                    allowFreeform: args.allowFreeform ?? true,
                };
                if (turnState.session) turnState.session.abort();
                return "aborted";
            },
        });

        // Merge user tools with system tools
        const userTools = this.config.tools ?? [];
        const allTools: Tool<any>[] = [
            ...userTools.filter(t => {
                const name = (t as any).name;
                return name !== "wait" && name !== "ask_user";
            }),
            waitTool,
            askUserTool,
        ];

        // Re-register tools for this turn (may have changed)
        this.copilotSession.registerTools(allTools);

        // Collect the final assistant content and all events via on()
        let finalContent: string | undefined;
        const collectedEvents: CapturedEvent[] = [];
        const unsubscribers: (() => void)[] = [];

        const turnComplete = new Promise<void>((resolve, reject) => {
            // Catch-all event handler — captures every event and fires onEvent immediately.
            unsubscribers.push(
                this.copilotSession.on((event: any) => {
                    const eventType = event.type ?? event.eventType ?? "unknown";
                    const captured: CapturedEvent = { eventType, data: event.data ?? event };
                    collectedEvents.push(captured);
                    // Fire immediately so callers can write to CMS in real-time
                    if (opts?.onEvent) {
                        try { opts.onEvent(captured); } catch {}
                    }
                }),
            );

            // Capture the final assistant message
            unsubscribers.push(
                this.copilotSession.on("assistant.message", (event: any) => {
                    finalContent = event.data?.content ?? finalContent;
                }),
            );

            // Stream deltas to the caller if requested
            if (opts?.onDelta) {
                unsubscribers.push(
                    this.copilotSession.on("assistant.message_delta", (event: any) => {
                        if (event.data?.deltaContent) {
                            opts.onDelta!(event.data.deltaContent);
                        }
                    }),
                );
            }

            // Notify caller of tool execution starts
            if (opts?.onToolStart) {
                unsubscribers.push(
                    this.copilotSession.on("tool.execution_start", (event: any) => {
                        opts.onToolStart!(event.data?.toolName ?? "unknown", event.data?.toolArgs);
                    }),
                );
            }

            // session.idle = turn finished (normal completion or post-abort)
            unsubscribers.push(
                this.copilotSession.on("session.idle", () => {
                    resolve();
                }),
            );
        });

        // Set up a timeout race — configurable via env to support long tool calls
        const TURN_TIMEOUT = parseInt(process.env.TURN_TIMEOUT_MS ?? "300000", 10);
        const timeoutPromise = new Promise<void>((_, reject) => {
            setTimeout(() => reject(new Error("Turn timed out")), TURN_TIMEOUT);
        });

        try {
            // Fire the prompt — non-blocking
            await this.copilotSession.send({ prompt });

            // Wait for session.idle or timeout
            await Promise.race([turnComplete, timeoutPromise]);
        } catch (err: any) {
            // Timeout — kill it
            const errMsg = err.message ?? String(err);
            if (errMsg.includes("timed out")) {
                try { this.copilotSession.abort(); } catch {}
                return {
                    type: "error",
                    message: "Copilot was taking too long to process and was killed.",
                };
            }
            // Other send() errors
            if (!turnState.pendingInput && !turnState.pendingWait) {
                return { type: "error", message: errMsg };
            }
        } finally {
            // Always clean up subscriptions
            for (const unsub of unsubscribers) unsub();
        }

        // Check what ended the turn
        if (turnState.pendingInput) {
            return { type: "input_required", ...turnState.pendingInput, events: collectedEvents };
        }
        if (turnState.pendingWait) {
            return {
                type: "wait",
                seconds: turnState.pendingWait.seconds,
                reason: turnState.pendingWait.reason,
                content: finalContent,
                events: collectedEvents,
            };
        }

        return {
            type: "completed",
            content: finalContent ?? "(no response)",
            events: collectedEvents,
        };
    }

    /**
     * Abort the current in-flight message.
     * Session remains alive for future runTurn() calls.
     */
    abort(): void {
        this.copilotSession.abort();
    }

    /**
     * Destroy the session — release resources, flush to disk.
     */
    async destroy(): Promise<void> {
        await this.copilotSession.destroy();
    }

    /**
     * Get conversation messages from the underlying session.
     */
    async getMessages(): Promise<unknown[]> {
        return this.copilotSession.getMessages();
    }

    /**
     * Update configuration for the next turn.
     */
    updateConfig(config: Partial<ManagedSessionConfig>): void {
        if (config.model !== undefined) this.config.model = config.model;
        if (config.tools !== undefined) this.config.tools = config.tools;
        if (config.systemMessage !== undefined) this.config.systemMessage = config.systemMessage;
        if (config.waitThreshold !== undefined) this.config.waitThreshold = config.waitThreshold;
    }

    /** Get the underlying CopilotSession (for direct access when needed). */
    getCopilotSession(): CopilotSession {
        return this.copilotSession;
    }
}
