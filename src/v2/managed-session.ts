import { defineTool, type Tool, type CopilotSession } from "@github/copilot-sdk";
import type { TurnResult, TurnOptions, ManagedSessionConfig } from "./types.js";

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

        try {
            const response = await this.copilotSession.sendAndWait(
                { prompt },
                60_000
            );

            if (turnState.pendingInput) {
                return { type: "input_required", ...turnState.pendingInput };
            }
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
            // Abort caused by user input request
            if (turnState.pendingInput) {
                return { type: "input_required", ...turnState.pendingInput };
            }

            // Abort caused by wait tool
            if (turnState.pendingWait) {
                let content: string | undefined;
                try {
                    const msgs = await this.copilotSession.getMessages();
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

            // Timeout
            const errMsg = err.message ?? String(err);
            if (errMsg.includes("waiting for session.idle")) {
                try { this.copilotSession.abort(); } catch {}
                return {
                    type: "error",
                    message: "Copilot was taking too long to process and was killed.",
                };
            }

            return { type: "error", message: errMsg };
        }
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
