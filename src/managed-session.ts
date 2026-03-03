import { defineTool, type Tool, type CopilotSession } from "@github/copilot-sdk";
import type { TurnResult, TurnOptions, ManagedSessionConfig, CapturedEvent } from "./types.js";

/**
 * Mutable state shared between the wait tool handler and runTurn().
 * @internal
 */
interface TurnState {
    pendingWait: { seconds: number; reason: string } | null;
    pendingInput: { question: string; choices?: string[]; allowFreeform?: boolean } | null;
    pendingSpawnAgent: { task: string; systemMessage?: string; toolNames?: string[] } | null;
    pendingMessageAgent: { agentId: string; message: string } | null;
    pendingCheckAgents: boolean;
    pendingWaitForAgents: { agentIds: string[] } | null;
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
     * Sub-agent tool definitions.
     * These are the LLM-visible tools for spawning and managing sub-agents.
     * Like wait/ask_user, handlers are stubs — real handlers set per-turn in runTurn().
     */
    static subAgentToolDefs(): Tool<any>[] {
        const spawnAgentTool = defineTool("spawn_agent", {
            description:
                "Spawn an autonomous sub-agent to work on a task in parallel. " +
                "The sub-agent is a full Copilot session with its own conversation and tools. " +
                "Returns an agent ID you can use to check status, send messages, or wait for completion. " +
                "IMPORTANT: Only spawn agents for tasks that MUST run independently and in parallel " +
                "(e.g. separate data sources to monitor, independent work streams). " +
                "Do NOT spawn agents for summarization, reporting, or coordination \u2014 handle those yourself. " +
                "Each agent adds cost, so minimize the number of agents.",
            parameters: {
                type: "object",
                properties: {
                    task: {
                        type: "string",
                        description: "A clear description of what the sub-agent should do. This becomes the agent's first prompt.",
                    },
                    system_message: {
                        type: "string",
                        description: "Optional custom system message for the sub-agent. If omitted, inherits the parent's system message.",
                    },
                    tool_names: {
                        type: "array",
                        items: { type: "string" },
                        description: "Optional list of tool names the sub-agent should have access to. If omitted, inherits the parent's tools.",
                    },
                },
                required: ["task"],
            },
            handler: async () => "stub",
        });

        const messageAgentTool = defineTool("message_agent", {
            description:
                "Send a message to a running sub-agent. " +
                "The message is enqueued as a prompt for the sub-agent's next turn.",
            parameters: {
                type: "object",
                properties: {
                    agent_id: { type: "string", description: "The sub-agent's ID (returned by spawn_agent)" },
                    message: { type: "string", description: "The message to send to the sub-agent" },
                },
                required: ["agent_id", "message"],
            },
            handler: async () => "stub",
        });

        const checkAgentsTool = defineTool("check_agents", {
            description:
                "Check the current status and latest output of all sub-agents. " +
                "Returns each agent's ID, task, status (running/completed/failed), and result.",
            parameters: {
                type: "object",
                properties: {},
            },
            handler: async () => "stub",
        });

        const waitForAgentsTool = defineTool("wait_for_agents", {
            description:
                "Block until one or more sub-agents complete. " +
                "Returns the final results of the completed agents. " +
                "If no agent_ids are specified, waits for ALL active sub-agents.",
            parameters: {
                type: "object",
                properties: {
                    agent_ids: {
                        type: "array",
                        items: { type: "string" },
                        description: "Optional list of specific agent IDs to wait for. If omitted, waits for all.",
                    },
                },
            },
            handler: async () => "stub",
        });

        return [spawnAgentTool, messageAgentTool, checkAgentsTool, waitForAgentsTool];
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
            pendingSpawnAgent: null,
            pendingMessageAgent: null,
            pendingCheckAgents: false,
            pendingWaitForAgents: null,
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

        // Build sub-agent tools
        const spawnAgentTool = defineTool("spawn_agent", {
            description:
                "Spawn an autonomous sub-agent to work on a task in parallel. " +
                "The sub-agent is a full Copilot session with its own conversation and tools. " +
                "Returns an agent ID you can use to check status, send messages, or wait for completion. " +
                "IMPORTANT: Only spawn agents for tasks that MUST run independently and in parallel " +
                "(e.g. separate data sources to monitor, independent work streams). " +
                "Do NOT spawn agents for summarization, reporting, or coordination \u2014 handle those yourself. " +
                "Each agent adds cost, so minimize the number of agents.",
            parameters: {
                type: "object",
                properties: {
                    task: {
                        type: "string",
                        description: "A clear description of what the sub-agent should do. This becomes the agent's first prompt.",
                    },
                    system_message: {
                        type: "string",
                        description: "Optional custom system message for the sub-agent. If omitted, inherits the parent's system message.",
                    },
                    tool_names: {
                        type: "array",
                        items: { type: "string" },
                        description: "Optional list of tool names the sub-agent should have access to. If omitted, inherits the parent's tools.",
                    },
                },
                required: ["task"],
            },
            handler: async (args: { task: string; system_message?: string; tool_names?: string[] }) => {
                turnState.pendingSpawnAgent = {
                    task: args.task,
                    systemMessage: args.system_message,
                    toolNames: args.tool_names,
                };
                if (turnState.session) turnState.session.abort();
                return "aborted";
            },
        });

        const messageAgentTool = defineTool("message_agent", {
            description:
                "Send a message to a running sub-agent. " +
                "The message is enqueued as a prompt for the sub-agent's next turn.",
            parameters: {
                type: "object",
                properties: {
                    agent_id: { type: "string", description: "The sub-agent's ID (returned by spawn_agent)" },
                    message: { type: "string", description: "The message to send to the sub-agent" },
                },
                required: ["agent_id", "message"],
            },
            handler: async (args: { agent_id: string; message: string }) => {
                turnState.pendingMessageAgent = {
                    agentId: args.agent_id,
                    message: args.message,
                };
                if (turnState.session) turnState.session.abort();
                return "aborted";
            },
        });

        const checkAgentsTool = defineTool("check_agents", {
            description:
                "Check the current status and latest output of all sub-agents. " +
                "Returns each agent's ID, task, status (running/completed/failed), and result.",
            parameters: {
                type: "object",
                properties: {},
            },
            handler: async () => {
                turnState.pendingCheckAgents = true;
                if (turnState.session) turnState.session.abort();
                return "aborted";
            },
        });

        const waitForAgentsTool = defineTool("wait_for_agents", {
            description:
                "Block until one or more sub-agents complete. " +
                "Returns the final results of the completed agents. " +
                "If no agent_ids are specified, waits for ALL active sub-agents.",
            parameters: {
                type: "object",
                properties: {
                    agent_ids: {
                        type: "array",
                        items: { type: "string" },
                        description: "Optional list of specific agent IDs to wait for. If omitted, waits for all.",
                    },
                },
            },
            handler: async (args: { agent_ids?: string[] }) => {
                turnState.pendingWaitForAgents = {
                    agentIds: args.agent_ids ?? [],
                };
                if (turnState.session) turnState.session.abort();
                return "aborted";
            },
        });

        const SYSTEM_TOOL_NAMES = new Set(["wait", "ask_user", "spawn_agent", "message_agent", "check_agents", "wait_for_agents"]);

        // Merge user tools with system tools
        const userTools = this.config.tools ?? [];
        const allTools: Tool<any>[] = [
            ...userTools.filter(t => {
                const name = (t as any).name;
                return !SYSTEM_TOOL_NAMES.has(name);
            }),
            waitTool,
            askUserTool,
            spawnAgentTool,
            messageAgentTool,
            checkAgentsTool,
            waitForAgentsTool,
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
            // Other send() errors — check if any handler aborted first
            if (!turnState.pendingInput && !turnState.pendingWait
                && !turnState.pendingSpawnAgent && !turnState.pendingMessageAgent
                && !turnState.pendingCheckAgents && !turnState.pendingWaitForAgents) {
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
        if (turnState.pendingSpawnAgent) {
            return {
                type: "spawn_agent",
                task: turnState.pendingSpawnAgent.task,
                systemMessage: turnState.pendingSpawnAgent.systemMessage,
                toolNames: turnState.pendingSpawnAgent.toolNames,
                content: finalContent,
                events: collectedEvents,
            };
        }
        if (turnState.pendingMessageAgent) {
            return {
                type: "message_agent",
                agentId: turnState.pendingMessageAgent.agentId,
                message: turnState.pendingMessageAgent.message,
                events: collectedEvents,
            };
        }
        if (turnState.pendingCheckAgents) {
            return { type: "check_agents", events: collectedEvents };
        }
        if (turnState.pendingWaitForAgents) {
            return {
                type: "wait_for_agents",
                agentIds: turnState.pendingWaitForAgents.agentIds,
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
