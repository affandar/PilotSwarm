import { defineTool, type Tool, type CopilotSession } from "@github/copilot-sdk";
import type { TurnResult, TurnOptions, ManagedSessionConfig, CapturedEvent } from "./types.js";

/**
 * Mutable state shared between the wait tool handler and runTurn().
 * @internal
 */
interface TurnState {
    pendingWait: { seconds: number; reason: string } | null;
    pendingInput: { question: string; choices?: string[]; allowFreeform?: boolean } | null;
    pendingSpawnAgent: { task: string; model?: string; systemMessage?: string; toolNames?: string[] } | null;
    pendingMessageAgent: { agentId: string; message: string } | null;
    pendingCheckAgents: boolean;
    pendingWaitForAgents: { agentIds: string[] } | null;
    pendingListSessions: boolean;
    pendingCompleteAgent: { agentId: string } | null;
    pendingCancelAgent: { agentId: string; reason?: string } | null;
    pendingDeleteAgent: { agentId: string; reason?: string } | null;
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

        const listModelsTool = defineTool("list_available_models", {
            description:
                "List all available LLM models across all configured providers. " +
                "Returns each model's qualified name (provider:model), description, and cost tier. " +
                "Use this when choosing the best model for a sub-agent task, or when the user asks about available models. " +
                "When choosing a model for a sub-agent, prefer lower-cost models for simple tasks " +
                "and higher-cost models for complex reasoning tasks.",
            parameters: {
                type: "object",
                properties: {},
            },
            handler: async () => "stub",
        });

        return [waitTool, askUserTool, listModelsTool];
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
                "Each agent adds cost, so minimize the number of agents. " +
                "By default, sub-agents inherit the parent's model. " +
                "If the user asks to pick the right model, call list_available_models first.",
            parameters: {
                type: "object",
                properties: {
                    task: {
                        type: "string",
                        description: "A clear description of what the sub-agent should do. This becomes the agent's first prompt.",
                    },
                    model: {
                        type: "string",
                        description: "Optional model in provider:model format (e.g. 'azure-openai:gpt-4.1-mini'). If omitted, inherits parent's model.",
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

        const listSessionsTool = defineTool("list_sessions", {
            description:
                "List all active sessions in the system. " +
                "Returns each session's ID, title, status, parent, and iteration count. " +
                "Use this to discover other running sessions, find sibling agents, or survey the system.",
            parameters: {
                type: "object",
                properties: {},
            },
            handler: async () => "stub",
        });

        return [spawnAgentTool, messageAgentTool, checkAgentsTool, waitForAgentsTool, listSessionsTool,
            ...ManagedSession._childManagementToolDefs()];
    }

    /**
     * Child management tool definitions (complete, cancel, delete).
     * Separated for clarity but included in subAgentToolDefs().
     */
    static _childManagementToolDefs(): Tool<any>[] {
        const completeAgentTool = defineTool("complete_agent", {
            description:
                "Gracefully complete a running sub-agent. " +
                "Sends a /done command to the sub-agent, causing it to finish and send its final result back. " +
                "Use this when a sub-agent has accomplished its task and should stop.",
            parameters: {
                type: "object",
                properties: {
                    agent_id: { type: "string", description: "The sub-agent's ID (returned by spawn_agent)" },
                },
                required: ["agent_id"],
            },
            handler: async () => "stub",
        });

        const cancelAgentTool = defineTool("cancel_agent", {
            description:
                "Cancel a running sub-agent immediately. " +
                "The sub-agent's orchestration is terminated without a graceful shutdown. " +
                "Optionally provide a reason for the cancellation.",
            parameters: {
                type: "object",
                properties: {
                    agent_id: { type: "string", description: "The sub-agent's ID (returned by spawn_agent)" },
                    reason: { type: "string", description: "Optional reason for cancellation" },
                },
                required: ["agent_id"],
            },
            handler: async () => "stub",
        });

        const deleteAgentTool = defineTool("delete_agent", {
            description:
                "Cancel and delete a sub-agent entirely. " +
                "Terminates the orchestration and removes the session from the catalog. " +
                "Use this to clean up sub-agents you no longer need.",
            parameters: {
                type: "object",
                properties: {
                    agent_id: { type: "string", description: "The sub-agent's ID (returned by spawn_agent)" },
                    reason: { type: "string", description: "Optional reason for deletion" },
                },
                required: ["agent_id"],
            },
            handler: async () => "stub",
        });

        return [completeAgentTool, cancelAgentTool, deleteAgentTool];
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
            pendingListSessions: false,
            pendingCompleteAgent: null,
            pendingCancelAgent: null,
            pendingDeleteAgent: null,
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

        // list_available_models — returns data inline (no abort/continuation needed)
        const listModelsTool = defineTool("list_available_models", {
            description:
                "List all available LLM models across all configured providers. " +
                "Returns each model's qualified name (provider:model), description, and cost tier. " +
                "Use this when choosing the best model for a sub-agent task, or when the user asks about available models. " +
                "When choosing a model for a sub-agent, prefer lower-cost models for simple tasks " +
                "and higher-cost models for complex reasoning tasks.",
            parameters: {
                type: "object",
                properties: {},
            },
            handler: async () => {
                return opts?.modelSummary || "No model providers configured.";
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
                "Each agent adds cost, so minimize the number of agents. " +
                "By default, sub-agents use the same model as the parent. " +
                "If the user asks to use the right model for the job, call list_available_models first " +
                "and pick one based on task complexity and cost.",
            parameters: {
                type: "object",
                properties: {
                    task: {
                        type: "string",
                        description: "A clear description of what the sub-agent should do. This becomes the agent's first prompt.",
                    },
                    model: {
                        type: "string",
                        description: "Optional model to use for this sub-agent in provider:model format (e.g. 'azure-openai:gpt-4.1-mini'). Use list_available_models to see options. If omitted, inherits the parent's model.",
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
            handler: async (args: { task: string; model?: string; system_message?: string; tool_names?: string[] }) => {
                turnState.pendingSpawnAgent = {
                    task: args.task,
                    model: args.model,
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

        const listSessionsTool = defineTool("list_sessions", {
            description:
                "List all active sessions in the system. " +
                "Returns each session's ID, title, status, parent, and iteration count. " +
                "Use this to discover other running sessions, find sibling agents, or survey the system.",
            parameters: {
                type: "object",
                properties: {},
            },
            handler: async () => {
                turnState.pendingListSessions = true;
                if (turnState.session) turnState.session.abort();
                return "aborted";
            },
        });

        const completeAgentTool = defineTool("complete_agent", {
            description:
                "Gracefully complete a running sub-agent. " +
                "Sends a /done command to the sub-agent, causing it to finish and send its final result back. " +
                "Use this when a sub-agent has accomplished its task and should stop.",
            parameters: {
                type: "object",
                properties: {
                    agent_id: { type: "string", description: "The sub-agent's ID (returned by spawn_agent)" },
                },
                required: ["agent_id"],
            },
            handler: async (args: { agent_id: string }) => {
                turnState.pendingCompleteAgent = { agentId: args.agent_id };
                if (turnState.session) turnState.session.abort();
                return "aborted";
            },
        });

        const cancelAgentTool = defineTool("cancel_agent", {
            description:
                "Cancel a running sub-agent immediately. " +
                "The sub-agent's orchestration is terminated without a graceful shutdown. " +
                "Optionally provide a reason for the cancellation.",
            parameters: {
                type: "object",
                properties: {
                    agent_id: { type: "string", description: "The sub-agent's ID (returned by spawn_agent)" },
                    reason: { type: "string", description: "Optional reason for cancellation" },
                },
                required: ["agent_id"],
            },
            handler: async (args: { agent_id: string; reason?: string }) => {
                turnState.pendingCancelAgent = { agentId: args.agent_id, reason: args.reason };
                if (turnState.session) turnState.session.abort();
                return "aborted";
            },
        });

        const deleteAgentTool = defineTool("delete_agent", {
            description:
                "Cancel and delete a sub-agent entirely. " +
                "Terminates the orchestration and removes the session from the catalog. " +
                "Use this to clean up sub-agents you no longer need.",
            parameters: {
                type: "object",
                properties: {
                    agent_id: { type: "string", description: "The sub-agent's ID (returned by spawn_agent)" },
                    reason: { type: "string", description: "Optional reason for deletion" },
                },
                required: ["agent_id"],
            },
            handler: async (args: { agent_id: string; reason?: string }) => {
                turnState.pendingDeleteAgent = { agentId: args.agent_id, reason: args.reason };
                if (turnState.session) turnState.session.abort();
                return "aborted";
            },
        });

        const SYSTEM_TOOL_NAMES = new Set(["wait", "ask_user", "list_available_models", "spawn_agent", "message_agent", "check_agents", "wait_for_agents", "list_sessions", "complete_agent", "cancel_agent", "delete_agent"]);

        // Merge user tools with system tools
        const userTools = this.config.tools ?? [];

        // Wrap user tool handlers to augment invocation with the PilotSwarm
        // durable session ID. The Copilot SDK's invocation.sessionId is an
        // internal SDK session ID — we add durableSessionId so tool handlers
        // can identify which durable session is calling without closures.
        // Both IDs are available: invocation.sessionId (SDK) and
        // invocation.durableSessionId (PilotSwarm).
        const durableSessionId = this.sessionId;
        const wrappedUserTools = userTools
            .filter(t => {
                const name = (t as any).name;
                return !SYSTEM_TOOL_NAMES.has(name);
            })
            .map(t => ({
                ...t,
                handler: (args: any, invocation: any) => {
                    const augmented = { ...invocation, durableSessionId };
                    // Diagnostic: log both session IDs for verification
                    console.log(`[tool] ${(t as any).name} invoked — copilotSessionId=${invocation?.sessionId?.slice(0,8)} durableSessionId=${durableSessionId.slice(0,8)}`);
                    return (t as any).handler(args, augmented);
                },
            }));

        const allTools: Tool<any>[] = [
            ...wrappedUserTools,
            waitTool,
            askUserTool,
            listModelsTool,
            spawnAgentTool,
            messageAgentTool,
            checkAgentsTool,
            waitForAgentsTool,
            listSessionsTool,
            completeAgentTool,
            cancelAgentTool,
            deleteAgentTool,
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
                    const eventData = event.data ?? event;

                    // Augment tool execution events with the durable session ID
                    // so CMS consumers can correlate tool calls to durable sessions.
                    if (eventType === "tool.execution_start" || eventType === "tool.execution_complete") {
                        if (typeof eventData === "object" && eventData !== null) {
                            eventData.durableSessionId = durableSessionId;
                        }
                    }

                    const captured: CapturedEvent = { eventType, data: eventData };
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
                && !turnState.pendingCheckAgents && !turnState.pendingWaitForAgents
                && !turnState.pendingListSessions && !turnState.pendingCompleteAgent
                && !turnState.pendingCancelAgent && !turnState.pendingDeleteAgent) {
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
                model: turnState.pendingSpawnAgent.model,
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
        if (turnState.pendingListSessions) {
            return { type: "list_sessions", events: collectedEvents };
        }
        if (turnState.pendingCompleteAgent) {
            return {
                type: "complete_agent",
                agentId: turnState.pendingCompleteAgent.agentId,
                events: collectedEvents,
            };
        }
        if (turnState.pendingCancelAgent) {
            return {
                type: "cancel_agent",
                agentId: turnState.pendingCancelAgent.agentId,
                reason: turnState.pendingCancelAgent.reason,
                events: collectedEvents,
            };
        }
        if (turnState.pendingDeleteAgent) {
            return {
                type: "delete_agent",
                agentId: turnState.pendingDeleteAgent.agentId,
                reason: turnState.pendingDeleteAgent.reason,
                events: collectedEvents,
            };
        }

        // Check if the SDK emitted a session.error — if so, treat as an error
        // even though session.idle fired (the SDK fires idle after retries exhaust).
        const sessionError = collectedEvents.find(e => e.eventType === "session.error");
        if (sessionError && !finalContent) {
            const errData: any = sessionError.data ?? {};
            const errMsg = errData.message ?? errData.stack ?? "Unknown session error";
            return {
                type: "error",
                message: `Execution failed: ${errMsg}`,
                events: collectedEvents,
            } as any;
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
